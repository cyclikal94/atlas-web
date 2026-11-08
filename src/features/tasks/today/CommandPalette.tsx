import { useNavigate } from "@tanstack/react-router";
import { ListTodo, Plus, Search, User } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "../../../components/ui/dialog";
import { useResourceList } from "../../../data";
import { cn } from "../../../lib/utils";
import * as copy from "../copy";
import { TasksBoundary, useTasksEnv } from "../env";
import { useQuickAdd } from "./quick-add";

/**
 * The search pill of the Final design ("Search or add anything… ⌘K"): a button in the page header that opens the palette. The palette
 * finds a task, a list or a person by name among what this device holds, and with no match (or always, as the last choice) adds the
 * typed line as a task on the day (`useQuickAdd`). ⌘K or Ctrl+K opens it from the page it is on.
 */
export function SearchPill({
  day,
  zone,
  className,
}: {
  /** The day a typed line is added to (today when the page has none). */
  day: string;
  zone: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={copy.PALETTE.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-search-pill=""
        onClick={() => setOpen(true)}
        className={cn(
          "atlas-transition flex h-11 min-w-0 items-center gap-2.5 rounded-full border border-border bg-card px-3.5 text-[13px] text-muted-foreground hover:border-input hover:text-foreground",
          className,
        )}
      >
        <Search aria-hidden="true" className="size-4 flex-none" />
        <span className="min-w-0 flex-1 truncate text-left">
          {copy.PALETTE.placeholder}
        </span>
        <kbd className="hidden rounded-[5px] border border-border px-1.5 py-0.5 font-num text-[11px] tablet:inline">
          {copy.PALETTE.shortcut}
        </kbd>
      </button>
      {open ? (
        <TasksBoundary>
          <CommandPalette
            day={day}
            zone={zone}
            onClose={() => setOpen(false)}
            returnFocus={button}
          />
        </TasksBoundary>
      ) : null}
    </>
  );
}

interface Result {
  key: string;
  kind: "task" | "list" | "person" | "add" | "new";
  label: string;
  go(): void;
}

const normalise = (text: string) =>
  text.toLocaleLowerCase().replace(/\s+/g, " ").trim();

function CommandPalette({
  day,
  zone,
  onClose,
  returnFocus,
}: {
  day: string;
  zone: string;
  onClose(): void;
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  const env = useTasksEnv();
  const navigate = useNavigate();
  const add = useQuickAdd(day, zone);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const id = useId();
  const tasks = useResourceList({ kind: "task", limit: 100 });
  const lists = useResourceList({ kind: "list", limit: 100 });
  const people = useResourceList({ kind: "person", limit: 100 });
  const needle = normalise(query);
  const results = useMemo<Result[]>(() => {
    const out: Result[] = [];
    const rows = (read: typeof tasks) =>
      read.status === "ready"
        ? read.value.rows.map((r) => r.merged).filter((r) => !r.archived)
        : [];
    if (needle !== "") {
      for (const row of rows(tasks))
        if (normalise(row.label).includes(needle))
          out.push({
            key: `task:${row.id}`,
            kind: "task",
            label: row.label,
            go: () =>
              void navigate({
                to: "/tasks/$taskId",
                params: { taskId: row.id },
                search: {},
              }),
          });
      for (const row of rows(lists))
        if (normalise(row.label).includes(needle))
          out.push({
            key: `list:${row.id}`,
            kind: "list",
            label: row.label,
            go: () =>
              void navigate({
                to: "/tasks/lists/$listId",
                params: { listId: row.id },
              }),
          });
      for (const row of rows(people))
        if (normalise(row.label).includes(needle))
          out.push({
            key: `person:${row.id}`,
            kind: "person",
            label: row.label,
            go: () =>
              void navigate({
                to: "/people/$personId",
                params: { personId: row.id },
              }),
          });
    }
    const shown = out.slice(0, 12);
    if (needle !== "" && env.writable)
      shown.push({
        key: "add",
        kind: "add",
        label: copy.PALETTE.add(query.trim(), dayWord(day, zone, env.now())),
        go: () => undefined,
      });
    shown.push({
      key: "new",
      kind: "new",
      label: copy.PALETTE.newTask,
      go: () => void navigate({ to: "/tasks/new" }),
    });
    return shown;
  }, [needle, query, tasks, lists, people, navigate, env, day, zone]);
  const current = results[Math.min(active, results.length - 1)] ?? null;
  const choose = async (result: Result) => {
    if (result.kind === "add") {
      if (busy) return;
      setBusy(true);
      const outcome = await add(query.trim());
      setBusy(false);
      if (!outcome.ok) {
        setNote(outcome.message ?? copy.NOT_WRITABLE);
        return;
      }
      onClose();
      return;
    }
    onClose();
    result.go();
  };
  const ICON = {
    task: Search,
    list: ListTodo,
    person: User,
    add: Plus,
    new: Plus,
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={copy.PALETTE.title}
      returnFocusRef={returnFocus}
      syncControl={false}
      initialFocusSelector="input"
    >
      <div className="flex flex-col gap-3" data-palette="">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            role="combobox"
            aria-label={copy.PALETTE.label}
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={current ? `${id}-${current.key}` : undefined}
            aria-autocomplete="list"
            placeholder={copy.PALETTE.placeholder}
            value={query}
            disabled={busy}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
              setNote(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((n) => Math.min(n + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((n) => Math.max(n - 1, 0));
              } else if (event.key === "Enter" && current) {
                event.preventDefault();
                void choose(current);
              }
            }}
            className="h-11 w-full rounded-full border border-input bg-background pl-10 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring"
          />
        </div>
        {needle === "" ? (
          <p className="text-xs text-muted-foreground">{copy.PALETTE.empty}</p>
        ) : null}
        {note ? <p className="text-xs text-destructive">{note}</p> : null}
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={copy.PALETTE.title}
          className="flex flex-col gap-0.5"
        >
          {results.map((result, index) => {
            const Icon = ICON[result.kind];
            const selected = result === current;
            return (
              <div
                key={result.key}
                id={`${id}-${result.key}`}
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                data-palette-result={result.kind}
                className={cn(
                  "atlas-transition flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 text-sm text-foreground hover:bg-accent",
                  selected ? "bg-accent text-accent-foreground" : "",
                )}
                onMouseEnter={() => setActive(index)}
                onClick={() => void choose(result)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void choose(result);
                }}
              >
                <Icon
                  aria-hidden="true"
                  className="size-4 flex-none text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{result.label}</span>
                {result.kind === "task" ||
                result.kind === "list" ||
                result.kind === "person" ? (
                  <span className="text-xs text-muted-foreground">
                    {result.kind === "task"
                      ? copy.PALETTE.tasks
                      : result.kind === "list"
                        ? copy.PALETTE.lists
                        : copy.PALETTE.people}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        {needle !== "" &&
        results.every((r) => r.kind === "add" || r.kind === "new") ? (
          <p className="text-xs text-muted-foreground">
            {copy.PALETTE.none(query.trim())}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** "today", or the day's short label. */
function dayWord(day: string, zone: string, nowMs: number): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
  }).format(new Date(nowMs));
  if (day === today) return "today";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}
