import { useEffect, useId, useReducer, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import {
  type CacheRow,
  type DraftRow,
  type Observation,
  useAllOutstandingByKind,
  useCachedResources,
  useDataActions,
  useDataEnv,
  useDraftWithCommand,
  useResourceView,
} from "../../../data";
import {
  AnchorDialog,
  type AnchorEditor,
  type AnchorNames,
  type AnchorRefusal,
  anchorDraftOf,
  anchorOfCommand,
  type CalendarAnchor,
  describeAnchor,
  EMPTY_ANCHOR,
  setAnchorRequest,
} from "../../calendars/anchors";
import {
  ANCHOR_ACTION,
  ANCHOR_CONFLICT,
  ANCHOR_NOT_SAVED_CHANGED,
  ANCHOR_NOT_SAVED_DENIED,
  ANCHOR_QUEUED,
  ANCHOR_REASONS,
  ANCHOR_REMOVED,
  ANCHOR_SAVED,
  ANCHOR_SAVING,
  AUTOMATION_OFF,
  anchoredTo,
  anchorRejected,
  BINDING_FAILED,
  BINDING_OFFLINE,
  BINDING_OFFLINE_EDIT,
  BINDING_READING,
  BINDING_UNSYNCED,
  CHANGE_ANCHOR,
  DISMISS_ANCHOR,
  NOT_ANCHORED,
  REVIEW_ANCHOR,
  SECTION_HEADING,
  TRY_AGAIN,
} from "../../calendars/copy-anchor";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { type TaskVisit, useTaskScreenAt, useTaskVisit } from "../visit";
import {
  type BindingRead,
  bindingOf,
  firstReceipt,
  readBinding,
  readBindingAgain,
  subscribeBinding,
} from "./anchor-binding";
import {
  discardPanel,
  keptPanelKey,
  openPanel,
  operationKeys,
  retainPanel,
} from "./anchor-kept";

const SET_ANCHOR = "set_anchor";
const KINDS = [SET_ANCHOR] as const;
const VIEW_KINDS = { settings: SET_ANCHOR };

/** The reason a refused `set_anchor` is shown with (the server's `422` does not say which rule failed; the task's own facts can). */
export function anchorRefusal(
  draft: Pick<DraftRow, "last_error">,
  facts: { repeats: boolean; seconds: boolean },
): string {
  const status = draft.last_error?.status;
  if (status === 403 || status === 404) return ANCHOR_REASONS.unavailable ?? "";
  if (status === 422 && facts.repeats) return ANCHOR_REASONS.recurrence ?? "";
  if (status === 422 && facts.seconds) return ANCHOR_REASONS.untimed ?? "";
  return ANCHOR_REASONS.other ?? "";
}

/**
 * The task's "Calendar anchor" (WEB-13b §4.3/§4.4; the task-level part of WF-TASK-01): the binding as the server shows it, read ONLINE once
 * per visit (`anchor-binding.ts`; offline it says "Binding details need a connection.", case 3, while the rest of the task stays as the
 * cache shows it), this task's queued anchor changes, and "Anchor…" / "Change anchor…", which queue `set_anchor` (offline included).
 * Shown for a task that does not repeat: a task that repeats on its own schedule cannot be anchored (the server answers `422`).
 */
export function AnchorSection({
  task,
  repeats,
  canEdit,
  synced,
}: {
  task: CacheRow;
  repeats: boolean;
  canEdit: boolean;
  /**
   * The task is in the cache, not only this device's pending create: until then the server has no binding to read (a read would be
   * refused `404` and that refusal kept for the visit), so nothing is read and the section says it will show the anchor once synced.
   */
  synced: boolean;
}) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const actions = useDataActions();
  const announcer = useAnnouncer();
  const heading = useId();
  const visitOf = useTaskVisit();
  const screenAt = useTaskScreenAt();
  const mountKey = useRef(`mount-${Math.random().toString(36).slice(2)}`);
  const [visit, setVisit] = useState<string | null>(null);
  // Whether the read may still be SENT (R6): while the person is at this task's screen (by its router and the document), or, outside any
  // router, while this mount is. Asked before every admission of the read, retries included. Not the first visit's own end: a section
  // React kept mounted while the address went away and came back in one turn is the screen the person is at again (R36), and a remount
  // (the session's re-check of a `403`) is at the same address.
  const live = useRef<() => boolean>(() => false);
  // The visit the section is shown on (null outside any router): it owns a panel kept by the in-dialog sync control.
  const owner = useRef<TaskVisit | null>(null);
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeBinding(changed), []);
  // The visit this section belongs to, asked once it is shown (a section outside any router keeps its read for its own mount only).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the visit is asked for the identity shown
  useEffect(() => {
    const going = visitOf(env.identity);
    owner.current = going;
    if (going === null) {
      let mountedHere = true;
      live.current = () => mountedHere;
      setVisit(mountKey.current);
      return () => {
        mountedHere = false;
      };
    }
    const { address } = going;
    live.current = () => screenAt(address);
    setVisit(`visit-${going.generation}`);
  }, [env.identity]);
  const read: BindingRead | undefined =
    visit === null ? undefined : bindingOf(env.identity, `${visit}:${task.id}`);
  // Online and compatible only (an ordinary stamped read), for a task the server has (synced); never while the task repeats.
  useEffect(() => {
    if (visit === null || repeats || !synced || !env.online || !env.writable)
      return;
    readBinding(env.identity, visit, task.id, env.api, live.current);
  }, [
    visit,
    repeats,
    synced,
    env.online,
    env.writable,
    env.identity,
    env.api,
    task.id,
  ]);

  // This task's queued anchor changes (headers and small bodies), and those that need a decision.
  const outstanding = useAllOutstandingByKind(KINDS);
  const mine = (d: DraftRow) => d.target_resource_ids[0] === task.id;
  const drafts =
    outstanding.status === "ready" ? outstanding.value.drafts.filter(mine) : [];
  const attention =
    outstanding.status === "ready"
      ? outstanding.value.attention.filter(mine)
      : [];
  const conflicted =
    attention.find((d) => d.status === "version_conflict") ?? null;
  const rejected = attention.find((d) => d.status === "rejected") ?? null;
  const pending = drafts.some(
    (d) => d.status === "queued" || d.status === "in_flight",
  );
  const saving = drafts.some((d) => d.status === "acknowledged");
  // A receipted change of this task's anchor reads the binding again, once (a remount does not repeat it).
  const receipted = drafts.find((d) => d.status === "acknowledged");
  useEffect(() => {
    if (receipted === undefined || visit === null || !env.online) return;
    if (firstReceipt(env.identity, receipted.local_id))
      readBindingAgain(env.identity, visit, task.id, env.api, live.current);
  }, [receipted, visit, env.online, env.identity, env.api, task.id]);

  // The read the panel's save is made from: the task and its drafts, checked again when the change is written.
  const view = useResourceView(task.id, VIEW_KINDS);
  const conflictBody = useDraftWithCommand(conflicted?.local_id ?? null);
  const binding = read?.kind === "read" ? read.binding : null;
  const anchor = binding?.anchor ?? null;
  const reference = anchor?.reference;
  const names = useCachedResources(
    reference === undefined
      ? []
      : [
          reference.kind === "event_series"
            ? reference.source_id
            : reference.field_id,
        ],
  );
  const knownNames = (a: CalendarAnchor | null): AnchorNames => {
    if (a === null || names.status !== "ready") return {};
    const id =
      a.reference.kind === "event_series"
        ? a.reference.source_id
        : a.reference.field_id;
    const label = names.value[id]?.merged.label ?? null;
    return a.reference.kind === "event_series"
      ? { source: label }
      : { field: label };
  };

  /** What a panel's session was opened for (`anchor-kept.ts` keeps it with the session, renewed by the session's own done saves). */
  type PanelFor = {
    anchor: CalendarAnchor | null;
    supersede: string | null;
    observed: Observation | null;
    /** A save of the session was done while newer input stayed in it: the next save is checked against the task as it is NOW. */
    renewed: boolean;
  };
  // The session the panel shows (revision 2, R3a/R3b): owned by the task's visit, not by this section or the panel.
  const [dialog, setDialog] = useState<AnchorEditor<PanelFor> | null>(null);
  const panelKey = keptPanelKey(env.identity, task.id);
  // Outside any visit (a section outside a router): this mount's own change identities (`operationKeys`).
  const ownKeys = useRef(new Map<string, string>());
  // The next panel opened while the visit goes on shows the session the visit kept or left (I1, R3a), else a new one opened for this.
  const open = (from: CalendarAnchor | null, supersede: string | null) => {
    setDialog(
      openPanel<PanelFor>(
        panelKey,
        owner.current,
        () => ({
          draft: from === null ? EMPTY_ANCHOR : anchorDraftOf(from),
          names: knownNames(from),
          context: {
            anchor: from,
            supersede,
            observed: view.status === "ready" ? view.value.observation : null,
            renewed: false,
          },
        }),
        // A stored change of the session ended any conflict it superseded: the next save is an ordinary one, after it in the queue,
        // checked against the task as it is then.
        (context) => ({ ...context, supersede: null, renewed: true }),
      ),
    );
  };
  const observedNow = view.status === "ready" ? view.value.observation : null;

  // `context`: what the saving session was opened for, as it is when the save is pressed (whichever panel or section shows it).
  const save = async (
    next: CalendarAnchor | null,
    context: PanelFor,
  ): Promise<string | null | AnchorRefusal<PanelFor>> => {
    if (!env.writable) return copy.NOT_WRITABLE;
    const outbox = data.outbox();
    if (outbox === null) return copy.NO_DATABASE;
    // The identity of each change pressed and not yet stored, so the same change pressed again after a refusal (or a failure that may
    // have stored it) is recognised; a STORED change's identity is retired (R2): pressing a change again later, even one equal to an earlier
    // one (A, B, then A), is a new operation.
    const keys = operationKeys(panelKey, owner.current, ownKeys.current);
    const what = JSON.stringify([next, context.supersede]);
    let key = keys.get(what);
    if (key === undefined) {
      key = env.newId();
      keys.set(what, key);
    }
    const observed = context.renewed ? observedNow : context.observed;
    const request = setAnchorRequest(task, next, key, observed ?? undefined);
    try {
      const outcome =
        context.supersede === null
          ? await outbox.enqueue(request)
          : await outbox.supersede(context.supersede, request);
      if (outcome.kind === "queued" || outcome.kind === "superseded") {
        keys.delete(what);
        announcer.announce(next === null ? ANCHOR_REMOVED : ANCHOR_SAVED);
        return null;
      }
      // Told that the task changed, the person checks it and saves again (WEB-13a's rule for its own dialogs): that next press is a
      // deliberate save of the task as it is then, still checked when it is written. Any supersession it was making stands.
      if (outcome.reason === "changed")
        return {
          refused: ANCHOR_NOT_SAVED_CHANGED,
          context: { ...context, renewed: true },
        };
      if (outcome.reason === "denied") return ANCHOR_NOT_SAVED_DENIED;
      return copy.refusalMessage(outcome.reason) ?? copy.NOT_WRITABLE;
    } catch {
      return copy.refusalMessage("storage");
    }
  };

  if (repeats) return null;
  const offline = !env.online;
  const statusLine = !synced
    ? BINDING_UNSYNCED
    : offline
      ? BINDING_OFFLINE
      : read === undefined || read.kind === "reading"
        ? BINDING_READING
        : read.kind === "failed"
          ? BINDING_FAILED
          : anchor === null
            ? NOT_ANCHORED
            : anchoredTo(describeAnchor(anchor, knownNames(anchor)));
  const state = !synced
    ? "unsynced"
    : offline
      ? "offline"
      : read === undefined
        ? "reading"
        : read.kind === "read"
          ? anchor === null
            ? "none"
            : "anchored"
          : read.kind;
  const conflictAnchor =
    conflictBody.status === "ready" && conflictBody.value !== null
      ? anchorOfCommand(conflictBody.value.command)
      : undefined;
  return (
    <section
      aria-labelledby={heading}
      data-anchor-section={state}
      className="flex flex-col gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
    >
      <h2 id={heading} className="text-[13.5px] font-medium text-ink-1">
        {SECTION_HEADING}
      </h2>
      <p data-anchor-status="" className="text-[13px] text-ink-2">
        {statusLine}
        {binding !== null && !binding.active ? ` ${AUTOMATION_OFF}.` : ""}
      </p>
      {read?.kind === "failed" && !offline ? (
        <span className="flex">
          <Button
            variant="quiet"
            onClick={() =>
              visit !== null &&
              readBindingAgain(
                env.identity,
                visit,
                task.id,
                env.api,
                live.current,
              )
            }
          >
            {TRY_AGAIN}
          </Button>
        </span>
      ) : null}
      {pending ? (
        <p data-anchor-queued="" className="text-[12.5px] text-ink-2">
          {ANCHOR_QUEUED}
        </p>
      ) : saving ? (
        <p data-anchor-saving="" className="text-[12.5px] text-ink-2">
          {ANCHOR_SAVING}
        </p>
      ) : null}
      {conflicted !== null ? (
        <div
          data-anchor-conflict={conflicted.local_id}
          className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-1"
        >
          <span>{ANCHOR_CONFLICT}</span>
          {canEdit && conflictAnchor !== undefined ? (
            <Button
              variant="quiet"
              onClick={() => open(conflictAnchor, conflicted.local_id)}
            >
              {REVIEW_ANCHOR}
            </Button>
          ) : null}
        </div>
      ) : null}
      {rejected !== null ? (
        <div
          data-anchor-rejected={rejected.local_id}
          className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-1"
        >
          <span>
            {anchorRejected(
              anchorRefusal(rejected, {
                repeats,
                seconds: anchor?.offset.kind === "elapsed_seconds",
              }),
            )}
          </span>
          <Button
            variant="quiet"
            onClick={() =>
              void actions.discard(rejected.local_id).then(
                () => undefined,
                () => undefined,
              )
            }
          >
            {DISMISS_ANCHOR}
          </Button>
        </div>
      ) : null}
      {offline ? (
        <p className="text-[12.5px] text-ink-2">{BINDING_OFFLINE_EDIT}</p>
      ) : null}
      <span className="flex">
        {!canEdit ? (
          <Button disabled reason={ANCHOR_NOT_SAVED_DENIED}>
            {anchor === null ? ANCHOR_ACTION : CHANGE_ANCHOR}
          </Button>
        ) : !env.writable ? (
          <Button disabled reason={copy.NOT_WRITABLE}>
            {anchor === null ? ANCHOR_ACTION : CHANGE_ANCHOR}
          </Button>
        ) : (
          <Button onClick={() => open(anchor, null)}>
            {anchor === null ? ANCHOR_ACTION : CHANGE_ANCHOR}
          </Button>
        )}
      </span>
      {dialog !== null ? (
        <AnchorDialog
          editor={dialog}
          repeats={repeats}
          onSave={(next, _names, _draft, context) => save(next, context)}
          {...(dialog.context().anchor !== null || anchor !== null
            ? { onRemove: (context: PanelFor) => save(null, context) }
            : {})}
          {...(owner.current === null
            ? {}
            : {
                onRetain: () =>
                  retainPanel(panelKey, dialog as AnchorEditor<unknown>),
              })}
          // Cancel, Escape, the close icon: the session shown ends unless the sync control kept it; a consumed one has left already. Only
          // the session shown closes this panel (never an earlier one's late answer).
          onClose={() => {
            if (!dialog.retained())
              discardPanel(panelKey, dialog as AnchorEditor<unknown>);
            setDialog((d) => (d === dialog ? null : d));
          }}
        />
      ) : null}
    </section>
  );
}
