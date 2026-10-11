import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installRelease, ReleaseRejected, rollback } from "@/lib/ml-registry/install";
import { canonicalJson, RELEASE_SCHEMA, sha256Hex, signRelease, verifyRelease, type ReleaseManifest } from "@/lib/ml-registry/release";
import { runGate } from "@/lib/ml-registry/gate";

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: publicKey.export({ type: "spki", format: "pem" }).toString() };
};

function makeRelease(buildId: string, opts: { gatePassed?: boolean; innerBuildId?: string } = {}) {
  const model = Buffer.from(JSON.stringify({ weights: buildId }));
  const inner = Buffer.from(JSON.stringify({ buildId: opts.innerBuildId ?? buildId, files: { json: { path: "scam_classifier.json", sha256: sha256Hex(model) } } }));
  const files = new Map([["model_manifest.json", inner], ["scam_classifier.json", model]]);
  const manifest: ReleaseManifest = {
    schema: RELEASE_SCHEMA,
    name: "test-model",
    buildId,
    createdAt: "2026-10-11T00:00:00.000Z",
    files: [...files].map(([name, data]) => ({ name, sha256: sha256Hex(data), size: data.length })),
    evaluation: { gatePassed: opts.gatePassed ?? true, reportSha256: "0".repeat(64), summary: "Gate: PASSED" },
  };
  return { manifest, files };
}

function dirs() {
  const root = mkdtempSync(path.join(os.tmpdir(), "registry-"));
  const modelsDir = path.join(root, "models");
  mkdirSync(modelsDir);
  writeFileSync(path.join(modelsDir, "model_manifest.json"), JSON.stringify({ buildId: "old-1" }));
  return { modelsDir, backupsDir: path.join(root, "backups") };
}

const activeBuild = (modelsDir: string) => (JSON.parse(readFileSync(path.join(modelsDir, "model_manifest.json"), "utf8")) as { buildId: string }).buildId;

describe("signed model releases", () => {
  const k = keys();

  it("signature covers the canonical manifest", () => {
    const { manifest } = makeRelease("b1");
    const sig = signRelease(manifest, k.priv);
    expect(verifyRelease(manifest, sig, k.pub)).toBe(true);
    expect(verifyRelease({ ...manifest, buildId: "b2" }, sig, k.pub)).toBe(false);
    expect(verifyRelease(manifest, sig, keys().pub)).toBe(false);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("installs a verified release atomically and keeps the previous model", async () => {
    const d = dirs();
    const { manifest, files } = makeRelease("new-2");
    const r = await installRelease({ manifest, signature: signRelease(manifest, k.priv), publicKeyPem: k.pub, fetchFile: async (n) => files.get(n)!, ...d });
    expect(r).toMatchObject({ buildId: "new-2", previousBuildId: "old-1" });
    expect(activeBuild(d.modelsDir)).toBe("new-2");
    expect(existsSync(r.backup!)).toBe(true);
  });

  const rejected: Array<[string, (m: ReleaseManifest, f: Map<string, Buffer>) => { manifest: unknown; signature?: string; pub?: string; files?: Map<string, Buffer> }]> = [
    ["tampered signature", (m) => ({ manifest: m, signature: signRelease({ ...m, buildId: "other" }, k.priv) })],
    ["wrong public key", (m) => ({ manifest: m, pub: keys().pub })],
    ["file content changed", (m, f) => ({ manifest: m, files: new Map([...f, ["scam_classifier.json", Buffer.from("evil")]]) })],
    ["unsafe file name", (m) => {
      const bad = { ...m, files: [...m.files, { name: "../escape.json", sha256: "a".repeat(64), size: 1 }] };
      return { manifest: bad, signature: signRelease(bad, k.priv) };
    }],
  ];
  it.each(rejected)("rejects: %s — and leaves the active model untouched", async (_n, mutate) => {
    const d = dirs();
    const { manifest, files } = makeRelease("new-3");
    const x = mutate(manifest, files);
    await expect(
      installRelease({
        manifest: x.manifest,
        signature: x.signature ?? signRelease(manifest, k.priv),
        publicKeyPem: x.pub ?? k.pub,
        fetchFile: async (n) => (x.files ?? files).get(n)!,
        ...d,
      }),
    ).rejects.toBeInstanceOf(ReleaseRejected);
    expect(activeBuild(d.modelsDir)).toBe("old-1");
  });

  it("rejects a release that did not pass the evaluation gate", async () => {
    const d = dirs();
    const { manifest, files } = makeRelease("new-4", { gatePassed: false });
    await expect(installRelease({ manifest, signature: signRelease(manifest, k.priv), publicKeyPem: k.pub, fetchFile: async (n) => files.get(n)!, ...d })).rejects.toThrow(/evaluation gate/);
    expect(activeBuild(d.modelsDir)).toBe("old-1");
  });

  it("rejects when the model's own manifest disagrees with the signed release", async () => {
    const d = dirs();
    const { manifest, files } = makeRelease("new-5", { innerBuildId: "something-else" });
    await expect(installRelease({ manifest, signature: signRelease(manifest, k.priv), publicKeyPem: k.pub, fetchFile: async (n) => files.get(n)!, ...d })).rejects.toThrow(/buildId differs/);
  });

  it("rollback restores the previous model and never restores a rolled-back one", async () => {
    const d = dirs();
    for (const id of ["v2", "v3"]) {
      const { manifest, files } = makeRelease(id);
      await installRelease({ manifest, signature: signRelease(manifest, k.priv), publicKeyPem: k.pub, fetchFile: async (n) => files.get(n)!, ...d });
      await new Promise((r) => setTimeout(r, 5)); // distinct backup timestamps
    }
    expect(activeBuild(d.modelsDir)).toBe("v3");
    expect(rollback(d.modelsDir, d.backupsDir).buildId).toBe("v2");
    expect(rollback(d.modelsDir, d.backupsDir).buildId).toBe("old-1");
    expect(() => rollback(d.modelsDir, d.backupsDir)).toThrow(/no previous model/);
  });
});

describe("evaluation gate", () => {
  it("the active model passes against itself (no regression)", async () => {
    const r = await runGate("ml/models/scam_classifier.json", "ml/models/scam_classifier.json", ["tests/fixtures/eval/realistic-v1.jsonl"]);
    expect(r.passed).toBe(true);
    expect(r.candidate.sets[0].caught).toBe(r.active.sets[0].caught);
  }, 120_000);
});
