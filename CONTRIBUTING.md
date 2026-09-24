# Contributing to Atlas Web

Use UK English. This is the separate TypeScript/React frontend repository. Node is
pinned in `.node-version`; use pnpm 12.4.2 and keep `pnpm-lock.yaml` committed.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm check:contract
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Run `pnpm dev` for development. `ATLAS_BACKEND_URL` configures the local proxy
(default `http://127.0.0.1:8080`). Browser and backend requests share one origin;
API, health, readiness and callback paths must never receive an offline shell.
The shared route patterns live in `src/lib/backend-routes.ts`.

The bootstrap provides the build/test toolchain and neutral entry only. WEB-07 owns
the approved UI, Geist fonts, Auto/light/dark settings and deployment artefacts;
WEB-08 owns authentication; WEB-09 owns storage/sync; WEB-14 owns service-worker
registration, update UX and push. Keep protected content inside `#protected-root`;
it starts inert and hidden. Do not lift that gate without the reviewed lifecycle.

`contract-pin.json` records the exact API tarball and source contract hashes.
`@atlas/api-types` contains backend-generated declarations only; `openapi-fetch`
is this repository's runtime dependency. The backend generation tooling owns
`openapi-typescript`. Never read a sibling checkout during frontend builds.
The initial local tarball is labelled bootstrap-only and is not a published release.
A released pin is required before creating delivery worktrees; check with
`pnpm check:contract --require-release` after publication and deliberate re-pinning.

The approved workflow, decisions and reviewed specifications live in the sibling
`atlas-orchestrator` repository. Task inputs are staged under `.agtx/approved` by
the supervisor. Follow the card's scope and acceptance criteria. Fixture tests do
not prove integration against the required backend fixes. Do not commit, push,
merge or deploy without explicit authorisation; the initial commit awaits Kieran's
review. Keep generated output, dependency directories and agent state out of Git.
