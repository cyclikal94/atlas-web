/**
 * The copy deck of `wireframes/behaviour/reconnect-to-confirm.html` (WEB-05.5), extracted from the accepted wireframe by
 * script and NOT typed by hand, so the component's own copy (`src/components/ui/neutral-state.tsx`) is compared with the
 * wireframe's words. The wireframe's "Engineering note (not product copy)" paragraphs are deliberately absent.
 * Keys: heading, message, more (a second paragraph before the control), button (the control's label), note (after it).
 */
export const COPY_DECK: Record<
  string,
  {
    heading: string;
    message: string;
    more?: string;
    button?: string;
    note?: string;
  }
> = {
  "1a.confirming": {
    heading: "Confirming your last action",
    message:
      "We couldn't confirm whether signing out (or retiring this device) finished. Sign in again and we'll check for you — this browser's data for this account will be cleared if it did finish, and kept if it didn't.",
    button: "Reconnect",
    note: "We do not yet know if your unsent changes will be kept — we'll tell you as soon as this is confirmed. After you sign in we repeat exactly what you asked for, once, and never against the session you have just signed in with.",
  },
  "1a.checking": {
    heading: "Checking what happened",
    message:
      "We're checking your earlier request with the record we saved before you sent it. Your content stays hidden until this finishes.",
  },
  "1a.device_changed": {
    heading: "This device changed after you confirmed",
    message:
      "Something about this device changed before your request was processed, so nothing was removed. Review the device and try again if you still want to retire it.",
    button: "Review this device",
  },
  "1a.ended_elsewhere": {
    heading: "This session had already ended",
    message:
      "Another action ended this session before your request, so nothing was cleared from this browser. Sign in again to carry on.",
    button: "Sign in again",
  },
  "1b": {
    heading: "Reconnect to keep going",
    message:
      "We noticed a change to this session — a sign-out, a password change or an expired session — possibly in another tab or window. Sign in again to confirm it's still you before we show your household's content here.",
    button: "Reconnect",
    note: "Nothing was deleted here. Your unsent changes are kept safe and will send once you're reconnected and caught up (next panel).",
  },
  "1c.finishing": {
    heading: "Finishing sign-in",
    message:
      "We're confirming your sign-in. Your household's content stays hidden until this finishes, so nothing from another account can appear here.",
    more: "Nothing you typed is lost. If this takes more than a few seconds, check your connection.",
  },
  "1c.offline": {
    heading: "Reconnect to finish signing in",
    message:
      "You lost your connection while we were confirming your sign-in. We'll finish as soon as you're back online. Content stays hidden until then.",
  },
  "1c.lock_wait": {
    heading: "Another tab is finishing a sign-in",
    message: "Switch to that tab, or try again here.",
    button: "Try again",
  },
  "1c.superseded": {
    heading: "That sign-in was replaced by a newer one",
    message:
      "You started another sign-in after this one, so we ignored this one. Nothing changed on this device.",
  },
  "1c.resolving": {
    heading: "Checking an unfinished sign-in",
    message:
      "A sign-in didn't finish cleanly, so we're making sure nothing is left behind. Your content stays hidden until this is done.",
  },
  "1c.ended": {
    heading: "That sign-in didn't finish",
    message:
      "We couldn't confirm it, so we ended it to be safe. Nothing was lost. Sign in again to carry on.",
    button: "Sign in again",
  },
  "1d": {
    heading: "This browser is now signed in as a different account",
    message:
      "Another sign-in on this device replaced yours, so we've hidden your household's content. Sign in again to carry on.",
    button: "Sign in again",
    note: "Nothing was deleted here, and your unsent changes are kept. We don't show the other account's details.",
  },
  "1e.checking": {
    heading: "Checking your account",
    message:
      "We're checking that this window still belongs to the account you signed in with. Nothing is shown until that's done.",
    more: "Nothing you typed is lost.",
  },
  "1e.session_online": {
    heading: "Checking your session",
    message:
      "Something about this window's sign-in didn't match, so we've hidden your content while we check. This usually takes a moment and you won't need to do anything.",
  },
  "1e.session_offline": {
    heading: "Reconnect to check your session",
    message:
      "We can't finish checking this window's sign-in without a connection. Your content and unsent changes stay on this device and hidden until then.",
    button: "Try again",
  },
  "1e.read_failure": {
    heading: "We couldn't check your account",
    message:
      "This browser wouldn't let us read what we need to confirm your account. Nothing is shown until we can.",
    button: "Reload",
  },
  "1e.interrupted_online": {
    heading: "Checking your session",
    message:
      "A request this browser sent to Atlas didn't finish being checked, so we can't be sure your session is still current. We've hidden your content while we check. This usually takes a moment and you won't need to do anything.",
  },
  "1e.interrupted_offline": {
    heading: "Reconnect to finish checking",
    message:
      "A request this browser sent to Atlas didn't finish being checked, and we can't confirm your session without a connection. Your content and unsent changes stay on this device and hidden until then.",
    button: "Try again",
  },
  "1e.waiting": {
    heading: "Waiting for another window",
    message:
      "Another Atlas window is still finishing a request, so we're waiting for it before we show your content. This usually takes a moment and you won't need to do anything. If it takes longer, close any Atlas windows you're not using. Nothing you typed is lost.",
  },
  "2": {
    heading: "Catching up",
    message:
      "You're signed in. We're bringing this device up to date — anything you couldn't see stays hidden until this finishes, so you never see stale or wrongly-scoped content.",
    more: "Your unsent changes are preserved and will apply once catch-up completes.",
  },
  "3": {
    heading: "Couldn't finish catching up",
    message:
      "Content stays hidden until this succeeds — we won't show anything that might be stale or that you may no longer have access to.",
    button: "Try again",
  },
};
