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
src/session/             the account lifecycle: who is signed in, whether a request may be sent, whether anything may be shown. Import only `src/session` (its index),
                         never a deeper path; docs/session.md. `adapters/protected-surface.ts` is the only importer of the gate
src/protected-surface/   gate, title, portal container (the gate is importable only from src/session and src/fixture)
src/features/            one folder per destination; placeholders until WEB-10 to WEB-14 replace them
src/lib/                 api-client (the only place that may reach the network), backend-routes, sync-chip, form-recovery
src/fixture/             the fixture entry, controls gallery, session harness and neutral-state pages: never packaged
src/styles/              tokens.css (the source of the theme), fonts, base
lint/                    the guardrail rules; docs/lint-rules.md
deploy/, charts/         nginx configs, Compose, the Helm chart
scripts/                 checks, packaging, smoke tests
tests/                   Vitest (jsdom), Playwright (tests/e2e, tests/integration), lint fixtures; tests/support/session is the fake platform
scripts/integration/     the released-backend integration harness and delaying proxy (pnpm test:integration)
```

## Rules of the road

- **Scope.** WEB-07 owns the foundation. Authentication and account lifecycle are WEB-08; storage and sync are WEB-09; service-worker registration and update UX are WEB-14.
  Do not pull them forward. `src/lib/db/` stays empty. WEB-08a (the session primitives) is in `src/session`; registration, OIDC and the sign-in form are WEB-08b, the lifecycle traces on a rendered
  cache are WEB-08c.
- **The protected root.** `#protected-root` starts inert and hidden. Everything that renders account data lives inside it, including dialogs and tooltips (use the shared
  `Dialog` and `Tooltip`, which render into the registered portal container). Do not lift the gate; only the session's `act` does, through `src/session/adapters/protected-surface.ts`. Lint rules R1 to R12 enforce the mechanical parts
  (R7 to R12 by `scripts/check-session-conventions.mjs`, run by `pnpm lint`). Never send a request except through `session.api`; never read `atlas-auth` except in `src/session`.
- **Tokens and the kit.** The UI is built from the shadcn/ui kit in `src/components/ui` (Button, Input, Card, Badge, Alert, Dialog, Tooltip and the rest), composed with
  `cn` from `src/lib/utils.ts`. Colours come from the shadcn theme variables (`bg-background`, `text-muted-foreground`, `border-input`, `bg-sidebar`). Never write a hex
  value in a component. To change the palette, export a theme from tweakcn.com and run `node scripts/apply-theme.mjs <file.css>`: it rewrites `src/styles/tokens.css`
  and the mirror `src/design/tokens.ts` and regenerates `docs/design-tokens.md`; the contrast test (`tests/design/tokens.test.ts`) then fails on any declared pair
  (`src/design/contrast-pairs.ts`) below its minimum. Inputs take `border-input` and fill only from `background` or `card` (Q17).
- **No inline script or style.** The production content security policy forbids both. Load scripts as files. Do not add a component that injects a `<style>` element or sets a `style`
  attribute through `setAttribute`; setting `element.style.x` is fine.
- **Copy.** Use the accepted copy deck (`design_handoff_atlas_web`). Do not ship a designer's annotation.
- **Accessibility.** Every control has an accessible name; state is never colour alone; a disabled control states its reason; live regions go through the announcer.
- **Fixtures.** A passing fixture test says the client behaves as designed. It is not integration evidence, and a report must never present it as one. Fixture code (`src/fixture`, `dist-fixture`) is
  never packaged; `scripts/check-no-fixture.mjs` fails any artefact that contains it.
- **Dependencies.** Add with `pnpm add --save-exact`; the licence must be on the reviewed list (`scripts/generate-notices.mjs`).

## Evidence

Checks write to `.agtx/evidence/WEB-07/<check-id>/` and, for the session module, `.agtx/evidence/WEB-08a/{design,profiling,fixture,integration,lint}/` (git-ignored). A check that cannot run is recorded as **not run, with the reason**, never as passed.

## Contract

`contract-pin.json` records the exact API tarball and source contract hashes. `@atlas/api-types` contains backend-generated declarations only; `openapi-fetch` is this repository's
runtime dependency. The backend generation tooling owns `openapi-typescript`. Never read a sibling checkout during frontend builds. The vendored tarball comes from the published backend
release named by the pin, and its verification record binds the asset and tag to their hashes and source commit. A released pin is required before creating delivery worktrees; check with
`pnpm check:contract --require-release`.

The approved workflow, decisions and reviewed specifications live in the sibling `atlas-orchestrator` repository. Task inputs are staged under `.agtx/approved` by the supervisor. Follow the
card's scope and acceptance criteria.
