#!/usr/bin/env bash
# Phase 5 migration safety check on a throw-away database (never touches your data):
#   pre-Phase-5 schema + sample data → upgrade → verify data kept → rollback → verify → re-apply.
# Usage: scripts/verify-migrations.sh   (needs the local PostgreSQL from .env running)
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | sed -E 's#/[^/?]+(\?.*)?$##')"
DB=scamshield_migcheck_$$
PSQL="${PSQL:-$(command -v psql || echo /opt/homebrew/opt/postgresql@17/bin/psql)}"
URL="$BASE_URL/$DB"
TMP="$(mktemp -d)"
cleanup() { "$PSQL" "$BASE_URL/postgres" -qc "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$PSQL" "$BASE_URL/postgres" -qc "CREATE DATABASE $DB" >/dev/null

# 1. Pre-Phase-5 schema: the same migrations minus the phase5_* ones.
mkdir -p "$TMP/prisma/migrations"
cp prisma/schema.prisma "$TMP/prisma/"
for m in prisma/migrations/*/; do m="${m%/}"; [[ "$m" == *phase5_* ]] || cp -R "$m" "$TMP/prisma/migrations/"; done
cp prisma/migrations/migration_lock.toml "$TMP/prisma/migrations/"
DATABASE_URL="$URL" npx prisma migrate deploy --schema "$TMP/prisma/schema.prisma" >/dev/null

# 2. Old-shape data.
"$PSQL" "$URL" -q <<'SQL'
INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('u1','U','u1@test.local',true,now(),now());
INSERT INTO scam_report(id,"userId","reportType",category,fingerprint,domain,"contentPreview",status,"createdAt") VALUES ('r1','u1','url','kyc','fp1','old-example.top','preview','PENDING',now());
INSERT INTO scam_pattern(id,"patternType",value,category,"reportCount","distinctReporters",confidence,status,"firstSeen","lastSeen") VALUES ('p1','DOMAIN','old-example.top','kyc',3,3,0.5,'UNVERIFIED',now(),now());
SQL
snapshot() { "$PSQL" "$URL" -At -c "SELECT (SELECT count(*) FROM \"user\")||'/'||(SELECT count(*) FROM scam_report)||'/'||(SELECT count(*) FROM scam_pattern)||'/'||(SELECT string_agg(id||':'||fingerprint||':'||domain,',') FROM scam_report)"; }
BEFORE="$(snapshot)"

# 3. Upgrade with the Phase 5 migrations.
DATABASE_URL="$URL" npx prisma migrate deploy >/dev/null
AFTER="$(snapshot)"
VERDICT="$("$PSQL" "$URL" -At -c "SELECT verdict FROM scam_report WHERE id='r1'")"
INTEL="$("$PSQL" "$URL" -At -c "SELECT count(*) FROM scam_intel")"
[[ "$BEFORE" == "$AFTER" ]] && echo "PASS upgrade keeps existing rows ($AFTER)" || { echo "FAIL upgrade changed data: $BEFORE → $AFTER"; exit 1; }
[[ "$VERDICT" == "scam" ]] && echo "PASS existing report gets verdict default 'scam'" || { echo "FAIL verdict=$VERDICT"; exit 1; }
[[ "$INTEL" == "0" ]] && echo "PASS scam_intel created empty" || { echo "FAIL scam_intel=$INTEL"; exit 1; }

# 4. Rollback (documented down script) → data intact, Phase 5 objects gone.
"$PSQL" "$URL" -q -v ON_ERROR_STOP=1 -f prisma/rollbacks/20261010123212_phase5_scam_intel.down.sql >/dev/null
ROLLED="$(snapshot)"
GONE="$("$PSQL" "$URL" -At -c "SELECT to_regclass('scam_intel') IS NULL")"
[[ "$ROLLED" == "$BEFORE" && "$GONE" == "t" ]] && echo "PASS rollback keeps existing rows and removes Phase 5 objects" || { echo "FAIL rollback: $ROLLED gone=$GONE"; exit 1; }

# 5. Re-apply.
DATABASE_URL="$URL" npx prisma migrate deploy >/dev/null
[[ "$(snapshot)" == "$BEFORE" ]] && echo "PASS re-apply after rollback keeps existing rows" || { echo "FAIL re-apply"; exit 1; }
echo "MIGRATION CHECK PASSED"
