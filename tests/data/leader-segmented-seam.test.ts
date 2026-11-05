// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  A,
  type LeaderWorld,
  leaderWorld,
  type ServerRequest,
} from "../support/data/leader-world";
import { projection, Rng, uuid } from "../support/data/sync-pages";

/**
 * WEB-09c R23-PAIR: the DIAGNOSTIC composition seam (`SyncLeaderDeps.segmentedCapable`, supplied by the browser composition only for a
 * development-pair page). Without it the production leader never opts in (production supplies none); with it, BOTH request callers the
 * leader composes (the ordinary engine and the recovery job's fenced catch-up) send `max_changes` with the configured starting budget. A
 * composition that wired one caller and not the other, or opted in without being asked, fails here.
 */
const upsert = (n: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n) },
});
function snapshotServer(w: LeaderWorld): void {
  w.server = (request) => {
    if (request.path !== "/sync") return w.status(404);
    if (request.cursor === null)
      return w.json({
        phase: "snapshot",
        hasMore: false,
        nextCursor: "delta-1",
        batches: [{ revision: 10, changes: [upsert(1)] }],
      });
    return w.json({
      phase: "delta",
      hasMore: false,
      nextCursor: request.cursor,
      batches: [],
    });
  };
}
const syncs = (w: LeaderWorld, klass: ServerRequest["klass"]) =>
  w.requests.filter((r) => r.path === "/sync" && r.klass === klass);

async function run(options?: Parameters<LeaderWorld["page"]>[2]) {
  const w = leaderWorld();
  snapshotServer(w);
  const one = w.page("A", A, options);
  await w.settle();
  // The live-edge poll: an ordinary delta request.
  await w.advance(61_000);
  // A fence the recovery job is eligible to clear: its catch-up is a recovery-class delta request from the stored cursor.
  one.view.set({ kind: "neutral", state: "1d.reauth" as never });
  await w.settle();
  await w.advance(5_000);
  return w;
}

describe("SEG: the diagnostic seam reaches both request callers, and only when given", () => {
  test("SEG-1 without it (as production): no ordinary or recovery request carries max_changes", async () => {
    const w = await run();
    const ordinary = syncs(w, "ordinary").filter((r) => r.cursor !== null);
    const recovery = syncs(w, "recovery");
    expect(ordinary.length).toBeGreaterThan(0);
    expect(recovery.length).toBeGreaterThan(0);
    expect([...ordinary, ...recovery].map((r) => r.maxChanges)).toEqual(
      [...ordinary, ...recovery].map(() => undefined),
    );
  });

  test("SEG-2 with it: the ordinary engine's delta request AND the recovery catch-up carry the configured budget; the snapshot never does", async () => {
    const w = await run({
      segmentedCapable: () => true,
      config: { segmentedMaxChanges: 4 },
    });
    const snapshot = syncs(w, "ordinary").filter((r) => r.cursor === null);
    const ordinary = syncs(w, "ordinary").filter((r) => r.cursor !== null);
    const recovery = syncs(w, "recovery").filter((r) => r.cursor !== null);
    expect(snapshot.length).toBeGreaterThan(0);
    expect(snapshot.every((r) => r.maxChanges === undefined)).toBe(true);
    expect(ordinary.length).toBeGreaterThan(0);
    expect(ordinary.every((r) => r.maxChanges === "4")).toBe(true);
    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery.every((r) => r.maxChanges === "4")).toBe(true);
  });

  test("SEG-3 capability without a configuration uses the configured default (the provisional starting value)", async () => {
    const w = await run({ segmentedCapable: () => true });
    const ordinary = syncs(w, "ordinary").filter((r) => r.cursor !== null);
    expect(ordinary.length).toBeGreaterThan(0);
    expect(
      ordinary.every(
        (r) => r.maxChanges === String(DATA_CONFIG.segmentedMaxChanges),
      ),
    ).toBe(true);
  });
});
