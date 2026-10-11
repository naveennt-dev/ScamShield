/**
 * Import a scam-intelligence list into the local `scam_intel` table (Phase 5).
 *
 *   npx tsx --env-file=.env scripts/intel-import.ts <file.csv|file.json> --source imported|verified [--dry-run]
 *   npx tsx --env-file=.env scripts/intel-import.ts --prune-expired
 *
 * CSV columns (header required): kind,value,status,category,confidence,explanation,expiresAt
 *   kind: DOMAIN | URL      status: SUSPICIOUS | CONFIRMED_MALICIOUS | BENIGN | UNKNOWN
 * JSON: an array of objects with the same fields.
 *
 * Every row is validated (prepareIntelRecord) — invalid rows are rejected and reported by row
 * number only (their content is never echoed). Provenance is recorded as "import:<file name>".
 * Nothing is fetched from the internet: the operator chooses and supplies the file, and is
 * responsible for its licence/terms. No list is bundled with ScamShield.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { prisma } from "../src/lib/db/prisma";
import { deleteExpiredIntel, IntelValidationError, prepareIntelRecord, upsertIntelRecord } from "../src/lib/intel/records";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseIntelFile(name: string, text: string): Record<string, unknown>[] {
  if (name.toLowerCase().endsWith(".json")) {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error("JSON must be an array of records");
    return data.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r));
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));
  const header = parseCsvLine(lines.shift() ?? "").map((h) => h.trim());
  const allowed = new Set(["kind", "value", "status", "category", "confidence", "explanation", "expiresAt", "reviewAt"]);
  const unknown = header.filter((h) => !allowed.has(h));
  if (unknown.length) throw new Error(`Unknown CSV columns: ${unknown.join(", ")}`);
  return lines.map((l) => {
    const cells = parseCsvLine(l);
    const row: Record<string, unknown> = {};
    header.forEach((h, i) => {
      const v = (cells[i] ?? "").trim();
      if (v !== "") row[h] = h === "confidence" ? Number(v) : v;
    });
    return row;
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--prune-expired")) {
    console.log(`Deleted ${await deleteExpiredIntel()} expired intelligence records.`);
    return;
  }
  const file = args.find((a) => !a.startsWith("--"));
  const source = args[args.indexOf("--source") + 1];
  const dryRun = args.includes("--dry-run");
  if (!file || !["imported", "verified"].includes(source)) {
    console.log("usage: intel-import.ts <file.csv|file.json> --source imported|verified [--dry-run]  |  --prune-expired");
    process.exit(2);
  }
  if (statSync(file).size > MAX_BYTES) throw new Error(`File larger than ${MAX_BYTES} bytes`);
  const rows = parseIntelFile(file, readFileSync(file, "utf8"));
  if (rows.length > MAX_ROWS) throw new Error(`More than ${MAX_ROWS} rows`);

  const sourceType = source === "verified" ? "VERIFIED" : "IMPORTED_PUBLIC";
  const sourceName = `import:${basename(file).replace(/[^\w .:@/+-]/g, "_").slice(0, 90)}`;
  let ok = 0, created = 0;
  const rejected: string[] = [];
  const notes = new Map<string, number>();
  for (const [i, row] of rows.entries()) {
    const input = { ...row, sourceType, sourceName, updateMethod: "import" };
    try {
      if (dryRun) {
        const r = prepareIntelRecord(input);
        for (const n of r.notes) notes.set(n, (notes.get(n) ?? 0) + 1);
      } else {
        const r = await upsertIntelRecord(input);
        if (r.created) created++;
        for (const n of r.record.notes) notes.set(n, (notes.get(n) ?? 0) + 1);
      }
      ok++;
    } catch (e) {
      rejected.push(`row ${i + 2}: ${e instanceof IntelValidationError ? e.issues.join("; ") : "error"}`);
    }
  }
  console.log(`${dryRun ? "[dry run] " : ""}${ok} valid (${created} new), ${rejected.length} rejected, source=${sourceType}, provenance=${sourceName}`);
  for (const [n, c] of notes) console.log(`  note (${c}×): ${n}`);
  for (const r of rejected.slice(0, 20)) console.log(`  ${r}`);
  if (rejected.length > 20) console.log(`  … ${rejected.length - 20} more`);
}

if (process.argv[1]?.endsWith("intel-import.ts")) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : "import failed");
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
