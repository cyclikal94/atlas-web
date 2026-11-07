import type {
  DependencyEdge,
  DependencyGraph,
  DependencyGraphNode,
  DependencyState,
} from "./contract";

/**
 * WEB-18 (plan §3.4, D-18-2/3/10). PURE. Everything the screen shows of a dependency graph is derived from ONE validated answer
 * (`parseDependencyGraph`): its nodes and its edges, never the order of anything and never another answer. Order here is presentation
 * only (title, then day, then id), so two renders of one answer are identical and nothing claims that order means anything.
 */

/** The deepest node a map is drawn for (four columns of 112 px boxes and 32 px gaps fit the wide dialog's map column). */
export const MAP_MAX_DEPTH = 3;
/** The most boxes a map column holds (the design: "Up to 32 prerequisites"); beyond it the list alone is shown. */
export const MAP_MAX_COLUMN = 32;
export const BOX_WIDTH = 112;
export const BOX_HEIGHT = 48;
export const COLUMN_GAP = 32;
export const ROW_GAP = 12;
/** Room round the boxes for the arcs that bulge out of the grid (same-column arcs to the left, right-to-left arcs over the top). */
export const MAP_MARGIN = 16;

export interface GraphIndex {
  node(id: string): DependencyGraphNode;
  title(id: string): string;
  /** The node's prerequisites in this answer, in presentation order. */
  prerequisitesOf(id: string): string[];
  /** The nodes that need this one in this answer, in presentation order. */
  dependantsOf(id: string): string[];
}

/** Title (en-GB), then the day (an undated day last), then the occurrence id: a total order, so presentation is deterministic. */
export function presentationCompare(
  g: DependencyGraph,
): (a: string, b: string) => number {
  const nodes = new Map(g.nodes.map((n) => [n.occurrence_id, n]));
  const titles = new Map(g.tasks.map((t) => [t.id, t.title]));
  const titleOf = (id: string) =>
    titles.get(nodes.get(id)?.task_id ?? "") ?? "";
  return (a, b) => {
    const byTitle = titleOf(a).localeCompare(titleOf(b), "en-GB");
    if (byTitle !== 0) return byTitle;
    const da = nodes.get(a)?.slot.date ?? null;
    const db = nodes.get(b)?.slot.date ?? null;
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? -1 : 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

export function indexGraph(g: DependencyGraph): GraphIndex {
  const nodes = new Map(g.nodes.map((n) => [n.occurrence_id, n]));
  const titles = new Map(g.tasks.map((t) => [t.id, t.title]));
  const compare = presentationCompare(g);
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const e of g.edges) {
    up.set(e.dependant_id, [
      ...(up.get(e.dependant_id) ?? []),
      e.prerequisite_id,
    ]);
    down.set(e.prerequisite_id, [
      ...(down.get(e.prerequisite_id) ?? []),
      e.dependant_id,
    ]);
  }
  for (const list of up.values()) list.sort(compare);
  for (const list of down.values()) list.sort(compare);
  return {
    node: (id) => nodes.get(id) as DependencyGraphNode,
    title: (id) => titles.get(nodes.get(id)?.task_id ?? "") ?? "",
    prerequisitesOf: (id) => [...(up.get(id) ?? [])],
    dependantsOf: (id) => [...(down.get(id) ?? [])],
  };
}

/** The pill of a node: its `dependency_state`, as the server states it (one place, so nothing else derives a state). */
export const stateOf = (n: DependencyGraphNode): DependencyState =>
  n.dependency_state;

/**
 * The accessible list (D-18-2): the root, then each node's prerequisites nested below it. A node is placed ONCE, under the first of its
 * dependants a breadth-first walk from the root reaches (so its nesting depth is its `depth`); every other edge to it is a reference
 * ("Needs “X” too") under that dependant. Nesting pairs and references together are exactly the answer's edges.
 */
export interface TreeItem {
  id: string;
  depth: number;
  children: TreeItem[];
  /** Prerequisites placed elsewhere, shown here as references, in presentation order. */
  refs: string[];
}

export function treeOf(g: DependencyGraph): TreeItem {
  const index = indexGraph(g);
  const root: TreeItem = { id: g.root_id, depth: 0, children: [], refs: [] };
  const placed = new Map<string, TreeItem>([[g.root_id, root]]);
  const queue: TreeItem[] = [root];
  for (let at = 0; at < queue.length; at += 1) {
    const item = queue[at] as TreeItem;
    for (const id of index.prerequisitesOf(item.id)) {
      if (placed.has(id)) {
        item.refs.push(id);
        continue;
      }
      const child: TreeItem = {
        id,
        depth: item.depth + 1,
        children: [],
        refs: [],
      };
      placed.set(id, child);
      item.children.push(child);
      queue.push(child);
    }
  }
  return root;
}

/** The edges a tree shows: each nesting (child needed by its parent) and each reference. The test oracle of D-18-2. */
export function edgesOfTree(t: TreeItem): DependencyEdge[] {
  const out: DependencyEdge[] = [];
  const walk = (item: TreeItem) => {
    for (const child of item.children) {
      out.push({ prerequisite_id: child.id, dependant_id: item.id });
      walk(child);
    }
    for (const ref of item.refs)
      out.push({ prerequisite_id: ref, dependant_id: item.id });
  };
  walk(t);
  return out;
}

/** Every item of a tree in document order (the root first). */
export function itemsOf(t: TreeItem): TreeItem[] {
  const out: TreeItem[] = [];
  const walk = (item: TreeItem) => {
    out.push(item);
    for (const child of item.children) walk(child);
  };
  walk(t);
  return out;
}

/**
 * The summary line (D-18-10), from VISIBLE nodes only: what the day waits for directly and how many of those are done, the visible direct
 * prerequisites still open (presentation order), whether the root also waits for something hidden, and how many visible nodes are further
 * back. Nothing hidden is counted, because nothing hidden is in the answer.
 */
export interface GraphSummary {
  direct: number;
  directDone: number;
  open: string[];
  rootRestricted: boolean;
  further: number;
  partial: boolean;
  restricted: boolean;
}

export function summaryOf(g: DependencyGraph): GraphSummary {
  const index = indexGraph(g);
  const direct = index.prerequisitesOf(g.root_id);
  const root = index.node(g.root_id);
  return {
    direct: direct.length,
    directDone: direct.filter((id) => index.node(id).outcome === "complete")
      .length,
    open: direct.filter((id) => index.node(id).outcome !== "complete"),
    rootRestricted: root.restricted_prerequisites === true,
    further: g.nodes.filter((n) => n.relation === "transitive").length,
    partial: g.coverage === "partial",
    restricted: g.restricted,
  };
}

/**
 * The decorative map (D-18-3): one column per depth, prerequisites to the LEFT and this day rightmost, and one path per edge from the
 * prerequisite to the day that needs it. Within a column boxes are ordered by the mean row of their already-placed dependants (one
 * barycentre sweep from the root leftwards), ties in presentation order. Null (the list alone) when there is no edge to draw or the
 * answer is beyond the legibility bounds.
 */
export interface MapBox {
  id: string;
  x: number;
  y: number;
}
export interface MapPath {
  prerequisite: string;
  dependant: string;
  d: string;
}
export interface MapLayout {
  width: number;
  height: number;
  boxes: MapBox[];
  paths: MapPath[];
}

export type MapRefusal = "no_edges" | "too_deep" | "too_tall";

export function mapRefusal(g: DependencyGraph): MapRefusal | null {
  if (g.edges.length === 0) return "no_edges";
  const deepest = Math.max(...g.nodes.map((n) => n.depth));
  if (deepest > MAP_MAX_DEPTH) return "too_deep";
  const perDepth = new Map<number, number>();
  for (const n of g.nodes)
    perDepth.set(n.depth, (perDepth.get(n.depth) ?? 0) + 1);
  if ([...perDepth.values()].some((count) => count > MAP_MAX_COLUMN))
    return "too_tall";
  return null;
}

export function mapLayout(g: DependencyGraph): MapLayout | null {
  if (mapRefusal(g) !== null) return null;
  const index = indexGraph(g);
  const compare = presentationCompare(g);
  const deepest = Math.max(...g.nodes.map((n) => n.depth));
  const columns: string[][] = Array.from({ length: deepest + 1 }, () => []);
  const row = new Map<string, number>();
  columns[0] = [g.root_id];
  row.set(g.root_id, 0);
  for (let depth = 1; depth <= deepest; depth += 1) {
    const here = g.nodes
      .filter((n) => n.depth === depth)
      .map((n) => n.occurrence_id);
    const centre = (id: string) => {
      const placed = index
        .dependantsOf(id)
        .filter((d) => row.has(d))
        .map((d) => row.get(d) as number);
      return placed.length === 0
        ? Number.POSITIVE_INFINITY
        : placed.reduce((a, b) => a + b, 0) / placed.length;
    };
    here.sort((a, b) => centre(a) - centre(b) || compare(a, b));
    for (const [i, id] of here.entries()) row.set(id, i);
    columns[depth] = here;
  }
  const tallest = Math.max(...columns.map((c) => c.length));
  const pitch = BOX_HEIGHT + ROW_GAP;
  const boxes: MapBox[] = [];
  const at = new Map<string, MapBox>();
  columns.forEach((ids, depth) => {
    const x = MAP_MARGIN + (deepest - depth) * (BOX_WIDTH + COLUMN_GAP);
    const offset = MAP_MARGIN + ((tallest - ids.length) * pitch) / 2;
    ids.forEach((id, i) => {
      const box = { id, x, y: offset + i * pitch };
      boxes.push(box);
      at.set(id, box);
    });
  });
  const width =
    2 * MAP_MARGIN + (deepest + 1) * BOX_WIDTH + deepest * COLUMN_GAP;
  const height = 2 * MAP_MARGIN + tallest * pitch - ROW_GAP;
  const mid = BOX_HEIGHT / 2;
  const paths: MapPath[] = g.edges.map((e) => {
    const p = at.get(e.prerequisite_id) as MapBox;
    const q = at.get(e.dependant_id) as MapBox;
    let d: string;
    if (p.x < q.x) {
      // Left to right, the ordinary case: from the prerequisite's right edge to the dependant's left edge.
      const x1 = p.x + BOX_WIDTH;
      const y1 = p.y + mid;
      const x2 = q.x;
      const y2 = q.y + mid;
      const bend = (x2 - x1) / 2;
      d = `M ${x1} ${y1} C ${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
    } else if (p.x === q.x) {
      // The same column (equal depth): an arc out to the left, between the two left edges.
      const y1 = p.y + mid;
      const y2 = q.y + mid;
      const reach = Math.min(MAP_MARGIN, 8 + Math.abs(y2 - y1) / 8);
      d = `M ${p.x} ${y1} C ${p.x - reach} ${y1} ${q.x - reach} ${y2} ${q.x} ${y2}`;
    } else {
      // Right to left (a prerequisite nearer this day than its dependant): an arc over the top, into the dependant's top edge.
      const x1 = p.x + BOX_WIDTH / 2;
      const y1 = p.y;
      const x2 = q.x + BOX_WIDTH / 2;
      const y2 = q.y;
      const lift = Math.min(y1, y2) - MAP_MARGIN;
      d = `M ${x1} ${y1} C ${x1} ${lift} ${x2} ${lift} ${x2} ${y2}`;
    }
    return { prerequisite: e.prerequisite_id, dependant: e.dependant_id, d };
  });
  return { width, height, boxes, paths };
}
