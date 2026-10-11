import { type FormEvent, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { useSession } from "../../../session";
import {
  MESSAGE_TEXT,
  type MessageId,
} from "../../authentication/outcome-copy";
import { isOnlineNow, useOnline } from "../../authentication/use-online";
import {
  checkCurrentPassword,
  checkNewPassword,
  FIELD_MESSAGE,
} from "../../authentication/validation";
import { useInteractions } from "../sessions-devices/ownership";
import { untilSent } from "../sessions-devices/until-sent";
import { leavesOutcomeUnknown } from "./outcome";
import { Unconfirmed } from "./Unconfirmed";

/** [D] "Atlas Settings Screens", SETTINGS-03: the heading, the consequence and the button. */
export const PASSWORD_HEADING = "Change your password";
export const PASSWORD_CONSEQUENCE =
  "This signs you out everywhere, including here. You'll sign back in with the new password. Anything you've recorded but not yet sent stays saved on this device.";
/** [W] WF-SETTINGS-03: "New password (12–1,024 bytes)", kept as a hint under the field. */
export const PASSWORD_HINT = "12–1,024 bytes";
/**
 * [P], design gap G-16: the backend answers a WRONG current password with `401 unauthenticated`, which fails closed (the session
 * ends into "Reconnect to keep going"). Disclosed here rather than hidden; recommended backend follow-up: a distinct non-401 code.
 */
export const WRONG_CURRENT_WARNING =
  "If your current password is wrong, this session will also end.";
/** [P], review R7: no accepted wording exists for the offline state; the sibling reasons are one sentence of this shape. */
export const PASSWORD_OFFLINE_REASON =
  "Changing your password needs a connection.";
/** [D] "No password at all?" */
export const NO_PASSWORD_HEADING = "No password at all?";
export const NO_PASSWORD_BODY =
  "If SSO is your only way in, you can't set a first password here — an administrator has to do it.";

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; field: "current" | "next" | null; text: string }
  | { kind: "unconfirmed" };

/**
 * What a REFUSED password change says, by the status alone: the answer's body is not read (docs/session.md). Only a `4xx` gets
 * here; a `5xx` cannot show the change was not made and is unconfirmed instead (`leavesOutcomeUnknown`, review R6).
 */
function messageForStatus(status: number | undefined): MessageId {
  switch (status) {
    case 400:
    case 422:
      return "check_details";
    case 429:
      return "rate_limited";
    case 403:
      return "wrong_origin";
    default:
      return "generic";
  }
}

/**
 * WF-SETTINGS-03, "Change your password". Success revokes every session including this one, so the record raises its fence and
 * the tree unmounts into "Reconnect to keep going": nothing is drawn after a success. An unknown outcome (a lost answer, or a
 * gateway or server error that cannot show the change was not made) is shown as unconfirmed and never retried. Neither password
 * is kept after the call. The action is disabled, with its reason, while the browser reports no connection, and its handler
 * refuses to send then; that is a hint, never the evidence for an outcome: a request that started online is judged by its answer.
 */
export function ChangePasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const session = useSession();
  const interactions = useInteractions();
  const announcer = useAnnouncer();
  const online = useOnline();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inflight = useRef(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const ids = {
    current: useId(),
    next: useId(),
    hint: useId(),
    consequence: useId(),
  };

  if (!hasPassword)
    return (
      <section
        aria-labelledby="no-password-heading"
        className="flex flex-col gap-1.5"
        data-no-password=""
      >
        <h3
          id="no-password-heading"
          className="text-[14px] font-medium text-ink-1"
        >
          {NO_PASSWORD_HEADING}
        </h3>
        <p className="text-[13px] leading-[1.6] text-ink-2">
          {NO_PASSWORD_BODY}
        </p>
      </section>
    );

  const fail = (field: "current" | "next" | null, text: string) => {
    setPhase({ kind: "error", field, text });
    announcer.announce(text, "assertive");
    (field === "next" ? nextRef : currentRef).current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inflight.current || !online || !isOnlineNow()) return;
    const old = checkCurrentPassword(current);
    if (!old.ok) return fail("current", FIELD_MESSAGE[old.reason]);
    const fresh = checkNewPassword(next);
    if (!fresh.ok) return fail("next", FIELD_MESSAGE[fresh.reason]);
    inflight.current = true;
    setPhase({ kind: "busy" });
    // WEB-08d review R3: a change refused before it was sent is tried again only while this form is mounted; leaving the screen
    // withdraws one still waiting to be issued. One already sent is never withdrawn: its answer decides.
    const interaction = interactions.begin();
    const result = await untilSent(
      () =>
        session.operations.changePassword(
          { current: old.value, next: fresh.value },
          { withdraw: interaction.withdraw },
        ),
      { isCurrent: interaction.current },
    ).catch(() => null);
    // WEB-08d review R4: asked BEFORE ending it. A form that was dismissed, left or replaced, or whose identity moved on, may not show
    // the outcome: the announcer outlives the form, so an old answer would speak over whatever the person is doing now. The session
    // still observes what the request did (a success or a 401 ends the session everywhere, the neutral state takes over).
    const owned = interaction.current();
    interaction.end();
    inflight.current = false;
    // A password never outlives its submit. These are this form's own fields: a reopened form is another one, which this cannot touch.
    setCurrent("");
    setNext("");
    if (!owned) return setPhase({ kind: "idle" });
    if (result === null || leavesOutcomeUnknown(result))
      return setPhase({ kind: "unconfirmed" });
    if (result.ok) return setPhase({ kind: "idle" });
    // `auth_state` and `closed`: the session ended (success, or a wrong current password: gap G-16); the neutral state takes over.
    if (result.error === "auth_state" || result.error === "closed")
      return setPhase({ kind: "idle" });
    fail(
      null,
      MESSAGE_TEXT[
        result.error === "not_sent"
          ? "busy_window"
          : messageForStatus(result.status)
      ],
    );
  };

  const error = phase.kind === "error" ? phase : null;
  const busy = phase.kind === "busy";
  // A request already on the wire is the thing to say, even if the connection has since dropped: its answer decides.
  const reason = busy
    ? "Changing your password…"
    : !online
      ? PASSWORD_OFFLINE_REASON
      : null;
  return (
    <section aria-labelledby="password-heading" className="flex flex-col gap-3">
      <h3 id="password-heading" className="text-[14px] font-medium text-ink-1">
        {PASSWORD_HEADING}
      </h3>
      <form
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-3"
      >
        <Input
          ref={currentRef}
          id={ids.current}
          label="Current password"
          name="current-password"
          type="password"
          autoComplete="current-password"
          surface="panel"
          value={current}
          aria-invalid={error?.field === "current" ? true : undefined}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <div className="flex flex-col gap-1.5">
          <Input
            ref={nextRef}
            id={ids.next}
            label="New password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            surface="panel"
            value={next}
            aria-describedby={`${ids.hint} ${ids.consequence}`}
            aria-invalid={error?.field === "next" ? true : undefined}
            onChange={(event) => setNext(event.target.value)}
          />
          <p id={ids.hint} className="text-[12px] text-ink-2">
            {PASSWORD_HINT}
          </p>
        </div>
        <p
          id={ids.consequence}
          className="text-[12.5px] leading-[1.6] text-ink-2"
        >
          {PASSWORD_CONSEQUENCE}
        </p>
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          {WRONG_CURRENT_WARNING}
        </p>
        {error ? (
          <p data-error="" className="text-[13px] text-ink-1">
            {error.text}
          </p>
        ) : null}
        <div>
          {reason ? (
            <Button type="submit" variant="primary" disabled reason={reason}>
              Change password
            </Button>
          ) : (
            <Button type="submit" variant="primary">
              Change password
            </Button>
          )}
        </div>
      </form>
      {phase.kind === "unconfirmed" ? (
        <Unconfirmed check={() => session.operations.readAccount()} />
      ) : null}
    </section>
  );
}
