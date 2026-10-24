#!/usr/bin/env bash
# B18 / C2. Builds the atlas-web image from the already-built dist/ for each platform, runs it as a hardened container
# (non-root, read-only root filesystem, no capabilities) and checks routing, headers, caching, provenance, content
# identity with dist/, and that no fixture code is inside. Needs a Docker daemon (honours DOCKER_CONTEXT).
#
#   PLATFORMS="linux/arm64 linux/amd64"   platforms to build and smoke-test (default: both)
#   BROWSER_PLATFORM=linux/arm64          the platform on which the browser suite also runs against the container
#
# The image is the static half of the one-origin deployment (Q6): it answers every backend path with a 404, which is checked
# directly against the container. The production app asks the server for its API version (`GET /health`, D-08) at boot, so the
# browser suite runs at a composed origin instead: the reference proxy (deploy/nginx/proxy.conf.template) in front of THIS image and
# the stub backend (deploy/stub-backend.conf), as deploy/compose.yaml and deploy/compose.fixture.yaml compose them. Every page, asset
# and worker byte still comes from the image under test (checked at the composed origin); only /health is the stub's, and a pass
# there is fixture evidence about the backend. Needs the docker-compose binary or plugin as well.
#
# Evidence goes to .agtx/evidence/WEB-07/<B18-C2>/. Containers, images and the Compose project created here are removed on exit.
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
PROJECT="atlas-web-smoke-image-$RUN_ID"
COMPOSE_FILES=(-f deploy/compose.yaml -f deploy/compose.fixture.yaml -f "$TMP/compose.image.yaml")
COMPOSED=0

compose_logs() {
  $COMPOSE -p "$PROJECT" "${COMPOSE_FILES[@]}" logs --no-color >"$EVIDENCE/composed-logs-$1.txt" 2>&1 || true
  $COMPOSE -p "$PROJECT" "${COMPOSE_FILES[@]}" ps -a >"$EVIDENCE/composed-ps-$1.txt" 2>&1 || true
}
cleanup() {
  if [ "$COMPOSED" = 1 ]; then
    compose_logs interrupted
    $COMPOSE -p "$PROJECT" "${COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  for c in "${CONTAINERS[@]:-}"; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true; done
  for i in "${IMAGES[@]:-}"; do [ -n "$i" ] && docker rmi -f "$i" >/dev/null 2>&1 || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT
# An interrupted run still removes what it created, and exits non-zero.
trap 'exit 130' INT
trap 'exit 143' TERM

# BuildKit (buildx) builds a non-native platform correctly; the legacy builder cannot. Use buildx when it is available.
if docker buildx version >/dev/null 2>&1; then BUILD="docker buildx build --provenance=false --load"
elif command -v docker-buildx >/dev/null 2>&1; then BUILD="docker-buildx build --provenance=false --load"
else BUILD="docker build"; fi
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi

fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "ok:   $*"; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
expect_contains() { case "$2" in *"$3"*) ok "$1" ;; *) fail "$1 (expected to contain '$3', got '$2')" ;; esac; }
header_line() { curl -sI "$2" | tr -d '\r' | grep -i "^$1:" || true; }
STUB_HEALTH='{"api_version":"0.29.0","status":"ok"}'

# The composed origin for the browser suite: the reference proxy, the image under test ($1, already built) as the frontend and the
# stub backend. The proxy and the stub receive their configuration as Compose inline configs (byte-equal to the files in deploy/),
# because host bind mounts are not available in every Docker runtime; that needs a writable root in those two containers (test
# only). The frontend keeps compose.yaml's hardening. Sets ORIGIN, or fails and returns non-zero without starting a browser.
compose_up() {
  local image="$1" arch="$2" direct="$3" web image_id
  indent() { sed 's/\$/$$/g' "$1" | sed 's/^/        /'; }
  {
    echo "configs:"
    echo "  proxy_template:"
    echo "    content: |"
    indent deploy/nginx/proxy.conf.template
    echo "  stub_conf:"
    echo "    content: |"
    indent deploy/stub-backend.conf
    echo "services:"
    echo "  proxy:"
    echo "    read_only: false"
    echo "    volumes: !reset []"
    echo "    ports: !override"
    echo "      - \"127.0.0.1::8080\""
    echo "    configs:"
    echo "      - source: proxy_template"
    echo "        target: /etc/nginx/templates/default.conf.template"
    echo "  backend:"
    echo "    read_only: false"
    echo "    volumes: !reset []"
    echo "    configs:"
    echo "      - source: stub_conf"
    echo "        target: /etc/nginx/conf.d/default.conf"
  } >"$TMP/compose.image.yaml"
  image_id="$(docker image inspect "$image" --format '{{.Id}}')"
  {
    echo "image=$image"
    echo "image_id=$image_id"
    echo "platform=linux/$arch"
    echo "direct_origin=$direct"
    echo "project=$PROJECT"
    echo "proxy=deploy/nginx/proxy.conf.template sha256 $(shasum -a 256 deploy/nginx/proxy.conf.template | cut -d' ' -f1)"
    echo "backend=STUB deploy/stub-backend.conf sha256 $(shasum -a 256 deploy/stub-backend.conf | cut -d' ' -f1) (fixture evidence, not a real backend)"
  } >"$EVIDENCE/composed-$arch.txt"
  # compose.yaml interpolates every service; the stub ignores the backend's settings and postgres is disabled by compose.fixture.yaml.
  export ATLAS_WEB_IMAGE="$image" ATLAS_PROXY_IMAGE="$NGINX_IMAGE" ATLAS_BACKEND_IMAGE="$NGINX_IMAGE" ATLAS_POSTGRES_IMAGE="$POSTGRES_IMAGE"
  export ATLAS_PUBLIC_ORIGIN="http://127.0.0.1" ATLAS_POSTGRES_PASSWORD="unused-by-the-stub" ATLAS_PROXY_MAX_BODY="8m"
  $COMPOSE -p "$PROJECT" "${COMPOSE_FILES[@]}" config >"$EVIDENCE/composed-config-$arch.yaml" 2>"$TMP/config.log" \
    || { cat "$TMP/config.log" >&2; fail "$arch: the composed origin's Compose configuration is invalid"; return 1; }
  COMPOSED=1  # from here on, teardown removes the project even if `up` fails half-way
  $COMPOSE -p "$PROJECT" "${COMPOSE_FILES[@]}" up -d --no-build >"$TMP/up.log" 2>&1 \
    || { cat "$TMP/up.log" >&2; fail "$arch: the composed origin did not start"; return 1; }
  ORIGIN="http://$($COMPOSE -p "$PROJECT" "${COMPOSE_FILES[@]}" port proxy 8080)"
  echo "composed_origin=$ORIGIN" >>"$EVIDENCE/composed-$arch.txt"
  # Ready when the proxy serves both halves; at most 30 s, and an unreachable upstream cannot hold a probe longer than 2 s.
  local deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ "$(curl -s -m 2 "$ORIGIN/_web/health")" = ok ] && [ "$(curl -s -m 2 "$ORIGIN/health")" = "$STUB_HEALTH" ] && break
    sleep 0.5
  done
  [ "$(curl -s -m 2 "$ORIGIN/_web/health")" = ok ] || { fail "$arch: the composed origin never served the frontend"; return 1; }
  [ "$(curl -s -m 2 "$ORIGIN/health")" = "$STUB_HEALTH" ] || { fail "$arch: the composed origin never answered /health"; return 1; }
  web="$($COMPOSE -p "$PROJECT" "${COMPOSE_FILES[@]}" ps -q web)"
  expect_eq "$arch: the composed frontend runs the image under test" "$(docker inspect "$web" --format '{{.Image}}')" "$image_id"
}

# What the browser sees at the composed origin is the image's, apart from the stub's /health.
check_composed() {
  local arch="$1" direct="$2" index="$3" asset="$4" font="$5" name
  expect_eq "$arch: the image itself still answers /health with a 404" "$(curl -s -o /dev/null -w '%{http_code}' "$direct/health")" 404
  expect_eq "$arch: composed /health is the stub backend's answer" "$(curl -s "$ORIGIN/health")" "$STUB_HEALTH"
  expect_contains "$arch: composed /health is labelled as the stub's" "$(curl -sI "$ORIGIN/health")" "X-Stub-Backend: true"
  case "$(curl -sI "$ORIGIN/")" in *[Xx]-[Ss]tub-[Bb]ackend*) fail "$arch: the composed / came from the stub" ;; *) ok "$arch: the composed / comes from the frontend" ;; esac
  expect_eq "$arch: the composed / is the image's shell" "$(curl -s "$ORIGIN/")" "$index"
  for name in $(sed -n 's/^add_header \([^ ]*\) .*/\1/p' deploy/nginx/security-headers.conf) Cache-Control; do
    expect_eq "$arch: composed / keeps the image's $name" "$(header_line "$name" "$ORIGIN/")" "$(header_line "$name" "$direct/")"
  done
  expect_eq "$arch: composed hashed asset keeps the image's Cache-Control" "$(header_line Cache-Control "$ORIGIN$asset")" "$(header_line Cache-Control "$direct$asset")"
  expect_eq "$arch: composed /sw.js keeps the image's Content-Type" "$(header_line Content-Type "$ORIGIN/sw.js")" "$(header_line Content-Type "$direct/sw.js")"
  for file in "${asset#/}" sw.js manifest.webmanifest "$font"; do
    expect_eq "$arch: composed /$file equals dist's" "$(curl -s "$ORIGIN/$file" | shasum -a 256 | cut -d' ' -f1)" "$(shasum -a 256 "dist/$file" | cut -d' ' -f1)"
  done
}

# The stub echoes any backend path with a 200 (deploy/stub-backend.conf), where Playwright's own stub (scripts/preview-with-stub-backend.mjs)
# answers a 404. The suite must therefore have asked it nothing but /health or /ready, or a pass here could hide what fails there.
check_backend_requests() {
  local arch="$1" log browser asked=no
  log="$EVIDENCE/composed-backend-requests-$arch.txt"
  $COMPOSE -p "$PROJECT" "${COMPOSE_FILES[@]}" logs --no-color --no-log-prefix backend 2>&1 | grep '\] "' >"$log" || true
  browser="$(grep -v '"curl/' "$log" || true)"
  if grep -q '"GET /health HTTP/1.1" 200 ' <<<"$browser"; then asked=yes; fi
  expect_eq "$arch: the browser asked the stub backend for /health" "$asked" yes
  expect_eq "$arch: the browser asked the stub backend for nothing but /health and /ready" "$(printf '%s\n' "$browser" | grep -v '^$' | grep -cvE '"(GET|HEAD) /(health|ready)(\?[^ ]*)? HTTP/1.1"' || true)" 0
}

compose_down() {
  local arch="$1" left
  [ "$COMPOSED" = 1 ] || return 0
  compose_logs "$arch"
  $COMPOSE -p "$PROJECT" "${COMPOSE_FILES[@]}" down -v --remove-orphans >"$TMP/down.log" 2>&1 || { cat "$TMP/down.log" >&2; fail "$arch: the composed origin was not torn down"; }
  COMPOSED=0
  left="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
  expect_eq "$arch: no container of the composed origin is left" "$left" ""
}

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
  for path in /sw.js /theme-init.js /manifest.webmanifest /icons/icon-192.png /_web/provenance.json /settings; do
    expect_contains "$arch: $path revalidates" "$(curl -sI "$base$path")" "Cache-Control: no-cache"
  done
  # WEB-14a: the installable app's manifest and icons are served with their media types.
  expect_contains "$arch: the web app manifest has its MIME type" "$(curl -sI "$base/manifest.webmanifest")" "application/manifest+json"
  expect_eq "$arch: the web app manifest equals dist's" "$(body "$base/manifest.webmanifest")" "$(cat dist/manifest.webmanifest)"
  expect_contains "$arch: the icons are PNG" "$(curl -sI "$base/icons/icon-512.png")" "image/png"
  expect_contains "$arch: the worker is JavaScript" "$(curl -sI "$base/sw.js")" "javascript"
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

  # --- the browser suite against the real container (native architecture only), at the composed origin (see the top of this file)
  if [ "$platform" = "$BROWSER_PLATFORM" ]; then
    echo "--- browser suite against the $arch container through the reference proxy (production project; stub backend)"
    if compose_up "$tag" "$arch" "$base"; then
      check_composed "$arch" "$base" "$index" "$asset" "$font"
      ATLAS_PRODUCTION_URL="$ORIGIN" PLAYWRIGHT_JSON_OUTPUT_FILE="$EVIDENCE/playwright-inventory-$arch.json" \
        pnpm exec playwright test --project=production-chromium production.neutral production.csp \
        --workers=1 --retries=0 --repeat-each=1 --forbid-only --list --reporter=json > "$EVIDENCE/playwright-inventory-$arch.log" 2>&1
      if ATLAS_PRODUCTION_URL="$ORIGIN" PLAYWRIGHT_JSON_OUTPUT_FILE="$EVIDENCE/playwright-image-$arch.json" \
        pnpm exec playwright test --project=production-chromium production.neutral production.csp \
        --workers=1 --retries=0 --repeat-each=1 --forbid-only --update-snapshots=none --reporter=list,json > "$EVIDENCE/playwright-image-$arch.log" 2>&1; then ok "$arch: production browser suite passes against the container"; else fail "$arch: production browser suite failed (see $EVIDENCE/playwright-image-$arch.log)"; tail -30 "$EVIDENCE/playwright-image-$arch.log" >&2; fi
      check_backend_requests "$arch"
    else
      fail "$arch: production browser suite not run: the composed origin is not ready"
    fi
    compose_down "$arch"
  fi
  docker logs "$name" > "$EVIDENCE/container-log-$arch.txt" 2>&1 || true
done

if [ "$FAILED" -ne 0 ]; then echo "Image smoke FAILED" >&2; exit 1; fi
echo "Image smoke ok for: $PLATFORMS"
