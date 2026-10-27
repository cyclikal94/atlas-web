#!/usr/bin/env bash
# B18 / C2. Builds the atlas-web image from the already-built dist/ for each platform, runs it as a hardened container
# (non-root, read-only root filesystem, no capabilities) and checks routing, headers, caching, provenance, content
# identity with dist/, and that no fixture code is inside. Needs a Docker daemon (honours DOCKER_CONTEXT).
#
#   PLATFORMS="linux/arm64 linux/amd64"   platforms to build and smoke-test (default: both)
#   BROWSER_PLATFORM=linux/arm64          the platform on which the browser suite also runs against the container
#
# Evidence goes to .agtx/evidence/WEB-07/<B18-C2>/. Containers and images created here are removed on exit.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source deploy/base-images.env

PLATFORMS="${PLATFORMS:-linux/arm64 linux/amd64}"
BROWSER_PLATFORM="${BROWSER_PLATFORM:-linux/arm64}"
EVIDENCE=".agtx/evidence/WEB-07/C2"
mkdir -p "$EVIDENCE"
RUN_ID="$$"
FAILED=0
CONTAINERS=()
IMAGES=()
TMP="$(mktemp -d "${TMPDIR:-/tmp}/atlas-web-image.XXXXXX")"

cleanup() {
  for c in "${CONTAINERS[@]:-}"; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true; done
  for i in "${IMAGES[@]:-}"; do [ -n "$i" ] && docker rmi -f "$i" >/dev/null 2>&1 || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT

# BuildKit (buildx) builds a non-native platform correctly; the legacy builder cannot. Use buildx when it is available.
if docker buildx version >/dev/null 2>&1; then BUILD="docker buildx build --provenance=false --load"
elif command -v docker-buildx >/dev/null 2>&1; then BUILD="docker-buildx build --provenance=false --load"
else BUILD="docker build"; fi

fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "ok:   $*"; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
expect_contains() { case "$2" in *"$3"*) ok "$1" ;; *) fail "$1 (expected to contain '$3', got '$2')" ;; esac; }

[ -f dist/index.html ] && [ -f dist/_web/provenance.json ] || { echo "dist/ is missing or has no provenance: run pnpm build && pnpm package:prepare first" >&2; exit 2; }
node scripts/check-no-fixture.mjs dist
node scripts/validate-provenance.mjs dist/_web/provenance.json
CSP="$(sed -n 's/^add_header Content-Security-Policy "\(.*\)" always;$/\1/p' deploy/nginx/security-headers.conf)"
(cd dist && find . -type f | LC_ALL=C sort | xargs shasum -a 256) > "$TMP/dist.sha256"

for platform in $PLATFORMS; do
  arch="${platform#linux/}"
  tag="atlas-web-smoke-$RUN_ID:$arch"
  name="atlas-web-smoke-$RUN_ID-$arch"
  echo "=== $platform"
  $BUILD --platform "$platform" --build-arg NGINX_IMAGE="$NGINX_IMAGE" \
    --build-arg ATLAS_WEB_VERSION="$(node -p "require('./package.json').version")" \
    --build-arg ATLAS_WEB_REVISION="$(node scripts/source-revision.mjs)" -t "$tag" . >/dev/null 2>&1
  IMAGES+=("$tag")
  docker image inspect "$tag" > "$EVIDENCE/image-inspect-$arch.json"

  docker run -d --name "$name" --platform "$platform" --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1::8080 "$tag" >/dev/null
  CONTAINERS+=("$name")
  port="$(docker port "$name" 8080/tcp | head -1 | sed 's/.*://')"
  base="http://127.0.0.1:$port"
  for _ in $(seq 1 40); do curl -fsS -o /dev/null "$base/_web/health" 2>/dev/null && break; sleep 0.5; done

  # --- process and filesystem hardening
  expect_eq "$arch: runs as UID 101 (not root)" "$(docker exec "$name" id -u)" "101"
  if docker exec "$name" sh -c 'touch /srv/atlas-web/x' 2>/dev/null; then fail "$arch: the site directory is writable"; else ok "$arch: the site directory is read-only"; fi
  if docker exec "$name" sh -c 'touch /etc/x' 2>/dev/null; then fail "$arch: the root filesystem is writable"; else ok "$arch: root filesystem is read-only"; fi
  docker exec "$name" sh -c 'touch /tmp/x' && ok "$arch: /tmp is writable (nginx pid and temporary files)"
  expect_eq "$arch: healthcheck passes" "$(docker exec "$name" wget -q -O - http://127.0.0.1:8080/_web/health)" "ok"

  # --- routing
  code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
  body() { curl -s "$@"; }
  expect_eq "$arch: / is 200" "$(code "$base/")" 200
  index="$(body "$base/")"
  expect_contains "$arch: / is the shell with an inert protected root" "$index" 'id="protected-root" inert'
  expect_eq "$arch: a deep link falls back to the shell" "$(body "$base/settings/appearance")" "$index"
  expect_eq "$arch: a deep link with a query falls back to the shell" "$(body "$base/tasks/1?x=1")" "$index"
  expect_eq "$arch: an unknown asset is a 404, not the shell" "$(code "$base/assets/missing.js")" 404
  expect_eq "$arch: an unknown file is a 404, not the shell" "$(code "$base/nope.png")" 404
  expect_eq "$arch: /fixture.html is a 404" "$(code "$base/fixture.html")" 404
  for path in /api /api/ /api/experimental/v1/tasks '/health' '/health?probe=1' '/ready' '/ready?probe=1' /auth '/auth?return_to=x' /auth/callback /oidc /oidc/callback '//api/x'; do
    expect_eq "$arch: backend path $path is an explicit 404" "$(code "$base$path")" 404
    case "$(body "$base$path")" in *'id="protected-root"'*) fail "$arch: $path received the shell" ;; esac
  done
  expect_eq "$arch: /API/x is case-sensitive, so it is a client route" "$(code "$base/API/x")" 200
  expect_eq "$arch: a similar name (/apiary) is a client route" "$(code "$base/apiary")" 200
  expect_eq "$arch: /_web/health" "$(body "$base/_web/health")" "ok"
  expect_eq "$arch: /_web/provenance.json equals dist's" "$(body "$base/_web/provenance.json")" "$(cat dist/_web/provenance.json)"
  expect_eq "$arch: dotfiles are denied" "$(code "$base/.env")" 404
  expect_eq "$arch: POST is 405" "$(code -X POST "$base/")" 405
  expect_eq "$arch: HEAD / is 200" "$(code -I "$base/")" 200

  # --- headers
  headers="$(curl -sI "$base/")"
  expect_contains "$arch: / has the exact content security policy" "$headers" "Content-Security-Policy: $CSP"
  expect_contains "$arch: nosniff" "$headers" "X-Content-Type-Options: nosniff"
  expect_contains "$arch: referrer policy" "$headers" "Referrer-Policy: no-referrer"
  expect_contains "$arch: opener policy" "$headers" "Cross-Origin-Opener-Policy: same-origin"
  expect_contains "$arch: index.html revalidates" "$headers" "Cache-Control: no-cache"
  for path in /sw.js /theme-init.js /_web/provenance.json /settings; do
    expect_contains "$arch: $path revalidates" "$(curl -sI "$base$path")" "Cache-Control: no-cache"
  done
  asset="$(printf '%s' "$index" | sed -n 's/.*src="\(\/assets\/index-[^"]*\.js\)".*/\1/p' | head -1)"
  font="$(cd dist && ls assets/*.woff2 | head -1)"
  ah="$(curl -sI "$base$asset")"
  expect_contains "$arch: hashed asset is immutable" "$ah" "Cache-Control: public, max-age=31536000, immutable"
  expect_contains "$arch: hashed asset keeps the security headers" "$ah" "X-Content-Type-Options: nosniff"
  expect_contains "$arch: JavaScript is compressed when the client accepts gzip" "$(curl -sI -H 'Accept-Encoding: gzip' "$base$asset")" "Content-Encoding: gzip"
  expect_contains "$arch: compressed responses vary on Accept-Encoding" "$(curl -sI -H 'Accept-Encoding: gzip' "$base$asset")" "Vary: Accept-Encoding"
  expect_eq "$arch: an uncompressed request gets the identical bytes back" "$(curl -s "$base$asset" | shasum -a 256 | cut -d' ' -f1)" "$(curl -s -H 'Accept-Encoding: gzip' "$base$asset" | gunzip | shasum -a 256 | cut -d' ' -f1)"
  expect_contains "$arch: woff2 has its MIME type" "$(curl -sI "$base/$font")" "font/woff2"
  expect_contains "$arch: a backend-path 404 keeps the security headers" "$(curl -sI "$base/api/x")" "Content-Security-Policy:"
  expect_contains "$arch: a backend-path 404 is not cached" "$(curl -sI "$base/api/x")" "Cache-Control: no-store"

  # --- content identity and no fixture code
  mkdir -p "$TMP/fs-$arch"
  docker export "$name" | tar -x -C "$TMP/fs-$arch" srv/atlas-web usr/share/atlas-web
  (cd "$TMP/fs-$arch/srv/atlas-web" && find . -type f | LC_ALL=C sort | xargs shasum -a 256) > "$EVIDENCE/served-$arch.sha256"
  if diff -q "$TMP/dist.sha256" "$EVIDENCE/served-$arch.sha256" >/dev/null; then ok "$arch: served files are byte-identical to dist/"; else fail "$arch: served files differ from dist/"; diff "$TMP/dist.sha256" "$EVIDENCE/served-$arch.sha256" | head >&2; fi
  node scripts/check-no-fixture.mjs "$TMP/fs-$arch/srv/atlas-web" >/dev/null && ok "$arch: no fixture code in the image filesystem" || fail "$arch: fixture code in the image"
  expect_eq "$arch: image provenance equals dist's" "$(cat "$TMP/fs-$arch/usr/share/atlas-web/provenance.json")" "$(cat dist/_web/provenance.json)"
  labels="$(docker image inspect "$tag" --format '{{json .Config.Labels}}')"
  expect_contains "$arch: OCI title label" "$labels" '"org.opencontainers.image.title":"atlas-web"'
  expect_contains "$arch: OCI licence label" "$labels" '"org.opencontainers.image.licenses":"AGPL-3.0-only"'

  # --- the browser suite against the real container (native architecture only)
  if [ "$platform" = "$BROWSER_PLATFORM" ]; then
    echo "--- browser suite against the $arch container (production project)"
    ATLAS_PRODUCTION_URL="$base" PLAYWRIGHT_JSON_OUTPUT_FILE="$EVIDENCE/playwright-inventory-$arch.json" pnpm exec playwright test --project=production-chromium production.neutral production.csp --workers=1 --retries=0 --repeat-each=1 --forbid-only --list --reporter=json > "$EVIDENCE/playwright-inventory-$arch.log" 2>&1
    if ATLAS_PRODUCTION_URL="$base" PLAYWRIGHT_JSON_OUTPUT_FILE="$EVIDENCE/playwright-image-$arch.json" pnpm exec playwright test --project=production-chromium production.neutral production.csp --workers=1 --retries=0 --repeat-each=1 --forbid-only --update-snapshots=none --reporter=list,json > "$EVIDENCE/playwright-image-$arch.log" 2>&1; then ok "$arch: production browser suite passes against the container"; else fail "$arch: production browser suite failed (see $EVIDENCE/playwright-image-$arch.log)"; tail -30 "$EVIDENCE/playwright-image-$arch.log" >&2; fi
  fi
  docker logs "$name" > "$EVIDENCE/container-log-$arch.txt" 2>&1 || true
done

if [ "$FAILED" -ne 0 ]; then echo "Image smoke FAILED" >&2; exit 1; fi
echo "Image smoke ok for: $PLATFORMS"
