import { Link } from "@tanstack/react-router";
import { ChevronRight, ListChecks, Plus } from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { List } from "../../../components/ui/list";
import { useAllOutstandingByKind, useResourceList } from "../../../data";
import * as copy from "../copy";
import { QUEUED_KINDS } from "../model/commands";
import { patched } from "../view";

export const LIST_COPY = {
  heading: "Your tasks",
  newTask: "New task",
  lists: "Lists",
  showArchived: "Archived",
  showActive: "Active",
  none: "No tasks here yet.",
  more: "More tasks",
  first: "First page",
  archivedTag: "Archived",
} as const;

/**
 * The Tasks list pane (WF-TASK-01): the cached tasks a page of 100 at a time (Q9), with my outstanding creates first (projected, "Not sent
 * yet") and an "Archived" filter (the cross-kind "Archived items" ledger is a Settings follow-up).
 */
export function TaskList({ selected }: { selected?: string }) {
  const heading = useId();
  const [archived, setArchived] = useState(false);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const page = useResourceList({ kind: "task", after, limit: 100 });
  const outstanding = useAllOutstandingByKind(QUEUED_KINDS);
  const drafts = outstanding.status === "ready" ? outstanding.value.drafts : [];
  const creates = drafts
    .filter((d) => d.kind === "create_task")
    .map((d) => patched(null, d.target_resource_ids[0] as string, drafts))
    .filter((row) => row !== null);
  const rows =
    page.status === "ready"
      ? page.value.rows.map(
          (r) => patched(r.merged, r.base.id, drafts) ?? r.merged,
        )
      : [];
  const ids = new Set(rows.map((r) => r.id));
  // A read that failed is not an empty list, and saved changes that could not be read are not "none" (R9, revision 3; Q17). No database
  // on this device (`absent`) is a genuinely empty list.
  const failed = [page, outstanding].some(
    (read) => read.status === "unavailable" && read.reason !== "absent",
  );
  const known = [page, outstanding].every(
    (read) =>
      read.status === "ready" ||
      (read.status === "unavailable" && read.reason === "absent"),
  );
  const shown = [
    ...(cursors.length === 1 ? creates.filter((c) => !ids.has(c.id)) : []),
    ...rows,
  ].filter((row) => row.archived === archived);
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-3"
      data-task-list=""
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id={heading}
          className="text-base font-semibold tracking-tight text-foreground"
        >
          {LIST_COPY.heading}
        </h2>
        <span className="flex gap-2">
          {/* WEB-10b (D-10b-1): Lists live under the Tasks destination, reached from here (no rail or tab item of their own). */}
          <Button asChild variant="outline">
            <Link to="/tasks/lists" data-lists-link="">
              {LIST_COPY.lists}
            </Link>
          </Button>
          <Button asChild variant="default">
            <Link to="/tasks/new">
              <Plus aria-hidden="true" strokeWidth={2.25} />
              {LIST_COPY.newTask}
            </Link>
          </Button>
        </span>
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
        {LIST_COPY.showArchived}
      </label>
      {failed ? (
        <p className="text-sm text-muted-foreground" data-task-list-error="">
          {copy.LOCAL_FAILED}
        </p>
      ) : null}
      {shown.length === 0 ? (
        known ? (
          <EmptyState icon={ListChecks} compact>
            {LIST_COPY.none}
          </EmptyState>
        ) : null
      ) : (
        <List className="atlas-stagger overflow-hidden rounded-xl border bg-card p-1.5 shadow-sm">
          {shown.map((row) => {
            const pending = drafts.some((d) =>
              d.index_targets.includes(row.id),
            );
            return (
              <li key={row.id} className="list-none">
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId: row.id }}
                  data-task-link={row.id}
                  aria-current={selected === row.id ? "page" : undefined}
                  className={`atlas-transition group flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-foreground hover:bg-accent ${
                    selected === row.id
                      ? "bg-accent font-medium text-accent-foreground"
                      : ""
                  }`}
                >
                  <span className="truncate">{row.label}</span>
                  <span className="flex flex-none items-center gap-2">
                    {pending ? (
                      <Badge variant="muted">{copy.PENDING.queued}</Badge>
                    ) : null}
                    <ChevronRight
                      aria-hidden="true"
                      size={15}
                      className="size-4 text-muted-foreground"
                    />
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
            {LIST_COPY.first}
          </Button>
        ) : null}
        {page.status === "ready" && page.value.next !== null ? (
          <Button
            variant="ghost"
            onClick={() => setCursors([...cursors, page.value.next])}
          >
            {LIST_COPY.more}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
