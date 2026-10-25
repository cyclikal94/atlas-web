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
import {
  completeKept,
  disownKept,
  editKept,
  keptEntry,
  keptKey,
  useKeptInput,
} from "../kept-input";
import { type ComposedList, roomFor } from "../model/list-view";
import { listItem } from "../model/lists";
import { useListActions } from "./actions";
import { PICKER } from "./copy";
import { ReadNotice } from "./ReadNotice";
import { usePickerPage } from "./reads";

export const pickerEditor = (listId: string) => `list-picker:${listId}`;

interface PickerInput {
  query: string;
  /** In the order selected. A selection the search hides stays selected and counted (PRODUCT-DECISIONS-20261011). */
  selected: string[];
  /**
   * The local id of each selected task's add, chosen when it is selected: a retry after an uncertain save reuses it (`duplicate`, never a
   * second add). With the outstanding create of a task not sent yet, the add waits for it (D-10b-11).
   */
  attempts: Record<string, string>;
  after: Record<string, string>;
}

const empty = (): PickerInput => ({
  query: "",
  selected: [],
  attempts: {},
  after: {},
});

/** Applies `change` to the session `session` of `key`, wherever its editor is (mounted or not), and to the mounted editor's view. */
function editSession(
  key: string,
  session: number,
  change: (value: PickerInput) => PickerInput,
  edit: (change: (value: PickerInput) => PickerInput) => void,
): void {
  const entry = keptEntry<PickerInput>(key);
  if (entry !== null && entry.session === session)
    editKept(key, session, change(entry.value));
  edit(change);
}

/**
 * "Add task to list" (plan §4.6, D-10b-10..12): the tasks this device can offer (its cached tasks and the ones it created and has not
 * sent, never another person's), searched, a page of 100 at a time. Selection is capped by the room the composed list has; "Add selected"
 * checks that room again against the LATEST composition, then saves one `list_item` per task, in the order selected. A partial save keeps
 * the rest selected. The session is the screen visit's (`kept-input.ts`).
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
  const selected = kept.value.selected.filter((id) => !members.has(id));
  const room = roomFor(list);
  const full = selected.length >= room;
  // The count of results is announced once a search settles (politely).
  const items = page.value?.items ?? null;
  const more = page.value?.next !== null && page.value?.next !== undefined;
  useEffect(() => {
    if (items === null || page.reading) return;
    announcer.announce(PICKER.results(items.length, more), "polite");
  }, [items, more, page.reading, announcer]);
  const toggle = (id: string, after: string | null) =>
    kept.edit((value) => {
      if (value.selected.includes(id))
        return {
          ...value,
          selected: value.selected.filter((s) => s !== id),
        };
      return {
        ...value,
        selected: [...value.selected, id],
        attempts: {
          ...value.attempts,
          [id]: value.attempts[id] ?? env.newId(),
        },
        after: after === null ? value.after : { ...value.after, [id]: after },
      };
    });
  const discard = () => disownKept(key);
  const save = async () => {
    if (kept.busy) return;
    const now = latest.current;
    const input = kept.value;
    const chosen = input.selected.filter(
      (id) => !(now.members ?? []).includes(id),
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
    const queued = new Set<string>();
    let reason: string | null = null;
    try {
      for (const taskId of chosen) {
        const outcome = await actions.enqueue(
          listItem({
            listId,
            taskId,
            included: true,
            after: input.after[taskId] ?? null,
            localId: input.attempts[taskId] as string,
          }),
          "",
        );
        if (outcome.ok) queued.add(taskId);
        else {
          reason = outcome.message ?? copy.refusalMessage("storage");
          break;
        }
      }
    } finally {
      const all = queued.size === chosen.length;
      // The tasks saved leave the selection (newer edits stay): never added twice, never lost.
      const leave = (value: PickerInput): PickerInput => ({
        ...value,
        selected: value.selected.filter((id) => !queued.has(id)),
      });
      if (all) {
        announcer.announce(PICKER.added(queued.size, now.row.label), "polite");
        if (completeKept(ticket, true, { note: PICKER.newer }) === "kept")
          editSession(key, ticket.session, leave, kept.edit);
      } else {
        if (queued.size > 0) editSession(key, ticket.session, leave, kept.edit);
        completeKept(ticket, false, {
          note:
            queued.size > 0
              ? PICKER.partial(queued.size, chosen.length, reason ?? "")
              : reason,
        });
      }
    }
  };
  const shownNote = note ?? kept.note;
  return (
    <Dialog
      open
      onClose={onClose}
      onDiscard={discard}
      title={PICKER.title}
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
              const checked = kept.value.selected.includes(item.id);
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
