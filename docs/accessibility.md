# Accessibility

The target is WCAG 2.2 AA, with the accepted Atlas rules on top (`accessibility.md` in the WEB-02 wireframe set). Three layers of evidence apply
(WEB-03 3.6a). WEB-07 supplies layer 1, and the checklist for layer 2. **It claims nothing about layer 3.**

## Layer 1: automated, in every run

| What | How | Where |
| --- | --- | --- |
| Rules that need no layout | `jest-axe` on every component and screen in jsdom | `tests/components`, `tests/app` |
| Rendered colour contrast and layout rules | `axe-core` injected into the real page in Chromium, Firefox and WebKit, dark and light, every sync tone, at 1440, 834 and 390 px | `tests/e2e/fixture.shell.spec.ts`, `fixture.controls.spec.ts`, `production.neutral.spec.ts` |
| Token contrast | every declared foreground/background pair, both themes, computed from the hex values | `tests/design/tokens.test.ts`, `docs/design-tokens.md` |
| Input border (Q17) | painted border colour measured in a real browser, in both themes, against the surface and the fill | `tests/e2e/fixture.controls.spec.ts` |
| Forced colours, reduced motion | emulated media features | `fixture.controls.spec.ts` |
| Reflow | 320 CSS px, a 320 px viewport at 400% zoom, text-spacing overrides (WCAG 1.4.12): no horizontal scrolling | `fixture.shell.spec.ts` |
| Long pages | content taller than the viewport at 390, 834 and 1440 px and in short windows (844x390, 1280x480, 667x375): navigation and the sync chip stay inside the viewport, topmost and clickable at the top, middle and bottom; content is not left under a bar; Tab and Shift+Tab never park focus under the mobile bars; the skip link and route focus stay clear of them | `tests/e2e/fixture.scroll.spec.ts` |
| Live regions | one registry; a lint rule (R6) rejects any other `aria-live`, `status`, `alert` or `log` | `lint/live-region-registry.grit` |

A green layer 1 does not mean the product is accessible. It means the failures a machine can find are absent.

## What WEB-07 built in

- **Skip link** first in tab order, visible on focus, moving focus to `<main id="main" tabindex="-1">` without changing the URL fragment (which carries the sign-in grant).
- **One primary navigation** exposed at a time (rail, icon rail or tab bar), with `aria-current="page"`, heavier weight and an accent bar on the active item: colour is never the only cue (finding F6).
- **Route focus:** after an in-app navigation focus moves to the page heading, never to `<body>`. The initial load does not steal focus.
- **Navigation and status stay in reach on long pages.** The document scrolls (so keyboard scrolling, find in page, scroll restoration and the mobile browser toolbar behave natively) and the chrome does not scroll away with it: the rail is sticky and one viewport tall, and on mobile the header and the bottom tabs are sticky. A screen supplies ordinary long content in `<main>` and does nothing else. In a window too short for every destination the rail's navigation scrolls inside it while the status below stays put. Sticky bars cover part of the viewport, so `scroll-padding` on the root (`src/app/shell/chrome-insets.ts`, measured because the header can wrap) keeps focus, the skip link's target and route focus clear of them (WCAG 2.4.11, technique C43). Removing the padding makes the button keyboard test fail. `scroll-padding` alone is not enough for a text field in WebKit, which reveals the field's caret rather than the field: the caret is clear of a bar while the rest of a 44 px field and its 4 px focus ring can be behind it. So a focus that lands in `<main>` partly under a bar is revealed as a whole box through the same padded scrollport (`scrollIntoView`, nearest edge, no animation; it does nothing when the field and its ring are already clear). A box taller than the space between the bars is left to the browser. Removing that handler fails the WebKit text-field tests (`fixture.scroll.spec.ts`, "text fields"), and also most of the tap and multi-line cases on Chromium and Firefox.
- **Dialogs:** title, description, the sync control **inside** the focus trap (the page behind is inert), a close control, Escape and the close icon discard, only the sync control retains the draft. Focus goes to the first field on open and returns to the opener on close. Tab and Shift+Tab, with or without Option or Alt, wrap inside the dialog (`src/components/ui/focus-loop.ts`), tested on every engine.
- **The sync/offline chip** is a real `<button>` whose accessible name states status and action ("2 waiting to send, Receiving updates: up to date. Open sync queue."). It contains its visible text. A separate announcer reports changes: polite on a change of phase or count, assertive **only** when the conflict count increases, never on first render, coalesced to one per frame.
- **Tone is never colour alone:** every state has words and a dot.
- **44px targets** for touch controls, 48px for the mobile tabs. The dialog Close control and the in-dialog sync control keep 44px at 320px wide beside long labels and large counts: Close does not shrink (`shrink-0`), the title never squeezes below its longest word, and the sync label wraps (`tests/e2e/fixture.shell.spec.ts`, "dialog header keeps a 44 x 44 Close target").
- **Tooltips** on the icon rail show on hover **and** keyboard focus, are dismissible (Escape), hoverable and persistent (WCAG 1.4.13). Controls keep their own accessible names: labels do not depend on hover.
- **Focus ring:** one style everywhere, 2px `action-ink`, 2px offset, and system colours in forced-colours mode.
- **Forms:** every `Input` requires a label association. A disabled control states its reason beside it.

### The sharing screens (WEB-12a)

- The resource kinds of WF-SHARING-03 are a `role="tablist"` (arrows, Home and End move and select, roving `tabindex`, `aria-controls` to the panel); each template choice and each grant's Read/Edit is a labelled `role="radiogroup"`. The resolution chain marks the resolving layer with `aria-current` and the words "resolves here", not colour alone.
- The directory lookup's two variants are separate labelled sections in one reading order (not tabs), and "No account found" is plain text, not an error banner.
- Every disabled Save, Confirm or action states its reason beside it (offline, nothing changed, unsupported server, loading the current defaults). Errors carry a copyable request ID. Announcements (saved, confirmed, an error) go through the announcer only.
- The policy and defaults editors are full-bleed sheets below the desktop breakpoint (1280 px: mobile and both tablet orientations, as the accepted tablet frames draw them) and centred dialogs from it (the shared `Dialog` with `sheetBelow="desktop"`; focus trap, in-dialog sync control and dismissal unchanged), with 44 px targets; the directory lookup is a view inside the open dialog with Back, never a second stacked dialog.
- The in-dialog sync control keeps the editors' unsaved choices and says so when the editor reopens ("Your unsaved changes are shown again"); Cancel, Done, Escape and the close icon discard them (ia.md §1.3.3). The defaults review lists each principal of both audiences with its access and each exclusion, as text.
- Automated: jest-axe on every sharing screen (`tests/features/sharing/*`) and keyboard, viewport and focus checks in the three engines (`tests/e2e/fixture.sharing.spec.ts`). The manual pass below and the real assistive technology passes of Layer 3 apply to these screens too and are not claimed.

## Layer 2: manual keyboard and screen-reader pass (checklist, for WEB-08c and WEB-15)

For each core journey (open the app, move between destinations, open Appearance and change it, open the More sheet, read the sync status, reach a compatibility screen):

- [ ] Every action is reachable and operable by keyboard alone; nothing traps focus; the order matches the visual order.
- [ ] Focus is always visible and never lost to `<body>` after an action.
- [ ] Every control has a name, role and state that match what is shown.
- [ ] Dialogs announce their title, keep focus inside, close on Escape and return focus.
- [ ] Sync changes are announced once, at the right politeness, and a new conflict interrupts.
- [ ] A locked or gated screen announces nothing about any account (WEB-08).
- [ ] Text scaling to 200% and 400% zoom reflows; forced colours and reduced motion behave.
- [ ] On a long page, navigation and the sync status stay reachable while scrolling, and Tab never leaves the focused control, a text field included, or its focus ring under a bar. On real devices: the iOS Safari toolbar collapsing, the installed app's safe areas, a landscape phone, 400% zoom (the two mobile bars then take about half of a 256 px-tall viewport, which the tests do not measure), and a Windows or Linux browser with classic scrollbars (the icon rail hides its scrollbar; the fixture run used overlay scrollbars).

## Layer 3: required real assistive technology before release (Q13)

| Combination | Status |
| --- | --- |
| NVDA with Firefox or Chrome on Windows | **Not run** (WEB-15 release evidence) |
| VoiceOver with Safari on iOS and iPadOS, including the installed web app | **Not run** (WEB-15 release evidence) |
| **TalkBack with Chrome on Android** | **Not run** (WEB-15 release evidence) |

The three combinations, a manual pass through the core journeys, and the recorded results are required before release. A keyboard-only walkthrough of the fixture shell,
run by hand on the host, is informational and does not satisfy Q13.
