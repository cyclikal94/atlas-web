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
import { listItem } from "../model/lists";
import { useListActions } from "./actions";
import { PICKER } from "./copy";
import { ReadNotice } from "./ReadNotice";
import { usePickerPage } from "./reads";

export const pickerEditor = (listId: string) => `list-picker:${listId}`;

/**
 * One selection of a task: an INTENTION to add it, whose add is named by the local id chosen when it was selected (R2, revision 2). The
 * task identifies the member, not the add: a task deselected and selected again is a new selection, a new add under a new id, never
 * deduplicated against an earlier one, whatever became of that one. A retry of the same selection after an answer that was lost sends the
 * same add again (`duplicate`, never a second add).
 */
interface Choice {
  task: string;
  localId: string;
  /** The outstanding create of a task not sent yet, as it was when selected: the add waits for it (D-10b-11). */
  after: string | null;
  /** Sent, and the answer did not say whether it was stored (`SaveOutcome.uncertain`); it stays so after a later definite refusal. */
  issued: boolean;
}

interface PickerInput {
  query: string;
  /** In the order selected. A selection the search hides stays selected and counted (PRODUCT-DECISIONS-20261011). */
  selected: Choice[];
}

const empty = (): PickerInput => ({ query: "", selected: [] });

/**
 * "Add task to list" (plan §4.6, D-10b-10..12): the tasks this device can offer (its cached tasks and the ones it created and has not
 * sent, never another person's), searched, a page of 100 at a time. Selection is capped by the room the composed list has; "Add selected"
 * checks that room again against the LATEST composition, then saves one `list_item` per task, in the order selected. A partial save keeps
 * the rest selected. The session is the screen visit's (`kept-input.ts`).
 *
 * A selection whose add was sent and its answer lost is settled by what is STORED, not by the list's membership (R2, revision 2): Add
 * selected first asks whether a draft is stored under its id; if so that selection is done (it leaves the selection, and the person is
 * told: if the task is not in the list now, choosing it again is a new add), else the same add is sent again. Membership is never taken as
 * proof of which add made it, and no add is made that the person did not choose.
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
  const toggle = (task: string, after: string | null) =>
    kept.edit((value) => {
      if (value.selected.some((c) => c.task === task))
        return {
          ...value,
          selected: value.selected.filter((c) => c.task !== task),
        };
      // A new selection, a new add: never the id of an earlier selection of this task (R2).
      const choice: Choice = {
        task,
        localId: env.newId(),
        after,
        issued: false,
      };
      return { ...value, selected: [...value.selected, choice] };
    });
  const discard = () => disownKept(key);
  const save = async () => {
    if (kept.busy) return;
    const now = latest.current;
    const chosen = kept.value.selected.filter(
      (c) => !(now.members ?? []).includes(c.task),
    );
    if (chosen.length === 0) return;
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
    // By local id (the selection), never by task: a later selection of the same task is another add.
    const queued = new Set<string>();
    const earlier = new Set<string>();
    const uncertain = new Set<string>();
    let refused = false;
    let reason: string | null = null;
    try {
      for (const choice of chosen) {
        // An add whose answer was lost and that is stored after all: this selection is done, not made again (R2). Not found, or no
        // answer: the same add is sent again (the outbox recognises it if it is stored).
        if (choice.issued && (await actions.stored(choice.localId)) === true) {
          earlier.add(choice.localId);
          continue;
        }
        const outcome = await actions.enqueue(
          listItem({
            listId,
            taskId: choice.task,
            included: true,
            after: choice.after,
            localId: choice.localId,
          }),
          "",
        );
        if (outcome.ok) queued.add(choice.localId);
        else {
          if (outcome.uncertain === true) uncertain.add(choice.localId);
          refused = true;
          reason = outcome.message ?? copy.refusalMessage("storage");
          break;
        }
      }
    } finally {
      // ONE settlement of the session (`kept-input.ts`): the selections done leave, the ones that may have been stored are marked so;
      // what was typed meanwhile (the search) stays. Never added twice, never lost.
      const leave = (value: PickerInput): PickerInput => ({
        ...value,
        selected: value.selected
          .filter((c) => !queued.has(c.localId) && !earlier.has(c.localId))
          .map((c) => (uncertain.has(c.localId) ? { ...c, issued: true } : c)),
      });
      const notes = [
        refused && queued.size > 0
          ? PICKER.partial(queued.size, chosen.length, reason ?? "")
          : reason,
        earlier.size > 0 ? PICKER.earlier(earlier.size) : null,
      ].filter((n): n is string => n !== null && n !== "");
      if (!refused && queued.size > 0)
        announcer.announce(PICKER.added(queued.size, now.row.label), "polite");
      completeKept<PickerInput>(ticket, queued.size === chosen.length, {
        note:
          notes.length > 0 ? notes.join(" ") : refused ? null : PICKER.newer,
        change: leave,
      });
    }
  };
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
                    onChange={() => toggle(item.id, item.createLocalId)}
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
      </div>
    </Dialog>
  );
}
