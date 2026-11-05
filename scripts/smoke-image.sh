#!/usr/bin/env bash
# B18 / C2. Builds the atlas-web image from the already-built dist/ for each platform, runs it as a hardened container
# (non-root, read-only root filesystem, no capabilities) and checks routing, headers, caching, provenance, content
# identity with dist/, and that no fixture code is inside. Needs a Docker daemon (honours DOCKER_CONTEXT).
#
#   PLATFORMS="linux/arm64 linux/amd64"   platforms to build and smoke-test (default: both)
#   BROWSER_PLATFORM=linux/arm64          the platform on which the browser suite also runs against the container
#   SMOKE_IMAGE_EVIDENCE=<directory>      where the evidence goes (default .agtx/evidence/WEB-07/C2); it must be absent or empty,
#                                         so an earlier attempt's evidence is never overwritten
#
# The image is the static half of the one-origin deployment (Q6) and answers every backend path with a 404, which is checked
# directly against the container. The production app asks the server for its API version (`GET /health`, D-08) at boot, so the
# browser suite runs at a COMPOSED origin: the reference proxy (deploy/nginx/proxy.conf.template) in front of THIS container (the
# one inspected above, reached at its address on Docker's default bridge, its own networking untouched) and a check-only stub
# backend (scripts/smoke-image-backend.conf: /health and /ready in the released shape, 404 for everything else). Pages, assets
# and the worker still come from the image under test, and
# are checked byte for byte at the composed origin before any browser starts; only the backend paths are the stub's, and a pass
# there is fixture evidence about the backend. The pinned case list (scripts/smoke-image-cases.json) must be discovered and pass
# exactly, and the stub's log must show the browser asked it for /health and nothing but /health and /ready.
#
# Everything this run creates is labelled with its run id (images by tag), removed on every exit (success, failure or signal) and
# then looked for again: anything left fails the run.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source deploy/base-images.env

PLATFORMS="${PLATFORMS:-linux/arm64 linux/amd64}"
BROWSER_PLATFORM="${BROWSER_PLATFORM:-linux/arm64}"
EVIDENCE="${SMOKE_IMAGE_EVIDENCE:-.agtx/evidence/WEB-07/C2}"
if [ -d "$EVIDENCE" ] && [ -n "$(ls -A "$EVIDENCE")" ]; then
  echo "$EVIDENCE already holds an earlier attempt's evidence: set SMOKE_IMAGE_EVIDENCE to a fresh directory" >&2
  exit 2
fi
mkdir -p "$EVIDENCE"
RUN_ID="$$-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
LABEL="atlas-web-smoke-image=$RUN_ID"
FAILED=0
CONTAINERS=()
IMAGES=()
CHILD=""
TMP="$(mktemp -d "${TMPDIR:-/tmp}/atlas-web-image.XXXXXX")"
STUB_CONF=scripts/smoke-image-backend.conf
STUB_HEALTH='{"api_version":"0.29.0","status":"ok"}'
STUB_READY='{"status":"ready"}'
echo "run_id=$RUN_ID" >"$EVIDENCE/run.txt"

# What this run owns and has not removed: containers by label, images by tag.
survivors() {
  docker ps -aq --filter "label=$LABEL"
  for i in "${IMAGES[@]:-}"; do
    if [ -n "$i" ]; then docker image inspect "$i" --format "{{.Id}} $i" 2>/dev/null; fi
  done
  return 0
}

stop_child() {
  [ -n "$CHILD" ] || return 0
  kill -TERM -- "-$CHILD" 2>/dev/null || kill -TERM "$CHILD" 2>/dev/null || true
  wait "$CHILD" 2>/dev/null || true
  CHILD=""
}

# Every removal is attempted whatever another one did (no errexit here); what is left is then looked for, so a removal that
# failed shows up as a survivor.
cleanup() {
  local rc=$? left
  set +e
  trap - INT TERM
  stop_child
  for c in "${CONTAINERS[@]:-}"; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1; done
  for i in "${IMAGES[@]:-}"; do [ -n "$i" ] && docker rmi -f "$i" >/dev/null 2>&1; done
  rm -rf "$TMP"
  if docker info >/dev/null 2>&1; then left="$(survivors | sort -u)"; else left="unknown: the Docker daemon cannot be asked"; fi
  { echo "exit_before_cleanup=$rc"; echo "survivors=${left:-none}"; } >"$EVIDENCE/cleanup.txt"
  if [ -n "$left" ]; then
    echo "FAIL: resources this run created survived cleanup:" >&2
    echo "$left" >&2
    [ "$rc" -ne 0 ] || rc=1
  fi
  exit "$rc"
}
trap cleanup EXIT
# A signal stops the child that is running (its whole process group), then the EXIT trap removes what this run created.
trap 'stop_child; exit 130' INT
trap 'stop_child; exit 143' TERM

# Long commands run in the background, in a process group of their own, so a signal reaches this script while they run.
run_child() {
  local rc=0
  set -m
  "$@" </dev/null &
  CHILD=$!
  set +m
  wait "$CHILD" || rc=$?
  CHILD=""
  return "$rc"
}

# BuildKit (buildx) builds a non-native platform correctly; the legacy builder cannot. Use buildx when it is available.
if docker buildx version >/dev/null 2>&1; then BUILD="docker buildx build --provenance=false --load"
elif command -v docker-buildx >/dev/null 2>&1; then BUILD="docker-buildx build --provenance=false --load"
else BUILD="docker build"; fi

fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "ok:   $*"; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
expect_contains() { case "$2" in *"$3"*) ok "$1" ;; *) fail "$1 (expected to contain '$3', got '$2')" ;; esac; }
header_line() { curl -sI "${@:2}" | tr -d '\r' | grep -i "^$1:" || true; }
sha() { shasum -a 256 | cut -d' ' -f1; }

[ -f dist/index.html ] && [ -f dist/_web/provenance.json ] || { echo "dist/ is missing or has no provenance: run pnpm build && pnpm package:prepare first" >&2; exit 2; }
node scripts/check-no-fixture.mjs dist
node scripts/validate-provenance.mjs dist/_web/provenance.json
CSP="$(sed -n 's/^add_header Content-Security-Policy "\(.*\)" always;$/\1/p' deploy/nginx/security-headers.conf)"
(cd dist && find . -type f | LC_ALL=C sort | xargs shasum -a 256) > "$TMP/dist.sha256"
cp "$TMP/dist.sha256" "$EVIDENCE/prepared-dist.sha256"

# The composed origin for the browser suite (see the top of this file). $1 is the container already checked above, $2 its image,
# $3 the architecture and $4 its direct origin. The proxy and the stub are hardened like the image (read-only root, no
# capabilities); their configuration arrives in the environment and is written to a tmpfs, because host bind mounts are not
# available in every Docker runtime, and is then compared byte for byte with the files in this repository. All three stay on
# Docker's default bridge and the proxy reaches the other two by address: joining the container under test to a second network
# can move its default gateway there and silently break its published port (Docker picks the gateway network by priority and
# then by name). Sets ORIGIN, or fails and returns non-zero without starting a browser.
bridge_ip() { docker inspect "$1" --format '{{with index .NetworkSettings.Networks "bridge"}}{{.IPAddress}}{{end}}' 2>/dev/null; }
compose_up() {
  local name="$1" tag="$2" arch="$3" direct="$4" proxy="$1-proxy" backend="$1-backend" image_id deadline web_ip backend_ip
  # shellcheck disable=SC2054  # the commas are tmpfs mount options, not array separators
  local hardened=(--read-only --cap-drop ALL --security-opt no-new-privileges --label "$LABEL" --tmpfs /tmp
    --tmpfs /etc/nginx/conf.d:uid=101,gid=101,mode=0755)
  CONTAINERS+=("$backend")
  docker run -d --name "$backend" "${hardened[@]}" \
    -e ATLAS_SMOKE_CONF="$(cat "$STUB_CONF")" --entrypoint /bin/sh "$NGINX_IMAGE" \
    -c 'printf "%s\n" "$ATLAS_SMOKE_CONF" > /etc/nginx/conf.d/default.conf && exec nginx -g "daemon off;"' >/dev/null \
    || { fail "$arch: the stub backend did not start"; return 1; }
  web_ip="$(bridge_ip "$name")"
  backend_ip="$(bridge_ip "$backend")"
  [ -n "$web_ip" ] && [ -n "$backend_ip" ] || { fail "$arch: no default-bridge address for the container under test or the stub"; return 1; }
  CONTAINERS+=("$proxy")
  docker run -d --name "$proxy" "${hardened[@]}" --tmpfs /etc/nginx/templates:uid=101,gid=101,mode=0755 \
    -e ATLAS_WEB_UPSTREAM="$web_ip:8080" -e ATLAS_BACKEND_UPSTREAM="$backend_ip:3000" -e ATLAS_PROXY_MAX_BODY=8m \
    -e ATLAS_SMOKE_TEMPLATE="$(cat deploy/nginx/proxy.conf.template)" -p 127.0.0.1::8080 --entrypoint /bin/sh "$NGINX_IMAGE" \
    -c 'printf "%s\n" "$ATLAS_SMOKE_TEMPLATE" > /etc/nginx/templates/default.conf.template && exec /docker-entrypoint.sh nginx -g "daemon off;"' >/dev/null \
    || { fail "$arch: the reference proxy did not start"; return 1; }
  ORIGIN="http://127.0.0.1:$(docker port "$proxy" 8080/tcp | head -1 | sed 's/.*://')"
  image_id="$(docker image inspect "$tag" --format '{{.Id}}')"
  {
    echo "direct_origin=$direct"
    echo "composed_origin=$ORIGIN"
    echo "image=$tag"
    echo "image_id=$image_id"
    echo "platform=linux/$arch"
    echo "frontend_container=$name image $(docker inspect "$name" --format '{{.Image}}') upstream $web_ip:8080"
    echo "proxy=$proxy $NGINX_IMAGE deploy/nginx/proxy.conf.template sha256 $(sha <deploy/nginx/proxy.conf.template)"
    echo "backend=STUB $backend $NGINX_IMAGE $STUB_CONF sha256 $(sha <"$STUB_CONF") upstream $backend_ip:3000 (fixture evidence, not a real backend)"
    echo "prepared_dist=prepared-dist.sha256 sha256 $(sha <"$TMP/dist.sha256")"
  } >"$EVIDENCE/composed-$arch.txt"
  # Ready when the proxy serves both halves: at most 30 s, and an unreachable upstream holds a probe for at most 2 s. A container
  # that exits fails at once.
  deadline=$((SECONDS + 30))
  while :; do
    [ "$(curl -s -m 2 "$ORIGIN/_web/health")" = ok ] && [ "$(curl -s -m 2 "$ORIGIN/health")" = "$STUB_HEALTH" ] && break
    for c in "$backend" "$proxy" "$name"; do
      if [ "$(docker inspect "$c" --format '{{.State.Running}}')" != true ]; then
        docker logs "$c" >"$EVIDENCE/exited-$c.txt" 2>&1 || true
        fail "$arch: $c exited before the composed origin was ready (see $EVIDENCE/exited-$c.txt)"; return 1
      fi
    done
    [ "$SECONDS" -lt "$deadline" ] || { fail "$arch: the composed origin was not ready within 30 s (frontend probe and /health)"; return 1; }
    sleep 0.5
  done
  expect_eq "$arch: the composed frontend is the container under test" "$(docker inspect "$name" --format '{{.Image}}')" "$image_id"
  expect_eq "$arch: the proxy runs this repository's reference template" \
    "$(docker exec "$proxy" cat /etc/nginx/templates/default.conf.template | sha)" "$(sha <deploy/nginx/proxy.conf.template)"
  expect_eq "$arch: the stub backend runs $STUB_CONF" "$(docker exec "$backend" cat /etc/nginx/conf.d/default.conf | sha)" "$(sha <"$STUB_CONF")"
}

# What the browser will see at the composed origin is the image's, apart from the stub's backend paths.
check_composed() {
  local arch="$1" direct="$2" index="$3" asset="$4" path file want got name
  for path in /health /ready; do
    expect_eq "$arch: the container itself still answers $path with a 404" "$(code "$direct$path")" 404
  done
  expect_eq "$arch: composed /health is the stub's released shape" "$(body "$ORIGIN/health")" "$STUB_HEALTH"
  expect_eq "$arch: composed /health?probe=1 is the stub's too" "$(body "$ORIGIN/health?probe=1")" "$STUB_HEALTH"
  expect_contains "$arch: composed /health is labelled as the stub's" "$(curl -sI "$ORIGIN/health")" "X-Atlas-Check-Backend: stub"
  expect_eq "$arch: composed /ready is the stub's" "$(body "$ORIGIN/ready")" "$STUB_READY"
  for path in /api/x /auth/callback /oidc /health/x; do
    expect_eq "$arch: composed $path is the stub's explicit 404" "$(code "$ORIGIN$path")" 404
    expect_contains "$arch: composed $path came from the stub" "$(curl -sI "$ORIGIN$path")" "X-Atlas-Check-Backend: stub"
  done
  for path in / /settings/appearance '/tasks/1?x=1' /assets/missing.js /_web/health; do
    case "$(curl -sI "$ORIGIN$path")" in *[Xx]-[Aa]tlas-[Cc]heck-[Bb]ackend*) fail "$arch: composed $path came from the stub" ;; *) ok "$arch: composed $path comes from the image" ;; esac
  done
  expect_eq "$arch: composed / is the container's shell" "$(body "$ORIGIN/")" "$index"
  expect_eq "$arch: composed deep link is the shell" "$(body "$ORIGIN/settings/appearance")" "$index"
  expect_eq "$arch: composed deep link with a query is the shell" "$(body "$ORIGIN/tasks/1?x=1")" "$index"
  expect_eq "$arch: composed unknown asset is the image's 404" "$(code "$ORIGIN/assets/missing.js")" 404
  expect_eq "$arch: composed /_web/health" "$(body "$ORIGIN/_web/health")" ok
  # Every prepared file, byte for byte, through the proxy.
  while read -r want file; do
    got="$(curl -s "$ORIGIN/${file#./}" | sha)"
    [ "$got" = "$want" ] || fail "$arch: composed /${file#./} differs from dist/ ($got)"
  done <"$TMP/dist.sha256"
  ok "$arch: every prepared file checked through the composed origin ($(wc -l <"$TMP/dist.sha256" | tr -d ' ') files)"
  expect_eq "$arch: composed gzip of the entry JavaScript is the same bytes" \
    "$(curl -s -H 'Accept-Encoding: gzip' "$ORIGIN$asset" | gunzip | sha)" "$(sha <"dist$asset")"
  for path in / "$asset" /sw.js /_web/provenance.json; do
    for name in $(sed -n 's/^add_header \([^ ]*\) .*/\1/p' deploy/nginx/security-headers.conf) Cache-Control Content-Type; do
      expect_eq "$arch: composed $path keeps the image's $name" "$(header_line "$name" "$ORIGIN$path")" "$(header_line "$name" "$direct$path")"
    done
  done
  expect_eq "$arch: composed gzip keeps Content-Encoding" "$(header_line Content-Encoding -H 'Accept-Encoding: gzip' "$ORIGIN$asset")" "$(header_line Content-Encoding -H 'Accept-Encoding: gzip' "$direct$asset")"
}

# The browser's own requests to the stub (curl's are this script's checks): /health at least once, and nothing but /health and /ready.
check_backend_requests() {
  local arch="$1" backend="$2" log browser
  log="$EVIDENCE/composed-backend-requests-$arch.txt"
  docker logs "$backend" 2>/dev/null | grep -E '^[A-Z]+ /' >"$log" || true
  browser="$(grep -v '"curl/' "$log" || true)"
  if grep -qE '^GET /health(\?[^ ]*)? 200 ' <<<"$browser"; then ok "$arch: the browser asked the stub for /health"; else fail "$arch: the browser never asked the stub for /health"; fi
  expect_eq "$arch: the browser asked the stub for nothing but /health and /ready" \
    "$(printf '%s\n' "$browser" | grep -v '^$' | grep -cvE '^(GET|HEAD) /(health|ready)(\?[^ ]*)? 200 ' || true)" 0
}

# Remove the composed origin (not the container under test) and check it is gone.
compose_down() {
  local name="$1" arch="$2" c left
  for c in "$name-proxy" "$name-backend"; do
    docker logs "$c" >"$EVIDENCE/composed-log-$c.txt" 2>&1 || true
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  left=""
  for c in "$name-proxy" "$name-backend"; do
    if docker container inspect "$c" >/dev/null 2>&1; then left="$left $c"; fi
  done
  expect_eq "$arch: the composed origin is torn down" "$left" ""
}

for platform in $PLATFORMS; do
  arch="${platform#linux/}"
  tag="atlas-web-smoke-$RUN_ID:$arch"
  name="atlas-web-smoke-$RUN_ID-$arch"
  echo "=== $platform"
  IMAGES+=("$tag")
  # shellcheck disable=SC2086  # $BUILD is a command and its options, split on purpose
  run_child $BUILD --platform "$platform" --build-arg NGINX_IMAGE="$NGINX_IMAGE" \
    --build-arg ATLAS_WEB_VERSION="$(node -p "require('./package.json').version")" \
    --build-arg ATLAS_WEB_REVISION="$(node scripts/source-revision.mjs)" -t "$tag" . >"$EVIDENCE/build-$arch.log" 2>&1 \
    || { tail -20 "$EVIDENCE/build-$arch.log" >&2; echo "FAIL: $arch: the image did not build" >&2; exit 1; }
  docker image inspect "$tag" > "$EVIDENCE/image-inspect-$arch.json"

  CONTAINERS+=("$name")
  docker run -d --name "$name" --label "$LABEL" --platform "$platform" --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1::8080 "$tag" >/dev/null
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
    # Only the composed origin's own checks gate the browser; an earlier direct failure stays counted either way.
    failed_before=$FAILED
    FAILED=0
    if compose_up "$name" "$tag" "$arch" "$base" && check_composed "$arch" "$base" "$index" "$asset" && [ "$FAILED" -eq 0 ]; then
      inventory="$EVIDENCE/playwright-inventory-$arch.json"
      results="$EVIDENCE/playwright-image-$arch.json"
      run_child env ATLAS_PRODUCTION_URL="$ORIGIN" PLAYWRIGHT_JSON_OUTPUT_FILE="$inventory" pnpm exec playwright test --project=production-chromium production.neutral production.csp --workers=1 --retries=0 --repeat-each=1 --forbid-only --list --reporter=json > "$EVIDENCE/playwright-inventory-$arch.log" 2>&1 || fail "$arch: the browser selection could not be listed (see $EVIDENCE/playwright-inventory-$arch.log)"
      if node scripts/check-playwright-cases.mjs --expected scripts/smoke-image-cases.json --inventory "$inventory" --out "$EVIDENCE/playwright-inventory-verdict-$arch.json"; then
        ok "$arch: the discovered selection is exactly the pinned case list"
        if run_child env ATLAS_PRODUCTION_URL="$ORIGIN" PLAYWRIGHT_JSON_OUTPUT_FILE="$results" pnpm exec playwright test --project=production-chromium production.neutral production.csp --workers=1 --retries=0 --repeat-each=1 --forbid-only --update-snapshots=none --reporter=list,json > "$EVIDENCE/playwright-image-$arch.log" 2>&1; then ok "$arch: production browser suite passes against the container"; else fail "$arch: production browser suite failed (see $EVIDENCE/playwright-image-$arch.log)"; tail -30 "$EVIDENCE/playwright-image-$arch.log" >&2; fi
        if node scripts/check-playwright-cases.mjs --expected scripts/smoke-image-cases.json --inventory "$inventory" --results "$results" --out "$EVIDENCE/playwright-image-verdict-$arch.json"; then ok "$arch: every pinned case ran once and passed"; else fail "$arch: the run does not account for the pinned cases (see $EVIDENCE/playwright-image-verdict-$arch.json)"; fi
        check_backend_requests "$arch" "$name-backend"
      else
        fail "$arch: the discovered selection is not the pinned case list (see $EVIDENCE/playwright-inventory-verdict-$arch.json); the suite was not run"
      fi
    else
      fail "$arch: production browser suite not run: the composed origin is not ready or not the image's"
    fi
    compose_down "$name" "$arch"
    FAILED=$((failed_before | FAILED))
  fi
  docker logs "$name" > "$EVIDENCE/container-log-$arch.txt" 2>&1 || true
done

if [ "$FAILED" -ne 0 ]; then echo "Image smoke FAILED" >&2; exit 1; fi
echo "Image smoke ok for: $PLATFORMS"
