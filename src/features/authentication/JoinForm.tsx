import { type FormEvent, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NeutralStatus } from "../../components/ui/neutral-status";
import { useRecoverableEditor } from "../../lib/form-recovery/editor";
import type { RegisterResult } from "./controller";
import { RequestId } from "./MessageText";
import { fieldOf, MESSAGE_TEXT, type MessageField } from "./outcome-copy";
import {
  checkNewPassword,
  checkNewUsername,
  FIELD_MESSAGE,
} from "./validation";

/** [W] registration.html, "Offline (O)". */
export const JOIN_OFFLINE_REASON = "Creating an account needs a connection.";
export const JOIN_BUSY_REASON = "Creating your account…";
/** [W] registration.html, State 1 footnote, verbatim. */
export const JOIN_FOOTNOTE =
  "Only one attempt with this invitation can succeed. If your connection drops after submitting, do not resend — try signing in with the details you chose instead.";

interface FieldError {
  field: MessageField;
  text: string;
  /** From the Atlas error body, when there was one; shown on its own line. */
  requestId?: string;
}

/**
 * The registration form. Real `<form>`; `autocomplete="new-password"` so a password manager offers to save the choice; the
 * username is trimmed and the password never is. It is submitted once: after an outcome the form has nothing to resubmit
 * (the caller drops the token on any unknown outcome) and a refusal that leaves the invitation usable re-enables it.
 *
 * WEB-14a revision 39 (review of revision 38, R40-FREEZE; design assessment C2, I3/I4): a submission is admitted or refused at the gesture
 * (the username's ticket, none while an update reload is being prepared), and one admitted before is waited for until its outcome.
 */
export function JoinForm({
  online,
  submitLabel,
  onSubmit,
  journey = "",
}: {
  online: boolean;
  submitLabel: string;
  /** Revision 40 (R40-GATE): the invitation link this form serves (`invitationMemory.version`): a newer link's form never shows this one's. */
  journey?: string;
  onSubmit(input: {
    username: string;
    password: string;
  }): Promise<RegisterResult>;
}) {
  const [username, setUsername] = useState("");
  // WEB-14a revision 37 (R40): the username typed here is non-secret input of a form shown BEFORE any account is displayed. Revision 39
  // (review of revision 38, R40-COMPOSITION): the invitation that mounts this form lives in page memory only, so no reload can bring the
  // username back to it: its unfinished input stops an update reload and stays here. Nothing of it is written anywhere; never the password.
  // Revision 40 (R40-GATE): it is the invitation's journey's, not this mount's: the form that comes back after a gate shows it again.
  const typed = useRef(false);
  const recovery = useRecoverableEditor<string>({
    identity: "pre-account",
    context: "join",
    encode: (text) => text,
    decode: (text) => text,
    start: () => "",
    untouched: () => !typed.current,
    restored: setUsername,
    reset: (text) => {
      typed.current = false;
      setUsername(text);
    },
    preAccount: true,
    journey,
  });
  const changeUsername = (text: string) => {
    if (!recovery.edit(text)) return;
    typed.current = true;
    setUsername(text);
  };
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FieldError | null>(null);
  const inflight = useRef(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const show = (field: MessageField, text: string, requestId?: string) => {
    setError({ field, text, requestId });
    (field === "username" ? usernameRef : passwordRef).current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inflight.current || !online) return;
    const name = checkNewUsername(username);
    if (!name.ok) return show("username", FIELD_MESSAGE[name.reason]);
    const secret = checkNewPassword(password);
    if (!secret.ok) return show("password", FIELD_MESSAGE[secret.reason]);
    // Revision 39 (R40-FREEZE): admitted now, or nothing is sent.
    const ticket = recovery.submitting();
    if (ticket === null) return;
    setError(null);
    inflight.current = true;
    setBusy(true);
    let result: RegisterResult | null = null;
    try {
      result = await onSubmit({ username: name.value, password: secret.value });
    } finally {
      // Only a settled registration consumed the username; what an unknown outcome leaves is the surface's (`JoinSurface`).
      if (result?.kind === "settled") void ticket.succeeded();
      else ticket.failed();
      inflight.current = false;
      setBusy(false);
    }
    if (result.kind === "failed") {
      setPassword("");
      show(
        fieldOf(result.message.id),
        MESSAGE_TEXT[result.message.id],
        result.message.requestId,
      );
    }
  };

  const usernameError = error?.field === "username" ? error : null;
  const passwordError = error?.field === "password" ? error : null;
  const formError = error && error.field === null ? error : null;
  const reason = !online ? JOIN_OFFLINE_REASON : busy ? JOIN_BUSY_REASON : null;

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
      aria-describedby={formError ? "join-form-error" : undefined}
    >
      <div className="flex flex-col gap-1.5">
        <Input
          ref={usernameRef}
          label="Username"
          name="username"
          type="text"
          placeholder="Choose a username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={100}
          value={username}
          disabled={!online}
          aria-invalid={usernameError ? true : undefined}
          aria-describedby={usernameError ? "join-username-error" : undefined}
          onChange={(event) => changeUsername(event.target.value)}
        />
        {usernameError ? (
          <NeutralStatus kind="alert" id="join-username-error">
            {usernameError.text}
            <RequestId id={usernameError.requestId} />
          </NeutralStatus>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Input
          ref={passwordRef}
          label="Password"
          name="password"
          type="password"
          placeholder="At least 12 characters"
          autoComplete="new-password"
          value={password}
          disabled={!online}
          aria-invalid={passwordError ? true : undefined}
          aria-describedby={passwordError ? "join-password-error" : undefined}
          onChange={(event) => setPassword(event.target.value)}
        />
        {passwordError ? (
          <NeutralStatus kind="alert" id="join-password-error">
            {passwordError.text}
            <RequestId id={passwordError.requestId} />
          </NeutralStatus>
        ) : null}
      </div>
      {formError ? (
        <NeutralStatus kind="alert" id="join-form-error">
          {formError.text}
          <RequestId id={formError.requestId} />
        </NeutralStatus>
      ) : null}
      <div>
        {reason ? (
          <Button type="submit" variant="default" disabled reason={reason}>
            {submitLabel}
          </Button>
        ) : (
          <Button type="submit" variant="default">
            {submitLabel}
          </Button>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {JOIN_FOOTNOTE}
      </p>
    </form>
  );
}
