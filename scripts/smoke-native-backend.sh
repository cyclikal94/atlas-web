#!/usr/bin/env bash
# C3 / C4 with a NATIVE released backend binary (acquisition option 1) and the Vite preview proxy standing in for the
# reverse proxy. This proves the frontend build works through a same-origin proxy against the real backend and that the
# preview proxy passes Set-Cookie, X-CSRF-Token and Origin through untouched. It is NOT evidence about the reference nginx
# proxy (scripts/smoke-compose.sh --real is), and the report labels it as such.
#
#   scripts/smoke-native-backend.sh /path/to/atlas-server
#
# Loopback listeners only; the database is a disposable SQLite file under TMPDIR; every process started here is stopped on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_BIN="${1:?usage: smoke-native-backend.sh /path/to/atlas-server}"
BACKEND_PORT="${BACKEND_PORT:-3111}"
PREVIEW_PORT="${PREVIEW_PORT:-4175}"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/atlas-web-native.XXXXXX")"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1 || true
  done
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && wait "$pid" >/dev/null 2>&1 || true
  done
  rm -rf "$TMPD"
}
trap cleanup EXIT

[ -f dist/index.html ] || { echo "dist/ is missing: run pnpm build first" >&2; exit 2; }

ATLAS_SMOKE_PASSWORD="$(openssl rand -hex 16)"
export ATLAS_SMOKE_PASSWORD
DB="sqlite://$TMPD/atlas.sqlite?mode=rwc"
ORIGIN="http://127.0.0.1:$PREVIEW_PORT"
DIRECT="http://127.0.0.1:$BACKEND_PORT"

printf '%s\n' "$ATLAS_SMOKE_PASSWORD" | ATLAS_DATABASE_URL="$DB" "$BACKEND_BIN" account alice >"$TMPD/account.log" 2>&1 || { cat "$TMPD/account.log" >&2; exit 1; }

ATLAS_BIND="127.0.0.1:$BACKEND_PORT" ATLAS_PUBLIC_ORIGIN="$ORIGIN" ATLAS_DATABASE_URL="$DB" \
  "$BACKEND_BIN" >"$TMPD/backend.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 60); do curl -fsS "$DIRECT/ready" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$DIRECT/ready" >/dev/null || { echo "backend did not become ready" >&2; tail -20 "$TMPD/backend.log" >&2; exit 1; }

# Run vite directly (not through pnpm) so the recorded PID is the server itself and cleanup really stops it.
ATLAS_BACKEND_URL="$DIRECT" node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port "$PREVIEW_PORT" --strictPort >"$TMPD/preview.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 40); do curl -sS -o /dev/null "$ORIGIN/" 2>/dev/null && break; sleep 0.5; done

node scripts/smoke-backend.mjs --origin "$ORIGIN" --direct "$DIRECT" --user alice \
  --label "vite preview proxy + native release binary" --out .agtx/evidence/WEB-07/C3
