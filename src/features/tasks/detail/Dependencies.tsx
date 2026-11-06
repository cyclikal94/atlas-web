import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { RadioCardGroup } from "../../../components/ui/radio-card-group";
import {
  type CacheRow,
  type DraftWithCommand,
  readResourcePageNow,
  readResourcesNow,
  useAppliedRevision,
  useCachedResources,
  useDataEnv,
  useDraftWithCommand,
  useSharingDefaults,
} from "../../../data";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { dayLabel } from "../format";
import {
  completeKept,
  type KeptTicket,
  keptKey,
  useKeptInput,
} from "../kept-input";
import {
  commandOf,
  completeDependencies,
  OCCURRENCE_VERSIONED_KINDS,
  setDependencies,
} from "../model/commands";
import {
  type DependencyGraph,
  type DependencyItem,
  type DependencyPreview,
  type Evidence,
  parseEvidence,
  parseOccurrenceData,
} from "../model/contract";
import {
  admittedMode,
  baseMatches,
  baseOf,
  causeOf,
  type EditorBase,
  editorBlock,
  MAX_PREREQUISITES,
  type Mode,
  modesOf,
  pendingVersioned,
  prerequisitesOf,
  progressOf,
  rootAdmitted,
  satisfiedPreview,
  validateList,
} from "../model/dependencies";
import { layer } from "../model/evaluate";
import { indexGraph } from "../model/graph";
import { progressId } from "../model/ids";
import type { RowModel } from "../view";
import {
  DependencyGraphSection,
  GRAPH_COPY,
  nodeLabel,
} from "./DependencyGraph";
import { useDependencyGraph } from "./useDependencyGraph";
import { type PreviewRead, usePreview } from "./usePreview";

/** Provisional copy (STAGED-ACCEPTANCE-20261011; docs/tasks.md WEB-10c checkpoint list). */
export const DEPENDENCY_COPY = {
  heading: "What needs doing first",
  none: "Nothing needs doing first",
  progress: (done: number, total: number, title: string) =>
    `${done} of ${total} done — “${title}” is still open`,
  allDone: "All done",
  see: "See what needs doing first",
  set: "Set what this waits for",
  unavailable: "Some of it is private to someone else.",
  offline: "Can be checked when you're online.",
  failed: "Couldn't show what this waits for",
  refresh: "Refresh",
  loading: "Loading what this waits for",
  notHere: "A task not on this device yet",
  thisTask: "This task",
  done: "Done",
  toDo: "To do",
  cantHere: "You can't tick this off here",
  cantHereWhy: "Only your own tick-box tasks can be ticked off from here.",
  strict: (title: string) =>
    `“${title}” is set to require its prerequisites strictly, so it can't be started early.`,
  hiddenCount: (n: number) =>
    n === 1
      ? "1 item you can't see is private to someone else."
      : "Some items are private to someone else.",
  modesName: "What to do",
  wait: "Wait until everything's done",
  completeAll: "Tick the others off as well",
  startAnyway: "Start anyway",
  completeAllWhy: {
    unavailable:
      "Some of what this waits for is private, so it can't be ticked off from here.",
    cannot_complete: "Some of it can't be ticked off from here.",
    root: "Record this day's progress on its card first.",
  },
  /** Why no mode can complete this day itself (review R15): its progress is not entered, or it can't be ticked off from here. */
  rootWhy: "Record this day's progress on its card first.",
  preview: "This is a preview. Nothing changes until you choose.",
  markDone: "Mark done",
  close: "Cancel",
  sending: "Saving on this device…",
  saved: "Saved. It will be sent when Atlas can.",
  evidenceKept: "What you entered is kept for this day.",
  // Conflicts
  conflictTitle: "This couldn't be completed as sent",
  cause: {
    satisfied: "Everything it waits for is done now.",
    unavailable: "Some of what it waits for is private to someone else now.",
    strict: (title: string) =>
      `“${title}” requires its prerequisites strictly.`,
    cannot_complete: "Something it waits for can't be ticked off from here.",
    changed: "What it waits for changed.",
  },
  checking: "Checking what it waits for…",
  changedWhileSaving:
    "What this waits for changed while saving. Check it and choose again.",
  review: "Review and send again",
  discard: "Discard",
  unmet: (title: string) => `This can't be marked done until “${title}” is.`,
  setConflict: "Couldn't set what this waits for as sent.",
  keepEditing: "Keep editing",
  // Editor
  editorTitle: "Set what this waits for",
  editorLead: (title: string) =>
    `This replaces everything “${title}” waits for.`,
  editorNow: "Now waiting for:",
  editorEmpty: "Nothing yet.",
  remove: "Remove",
  addTask: "Task",
  addDay: "Day",
  add: "Add",
  moreTasks: "More tasks",
  moreDays: "More saved days",
  chooseTask: "Choose a task",
  chooseDay: "Choose a day",
  strictLabel: "Don't allow starting early",
  counter: (n: number) => `${n} of ${MAX_PREREQUISITES}`,
  save: "Save",
  cancel: "Cancel",
  editorUnavailable:
    "Some of what this waits for is private to someone else, so it can't be changed here.",
  editorOffline: "Changing what this waits for needs a connection.",
  editorDenied: "You can't change this day.",
  editorLoading: "Checking what this waits for…",
  errors: {
    too_many: `At most ${MAX_PREREQUISITES} can be chosen.`,
    duplicate: "That day is already in the list.",
    self: "A day can't wait for itself.",
  },
  noDays: "This task has no saved days on this device.",
  undated: "No date",
  // WEB-18 (D-18-7/8): the editor built from the authoritative direct list.
  editorChanged: "What this waits for has changed since you started.",
  editorRestart: "Start again from the current list",
  editorPending:
    "Another change to this day hasn't been sent yet. Try again once it's sent or discarded.",
  editorWaitsNow: "Waits for now:",
} as const;

const DEP_KINDS = new Set(["set_dependencies", "complete_dependencies"]);

/**
 * WEB-18 (D-18-5): what makes a shown graph read again besides opening and "Check again": this device's own drafts of the day settling
 * (any kind: a completion or a correction of the day changes what the graph says) and the account's applied sync revision moving.
 */
function useGraphSettled(row: RowModel): string {
  const revision = useAppliedRevision();
  // The revision this view first knew: its arrival is not a change (a read on opening is asked once, not twice: request cost, item 9).
  const first = useRef<number | null | undefined>(undefined);
  const value = revision.status === "ready" ? revision.value : undefined;
  if (value !== undefined && first.current === undefined) first.current = value;
  const moved =
    value !== undefined && value !== first.current ? String(value) : "";
  return `${row.drafts.map((d) => `${d.local_id}:${d.status}`).join(",")}|${moved}`;
}

/** The labels of preview items from the cache: the task's title and the day's date, never an id. */
function useLabels(
  items: readonly { occurrence_id: string; task_id: string }[],
) {
  const ids = [
    ...new Set(items.flatMap((item) => [item.occurrence_id, item.task_id])),
  ];
  const rows = useCachedResources(ids);
  return (item: { occurrence_id: string; task_id: string }) => {
    const value = rows.status === "ready" ? rows.value : {};
    const task = value[item.task_id]?.merged ?? null;
    const day = value[item.occurrence_id]?.merged ?? null;
    const date = day ? parseOccurrenceData(day.value)?.slot.date : undefined;
    return {
      title: task?.label ?? DEPENDENCY_COPY.notHere,
      day:
        date === undefined
          ? null
          : date === null
            ? DEPENDENCY_COPY.undated
            : dayLabel(date),
    };
  };
}

// ---- the detail's row ----------------------------------------------------------------------------------------------------------------
export interface DependencyState {
  read: PreviewRead;
  /** The number of the read shown, and of the latest asked (`usePreview`). */
  seq: number;
  asked(): number;
  refresh(): Promise<PreviewRead>;
}

/** The day's preview, read again when this device's own dependency drafts of the day are answered. */
export function useDependencies(row: RowModel): DependencyState {
  const settled = row.drafts
    .filter((d) => DEP_KINDS.has(d.kind))
    .map((d) => `${d.local_id}:${d.status}`)
    .join(",");
  return usePreview(row.id, settled);
}

export function DependencyRow({
  row,
  state,
  onSee,
  onSet,
}: {
  row: RowModel;
  state: DependencyState;
  onSee(): void;
  onSet(): void;
}) {
  const env = useTasksEnv();
  const heading = useId();
  const read = state.read;
  const preview = read.kind === "ready" ? read.preview : null;
  const items = preview ? prerequisitesOf(preview, row.id) : [];
  const label = useLabels(items);
  const counts = preview ? progressOf(preview, row.id) : null;
  return (
    <section
      aria-labelledby={heading}
      data-dependencies={read.kind}
      className="flex flex-col gap-2 rounded-row border border-hairline-strong bg-panel p-4"
    >
      <h2 id={heading} className="text-[15px] font-medium text-ink-1">
        {DEPENDENCY_COPY.heading}
      </h2>
      {read.kind === "loading" ? (
        <div aria-busy="true" className="flex flex-col gap-1">
          <span className="sr-only">{DEPENDENCY_COPY.loading}</span>
          <div className="min-h-10 rounded-row border border-dashed border-hairline-strong" />
        </div>
      ) : read.kind === "offline" ? (
        <p className="text-[13px] text-ink-2">{DEPENDENCY_COPY.offline}</p>
      ) : read.kind === "refused" ? (
        <p className="text-[13px] text-ink-2">{copy.UNREADABLE}</p>
      ) : read.kind === "error" ? (
        <div className="flex flex-col gap-1" data-dependencies-error="">
          <p className="text-[13px] text-ink-2">{DEPENDENCY_COPY.failed}</p>
          {read.requestId ? (
            <p className="select-all font-num text-[12px] text-ink-2">
              {copy.REQUEST_ID(read.requestId)}
            </p>
          ) : null}
          <span>
            <Button onClick={() => void state.refresh()}>
              {copy.TRY_AGAIN}
            </Button>
          </span>
        </div>
      ) : counts !== null && counts.total === 0 && !preview?.unavailable ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13px] text-ink-2" data-dependencies-none="">
            {DEPENDENCY_COPY.none}
          </p>
          {row.canEdit && env.writable ? (
            <Button variant="quiet" onClick={onSet}>
              {DEPENDENCY_COPY.set}
            </Button>
          ) : null}
        </div>
      ) : counts !== null ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-ink-1" data-dependencies-progress="">
            {counts.firstOpen === null
              ? DEPENDENCY_COPY.allDone
              : DEPENDENCY_COPY.progress(
                  counts.done,
                  counts.total,
                  label(counts.firstOpen).title,
                )}
          </p>
          {preview?.unavailable ? (
            <p className="text-[12.5px] text-ink-2">
              {DEPENDENCY_COPY.unavailable}
            </p>
          ) : null}
          <span className="flex flex-wrap gap-2">
            <Button onClick={onSee}>{DEPENDENCY_COPY.see}</Button>
            <Button variant="quiet" onClick={() => void state.refresh()}>
              {DEPENDENCY_COPY.refresh}
            </Button>
            {row.canEdit && env.writable && !preview?.unavailable ? (
              <Button variant="quiet" onClick={onSet}>
                {DEPENDENCY_COPY.set}
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}
    </section>
  );
}

// ---- the preview and completion dialog -------------------------------------------------------------------------------------------
/** What the dialog completes with: the person's evidence for a numeric or checklist root (from the record card), with its ticket. */
export interface RootEvidence {
  evidence: Evidence;
  ticket: KeptTicket | null;
}

function DependencyList({
  preview,
  rootId,
  rootTitle,
}: {
  preview: DependencyPreview;
  rootId: string;
  rootTitle: string;
}) {
  const label = useLabels(preview.items);
  const why = useId();
  const pill = (item: DependencyItem) =>
    item.complete ? DEPENDENCY_COPY.done : DEPENDENCY_COPY.toDo;
  return (
    <>
      {/* WEB-18 (D-18-9): the labelled fallback while the graph can't be shown. Its order is the completion order and nothing more: the
          decorative chain that implied connections from it is gone. */}
      <p className="text-[12.5px] text-ink-2" data-dependency-fallback="">
        {GRAPH_COPY.fallback}
      </p>
      <ol
        className="m-0 flex list-none flex-col gap-1.5 p-0"
        data-dependency-list=""
      >
        {preview.items.map((item) => {
          const root = item.occurrence_id === rootId;
          const { title, day } = label(item);
          const blocked = !item.complete && !item.can_complete && !root;
          return (
            <li
              key={item.occurrence_id}
              data-dependency-item={item.occurrence_id}
              data-complete={item.complete ? "" : undefined}
              className="flex flex-col gap-0.5 rounded-row border border-hairline-strong bg-canvas px-3 py-2"
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13.5px] text-ink-1">
                  {root ? `${DEPENDENCY_COPY.thisTask}: ${rootTitle}` : title}
                  {day ? (
                    <span className="text-[12px] text-ink-2"> · {day}</span>
                  ) : null}
                </span>
                <span
                  className={`rounded-round border px-2.5 py-0.5 text-[12px] text-ink-1 ${item.complete ? "border-hairline-strong" : "border-field-edge"}`}
                >
                  {pill(item)}
                </span>
              </span>
              {blocked ? (
                <span className="text-[12px] text-ink-2" aria-describedby={why}>
                  {DEPENDENCY_COPY.cantHere}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p id={why} className="text-[12px] text-ink-2">
        {DEPENDENCY_COPY.cantHereWhy}
      </p>
      {preview.unavailable ? (
        <p className="text-[12.5px] text-ink-2" data-dependency-unavailable="">
          {DEPENDENCY_COPY.hiddenCount(2)}
        </p>
      ) : null}
      {preview.strict ? (
        <p className="text-[12.5px] text-ink-2" data-dependency-strict="">
          {DEPENDENCY_COPY.strict(rootTitle)}
        </p>
      ) : null}
    </>
  );
}

/**
 * WF-TASK-04 (CM-354, TASK-14/14a): the ordered list of what the day waits for, the three modes, and the completion. `replacing`: the
 * conflicted `complete_dependencies` this send replaces (its durable draft), so "Review and send again" supersedes it rather than adding
 * another. The root evidence (a numeric or checklist root, from the record card) is KEPT while hidden ("Wait") and settled only by a
 * successful save of exactly what was submitted (PRODUCT-DECISIONS-20261011; WEB-10a's acknowledgement rule).
 *
 * Admission (review R12): the dialog acts only on the answer of the read it asked when it opened (or a later one), and ONE rule
 * (`admittedMode`) decides the choice shown, the button and the send, so a mode remembered from a refused draft, or chosen before the
 * preview changed, is shown as Wait and never sent. The send checks again after its own awaits: if the preview, the identity or the
 * connection moved meanwhile nothing is queued or replaced, and what the person entered and the refused draft stay.
 */
export function DependencyDialog({
  row,
  state,
  open,
  onClose,
  rootEvidence,
  replacing,
  initialMode,
  actions,
}: {
  row: RowModel;
  state: DependencyState;
  open: boolean;
  onClose(): void;
  rootEvidence: RootEvidence | null;
  replacing: DraftWithCommand | null;
  initialMode?: Mode;
  actions: Pick<TaskActions, "enqueue">;
}) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const announcer = useAnnouncer();
  const navigate = useNavigate();
  const defaults = useSharingDefaults().record;
  // WEB-18 (D-18-1/5): what the day waits for is DRAWN from one whole graph answer; the modes below still come from the preview alone.
  const graph = useDependencyGraph(row.id, undefined, {
    active: open,
    settled: useGraphSettled(row),
  });
  const [mode, setMode] = useState<Mode | "wait">(initialMode ?? "wait");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Opening the dialog reads the preview again: it acts only on that answer or a later one.
  const [opening, setOpening] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once when it opens
  useEffect(() => {
    if (!open) {
      setOpening(null);
      return;
    }
    void state.refresh();
    setOpening(state.asked());
  }, [open]);
  const sending = useRef(false);
  const read = state.read;
  const preview = read.kind === "ready" ? read.preview : null;
  const title = row.title ?? copy.UNTITLED;
  const goal = row.data.definition.goal;
  // Every mode completes this day too: only with what is sent for it (review R15).
  const rootCompletable =
    preview !== null &&
    rootAdmitted(preview, row.id, goal.kind, rootEvidence !== null);
  const availability = preview
    ? modesOf(preview, row.id, rootCompletable)
    : null;
  const satisfied = preview ? satisfiedPreview(preview, row.id) : false;
  const fresh = opening !== null && state.seq >= opening;
  // What may be sent now for the person's choice (Wait when the preview forbids it), and the same for the choice shown.
  const effective =
    preview === null || satisfied
      ? "wait"
      : (admittedMode(preview, row.id, rootCompletable, mode) ?? "wait");
  // The latest render's facts, for the send's check after its awaits.
  const now = {
    preview: fresh ? preview : null,
    seq: state.seq,
    identity: env.identity,
    service: data.service(),
    online: env.online,
    writable: env.writable,
    rootCompletable,
  };
  const latest = useRef(now);
  latest.current = now;
  const admits = (at: typeof now, chosen: Mode) =>
    at.preview !== null &&
    at.online &&
    at.writable &&
    admittedMode(at.preview, row.id, at.rootCompletable, chosen) === chosen;
  const send = async (chosen: Mode) => {
    const at = latest.current;
    if (sending.current || at.preview === null || !admits(at, chosen)) return;
    const shown = at.preview;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    let ok = false;
    try {
      const me = env.accountId;
      const others = prerequisitesOf(shown, row.id).filter((i) => !i.complete);
      const streams = await Promise.all(
        others.map((item) => progressId(item.occurrence_id, me)),
      );
      const held = await readResourcesNow(data, streams);
      const after = latest.current;
      if (
        after.seq !== at.seq ||
        after.identity !== at.identity ||
        after.service !== at.service ||
        !admits(after, chosen)
      ) {
        setMessage(DEPENDENCY_COPY.changedWhileSaving);
        return;
      }
      const request = completeDependencies({
        occurrenceId: row.id,
        previewToken: shown.token,
        mode: chosen,
        happenedAt: Math.floor(env.now() / 1000),
        rootEvidence:
          goal.kind === "checkbox" ? null : (rootEvidence?.evidence ?? null),
        rootStream: {
          id: row.progressId,
          known: row.streamPresent || row.streamPending,
        },
        prerequisites: others.map((item, i) => ({
          occurrenceId: item.occurrence_id,
          stream: held?.has(streams[i] as string)
            ? (streams[i] as string)
            : null,
        })),
        defaults,
      });
      if (replacing !== null) {
        const outbox = data.outbox();
        const out = outbox
          ? await outbox.supersede(replacing.local_id, {
              ...request,
              expectDraft: (now) =>
                now.local_id === replacing.local_id &&
                now.status === replacing.status &&
                now.command_digest === replacing.command_digest,
            })
          : null;
        ok = out?.kind === "superseded";
        if (ok) announcer.announce(DEPENDENCY_COPY.saved, "polite");
        else
          setMessage(
            out?.kind === "refused"
              ? (copy.refusalMessage(out.reason) ?? DEPENDENCY_COPY.failed)
              : DEPENDENCY_COPY.failed,
          );
      } else {
        const out = await actions.enqueue(request, DEPENDENCY_COPY.saved);
        ok = out.ok;
        if (!out.ok) setMessage(out.message);
      }
    } catch {
      setMessage(DEPENDENCY_COPY.failed);
    } finally {
      sending.current = false;
      setBusy(false);
      if (rootEvidence?.ticket) completeKept(rootEvidence.ticket, ok);
    }
    if (ok) onClose();
  };
  // Closing without sending keeps the person's entered evidence on the card (its save was never made).
  const close = () => {
    if (rootEvidence?.ticket) completeKept(rootEvidence.ticket, false);
    onClose();
  };
  // "Open this task" (D-18-4): closes exactly as Cancel does, then shows that day (its own dialog reads its own graph).
  const openTask = (node: { task_id: string; occurrence_id: string }) => {
    close();
    void navigate({
      to: "/tasks/$taskId",
      params: { taskId: node.task_id },
      search: { occurrence: node.occurrence_id },
    });
  };
  // The preview's ordered list is the labelled fallback only when the graph answered and can't be shown (D-18-9), never beside it.
  const fallback = graph.view.kind === "error" || graph.view.kind === "refused";
  const shownGraph =
    graph.view.kind === "ready" || graph.view.kind === "stale"
      ? graph.view.graph
      : null;
  // D-18-11: what can't be ticked off from here, named from the preview (cache labels) in the mode's reason, never on the graph.
  const blocked = preview
    ? prerequisitesOf(preview, row.id).filter(
        (item) => !item.complete && !item.can_complete,
      )
    : [];
  const blockedLabel = useLabels(blocked);
  const disabledReason = !env.writable
    ? copy.NOT_WRITABLE
    : !env.online
      ? DEPENDENCY_COPY.offline
      : busy
        ? DEPENDENCY_COPY.sending
        : !fresh
          ? DEPENDENCY_COPY.checking
          : null;
  const options = [
    { value: "wait" as const, label: DEPENDENCY_COPY.wait },
    ...(availability?.complete_prerequisites === null
      ? [
          {
            value: "complete_prerequisites" as const,
            label: DEPENDENCY_COPY.completeAll,
          },
        ]
      : []),
    ...(availability?.advisory_override === null
      ? [
          {
            value: "advisory_override" as const,
            label: DEPENDENCY_COPY.startAnyway,
          },
        ]
      : []),
  ];
  return (
    <Dialog
      open={open}
      onClose={close}
      title={DEPENDENCY_COPY.heading}
      description={DEPENDENCY_COPY.preview}
      size="wide"
      footer={
        <div className="flex flex-col gap-2">
          {message ? (
            <p className="text-[12.5px] text-ink-2" data-dependency-message="">
              {message}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={close}>
              {DEPENDENCY_COPY.close}
            </Button>
            {preview === null ? null : satisfied ? (
              disabledReason || availability?.require_satisfied === "root" ? (
                <Button
                  disabled
                  reason={disabledReason ?? DEPENDENCY_COPY.rootWhy}
                >
                  {DEPENDENCY_COPY.markDone}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => void send("require_satisfied")}
                >
                  {DEPENDENCY_COPY.markDone}
                </Button>
              )
            ) : effective === "wait" ? null : disabledReason ? (
              <Button disabled reason={disabledReason}>
                {effective === "complete_prerequisites"
                  ? DEPENDENCY_COPY.completeAll
                  : DEPENDENCY_COPY.startAnyway}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void send(effective)}>
                {effective === "complete_prerequisites"
                  ? DEPENDENCY_COPY.completeAll
                  : DEPENDENCY_COPY.startAnyway}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div
        className="flex flex-col gap-3"
        data-dependency-dialog={
          read.kind === "ready" && !fresh ? "checking" : read.kind
        }
      >
        {read.kind === "loading" ? (
          <div aria-busy="true" className="flex flex-col gap-1.5">
            <span className="sr-only">{DEPENDENCY_COPY.loading}</span>
            {[0, 1, 2].map((n) => (
              <div
                key={n}
                className="min-h-10 rounded-row border border-dashed border-hairline-strong"
              />
            ))}
          </div>
        ) : read.kind !== "ready" || preview === null ? (
          <p className="text-[13px] text-ink-2">
            {read.kind === "offline"
              ? DEPENDENCY_COPY.offline
              : DEPENDENCY_COPY.failed}
          </p>
        ) : (
          <>
            <DependencyGraphSection
              view={graph.view}
              rootTitle={title}
              onRefresh={() => void graph.refresh()}
              onOpenTask={openTask}
            />
            {fallback ? (
              <DependencyList
                preview={preview}
                rootId={row.id}
                rootTitle={title}
              />
            ) : shownGraph !== null && preview.strict ? (
              <p className="text-[12.5px] text-ink-2" data-dependency-strict="">
                {DEPENDENCY_COPY.strict(title)}
              </p>
            ) : null}
            {rootEvidence !== null && effective === "wait" ? (
              <p className="text-[12px] text-ink-2">
                {DEPENDENCY_COPY.evidenceKept}
              </p>
            ) : null}
            {satisfied ? (
              availability?.require_satisfied === "root" ? (
                <p
                  className="text-[12px] text-ink-2"
                  data-mode-reason="require_satisfied"
                >
                  {DEPENDENCY_COPY.markDone}: {DEPENDENCY_COPY.rootWhy}
                </p>
              ) : null
            ) : (
              <div className="flex flex-col gap-1.5">
                <RadioCardGroup<Mode | "wait">
                  label={DEPENDENCY_COPY.modesName}
                  value={effective}
                  onValueChange={setMode}
                  options={options}
                />
                {availability?.complete_prerequisites ? (
                  <p
                    className="text-[12px] text-ink-2"
                    data-mode-reason="complete_prerequisites"
                  >
                    {DEPENDENCY_COPY.completeAll}:{" "}
                    {
                      DEPENDENCY_COPY.completeAllWhy[
                        availability.complete_prerequisites
                      ]
                    }
                    {!fallback &&
                    availability.complete_prerequisites === "cannot_complete" &&
                    blocked.length > 0
                      ? ` ${blocked.map((item) => `“${blockedLabel(item).title}”`).join(", ")}.`
                      : null}
                  </p>
                ) : null}
                {availability?.advisory_override ? (
                  <p
                    className="text-[12px] text-ink-2"
                    data-mode-reason="advisory_override"
                  >
                    {DEPENDENCY_COPY.startAnyway}:{" "}
                    {availability.advisory_override === "strict"
                      ? DEPENDENCY_COPY.strict(title)
                      : DEPENDENCY_COPY.rootWhy}
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---- the conflict blocks ---------------------------------------------------------------------------------------------------------
/** A queued `complete_dependencies` that met a conflict: the cause, from a fresh preview, then review-and-send-again or discard. */
export function CompletionConflict({
  row,
  state,
  localId,
  onReview,
}: {
  row: RowModel;
  state: DependencyState;
  localId: string;
  onReview(
    draft: DraftWithCommand,
    mode: Mode,
    evidence: Evidence | null,
  ): void;
}) {
  const data = useDataEnv();
  const stored = useDraftWithCommand(localId);
  const draft =
    stored.status === "ready" && stored.value?.local_id === localId
      ? stored.value
      : null;
  const command = draft ? commandOf(draft) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cause is read from a preview asked after the conflict
  useEffect(() => {
    void state.refresh();
  }, [localId]);
  const read = state.read;
  const mode = (command?.mode as Mode | undefined) ?? "require_satisfied";
  const token =
    typeof command?.preview_token === "string" ? command.preview_token : "";
  const evidence =
    command?.root_evidence === undefined
      ? null
      : parseEvidence(command.root_evidence);
  const cause =
    read.kind === "ready" ? causeOf(mode, token, read.preview, row.id) : null;
  const title = row.title ?? copy.UNTITLED;
  return (
    <section
      data-completion-conflict={cause ?? "checking"}
      className="flex flex-col gap-2 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
    >
      <h2 className="text-[14px] font-medium text-ink-1">
        {DEPENDENCY_COPY.conflictTitle}
      </h2>
      <p className="text-[13px] text-ink-1">
        {cause === null
          ? DEPENDENCY_COPY.checking
          : cause === "strict"
            ? DEPENDENCY_COPY.cause.strict(title)
            : DEPENDENCY_COPY.cause[cause]}
      </p>
      <div className="flex flex-wrap gap-2">
        {draft !== null && read.kind === "ready" ? (
          <Button
            variant="primary"
            onClick={() =>
              onReview(
                draft,
                cause === "satisfied" ? "require_satisfied" : mode,
                evidence,
              )
            }
          >
            {DEPENDENCY_COPY.review}
          </Button>
        ) : null}
        <Button onClick={() => void data.outbox()?.discard(localId)}>
          {DEPENDENCY_COPY.discard}
        </Button>
      </div>
    </section>
  );
}

/**
 * A `record` (or a timer's stop) that completes the day and met a conflict: read the preview again; when something it waits for is still
 * open, say so and offer the preview. Otherwise nothing here: WEB-10a's version-conflict handling stands, unchanged.
 */
export function UnmetConflict({
  row,
  state,
  localId,
  onSee,
}: {
  row: RowModel;
  state: DependencyState;
  localId: string;
  onSee(): void;
}) {
  const data = useDataEnv();
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again once per conflicted draft
  useEffect(() => {
    void state.refresh();
  }, [localId]);
  const read = state.read;
  const open =
    read.kind === "ready" ? progressOf(read.preview, row.id).firstOpen : null;
  const label = useLabels(open === null ? [] : [open]);
  if (open === null) return null;
  return (
    <section
      data-unmet-conflict={localId}
      className="flex flex-col gap-2 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
    >
      <p className="text-[13px] text-ink-1">
        {DEPENDENCY_COPY.unmet(label(open).title)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onSee}>
          {DEPENDENCY_COPY.see}
        </Button>
        <Button onClick={() => void data.outbox()?.discard(localId)}>
          {DEPENDENCY_COPY.discard}
        </Button>
      </div>
    </section>
  );
}

/** A `set_dependencies` that met a conflict: neutral copy (never naming a cycle's edge), "Keep editing" with the SUBMITTED list. */
export function SetConflict({
  localId,
  onKeepEditing,
}: {
  localId: string;
  onKeepEditing(draft: DraftWithCommand): void;
}) {
  const data = useDataEnv();
  const stored = useDraftWithCommand(localId);
  const draft =
    stored.status === "ready" && stored.value?.local_id === localId
      ? stored.value
      : null;
  return (
    <section
      data-set-conflict={localId}
      className="flex flex-col gap-2 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
    >
      <p className="text-[13px] text-ink-1">{DEPENDENCY_COPY.setConflict}</p>
      <div className="flex flex-wrap gap-2">
        {draft !== null ? (
          <Button variant="primary" onClick={() => onKeepEditing(draft)}>
            {DEPENDENCY_COPY.keepEditing}
          </Button>
        ) : null}
        <Button onClick={() => void data.outbox()?.discard(localId)}>
          {DEPENDENCY_COPY.discard}
        </Button>
      </div>
    </section>
  );
}

// ---- the editor ------------------------------------------------------------------------------------------------------------------
interface EditorValue {
  list: string[];
  strict: boolean;
  /** WEB-18 (D-18-7): the graph read the edit was built from (its root's version and direct list); null until the first one. */
  base: EditorBase | null;
  /** WEB-18: the person changed the list or the rule since it was built. */
  touched: boolean;
}

/** The days the editor can offer for one task: its saved days on this device, 100 at a time (the day picker's paging). */
function useTaskDays(taskId: string | null) {
  const data = useDataEnv();
  const [state, setState] = useState<{
    taskId: string | null;
    rows: CacheRow[];
    next: string | null;
    ready: boolean;
  }>({ taskId: null, rows: [], next: null, ready: false });
  const load = async (after: string | null) => {
    if (taskId === null) return;
    const exec = await readResourcePageNow(data, {
      kind: "execution",
      parentId: taskId,
      limit: 1,
    });
    const execution = exec.ok ? exec.value.rows[0]?.merged : undefined;
    if (execution === undefined) {
      setState({ taskId, rows: [], next: null, ready: true });
      return;
    }
    const page = await readResourcePageNow(data, {
      kind: "occurrence",
      parentId: execution.id,
      after,
      limit: 100,
    });
    if (!page.ok) return;
    setState((prev) => ({
      taskId,
      rows: [
        ...(after === null || prev.taskId !== taskId ? [] : prev.rows),
        ...page.value.rows.map((r) => r.merged),
      ],
      next: page.value.next,
      ready: true,
    }));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new task starts its days afresh
  useEffect(() => {
    void load(null);
  }, [taskId]);
  return {
    rows: state.taskId === taskId ? state.rows : [],
    ready: state.taskId === taskId && state.ready,
    more:
      state.taskId === taskId && state.next !== null
        ? () => void load(state.next)
        : null,
  };
}

function useTaskChoices() {
  const data = useDataEnv();
  const [state, setState] = useState<{ rows: CacheRow[]; next: string | null }>(
    {
      rows: [],
      next: null,
    },
  );
  const load = async (after: string | null) => {
    const page = await readResourcePageNow(data, {
      kind: "task",
      after,
      limit: 100,
    });
    if (!page.ok) return;
    setState((prev) => ({
      rows: [
        ...(after === null ? [] : prev.rows),
        ...page.value.rows.map((r) => r.merged).filter((r) => !r.archived),
      ],
      next: page.value.next,
    }));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once when the editor opens
  useEffect(() => {
    void load(null);
  }, []);
  return {
    rows: state.rows,
    more: state.next !== null ? () => void load(state.next) : null,
  };
}

/**
 * The bounded editor (D-10c-7; WEB-18 D-18-6/7/8): it saves only online, with a fresh preview that has nothing private AND its own fresh
 * depth-one graph read (`max_depth=1`, the backend's editing read). A new edit starts from that read's AUTHORITATIVE direct list and the
 * root's strict rule, and is saved on that read's root version (`reviewedBase`), so a server that has moved on answers `conflict` and
 * nothing is silently overwritten. A later read that moves the base re-seeds an untouched edit and withholds Save from a touched one
 * until the person starts again from the current list. Save is withheld too when the root has hidden prerequisites (saving would remove
 * them), when the person may not edit the day, and while another change of the day's version is unsettled. The list is checked here (at
 * most 32, unique, never the day itself); visibility and cycles are the server's. `replacing`: "Keep editing" of a conflicted
 * `set_dependencies`, which starts from the SUBMITTED list, shows the current list beside it and supersedes it on the version read now.
 * What is typed is kept for the screen's logical visit (WEB-10a decisions 44 and 48).
 */
export function DependencyEditor({
  row,
  state,
  open,
  onClose,
  replacing,
  actions,
}: {
  row: RowModel;
  state: DependencyState;
  open: boolean;
  onClose(): void;
  replacing: DraftWithCommand | null;
  actions: Pick<TaskActions, "enqueue">;
}) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const announcer = useAnnouncer();
  const taskId = useId();
  const dayId = useId();
  const strictId = useId();
  const submitted = replacing ? commandOf(replacing) : null;
  const read = state.read;
  const preview = read.kind === "ready" ? read.preview : null;
  const graph = useDependencyGraph(row.id, 1, {
    active: open,
    settled: useGraphSettled(row),
  });
  // Only a current whole answer is a base to save on: a stale one (a failed re-read) is not.
  const current = graph.view.kind === "ready" ? graph.view.graph : null;
  const input = useKeptInput<EditorValue>(
    keptKey(
      env.identity,
      `dependencies:${row.id}:${replacing?.local_id ?? "new"}`,
    ),
    env.identity,
    () => ({
      list: Array.isArray(submitted?.prerequisites)
        ? (submitted.prerequisites as string[])
        : [],
      strict:
        typeof submitted?.strict === "boolean"
          ? submitted.strict
          : (preview?.strict ?? false),
      base: null,
      touched: false,
    }),
    { consumed: () => null },
  );
  // D-18-7: built from the editor's own graph read. A new edit takes its direct list and strict rule; "Keep editing" keeps the
  // submitted list. Either way the base is that read's, and a moved base re-builds an UNTOUCHED edit (never a touched one).
  const build = (g: DependencyGraph, keepList: boolean) => {
    const root = g.nodes[0];
    input.edit((v) => ({
      list: keepList ? v.list : [...g.direct_prerequisites],
      strict: keepList ? v.strict : (root?.strict ?? v.strict),
      base: baseOf(g),
      touched: false,
    }));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new whole answer is considered once
  useEffect(() => {
    if (current === null || input.busy) return;
    const v = input.value;
    if (v.base !== null && (v.touched || baseMatches(v.base, current))) return;
    build(current, replacing !== null);
  }, [current]);
  const changed =
    current !== null &&
    input.value.base !== null &&
    input.value.touched &&
    !baseMatches(input.value.base, current);
  const pending = pendingVersioned(
    row.drafts.map((d) => ({
      local_id: d.local_id,
      kind: d.kind,
      status: d.status,
      command: commandOf(d),
    })),
    row.id,
    OCCURRENCE_VERSIONED_KINDS,
    replacing?.local_id ?? null,
  );
  const graphLabel = (id: string): string | null => {
    if (current === null || !current.nodes.some((n) => n.occurrence_id === id))
      return null;
    const { title, day } = nodeLabel(indexGraph(current), id);
    return `${title} · ${day}`;
  };
  const [pickTask, setPickTask] = useState<string | null>(null);
  const [pickDay, setPickDay] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const tasks = useTaskChoices();
  const days = useTaskDays(pickTask);
  const chosen = useCachedResources(input.value.list);
  const chosenTasks = useCachedResources(
    chosen.status === "ready"
      ? Object.values(chosen.value).flatMap((r) => {
          const parsed = r ? parseOccurrenceData(r.merged.value) : null;
          return parsed ? [parsed.task_id] : [];
        })
      : [],
  );
  const labelOf = (id: string) => {
    const fromGraph = graphLabel(id);
    if (fromGraph !== null) return fromGraph;
    const occ = chosen.status === "ready" ? chosen.value[id]?.merged : null;
    const parsed = occ ? parseOccurrenceData(occ.value) : null;
    const task =
      parsed && chosenTasks.status === "ready"
        ? chosenTasks.value[parsed.task_id]?.merged
        : null;
    const date = parsed?.slot.date;
    return `${task?.label ?? DEPENDENCY_COPY.notHere}${
      date === undefined
        ? ""
        : ` · ${date === null ? DEPENDENCY_COPY.undated : dayLabel(date)}`
    }`;
  };
  // Opening the editor reads the preview again, and a save is admitted only on that answer or a later one (review R4): what it may replace
  // is judged on what the server says NOW, for a new list and for "Keep editing" alike. A replacement is no exception: saving it
  // supersedes the whole direct list on the version shown now, so a day whose prerequisites have become private, an edit right that has
  // gone or a preview not yet answered withholds Save. What was typed (or the submitted list) is kept meanwhile. "That answer" is the
  // one SHOWN for the read asked at opening or a later one (review R12's rule): a resolved re-read whose answer was overtaken is not it.
  const [opening, setOpening] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once when it opens
  useEffect(() => {
    if (!open) {
      setOpening(null);
      return;
    }
    void state.refresh();
    setOpening(state.asked());
  }, [open]);
  const refreshed = opening !== null && state.seq >= opening;
  const block = editorBlock({
    online: env.online,
    canEdit: row.canEdit,
    preview: refreshed ? preview : null,
    root:
      current !== null && input.value.base !== null
        ? {
            can_edit: current.nodes[0]?.can_edit ?? false,
            restricted_prerequisites:
              current.nodes[0]?.restricted_prerequisites ?? null,
          }
        : null,
    pending,
    changed,
  });
  const title = row.title ?? copy.UNTITLED;
  const save = async () => {
    const problem = validateList(row.id, input.value.list);
    if (problem !== null) {
      setError(DEPENDENCY_COPY.errors[problem]);
      return;
    }
    const base = input.value.base;
    if (base === null) return;
    const ticket = input.submit();
    if (ticket === null) return;
    // Sent on the version of the read the list was built from (D-18-7/8), never the cache's.
    const request = setDependencies({
      occurrenceId: row.id,
      prerequisites: input.value.list,
      strict: input.value.strict,
      reviewedBase: base.version,
    });
    let ok = false;
    try {
      if (replacing !== null) {
        const out = await data.outbox()?.supersede(replacing.local_id, {
          ...request,
          expectDraft: (now) =>
            now.local_id === replacing.local_id &&
            now.status === replacing.status &&
            now.command_digest === replacing.command_digest,
        });
        ok = out?.kind === "superseded";
        if (ok) announcer.announce(DEPENDENCY_COPY.saved, "polite");
        else
          setError(
            out?.kind === "refused"
              ? (copy.refusalMessage(out.reason) ?? DEPENDENCY_COPY.setConflict)
              : DEPENDENCY_COPY.setConflict,
          );
      } else {
        const out = await actions.enqueue(request, DEPENDENCY_COPY.saved);
        ok = out.ok;
        if (!out.ok) setError(out.message);
      }
    } finally {
      completeKept(ticket, ok);
    }
    if (ok) onClose();
  };
  const blockReason =
    block === "offline"
      ? DEPENDENCY_COPY.editorOffline
      : block === "denied"
        ? DEPENDENCY_COPY.editorDenied
        : block === "unavailable" || block === "restricted"
          ? DEPENDENCY_COPY.editorUnavailable
          : block === "pending"
            ? DEPENDENCY_COPY.editorPending
            : block === "changed"
              ? DEPENDENCY_COPY.editorChanged
              : block === "loading"
                ? refreshed && read.kind === "error"
                  ? DEPENDENCY_COPY.failed
                  : refreshed && read.kind === "refused"
                    ? copy.UNREADABLE
                    : graph.view.kind === "error" || graph.view.kind === "stale"
                      ? DEPENDENCY_COPY.failed
                      : graph.view.kind === "refused"
                        ? copy.UNREADABLE
                        : DEPENDENCY_COPY.editorLoading
                : !env.writable
                  ? copy.NOT_WRITABLE
                  : input.busy
                    ? DEPENDENCY_COPY.sending
                    : null;
  const dayChoices = days.rows.filter((r) => r.id !== row.id);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={DEPENDENCY_COPY.editorTitle}
      description={DEPENDENCY_COPY.editorLead(title)}
      footer={
        <div className="flex flex-col gap-2">
          {error ? (
            <p
              className="text-[12.5px] text-conflict-text"
              data-editor-error=""
            >
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={onClose}>
              {DEPENDENCY_COPY.cancel}
            </Button>
            {blockReason ? (
              <Button disabled reason={blockReason}>
                {DEPENDENCY_COPY.save}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void save()}>
                {DEPENDENCY_COPY.save}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div
        className="flex flex-col gap-3"
        data-dependency-editor={block ?? "open"}
      >
        {block === "changed" && current !== null ? (
          <div
            className="flex flex-col gap-1.5 rounded-row border border-conflict-edge bg-conflict-tint p-3"
            data-editor-changed=""
          >
            <p className="text-[13px] text-ink-1">
              {DEPENDENCY_COPY.editorChanged}
            </p>
            <span>
              <Button onClick={() => build(current, false)}>
                {DEPENDENCY_COPY.editorRestart}
              </Button>
            </span>
          </div>
        ) : null}
        {replacing !== null && current !== null ? (
          <div className="flex flex-col gap-1" data-editor-now="">
            <p className="text-[12.5px] text-ink-2">
              {DEPENDENCY_COPY.editorWaitsNow}{" "}
              {current.direct_prerequisites.length === 0
                ? DEPENDENCY_COPY.editorEmpty
                : current.direct_prerequisites
                    .map((id) => graphLabel(id) ?? DEPENDENCY_COPY.notHere)
                    .join("; ")}
            </p>
          </div>
        ) : null}
        <p className="text-[13px] text-ink-1">{DEPENDENCY_COPY.editorNow}</p>
        {input.value.list.length === 0 ? (
          <p className="text-[13px] text-ink-2">
            {DEPENDENCY_COPY.editorEmpty}
          </p>
        ) : (
          <ol
            className="m-0 flex list-none flex-col gap-1.5 p-0"
            data-editor-list=""
          >
            {input.value.list.map((id) => (
              <li
                key={id}
                data-editor-item={id}
                className="flex items-center justify-between gap-2 rounded-row border border-hairline-strong bg-canvas px-3 py-1.5"
              >
                <span className="text-[13px] text-ink-1">{labelOf(id)}</span>
                <Button
                  variant="quiet"
                  aria-label={`${DEPENDENCY_COPY.remove}: ${labelOf(id)}`}
                  onClick={() => {
                    setError(null);
                    input.edit((v) => ({
                      ...v,
                      list: v.list.filter((x) => x !== id),
                      touched: true,
                    }));
                  }}
                >
                  {DEPENDENCY_COPY.remove}
                </Button>
              </li>
            ))}
          </ol>
        )}
        <p className="text-[12px] text-ink-2" data-editor-counter="">
          {DEPENDENCY_COPY.counter(input.value.list.length)}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label
              htmlFor={taskId}
              className="text-[12px] font-medium text-ink-2"
            >
              {DEPENDENCY_COPY.addTask}
            </label>
            <select
              id={taskId}
              value={pickTask ?? ""}
              data-field-edge=""
              onChange={(event) => {
                setPickTask(event.target.value || null);
                setPickDay("");
              }}
              className="min-h-11 max-w-[260px] rounded-control border border-field-edge bg-canvas px-3 text-[13.5px] text-ink-1"
            >
              <option value="">{DEPENDENCY_COPY.chooseTask}</option>
              {tasks.rows.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.label}
                </option>
              ))}
            </select>
          </div>
          {tasks.more ? (
            <Button variant="quiet" onClick={tasks.more}>
              {DEPENDENCY_COPY.moreTasks}
            </Button>
          ) : null}
          <div className="flex flex-col gap-1">
            <label
              htmlFor={dayId}
              className="text-[12px] font-medium text-ink-2"
            >
              {DEPENDENCY_COPY.addDay}
            </label>
            <select
              id={dayId}
              value={pickDay}
              disabled={pickTask === null}
              data-field-edge=""
              onChange={(event) => setPickDay(event.target.value)}
              className="min-h-11 max-w-[260px] rounded-control border border-field-edge bg-canvas px-3 text-[13.5px] text-ink-1"
            >
              <option value="">{DEPENDENCY_COPY.chooseDay}</option>
              {dayChoices.map((day) => {
                const date = parseOccurrenceData(day.value)?.slot.date;
                return (
                  <option key={day.id} value={day.id}>
                    {date ? dayLabel(date) : DEPENDENCY_COPY.undated}
                  </option>
                );
              })}
            </select>
          </div>
          {days.more ? (
            <Button variant="quiet" onClick={days.more}>
              {DEPENDENCY_COPY.moreDays}
            </Button>
          ) : null}
          {pickDay === "" ? (
            <Button disabled reason={DEPENDENCY_COPY.chooseDay}>
              {DEPENDENCY_COPY.add}
            </Button>
          ) : (
            <Button
              onClick={() => {
                const problem = validateList(row.id, [
                  ...input.value.list,
                  pickDay,
                ]);
                if (problem !== null) {
                  setError(DEPENDENCY_COPY.errors[problem]);
                  return;
                }
                setError(null);
                input.edit((v) => ({
                  ...v,
                  list: [...v.list, pickDay],
                  touched: true,
                }));
                setPickDay("");
              }}
            >
              {DEPENDENCY_COPY.add}
            </Button>
          )}
        </div>
        {pickTask !== null && days.ready && dayChoices.length === 0 ? (
          <p className="text-[12.5px] text-ink-2">{DEPENDENCY_COPY.noDays}</p>
        ) : null}
        <label
          htmlFor={strictId}
          className="inline-flex min-h-11 items-center gap-2.5 text-[13.5px] text-ink-1"
        >
          <input
            id={strictId}
            type="checkbox"
            checked={input.value.strict}
            onChange={(event) => {
              const strict = event.target.checked;
              input.edit((v) => ({ ...v, strict, touched: true }));
            }}
            className="size-[15px]"
          />
          {DEPENDENCY_COPY.strictLabel}
        </label>
      </div>
    </Dialog>
  );
}

/** Whether `evidence`, recorded now, would complete the day for me (its action outcome), from my stream as this device holds it. */
export function wouldComplete(
  row: RowModel,
  evidence: Evidence,
  nowMs: number,
): boolean {
  if (evidence.kind === "checkbox") return evidence.complete;
  if (evidence.kind === "observe") return false;
  const layered = layer(
    row.progress,
    row.data.definition.goal,
    [
      {
        entryId: "candidate",
        evidence,
        happenedAt: Math.floor(nowMs / 1000),
        replaces: null,
      },
    ],
    { opensAt: row.data.opens_at, closesAt: row.data.closes_at },
  );
  return (
    layered.action.outcome === "complete" ||
    layered.action.outcome === "provisional"
  );
}

/**
 * The record card's gate (§4.2): online, with a fresh preview showing something still open, evidence that would complete the day opens
 * the dialog INSTEAD of queueing a plain record (which the server would refuse). Offline, or with nothing open, the plain record is
 * queued as before. Returns whether it opened the dialog.
 */
export function gateOf(
  row: RowModel,
  state: DependencyState,
  online: boolean,
  nowMs: number,
  open: (root: RootEvidence | null) => void,
): (evidence: Evidence, ticket: KeptTicket | null) => boolean {
  return (evidence, ticket) => {
    if (!online || state.read.kind !== "ready") return false;
    if (satisfiedPreview(state.read.preview, row.id)) return false;
    if (prerequisitesOf(state.read.preview, row.id).length === 0) return false;
    if (!wouldComplete(row, evidence, nowMs)) return false;
    open(
      row.data.definition.goal.kind === "checkbox"
        ? null
        : { evidence, ticket },
    );
    return true;
  };
}
