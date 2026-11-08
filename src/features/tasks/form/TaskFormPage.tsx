import { useNavigate } from "@tanstack/react-router";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Breadcrumb } from "../../../components/ui/breadcrumb";
import { Button } from "../../../components/ui/button";
import { Pill } from "../../../components/ui/chip";
import { ChoiceCards } from "../../../components/ui/choice-cards";
import { FactCell, FactsStrip } from "../../../components/ui/facts-strip";
import { GroupedBox, GroupedSection } from "../../../components/ui/grouped";
import { Input, inputClass } from "../../../components/ui/input";
import { NativeSelect } from "../../../components/ui/native-select";
import { PageHeading } from "../../../components/ui/page-heading";
import {
  type DraftWithCommand,
  type EnqueueRequest,
  type Loadable,
  useAllOutstandingByKind,
  useDataEnv,
  useSharingDefaults,
} from "../../../data";
import { RecoveryNotice } from "../../../lib/form-recovery/RecoveryNotice";
import { cn } from "../../../lib/utils";
import { useTaskActions } from "../actions";
import * as copy from "../copy";
import { DETAIL_COPY } from "../detail/TaskDetail";
import { useTaskDetail } from "../detail/useTaskDetail";
import { useTasksEnv } from "../env";
import { dayLabel } from "../format";
import {
  completeKept,
  type KeptRecovery,
  keptEntry,
  keptKey,
  useKeptInput,
  useKeptRecovery,
} from "../kept-input";
import {
  commandOf,
  createTask,
  QUEUED_KINDS,
  reviseTask,
} from "../model/commands";
import {
  CARRIES,
  type Carry,
  PARTICIPATIONS,
  type Participation,
  type TaskPreset,
} from "../model/contract";
import {
  applicable,
  emptyForm,
  type FormErrors,
  type FormField,
  fromDefinition,
  type GoalKind,
  type RepeatChoice,
  repeatFamily,
  type TaskFormState,
  visibleFields,
} from "../model/form";
import { occurrenceId, progressId } from "../model/ids";
import {
  decodeTaskFormInput,
  encodeTaskFormInput,
  taskFormContext,
} from "../model/recovery";
import { addDays, firstSlot, todayIn } from "../model/time";
import { editable } from "../reasons";
import { TODAY_TITLE } from "../titles";
import { knownZones } from "../today/TodayPage";
import { PresetPicker } from "./PresetPicker";

export const FORM_COPY = {
  newTitle: "New task",
  editTitle: "Edit task",
  name: "Name",
  repeats: "Repeats",
  repeat: {
    none: "Doesn't repeat",
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    yearly: "Yearly",
    after_completion: "After it's done",
  } as Record<RepeatChoice, string>,
  interval: "Every how many",
  monthEnd:
    "A monthly or yearly task that starts on the 29th, 30th or 31st only happens in months that have that day.",
  starting: "Starting",
  startingHint: "Leave empty for a one-off with no date.",
  time: "Time of day",
  timeHint: "Leave empty for any time that day.",
  zone: "Time zone",
  open: "You can start it (days before)",
  close: "It stays open for (days)",
  done: "What counts as done",
  goal: {
    checkbox: "A tick",
    numeric: "An amount",
    checklist: "A checklist",
  } as Record<GoalKind, string>,
  minimum: "At least",
  maximum: "At most",
  unit: "Unit",
  item: (n: number) => `Item ${n}`,
  addItem: "Add an item",
  removeItem: (n: number) => `Remove item ${n}`,
  when: "When",
  carry: "If a day gets missed",
  who: "Who takes part",
  exclusions: "Let people skip a day without breaking their streak",
  sharing: "Who gets this task",
  sharingDefaults: (summary: string) => `Use my defaults (${summary})`,
  sharingDefaultsUnknown: "Use my defaults",
  sharingOnlyMe: "Only me",
  sharingLater: "To choose people, save first, then use Sharing on the task.",
  /** One line under each goal kind (the Final design's choice cards, 8 November 2026; provisional). */
  goalLine: {
    checkbox: "Tick it off when it's done.",
    numeric: "Log an amount, with a minimum or a maximum.",
    checklist: "Tick off each item on the day.",
  } as Record<GoalKind, string>,
  locked: "Switching to a one-off needs a new task",
  lockedWho: "Changing who takes part needs a new task",
  save: "Save",
  cancel: "Cancel",
  /** The Final design (8 November 2026): the task's page in edit mode. */
  namePlaceholder: "What needs doing",
  lead: "Give it a name. Everything else is set below, and can change later.",
  draftKept: "Draft kept if you click away",
  facts: {
    when: "When",
    who: "Who",
    done: "Done when",
    missed: "If missed",
    seenBy: "Seen by",
    noDate: "No date",
    anyTime: "any time",
  },
  quickDate: { today: "Today", tomorrow: "Tomorrow", none: "No date" },
  saved: "Saved on this device. Not sent yet.",
  reviewNeeded:
    "Saved. Review who gets this task in the sync queue before it's sent.",
  newerEdits: "Saved. Your newer changes are still here.",
  retargeted: "This change can't be made until the task has been sent.",
  wait: "Wait for this task to finish syncing before editing it.",
  denied: "You can't edit this task. What you typed is kept here.",
  changedElsewhere:
    "This task's unsent change was edited somewhere else. What you typed is kept here: check it, then save again.",
} as const;

type Mode = { kind: "new" } | { kind: "edit"; taskId: string };

/** The form drawn in a container beside or over another page (Settings · Layout): where its Cancel and its save lead. */
export interface Embedded {
  onClose(): void;
  onSaved(taskId: string): void;
}

/** WF-TASK-02 (create and revise), with the preset picker for a new task. */
export function TaskFormPage({
  mode,
  embedded,
}: {
  mode: Mode;
  embedded?: Embedded;
}) {
  if (mode.kind === "edit")
    return (
      <EditTask taskId={mode.taskId} {...(embedded ? { embedded } : {})} />
    );
  return <NewTask {...(embedded ? { embedded } : {})} />;
}

/** The new-task form's editor (R33): one per identity. Its picker's choice is kept apart, until a stage is chosen. */
const NEW_FORM = "task-form:new";
const NEW_PICK = "task-form:new:preset";

/**
 * Revision 37 (WEB-14a R40): the task form's input is recoverable around an app-update reload (Q4), as one versioned text of its editing
 * session (`model/recovery.ts`), under a context of the editor and its target (the new task's, or the task edited).
 */
const formRecovery = (context: string): KeptRecovery<FormInput> => ({
  context,
  encode: encodeTaskFormInput,
  decode: decodeTaskFormInput,
});

function NewTask({ embedded }: { embedded?: Embedded }) {
  const env = useTasksEnv();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const navigate = useNavigate();
  // A form kept through a visit to the sync screens is the stage the person had reached: it resumes, never the picker again (R33).
  const [stage, setStage] = useState<
    "pick" | "kept" | { preset: TaskPreset | null }
  >(() =>
    keptEntry(keptKey(env.identity, NEW_FORM)) === null ? "pick" : "kept",
  );
  const base = useMemo(
    () => emptyForm(zone, todayIn(zone, env.now())),
    [zone, env],
  );
  // Revision 37 (R40): the form opens only once a stage is chosen, so this screen looks for what the page before an update left to it:
  // a copy restored is the stage the person had reached (the form, with its input), never the picker again; nothing is submitted.
  const recovered = useKeptRecovery<FormInput>(
    keptKey(env.identity, NEW_FORM),
    env.identity,
    formRecovery(NEW_FORM),
    () => ({ initial: base, state: base }),
    true,
  );
  useEffect(() => {
    if (
      stage === "pick" &&
      recovered.restored !== null &&
      keptEntry(keptKey(env.identity, NEW_FORM)) !== null
    )
      setStage("kept");
  }, [stage, recovered.restored, env.identity]);
  if (stage === "pick")
    return (
      <>
        <PageHeading>{FORM_COPY.newTitle}</PageHeading>
        <PresetPicker
          zone={zone}
          keptAs={keptKey(env.identity, NEW_PICK)}
          onUse={(preset) => setStage({ preset })}
          onScratch={() => setStage({ preset: null })}
          onClose={() =>
            embedded
              ? embedded.onClose()
              : void navigate({ to: "/tasks", search: {} })
          }
        />
      </>
    );
  const initial =
    stage === "kept" || stage.preset === null
      ? base
      : fromDefinition(stage.preset.title, stage.preset.definition, base);
  return (
    <TaskForm
      initial={initial}
      mode={{ kind: "new" }}
      {...(embedded ? { embedded } : {})}
    />
  );
}

/**
 * The task being edited, from the detail's certified read (R9, revision 4): a read that failed or kept changing says so with Try again
 * (never "not available"), a COMPLETE read that holds no task says it is not on this device, and a later failed refresh keeps the form that
 * is open (with what was typed), saying it is stale.
 */
function EditTask({
  taskId,
  embedded,
}: {
  taskId: string;
  embedded?: Embedded;
}) {
  const view = useTaskDetail(taskId, undefined);
  // The edit's write target (a queued create or revise to edit in place) is read before the form shows, so Save is never offered, or
  // withheld, on a queue that is still loading; the form keeps its own block when it cannot be read.
  const outstanding = useAllOutstandingByKind(QUEUED_KINDS);
  const env = useTasksEnv();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const notice =
    view.readError === null ? null : (
      <div
        className="flex flex-col gap-2"
        data-task-edit-error={view.readError}
      >
        <p className="text-sm text-muted-foreground">
          {view.readError === "unstable"
            ? copy.LOCAL_UNSTABLE
            : copy.LOCAL_FAILED}
          {view.status === "ready" ? ` ${copy.SHOWING_LAST_READ}` : ""}
        </p>
        <span>
          <Button onClick={view.retry}>{copy.TRY_AGAIN}</Button>
        </span>
      </div>
    );
  if (view.status === "loading" || outstanding.status === "loading")
    return <p className="text-sm text-muted-foreground">{copy.LOADING}</p>;
  if (view.status === "error") return notice;
  if (view.task === null)
    return (
      <p className="text-sm text-muted-foreground">{DETAIL_COPY.absent}</p>
    );
  if (view.definition === null || view.execution === null)
    return <p className="text-sm text-muted-foreground">{copy.NO_DATABASE}</p>;
  const initial = fromDefinition(
    view.task.label,
    view.definition,
    emptyForm(zone, todayIn(zone, env.now())),
  );
  return (
    <>
      {notice}
      <TaskForm
        initial={initial}
        outstanding={outstanding}
        {...(embedded ? { embedded } : {})}
        mode={{
          kind: "edit",
          taskId,
          executionId: view.execution.id,
          policyVersion: view.task.policy_version,
          synced: view.synced,
          editable: editable(view.task, view.execution),
        }}
      />
    </>
  );
}

type FormMode =
  | { kind: "new" }
  | {
      kind: "edit";
      taskId: string;
      executionId: string;
      policyVersion: number | undefined;
      synced: boolean;
      /** Both the task and its details may be changed by me, as this device last read them (R29). */
      editable: boolean;
    };

/** A form's editing session (R33): the values it began from (a locked choice is judged against them) and what is typed now. */
interface FormInput {
  initial: TaskFormState;
  state: TaskFormState;
}

const select = inputClass;

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Union of the review kinds a draft is blocked for and the ones a new capture needs: an edit never clears a review (D-10a-13). */
const widened = (
  draft: DraftWithCommand,
  request: EnqueueRequest,
): EnqueueRequest => ({
  ...request,
  build: (bases) => {
    const built = request.build(bases);
    return {
      ...built,
      defaultsReview: [
        ...new Set([
          ...(draft.review_block?.kinds ?? []),
          ...(built.defaultsReview ?? []),
        ]),
      ],
    };
  },
});

function TaskForm({
  initial,
  mode,
  outstanding,
  embedded,
}: {
  initial: TaskFormState;
  mode: FormMode;
  /** The queue an edit saves into (edit only). */
  outstanding?: Loadable<{ drafts: DraftWithCommand[] }>;
  embedded?: Embedded;
}) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const actions = useTaskActions();
  const defaults = useSharingDefaults();
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // What was typed is the editing session's (revision 18, R33; `kept-input.ts`), not this mount's: a visit to the sync screens keeps it,
  // whole and raw, and coming back shows it again, as is the new form's stage. Every edit moves the session's revision; a save consumes the
  // session, and closes the form onto its task, only if nothing was typed after what it submitted, and only the form mounted then (if
  // any) moves: a save that completes after the person left never navigates them away from where they are now (revision 2), even while
  // the form they left is still being removed, and at the sync screens too (revision 23, R35: `consumed` is told only to a form the
  // person is still at; the save is consumed either way).
  const kept = useKeptInput<FormInput>(
    keptKey(
      env.identity,
      mode.kind === "new" ? NEW_FORM : taskFormContext(mode.taskId),
    ),
    env.identity,
    () => ({ initial, state: initial }),
    {
      consumed: (_, taskId) => {
        if (taskId !== null) {
          if (embedded) embedded.onSaved(taskId);
          else
            void navigate({
              to: "/tasks/$taskId",
              params: { taskId },
              search: {},
            });
        }
        return null;
      },
      unedited: mode.kind === "new",
      recover: formRecovery(
        mode.kind === "new" ? NEW_FORM : taskFormContext(mode.taskId),
      ),
      // A date or time field partly typed has no value the session can hold: unfinished, never saved as empty (R40).
      unfinished: () =>
        Array.from(formRef.current?.querySelectorAll("input") ?? []).some(
          (input) => input.validity?.badInput === true,
        ),
    },
  );
  const { state } = kept.value;
  const recovery = kept.recovery;
  const locked = recovery?.locked === true;
  const [errors, setErrors] = useState<FormErrors>({});
  const { note: notice, setNote: setNotice, busy } = kept;
  const id = useId();
  const zones = useMemo(knownZones, []);
  const show = visibleFields(state);
  const set = (patch: Partial<TaskFormState>) =>
    kept.edit((input) => ({ ...input, state: { ...input.state, ...patch } }));
  const fid = (name: string) => `${id}-${name}`;
  const described = (name: FormField, hint = false) => {
    const ids = [
      hint ? `${fid(name)}-hint` : null,
      errors[name] ? `${fid(name)}-error` : null,
    ].filter(Boolean);
    return {
      id: fid(name),
      ...(ids.length > 0 ? { "aria-describedby": ids.join(" ") } : {}),
      ...(errors[name] ? { "aria-invalid": true } : {}),
    };
  };
  const drafts =
    outstanding?.status === "ready" ? outstanding.value.drafts : [];
  const editing = mode.kind === "edit";
  const queuedCreate =
    mode.kind === "edit"
      ? drafts.find(
          (d) =>
            d.kind === "create_task" &&
            d.status === "queued" &&
            d.target_resource_ids[0] === mode.taskId,
        )
      : undefined;
  const queuedRevise =
    mode.kind === "edit"
      ? drafts.find(
          (d) =>
            d.kind === "revise_task" &&
            d.status === "queued" &&
            d.attempts === 0 &&
            d.target_resource_ids[0] === mode.taskId,
        )
      : undefined;
  // An edit saves into the queued create or revise when there is one, so it needs the whole queue read: until then (or when it could not be
  // read) the target is unknown and nothing is saved (R9, revision 3; Q17: never a stale write target).
  const queueUnread =
    mode.kind === "edit" &&
    !(
      outstanding?.status === "ready" ||
      (outstanding?.status === "unavailable" && outstanding.reason === "absent")
    );
  const queueFailed =
    queueUnread &&
    outstanding?.status === "unavailable" &&
    outstanding.reason !== "absent";
  // A known denial withholds every save of an edit, a coalescing one included (R29): what was typed stays in the form.
  const denied = mode.kind === "edit" && !mode.editable;
  const canSave =
    !queueUnread &&
    !denied &&
    (mode.kind === "new" ||
      queuedCreate !== undefined ||
      (mode.synced && mode.policyVersion !== undefined));
  const defaultsSummary =
    defaults.record === null
      ? FORM_COPY.sharingDefaultsUnknown
      : FORM_COPY.sharingDefaults(
          defaults.record.snapshot.defaults.task.kind === "private"
            ? "only you"
            : defaults.record.snapshot.defaults.task.kind ===
                "primary_household"
              ? "your household"
              : "the people you chose",
        );

  const save = async () => {
    // Every route into a save (the button, Enter's implicit submission) is admitted here, by this render's facts, not only by the
    // button's state (R29).
    if (!canSave) return;
    const result = applicable(state);
    if (!result.ok) {
      setErrors(result.errors);
      setNotice(null);
      return;
    }
    setErrors({});
    const ticket = kept.submit();
    if (ticket === null) return;
    let ok = false;
    let note: string | null = null;
    let taskId: string | null = null;
    try {
      let request: EnqueueRequest;
      if (mode.kind === "new" || queuedCreate !== undefined) {
        // Ids before enqueue (§4.3): task and details are new UUIDs; the first occurrence and my progress are deterministic.
        const original =
          queuedCreate === undefined ? null : commandOf(queuedCreate);
        taskId = mode.kind === "edit" ? mode.taskId : env.newId();
        const executionId =
          original !== null && typeof original.execution_id === "string"
            ? original.execution_id
            : env.newId();
        const slot = firstSlot(result.definition, env.now());
        const occurrence =
          slot === null ? null : await occurrenceId(taskId, slot.key);
        const progress =
          occurrence === null
            ? null
            : await progressId(occurrence, env.accountId);
        const sharing =
          original !== null && original.initial_policy !== undefined
            ? "only_me"
            : state.sharing;
        request = createTask({
          taskId,
          executionId,
          occurrenceId: occurrence,
          progressId: progress,
          title: result.title,
          definition: result.definition,
          sharing: mode.kind === "new" ? state.sharing : sharing,
          defaults: defaults.record,
        });
      } else {
        taskId = mode.taskId;
        request = reviseTask({
          taskId: mode.taskId,
          executionId: mode.executionId,
          title: result.title,
          definition: result.definition,
          policyVersion: mode.policyVersion as number,
        });
      }
      const coalesce = queuedCreate ?? queuedRevise;
      let review = false;
      if (coalesce !== undefined) {
        const outbox = data.outbox();
        // The edit is made only to the queued change this form was shown (S6): another tab's edit of it, committed in between, is never
        // overwritten from this older view, and a known denial is checked in the same transaction (R29/DA-A2).
        const edited = outbox
          ? await outbox.editQueued(coalesce.local_id, {
              ...widened(coalesce, request),
              expectDraft: (now) =>
                now.local_id === coalesce.local_id &&
                now.status === coalesce.status &&
                now.command_digest === coalesce.command_digest,
            })
          : null;
        if (edited?.kind === "edited") ok = true;
        else
          note =
            edited?.kind === "refused" && edited.reason === "retargeted"
              ? FORM_COPY.retargeted
              : edited?.kind === "refused" && edited.reason === "denied"
                ? FORM_COPY.denied
                : edited?.kind === "refused" &&
                    edited.reason === "draft_changed"
                  ? FORM_COPY.changedElsewhere
                  : (copy.refusalMessage(
                      edited?.kind === "refused" ? edited.reason : "storage",
                    ) ?? null);
      } else {
        // A create captured from defaults this device never fetched is held for review in the queue (WEB-12a).
        review = mode.kind === "new" && defaults.record === null;
        const saved = await actions.enqueue(
          request,
          review ? FORM_COPY.reviewNeeded : FORM_COPY.saved,
        );
        ok = saved.ok;
        if (!saved.ok) note = saved.message;
      }
    } finally {
      // The owner decides (R33): it consumes only this exact session and revision (the form then closes onto its task), and otherwise
      // keeps the newer input, or the refused one, with what to say.
      completeKept(ticket, ok, {
        note: ok ? FORM_COPY.newerEdits : note,
        detail: taskId,
      });
    }
  };

  const lockedRepeat = editing;
  // The Final design (8 November 2026): the form is the task's page in edit mode. The name is the large title, the facts strip shows
  // each choice as a cell that leads to its section, the save row sits under the strip (and at the bottom of the phone's viewport), and
  // every field lives in a section of one grouped box, so nothing a reader or a test looks for is behind a popover.
  const sections = useRef<Record<string, HTMLElement | null>>({});
  const jump = (key: string) => {
    const section = sections.current[key];
    if (!section) return;
    section.scrollIntoView?.({ block: "start" });
    const field = section.querySelector<HTMLElement>(
      "input:not([type=hidden]):not(:disabled), select:not(:disabled), button:not(:disabled)",
    );
    field?.focus();
  };
  const whenValue =
    state.startDate.trim() === ""
      ? FORM_COPY.facts.noDate
      : `${dayLabel(state.startDate)} · ${state.time.trim() === "" ? FORM_COPY.facts.anyTime : state.time}`;
  const repeatValue =
    state.repeat === "none"
      ? FORM_COPY.repeat.none
      : state.interval.trim() === "1" || state.interval.trim() === ""
        ? FORM_COPY.repeat[state.repeat]
        : `${FORM_COPY.repeat[state.repeat]} · ${copy.CADENCE({ frequency: state.repeat, interval: Number(state.interval) || 1 })}`;
  const saveButton = !env.writable ? (
    <Button disabled reason={copy.NOT_WRITABLE}>
      {FORM_COPY.save}
    </Button>
  ) : denied ? (
    <Button disabled reason={FORM_COPY.denied}>
      {FORM_COPY.save}
    </Button>
  ) : !canSave ? (
    <Button disabled reason={queueFailed ? copy.LOCAL_FAILED : FORM_COPY.wait}>
      {FORM_COPY.save}
    </Button>
  ) : busy ? (
    <Button disabled reason={copy.SAVING}>
      {FORM_COPY.save}
    </Button>
  ) : (
    <Button variant="default" type="submit" className="px-5">
      {FORM_COPY.save}
    </Button>
  );
  const cancel = () =>
    // Cancel leaves for the task (or the list), which discards what was typed; a save already made stays queued.
    embedded
      ? embedded.onClose()
      : void (mode.kind === "edit"
          ? navigate({
              to: "/tasks/$taskId",
              params: { taskId: mode.taskId },
              search: {},
            })
          : navigate({ to: "/tasks", search: {} }));
  const section = (
    key: string,
    heading: string,
    summary: string,
    children: ReactNode,
    attrs: Record<`data-${string}`, string | undefined> = {},
  ) => (
    <GroupedSection
      {...attrs}
      sectionRef={(node) => {
        sections.current[key] = node;
      }}
      aria-labelledby={fid(`${key}-heading`)}
      summary={summary}
      heading={<h2 id={fid(`${key}-heading`)}>{heading}</h2>}
    >
      {children}
    </GroupedSection>
  );
  return (
    <form
      ref={formRef}
      className="atlas-enter flex min-w-0 flex-col gap-5"
      data-task-form={mode.kind}
      data-recovery-ready={recovery?.view.ready === false ? "false" : "true"}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {embedded ? null : (
        <Breadcrumb
          items={[{ label: TODAY_TITLE, to: "/today" }]}
          current={editing ? FORM_COPY.editTitle : FORM_COPY.newTitle}
        />
      )}
      <PageHeading as={embedded ? "h2" : "h1"} eyebrow>
        {editing ? FORM_COPY.editTitle : FORM_COPY.newTitle}
      </PageHeading>
      {recovery ? (
        <RecoveryNotice recovery={recovery} firstFieldRef={nameRef} />
      ) : null}
      {/* Held while an update reload is prepared (R40): nothing is typed or saved after the last save. */}
      <fieldset
        disabled={busy || locked}
        className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0"
      >
        <div className="flex items-start gap-4" data-form-header="">
          <span
            aria-hidden="true"
            className="mt-2 flex size-10 flex-none rounded-full border-2 border-dashed border-input"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <label htmlFor={fid("title")} className="sr-only">
              {FORM_COPY.name}
            </label>
            <input
              ref={nameRef}
              {...described("title")}
              value={state.title}
              placeholder={FORM_COPY.namePlaceholder}
              data-field-edge=""
              className="w-full min-w-0 rounded-sm border-0 bg-transparent p-0 text-[28px] font-semibold leading-[1.15] tracking-[-0.03em] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring tablet:text-[40px]"
              onChange={(e) => set({ title: e.target.value })}
            />
            {errors.title ? (
              <p
                id={`${fid("title")}-error`}
                className="text-xs text-destructive"
              >
                {errors.title}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{FORM_COPY.lead}</p>
            )}
          </div>
        </div>
        <FactsStrip data-form-facts="">
          <FactCell
            as="button"
            label={FORM_COPY.facts.when}
            data-fact="when"
            onClick={() => jump("when")}
          >
            <span className="font-num">{whenValue}</span>
          </FactCell>
          <FactCell
            as="button"
            label={FORM_COPY.repeats}
            data-fact="repeats"
            onClick={() => jump("when")}
          >
            <span>{repeatValue}</span>
          </FactCell>
          <FactCell
            as="button"
            label={FORM_COPY.facts.who}
            data-fact="who"
            onClick={() => jump("who")}
          >
            <span>{copy.PARTICIPATION[state.participation]}</span>
          </FactCell>
          <FactCell
            as="button"
            label={FORM_COPY.facts.done}
            data-fact="goal"
            onClick={() => jump("goal")}
          >
            <span>{FORM_COPY.goal[state.goalKind]}</span>
          </FactCell>
          <FactCell
            as="button"
            label={FORM_COPY.facts.missed}
            data-fact="carry"
            onClick={() => jump("carry")}
          >
            <span>{copy.CARRY[state.carry].label}</span>
          </FactCell>
          {mode.kind === "new" ? (
            <FactCell
              as="button"
              label={FORM_COPY.facts.seenBy}
              data-fact="sharing"
              onClick={() => jump("sharing")}
            >
              <span>
                {state.sharing === "only_me"
                  ? FORM_COPY.sharingOnlyMe
                  : defaultsSummary}
              </span>
            </FactCell>
          ) : null}
        </FactsStrip>
        {errors.definition ? (
          <p className="text-xs text-destructive">{errors.definition}</p>
        ) : null}
        {notice ? (
          <p className="text-sm text-foreground" data-form-notice="">
            {notice}
          </p>
        ) : null}
        {/* The save row under the strip (the Final design); on the phone it stays in reach at the bottom of the viewport. */}
        <div
          className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center gap-2 border-t border-border/70 bg-background/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur tablet:static tablet:mx-0 tablet:border-0 tablet:bg-transparent tablet:p-0 tablet:backdrop-blur-none"
          data-form-actions=""
        >
          {saveButton}
          <Button variant="ghost" onClick={cancel}>
            {FORM_COPY.cancel}
          </Button>
          <span className="ml-auto hidden text-xs text-muted-foreground tablet:inline">
            {FORM_COPY.draftKept}
          </span>
        </div>
        <GroupedBox data-form-sections="">
          {section(
            "when",
            FORM_COPY.when,
            `${whenValue} · ${repeatValue}`,
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-1.5" data-form-quick="date">
                {(["today", "tomorrow", "none"] as const).map((quick) => {
                  const value =
                    quick === "none"
                      ? ""
                      : quick === "today"
                        ? todayIn(state.timezone, env.now())
                        : addDays(todayIn(state.timezone, env.now()), 1);
                  return (
                    <Pill
                      key={quick}
                      pressed={state.startDate === value}
                      onClick={() => set({ startDate: value })}
                    >
                      {FORM_COPY.quickDate[quick]}
                    </Pill>
                  );
                })}
              </div>
              <div className="grid gap-3 tablet:grid-cols-2">
                <Field
                  id={fid("repeat")}
                  label={FORM_COPY.repeats}
                  hint={lockedRepeat ? FORM_COPY.locked : FORM_COPY.monthEnd}
                >
                  <NativeSelect
                    id={fid("repeat")}
                    aria-describedby={`${fid("repeat")}-hint`}
                    value={state.repeat}
                    onChange={(e) =>
                      set({ repeat: e.target.value as RepeatChoice })
                    }
                  >
                    {(Object.keys(FORM_COPY.repeat) as RepeatChoice[])
                      .filter(
                        (r) =>
                          !lockedRepeat ||
                          repeatFamily(r) ===
                            repeatFamily(kept.value.initial.repeat),
                      )
                      .map((r) => (
                        <option key={r} value={r}>
                          {FORM_COPY.repeat[r]}
                        </option>
                      ))}
                  </NativeSelect>
                </Field>
                {show.interval ? (
                  <Field
                    id={fid("interval")}
                    label={FORM_COPY.interval}
                    error={errors.interval}
                  >
                    <input
                      {...described("interval")}
                      inputMode="numeric"
                      value={state.interval}
                      data-field-edge=""
                      className={select}
                      onChange={(e) => set({ interval: e.target.value })}
                    />
                  </Field>
                ) : null}
                <Field
                  id={fid("startDate")}
                  label={FORM_COPY.starting}
                  hint={FORM_COPY.startingHint}
                  error={errors.startDate}
                >
                  <input
                    {...described("startDate", true)}
                    type="date"
                    value={state.startDate}
                    data-field-edge=""
                    className={select}
                    onChange={(e) => set({ startDate: e.target.value })}
                  />
                </Field>
                {show.time ? (
                  <Field
                    id={fid("time")}
                    label={FORM_COPY.time}
                    hint={FORM_COPY.timeHint}
                    error={errors.time}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input
                        {...described("time", true)}
                        type="time"
                        value={state.time}
                        data-field-edge=""
                        className={cn(select, "w-auto flex-none")}
                        // The person's own edit of the time: from now on the minute shown is what is sent (R31).
                        onChange={(e) =>
                          set({
                            time: e.target.value,
                            keptTime: null,
                            timeUnconfirmed: false,
                          })
                        }
                      />
                      {(["", "09:00", "18:00"] as const).map((quick) => (
                        <Pill
                          key={quick || "any"}
                          pressed={state.time === quick}
                          onClick={() =>
                            set({
                              time: quick,
                              keptTime: null,
                              timeUnconfirmed: false,
                            })
                          }
                        >
                          {quick === "" ? FORM_COPY.facts.anyTime : quick}
                        </Pill>
                      ))}
                    </div>
                  </Field>
                ) : null}
                <Field
                  id={fid("timezone")}
                  label={FORM_COPY.zone}
                  error={errors.timezone}
                >
                  <NativeSelect
                    {...described("timezone")}
                    value={state.timezone}
                    onChange={(e) => set({ timezone: e.target.value })}
                  >
                    {(zones.includes(state.timezone)
                      ? zones
                      : [state.timezone, ...zones]
                    ).map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field
                  id={fid("openDaysBefore")}
                  label={FORM_COPY.open}
                  error={errors.openDaysBefore}
                >
                  <input
                    {...described("openDaysBefore")}
                    inputMode="numeric"
                    value={state.openDaysBefore}
                    data-field-edge=""
                    className={select}
                    onChange={(e) => set({ openDaysBefore: e.target.value })}
                  />
                </Field>
                <Field
                  id={fid("closeDaysAfter")}
                  label={FORM_COPY.close}
                  error={errors.closeDaysAfter}
                >
                  <input
                    {...described("closeDaysAfter")}
                    inputMode="numeric"
                    value={state.closeDaysAfter}
                    data-field-edge=""
                    className={select}
                    onChange={(e) => set({ closeDaysAfter: e.target.value })}
                  />
                </Field>
              </div>
            </div>,
          )}
          {section(
            "goal",
            FORM_COPY.done,
            FORM_COPY.goal[state.goalKind],
            <div className="flex flex-col gap-4">
              <ChoiceCards
                legend={FORM_COPY.done}
                legendHidden
                name={fid("goal")}
                value={state.goalKind}
                onChange={(goalKind) => set({ goalKind })}
                columns={3}
                options={(["checkbox", "numeric", "checklist"] as const).map(
                  (kind) => ({
                    value: kind,
                    label: FORM_COPY.goal[kind],
                    description: FORM_COPY.goalLine[kind],
                  }),
                )}
              />
              {show.numeric ? (
                <div className="grid gap-3 tablet:grid-cols-3">
                  <Field
                    id={fid("minimum")}
                    label={FORM_COPY.minimum}
                    error={errors.minimum}
                  >
                    <input
                      {...described("minimum")}
                      inputMode="decimal"
                      value={state.minimum}
                      data-field-edge=""
                      className={select}
                      onChange={(e) => set({ minimum: e.target.value })}
                    />
                  </Field>
                  <Field
                    id={fid("maximum")}
                    label={FORM_COPY.maximum}
                    error={errors.maximum}
                  >
                    <input
                      {...described("maximum")}
                      inputMode="decimal"
                      value={state.maximum}
                      data-field-edge=""
                      className={select}
                      onChange={(e) => set({ maximum: e.target.value })}
                    />
                  </Field>
                  <Field
                    id={fid("unit")}
                    label={FORM_COPY.unit}
                    error={errors.unit}
                  >
                    <input
                      {...described("unit")}
                      value={state.unit}
                      data-field-edge=""
                      className={select}
                      onChange={(e) => set({ unit: e.target.value })}
                    />
                  </Field>
                </div>
              ) : null}
              {show.checklist ? (
                <div className="flex flex-col gap-2" data-checklist-items="">
                  {state.checklist.map((item, index) => (
                    <div key={item.id} className="flex items-end gap-2">
                      <div className="flex-1">
                        <Input
                          label={FORM_COPY.item(index + 1)}
                          value={item.label}
                          onChange={(e) =>
                            set({
                              checklist: state.checklist.map((i) =>
                                i.id === item.id
                                  ? { ...i, label: e.target.value }
                                  : i,
                              ),
                            })
                          }
                        />
                      </div>
                      <Button
                        variant="ghost"
                        aria-label={FORM_COPY.removeItem(index + 1)}
                        onClick={() =>
                          set({
                            checklist: state.checklist.filter(
                              (i) => i.id !== item.id,
                            ),
                          })
                        }
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                  {state.checklist.length < 100 ? (
                    <span>
                      <Button
                        onClick={() =>
                          set({
                            checklist: [
                              ...state.checklist,
                              { id: env.newId(), label: "" },
                            ],
                          })
                        }
                      >
                        {FORM_COPY.addItem}
                      </Button>
                    </span>
                  ) : null}
                  {errors.checklist ? (
                    <p className="text-xs text-destructive">
                      {errors.checklist}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>,
            { "data-form-section": "goal" },
          )}
          {section(
            "carry",
            FORM_COPY.carry,
            copy.CARRY[state.carry].label,
            <ChoiceCards
              legend={FORM_COPY.carry}
              legendHidden
              name={fid("carry")}
              value={state.carry}
              onChange={(carry) => set({ carry })}
              columns={3}
              options={CARRIES.map((carry: Carry) => ({
                value: carry,
                label: copy.CARRY[carry].label,
                description: copy.CARRY[carry].line,
              }))}
            />,
            { "data-form-section": "carry" },
          )}
          {section(
            "who",
            FORM_COPY.who,
            copy.PARTICIPATION[state.participation],
            <div className="flex flex-col gap-3">
              <ChoiceCards
                legend={FORM_COPY.who}
                legendHidden
                name={fid("who")}
                value={state.participation}
                onChange={(participation) => set({ participation })}
                columns={2}
                options={PARTICIPATIONS.filter(
                  (p) => !editing || p === initial.participation,
                ).map((p: Participation) => ({
                  value: p,
                  label: copy.PARTICIPATION[p],
                  description: copy.PARTICIPATION_LINE[p],
                }))}
                {...(editing ? { locked: FORM_COPY.lockedWho } : {})}
                {...(errors.participation
                  ? {
                      error: errors.participation,
                      errorId: fid("participation-error"),
                    }
                  : {})}
              />
              <label className="flex min-h-11 items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={state.allowExclusions}
                  onChange={() =>
                    set({ allowExclusions: !state.allowExclusions })
                  }
                  className="size-4"
                />
                {FORM_COPY.exclusions}
              </label>
            </div>,
            { "data-form-section": "who" },
          )}
          {mode.kind === "new"
            ? section(
                "sharing",
                FORM_COPY.sharing,
                state.sharing === "only_me"
                  ? FORM_COPY.sharingOnlyMe
                  : defaultsSummary,
                <ChoiceCards
                  legend={FORM_COPY.sharing}
                  legendHidden
                  name={fid("sharing")}
                  value={state.sharing}
                  onChange={(sharing) => set({ sharing })}
                  columns={2}
                  options={[
                    { value: "defaults" as const, label: defaultsSummary },
                    {
                      value: "only_me" as const,
                      label: FORM_COPY.sharingOnlyMe,
                    },
                  ]}
                  hint={FORM_COPY.sharingLater}
                />,
                { "data-form-section": "sharing" },
              )
            : null}
        </GroupedBox>
      </fieldset>
    </form>
  );
}
