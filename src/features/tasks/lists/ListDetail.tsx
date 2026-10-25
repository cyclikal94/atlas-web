import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { PageHeading } from "../../../components/ui/page-heading";
import { ResourcePolicyEditor } from "../../sharing";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { keptKey } from "../kept-input";
import { archiveResource } from "../model/commands";
import { atCapacity, listItemOf, listRows } from "../model/list-view";
import { listItem } from "../model/lists";
import { useListActions } from "./actions";
import { DETAIL } from "./copy";
import { holdsInput, RenameListDialog, renameEditor } from "./dialogs";
import { ReadNotice } from "./ReadNotice";
import { useListDetail } from "./reads";
import { pickerEditor, TaskPicker } from "./TaskPicker";

/**
 * The list detail (plan §4.2-4.3, 4.7): the list's name and controls, its tasks (each a link to the task; a WITHHELD row for a task id
 * this device cannot name, D-10b-6), "Add task to list" with the capacity pre-check (D-10b-10), and the load-bearing access caption
 * (D-10b-9). Everything comes from ONE certified read of this device's data; "This list isn't on this device" only from a complete one.
 * The drawn row checkbox is not implemented (D-10b-5a): recording lives on Today and the task.
 */
export function ListDetail({ listId }: { listId: string }) {
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
  const rows =
    list === null || value === null
      ? []
      : listRows(list, value.tasks, new Set(value.projected.keys()));
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

  if (value === null) {
    if (view.noDatabase) return <Absent />;
    if (view.error !== null)
      return (
        <div className="flex flex-col gap-3" data-list-detail="error">
          <BackLink />
          <ReadNotice error={view.error} stale={false} retry={view.retry} />
        </div>
      );
    return (
      <p aria-busy="true" className="text-[13px] text-ink-2">
        {DETAIL.loading}
      </p>
    );
  }
  if (list === null) return <Absent />;

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

  return (
    <article
      ref={article}
      className="flex max-w-[760px] flex-col gap-6"
      data-list-detail={listId}
      data-list-projected={list.projected ? "" : undefined}
    >
      <div className="flex flex-col gap-2">
        <BackLink />
        {list.pending ? (
          <span
            data-pending-mark={list.pending}
            className="text-[12px] text-ink-2"
          >
            {copy.PENDING[list.pending]}
          </span>
        ) : null}
        <PageHeading>{row.label}</PageHeading>
        {row.archived ? (
          <p className="text-[13px] text-ink-2" data-list-archived="">
            {DETAIL.archivedNote}
          </p>
        ) : null}
        <div className="flex flex-wrap items-start gap-2">
          {editable ? (
            <Button onClick={openFrom("rename")}>{DETAIL.rename}</Button>
          ) : (
            <Button disabled reason={noEdit}>
              {DETAIL.rename}
            </Button>
          )}
          {list.projected ? (
            <Button disabled reason={DETAIL.sharingWait}>
              {DETAIL.sharing}
            </Button>
          ) : (
            <Button onClick={openFrom("sharing")}>{DETAIL.sharing}</Button>
          )}
          {editable ? (
            <Button onClick={archive}>
              {row.archived ? DETAIL.restore : DETAIL.archive}
            </Button>
          ) : (
            <Button disabled reason={noEdit}>
              {row.archived ? DETAIL.restore : DETAIL.archive}
            </Button>
          )}
        </div>
      </div>
      {view.error !== null ? (
        <ReadNotice error={view.error} stale retry={view.retry} />
      ) : null}
      {conflicted ? (
        <p className="text-[12.5px] text-conflict-text" data-list-attention="">
          {DETAIL.attention}{" "}
          <Link to="/sync" className="underline underline-offset-2">
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
            className="text-[12.5px] text-conflict-text"
            data-list-refused={draft.local_id}
          >
            {DETAIL.refused(task?.label ?? null)}{" "}
            <Link to="/sync" className="underline underline-offset-2">
              {DETAIL.openSync}
            </Link>
          </p>
        );
      })}
      {!readable ? (
        <p className="text-[13.5px] text-ink-2" data-list-unreadable="">
          {DETAIL.unreadable}
        </p>
      ) : (
        <section className="flex flex-col gap-3">
          {rows.length === 0 ? (
            <p className="text-[13px] text-ink-2">{DETAIL.empty}</p>
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
                    className="flex min-h-11 list-none items-center gap-3 border-t border-hairline py-1"
                  >
                    {item.kind === "task" ? (
                      <Link
                        to="/tasks/$taskId"
                        params={{ taskId: item.id }}
                        search={{}}
                        className="atlas-transition flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-row px-2 text-[14px] text-ink-1 hover:bg-row-hover"
                      >
                        <span className="truncate">{item.title}</span>
                        {item.archived ? (
                          <span className="flex-none text-[11.5px] text-ink-2">
                            {DETAIL.archivedTask}
                          </span>
                        ) : null}
                        {item.projected ? (
                          <span className="flex-none text-[11.5px] text-ink-2">
                            {DETAIL.notSent}
                          </span>
                        ) : null}
                      </Link>
                    ) : (
                      <span
                        className="flex min-w-0 flex-1 items-center gap-2 px-2 text-[14px] text-ink-2"
                        data-list-withheld=""
                      >
                        <span
                          aria-hidden="true"
                          className="size-[7px] flex-none rounded-full bg-withheld"
                        />
                        {DETAIL.withheld}
                        <span className="text-[11.5px] text-ink-2">
                          {DETAIL.withheldTag}
                        </span>
                      </span>
                    )}
                    {item.mark ? (
                      <span
                        data-pending-mark={item.mark}
                        className="flex-none text-[11.5px] text-ink-2"
                      >
                        {copy.PENDING[item.mark]}
                      </span>
                    ) : null}
                    {editable ? (
                      <Button
                        variant="quiet"
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
          <div data-list-add="">
            {!editable ? (
              <Button disabled reason={noEdit}>
                {DETAIL.add}
              </Button>
            ) : full ? (
              <Button disabled reason={DETAIL.atLimit}>
                {DETAIL.add}
              </Button>
            ) : (
              <Button onClick={openFrom("picker")}>{DETAIL.add}</Button>
            )}
          </div>
        </section>
      )}
      <p className="max-w-[560px] text-[12px] text-ink-2" data-list-caption="">
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
    </article>
  );
}

function BackLink() {
  return (
    <Link
      to="/tasks/lists"
      className="atlas-transition inline-flex min-h-11 w-fit items-center text-[13px] text-ink-2 hover:text-ink-1"
    >
      {DETAIL.back}
    </Link>
  );
}

function Absent() {
  return (
    <div className="flex flex-col gap-3" data-list-detail="absent">
      <BackLink />
      <p className="text-[13.5px] text-ink-2">{DETAIL.absent}</p>
    </div>
  );
}
