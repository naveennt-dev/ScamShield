-- Rollback for the Phase 5 migrations:
--   20261010123446_phase5_report_verdict  (adds scam_report.verdict)
--   20261010123212_phase5_scam_intel      (adds scam_intel + enums)
-- Removes ONLY what those migrations added; existing tables/rows are untouched.
-- Apply:  psql "$DATABASE_URL" -f prisma/rollbacks/20261010123212_phase5_scam_intel.down.sql
-- (Prisma's `migrate resolve --rolled-back` only applies to FAILED migrations, so the migration
--  history rows are removed here; `npx prisma migrate deploy` re-applies them later.)
BEGIN;
ALTER TABLE "scam_report" DROP COLUMN IF EXISTS "verdict";
DROP TABLE IF EXISTS "scam_intel";
DROP TYPE IF EXISTS "IntelSource";
DROP TYPE IF EXISTS "IntelStatus";
DROP TYPE IF EXISTS "IntelKind";
DELETE FROM "_prisma_migrations"
 WHERE migration_name IN ('20261010123446_phase5_report_verdict', '20261010123212_phase5_scam_intel');
COMMIT;
