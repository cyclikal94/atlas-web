// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { mergeResource } from "../../src/data/model/overlay";
import type { CommitPageInput } from "../../src/data/plans/commit-page";
import { stageDeltaSegment } from "../../src/data/plans/delta-segments";
import { admitReceipt, markInFlight } from "../../src/data/plans/outbox";
import { reconcileOwedReceipts } from "../../src/data/plans/recovery-writers";
import { scanSyncPage } from "../../src/data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../src/data/scan/validate";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";
import { bytesOf, type Change, uuid } from "../support/data/sync-pages";

/**
 * U11 (WEB-09c, R20-SEG of the review of 28 October 2026): local work that arrives WHILE a revision is staged. Through the PRODUCTION
 * enqueue (W2), claim (W5 `markInFlight`), receipt (`admitReceipt`), W27 and W1 over the double of IndexedDB.
 *
 * The activation moves words into the cache that earlier requests delivered. A staged word is evidence only about a candidate that existed
 * when its request was captured: the claim's `request_seq` against the word's, strictly (`stagedMentionReaches`). Before the correction,
 * every staged word was taken as a present-moment mention, so an edit acknowledged between two segments lost its overlay, its held flag and
 * then its draft over the OLDER content (the first test below). The controls are the ordinary pages, a fresh word of the final segment, a
 * fresh word of a LATER segment, and local work claimed before a piece's request was captured: all release exactly as an ordinary page does.
 * The recovery job's catch-up (recovery mode, then W26) is the last group. A model of the store, not a real engine:
 * `fixture.data-segmented.spec.ts` N5 and N6 run the schedule natively.
 */

const A = uuid(1);
const SEGMENTED = { ...DATA_CONFIG, allowSegment: true };
const decode = {
  validators: createValueValidators(),
  derivers: createKeyDerivers(),
};

const resource = (id: string, label: string, version: number) => ({
  id,
  kind: "person",
  parent_id: null,
  label,
  value: null,
  version,
  can_edit: true,
  archived: false,
  policy_version: 1,
});
const upsert = (id: string, label: string, version: number): Change => ({
  kind: "upsert",
  resource: resource(id, label, version),
});
const remove = (id: string): Change => ({ kind: "remove", id });
/** Changes of other resources, to give a piece the contract's minimum of four. */
const others = (from: number, n: number): Change[] =>
  Array.from({ length: n }, (_, i) => upsert(uuid(from + i), "other", 1));

interface Piece {
  revision: number;
  changes: Change[];
  segment?: { index: number; last: boolean };
  hasMore: boolean;
  nextCursor: string;
}

/**
 * A request captured the way W19 captures one (`request_seq` incremented, then the capture carries it), and its answer as a commit input.
 * The order of `request_seq` against the claim and the receipt is the whole point of these schedules, so every request goes through here.
 */
function request(w: OutboxWorld, piece: Piece): CommitPageInput {
  w.setSync({ request_seq: w.sync().request_seq + 1 });
  const bytes = bytesOf(
    JSON.stringify({
      phase: "delta",
      batches: [
        {
          revision: piece.revision,
          changes: piece.changes,
          ...(piece.segment ? { segment: piece.segment } : {}),
        },
      ],
      next_cursor: piece.nextCursor,
      has_more: piece.hasMore,
    }),
  );
  const scan = scanSyncPage(bytes, SEGMENTED);
  if (!scan.ok) throw new Error(`the test page does not scan: ${scan.reason}`);
  return {
    captured: w.capture(),
    bytes,
    scan,
    now: "2026-10-28T12:00:00.000Z",
    decode,
  };
}

/** A captured answer applied: staged when it is a non-final segment (W27), committed otherwise (W1). */
async function apply(w: OutboxWorld, input: CommitPageInput): Promise<string> {
  const batch = input.scan.batches[0];
  const out =
    batch?.segment !== undefined && !batch.segment.last
      ? await w.service.commit(stageDeltaSegment, {
          captured: input.captured,
          bytes: input.bytes,
          scan: input.scan,
          now: 1_000,
          decode,
        })
      : await w.commit(input);
  if (out.kind !== "applied") throw new Error(`not applied: ${out.kind}`);
  return (out.value as { kind: string }).kind;
}

const deliver = async (w: OutboxWorld, piece: Piece): Promise<string> =>
  apply(w, request(w, piece));

const seg = (
  index: number,
  last: boolean,
  changes: Change[],
  hasMore = true,
  revision = 10,
): Piece => ({
  revision,
  changes,
  segment: { index, last },
  hasMore,
  nextCursor: last ? `c${index + 1}` : `cont-${index}`,
});

const edit = (label: string): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [
    { resourceId: A, role: "primary", basis: "resource", versionChecked: true },
  ],
  build: (bases) => ({
    command: { kind: "edit", id: A, base: bases[A] as number, label },
    displayPatch: { [A]: { label } },
  }),
});

/** The person's edit of A: enqueued through the facade, then (each separately, so a schedule can put a piece between them) claimed and receipted. */
async function enqueueEdit(w: OutboxWorld, label = "new"): Promise<string> {
  const out = await w.outbox.enqueue(edit(label));
  if (out.kind !== "queued") throw new Error(`enqueue: ${out.kind}`);
  return out.localId;
}
async function claim(w: OutboxWorld, localId: string): Promise<void> {
  const out = await w.service.commit(markInFlight, {
    captured: w.capture(),
    localId,
  });
  expect(out).toMatchObject({ kind: "applied", value: { kind: "claimed" } });
}
async function receipt(
  w: OutboxWorld,
  localId: string,
  revision: number,
): Promise<{ displayed: number }> {
  const out = await w.service.commit(admitReceipt, {
    captured: w.capture(),
    localId,
    revision,
  });
  if (out.kind !== "applied") throw new Error(`receipt: ${out.kind}`);
  return out.value as { displayed: number };
}

/** A world whose live cache holds A at version 1 ("old"): the previous complete revision. */
async function world(): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.put("cache", [cacheRow({ id: A, label: "old", version: 1 })]);
  return w;
}

/** What the person sees of A: the cached row with every overlay over it (`mergeResource`, as a view composes it); null when A is not held. */
const seen = (w: OutboxWorld): string | null => {
  const base = w.cache().find((row) => row.id === A) ?? null;
  return (
    mergeResource(
      base,
      w.effects().filter((row) => row.resource_id === A),
    ).merged?.label ?? null
  );
};
const cached = (w: OutboxWorld) => w.cache().find((row) => row.id === A);

/** The edit is retained, acknowledged, with its overlay shown over whatever the cache holds. */
function expectRetained(w: OutboxWorld, localId: string): void {
  expect(w.drafts()).toMatchObject([
    { local_id: localId, status: "acknowledged", held_pending_cache: false },
  ]);
  expect(w.effects()).toMatchObject([
    {
      resource_id: A,
      local_id: localId,
      display: { label: "new" },
      last_mentioned_page_seq: null,
      resolved: null,
    },
  ]);
}
/** The edit is released: no draft, no effect row. */
function expectReleased(w: OutboxWorld): void {
  expect(w.drafts()).toEqual([]);
  expect(w.effects()).toEqual([]);
}

describe("U11: an edit made while a revision is staged keeps its receipt state until content that can reflect it arrives (R20-SEG)", () => {
  test("the review's schedule: an edit acknowledged BETWEEN two segments keeps its overlay and draft over the older staged content", async () => {
    const w = await world();
    expect(
      await deliver(w, seg(0, false, [upsert(A, "old", 1), ...others(10, 3)])),
    ).toBe("staged");
    const id = await enqueueEdit(w);
    await claim(w, id);
    expect(await receipt(w, id, 11)).toMatchObject({ displayed: 1 });
    // The rest of revision 10 does not name A; `has_more` announces revision 11, not yet fetched.
    expect(await deliver(w, seg(1, true, others(20, 4)))).toBe("committed");

    expect(w.sync()).toMatchObject({ applied_revision: 10, delta_stage: null });
    expect(w.rows("delta_staging" as never)).toEqual([]);
    expect(cached(w)).toMatchObject({ label: "old", version: 1 });
    expectRetained(w, id);
    expect(seen(w)).toBe("new");
    // The same claim's witness is the boundary: the staged word's request was captured BEFORE it.
    const word = w.effects()[0];
    expect(word?.submitted_at_request_seq).toBe(1);

    // Revision 11, the edit's own publication, then releases it over the new content, as any page does.
    expect(
      await deliver(w, {
        revision: 11,
        changes: [upsert(A, "new", 2)],
        hasMore: false,
        nextCursor: "c3",
      }),
    ).toBe("committed");
    expectReleased(w);
    expect(cached(w)).toMatchObject({ label: "new", version: 2 });
    expect(seen(w)).toBe("new");
  });

  test("an edit CLAIMED between segments and receipted only AFTER the activation is shown: the staged word did not mark it", async () => {
    const w = await world();
    await deliver(w, seg(0, false, [upsert(A, "old", 1), ...others(10, 3)]));
    const id = await enqueueEdit(w);
    await claim(w, id);
    expect(await deliver(w, seg(1, true, others(20, 4)))).toBe("committed");
    // Not mentioned: the receipt finds an open candidate and shows the overlay.
    expect(w.effects()[0]).toMatchObject({ last_mentioned_page_seq: null });
    expect(await receipt(w, id, 11)).toMatchObject({ displayed: 1 });
    expectRetained(w, id);
    expect(seen(w)).toBe("new");
  });

  test("an edit ENQUEUED between segments and claimed after the activation is shown too (no candidate existed for the staged word)", async () => {
    const w = await world();
    await deliver(w, seg(0, false, [upsert(A, "old", 1), ...others(10, 3)]));
    const id = await enqueueEdit(w);
    await deliver(w, seg(1, true, others(20, 4)));
    await claim(w, id);
    expect(await receipt(w, id, 11)).toMatchObject({ displayed: 1 });
    expectRetained(w, id);
  });

  test("a staged REMOVAL older than the edit retires nothing: the overlay is kept (and shows nothing without a cached row); the live edge resolves it", async () => {
    const w = await world();
    await deliver(w, seg(0, false, [remove(A), ...others(10, 3)]));
    const id = await enqueueEdit(w);
    await claim(w, id);
    await receipt(w, id, 11);
    await deliver(w, seg(1, true, others(20, 4)));
    expect(cached(w)).toBeUndefined();
    expectRetained(w, id);
    // An overlay is a patch over a cached row: with none, nothing is shown, never a row made of the patch alone.
    expect(seen(w)).toBeNull();
    // The live edge, captured after the receipt and naming nothing of A, is the proof that nothing will publish it.
    expect(
      await deliver(w, {
        revision: 12,
        changes: others(30, 1),
        hasMore: false,
        nextCursor: "c3",
      }),
    ).toBe("committed");
    expectReleased(w);
  });

  test("an ineligible staged word leaves A unnamed for the edit, so a final segment at the live edge resolves it exactly as an ordinary page would", async () => {
    const w = await world();
    await deliver(w, seg(0, false, [upsert(A, "old", 1), ...others(10, 3)]));
    const id = await enqueueEdit(w);
    await claim(w, id);
    await receipt(w, id, 11);
    // has_more: false, and the request was captured after the receipt: the server says nothing will publish A to this account.
    expect(await deliver(w, seg(1, true, others(20, 4), false))).toBe(
      "committed",
    );
    expectReleased(w);
    expect(cached(w)).toMatchObject({ label: "old" });

    // Control: ordinary pages (revision 9 before the edit, revision 10 after it, at the live edge) give the same cache and local work.
    const o = await world();
    await deliver(o, {
      revision: 9,
      changes: [upsert(A, "old", 1), ...others(10, 3)],
      hasMore: true,
      nextCursor: "c1",
    });
    const oid = await enqueueEdit(o);
    await claim(o, oid);
    await receipt(o, oid, 11);
    await deliver(o, {
      revision: 10,
      changes: others(20, 4),
      hasMore: false,
      nextCursor: "c2",
    });
    expectReleased(o);
    expect(o.cache()).toEqual(w.cache());
  });
});

describe("U11 controls: words that CAN reflect the edit release it, as an ordinary page does", () => {
  test("control: ordinary pages (revision 10 before the edit, revision 11 after it, not naming A) keep the receipt", async () => {
    const w = await world();
    await deliver(w, {
      revision: 10,
      changes: [upsert(A, "old", 1), ...others(10, 3)],
      hasMore: true,
      nextCursor: "c1",
    });
    const id = await enqueueEdit(w);
    await claim(w, id);
    await receipt(w, id, 12);
    await deliver(w, {
      revision: 11,
      changes: others(20, 4),
      hasMore: true,
      nextCursor: "c2",
    });
    expectRetained(w, id);
    expect(seen(w)).toBe("new");
  });

  test("control: a fresh word of the FINAL segment releases the edit over the updated content", async () => {
    const w = await world();
    await deliver(w, seg(0, false, [upsert(A, "old", 1), ...others(10, 3)]));
    const id = await enqueueEdit(w);
    await claim(w, id);
    await receipt(w, id, 11);
    await deliver(w, seg(1, true, [upsert(A, "new", 2), ...others(20, 3)]));
    expectReleased(w);
    expect(cached(w)).toMatchObject({ label: "new", version: 2 });
  });

  test("control: a fresh word of a LATER staged segment replaces the older one, and its request (after the claim) releases the edit", async () => {
    const w = await world();
    await deliver(w, seg(0, false, [upsert(A, "old", 1), ...others(10, 3)]));
    const id = await enqueueEdit(w);
    await claim(w, id);
    await receipt(w, id, 11);
    expect(
      await deliver(w, seg(1, false, [upsert(A, "new", 2), ...others(20, 3)])),
    ).toBe("staged");
    // The last word per id carries the request it came from: the later one.
    const staged = w.rows("delta_staging" as never) as Array<{
      id: string;
      request_seq: number;
    }>;
    expect(staged.find((row) => row.id === A)?.request_seq).toBe(
      w.sync().request_seq,
    );
    await deliver(w, seg(2, true, others(30, 4)));
    expectReleased(w);
    expect(cached(w)).toMatchObject({ label: "new", version: 2 });
  });

  test("control: local work claimed BEFORE the revision's first request is released by a staged word, as by the whole batch", async () => {
    const run = async (segmented: boolean) => {
      const w = await world();
      const id = await enqueueEdit(w);
      await claim(w, id);
      await receipt(w, id, 9);
      const changes = [
        upsert(A, "current", 3),
        ...others(10, 3),
        ...others(20, 4),
      ];
      if (segmented) {
        await deliver(w, seg(0, false, changes.slice(0, 4)));
        await deliver(w, seg(1, true, changes.slice(4)));
      } else
        await deliver(w, {
          revision: 10,
          changes,
          hasMore: true,
          nextCursor: "c2",
        });
      return w;
    };
    const segmented = await run(true);
    const whole = await run(false);
    expectReleased(segmented);
    expect(cached(segmented)).toMatchObject({ label: "current", version: 3 });
    expect(segmented.cache()).toEqual(whole.cache());
    expect(segmented.drafts()).toEqual(whole.drafts());
    expect(segmented.effects()).toEqual(whole.effects());
  });

  test("control: a claim made after the first request is CAPTURED but whose receipt arrives between pieces is released, as an ordinary page captured after the claim is", async () => {
    // The ordinary-page semantics (WEB-04 §5.4): a page whose request was captured after the claim is the account's view for the ids it
    // names. The staged word is judged at its capture, so it is held to exactly that, never to the time it is activated.
    const run = async (segmented: boolean) => {
      const w = await world();
      const id = await enqueueEdit(w);
      await claim(w, id);
      const first = request(
        w,
        segmented
          ? seg(0, false, [upsert(A, "old", 1), ...others(10, 3)])
          : {
              revision: 9,
              changes: [upsert(A, "old", 1), ...others(10, 3)],
              hasMore: true,
              nextCursor: "c1",
            },
      );
      await apply(w, first);
      await receipt(w, id, 11);
      await deliver(
        w,
        segmented
          ? seg(1, true, others(20, 4))
          : {
              revision: 10,
              changes: others(20, 4),
              hasMore: true,
              nextCursor: "c2",
            },
      );
      return w;
    };
    const segmented = await run(true);
    const whole = await run(false);
    expectReleased(segmented);
    expect(segmented.effects()).toEqual(whole.effects());
    expect(segmented.drafts()).toEqual(whole.drafts());
    expect(segmented.cache()).toEqual(whole.cache());
  });
});

describe("U11 recovery: a staged revision activated by the recovery job's catch-up owes its receipt bookkeeping to W26", () => {
  /** The review's schedule, with the final segment applied in RECOVERY mode (the fenced catch-up) and the owed reconciliation after it. */
  async function caughtUp(order: "between" | "before") {
    const w = await world();
    let id = "";
    const edited = async (revision: number) => {
      id = await enqueueEdit(w);
      await claim(w, id);
      await receipt(w, id, revision);
    };
    // "before": the edit committed at revision 9, before revision 10 existed, so revision 10's pieces carry it. "between": the review's
    // schedule, the edit receipted at 11 after the older piece was received.
    if (order === "before") await edited(9);
    await deliver(
      w,
      seg(0, false, [
        upsert(
          A,
          order === "before" ? "new" : "old",
          order === "before" ? 2 : 1,
        ),
        ...others(10, 3),
      ]),
    );
    if (order === "between") await edited(11);
    const final = await w.commit({
      ...request(w, seg(1, true, others(20, 4))),
      mode: "recovery",
    });
    expect(final).toMatchObject({
      kind: "applied",
      value: { kind: "committed" },
    });
    // Recovery mode touches no local work at all: the overlay stands, and the bookkeeping is owed.
    expectRetained(w, id);
    expect(w.sync()).toMatchObject({
      applied_revision: 10,
      recovery_reconcile_pending: true,
    });
    const owed = await w.service.commit(reconcileOwedReceipts, {
      captured: w.capture(),
    });
    expect(owed).toMatchObject({
      kind: "applied",
      value: { kind: "reconciled" },
    });
    return { w, id };
  }

  test("a receipt NEWER than the activated revision is not covered by it: the overlay and draft stay", async () => {
    const { w, id } = await caughtUp("between");
    expectRetained(w, id);
    expect(seen(w)).toBe("new");
  });

  test("control: a receipt at or below the activated revision is covered (its command committed before any piece was generated) and released", async () => {
    // Revision 10's pieces were generated after revision 9 existed, so A's word in them reflects an edit receipted at 9.
    const { w } = await caughtUp("before");
    expectReleased(w);
    expect(cached(w)).toMatchObject({ label: "new" });
  });
});

describe("U11 rows without the claim's witness (written before it): the receipt's floor stands in, later than the claim and so only stricter", () => {
  /** A staged piece naming A, then an acknowledged row and draft written as an older build wrote them (no `submitted_at_request_seq`). */
  async function legacy(floor: number) {
    const w = await world();
    w.setSync({ request_seq: 3 });
    w.put("drafts", [
      draftRow({
        local_id: "legacy",
        account_id: w.service.account,
        status: "acknowledged",
        index_targets: [A],
        receipt_revision: 9,
        command: { kind: "edit", id: A, label: "new" },
      }),
    ]);
    w.put("pending_effects", [
      effectRow({
        resource_id: A,
        local_id: "legacy",
        display: { label: "new" },
        no_publication_floor: floor,
        receipt_revision: 9,
      }),
    ]);
    // Request 4 carries the first piece, request 5 the final one (`has_more`: not the live edge).
    await deliver(
      w,
      seg(0, false, [upsert(A, "current", 2), ...others(10, 3)]),
    );
    await deliver(w, seg(1, true, others(20, 4)));
    return w;
  }

  test("a receipt recorded BEFORE the piece's request was captured: the staged word reaches the row and releases it", async () => {
    const w = await legacy(3);
    expectReleased(w);
    expect(cached(w)).toMatchObject({ label: "current", version: 2 });
  });

  test("a receipt recorded while the piece's request was in flight (the review's probe): the row and its draft are kept", async () => {
    const w = await legacy(4);
    expect(w.drafts()).toMatchObject([{ local_id: "legacy" }]);
    expect(w.effects()).toMatchObject([
      { display: { label: "new" }, last_mentioned_page_seq: null },
    ]);
  });
});
