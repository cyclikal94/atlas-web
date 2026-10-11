import { type FormEvent, useEffect, useId, useRef, useState } from "react";
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
  NAME_SAVED,
  NAME_THIS_DEVICE_TITLE,
  NAME_UNCONFIRMED,
  REMOVE_NAME,
  renameTitle,
  SAVE_NAME,
} from "./label-copy";
import { checkDeviceName, deviceDisplay, isolate } from "./labels";
import { untilSent } from "./until-sent";

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  /** The typed value breaks the name rules: nothing was sent. */
  | { kind: "invalid"; text: string }
  /** A definite answer that changed nothing, or one whose effect is unknown; the list was read again where that helps. */
  | { kind: "message"; text: string; gone?: boolean };

/**
 * D-8d-09/10: naming a listed device (BE-Q25 `PUT`/`DELETE /devices/{id}/name`). The typed text is sent exactly as typed: it is
 * checked against the server's own `DeviceName` rules first and never trimmed or normalised. A name is display metadata only; it
 * is not part of the device's state token, so naming never stales a retirement confirmation. A result that arrives after the dialog
 * has gone, or after the identity moved on (`closed`), or with the session ended (`auth_state`), changes and says nothing.
 */
export function NameDeviceDialog({
  device,
  onChanged,
  onClose,
}: {
  device: DeviceRow;
  /** Called when the list should be read again (a change was made, or its outcome is unknown). */
  onChanged(): void;
  onClose(): void;
}) {
  const session = useSession();
  const announcer = useAnnouncer();
  const online = useOnline();
  const display = deviceDisplay(device);
  const [value, setValue] = useState(display.named ? display.title : "");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inflight = useRef(false);
  const live = useRef(true);
  const field = useRef<HTMLInputElement>(null);
  const formId = useId();
  const problemId = useId();
  const describedId = useId();
  useEffect(() => {
    // Set on every mount, not only at creation: StrictMode mounts, unmounts and mounts again.
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const send = async (name: string | null) => {
    if (inflight.current || !isOnlineNow()) return;
    inflight.current = true;
    setPhase({ kind: "busy" });
    const result: Result<"named" | "cleared" | "gone"> | null = await untilSent(
      () => session.operations.nameDevice(device.id, name),
      { isCurrent: () => live.current },
    ).catch(() => null);
    inflight.current = false;
    // Unmounted (the tree moved on, or the person closed it): the answer is nobody's.
    if (!live.current) return;
    if (result?.ok) {
      if (result.value === "gone") {
        setPhase({ kind: "message", text: NAME_GONE, gone: true });
        announcer.announce(NAME_GONE, "assertive");
        onChanged();
        return;
      }
      announcer.announce(result.value === "named" ? NAME_SAVED : NAME_REMOVED);
      onChanged();
      onClose();
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
    setPhase({ kind: "message", text });
    announcer.announce(text, "assertive");
    // An outcome nobody can confirm (offline after sending, a 5xx, a lost answer): the list is read again so the person can check.
    if (text === NAME_UNCONFIRMED) onChanged();
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
          <p data-refusal="" className="text-ink-2">
            {phase.text}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
