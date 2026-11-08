import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  pinList,
  renamePinnedList,
  unpinList,
  usePinnedLists,
} from "../../../app/shell/preferences";
import { ActionMenu, type MenuItem } from "../../../components/ui/action-menu";
import { Breadcrumb } from "../../../components/ui/breadcrumb";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { Eyebrow, PageHeader } from "../../../components/ui/page-header";
import { PageHeading } from "../../../components/ui/page-heading";
import { ColourDot } from "../../../components/ui/row";
import { cn } from "../../../lib/utils";
import { ResourcePolicyEditor } from "../../sharing";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { keptKey, useKeptRecovery } from "../kept-input";
import { archiveResource } from "../model/commands";
import { atCapacity, listItemOf, listRows } from "../model/list-view";
import { listItem } from "../model/lists";
import { todayIn } from "../model/time";
import { LISTS_TITLE } from "../titles";
import { SearchPill } from "../today/CommandPalette";
import type { RowOpen } from "../today/TodayRow";
import { useListActions } from "./actions";
import { DETAIL, LISTS } from "./copy";
import {
  holdsInput,
  RenameListDialog,
  renameEditor,
  renameRecovery,
  renameStart,
} from "./dialogs";
import { ReadNotice } from "./ReadNotice";
import { useListDetail } from "./reads";
import {
  pickerEditor,
  pickerRecovery,
  pickerStart,
  TaskPicker,
} from "./TaskPicker";

/**
 * The list detail (plan §4.2-4.3, 4.7): the list's name and controls, its tasks (each a link to the task; a WITHHELD row for a task id
 * this device cannot name, D-10b-6), "Add task to list" with the capacity pre-check (D-10b-10), and the load-bearing access caption
 * (D-10b-9). Everything comes from ONE certified read of this device's data; "This list isn't on this device" only from a complete one.
 * The drawn row checkbox is not implemented (D-10b-5a): recording lives on Today and the task.
 *
 * Every state has the page's one heading (R4): the list's name once it is read, else the destination's ("Lists", nothing of the list),
 * always the same element (`Frame`), so the focus a navigation gave it stays when the read completes.
 */
export function ListDetail({
  listId,
  openTask,
}: {
  listId: string;
  /** Where a task row leads when the task opens beside the list (Settings · Layout). */
  openTask?: (taskId: string) => RowOpen;
}) {
  const env = useTasksEnv();
  const actions = useListActions();
  const view = useListDetail(listId);
  // A dialog whose input the person kept (the in-dialog sync control) is shown again when they come back.
  const [dialog, setDialog] = useState<"rename" | "picker" | "sharing" | null>(
    () =>
      holdsInput(keptKey(env.identity, renameEditor(listId)))
        ? "rename"
        : holdsInput(keptKey(env.identity, pickerEditor(listId)))
          ? "picker"
          : null,
  );
  const opener = useRef<HTMLElement | null>(null);
  const article = useRef<HTMLElement | null>(null);
  // After Remove, focus moves to the next row's Remove (or "Add task to list") once the row has left.
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  const value = view.value;
  const list = value?.list ?? null;
  // The sidebar's pin for this list (kept on this device): its label follows a rename.
  const pinned = usePinnedLists().some((pin) => pin.id === listId);
  const label = list?.row.label ?? null;
  useEffect(() => {
    if (pinned && label !== null) renamePinnedList(listId, label);
  }, [pinned, label, listId]);
  const rows =
    list === null || value === null
      ? []
      : listRows(list, value.tasks, new Set(value.projected.keys()));
  // Revision 38 (WEB-14a, DA-R40-D): neither dialog is open after an app-update reload, so this screen looks for the copies the page before
  // it left, and opens the dialog on one (restored, never saved). A rename's start is the list as read now.
  const renameKey = keptKey(env.identity, renameEditor(listId));
  const pickerKey = keptKey(env.identity, pickerEditor(listId));
  const renamed = useKeptRecovery(
    renameKey,
    env.identity,
    renameRecovery(listId),
    () => renameStart(list, env.newId),
    false,
  );
  const picked = useKeptRecovery(
    pickerKey,
    env.identity,
    pickerRecovery(listId, env.newId),
    pickerStart,
    false,
  );
  useEffect(() => {
    if (dialog !== null) return;
    if (renamed.restored !== null && holdsInput(renameKey)) setDialog("rename");
    else if (picked.restored !== null && holdsInput(pickerKey))
      setDialog("picker");
  }, [dialog, renamed.restored, picked.restored, renameKey, pickerKey]);
  useEffect(() => {
    if (focusAfter === null) return;
    const root = article.current;
    const target =
      root?.querySelector<HTMLElement>(`[data-list-remove="${focusAfter}"]`) ??
      root?.querySelector<HTMLElement>("[data-list-add] button");
    if (target) {
      target.focus();
      setFocusAfter(null);
    }
  });
  const openFrom =
    (which: "rename" | "picker" | "sharing") =>
    (event: { currentTarget: HTMLElement }) => {
      opener.current = event.currentTarget;
      setDialog(which);
    };
  // A dialog opened from "More" returns focus to the More control (the menu itself has gone by then).
  const openFromMenu = (which: "rename" | "sharing") => () => {
    opener.current =
      article.current?.querySelector<HTMLElement>("[data-list-more]") ?? null;
    setDialog(which);
  };

  if (value === null) {
    if (view.noDatabase) return absent();
    if (view.error !== null)
      return (
        <Frame state="error">
          <ReadNotice error={view.error} stale={false} retry={view.retry} />
        </Frame>
      );
    return (
      <Frame state="loading">
        <p aria-busy="true" className="text-sm text-muted-foreground">
          {DETAIL.loading}
        </p>
      </Frame>
    );
  }
  // A list gone while its rename is open keeps the dialog and what was typed in it; Save says why it cannot (§4.5).
  if (list === null)
    return absent(
      dialog === "rename" ? (
        <RenameListDialog
          listId={listId}
          list={null}
          onClose={() => setDialog(null)}
          returnFocusRef={opener}
        />
      ) : null,
    );

  const { row } = list;
  const editable = row.can_edit && env.writable;
  const noEdit = !env.writable ? copy.NOT_WRITABLE : DETAIL.noEdit;
  const readable = list.members !== null;
  const full = atCapacity(list);
  const remove = async (taskId: string, title: string | null, next: string) => {
    if (!row.can_edit) {
      actions.denied();
      return;
    }
    const outcome = await actions.enqueue(
      listItem({ listId, taskId, included: false }),
      title === null
        ? DETAIL.removedWithheld(row.label)
        : DETAIL.removed(title, row.label),
    );
    if (outcome.ok) setFocusAfter(next);
  };
  const archive = () =>
    row.can_edit
      ? void actions.enqueue(
          archiveResource({ id: listId, archived: !row.archived }),
          row.archived ? DETAIL.restored : DETAIL.archived,
        )
      : void actions.denied();
  const conflicted = list.attention > 0;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const menu: MenuItem[] = [
    editable
      ? { label: DETAIL.rename, onSelect: openFromMenu("rename") }
      : { label: DETAIL.rename, reason: noEdit, onSelect: () => undefined },
    {
      label: pinned ? DETAIL.unpin : DETAIL.pin,
      onSelect: () =>
        pinned ? unpinList(listId) : pinList({ id: listId, label: row.label }),
    },
    list.projected
      ? {
          label: DETAIL.sharing,
          reason: DETAIL.sharingWait,
          onSelect: () => undefined,
        }
      : { label: DETAIL.sharing, onSelect: openFromMenu("sharing") },
    editable
      ? {
          label: row.archived ? DETAIL.restore : DETAIL.archive,
          onSelect: archive,
          tone: row.archived ? "default" : "destructive",
        }
      : {
          label: row.archived ? DETAIL.restore : DETAIL.archive,
          reason: noEdit,
          onSelect: () => undefined,
        },
  ];
  const count = list.members === null ? null : list.members.length;

  return (
    <Frame
      state={listId}
      projected={list.projected}
      articleRef={article}
      heading={row.label}
      mark={
        list.pending ? (
          <span
            data-pending-mark={list.pending}
            className="text-xs text-muted-foreground"
          >
            {copy.PENDING[list.pending]}
          </span>
        ) : null
      }
      summary={
        <>
          <ColourDot id={listId} size={8} />
          {count === null ? LISTS.countUnknown : LISTS.count(count)}
          {row.archived ? (
            <span data-list-archived="">{` · ${DETAIL.archivedNote}`}</span>
          ) : null}
        </>
      }
      controls={
        <>
          <SearchPill
            day={todayIn(zone, env.now())}
            zone={zone}
            className="min-w-0 flex-1 tablet:w-[260px] tablet:flex-none"
          />
          <ActionMenu items={menu} data-list-more="" />
        </>
      }
    >
      {view.error !== null ? (
        <ReadNotice error={view.error} stale retry={view.retry} />
      ) : null}
      {conflicted ? (
        <p className="text-xs text-destructive" data-list-attention="">
          {DETAIL.attention}{" "}
          <Link
            to="/sync"
            search={{ tab: "conflicts" }}
            className="underline underline-offset-2"
          >
            {DETAIL.openSync}
          </Link>
        </p>
      ) : null}
      {list.refused.map((draft) => {
        const taskId = listItemOf(draft, listId)?.taskId ?? null;
        const task = taskId === null ? undefined : value.tasks.get(taskId);
        return (
          <p
            key={draft.local_id}
            className="text-xs text-destructive"
            data-list-refused={draft.local_id}
          >
            {DETAIL.refused(task?.label ?? null)}{" "}
            <Link
              to="/sync"
              search={{ tab: "conflicts" }}
              className="underline underline-offset-2"
            >
              {DETAIL.openSync}
            </Link>
          </p>
        );
      })}
      {!readable ? (
        <p className="text-sm text-muted-foreground" data-list-unreadable="">
          {DETAIL.unreadable}
        </p>
      ) : (
        // A list is Today's row design (the Final design, 8 November 2026): the way to add a task first, then one row per task, the
        // withheld ones last; "Remove" is a quiet control at the end of a row, shown on hover and focus from the tablet up.
        <section className="flex min-w-0 flex-col" data-list-box="">
          <div data-list-add="" className="-mx-3.5">
            {!editable ? (
              <div className="px-3.5 py-1.5">
                <Button disabled reason={noEdit}>
                  {DETAIL.add}
                </Button>
              </div>
            ) : full ? (
              <div className="px-3.5 py-1.5">
                <Button disabled reason={DETAIL.atLimit}>
                  {DETAIL.add}
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={openFrom("picker")}
                className="atlas-transition flex min-h-12 w-full items-center gap-3.5 rounded-[10px] px-3.5 text-left text-[15px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              >
                <Plus
                  aria-hidden="true"
                  className="size-[18px] flex-none"
                  strokeWidth={1.9}
                />
                {DETAIL.add}
              </button>
            )}
          </div>
          {rows.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">{DETAIL.empty}</p>
          ) : (
            <List className="flex flex-col">
              {rows.map((item, index) => {
                const next = rows[index + 1]?.id ?? "add";
                const title = item.kind === "task" ? item.title : null;
                return (
                  <li
                    key={item.id}
                    data-list-row={item.kind}
                    data-list-task={item.id}
                    className="atlas-transition group -mx-3.5 flex min-h-12 list-none items-center gap-3.5 rounded-[10px] px-3.5 hover:bg-accent/60"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-[18px] flex-none rounded-full border-2",
                        item.kind === "task" && item.archived
                          ? "border-dashed border-input"
                          : "border-input",
                      )}
                    />
                    {item.kind === "task" ? (
                      <Link
                        {...(openTask
                          ? (() => {
                              const target = openTask(item.id);
                              return {
                                to: target.to,
                                params: target.params,
                                search: target.search,
                              };
                            })()
                          : {
                              to: "/tasks/$taskId",
                              params: { taskId: item.id },
                            })}
                        search={{}}
                        className="atlas-transition flex min-h-11 min-w-0 flex-1 items-center gap-2 text-[15px] text-foreground hover:text-primary"
                      >
                        <span className="truncate">{item.title}</span>
                      </Link>
                    ) : (
                      <span
                        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-[15px] text-muted-foreground"
                        data-list-withheld=""
                      >
                        {DETAIL.withheld}
                        <span className="text-xs text-muted-foreground">
                          {DETAIL.withheldTag}
                        </span>
                      </span>
                    )}
                    <span className="flex flex-none items-center gap-2 text-xs text-muted-foreground">
                      {item.kind === "task" && item.archived ? (
                        <span>{DETAIL.archivedTask}</span>
                      ) : null}
                      {item.kind === "task" && item.projected ? (
                        <span>{DETAIL.notSent}</span>
                      ) : null}
                      {item.mark ? (
                        <span data-pending-mark={item.mark}>
                          {copy.PENDING[item.mark]}
                        </span>
                      ) : null}
                    </span>
                    {editable ? (
                      <Button
                        variant="ghost"
                        className="text-muted-foreground tablet:opacity-0 tablet:group-focus-within:opacity-100 tablet:group-hover:opacity-100 tablet:focus-visible:opacity-100"
                        data-list-remove={item.id}
                        aria-label={
                          title === null
                            ? DETAIL.removeWithheld
                            : DETAIL.removeLabel(title)
                        }
                        onClick={() => void remove(item.id, title, next)}
                      >
                        {DETAIL.remove}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </List>
          )}
        </section>
      )}
      <p
        className="max-w-[560px] text-xs text-muted-foreground"
        data-list-caption=""
      >
        {DETAIL.caption}
      </p>
      {dialog === "rename" ? (
        <RenameListDialog
          listId={listId}
          list={list}
          onClose={() => setDialog(null)}
          returnFocusRef={opener}
        />
      ) : null}
      {dialog === "picker" && readable ? (
        <TaskPicker
          list={list}
          onClose={() => setDialog(null)}
          returnFocusRef={opener}
        />
      ) : null}
      {dialog === "sharing" && !list.projected ? (
        <ResourcePolicyEditor
          resourceId={listId}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        />
      ) : null}
    </Frame>
  );
}

/**
 * The detail's frame in every state (the Final design): the breadcrumb, the small word "List", the page heading (the same element
 * throughout, R4) with its summary line, the search pill and "More" at the right, then the state's content. `state` is the list's id
 * once it is read, else `loading`, `error` or `absent`. `data-list-detail` names only a read list or a settled state: while loading it is
 * absent (`data-list-loading` instead), so nothing reads "loading" as an id.
 */
function Frame({
  state,
  projected = false,
  articleRef,
  heading = LISTS_TITLE,
  mark = null,
  summary = null,
  controls = null,
  children,
}: {
  state: string;
  projected?: boolean;
  articleRef?: RefObject<HTMLElement | null>;
  heading?: string;
  mark?: ReactNode;
  summary?: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
}) {
  const read = state !== "loading" && state !== "error" && state !== "absent";
  return (
    <article
      ref={articleRef}
      className="flex min-w-0 flex-col gap-5"
      data-list-detail={state === "loading" ? undefined : state}
      data-list-loading={state === "loading" ? "" : undefined}
      data-list-projected={projected ? "" : undefined}
    >
      <Breadcrumb
        items={[{ label: LISTS_TITLE, to: "/tasks/lists" }]}
        current={read ? heading : LISTS_TITLE}
      />
      <PageHeader
        eyebrow={read ? <Eyebrow>{DETAIL.eyebrow}</Eyebrow> : undefined}
        title={<PageHeading>{heading}</PageHeading>}
        summary={
          summary || mark ? (
            <span
              className="inline-flex flex-wrap items-center gap-2"
              data-list-summary=""
            >
              {summary}
              {mark}
            </span>
          ) : undefined
        }
        actions={controls ?? undefined}
      />
      {children}
    </article>
  );
}

/** A plain element, not a component: the same `Frame` as the other states, so its heading is the same element. */
function absent(dialog: ReactNode = null) {
  return (
    <Frame state="absent">
      <p className="text-sm text-muted-foreground">{DETAIL.absent}</p>
      {dialog}
    </Frame>
  );
}
