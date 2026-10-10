# Guardrail lint rules

The account-lifecycle matrix (Q19) says several conformance rules are "enforced by a WEB-07 lint rule and WEB-08a tests". Some of those rules name
functions WEB-08a has not written yet. So WEB-07 ships the **rule framework**, every rule that can be stated against code that exists or against
normative names (**R1 to R6, active now**), and this **register** that hands the rest (R7 to R12) to WEB-08a with the exact rule text. Nothing is silently omitted.

## Mechanism

Biome GritQL plugins in `lint/*.grit`, attached in `biome.json` with `overrides`. Plugins are **additive** across overrides, so a later override cannot switch
one off. Each rule is therefore scoped by its own override with **disjoint `includes`**: a rule applies to `src/**` and lists the places that may break it
with negated globs (`!src/lib/api-client/**`). Tests, scripts and Playwright specs are outside `src/**` and are not linted by these rules.

Every rule is tested by `tests/lint/rules.test.ts`: it copies the real `biome.json` and `lint/*.grit` into a temporary tree, writes known-bad and
known-good snippets at the paths each rule is scoped to, runs `biome lint`, and asserts the **exact** diagnostics (rule and line). A rule that stops biting fails the test, and
`pnpm lint` on the real tree stays clean.

A diagnostic is suppressed only with `// biome-ignore lint/plugin: <reason>` and a reviewer note. The rules match by name, so a property called `fetch` on your own
object also matches: rename it or suppress it with a reason.

## Active rules

| Rule | Enforces | Allowed in | Source |
| --- | --- | --- | --- |
| **R1 `no-raw-network`** | No `fetch`, `window/globalThis/self.fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `navigator.sendBeacon`. Covers `src/sw.ts`. Narrowed by WEB-08a to the send boundary and the unstamped surface. | `src/lib/api-client/boundary.ts` and `unstamped.ts` only | matrix 3.6.2 step 1: the stamped wrapper is the only way any page reaches the API |
| **R2 `no-locks-query`** | `navigator.locks.query()` (and `locks.query()`) is never called. A held lock, a hint, a time-out or an earlier read is not evidence of another page's state. | nowhere | matrix 3.6.3 item 3 |
| **R3 `portal-only-via-ui`** | `createPortal`, `react-dom`, and imports of Radix `portal`, `dialog`, `alert-dialog`, `popover`, `tooltip`, `dropdown-menu`, `select`, `hover-card`, `context-menu`, `menubar`, `navigation-menu`, `toast`; `document.body.append/appendChild/prepend/insertAdjacentHTML/insertAdjacentElement/replaceChildren/before/after`; `document.write(ln)`. | `src/components/ui/**` | matrix 3.7.1: no portal renders account data outside `#protected-root` |
| **R4 `gate-import-allowlist`** | `src/protected-surface/gate` (mount, lift and apply the gate) is imported only by the session module and the fixture entry. | `src/session/**`, `src/fixture/**`, `src/protected-surface/**` | matrix 3.6.3: mount and gate-lift callable only from `act` |
| **R5 `title-only-via-module`** | `document.title` is written only through `src/protected-surface/title.ts`. The tab title can reveal what is open. | `src/protected-surface/title.ts` | matrix 3.7.1: the title is protected surface |
| **R6 `live-region-registry`** | `aria-live`, `role="status"`, `role="alert"` and `role="log"` only in the announcer, the neutral gate, the neutral states (added by WEB-08a: they need both `status` and `alert`), the neutral status (added by WEB-08b: the public sign-in and join surfaces have no announcer and must announce a refusal once) and the sync chip module. A stray live region would announce protected text while the gate is closed. | `announcer.tsx`, `neutral-gate.tsx`, `neutral-state.tsx`, `neutral-status.tsx`, `sync-status.tsx` in `src/components/ui/` | matrix 3.7.2 step 1c |

**Extending an allowlist is a reviewed change.** The list of allowed places is the lint configuration; widening it needs the same review as the code it lets through.
WEB-08b widened R6 by exactly one file, `neutral-status.tsx`. The reason it is safe: the risk R6 guards (announcing protected text while the gate is closed) cannot arise on surfaces that show nothing about any account, never import the gate (R4) and never use the portal dialog (R3). The component renders only fixed application messages (the catalogue of `src/features/authentication/outcome-copy.ts`, and the join surface's own fixed sentences: the wireframe's lost-response line and the provisional note about an earlier invitation, which names no username) and a request ID.

Known limits, so no one mistakes the rules for proof: they see syntax, not data flow. An aliased `const q = navigator.locks; q.query()` is not caught by R2; a
`document.title` written through an alias is not caught by R5; `Object.defineProperty(document, "title", ...)` is not caught. The rules stop accidents and make deliberate evasion visible in review;
WEB-08a's runtime tests are the other half.

## The session conventions R7 to R12 (WEB-08a)

WEB-07 handed these six to WEB-08a with their exact text; the functions they are about now exist. They are **not GritQL rules**. The spike
(`.agtx/evidence/WEB-08a/lint/spike.md`) established that biome 2.5.14's GritQL can match a named function declaration and its first statement, but
cannot match a class method by name, cannot say that one statement precedes another, and cannot count ("exactly one call of `fetch`"). The plan's
stated fallback applies: `scripts/check-session-conventions.mjs` (implementation in `scripts/lib/session-conventions.mjs`), dependency-free and
deterministic, run by `pnpm lint` after Biome, and tested in `tests/lint/session-conventions.test.ts` with known-bad and known-good snippets for every
rule, a one-line-edit test against the real source, and a test that every function a rule is about still exists. **It is syntactic**: it strips comments and
string contents, finds functions by name, matches braces and reads tokens.

| Rule | Enforces | Where |
| --- | --- | --- |
| **R7 `send-boundary`** | `boundary.ts` contains exactly one call of `fetch`; it is inside the function `issue`, inside a `try` whose `finally` calls `releaseIssueLock`; `issue` contains no `await`, no `.then`, no call on `locks.` or `store.` and no `read(`; the guard `step.refuses(` precedes the `try`. | `src/lib/api-client/boundary.ts` |
| **R8 `closing-write-first`** | Every function named `…ClosingWrite` has `beginClosing(` as its first statement, and `beginClosing(` is called only by such a function. | `src/session/kernel/**` |
| **R9 `surrender-first`** | Every `handle…Answer` function has `surrenderLock(` as its first statement and `detectInvalidation(` as its second, with no `await`, `.text(`, `.json(`, `.clone(`, `store.` or lock acquisition in either; `surrenderLock(` is called only by such a function. | `src/session/kernel/**` |
| **R10 `act-is-synchronous`** | The function `act` has no `await`, no `.then` and no `transact`, `acquire`, `wait`, `probe`, `getItem` or `read` call and no `store.` member; `attachTree` is referenced only from `act` (its declaration in `ports/surface.ts` and definition in `adapters/protected-surface.ts` are exempt). | `src/session/**` |
| **R11 `activity-first`** | The first statement of `send` and of `expose` is a call of `createActivity(` (bare or assigned); an `Activity` is constructed only in `activity.ts`. | `src/session/kernel/**`, `src/session/**` |
| **R12 `send-reads-no-display-state`** | `send` references none of `display`, `displaying`, `mayRender`, `renderPermission`, `page.display`. | `src/session/kernel/send.ts` |

**A rule that cannot find its function fails.** `REQUIRED` in the checker lists the functions each rule is about (`issue`, `activatingClosingWrite`,
`settlementClosingWrite`, `operationFenceClosingWrite`, the three `handle…Answer` handlers, `act`, `send`, `expose`); if one is renamed or moved, `pnpm lint` reports it
instead of silently checking nothing.

Known limits, so no one mistakes the checker for proof: it sees names and tokens, not data flow. A function that reaches a forbidden call through a helper it
calls is not caught; a function renamed to dodge a name pattern is caught only where `REQUIRED` names it; an arrow function assigned to a constant is not a
named declaration and is out of scope. The runtime suites are the other half: the surrender-order spies (`tests/session/surrender.test.ts`), the closing-write matrix
(`closing-matrix.test.ts`, `pnpm test:session-matrix`), the `act` properties P-C and P-I, and the mutation tests that remove each rule from a copy of the source and
require the property checkers to notice.
