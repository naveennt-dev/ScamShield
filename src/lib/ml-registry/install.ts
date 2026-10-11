import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_RELEASE_FILE_BYTES, sha256Hex, validateManifest, verifyRelease, type ReleaseManifest } from "./release";

/**
 * Verified, atomic installation of a signed model release into the models directory.
 *
 * Order: verify signature → reject releases that did not pass the evaluation gate → fetch each
 * file (size-limited) and check its SHA-256 → cross-check model_manifest.json against the files →
 * write everything to a staging directory → swap directories with two renames on the same
 * filesystem, keeping the previous models as a backup for rollback. Any failure before the swap
 * leaves the installed model untouched; a failure during the swap restores the previous one.
 */

export type FileSource = (name: string) => Promise<Buffer>;

export interface InstallOptions {
  manifest: unknown;
  signature: string;
  publicKeyPem: string;
  fetchFile: FileSource;
  modelsDir: string;
  backupsDir: string;
  /** Keep this many previous model sets. */
  keepBackups?: number;
}

export interface InstallResult {
  buildId: string;
  previousBuildId: string | null;
  backup: string | null;
}

export class ReleaseRejected extends Error {}

function readBuildId(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(path.join(dir, "model_manifest.json"), "utf8")) as { buildId?: string }).buildId ?? null;
  } catch {
    return null;
  }
}

export async function installRelease(o: InstallOptions): Promise<InstallResult> {
  let manifest: ReleaseManifest;
  try {
    manifest = validateManifest(o.manifest);
  } catch (e) {
    throw new ReleaseRejected((e as Error).message);
  }
  if (!verifyRelease(manifest, o.signature, o.publicKeyPem)) throw new ReleaseRejected("signature does not verify against the pinned public key");
  if (!manifest.evaluation.gatePassed) throw new ReleaseRejected("release did not pass the evaluation gate");

  const files = new Map<string, Buffer>();
  for (const f of manifest.files) {
    const data = await o.fetchFile(f.name);
    if (data.length > MAX_RELEASE_FILE_BYTES || data.length !== f.size) throw new ReleaseRejected(`${f.name}: size mismatch`);
    if (sha256Hex(data) !== f.sha256) throw new ReleaseRejected(`${f.name}: SHA-256 mismatch`);
    files.set(f.name, data);
  }
  // The model's own manifest must agree with the signed file list (the loaders verify it again).
  const inner = JSON.parse(files.get("model_manifest.json")!.toString("utf8")) as { buildId?: string; files?: Record<string, { path: string; sha256: string }> };
  if (inner.buildId !== manifest.buildId) throw new ReleaseRejected("model_manifest.json buildId differs from the release");
  for (const info of Object.values(inner.files ?? {})) {
    const f = manifest.files.find((x) => x.name === info.path);
    if (!f || f.sha256 !== info.sha256) throw new ReleaseRejected(`model_manifest.json lists ${info.path} with a different hash`);
  }

  const parent = path.dirname(path.resolve(o.modelsDir));
  const staging = path.join(parent, `.models-staging-${randomBytes(6).toString("hex")}`);
  mkdirSync(staging, { recursive: true });
  try {
    for (const [name, data] of files) writeFileSync(path.join(staging, name), data, { mode: 0o644 });
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }

  const previousBuildId = existsSync(o.modelsDir) ? readBuildId(o.modelsDir) : null;
  mkdirSync(o.backupsDir, { recursive: true });
  const backup = existsSync(o.modelsDir)
    ? path.join(o.backupsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${(previousBuildId ?? "unknown").replace(/[^\w.+-]/g, "_")}`)
    : null;
  if (backup) {
    if (path.dirname(path.resolve(backup)) === parent || statSync(o.backupsDir).dev === statSync(parent).dev) renameSync(o.modelsDir, backup);
    else throw new ReleaseRejected("backups directory must be on the same disk as the models directory");
  }
  try {
    renameSync(staging, o.modelsDir);
  } catch (e) {
    if (backup) renameSync(backup, o.modelsDir); // put the previous model back
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  pruneBackups(o.backupsDir, o.keepBackups ?? 3);
  return { buildId: manifest.buildId, previousBuildId, backup };
}

export function listBackups(backupsDir: string): string[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((n) => !n.startsWith("."))
    .sort()
    .reverse()
    .map((n) => path.join(backupsDir, n));
}

function pruneBackups(backupsDir: string, keep: number) {
  for (const old of listBackups(backupsDir).slice(keep)) rmSync(old, { recursive: true, force: true });
}

/** Restore the most recent backup; the current model set becomes a backup itself. */
export function rollback(modelsDir: string, backupsDir: string): { restored: string; buildId: string | null } {
  // A model that was itself rolled back is kept for inspection but never restored automatically.
  const latest = listBackups(backupsDir).find((b) => !path.basename(b).includes("_rolled-back_"));
  if (!latest) throw new Error("no previous model to roll back to");
  const current = existsSync(modelsDir) ? path.join(backupsDir, `.rolled-back-${Date.now()}`) : null;
  if (current) renameSync(modelsDir, current);
  try {
    renameSync(latest, modelsDir);
  } catch (e) {
    if (current) renameSync(current, modelsDir);
    throw e;
  }
  if (current) renameSync(current, path.join(backupsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_rolled-back_${readBuildId(path.join(backupsDir, path.basename(current))) ?? "unknown"}`));
  return { restored: latest, buildId: readBuildId(modelsDir) };
}
