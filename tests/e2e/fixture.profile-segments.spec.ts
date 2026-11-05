import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { checklistValue, w1 } from "../../scripts/lib/profile-workloads.mjs";
import {
  ACCOUNT,
  bootSession,
  seedSettled,
  stubNetwork,
  waitForState,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * The segmented-delivery TUNING SWEEP (WEB-09c, BOUNDED-SYNC-PAGINATION-20261027; plan §5). MEASUREMENT, not a check: it runs only when
 * `ATLAS_SEGMENT_SWEEP` names an output directory, and otherwise every case is skipped. It drives the PRODUCTION engine, plans and session
 * wrapper in a real engine, with `/sync` STUBBED: the stub answers BE-Q23's PROVISIONAL contract by splitting exact, hashed fixture bytes
 * into segments of the requested size. Nothing here is the real server, and nothing here is a device: desktop engines only.
 *
 * Workloads: W1 (the approved 800 x 100-item checklist batch, `scripts/lib/profile-workloads.mjs`, 6,108,899 bytes) and R201 (a
 * reachable-shape dense revision: one person ancestor and 200 dense checklist fields; the ancestor repeats in every segment, as BE-Q23's
 * closure rule requires, and counts against the budget). Budgets: `ATLAS_SEGMENT_SWEEP_BUDGETS` (default 4,25,100,200,whole), each run in
 * a fresh browser context, `ATLAS_SEGMENT_SWEEP_RUNS` times (default 5). Recorded per run: requests, wall-clock from the first request to
 * idle, each page's bytes, scan and commit milliseconds (the engine's own trace), the activation's commit, and in Chromium only the JS heap
 * high-water mark above the page's idle baseline (CDP `Performance.getMetrics`, sampled every 20 ms: a sampled peak, not an exact one).
 * The host's load averages are recorded at the start and end of every run: figures taken while other heavy work runs are not tuning evidence.
 */
const OUT = process.env.ATLAS_SEGMENT_SWEEP;
const RUNS = Number(process.env.ATLAS_SEGMENT_SWEEP_RUNS ?? 5);
const BUDGETS = (
  process.env.ATLAS_SEGMENT_SWEEP_BUDGETS ?? "4,25,100,200,whole"
).split(",");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
interface Workload {
  name: string;
  revision: number;
  /** The changes of the revision in the server's order (the ancestor first). */
  changes: unknown[];
  /** Changes that the closure rule repeats at the head of every segment. */
  ancestors: unknown[];
}
const W1 = (): Workload => {
  const page = JSON.parse(w1()) as { batches: Array<{ changes: unknown[] }> };
  return {
    name: "W1",
    revision: 1,
    changes: page.batches[0]?.changes ?? [],
    ancestors: [],
  };
};
const R201 = (): Workload => {
  const person = {
    kind: "upsert",
    resource: {
      id: uuid(1),
      kind: "person",
      parent_id: null,
      label: "Person",
      value: null,
      version: 1,
      can_edit: true,
      policy_version: 1,
      archived: false,
    },
  };
  const fields = Array.from({ length: 200 }, (_, c) => ({
    kind: "upsert",
    resource: {
      id: uuid(100_000 + c),
      kind: "field",
      parent_id: uuid(1),
      label: "Checklist",
      value: checklistValue(c + 1),
      version: 1,
      can_edit: true,
      policy_version: 1,
      archived: false,
    },
  }));
  return { name: "R201", revision: 1, changes: fields, ancestors: [person] };
};

/** The page bodies a segmenting server would send for budget `m` ("whole": the batch in one ordinary page). */
function bodies(w: Workload, budget: string): string[] {
  const page = (
    changes: unknown[],
    segment: { index: number; last: boolean } | null,
    next: string,
    more: boolean,
  ) =>
    JSON.stringify({
      phase: "delta",
      batches: [
        { revision: w.revision, changes, ...(segment ? { segment } : {}) },
      ],
      next_cursor: next,
      has_more: more,
    });
  if (budget === "whole")
    return [page([...w.ancestors, ...w.changes], null, "final", false)];
  const per = Number(budget) - w.ancestors.length;
  const out: string[] = [];
  for (
    let from = 0, index = 0;
    from < w.changes.length;
    from += per, index += 1
  ) {
    const last = from + per >= w.changes.length;
    out.push(
      page(
        [...w.ancestors, ...w.changes.slice(from, from + per)],
        { index, last },
        last ? "final" : `cont-${index}`,
        !last,
      ),
    );
  }
  return out;
}

const heapSampler = async (page: Page, enabled: boolean) => {
  if (!enabled)
    return { stop: async () => null, baseline: null as number | null };
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const read = async () => {
    const { metrics } = (await cdp.send("Performance.getMetrics")) as {
      metrics: Array<{ name: string; value: number }>;
    };
    return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  };
  const baseline = await read();
  let peak = baseline;
  let running = true;
  const loop = (async () => {
    while (running) {
      peak = Math.max(peak, await read().catch(() => peak));
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  return {
    baseline,
    stop: async () => {
      running = false;
      await loop;
      return peak - baseline;
    },
  };
};

test.describe("WEB-09c segmented-delivery tuning sweep (measurement; runs only with ATLAS_SEGMENT_SWEEP)", () => {
  test.skip(
    !OUT,
    "the sweep is a measurement, run only when ATLAS_SEGMENT_SWEEP names an output directory",
  );
  for (const make of [W1, R201])
    for (const budget of BUDGETS)
      for (let run = 1; run <= RUNS; run += 1)
        test(`${make().name} at ${budget}, run ${run}`, async ({
          context,
          browserName,
        }) => {
          test.setTimeout(600_000);
          const w = make();
          const pages = bodies(w, budget);
          const loadStart = loadavg();
          const net = await stubNetwork(context);
          await seedSettled(context);
          const page = await bootSession(context);
          for (const body of pages)
            net.script.push(() => ({ status: 200, body }));
          const heap = await heapSampler(page, browserName === "chromium");
          const started = Date.now();
          await page.evaluate(
            async ({ a, segmented, m }) => {
              await window.__atlasData?.startSync(a, {
                seedCursor: "cursor-0",
                ...(segmented
                  ? { segmentedCapable: true, segmentedMaxChanges: m }
                  : {}),
              });
            },
            {
              a: ACCOUNT,
              segmented: budget !== "whole",
              m: budget === "whole" ? 0 : Number(budget),
            },
          );
          // A Node-side poll (an async predicate given to `waitForFunction` resolves at once: its promise is truthy).
          for (const deadline = Date.now() + 540_000; ; ) {
            const row = (await page.evaluate(
              (a) => window.__atlasData?.syncState(a),
              ACCOUNT,
            )) as { applied_revision?: unknown; delta_stage?: unknown } | null;
            if (row?.applied_revision === w.revision && row.delta_stage == null)
              break;
            if (Date.now() > deadline)
              throw new Error("the revision was not applied");
            await page.waitForTimeout(10);
          }
          const wallMs = Date.now() - started;
          await waitForState(page, "idle");
          const peak = await heap.stop();
          const trace = (await page.evaluate(
            () =>
              (window.__atlasData as unknown as { engineTrace: string[] })
                .engineTrace,
          )) as string[];
          // The engine's own span, from its first tick to the commit that applied the revision (performance.now in the page).
          const at = (line: string) =>
            Number(line.slice(0, line.indexOf("ms ")));
          const firstTick = trace.find((line) =>
            line.includes(" data.sync_tick "),
          );
          const applied = trace.filter(
            (line) =>
              line.includes(" data.sync_commit ") &&
              line.includes('"value":"committed"'),
          )[0];
          const engineMs =
            firstTick && applied ? at(applied) - at(firstTick) : null;
          const commits = trace
            .filter((line) => line.includes(" data.sync_commit "))
            .map(
              (line) =>
                JSON.parse(line.slice(line.indexOf("{"))) as Record<
                  string,
                  unknown
                >,
            );
          const rows =
            (await page.evaluate(
              (a) => window.__atlasData?.rows(a, "cache").then((r) => r.length),
              ACCOUNT,
            )) ?? 0;
          expect(rows).toBe(w.changes.length + w.ancestors.length);
          const record = {
            workload: w.name,
            engine: browserName,
            budget,
            run,
            requests: net.requests.filter(
              (u) => u.searchParams.get("cursor") !== "final",
            ).length,
            sent_max_changes:
              net.requests[0]?.searchParams.get("max_changes") ?? null,
            wall_ms: wallMs,
            engine_ms: engineMs,
            pages: commits,
            heap_peak_above_baseline_bytes: peak,
            body_sha256: pages.map(sha),
            body_bytes: pages.map((b) => Buffer.byteLength(b)),
            load_start: loadStart,
            load_end: loadavg(),
          };
          const dir = join(OUT as string, browserName);
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, `${w.name}-${budget}-${run}.json`),
            `${JSON.stringify(record, null, 2)}\n`,
          );
        });
});
