import { type FormEvent, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { type DeviceRow, type Result, useSession } from "../../../session";
import { isOnlineNow, useOnline } from "../../authentication/use-online";
import {
  CANCEL,
  DONE,
  NAME_A_DEVICE_TITLE,
  NAME_CHANGE_REFUSED,
  NAME_DESCRIPTION,
  NAME_GONE,
  NAME_LABEL,
  NAME_NOT_SENT,
  NAME_OFFLINE_REASON,
  NAME_PROBLEM,
  NAME_REFUSED,
  NAME_REMOVED,
  NAME_REMOVED_NEWER_KEPT,
  NAME_SAVED,
  NAME_SAVED_NEWER_KEPT,
  NAME_THIS_DEVICE_TITLE,
  NAME_UNCONFIRMED,
  REMOVE_NAME,
  renameTitle,
  SAVE_NAME,
} from "./label-copy";
import { checkDeviceName, deviceDisplay, isolate } from "./labels";
import { mayHaveChanged } from "./outcome";
import { type Interaction, reconcileLists } from "./ownership";
import { untilSent } from "./until-sent";

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  /** The typed value breaks the name rules: nothing was sent. */
  | { kind: "invalid"; text: string }
  /** A definite answer that changed nothing, or one whose effect is unknown; the list was read again where that helps. */
  | { kind: "message"; text: string; gone?: boolean; kept?: boolean };

/**
 * D-8d-09/10: naming a listed device (BE-Q25 `PUT`/`DELETE /devices/{id}/name`). The typed text is sent exactly as typed: it is
 * checked against the server's own `DeviceName` rules first and never trimmed or normalised. A name is display metadata only; it
 * is not part of the device's state token, so naming never stales a retirement confirmation.
 *
 * Review R1/R3 (revision 2): this dialog is one `interaction`. A change the server may have made (confirmed, `gone`, or unknown) is
 * reported for the lists whether or not the dialog is still open: dismissing it cannot undo a request already sent. Only while the
 * interaction is current (not dismissed or replaced, the identity unchanged) is another attempt made or the outcome shown. The
 * request carries the interaction's `withdraw`, so one dismissed before it was issued is never sent. (This supersedes the plan's
 * D-8d-10 "a result after the dialog has gone changes nothing": it shows nothing; the lists still reconcile.)
 *
 * Review R6 (revision 8): a submission owns only the draft it submitted. Every accepted edit moves `revision` on, and a submission
 * keeps the revision it was taken from. A completed save or removal closes the dialog only if the draft is still that one;
 * otherwise the newer text stays in the field, unsent, with its focus, and the person is told what the earlier request did.
 */
export function NameDeviceDialog({
  device,
  interaction,
  onClose,
}: {
  device: DeviceRow;
  /** This opening of the dialog: begun by the opener, ended when the dialog is dismissed or replaced. */
  interaction: Interaction;
  onClose(): void;
}) {
  const session = useSession();
  const announcer = useAnnouncer();
  const online = useOnline();
  const display = deviceDisplay(device);
  const [value, setValue] = useState(display.named ? display.title : "");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inflight = useRef(false);
  /** The draft's revision: moved on synchronously by every accepted edit, so an edit away and back is still a later draft. */
  const revision = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const formId = useId();
  const problemId = useId();
  const describedId = useId();

  const send = async (name: string | null) => {
    if (inflight.current || !isOnlineNow() || !interaction.current()) return;
    inflight.current = true;
    const submitted = revision.current;
    setPhase({ kind: "busy" });
    const result: Result<"named" | "cleared" | "gone"> | null = await untilSent(
      () =>
        session.operations.nameDevice(device.id, name, {
          withdraw: interaction.withdraw,
        }),
      { isCurrent: interaction.current },
    ).catch(() => null);
    inflight.current = false;
    // First what the server may have changed (both lists show the name), whoever is still looking: the person may have closed the
    // dialog after the request was sent, and that does not undo it.
    if (mayHaveChanged(result)) reconcileLists(session, interaction.scope);
    // Dismissed, replaced, or the identity moved on: the answer is nobody's to show.
    if (!interaction.current()) return;
    if (result?.ok) {
      if (result.value === "gone") {
        setPhase({ kind: "message", text: NAME_GONE, gone: true });
        announcer.announce(NAME_GONE, "assertive");
        return;
      }
      if (revision.current === submitted) {
        announcer.announce(
          result.value === "named" ? NAME_SAVED : NAME_REMOVED,
        );
        onClose();
        return;
      }
      // A later edit is not this request's to discard: keep it, unsent, and say what the earlier request did.
      const text =
        result.value === "named"
          ? NAME_SAVED_NEWER_KEPT
          : NAME_REMOVED_NEWER_KEPT;
      setPhase({ kind: "message", text, kept: true });
      announcer.announce(text);
      return;
    }
    // The session ended (the neutral state takes over) or the answer belongs to an identity that is no longer settled: say nothing.
    if (result && (result.error === "auth_state" || result.error === "closed"))
      return setPhase({ kind: "idle" });
    const text =
      result?.error === "not_sent"
        ? NAME_NOT_SENT
        : result?.error === "http" &&
            result.status !== undefined &&
            result.status >= 400 &&
            result.status < 500
          ? `${result.status === 400 || result.status === 422 ? NAME_REFUSED : NAME_CHANGE_REFUSED}${
              result.atlasError?.request_id
                ? ` Request ID: ${result.atlasError.request_id}`
                : ""
            }`
          : NAME_UNCONFIRMED;
    // An outcome nobody can confirm (offline after sending, a 5xx, a lost answer) has already had the lists read again above, so the
    // person can check.
    setPhase({ kind: "message", text });
    announcer.announce(text, "assertive");
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (inflight.current) return;
    const problem = checkDeviceName(value);
    if (problem) {
      const text = NAME_PROBLEM[problem];
      setPhase({ kind: "invalid", text });
      announcer.announce(text, "assertive");
      field.current?.focus();
      return;
    }
    void send(value);
  };

  const busy = phase.kind === "busy";
  const gone = phase.kind === "message" && phase.gone === true;
  const blocked = busy
    ? "Saving…"
    : !online
      ? NAME_OFFLINE_REASON
      : gone
        ? NAME_GONE
        : null;
  const title = display.named
    ? renameTitle(isolate(display.title))
    : device.current
      ? NAME_THIS_DEVICE_TITLE
      : NAME_A_DEVICE_TITLE;

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={onClose}>
            {gone ? DONE : CANCEL}
          </Button>
          {display.named && !gone ? (
            blocked ? (
              <Button disabled reason={blocked}>
                {REMOVE_NAME}
              </Button>
            ) : (
              <Button onClick={() => void send(null)}>{REMOVE_NAME}</Button>
            )
          ) : null}
          {gone ? null : blocked ? (
            <Button variant="primary" disabled reason={blocked}>
              {SAVE_NAME}
            </Button>
          ) : (
            <Button variant="primary" type="submit" form={formId}>
              {SAVE_NAME}
            </Button>
          )}
        </div>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={save}
        className="flex flex-col gap-3 text-[14px] leading-[1.6] text-ink-1"
      >
        {!display.named && !display.fallback ? (
          <p className="text-ink-2 [overflow-wrap:anywhere]">{display.title}</p>
        ) : display.named && display.label ? (
          <p className="text-ink-2 [overflow-wrap:anywhere]">{display.label}</p>
        ) : null}
        <Input
          ref={field}
          label={NAME_LABEL}
          surface="panel"
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={phase.kind === "invalid" ? true : undefined}
          aria-describedby={
            phase.kind === "invalid"
              ? `${problemId} ${describedId}`
              : describedId
          }
          onChange={(event) => {
            revision.current += 1;
            setValue(event.target.value);
            if (phase.kind === "invalid") setPhase({ kind: "idle" });
          }}
        />
        <p id={describedId} className="text-[12.5px] text-ink-2">
          {NAME_DESCRIPTION}
        </p>
        {phase.kind === "invalid" ? (
          <p id={problemId} data-name-problem="" className="text-[12.5px]">
            {phase.text}
          </p>
        ) : null}
        {phase.kind === "message" ? (
          <p
            data-refusal={phase.kept ? undefined : ""}
            data-name-kept={phase.kept ? "" : undefined}
            className="text-ink-2"
          >
            {phase.text}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
