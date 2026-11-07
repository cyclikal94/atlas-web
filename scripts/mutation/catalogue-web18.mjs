// WEB-18's mutants (plan §7.5: the dependency graph's parser, tree, summary, map, read hook, editor base and dialog), numbered MU-7001…
// (unit) and MU-7101… (real engine), each title starting with its plan id. In the form and under the rules of `data-catalogue.mjs`,
// which spreads them into its `UNIT` and `ENGINE` lists. `sub` is the catalogue's own exactly-one-occurrence patcher. Every unit mutant
// names the test written for it (`expect`, matched against the failing test's full name): only an assertion of that test counts.
//
// Not created from the plan's list, with the reason (never counted as caught):
//  - MU-7026 ("the preview-unavailable block removed"): its patch would be byte-identical to WEB-10c's MU-3017 (the same line of
//    `editorBlock`), which is retained unchanged; WEB-18's S-ED7 also exercises that rule.
//  - The parser's "root first" check alone: the root's own depth and relation checks reject the same bodies (layered defences), so
//    removing it is not observable; the parser's other checks each have their own mutant below.
// Re-anchored WEB-10c mutant (catalogue-web10c.mjs), the same fault over the moved line: MU-3018 (the editor starts from the transitive
// preview instead of its authoritative start: since D-18-7 that start is the graph's direct list, built in the editor's `build`).
import { sub } from "./data-catalogue.mjs";

const CONTRACT = "src/features/tasks/model/contract.ts";
const GRAPH = "src/features/tasks/model/graph.ts";
const HOOK = "src/features/tasks/detail/useDependencyGraph.ts";
const MODEL = "src/features/tasks/model/dependencies.ts";
const DEPS = "src/features/tasks/detail/Dependencies.tsx";
const VIEW = "src/features/tasks/detail/DependencyGraph.tsx";
const MODEL_TESTS = ["tests/features/tasks/dependency-graph-model.test.ts"];
const HOOK_TESTS = ["tests/features/tasks/dependency-graph-hook.test.tsx"];
const EDITOR_TESTS = ["tests/features/tasks/dependency-editor-graph.test.tsx"];
const VIEW_TESTS = ["tests/features/tasks/dependency-graph-view.test.tsx"];

export const UNIT_WEB18 = [
  // ---- the parser (plan §3.1) ------------------------------------------------------------------------------------------------------
  {
    id: "MU-7001",
    title:
      "MU-7001: WEB-18 §3.1: the answer's effective max_depth is not checked against the request",
    file: CONTRACT,
    tests: [...MODEL_TESTS, "tests/features/tasks/api-graph.test.ts"],
    expect: /M-P4 another max_depth than asked|its answer must say 1/,
    patch: (t) =>
      sub(t, "  if (value.max_depth !== request.maxDepth) return null;\n", ""),
  },
  {
    id: "MU-7002",
    title:
      "MU-7002: WEB-18 §3.1: an answer for another root than the one asked is accepted",
    file: CONTRACT,
    tests: [...MODEL_TESTS, "tests/features/tasks/api-graph.test.ts"],
    expect: /M-P3 another root than asked|an answer for another root/,
    patch: (t) =>
      sub(
        t,
        "  if (!isUuid(value.root_id) || value.root_id !== request.rootId) return null;",
        "  if (!isUuid(value.root_id)) return null;",
      ),
  },
  {
    id: "MU-7003",
    title: "MU-7003: WEB-18 §3.1: an edge of an UNEXPANDED node is accepted",
    file: CONTRACT,
    tests: MODEL_TESTS,
    expect: /M-P9 an edge of an unexpanded node/,
    patch: (t) =>
      sub(
        t,
        '    if (dependant.prerequisites !== "expanded") return null;\n',
        "",
      ),
  },
  {
    id: "MU-7004",
    title:
      "MU-7004: WEB-18 §3.1: restricted_prerequisites may be null on an expanded node",
    file: CONTRACT,
    tests: MODEL_TESTS,
    expect: /M-P11a restricted_prerequisites null on an expanded node/,
    patch: (t) =>
      sub(
        t,
        '      ? typeof raw.restricted_prerequisites !== "boolean"\n',
        "      ? false\n",
      ),
  },
  {
    id: "MU-7005",
    title:
      "MU-7005: WEB-18 §3.1: a direct list shorter than the root's edges is accepted",
    file: CONTRACT,
    tests: MODEL_TESTS,
    expect: /M-P12 a direct list that is not the root's edges/,
    patch: (t) =>
      sub(
        t,
        "  if (rootPrerequisites.size !== direct.length) return null;\n",
        "",
      ),
  },
  {
    id: "MU-7006",
    title:
      "MU-7006: WEB-18 §3.1: a node's relation (direct or further back) is not checked against the root's edges",
    file: CONTRACT,
    tests: MODEL_TESTS,
    expect: /M-P13a a transitive node said to be direct/,
    patch: (t) =>
      sub(
        t,
        '      (node.relation === "direct") !== rootPrerequisites.has(node.occurrence_id)\n',
        "      (false as boolean)\n",
      ),
  },
  {
    id: "MU-7007",
    title:
      "MU-7007: WEB-18 §3.1: a depth that is not the breadth-first distance (or a node no edge reaches) is accepted",
    file: CONTRACT,
    tests: MODEL_TESTS,
    expect: /M-P14 a depth that is not the shortest distance/,
    patch: (t) =>
      sub(
        t,
        "    if (distance.get(node.occurrence_id) !== node.depth) return null;\n",
        "",
      ),
  },
  {
    id: "MU-7008",
    title:
      "MU-7008: WEB-18 §3.1 (obligation 6): coverage is not checked against its definition",
    file: CONTRACT,
    tests: MODEL_TESTS,
    expect: /M-P16 coverage that is not its definition/,
    patch: (t) =>
      sub(
        t,
        '  if ((value.coverage === "partial") !== partial) return null;\n',
        "",
      ),
  },
  {
    id: "MU-7009",
    title:
      "MU-7009: WEB-18 §3.1 (obligation 6): restricted is not checked against its definition",
    file: CONTRACT,
    tests: MODEL_TESTS,
    expect: /M-P17 restricted that is not its definition/,
    patch: (t) =>
      sub(t, "  if (value.restricted !== restricted) return null;\n", ""),
  },
  {
    id: "MU-7010",
    title: "MU-7010: WEB-18 §3.1: a task no node has is accepted in tasks",
    file: CONTRACT,
    tests: MODEL_TESTS,
    expect: /M-P19b a task no node has/,
    patch: (t) =>
      sub(t, "  if (nodeTasks.size !== taskIds.size) return null;\n", ""),
  },
  {
    id: "MU-7011",
    title:
      "MU-7011: WEB-18 §3.1: a dependency_state is not checked against the contract's definition",
    file: CONTRACT,
    tests: MODEL_TESTS,
    expect: /M-P18[a-e] /,
    patch: (t) =>
      sub(
        t,
        "    if (node.dependency_state !== definedState(node, visible)) return null;\n",
        "",
      ),
  },
  {
    id: "MU-7012",
    title:
      "MU-7012: WEB-18 §3.1: a node with a key the contract does not have is accepted",
    file: CONTRACT,
    tests: MODEL_TESTS,
    expect: /M-P2 an unknown node key/,
    patch: (t) =>
      sub(
        t,
        "  if (!isObject(raw) || !keysAre(raw, NODE_KEYS)) return null;",
        '  if (!isObject(raw) || !keysAre(raw, NODE_KEYS, ["title"])) return null;',
      ),
  },
  // ---- the tree, the summary and the map (plan §3.4) -------------------------------------------------------------------------------
  {
    id: "MU-7013",
    title:
      "MU-7013: WEB-18 D-18-2: a shared prerequisite's other edges are dropped from the list (no references)",
    file: GRAPH,
    tests: MODEL_TESTS,
    expect: /M-G3 shared prerequisite|M-G property/,
    patch: (t) => sub(t, "        item.refs.push(id);\n", ""),
  },
  {
    id: "MU-7014",
    title:
      "MU-7014: WEB-18 D-18-2: a day is placed under the dependant a DEPTH-first walk reaches (not at its shortest distance)",
    file: GRAPH,
    tests: MODEL_TESTS,
    expect: /M-G property/,
    patch: (t) =>
      sub(
        t,
        "    const item = queue[at] as TreeItem;\n",
        "    const item = queue.splice(queue.length - 1, 1)[0] as TreeItem;\n    at -= 1;\n",
      ),
  },
  {
    id: "MU-7015",
    title:
      "MU-7015: WEB-18 D-18-10: the summary counts a direct prerequisite still open as done",
    file: GRAPH,
    tests: [...MODEL_TESTS, ...VIEW_TESTS],
    expect: /M-G1 chain|S-G3: the shared prerequisite is referenced/,
    patch: (t) =>
      sub(
        t,
        '    directDone: direct.filter((id) => index.node(id).outcome === "complete")',
        '    directDone: direct.filter((id) => index.node(id).outcome !== "complete")',
      ),
  },
  {
    id: "MU-7016",
    title:
      "MU-7016: WEB-18 D-18-3: the map draws no edge between two days of the same depth",
    file: GRAPH,
    tests: [...MODEL_TESTS, ...VIEW_TESTS],
    expect:
      /M-G7 the map|M-G property|cross \(same-column and right-to-left edges\)/,
    patch: (t) =>
      sub(
        t,
        "  const paths: MapPath[] = g.edges.map((e) => {",
        "  const paths: MapPath[] = g.edges.filter((e) => at.get(e.prerequisite_id)?.x !== at.get(e.dependant_id)?.x).map((e) => {",
      ),
  },
  // ---- the read hook (plan §3.5; backend consumer obligations 1–5) ---------------------------------------------------------------
  {
    id: "MU-7017",
    title:
      "MU-7017: WEB-18 D-18-5 (obligation 2): an answer that is not the latest request's is applied",
    file: HOOK,
    tests: HOOK_TESTS,
    expect: /an earlier request answered after a later one is dropped/,
    patch: (t) =>
      sub(
        t,
        "    if (latest.current !== mine || current.current !== asked) return;",
        "    if (current.current !== asked) return;",
      ),
  },
  {
    id: "MU-7018",
    title:
      "MU-7018: WEB-18 D-18-5 (obligation 1): a view is not kept for its identity",
    file: HOOK,
    tests: HOOK_TESTS,
    expect: /H-2 identity/,
    patch: (t) =>
      sub(
        t,
        '  const scope = `${env.identity}\\u0000${rootId}\\u0000${maxDepth ?? ""}`;',
        '  const scope = `${rootId}\\u0000${maxDepth ?? ""}`;',
      ),
  },
  {
    id: "MU-7019",
    title: "MU-7019: WEB-18 D-18-9: offline, the last graph stays shown",
    file: HOOK,
    tests: HOOK_TESTS,
    expect: /H-3 offline/,
    patch: (t) =>
      sub(
        t,
        '    if (!online.current) {\n      drop({ kind: "offline" });\n      return;\n    }',
        "    if (!online.current) {\n      return;\n    }",
      ),
  },
  {
    id: "MU-7020",
    title:
      "MU-7020: WEB-18 D-18-9 (obligation 4): a view whose read answers not_found is kept",
    file: HOOK,
    tests: HOOK_TESTS,
    expect: /H-4 refusal/,
    patch: (t) =>
      sub(
        t,
        '    return { kind: "refused" };',
        '    return previous.kind === "ready" || previous.kind === "stale"\n      ? { ...previous, checking: false }\n      : { kind: "refused" };',
      ),
  },
  {
    id: "MU-7021",
    title:
      "MU-7021: WEB-18 D-18-5 (cost): a trigger during a read sends another at once (no coalescing)",
    file: HOOK,
    tests: HOOK_TESTS,
    expect: /triggers during a read queue exactly ONE follow-up/,
    patch: (t) =>
      sub(
        t,
        "    if (flight.current !== null && flight.current.scope === asked) {",
        "    if (false as boolean) {",
      ),
  },
  {
    id: "MU-7022",
    title:
      "MU-7022: WEB-18 D-18-5: a BFCache hide keeps the snapshot (a restored page shows it unread)",
    file: HOOK,
    tests: HOOK_TESTS,
    expect: /H-9 a BFCache hide drops the snapshot/,
    patch: (t) =>
      sub(t, "      if (event.persisted) drop(LOADING);", "      void event;"),
  },
  // ---- the editor (D-18-6/7/8) -----------------------------------------------------------------------------------------------------
  {
    id: "MU-7023",
    title:
      "MU-7023: WEB-18 D-18-7: a new edit starts empty instead of from the authoritative direct list",
    file: DEPS,
    tests: EDITOR_TESTS,
    expect: /S-ED1/,
    patch: (t) =>
      sub(
        t,
        "      list: keepList ? v.list : [...g.direct_prerequisites],",
        "      list: keepList ? v.list : [],",
      ),
  },
  {
    id: "MU-7024",
    title:
      "MU-7024: WEB-18 D-18-7/8 (A18-9): the save is sent on the cache's version, not on the version of the read it was built from",
    file: DEPS,
    tests: EDITOR_TESTS,
    expect: /S-ED1|S-ED3/,
    patch: (t) => sub(t, "      reviewedBase: base.version,\n", ""),
  },
  {
    id: "MU-7025",
    title:
      "MU-7025: WEB-18 D-18-6: a root with hidden prerequisites offers Save (which would remove them)",
    file: MODEL,
    tests: EDITOR_TESTS,
    expect: /S-ED7 the day has hidden prerequisites/,
    patch: (t) =>
      sub(
        t,
        '  if (input.root.restricted_prerequisites === true) return "restricted";\n',
        "",
      ),
  },
  {
    id: "MU-7027",
    title:
      "MU-7027: WEB-18 D-18-7 (E-14): Save is offered while another change of the day's version is unsettled",
    file: MODEL,
    tests: EDITOR_TESTS,
    expect: /S-ED5 another unsettled change/,
    patch: (t) =>
      sub(t, '  if (input.pending === true) return "pending";\n', ""),
  },
  {
    id: "MU-7028",
    title:
      "MU-7028: WEB-18 D-18-7 (A18-6): a touched edit whose base moved is saved as it is",
    file: MODEL,
    tests: EDITOR_TESTS,
    expect: /touched: Save is withheld with 'changed'/,
    patch: (t) =>
      sub(t, '  if (input.changed === true) return "changed";\n', ""),
  },
  {
    id: "MU-7032",
    title:
      "MU-7032: WEB-18 D-18-7: a newer read re-seeds a TOUCHED edit (the person's input replaced behind their back)",
    file: DEPS,
    tests: EDITOR_TESTS,
    expect: /touched: Save is withheld with 'changed'/,
    patch: (t) =>
      sub(
        t,
        "    if (v.base !== null && (v.touched || baseMatches(v.base, current))) return;",
        "    if (v.base !== null && baseMatches(v.base, current)) return;",
      ),
  },
  // ---- the dialog (D-18-1, D-18-5, D-18-9) -----------------------------------------------------------------------------------------
  {
    id: "MU-7029",
    title:
      "MU-7029: WEB-18 D-18-9 (obligation 6): a partial answer is shown without its notice",
    file: VIEW,
    tests: VIEW_TESTS,
    expect: /S-G6/,
    patch: (t) =>
      sub(
        t,
        '          {graph.coverage === "partial" ? (',
        "          {false ? (",
      ),
  },
  {
    id: "MU-7030",
    title:
      "MU-7030: WEB-18 D-18-9 (obligation 6): a restricted answer is shown without its notice",
    file: VIEW,
    tests: VIEW_TESTS,
    expect: /S-G5/,
    patch: (t) =>
      sub(t, "          {graph.restricted ? (", "          {false ? ("),
  },
  {
    id: "MU-7031",
    title:
      "MU-7031: WEB-18 D-18-9: the preview's ordered list is shown beside the graph (connections implied by order)",
    file: DEPS,
    tests: VIEW_TESTS,
    expect: /S-G1|S-G3|cross \(same-column/,
    patch: (t) =>
      sub(
        t,
        '  const fallback = graph.view.kind === "error" || graph.view.kind === "refused";',
        "  const fallback = true as boolean;",
      ),
  },
  {
    id: "MU-7033",
    title:
      "MU-7033: WEB-18 D-18-5 (cost): the applied revision becoming known reads the whole graph a second time on opening",
    file: DEPS,
    tests: VIEW_TESTS,
    expect: /S-G1|S-G2|S-G3|cross \(same-column/,
    patch: (t) =>
      sub(
        t,
        '  const moved =\n    value !== undefined && value !== first.current ? String(value) : "";',
        '  const moved = value === undefined ? "" : String(value);',
      ),
  },
  {
    id: "MU-7034",
    title:
      "MU-7034: WEB-18 D-18-3/D-18-8a: the map names this day by the answer's title while the list uses the dialog's (two names for one day)",
    file: VIEW,
    tests: VIEW_TESTS,
    expect: /S-G1b/,
    patch: (t) =>
      sub(
        t,
        "              {root ? rootTitle : title}\n",
        "              {title}\n",
      ),
  },
  // ---- revision 1 (independent review 1, F-R2..F-R4) ------------------------------------------------------------------------------
  {
    id: "MU-7036",
    title:
      "MU-7036: WEB-18 revision 1 (review F-R2): the tree takes Arrow, Home, End, Enter and Space held with Alt, Ctrl or Meta from the browser",
    file: VIEW,
    tests: VIEW_TESTS,
    expect: /S-G9b/,
    patch: (t) =>
      sub(
        t,
        "    if (event.altKey || event.ctrlKey || event.metaKey) return;\n",
        "",
      ),
  },
  {
    id: "MU-7037",
    title:
      "MU-7037: WEB-18 revision 1 (review F-R3): the summary rewrites the joined text, so a title containing '. and ' is altered",
    file: VIEW,
    tests: VIEW_TESTS,
    expect: /S-G3b/,
    patch: (t) =>
      sub(
        t,
        "      {text}.\n",
        '      {text.replace(/\\. and /, ", and ")}.\n',
      ),
  },
  {
    id: "MU-7038",
    title:
      "MU-7038: WEB-18 revision 1 (review F-R4): 'Try again' from the stale notice shows no 'Checking again…' while the re-read is in flight",
    file: VIEW,
    tests: VIEW_TESTS,
    expect: /S-G10b/,
    patch: (t) =>
      sub(
        t,
        "                {copy.TRY_AGAIN}\n              </Button>\n              {view.checking ? (",
        "                {copy.TRY_AGAIN}\n              </Button>\n              {false ? (",
      ),
  },
  {
    id: "MU-7039",
    title:
      "MU-7039: WEB-18 revision 1 (review F-R4): the section is busy only while a READY answer is re-read (not a stale or failed one)",
    file: VIEW,
    tests: VIEW_TESTS,
    expect: /S-G10b|S-G10c/,
    patch: (t) =>
      sub(
        t,
        '        ((view.kind === "ready" ||\n          view.kind === "stale" ||\n          view.kind === "error") &&\n          view.checking)',
        '        (view.kind === "ready" && view.checking)',
      ),
  },
  {
    id: "MU-7040",
    title:
      "MU-7040: WEB-18 revision 1 (F-R4's related schedule): 'Try again' from the error shows no 'Checking again…' while the re-read is in flight",
    file: VIEW,
    tests: VIEW_TESTS,
    expect: /S-G10c/,
    patch: (t) =>
      sub(
        t,
        "{copy.TRY_AGAIN}</Button>\n            {view.checking ? (",
        "{copy.TRY_AGAIN}</Button>\n            {false ? (",
      ),
  },
  {
    id: "MU-7041",
    title:
      "MU-7041: WEB-18 revision 1 (F-R4's related schedule): the hook does not mark a failed view as checking while it is read again",
    file: HOOK,
    tests: VIEW_TESTS,
    expect: /S-G10c/,
    patch: (t) =>
      sub(
        t,
        '              prev.view.kind === "stale" ||\n              prev.view.kind === "error"\n',
        '              prev.view.kind === "stale"\n',
      ),
  },
];

export const ENGINE_WEB18 = [
  {
    id: "MU-7101",
    title:
      "MU-7101: WEB-18 D-18-3: (REAL ENGINE) the decorative map is exposed to assistive technology",
    file: VIEW,
    spec: "tests/e2e/fixture.tasks-18.spec.ts",
    grep: "E-G1: the map and the list agree",
    expect: /E-G1: the map and the list agree/,
    patch: (t) =>
      sub(
        t,
        '    <div\n      aria-hidden="true"\n      data-graph-map=""',
        '    <div\n      data-graph-map=""',
      ),
  },
  {
    id: "MU-7102",
    title:
      "MU-7102: WEB-18 D-18-2: (REAL ENGINE) Right and Left are swapped in the list (Right closes or goes up, Left opens)",
    file: VIEW,
    spec: "tests/e2e/fixture.tasks-18.spec.ts",
    grep: "E-G1: the map and the list agree",
    expect: /E-G1: the map and the list agree/,
    patch: (t) =>
      sub(
        sub(t, '      case "ArrowRight":\n', '      case "ArrowSwapped":\n'),
        '      case "ArrowLeft":\n',
        '      case "ArrowRight":\n',
      ).replace('      case "ArrowSwapped":\n', '      case "ArrowLeft":\n'),
  },
  {
    id: "MU-7103",
    title:
      "MU-7103: WEB-18 D-18-5 (obligation 2): (REAL ENGINE) an answer asked before the connection dropped is applied after a later one",
    file: HOOK,
    spec: "tests/e2e/fixture.tasks-18.spec.ts",
    grep: "E-G5: ordering",
    expect: /E-G5: ordering/,
    patch: (t) =>
      sub(
        t,
        "    if (latest.current !== mine || current.current !== asked) return;",
        "    if (current.current !== asked) return;",
      ),
  },
];
