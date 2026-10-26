import { useId, useSyncExternalStore } from "react";
import {
  type ReturnDestination,
  returnDestination,
} from "../../../app/return-destination";
import { Button } from "../../../components/ui/button";
import { type Session, useSession } from "../../../session";
import {
  type SignInResult,
  type SsoResult,
  signIn,
  startSso,
} from "../../authentication/controller";
import { authFeedback } from "../../authentication/feedback";
import { SignInForm } from "../../authentication/SignInForm";
import { useOnline } from "../../authentication/use-online";
import { type ConfirmOwner, confirmFlow } from "./confirm-state";

/** [P] (gap G-23): no accepted wireframe exists for in-place re-authentication. */
export const CONFIRM_LABEL = "Confirm it's you";
export const CONFIRM_HINT =
  "Sign in again here to unlock these controls for a few minutes. You'll come back to this screen.";
export const CONFIRM_CANCEL = "Cancel";

/**
 * In-place SAME-account re-authentication (WEB-08c, gap G-23). Linking and removing single sign-on need a session created in the last
 * five minutes; instead of "sign out and in again first", the person confirms their password here. The username is READ-ONLY: it is
 * the current account's own, from the fresh `GET /me` read the screen already made (D-8b-07, sealed for the settled identity), so this
 * can only ever be a sign-in as the account that is signed in. A settlement makes a new session at a newer epoch; the protected tree is
 * closed for it and mounts again, and the page puts the person back on this screen with focus on the link control
 * (`return-destination.ts`: same account, newer epoch, once, 120 s; D-8c-03). Nothing here grants anything: the server decides, a `401`
 * on the link call afterwards is still the fail-closed path (O9), and another tab settling a different account drops the destination.
 *
 * It is shown inline in the "Signing in" dialog, not as a second dialog on top of it (the package's dialog makes the page behind it
 * inert; two stacked would contend for that). Single sign-on leaves the page, so it carries no return destination (page memory does not
 * survive the round trip).
 *
 * Whether it is open, and a refusal to show, live in page memory bound to this session (`confirm-state.ts`), so a refusal that arrives
 * after the activation's gate has closed and re-opened the tree is still shown here (R3 of the review of 11 October 2026). Cancel
 * cancels a sign-in in flight (R1). Leaving the "Signing in" dialog does not: a submitted confirmation of the SAME account completes, and
 * its return destination brings the person back here.
 */
export function ConfirmItsYou({
  username,
  navigate = (url: string) => location.assign(url),
}: {
  username: string;
  navigate?(url: string): void;
}) {
  const session = useSession();
  const online = useOnline();
  const identity = useSyncExternalStore(
    session.identity.subscribe,
    session.identity.get,
    session.identity.get,
  );
  const owner: ConfirmOwner | null =
    identity === null
      ? null
      : { account: identity.account_id, epoch: identity.epoch };
  const stage = useSyncExternalStore(
    confirmFlow.subscribe,
    () => confirmFlow.for(owner),
    () => confirmFlow.for(owner),
  );
  const headingId = useId();

  if (stage === null || owner === null)
    return (
      <div className="flex flex-col items-start gap-2" data-confirm-its-you="">
        <Button onClick={() => owner && confirmFlow.open(owner)}>
          {CONFIRM_LABEL}
        </Button>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {CONFIRM_HINT}
        </p>
      </div>
    );

  return (
    <section
      aria-labelledby={headingId}
      data-confirm-its-you="open"
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted p-3.5"
    >
      <h4 id={headingId} className="text-sm font-medium text-foreground">
        {CONFIRM_LABEL}
      </h4>
      <SignInForm
        online={online}
        initialUsername={username}
        usernameReadOnly
        submitLabel={CONFIRM_LABEL}
        backLabel={CONFIRM_CANCEL}
        onBack={() => confirmFlow.cancel()}
        carried={stage.failure}
        onCarriedShown={() => {
          confirmFlow.failureShown(owner);
          authFeedback.takeFailure();
        }}
        onSubmit={(credentials) =>
          confirmSignIn(session, owner, username, credentials.password)
        }
        onSso={() => confirmSso(session, owner, navigate)}
      />
    </section>
  );
}

/** Single sign-on from the open section, as the same kind of journey: Cancel before it navigates cancels it. */
export async function confirmSso(
  session: Session,
  owner: ConfirmOwner,
  navigate: (url: string) => void,
): Promise<SsoResult> {
  const journey = confirmFlow.submit(owner);
  if (journey === null) return { kind: "cancelled" };
  const result = await startSso(
    session,
    { link: false },
    { navigate },
    journey.signal,
  );
  confirmFlow.finish(journey);
  return result;
}

/**
 * The confirmation's sign-in, as a journey of the page-memory flow (`confirmFlow.submit`): Cancel aborts it and the controller cancels
 * its attempt with the session. The username is the read-only field's: whatever the form holds, it is this account's own.
 *
 * The return destination (D-8c-03) is set for THIS request and belongs to it (R2 of the review of 11 October 2026):
 *  - `settled`: kept; the same account mounts at the newer epoch and takes it;
 *  - `gating`: kept; the activation's outcome is unknown, and a later settlement of the same account at a newer epoch still takes it
 *    (another account mounting, a remount at the old epoch after 120 s, or a newer request's own destination still drop or replace it);
 *  - anything else (a refusal, a newer attempt, a busy lock, Cancel): nothing is coming back, so ITS destination is dropped, and never one
 *    that a newer request set meanwhile.
 * A refusal is kept in the flow for whichever mount of this session's tree shows it (the activation's gate unmounts the one that asked).
 */
export async function confirmSignIn(
  session: Session,
  owner: ConfirmOwner,
  username: string,
  password: string,
): Promise<SignInResult> {
  const journey = confirmFlow.submit(owner);
  if (journey === null) return { kind: "cancelled" };
  const destination: ReturnDestination = {
    account: owner.account,
    epoch: owner.epoch,
    when: "newer",
    path: "/settings/signing-in",
    focusKey: "link-sso",
    requestedAt: Date.now(),
  };
  returnDestination.set(destination);
  const result = await signIn(session, { username, password }, journey.signal);
  const current = confirmFlow.finish(journey);
  // Confirmed: the section's work is done (the newer session's tree opens at the return destination).
  if (result.kind === "settled") {
    if (current) confirmFlow.cancel();
    return result;
  }
  if (result.kind === "gating") return result;
  returnDestination.clearIf(destination);
  if (current && result.kind === "failed")
    confirmFlow.fail(journey, result.message);
  return result;
}
