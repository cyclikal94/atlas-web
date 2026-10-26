# Atlas Web

The independent web client for [Atlas](https://github.com/cyclikal94/atlas): a household task app with shared recurring chores, per-person privacy controls
and offline-first sync. This repository is developed, versioned and deployed **separately from the backend**. The two are served behind one public origin.

## Where this stands

This is the **client foundation** (WEB-07). It has:

- the design system: the [shadcn/ui](https://ui.shadcn.com) kit on Radix and Tailwind, the shadcn theme variable set (so a [tweakcn](https://tweakcn.com) theme
  drops in with `node scripts/apply-theme.mjs`), Geist and Geist Mono self-hosted, dark by default with a full light theme, and **Appearance**: Auto by default,
  with Light and Dark overrides, stored on this device only and applied before first paint;
- the shared shell: skip link, rail, icon rail and bottom tabs, the More sheet, the persistent sync/offline status control (the presentation, not the sync logic),
  a shared dialog, and the accessible primitives;
- the protected-surface plumbing: a static, **inert** `#protected-root` with a visible neutral gate, a portal container, the announcer, the title module, and a
  browser capability check (Web Locks, IndexedDB, `inert`, secure context) with a compatibility screen;
- guardrail lint rules (`docs/lint-rules.md`), the form-recovery presentation and port, and same-origin hosting with an archive, a Docker image (amd64 and arm64),
  Docker Compose and a Helm chart.

It does **not** yet have sign-in, sessions, local storage, sync, or any feature screen. Those are later slices (WEB-08 to WEB-14). The production build shows only a neutral
entry: it never mounts the shell. The shell is exercised through a **fixture** build that is never packaged. A passing fixture test is not integration evidence.

## Quick start

```sh
nvm use                        # Node 22.23.2 (.node-version); pnpm 12.4.2
pnpm install --frozen-lockfile
pnpm dev                       # http://127.0.0.1:5173, proxying backend paths to ATLAS_BACKEND_URL (default http://127.0.0.1:3000)
```

`pnpm dev` opens the neutral entry. `pnpm dev:fixture` opens the **shell** instead, with the gate lifted and a sync state you choose in the query string,
for example `/today?phase=offline&pending=3&conflicts=1` (phases: `synced`, `resyncing`, `interrupted`, `offline`). Client routes work (`/settings/appearance`), and
`/__controls` shows every shared control. Fixture mode is for development and tests only: it is never packaged.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm lint` | Biome, including the guardrail rules |
| `pnpm typecheck` | TypeScript, application and service worker |
| `pnpm test` | Vitest (jsdom): tokens, theme, primitives, shell, chip, capabilities, gate, lint rules |
| `pnpm build` | typecheck, then the production build into `dist/` |
| `pnpm dev:fixture` | the dev server with the fixture shell |
| `pnpm build:fixture` | the fixture build into `dist-fixture/` (never packaged) |
| `pnpm test:e2e` | builds both, then Playwright (`ATLAS_E2E_BROWSERS=all` adds Firefox and WebKit). A run that selects only `--project=production-*` or only `--project=fixture-*` starts, and needs the build of, only that server |
| `pnpm check:contract` | the pinned API contract (`--require-release` for a release) |
| `pnpm package:prepare` | provenance and third-party notices for `dist/` |
| `pnpm check:artefacts` | no fixture code, no off-origin URL, size budgets, complete third-party notices |
| `pnpm docs:tokens` | regenerates `docs/design-tokens.md` |
| `node scripts/apply-theme.mjs <theme.css>` | applies a tweakcn or shadcn theme export to the token files and regenerates the docs |

## Documentation

- [`docs/hosting.md`](docs/hosting.md): the one-origin routing rule, the frontend container, the proxy example, Kubernetes.
- [`docs/packaging.md`](docs/packaging.md): the archive, image, Compose, chart, provenance, notices and the checks.
- [`docs/design-tokens.md`](docs/design-tokens.md): every token and its contrast, generated.
- [`docs/browser-support.md`](docs/browser-support.md): the policy, the required features, what has and has not been exercised.
- [`docs/accessibility.md`](docs/accessibility.md): what is built in, the automated evidence, and the manual checklist that remains.
- [`docs/lint-rules.md`](docs/lint-rules.md): the guardrail rules and the register handed to WEB-08a.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to work here.

## Contract

API types are vendored from the backend GitHub release named in `contract-pin.json`; `contract-release-verification.json` records the verified asset, tag commit,
contract and checksums. Frontend builds consume that package and never read a backend checkout.

## Licence

AGPL-3.0-only. Geist and Geist Mono are SIL OFL 1.1; see the third-party notices in each artefact.
