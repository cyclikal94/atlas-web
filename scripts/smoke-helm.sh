#!/usr/bin/env bash
# B19 / C6 (chart layer). Lints and renders charts/atlas-web and asserts what the chart promises: it is required to be told an
# image (no guessed registry), the pod is hardened, probes use /_web/health, the Ingress routes the shared backend prefixes
# to the backend and everything else to this frontend, and the values schema rejects nonsense. It runs helm only: it needs no
# cluster and touches none. Deployment to a disposable cluster is scripts/smoke-kind.sh (CI: .github/workflows/web.yml, web-helm-kind).
set -euo pipefail
cd "$(dirname "$0")/.."
EVIDENCE=".agtx/evidence/WEB-07/C6"
mkdir -p "$EVIDENCE"
CHART=charts/atlas-web
FAILED=0
fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "ok:   $*"; }
has() { if grep -Eq "$2" <<<"$1"; then ok "$3"; else fail "$3 (no match for: $2)"; fi; }
hasnt() { if grep -Eq "$2" <<<"$1"; then fail "$3 (unexpected match for: $2)"; else ok "$3"; fi; }

helm lint "$CHART" --set image.repository=registry.example/atlas-web >"$EVIDENCE/helm-lint.txt" 2>&1 && ok "helm lint (frontend only)" || { cat "$EVIDENCE/helm-lint.txt" >&2; fail "helm lint"; }
helm lint "$CHART" --set image.repository=registry.example/atlas-web --set ingress.enabled=true --set ingress.host=atlas.example.test \
  --set ingress.backend.serviceName=atlas-backend >>"$EVIDENCE/helm-lint.txt" 2>&1 && ok "helm lint (with Ingress)" || fail "helm lint with Ingress"

if helm template t "$CHART" >/dev/null 2>&1; then fail "the chart rendered without an image repository"; else ok "the chart refuses to render without image.repository (no guessed registry)"; fi
if helm template t "$CHART" --set image.repository=x --set ingress.enabled=true >/dev/null 2>&1; then fail "an enabled Ingress rendered without a host"; else ok "an enabled Ingress requires a host and a backend service"; fi
if helm template t "$CHART" --set image.repository=x --set image.digest=sha256:short >/dev/null 2>&1; then fail "the schema accepted a malformed digest"; else ok "the values schema rejects a malformed digest"; fi
if helm template t "$CHART" --set image.repository=x --set service.port=99999 >/dev/null 2>&1; then fail "the schema accepted an impossible port"; else ok "the values schema rejects an impossible port"; fi

rendered="$(helm template atlas-web "$CHART" --set image.repository=registry.example/atlas-web --set ingress.enabled=true \
  --set ingress.host=atlas.example.test --set ingress.backend.serviceName=atlas-backend --set ingress.className=nginx)"
printf '%s\n' "$rendered" >"$EVIDENCE/helm-template.yaml"

has "$rendered" 'image: "registry.example/atlas-web:0.0.0"' "the image tag defaults to appVersion"
has "$(helm template t "$CHART" --set image.repository=r --set image.tag=1.2.3)" 'image: "r:1.2.3"' "an explicit tag is used"
has "$(helm template t "$CHART" --set image.repository=r --set image.tag=1.2.3 --set image.digest=sha256:$(printf 'a%.0s' $(seq 1 64)))" '@sha256:a{64}' "a digest takes precedence over the tag"
has "$rendered" 'runAsNonRoot: true' "the pod runs as non-root"
has "$rendered" 'runAsUser: 101' "the pod runs as UID 101"
has "$rendered" 'readOnlyRootFilesystem: true' "the root filesystem is read-only"
has "$rendered" 'allowPrivilegeEscalation: false' "privilege escalation is off"
has "$rendered" 'drop: \["ALL"\]' "all capabilities are dropped"
has "$rendered" 'type: RuntimeDefault' "the seccomp profile is RuntimeDefault"
has "$rendered" 'automountServiceAccountToken: false' "no service account token is mounted"
has "$rendered" 'path: /_web/health' "probes use /_web/health"
has "$rendered" 'mountPath: /tmp' "only /tmp is writable"
hasnt "$rendered" 'hostNetwork|hostPath|privileged: true' "no host network, host path or privileged container"
hasnt "$rendered" 'kind: (Secret|ConfigMap)' "the chart creates no Secret or ConfigMap (no secret material lives in it)"
hasnt "$rendered" 'kind: (StatefulSet|PersistentVolumeClaim)' "the chart deploys no database and no storage: it is the frontend only"

# The Ingress: Prefix matching, one origin, the shared list to the backend, everything else to the frontend.
has "$rendered" 'ingressClassName: "nginx"' "the Ingress class is configurable"
has "$rendered" 'host: "atlas.example.test"' "one host"
for prefix in api health ready auth oidc; do has "$rendered" "path: /$prefix\$" "the Ingress routes /$prefix"; done
has "$rendered" 'path: /$' "the Ingress routes / to the frontend"
[ "$(grep -c 'pathType: Prefix' <<<"$rendered")" = "6" ] && ok "every path is pathType Prefix (element-wise: /apiary is not /api)" || fail "pathType is not Prefix everywhere"
node scripts/check-route-parity.mjs && ok "the rendered Ingress lists exactly the shared backend prefixes (route parity)" || fail "route parity"

if [ "$FAILED" -ne 0 ]; then echo "Helm smoke FAILED" >&2; exit 1; fi
echo "Helm smoke ok (lint and template only; a deployment needs a cluster: scripts/smoke-kind.sh)."
