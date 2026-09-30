#!/usr/bin/env bash
# B10 (real nginx layer). Serves the FIXTURE build (dist-fixture/) through the real frontend nginx configuration, with the
# real security headers, and runs the whole fixture browser suite against it. Any content security policy violation is a console
# error, and the console guard in tests/e2e/helpers.ts fails the run on it. The image built here is a throwaway check
# fixture: it contains fixture code, is never tagged for release and is removed on exit. Needs a Docker daemon.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source deploy/base-images.env

EVIDENCE=".agtx/evidence/WEB-07/B10"
mkdir -p "$EVIDENCE"
[ -f dist-fixture/index.html ] || { echo "dist-fixture/ is missing: run pnpm build:fixture first" >&2; exit 2; }
if docker buildx version >/dev/null 2>&1; then BUILD="docker buildx build --provenance=false --load"
elif command -v docker-buildx >/dev/null 2>&1; then BUILD="docker-buildx build --provenance=false --load"
else BUILD="docker build"; fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/atlas-web-fixture-nginx.XXXXXX")"
IMAGE="atlas-web-fixture-nginx-$$:local"
NAME="atlas-web-fixture-nginx-$$"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/ctx/deploy/nginx"
cp -R dist-fixture "$TMP/ctx/dist-fixture"
cp deploy/nginx/web.conf deploy/nginx/security-headers.conf "$TMP/ctx/deploy/nginx/"
cat >"$TMP/ctx/Dockerfile" <<EOF
FROM $NGINX_IMAGE
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/atlas-security-headers.conf
COPY deploy/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY dist-fixture/ /srv/atlas-web/
EOF
$BUILD -t "$IMAGE" "$TMP/ctx" >"$TMP/build.log" 2>&1 || { tail -20 "$TMP/build.log" >&2; exit 1; }
docker run -d --name "$NAME" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1::8080 "$IMAGE" >/dev/null
port="$(docker port "$NAME" 8080/tcp | head -1 | sed 's/.*://')"
base="http://127.0.0.1:$port"
for _ in $(seq 1 40); do curl -fsS -o /dev/null "$base/_web/health" 2>/dev/null && break; sleep 0.5; done
curl -fsS "$base/_web/health" >/dev/null || { docker logs "$NAME" >&2; exit 1; }

echo "Fixture suite (chromium) against the real nginx configuration at $base"
if ATLAS_FIXTURE_URL="$base" pnpm exec playwright test --project=fixture-chromium >"$EVIDENCE/playwright-fixture-nginx.log" 2>&1; then
  tail -3 "$EVIDENCE/playwright-fixture-nginx.log"
  echo "Fixture suite passes behind the real nginx headers (zero CSP violations)."
else
  tail -40 "$EVIDENCE/playwright-fixture-nginx.log" >&2
  echo "Fixture suite FAILED behind the real nginx headers" >&2
  exit 1
fi
