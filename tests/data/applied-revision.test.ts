// @vitest-environment node
import { describe, expect, test } from "vitest";
import { readAppliedRevision } from "../../src/data/plans/applied-revision";
import { listReadPlans } from "../../src/data/plans/registry";
import { pageWorld } from "../support/data/page-world";
import { projection, Rng, uuid } from "../support/data/sync-pages";

/**
 * `readAppliedRevision` (WEB-11a finding 8): the People screens' signal that a synced change was applied (API 0.29 asks for a summary
 * re-read on any synced person or field change). Fixture evidence over the double of IndexedDB, through the PRODUCTION page commit.
 */
const upsert = (n: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n) },
});

describe("readAppliedRevision", () => {
  test("is a registered READ plan over sync_state only", () => {
    const entry = listReadPlans().find(
      (plan) => plan.name === "data.readAppliedRevision",
    );
    expect(entry?.mode).toBe("readonly");
    expect(entry?.scope).toEqual(["sync_state"]);
  });

  test("null before any applied page; a committed page with a batch moves it; a page without one leaves it", async () => {
    const w = await pageWorld({ cursor: "c-0" });
    w.setSync({ applied_revision: null });
    const read = () =>
      w.service.store.run(readAppliedRevision, {
        incarnationId: w.service.incarnationId,
      });
    expect(await read()).toBeNull();
    await w.commit(
      w.input({
        phase: "delta",
        hasMore: false,
        nextCursor: "c-1",
        batches: [{ revision: 7, changes: [upsert(1)] }],
      }),
    );
    expect(await read()).toBe(7);
    await w.commit(
      w.input({
        phase: "delta",
        hasMore: false,
        nextCursor: "c-2",
        batches: [],
      }),
    );
    expect(await read()).toBe(7);
    await w.commit(
      w.input({
        phase: "delta",
        hasMore: false,
        nextCursor: "c-3",
        batches: [{ revision: 9, changes: [upsert(2)] }],
      }),
    );
    expect(await read()).toBe(9);
  });
});
