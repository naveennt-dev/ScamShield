#!/usr/bin/env bash
# Runs the ScamShield local detection stack, loopback-only:
#   PostgreSQL  → 127.0.0.1:<port from DATABASE_URL>  (durable data, managed here if not already running)
#   Redis       → 127.0.0.1:<port from REDIS_URL>     (rate-limit counters only, nothing persisted)
#   ML service  → http://127.0.0.1:${ML_SERVICE_PORT:-8765}   (ml/inference/service.py)
#   Next.js API → http://127.0.0.1:${PORT:-3000}             (what the Mac app talks to)
#
#   scripts/local-stack.sh start | stop | restart | status
#
# Requires: npm run build (once), ml/.venv with ml/requirements.txt, a trained model, and (for the
# database) Homebrew PostgreSQL 17 + Redis. Next.js telemetry is disabled. `.env` is read, never
# modified, and no secret is printed.
#
# Data (never deleted by this script): ${SCAMSHIELD_DATA_DIR:-~/Library/Application Support/ScamShield/server}
#   postgres/   PostgreSQL cluster (created on first start; migrations applied additively)
#
# AI second opinion: enabled on the API when .env has an OpenRouter key (free models only, never a
# paid fallback). It is still opt-in per scan — only scans from an app whose user agreed to the AI
# second opinion are sent; everything else stays local. SCAMSHIELD_REMOTE_AI=0 forces it off.
#
# Link scans: page-behaviour inspection in an isolated browser is OFF by default (release audit:
# no OS-level isolation around Chromium on macOS — docs/design/link-protection.md §4). Opt in with
# SCAMSHIELD_DYNAMIC_INSPECTION=1; each inspection still needs an explicit click.
# URL threat feeds (URLhaus, PhishTank) are used only if their keys are in .env.
set -euo pipefail
cd "$(dirname "$0")/.."
RUN_DIR="${SCAMSHIELD_RUN_DIR:-.scamshield-run}"

# True when the AI second opinion can run: a key is configured (checked without printing it) and
# the user did not force it off with SCAMSHIELD_REMOTE_AI=0.
remote_ai_enabled() {
  if [[ "${SCAMSHIELD_REMOTE_AI:-}" == 0 ]]; then echo false; return; fi
  if [[ -f .env ]] && awk -F= '/^OPENROUTER_API_KEY=/{ v=$2; gsub(/["'"'"' ]/, "", v); found = length(v) > 0 } END { exit found ? 0 : 1 }' .env; then
    echo true
  else
    echo false
  fi
}
mkdir -p "$RUN_DIR"
ML_PORT="${ML_SERVICE_PORT:-8765}"
WEB_PORT="${PORT:-3000}"
DATA_DIR="${SCAMSHIELD_DATA_DIR:-$HOME/Library/Application Support/ScamShield/server}"
PGDATA_DIR="$DATA_DIR/postgres"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
[[ -x "$PG_BIN/pg_ctl" ]] || PG_BIN="$(dirname "$(command -v pg_ctl 2>/dev/null || echo /nonexistent/pg_ctl)")"

die() { echo "ERROR: $*" >&2; exit 1; }
is_up() { curl -sf -o /dev/null --max-time 2 "$1"; }
listener() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}'; }

# Reads one variable from .env (or the environment) without echoing it anywhere.
env_value() {
  local name="$1" v="${!1:-}"
  if [[ -z "$v" && -f .env ]]; then v="$(grep -E "^${name}=" .env | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/')"; fi
  printf '%s' "$v"
}

# DATABASE_URL → host port user dbname (password exported as PGPASSWORD for child processes only).
parse_db() {
  local url; url="$(env_value DATABASE_URL)"
  [[ -n "$url" ]] || return 1
  eval "$(python3 - "$url" <<'PY'
import sys, shlex
from urllib.parse import urlparse, unquote
u = urlparse(sys.argv[1])
vals = {"DB_HOST": u.hostname or "", "DB_PORT": str(u.port or 5432), "DB_USER": unquote(u.username or ""),
        "DB_NAME": (u.path or "/").lstrip("/").split("?")[0], "PGPASSWORD": unquote(u.password or "")}
print("\n".join(f"{k}={shlex.quote(v)}" for k, v in vals.items()))
PY
)"
  export PGPASSWORD
}

start_postgres() {
  if ! parse_db; then echo "Database   : not configured (DATABASE_URL empty) — scanning works without it"; return 0; fi
  [[ "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" ]] || { echo "Database   : external host — not managed here"; return 0; }
  if [[ -n "$(listener "$DB_PORT")" ]]; then
    if "$PG_BIN/psql" -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d postgres -Atqc "select 1" >/dev/null 2>&1; then
      echo "Database   : using PostgreSQL already running on 127.0.0.1:$DB_PORT"
    else
      die "port $DB_PORT (DATABASE_URL) is in use by $(listener "$DB_PORT") but it is not a PostgreSQL server accepting ScamShield's credentials. Stop it or change the port in .env."
    fi
  else
    [[ -x "$PG_BIN/initdb" ]] || die "PostgreSQL not found. Install it: brew install postgresql@17"
    local want; want="$("$PG_BIN/pg_ctl" --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
    if [[ ! -f "$PGDATA_DIR/PG_VERSION" ]]; then
      echo "Database   : creating durable cluster in $PGDATA_DIR"
      mkdir -p "$DATA_DIR"; chmod 700 "$DATA_DIR"
      if [[ -n "$PGPASSWORD" ]]; then
        local pw; pw="$(mktemp)"; chmod 600 "$pw"; printf '%s' "$PGPASSWORD" > "$pw"
        "$PG_BIN/initdb" -D "$PGDATA_DIR" -U "$DB_USER" --pwfile="$pw" -A scram-sha-256 -E UTF8 --locale=C >/dev/null
        rm -f "$pw"
      else
        # DATABASE_URL has no password: keep it working (it is not modified here) with trust auth.
        # The server listens on 127.0.0.1 only and the data folder is private to this macOS user,
        # but any process on this Mac could connect — add a password to DATABASE_URL to tighten it.
        echo "WARNING: DATABASE_URL has no password → PostgreSQL uses trust auth on 127.0.0.1 only. Consider adding a password." >&2
        "$PG_BIN/initdb" -D "$PGDATA_DIR" -U "$DB_USER" -A trust -E UTF8 --locale=C >/dev/null 2>&1
      fi
    fi
    local have; have="$(cat "$PGDATA_DIR/PG_VERSION")"
    [[ "$have" == "$want" ]] || die "database cluster is PostgreSQL $have but $PG_BIN is $want. Point PG_BIN at PostgreSQL $have (e.g. /opt/homebrew/opt/postgresql@$have/bin)."
    "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -l "$DATA_DIR/postgres.log" -w -t 30 \
      -o "-c listen_addresses=127.0.0.1 -p $DB_PORT -c unix_socket_directories='$PGDATA_DIR'" start >/dev/null
    echo "Database   : started (127.0.0.1:$DB_PORT, data in $PGDATA_DIR)"
  fi
  # Create the database if missing, then apply pending migrations (additive; never resets data).
  if [[ "$("$PG_BIN/psql" -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d postgres -Atqc "select 1 from pg_database where datname='$DB_NAME'")" != "1" ]]; then
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
  fi
  npx prisma migrate deploy >/dev/null 2>&1 && echo "Database   : migrations up to date" || die "prisma migrate deploy failed (run it manually to see why)"
}

stop_postgres() {
  if [[ -f "$PGDATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -m fast -w stop >/dev/null 2>&1 && echo "Database   : stopped" || true
  fi
}

start_redis() {
  local url; url="$(env_value REDIS_URL)"
  [[ -n "$url" ]] || { echo "Redis      : not configured (in-memory rate limiting)"; return 0; }
  local host port
  host="$(python3 -c 'import sys; from urllib.parse import urlparse; u=urlparse(sys.argv[1]); print(u.hostname or "")' "$url")"
  port="$(python3 -c 'import sys; from urllib.parse import urlparse; u=urlparse(sys.argv[1]); print(u.port or 6379)' "$url")"
  [[ "$host" == "127.0.0.1" || "$host" == "localhost" ]] || { echo "Redis      : external host — not managed here"; return 0; }
  if [[ -n "$(listener "$port")" ]]; then
    redis-cli -h 127.0.0.1 -p "$port" ping 2>/dev/null | grep -q PONG || die "port $port (REDIS_URL) is in use by $(listener "$port"), which is not Redis."
    echo "Redis      : using Redis already running on 127.0.0.1:$port"
    return 0
  fi
  command -v redis-server >/dev/null || die "Redis not found. Install it: brew install redis (or remove REDIS_URL from .env to use in-memory limits)"
  redis-server --bind 127.0.0.1 --port "$port" --save "" --appendonly no --daemonize yes \
    --pidfile "$PWD/$RUN_DIR/redis.pid" --logfile "$PWD/$RUN_DIR/redis.log" >/dev/null
  for _ in $(seq 1 20); do redis-cli -p "$port" ping >/dev/null 2>&1 && break; sleep 0.2; done
  echo "Redis      : started (127.0.0.1:$port, counters only)"
}

stop_redis() {
  if [[ -f "$RUN_DIR/redis.pid" ]] && kill -0 "$(cat "$RUN_DIR/redis.pid")" 2>/dev/null; then
    kill "$(cat "$RUN_DIR/redis.pid")" 2>/dev/null || true
    echo "Redis      : stopped"
  fi
  rm -f "$RUN_DIR/redis.pid"
}

# Removes a pid file whose process is gone (e.g. after a crash or reboot).
clear_stale() {
  local f="$RUN_DIR/$1.pid"
  if [[ -f "$f" ]] && ! kill -0 "$(cat "$f")" 2>/dev/null; then rm -f "$f"; echo "($1: removed stale pid file)"; fi
}

# A port that is busy but not answering our health URL belongs to something else → refuse.
check_port() {
  local port="$1" url="$2" what="$3"
  if [[ -n "$(listener "$port")" ]] && ! is_up "$url"; then
    die "port $port is in use by $(listener "$port"), not by the ScamShield $what. Stop that process or set ${4} to another port."
  fi
}

start() {
  [[ -f ml/models/model_manifest.json ]] || die "No trained model. Run: npm run ml:train"
  [[ -d .next ]] || die "No production build. Run: npm run build"
  [[ -x ml/.venv/bin/python ]] || die "Python environment missing. Run: python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt"
  clear_stale ml; clear_stale web
  start_postgres
  start_redis
  check_port "$ML_PORT" "http://127.0.0.1:$ML_PORT/health" "ML service" ML_SERVICE_PORT
  check_port "$WEB_PORT" "http://127.0.0.1:$WEB_PORT/api/v1/health" "API" PORT
  if ! is_up "http://127.0.0.1:$ML_PORT/health"; then
    ML_SERVICE_HOST=127.0.0.1 ML_SERVICE_PORT="$ML_PORT" nohup ml/.venv/bin/python ml/inference/service.py > "$RUN_DIR/ml.log" 2>&1 &
    echo $! > "$RUN_DIR/ml.pid"
  fi
  if ! is_up "http://127.0.0.1:$WEB_PORT/api/v1/health"; then
    NEXT_TELEMETRY_DISABLED=1 LOCAL_CLIENT_RATE_TIER=true CONTRIBUTIONS_ENABLED=true ALLOW_BROWSER_EXTENSION=true DYNAMIC_INSPECTION_ENABLED="$([[ "${SCAMSHIELD_DYNAMIC_INSPECTION:-0}" == 1 ]] && echo true || echo false)" LLM_ENABLED="$(remote_ai_enabled)" ML_SERVICE_URL="http://127.0.0.1:$ML_PORT" \
      nohup npx next start -H 127.0.0.1 -p "$WEB_PORT" > "$RUN_DIR/web.log" 2>&1 &
    echo $! > "$RUN_DIR/web.pid"
  fi
  for _ in $(seq 1 60); do
    is_up "http://127.0.0.1:$ML_PORT/health" && is_up "http://127.0.0.1:$WEB_PORT/api/v1/health" && break
    sleep 1
  done
  status
}

stop() {
  for svc in web ml; do
    if [[ -f "$RUN_DIR/$svc.pid" ]]; then
      pid="$(cat "$RUN_DIR/$svc.pid")"
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      rm -f "$RUN_DIR/$svc.pid"
    fi
  done
  stop_redis
  stop_postgres
  echo "stopped"
}

status() {
  if is_up "http://127.0.0.1:$ML_PORT/health"; then echo "ML service : up   (127.0.0.1:$ML_PORT)"; else echo "ML service : down"; fi
  if is_up "http://127.0.0.1:$WEB_PORT/api/v1/health"; then
    echo "Local API  : up   (127.0.0.1:$WEB_PORT)"
    curl -s "http://127.0.0.1:$WEB_PORT/api/v1/health" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print('Status     :', d['status']); print('Checks     :', d['checks']); print('ML model   :', d.get('mlModel'))"
  else
    echo "Local API  : down"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
