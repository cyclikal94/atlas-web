import {
  Link,
  useMatchRoute,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { ChevronRight, ListTodo, Plus } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useLayoutMode } from "../../../app/shell/layout-mode";
import { usePinnedLists, useTaskWrapper } from "../../../app/shell/preferences";
import { Button, buttonVariants } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { List } from "../../../components/ui/list";
import { PageHeader, TitleText } from "../../../components/ui/page-header";
import {
  ColourDot,
  ListRow,
  RowGroupHeading,
} from "../../../components/ui/row";
import * as copy from "../copy";
import { TaskDetail } from "../detail/TaskDetail";
import { useTasksEnv } from "../env";
import { keptKey, useKeptRecovery } from "../kept-input";
import type { ComposedList } from "../model/list-view";
import { todayIn } from "../model/time";
import { effectiveWrapper } from "../screens";
import { LISTS_TITLE } from "../titles";
import { SearchPill } from "../today/CommandPalette";
import { PANE_COPY, TaskPane } from "../today/TaskPane";
import type { RowOpen } from "../today/TodayRow";
import { LISTS } from "./copy";
import {
  CREATE_EDITOR,
  CREATE_RECOVERY,
  CreateListDialog,
  createStart,
  holdsInput,
} from "./dialogs";
import { ListDetail } from "./ListDetail";
import { ReadNotice } from "./ReadNotice";
import { useListsPane } from "./reads";

/**
 * WEB-10b's Lists (D-10b-1/2): the pane of lists and, from 1280 px, the list detail beside it; below that one column (the pane at
 * `/tasks/lists`, the detail with the breadcrumb at `/tasks/lists/<id>`). The detail is drawn here from the matched id, so the routes'
 * first load carries no second lazy screen.
 */
export function ListsLayout() {
  const match = useMatchRoute()({ to: "/tasks/lists/$listId" });
  const listId = match === false ? null : match.listId;
  const navigate = useNavigate();
  const task = useRouterState({
    select: (state) =>
      (state.location.search as { task?: string }).task ?? null,
  });
  // A task from the list opens in the chosen container (Settings · Layout), as it does from the day.
  const wrapper = effectiveWrapper(useTaskWrapper(), useLayoutMode());
  const close = useCallback(() => {
    if (listId === null) return;
    void navigate({
      to: "/tasks/lists/$listId",
      params: { listId },
      search: {},
      replace: true,
    });
  }, [navigate, listId]);
  const openTask =
    wrapper === "page" || listId === null
      ? undefined
      : (taskId: string): RowOpen => ({
          to: "/tasks/lists/$listId",
          params: { listId },
          search: { task: taskId },
        });
  // The Final design: all the lists take the page, and a list is a page of its own (its breadcrumb leads back).
  if (listId === null)
    return (
      <div className="flex min-w-0 flex-col" data-lists-layout="">
        <nav aria-label={LISTS.pane} className="mt-1 min-w-0">
          <ListsPane selected={null} />
        </nav>
      </div>
    );
  const page = (
    <ListDetail
      key={listId}
      listId={listId}
      {...(openTask ? { openTask } : {})}
    />
  );
  if (task === null || wrapper === "page")
    return (
      <div className="flex min-w-0 flex-col" data-lists-layout="">
        {page}
      </div>
    );
  const content = (
    <TaskDetail key={task} taskId={task} embedded onClose={close} />
  );
  if (wrapper === "split")
    return (
      <div
        className="grid items-start gap-8 desktop:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
        data-lists-layout=""
        data-lists-split=""
      >
        {page}
        <TaskPane wrapper="split" label={PANE_COPY.label} onClose={close}>
          {content}
        </TaskPane>
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col" data-lists-layout="">
      {page}
      <TaskPane wrapper={wrapper} label={PANE_COPY.label} onClose={close}>
        {content}
      </TaskPane>
    </div>
  );
}

/**
 * The pane (plan §4.1, on the Final design of 8 November 2026): this device's lists a page (100) at a time, by name within a page, with
 * the lists created here and not received yet first, as rows (a colour, the name, a short fact, the count), the ones pinned to the
 * sidebar in their own group; an "Archived" filter; the search pill and "New list" at the head. A read that failed is never "No lists yet".
 */
function ListsPane({ selected }: { selected: string | null }) {
  const env = useTasksEnv();
  const heading = useId();
  const [archived, setArchived] = useState(false);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const pane = useListsPane({ archived, after });
  const pinned = usePinnedLists();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The create dialog is shown again when the person comes back to this screen with its input kept (the in-dialog sync control).
  const createKey = keptKey(env.identity, CREATE_EDITOR);
  const [creating, setCreating] = useState(() => holdsInput(createKey));
  // Revision 38 (WEB-14a, DA-R40-D): the dialog is not open after an app-update reload, so this screen looks for the copy the page before
  // it left, and opens the dialog on it (restored, never saved).
  const recovered = useKeptRecovery(
    createKey,
    env.identity,
    CREATE_RECOVERY,
    () => createStart(env.newId),
    false,
  );
  useEffect(() => {
    if (!creating && recovered.restored !== null && holdsInput(createKey))
      setCreating(true);
  }, [creating, recovered.restored, createKey]);
  const opener = useRef<HTMLButtonElement | null>(null);
  const value = pane.value;
  const lists = value?.lists ?? [];
  const pinnedIds = new Set(pinned.map((pin) => pin.id));
  const pinnedLists = lists.filter((list) => pinnedIds.has(list.row.id));
  const otherLists = lists.filter((list) => !pinnedIds.has(list.row.id));
  const newList = (label: string, primary = false) => (
    <button
      ref={opener}
      type="button"
      onClick={() => setCreating(true)}
      data-new-list=""
      className={buttonVariants({ variant: primary ? "default" : "outline" })}
    >
      <Plus aria-hidden="true" strokeWidth={2.25} />
      {label}
    </button>
  );
  const rows = (group: ComposedList[]) => (
    <List className="flex flex-col">
      {group.map((list) => {
        const id = list.row.id;
        const current = selected === id;
        return (
          <li key={id} className="list-none">
            <ListRow
              to="/tasks/lists/$listId"
              params={{ listId: id }}
              data-list-link={id}
              current={current}
              leading={<ColourDot id={id} />}
              fact={
                list.row.archived
                  ? LISTS.archivedGroup
                  : list.pending
                    ? copy.PENDING[list.pending]
                    : undefined
              }
              trailing={
                <>
                  {list.pending ? (
                    <span
                      data-pending-mark={list.pending}
                      className="text-xs text-muted-foreground tablet:sr-only"
                    >
                      {copy.PENDING[list.pending]}
                    </span>
                  ) : null}
                  {list.members === null ? (
                    <span className="w-10 text-right font-num text-xs text-muted-foreground">
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">{LISTS.countUnknown}</span>
                    </span>
                  ) : (
                    <span
                      className="w-10 text-right font-num text-xs text-muted-foreground"
                      data-list-count={list.members.length}
                    >
                      <span aria-hidden="true">{list.members.length}</span>
                      <span className="sr-only">
                        {LISTS.count(list.members.length)}
                      </span>
                    </span>
                  )}
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 flex-none text-muted-foreground"
                  />
                </>
              }
            >
              {list.row.label}
            </ListRow>
          </li>
        );
      })}
    </List>
  );
  return (
    <section
      aria-labelledby={heading}
      className="flex min-w-0 flex-col gap-3"
      data-lists-pane=""
    >
      <h2 id={heading} className="sr-only">
        {LISTS.pane}
      </h2>
      {/* The Final design: the large title under the route's eyebrow heading, the summary line, the search pill and the way to a new list. */}
      <PageHeader
        title={<TitleText>{LISTS_TITLE}</TitleText>}
        summary={
          <span data-lists-summary="">
            {value === null
              ? LISTS.loading
              : LISTS.summary(
                  lists.length,
                  pinnedLists.length,
                  value.next !== null,
                )}
          </span>
        }
        actions={
          <>
            <SearchPill
              day={todayIn(zone, env.now())}
              zone={zone}
              className="min-w-0 flex-1 tablet:w-[260px] tablet:flex-none"
            />
            {newList(LISTS.newList, true)}
          </>
        }
      />
      <label className="inline-flex min-h-11 items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={archived}
          onChange={() => {
            setArchived(!archived);
            setCursors([null]);
          }}
          className="size-4"
        />
        {LISTS.archivedFilter}
      </label>
      {value !== null && value.attention > 0 ? (
        <p className="text-xs text-destructive" data-lists-attention="">
          {LISTS.attention}{" "}
          <Link
            to="/sync"
            search={{ tab: "conflicts" }}
            className="underline underline-offset-2"
          >
            {LISTS.openSync}
          </Link>
        </p>
      ) : null}
      {pane.error !== null ? (
        <ReadNotice
          error={pane.error}
          stale={value !== null}
          retry={pane.retry}
        />
      ) : null}
      {value === null ? (
        pane.noDatabase ? (
          <Empty archived={archived}>
            {archived ? null : newList(LISTS.newListEmpty)}
          </Empty>
        ) : pane.error === null ? (
          <p aria-busy="true" className="sr-only">
            {LISTS.loading}
          </p>
        ) : null
      ) : lists.length === 0 && !value.any && cursors.length === 1 ? (
        <Empty archived={archived}>
          {archived ? null : newList(LISTS.newListEmpty)}
        </Empty>
      ) : lists.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-lists-none="">
          {archived ? LISTS.emptyArchived : LISTS.noneHere}
        </p>
      ) : (
        <div className="flex flex-col" data-lists-rows="">
          {pinnedLists.length > 0 ? (
            <>
              <RowGroupHeading>{LISTS.pinned}</RowGroupHeading>
              {rows(pinnedLists)}
            </>
          ) : null}
          {otherLists.length > 0 ? (
            <>
              <RowGroupHeading>
                {archived ? LISTS.archivedGroup : LISTS.all}
              </RowGroupHeading>
              {rows(otherLists)}
            </>
          ) : null}
        </div>
      )}
      <div className="flex gap-2">
        {cursors.length > 1 ? (
          <Button variant="ghost" onClick={() => setCursors([null])}>
            {LISTS.first}
          </Button>
        ) : null}
        {value !== null && value.next !== null ? (
          <Button
            variant="ghost"
            onClick={() => setCursors([...cursors, value.next])}
          >
            {LISTS.more}
          </Button>
        ) : null}
      </div>
      {creating ? (
        <CreateListDialog
          onClose={() => setCreating(false)}
          returnFocusRef={opener}
        />
      ) : null}
    </section>
  );
}

function Empty({
  archived,
  children,
}: {
  archived: boolean;
  children: ReactNode;
}) {
  return (
    <EmptyState icon={ListTodo} action={children} data-lists-empty="">
      {archived ? LISTS.emptyArchived : LISTS.empty}
    </EmptyState>
  );
}
