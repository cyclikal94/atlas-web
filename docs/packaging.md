# Packaging and provenance

Atlas Web ships as four independently usable artefacts (Q5, follow-up decision 2). They are **built from one `dist/` and one
`provenance.json`, never rebuilt per artefact**, so they can be shown to be the same build. WEB-07 provides the mechanics and the
checks. **It does not tag, publish, push an image, create a release or deploy anything.**

| Artefact | Where | Notes |
| --- | --- | --- |
| Standalone archive | `atlas-web-<version>.tar.gz` (+ `.sha256`) | The static site, provenance, third-party notices, licence, an nginx example. No backend code. |
| Docker image | `Dockerfile` | `linux/amd64` and `linux/arm64`. Unprivileged nginx, read-only root filesystem. |
| Docker Compose | `deploy/compose.yaml` | Reference proxy + frontend + backend + PostgreSQL behind one origin. Loopback HTTP by default. |
| Helm chart | `charts/atlas-web` | The frontend only. Optional Ingress implements the one-origin rule. |

## Building

```sh
pnpm install --frozen-lockfile
pnpm build                  # typecheck, then vite build -> dist/
pnpm package:prepare        # writes dist/_web/provenance.json and dist/_web/third-party-notices.txt (from the build's bundled-packages records), validating both
pnpm package:archive        # release/atlas-web-<version>.tar.gz (deterministic)
docker buildx build --platform linux/amd64,linux/arm64 -t <repository>:<tag> .
```

`pnpm build` empties `dist/`, so `package:prepare` must run after it. The Dockerfile has no build stage: it `COPY`s `dist/`. The image and
the chart both refuse to be built without a `dist/` that has provenance.

The archive is byte-for-byte reproducible: sorted entries, root ownership, fixed modes, a fixed modification time (`SOURCE_DATE_EPOCH`,
default `0`) and gzip level 9. Two runs over the same `dist/` produce the same SHA-256 (`scripts/smoke-archive.mjs` checks this).

## Provenance

`provenance.json` records what this client was built against, in the shape of `provenance.json.example`:

```json
{
  "atlas_backend_ref": { "tag": "v0.27.0-rc.1", "commit": "<full backend commit>" },
  "contract_hash": "<SHA-256 of api/openapi.json>",
  "api_types_version": "0.27.0-rc.1",
  "api_types_tarball_sha256": "<SHA-256>",
  "frontend_ref": { "tag": null, "commit": "<full frontend commit>", "dirty": false },
  "ci_run_id": "local",
  "generation_inputs": { "openapi_typescript": "7.4.3", "generator_config_hash": "<generator lock SHA-256>" },
  "tested_pairings": []
}
```

- It comes from `contract-pin.json` and the installed `@atlas/api-types/provenance.json`. `scripts/validate-provenance.mjs` fails if it
  disagrees with either, or is malformed.
- `backend_image_digest` and `backend_native_checksum` appear **only for pairings that were actually tested** (`--tested-image`,
  `--tested-native`), and then `tested_pairings` lists them. Otherwise they are omitted and `tested_pairings` is empty: the client never
  claims compatibility it has not shown.
- `ci_run_id` is `local` for a development build. `frontend_ref.dirty` is true when the working tree differs from the commit, so a
  provenance file cannot pretend a modified tree is a commit.
- It is served at `GET /_web/provenance.json`, is at the archive root, and is at `/usr/share/atlas-web/provenance.json` in the image.

## Third-party notices

`scripts/generate-notices.mjs` writes `dist/_web/third-party-notices.txt` (also `THIRD-PARTY-NOTICES.txt` in the archive) for what the distribution **actually
contains**, from two sources: the packages the build itself recorded as bundled into the output, and the declared production dependencies (`pnpm licenses --prod`).

- **The record of bundled packages** is `dist/_web/bundled-packages-app.json` and `dist/_web/bundled-packages-service-worker.json` (names and versions only), written from the
  bundler's own module graph (`build/bundled-packages.ts`) for the application and, separately, for `sw.js`, which vite-plugin-pwa builds on its own. Vite compiles every package the
  code imports into the output whatever `package.json` calls it: the Workbox packages (`workbox-core`, `-precaching`, `-routing` and their dependency `-strategies`) are
  development dependencies and are inside `sw.js`, so a listing of production dependencies alone omitted them. The records travel in `dist/`, the archive and the image beside the
  files they describe, so they cannot be stale.
- It reads each package's licence text from the installed package. **It fails on any licence not on the reviewed list**: MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD,
  Unlicense, OFL-1.1 (Geist and Geist Mono), and AGPL-3.0-only (this project's own backend contract types). A new licence needs a reviewed edit to that list, not a workaround.
  The list is applied to the distributed set, not to every installed development tool.
- It refuses to run without the build's record, and fails on a recorded package that is not installed.

`scripts/check-notices.mjs` (part of `pnpm check:artefacts`, and run on the extracted archive by `scripts/smoke-archive.mjs`) then checks the result against the artefact: every recorded
package is listed with a licence section that carries text, and every Workbox module that marks `sw.js` (`self["workbox:<module>:<version>"]`) is in the service-worker record and in
the notices. That second check reads the output itself, so it does not trust the record it cross-checks.

## Checks that guard the artefacts

| Check | Script | What it proves |
| --- | --- | --- |
| No fixture code | `scripts/check-no-fixture.mjs` | `fixture.html`, the fixture entry and the `ATLAS_FIXTURE_ONLY` marker are in no directory, archive or image filesystem. |
| No off-origin request | `scripts/check-external-urls.mjs` | Nothing in `dist/` loads from off the origin. Fonts are self-hosted. The few inert URL strings (XML namespaces, a licence banner, two documentation links inside library messages) are listed in the evidence. |
| Complete notices | `scripts/check-notices.mjs` | Every package bundled into the application and into `sw.js` has a notice with its licence text (see Third-party notices). |
| Size budgets | `scripts/check-budgets.mjs` | Initial JavaScript and CSS (gzip) and font bytes stay within the provisional budgets and within 10% of the recorded baseline (`perf-budget.json`). |
| One route list | `scripts/check-route-parity.mjs` | The dev proxy, service worker, both nginx configs and the Ingress list the same backend prefixes. |
| Archive | `scripts/smoke-archive.mjs` | Deterministic, complete, served by a plain static server, provenance valid. |
| Image | `scripts/smoke-image.sh` | Both architectures: non-root, read-only, routing, headers, gzip, byte-identical to `dist/`, provenance, no fixture code; the production browser suite passes against the container. |
| Fixture behind real nginx | `scripts/smoke-fixture-nginx.sh` | The whole fixture browser suite passes under the real security headers (zero CSP violations). |
| Compose | `scripts/smoke-compose.sh --stub` / `--real` | Routing, `Host`, cookie and CSRF pass-through through the real reference proxy, against a stub (fixture) or the real released backend image. |
| Native backend | `scripts/smoke-native-backend.sh` | The real released native binary through the Vite preview proxy: cookie, CSRF and origin behaviour identical to direct requests. |
| Chart | `scripts/smoke-helm.sh` | Lint, render and assertions (hardening, probes, one-origin Ingress, schema). |
| Chart on a cluster | `scripts/smoke-kind.sh` | Builds the image, loads it into an existing kind cluster named by `KIND_CLUSTER_NAME`, installs the chart into a namespace of its own, checks the rollout and the HTTP behaviour. CI runs it on a disposable cluster created under the same name (`web-helm-kind`); `tests/static/kind-workflow.test.ts` pins that naming and the namespace scoping, and `tests/static/kind-smoke.test.ts` runs the script against a cluster that already holds other releases (see below). |

The kind smoke owns only what it creates. The cluster it is given may already hold work, including a release called `atlas-web`, so it never uses a fixed name:
each run deploys into its own namespace `atlas-web-smoke-<run id>` (random, or `SMOKE_KIND_RUN_ID`), under a release and an image tag with the same id. It creates the
namespace with `kubectl create namespace`, which refuses an existing name, and only then owns it; on exit it deletes that namespace (and with it the release, whole or
half-installed) and removes the image tag only if it built it. A run that fails earlier (no `dist/`, a missing cluster, a taken image tag, a failed build or load, a
namespace collision) deletes no namespace and uninstalls no release, and every `helm` and `kubectl` call is scoped to the run's namespace and the pinned cluster
context. The chart creates namespaced resources only, so that deletion is complete (`tests/static/kind-smoke.test.ts` checks the templates). The one thing left is the
image `kind load` put in the cluster's nodes, under its unique tag, until the cluster itself is deleted. The tests use fake `kind`, `docker`, `helm` and `kubectl`
executables (`tests/helpers/fake-kind-tools.mjs`) over a state file, so they prove the script's control flow and scoping and what survives a failure, not the real tools'
behaviour; a real disposable cluster is the check for that.

Browser runs against a container (`smoke-image.sh`, `smoke-compose.sh --real`, `smoke-fixture-nginx.sh`) select only the project whose server they supply, and the Playwright
configuration then starts no preview server for the other one, so a production-only run on a clean CI job needs no `dist-fixture/` (and a fixture-only run needs no `dist/`).
That rule is `tests/e2e/targets.ts`, guarded by `tests/static/playwright-servers.test.ts`, which also checks that every browser run in `scripts/*.sh` selects only servers it supplies by URL.

Budgets are provisional starting points (WEB-07); the WEB-09 profiling work replaces them with measured ones. `scripts/profile-shell.mjs`
measures LCP, CLS, first contentful paint, the fallback-font window and bytes under fast and slow 4G with a 4x CPU throttle. Its results are
recorded with the work, and the primary sans font is preloaded because of them (see the evidence: the mobile fallback-font window falls from
about 95/450 ms to 0/100 ms on fast/slow 4G, LCP is unchanged, first contentful paint is about 30-120 ms later).

## CI

`.github/workflows/web.yml` has no path filter. Its jobs call the same scripts a developer runs: `web-checks`, `web-contract`, `web-e2e` (Chromium,
Firefox and WebKit), `web-package` (the archive, and the image on a **native** amd64 runner and a **native** arm64 runner), `web-compose`,
`web-integration` (the real backend, fetched from its release and verified against its published `SHA256SUMS`) and `web-helm-kind`. Workflow
artefacts are internal and short-lived; nothing is published.

## What is not decided here

- Release versioning and tagging, the registry, and image signing belong to the release task (WEB-15).
- The image tag defaults, the chart `version` and `appVersion` are `0.0.0` until a release sets them.
- Rollback: an image tag or digest is immutable, so rolling back means deploying the previous tag; the client stores nothing that a rollback can strand
  except through WEB-09's schema versioning, which owns that.
