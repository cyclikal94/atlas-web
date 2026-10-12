import { useNavigate } from "@tanstack/react-router";
import { useId, useReducer, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { useSharingDefaults } from "../../../data";
import * as copy from "../copy";
import { usePeopleEnv } from "../env";
import { useMemoryRevision } from "../memory";
import { personDefaultsLabel } from "../model/audience";
import { createPersonRequest } from "../model/commands";
import {
  applicablePerson,
  type NewPersonState,
  NOTE_LABEL,
  newPersonForm,
  type PersonSharing,
  reduceNewPerson,
} from "../model/person-form";
import { Choices, FieldError, useOutboxSave } from "../parts";

/**
 * "New person" (§4.2). Name, who can see the person ("Use my defaults — {resolved}" / "Only you") and an optional first note. Saved as ONE
 * queued `/commands` batch, `create_person` then `create_field` (SHARE-10), offline-capable. A hidden note keeps its text and is not sent
 * (PRODUCT-DECISIONS item 2). The in-dialog sync control keeps the draft for this identity; Cancel, Escape and the close icon discard it.
 */
const RETAINED = "new-person";

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
  const retained = env.memory.drafts.get(RETAINED) as
    | NewPersonState
    | undefined;
  const [state, dispatch] = useReducer(
    reduceNewPerson,
    retained ?? newPersonForm(),
  );
  const restored = useRef(retained !== undefined);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const nameError = useId();
  const noteError = useId();
  const noteId = useId();

  const resolved = personDefaultsLabel(defaults.record);
  const defaultsUnknown =
    state.sharing === "defaults" && defaults.status === "loading";

  const submit = async () => {
    if (saving) return;
    const result = applicablePerson(state);
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
    setProblems({});
    setRefusal(null);
    setSaving(true);
    const ticket = state.revision;
    const personId = env.newId();
    const request = createPersonRequest({
      personId,
      name: result.name,
      sharing: result.sharing,
      note:
        result.note === null
          ? null
          : { fieldId: env.newId(), label: NOTE_LABEL, text: result.note },
      record: defaults.record,
    });
    const outcome = await save((outbox) => outbox.enqueue(request));
    setSaving(false);
    if (!outcome.ok) {
      // Everything typed stays (a refused save is not saved).
      if (outcome.message !== null) setRefusal(outcome.message);
      return;
    }
    const reviewing = result.sharing === "defaults" && defaults.record === null;
    announcer.announce(
      reviewing ? copy.SAVED_REVIEW : copy.SAVED_NOT_SENT,
      "polite",
    );
    env.memory.drafts.delete(RETAINED);
    // The inputs are locked while saving, so the saved state is the one on screen (its ticket is current): nothing later is consumed.
    if (stateRef.current.revision !== ticket) return;
    onClose();
    void navigate({ to: "/people/$personId", params: { personId } });
  };

  const disabledReason = !env.writable
    ? copy.READ_ONLY_COMPAT
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
      onDiscard={() => env.memory.drafts.delete(RETAINED)}
      onRetainDraft={() => env.memory.drafts.set(RETAINED, stateRef.current)}
      initialFocusSelector="input"
      footer={
        <>
          <Button
            variant="quiet"
            onClick={() => {
              env.memory.drafts.delete(RETAINED);
              onClose();
            }}
          >
            {copy.CANCEL}
          </Button>
          <span className="ml-auto">
            {disabledReason === null ? (
              <Button
                variant="primary"
                data-people-action="save-person"
                onClick={() => void submit()}
              >
                {copy.SAVE}
              </Button>
            ) : (
              <Button variant="primary" disabled reason={disabledReason}>
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
          {restored.current ? (
            <p className="text-[12.5px] text-ink-2">{copy.RESTORED_DRAFT}</p>
          ) : null}
          {refusal ? (
            <p
              data-people-refusal=""
              className="text-[13px] text-conflict-text"
            >
              {refusal}
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Input
              label={copy.NAME}
              value={state.name}
              maxLength={600}
              aria-invalid={problems.name ? true : undefined}
              aria-describedby={problems.name ? nameError : undefined}
              onChange={(event) =>
                dispatch({ type: "name", value: event.target.value })
              }
              surface="panel"
            />
            <FieldError id={nameError} message={problems.name} />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[13px] font-medium text-ink-1">
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
                className="text-[13px] font-medium text-ink-1"
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
                className="atlas-transition min-h-24 w-full rounded-control border border-field-edge bg-panel px-3 py-2.5 text-[14px] text-ink-1"
              />
              <FieldError id={noteError} message={problems.note} />
              <Button
                variant="quiet"
                onClick={() => dispatch({ type: "note_open", value: false })}
              >
                {copy.HIDE_NOTE}
              </Button>
            </div>
          ) : (
            <Button
              variant="quiet"
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
