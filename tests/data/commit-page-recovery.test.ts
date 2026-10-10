// @vitest-environment node
import { describe, expect, test } from "vitest";
import { reconcileOwedReceipts } from "../../src/data/plans/recovery-writers";
import { pageWorld } from "../support/data/page-world";
import { draftRow, effectRow } from "../support/data/rows";
import { projection, Rng, uuid } from "../support/data/sync-pages";

/**
 * W1 in RECOVERY mode (matrix 3.7.3; R8 of the review of 10 October 2026): a catch-up page applied while the account is fenced is applied
 * exactly like an ordinary page (content, cursor, sequence), and NOTHING of the queue is written: no draft, body or effect row, acknowledged
 * or not. The receipt bookkeeping it skipped is owed (`recovery_reconcile_pending`) and done by W26 as an ordinary write once the account
 * is displayed, for ACKNOWLEDGED drafts only. The same page in the default mode is WEB-09a's behaviour, unchanged (the contrast below).
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

describe("commitPage in recovery mode (matrix 3.7.3, R8)", () => {
  test("the page and its position apply; NOTHING of the queue is written (unsent or acknowledged); the bookkeeping is owed", async () => {
    // ADAPTED (R8 of the review of 10 October 2026). The original assertion (`acked` released, `held_pending_cache: false`, by the recovery
    // commit itself) recorded the P-7 interpretation the review rejected: the approved brief's recovery touches NO draft, `pending_effects`
    // or outbox entry. Its intent (the acknowledged receipt is released against the page) is now asserted after W26, below.
    const queue = (w: Awaited<ReturnType<typeof scenario>>["w"]) =>
      JSON.stringify([
        w.rows("drafts"),
        w.rows("draft_commands"),
        w.rows("pending_effects"),
      ]);
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
    expect(acked).toMatchObject({ held_pending_cache: true });
    expect(w.rows("pending_effects")).toHaveLength(2);
    expect(w.sync().recovery_reconcile_pending).toBe(true);
    const afterRecovery = queue(w);
    w.assertNoOrphanBodies();

    // Once displayed (an ordinary write, W26): the acknowledged receipt is released against the cache; unsent work is still untouched.
    const owed = await w.service.commit(reconcileOwedReceipts, {
      captured: w.capture(),
    });
    expect(owed).toMatchObject({
      kind: "applied",
      value: { kind: "reconciled" },
    });
    expect(queue(w)).not.toBe(afterRecovery);
    expect(unsent()).toBe(before);
    expect(
      (w.rows("drafts") as Array<{ local_id: string }>).map((d) => d.local_id),
    ).toEqual(["unsent"]);
    expect(w.sync().recovery_reconcile_pending).toBe(false);
    w.assertNoOrphanBodies();
  });

  test("W26 owes nothing when nothing is owed, and is refused for another binding (OWN) or an earlier epoch", async () => {
    const { w } = await scenario(undefined);
    const before = w.snapshot();
    expect(
      await w.service.commit(reconcileOwedReceipts, { captured: w.capture() }),
    ).toEqual({ kind: "applied", value: { kind: "none" } });
    w.setSync({ recovery_reconcile_pending: true });
    const owed = w.snapshot();
    expect(
      await w.service.commit(reconcileOwedReceipts, {
        captured: w.capture({ ownershipToken: "another-binding" }),
      }),
    ).toEqual({ kind: "dropped", reason: "owner" });
    w.setSync({ stamp: { epoch: 5 } });
    const stamped = w.snapshot();
    expect(
      await w.service.store.run(reconcileOwedReceipts, {
        captured: w.capture(),
      }),
    ).toEqual({ kind: "dropped", reason: "epoch_superseded" });
    expect(w.snapshot()).toEqual(stamped);
    expect(owed).not.toEqual(before);
  });

  test("the contrast: the default mode (WEB-09a) drops the unsent draft's overlay display on a mention and removes the finished receipt", async () => {
    const { w, before, unsent } = await scenario(undefined);
    expect(unsent()).not.toBe(before);
    expect(
      (w.rows("drafts") as Array<{ local_id: string }>).map((d) => d.local_id),
    ).toEqual(["unsent"]);
  });
});
