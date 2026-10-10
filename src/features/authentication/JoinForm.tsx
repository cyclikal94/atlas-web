import { type FormEvent, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NeutralStatus } from "../../components/ui/neutral-status";
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
 */
export function JoinForm({
  online,
  submitLabel,
  onSubmit,
}: {
  online: boolean;
  submitLabel: string;
  onSubmit(input: {
    username: string;
    password: string;
  }): Promise<RegisterResult>;
}) {
  const [username, setUsername] = useState("");
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
    setError(null);
    inflight.current = true;
    setBusy(true);
    let result: RegisterResult;
    try {
      result = await onSubmit({ username: name.value, password: secret.value });
    } finally {
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
          onChange={(event) => setUsername(event.target.value)}
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
          <Button type="submit" variant="primary" disabled reason={reason}>
            {submitLabel}
          </Button>
        ) : (
          <Button type="submit" variant="primary">
            {submitLabel}
          </Button>
        )}
      </div>
      <p className="text-[12.5px] leading-[1.6] text-ink-2">{JOIN_FOOTNOTE}</p>
    </form>
  );
}
