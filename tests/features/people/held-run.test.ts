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
import type { HeldChange } from "../../../src/features/people/field/held-store";
import {
  forgetAllPeopleMemory,
  type HeldRun,
  peopleMemory,
} from "../../../src/features/people/memory";
import {
  expectedBaseOf,
  snapshotOf,
  stillBound,
} from "../../../src/features/people/model/snapshot";
import { cacheRow, draftRow } from "../../support/data/rows";
import { fakeSharingApi, ok } from "../../support/sharing/fake-api";

/**
 * A held change's run (D-11a-12) and an edit's binding. PURE runner tests over doubles: the ownership boundaries (finding 2 of the review of
 * 13 October 2026) and the snapshot binding (finding 1). The screens' composition is in `review-findings.test.tsx`.
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
  ...over,
});

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
  let n = 0;
  const env = {
    sharing,
    newId: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
    memory: peopleMemory("acct:1"),
  } as unknown as PeopleEnv;
  const queued: Array<{ request: EnqueueRequest; command: unknown }> = [];
  let current: CacheRow | null = field();
  let listed = true;
  const run: HeldRun = { holdId: "h", cancelled: false, policyDone: false };
  const persisted: HeldChange[] = [];
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
    listed: () => listed,
    persist: async (change: HeldChange) => {
      persisted.push(structuredClone(change));
    },
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
  return {
    env,
    sharing,
    queued,
    run,
    deps,
    persisted,
    setCurrent: (row: CacheRow | null) => {
      current = row;
    },
    unlist: () => {
      listed = false;
    },
    onBeforeWrite: (hook: () => void) => {
      beforeWrite = hook;
    },
  };
}

describe("runHeldChange: ownership (finding 2)", () => {
  test("control: the audience first, then the content on the CONFIRMED policy version, under the hold's id", async () => {
    const w = world();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    const result = await runHeldChange(w.env, held(), w.run, w.deps);
    expect(result).toEqual({ kind: "done" });
    expect(w.sharing.sent).toHaveLength(1);
    expect(w.queued).toHaveLength(1);
    expect(w.queued[0]?.request.localId).toBe(held().holdId);
    expect(w.queued[0]?.command).toMatchObject({
      command: { expected_version: 4, expected_policy_version: 7 },
    });
  });

  test("discarded while its policy read was on its way: nothing is sent and nothing is queued", async () => {
    const w = world();
    let release!: (value: unknown) => void;
    w.sharing.next.policy.push(
      () =>
        new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        }) as never,
    );
    const running = runHeldChange(w.env, held(), w.run, w.deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    w.run.cancelled = true;
    release(ok({ version: 6, policy: HOME_VIEW }));
    expect(await running).toEqual({ kind: "cancelled", policyDone: false });
    expect(w.sharing.sent).toEqual([]);
    expect(w.queued).toEqual([]);
  });

  test("discarded after its policy change was sent, before it was confirmed: no content, and its attempt is KEPT (it may have been made)", async () => {
    const w = world();
    let release!: (value: unknown) => void;
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      () =>
        new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        }) as never,
    );
    const change = held();
    const running = runHeldChange(w.env, change, w.run, w.deps);
    while (w.sharing.sent.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
    w.run.cancelled = true;
    release(ok({ version: 7, policy: PRIVATE }));
    expect(await running).toEqual({ kind: "cancelled", policyDone: false });
    expect(w.sharing.sent).toHaveLength(1);
    // Never treated as cancelled on the server: the attempt (key and body) survives for a truthful recovery.
    expect(change.attempt).toEqual({
      key: w.sharing.sent[0]?.key,
      body: expect.any(String),
    });
    expect(w.queued).toEqual([]);
  });

  test("discarded at the last moment, inside the content step's transaction: its build refuses and nothing is queued", async () => {
    const w = world();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    w.onBeforeWrite(() => {
      w.run.cancelled = true;
    });
    expect(await runHeldChange(w.env, held(), w.run, w.deps)).toEqual({
      kind: "cancelled",
      policyDone: true,
    });
    expect(w.queued).toEqual([]);
  });

  test("finished or discarded by another page (no longer listed): nothing is sent", async () => {
    const w = world();
    w.unlist();
    expect(await runHeldChange(w.env, held(), w.run, w.deps)).toEqual({
      kind: "cancelled",
      policyDone: false,
    });
    expect(w.sharing.calls).toEqual([]);
  });

  test("its uncertain policy attempt is kept with the hold (persisted), so a retry sends the same key and body", async () => {
    const w = world();
    w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
    w.sharing.next.management.push({ ok: false, kind: "uncertain" } as never);
    const change = held();
    expect(await runHeldChange(w.env, change, w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "uncertain",
    });
    expect(change.attempt).not.toBeNull();
    expect(w.persisted.at(-1)?.attempt).toEqual(change.attempt);
    expect(w.queued).toEqual([]);
  });
});

describe("runHeldChange: binding (finding 1)", () => {
  test("a field already changed when the run begins: nothing is sent (content_changed)", async () => {
    const w = world();
    w.setCurrent(field({ version: 5 }));
    expect(await runHeldChange(w.env, held(), w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "content_changed",
    });
    expect(w.sharing.calls).toEqual([]);
  });

  test("a field changed WHILE the policy step ran: the content is not queued on the newer version", async () => {
    const w = world();
    w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }), () => {
      w.setCurrent(field({ version: 5 }));
      return Promise.resolve(ok({ version: 7, policy: PRIVATE }));
    });
    expect(await runHeldChange(w.env, held(), w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "content_changed",
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
    const change = held({ expectedBase: 3 });
    expect(await runHeldChange(w.env, change, w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "content_changed",
    });
    expect(w.queued).toEqual([]);
  });

  test("a field no longer on this device: gone", async () => {
    const w = world();
    w.setCurrent(null);
    expect(await runHeldChange(w.env, held(), w.run, w.deps)).toEqual({
      kind: "failed",
      reason: "gone",
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
    });
    expect(stillBound(snapshot, field())).toBe(true);
    expect(stillBound(snapshot, field({ version: 5 }))).toBe(false);
    expect(stillBound(snapshot, field({ policy_version: 7 }))).toBe(false);
  });
});
