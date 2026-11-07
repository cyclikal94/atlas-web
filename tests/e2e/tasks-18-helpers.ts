import type { BrowserContext, Route } from "@playwright/test";
import type { DependencyGraph } from "../../src/features/tasks/model/contract";
import { buildGraph, type GraphSpec } from "../support/tasks/graphs";
import { API, type BuiltTask } from "./tasks-helpers";

/**
 * WEB-18's read in the native specs: `GET /occurrences/{id}/dependency-graph` answered by a route double (FIXTURE evidence: `page.route`,
 * never a backend). Register AFTER `serveTasks10c` (a later route wins); everything else falls back to it. Each answer is the test's own,
 * may be held, and is logged with its query.
 */
export type GraphAnswer = { status: number; body: unknown };

export interface GraphReads {
  /** The answer to a read (default: 404 `not_found`, which leaves the dialog's labelled fallback list). */
  answer: (q: {
    occurrenceId: string;
    maxDepth: string | null;
  }) => GraphAnswer | Promise<GraphAnswer>;
  log: Array<{ at: number; occurrenceId: string; maxDepth: string | null }>;
}

export async function serveGraph(context: BrowserContext): Promise<GraphReads> {
  const reads: GraphReads = {
    answer: () => ({
      status: 404,
      body: {
        code: "not_found",
        message: "m",
        request_id: "11111111-1111-4111-8111-111111111111",
        details: [],
      },
    }),
    log: [],
  };
  await context.route(
    `**${API}/occurrences/*/dependency-graph*`,
    async (route: Route) => {
      const request = route.request();
      if (request.method() !== "GET") return route.fallback();
      const url = new URL(request.url());
      const match = /\/occurrences\/([^/]+)\/dependency-graph$/.exec(
        url.pathname,
      );
      if (!match) return route.fallback();
      const q = {
        occurrenceId: match[1] as string,
        maxDepth: url.searchParams.get("max_depth"),
      };
      reads.log.push({ at: Date.now(), ...q });
      const a = await reads.answer(q);
      if (a.status === 0) return route.abort("failed");
      return route.fulfill({
        status: a.status,
        contentType: "application/json",
        body: JSON.stringify(a.body),
      });
    },
  );
  return reads;
}

/** A spec's graph rooted at a built task's day (the answer must be for the day shown); other days keep their ids. */
export function graphFor(
  root: BuiltTask,
  spec: GraphSpec,
  others: Readonly<Record<string, BuiltTask>> = {},
): DependencyGraph {
  const id = (n: string) =>
    n === spec.root ? root.occurrenceId : (others[n]?.occurrenceId ?? n);
  return buildGraph({
    ...spec,
    root: root.occurrenceId,
    nodes: spec.nodes.map((n) => ({
      ...n,
      id: id(n.id),
      task: n.id === spec.root ? root.taskId : (others[n.id]?.taskId ?? n.task),
    })),
    edges: spec.edges.map(([p, d]) => [id(p), id(d)]),
  });
}

/** The preview a server gives for the same visible days (the root last). */
export function previewFor(
  g: DependencyGraph,
  over: Record<string, unknown> = {},
): GraphAnswer {
  return {
    status: 200,
    body: {
      token: "d".repeat(64),
      items: [
        ...g.nodes.slice(1).map((n) => ({
          occurrence_id: n.occurrence_id,
          task_id: n.task_id,
          complete: n.outcome === "complete",
          can_complete: true,
          progress_version: null,
        })),
        {
          occurrence_id: g.root_id,
          task_id: g.nodes[0]?.task_id,
          complete: false,
          can_complete: true,
          progress_version: null,
        },
      ],
      unavailable: false,
      strict: g.nodes[0]?.strict ?? false,
      ...over,
    },
  };
}
