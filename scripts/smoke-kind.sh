#!/usr/bin/env bash
# R6 / R7 / B19 (chart layer, deployment). Builds the atlas-web image from the already-built dist/, loads it into an EXISTING kind
# cluster, installs charts/atlas-web there and checks the rollout and the HTTP behaviour of the deployed pods. CI runs this
# script after helm/kind-action (.github/workflows/web.yml, web-helm-kind); a developer runs it against a disposable cluster.
#
#   KIND_CLUSTER_NAME   required. The cluster to deploy into. The workflow passes the same variable to helm/kind-action as its
#                       cluster_name, so creation and image loading cannot name different clusters. Locally:
#                         kind create cluster --name atlas-web-local
#                         KIND_CLUSTER_NAME=atlas-web-local ./scripts/smoke-kind.sh
#                         kind delete cluster --name atlas-web-local
#   SMOKE_KIND_RUN_ID   optional, 4 to 12 characters of [a-z0-9]. Names this run's namespace, release and image tag; a random
#                       value by default. Setting it to a name already in use makes the run refuse (see below), which is how the
#                       collision path is tested (tests/static/kind-smoke.test.ts).
#   SMOKE_KIND_EVIDENCE optional. Where the logs go; .agtx/evidence/WEB-07/R6/ by default.
#
# It creates no cluster and deletes none. Every kind, helm and kubectl call is pinned to that cluster (`--name`, and the
# `kind-<name>` context), so whatever else the developer's kubeconfig points at is never touched.
#
# Ownership (R7). The cluster may already hold other work, including a release called `atlas-web`, so a name the script merely
# chooses is not a name it owns. Each run therefore deploys into its OWN namespace, `atlas-web-smoke-<run id>`, under its own
# release name and image tag, and it removes only what it has proved it created:
#   * The namespace is created with `kubectl create namespace`, which fails if the name exists, so a collision aborts the run
#     before anything is installed. Only after that call succeeds does the run own the namespace, and on exit it deletes the
#     whole namespace: the release and any half-created part of it (a failed or timed-out `helm install` leaves resources and a
#     release record behind) go with it. Every helm and kubectl call after that is scoped to it with `--namespace`.
#   * A run that fails before it creates the namespace (no dist/, a missing cluster, a failed image build or load, a name
#     collision) deletes no namespace and uninstalls no release.
#   * The image tag is checked to be absent before the build and removed on exit only if this run built it; a tag that already
#     exists aborts the run.
#   * The chart creates namespaced resources only (Deployment, Service, and an Ingress that is off here), which
#     tests/static/kind-smoke.test.ts checks, so deleting the namespace removes everything the install created.
# One thing is left behind: the image that `kind load` copied into the cluster's nodes stays there under its unique tag until the
# cluster itself is deleted (kind has no supported command to unload one). It cannot be confused with anything else.
# The port-forward and the host-side image tag are removed on exit, including on Ctrl-C or SIGTERM.
#
# Needs a Docker daemon (honours DOCKER_CONTEXT).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source deploy/base-images.env

: "${KIND_CLUSTER_NAME:?set KIND_CLUSTER_NAME to the kind cluster to deploy into}"
CONTEXT="kind-$KIND_CLUSTER_NAME"
EVIDENCE="${SMOKE_KIND_EVIDENCE:-.agtx/evidence/WEB-07/R6}"
mkdir -p "$EVIDENCE"

RUN_ID="${SMOKE_KIND_RUN_ID:-$(node -e "process.stdout.write(require('crypto').randomBytes(4).toString('hex'))")}"
if ! [[ "$RUN_ID" =~ ^[a-z0-9]{4,12}$ ]]; then
  echo "SMOKE_KIND_RUN_ID must be 4 to 12 characters of [a-z0-9] (got '$RUN_ID')" >&2
  exit 2
fi
NAMESPACE="atlas-web-smoke-$RUN_ID"
# The release name contains the chart name, so the chart's fullname helper yields exactly this name for the Deployment and Service.
RELEASE="atlas-web-smoke-$RUN_ID"
SELECTOR="app.kubernetes.io/name=atlas-web,app.kubernetes.io/instance=$RELEASE"
REPOSITORY="atlas-web-kind-smoke"
# Not purely numeric: `--set` would parse a number as a number and the chart schema (image.tag is a string) rejects it.
TAG="smoke-$RUN_ID"
IMAGE="$REPOSITORY:$TAG"

# What this run has created, and so may remove. Each flag is set only after the command that creates the thing has succeeded.
FORWARD_PID=""
IMAGE_OWNED=0
NAMESPACE_OWNED=0
FAILED=0

fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "ok:   $*"; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }

cleanup() {
  set +e
  if [ -n "$FORWARD_PID" ]; then
    kill "$FORWARD_PID" >/dev/null 2>&1
    wait "$FORWARD_PID" >/dev/null 2>&1
  fi
  if [ "$NAMESPACE_OWNED" = 1 ]; then
    kubectl --context "$CONTEXT" delete namespace "$NAMESPACE" --wait=true --timeout=120s >"$EVIDENCE/namespace-delete.log" 2>&1 \
      || echo "warning: could not delete namespace '$NAMESPACE' (this run created it); remove it with: kubectl --context $CONTEXT delete namespace $NAMESPACE" >&2
  fi
  if [ "$IMAGE_OWNED" = 1 ]; then
    docker rmi "$IMAGE" >/dev/null 2>&1
  fi
  return 0
}
# A signal must run the clean-up too: `exit` from a trap runs the EXIT trap.
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

[ -f dist/index.html ] || { echo "dist/ is missing: run pnpm build && pnpm package:prepare first" >&2; exit 2; }

# The cluster must already exist, under exactly this name. This is the check the original workflow lacked: it created
# `chart-testing` and then loaded the image into `kind`.
if ! kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER_NAME"; then
  echo "kind cluster '$KIND_CLUSTER_NAME' does not exist (clusters: $(kind get clusters 2>&1 | tr '\n' ' '))" >&2
  exit 2
fi
ok "the kind cluster '$KIND_CLUSTER_NAME' exists"

# A tag that is already there is somebody else's: `docker build -t` would move it to the new image and the exit clean-up would
# then delete it.
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "the image tag '$IMAGE' already exists; refusing to replace or remove it (choose another SMOKE_KIND_RUN_ID)" >&2
  exit 2
fi

docker build --build-arg NGINX_IMAGE="$NGINX_IMAGE" -t "$IMAGE" . >"$EVIDENCE/docker-build.log" 2>&1
IMAGE_OWNED=1
ok "built $IMAGE"
kind load docker-image "$IMAGE" --name "$KIND_CLUSTER_NAME" >"$EVIDENCE/kind-load.log" 2>&1 \
  && ok "loaded $IMAGE into '$KIND_CLUSTER_NAME'" || { cat "$EVIDENCE/kind-load.log" >&2; fail "kind load docker-image"; exit 1; }

# `create` fails when the namespace exists (helm's --create-namespace would accept it), so success here is the proof that this run
# made it and may delete it.
kubectl --context "$CONTEXT" create namespace "$NAMESPACE" >"$EVIDENCE/namespace-create.log" 2>&1 \
  || { cat "$EVIDENCE/namespace-create.log" >&2; echo "the namespace '$NAMESPACE' could not be created (a name collision leaves the existing one untouched)" >&2; fail "create namespace"; exit 1; }
NAMESPACE_OWNED=1
ok "created the namespace '$NAMESPACE' for this run"

helm --kube-context "$CONTEXT" --namespace "$NAMESPACE" install "$RELEASE" charts/atlas-web \
  --set-string image.repository="$REPOSITORY" --set-string image.tag="$TAG" \
  --set image.pullPolicy=Never --set replicaCount=2 --wait --timeout 120s >"$EVIDENCE/helm-install.log" 2>&1 \
  && ok "helm install --wait" || { cat "$EVIDENCE/helm-install.log" >&2; fail "helm install"; exit 1; }
kubectl --context "$CONTEXT" --namespace "$NAMESPACE" rollout status "deployment/$RELEASE" --timeout=60s >"$EVIDENCE/rollout.log" 2>&1 \
  && ok "the deployment rolled out (2 replicas)" || { cat "$EVIDENCE/rollout.log" >&2; fail "rollout"; exit 1; }
kubectl --context "$CONTEXT" --namespace "$NAMESPACE" get pods -l "$SELECTOR" -o wide >"$EVIDENCE/pods.txt"

# A free loopback port, so a developer's own 8081 is never assumed to be free.
PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
kubectl --context "$CONTEXT" --namespace "$NAMESPACE" port-forward --address 127.0.0.1 "svc/$RELEASE" "$PORT:80" >"$EVIDENCE/port-forward.log" 2>&1 &
FORWARD_PID=$!
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/_web/health" 2>/dev/null && break
  sleep 1
done

status() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$1"; }
expect_eq "/_web/health answers ok" "$(curl -s "http://127.0.0.1:$PORT/_web/health")" "ok"
expect_eq "a client route serves the application shell" "$(status /settings/appearance)" "200"
expect_eq "a backend prefix is not served by the frontend (404, no fallback)" "$(status /api/x)" "404"
expect_eq "a missing asset is 404, not the application shell" "$(status /assets/missing.js)" "404"
# Selected by this release's own labels in this run's namespace: another atlas-web release elsewhere in the cluster is not counted.
expect_eq "the pods run as UID 101" \
  "$(kubectl --context "$CONTEXT" --namespace "$NAMESPACE" get pods -l "$SELECTOR" -o jsonpath='{.items[*].spec.securityContext.runAsUser}')" "101 101"

if [ "$FAILED" -ne 0 ]; then echo "kind smoke FAILED" >&2; exit 1; fi
echo "kind smoke ok (cluster '$KIND_CLUSTER_NAME', namespace '$NAMESPACE': image loaded, chart installed, rolled out, HTTP checks passed; the namespace is removed on exit)."
