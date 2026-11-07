import { useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { type EnqueueOutcome, useOptionalDataEnv } from "../../data";
import { useRecoverableEditor } from "../../lib/form-recovery/editor";
import { RecoveryNotice } from "../../lib/form-recovery/RecoveryNotice";
import {
  ADD_HELP,
  ADD_TITLE,
  ADDED,
  ADDED_OFFLINE,
  CANCEL,
  CREATE_SOURCE,
  LABEL,
  NEEDS_DATABASE,
  NOT_SAVED,
  NOT_SAVED_CHANGED,
  NOT_SAVED_FENCED,
  NOT_SAVED_QUOTA,
  NOT_SAVED_STORAGE,
  TIMEZONE,
} from "./copy";
import { Field, FormMessage, TimezoneSuggestions } from "./fields";
import { createSourceRequest } from "./model/commands";
import { createSubmission } from "./model/submission";
import { defaultTimezone, labelError, timezoneError } from "./model/validation";

/** The words for a save the outbox refused: it was NOT stored, and the form stays open with what was typed. */
export function refusalMessage(
  outcome: Extract<EnqueueOutcome, { kind: "refused" }>["reason"] | string,
): string {
  switch (outcome) {
    case "quota":
      return NOT_SAVED_QUOTA;
    case "storage":
      return NOT_SAVED_STORAGE;
    case "fenced":
    case "closing":
      return NOT_SAVED_FENCED;
    case "changed":
      return NOT_SAVED_CHANGED;
    default:
      return NOT_SAVED;
  }
}

/**
 * "Add source" (credential-free, queued; WEB-13a). The label and the timezone are all it asks: nothing sensitive, so the change goes
 * through the outbox, offline or online, and appears as pending until the server has it. A save that is refused locally keeps the
 * form open; a retry of the SAME values reuses the same save identity and the same source id, so a save whose completion was lost is
 * recognised and not made twice.
 */
/** Revision 37 (WEB-14a R40): the add form's input, recoverable around an app-update reload (Q4). Nothing in it is a secret. */
export const ADD_CONTEXT = "calendar-add";
type AddInput = { label: string; timezone: string };
const encodeAdd = (input: AddInput) =>
  JSON.stringify({ v: 1, label: input.label, timezone: input.timezone });
function decodeAdd(text: string): AddInput | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    return raw !== null &&
      typeof raw === "object" &&
      raw.v === 1 &&
      typeof raw.label === "string" &&
      typeof raw.timezone === "string"
      ? { label: raw.label, timezone: raw.timezone }
      : null;
  } catch {
    return null;
  }
}

export function AddSourceDialog({
  online,
  identity,
  onClose,
}: {
  online: boolean;
  /** The displayed identity the form's recovery belongs to (revision 37, R40). */
  identity: string;
  onClose(): void;
}) {
  const env = useOptionalDataEnv();
  const announcer = useAnnouncer();
  const formId = useId();
  const zonesId = useId();
  const [label, setLabel] = useState("");
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [errors, setErrors] = useState<{
    label: string | null;
    timezone: string | null;
  }>({ label: null, timezone: null });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Revision 37 (R40): every change reaches the form's recoverable model first (refused while an update reload is prepared).
  const touched = useRef(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const recovery = useRecoverableEditor<AddInput>({
    identity,
    context: ADD_CONTEXT,
    encode: encodeAdd,
    decode: decodeAdd,
    start: () => ({ label: "", timezone: defaultTimezone() }),
    untouched: () => !touched.current,
    restored: (input) => {
      setLabel(input.label);
      setTimezone(input.timezone);
    },
    // "Discard instead" (revision 38, R40-A): at the gesture, never when the copies' removal completes.
    reset: (input) => {
      touched.current = false;
      setLabel(input.label);
      setTimezone(input.timezone);
    },
  });
  const change = (next: AddInput) => {
    if (!recovery.edit(next)) return;
    touched.current = true;
    setLabel(next.label);
    setTimezone(next.timezone);
  };
  const submission = useRef(
    createSubmission<{ label: string; timezone: string }>(() =>
      crypto.randomUUID(),
    ),
  );
  const sourceIds = useRef(new Map<string, string>());
  // A synchronous latch (revision 2): a second press before the screen shows the first as busy saves nothing more.
  const saving = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async () => {
    if (saving.current) return;
    const next = {
      label: labelError(label),
      timezone: timezoneError(timezone),
    };
    setErrors(next);
    if (next.label !== null || next.timezone !== null) return;
    const outbox = env?.outbox() ?? null;
    if (outbox === null) {
      setMessage(NEEDS_DATABASE);
      return;
    }
    // Its ticket first (R40): none while an update reload is prepared, so nothing is saved after the last recovery copy.
    const ticket = recovery.submitting();
    if (ticket === null) return;
    const pair = submission.current.attempt({
      label: label.trim(),
      timezone: timezone.trim(),
    });
    let id = sourceIds.current.get(pair.key);
    if (id === undefined) {
      id = crypto.randomUUID();
      sourceIds.current.set(pair.key, id);
    }
    setBusy(true);
    setMessage(null);
    saving.current = true;
    try {
      const outcome = await outbox.enqueue(
        createSourceRequest({ id, ...pair.body, localId: pair.key }),
      );
      if (outcome.kind === "queued") void ticket.succeeded();
      else ticket.failed();
      if (outcome.kind === "queued") {
        announcer.announce(online ? ADDED : ADDED_OFFLINE);
        // A save that finished after the form closed closes nothing: another dialog may be open by then.
        if (mounted.current) onClose();
        return;
      }
      setMessage(refusalMessage(outcome.reason));
    } catch {
      // A request the facade refused as built wrongly, or a failure it did not classify: nothing was stored.
      ticket.failed();
      setMessage(NOT_SAVED);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={ADD_TITLE}
      footer={
        <>
          {busy ? (
            <Button variant="default" disabled reason="Saving…">
              {CREATE_SOURCE}
            </Button>
          ) : (
            <Button variant="default" type="submit" form={formId}>
              {CREATE_SOURCE}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {CANCEL}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <RecoveryNotice recovery={recovery} firstFieldRef={labelRef} />
        <Field
          ref={labelRef}
          label={LABEL}
          name="label"
          value={label}
          error={errors.label}
          onChange={(event) => change({ label: event.target.value, timezone })}
        />
        <Field
          label={TIMEZONE}
          name="timezone"
          value={timezone}
          list={zonesId}
          autoComplete="off"
          error={errors.timezone}
          onChange={(event) => change({ label, timezone: event.target.value })}
        />
        <TimezoneSuggestions id={zonesId} />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {ADD_HELP}
        </p>
        <FormMessage message={message} />
      </form>
    </Dialog>
  );
}
