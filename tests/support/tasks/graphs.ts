import {
  type DependencyEdge,
  type DependencyGraph,
  type DependencyGraphNode,
  definedState,
  type Outcome,
} from "../../../src/features/tasks/model/contract";

/**
 * WEB-18 test support: dependency-graph answers that are VALID by construction (the builder derives every field the contract defines from
 * a small spec: depth, relation, expansion flags, `dependency_state`, `coverage`, `restricted`, the task list and the direct list), in the
 * server's documented order (root first, then breadth-first by ascending id; edges by dependant then prerequisite). FIXTURE evidence only.
 * The backend's six documented examples are copied verbatim below with their source.
 */
export interface NodeSpec {
  id: string;
  /** The task definition (several days of one recurring task share it). */
  task: string;
  title: string;
  date?: string | null;
  outcome?: Outcome;
  version?: number;
  canEdit?: boolean;
  strict?: boolean;
  /** At `max_depth` or beyond the node budget: none of its edges is returned. */
  unexpanded?: boolean;
  /** One or more of its stored direct prerequisites is hidden from the caller (expanded nodes only). */
  hidden?: boolean;
}

export interface GraphSpec {
  root: string;
  nodes: NodeSpec[];
  /** `[prerequisite, dependant]`: the dependant requires the prerequisite. */
  edges: Array<[string, string]>;
  maxDepth?: number;
}

/** A contract-valid answer for `spec` (as the JSON body the server sends; parse it to check). */
export function buildGraph(spec: GraphSpec): DependencyGraph {
  const specs = new Map(spec.nodes.map((n) => [n.id, n]));
  const up = new Map<string, string[]>();
  for (const [p, d] of spec.edges) up.set(d, [...(up.get(d) ?? []), p]);
  // Breadth-first from the root over the edges of expanded nodes, ascending ids at each step (the server's discovery order).
  const depth = new Map<string, number>([[spec.root, 0]]);
  const order = [spec.root];
  for (let at = 0; at < order.length; at += 1) {
    const id = order[at] as string;
    if (specs.get(id)?.unexpanded) continue;
    for (const p of [...(up.get(id) ?? [])].sort())
      if (!depth.has(p)) {
        depth.set(p, (depth.get(id) as number) + 1);
        order.push(p);
      }
  }
  const kept = new Set(order);
  const edges: DependencyEdge[] = spec.edges
    .filter(([p, d]) => kept.has(p) && kept.has(d) && !specs.get(d)?.unexpanded)
    .map(([p, d]) => ({ prerequisite_id: p, dependant_id: d }))
    .sort((a, b) =>
      a.dependant_id === b.dependant_id
        ? a.prerequisite_id.localeCompare(b.prerequisite_id)
        : a.dependant_id.localeCompare(b.dependant_id),
    );
  const direct = edges
    .filter((e) => e.dependant_id === spec.root)
    .map((e) => e.prerequisite_id)
    .sort();
  const base = order.map((id) => {
    const s = specs.get(id);
    if (s === undefined) throw new Error(`buildGraph: no spec for ${id}`);
    const expanded = !s.unexpanded;
    return {
      occurrence_id: id,
      task_id: s.task,
      slot: {
        key: s.date ? s.date : "once",
        date: s.date === undefined ? "2026-09-08" : s.date,
        intended_time: null,
        timezone: "Europe/London",
        instant: null,
      },
      version: s.version ?? 1,
      can_edit: s.canEdit ?? true,
      strict: s.strict ?? false,
      depth: depth.get(id) as number,
      relation:
        id === spec.root
          ? ("root" as const)
          : direct.includes(id)
            ? ("direct" as const)
            : ("transitive" as const),
      outcome: s.outcome ?? ("incomplete" as Outcome),
      prerequisites: expanded ? ("expanded" as const) : ("unexpanded" as const),
      restricted_prerequisites: expanded ? (s.hidden ?? false) : null,
    };
  });
  const byId = new Map(base.map((n) => [n.occurrence_id, n]));
  const nodes: DependencyGraphNode[] = base.map((n) => ({
    ...n,
    dependency_state: definedState(
      n,
      edges
        .filter((e) => e.dependant_id === n.occurrence_id)
        .map((e) => byId.get(e.prerequisite_id) as DependencyGraphNode),
    ),
  }));
  const titles = new Map<string, string>();
  for (const id of order) {
    const s = specs.get(id) as NodeSpec;
    if (!titles.has(s.task)) titles.set(s.task, s.title);
  }
  return {
    root_id: spec.root,
    nodes,
    edges,
    tasks: [...titles.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, title]) => ({ id, title })),
    direct_prerequisites: direct,
    coverage: nodes.some((n) => n.prerequisites === "unexpanded")
      ? "partial"
      : "complete",
    restricted: nodes.some((n) => n.restricted_prerequisites === true),
    max_depth: spec.maxDepth ?? 200,
  };
}

/** A deterministic UUID-shaped id from a small number (`kind` 0: occurrence, 1: task). */
export const gid = (n: number, kind: 0 | 1 = 0): string =>
  `${kind === 0 ? "0cc00000" : "7a5c0000"}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const node = (n: number, title: string, over: Partial<NodeSpec> = {}) => ({
  id: gid(n),
  task: gid(n, 1),
  title,
  ...over,
});

/** Pack ← Book tickets ← Choose dates (done). */
export const chainSpec = (): GraphSpec => ({
  root: gid(1),
  nodes: [
    node(1, "Pack"),
    node(2, "Book tickets"),
    node(3, "Choose dates", { outcome: "complete" }),
  ],
  edges: [
    [gid(2), gid(1)],
    [gid(3), gid(2)],
  ],
});

/** Clean up ← Wash, Dry, Put away (a branch: three direct prerequisites, none shared). */
export const branchSpec = (): GraphSpec => ({
  root: gid(10),
  nodes: [
    node(10, "Clean up"),
    node(11, "Wash", { outcome: "complete" }),
    node(12, "Dry"),
    node(13, "Put away"),
  ],
  edges: [
    [gid(11), gid(10)],
    [gid(12), gid(10)],
    [gid(13), gid(10)],
  ],
});

/** Serve dinner ← Cook, Pour drinks; both ← Set the table (done): a shared prerequisite (a diamond). */
export const sharedSpec = (): GraphSpec => ({
  root: gid(20),
  nodes: [
    node(20, "Serve dinner", { strict: true }),
    node(21, "Cook"),
    node(22, "Pour drinks", { outcome: "complete" }),
    node(23, "Set the table", { outcome: "complete" }),
  ],
  edges: [
    [gid(21), gid(20)],
    [gid(22), gid(20)],
    [gid(23), gid(21)],
    [gid(23), gid(22)],
  ],
});

/** The root alone. */
export const emptySpec = (over: Partial<NodeSpec> = {}): GraphSpec => ({
  root: gid(30),
  nodes: [node(30, "Water plants", over)],
  edges: [],
});

/** A root with one visible done prerequisite and one hidden one. */
export const restrictedRootSpec = (): GraphSpec => ({
  root: gid(40),
  nodes: [
    node(40, "Birthday party", { hidden: true }),
    node(41, "Send invitations", { outcome: "complete" }),
  ],
  edges: [[gid(41), gid(40)]],
});

/** A root restricted with NO visible prerequisite. */
export const restrictedOnlySpec = (): GraphSpec => ({
  root: gid(45),
  nodes: [node(45, "Plan the trip", { hidden: true })],
  edges: [],
});

/** Report ← Draft (shared) ← a hidden prerequisite: the middle node is restricted. */
export const restrictedMidSpec = (): GraphSpec => ({
  root: gid(50),
  nodes: [
    node(50, "Send the report"),
    node(51, "Draft the report", { hidden: true }),
    node(52, "Gather figures", { outcome: "complete" }),
  ],
  edges: [
    [gid(51), gid(50)],
    [gid(52), gid(51)],
  ],
});

/** The chain read with `max_depth=1`: Book tickets is unexpanded, so the graph is partial. */
export const depthOneSpec = (): GraphSpec => ({
  root: gid(1),
  nodes: [node(1, "Pack"), node(2, "Book tickets", { unexpanded: true })],
  edges: [[gid(2), gid(1)]],
  maxDepth: 1,
});

/** Edges that are not left to right on the map: a same-depth edge and a prerequisite nearer the root than its dependant. */
export const crossSpec = (): GraphSpec => ({
  root: gid(60),
  nodes: [
    node(60, "Move house"),
    node(61, "Pack boxes"),
    node(62, "Book the van"),
    node(63, "Measure rooms"),
  ],
  edges: [
    [gid(61), gid(60)],
    [gid(62), gid(60)],
    // Same depth (1 → 1): Pack boxes needs Book the van.
    [gid(62), gid(61)],
    [gid(63), gid(61)],
    // Book the van (depth 1) is also needed by Measure rooms (depth 2): right to left.
    [gid(62), gid(63)],
  ],
});

/** A chain deeper than the map draws. */
export const deepSpec = (length = 6): GraphSpec => ({
  root: gid(100),
  nodes: Array.from({ length }, (_, i) => node(100 + i, `Step ${i}`)),
  edges: Array.from(
    { length: length - 1 },
    (_, i) => [gid(101 + i), gid(100 + i)] as [string, string],
  ),
});

/** A budget-partial answer: the root's prerequisites are expanded, one of them is not (beyond the node budget). */
export const budgetPartialSpec = (): GraphSpec => ({
  root: gid(70),
  nodes: [
    node(70, "Launch"),
    node(71, "Test"),
    node(72, "Build", { unexpanded: true }),
    node(73, "Design", { outcome: "complete" }),
  ],
  edges: [
    [gid(71), gid(70)],
    [gid(72), gid(70)],
    [gid(73), gid(71)],
  ],
});

/**
 * The largest valid answer: 200 nodes, each depending on the next 32 (as many as `set_dependencies` allows), so 5,872 edges (the most a
 * 200-node acyclic graph with at most 32 prerequisites per node holds; the contract's 6,400 bound is checked with a synthetic body).
 */
export const maximalSpec = (): GraphSpec => {
  const nodes = Array.from({ length: 200 }, (_, i) =>
    node(1000 + i, `Item ${String(i).padStart(3, "0")}`, {
      outcome: i % 3 === 0 && i > 0 ? "complete" : "incomplete",
    }),
  );
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < 200; i += 1)
    for (let j = i + 1; j <= Math.min(199, i + 32); j += 1)
      edges.push([gid(1000 + j), gid(1000 + i)]);
  return { root: gid(1000), nodes, edges };
};

/** A seeded PRNG (mulberry32). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OUTCOME_POOL: readonly Outcome[] = [
  "incomplete",
  "incomplete",
  "complete",
  "complete",
  "unknown",
  "missed",
  "provisional",
  "excluded",
];

/**
 * A random VALID answer (the property test's generator): up to `max` nodes in a random acyclic graph, each with at most 32 prerequisites
 * among later nodes, some unexpanded, some with hidden prerequisites, some days of one recurring task, mixed outcomes and dates.
 */
export function randomSpec(seed: number, max = 200): GraphSpec {
  const r = random(seed);
  const n = 1 + Math.floor(r() * max);
  const tasks = Math.max(1, Math.floor(n * (0.4 + r() * 0.6)));
  const nodes: NodeSpec[] = Array.from({ length: n }, (_, i) => {
    const task = Math.floor(r() * tasks);
    const dated = r();
    return {
      id: gid(5000 + i),
      task: gid(5000 + task, 1),
      title: `Task ${task}`,
      date:
        dated < 0.1
          ? null
          : `2026-${String(1 + Math.floor(r() * 12)).padStart(2, "0")}-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`,
      outcome: OUTCOME_POOL[Math.floor(r() * OUTCOME_POOL.length)] as Outcome,
      unexpanded: i > 0 && r() < 0.08,
      hidden: r() < 0.08,
    };
  });
  const edges: Array<[string, string]> = [];
  const density = r();
  for (let i = 0; i < n; i += 1) {
    const later = n - i - 1;
    const want = Math.min(32, later, Math.floor(r() * (1 + density * 6)));
    const chosen = new Set<number>();
    while (chosen.size < want) chosen.add(i + 1 + Math.floor(r() * later));
    for (const j of chosen) edges.push([gid(5000 + j), gid(5000 + i)]);
  }
  return {
    root: gid(5000),
    nodes,
    edges,
    ...(r() < 0.2 ? { maxDepth: 200 } : {}),
  };
}

/**
 * The backend's documented examples, verbatim (atlas `docs/tasks.md` "Dependency graph" at the released commit `7dc51e39`,
 * `v0.31.0-rc.1`): a chain, a branch and join with a shared prerequisite, no prerequisites, a restricted root, the chain at
 * `max_depth=1`, and two days of one recurring task.
 */
export const DOCUMENTED: Readonly<Record<string, string>> = {
  chain: `{"root_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e01","nodes":[{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e01","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e01","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":3,"can_edit":true,"strict":false,"depth":0,"relation":"root","outcome":"incomplete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"waiting"},{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e02","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e02","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":3,"can_edit":true,"strict":false,"depth":1,"relation":"direct","outcome":"incomplete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"ready"},{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e03","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e03","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":1,"can_edit":true,"strict":false,"depth":2,"relation":"transitive","outcome":"complete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"satisfied"}],"edges":[{"prerequisite_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e02","dependant_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e01"},{"prerequisite_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e03","dependant_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e02"}],"tasks":[{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e01","title":"Pack"},{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e02","title":"Book tickets"},{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e03","title":"Choose dates"}],"direct_prerequisites":["6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e02"],"coverage":"complete","restricted":false,"max_depth":200}`,
  shared: `{"root_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e10","nodes":[{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e10","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e10","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":3,"can_edit":true,"strict":true,"depth":0,"relation":"root","outcome":"incomplete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"waiting"},{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e11","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e11","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":2,"can_edit":true,"strict":false,"depth":1,"relation":"direct","outcome":"incomplete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"ready"},{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e12","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e12","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":2,"can_edit":true,"strict":false,"depth":1,"relation":"direct","outcome":"complete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"satisfied"},{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e13","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e13","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":1,"can_edit":true,"strict":false,"depth":2,"relation":"transitive","outcome":"complete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"satisfied"}],"edges":[{"prerequisite_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e11","dependant_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e10"},{"prerequisite_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e12","dependant_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e10"},{"prerequisite_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e13","dependant_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e11"},{"prerequisite_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e13","dependant_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e12"}],"tasks":[{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e10","title":"Serve dinner"},{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e11","title":"Cook"},{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e12","title":"Pour drinks"},{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e13","title":"Set the table"}],"direct_prerequisites":["6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e11","6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e12"],"coverage":"complete","restricted":false,"max_depth":200}`,
  none: `{"root_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e20","nodes":[{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e20","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e20","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":1,"can_edit":true,"strict":false,"depth":0,"relation":"root","outcome":"incomplete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"ready"}],"edges":[],"tasks":[{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e20","title":"Water plants"}],"direct_prerequisites":[],"coverage":"complete","restricted":false,"max_depth":200}`,
  restricted: `{"root_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e30","nodes":[{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e30","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e30","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":4,"can_edit":true,"strict":false,"depth":0,"relation":"root","outcome":"incomplete","prerequisites":"expanded","restricted_prerequisites":true,"dependency_state":"restricted"},{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e31","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e31","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":1,"can_edit":true,"strict":false,"depth":1,"relation":"direct","outcome":"complete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"satisfied"}],"edges":[{"prerequisite_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e31","dependant_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e30"}],"tasks":[{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e30","title":"Birthday party"},{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e31","title":"Send invitations"}],"direct_prerequisites":["6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e31"],"coverage":"complete","restricted":true,"max_depth":200}`,
  depthOne: `{"root_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e01","nodes":[{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e01","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e01","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":3,"can_edit":true,"strict":false,"depth":0,"relation":"root","outcome":"incomplete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"waiting"},{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e02","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e02","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":3,"can_edit":true,"strict":false,"depth":1,"relation":"direct","outcome":"incomplete","prerequisites":"unexpanded","restricted_prerequisites":null,"dependency_state":"unknown"}],"edges":[{"prerequisite_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e02","dependant_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e01"}],"tasks":[{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e01","title":"Pack"},{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e02","title":"Book tickets"}],"direct_prerequisites":["6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e02"],"coverage":"partial","restricted":false,"max_depth":1}`,
  recurring: `{"root_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e40","nodes":[{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e40","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e40","slot":{"key":"once","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":2,"can_edit":true,"strict":false,"depth":0,"relation":"root","outcome":"incomplete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"waiting"},{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e41","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e41","slot":{"key":"2026-09-07","date":"2026-09-07","intended_time":null,"timezone":"Europe/London","instant":null},"version":1,"can_edit":true,"strict":false,"depth":1,"relation":"direct","outcome":"complete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"satisfied"},{"occurrence_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e42","task_id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e41","slot":{"key":"2026-09-08","date":"2026-09-08","intended_time":null,"timezone":"Europe/London","instant":null},"version":1,"can_edit":true,"strict":false,"depth":1,"relation":"direct","outcome":"incomplete","prerequisites":"expanded","restricted_prerequisites":false,"dependency_state":"ready"}],"edges":[{"prerequisite_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e41","dependant_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e40"},{"prerequisite_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e42","dependant_id":"6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e40"}],"tasks":[{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e40","title":"Holiday"},{"id":"1b7e2a90-4c1d-4e8a-9f30-5a6b7c8d9e41","title":"Water plants"}],"direct_prerequisites":["6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e41","6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e42"],"coverage":"complete","restricted":false,"max_depth":200}`,
};

/** A depth-one answer for an editor test: the root alone, with its version and rule (its direct list as `direct`). */
export function rootGraph(over: {
  root: string;
  task: string;
  title: string;
  version?: number;
  strict?: boolean;
  canEdit?: boolean;
  hidden?: boolean;
  direct?: Array<{
    id: string;
    task: string;
    title: string;
    outcome?: Outcome;
  }>;
  maxDepth?: number;
}): DependencyGraph {
  return buildGraph({
    root: over.root,
    nodes: [
      {
        id: over.root,
        task: over.task,
        title: over.title,
        version: over.version ?? 1,
        strict: over.strict ?? false,
        canEdit: over.canEdit ?? true,
        hidden: over.hidden ?? false,
      },
      ...(over.direct ?? []).map((d) => ({
        id: d.id,
        task: d.task,
        title: d.title,
        outcome: d.outcome ?? ("incomplete" as Outcome),
        unexpanded: (over.maxDepth ?? 1) === 1,
      })),
    ],
    edges: (over.direct ?? []).map(
      (d) => [d.id, over.root] as [string, string],
    ),
    maxDepth: over.maxDepth ?? 1,
  });
}
