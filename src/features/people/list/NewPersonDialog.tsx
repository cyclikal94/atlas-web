import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { useSharingDefaults } from "../../../data";
import { UNAVAILABLE_WHILE_RELOADING } from "../../../lib/form-recovery/RecoveryBanner";
import { RecoveryNotice } from "../../../lib/form-recovery/RecoveryNotice";
import * as copy from "../copy";
import { usePeopleEnv } from "../env";
import { completeTicket, usePeopleRecovery } from "../form-recovery";
import {
  admit,
  completeSession,
  isPending,
  preparedFor,
  reportSession,
  retireSession,
  sessionOf,
  settle,
  useEditingSession,
} from "../lifetime";
import { type PeopleMemory, useMemoryRevision } from "../memory";
import { personDefaultsLabel } from "../model/audience";
import { createPersonRequest } from "../model/commands";
import {
  applicablePerson,
  type NewPersonAction,
  type NewPersonState,
  NOTE_LABEL,
  newPersonForm,
  type PersonSharing,
  reduceNewPerson,
} from "../model/person-form";
import { personCodec } from "../model/recovery";
import { Choices, FieldError, useOutboxSave } from "../parts";

/**
 * "New person" (§4.2). Name, who can see the person ("Use my defaults — {resolved}" / "Only you") and an optional first note. Saved as ONE
 * queued `/commands` batch, `create_person` then `create_field` (SHARE-10), offline-capable. A hidden note keeps its text and is not sent
 * (PRODUCT-DECISIONS item 2). What is typed is kept for this identity as it is typed, with its editing session, so the sync control or a
 * remount (a 403, or the list moving at the tablet width) keeps the latest input and the same session (review 19, finding 1); Cancel,
 * Escape and the close icon discard it.
 * A save ends only the editing session it was made in (`lifetime.ts`, review 6, finding 1): a form opened after Cancel is another one.
 * And a session saves once at a time (review 7, finding 1): a form reopened while its save runs shows it saving, and admits no second
 * create; a retry of the same input is the same request (the same person, note and local ids), so a save that was written but whose
 * answer was lost is recognised, never made twice.
 */
export const RETAINED = "new-person";

interface RetainedPerson {
  session: string;
  form: NewPersonState;
}

/**
 * WEB-14a (F-INT-PEOPLE-Q4): page memory keeps input of the new person's form (edited, or a save of it running). Its recoverable model
 * (`form-recovery.ts`, `people-new:dialog`) takes nothing left by an update into it then: the copy is offered instead.
 */
export function holdsNewPerson(memory: PeopleMemory): boolean {
  const kept = memory.drafts.get(RETAINED) as RetainedPerson | undefined;
  if (kept === undefined) return false;
  return kept.form.revision > 0 || isPending(memory, kept.session);
}

/** A copy the page before an update left, kept as a new editing session for the form to open on (never submitted). */
export function parkNewPerson(
  memory: PeopleMemory,
  form: NewPersonState,
  newId: () => string,
): string {
  const session = newId();
  memory.drafts.set(RETAINED, {
    session,
    form: { ...form, revision: 1 },
  } satisfies RetainedPerson);
  return session;
}

export function NewPersonDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
}) {
  if (!open) return null;
  return <NewPersonForm onClose={onClose} />;
}

function NewPersonForm({ onClose }: { onClose(): void }) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const defaults = useSharingDefaults();
  const announcer = useAnnouncer();
  const navigate = useNavigate();
  const save = useOutboxSave();
  const [retained] = useState(
    () => env.memory.drafts.get(RETAINED) as RetainedPerson | undefined,
  );
  const [session] = useState(() => sessionOf(retained) ?? env.newId());
  const [state, setState] = useState<NewPersonState>(
    () => retained?.form ?? newPersonForm(),
  );
  const restored = useRef(retained !== undefined);
  const saving = isPending(env.memory, session);
  // WEB-14a (F-INT-PEOPLE-Q4): the input as last given (the model has it in the same step).
  const input = useRef(state);
  const take = (next: NewPersonState) => {
    input.current = next;
    setState(next);
  };
  const recovery = usePeopleRecovery<NewPersonState>({
    memory: env.memory,
    key: RETAINED,
    session,
    codec: personCodec,
    start: newPersonForm,
    value: () => input.current,
    holds: () => holdsNewPerson(env.memory),
    untouched: () =>
      input.current.revision === 0 && !isPending(env.memory, session),
    busy: () => isPending(env.memory, session),
    // A copy restored, or "Discard instead": the session's input from now on (kept in page memory by the effect below).
    restored: (form) => take({ ...form, revision: input.current.revision + 1 }),
    reset: (form) => take({ ...form, revision: input.current.revision + 1 }),
  });
  /** The person's change: given to the recoverable model first, and not taken while an update reload is being prepared. */
  const dispatch = (action: NewPersonAction) => {
    const next = reduceNewPerson(input.current, action);
    if (!recovery.edit(next)) return;
    take(next);
  };
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const stateRef = useRef(state);
  // The form's first field: focused when B restores the form and after "Discard instead" (WEB-14a revision 51, F-R51-1).
  const nameRef = useRef<HTMLInputElement>(null);
  stateRef.current = state;
  const nameError = useId();
  const noteError = useId();
  const noteId = useId();
  /** This session ends (never a later session's kept input). */
  const forget = () => retireSession(env.memory, RETAINED, session);
  // The person saved by this session is shown when the save completes, through whichever mount shows the session now.
  const owns = useEditingSession<{ refusal: string }>(env.memory, session, {
    revision: () => stateRef.current.revision,
    close: (personId) => {
      onClose();
      if (personId !== null)
        void navigate({ to: "/people/$personId", params: { personId } });
    },
    keep: () => setRefusal(copy.LATER_EDITS_KEPT),
    report: (update) => setRefusal(update.refusal),
  });

  // The latest input is kept as it changes, not only by the sync control: a remount restores the same session with what was typed last
  // (review 19, finding 1), so its running save, prepared request and completion stay attached to it. Only the session's form keeps it:
  // once the session ended (Cancel, Escape, the close icon) this form no longer owns it and keeps nothing again (review 8, finding 1), and
  // an older form never overwrites a later session's. An untouched new form keeps nothing.
  useEffect(() => {
    if (!owns()) return;
    if (state.revision === 0 && !restored.current) return;
    env.memory.drafts.set(RETAINED, {
      session,
      form: state,
    } satisfies RetainedPerson);
  }, [env, session, state, owns]);

  const resolved = personDefaultsLabel(defaults.record);
  const defaultsUnknown =
    state.sharing === "defaults" && defaults.status === "loading";

  const submit = async () => {
    if (!owns()) return;
    // The input as the recoverable model has it (what its ticket below records), read in the same step.
    const now = input.current;
    const result = applicablePerson(now);
    if (!result.ok) {
      setProblems(
        Object.fromEntries(
          Object.entries(result.problems).map(([key, problem]) => [
            key,
            copy.PROBLEM[problem] ?? "",
          ]),
        ),
      );
      return;
    }
    const memory = env.memory;
    // Admitted once per session, before anything is awaited: a remounted or reopened form of the same session admits nothing more.
    const admission = admit(memory, [session], env.newId);
    if (admission === null) return;
    // WEB-14a (F-INT-PEOPLE-Q4): the recoverable model's ticket, in the same step (none while an update reload is prepared: nothing is
    // sent then). Only a durable success (queued) covers what it sent; anything else keeps the input for the update to save.
    const kept = recovery.submitting();
    if (kept === null) {
      settle(admission);
      return;
    }
    let durable = false;
    try {
      durable = await send(memory, admission, result, now.revision);
    } finally {
      completeTicket(kept, durable);
    }
  };

  /** One admitted save of the session; true when it was queued. */
  const send = async (
    memory: PeopleMemory,
    admission: NonNullable<ReturnType<typeof admit>>,
    result: Extract<ReturnType<typeof applicablePerson>, { ok: true }>,
    ticket: number,
  ): Promise<boolean> => {
    setProblems({});
    setRefusal(null);
    const record = defaults.record;
    const { personId, request } = preparedFor(
      memory,
      session,
      JSON.stringify([result.name, result.sharing, result.note, record]),
      () => {
        const id = env.newId();
        return {
          personId: id,
          request: {
            ...createPersonRequest({
              personId: id,
              name: result.name,
              sharing: result.sharing,
              note:
                result.note === null
                  ? null
                  : {
                      fieldId: env.newId(),
                      label: NOTE_LABEL,
                      text: result.note,
                    },
              record,
            }),
            localId: env.newId(),
          },
        };
      },
    );
    let outcome: Awaited<ReturnType<typeof save>>;
    try {
      outcome = await save((outbox) => outbox.enqueue(request));
    } finally {
      settle(admission);
    }
    if (!outcome.ok) {
      // Everything typed stays (a refused save is not saved), told to the form showing this session now.
      if (outcome.message !== null)
        reportSession(memory, RETAINED, session, { refusal: outcome.message });
      return false;
    }
    const reviewing = result.sharing === "defaults" && record === null;
    announcer.announce(
      reviewing ? copy.SAVED_REVIEW : copy.SAVED_NOT_SENT,
      "polite",
    );
    // Only this session ends: its kept input is forgotten and the form showing it (if any) closes onto the saved person. A form opened
    // after Cancel is another session's and stays as typed (review 6, finding 1); input typed after the ticket stays too.
    completeSession(
      memory,
      RETAINED,
      session,
      ticket,
      (kept) => (kept as RetainedPerson).form.revision,
      personId,
    );
    return true;
  };

  const disabledReason = !env.writable
    ? copy.READ_ONLY_COMPAT
    : recovery.locked
      ? UNAVAILABLE_WHILE_RELOADING
      : defaultsUnknown
        ? copy.DEFAULTS_LOADING_REASON
        : saving
          ? copy.SAVING
          : null;

  return (
    <Dialog
      open
      title={copy.NEW_PERSON_TITLE}
      onClose={onClose}
      onDiscard={forget}
      onRetainDraft={() => {
        // Only the session's form now keeps input for it (an older form's handler never overwrites a later session's).
        if (owns())
          env.memory.drafts.set(RETAINED, {
            session,
            form: stateRef.current,
          } satisfies RetainedPerson);
      }}
      initialFocusSelector="input"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              forget();
              onClose();
            }}
          >
            {copy.CANCEL}
          </Button>
          <span className="ml-auto">
            {disabledReason === null ? (
              <Button
                variant="default"
                data-people-action="save-person"
                onClick={() => void submit()}
              >
                {copy.SAVE}
              </Button>
            ) : (
              <Button variant="default" disabled reason={disabledReason}>
                {copy.SAVE}
              </Button>
            )}
          </span>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabledReason === null) void submit();
        }}
      >
        <fieldset disabled={saving} className="flex flex-col gap-4">
          <RecoveryNotice recovery={recovery} firstFieldRef={nameRef} />
          {restored.current && recovery.view.restored === null ? (
            <p className="text-xs text-muted-foreground">
              {copy.RESTORED_DRAFT}
            </p>
          ) : null}
          {refusal ? (
            <p data-people-refusal="" className="text-sm text-destructive">
              {refusal}
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Input
              ref={nameRef}
              label={copy.NAME}
              value={state.name}
              maxLength={600}
              aria-invalid={problems.name ? true : undefined}
              aria-describedby={problems.name ? nameError : undefined}
              onChange={(event) =>
                dispatch({ type: "name", value: event.target.value })
              }
            />
            <FieldError id={nameError} message={problems.name} />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium text-foreground">
              {copy.PERSON_SHARING}
            </legend>
            <Choices<PersonSharing>
              label={copy.PERSON_SHARING}
              value={state.sharing}
              onChange={(value) => dispatch({ type: "sharing", value })}
              choices={[
                { value: "defaults", label: copy.USE_DEFAULTS(resolved) },
                { value: "only_you", label: copy.ONLY_YOU },
              ]}
            />
          </fieldset>
          {state.noteOpen ? (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor={noteId}
                className="text-sm font-medium text-foreground"
              >
                {copy.FIRST_NOTE}
              </label>
              <textarea
                id={noteId}
                value={state.note}
                rows={4}
                aria-invalid={problems.note ? true : undefined}
                aria-describedby={problems.note ? noteError : undefined}
                onChange={(event) =>
                  dispatch({ type: "note", value: event.target.value })
                }
                className="atlas-transition min-h-24 w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm text-foreground"
              />
              <FieldError id={noteError} message={problems.note} />
              <Button
                variant="ghost"
                onClick={() => dispatch({ type: "note_open", value: false })}
              >
                {copy.HIDE_NOTE}
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              data-people-action="add-note"
              onClick={() => dispatch({ type: "note_open", value: true })}
            >
              {copy.ADD_FIRST_NOTE}
            </Button>
          )}
        </fieldset>
      </form>
    </Dialog>
  );
}
