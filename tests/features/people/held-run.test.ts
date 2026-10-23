// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type {
  CacheRow,
  EnqueueOutcome,
  EnqueueRequest,
  Outbox,
} from "../../../src/data";
import { createConditionalFormPort } from "../../../src/data/ports/conditional-form";
import type { PeopleEnv } from "../../../src/features/people/env";
import {
  heldAttemptOf,
  holdChange,
  runHeldChange,
  settleHold,
} from "../../../src/features/people/field/held";
import {
  decodeHeld,
  type HeldChange,
  type HeldCopy,
  heldContextOf,
  heldStoreOver,
} from "../../../src/features/people/field/held-store";
import {
  forgetAllPeopleMemory,
  type HeldRun,
  peopleMemory,
} from "../../../src/features/people/memory";
import {
  expectedBaseOf,
  reviewedDraft,
  snapshotOf,
  stillBound,
  successorFollows,
} from "../../../src/features/people/model/snapshot";
import { toWirePolicy } from "../../../src/features/sharing";
import {
  canonicalBody,
  nextAttempt,
} from "../../../src/features/sharing/model/submission";
import { pageWorld } from "../../support/data/page-world";
import { cacheRow, draftRow } from "../../support/data/rows";
import { heldPortDouble } from "../../support/people/held-port";
import { fakeSharingApi, ok } from "../../support/sharing/fake-api";

/**
 * A held change's run (D-11a-12) and an edit's binding. Runner tests over the real held store and a compare-and-set double of its port:
 * the ownership boundaries (finding 2 of the review of 13 October 2026), the durable admission and outcomes (review 2 of 22 October 2026,
 * finding 2) and the snapshot binding (finding 1). The screens' composition is in `review-findings.test.tsx`.
 */
beforeEach(() => forgetAllPeopleMemory());

const P = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const HOME_VIEW = {
  grants: [{ kind: "household" as const, id: "h", edit: false }],
  exclude_accounts: [],
};
const PRIVATE = { grants: [], exclude_accounts: [] };

const held = (over: Partial<HeldChange> = {}): HeldChange => ({
  holdId: "aaaaaaaa-0000-4000-8000-000000000001",
  fieldId: F,
  personId: P,
  label: "Note",
  value: { kind: "text", text: "Secret" },
  sameKind: true,
  version: 4,
  expectedBase: 4,
  from: { version: 6, policy: HOME_VIEW },
  to: PRIVATE,
  attempt: null,
  status: { kind: "waiting" },
  heldAt: "2026-10-13T09:00:00.000Z",
  rev: 0,
  queued: false,
  seq: 0,
  retired: false,
  ...over,
});
const CONTEXT = heldContextOf(P, F);
const HOLD = held().holdId;
const keyOfHeld = () => ({ personId: P, fieldId: F, holdId: HOLD });

const field = (over: Partial<CacheRow> = {}): CacheRow =>
  cacheRow({
    id: F,
    kind: "field",
    parent_id: P,
    version: 4,
    policy_version: 6,
    ...over,
  });

function world() {
  const sharing = fakeSharingApi();
  const store = heldPortDouble();
  let n = 0;
  const env = {
    sharing,
    newId: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
    memory: peopleMemory("acct:1"),
    now: () => Date.parse("2026-10-22T09:00:00.000Z"),
    held: heldStoreOver(store.port, () => "2026-10-22T09:00:00.000Z"),
  } as unknown as PeopleEnv;
  const queued: Array<{ request: EnqueueRequest; command: unknown }> = [];
  let current: CacheRow | null = field();
  let mounted = true;
  const run: HeldRun = { holdId: "h", cancelled: false, policyDone: false };
  /** Called just before the content step's transaction (a hook for the schedules below). */
  let beforeWrite = () => {};
  const outbox = {
    enqueue: async (request: EnqueueRequest): Promise<EnqueueOutcome> => {
      beforeWrite();
      const command = request.build({ [F]: current?.version ?? 0 }).command;
      queued.push({ request, command });
      return { kind: "queued", localId: request.localId ?? "x", createdSeq: 1 };
    },
  } as unknown as Outbox;
  const deps = {
    current: () => current,
    mounted: () => mounted,
    enqueue: async (
      go: (o: Outbox) => Promise<EnqueueOutcome>,
    ): Promise<
      { ok: true; localId: string } | { ok: false; message: string | null }
    > => {
      try {
        const outcome = await go(outbox);
        return outcome.kind === "queued"
          ? { ok: true, localId: outcome.localId }
          : { ok: false, message: "refused" };
      } catch {
        return { ok: false, message: "storage" };
      }
    },
  };
  /** The hold as it is stored now (put through the real held store, as the page that held it did). */
  const hold = async (change = held()): Promise<HeldCopy> => {
    const created = await env.held.create(change);
    if (created.kind !== "saved") throw new Error("not held");
    return created.copy;
  };
  const stored = () => store.rows.get(`${CONTEXT}\u0000${HOLD}`);
  return {
    env,
    sharing,
    store,
    queued,
    run,
    deps,
    hold,
    stored,
    storedHeld: () => {
      const row = stored();
      return row === undefined || row.terminal ? null : decodeHeld(row);
    },
    setCurrent: (row: CacheRow | null) => {
      current = row;
    },
    unmount: () => {
      mounted = false;
    },
    onBeforeWrite: (hook: () => void) => {
      beforeWrite = hook;
    },
  };
}

const pending = () => {
  let release!: (value: unknown) => void;
  const answer = () =>
    new Promise((resolve) => {
      release = resolve as (value: unknown) => void;
    }) as never;
  return { answer, release: (value: unknown) => release(value) };
};
const until = async (condition: () => boolean) => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("runHeldChange: ownership (finding 2)", () => {
  test("control: the audience first, then the content on the CONFIRMED policy version, under the hold's id; the hold then ENDS", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    const result = await runHeldChange(w.env, shown, w.run, w.deps);
    expect(result).toEqual({ kind: "done", ended: true });
    expect(w.sharing.sent).toHaveLength(1);
    expect(w.queued).toHaveLength(1);
    expect(w.queued[0]?.request.localId).toBe(HOLD);
    expect(w.queued[0]?.command).toMatchObject({
      command: { expected_version: 4, expected_policy_version: 7 },
    });
    expect(w.stored()?.terminal).toBe(true);
  });

  test("the EXACT attempt is durable before it is sent (review 2, finding 2): an end after that point knows it may have been made", async () => {
    const w = world();
    const shown = await w.hold();
    let durableAtSend: HeldChange | null = null;
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    w.sharing.next.management.push(() => {
      durableAtSend = w.storedHeld();
      return Promise.resolve(ok({ revision: 1 }));
    });
    await runHeldChange(w.env, shown, w.run, w.deps);
    expect(durableAtSend).not.toBeNull();
    expect((durableAtSend as unknown as HeldChange).attempt?.key).toBe(
      w.sharing.sent[0]?.key,
    );
    // Then the confirmed audience, then the content's admission, written in that order before the content was queued.
    expect(w.store.writes.map((write) => write.rev)).toEqual([0, 1, 2, 3]);
    expect(w.store.writes[2]).toMatchObject({ attempt: null, to: PRIVATE });
    expect(w.store.writes[3]).toMatchObject({ queued: true });
  });

  test("discarded while its policy read was on its way: nothing is sent, nothing is queued, and the hold ENDS", async () => {
    const w = world();
    const shown = await w.hold();
    const read = pending();
    w.sharing.next.policy.push(read.answer);
    const running = runHeldChange(w.env, shown, w.run, w.deps);
    await until(() => w.sharing.calls.length > 0);
    w.run.cancelled = true;
    read.release(ok({ version: 6, policy: HOME_VIEW }));
    expect(await running).toEqual({
      kind: "cancelled",
      policy: "none",
      ended: true,
      retired: false,
      attempt: null,
    });
    expect(w.sharing.sent).toEqual([]);
    expect(w.queued).toEqual([]);
    expect(w.stored()?.terminal).toBe(true);
  });

  test("discarded after its policy change was sent, before it was confirmed: no content, and the attempt is said to MAYBE have been made", async () => {
    const w = world();
    const shown = await w.hold();
    const confirm = pending();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      confirm.answer,
    );
    const running = runHeldChange(w.env, shown, w.run, w.deps);
    await until(() => w.sharing.sent.length > 0 && w.sharing.calls.length > 2);
    w.run.cancelled = true;
    confirm.release(ok({ version: 7, policy: PRIVATE }));
    const result = await running;
    expect(result).toMatchObject({ kind: "cancelled", ended: true });
    // The confirming read was answered (the change was made), or not: never "nothing was sent".
    expect((result as { policy: string }).policy).not.toBe("none");
    expect(w.sharing.sent).toHaveLength(1);
    expect(w.queued).toEqual([]);
  });

  test("discarded at the last moment, inside the content step's transaction: its build refuses, the admission is withdrawn, the hold ends", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    w.onBeforeWrite(() => {
      w.run.cancelled = true;
    });
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "cancelled",
      policy: "done",
      ended: true,
      retired: false,
      attempt: null,
    });
    expect(w.queued).toEqual([]);
    expect(w.store.writes.at(-1)).toMatchObject({ queued: false });
  });

  test("ended by another page before the run read it: nothing is sent (the stored state governs, not the list)", async () => {
    const w = world();
    const shown = await w.hold();
    w.store.endElsewhere(CONTEXT, HOLD);
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "cancelled",
      policy: "none",
      ended: true,
      retired: false,
      attempt: null,
    });
    expect(w.sharing.calls).toEqual([]);
  });

  test("moved on by another page (another stored state than the one shown): stale, nothing is sent", async () => {
    const w = world();
    const shown = await w.hold();
    w.store.changeElsewhere(CONTEXT, HOLD);
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "stale",
    });
    expect(w.sharing.calls).toEqual([]);
  });

  test("another page ENDS it while its policy read is on its way: the attempt's admission is refused and nothing is sent", async () => {
    const w = world();
    const shown = await w.hold();
    const read = pending();
    w.sharing.next.policy.push(read.answer);
    const running = runHeldChange(w.env, shown, w.run, w.deps);
    await until(() => w.sharing.calls.length > 0);
    w.store.endElsewhere(CONTEXT, HOLD);
    read.release(ok({ version: 6, policy: HOME_VIEW }));
    expect(await running).toEqual({
      kind: "cancelled",
      policy: "none",
      ended: true,
      retired: false,
      attempt: null,
    });
    expect(w.sharing.sent).toEqual([]);
    expect(w.queued).toEqual([]);
  });

  test("another page ends it AFTER the attempt was admitted: the change may have been made, and no content is queued", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    w.sharing.next.management.push(() => {
      w.store.endElsewhere(CONTEXT, HOLD);
      return Promise.resolve(ok({ revision: 1 }));
    });
    const result = await runHeldChange(w.env, shown, w.run, w.deps);
    expect(result).toMatchObject({ kind: "cancelled", ended: true });
    expect(w.sharing.sent).toHaveLength(1);
    expect(w.queued).toEqual([]);
  });

  test("its uncertain policy attempt is kept with the hold, so a retry sends the same key and byte-identical body", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
    w.sharing.next.management.push({ ok: false, kind: "uncertain" } as never);
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "uncertain",
      kept: true,
    });
    const kept = w.storedHeld();
    expect(kept?.attempt?.key).toBe(w.sharing.sent[0]?.key);
    expect(kept?.status).toEqual({ kind: "failed", reason: "uncertain" });
    expect(w.queued).toEqual([]);
    // Try again: the same attempt is already durable, so it is sent again as it is (no new key).
    const again = await w.env.held.update(
      { change: kept as HeldChange, digest: w.stored()?.content_digest ?? "" },
      { ...(kept as HeldChange), status: { kind: "waiting" } },
    );
    if (again.kind !== "saved") throw new Error("not saved");
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    const retry: HeldRun = { holdId: "h", cancelled: false, policyDone: false };
    expect(await runHeldChange(w.env, again.copy, retry, w.deps)).toEqual({
      kind: "done",
      ended: true,
    });
    expect(w.sharing.sent[1]?.key).toBe(w.sharing.sent[0]?.key);
  });

  test("a failed write of the attempt sends NOTHING (the store refused or failed): not saved, and only this page says so", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
    w.store.failPuts.push("failed");
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "not_saved",
      kept: false,
    });
    expect(w.sharing.sent).toEqual([]);
  });

  test("a failed write of the CONFIRMED audience queues no content (the next step needs the committed progress)", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    // The attempt's write succeeds; the progress write after the confirmation fails.
    let puts = 0;
    w.store.beforePut(() => {
      puts += 1;
      if (puts === 2) w.store.failPuts.push("failed");
    });
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "not_saved",
      kept: false,
    });
    expect(w.sharing.sent).toHaveLength(1);
    expect(w.queued).toEqual([]);
  });

  test("queued, but the hold's end failed: done, NOT ended (the copy stays, and a repeat is the same save)", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    w.store.failEnds.push("failed");
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "done",
      ended: false,
    });
    expect(w.storedHeld()).toMatchObject({ queued: true, attempt: null });
  });

  test("discarded while it ran, but the end failed: cancelled and NOT ended (the page keeps it visible)", async () => {
    const w = world();
    const shown = await w.hold();
    const read = pending();
    w.sharing.next.policy.push(read.answer);
    const running = runHeldChange(w.env, shown, w.run, w.deps);
    await until(() => w.sharing.calls.length > 0);
    w.run.cancelled = true;
    w.store.failEnds.push("failed");
    read.release(ok({ version: 6, policy: HOME_VIEW }));
    expect(await running).toEqual({
      kind: "cancelled",
      policy: "none",
      ended: false,
      retired: false,
      attempt: null,
    });
    expect(w.storedHeld()).not.toBeNull();
  });

  // Adapted in revision 3 (review 3, finding 1): this case asserted only that nothing more is sent, and expected the hold `cancelled`
  // (ended) while it did so. Leaving the page is not a discard: the run is `suspended` and the hold stays exactly as it was stored.
  test("navigated away (the row unmounted): nothing more is sent", async () => {
    const w = world();
    const shown = await w.hold();
    w.unmount();
    const result = await runHeldChange(w.env, shown, w.run, w.deps);
    expect(result).toEqual({ kind: "suspended" });
    expect(w.sharing.calls).toEqual([]);
    expect(w.stored()?.terminal).toBe(false);
    expect(w.storedHeld()).toEqual(shown.change);
  });
});

describe("runHeldChange: binding (finding 1)", () => {
  test("a field already changed when the run begins: nothing is sent (content_changed)", async () => {
    const w = world();
    const shown = await w.hold();
    w.setCurrent(field({ version: 5 }));
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "content_changed",
      kept: true,
    });
    expect(w.sharing.calls).toEqual([]);
  });

  test("a field changed WHILE the policy step ran: the content is not queued on the newer version", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }), () => {
      w.setCurrent(field({ version: 5 }));
      return Promise.resolve(ok({ version: 7, policy: PRIVATE }));
    });
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "content_changed",
      kept: true,
    });
    expect(w.queued).toEqual([]);
  });

  test("an outbox base that moved since the edit began refuses the content step inside its transaction", async () => {
    const w = world();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    // The record says 5 (another save of this field was queued meanwhile) while the cache still shows 4.
    w.onBeforeWrite(() => w.setCurrent(field({ version: 4 })));
    const shown = await w.hold(held({ expectedBase: 3 }));
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "content_changed",
      kept: true,
    });
    // Nothing was queued, so the admission is withdrawn with the failure.
    expect(w.storedHeld()).toMatchObject({ queued: false });
    expect(w.queued).toEqual([]);
  });

  test("a field no longer on this device: gone", async () => {
    const w = world();
    const shown = await w.hold();
    w.setCurrent(null);
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "gone",
      kept: true,
    });
  });
});

describe("an edit's snapshot (finding 1)", () => {
  test("the expected base is the cached version, or the base of this device's newest save of the row plus one", () => {
    const row = field({ version: 4 });
    expect(expectedBaseOf(row, [])).toBe(4);
    const mine = [
      draftRow({
        local_id: "a",
        created_seq: 1,
        bases: { [F]: 4 },
        bumped: [F],
      }),
      draftRow({
        local_id: "b",
        created_seq: 2,
        bases: { [F]: 5 },
        bumped: [F],
      }),
      draftRow({
        local_id: "c",
        created_seq: 3,
        bases: { other: 9 },
        bumped: ["other"],
      }),
    ];
    expect(expectedBaseOf(row, mine)).toBe(6);
    // Excluding a conflicted save (its contribution is retired by the supersession).
    expect(expectedBaseOf(row, mine, "b")).toBe(5);
  });

  test("bound only while the content AND policy versions are the ones it began on", () => {
    const snapshot = snapshotOf(field(), [], null);
    expect(snapshot).toEqual({
      version: 4,
      policyVersion: 6,
      expectedBase: 4,
      latestLocalId: null,
      latestDigest: null,
    });
    expect(stillBound(snapshot, field())).toBe(true);
    expect(stillBound(snapshot, field({ version: 5 }))).toBe(false);
    expect(stillBound(snapshot, field({ policy_version: 7 }))).toBe(false);
  });

  test("an edit in place replaces only the body it read: same id, status and bases with another digest is refused (review 2, finding 3)", () => {
    const opened = draftRow({
      local_id: "L",
      status: "queued",
      command_digest: "d0",
      bases: { [F]: 4 },
      bumped: [F],
    });
    const snapshot = snapshotOf(field(), [{ ...opened, command: {} }], "L");
    expect(snapshot.latestDigest).toBe("d0");
    const accepts = reviewedDraft(snapshot);
    expect(accepts(opened)).toBe(true);
    // Another page's newer edit of L keeps everything the old checks compared.
    expect(accepts({ ...opened, command_digest: "d1" })).toBe(false);
    expect(accepts({ ...opened, status: "in_flight" })).toBe(false);
    expect(accepts({ ...opened, local_id: "M" })).toBe(false);
    // A save not in the outstanding read when the edit opened cannot be edited in place.
    expect(reviewedDraft(snapshotOf(field(), [], "L"))(opened)).toBe(false);
  });

  test("a new draft follows the reviewed save only while the read shows it with the body the edit read", () => {
    const snapshot = { latestLocalId: "L", latestDigest: "d0" };
    const L = (over = {}) => ({
      ...draftRow({ local_id: "L", command_digest: "d0", ...over }),
      command: {},
    });
    // Sent as it was read (its body is frozen): a successor follows it.
    expect(
      successorFollows("not_queued", snapshot, [L({ status: "in_flight" })]),
    ).toBe(true);
    // Sent after another page changed it, changed in place, retargeted, gone, or not in the read: reviewed again.
    expect(
      successorFollows("not_queued", snapshot, [
        L({ status: "in_flight", command_digest: "d1" }),
      ]),
    ).toBe(false);
    expect(successorFollows("draft_changed", snapshot, [L()])).toBe(false);
    expect(successorFollows("retargeted", snapshot, [L()])).toBe(false);
    expect(successorFollows("not_found", snapshot, [L()])).toBe(false);
    expect(successorFollows(null, snapshot, [])).toBe(false);
    // No in-place edit asked (held for review, audience just changed): the read must still show the reviewed body.
    expect(successorFollows(null, snapshot, [L()])).toBe(true);
    expect(
      successorFollows(null, snapshot, [L({ command_digest: "d1" })]),
    ).toBe(false);
    // Nothing was outstanding when the edit began: the base guard alone decides.
    expect(
      successorFollows(null, { latestLocalId: null, latestDigest: null }, []),
    ).toBe(true);
  });
});

// ---- review 3 of 22 October 2026 (findings 1 and 2; the design assessment's C3a/C3b/C3c, schedules H1-H11) --------------------------

/** The held store over the REAL conditional port and the real W9 plans, on the IndexedDB double (the reviewer's composition). */
async function realHeld(w: ReturnType<typeof world>) {
  const real = await pageWorld();
  const now = () => "2026-10-22T12:00:00.000Z";
  w.env.held = heldStoreOver(
    createConditionalFormPort({ service: () => real.service, now }),
    now,
  );
  return real;
}

/** A field lock as Web Locks' `ifAvailable` answers it: taken while held, null for anyone else meanwhile. */
function locks() {
  const taken = new Set<string>();
  return {
    taken,
    exclusive: async <T>(
      name: string,
      go: () => Promise<T>,
    ): Promise<T | null> => {
      if (taken.has(name)) return null;
      taken.add(name);
      try {
        return await go();
      } finally {
        taken.delete(name);
      }
    },
  };
}

/** A people env for the replacement protocol: the world's store, a lock and the account. */
function holder(w: ReturnType<typeof world>) {
  const lock = locks();
  Object.assign(w.env, { accountId: "acct", exclusive: lock.exclusive });
  return lock;
}

const live = async (w: ReturnType<typeof world>) =>
  ((await w.env.held.list(P, F, null))?.copies ?? []).map(decodeHeld);

const fresh = (holdId: string, text: string) => {
  const {
    seq: _seq,
    retired: _retired,
    attempt: _attempt,
    ...rest
  } = held({
    holdId,
    value: { kind: "text", text },
  });
  return rest;
};

describe("review 3 finding 1: leaving the page is not a discard (H1, H3, H11)", () => {
  for (const leave of ["route", "discard", "stay"] as const)
    test(`real port, the first policy read held: ${leave === "route" ? "navigating away keeps the hold byte for byte and sends nothing" : leave === "discard" ? "control: an explicit Discard at the same moment ends it" : "control: staying on the page runs it once"}`, async () => {
      const w = world();
      await realHeld(w);
      const shown = await w.hold();
      const blocked = pending();
      w.sharing.next.policy.push(
        blocked.answer,
        ok({ version: 7, policy: PRIVATE }),
      );
      const task = runHeldChange(w.env, shown, w.run, w.deps);
      await until(() => w.sharing.calls.length === 1);
      if (leave === "route") w.unmount();
      if (leave === "discard") w.run.cancelled = true;
      blocked.release(ok({ version: 6, policy: HOME_VIEW }));
      const result = await task;
      const stored = await w.env.held.read(keyOfHeld());
      if (leave === "stay") {
        expect(result).toEqual({ kind: "done", ended: true });
        expect(stored.kind).toBe("ended");
        expect(w.queued).toHaveLength(1);
        return;
      }
      expect(w.sharing.sent).toEqual([]);
      expect(w.queued).toEqual([]);
      if (leave === "discard") {
        expect(result).toMatchObject({ kind: "cancelled", ended: true });
        expect(stored.kind).toBe("ended");
        return;
      }
      expect(result).toEqual({ kind: "suspended" });
      expect(stored.kind).toBe("live");
      if (stored.kind !== "live") return;
      // Its input, edit snapshot and audience asked for are exactly the ones held (only its state number moved, with a write of progress).
      const { rev: _a, ...kept } = stored.copy.change;
      const { rev: _b, ...asHeld } = shown.change;
      expect(kept).toEqual(asHeld);
    });

  test("left AFTER its attempt was admitted (while replace_policy was on its way): the attempt stays with the hold, nothing ends", async () => {
    const w = world();
    const shown = await w.hold();
    const sent = pending();
    w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
    w.sharing.next.management.push(sent.answer);
    const task = runHeldChange(w.env, shown, w.run, w.deps);
    await until(() => w.sharing.sent.length === 1);
    w.unmount();
    sent.release(ok({ revision: 1 }));
    expect(await task).toEqual({ kind: "suspended" });
    const kept = w.storedHeld();
    expect(kept?.attempt?.key).toBe(w.sharing.sent[0]?.key);
    expect(kept).toMatchObject({ queued: false, retired: false });
    expect(w.stored()?.terminal).toBe(false);
    expect(w.queued).toEqual([]);
  });

  test("left while its CONFIRMING read was on its way: the progress known so far is written, no content is queued, nothing ends", async () => {
    const w = world();
    const shown = await w.hold();
    const confirm = pending();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      confirm.answer,
    );
    const task = runHeldChange(w.env, shown, w.run, w.deps);
    await until(() => w.sharing.calls.length === 3);
    w.unmount();
    confirm.release(ok({ version: 7, policy: PRIVATE }));
    expect(await task).toEqual({ kind: "suspended" });
    // The confirmation was never applied by a stopped run (`isCurrent`): the attempt is kept as uncertain, never dropped.
    expect(w.storedHeld()?.attempt?.key).toBe(w.sharing.sent[0]?.key);
    expect(w.stored()?.terminal).toBe(false);
    expect(w.queued).toEqual([]);
  });

  test("left inside the content step's transaction: its build refuses, the admission is withdrawn, the hold is kept with its confirmed audience", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    w.onBeforeWrite(() => w.unmount());
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "suspended",
    });
    expect(w.queued).toEqual([]);
    expect(w.storedHeld()).toMatchObject({
      queued: false,
      from: { version: 7, policy: PRIVATE },
      attempt: null,
      value: { kind: "text", text: "Secret" },
    });
  });

  test("after a stop with its audience confirmed, the next run (back on the page) only queues the content, once", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    w.onBeforeWrite(() => w.unmount());
    await runHeldChange(w.env, shown, w.run, w.deps);
    const again = w.storedHeld() as HeldChange;
    const row = w.stored();
    const w2 = { ...w.deps, mounted: () => true };
    w.onBeforeWrite(() => {});
    expect(
      await runHeldChange(
        w.env,
        { change: again, digest: row?.content_digest ?? "" },
        { holdId: HOLD, cancelled: false, policyDone: false },
        w2,
      ),
    ).toEqual({ kind: "done", ended: true });
    expect(w.sharing.sent).toHaveLength(1);
    expect(w.queued).toHaveLength(1);
    expect(w.queued[0]?.command).toMatchObject({
      command: { expected_policy_version: 7 },
    });
  });

  test("another identity is displayed while its policy read is on its way: nothing more is written or sent, the hold is kept", async () => {
    const w = world();
    const shown = await w.hold();
    const read = pending();
    w.sharing.next.policy.push(read.answer);
    const task = runHeldChange(w.env, shown, w.run, w.deps);
    await until(() => w.sharing.calls.length === 1);
    const writes = w.store.writes.length;
    peopleMemory("acct:2");
    read.release(ok({ version: 6, policy: HOME_VIEW }));
    expect(await task).toEqual({ kind: "suspended" });
    expect(w.store.writes).toHaveLength(writes);
    expect(w.sharing.sent).toEqual([]);
    expect(w.storedHeld()).toEqual(shown.change);
  });
});

describe("review 3 finding 2: one current hold per field (H4, H5)", () => {
  test("two pages' saves cannot interleave: while one holds the field's lock the other writes nothing (busy), and the later save replaces the first", async () => {
    const w = world();
    holder(w);
    const gate = pending();
    let paused = false;
    w.store.beforeList(() => {
      paused = true;
    });
    // A is inside its operation (its read of the field's holds is held): B's save finds the lock taken.
    const listing = w.env.held.list.bind(w.env.held);
    let first = true;
    w.env.held = {
      ...w.env.held,
      list: async (...args) => {
        if (first) {
          first = false;
          await gate.answer();
        }
        return listing(...args);
      },
    };
    const a = holdChange(w.env, fresh("hold-a", "First"));
    // A has begun its read of the field's holds (inside its operation).
    await until(() => !first);
    expect(await holdChange(w.env, fresh("hold-b", "Second"))).toEqual({
      kind: "busy",
    });
    expect(w.store.writes).toEqual([]);
    gate.release(undefined);
    expect(await a).toMatchObject({ kind: "held", complete: true });
    expect(await holdChange(w.env, fresh("hold-b", "Second"))).toMatchObject({
      kind: "held",
      complete: true,
    });
    expect((await live(w)).map((h) => [h?.holdId, h?.value, h?.seq])).toEqual([
      ["hold-b", { kind: "text", text: "Second" }, 2],
    ]);
    expect(paused).toBe(true);
  });

  test("control: two saves one after the other keep the second, the first retired from the state it was read in", async () => {
    const w = world();
    holder(w);
    expect((await holdChange(w.env, fresh("hold-a", "First"))).kind).toBe(
      "held",
    );
    expect((await holdChange(w.env, fresh("hold-b", "Second"))).kind).toBe(
      "held",
    );
    expect((await live(w)).map((h) => h?.holdId)).toEqual(["hold-b"]);
    expect(w.env.memory.heldEnded.has("hold-a")).toBe(true);
  });

  test("real port: the reviewer's create A, create B, then each one's cleanup, can no longer erase both (an earlier hold left by a cut-short save is retired by the later one's run, never the reverse)", async () => {
    const w = world();
    await realHeld(w);
    holder(w);
    // A cut-short replacement: B is the field's current hold (generation 2), A (1) is still kept.
    const a = await w.env.held.create(
      held({
        holdId: "hold-a",
        value: { kind: "text", text: "First" },
        seq: 1,
      }),
    );
    const b = await w.env.held.create(
      held({
        holdId: "hold-b",
        value: { kind: "text", text: "Second" },
        seq: 2,
      }),
    );
    if (a.kind !== "saved" || b.kind !== "saved") throw new Error("setup");
    // A's run (a page that still shows A): it is not run; it is retired as B's predecessor.
    expect(
      await runHeldChange(
        w.env,
        a.copy,
        { ...w.run, holdId: "hold-a" },
        w.deps,
      ),
    ).toEqual({ kind: "superseded", ended: true, retired: false });
    expect(w.sharing.calls).toEqual([]);
    // B's run then runs B.
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    expect(
      await runHeldChange(
        w.env,
        b.copy,
        { ...w.run, holdId: "hold-b" },
        w.deps,
      ),
    ).toEqual({ kind: "done", ended: true });
    expect(w.queued.map((q) => q.request.localId)).toEqual(["hold-b"]);
  });

  test("the current hold's run retires an earlier one a closed page left, then runs", async () => {
    const w = world();
    holder(w);
    await w.env.held.create(held({ holdId: "hold-a", seq: 1 }));
    const b = await w.env.held.create(held({ holdId: "hold-b", seq: 2 }));
    if (b.kind !== "saved") throw new Error("setup");
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    expect(
      await runHeldChange(
        w.env,
        b.copy,
        { ...w.run, holdId: "hold-b" },
        w.deps,
      ),
    ).toEqual({ kind: "done", ended: true });
    expect(await live(w)).toEqual([]);
    expect(w.sharing.sent).toHaveLength(1);
  });

  test("a save whose new hold another page ended before its earlier ones were retired retires nothing and says so (changed)", async () => {
    const w = world();
    holder(w);
    expect((await holdChange(w.env, fresh("hold-a", "First"))).kind).toBe(
      "held",
    );
    const reading = w.env.held.read.bind(w.env.held);
    w.env.held = {
      ...w.env.held,
      read: async (key) => {
        if (key.holdId === "hold-b")
          w.store.endElsewhere(heldContextOf(P, F), "hold-b");
        return reading(key);
      },
    };
    expect(await holdChange(w.env, fresh("hold-b", "Second"))).toEqual({
      kind: "changed",
    });
    expect((await live(w)).map((h) => h?.holdId)).toEqual(["hold-a"]);
  });

  test("an earlier hold whose retirement is refused is kept (incomplete, said) and can never run: its run finds a later hold", async () => {
    const w = world();
    holder(w);
    const a = await holdChange(w.env, fresh("hold-a", "First"));
    w.store.failEnds.push("failed");
    expect(await holdChange(w.env, fresh("hold-b", "Second"))).toMatchObject({
      kind: "held",
      complete: false,
    });
    if (a.kind !== "held") throw new Error("setup");
    expect(
      await runHeldChange(
        w.env,
        a.copy,
        { ...w.run, holdId: "hold-a" },
        w.deps,
      ),
    ).toEqual({ kind: "superseded", ended: true, retired: false });
    expect(w.sharing.calls).toEqual([]);
    expect((await live(w)).map((h) => h?.holdId)).toEqual(["hold-b"]);
  });

  test("copies of the first shape (generation 0) are retired by a new hold; an unreadable copy is kept and the save says so", async () => {
    const w = world();
    holder(w);
    await w.env.held.create(held({ holdId: "old-1", seq: 0 }));
    await w.env.held.create(held({ holdId: "old-2", seq: 0 }));
    // A copy this page cannot read (a damaged value), put as another page wrote it.
    w.store.rows.set(`${heldContextOf(P, F)}\u0000unreadable`, {
      form_context: heldContextOf(P, F),
      tab_instance_id: "unreadable",
      fields: { held: "{not json" },
      redacted: [],
      saved_at: "2026-10-22T09:00:00.000Z",
      capture_seq: 0,
      writer_gen: Number.MAX_SAFE_INTEGER,
      terminal: false,
      content_digest: "d-unreadable",
    });
    expect(await holdChange(w.env, fresh("hold-n", "New"))).toMatchObject({
      kind: "held",
      complete: false,
    });
    expect(
      (await w.env.held.list(P, F, null))?.copies.map((r) => r.tab_instance_id),
    ).toEqual(["hold-n", "unreadable"]);
    expect((await live(w)).find((h) => h?.holdId === "hold-n")?.seq).toBe(1);
  });

  test("the field's holds cannot all be read: nothing is kept (failed), the editor keeps the edit", async () => {
    const w = world();
    holder(w);
    w.store.failLists.count = 1;
    expect(await holdChange(w.env, fresh("hold-a", "First"))).toEqual({
      kind: "failed",
      refused: false,
    });
    expect(w.store.writes).toEqual([]);
  });

  test("a run that cannot read its field's holds does not run (it cannot know it is the current one)", async () => {
    const w = world();
    const shown = await w.hold();
    w.store.failLists.count = 1;
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "not_saved",
      kept: false,
    });
    expect(w.sharing.calls).toEqual([]);
  });
});

describe("review 3: an unresolved attempt outlives its content (C3c; H6-H8)", () => {
  // The attempt the runner itself builds for this change (the same key is reused only for a byte-identical body).
  const ATTEMPT = nextAttempt(
    null,
    [
      {
        kind: "replace_policy",
        id: F,
        expected_version: 6,
        policy: toWirePolicy(PRIVATE),
      },
    ],
    () => "k-1",
  );

  test("discarded while its attempt is unresolved: RETIRED (attempt, audience asked for and guard kept, content cleared), never ended", async () => {
    const w = world();
    const shown = await w.hold(held({ attempt: ATTEMPT }));
    const settled = await settleHold(w.env.held, shown);
    expect(settled.kind).toBe("retired");
    expect(w.storedHeld()).toMatchObject({
      retired: true,
      attempt: ATTEMPT,
      to: PRIVATE,
      from: { version: 6 },
      value: { kind: "text", text: "" },
    });
    // A retired hold never runs.
    const row = w.stored();
    expect(
      await runHeldChange(
        w.env,
        {
          change: w.storedHeld() as HeldChange,
          digest: row?.content_digest ?? "",
        },
        w.run,
        w.deps,
      ),
    ).toEqual({ kind: "stale" });
    expect(w.sharing.calls).toEqual([]);
  });

  test("control: a hold with nothing unresolved simply ends; a discarded reconciliation record ends", async () => {
    const w = world();
    const shown = await w.hold();
    expect((await settleHold(w.env.held, shown)).kind).toBe("ended");
    const w2 = world();
    const retired = await w2.hold(held({ attempt: ATTEMPT }));
    const record = await settleHold(w2.env.held, retired);
    if (record.kind !== "retired") throw new Error("setup");
    expect((await settleHold(w2.env.held, record.copy)).kind).toBe("ended");
  });

  test("a new hold of EXACTLY the same change takes the unresolved attempt over (same key and body) and the earlier one ends", async () => {
    const w = world();
    holder(w);
    await w.env.held.create(
      held({ holdId: "hold-a", seq: 1, attempt: ATTEMPT }),
    );
    const b = await holdChange(w.env, fresh("hold-b", "Second"));
    expect(b).toMatchObject({ kind: "held", complete: true });
    expect((await live(w)).map((h) => [h?.holdId, h?.attempt])).toEqual([
      ["hold-b", ATTEMPT],
    ]);
    // Its run retries that exact attempt: the same key, the same body.
    if (b.kind !== "held") throw new Error("setup");
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    await runHeldChange(w.env, b.copy, { ...w.run, holdId: "hold-b" }, w.deps);
    expect(w.sharing.sent.map((s) => s.key)).toEqual([ATTEMPT.key]);
  });

  test("a new hold of ANOTHER change does not take it: the earlier hold is retired, its attempt kept on the device", async () => {
    const w = world();
    holder(w);
    await w.env.held.create(
      held({ holdId: "hold-a", seq: 1, attempt: ATTEMPT }),
    );
    const other = {
      ...fresh("hold-b", "Second"),
      to: HOME_VIEW,
      from: { version: 6, policy: PRIVATE },
    };
    expect(await holdChange(w.env, other)).toMatchObject({
      kind: "held",
      complete: true,
    });
    const kept = await live(w);
    expect(kept.map((h) => [h?.holdId, h?.retired, h?.attempt])).toEqual([
      ["hold-a", true, ATTEMPT],
      ["hold-b", false, null],
    ]);
  });

  test("the attempt is found again after the page forgot everything (a reload), for a direct change of the same audience", async () => {
    const w = world();
    const shown = await w.hold(held({ attempt: ATTEMPT }));
    await settleHold(w.env.held, shown);
    forgetAllPeopleMemory();
    expect(await heldAttemptOf(w.env, P, F, 6, PRIVATE)).toEqual(ATTEMPT);
    expect(await heldAttemptOf(w.env, P, F, 6, HOME_VIEW)).toBeNull();
  });

  test("another page retires it after this run's attempt was admitted: this run is stale and queues nothing (the record keeps the attempt)", async () => {
    const w = world();
    const shown = await w.hold();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    w.sharing.next.management.push(async () => {
      const now = w.storedHeld() as HeldChange;
      await settleHold(w.env.held, {
        change: now,
        digest: w.stored()?.content_digest ?? "",
      });
      return ok({ revision: 1 });
    });
    expect(await runHeldChange(w.env, shown, w.run, w.deps)).toEqual({
      kind: "stale",
    });
    expect(w.queued).toEqual([]);
    expect(w.storedHeld()).toMatchObject({
      retired: true,
      attempt: { key: w.sharing.sent[0]?.key },
    });
  });

  test("H7: a retry of the SAME attempt is not sent when another page ended the hold first (the fast path checks the stored state)", async () => {
    const w = world();
    const shown = await w.hold(held({ attempt: { key: "k-same", body: "" } }));
    // The attempt the retry builds is byte-identical to the kept one only when its body is: build it the way the runner will.
    const first = world();
    const s1 = await first.hold();
    first.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
    first.sharing.next.management.push({
      ok: false,
      kind: "uncertain",
    } as never);
    await runHeldChange(first.env, s1, first.run, first.deps);
    const kept = first.storedHeld() as HeldChange;
    expect(kept.attempt).not.toBeNull();
    const retry = await w.hold({
      ...kept,
      holdId: "hold-r",
      rev: 0,
      status: { kind: "waiting" },
    });
    w.sharing.next.policy.push(() => {
      w.store.endElsewhere(heldContextOf(P, F), "hold-r");
      return Promise.resolve(ok({ version: 6, policy: HOME_VIEW }));
    });
    expect(
      await runHeldChange(w.env, retry, { ...w.run, holdId: "hold-r" }, w.deps),
    ).toMatchObject({ kind: "cancelled", ended: true });
    expect(w.sharing.sent).toEqual([]);
    expect(shown.change.holdId).toBe(HOLD);
  });

  test("H7 control: the same retry with the hold untouched sends the kept key and byte-identical body", async () => {
    const first = world();
    const s1 = await first.hold();
    first.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
    first.sharing.next.management.push({
      ok: false,
      kind: "uncertain",
    } as never);
    await runHeldChange(first.env, s1, first.run, first.deps);
    const kept = first.storedHeld() as HeldChange;
    const w = world();
    const retry = await w.hold({
      ...kept,
      holdId: "hold-r",
      rev: 0,
      status: { kind: "waiting" },
    });
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    await runHeldChange(w.env, retry, { ...w.run, holdId: "hold-r" }, w.deps);
    expect(w.sharing.sent).toHaveLength(1);
    expect(w.sharing.sent[0]?.key).toBe(kept.attempt?.key);
    expect(canonicalBody(w.sharing.sent[0]?.commands)).toBe(kept.attempt?.body);
  });
});
