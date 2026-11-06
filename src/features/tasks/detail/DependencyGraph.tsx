import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLayoutMode } from "../../../app/shell/layout-mode";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import * as copy from "../copy";
import { dayLabel } from "../format";
import type {
  DependencyGraph,
  DependencyGraphNode,
  DependencyState,
} from "../model/contract";
import {
  BOX_HEIGHT,
  BOX_WIDTH,
  type GraphIndex,
  indexGraph,
  mapLayout,
  mapRefusal,
  stateOf,
  summaryOf,
  type TreeItem,
  treeOf,
} from "../model/graph";
import type { GraphView } from "./useDependencyGraph";

/** Provisional copy (STAGED-ACCEPTANCE-20261011; docs/tasks.md WEB-18 checkpoint list). The state labels are the backend's suggestions. */
export const GRAPH_COPY = {
  treeName: "What this waits for",
  thisTask: "This task",
  state: {
    satisfied: "Done",
    waiting: "Waiting",
    restricted: "Waiting on something you can't see",
    ready: "To do",
    unknown: "Not shown here",
  } satisfies Record<DependencyState, string>,
  direct: "Needed directly",
  further: "Further back",
  needsToo: (title: string) => `Needs “${title}” too`,
  summary: (n: number, done: number) => `Waits directly for ${n}: ${done} done`,
  open: (titles: readonly string[]) =>
    `Still open: ${titles.map((t) => `“${t}”`).join(", ")}`,
  hiddenToo: "and something you can't see",
  furtherBack: (m: number) => `${m} more further back`,
  restricted:
    "Some of it is private to someone else, so this isn't the whole picture.",
  partial: "There's more further back than shown here.",
  rootRestrictedOnly: "This waits for something you can't see.",
  none: "Nothing needs doing first",
  notExpanded: "What this waits for isn't shown here.",
  alsoHidden: "It also waits for something you can't see.",
  waitsFor: "Waits for:",
  neededBy: "Needed by:",
  nothing: "Nothing",
  openTask: "Open this task",
  checkAgain: "Check again",
  checking: "Checking again…",
  stale: (time: string) => `Couldn't check again. Shown as it was at ${time}.`,
  failed: "Couldn't show how these connect",
  loading: "Loading how these connect",
  offline: "Can be checked when you're online.",
  tooMuch: "Too much to draw here; the list shows all of it.",
  fallback:
    "How these connect couldn't be shown. This is the order they can be done in.",
  keys: "Arrow keys move through the list. Right opens an item, Left closes it or goes up a level.",
  undated: "No date",
  inspectorName: "Selected",
} as const;

const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

/** A node's label: its task's title from THIS answer and its day; a recurring task's days are told apart by the day. */
export function nodeLabel(
  index: GraphIndex,
  id: string,
): { title: string; day: string } {
  const node = index.node(id);
  const title = index.title(id) || copy.UNTITLED;
  return {
    title,
    day:
      node.slot.date === null ? GRAPH_COPY.undated : dayLabel(node.slot.date),
  };
}

const SECONDARY: ReadonlySet<string> = new Set([
  "missed",
  "excluded",
  "provisional",
]);

function StatePill({ node }: { node: DependencyGraphNode }) {
  const state = stateOf(node);
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span
        data-pill={state}
        className={`rounded-round border px-2 py-0.5 text-[11.5px] ${
          state === "satisfied"
            ? "border-done-edge text-done"
            : state === "ready"
              ? "border-field-edge text-action-ink"
              : state === "unknown"
                ? "border-hairline-strong text-ink-2"
                : "border-field-edge text-ink-1"
        }`}
      >
        {GRAPH_COPY.state[state]}
      </span>
      {SECONDARY.has(node.outcome) ? (
        <span className="text-[11.5px] text-ink-2">
          {copy.OUTCOME[node.outcome]}
        </span>
      ) : null}
    </span>
  );
}

// ---- the decorative map ------------------------------------------------------------------------------------------------------------
/**
 * D-18-3: decoration only (TASK-04: "the list beside it is the real control… the only version a screen reader gets"). Hidden from
 * assistive technology and holding nothing focusable; a pointer on a box selects that day in the list and moves focus there.
 */
function DependencyMap({
  graph,
  index,
  rootTitle,
  selected,
  onPick,
}: {
  graph: DependencyGraph;
  index: GraphIndex;
  /** This day's title as the rest of the dialog names it (the list's root item, the header's lines), so the two views agree. */
  rootTitle: string;
  selected: string | null;
  onPick(id: string): void;
}) {
  const marker = useId().replace(/:/g, "");
  const layout = useMemo(() => mapLayout(graph), [graph]);
  if (layout === null) return null;
  return (
    <div
      aria-hidden="true"
      data-graph-map=""
      className="relative shrink-0"
      style={{ width: layout.width, height: layout.height }}
    >
      <svg
        aria-hidden="true"
        width={layout.width}
        height={layout.height}
        className="pointer-events-none absolute inset-0 overflow-visible text-ink-2"
        focusable="false"
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
          </marker>
        </defs>
        {layout.paths.map((p) => (
          <path
            key={`${p.prerequisite}>${p.dependant}`}
            data-map-edge={`${p.prerequisite}>${p.dependant}`}
            d={p.d}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            markerEnd={`url(#${marker})`}
          />
        ))}
      </svg>
      {layout.boxes.map((box) => {
        const node = index.node(box.id);
        const root = box.id === graph.root_id;
        const { title, day } = nodeLabel(index, box.id);
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: decoration; the list is the control (D-18-3)
          <div
            key={box.id}
            data-map-node={box.id}
            data-state={stateOf(node)}
            data-selected={selected === box.id ? "" : undefined}
            onClick={() => onPick(box.id)}
            className={`absolute flex cursor-pointer flex-col justify-center gap-0.5 overflow-hidden rounded-row border px-2.5 ${
              stateOf(node) === "satisfied" ? "bg-done-tint" : "bg-canvas"
            } ${selected === box.id ? "border-action-fill" : root ? "border-field-edge" : "border-hairline-strong"}`}
            style={{
              left: box.x,
              top: box.y,
              width: BOX_WIDTH,
              height: BOX_HEIGHT,
            }}
          >
            <span className="truncate text-[12.5px] font-medium text-ink-1">
              {root ? rootTitle : title}
            </span>
            <span className="truncate text-[11px] text-ink-2">
              {root
                ? GRAPH_COPY.thisTask
                : `${GRAPH_COPY.state[stateOf(node)]} · ${day}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---- the accessible list (an ARIA tree) ------------------------------------------------------------------------------------------
/** One row of the tree as shown: a day (`node`) or a reference to a day placed elsewhere (`ref`). */
interface Row {
  key: string;
  kind: "node" | "ref";
  id: string;
  /** The key of the row it sits under (a day), or null for the root. */
  parent: string | null;
  level: number;
  setsize: number;
  posinset: number;
  /** Rows below it (its prerequisites placed here, and its references). */
  branch: boolean;
}

export const refKey = (dependant: string, prerequisite: string) =>
  `${dependant}>${prerequisite}`;

/** Every row of the tree in document order, with whether it is shown (every ancestor expanded). */
function rowsOf(
  tree: TreeItem,
  isOpen: (item: TreeItem) => boolean,
): { all: Map<string, Row>; shown: Row[] } {
  const all = new Map<string, Row>();
  const shown: Row[] = [];
  const walk = (
    item: TreeItem,
    parent: string | null,
    setsize: number,
    posinset: number,
    visible: boolean,
  ) => {
    const below = item.children.length + item.refs.length;
    const row: Row = {
      key: item.id,
      kind: "node",
      id: item.id,
      parent,
      level: item.depth + 1,
      setsize,
      posinset,
      branch: below > 0,
    };
    all.set(row.key, row);
    if (visible) shown.push(row);
    const inner = visible && below > 0 && isOpen(item);
    item.children.forEach((child, i) => {
      walk(child, item.id, below, i + 1, inner);
    });
    item.refs.forEach((ref, i) => {
      const r: Row = {
        key: refKey(item.id, ref),
        kind: "ref",
        id: ref,
        parent: item.id,
        level: item.depth + 2,
        setsize: below,
        posinset: item.children.length + i + 1,
        branch: false,
      };
      all.set(r.key, r);
      if (inner) shown.push(r);
    });
  };
  walk(tree, null, 1, 1, true);
  return { all, shown };
}

/** The parent of every placed day (to open the way to it). */
function parentsOf(tree: TreeItem): Map<string, string | null> {
  const out = new Map<string, string | null>([[tree.id, null]]);
  const walk = (item: TreeItem) => {
    for (const child of item.children) {
      out.set(child.id, item.id);
      walk(child);
    }
  };
  walk(tree);
  return out;
}

interface RowProps {
  row: Row;
  index: GraphIndex;
  rootId: string;
  rootTitle: string;
  expanded: boolean;
  focused: boolean;
  selected: boolean;
  register(key: string, el: HTMLElement | null): void;
  onKey(event: KeyboardEvent<HTMLElement>, row: Row): void;
  onActivate(row: Row): void;
  onFocusRow(row: Row): void;
  children?: ReactNode;
}

function TreeRow({
  row,
  index,
  rootId,
  rootTitle,
  expanded,
  focused,
  selected,
  register,
  onKey,
  onActivate,
  onFocusRow,
  children,
}: RowProps) {
  const node = index.node(row.id);
  const { title, day } = nodeLabel(index, row.id);
  const ref = (el: HTMLElement | null) => register(row.key, el);
  const indent = { paddingInlineStart: 8 + (row.level - 1) * 18 };
  if (row.kind === "ref")
    return (
      <div
        ref={ref}
        role="treeitem"
        tabIndex={focused ? 0 : -1}
        aria-level={row.level}
        aria-setsize={row.setsize}
        aria-posinset={row.posinset}
        onKeyDown={(event) => onKey(event, row)}
        onClick={() => onActivate(row)}
        onFocus={() => onFocusRow(row)}
        style={indent}
        data-tree-ref={row.key}
        className="flex min-h-11 cursor-pointer items-center gap-2 rounded-control px-2 text-[12.5px] text-ink-2 hover:bg-row-hover"
      >
        {GRAPH_COPY.needsToo(`${title} · ${day}`)}
      </div>
    );
  const root = row.id === rootId;
  return (
    <div role="none" className="flex flex-col">
      <div
        ref={ref}
        role="treeitem"
        tabIndex={focused ? 0 : -1}
        aria-level={row.level}
        aria-setsize={row.setsize}
        aria-posinset={row.posinset}
        aria-selected={selected}
        aria-expanded={row.branch ? expanded : undefined}
        onKeyDown={(event) => onKey(event, row)}
        onClick={() => onActivate(row)}
        onFocus={() => onFocusRow(row)}
        style={indent}
        data-tree-node={row.id}
        data-state={stateOf(node)}
        className={`flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 rounded-control px-2 py-1 hover:bg-row-hover ${selected ? "bg-select-tint" : ""}`}
      >
        <span
          aria-hidden="true"
          className="w-3 font-num text-[10px] text-ink-2"
        >
          {row.branch ? (expanded ? "▾" : "▸") : ""}
        </span>
        <span className="text-[13px] text-ink-1">
          {root ? `${GRAPH_COPY.thisTask}: ${rootTitle}` : title}
          <span className="text-[12px] text-ink-2"> · {day}</span>
        </span>
        {root ? null : (
          <span className="text-[11.5px] text-ink-2">
            {node.relation === "direct"
              ? GRAPH_COPY.direct
              : GRAPH_COPY.further}
          </span>
        )}
        <span className="ml-auto">
          <StatePill node={node} />
        </span>
      </div>
      {row.branch && expanded ? (
        // biome-ignore lint/a11y/useSemanticElements: the ARIA tree pattern's group of child items, not a form group
        <div role="group" className="flex flex-col">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The real control (D-18-2, TASK-04): an ARIA tree of the answer, keyboard-navigable (Up/Down, Right opens or goes in, Left closes or goes
 * up, Home/End; Enter or Space selects a day; on a reference it moves to the day itself, opening the way to it). Roving tab stop. A day
 * is open by default when it is the root or a direct prerequisite; what the person opened or closed is kept across re-reads.
 */
function DependencyTree({
  graph,
  index,
  tree,
  rootTitle,
  selected,
  describedBy,
  onSelect,
  focusRequest,
}: {
  graph: DependencyGraph;
  index: GraphIndex;
  tree: TreeItem;
  rootTitle: string;
  selected: string | null;
  describedBy: string;
  onSelect(id: string): void;
  /** A day to move focus to (a map pick), with a counter so the same day can be asked twice. */
  focusRequest: { id: string; n: number } | null;
}) {
  const parents = useMemo(() => parentsOf(tree), [tree]);
  // Days whose open state differs from the default (open exactly at depth 0 and 1).
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const isOpen = (item: TreeItem) => item.depth <= 1 !== toggled.has(item.id);
  const setOpen = (item: TreeItem, open: boolean) => {
    if (isOpen(item) === open) return;
    const next = new Set(toggled);
    if (next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
    setToggled(next);
  };
  const items = useMemo(() => {
    const out = new Map<string, TreeItem>();
    const walk = (item: TreeItem) => {
      out.set(item.id, item);
      for (const child of item.children) walk(child);
    };
    walk(tree);
    return out;
  }, [tree]);
  const { all, shown } = rowsOf(tree, isOpen);
  const [focusKey, setFocusKey] = useState<string>(graph.root_id);
  const elements = useRef(new Map<string, HTMLElement>());
  const pending = useRef<string | null>(null);
  // The tab stop is always a row that is shown.
  const stop = shown.some((r) => r.key === focusKey) ? focusKey : graph.root_id;
  useEffect(() => {
    const key = pending.current;
    if (key === null) return;
    const el = elements.current.get(key);
    if (el) {
      pending.current = null;
      el.focus();
    }
  });
  const moveTo = (key: string) => {
    setFocusKey(key);
    pending.current = key;
    const el = elements.current.get(key);
    if (el) {
      pending.current = null;
      el.focus();
    }
  };
  /** Opens the way to a placed day and focuses it. */
  const reveal = (id: string) => {
    const next = new Set(toggled);
    for (
      let p = parents.get(id) ?? null;
      p !== null;
      p = parents.get(p) ?? null
    ) {
      const item = items.get(p);
      if (item && !isOpen(item)) {
        if (next.has(p)) next.delete(p);
        else next.add(p);
      }
    }
    setToggled(next);
    setFocusKey(id);
    pending.current = id;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a map pick asks once per request
  useEffect(() => {
    if (focusRequest !== null) reveal(focusRequest.id);
  }, [focusRequest]);
  const activate = (row: Row) => {
    if (row.kind === "ref") {
      reveal(row.id);
      return;
    }
    setFocusKey(row.key);
    onSelect(row.id);
  };
  const onKey = (event: KeyboardEvent<HTMLElement>, row: Row) => {
    const at = shown.findIndex((r) => r.key === row.key);
    const item = row.kind === "node" ? items.get(row.id) : undefined;
    const open = item !== undefined && isOpen(item);
    switch (event.key) {
      case "ArrowDown": {
        const next = shown[at + 1];
        if (next) moveTo(next.key);
        break;
      }
      case "ArrowUp": {
        const prev = shown[at - 1];
        if (prev) moveTo(prev.key);
        break;
      }
      case "ArrowRight":
        if (item && row.branch && !open) setOpen(item, true);
        else if (row.branch && open) {
          const first = shown[at + 1];
          if (first) moveTo(first.key);
        }
        break;
      case "ArrowLeft":
        if (item && row.branch && open) setOpen(item, false);
        else if (row.parent !== null) moveTo(row.parent);
        break;
      case "Home": {
        const first = shown[0];
        if (first) moveTo(first.key);
        break;
      }
      case "End": {
        const last = shown[shown.length - 1];
        if (last) moveTo(last.key);
        break;
      }
      case "Enter":
      case " ":
        activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  const register = (key: string, el: HTMLElement | null) => {
    if (el) elements.current.set(key, el);
    else elements.current.delete(key);
  };
  const props = (row: Row) => ({
    row,
    index,
    rootId: graph.root_id,
    rootTitle,
    focused: stop === row.key,
    register,
    onKey,
    onActivate: activate,
    onFocusRow: (r: Row) => setFocusKey(r.key),
  });
  const render = (item: TreeItem): ReactNode => {
    const row = all.get(item.id) as Row;
    const open = isOpen(item);
    return (
      <TreeRow
        key={item.id}
        {...props(row)}
        expanded={open}
        selected={selected === item.id}
      >
        {open ? item.children.map(render) : null}
        {open
          ? item.refs.map((ref) => {
              const r = all.get(refKey(item.id, ref)) as Row;
              return (
                <TreeRow
                  key={r.key}
                  {...props(r)}
                  expanded={false}
                  selected={false}
                />
              );
            })
          : null}
      </TreeRow>
    );
  };
  return (
    <div
      role="tree"
      aria-label={GRAPH_COPY.treeName}
      aria-describedby={describedBy}
      data-dependency-tree=""
      className="flex flex-col gap-0.5"
    >
      {render(tree)}
    </div>
  );
}

// ---- the inspector -----------------------------------------------------------------------------------------------------------------
function NodeInspector({
  graph,
  index,
  id,
  rootTitle,
  onOpenTask,
}: {
  graph: DependencyGraph;
  index: GraphIndex;
  id: string;
  rootTitle: string;
  onOpenTask(node: DependencyGraphNode): void;
}) {
  const node = index.node(id);
  const root = id === graph.root_id;
  const { title, day } = nodeLabel(index, id);
  const name = (other: string) => {
    const label = nodeLabel(index, other);
    return other === graph.root_id
      ? `${GRAPH_COPY.thisTask}: ${rootTitle}`
      : `${label.title} · ${label.day}`;
  };
  const up = index.prerequisitesOf(id);
  const down = index.dependantsOf(id);
  return (
    <section
      aria-label={GRAPH_COPY.inspectorName}
      data-graph-inspect={id}
      className="flex flex-col gap-1.5 rounded-row border border-hairline-strong bg-canvas p-3"
    >
      <p className="text-[13.5px] font-medium text-ink-1">
        {root ? `${GRAPH_COPY.thisTask}: ${rootTitle}` : title}
        <span className="text-[12px] font-normal text-ink-2"> · {day}</span>
      </p>
      <span className="flex flex-wrap items-center gap-2">
        <StatePill node={node} />
        {root ? null : (
          <span className="text-[12px] text-ink-2">
            {node.relation === "direct"
              ? GRAPH_COPY.direct
              : GRAPH_COPY.further}
          </span>
        )}
      </span>
      {node.prerequisites === "unexpanded" ? (
        <p className="text-[12.5px] text-ink-2" data-inspect-unexpanded="">
          {GRAPH_COPY.notExpanded}
        </p>
      ) : (
        <p className="text-[12.5px] text-ink-2">
          {GRAPH_COPY.waitsFor}{" "}
          {up.length === 0 && !node.restricted_prerequisites
            ? GRAPH_COPY.nothing
            : up.map(name).join("; ")}
          {node.restricted_prerequisites ? (
            <span data-inspect-hidden="">
              {up.length === 0 ? "" : " "}
              {up.length === 0
                ? GRAPH_COPY.rootRestrictedOnly
                : GRAPH_COPY.alsoHidden}
            </span>
          ) : null}
        </p>
      )}
      {root ? null : (
        <p className="text-[12.5px] text-ink-2">
          {GRAPH_COPY.neededBy} {down.map(name).join("; ")}
        </p>
      )}
      {root ? null : (
        <span>
          <Button onClick={() => onOpenTask(node)}>
            {GRAPH_COPY.openTask}
          </Button>
        </span>
      )}
    </section>
  );
}

// ---- the section ---------------------------------------------------------------------------------------------------------------------
function Summary({
  graph,
  index,
}: {
  graph: DependencyGraph;
  index: GraphIndex;
}) {
  const s = summaryOf(graph);
  if (s.direct === 0)
    return (
      <p className="text-[13px] text-ink-1" data-graph-summary="none">
        {s.rootRestricted ? GRAPH_COPY.rootRestrictedOnly : GRAPH_COPY.none}
      </p>
    );
  const parts = [GRAPH_COPY.summary(s.direct, s.directDone)];
  if (s.open.length > 0)
    parts.push(GRAPH_COPY.open(s.open.map((id) => nodeLabel(index, id).title)));
  if (s.rootRestricted) parts.push(GRAPH_COPY.hiddenToo);
  if (s.further > 0) parts.push(GRAPH_COPY.furtherBack(s.further));
  return (
    <p className="text-[13px] text-ink-1" data-graph-summary="">
      {parts.join(". ").replace(/\. and /, ", and ")}.
    </p>
  );
}

/**
 * WEB-18: "What this waits for" drawn from ONE whole answer: the summary, the restricted and partial notices (never presented as whole),
 * the decorative map beside the tree from 1280 px, the tree and the inspector of the selected day. The completion modes are not here:
 * they come from the preview alone (D-18-1).
 */
export function DependencyGraphSection({
  view,
  rootTitle,
  onRefresh,
  onOpenTask,
}: {
  view: GraphView;
  rootTitle: string;
  onRefresh(): void;
  onOpenTask(node: DependencyGraphNode): void;
}) {
  const mode = useLayoutMode();
  const announcer = useAnnouncer();
  const keysId = useId();
  const graph =
    view.kind === "ready" || view.kind === "stale" ? view.graph : null;
  const index = useMemo(() => (graph ? indexGraph(graph) : null), [graph]);
  const tree = useMemo(() => (graph ? treeOf(graph) : null), [graph]);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{
    id: string;
    n: number;
  } | null>(null);
  // A new whole answer that no longer holds the selected day drops the selection (nothing is carried over from another answer).
  const shownSelected =
    selected !== null && graph?.nodes.some((n) => n.occurrence_id === selected)
      ? selected
      : null;
  // A selection is said through the page's announcer (lint R6: no live region of its own), with the day it shows.
  const select = (id: string) => {
    setSelected(id);
    if (index === null || graph === null) return;
    const { title, day } = nodeLabel(index, id);
    announcer.announce(
      `${GRAPH_COPY.inspectorName}: ${id === graph.root_id ? `${GRAPH_COPY.thisTask}: ${rootTitle}` : `${title} · ${day}`}`,
      "polite",
    );
  };
  const state =
    view.kind === "ready" ? (view.checking ? "checking" : "ready") : view.kind;
  return (
    <section
      data-dependency-graph={state}
      aria-busy={
        view.kind === "loading" || (view.kind === "ready" && view.checking)
          ? true
          : undefined
      }
      className="flex flex-col gap-2.5"
    >
      {view.kind === "loading" || view.kind === "idle" ? (
        <div className="flex flex-col gap-1.5">
          <span className="sr-only">{GRAPH_COPY.loading}</span>
          {[0, 1, 2].map((n) => (
            <div
              key={n}
              className="min-h-10 rounded-row border border-dashed border-hairline-strong"
            />
          ))}
        </div>
      ) : view.kind === "offline" ? (
        <p className="text-[13px] text-ink-2">{GRAPH_COPY.offline}</p>
      ) : view.kind === "refused" ? (
        <p className="text-[13px] text-ink-2" data-graph-refused="">
          {copy.UNREADABLE}
        </p>
      ) : view.kind === "error" ? (
        <div className="flex flex-col gap-1" data-graph-error="">
          <p className="text-[13px] text-ink-2">{GRAPH_COPY.failed}</p>
          {view.requestId ? (
            <p className="select-all font-num text-[12px] text-ink-2">
              {copy.REQUEST_ID(view.requestId)}
            </p>
          ) : null}
          <span>
            <Button onClick={onRefresh}>{copy.TRY_AGAIN}</Button>
          </span>
        </div>
      ) : graph !== null && index !== null && tree !== null ? (
        <>
          <Summary graph={graph} index={index} />
          {view.kind === "stale" ? (
            <div
              className="flex flex-wrap items-center gap-2"
              data-graph-stale=""
            >
              <p className="text-[12.5px] text-ink-2">
                {GRAPH_COPY.stale(TIME.format(view.at))}
              </p>
              <Button variant="quiet" onClick={onRefresh}>
                {copy.TRY_AGAIN}
              </Button>
            </div>
          ) : null}
          {graph.restricted ? (
            <p className="text-[12.5px] text-ink-2" data-graph-restricted="">
              {GRAPH_COPY.restricted}
            </p>
          ) : null}
          {graph.coverage === "partial" ? (
            <p className="text-[12.5px] text-ink-2" data-graph-partial="">
              {GRAPH_COPY.partial}
            </p>
          ) : null}
          <div className="flex flex-col gap-3 desktop:flex-row desktop:items-start">
            {mode === "desktop" ? (
              mapRefusal(graph) === "too_deep" ||
              mapRefusal(graph) === "too_tall" ? (
                <p
                  className="text-[12.5px] text-ink-2 desktop:flex-1"
                  data-graph-too-much=""
                >
                  {GRAPH_COPY.tooMuch}
                </p>
              ) : mapRefusal(graph) === null ? (
                <div className="desktop:flex-1">
                  <DependencyMap
                    graph={graph}
                    index={index}
                    rootTitle={rootTitle}
                    selected={shownSelected}
                    onPick={(id) => {
                      select(id);
                      setFocusRequest((prev) => ({
                        id,
                        n: (prev?.n ?? 0) + 1,
                      }));
                    }}
                  />
                </div>
              ) : null
            ) : null}
            <div className="flex min-w-0 flex-col gap-2 desktop:w-[320px] desktop:shrink-0">
              <DependencyTree
                graph={graph}
                index={index}
                tree={tree}
                rootTitle={rootTitle}
                selected={shownSelected}
                describedBy={keysId}
                onSelect={select}
                focusRequest={focusRequest}
              />
              <p id={keysId} className="text-[12px] text-ink-2">
                {GRAPH_COPY.keys}
              </p>
            </div>
          </div>
          {shownSelected !== null ? (
            <NodeInspector
              graph={graph}
              index={index}
              id={shownSelected}
              rootTitle={rootTitle}
              onOpenTask={onOpenTask}
            />
          ) : null}
          <span className="flex flex-wrap items-center gap-2">
            <Button variant="quiet" onClick={onRefresh}>
              {GRAPH_COPY.checkAgain}
            </Button>
            {view.kind === "ready" && view.checking ? (
              <span className="text-[12px] text-ink-2" data-graph-checking="">
                {GRAPH_COPY.checking}
              </span>
            ) : null}
          </span>
        </>
      ) : null}
    </section>
  );
}
