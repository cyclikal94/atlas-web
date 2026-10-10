// @vitest-environment node
import { describe, expect, test } from "vitest";
import { NO_CONSENT_DIGEST } from "../../src/data/model/local-work";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { SyncStateRow } from "../../src/data/model/types";
import {
  readBaseline,
  reconcileStaleFence,
  releaseFence,
  setClosing,
  setDraftFence,
  summariseWork,
} from "../../src/data/plans/fence";
import type { AccountStore } from "../../src/data/store/port";
import { putPlan } from "../../src/fixture/data-harness/conformance";
import { DataTestWorld } from "../support/data/env";
import {
  cacheRow,
  draftRow,
  effectRow,
  recoveryRow,
} from "../support/data/rows";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const env = new DataTestWorld();
  env.idb.autoDrive = true;
  const page = env.page("A");
  page.identity.account = ACCOUNT;
  const opened = await page.open(ACCOUNT, { create: true });
  if (opened.kind !== "opened") throw new Error("setup");
  const store: AccountStore = opened.store;
  const inc = store.incarnationId;
  const sync = () =>
    env.idb.peek(
      accountDatabaseName(ACCOUNT),
      "sync_state",
      "singleton",
    ) as SyncStateRow;
  return { env, store, inc, sync };
}

describe("F-W3: the draft fence (decision D-06)", () => {
  test("setDraftFence computes the consent digest INSIDE its own transaction and records the operation", async () => {
    const { store, inc, sync } = await setup();
    await store.run(putPlan("drafts"), [
      draftRow({ status: "queued" }),
      draftRow({ status: "in_flight" }),
    ]);
    await store.run(putPlan("form_recovery"), [recoveryRow()]);
    const summary = await store.run(summariseWork, { incarnationId: inc });
    const set = await store.run(setDraftFence, {
      incarnationId: inc,
      now: 100,
      token: "tok",
      operationId: "op-1",
    });
    expect(set).toEqual({ kind: "set", consentDigest: summary.digest });
    expect(sync().draft_fence).toEqual({
      token: "tok",
      started_at: 100,
      operation_ids: ["op-1"],
      consent_digest: summary.digest,
      closing: false,
    });
  });

  test("a second operation appends its id and refreshes the digest; the first's release leaves the fence", async () => {
    const { store, inc, sync } = await setup();
    await store.run(setDraftFence, {
      incarnationId: inc,
      now: 1,
      token: "tok",
      operationId: "op-1",
    });
    await store.run(putPlan("drafts"), [draftRow({ status: "queued" })]);
    await store.run(setDraftFence, {
      incarnationId: inc,
      now: 2,
      token: "tok-2",
      operationId: "op-2",
    });
    expect(sync().draft_fence?.operation_ids).toEqual(["op-1", "op-2"]);
    // The token and start time stay those of the first fence; the digest is the one read in the second transaction.
    expect(sync().draft_fence?.token).toBe("tok");
    expect(sync().draft_fence?.started_at).toBe(1);
    expect(sync().draft_fence?.consent_digest).not.toBe(NO_CONSENT_DIGEST);
    expect(
      await store.run(releaseFence, {
        incarnationId: inc,
        operationId: "op-1",
      }),
    ).toEqual({ kind: "kept" });
    expect(sync().draft_fence?.operation_ids).toEqual(["op-2"]);
    expect(
      await store.run(releaseFence, {
        incarnationId: inc,
        operationId: "op-2",
      }),
    ).toEqual({ kind: "released" });
    expect(sync().draft_fence).toBeNull();
  });

  test("releaseFence is ownership-scanning, idempotent and never clears another operation's fence (MU-38)", async () => {
    const { store, inc, sync } = await setup();
    expect(
      await store.run(releaseFence, {
        incarnationId: inc,
        operationId: "nobody",
      }),
    ).toEqual({ kind: "noop" });
    await store.run(setDraftFence, {
      incarnationId: inc,
      now: 1,
      token: "t",
      operationId: "op-1",
    });
    expect(
      await store.run(releaseFence, {
        incarnationId: inc,
        operationId: "op-other",
      }),
    ).toEqual({ kind: "noop" });
    expect(sync().draft_fence?.operation_ids).toEqual(["op-1"]);
    await store.run(releaseFence, { incarnationId: inc, operationId: "op-1" });
    expect(
      await store.run(releaseFence, {
        incarnationId: inc,
        operationId: "op-1",
      }),
    ).toEqual({ kind: "noop" });
  });

  test("a plan issued by a handle of another incarnation is refused and changes nothing (INC)", async () => {
    const { store, sync } = await setup();
    const inc = store.incarnationId;
    await store.run(setDraftFence, {
      incarnationId: inc,
      now: 1,
      token: "t",
      operationId: "op-1",
    });
    const before = sync();
    await expect(
      store.run(releaseFence, {
        incarnationId: "an-earlier-incarnation",
        operationId: "op-1",
      }),
    ).rejects.toMatchObject({
      cause: "plan_rejected",
      detail: { stage: "guard", reason: "incarnation" },
    });
    await expect(
      store.run(setClosing, {
        incarnationId: "an-earlier-incarnation",
        now: 1,
        token: "x",
      }),
    ).rejects.toMatchObject({ cause: "plan_rejected" });
    expect(sync()).toEqual(before);
  });

  test("setClosing creates the fence if absent and keeps an existing one; release removes `closing` with the record", async () => {
    const { store, inc, sync } = await setup();
    await store.run(setClosing, { incarnationId: inc, now: 5, token: "t" });
    expect(sync().draft_fence).toMatchObject({
      closing: true,
      operation_ids: [],
      started_at: 5,
    });
    await store.run(setDraftFence, {
      incarnationId: inc,
      now: 6,
      token: "t2",
      operationId: "op-1",
    });
    expect(sync().draft_fence).toMatchObject({
      closing: true,
      operation_ids: ["op-1"],
    });
    await store.run(releaseFence, { incarnationId: inc, operationId: "op-1" });
    expect(sync().draft_fence).toBeNull();
  });

  test("the baseline: the fence's digest; the live digest and count are recomputed with the same function", async () => {
    const { store, inc } = await setup();
    await store.run(putPlan("drafts"), [draftRow({ status: "queued" })]);
    const set = await store.run(setDraftFence, {
      incarnationId: inc,
      now: 1,
      token: "t",
      operationId: "op-1",
    });
    const before = await store.run(readBaseline, { incarnationId: inc });
    expect(before.fenceDigest).toBe(
      (set as { consentDigest: string }).consentDigest,
    );
    expect(before.liveDigest).toBe(before.fenceDigest);
    await store.run(putPlan("drafts"), [draftRow({ status: "queued" })]);
    const after = await store.run(readBaseline, { incarnationId: inc });
    expect(after.liveCount).toBe(2);
    expect(after.liveDigest).not.toBe(after.fenceDigest);
  });

  test("the summary and digest ignore pending_effects, resource_versions and cache rows", async () => {
    const { store, inc } = await setup();
    await store.run(putPlan("drafts"), [draftRow({ status: "queued" })]);
    const before = await store.run(summariseWork, { incarnationId: inc });
    await store.run(putPlan("pending_effects"), [effectRow()]);
    await store.run(putPlan("cache"), [cacheRow()]);
    expect(await store.run(summariseWork, { incarnationId: inc })).toEqual(
      before,
    );
  });
});

describe("stale-fence reconciliation (D-06, MU-39)", () => {
  const input = (
    over: Partial<{
      now: number;
      hasPendingOperation: boolean;
      sessionStarted: boolean;
    }> = {},
  ) => ({
    now: 1_000_000,
    staleMs: 120_000,
    hasPendingOperation: false,
    sessionStarted: true,
    ...over,
  });
  async function fenced(startedAt: number) {
    const ctx = await setup();
    await ctx.store.run(setDraftFence, {
      incarnationId: ctx.inc,
      now: startedAt,
      token: "t",
      operationId: "op-1",
    });
    return ctx;
  }
  test("clears a fence that is old enough, with no pending operation and a started session", async () => {
    const { store, inc, sync } = await fenced(0);
    expect(
      await store.run(reconcileStaleFence, { incarnationId: inc, ...input() }),
    ).toEqual({ cleared: true });
    expect(sync().draft_fence).toBeNull();
  });
  test("does nothing when the fence is not old enough", async () => {
    const { store, inc, sync } = await fenced(950_000);
    expect(
      await store.run(reconcileStaleFence, { incarnationId: inc, ...input() }),
    ).toEqual({ cleared: false });
    expect(sync().draft_fence).not.toBeNull();
  });
  test("does nothing while an operation is pending for the account (MU-39)", async () => {
    const { store, inc, sync } = await fenced(0);
    expect(
      await store.run(reconcileStaleFence, {
        incarnationId: inc,
        ...input({ hasPendingOperation: true }),
      }),
    ).toEqual({ cleared: false });
    expect(sync().draft_fence).not.toBeNull();
  });
  test("does nothing before the session has started (the pending store may not be populated yet)", async () => {
    const { store, inc, sync } = await fenced(0);
    expect(
      await store.run(reconcileStaleFence, {
        incarnationId: inc,
        ...input({ sessionStarted: false }),
      }),
    ).toEqual({ cleared: false });
    expect(sync().draft_fence).not.toBeNull();
  });
  test("a database with no fence is untouched", async () => {
    const { store, inc } = await setup();
    expect(
      await store.run(reconcileStaleFence, { incarnationId: inc, ...input() }),
    ).toEqual({ cleared: false });
  });
});
