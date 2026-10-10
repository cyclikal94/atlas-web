import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NeutralStatus } from "../../components/ui/neutral-status";
import type { FormFailure, SignInResult, SsoResult } from "./controller";
import { RequestId } from "./MessageText";
import {
  fieldOf,
  MESSAGE_TEXT,
  type Message,
  type MessageField,
} from "./outcome-copy";
import {
  checkCurrentPassword,
  checkSignInUsername,
  FIELD_MESSAGE,
  type FieldReason,
} from "./validation";

/** [D] SWITCH-02: "Signing in needs a connection." */
export const OFFLINE_REASON = "Signing in needs a connection.";
export const BUSY_REASON = "Signing in…";

interface FieldError {
  field: MessageField;
  text: string;
  /** From the Atlas error body, when there was one; shown on its own line. */
  requestId?: string;
}

/**
 * The sign-in form: a real `<form>` (password managers, Enter submits), `autocomplete` tokens, labels associated. A refusal
 * clears the password and moves focus to the field it belongs to, with the message under the field and `aria-invalid`. The
 * password lives in component state for the duration of one submit and is not kept: nothing here reads it back after the
 * call. It renders nothing about any account.
 *
 * A refusal of the password sign-in reaches the form through `carried`, not through the return value of `onSubmit`: the neutral
 * gate unmounts the form between the exchange and the activation, so a form that is mounted when the refusal arrives is not
 * necessarily the one that submitted (review R1). The controller carries every refusal in page memory; this form shows it, once,
 * and takes it. A refusal of single sign-on cannot come after a gate and is shown from the return value.
 */
export function SignInForm({
  online,
  initialUsername,
  onSubmit,
  onSso,
  onBack,
  carried = null,
  onCarriedShown,
}: {
  online: boolean;
  initialUsername: string;
  onSubmit(credentials: {
    username: string;
    password: string;
  }): Promise<SignInResult>;
  onSso(): Promise<SsoResult>;
  /** Reauthenticate mode: back to the card the person came from. */
  onBack?(): void;
  /** A refusal produced by a sign-in that this form, or an earlier one that the gate unmounted, submitted. */
  carried?: Message | null;
  /** Called once the carried refusal is on screen, so a later form does not show it again. */
  onCarriedShown?(): void;
}) {
  const [username, setUsername] = useState(initialUsername);
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
  const fromFailure = (failure: FormFailure) => {
    show(
      fieldOf(failure.message.id),
      MESSAGE_TEXT[failure.message.id],
      failure.message.requestId,
    );
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `show` and the callback are re-created every render; the refusal is the trigger
  useEffect(() => {
    if (carried === null) return;
    show(fieldOf(carried.id), MESSAGE_TEXT[carried.id], carried.requestId);
    onCarriedShown?.();
  }, [carried]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inflight.current || !online) return;
    const name = checkSignInUsername(username);
    if (!name.ok)
      return show("username", FIELD_MESSAGE[name.reason as FieldReason]);
    const secret = checkCurrentPassword(password);
    if (!secret.ok)
      return show("password", FIELD_MESSAGE[secret.reason as FieldReason]);
    setError(null);
    inflight.current = true;
    setBusy(true);
    try {
      // The outcome is not read here: a refusal arrives as `carried` (see above).
      await onSubmit({ username: name.value, password: secret.value });
    } finally {
      inflight.current = false;
      setBusy(false);
      // A password never outlives its submit.
      setPassword("");
    }
  };

  const sso = async () => {
    if (inflight.current || !online) return;
    setError(null);
    inflight.current = true;
    setBusy(true);
    let result: SsoResult;
    try {
      result = await onSso();
    } finally {
      inflight.current = false;
      // After a successful redirect the page is leaving; a failure keeps the form usable.
      setBusy(false);
    }
    if (result.kind === "failed") fromFailure(result);
  };

  const usernameError = error?.field === "username" ? error : null;
  const passwordError = error?.field === "password" ? error : null;
  const formError = error && error.field === null ? error : null;
  const disabledReason = !online ? OFFLINE_REASON : busy ? BUSY_REASON : null;

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
      aria-describedby={formError ? "sign-in-form-error" : undefined}
    >
      <div className="flex flex-col gap-1.5">
        <Input
          ref={usernameRef}
          label="Username"
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={100}
          value={username}
          disabled={!online}
          aria-invalid={usernameError ? true : undefined}
          aria-describedby={
            usernameError ? "sign-in-username-error" : undefined
          }
          onChange={(event) => setUsername(event.target.value)}
        />
        {usernameError ? (
          <NeutralStatus kind="alert" id="sign-in-username-error">
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
          autoComplete="current-password"
          value={password}
          disabled={!online}
          aria-invalid={passwordError ? true : undefined}
          aria-describedby={
            passwordError ? "sign-in-password-error" : undefined
          }
          onChange={(event) => setPassword(event.target.value)}
        />
        {passwordError ? (
          <NeutralStatus kind="alert" id="sign-in-password-error">
            {passwordError.text}
            <RequestId id={passwordError.requestId} />
          </NeutralStatus>
        ) : null}
      </div>
      {formError ? (
        <NeutralStatus kind="alert" id="sign-in-form-error">
          {formError.text}
          <RequestId id={formError.requestId} />
        </NeutralStatus>
      ) : null}
      <div className="flex flex-col items-start gap-3">
        {disabledReason ? (
          <Button
            type="submit"
            variant="primary"
            disabled
            reason={disabledReason}
          >
            Sign in
          </Button>
        ) : (
          <Button type="submit" variant="primary">
            Sign in
          </Button>
        )}
        {disabledReason ? null : (
          <Button variant="secondary" onClick={() => void sso()}>
            Use single sign-on instead
          </Button>
        )}
        {onBack ? (
          <Button variant="quiet" onClick={onBack}>
            Back
          </Button>
        ) : null}
      </div>
    </form>
  );
}
