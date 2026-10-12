import { useEffect, useId, useReducer, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import {
  type CacheRow,
  type DraftWithCommand,
  useCachedResource,
  useConflictInbox,
  useDataActions,
  useSharingDefaults,
} from "../../../data";
import { applyPolicyChange, ResourcePolicyEditor } from "../../sharing";
import * as copy from "../copy";
import { type PeopleEnv, usePeopleEnv } from "../env";
import { isCurrentMemory, useMemoryRevision } from "../memory";
import {
  type AudienceClass,
  audienceLabel,
  classify,
  fieldDefaultsLabel,
  primaryHousehold,
  quickPolicy,
  subjectNote,
} from "../model/audience";
import {
  archiveRequest,
  editCreateRequest,
  putFieldCreateRequest,
  putFieldSharedBody,
  putFieldUpdateRequest,
} from "../model/commands";
import {
  applicable,
  type ExistingAudience,
  type FieldFormState,
  type FieldInputProblem,
  fromField,
  type NewAudience,
  newFieldForm,
  type ProblemSlot,
  reduceFieldForm,
} from "../model/field-form";
import { changesOfAll, foldRows, type ShownRow } from "../model/project";
import {
  FIELD_KINDS,
  type FieldKind,
  formatValue,
  parseFieldValue,
} from "../model/values";
import { sendOnline } from "../online";
import { Banner, Choices, FieldError, useOutboxSave } from "../parts";
import { OutstandingChain, usePersonLinkage } from "../reads";
import { ValueInput } from "./ValueInput";

/**
 * WF-PEOPLE-03, the field editor (§4.4): a ROUTE-ADDRESSED dialog (`/people/$personId/fields/new` and `/fields/$fieldId`), a full-bleed sheet
 * below 768 px. Its draft lives in the identity's page memory while it is open, so a remount of the protected tree (a `403` anywhere,
 * D-12a-13) reopens the same route with the draft intact; Cancel, Escape and the close icon discard it, the in-dialog sync control keeps it.
 *
 *  - Create: "Use my defaults" / "Only you" queue a `put_field` (offline-capable); "Home · can view" is one online attempt to
 *    `/task-access-commands`, disabled offline. "Choose people…" is offered after saving (the field row's "Who can see it").
 *  - Update: `put_field` with `expected_version` and `expected_policy_version` (Q1). An audience change is the policy's (online:
 *    `applyPolicyChange`, then the content with the CONFIRMED policy version); offline the person chooses between "Save now" (under the
 *    current audience) and "Hold as draft" (D-11a-12).
 *  - A version conflict of this field's draft shows the current value beside the person's, with "Save mine on the current version" (a
 *    supersession on the current bases, the person's explicit act) and "Discard mine".
 */
export function FieldEditorDialog({
  personId,
  fieldId,
  onClose,
}: {
  personId: string;
  fieldId: string | null;
  onClose(): void;
}) {
  const env = usePeopleEnv();
  const person = useCachedResource(personId);
  const field = useCachedResource(fieldId ?? "");
  return (
    <OutstandingChain>
      {(outstanding) => {
        if (
          person.status === "loading" ||
          (fieldId !== null && field.status === "loading") ||
          outstanding.status === "loading"
        )
          return null;
        const changes = changesOfAll(outstanding.rows);
        const personRow = foldRows(
          person.status === "ready" && person.value.merged?.kind === "person"
            ? [person.value.merged]
            : [],
          changes,
          "person",
        ).find((row) => row.row.id === personId);
        if (personRow === undefined) return null;
        const fieldRow =
          fieldId === null
            ? null
            : (foldRows(
                field.status === "ready" &&
                  field.value.merged?.kind === "field" &&
                  field.value.merged.parent_id === personId
                  ? [field.value.merged]
                  : [],
                changes,
                "field",
                personId,
              ).find((row) => row.row.id === fieldId) ?? null);
        // PPL-5 and a field that is gone: nothing to edit.
        if (fieldId !== null && fieldRow === null) return null;
        return (
          <Editor
            key={`${env.identity}\u0000${personId}\u0000${fieldId ?? "new"}`}
            env={env}
            person={personRow}
            field={fieldRow}
            drafts={outstanding.rows}
            onClose={onClose}
          />
        );
      }}
    </OutstandingChain>
  );
}

interface Retained {
  form: FieldFormState;
  /** The id a new field is created under: one per editing session, so a retried shared create is the same field. */
  newFieldId: string;
  /** The audience choice was changed by the person (an existing field's choice otherwise follows its policy). */
  touched: boolean;
}

type Outcome =
  | null
  | { kind: "message"; text: string; requestId?: string }
  | { kind: "offline_choice" };

function Editor({
  env,
  person,
  field,
  drafts,
  onClose,
}: {
  env: PeopleEnv;
  person: ShownRow;
  field: ShownRow | null;
  drafts: readonly DraftWithCommand[];
  onClose(): void;
}) {
  useMemoryRevision(env.memory);
  const announcer = useAnnouncer();
  const save = useOutboxSave();
  const defaults = useSharingDefaults();
  const actions = useDataActions();
  const conflicts = useConflictInbox();
  const { linkage } = usePersonLinkage(person.row.id);
  const draftKey = `field:${person.row.id}:${field?.row.id ?? "new"}`;
  const existing = field?.row ?? null;
  const parsed = existing === null ? null : parseFieldValue(existing.value);
  const [initial] = useState<{ retained: Retained; restored: boolean }>(() => {
    const kept = env.memory.drafts.get(draftKey) as Retained | undefined;
    if (kept !== undefined) return { retained: kept, restored: true };
    const form =
      existing !== null && parsed !== null
        ? fromField({ label: existing.label, value: parsed }, env.newId)
        : existing !== null
          ? { ...newFieldForm(), name: existing.label }
          : newFieldForm();
    return {
      retained: { form, newFieldId: env.newId(), touched: false },
      restored: false,
    };
  });
  const [state, dispatch] = useReducer(reduceFieldForm, initial.retained.form);
  const [touched, setTouched] = useState(initial.retained.touched);
  const [problems, setProblems] = useState<
    Partial<Record<ProblemSlot, FieldInputProblem>>
  >({});
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [offlineChoice, setOfflineChoice] = useState<"save_now" | "hold">(
    "hold",
  );
  const [policyEditor, setPolicyEditor] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const nameError = useId();
  const typeId = useId();

  // The draft is kept for this identity while the editor is open (a remount reopens it); dismissing the editor forgets it.
  useEffect(() => {
    env.memory.drafts.set(draftKey, {
      form: state,
      newFieldId: initial.retained.newFieldId,
      touched,
    } satisfies Retained);
  }, [env, draftKey, state, touched, initial.retained.newFieldId]);
  const forget = () => env.memory.drafts.delete(draftKey);
  const close = () => {
    forget();
    onClose();
  };

  // ---- the existing field's audience (owner-only read, while open, online and editable) ----------------------------------------
  const isNew = existing === null;
  const projected = field?.projected ?? false;
  const canEdit = existing === null ? true : existing.can_edit;
  const known =
    existing === null ? undefined : env.memory.policies.get(existing.id);
  const policyLoad: "idle" | "loading" | "forbidden" | "failed" =
    existing === null
      ? "idle"
      : env.memory.policyReads.has(existing.id)
        ? "loading"
        : (env.memory.policyRefusals.get(existing.id) ?? "idle");
  useEffect(() => {
    if (existing === null || projected || !canEdit || !env.online) return;
    const memory = env.memory;
    if (
      memory.policies.has(existing.id) ||
      memory.policyReads.has(existing.id) ||
      memory.policyRefusals.get(existing.id) === "forbidden"
    )
      return;
    memory.policyReads.add(existing.id);
    memory.policyRefusals.delete(existing.id);
    memory.touch();
    void env.sharing.readPolicy(existing.id).then((result) => {
      if (!isCurrentMemory(memory)) return;
      memory.policyReads.delete(existing.id);
      if (result.ok) memory.policies.set(existing.id, result.value);
      else
        memory.policyRefusals.set(
          existing.id,
          result.kind === "forbidden" ? "forbidden" : "failed",
        );
      memory.touch();
    });
  }, [env, existing, projected, canEdit]);

  const home = primaryHousehold(defaults.record);
  const homeName = home?.household?.name ?? "Home";
  const current: AudienceClass | null =
    known === undefined ? null : classify(known.policy, home?.id ?? null);
  const currentChoice: ExistingAudience | null =
    current === null
      ? null
      : current.kind === "only_you"
        ? "only_you"
        : current.kind === "home_view"
          ? "home"
          : "custom";
  const audience = isNew
    ? (state.audience as NewAudience)
    : touched
      ? (state.audience as ExistingAudience)
      : currentChoice;
  const audienceChanged =
    !isNew && touched && currentChoice !== null && audience !== currentChoice;
  const currentLabel =
    current === null
      ? copy.CURRENT_AUDIENCE_UNKNOWN
      : audienceLabel(current, homeName);

  // ---- a version conflict of this field's draft --------------------------------------------------------------------------------
  const conflict =
    existing === null || conflicts.status !== "ready"
      ? null
      : (conflicts.value.find(
          (row) =>
            row.kind === "version_conflict" &&
            row.draft.kind === "put_field" &&
            row.draft.target_resource_ids[0] === existing.id,
        ) ?? null);

  const readOnly = !canEdit;
  const title = isNew
    ? copy.ADD_FIELD_TITLE
    : copy.EDIT_FIELD_TITLE(existing.label);

  const fail = (text: string | null, requestId?: string) => {
    if (text !== null)
      setOutcome({
        kind: "message",
        text,
        ...(requestId ? { requestId } : {}),
      });
  };
  const succeeded = (message: string, ticket: number) => {
    announcer.announce(message, "polite");
    // A change made while saving stays, unsaved (the ticket): only a success for the current revision ends the session.
    if (stateRef.current.revision !== ticket) {
      setOutcome({ kind: "message", text: copy.LATER_EDITS_KEPT });
      return;
    }
    close();
  };

  const submit = async (choice?: "save_now" | "hold") => {
    if (saving) return;
    const ready = applicable(state);
    if (!ready.ok) {
      setProblems(ready.problems);
      return;
    }
    setProblems({});
    setOutcome(null);
    const ticket = state.revision;
    // ---- create ----
    if (isNew) {
      const fieldId = initial.retained.newFieldId;
      const choiceNew = state.audience as NewAudience;
      if (choiceNew === "home") {
        const policy = quickPolicy("home", null, home?.id ?? null);
        if (policy === null) return fail(copy.NO_PRIMARY_HOUSEHOLD);
        setSaving(true);
        const result = await sendOnline(
          env,
          `create:${fieldId}`,
          putFieldSharedBody({
            fieldId,
            personId: person.row.id,
            label: ready.label,
            value: ready.value,
            policy,
          }),
          (attempt) => env.api.putFieldShared(attempt),
        );
        setSaving(false);
        if (result.ok) return succeeded(copy.SAVED_AFTER_SYNC, ticket);
        return fail(
          result.kind === "identity_grant_required"
            ? copy.IDENTITY_GRANT
            : result.kind === "uncertain"
              ? copy.UNCERTAIN
              : result.kind === "offline" || result.kind === "not_sent"
                ? copy.SHARED_NEEDS_CONNECTION
                : result.kind === "closed"
                  ? null
                  : copy.REFUSED.storage,
          "requestId" in result ? result.requestId : undefined,
        );
      }
      setSaving(true);
      const reviewing = choiceNew === "defaults" && defaults.record === null;
      const outcome = await save((outbox) =>
        outbox.enqueue(
          putFieldCreateRequest({
            fieldId,
            personId: person.row.id,
            label: ready.label,
            value: ready.value,
            audience: choiceNew,
            record: defaults.record,
            ...(person.projected && person.createDraft !== null
              ? { dependsOn: [person.createDraft] }
              : {}),
          }),
        ),
      );
      setSaving(false);
      if (!outcome.ok) return fail(outcome.message);
      return succeeded(
        reviewing ? copy.SAVED_FIELD_REVIEW : copy.SAVED_NOT_SENT,
        ticket,
      );
    }
    // ---- an unsent create, edited in place (D-11a-15) ----
    if (projected) {
      const draft = drafts.find((d) => d.local_id === field?.createDraft);
      const request =
        draft === undefined ? null : editCreateRequest(draft, ready);
      if (draft === undefined || request === null)
        return fail(copy.WAIT_FOR_SYNC_FIELD);
      setSaving(true);
      const outcome = await save((outbox) =>
        outbox.editQueued(draft.local_id, request),
      );
      setSaving(false);
      if (!outcome.ok) return fail(outcome.message ?? null);
      return succeeded(copy.SAVED_NOT_SENT, ticket);
    }
    // ---- update ----
    const policyVersion = existing.policy_version;
    if (policyVersion === undefined) return fail(copy.WAIT_FOR_SYNC_FIELD);
    const contentChanged =
      ready.label !== existing.label ||
      JSON.stringify(ready.value) !== JSON.stringify(parsed);
    const sameKind = parsed !== null && parsed.kind === ready.value.kind;
    const queueUpdate = async (version: number) => {
      const request = putFieldUpdateRequest({
        fieldId: existing.id,
        personId: person.row.id,
        label: ready.label,
        value: ready.value,
        policyVersion: version,
        sameKind,
      });
      const latest = field?.latest ?? null;
      return save(async (outbox) => {
        if (
          latest?.kind === "put_field_update" &&
          latest.status === "queued" &&
          !latest.reviewing &&
          version === policyVersion
        ) {
          const edited = await outbox.editQueued(latest.localId, request);
          if (
            edited.kind === "edited" ||
            (edited.reason !== "not_queued" &&
              edited.reason !== "not_found" &&
              edited.reason !== "retargeted")
          )
            return edited;
        }
        return outbox.enqueue(request);
      });
    };
    if (!audienceChanged) {
      if (!contentChanged) return close();
      setSaving(true);
      const outcome = await queueUpdate(policyVersion);
      setSaving(false);
      if (!outcome.ok) return fail(outcome.message);
      return succeeded(copy.SAVED_NOT_SENT, ticket);
    }
    // The audience changes: the policy's own, online-only step.
    const target =
      audience === "custom"
        ? null
        : quickPolicy(
            audience as "only_you" | "home",
            known?.policy ?? null,
            home?.id ?? null,
          );
    if (target === null || known === undefined)
      return fail(copy.SHARING_CHANGED);
    if (!env.online) {
      if (choice === undefined) {
        setOutcome({ kind: "offline_choice" });
        return;
      }
      if (choice === "save_now") {
        if (!contentChanged) return close();
        setSaving(true);
        const outcome = await queueUpdate(policyVersion);
        setSaving(false);
        if (!outcome.ok) return fail(outcome.message);
        return succeeded(copy.SAVED_NOT_SENT, ticket);
      }
      env.memory.held.set(existing.id, {
        fieldId: existing.id,
        personId: person.row.id,
        label: ready.label,
        value: ready.value,
        sameKind,
        baseVersion: existing.version,
        from: { version: known.version, policy: known.policy },
        to: target,
        status: { kind: "waiting" },
      });
      env.memory.touch();
      return succeeded(copy.HELD_WAITING(ready.label), ticket);
    }
    setSaving(true);
    const memory = env.memory;
    const changed = await applyPolicyChange(
      { api: env.sharing, newId: env.newId },
      {
        resourceId: existing.id,
        from: { version: known.version, policy: known.policy },
        to: target,
        attempt: memory.attempts.get(`policy:${existing.id}`) ?? null,
        isCurrent: () => isCurrentMemory(memory),
      },
    );
    if (changed.attempt === null)
      memory.attempts.delete(`policy:${existing.id}`);
    else memory.attempts.set(`policy:${existing.id}`, changed.attempt);
    const result = changed.result;
    if (!result.ok) {
      setSaving(false);
      if (result.kind === "changed" || result.kind === "conflict") {
        // Re-read and re-classify; the draft stays.
        memory.policies.delete(existing.id);
        memory.touch();
        return fail(copy.SHARING_CHANGED, result.requestId);
      }
      return fail(
        result.kind === "forbidden"
          ? copy.AUDIENCE_OWNER_ONLY
          : result.kind === "uncertain"
            ? copy.UNCERTAIN
            : result.kind === "closed"
              ? null
              : copy.NEEDS_CONNECTION,
        result.requestId,
      );
    }
    memory.policies.set(existing.id, {
      version: result.policyVersion,
      policy: target,
    });
    memory.touch();
    if (contentChanged) {
      const outcome = await queueUpdate(result.policyVersion);
      setSaving(false);
      if (!outcome.ok) return fail(outcome.message);
    } else setSaving(false);
    return succeeded(copy.SAVED_NOT_SENT, ticket);
  };

  if (policyEditor && existing !== null)
    return (
      <ResourcePolicyEditor
        resourceId={existing.id}
        open
        onOpenChange={(open) => {
          if (!open) setPolicyEditor(false);
        }}
      />
    );

  const offline = outcome?.kind === "offline_choice";
  const saveReason = !env.writable
    ? copy.READ_ONLY_COMPAT
    : saving
      ? copy.SAVING
      : isNew && state.audience === "defaults" && defaults.status === "loading"
        ? copy.DEFAULTS_LOADING_REASON
        : !isNew && !projected && existing.policy_version === undefined
          ? copy.WAIT_FOR_SYNC_FIELD
          : null;

  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      onDiscard={forget}
      onRetainDraft={() => undefined}
      initialFocusSelector="input"
      footer={
        readOnly ? (
          <Button variant="quiet" onClick={close}>
            {copy.CANCEL}
          </Button>
        ) : offline ? (
          <>
            <span className="text-[12px] text-ink-2">
              {copy.ESCAPE_DISCARDS}
            </span>
            <Button variant="quiet" onClick={close}>
              {copy.CANCEL}
            </Button>
            <span className="ml-auto">
              <Button
                variant="primary"
                data-people-action="offline-confirm"
                onClick={() => void submit(offlineChoice)}
              >
                {offlineChoice === "hold" ? copy.HOLD_AS_DRAFT : copy.SAVE_NOW}
              </Button>
            </span>
          </>
        ) : (
          <>
            <Button variant="quiet" onClick={close}>
              {copy.CANCEL}
            </Button>
            {!isNew && !projected && canEdit ? (
              <ArchiveInEditor id={existing.id} onDone={close} />
            ) : null}
            <span className="ml-auto">
              {saveReason === null ? (
                <Button
                  variant="primary"
                  data-people-action="save-field"
                  onClick={() => void submit()}
                >
                  {copy.SAVE}
                </Button>
              ) : (
                <Button variant="primary" disabled reason={saveReason}>
                  {copy.SAVE}
                </Button>
              )}
            </span>
          </>
        )
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (saveReason === null && !readOnly)
            void submit(offline ? offlineChoice : undefined);
        }}
      >
        <fieldset disabled={saving} className="flex flex-col gap-4">
          {initial.restored ? (
            <p className="text-[12.5px] text-ink-2">{copy.RESTORED_DRAFT}</p>
          ) : null}
          {readOnly ? (
            <p className="text-[13px] text-ink-2">{copy.READ_ONLY_FIELD}</p>
          ) : null}
          {conflict !== null && existing !== null ? (
            <ConflictPanel
              current={existing}
              onDiscard={async () => {
                await actions.discard(conflict.draft.local_id);
              }}
              onSaveMine={async () => {
                const policyVersion = existing.policy_version;
                const ready = applicable(stateRef.current);
                if (policyVersion === undefined || !ready.ok) return;
                const outcome = await save((outbox) =>
                  outbox.supersede(
                    conflict.draft.local_id,
                    putFieldUpdateRequest({
                      fieldId: existing.id,
                      personId: person.row.id,
                      label: ready.label,
                      value: ready.value,
                      policyVersion,
                      sameKind: parsed?.kind === ready.value.kind,
                    }),
                  ),
                );
                if (outcome.ok)
                  announcer.announce(copy.SAVED_NOT_SENT, "polite");
                else fail(outcome.message);
              }}
            />
          ) : null}
          {outcome?.kind === "message" ? (
            <Banner message={outcome.text} requestId={outcome.requestId} />
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Input
              label={copy.FIELD_NAME}
              value={state.name}
              surface="panel"
              readOnly={readOnly}
              aria-invalid={problems.name ? true : undefined}
              aria-describedby={problems.name ? nameError : undefined}
              onChange={(event) =>
                dispatch({ type: "name", value: event.target.value })
              }
            />
            <FieldError
              id={nameError}
              message={problems.name ? copy.PROBLEM[problems.name] : undefined}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={typeId}
              className="text-[13px] font-medium text-ink-1"
            >
              {copy.FIELD_TYPE}
            </label>
            <select
              id={typeId}
              value={state.kind}
              disabled={readOnly}
              onChange={(event) =>
                dispatch({
                  type: "kind",
                  value: event.target.value as FieldKind,
                })
              }
              className="min-h-11 rounded-control border border-field-edge bg-panel px-3 text-[14px] text-ink-1"
            >
              {FIELD_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {copy.KIND_LABEL[kind]}
                </option>
              ))}
            </select>
          </div>
          <ValueInput
            kind={state.kind}
            slots={state.slots}
            dispatch={dispatch}
            problems={problems}
            newId={env.newId}
            readOnly={readOnly}
          />
          {readOnly ? null : (
            <AudienceSection
              env={env}
              isNew={isNew}
              projected={projected}
              audience={audience}
              current={current}
              currentChoice={currentChoice}
              homeName={homeName}
              hasHome={home !== null}
              fieldDefaults={fieldDefaultsLabel(defaults.record)}
              policyLoad={policyLoad}
              personName={person.row.label}
              note={subjectNote({
                linkage,
                choice: (audience ?? "only_you") as
                  | "defaults"
                  | "only_you"
                  | "home"
                  | "custom",
                personName: person.row.label,
                homeMembers:
                  home?.household?.members.map((member) => member.account_id) ??
                  null,
                homeName,
              })}
              onChange={(value) => {
                setTouched(true);
                dispatch({ type: "audience", value });
                if (outcome?.kind === "offline_choice") setOutcome(null);
              }}
              onChoosePeople={() => setPolicyEditor(true)}
            />
          )}
          {offline ? (
            <OfflineChoice
              name={state.name.trim() || copy.FIELD_VALUE.toLowerCase()}
              currentLabel={currentLabel}
              value={offlineChoice}
              onChange={setOfflineChoice}
            />
          ) : null}
        </fieldset>
      </form>
    </Dialog>
  );
}

function AudienceSection({
  env,
  isNew,
  projected,
  audience,
  current,
  currentChoice,
  homeName,
  hasHome,
  fieldDefaults,
  policyLoad,
  note,
  onChange,
  onChoosePeople,
}: {
  env: PeopleEnv;
  isNew: boolean;
  projected: boolean;
  audience: NewAudience | ExistingAudience | null;
  current: AudienceClass | null;
  currentChoice: ExistingAudience | null;
  homeName: string;
  hasHome: boolean;
  fieldDefaults: string | null;
  policyLoad: "idle" | "loading" | "forbidden" | "failed";
  personName: string;
  note: string | null;
  onChange(value: NewAudience | ExistingAudience): void;
  onChoosePeople(): void;
}) {
  const homeReason = !hasHome
    ? copy.NO_PRIMARY_HOUSEHOLD
    : !env.online && isNew
      ? copy.SHARED_NEEDS_CONNECTION
      : undefined;
  if (isNew)
    return (
      <fieldset className="flex flex-col gap-2" data-audience="new">
        <legend className="mb-1.5 text-[13px] font-medium text-ink-1">
          {copy.AUDIENCE}
        </legend>
        <Choices<NewAudience>
          label={copy.AUDIENCE}
          value={audience as NewAudience}
          onChange={onChange}
          choices={[
            { value: "defaults", label: copy.USE_DEFAULTS(fieldDefaults) },
            { value: "only_you", label: copy.ONLY_YOU },
            {
              value: "home",
              label: copy.HOME_VIEW(homeName),
              ...(homeReason ? { disabledReason: homeReason } : {}),
            },
          ]}
        />
        <p className="text-[12.5px] text-ink-2">{copy.CHOOSE_AFTER_SAVE}</p>
        {note ? (
          <p data-subject-note="" className="text-[12.5px] text-ink-1">
            {note}
          </p>
        ) : null}
      </fieldset>
    );
  if (projected) return null;
  if (policyLoad === "forbidden")
    return <p className="text-[13px] text-ink-2">{copy.AUDIENCE_OWNER_ONLY}</p>;
  if (current === null)
    return (
      <p className="text-[13px] text-ink-2" data-audience="unknown">
        {policyLoad === "loading"
          ? copy.AUDIENCE_LOADING
          : policyLoad === "failed"
            ? copy.AUDIENCE_LOAD_FAILED
            : copy.LINK_UNKNOWN_REASON.offline}
      </p>
    );
  return (
    <fieldset className="flex flex-col gap-2" data-audience="existing">
      <legend className="mb-1.5 text-[13px] font-medium text-ink-1">
        {copy.AUDIENCE}
      </legend>
      <Choices<ExistingAudience>
        label={copy.AUDIENCE}
        value={audience as ExistingAudience}
        onChange={onChange}
        choices={[
          { value: "only_you", label: copy.ONLY_YOU },
          {
            value: "home",
            label: copy.HOME_VIEW(homeName),
            ...(hasHome ? {} : { disabledReason: copy.NO_PRIMARY_HOUSEHOLD }),
          },
          ...(currentChoice === "custom" && current.kind === "custom"
            ? [
                {
                  value: "custom" as const,
                  label: copy.CUSTOM(current.summary),
                },
              ]
            : []),
        ]}
      />
      {env.online ? (
        <Button data-people-action="choose-people" onClick={onChoosePeople}>
          {copy.CHOOSE_PEOPLE}
        </Button>
      ) : null}
      {note ? (
        <p data-subject-note="" className="text-[12.5px] text-ink-1">
          {note}
        </p>
      ) : null}
    </fieldset>
  );
}

function OfflineChoice({
  name,
  currentLabel,
  value,
  onChange,
}: {
  name: string;
  currentLabel: string;
  value: "save_now" | "hold";
  onChange(value: "save_now" | "hold"): void;
}) {
  return (
    <section
      data-offline-choice=""
      className="flex flex-col gap-2 rounded-row border border-hairline-strong bg-inset p-3.5"
    >
      <h3 className="text-[14px] font-medium text-ink-1">
        {copy.OFFLINE_HEADING}
      </h3>
      <p className="text-[13px] leading-[1.55] text-ink-1">
        {copy.OFFLINE_BODY(name)}
      </p>
      <Choices<"save_now" | "hold">
        label={copy.OFFLINE_HEADING}
        value={value}
        onChange={onChange}
        choices={[
          {
            value: "save_now",
            label: copy.SAVE_NOW_TITLE(name, currentLabel),
            description: copy.SAVE_NOW_BODY,
          },
          {
            value: "hold",
            label: copy.HOLD_TITLE,
            description: copy.HOLD_BODY(name),
          },
        ]}
      />
      <p className="text-[12.5px] leading-[1.55] text-ink-2">
        {copy.HOLD_CAVEAT(name)}
      </p>
      <p className="text-[12.5px] leading-[1.55] text-ink-2">
        {copy.HOLD_CAVEAT_2}
      </p>
    </section>
  );
}

function ConflictPanel({
  current,
  onDiscard,
  onSaveMine,
}: {
  current: CacheRow;
  onDiscard(): Promise<void>;
  onSaveMine(): Promise<void>;
}) {
  const value = parseFieldValue(current.value);
  return (
    <section
      data-field-conflict=""
      className="flex flex-col gap-2 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
    >
      <h3 className="text-[14px] font-medium text-ink-1">
        {copy.CONFLICT_TITLE}
      </h3>
      <p className="text-[12.5px] text-ink-1">
        {copy.CONFLICT_CURRENT}: {current.label}
        {value === null ? "" : ` — ${formatValue(value)}`}
      </p>
      <p className="text-[12.5px] text-ink-2">{copy.CONFLICT_MINE}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          data-people-action="save-mine"
          onClick={() => void onSaveMine()}
        >
          {copy.SAVE_MINE}
        </Button>
        <Button
          variant="quiet"
          data-people-action="discard-mine"
          onClick={() => void onDiscard()}
        >
          {copy.DISCARD_MINE}
        </Button>
      </div>
    </section>
  );
}

function ArchiveInEditor({ id, onDone }: { id: string; onDone(): void }) {
  const save = useOutboxSave();
  const announcer = useAnnouncer();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="quiet"
        data-people-action="archive-field-editor"
        onClick={async () => {
          const outcome = await save((outbox) =>
            outbox.enqueue(archiveRequest({ id, archived: true })),
          );
          if (outcome.ok) {
            announcer.announce(copy.SAVED_NOT_SENT, "polite");
            onDone();
          } else if (outcome.message !== null) setMessage(outcome.message);
        }}
      >
        {copy.ARCHIVE}
      </Button>
      {message ? (
        <span className="text-[12px] text-conflict-text">{message}</span>
      ) : null}
    </span>
  );
}
