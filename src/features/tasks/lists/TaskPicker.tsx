import {
  type RefObject,
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { completeKept, disownKept, keptKey, useKeptInput } from "../kept-input";
import { type ComposedList, roomFor } from "../model/list-view";
import { type Evidence, type Issued, useListActions } from "./actions";
import { PICKER } from "./copy";
import { ReadNotice } from "./ReadNotice";
import { usePickerPage } from "./reads";

export const pickerEditor = (listId: string) => `list-picker:${listId}`;

/**
 * One selection of a task: an INTENTION to add it, whose add is named by the local id chosen when it was selected (R2, revision 2). The
 * task identifies the member, not the add: a task deselected and selected again is a new selection, a new add under a new id, never
 * deduplicated against an earlier one, whatever became of that one. It holds no authority over the task's create (revision 4, D1 /
 * DA-N1): which create an add waits for, if any, is read when the add is made (`ListActions.prepareAdd`), never remembered from the page.
 */
interface Choice {
  task: string;
  localId: string;
  /** For display only: the task's title when it was selected. */
  title: string;
  /** The last Add found nothing on this device that makes the task (its unsent create discarded or refused, the task removed). */
  missing?: true;
}

/**
 * An add that was sent and whose answer did not say whether it was stored (`SaveOutcome.uncertain`; D1, revision 3): its exact request,
 * id and database, kept APART from the selection, so that deselecting or choosing the task again, the list's membership, the search or a
 * page hiding it can never drop it. `uncertain`: not looked up yet; `unknown`/`changed`: as the dialogs' attempts (`dialogs.tsx`).
 */
interface Unresolved extends Issued {
  task: string;
  state: "uncertain" | Exclude<Evidence, "stored">;
}

interface PickerInput {
  query: string;
  /** In the order selected. A selection the search hides stays selected and counted (PRODUCT-DECISIONS-20261011). */
  selected: Choice[];
  /** Earlier adds not settled yet, selected now or not. */
  unresolved: Unresolved[];
}

const empty = (): PickerInput => ({ query: "", selected: [], unresolved: [] });

/**
 * "Add task to list" (plan §4.6, D-10b-10..12): the tasks this device can offer (its cached tasks and the ones it created and has not
 * sent, never another person's), searched, a page of 100 at a time. Selection is capped by the room the composed list has; "Add selected"
 * checks that room again against the LATEST composition, then saves one `list_item` per task, in the order selected. A partial save keeps
 * the rest selected. The session is the screen visit's (`kept-input.ts`).
 *
 * An add whose answer was lost is settled by what is STORED, not by the list's membership (R2), and is never sent again (D1, revision 3;
 * approved 25 October 2026): Add selected first looks up every earlier add not settled yet (read only, `ListActions.reconcile`), whether
 * its task is selected, hidden or a member now. One found as it was sent is done (it leaves the selection, and the person is told: if the
 * task is not in the list now, choosing it again is a new add). While any other remains, Add selected writes NOTHING: what is selected and
 * searched stays, and the picker explains that the earlier outcome is unknown. Only the separate decision ("Add as new adds") then adds
 * what is selected now, each a new add under a new id (one selected under an earlier add's id gets a new one), neither cancelling nor
 * proving the earlier add; earlier adds whose task is not selected are not made again. Membership is never proof of which add made it,
 * and no add is made that the person did not choose.
 */
export function TaskPicker({
  list,
  onClose,
  returnFocusRef,
}: {
  /** The latest complete read of the list (its membership and room). */
  list: ComposedList;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const env = useTasksEnv();
  const actions = useListActions();
  const announcer = useAnnouncer();
  const listId = list.row.id;
  const key = keptKey(env.identity, pickerEditor(listId));
  const close = useRef(onClose);
  close.current = onClose;
  const latest = useRef(list);
  latest.current = list;
  const kept = useKeptInput<PickerInput>(key, env.identity, empty, {
    consumed: () => {
      close.current();
      return null;
    },
  });
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [note, setNote] = useState<string | null>(null);
  const search = useId();
  const caption = useId();
  const decision = useId();
  const query = useDeferredValue(kept.value.query);
  const members = new Set(list.members ?? []);
  const page = usePickerPage({
    listId,
    query,
    after: cursors[cursors.length - 1] ?? null,
    excluded: members,
  });
  const selected = kept.value.selected.filter((c) => !members.has(c.task));
  const room = roomFor(list);
  const full = selected.length >= room;
  // The count of results is announced once a search settles (politely).
  const items = page.value?.items ?? null;
  const more = page.value?.next !== null && page.value?.next !== undefined;
  useEffect(() => {
    if (items === null || page.reading) return;
    announcer.announce(PICKER.results(items.length, more), "polite");
  }, [items, more, page.reading, announcer]);
  const toggle = (task: string, title: string) =>
    kept.edit((value) => {
      // Deselecting leaves an earlier add that is not settled where it is (`unresolved`, D1).
      if (value.selected.some((c) => c.task === task))
        return {
          ...value,
          selected: value.selected.filter((c) => c.task !== task),
        };
      // A new selection, a new add: never the id of an earlier selection of this task (R2).
      const choice: Choice = {
        task,
        localId: env.newId(),
        title,
      };
      return { ...value, selected: [...value.selected, choice] };
    });
  const discard = () => disownKept(key);
  /** `again`: the person's decision to add what is selected now as new adds, after earlier adds this device could not settle (D1). */
  const save = async (again = false) => {
    if (kept.busy) return;
    const now = latest.current;
    const { unresolved } = kept.value;
    const chosen = kept.value.selected.filter(
      (c) => !(now.members ?? []).includes(c.task),
    );
    if (chosen.length === 0) return;
    if (again && !unresolved.some((u) => u.state !== "uncertain")) return;
    if (!now.row.can_edit) {
      setNote(actions.denied().message);
      return;
    }
    // Checked against the latest composition at the act: another tab may have added since the selection was made.
    const left = roomFor(now);
    if (chosen.length > left) {
      setNote(PICKER.short(left));
      return;
    }
    setNote(null);
    const ticket = kept.submit();
    if (ticket === null) return;
    // The decision is on the earlier adds it explained; one not looked up yet is looked up first, as on any Save.
    const looking = again
      ? unresolved.filter((u) => u.state === "uncertain")
      : unresolved;
    // A selection under an earlier add's id is a new add under a new id once the person has decided (never the predecessor's id).
    const renamed = new Map<string, string>();
    if (again)
      for (const c of chosen)
        if (unresolved.some((u) => u.localId === c.localId))
          renamed.set(c.localId, env.newId());
    // By local id (the selection), never by task: a later selection of the same task is another add.
    const queued = new Set<string>();
    const found = new Set<string>();
    const unsettled = new Map<string, Exclude<Evidence, "stored">>();
    const issued: Unresolved[] = [];
    // A selection whose task nothing on this device makes now: kept selected, shown so that it can be deselected (revision 4).
    let missing: string | null = null;
    let refused = false;
    let reason: string | null = null;
    try {
      for (const earlier of looking) {
        const evidence = await actions.reconcile(earlier);
        if (evidence === "stored") found.add(earlier.localId);
        else unsettled.set(earlier.localId, evidence);
      }
      // An earlier add not settled holds every add back until the person decides: nothing is written.
      if (unsettled.size === 0)
        for (const choice of chosen) {
          // An add whose answer was lost and that is stored after all: this selection is done, not made again (R2).
          if (found.has(choice.localId)) continue;
          const localId = renamed.get(choice.localId) ?? choice.localId;
          // What the add waits for is read NOW, from the task (revision 4): a create replaced since the selection is never named.
          const prepared = await actions.prepareAdd({
            listId,
            taskId: choice.task,
            localId,
          });
          // Issued only to the database the task was read in (its incarnation); nothing was written otherwise.
          const scope = actions.scope();
          if (prepared.kind !== "ready" || prepared.scope !== scope) {
            if (prepared.kind === "gone") missing = choice.localId;
            refused = true;
            reason = prepared.kind === "gone" ? PICKER.gone : PICKER.unread;
            break;
          }
          const outcome = await actions.enqueue(prepared.request, "");
          if (outcome.ok) queued.add(choice.localId);
          else {
            if (outcome.uncertain === true)
              issued.push({
                task: choice.task,
                localId,
                request: prepared.request,
                scope,
                state: "uncertain",
              });
            refused = true;
            reason =
              outcome.reason === "changed"
                ? PICKER.taskChanged
                : (outcome.message ?? copy.refusalMessage("storage"));
            break;
          }
        }
    } finally {
      // The decision is spent once something was sent on it: the earlier adds it was about are let go (a refusal before any write keeps
      // them, and the selection's ids, as they were).
      const decided = again && (queued.size > 0 || issued.length > 0);
      // ONE settlement of the session (`kept-input.ts`): the selections done leave; earlier adds found leave, the others keep what was
      // found; one that may have been stored now joins them; what was typed meanwhile (the search) stays. Never added twice, never lost.
      const leave = (value: PickerInput): PickerInput => ({
        ...value,
        selected: value.selected
          .filter((c) => !queued.has(c.localId) && !found.has(c.localId))
          .map(({ missing: _, ...c }) => ({
            ...c,
            ...(decided && renamed.has(c.localId)
              ? { localId: renamed.get(c.localId) as string }
              : {}),
            ...(c.localId === missing ? { missing: true as const } : {}),
          })),
        unresolved: [
          ...(decided ? [] : value.unresolved)
            .filter((u) => !found.has(u.localId))
            .map((u) => {
              const state = unsettled.get(u.localId);
              return state === undefined ? u : { ...u, state };
            }),
          ...issued,
        ],
      });
      const earlier = chosen.filter((c) => found.has(c.localId)).length;
      const outstanding = [...unsettled.values()];
      const notes = [
        outstanding.length > 0
          ? outstanding.includes("unknown")
            ? PICKER.unknown(outstanding.length)
            : PICKER.changed(outstanding.length)
          : null,
        refused && queued.size > 0
          ? PICKER.partial(queued.size, chosen.length, reason ?? "")
          : reason,
        earlier > 0 ? PICKER.earlier(earlier) : null,
      ].filter((n): n is string => n !== null && n !== "");
      if (outstanding.length > 0)
        announcer.announce(notes[0] as string, "assertive");
      if (!refused && queued.size > 0)
        announcer.announce(PICKER.added(queued.size, now.row.label), "polite");
      completeKept<PickerInput>(ticket, queued.size === chosen.length, {
        note:
          notes.length > 0 ? notes.join(" ") : refused ? null : PICKER.newer,
        change: leave,
      });
    }
  };
  const undecided = kept.value.unresolved.some((u) => u.state !== "uncertain");
  const gone = selected.filter((c) => c.missing === true);
  const shownNote = note ?? kept.note;
  return (
    <Dialog
      open
      onClose={onClose}
      onDiscard={discard}
      title={PICKER.title}
      initialFocusSelector='input[type="search"]'
      {...(returnFocusRef ? { returnFocusRef } : {})}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span
            className="text-[12.5px] text-ink-2"
            data-picker-selected={selected.length}
          >
            {PICKER.selected(selected.length)}
          </span>
          <span className="flex gap-2">
            <Button
              variant="quiet"
              onClick={() => {
                discard();
                onClose();
              }}
            >
              {PICKER.cancel}
            </Button>
            {selected.length === 0 || !env.writable ? (
              <Button
                variant="primary"
                disabled
                reason={!env.writable ? copy.NOT_WRITABLE : PICKER.chooseFirst}
              >
                {PICKER.submit}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void save()}>
                {PICKER.submit}
              </Button>
            )}
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-3" data-task-picker="">
        <label htmlFor={search} className="sr-only">
          {PICKER.searchLabel}
        </label>
        <input
          id={search}
          type="search"
          value={kept.value.query}
          placeholder={PICKER.search}
          data-field-edge=""
          aria-describedby={caption}
          onChange={(event) => {
            const value = event.target.value;
            setCursors([null]);
            kept.edit((v) => ({ ...v, query: value }));
          }}
          className="min-h-11 w-full rounded-control border border-field-edge bg-canvas px-3 text-[14px] text-ink-1 placeholder:text-ink-3"
        />
        <p id={caption} className="text-[12px] text-ink-2">
          {PICKER.caption}
        </p>
        <p className="text-[12px] text-ink-2" data-picker-room={room}>
          {PICKER.room(Math.max(0, room - selected.length))}
        </p>
        {page.error !== null ? (
          <ReadNotice
            error={page.error}
            stale={items !== null}
            retry={page.retry}
          />
        ) : null}
        {items === null ? (
          page.error === null ? (
            <p aria-busy="true" className="sr-only">
              {PICKER.loading}
            </p>
          ) : null
        ) : items.length === 0 ? (
          <p className="text-[13px] text-ink-2">
            {kept.value.query.trim() === "" ? PICKER.none : PICKER.noMatch}
          </p>
        ) : (
          <fieldset className="flex flex-col" disabled={kept.busy}>
            <legend className="sr-only">{PICKER.group}</legend>
            {items.map((item) => {
              const checked = kept.value.selected.some(
                (c) => c.task === item.id,
              );
              return (
                <label
                  key={item.id}
                  data-picker-task={item.id}
                  className="flex min-h-11 items-center gap-2.5 border-t border-hairline px-0.5 py-2 text-[13.5px] text-ink-1"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && full}
                    onChange={() => toggle(item.id, item.title)}
                    className="size-[15px]"
                  />
                  <span className="min-w-0 flex-1 break-words">
                    {item.title}
                  </span>
                  {item.createLocalId !== null ? (
                    <span className="flex-none text-[11.5px] text-ink-2">
                      {PICKER.notSent}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </fieldset>
        )}
        <div className="flex gap-2">
          {cursors.length > 1 ? (
            <Button variant="quiet" onClick={() => setCursors([null])}>
              {PICKER.first}
            </Button>
          ) : null}
          {more ? (
            <Button
              variant="quiet"
              onClick={() =>
                setCursors((c) => [...c, page.value?.next ?? null])
              }
            >
              {PICKER.more}
            </Button>
          ) : null}
        </div>
        {shownNote ? (
          <p className="text-[12.5px] text-ink-2" data-list-note="">
            {shownNote}
          </p>
        ) : null}
        {gone.map((c) => (
          <p
            key={c.localId}
            className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2"
            data-picker-missing={c.task}
          >
            <span className="min-w-0 flex-1 break-words">
              {PICKER.missing(c.title)}
            </span>
            <Button
              variant="quiet"
              aria-label={PICKER.deselect(c.title)}
              onClick={() => toggle(c.task, c.title)}
            >
              {PICKER.deselectShort}
            </Button>
          </p>
        ))}
        {undecided ? (
          <div
            className="flex flex-col items-start gap-2"
            data-list-decision=""
          >
            <p id={decision} className="text-[12.5px] text-ink-2">
              {PICKER.againNote}
            </p>
            {selected.length === 0 || !env.writable ? (
              <Button
                disabled
                reason={!env.writable ? copy.NOT_WRITABLE : PICKER.chooseFirst}
              >
                {PICKER.again}
              </Button>
            ) : (
              <Button
                aria-describedby={decision}
                onClick={() => void save(true)}
              >
                {PICKER.again}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
