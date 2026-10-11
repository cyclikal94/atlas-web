import { useEffect, useRef } from "react";
import type {
  ConsentTicket,
  NeutralActions,
  NeutralStateId,
} from "../../session";
import { Button } from "./button";
import { isGateOpen } from "./gate-dialog";

/**
 * The neutral full-page states of `wireframes/behaviour/reconnect-to-confirm.html` (account-lifecycle matrix 3.7): 1a to
 * 1e, 2, 3 and the post-success consent prompt of WEB-04. Each REPLACES the protected view (it is the entire page, not a
 * dialog), shows nothing about any account, and lives in #neutral-root.
 *
 * Copy is verbatim from the accepted wireframe (decision D-15); its "Engineering note (not product copy)" paragraphs
 * never ship. The heading is the programmatic focus target (`tabindex="-1"`), focused when the state renders; the message
 * is a status, or an alert for the states that report something the person must notice. State 1a NEVER promises that
 * unsent changes "will send": row 3 may end in a wipe (the wireframe's revision R1).
 *
 * This file is on the R6 live-region allowlist (decision D-12): the states need both `status` and `alert`.
 */
type ActionName = "signIn" | "retry" | "reload" | "reviewDevice";

interface Card {
  heading: string;
  message: string;
  /** A second paragraph under the message, before the control. */
  more?: string;
  button?: { label: string; action: ActionName };
  /** A paragraph after the control. */
  note?: string;
  live: "status" | "alert";
}

export const NEUTRAL_COPY: Readonly<
  Record<Exclude<NeutralStateId, "wipe.consent">, Card>
> = {
  "1a.confirming": {
    heading: "Confirming your last action",
    message:
      "We couldn't confirm whether signing out (or retiring this device) finished. Sign in again and we'll check for you — this browser's data for this account will be cleared if it did finish, and kept if it didn't.",
    button: { label: "Reconnect", action: "signIn" },
    note: "We do not yet know if your unsent changes will be kept — we'll tell you as soon as this is confirmed. After you sign in we repeat exactly what you asked for, once, and never against the session you have just signed in with.",
    live: "status",
  },
  "1a.checking": {
    heading: "Checking what happened",
    message:
      "We're checking your earlier request with the record we saved before you sent it. Your content stays hidden until this finishes.",
    live: "status",
  },
  "1a.device_changed": {
    heading: "This device changed after you confirmed",
    message:
      "Something about this device changed before your request was processed, so nothing was removed. Review the device and try again if you still want to retire it.",
    button: { label: "Review this device", action: "reviewDevice" },
    live: "status",
  },
  "1a.ended_elsewhere": {
    heading: "This session had already ended",
    message:
      "Another action ended this session before your request, so nothing was cleared from this browser. Sign in again to carry on.",
    button: { label: "Sign in again", action: "signIn" },
    live: "status",
  },
  "1b": {
    heading: "Reconnect to keep going",
    message:
      "We noticed a change to this session — a sign-out, a password change or an expired session — possibly in another tab or window. Sign in again to confirm it's still you before we show your household's content here.",
    button: { label: "Reconnect", action: "signIn" },
    note: "Nothing was deleted here. Your unsent changes are kept safe and will send once you're reconnected and caught up (next panel).",
    live: "alert",
  },
  "1c.finishing": {
    heading: "Finishing sign-in",
    message:
      "We're confirming your sign-in. Your household's content stays hidden until this finishes, so nothing from another account can appear here.",
    more: "Nothing you typed is lost. If this takes more than a few seconds, check your connection.",
    live: "status",
  },
  "1c.offline": {
    heading: "Reconnect to finish signing in",
    message:
      "You lost your connection while we were confirming your sign-in. We'll finish as soon as you're back online. Content stays hidden until then.",
    live: "status",
  },
  "1c.lock_wait": {
    heading: "Another tab is finishing a sign-in",
    message: "Switch to that tab, or try again here.",
    button: { label: "Try again", action: "retry" },
    live: "status",
  },
  "1c.superseded": {
    heading: "That sign-in was replaced by a newer one",
    message:
      "You started another sign-in after this one, so we ignored this one. Nothing changed on this device.",
    live: "status",
  },
  "1c.resolving": {
    heading: "Checking an unfinished sign-in",
    message:
      "A sign-in didn't finish cleanly, so we're making sure nothing is left behind. Your content stays hidden until this is done.",
    live: "status",
  },
  "1c.ended": {
    heading: "That sign-in didn't finish",
    message:
      "We couldn't confirm it, so we ended it to be safe. Nothing was lost. Sign in again to carry on.",
    button: { label: "Sign in again", action: "signIn" },
    live: "status",
  },
  "1d": {
    heading: "This browser is now signed in as a different account",
    message:
      "Another sign-in on this device replaced yours, so we've hidden your household's content. Sign in again to carry on.",
    button: { label: "Sign in again", action: "signIn" },
    note: "Nothing was deleted here, and your unsent changes are kept. We don't show the other account's details.",
    live: "alert",
  },
  "1e.checking": {
    heading: "Checking your account",
    message:
      "We're checking that this window still belongs to the account you signed in with. Nothing is shown until that's done.",
    more: "Nothing you typed is lost.",
    live: "status",
  },
  "1e.session_online": {
    heading: "Checking your session",
    message:
      "Something about this window's sign-in didn't match, so we've hidden your content while we check. This usually takes a moment and you won't need to do anything.",
    live: "alert",
  },
  "1e.session_offline": {
    heading: "Reconnect to check your session",
    message:
      "We can't finish checking this window's sign-in without a connection. Your content and unsent changes stay on this device and hidden until then.",
    button: { label: "Try again", action: "retry" },
    live: "alert",
  },
  "1e.read_failure": {
    heading: "We couldn't check your account",
    message:
      "This browser wouldn't let us read what we need to confirm your account. Nothing is shown until we can.",
    button: { label: "Reload", action: "reload" },
    live: "alert",
  },
  "1e.interrupted_online": {
    heading: "Checking your session",
    message:
      "A request this browser sent to Atlas didn't finish being checked, so we can't be sure your session is still current. We've hidden your content while we check. This usually takes a moment and you won't need to do anything.",
    live: "status",
  },
  "1e.interrupted_offline": {
    heading: "Reconnect to finish checking",
    message:
      "A request this browser sent to Atlas didn't finish being checked, and we can't confirm your session without a connection. Your content and unsent changes stay on this device and hidden until then.",
    button: { label: "Try again", action: "retry" },
    live: "status",
  },
  "1e.waiting": {
    heading: "Waiting for another window",
    message:
      "Another Atlas window is still finishing a request, so we're waiting for it before we show your content. This usually takes a moment and you won't need to do anything. If it takes longer, close any Atlas windows you're not using. Nothing you typed is lost.",
    live: "status",
  },
  "2": {
    heading: "Catching up",
    message:
      "You're signed in. We're bringing this device up to date — anything you couldn't see stays hidden until this finishes, so you never see stale or wrongly-scoped content.",
    more: "Your unsent changes are preserved and will apply once catch-up completes.",
    live: "status",
  },
  "3": {
    heading: "Couldn't finish catching up",
    message:
      "Content stays hidden until this succeeds — we won't show anything that might be stale or that you may no longer have access to.",
    button: { label: "Try again", action: "retry" },
    live: "status",
  },
};

/** WEB-04 wireframe 4, after a confirmed wipe: a count of changes only, never their content. */
export const CONSENT_HEADING = "You're signed out";
export const consentMessage = (count: number): string =>
  `${count === 1 ? "1 change was" : `${count} changes were`} saved on this device after you confirmed. Delete them now, or keep them here until you decide?`;
export const CONSENT_KEEP = "Keep for now";
export const CONSENT_DELETE = "Delete them →";

export interface NeutralStateProps {
  state: NeutralStateId;
  actions: NeutralActions;
  /** The `wipe.consent` state carries a count only, and the opaque ticket that names this prompt for the choice. */
  consent?: { count: number; ticket: ConsentTicket };
}

export function NeutralState({ state, actions, consent }: NeutralStateProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The heading is the programmatic focus target, focused when the state renders (and again when the state changes), unless the
  // resume gate is open: a hidden page's provisional state renders beneath the modal gate, which owns focus until it lifts
  // (WebKit moves focus to the body when an element under a modal dialog is focused; found when a slower machine let the
  // resume verification finish after the page hid).
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus is meant to follow the state id
  useEffect(() => {
    if (!isGateOpen()) heading.current?.focus();
  }, [state]);

  const main = "mx-auto flex max-w-[620px] flex-col gap-4 px-5 py-16";
  const h1 = "text-[26px] font-semibold tracking-[-0.025em] text-ink-1";
  const body = "text-[14px] leading-[1.6] text-ink-1";
  const muted = "text-[14px] leading-[1.6] text-ink-2";

  if (state === "wipe.consent") {
    // The choice is made on THIS prompt: the ticket the view carried with it names it (two accounts can be waiting).
    const answer = (choice: "delete" | "keep") => {
      if (consent) actions.consent(choice, consent.ticket);
    };
    return (
      <main data-neutral-state={state} className={main}>
        <h1 ref={heading} tabIndex={-1} className={h1}>
          {CONSENT_HEADING}
        </h1>
        <p role="status" className={body}>
          {consentMessage(consent?.count ?? 0)}
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => answer("keep")}>
            {CONSENT_KEEP}
          </Button>
          <Button variant="primary" onClick={() => answer("delete")}>
            {CONSENT_DELETE}
          </Button>
        </div>
      </main>
    );
  }

  const card = NEUTRAL_COPY[state];
  return (
    <main data-neutral-state={state} className={main}>
      <h1 ref={heading} tabIndex={-1} className={h1}>
        {card.heading}
      </h1>
      <p role={card.live} className={body}>
        {card.message}
      </p>
      {card.more ? <p className={muted}>{card.more}</p> : null}
      {card.button ? (
        <div>
          <Button
            variant="primary"
            onClick={() => actions[card.button?.action ?? "retry"]()}
          >
            {card.button.label}
          </Button>
        </div>
      ) : null}
      {card.note ? <p className={muted}>{card.note}</p> : null}
    </main>
  );
}
