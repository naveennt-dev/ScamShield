/**
 * Export curated contributions.
 *   npx tsx --env-file=.env scripts/curate-contributions.ts [--dry-run]
 * - Reviewer-ACCEPTED rows → ml/datasets/raw/contributions/contributions-<date>.jsonl (training data,
 *   picked up by `npm run ml:train`, which produces a CANDIDATE model — see scripts/model-registry.ts).
 * - Unreviewed rows that passed the automatic checks → ml/datasets/review/contributions-review-<date>.jsonl
 *   for a human to check (set status ACCEPTED/REJECTED in the database). Never trained on.
 * Rules: src/lib/services/contribution-curation.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { prisma } from "@/lib/db/prisma";
import { curate } from "@/lib/services/contribution-curation";

async function main() {
  const dry = process.argv.includes("--dry-run");
  const rows = await prisma.contribution.findMany({
    select: { fingerprint: true, contributorHash: true, text: true, label: true, category: true, flags: true, status: true, createdAt: true },
  });
  const report = curate(rows);
  console.log(`contributions: ${rows.length} · verified (training): ${report.verified.length} · awaiting review: ${report.reviewQueue.length}`);
  console.log(`excluded: ${JSON.stringify(report.excluded)}`);
  if (dry) return;
  const day = new Date().toISOString().slice(0, 10);
  const write = (dir: string, file: string, rows: typeof report.verified) => {
    if (rows.length === 0) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${file}`, rows.map(({ text, label, category, source, language }) => JSON.stringify({ text, label, category, source, language })).join("\n") + "\n");
    console.log(`✓ wrote ${dir}/${file}`);
  };
  write("ml/datasets/raw/contributions", `contributions-${day}.jsonl`, report.verified);
  write("ml/datasets/review", `contributions-review-${day}.jsonl`, report.reviewQueue);
}
void main().finally(() => prisma.$disconnect());
