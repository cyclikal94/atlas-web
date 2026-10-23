import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { PageHeading } from "../../../components/ui/page-heading";
import {
  type DraftWithCommand,
  type EnqueueRequest,
  type Loadable,
  useAllOutstandingByKind,
  useDataEnv,
  useSharingDefaults,
} from "../../../data";
import { useTaskActions } from "../actions";
import * as copy from "../copy";
import { DETAIL_COPY } from "../detail/TaskDetail";
import { useTaskDetail } from "../detail/useTaskDetail";
import { useTasksEnv } from "../env";
import { completeKept, keptEntry, keptKey, useKeptInput } from "../kept-input";
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
import { taskFormContext } from "../model/recovery";
import { firstSlot, todayIn } from "../model/time";
import { editable } from "../reasons";
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
  carry: "If a day gets missed",
  who: "Who takes part",
  exclusions: "Let people skip a day without breaking their streak",
  sharing: "Who gets this task",
  sharingDefaults: (summary: string) => `Use my defaults (${summary})`,
  sharingDefaultsUnknown: "Use my defaults",
  sharingOnlyMe: "Only me",
  sharingLater: "To choose people, save first, then use Sharing on the task.",
  locked: "Locked — switching to a one-off needs a new task",
  lockedWho: "Locked — changing who takes part needs a new task",
  save: "Save",
  cancel: "Cancel",
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

/** WF-TASK-02 (create and revise), with the preset picker for a new task. */
export function TaskFormPage({ mode }: { mode: Mode }) {
  if (mode.kind === "edit") return <EditTask taskId={mode.taskId} />;
  return <NewTask />;
}

/** The new-task form's editor (R33): one per identity. Its picker's choice is kept apart, until a stage is chosen. */
const NEW_FORM = "task-form:new";
const NEW_PICK = "task-form:new:preset";

function NewTask() {
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
  if (stage === "pick")
    return (
      <>
        <PageHeading>{FORM_COPY.newTitle}</PageHeading>
        <PresetPicker
          zone={zone}
          keptAs={keptKey(env.identity, NEW_PICK)}
          onUse={(preset) => setStage({ preset })}
          onScratch={() => setStage({ preset: null })}
          onClose={() => void navigate({ to: "/tasks", search: {} })}
        />
      </>
    );
  const initial =
    stage === "kept" || stage.preset === null
      ? base
      : fromDefinition(stage.preset.title, stage.preset.definition, base);
  return <TaskForm initial={initial} mode={{ kind: "new" }} />;
}

/**
 * The task being edited, from the detail's certified read (R9, revision 4): a read that failed or kept changing says so with Try again
 * (never "not available"), a COMPLETE read that holds no task says it is not on this device, and a later failed refresh keeps the form that
 * is open (with what was typed), saying it is stale.
 */
function EditTask({ taskId }: { taskId: string }) {
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
        <p className="text-[13px] text-ink-2">
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
    return <p className="text-[13px] text-ink-2">{copy.LOADING}</p>;
  if (view.status === "error") return notice;
  if (view.task === null)
    return <p className="text-[13px] text-ink-2">{DETAIL_COPY.absent}</p>;
  if (view.definition === null || view.execution === null)
    return <p className="text-[13px] text-ink-2">{copy.NO_DATABASE}</p>;
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

const select =
  "min-h-11 w-full rounded-control border border-field-edge bg-canvas px-3 text-[14px] text-ink-1";

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
      <label htmlFor={id} className="text-[13px] font-medium text-ink-1">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-[12px] text-ink-2">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-[12px] text-conflict-text">
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
}: {
  initial: TaskFormState;
  mode: FormMode;
  /** The queue an edit saves into (edit only). */
  outstanding?: Loadable<{ drafts: DraftWithCommand[] }>;
}) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const actions = useTaskActions();
  const defaults = useSharingDefaults();
  const navigate = useNavigate();
  // What was typed is the editing session's (revision 18, R33; `kept-input.ts`), not this mount's: a visit to the sync screens keeps it,
  // whole and raw, and coming back shows it again, as is the new form's stage. Every edit moves the session's revision; a save consumes the
  // session, and closes the form onto its task, only if nothing was typed after what it submitted, and only the form mounted then (if
  // any) moves: a save that completes after the person left never navigates them away from where they are now (revision 2).
  const kept = useKeptInput<FormInput>(
    keptKey(
      env.identity,
      mode.kind === "new" ? NEW_FORM : taskFormContext(mode.taskId),
    ),
    env.identity,
    () => ({ initial, state: initial }),
    {
      consumed: (_, taskId) => {
        if (taskId !== null)
          void navigate({
            to: "/tasks/$taskId",
            params: { taskId },
            search: {},
          });
        return null;
      },
      unedited: mode.kind === "new",
    },
  );
  const { state } = kept.value;
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
  return (
    <form
      className="flex max-w-[620px] flex-col gap-5"
      data-task-form={mode.kind}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <PageHeading>
        {editing ? FORM_COPY.editTitle : FORM_COPY.newTitle}
      </PageHeading>
      <fieldset disabled={busy} className="flex flex-col gap-5">
        <Field id={fid("title")} label={FORM_COPY.name} error={errors.title}>
          <input
            {...described("title")}
            value={state.title}
            data-field-edge=""
            className={select}
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 tablet:grid-cols-2">
          <Field
            id={fid("repeat")}
            label={FORM_COPY.repeats}
            hint={lockedRepeat ? FORM_COPY.locked : FORM_COPY.monthEnd}
          >
            <select
              id={fid("repeat")}
              aria-describedby={`${fid("repeat")}-hint`}
              value={state.repeat}
              data-field-edge=""
              className={select}
              onChange={(e) => set({ repeat: e.target.value as RepeatChoice })}
            >
              {(Object.keys(FORM_COPY.repeat) as RepeatChoice[])
                .filter(
                  (r) =>
                    !lockedRepeat ||
                    repeatFamily(r) === repeatFamily(kept.value.initial.repeat),
                )
                .map((r) => (
                  <option key={r} value={r}>
                    {FORM_COPY.repeat[r]}
                  </option>
                ))}
            </select>
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
              <input
                {...described("time", true)}
                type="time"
                value={state.time}
                data-field-edge=""
                className={select}
                // The person's own edit of the time: from now on the minute shown is what is sent (R31).
                onChange={(e) =>
                  set({
                    time: e.target.value,
                    keptTime: null,
                    timeUnconfirmed: false,
                  })
                }
              />
            </Field>
          ) : null}
          <Field
            id={fid("timezone")}
            label={FORM_COPY.zone}
            error={errors.timezone}
          >
            <select
              {...described("timezone")}
              value={state.timezone}
              data-field-edge=""
              className={select}
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
            </select>
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
        <fieldset className="flex flex-col gap-2">
          <legend className="text-[13px] font-medium text-ink-1">
            {FORM_COPY.done}
          </legend>
          <div className="flex flex-wrap gap-3">
            {(["checkbox", "numeric", "checklist"] as const).map((kind) => (
              <label
                key={kind}
                className="inline-flex min-h-11 items-center gap-2 text-[13.5px] text-ink-1"
              >
                <input
                  type="radio"
                  name={fid("goal")}
                  checked={state.goalKind === kind}
                  onChange={() => set({ goalKind: kind })}
                  className="size-[15px]"
                />
                {FORM_COPY.goal[kind]}
              </label>
            ))}
          </div>
          {show.numeric ? (
            <div className="grid gap-3 tablet:grid-cols-2">
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
                    variant="quiet"
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
                <p className="text-[12px] text-conflict-text">
                  {errors.checklist}
                </p>
              ) : null}
            </div>
          ) : null}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-[13px] font-medium text-ink-1">
            {FORM_COPY.carry}
          </legend>
          {CARRIES.map((carry: Carry) => (
            <label
              key={carry}
              className="flex min-h-11 items-start gap-2 text-[13.5px] text-ink-1"
            >
              <input
                type="radio"
                name={fid("carry")}
                checked={state.carry === carry}
                onChange={() => set({ carry })}
                className="mt-0.5 size-[15px]"
              />
              <span className="flex flex-col">
                <span>{copy.CARRY[carry].label}</span>{" "}
                <span className="text-[12px] text-ink-2">
                  {copy.CARRY[carry].line}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset
          className="flex flex-col gap-2"
          aria-describedby={
            errors.participation ? fid("participation-error") : undefined
          }
        >
          <legend className="text-[13px] font-medium text-ink-1">
            {FORM_COPY.who}
          </legend>
          {PARTICIPATIONS.filter(
            (p) => !editing || p === initial.participation,
          ).map((p: Participation) => (
            <label
              key={p}
              className="flex min-h-11 items-start gap-2 text-[13.5px] text-ink-1"
            >
              <input
                type="radio"
                name={fid("who")}
                checked={state.participation === p}
                onChange={() => set({ participation: p })}
                className="mt-0.5 size-[15px]"
              />
              <span className="flex flex-col">
                <span>{copy.PARTICIPATION[p]}</span>{" "}
                <span className="text-[12px] text-ink-2">
                  {copy.PARTICIPATION_LINE[p]}
                </span>
              </span>
            </label>
          ))}
          {editing ? (
            <p className="text-[12px] text-ink-2">{FORM_COPY.lockedWho}</p>
          ) : null}
          {errors.participation ? (
            <p
              id={fid("participation-error")}
              className="text-[12px] text-conflict-text"
            >
              {errors.participation}
            </p>
          ) : null}
        </fieldset>
        <label className="flex min-h-11 items-center gap-2 text-[13.5px] text-ink-1">
          <input
            type="checkbox"
            checked={state.allowExclusions}
            onChange={() => set({ allowExclusions: !state.allowExclusions })}
            className="size-[15px]"
          />
          {FORM_COPY.exclusions}
        </label>
        {mode.kind === "new" ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-[13px] font-medium text-ink-1">
              {FORM_COPY.sharing}
            </legend>
            {(["defaults", "only_me"] as const).map((choice) => (
              <label
                key={choice}
                className="inline-flex min-h-11 items-center gap-2 text-[13.5px] text-ink-1"
              >
                <input
                  type="radio"
                  name={fid("sharing")}
                  checked={state.sharing === choice}
                  onChange={() => set({ sharing: choice })}
                  className="size-[15px]"
                />
                {choice === "defaults"
                  ? defaultsSummary
                  : FORM_COPY.sharingOnlyMe}
              </label>
            ))}
            <p className="text-[12px] text-ink-2">{FORM_COPY.sharingLater}</p>
          </fieldset>
        ) : null}
      </fieldset>
      {errors.definition ? (
        <p className="text-[12.5px] text-conflict-text">{errors.definition}</p>
      ) : null}
      {notice ? (
        <p className="text-[13px] text-ink-1" data-form-notice="">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!env.writable ? (
          <Button disabled reason={copy.NOT_WRITABLE}>
            {FORM_COPY.save}
          </Button>
        ) : denied ? (
          <Button disabled reason={FORM_COPY.denied}>
            {FORM_COPY.save}
          </Button>
        ) : !canSave ? (
          <Button
            disabled
            reason={queueFailed ? copy.LOCAL_FAILED : FORM_COPY.wait}
          >
            {FORM_COPY.save}
          </Button>
        ) : busy ? (
          <Button disabled reason={copy.SAVING}>
            {FORM_COPY.save}
          </Button>
        ) : (
          <Button variant="primary" type="submit">
            {FORM_COPY.save}
          </Button>
        )}
        <Button
          variant="quiet"
          onClick={() =>
            // Cancel leaves for the task (or the list), which discards what was typed; a save already made stays queued.
            void (mode.kind === "edit"
              ? navigate({
                  to: "/tasks/$taskId",
                  params: { taskId: mode.taskId },
                  search: {},
                })
              : navigate({ to: "/tasks", search: {} }))
          }
        >
          {FORM_COPY.cancel}
        </Button>
      </div>
    </form>
  );
}
