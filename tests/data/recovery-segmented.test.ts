// @vitest-environment node
import { describe, expect, test } from "vitest";
import { recoveryWorld } from "../support/data/recovery-world";
import { cacheRow } from "../support/data/rows";
import { type Change, projection, Rng, uuid } from "../support/data/sync-pages";

/**
 * U9 (WEB-09c): the recovery job's catch-up follows segmented delivery by the same rules as the engine (W27 for a non-final segment, the
 * final one through W1 in RECOVERY mode, with the activation), and a snapshot never opts in. FIXTURE evidence over the double, against
 * BE-Q23's provisional contract.
 */
const changesOf = (n: number): Change[] =>
  Array.from({ length: n }, (_, k) => ({
    kind: "upsert" as const,
    resource: { ...projection(new Rng(k), k), id: uuid(200 + k), version: 1 },
  }));
const segment = (
  changes: Change[],
  index: number,
  last: boolean,
  nextCursor: string,
): Response =>
  new Response(
    JSON.stringify({
      phase: "delta",
      batches: [{ revision: 9, changes, segment: { index, last } }],
      next_cursor: nextCursor,
      has_more: !last,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("U9: segmented delivery in the recovery job's catch-up", () => {
  test("a fenced catch-up stages, then activates the revision in recovery mode, and finishes; every request carries the budget", async () => {
    const w = await recoveryWorld({
      cursor: "delta-0",
      phase: "delta",
      cacheStatus: "valid",
      displayed: false,
      segmentedCapable: () => true,
    });
    w.put("cache", [cacheRow({ id: uuid(1) })]);
    const changes = changesOf(6);
    let cacheWhileStaged: string[] | null = null;
    w.script.push(segment(changes.slice(0, 3), 0, false, "cont-0"), () => {
      cacheWhileStaged = w.cache().map((r) => r.id);
      return segment(changes.slice(3), 1, true, "final");
    });
    await w.bindJob();
    await w.settle();
    const sync = w.requests.filter((r) => r.url.pathname.endsWith("/sync"));
    expect(
      sync
        .slice(0, 2)
        .map((r) => [
          r.url.searchParams.get("cursor"),
          r.url.searchParams.get("max_changes"),
        ]),
    ).toEqual([
      ["delta-0", "100"],
      ["cont-0", "100"],
    ]);
    expect(cacheWhileStaged).toEqual([uuid(1)]);
    expect(
      w
        .cache()
        .map((r) => r.id)
        .sort(),
    ).toEqual(
      [
        uuid(1),
        ...changes.map((c) => (c as { resource: { id: string } }).resource.id),
      ].sort(),
    );
    expect(w.sync()).toMatchObject({
      cursor: "final",
      applied_revision: 9,
      delta_stage: null,
      recovery_reconcile_pending: true,
    });
    expect(w.rows("delta_staging" as never)).toEqual([]);
    expect(w.calls.some((c) => c.call === "finish")).toBe(true);
  });

  test("a snapshot never opts in, even where the server is known to segment", async () => {
    const w = await recoveryWorld({ segmentedCapable: () => true });
    w.script.push(
      new Response(
        JSON.stringify({
          phase: "snapshot",
          batches: [{ revision: 3, changes: [] }],
          next_cursor: "d1",
          has_more: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await w.bindJob();
    await w.settle();
    const first = w.requests.find((r) => r.url.pathname.endsWith("/sync"));
    expect(first?.url.searchParams.has("max_changes")).toBe(false);
  });
});
