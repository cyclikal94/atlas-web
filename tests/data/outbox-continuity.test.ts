// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import {
  type EnqueueRequest,
  OutboxRequestError,
  snapshotRequest,
  type TargetSpec,
  validateRequest,
} from "../../src/data/model/outbox";
import { setDraftFence } from "../../src/data/plans/fence";
import { enqueueDraft } from "../../src/data/plans/outbox";
import { outboxWorld } from "../support/data/outbox-world";
import { ACCOUNT } from "../support/data/page-world";
import { cacheRow } from "../support/data/rows";

/**
 * WEB-13b revision 9 (review 9 R7c; design assessment C2, invariant 6; schedule T5; MORNING-TASK-APPROVALS-20261028, the narrow
 * import-only assignment): `EnqueueRequest.continuity`, the content-free precondition of the cache's HISTORY a kept import was verified
 * against. W2 compares it with the singleton IN ITS OWN TRANSACTION, on every attempt (a fence's retry included), after the duplicate is
 * recognised and before anything new is written: an invalidation committed before the enqueue's transaction refuses it (`expired`,
 * nothing written); a save admitted before the invalidation stays queued, and a retry of it is still recognised. Through the PRODUCTION
 * plans and facade over the double of IndexedDB; the peer's invalidation is a committed write of the witness between two steps.
 */
const primary = (id: string): TargetSpec => ({
  resourceId: id,
  role: "primary",
  basis: "resource",
  versionChecked: false,
  seedIfUntracked: 1,
  requiresEdit: true,
});
const request = (
  continuity: EnqueueRequest["continuity"],
  localId?: string,
): EnqueueRequest => ({
  endpoint: "/calendar-sources/{id}/import",
  targetId: "r",
  targets: [primary("r")],
  build: () => ({
    command: { ics: "BEGIN:VCALENDAR", from: "a", through: "b" },
  }),
  ...(localId === undefined ? {} : { localId }),
  ...(continuity === undefined ? {} : { continuity }),
});

async function setup() {
  const w = await outboxWorld();
  w.put("cache", [cacheRow({ id: "r", version: 5, can_edit: true })]);
  const inc = w.service.incarnationId;
  const at = (invalidations: number) => ({ incarnationId: inc, invalidations });
  /** W2 directly, as the facade runs it. */
  const run = (req: EnqueueRequest, localId: string) =>
    w.service.store.run(enqueueDraft, {
      incarnationId: inc,
      request: req,
      localId,
      accountId: ACCOUNT,
      now: "2026-10-28T10:00:00.000Z",
    });
  /** What a committed invalidation (W18) leaves of the witness, written by another page. */
  const invalidated = () =>
    w.setSync({
      cache_invalidation_seq: (w.sync().cache_invalidation_seq ?? 0) + 1,
    });
  /** Everything the enqueue could have written. */
  const written = () => ({
    drafts: w.rows("drafts").length,
    bodies: w.rows("draft_commands").length,
    versions: w.rows("resource_versions").length,
  });
  return { w, inc, at, run, invalidated, written };
}

describe("W2 compares the stated history in its own transaction", () => {
  test("the same incarnation and witness: written (control)", async () => {
    const { run, at, written } = await setup();
    expect(await run(request(at(0)), "a")).toMatchObject({ kind: "queued" });
    expect(written().drafts).toBe(1);
  });

  test("an invalidation committed before the transaction: refused `expired`, nothing written", async () => {
    const { run, at, invalidated, written } = await setup();
    const before = written();
    invalidated();
    expect(await run(request(at(0)), "a")).toEqual({
      kind: "refused",
      reason: "expired",
    });
    expect(written()).toEqual(before);
  });

  test("another incarnation named, or a witness the singleton cannot establish: refused `expired`, nothing written", async () => {
    const { w, run, at, inc, written } = await setup();
    const before = written();
    expect(
      await run(
        request({ incarnationId: `${inc}-other`, invalidations: 0 }),
        "a",
      ),
    ).toEqual({ kind: "refused", reason: "expired" });
    w.setSync({ cache_invalidation_seq: -1 as never });
    expect(await run(request(at(0)), "b")).toEqual({
      kind: "refused",
      reason: "expired",
    });
    expect(written()).toEqual(before);
  });

  test("a request that states no history is written whatever the witness (other callers keep their behaviour)", async () => {
    const { run, invalidated, written } = await setup();
    invalidated();
    expect(await run(request(undefined), "a")).toMatchObject({
      kind: "queued",
    });
    expect(written().drafts).toBe(1);
  });

  test("admitted BEFORE the invalidation: it stays queued, and a retry of the same save is still recognised (no second draft)", async () => {
    const { run, at, invalidated, written } = await setup();
    expect(await run(request(at(0), "save-1"), "save-1")).toMatchObject({
      kind: "queued",
      duplicate: false,
    });
    invalidated();
    expect(await run(request(at(0), "save-1"), "save-1")).toMatchObject({
      kind: "queued",
      duplicate: true,
    });
    expect(written().drafts).toBe(1);
  });
});

describe("the facade: every attempt compares the history captured when the request was made", () => {
  test("T5: verified, then another page's invalidation commits before the enqueue's transaction: refused `expired`; control without it queues once", async () => {
    for (const peer of [false, true]) {
      const { w, at, invalidated, written } = await setup();
      const real = w.service.store.run.bind(w.service.store);
      vi.spyOn(w.service.store, "run").mockImplementation(((
        plan: { name: string },
        ...rest: unknown[]
      ) => {
        // Between the person's press (the request made) and the writing transaction.
        if (plan.name === "data.enqueueDraft" && peer) invalidated();
        return (real as (...args: unknown[]) => unknown)(plan, ...rest);
      }) as never);
      const outcome = await w.outbox.enqueue(request(at(0)));
      if (peer) {
        expect(outcome).toEqual({ kind: "refused", reason: "expired" });
        expect(written()).toEqual({ drafts: 0, bodies: 0, versions: 0 });
      } else {
        expect(outcome).toMatchObject({ kind: "queued" });
        expect(written().drafts).toBe(1);
      }
      vi.restoreAllMocks();
    }
  });

  test("a fence's retry compares it again: an invalidation committed between the fenced attempt and the retry refuses it; control queues", async () => {
    for (const peer of [false, true]) {
      const { w, inc, at, invalidated, written } = await setup();
      // A fence left by an operation that never finished, old enough to be reconciled: the first attempt is refused `fenced`.
      await w.service.store.run(setDraftFence, {
        incarnationId: inc,
        now: 0,
        token: "t",
        operationId: "op-1",
      });
      const real = w.service.store.run.bind(w.service.store);
      const attempts: string[] = [];
      vi.spyOn(w.service.store, "run").mockImplementation((async (
        plan: { name: string },
        ...rest: unknown[]
      ) => {
        const out = await (real as (...args: unknown[]) => Promise<unknown>)(
          plan,
          ...rest,
        );
        if (plan.name === "data.enqueueDraft")
          attempts.push((out as { reason?: string }).reason ?? "queued");
        if (plan.name === "data.reconcileStaleFence" && peer) invalidated();
        return out;
      }) as never);
      const outcome = await w.outbox.enqueue(request(at(0)));
      expect(attempts[0]).toBe("fenced");
      expect(attempts).toHaveLength(2);
      if (peer) {
        expect(outcome).toEqual({ kind: "refused", reason: "expired" });
        expect(written().drafts).toBe(0);
      } else {
        expect(outcome).toMatchObject({ kind: "queued" });
        expect(written().drafts).toBe(1);
      }
      vi.restoreAllMocks();
    }
  });

  test("the history is the request's as made: a caller changing its object afterwards changes nothing (snapshot)", async () => {
    const { w, at, written } = await setup();
    const given = request(at(0));
    const real = w.service.store.run.bind(w.service.store);
    vi.spyOn(w.service.store, "run").mockImplementation(((
      plan: { name: string },
      ...rest: unknown[]
    ) => {
      // The caller's object is changed after the facade took it: what it compares must not follow.
      if (plan.name === "data.enqueueDraft")
        (given.continuity as { invalidations: number }).invalidations = 7;
      return (real as (...args: unknown[]) => unknown)(plan, ...rest);
    }) as never);
    expect(await w.outbox.enqueue(given)).toMatchObject({ kind: "queued" });
    expect(written().drafts).toBe(1);
    vi.restoreAllMocks();
  });
});

describe("the request's shape", () => {
  test("a malformed history is the caller's mistake (OutboxRequestError `continuity`); snapshotRequest copies it", () => {
    for (const continuity of [
      { incarnationId: "", invalidations: 0 },
      { incarnationId: "i", invalidations: -1 },
      { incarnationId: "i", invalidations: 1.5 },
      { incarnationId: 3 as unknown as string, invalidations: 0 },
    ]) {
      const error = (() => {
        try {
          validateRequest(request(continuity));
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(OutboxRequestError);
      expect((error as OutboxRequestError).reason).toBe("continuity");
    }
    const given = request({ incarnationId: "i", invalidations: 2 });
    const copy = snapshotRequest(given);
    expect(copy.continuity).toEqual({ incarnationId: "i", invalidations: 2 });
    expect(copy.continuity).not.toBe(given.continuity);
    expect(() => validateRequest(copy)).not.toThrow();
  });
});
