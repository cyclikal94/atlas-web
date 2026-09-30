#!/usr/bin/env bash
# B19 (--stub) and C3 / C4 / C5 (--real). Brings up deploy/compose.yaml on loopback: the reference nginx proxy (the only published
# port), the atlas-web image built from dist/, and either a STUB backend (deploy/stub-backend.conf, fixture evidence) or a REAL
# Atlas backend image (layer C evidence). Everything is torn down on exit, including volumes created by this project.
#
#   scripts/smoke-compose.sh --stub
#   ATLAS_BACKEND_IMAGE=ghcr.io/cyclikal94/atlas@sha256:... scripts/smoke-compose.sh --real
#
# Needs a Docker daemon (honours DOCKER_CONTEXT) and the docker-compose binary or plugin.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source deploy/base-images.env

MODE="${1:---stub}"
case "$MODE" in --stub | --real) ;; *) echo "usage: smoke-compose.sh --stub|--real" >&2; exit 2 ;; esac
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi
if docker buildx version >/dev/null 2>&1; then BUILD="docker buildx build --provenance=false --load"
elif command -v docker-buildx >/dev/null 2>&1; then BUILD="docker-buildx build --provenance=false --load"
else BUILD="docker build"; fi

EVIDENCE=".agtx/evidence/WEB-07/C5"
[ "$MODE" = "--stub" ] && EVIDENCE=".agtx/evidence/WEB-07/B19"
mkdir -p "$EVIDENCE"
RUN_ID="$$"
PROJECT="atlas-web-smoke-$RUN_ID"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/atlas-web-compose.XXXXXX")"
WEB_IMAGE="atlas-web-compose-smoke-$RUN_ID:local"
FAILED=0
UP=0
FILES=(-f deploy/compose.yaml)

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
PORT="$(free_port)"
DIRECT_PORT="$(free_port)"
ORIGIN="http://127.0.0.1:$PORT"

cleanup() {
  if [ "$UP" = 1 ]; then
    $COMPOSE -p "$PROJECT" "${FILES[@]}" logs --no-color >"$EVIDENCE/compose-logs-${MODE#--}.txt" 2>&1 || true
    $COMPOSE -p "$PROJECT" "${FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker rmi -f "$WEB_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "ok:   $*"; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
expect_contains() { case "$2" in *"$3"*) ok "$1" ;; *) fail "$1 (expected to contain '$3', got '$2')" ;; esac; }

[ -f dist/index.html ] && [ -f dist/_web/provenance.json ] || { echo "dist/ is missing or has no provenance: run pnpm build && pnpm package:prepare first" >&2; exit 2; }
node scripts/check-no-fixture.mjs dist >/dev/null

$BUILD --build-arg NGINX_IMAGE="$NGINX_IMAGE" -t "$WEB_IMAGE" . >"$TMP/build.log" 2>&1 || { tail -20 "$TMP/build.log" >&2; exit 1; }

export ATLAS_WEB_IMAGE="$WEB_IMAGE"
export ATLAS_PROXY_IMAGE="$NGINX_IMAGE"
export ATLAS_PROXY_PORT="$PORT"
export ATLAS_LISTEN_ADDRESS="127.0.0.1"
export ATLAS_PUBLIC_ORIGIN="$ORIGIN"
export ATLAS_PROXY_MAX_BODY="8m"
export ATLAS_POSTGRES_IMAGE="$POSTGRES_IMAGE"
ATLAS_POSTGRES_PASSWORD="$(openssl rand -hex 16)"   # disposable, URL-safe, never printed
export ATLAS_POSTGRES_PASSWORD
if [ "$MODE" = "--stub" ]; then
  export ATLAS_BACKEND_IMAGE="$NGINX_IMAGE"
  FILES+=(-f deploy/compose.fixture.yaml)
else
  : "${ATLAS_BACKEND_IMAGE:?set ATLAS_BACKEND_IMAGE to the verified Atlas backend image (a digest)}"
  export ATLAS_BACKEND_IMAGE
  # Test-only: publish the backend on a second loopback port so proxied answers can be compared with direct ones.
  cat >"$TMP/compose.direct.yaml" <<YAML
services:
  backend:
    ports:
      - "127.0.0.1:$DIRECT_PORT:3000"
YAML
  FILES+=(-f "$TMP/compose.direct.yaml")
fi

# Host bind mounts are not available in every Docker runtime (this repository's local runtime shares no host paths). The same
# files are therefore injected as Compose inline configs: the bytes in the container equal deploy/nginx/proxy.conf.template
# (and deploy/stub-backend.conf). deploy/compose.yaml's own bind-mount wiring is checked by `compose config` only here.
indent() { sed 's/\$/$$/g' "$1" | sed 's/^/        /'; }
{
  echo "configs:"
  echo "  proxy_template:"
  echo "    content: |"
  indent deploy/nginx/proxy.conf.template
  if [ "$MODE" = "--stub" ]; then
    echo "  stub_conf:"
    echo "    content: |"
    indent deploy/stub-backend.conf
  fi
  echo "services:"
  echo "  proxy:"
  echo "    read_only: false   # inline configs are written into the container, which needs a writable root (test only)"
  echo "    volumes: !reset []"
  echo "    configs:"
  echo "      - source: proxy_template"
  echo "        target: /etc/nginx/templates/default.conf.template"
  if [ "$MODE" = "--stub" ]; then
    echo "  backend:"
    echo "    read_only: false"
    echo "    volumes: !reset []"
    echo "    configs:"
    echo "      - source: stub_conf"
    echo "        target: /etc/nginx/conf.d/default.conf"
  fi
} >"$TMP/compose.configs.yaml"
FILES+=(-f "$TMP/compose.configs.yaml")

$COMPOSE -p "$PROJECT" "${FILES[@]}" config >"$EVIDENCE/compose-config-${MODE#--}.yaml"
UP=1  # from here on, the trap tears the project down even if `up` fails half-way
$COMPOSE -p "$PROJECT" "${FILES[@]}" up -d >"$TMP/up.log" 2>&1 || { tail -20 "$TMP/up.log" >&2; exit 1; }
for _ in $(seq 1 60); do curl -fsS -o /dev/null "$ORIGIN/_web/health" 2>/dev/null && break; sleep 0.5; done
expect_eq "the proxy serves the frontend's own probe" "$(curl -s "$ORIGIN/_web/health")" "ok"

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }

# --- frontend routing through the proxy
index="$(body "$ORIGIN/")"
expect_contains "/ is the app shell" "$index" 'id="protected-root" inert'
expect_eq "a deep link is the same shell" "$(body "$ORIGIN/settings/appearance")" "$index"
expect_eq "a missing asset is a 404 from the frontend, not the shell" "$(code "$ORIGIN/assets/missing.js")" 404
expect_contains "the frontend's security headers pass through the proxy" "$(curl -sI "$ORIGIN/")" "Content-Security-Policy: default-src 'none'"
expect_eq "provenance is served through the proxy" "$(body "$ORIGIN/_web/provenance.json")" "$(cat dist/_web/provenance.json)"

if [ "$MODE" = "--stub" ]; then
  # --- backend routing, path preservation and header pass-through (the stub echoes what it received)
  for path in /api/experimental/v1/tasks '/api/x?probe=1' /auth/callback /oidc/callback; do
    answer="$(body -H "Origin: $ORIGIN" -H "X-CSRF-Token: token-123" -H "Cookie: atlas_session=abc" "$ORIGIN$path")"
    expect_contains "backend path $path reaches the backend with the path unchanged" "$answer" "\"uri\":\"$path\""
  done
  expect_eq "/health?probe=1 is answered by the backend" "$(body "$ORIGIN/health?probe=1")" '{"status":"ok"}'
  answer="$(body -H "Origin: $ORIGIN" -H "X-CSRF-Token: token-123" -H "Cookie: atlas_session=abc" "$ORIGIN/api/x")"
  expect_contains "Host reaches the backend as the public host" "$answer" "\"host\":\"127.0.0.1:$PORT\""
  expect_contains "Origin reaches the backend unchanged" "$answer" "\"origin\":\"$ORIGIN\""
  expect_contains "X-CSRF-Token reaches the backend unchanged" "$answer" '"csrf":"token-123"'
  expect_contains "the request Cookie reaches the backend unchanged" "$answer" '"cookie":"atlas_session=abc"'
  expect_contains "X-Forwarded-Host is the public host" "$answer" "\"xfh\":\"127.0.0.1:$PORT\""
  expect_contains "X-Forwarded-Proto is set" "$answer" '"xfp":"http"'
  setcookie="$(curl -sI "$ORIGIN/api/x" | grep -i '^set-cookie:' | tr -d '\r')"
  expect_eq "Set-Cookie passes through exactly (no Domain added, no attribute rewritten)" "$setcookie" "Set-Cookie: atlas_session=stub-value; Path=/; HttpOnly; SameSite=Lax"
  expect_eq "exactly one Set-Cookie" "$(curl -sI "$ORIGIN/api/x" | grep -ic '^set-cookie:')" "1"
  expect_eq "/API/x (wrong case) is a client route, not the backend" "$(body "$ORIGIN/API/x")" "$index"
  expect_eq "/apiary is a client route" "$(body "$ORIGIN/apiary")" "$index"
  expect_contains "a double slash is normalised and still reaches the backend" "$(body "$ORIGIN//api/x")" '"host"'
  expect_eq "a small POST passes through" "$(code -X POST -d 'x' "$ORIGIN/api/x")" 200
  expect_eq "a body above the limit is refused by the proxy" "$(head -c 9000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @- "$ORIGIN/api/x")" 413
else
  # --- the real backend
  password="$(openssl rand -hex 16)"
  printf '%s\n' "$password" | $COMPOSE -p "$PROJECT" "${FILES[@]}" run --rm -T --no-deps backend account alice >"$TMP/account.log" 2>&1 || { cat "$TMP/account.log" >&2; fail "could not create the disposable account"; }
  for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$DIRECT_PORT/ready" 2>/dev/null && break; sleep 0.5; done
  export ATLAS_SMOKE_PASSWORD="$password"
  if node scripts/smoke-backend.mjs --origin "$ORIGIN" --direct "http://127.0.0.1:$DIRECT_PORT" --user alice --strict-assets \
      --label "reference nginx proxy + released container image" --out "$EVIDENCE"; then ok "real backend through the reference proxy (C3, C4, C5)"; else fail "real backend smoke"; fi
  echo "--- browser suite through the proxy (production project)"
  if ATLAS_PRODUCTION_URL="$ORIGIN" pnpm exec playwright test --project=production-chromium production.neutral production.csp >"$EVIDENCE/playwright-compose.log" 2>&1; then ok "production browser suite passes through the proxy"; else fail "production browser suite through the proxy (see $EVIDENCE/playwright-compose.log)"; fi
  $COMPOSE -p "$PROJECT" "${FILES[@]}" images >"$EVIDENCE/compose-images.txt" 2>&1 || true
fi

if [ "$FAILED" -ne 0 ]; then echo "Compose smoke ($MODE) FAILED" >&2; exit 1; fi
echo "Compose smoke ($MODE) ok."
