# Browser support

## Policy (Q12)

Atlas Web targets the **current and previous major release** of:

- Chrome, Edge, Firefox and Safari on desktop;
- Chrome on Android;
- Safari on iOS and iPadOS, including the installed web app.

It is served in a **secure context** (HTTPS; loopback HTTP counts for development). It **requires** these features and has no fallback for a missing or
failing one, because Web Locks, IndexedDB and `inert` underpin the cross-tab account coordination and the deletion and recovery guarantees:

| Feature | Why it is required | Baseline |
| --- | --- | --- |
| Web Locks (`navigator.locks`) | Serialises account transitions and data deletion across tabs. The proposed fallback was rejected (Q12): it had unresolved deletion and recovery races. | Chrome/Edge 69, Firefox 96, Safari 15.4 |
| IndexedDB | Local data, drafts and the outbox (WEB-09). | Universal |
| `inert` attribute | Hides protected content behind the gate; every dialog's page behind is inert. | Chrome/Edge 102, Firefox 112, Safari 15.5 (broadly available since April 2023) |
| Secure context | Service workers, Web Locks and the `__Host-` cookie need it. | — |

A browser that lacks or fails one of these shows the **compatibility screen** (`src/app/CompatibilityScreen.tsx`) and nothing else. It states which
requirement failed and the supported browsers. It offers no way past it and shows nothing about any account. The check is presence (synchronous) and a
functional probe with a 3 s time-out: a lock request that must be granted at once, and a throwaway IndexedDB database that must open and is deleted.
A probe that hangs counts as a failure. The check also runs the **`atlas-auth` canary** (one small write of the durable sign-in record, the same 3 s bound): a page that cannot write it cannot
coordinate, so it never exposes anything and shows the compatibility screen. The server's `api_version` is checked separately, after boot, by `GET /health`; a version outside `>=0.29.0 <0.30.0` (derived
from `contract-pin.json`) or a missing one replaces the sign-in entry with a compatibility screen, and never hides an account that is already settled.

Older major versions are not blocked by user-agent sniffing: capability detection decides. The policy is about what is tested, not what is refused.

## Tested versions

The exact versions are release evidence, recorded by WEB-15 when a release exists. WEB-07 does not invent version numbers: a table filled in now would
be false precision. This table is deliberately **unfilled**.

| Browser | OS | Current major | Previous major | Tested on | Result |
| --- | --- | --- | --- | --- | --- |
| Chrome | Windows / macOS / Linux | _WEB-15_ | _WEB-15_ | | |
| Edge | Windows / macOS | _WEB-15_ | _WEB-15_ | | |
| Firefox | Windows / macOS / Linux | _WEB-15_ | _WEB-15_ | | |
| Safari | macOS | _WEB-15_ | _WEB-15_ | | |
| Chrome | Android | _WEB-15_ | _WEB-15_ | | |
| Safari and installed web app | iOS / iPadOS | _WEB-15_ | _WEB-15_ | | |

## What WEB-07 has actually exercised

Recorded honestly, with what each result does and does not prove.

- **Playwright, three engines, one version each** (the versions pinned by `@playwright/test` 1.63.0): Chromium, Firefox and WebKit, on desktop viewports
  from 320 to 1440 px, in dark and light, with the shell, dialogs, tooltips, keyboard navigation, the Appearance flow, the capability screens, offline fonts, the
  no-flash theme and the content security policy. This shows the behaviour is not engine-specific. It is **not** a claim about real Safari, current or previous.
- **macOS WebKit keyboard note.** Safari on macOS does not Tab to links and buttons unless Option is held (an OS setting, "Press Tab to highlight each item",
  is off by default), so the tests press Option+Tab there (`tests/e2e/helpers.ts`). Radix's focus loop ignores any Tab that carries Option or Alt, so a dialog
  wraps Tab and Shift+Tab itself (`src/components/ui/focus-loop.ts`, a key handler and focus calls only, so the content security policy is unchanged). Every dialog test
  asserts, on every engine, that Tab and Shift+Tab stay inside the dialog, that a whole turn returns to the start, and that Shift+Tab is the exact reverse
  (`expectFocusLoop` in `tests/e2e/helpers.ts`), with the single Firefox reverse-traversal exception described in the next note. With Safari's default setting, plain Tab reaches form controls only; that is the platform's behaviour and is not changed.
- **Long pages and the sticky chrome.** `tests/e2e/fixture.scroll.spec.ts` appends tall content to `<main>` (there is no long routed screen yet) and measures, on all three engines,
  that the navigation and the sync chip stay in the viewport and clickable at the top, middle and bottom, that Tab and Shift+Tab never leave focus under the mobile bars, and
  that the skip link and route focus stay clear of them. Labelled text inputs (the shared input's own classes, 44 px minimum) and textareas get the same check with the whole 4 px focus ring
  included, at 390x844, 320x568, 667x375 and 767x400, for Tab and Shift+Tab, programmatic focus and a tap on the visible sliver of a half-covered field. WebKit reveals the caret of a focused
  text field, not the field, so the shell reveals the whole box itself (`src/app/shell/chrome-insets.ts`); on Chromium and Firefox the Tab traversal already passed without it. The runs used overlay scrollbars and no dynamic browser toolbar or safe-area inset: a Windows or Linux browser with classic scrollbars,
  the iOS Safari toolbar and the installed app's safe areas are **not** exercised here (WEB-15).
- **Playwright Firefox and Radix's radio group.** Playwright's Firefox does not run a microtask between a keydown listener and Tab's default action (a plain-DOM control page
  reproduces it with no React or Radix). Radix's roving-focus group leaves by Shift+Tab through a React state update committed in that gap, so the Shift+Tab traversal out of the
  Appearance radio group is checked in full on Chromium and WebKit and only for the wrap from the first control on Firefox. Real Firefox has **not** been checked (WEB-15).
- **Offline in WebKit is not verified here.** Playwright's WebKit cannot emulate offline for service-worker navigations, so the offline deep-link test is skipped
  there. Real Safari offline behaviour is WEB-14a and WEB-15 evidence.
- **WEB-08a, the session module** (`docs/session.md`). Real Chromium, Firefox and WebKit (one Playwright version each) ran: the production `atlas-auth` IndexedDB store (creation-order visibility across two pages, atomic abort,
  `versionchange`, a malformed record failing closed), Web Locks (FIFO per name, grant only after release, release when the holder closes, abort before grant, `query()` never called), `BroadcastChannel` hints,
  and the level-0 gate with real `inert` and the real top layer; the screens in both themes at 320, 390, 768 and 1280 px with axe including contrast; and the integration set against the released backend
  (`pnpm test:integration`). **Limitations:** visibility is driven by overriding `document.visibilityState` and dispatching `visibilitychange`, not by the engine's own event; Playwright contexts are ephemeral
  profiles, so `durability: 'strict'` is not measured against a real on-disk profile; real freeze, bfcache and assistive technology are WEB-08c; real Safari and devices are WEB-15.
- **WEB-08c, lifecycle and Web Locks** (`docs/lifecycle-evidence.md`). On the production build with a stubbed network, in Chromium, Firefox and WebKit (one Playwright
  version each): the resume gate's first frame after a hide (and, in **Chromium only**, a CDP freeze with `Page.setWebLifecycleState`) is inert and hidden from assistive
  technology; a page frozen inside its `atlas-auth` callback makes another page's sign-in wait the full 20 s and nothing steals the lock; a `401` is recorded while that lock
  is held; another page's request for a closed owner's `atlas-lease-<id>` is granted (P-lock-a, close). **Limitations:** a frozen page exists in Chromium only (CDP), so
  P-lock-c is Chromium-only; Playwright's CDP `Page.crash` disposes or hangs the shared context, so P-lock-a after a crash is **not observable here**; the back/forward
  cache did not restore these pages under Playwright (recorded per engine, not passed); headless Firefox and WebKit cannot background a page natively. These are environment
  limits, not acceptance waivers: native backgrounding, real Safari and devices are WEB-09d's. Two engine artefacts of a test's OWN navigation are tolerated by exact
  message only: WebKit's page error for a fetch the departing document's reload cancelled (HF-4) and Firefox's warning that a transaction was aborted by the navigation (HF-2).
- **Not exercised:** previous-major versions of any browser, real Android and iOS devices, the installed web app, HTTPS with a real certificate (so the `__Host-` cookie
  was observed only through the documented loopback variant, `atlas_session`).

## Screen readers (Q13)

Three combinations are required before release: NVDA with Firefox or Chrome on Windows, VoiceOver with Safari on iOS and iPadOS (including the installed
web app), and **TalkBack with Chrome on Android**. `docs/accessibility.md` carries the checklist. None is claimed here.
