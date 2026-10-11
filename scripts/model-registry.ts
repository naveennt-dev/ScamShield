/**
 * Model registry: the only path from a trained candidate to the active model.
 *
 *   npm run ml:train                                   → ml/registry/candidates/next (candidate)
 *   npm run model:registry -- keygen                   → signing key (private key outside the repo)
 *   npm run model:registry -- gate   <candidateDir>    → evaluation gate vs the active model + model card
 *   npm run model:registry -- release <candidateDir>   → signed release in ml/registry/releases/<buildId>
 *   npm run model:registry -- install <releaseDir|https-url>  → verify signature + hashes, atomic swap
 *   npm run model:registry -- rollback                 → restore the previous model
 *   npm run model:registry -- status
 *
 * Feedback and contributions never change the active model by themselves: a human runs training,
 * the gate must pass, the release must be signed, and installs verify all of it. After install or
 * rollback, restart the services (scripts/scamshield.sh restart) to load the model.
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gateSummary, runGate, type GateReport } from "../src/lib/ml-registry/gate";
import { installRelease, listBackups, rollback } from "../src/lib/ml-registry/install";
import { canonicalJson, MAX_RELEASE_FILE_BYTES, RELEASE_SCHEMA, sha256Hex, signRelease, type ReleaseManifest } from "../src/lib/ml-registry/release";

const MODELS_DIR = path.resolve("ml/models");
const REGISTRY = path.resolve("ml/registry");
const RELEASES = path.join(REGISTRY, "releases");
const BACKUPS = path.join(REGISTRY, "backups");
const PUBLIC_KEY = process.env.MODEL_UPDATE_PUBLIC_KEY_PATH ?? path.join(REGISTRY, "model-signing-public.pem");
const PRIVATE_KEY = process.env.MODEL_SIGNING_KEY_PATH ?? path.join(os.homedir(), "Library/Application Support/ScamShield/keys/model-signing-ed25519.pem");
const MODEL_FILES = ["model_manifest.json", "scam_classifier.json", "scam_classifier.joblib"];

const die = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const readJson = <T>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;

function keygen() {
  if (existsSync(PRIVATE_KEY)) die(`a signing key already exists at ${PRIVATE_KEY} (refusing to overwrite)`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(path.dirname(PRIVATE_KEY), { recursive: true, mode: 0o700 });
  writeFileSync(PRIVATE_KEY, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  chmodSync(PRIVATE_KEY, 0o600);
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(PUBLIC_KEY, pub);
  console.log(`✓ private key: ${PRIVATE_KEY} (0600, never commit or share it)`);
  console.log(`✓ public key:  ${PUBLIC_KEY} (fingerprint ${sha256Hex(pub).slice(0, 16)})`);
}

function candidateFiles(dir: string) {
  for (const f of MODEL_FILES) if (!existsSync(path.join(dir, f))) die(`${dir} is missing ${f}`);
  const manifest = readJson<{ buildId: string; name: string; files: Record<string, { path: string; sha256: string }> }>(path.join(dir, "model_manifest.json"));
  for (const info of Object.values(manifest.files)) {
    if (sha256Hex(readFileSync(path.join(dir, info.path))) !== info.sha256) die(`${info.path}: SHA-256 differs from its model_manifest.json`);
  }
  return manifest;
}

function modelCard(dir: string, report: GateReport) {
  const m = readJson<Record<string, unknown> & { trainingData?: { rows?: number; sources?: string[]; dataSha256?: string } }>(path.join(dir, "model_manifest.json"));
  return `# Model card — ${m.name} ${m.buildId}

- **Type:** TF-IDF (word + character) + logistic regression, ${m.probabilityType}.
- **Created:** ${m.createdAt}
- **Training data:** ${m.trainingData?.rows ?? "?"} rows from ${(m.trainingData?.sources ?? []).join(", ")} (data SHA-256 ${String(m.trainingData?.dataSha256 ?? "?").slice(0, 16)}…).
- **Intended use:** one signal inside ScamShield's detection engine, next to deterministic rules and URL checks. It is never the only reason for a HIGH-RISK result (risk-engine cap), and on its own it cannot warn about a message that asks for nothing.
- **Not intended:** a stand-alone fraud verdict.

## Evaluation gate (vs the active model)

${gateSummary(report)}

## Limitations

- The evaluation sets are synthetic (written for this project) plus the public UCI SMS corpus; they show regressions, not real-world accuracy.
- Trained mostly on English/Hinglish SMS; weaker on other languages, long e-mails and screen text.
- Spam-trained vocabulary rates some genuine bills/reminders as scam-like; rules and the nothing-asked gate limit the effect.
`;
}

async function gate(dir: string) {
  dir = path.resolve(dir);
  const m = candidateFiles(dir);
  console.log(`▸ gate: candidate ${m.buildId} vs active ${readJson<{ buildId: string }>(path.join(MODELS_DIR, "model_manifest.json")).buildId}`);
  const report = await runGate(path.join(dir, "scam_classifier.json"), path.join(MODELS_DIR, "scam_classifier.json"));
  const bound = { ...report, candidateManifestSha256: sha256Hex(readFileSync(path.join(dir, "model_manifest.json"))) };
  writeFileSync(path.join(dir, "gate-report.json"), JSON.stringify(bound, null, 2));
  writeFileSync(path.join(dir, "model-card.md"), modelCard(dir, report));
  console.log(gateSummary(report));
  if (!report.passed) process.exitCode = 2;
}

function release(dir: string) {
  dir = path.resolve(dir);
  const m = candidateFiles(dir);
  const reportPath = path.join(dir, "gate-report.json");
  if (!existsSync(reportPath)) die("run the gate first");
  const report = readJson<GateReport & { candidateManifestSha256: string }>(reportPath);
  if (report.candidateManifestSha256 !== sha256Hex(readFileSync(path.join(dir, "model_manifest.json")))) die("the candidate changed after the gate ran — run the gate again");
  if (!report.passed) die(`gate failed: ${report.reasons.join("; ")}`);
  if (!existsSync(PRIVATE_KEY)) die(`no signing key at ${PRIVATE_KEY} — run keygen`);
  const out = path.join(RELEASES, m.buildId.replace(/[^\w.+-]/g, "_"));
  if (existsSync(out)) die(`${out} already exists`);
  mkdirSync(out, { recursive: true });
  const files = MODEL_FILES.map((name) => {
    copyFileSync(path.join(dir, name), path.join(out, name));
    const size = statSync(path.join(out, name)).size;
    if (size > MAX_RELEASE_FILE_BYTES) die(`${name} is larger than ${MAX_RELEASE_FILE_BYTES} bytes`);
    return { name, sha256: sha256Hex(readFileSync(path.join(out, name))), size };
  });
  copyFileSync(path.join(dir, "model-card.md"), path.join(out, "model-card.md"));
  const manifest: ReleaseManifest = {
    schema: RELEASE_SCHEMA,
    name: m.name,
    buildId: m.buildId,
    createdAt: new Date().toISOString(),
    files,
    evaluation: { gatePassed: true, reportSha256: sha256Hex(readFileSync(reportPath)), summary: gateSummary(report).split("\n")[0] },
  };
  copyFileSync(reportPath, path.join(out, "gate-report.json"));
  writeFileSync(path.join(out, "release.json"), canonicalJson(manifest));
  writeFileSync(path.join(out, "release.sig"), signRelease(manifest, readFileSync(PRIVATE_KEY, "utf8")));
  console.log(`✓ signed release ${m.buildId} → ${out}`);
}

async function fetchLimited(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_RELEASE_FILE_BYTES) throw new Error(`${url}: too large`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_RELEASE_FILE_BYTES) throw new Error(`${url}: too large`);
  return buf;
}

async function install(source: string) {
  if (!existsSync(PUBLIC_KEY)) die(`no pinned public key at ${PUBLIC_KEY}`);
  let get: (name: string) => Promise<Buffer>;
  if (/^https?:\/\//.test(source)) {
    const u = new URL(source.endsWith("/") ? source : `${source}/`);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !loopback) die("model updates are only fetched over HTTPS");
    get = (name) => fetchLimited(new URL(name, u).toString());
  } else {
    const dir = path.resolve(source);
    get = async (name) => readFileSync(path.join(dir, path.basename(name)));
  }
  const manifest = JSON.parse((await get("release.json")).toString("utf8"));
  const signature = (await get("release.sig")).toString("utf8").trim();
  const r = await installRelease({ manifest, signature, publicKeyPem: readFileSync(PUBLIC_KEY, "utf8"), fetchFile: get, modelsDir: MODELS_DIR, backupsDir: BACKUPS });
  console.log(`✓ installed ${r.buildId} (previous ${r.previousBuildId ?? "none"} kept at ${r.backup ?? "-"})`);
  console.log("  Restart the services to load it: scripts/scamshield.sh restart");
}

function status() {
  const active = existsSync(path.join(MODELS_DIR, "model_manifest.json")) ? readJson<{ buildId: string }>(path.join(MODELS_DIR, "model_manifest.json")).buildId : "none";
  console.log(`active model : ${active}`);
  console.log(`public key   : ${existsSync(PUBLIC_KEY) ? `${PUBLIC_KEY} (fingerprint ${sha256Hex(readFileSync(PUBLIC_KEY, "utf8")).slice(0, 16)})` : "not created"}`);
  console.log(`signing key  : ${existsSync(PRIVATE_KEY) ? "present (not shown)" : "not created"}`);
  console.log(`releases     : ${existsSync(RELEASES) ? readdirSync(RELEASES).join(", ") || "none" : "none"}`);
  console.log(`backups      : ${listBackups(BACKUPS).map((b) => path.basename(b)).join(", ") || "none"}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "keygen": return keygen();
    case "gate": return gate(arg ?? die("usage: gate <candidateDir>"));
    case "release": return release(arg ?? die("usage: release <candidateDir>"));
    case "install": return install(arg ?? die("usage: install <releaseDir|https-url>"));
    case "rollback": {
      const r = rollback(MODELS_DIR, BACKUPS);
      console.log(`✓ restored ${r.buildId ?? "unknown"} from ${r.restored}. Restart the services to load it.`);
      return;
    }
    case "status": return status();
    default: die("commands: keygen | gate <dir> | release <dir> | install <dir|url> | rollback | status");
  }
}
void main().catch((e) => die(e instanceof Error ? e.message : String(e)));
