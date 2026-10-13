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
| Live regions | one registry; a lint rule (R6) rejects any other `aria-live`, `status`, `alert` or `log` (`neutral-status.tsx` was added by WEB-08b for the public surfaces; see `docs/lint-rules.md`) | `lint/live-region-registry.grit` |
| Public surfaces (sign-in, join) and the Settings account card and "Signing in" dialog (WEB-08b) | every state, at 320, 390, 768 and 1280 px, dark and light, in Chromium, Firefox and WebKit: no horizontal scroll, axe **including contrast**, 44 px targets, a visible focus ring, the heading as the focus target where a state has just appeared; forced colours and reduced motion; 400% zoom; keyboard-only completion of sign-in and registration. Screenshots (Chromium) are in `.agtx/evidence/WEB-08b/design/` | `tests/e2e/production.auth-public.spec.ts`, `tests/e2e/fixture.auth-settings.spec.ts` |

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

## What WEB-08b built in

- **The sign-in and join pages are real forms.** `<form>`, labels bound to inputs, `autocomplete` tokens (`username`, `current-password`, `new-password`), no `autofocus` on a field; Enter submits; a password manager can fill and save.
- **A refusal is announced once and sits beside the field it belongs to.** The message is a `role="alert"` inserted when it appears (`neutral-status.tsx`), the field gets `aria-invalid` and `aria-describedby`, the password is cleared and focus moves to the
  field the message is about. The server's own words never reach the page: a message is chosen from a closed catalogue by the Atlas `code`, and the only thing taken from the server is the `request_id`, shown as text on its own line.
- **A state that has just appeared takes focus on its heading** (`tabindex="-1"`), as the neutral states do; a skeleton does not (nothing to read yet).
- **A disabled control states why**, as everywhere: "Signing in needs a connection.", "Creating an account needs a connection.", "Signing in…". The credential controls of "Signing in" do the same while offline ("Changing your password needs a connection.", "Removing a single sign-on link needs a connection.", "Linking single sign-on needs a connection.", "Checking needs a connection."): the reason is visible beside the control and is its accessible description, Remove keeps its consequence as a second description, and the fields keep what was typed.
- **Nothing about any account is on a public surface.** Before settlement no name, id or cookie state is shown, and the tab title is generic ("Sign in · Atlas", "Join · Atlas").
- **Targets and reflow:** every control is 44 px; the account card wraps its actions under a long or hostile username at 320 px without overflowing.
- **The "Signing in" dialog** uses the shared dialog: focus trap, Escape, focus returned to its link. Neither password is kept after the call. An unconfirmed result is shown as such and never retried: a lost answer, or a `5xx` (a gateway can answer `502` after the backend committed the change); only a `4xx` is a refusal. "Check now" finding the session still working leaves it unconfirmed (a working session does not show that the earlier request failed).
- **Remove and Link stop being offered when the window ends.** The five-minute rule is applied while "Signing in" stays open, not only when it opens: at the deadline both become disabled with the same visible reason ("Needs a sign-in from the last few minutes. Sign out and in again first."), which is their accessible description. Nothing announces the change, and a disabled control is drawn in place of the enabled one, so **keyboard focus on Remove or Link falls to the page when the window ends** (Tab then starts again from the top of the dialog), exactly as it does when either becomes busy or the connection is lost. That is the shared `Button`'s disabled form and was not changed; it is listed in the manual checks below.
- **Remove is described by its consequence.** The "signs you out everywhere" paragraph has an id and every Remove control (enabled, "Removing…", or disabled with its reason) lists it in `aria-describedby`, on the mobile sheet and the desktop dialog. A disabled control's own reason is read first. axe does not check this association, so `tests/e2e/fixture.auth-settings.spec.ts` asserts the accessible description at 320 and 1280 px.
- **A refusal that arrives after "Finishing sign-in"** is shown by the sign-in form that mounts next (the heading is focused as for any new state, and the message is a `role="alert"` inserted after the form appears, so it is announced once).


## Today and tasks (WEB-10a)

- Every page has one `h1` (Today, Tasks, the task's title, New task / Edit task); sections are labelled by their `h2`.
- The Today filters are a native radio group (`fieldset`/`legend`: arrow keys move and select); the day and zone are labelled native controls.
- A disabled action always states why beside it (`Button`'s `reason`): "Not open until …", "This day is closed", "Only participants can record this",
  "Wait for this task to finish syncing before editing it".
- A result shown from saved, unsent work is named "provisional" in its text; pending marks are words, never colour alone (the pill tone is decoration).
- Saves and refusals are announced through the announcer only (lint R6); nothing new is a live region.
- Radio choices with a consequence line are named by both, separated (found by the component tests: the names ran together).
- The correction dialog uses the shared `Dialog` (focus trap, Escape discards, focus return, in-dialog sync control keeps the draft).
- Automated: jest-axe in the component tests; axe with real layout and contrast in Chromium, Firefox and WebKit at 390×844, 834×1112, 1112×834,
  1180×820 and 1440×900 in light and dark (`fixture.tasks.spec.ts` E-T1; theme set before load), no horizontal overflow, and a keyboard-only journey
  (E-T8). This is browser emulation: physical devices and manual screen readers are WEB-09d's (collected by WEB-15).
- Revision 1 (R7): axe with real layout in all three engines for the task detail, the correction dialog and the task form at 390×844 and 1440×900,
  light and dark (E-T13), and a keyboard-only journey of the forms and dialogs (E-T8b): the correction dialog opens by Enter with focus inside,
  closes by Escape and saves by Enter, focus returning to "Correct this day" each time; the task form is filled and saved by keyboard. A day named in
  the address that is not available says so in text (no control is offered for it).

## Layer 2: manual keyboard and screen-reader pass (checklist, for WEB-08c and WEB-15)

For each core journey (open the app, move between destinations, open Appearance and change it, open the More sheet, read the sync status, reach a compatibility screen):

- [ ] Every action is reachable and operable by keyboard alone; nothing traps focus; the order matches the visual order.
- [ ] Focus is always visible and never lost to `<body>` after an action.
- [ ] Every control has a name, role and state that match what is shown.
- [ ] Dialogs announce their title, keep focus inside, close on Escape and return focus.
- [ ] Sync changes are announced once, at the right politeness, and a new conflict interrupts.
- [ ] A locked or gated screen announces nothing about any account (WEB-08).
- [ ] WEB-08b journeys: sign in with a wrong and then the right password; reach "Reconnect to keep going" and sign in again; open an invitation link, read the preview, create an account, and read the lost-response state; start single sign-on and return from the provider; open "Signing in", change the password and read the unconfirmed state; with "Signing in" open, switch the device offline and back, and read the reason beside each of Change password, Remove and Link single sign-on; open "Signing in" within a minute of signing in, leave it open for five minutes and note what a screen reader and keyboard focus do when Remove and Link become unavailable; the refusal on each form is announced once and focus lands on the right field.
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
