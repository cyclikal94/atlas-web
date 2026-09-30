# Contributing to Atlas Web

Use UK English in code, comments, copy and documentation. This is the separate TypeScript and React frontend repository. Node is pinned in `.node-version` and enforced
(`engine-strict`); use pnpm 12.4.2 and keep `pnpm-lock.yaml` committed. Do not commit, push, merge or deploy without explicit authorisation, and keep generated output,
dependency directories and agent state (`.agtx/`, `.agents/`, `.claude/`, `.codex/`, `.mcp.json`) out of Git.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm check:contract
pnpm build
pnpm exec playwright install chromium firefox webkit    # once
pnpm test:e2e                                           # ATLAS_E2E_BROWSERS=all for all three engines
```

## Running it

- `pnpm dev`: the production entry (the neutral app). `ATLAS_BACKEND_URL` sets where backend paths are proxied (default `http://127.0.0.1:3000`, the backend's documented bind).
- `pnpm dev:fixture`: the shell with the gate lifted. Choose the sync state in the query string (`?phase=offline&pending=3&conflicts=1`). `/__controls` shows every shared control.
- `pnpm preview` and `pnpm preview:fixture` serve the built output.

Browser, backend and proxy share **one origin**. Backend paths (`/api`, `/health`, `/ready`, `/auth`, `/oidc`) must never receive an offline shell. The list lives once, in
`src/lib/backend-routes.ts`; `pnpm check:route-parity` keeps every other place in step. See `docs/hosting.md`.

## What lives where

```
src/app/                 the application: capability check, neutral screens, router, providers, shell/
src/components/ui/       the shared primitives (the only place portals may be created)
src/design/              tokens mirror, theme logic, contrast maths
src/protected-surface/   gate, title, portal container (the gate is importable only from src/session and src/fixture)
src/features/            one folder per destination; placeholders until WEB-10 to WEB-14 replace them
src/lib/                 api-client (the only place that may reach the network), backend-routes, sync-chip, form-recovery
src/fixture/             the fixture entry and controls gallery: never packaged
src/styles/              tokens.css (the source of the theme), fonts, base
lint/                    the guardrail rules; docs/lint-rules.md
deploy/, charts/         nginx configs, Compose, the Helm chart
scripts/                 checks, packaging, smoke tests
tests/                   Vitest (jsdom), Playwright (tests/e2e), lint fixtures
```

## Rules of the road

- **Scope.** WEB-07 owns the foundation. Authentication and account lifecycle are WEB-08; storage and sync are WEB-09; service-worker registration and update UX are WEB-14.
  Do not pull them forward. `src/lib/db/` stays empty.
- **The protected root.** `#protected-root` starts inert and hidden. Everything that renders account data lives inside it, including dialogs and tooltips (use the shared
  `Dialog` and `Tooltip`, which render into the registered portal container). Do not lift the gate; that is WEB-08a's reviewed lifecycle. Lint rules R1 to R6 enforce the mechanical parts.
- **Tokens.** Colours come from tokens (`bg-canvas`, `text-ink-2`, `border-field-edge`). Never write a hex value in a component. Change a token in `src/styles/tokens.css`, mirror it in
  `src/design/tokens.ts`, add or adjust its declared pairs in `src/design/contrast-pairs.ts`, and run `pnpm docs:tokens`. The contrast test fails on any declared pair below its minimum.
  Inputs use `field-edge` and fill only from `canvas` or `panel` (Q17).
- **No inline script or style.** The production content security policy forbids both. Load scripts as files. Do not add a component that injects a `<style>` element or sets a `style`
  attribute through `setAttribute`; setting `element.style.x` is fine.
- **Copy.** Use the accepted copy deck (`design_handoff_atlas_web`). Do not ship a designer's annotation.
- **Accessibility.** Every control has an accessible name; state is never colour alone; a disabled control states its reason; live regions go through the announcer.
- **Fixtures.** A passing fixture test says the client behaves as designed. It is not integration evidence, and a report must never present it as one. Fixture code (`src/fixture`, `dist-fixture`) is
  never packaged; `scripts/check-no-fixture.mjs` fails any artefact that contains it.
- **Dependencies.** Add with `pnpm add --save-exact`; the licence must be on the reviewed list (`scripts/generate-notices.mjs`).

## Evidence

Checks write to `.agtx/evidence/WEB-07/<check-id>/` (git-ignored). A check that cannot run is recorded as **not run, with the reason**, never as passed.

## Contract

`contract-pin.json` records the exact API tarball and source contract hashes. `@atlas/api-types` contains backend-generated declarations only; `openapi-fetch` is this repository's
runtime dependency. The backend generation tooling owns `openapi-typescript`. Never read a sibling checkout during frontend builds. The vendored tarball comes from the published backend
release named by the pin, and its verification record binds the asset and tag to their hashes and source commit. A released pin is required before creating delivery worktrees; check with
`pnpm check:contract --require-release`.

The approved workflow, decisions and reviewed specifications live in the sibling `atlas-orchestrator` repository. Task inputs are staged under `.agtx/approved` by the supervisor. Follow the
card's scope and acceptance criteria.
