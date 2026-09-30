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
| **R1 `no-raw-network`** | No `fetch`, `window/globalThis/self.fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `navigator.sendBeacon`. Covers `src/sw.ts`. | `src/lib/api-client/**` | matrix 3.6.2 step 1: the stamped wrapper is the only way any page reaches the API |
| **R2 `no-locks-query`** | `navigator.locks.query()` (and `locks.query()`) is never called. A held lock, a hint, a time-out or an earlier read is not evidence of another page's state. | nowhere | matrix 3.6.3 item 3 |
| **R3 `portal-only-via-ui`** | `createPortal`, `react-dom`, and imports of Radix `portal`, `dialog`, `alert-dialog`, `popover`, `tooltip`, `dropdown-menu`, `select`, `hover-card`, `context-menu`, `menubar`, `navigation-menu`, `toast`; `document.body.append/appendChild/prepend/insertAdjacentHTML/insertAdjacentElement/replaceChildren/before/after`; `document.write(ln)`. | `src/components/ui/**` | matrix 3.7.1: no portal renders account data outside `#protected-root` |
| **R4 `gate-import-allowlist`** | `src/protected-surface/gate` (mount, lift and apply the gate) is imported only by the session module and the fixture entry. | `src/session/**`, `src/fixture/**`, `src/protected-surface/**` | matrix 3.6.3: mount and gate-lift callable only from `act` |
| **R5 `title-only-via-module`** | `document.title` is written only through `src/protected-surface/title.ts`. The tab title can reveal what is open. | `src/protected-surface/title.ts` | matrix 3.7.1: the title is protected surface |
| **R6 `live-region-registry`** | `aria-live`, `role="status"`, `role="alert"` and `role="log"` only in the announcer, the neutral gate and the sync chip module. A stray live region would announce protected text while the gate is closed. | `announcer.tsx`, `neutral-gate.tsx`, `sync-status.tsx` in `src/components/ui/` | matrix 3.7.2 step 1c |

**Extending an allowlist is a reviewed change.** The list of allowed places is the lint configuration; widening it needs the same review as the code it lets through.

Known limits, so no one mistakes the rules for proof: they see syntax, not data flow. An aliased `const q = navigator.locks; q.query()` is not caught by R2; a
`document.title` written through an alias is not caught by R5; `Object.defineProperty(document, "title", ...)` is not caught. The rules stop accidents and make deliberate evasion visible in review;
WEB-08a's runtime tests are the other half.

## Handed to WEB-08a (register)

These cannot be written until WEB-08a's functions exist. The rule text is the requirement; the framework, the fixture harness and the scoping mechanism above are ready.

| Rule | Text | Source |
| --- | --- | --- |
| **R7** | Every API `fetch` is preceded by its lease `complete` and the send-boundary guard that consults `page.closing`, released in the same synchronous step. | matrix 3.6.3 item 3 (nineteenth-round list) |
| **R8** | A closing write's first statement is `begin_closing()`. | same |
| **R9** | The lock promise is settled before the first `await`, body read or storage call, with the interim hold set in the same step. | same |
| **R10** | `act` performs no `await` or read. | same |
| **R11** | Every activity is created before its first lock request. | same |
| **R12** | No `send` reads display state. | same |

If a reviewer reads the matrix's sentence as requiring R7 to R12 in WEB-07, the missing input is WEB-08a's function names. This is recorded as a risk in the plan.
