// @vitest-environment node
import { describe, expect, test } from "vitest";
import { pageWorld } from "../support/data/page-world";
import { draftRow, effectRow } from "../support/data/rows";
import { projection, Rng, uuid } from "../support/data/sync-pages";

/**
 * W1 in RECOVERY mode (P-7; matrix 3.7.3): a catch-up page applied while the account is fenced is applied exactly like an ordinary
 * page (content, cursor, sequence), but its reconciliation writes only the receipt bookkeeping of ACKNOWLEDGED drafts, and deletes
 * nothing. The same page in the default mode is WEB-09a's behaviour, unchanged (the contrast below).
 */
const upsert = (n: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n) },
});

async function scenario(mode: "ordinary" | "recovery" | undefined) {
  const w = await pageWorld({ cursor: "c-0" });
  w.put("drafts", [
    draftRow({ local_id: "unsent", status: "queued" }),
    draftRow({
      local_id: "acked",
      status: "acknowledged",
      held_pending_cache: true,
      receipt_revision: 5,
    }),
  ]);
  w.put("pending_effects", [
    effectRow({
      resource_id: uuid(1),
      local_id: "unsent",
      display: { label: "mine" },
    }),
    effectRow({
      resource_id: uuid(1),
      local_id: "acked",
      receipt_revision: 5,
      no_publication_floor: 0,
      display: { label: "sent" },
    }),
  ]);
  const unsent = () =>
    JSON.stringify([
      (w.rows("drafts") as Array<{ local_id: string }>).filter(
        (d) => d.local_id === "unsent",
      ),
      w.commandOf("unsent"),
      (w.rows("pending_effects") as Array<{ local_id: string }>).filter(
        (e) => e.local_id === "unsent",
      ),
    ]);
  const before = unsent();
  const out = await w.commit(
    w.input(
      {
        phase: "delta",
        hasMore: false,
        nextCursor: "c-1",
        batches: [{ revision: 7, changes: [upsert(1)] }],
      },
      mode === undefined ? {} : { mode },
    ),
  );
  return { w, out, before, unsent };
}

describe("commitPage in recovery mode (P-7)", () => {
  test("the page and its position apply; unsent work is byte-identical; the acknowledged receipt is released and nothing is deleted", async () => {
    const { w, out, before, unsent } = await scenario("recovery");
    expect(out.kind).toBe("applied");
    expect(w.sync().cursor).toBe("c-1");
    expect(w.cache().map((row) => row.id)).toEqual([uuid(1)]);
    expect(unsent()).toBe(before);
    const acked = (
      w.rows("drafts") as Array<{
        local_id: string;
        held_pending_cache: boolean;
      }>
    ).find((d) => d.local_id === "acked");
    expect(acked).toMatchObject({ held_pending_cache: false });
    expect(w.rows("pending_effects")).toHaveLength(2);
    w.assertNoOrphanBodies();
  });

  test("the contrast: the default mode (WEB-09a) drops the unsent draft's overlay display on a mention and removes the finished receipt", async () => {
    const { w, before, unsent } = await scenario(undefined);
    expect(unsent()).not.toBe(before);
    expect(
      (w.rows("drafts") as Array<{ local_id: string }>).map((d) => d.local_id),
    ).toEqual(["unsent"]);
  });
});
