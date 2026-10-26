import { Link, useMatchRoute } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { List } from "../../../components/ui/list";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { keptKey } from "../kept-input";
import { LISTS } from "./copy";
import { CREATE_EDITOR, CreateListDialog, holdsInput } from "./dialogs";
import { ListDetail } from "./ListDetail";
import { ReadNotice } from "./ReadNotice";
import { useListsPane } from "./reads";

/**
 * WEB-10b's Lists (D-10b-1/2): the pane of lists and, from 1280 px, the list detail beside it; below that one column (the pane at
 * `/tasks/lists`, the detail with "‹ Lists" at `/tasks/lists/<id>`). The detail is drawn here from the matched id, so the routes'
 * first load carries no second lazy screen.
 */
export function ListsLayout() {
  const match = useMatchRoute()({ to: "/tasks/lists/$listId" });
  const listId = match === false ? null : match.listId;
  return (
    <div className="flex flex-col gap-6 desktop:flex-row" data-lists-layout="">
      <nav
        aria-label={LISTS.pane}
        className={`${listId === null ? "block" : "hidden desktop:block"} desktop:w-[300px]`}
      >
        <div className={listId === null ? "mt-4" : ""}>
          <ListsPane selected={listId} />
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        {listId === null ? (
          <p className="hidden text-sm text-muted-foreground desktop:block">
            {LISTS.choose}
          </p>
        ) : (
          <ListDetail key={listId} listId={listId} />
        )}
      </div>
    </div>
  );
}

/**
 * The pane (plan §4.1): this device's lists a page (100) at a time, by name within a page, with the lists created here and not received
 * yet first; an "Archived" filter; a count per list; and "+ New list". A read that failed is never "No lists yet".
 */
function ListsPane({ selected }: { selected: string | null }) {
  const env = useTasksEnv();
  const heading = useId();
  const [archived, setArchived] = useState(false);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const pane = useListsPane({ archived, after });
  // The create dialog is shown again when the person comes back to this screen with its input kept (the in-dialog sync control).
  const createKey = keptKey(env.identity, CREATE_EDITOR);
  const [creating, setCreating] = useState(() => holdsInput(createKey));
  const opener = useRef<HTMLButtonElement | null>(null);
  const value = pane.value;
  const lists = value?.lists ?? [];
  const newList = (label: string) => (
    <button
      ref={opener}
      type="button"
      onClick={() => setCreating(true)}
      data-new-list=""
      className="atlas-transition inline-flex min-h-11 items-center gap-1.5 rounded-md border border-dashed border-primary/25 px-4 text-sm font-medium text-primary hover:border-primary hover:bg-accent"
    >
      {label}
    </button>
  );
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-3"
      data-lists-pane=""
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id={heading}
          className="text-base font-semibold tracking-tight text-foreground"
        >
          {LISTS.pane}
        </h2>
        {newList(LISTS.newList)}
      </div>
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
        <List className="atlas-stagger overflow-hidden rounded-xl border bg-card p-1.5 shadow-sm">
          {lists.map((list) => {
            const id = list.row.id;
            const current = selected === id;
            return (
              <li key={id} className="list-none">
                <Link
                  to="/tasks/lists/$listId"
                  params={{ listId: id }}
                  data-list-link={id}
                  aria-current={current ? "page" : undefined}
                  className={`atlas-transition flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-foreground hover:bg-accent ${current ? "bg-accent font-medium text-accent-foreground" : ""}`}
                >
                  <span className="truncate">{list.row.label}</span>
                  <span className="flex flex-none items-center gap-2">
                    {list.pending ? (
                      <span
                        data-pending-mark={list.pending}
                        className="text-xs text-muted-foreground"
                      >
                        {copy.PENDING[list.pending]}
                      </span>
                    ) : null}
                    {list.members === null ? (
                      <span className="font-num text-xs text-muted-foreground">
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">{LISTS.countUnknown}</span>
                      </span>
                    ) : (
                      <span
                        className="font-num text-xs text-muted-foreground"
                        data-list-count={list.members.length}
                      >
                        <span aria-hidden="true">{list.members.length}</span>
                        <span className="sr-only">
                          {LISTS.count(list.members.length)}
                        </span>
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </List>
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
