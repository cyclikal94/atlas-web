import { describe, expect, test } from "vitest";
import {
  type DependencyGraph,
  parseDependencyGraph,
} from "../../../src/features/tasks/model/contract";
import {
  edgesOfTree,
  indexGraph,
  itemsOf,
  MAP_MAX_COLUMN,
  MAP_MAX_DEPTH,
  mapLayout,
  mapRefusal,
  summaryOf,
  treeOf,
} from "../../../src/features/tasks/model/graph";
import {
  branchSpec,
  budgetPartialSpec,
  buildGraph,
  chainSpec,
  crossSpec,
  DOCUMENTED,
  deepSpec,
  depthOneSpec,
  emptySpec,
  type GraphSpec,
  gid,
  maximalSpec,
  randomSpec,
  restrictedMidSpec,
  restrictedOnlySpec,
  restrictedRootSpec,
  sharedSpec,
} from "../../support/tasks/graphs";

/**
 * WEB-18 (plan §3.1, §3.4; A18-1..3, A18-7, A18-10, A18-11): the strict parser of `getDependencyGraph` against the contract's definitions,
 * and the pure tree, summary and map derived from ONE answer. Pure: no screen.
 */
type Raw = Record<string, unknown> & {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
};
const raw = (g: DependencyGraph): Raw => JSON.parse(JSON.stringify(g)) as Raw;
const parse = (body: unknown, rootId: string, maxDepth = 200) =>
  parseDependencyGraph(body, { rootId, maxDepth });
const valid = (spec: GraphSpec) => buildGraph(spec);
const pairSet = (edges: { prerequisite_id: string; dependant_id: string }[]) =>
  new Set(edges.map((e) => `${e.prerequisite_id}>${e.dependant_id}`));

describe("the documented examples and the builders are the contract's answers", () => {
  test.each(Object.entries(DOCUMENTED))("documented: %s", (_name, body) => {
    const json = JSON.parse(body) as { root_id: string; max_depth: number };
    const g = parse(json, json.root_id, json.max_depth);
    expect(g).not.toBeNull();
    expect(g?.root_id).toBe(json.root_id);
  });
  test.each([
    ["chain", chainSpec()],
    ["branch", branchSpec()],
    ["shared", sharedSpec()],
    ["empty", emptySpec()],
    ["restricted root", restrictedRootSpec()],
    ["restricted only", restrictedOnlySpec()],
    ["restricted mid", restrictedMidSpec()],
    ["depth one", depthOneSpec()],
    ["cross", crossSpec()],
    ["deep", deepSpec()],
    ["budget partial", budgetPartialSpec()],
    ["maximal", maximalSpec()],
  ])("builder: %s", (_name, spec) => {
    const g = valid(spec);
    expect(parse(raw(g), spec.root, spec.maxDepth ?? 200)).toEqual(g);
  });
});

/** One rejection per invariant (plan §3.1): each body differs from a valid one by exactly the broken fact. */
describe("M-P: every definitional invariant is checked", () => {
  const shared = () => raw(valid(sharedSpec()));
  const root = gid(20);
  const at = (b: Raw, id: string) =>
    b.nodes.find((n) => n.occurrence_id === id) as Record<string, unknown>;
  const cases: Array<[string, (b: Raw) => unknown, string?, number?]> = [
    ["M-P1 an unknown top-level key", (b) => ({ ...b, revision: 1 })],
    [
      "M-P2 an unknown node key",
      (b) => {
        (b.nodes[1] as Record<string, unknown>).title = "Cook";
        return b;
      },
    ],
    ["M-P3 another root than asked", (b) => b, gid(21)],
    ["M-P4 another max_depth than asked", (b) => b, root, 1],
    [
      "M-P5 the root is not first",
      (b) => ({ ...b, nodes: [b.nodes[1], b.nodes[0], ...b.nodes.slice(2)] }),
    ],
    ["M-P6 a node twice", (b) => ({ ...b, nodes: [...b.nodes, b.nodes[1]] })],
    [
      "M-P7 an edge to a node that is not returned",
      (b) => ({
        ...b,
        edges: [...b.edges, { prerequisite_id: gid(99), dependant_id: root }],
      }),
    ],
    [
      "M-P8 an edge from a node to itself",
      (b) => ({
        ...b,
        edges: [
          ...b.edges,
          { prerequisite_id: gid(21), dependant_id: gid(21) },
        ],
      }),
    ],
    [
      "M-P9 an edge of an unexpanded node",
      (b) => {
        Object.assign(at(b, gid(21)), {
          prerequisites: "unexpanded",
          restricted_prerequisites: null,
          dependency_state: "unknown",
        });
        return { ...b, coverage: "partial" };
      },
    ],
    ["M-P10 an edge twice", (b) => ({ ...b, edges: [...b.edges, b.edges[0]] })],
    [
      "M-P11a restricted_prerequisites null on an expanded node",
      (b) => {
        at(b, gid(21)).restricted_prerequisites = null;
        return b;
      },
    ],
    [
      "M-P11b restricted_prerequisites a boolean on an unexpanded node",
      () => {
        const b = raw(valid(depthOneSpec()));
        (b.nodes[1] as Record<string, unknown>).restricted_prerequisites =
          false;
        return b;
      },
      gid(1),
      1,
    ],
    [
      "M-P12 a direct list that is not the root's edges",
      (b) => ({ ...b, direct_prerequisites: [gid(21)] }),
    ],
    [
      "M-P13a a transitive node said to be direct",
      (b) => {
        at(b, gid(23)).relation = "direct";
        return b;
      },
    ],
    [
      "M-P13b a direct node said to be transitive",
      (b) => {
        at(b, gid(21)).relation = "transitive";
        return b;
      },
    ],
    [
      "M-P14 a depth that is not the shortest distance",
      (b) => {
        at(b, gid(23)).depth = 3;
        return b;
      },
    ],
    [
      "M-P15 a node no edge reaches",
      (b) => ({
        ...b,
        edges: b.edges.filter((e) => e.prerequisite_id !== gid(23)),
      }),
    ],
    [
      "M-P16 coverage that is not its definition",
      (b) => ({ ...b, coverage: "partial" }),
    ],
    [
      "M-P17 restricted that is not its definition",
      (b) => ({ ...b, restricted: true }),
    ],
    [
      "M-P18a satisfied without a complete outcome",
      (b) => {
        at(b, gid(21)).dependency_state = "satisfied";
        return b;
      },
    ],
    [
      "M-P18b ready while a visible prerequisite is open",
      (b) => {
        at(b, root).dependency_state = "ready";
        return b;
      },
    ],
    [
      "M-P18c waiting while every visible prerequisite is done",
      (b) => {
        at(b, gid(21)).dependency_state = "waiting";
        return b;
      },
    ],
    [
      "M-P18d restricted without a hidden prerequisite",
      (b) => {
        at(b, gid(21)).dependency_state = "restricted";
        return b;
      },
    ],
    [
      "M-P18e unknown on an expanded node",
      (b) => {
        at(b, gid(21)).dependency_state = "unknown";
        return b;
      },
    ],
    [
      "M-P19a a node's task missing from tasks",
      (b) => ({ ...b, tasks: b.tasks.slice(1) }),
    ],
    [
      "M-P19b a task no node has",
      (b) => ({
        ...b,
        tasks: [...b.tasks, { id: gid(99, 1), title: "Extra" }],
      }),
    ],
    ["M-P19c a task twice", (b) => ({ ...b, tasks: [...b.tasks, b.tasks[0]] })],
    [
      "M-P20a more than 200 nodes",
      () => {
        const b = raw(valid(maximalSpec()));
        return {
          ...b,
          nodes: [...b.nodes, { ...b.nodes[199], occurrence_id: gid(1300) }],
        };
      },
      gid(1000),
      200,
    ],
    [
      "M-P20b more than 6400 edges",
      (b) => ({
        ...b,
        edges: Array.from({ length: 6401 }, () => b.edges[0]),
      }),
    ],
    [
      "M-P20c more than 32 direct prerequisites",
      (b) => ({
        ...b,
        direct_prerequisites: Array.from({ length: 33 }, (_, i) =>
          gid(300 + i),
        ),
      }),
    ],
    [
      "M-P20d a version below 1",
      (b) => {
        at(b, root).version = 0;
        return b;
      },
    ],
    ["M-P20e max_depth 0", (b) => ({ ...b, max_depth: 0 }), root, 0],
    ["M-P20f max_depth 201", (b) => ({ ...b, max_depth: 201 }), root, 201],
    [
      "M-P21 the root unexpanded",
      (b) => {
        Object.assign(at(b, root), {
          prerequisites: "unexpanded",
          restricted_prerequisites: null,
        });
        return b;
      },
    ],
    [
      "M-P22a a title that is not text",
      (b) => {
        (b.tasks[0] as Record<string, unknown>).title = 7;
        return b;
      },
    ],
    [
      "M-P22b an id that is not a UUID",
      (b) => {
        (b.tasks[0] as Record<string, unknown>).id = "task-1";
        return b;
      },
    ],
    ["M-P22c not an object", () => [1, 2, 3]],
    [
      "M-P23 a second node at depth 0 said to be the root",
      (b) => {
        Object.assign(at(b, gid(21)), { relation: "root" });
        return b;
      },
    ],
  ];
  test.each(cases)("%s", (_name, change, rootId, maxDepth) => {
    const body = change(shared());
    expect(parse(body, rootId ?? root, maxDepth ?? 200)).toBeNull();
  });

  test("M-P20a control: the maximal answer itself parses (200 nodes)", () => {
    const g = valid(maximalSpec());
    expect(g.nodes).toHaveLength(200);
    expect(g.edges.length).toBe(5872);
    expect(parse(raw(g), gid(1000))).not.toBeNull();
  });

  test("control: the unmodified body parses", () => {
    expect(parse(shared(), root)).not.toBeNull();
  });
});

describe("M-G: the tree, the summary and the map, from one answer", () => {
  test("M-G1 chain: each day nested under the one that needs it, levels equal depths", () => {
    const g = valid(chainSpec());
    const t = treeOf(g);
    expect(t.id).toBe(gid(1));
    expect(t.children.map((c) => c.id)).toEqual([gid(2)]);
    expect(t.children[0]?.children.map((c) => c.id)).toEqual([gid(3)]);
    expect(itemsOf(t).map((i) => i.depth)).toEqual([0, 1, 2]);
    expect(summaryOf(g)).toEqual({
      direct: 1,
      directDone: 0,
      open: [gid(2)],
      rootRestricted: false,
      further: 1,
      partial: false,
      restricted: false,
    });
  });

  test("M-G2 branch: three siblings in presentation order (title), no references", () => {
    const g = valid(branchSpec());
    const t = treeOf(g);
    const index = indexGraph(g);
    expect(t.children.map((c) => index.title(c.id))).toEqual([
      "Dry",
      "Put away",
      "Wash",
    ]);
    expect(t.refs).toEqual([]);
    expect(summaryOf(g)).toMatchObject({ direct: 3, directDone: 1 });
  });

  test("M-G3 shared prerequisite: placed ONCE (under the first dependant), referenced under the other", () => {
    const g = valid(sharedSpec());
    const t = treeOf(g);
    const items = itemsOf(t).map((i) => i.id);
    expect(items.filter((id) => id === gid(23))).toHaveLength(1);
    // Cook comes before Pour drinks, so Set the table is placed under Cook and referenced under Pour drinks.
    const cook = t.children.find((c) => c.id === gid(21));
    const pour = t.children.find((c) => c.id === gid(22));
    expect(cook?.children.map((c) => c.id)).toEqual([gid(23)]);
    expect(pour?.refs).toEqual([gid(23)]);
    expect(pairSet(edgesOfTree(t))).toEqual(pairSet(g.edges));
  });

  test("M-G4 empty: the root alone; no map", () => {
    const g = valid(emptySpec());
    expect(treeOf(g)).toEqual({
      id: gid(30),
      depth: 0,
      children: [],
      refs: [],
    });
    expect(summaryOf(g).direct).toBe(0);
    expect(mapLayout(g)).toBeNull();
    expect(mapRefusal(g)).toBe("no_edges");
  });

  test("M-G5 restricted: the summary knows the root waits for something hidden, and counts only what is visible", () => {
    const g = valid(restrictedRootSpec());
    expect(summaryOf(g)).toMatchObject({
      direct: 1,
      directDone: 1,
      open: [],
      rootRestricted: true,
      restricted: true,
    });
    const mid = valid(restrictedMidSpec());
    expect(summaryOf(mid)).toMatchObject({
      rootRestricted: false,
      restricted: true,
      further: 1,
    });
  });

  test("M-G6 partial (depth one and node budget): an unexpanded node is a leaf of the tree, and the summary says partial", () => {
    for (const spec of [depthOneSpec(), budgetPartialSpec()]) {
      const g = valid(spec);
      expect(summaryOf(g).partial).toBe(true);
      const unexpanded = g.nodes.filter(
        (n) => n.prerequisites === "unexpanded",
      );
      const t = itemsOf(treeOf(g));
      for (const n of unexpanded) {
        const item = t.find((i) => i.id === n.occurrence_id);
        expect(item?.children).toEqual([]);
        expect(item?.refs).toEqual([]);
      }
    }
  });

  test("M-G7 the map: prerequisites left of what needs them, one path per edge, same-column and right-to-left edges drawn", () => {
    const g = valid(crossSpec());
    const layout = mapLayout(g);
    expect(layout).not.toBeNull();
    const x = new Map(layout?.boxes.map((b) => [b.id, b.x]));
    // The root is rightmost.
    expect(Math.max(...(layout?.boxes.map((b) => b.x) ?? []))).toBe(
      x.get(gid(60)),
    );
    expect(
      pairSet(
        layout?.paths.map((p) => ({
          prerequisite_id: p.prerequisite,
          dependant_id: p.dependant,
        })) ?? [],
      ),
    ).toEqual(pairSet(g.edges));
    // Equal depth: the same column.
    expect(x.get(gid(61))).toBe(x.get(gid(62)));
    // Measure rooms (depth 2) is left of Book the van (depth 1), which it needs.
    expect((x.get(gid(63)) as number) < (x.get(gid(62)) as number)).toBe(true);
    // Deterministic for one answer.
    expect(mapLayout(g)).toEqual(layout);
  });

  test("M-G7b the map's bounds: deeper than MAP_MAX_DEPTH or a column taller than MAP_MAX_COLUMN is the list alone", () => {
    expect(mapRefusal(valid(deepSpec(MAP_MAX_DEPTH + 1)))).toBeNull();
    expect(mapRefusal(valid(deepSpec(MAP_MAX_DEPTH + 2)))).toBe("too_deep");
    expect(mapLayout(valid(deepSpec(MAP_MAX_DEPTH + 2)))).toBeNull();
    const wide: GraphSpec = {
      root: gid(400),
      nodes: [
        { id: gid(400), task: gid(400, 1), title: "Root" },
        ...Array.from({ length: MAP_MAX_COLUMN + 1 }, (_, i) => ({
          id: gid(401 + i),
          task: gid(401 + i, 1),
          title: `T${i}`,
        })),
      ],
      edges: [
        ...Array.from(
          { length: 32 },
          (_, i) => [gid(401 + i), gid(400)] as [string, string],
        ),
        // The 33rd box at depth 2.
        [gid(401 + MAP_MAX_COLUMN), gid(401)],
      ],
    };
    expect(mapRefusal(valid(wide))).toBeNull();
    const taller: GraphSpec = {
      ...wide,
      nodes: [
        ...wide.nodes,
        ...Array.from({ length: MAP_MAX_COLUMN }, (_, i) => ({
          id: gid(500 + i),
          task: gid(500 + i, 1),
          title: `U${i}`,
        })),
      ],
      edges: [
        ...wide.edges,
        ...Array.from(
          { length: MAP_MAX_COLUMN },
          (_, i) => [gid(500 + i), gid(401 + (i % 32))] as [string, string],
        ),
      ],
    };
    expect(mapRefusal(valid(taller))).toBe("too_tall");
  });

  test("M-G large: the maximal answer trees and summarises; it is too deep to draw", () => {
    const g = valid(maximalSpec());
    const t = treeOf(g);
    expect(itemsOf(t)).toHaveLength(200);
    expect(pairSet(edgesOfTree(t))).toEqual(pairSet(g.edges));
    expect(mapLayout(g)).toBeNull();
    expect(summaryOf(g).direct).toBe(32);
  });

  test("M-G recurring: two days of one task are told apart by day, one task entry", () => {
    const body = JSON.parse(DOCUMENTED.recurring as string) as {
      root_id: string;
    };
    const g = parse(body, body.root_id) as DependencyGraph;
    const index = indexGraph(g);
    const [a, b] = treeOf(g).children.map((c) => c.id);
    expect(index.title(a as string)).toBe("Water plants");
    expect(index.title(b as string)).toBe("Water plants");
    expect(index.node(a as string).slot.date).not.toBe(
      index.node(b as string).slot.date,
    );
  });
});

/** M-G property (A18-10/11): for 300 seeded valid answers, the tree is exactly the answer's edges and every node once, at its depth. */
describe("M-G property: the tree and the map agree with the answer's edges", () => {
  const seeds = Array.from({ length: 300 }, (_, i) => 7919 * (i + 1));
  test("300 random valid answers", () => {
    let drawn = 0;
    for (const seed of seeds) {
      const spec = randomSpec(seed);
      const g = valid(spec);
      const parsed = parse(raw(g), spec.root, g.max_depth);
      expect(parsed, `seed ${seed}`).toEqual(g);
      const t = treeOf(g);
      const items = itemsOf(t);
      expect(items.map((i) => i.id).sort(), `seed ${seed}`).toEqual(
        g.nodes.map((n) => n.occurrence_id).sort(),
      );
      const depth = new Map(g.nodes.map((n) => [n.occurrence_id, n.depth]));
      for (const item of items) expect(item.depth).toBe(depth.get(item.id));
      const shown = edgesOfTree(t);
      expect(shown).toHaveLength(g.edges.length);
      expect(pairSet(shown), `seed ${seed}`).toEqual(pairSet(g.edges));
      const layout = mapLayout(g);
      expect(layout === null, `seed ${seed}`).toBe(mapRefusal(g) !== null);
      if (layout !== null) {
        drawn += 1;
        expect(layout.paths).toHaveLength(g.edges.length);
        expect(new Set(layout.boxes.map((b) => b.id)).size).toBe(
          g.nodes.length,
        );
      }
    }
    // The generator exercises both outcomes of the map's bound.
    expect(drawn).toBeGreaterThan(10);
    expect(drawn).toBeLessThan(seeds.length);
  });
});
