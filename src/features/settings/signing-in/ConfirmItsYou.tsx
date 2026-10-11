import { useId, useState } from "react";
import { returnDestination } from "../../../app/return-destination";
import { Button } from "../../../components/ui/button";
import { useSession } from "../../../session";
import { signIn, startSso } from "../../authentication/controller";
import { authFeedback } from "../../authentication/feedback";
import type { Message } from "../../authentication/outcome-copy";
import { SignInForm } from "../../authentication/SignInForm";
import { useOnline } from "../../authentication/use-online";

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
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<Message | null>(null);
  const headingId = useId();

  if (!open)
    return (
      <div className="flex flex-col items-start gap-2" data-confirm-its-you="">
        <Button onClick={() => setOpen(true)}>{CONFIRM_LABEL}</Button>
        <p className="text-[12.5px] leading-[1.6] text-ink-2">{CONFIRM_HINT}</p>
      </div>
    );

  const submit = async (credentials: {
    username: string;
    password: string;
  }) => {
    const identity = session.identity.get();
    if (identity !== null)
      returnDestination.set({
        account: identity.account_id,
        epoch: identity.epoch,
        when: "newer",
        path: "/settings/signing-in",
        focusKey: "link-sso",
        requestedAt: Date.now(),
      });
    const result = await signIn(session, {
      // The read-only field: whatever the form holds, it is this account's username.
      username,
      password: credentials.password,
    });
    if (result.kind === "settled") return result;
    // Not settled: nothing to come back to.
    const pending = returnDestination.peek();
    if (identity !== null && pending?.account === identity.account_id)
      returnDestination.clear();
    if (result.kind === "failed") setFailure(result.message);
    return result;
  };

  return (
    <section
      aria-labelledby={headingId}
      data-confirm-its-you="open"
      className="flex flex-col gap-3 rounded-row border border-hairline-strong bg-inset p-3.5"
    >
      <h4 id={headingId} className="text-[14px] font-medium text-ink-1">
        {CONFIRM_LABEL}
      </h4>
      <SignInForm
        online={online}
        initialUsername={username}
        usernameReadOnly
        submitLabel={CONFIRM_LABEL}
        backLabel={CONFIRM_CANCEL}
        onBack={() => {
          setOpen(false);
          setFailure(null);
        }}
        carried={failure}
        onCarriedShown={() => {
          setFailure(null);
          authFeedback.takeFailure();
        }}
        onSubmit={submit}
        onSso={() => startSso(session, { link: false }, { navigate })}
      />
    </section>
  );
}
