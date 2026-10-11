import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/**
 * Signed model releases.
 *
 * A release is a small JSON manifest listing every model file with its SHA-256 and size, plus the
 * outcome of the evaluation gate. The manifest is signed with Ed25519; clients pin the public key
 * and refuse anything whose signature or file hashes don't match. The signing key never lives in
 * the repository (see scripts/model-registry.ts keygen).
 */

export const RELEASE_SCHEMA = 1;
/** Largest single model file a client will accept. */
export const MAX_RELEASE_FILE_BYTES = 64 * 1024 * 1024;

export interface ReleaseFile {
  name: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  schema: typeof RELEASE_SCHEMA;
  name: string;
  buildId: string;
  createdAt: string;
  files: ReleaseFile[];
  evaluation: { gatePassed: boolean; reportSha256: string; summary: string };
}

/** Deterministic JSON (sorted keys) so the signature covers exactly one byte sequence. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** File names inside a release: plain names only — no paths, no traversal. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function validateManifest(m: unknown): ReleaseManifest {
  const r = m as ReleaseManifest;
  if (!r || typeof r !== "object" || r.schema !== RELEASE_SCHEMA) throw new Error("release: unsupported schema");
  if (typeof r.buildId !== "string" || !/^[\w.+-]{1,100}$/.test(r.buildId)) throw new Error("release: bad buildId");
  if (!Array.isArray(r.files) || r.files.length === 0 || r.files.length > 20) throw new Error("release: bad file list");
  const names = new Set<string>();
  for (const f of r.files) {
    if (!SAFE_NAME.test(f.name) || f.name.includes("..")) throw new Error(`release: unsafe file name ${String(f.name).slice(0, 40)}`);
    if (names.has(f.name)) throw new Error("release: duplicate file");
    names.add(f.name);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error("release: bad sha256");
    if (!Number.isInteger(f.size) || f.size <= 0 || f.size > MAX_RELEASE_FILE_BYTES) throw new Error("release: bad size");
  }
  if (!names.has("model_manifest.json")) throw new Error("release: model_manifest.json missing");
  if (!r.evaluation || typeof r.evaluation.gatePassed !== "boolean") throw new Error("release: evaluation missing");
  return r;
}

export function signRelease(manifest: ReleaseManifest, privateKeyPem: string): string {
  return sign(null, Buffer.from(canonicalJson(manifest)), createPrivateKey(privateKeyPem)).toString("base64");
}

export function verifyRelease(manifest: ReleaseManifest, signatureB64: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, Buffer.from(canonicalJson(manifest)), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
