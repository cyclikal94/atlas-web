// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type {
  CacheRow,
  EnqueueOutcome,
  EnqueueRequest,
  Outbox,
} from "../../../src/data";
import type { PeopleEnv } from "../../../src/features/people/env";
import { runHeldChange } from "../../../src/features/people/field/held";
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
  ...over,
});
const CONTEXT = heldContextOf(P, F);
const HOLD = held().holdId;

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
      attempt: null,
    });
    expect(w.storedHeld()).not.toBeNull();
  });

  test("navigated away (the row unmounted): nothing more is sent", async () => {
    const w = world();
    const shown = await w.hold();
    w.unmount();
    const result = await runHeldChange(w.env, shown, w.run, w.deps);
    expect(result).toMatchObject({ kind: "cancelled", policy: "none" });
    expect(w.sharing.calls).toEqual([]);
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
