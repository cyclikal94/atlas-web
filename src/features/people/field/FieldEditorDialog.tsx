import { ChevronDown } from "lucide-react";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import {
  type CacheRow,
  type DraftWithCommand,
  type EnqueueRequest,
  type Loadable,
  type MergedResource,
  type MergedUnder,
  useConflictInbox,
  useDataActions,
  useDraftWithCommand,
  useMergedUnder,
  useSharingDefaults,
} from "../../../data";
import { canonicalBody, ResourcePolicyEditor, untilSent } from "../../sharing";
import {
  applyPolicyChange,
  policyChangeCommands,
} from "../../sharing/apply-policy-change";
import { archiveRequestFor, archiveSaved, archiveTarget } from "../archive";
import * as copy from "../copy";
import { type PeopleEnv, usePeopleEnv } from "../env";
import {
  type Admission,
  admit,
  completeSession,
  isPending,
  preparedFor,
  reportSession,
  retireSession,
  sessionOf,
  settle,
  useEditingSession,
  useShown,
} from "../lifetime";
import {
  isCurrentMemory,
  notePolicy,
  type PeopleMemory,
  useMemoryRevision,
} from "../memory";
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
  baseGuard,
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
import {
  changesOfAll,
  foldRows,
  projectedRows,
  type ShownRow,
} from "../model/project";
import {
  draftFieldContent,
  type EditSnapshot,
  expectedBaseOf,
  followsOf,
  heldPredecessorOf,
  reviewedDraft,
  snapshotOf,
  stillBound,
  successorFollows,
} from "../model/snapshot";
import {
  FIELD_KINDS,
  type FieldKind,
  type FieldValue,
  formatValue,
  parseFieldValue,
} from "../model/values";
import { sendOnline, sentSomething } from "../online";
import { Banner, Choices, FieldError, useOutboxSave } from "../parts";
import { ConfirmedAbsence, OutstandingChain, usePersonLinkage } from "../reads";
import { type HoldOutcome, heldAttemptOf, holdChange } from "./held";
import { editorReads } from "./prerequisites";
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
 *  - A version conflict of this field's draft shows the current value (and the audience now, when it changed) beside the CONFLICTED
 *    SAVE'S OWN content, with "Save mine on the current version" (a supersession of that content on the version and audience the person
 *    sees, the person's explicit act) and "Discard mine" (finding 3 of the review of 13 October).
 *  - An edit is BOUND to the field as it was when it began (`model/snapshot.ts`, finding 1): a save after the field's content or policy
 *    changed, or after another save of the field was queued, writes nothing; the person reviews the current value and audience and chooses
 *    "Save mine on the current version" (re-binding) or "Discard mine".
 */
/** The type select's 16 px chevron, centred on it (inline: a one-off positioning utility would add rules to the shared stylesheet). */
const CHEVRON_CENTRED = { top: "calc(50% - 8px)" };

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
  // ONE owner per TARGET (review 9, finding 1): the identity, the person and the field (or a new one). Another field's route, even one the
  // router shows through this same component, mounts another owner: its title, its kept session and what Cancel ends are all its own,
  // and nothing of the previous target's view can act for it.
  return (
    <EditorTarget
      key={`${env.identity}\u0000${personId}\u0000${fieldId ?? "new"}`}
      env={env}
      personId={personId}
      fieldId={fieldId}
      onClose={onClose}
    />
  );
}

function EditorTarget({
  env,
  personId,
  fieldId,
  onClose,
}: {
  env: PeopleEnv;
  personId: string;
  fieldId: string | null;
  onClose(): void;
}) {
  // "Try again" reads EVERY read of the editor afresh, together (review 9, finding 2): the person, the field, this device's unsent changes
  // and any confirmation of an absence. New watches (a live query ends at its first error); the session kept for the target stays.
  const [reading, setReading] = useState(0);
  return (
    <EditorReads
      key={reading}
      env={env}
      personId={personId}
      fieldId={fieldId}
      retry={() => setReading((value) => value + 1)}
      onClose={onClose}
    />
  );
}

function EditorReads({
  env,
  personId,
  fieldId,
  retry,
  onClose,
}: {
  env: PeopleEnv;
  personId: string;
  fieldId: string | null;
  retry(): void;
  onClose(): void;
}) {
  // The person and the field as ONE read saw them (WEB-11a review 16, R16.1): a field changed by the commit that removed its person is
  // never admitted under the person a separate read still holds. A new field reads the person alone.
  const read = useMergedUnder(
    fieldId ?? personId,
    fieldId === null ? undefined : personId,
  );
  const person = partOf(read, (value) =>
    fieldId === null ? value.resource : value.parent,
  );
  const field = partOf(read, (value) => value.resource);
  const draftKey = `field:${personId}:${fieldId ?? "new"}`;
  return (
    <OutstandingChain witness={personId}>
      {(outstanding) => {
        // The edit's snapshot needs the person, the field and this device's whole chain of saves (finding 5), each READ: a read that
        // failed, or a chain that is more than this page reads, is not an empty one, and nothing is edited on a guessed base (review 7's
        // design assessment, C15; review 9, finding 2). Input kept for the editor stays kept for when the reads succeed.
        // An existing field's person and field are ONE read: it is said as the field's (the person alone is read only for a new field).
        const reads = editorReads(
          fieldId === null ? person : READ_WITH_FIELD,
          fieldId === null ? null : field,
          outstanding,
        );
        if (reads.kind === "loading") return null;
        if (reads.kind !== "read") {
          // The field's name only while both it and its person were read here, under that person (PPL-5): never from a read that failed.
          const label =
            person.status === "ready" &&
            person.value.merged?.kind === "person" &&
            field.status === "ready" &&
            field.value.merged?.kind === "field" &&
            field.value.merged.parent_id === personId
              ? field.value.merged.label
              : copy.FIELD_FALLBACK_NAME;
          return (
            <EditorUnread
              state={
                reads.kind === "capped"
                  ? "editor-unread"
                  : unreadState(reads.read)
              }
              title={
                fieldId === null
                  ? copy.ADD_FIELD_TITLE
                  : copy.EDIT_FIELD_TITLE(label)
              }
              message={
                reads.kind === "capped"
                  ? copy.EDITOR_CHANGES_CAPPED
                  : reads.read === "person"
                    ? copy.EDITOR_PERSON_UNREAD
                    : reads.read === "field"
                      ? copy.EDITOR_FIELD_UNREAD
                      : copy.EDITOR_CHANGES_UNREAD
              }
              memory={env.memory}
              draftKey={draftKey}
              onRetry={retry}
              onClose={onClose}
            />
          );
        }
        const changes = changesOfAll(outstanding.rows);
        const cachedPerson =
          person.status === "ready" && person.value.merged?.kind === "person"
            ? person.value.merged
            : null;
        // The unsent changes were read from a state without the person, and do not create them (R16.1): a later commit removed the person.
        // Nothing is shown until the reads agree; the kept input stays kept.
        if (
          outstanding.witnessed === false &&
          projectedRows(new Set(), changes, "person").every(
            (row) => row.row.id !== personId,
          )
        )
          return null;
        const personRow = foldRows(
          cachedPerson === null ? [] : [cachedPerson],
          changes,
          "person",
        ).find((row) => row.row.id === personId);
        // PPL-5: nothing of a person who isn't shown. The detail around the editor owns the person's absence (it withdraws the editor).
        if (personRow === undefined) return null;
        const fieldRow =
          fieldId === null
            ? null
            : (foldRows(
                // A cached field only under the person the SAME read holds (a person only this device creates has no server fields).
                cachedPerson !== null &&
                  field.status === "ready" &&
                  field.value.merged?.kind === "field" &&
                  field.value.merged.parent_id === personId
                  ? [field.value.merged]
                  : [],
                changes,
                "field",
                personId,
              ).find((row) => row.row.id === fieldId) ?? null);
        if (fieldId !== null && fieldRow === null)
          // A field the separate reads don't show is "not on this device" only once ONE read of the cache and the unsent changes agrees
          // (DA7-12: the queue's read can answer before the cache's when the field is published); meanwhile nothing is drawn.
          return (
            <ConfirmedAbsence
              id={fieldId}
              limit={1}
              pages={1}
              absent={({ resource, drafts }) =>
                foldRows(
                  resource !== null &&
                    resource.kind === "field" &&
                    resource.parent_id === personId
                    ? [resource]
                    : [],
                  changesOfAll(drafts),
                  "field",
                  personId,
                ).every((row) => row.row.id !== fieldId)
              }
            >
              {(confirmation) =>
                confirmation === "absent" || confirmation === "failed" ? (
                  <EditorUnread
                    state={
                      confirmation === "absent"
                        ? "editor-not-on-device"
                        : "editor-read-failed"
                    }
                    title={copy.EDIT_FIELD_TITLE(copy.FIELD_FALLBACK_NAME)}
                    message={
                      confirmation === "absent"
                        ? copy.FIELD_NOT_ON_DEVICE
                        : copy.EDITOR_FIELD_UNREAD
                    }
                    memory={env.memory}
                    draftKey={draftKey}
                    onRetry={confirmation === "failed" ? retry : null}
                    onClose={onClose}
                  />
                ) : null
              }
            </ConfirmedAbsence>
          );
        return (
          <Editor
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

const NOTHING: MergedResource = {
  base: null,
  effects: [],
  creates: [],
  createsTotal: 0,
  createsNext: null,
  merged: null,
};

/** The person's read when it is the field's read too (its state is the field's). */
const READ_WITH_FIELD: Loadable<MergedResource> = {
  status: "ready",
  value: NOTHING,
};

/** One part of the editor's single read, as a read of its own (a parent the read did not name is nothing). */
function partOf(
  read: Loadable<MergedUnder>,
  part: (value: MergedUnder) => MergedResource | null,
): Loadable<MergedResource> {
  return read.status === "ready"
    ? { status: "ready", value: part(read.value) ?? NOTHING }
    : read;
}

type UnreadState =
  | "editor-unread"
  | "editor-read-failed"
  | "editor-not-on-device";
const unreadState = (read: "person" | "field" | "changes"): UnreadState =>
  read === "changes" ? "editor-unread" : "editor-read-failed";

/**
 * The editor while it cannot edit: this device's unsent changes cannot be read whole, the person or the field could not be read (review 9,
 * finding 2), or the field is confirmed not to be on this device. Nothing is edited, but the editing session kept for the target is still
 * the person's to end (review 8, finding 1). Cancel, Escape, the close icon and the overlay end the session SHOWN here (the one kept under
 * the target's key when this view opened; none: nothing to end), exactly as the editor's own do; Try again and the in-dialog sync control
 * keep it. The view belongs to ONE target and ONE reading of it (its owner is keyed, review 9, finding 1): a handler of a view that was
 * replaced ends nothing and navigates nowhere.
 */
function EditorUnread({
  state,
  title,
  message,
  memory,
  draftKey,
  onRetry,
  onClose,
}: {
  state: UnreadState;
  title: string;
  message: string;
  memory: PeopleMemory;
  draftKey: string;
  /** null: nothing to read again (the field is confirmed not to be here). */
  onRetry: (() => void) | null;
  onClose(): void;
}) {
  const [shownSession] = useState(() => sessionOf(memory.drafts.get(draftKey)));
  const shown = useShown();
  const discard = () => {
    if (shown() && shownSession !== undefined)
      retireSession(memory, draftKey, shownSession);
  };
  const close = () => {
    if (shown()) onClose();
  };
  return (
    <Dialog
      open
      title={title}
      onClose={close}
      onDiscard={discard}
      onRetainDraft={() => undefined}
      footer={
        <>
          <Button
            variant="quiet"
            onClick={() => {
              discard();
              close();
            }}
          >
            {copy.CANCEL}
          </Button>
          {onRetry === null ? null : (
            <span className="ml-auto">
              <Button
                variant="primary"
                onClick={() => {
                  if (shown()) onRetry();
                }}
              >
                {copy.TRY_AGAIN}
              </Button>
            </span>
          )}
        </>
      }
    >
      <p data-people-state={state} className="text-[13.5px] text-ink-1">
        {message}
      </p>
    </Dialog>
  );
}

interface Retained {
  /** The editing session this input belongs to (`lifetime.ts`): kept across a remount, new after Cancel (review 6, finding 1). */
  session: string;
  form: FieldFormState;
  /** The id a new field is created under: one per editing session, so a retried shared create is the same field. */
  newFieldId: string;
  /** The audience choice was changed by the person (an existing field's choice otherwise follows its policy). */
  touched: boolean;
  /**
   * What an edit of an existing field is bound to (finding 1); kept with the draft, so a remount restores the same binding. null for a new
   * field, and for an edit that began on an unsent create until the person reviews the published field and binds to it (review 10).
   */
  snapshot: EditSnapshot | null;
  /** What the edit BEGAN on; fixed for the session (review 10, finding 1): a create published meanwhile does not change it. */
  origin: EditOrigin;
}

/**
 * Where an edit began (review 10, finding 1): a new field; a published field (bound at once, `snapshot`); or a field's unsent CREATE, which
 * the edit replaces in place only while it is stored with exactly the body the edit read (its `command_digest`, review 2, finding 3). Once
 * that create is published the edit has NO binding to the field yet: no version or audience was ever reviewed for it (unknown is not
 * unchanged). The person sees the field and who can see it as they are now and chooses "Save mine on the current version", which binds the
 * edit; nothing binds or saves because the create was published.
 */
type EditOrigin =
  | { kind: "new" }
  | { kind: "field" }
  | { kind: "create"; localId: string | null; digest: string | null };

type Outcome =
  | null
  | { kind: "message"; text: string; requestId?: string }
  | { kind: "offline_choice" }
  /** The field changed since the edit began (finding 1): nothing was saved; the person reviews the current value and audience. */
  | { kind: "stale" };

/** What a save tells the form showing its session now (`reportSession`): its outcome, and a re-binding it confirmed. */
interface EditorReport {
  outcome?: Outcome;
  snapshot?: EditSnapshot;
  touched?: boolean;
}

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
    if (kept !== undefined)
      return {
        retained: { ...kept, session: sessionOf(kept) ?? env.newId() },
        restored: true,
      };
    const form =
      existing !== null && parsed !== null
        ? fromField({ label: existing.label, value: parsed }, env.newId)
        : existing !== null
          ? { ...newFieldForm(), name: existing.label }
          : newFieldForm();
    const origin: EditOrigin =
      field === null
        ? { kind: "new" }
        : field.projected
          ? {
              kind: "create",
              localId: field.createDraft,
              digest:
                drafts.find((d) => d.local_id === field.createDraft)
                  ?.command_digest ?? null,
            }
          : { kind: "field" };
    return {
      retained: {
        session: env.newId(),
        form,
        newFieldId: env.newId(),
        touched: false,
        snapshot:
          existing === null || origin.kind !== "field"
            ? null
            : snapshotOf(existing, drafts, field?.latest?.localId ?? null),
        origin,
      },
      restored: false,
    };
  });
  const origin = initial.retained.origin;
  // The outstanding saves as they are read NOW (a save decides on the latest read, not the one of the render that started it).
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [state, dispatch] = useReducer(reduceFieldForm, initial.retained.form);
  const [touched, setTouched] = useState(initial.retained.touched);
  const [snapshot, setSnapshot] = useState(initial.retained.snapshot);
  const [problems, setProblems] = useState<
    Partial<Record<ProblemSlot, FieldInputProblem>>
  >({});
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [offlineChoice, setOfflineChoice] = useState<"save_now" | "hold">(
    "hold",
  );
  const [policyEditor, setPolicyEditor] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const nameError = useId();
  const typeId = useId();
  const session = initial.retained.session;
  // Whether this session's save runs, whichever mount of it started the save (review 7, finding 1).
  const saving = isPending(env.memory, session);

  // The draft is kept for this identity while the editor is open (a remount reopens it); dismissing the editor forgets it, and nothing
  // of this form keeps it again after that (review 8, finding 1).
  const retired = useRef(false);
  useEffect(() => {
    if (retired.current) return;
    env.memory.drafts.set(draftKey, {
      session,
      form: state,
      newFieldId: initial.retained.newFieldId,
      touched,
      snapshot,
      origin,
    } satisfies Retained);
  }, [
    env,
    draftKey,
    session,
    state,
    touched,
    snapshot,
    initial.retained.newFieldId,
    origin,
  ]);
  // Only this session ends (never a later session's under the same key), and only by the view shown now: a handler of an editor that was
  // replaced (another field's route, the reads read again) ends nothing and navigates nowhere (review 9, finding 1).
  const shown = useShown();
  const forget = () => {
    if (!shown()) return;
    retired.current = true;
    retireSession(env.memory, draftKey, session);
  };
  const close = () => {
    if (!shown()) return;
    forget();
    onClose();
  };
  // A save's completion ends the session it was made in, through whichever mount shows it now (review 6, finding 1).
  const owns = useEditingSession<EditorReport>(env.memory, session, {
    revision: () => stateRef.current.revision,
    close,
    keep: () => setOutcome({ kind: "message", text: copy.LATER_EDITS_KEPT }),
    report: (update) => {
      if (update.snapshot !== undefined) setSnapshot(update.snapshot);
      if (update.touched !== undefined) setTouched(update.touched);
      if (update.outcome !== undefined) setOutcome(update.outcome);
    },
  });
  /** What this session's save says, to the form showing the session now (the one that submitted may have been remounted since). */
  const tell = (update: EditorReport) =>
    reportSession(env.memory, draftKey, session, update);
  const ended = (ticket: number | null) =>
    completeSession(
      env.memory,
      draftKey,
      session,
      ticket,
      (kept) => (kept as Retained).form.revision,
    );

  // ---- the existing field's audience (owner-only read, while open, online and editable) ----------------------------------------
  const isNew = existing === null;
  const projected = field?.projected ?? false;
  const canEdit = existing === null ? true : existing.can_edit;
  const known =
    existing === null ? undefined : env.memory.policies.get(existing.id);
  const livePolicyVersion = existing?.policy_version ?? null;
  const policyLoad: "idle" | "loading" | "forbidden" | "failed" =
    existing === null
      ? "idle"
      : env.memory.policyReads.has(existing.id)
        ? "loading"
        : (env.memory.policyRefusals.get(existing.id) ?? "idle");
  // A policy read OLDER than the field's published policy version is not the audience any more: it is asked again, once per version.
  const asked = useRef<number | null>(null);
  useEffect(() => {
    if (existing === null || projected || !canEdit || !env.online) return;
    const memory = env.memory;
    const read = memory.policies.get(existing.id);
    const outdated =
      read !== undefined &&
      livePolicyVersion !== null &&
      read.version < livePolicyVersion &&
      asked.current !== livePolicyVersion;
    if (
      (read !== undefined && !outdated) ||
      memory.policyReads.has(existing.id) ||
      memory.policyRefusals.get(existing.id) === "forbidden"
    )
      return;
    if (outdated) {
      asked.current = livePolicyVersion;
      memory.policies.delete(existing.id);
    }
    memory.policyReads.add(existing.id);
    memory.policyRefusals.delete(existing.id);
    memory.touch();
    void untilSent(() => env.sharing.readPolicy(existing.id)).then((result) => {
      if (!isCurrentMemory(memory)) return;
      memory.policyReads.delete(existing.id);
      if (result.ok)
        notePolicy(memory, existing.id, {
          ...result.value,
          checkedAt: env.now(),
        });
      else
        memory.policyRefusals.set(
          existing.id,
          result.kind === "forbidden" ? "forbidden" : "failed",
        );
      memory.touch();
    });
  }, [env, existing, projected, canEdit, livePolicyVersion]);

  const home = primaryHousehold(defaults.record);
  const homeName = home?.household?.name ?? "Home";
  // The audience this edit may show and act on: the policy read AT the version the edit began on (finding 1). A read of another version
  // is another audience than the one the edit is bound to; it is never shown as the edit's.
  const shownPolicy =
    known !== undefined &&
    snapshot !== null &&
    known.version === snapshot.policyVersion
      ? known
      : undefined;
  const policyMoved =
    known !== undefined &&
    snapshot !== null &&
    known.version !== snapshot.policyVersion;
  const current: AudienceClass | null =
    shownPolicy === undefined
      ? null
      : classify(shownPolicy.policy, home?.id ?? null);
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
  // The audience as it is NOW (the read of the field's current policy version), for the review of a changed field or a conflict.
  const nowAudience =
    known !== undefined &&
    livePolicyVersion !== null &&
    known.version === livePolicyVersion
      ? audienceLabel(classify(known.policy, home?.id ?? null), homeName)
      : null;

  // ---- the edit is still bound to the field as it was when it began (finding 1) ------------------------------------------------
  const unbound =
    existing !== null &&
    !projected &&
    snapshot !== null &&
    (!stillBound(snapshot, existing) || policyMoved);
  // ---- the edit began on the field's unsent create, which is published now (review 10, finding 1) ------------------------------
  // It has no binding to the published field: the person reviews the field and who can see it as they are NOW, and only "Save mine on the
  // current version" binds the edit (never a guessed version, never the audience it was created with, never on its own).
  const needsReview =
    origin.kind === "create" &&
    existing !== null &&
    !projected &&
    snapshot === null &&
    canEdit;
  /** Why the published field's current audience is not shown (it must be, before the edit is bound to it), or null when it is. */
  const reviewAudienceReason =
    nowAudience !== null
      ? null
      : livePolicyVersion === null ||
          (known !== undefined && known.version > livePolicyVersion)
        ? copy.WAIT_FOR_SYNC_FIELD
        : policyLoad === "forbidden"
          ? copy.PUBLISHED_AUDIENCE_OWNER_ONLY
          : !env.online
            ? copy.CONFLICT_NEEDS_AUDIENCE
            : policyLoad === "failed"
              ? copy.AUDIENCE_LOAD_FAILED
              : copy.AUDIENCE_LOADING;
  // Said once when it happens while the editor is open (the Save button's reason changes under the person's hands).
  const reviewSaid = useRef(needsReview);
  useEffect(() => {
    if (needsReview && !reviewSaid.current)
      announcer.announce(copy.PUBLISHED_TITLE, "polite");
    reviewSaid.current = needsReview;
  }, [needsReview, announcer]);

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

  // The conflicted save's own body (the inbox lists headers): what "Yours" shows and "Save mine" sends (finding 3).
  const conflictBody = useDraftWithCommand(conflict?.draft.local_id ?? null);
  const conflicted =
    conflictBody.status === "ready" &&
    conflictBody.value !== null &&
    conflictBody.value.local_id === conflict?.draft.local_id
      ? conflictBody.value
      : null;
  const conflictContent =
    conflicted === null ? null : draftFieldContent(conflicted);

  const readOnly = !canEdit;
  const title = isNew
    ? copy.ADD_FIELD_TITLE
    : copy.EDIT_FIELD_TITLE(existing.label);

  const fail = (text: string | null, requestId?: string) => {
    if (text !== null)
      tell({
        outcome: {
          kind: "message",
          text,
          ...(requestId ? { requestId } : {}),
        },
      });
  };
  const succeeded = (message: string, ticket: number) => {
    announcer.announce(message, "polite");
    // A change made while saving stays, unsaved (the ticket): only a success for the current revision ends the session, and only the
    // session this save was made in (a later "Add a field" after Cancel is another session's, never closed or forgotten by this one).
    ended(ticket);
  };

  /** Queues the content update bound to `bound` (its policy version and expected base). */
  const queueUpdate = async (
    bound: EditSnapshot,
    ready: { label: string; value: FieldValue },
    policyVersion: number,
  ) => {
    const sameKind = parsed !== null && parsed.kind === ready.value.kind;
    const guard = baseGuard(bound.expectedBase);
    const base = {
      fieldId: (existing as CacheRow).id,
      personId: person.row.id,
      label: ready.label,
      value: ready.value,
      policyVersion,
      sameKind,
    };
    const latest = field?.latest ?? null;
    // The edit was made over a body that is no longer the one stored (finding 3 of review 2): nothing is written, the field is reviewed.
    let reviewAgain = false;
    const outcome = await save(async (outbox) => {
      // D-11a-15: only the unsent save the edit BEGAN on is edited in place, and only while it is stored exactly as the edit read it.
      let refusal: Parameters<typeof successorFollows>[0] = null;
      if (
        latest !== null &&
        latest.localId === bound.latestLocalId &&
        latest.kind === "put_field_update" &&
        latest.status === "queued" &&
        !latest.reviewing &&
        policyVersion === bound.policyVersion
      ) {
        const edited = await outbox.editQueued(latest.localId, {
          ...putFieldUpdateRequest(base),
          expectDraft: reviewedDraft(bound),
          // Only while no later save of the field follows it (D-11a-15, review 12): that save was built over this body.
          expectLatest: true,
        });
        if (edited.kind === "edited") return edited;
        if (
          edited.reason !== "not_queued" &&
          edited.reason !== "not_found" &&
          edited.reason !== "retargeted" &&
          edited.reason !== "draft_changed" &&
          edited.reason !== "not_latest"
        )
          return edited;
        refusal = edited.reason;
      }
      // A new draft follows the reviewed save only while it is stored with the body the edit read (never after another page's edit).
      if (!successorFollows(refusal, bound, draftsRef.current)) {
        reviewAgain = true;
        return { kind: "refused", reason: "draft_changed" } as const;
      }
      // ... and that is judged again where it counts, in the writing transaction (review 12, R12.1): a claimed body can come back to the
      // queue and be edited after the check above.
      const queued = await outbox.enqueue({
        ...putFieldUpdateRequest({ ...base, guard }),
        ...followsOf(bound, base.fieldId),
      });
      if (queued.kind === "refused" && queued.reason === "predecessor_changed")
        reviewAgain = true;
      return queued;
    });
    return { outcome, moved: guard.moved || reviewAgain };
  };

  /** One save of this session, admitted by `submit` (never on its own). */
  const run = async (choice?: "save_now" | "hold") => {
    const ready = applicable(state);
    if (!ready.ok) {
      setProblems(ready.problems);
      return;
    }
    setProblems({});
    tell({ outcome: null });
    const ticket = state.revision;
    // ---- create ----
    if (isNew) {
      const fieldId = initial.retained.newFieldId;
      const choiceNew = state.audience as NewAudience;
      if (choiceNew === "home") {
        const policy = quickPolicy("home", null, home?.id ?? null);
        if (policy === null) return fail(copy.NO_PRIMARY_HOUSEHOLD);
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
      const record = defaults.record;
      const reviewing = choiceNew === "defaults" && record === null;
      const dependsOn =
        person.projected && person.createDraft !== null
          ? [person.createDraft]
          : [];
      // The same input is the same request (its local id): a retry of a create that was written but not answered is recognised.
      const request = preparedFor(
        env.memory,
        session,
        JSON.stringify([
          fieldId,
          ready.label,
          ready.value,
          choiceNew,
          record,
          dependsOn,
        ]),
        () => ({
          ...putFieldCreateRequest({
            fieldId,
            personId: person.row.id,
            label: ready.label,
            value: ready.value,
            audience: choiceNew,
            record,
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
          }),
          localId: env.newId(),
        }),
      );
      const outcome = await save((outbox) => outbox.enqueue(request));
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
      // Only the create body the edit began on is replaced (another page's edit of it, or of its review, is never overwritten).
      const reviewed = origin.kind === "create" ? origin.digest : null;
      if (
        reviewed === null ||
        draft.local_id !== (origin.kind === "create" ? origin.localId : null) ||
        draft.command_digest !== reviewed
      )
        return fail(copy.CREATE_CHANGED);
      let refusal = null as string | null;
      const outcome = await save(async (outbox) => {
        const edited = await outbox.editQueued(draft.local_id, {
          ...request,
          expectDraft: (stored) =>
            stored.local_id === draft.local_id &&
            stored.status === "queued" &&
            stored.command_digest === reviewed,
          expectLatest: true,
        });
        if (edited.kind === "refused") refusal = edited.reason;
        return edited;
      });
      // Never a new create instead (review 10's design assessment, DA10-04): the input stays; a create being sent is published
      // eventually, and then the edit is reviewed on the field.
      if (refusal === "draft_changed" || refusal === "not_latest")
        return fail(copy.CREATE_CHANGED);
      if (refusal === "not_queued") return fail(copy.CREATE_SENDING);
      if (!outcome.ok) return fail(outcome.message ?? null);
      return succeeded(copy.SAVED_NOT_SENT, ticket);
    }
    // ---- update: bound to what the edit began on (finding 1), or, after its create was published, to what the person reviewed ----
    const bound = snapshot;
    if (bound === null) return fail(copy.PUBLISHED_REVIEW_FIRST);
    if (bound.policyVersion === null) return fail(copy.WAIT_FOR_SYNC_FIELD);
    if (
      !stillBound(bound, existing) ||
      (known !== undefined && known.version !== bound.policyVersion)
    ) {
      tell({ outcome: { kind: "stale" } });
      return;
    }
    const contentChanged =
      ready.label !== existing.label ||
      JSON.stringify(ready.value) !== JSON.stringify(parsed);
    const sameKind = parsed !== null && parsed.kind === ready.value.kind;
    const content = { label: ready.label, value: ready.value };
    const queued = async (policyVersion: number) => {
      const { outcome, moved } = await queueUpdate(
        bound,
        content,
        policyVersion,
      );
      if (moved) {
        tell({ outcome: { kind: "stale" } });
        return;
      }
      if (!outcome.ok) return fail(outcome.message);
      return succeeded(copy.SAVED_NOT_SENT, ticket);
    };
    if (!audienceChanged) {
      if (!contentChanged) return close();
      return queued(bound.policyVersion);
    }
    // The audience changes: the policy's own, online-only step, from the audience the edit shows (read at the bound policy version).
    const target =
      audience === "custom"
        ? null
        : quickPolicy(
            audience as "only_you" | "home",
            shownPolicy?.policy ?? null,
            home?.id ?? null,
          );
    if (target === null || shownPolicy === undefined)
      return fail(copy.SHARING_CHANGED);
    if (!env.online) {
      if (choice === undefined) {
        tell({ outcome: { kind: "offline_choice" } });
        return;
      }
      if (choice === "save_now") {
        if (!contentChanged) return close();
        return queued(bound.policyVersion);
      }
      // "Hold as draft": ONE operation of the field under its lock (`holdChange`, review 3 of 22 October 2026, finding 2): kept DURABLY
      // in the account's database as the field's current hold (finding 6), its earlier holds retired; only then may this page run it by
      // itself (D1). A taken lock, a failure or a hold changed elsewhere keeps the edit open here, as typed.
      const memory = env.memory;
      let kept: HoldOutcome;
      try {
        kept = await holdChange(env, {
          holdId: env.newId(),
          fieldId: existing.id,
          personId: person.row.id,
          label: ready.label,
          value: ready.value,
          sameKind,
          version: bound.version,
          expectedBase: bound.expectedBase,
          // The save the value was typed over, as shown (review 12): its content step follows it only while it is stored so.
          predecessor: heldPredecessorOf(bound, existing.id),
          from: { version: shownPolicy.version, policy: shownPolicy.policy },
          to: target,
          status: { kind: "waiting" },
          heldAt: new Date(env.now()).toISOString(),
          rev: 0,
          queued: false,
        });
      } catch {
        kept = { kind: "failed", refused: false };
      }
      if (kept.kind === "busy") return fail(copy.HELD_BUSY);
      if (kept.kind === "changed") return fail(copy.HELD_CHANGED_ELSEWHERE);
      if (kept.kind === "failed")
        return fail(
          kept.refused ? copy.REFUSED.closing : copy.HELD_SAVE_FAILED,
        );
      if (!isCurrentMemory(memory)) return;
      memory.heldAuthority.add(kept.copy.change.holdId);
      memory.touch();
      if (!kept.complete)
        announcer.announce(copy.HELD_KEPT_EARLIER(ready.label), "polite");
      return succeeded(copy.HELD_WAITING(ready.label), ticket);
    }
    const memory = env.memory;
    // The same change's unresolved attempt, kept by this page or by a hold (a reconciliation record) on this device: its key and body. A
    // page attempt counts only for EXACTLY this body (review 4; the assessment's C9: one of another change never hides a held one), and a
    // device lookup that could not be completed sends nothing (a fresh key could repeat a change that may already have been made).
    const body = canonicalBody(
      policyChangeCommands(existing.id, shownPolicy.version, target),
    );
    const remembered = memory.attempts.get(`policy:${existing.id}`) ?? null;
    let attempt = remembered?.body === body ? remembered : null;
    if (attempt === null) {
      const kept = await heldAttemptOf(
        env,
        person.row.id,
        existing.id,
        shownPolicy.version,
        target,
      );
      if (kept.kind === "unknown") {
        return fail(copy.HELD_ATTEMPT_UNKNOWN);
      }
      attempt = kept.kind === "found" ? kept.attempt : remembered;
    }
    const changed = await applyPolicyChange(
      { api: env.sharing, newId: env.newId },
      {
        resourceId: existing.id,
        from: { version: shownPolicy.version, policy: shownPolicy.policy },
        to: target,
        attempt,
        isCurrent: () => isCurrentMemory(memory),
      },
    );
    if (changed.attempt === null)
      memory.attempts.delete(`policy:${existing.id}`);
    else memory.attempts.set(`policy:${existing.id}`, changed.attempt);
    const result = changed.result;
    // A command was sent (whatever its answer said): the summaries shown are read again.
    if (isCurrentMemory(memory) && sentSomething(result))
      memory.invalidateSummaries();
    if (!result.ok) {
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
    notePolicy(memory, existing.id, {
      version: result.policyVersion,
      policy: target,
      checkedAt: env.now(),
    });
    memory.touch();
    // The edit is now bound to the audience the person just confirmed (its new policy version); the content base is unchanged.
    const confirmed = { ...bound, policyVersion: result.policyVersion };
    tell({ snapshot: confirmed, touched: false });
    if (!contentChanged) {
      return succeeded(copy.SAVED_NOT_SENT, ticket);
    }
    const { outcome, moved } = await queueUpdate(
      confirmed,
      content,
      result.policyVersion,
    );
    if (moved) {
      tell({ outcome: { kind: "stale" } });
      return;
    }
    if (!outcome.ok) return fail(outcome.message);
    return succeeded(copy.SAVED_NOT_SENT, ticket);
  };

  /**
   * Saves this session's input: admitted once per SESSION, synchronously, before anything is awaited (review 7, finding 1). While it
   * runs, every mount of the session shows it saving and admits nothing: a remounted editor cannot start a second create, update,
   * audience change or hold of the same input. The audience step, the policy read, its confirmation and the content update are ONE
   * admission (nothing re-enters between them with the older binding). Held changes keep their own field lock (`holdChange`).
   */
  const submit = async (choice?: "save_now" | "hold") => {
    if (!owns()) return;
    const admission = admit(env.memory, [session], env.newId);
    if (admission === null) return;
    try {
      await run(choice);
    } finally {
      settle(admission);
    }
  };

  const policyChangedSince =
    snapshot !== null &&
    livePolicyVersion !== null &&
    livePolicyVersion !== snapshot.policyVersion;
  /**
   * "Save mine on the current version" after a change since the edit began, or after the create it began on was published (review 10):
   * the person's explicit act, after seeing the current value and (when it changed, or was never reviewed) the current audience, binds the
   * edit to the field as THIS view shows it; the save then runs on that binding, once, on the render that holds it. The decision is the
   * one captured at the click (the binding and the input's revision): when either is no longer the view's by then (a save's report
   * re-bound it, the input changed), nothing is saved by it. It is the view's own state, so it never outlives the view.
   */
  const [resubmit, setResubmit] = useState<{
    binding: EditSnapshot;
    revision: number;
  } | null>(null);
  const rebind = () => {
    if (!shown() || existing === null) return;
    const binding = snapshotOf(
      existing,
      drafts,
      field?.latest?.localId ?? null,
    );
    setSnapshot(binding);
    setOutcome(null);
    setResubmit({ binding, revision: state.revision });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs the save once, on the render that holds the new binding
  useEffect(() => {
    if (resubmit === null) return;
    setResubmit(null);
    if (
      resubmit.binding !== snapshot ||
      resubmit.revision !== stateRef.current.revision
    )
      return;
    void submit();
  }, [resubmit]);
  /** The current audience must be known before an edit is re-bound to a changed one, or bound to a published one (review 10). */
  const rebindReason = needsReview
    ? reviewAudienceReason
    : policyChangedSince && nowAudience === null
      ? copy.CONFLICT_NEEDS_AUDIENCE
      : null;

  /** "Save mine on the current version" of a CONFLICTED save (finding 3): ITS content, on the version and audience the person sees now. */
  const saveConflicted = async (draft: DraftWithCommand) => {
    if (!owns()) return;
    const admission = admit(env.memory, [session], env.newId);
    if (admission === null) return;
    try {
      await saveConflictedAdmitted(draft);
    } finally {
      settle(admission);
    }
  };
  const saveConflictedAdmitted = async (draft: DraftWithCommand) => {
    const content = draftFieldContent(draft);
    if (existing === null || content === null || livePolicyVersion === null)
      return fail(copy.WAIT_FOR_SYNC_FIELD);
    if (content.policyVersion !== livePolicyVersion && nowAudience === null)
      return fail(copy.CONFLICT_NEEDS_AUDIENCE);
    const guard = baseGuard(expectedBaseOf(existing, drafts, draft.local_id));
    const outcome = await save((outbox) =>
      outbox.supersede(draft.local_id, {
        ...putFieldUpdateRequest({
          fieldId: existing.id,
          personId: person.row.id,
          label: content.label,
          value: content.value,
          policyVersion: livePolicyVersion,
          sameKind: parsed?.kind === content.value.kind,
          guard,
        }),
        // The draft the person decided on, as it is stored now (a change committed by another page in between is not overwritten).
        expectDraft: (stored) =>
          stored.local_id === draft.local_id &&
          stored.command_digest === draft.command_digest,
      }),
    );
    if (guard.moved) return fail(copy.STALE_TITLE);
    if (outcome.ok) announcer.announce(copy.SAVED_NOT_SENT, "polite");
    else fail(outcome.message);
  };

  if (policyEditor && existing !== null)
    return (
      <ResourcePolicyEditor
        resourceId={existing.id}
        open
        onOpenChange={(open) => {
          if (!open) {
            setPolicyEditor(false);
            env.memory.invalidateSummaries();
          }
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
        : needsReview
          ? copy.PUBLISHED_REVIEW_FIRST
          : !isNew && !projected && snapshot?.policyVersion == null
            ? copy.WAIT_FOR_SYNC_FIELD
            : null;

  return (
    <Dialog
      open
      title={title}
      onClose={() => {
        if (shown()) onClose();
      }}
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
              <ArchiveInEditor
                pending={
                  saving || isPending(env.memory, archiveTarget(existing.id))
                }
                admission={() =>
                  owns()
                    ? admit(
                        env.memory,
                        [session, archiveTarget(existing.id)],
                        env.newId,
                      )
                    : null
                }
                request={() =>
                  archiveRequestFor(
                    env.memory,
                    existing.id,
                    true,
                    existing.version,
                    env.newId,
                  )
                }
                onSaved={() => archiveSaved(env.memory, existing.id)}
                onRefused={(text) => fail(text)}
                onDone={() => ended(null)}
              />
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
            <ReviewPanel
              title={copy.CONFLICT_TITLE}
              current={existing}
              audienceNow={
                conflictContent === null ||
                conflictContent.policyVersion === livePolicyVersion
                  ? null
                  : (nowAudience ?? false)
              }
              mine={conflictContent}
              saveReason={
                conflicted === null || conflictContent === null
                  ? copy.LOADING_MINE
                  : conflictContent.policyVersion !== livePolicyVersion &&
                      nowAudience === null
                    ? copy.CONFLICT_NEEDS_AUDIENCE
                    : null
              }
              onDiscard={async () => {
                await actions.discard(conflict.draft.local_id);
              }}
              onSaveMine={async () => {
                if (conflicted !== null) await saveConflicted(conflicted);
              }}
            />
          ) : needsReview && existing !== null ? (
            <ReviewPanel
              title={copy.PUBLISHED_TITLE}
              note={copy.PUBLISHED_NOT_SAVED}
              current={existing}
              audienceNow={nowAudience ?? false}
              audienceUnknown={copy.PUBLISHED_AUDIENCE_UNKNOWN}
              mine={(() => {
                const ready = applicable(state);
                return ready.ok
                  ? { label: ready.label, value: ready.value }
                  : null;
              })()}
              saveReason={rebindReason}
              onDiscard={async () => close()}
              onSaveMine={async () => rebind()}
            />
          ) : (unbound || outcome?.kind === "stale") && existing !== null ? (
            <ReviewPanel
              title={copy.STALE_TITLE}
              current={existing}
              audienceNow={policyChangedSince ? (nowAudience ?? false) : null}
              mine={(() => {
                const ready = applicable(state);
                return ready.ok
                  ? { label: ready.label, value: ready.value }
                  : null;
              })()}
              saveReason={rebindReason}
              refused={outcome?.kind === "stale"}
              onDiscard={async () => close()}
              onSaveMine={async () => rebind()}
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
            <span className="relative block">
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
                className="atlas-transition min-h-11 w-full appearance-none rounded-control border border-field-edge bg-panel py-2.5 pl-3 pr-9 text-[14px] text-ink-1 disabled:opacity-60"
              >
                {FIELD_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {copy.KIND_LABEL[kind]}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden="true"
                size={16}
                className="pointer-events-none absolute right-3 text-ink-2"
                style={CHEVRON_CENTRED}
              />
            </span>
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
              projected={projected || needsReview}
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

/**
 * The review of a field that changed under an edit (finding 1) or of a conflicted save (finding 3, A5, plan §4.4 "current … next to
 * mine"): the current value, the audience NOW when it is not the one the edit or the save was bound to, and the person's own content.
 * "Save mine on the current version" is the person's explicit act; it is withheld while a changed audience cannot be shown.
 */
function ReviewPanel({
  title,
  note,
  current,
  audienceNow,
  audienceUnknown = copy.CONFLICT_AUDIENCE_UNKNOWN,
  mine,
  saveReason,
  refused = false,
  onDiscard,
  onSaveMine,
}: {
  title: string;
  /** What the review is for, when the title alone doesn't say it (a published create's edit, review 10). */
  note?: string;
  current: CacheRow;
  /** The current audience's label; `false`: it changed (or was never reviewed) and is not known here; null: unchanged (nothing to say). */
  audienceNow: string | false | null;
  /** What `audienceNow: false` says. */
  audienceUnknown?: string;
  mine: { label: string; value: FieldValue } | null;
  saveReason: string | null;
  /** A save was just refused because of this change: said, so a refused save is never silent. */
  refused?: boolean;
  onDiscard(): Promise<void>;
  onSaveMine(): Promise<void>;
}) {
  const value = parseFieldValue(current.value);
  return (
    <section
      data-field-conflict=""
      className="flex flex-col gap-2 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
    >
      <h3 className="text-[14px] font-medium text-ink-1">{title}</h3>
      {note === undefined ? null : (
        <p className="text-[12.5px] text-ink-1" data-review-published="">
          {note}
        </p>
      )}
      {refused ? (
        <p className="text-[12.5px] text-ink-1" data-review-refused="">
          {copy.STALE_NOT_SAVED}
        </p>
      ) : null}
      <p className="text-[12.5px] text-ink-1" data-review-current="">
        {copy.CONFLICT_CURRENT}: {current.label}
        {value === null ? "" : ` — ${formatValue(value)}`}
      </p>
      {audienceNow === null ? null : (
        <p className="text-[12.5px] text-ink-1" data-review-audience="">
          {audienceNow === false
            ? audienceUnknown
            : copy.CONFLICT_AUDIENCE_NOW(audienceNow)}
        </p>
      )}
      <p className="text-[12.5px] text-ink-1" data-review-mine="">
        {copy.CONFLICT_MINE}
        {mine === null ? "" : `: ${mine.label} — ${formatValue(mine.value)}`}
      </p>
      <div className="flex flex-wrap gap-2">
        {saveReason === null ? (
          <Button
            variant="primary"
            data-people-action="save-mine"
            onClick={() => void onSaveMine()}
          >
            {copy.SAVE_MINE}
          </Button>
        ) : (
          <Button variant="primary" disabled reason={saveReason}>
            {copy.SAVE_MINE}
          </Button>
        )}
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

/**
 * Archive from the editor: admitted with the editing session AND the field's archive (review 7, finding 1), so it never runs beside
 * the session's save or another archive of the field (from the detail or the ledger, `archive.ts`); its request is the field's prepared
 * archive (a retry is the same save); a refusal is told to the session's form now.
 */
function ArchiveInEditor({
  pending,
  admission,
  request,
  onSaved,
  onRefused,
  onDone,
}: {
  pending: boolean;
  admission(): Admission | null;
  request(): EnqueueRequest;
  onSaved(): void;
  onRefused(text: string): void;
  onDone(): void;
}) {
  const save = useOutboxSave();
  const announcer = useAnnouncer();
  if (pending)
    return (
      <Button variant="quiet" disabled reason={copy.SAVING}>
        {copy.ARCHIVE}
      </Button>
    );
  return (
    <Button
      variant="quiet"
      data-people-action="archive-field-editor"
      onClick={async () => {
        const admitted = admission();
        if (admitted === null) return;
        const prepared = request();
        let outcome: Awaited<ReturnType<typeof save>>;
        try {
          outcome = await save((outbox) => outbox.enqueue(prepared));
        } finally {
          settle(admitted);
        }
        if (outcome.ok) {
          onSaved();
          announcer.announce(copy.SAVED_NOT_SENT, "polite");
          onDone();
        } else if (outcome.message !== null) onRefused(outcome.message);
      }}
    >
      {copy.ARCHIVE}
    </Button>
  );
}
