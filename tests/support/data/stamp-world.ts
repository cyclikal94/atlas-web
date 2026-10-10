import type { DataRuntime } from "../../../src/data/engine/account-service";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type { AccountId, Captured } from "../../../src/data/model/types";
import type { Plan } from "../../../src/data/store/port";
import type { Identity, Persistence, Store } from "../../../src/session";
import { DEFAULT_CONFIG } from "../../../src/session/constants";
import { openHold } from "../../../src/session/kernel/persistence";
import { DataTestWorld, type PageEnv } from "./env";
import { type DataModules, srcDataModules } from "./modules";

/**
 * The commit-guard scenario runner (plan 8.2, F-S1 to F-S9; layer L1b, fake world).
 *
 * One request is stamped (A, epoch 1) and captured by page P1. A TRANSITION then happens (P1 itself, or another page P2, or a
 * confirmed wipe), at one of four POSITIONS relative to P1's commit, with P1's notice of another page's transition delivered,
 * delayed or never; the commit's COMPLETION is `normal`, `late` (the data is durable and only the completion event is held back
 * until well past the hold's bound and its stall report) or `unfinished` (the engine is still COMMITTING: the data is not durable
 * yet and lands only when the engine finishes, which is also held back past both bounds); and the database is in one of five states.
 * From P1 the last two look the same (its `run` promise is unresolved), which is why each is a cell of its own.
 * The ORACLE is the shared durable identity (what `atlas-auth` would say), which the code under test never reads: a commit is
 * STALE iff it was applied after the durable identity had left (A, 1). The code under test only has its own page's copy of the
 * identity, the database's own records and the engine's `versionchange`.
 *
 * Properties, checked on EVERY scenario:
 *  - C1: no commit lands in a database other than the account its request was stamped with;
 *  - C2: no commit re-creates a deleted database, and none lands in an incarnation other than the one captured;
 *  - C3: with the persistence hold (the product) NO stale commit is applied, in any cell, whatever notices this page has had: every
 *    settlement is made under the exclusive `atlas-auth` lock (the transitions of this runner are), the commit holds it shared from
 *    its verdict to its completion, so a transition is either seen by the verdict or ordered after the persistence. Without the hold
 *    (`persistence: false`, the contrast kept so that what the hold closes stays visible) the residual window of plan 5.2.3 is what
 *    remains, and is asserted to be exactly that;
 *  - a dropped commit writes nothing.
 */
export interface RunOptions {
  /** True (default): the page's runtime has the persistence hold, and every transition is settled under the exclusive lock. */
  persistence?: boolean;
}
export type Transition =
  | "none"
  | "self_switch"
  | "self_reauth"
  | "self_signout"
  | "other_switch"
  | "other_reauth"
  | "other_signout"
  | "wipe";
export type Position = "before_g2" | "queued" | "executed" | "completed";
export type Hint = "delivered" | "delayed" | "absent";
export type Completion = "normal" | "late" | "unfinished";
export type DbState = "open" | "latched" | "deleted" | "recreated" | "closing";

export interface Params {
  transition: Transition;
  position: Position;
  hint: Hint;
  completion: Completion;
  db: DbState;
}

export const A: AccountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const B: AccountId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const WRITER_CALLER = "scenario";
const nameA = accountDatabaseName(A);

export const TRANSITIONS: readonly Transition[] = [
  "none",
  "self_switch",
  "self_reauth",
  "self_signout",
  "other_switch",
  "other_reauth",
  "other_signout",
  "wipe",
];
export const POSITIONS: readonly Position[] = [
  "before_g2",
  "queued",
  "executed",
  "completed",
];
export const HINTS: readonly Hint[] = ["delivered", "delayed", "absent"];
export const COMPLETIONS: readonly Completion[] = [
  "normal",
  "late",
  "unfinished",
];
export const DB_STATES: readonly DbState[] = [
  "open",
  "latched",
  "deleted",
  "recreated",
  "closing",
];

/** The scenarios of the product that mean something: a database state other than `open` is arranged BEFORE the request and has no transition. */
export function enumerate(): Params[] {
  const out: Params[] = [];
  for (const db of DB_STATES) {
    for (const transition of db === "open"
      ? TRANSITIONS
      : (["none"] as const)) {
      for (const position of POSITIONS) {
        // The notice of another page's transition is the only thing a hint changes.
        const hints: readonly Hint[] = transition.startsWith("other_")
          ? HINTS
          : ["delivered"];
        for (const hint of hints)
          for (const completion of COMPLETIONS)
            out.push({ transition, position, hint, completion, db });
      }
    }
  }
  return out;
}

/**
 * Whether a stale commit is expected in a cell. WITH the persistence hold never. WITHOUT it, the characterised residual of plan
 * 5.2.3, stated independently of the implementation.
 */
export function expectsStale(p: Params, options: RunOptions = {}): boolean {
  if (options.persistence !== false) return false;
  if (p.db !== "open") return false;
  if (!p.transition.startsWith("other_")) return false;
  if (p.hint === "delivered") return false;
  if (p.position === "executed" || p.position === "completed") return false;
  // Another page's re-authentication within the account publishes the new epoch; a commit created AFTER the publication was
  // created is dropped by the epoch mirror. A commit already queued before it is not.
  if (p.transition === "other_reauth" && p.position === "before_g2")
    return false;
  return true;
}

class PageIdentity implements Store<Identity | null> {
  private value: Identity | null;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly env: PageEnv,
    initial: { account: AccountId; epoch: number },
  ) {
    this.value = {
      account_id: initial.account,
      epoch: initial.epoch,
      session_id: `s-${env.id}`,
    };
    env.identity.account = initial.account;
    env.identity.epoch = initial.epoch;
  }
  get(): Identity | null {
    return this.value;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  set(next: { account: AccountId; epoch: number } | null): void {
    this.value = next
      ? {
          account_id: next.account,
          epoch: next.epoch,
          session_id: `s-${this.env.id}`,
        }
      : null;
    this.env.identity.account = next?.account ?? null;
    this.env.identity.epoch = next?.epoch ?? 0;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface Page {
  env: PageEnv;
  identity: PageIdentity;
  runtime: DataRuntime;
}

export interface Outcome {
  params: Params;
  result: "applied" | "dropped" | "failed" | "unresolved";
  reason: string | null;
  keyWrittenInA: boolean;
  foreignWrites: string[];
  aExists: boolean;
  staleApplied: boolean;
  /** The incarnation of A's database at the end, and the one the request captured. */
  incarnation: { captured: string; final: string | null };
  violations: string[];
}

export interface WriterSpec {
  /** The response-applying plan under test and how to build its input. */
  plan: Plan<never, never, never>;
  name: string;
  input(captured: Captured): never;
  /** True when the plan's effect is present in a database snapshot (rows by store). */
  applied(snapshot: Record<string, object[]> | null): boolean;
  /** Extra seeding a plan needs in A's database before the request is captured. */
  seed?(world: DataTestWorld, db: string): void;
}

/** The first response-applying writer: a read failure recorded for a caller (W11). Later milestones add `commitPage`, `admitReceipt`. */
export function recordReadOutcomeWriter(modules: DataModules): WriterSpec {
  return {
    name: "recordReadOutcome",
    plan: modules.retryPlans.recordReadOutcome as never,
    input: (captured) =>
      ({
        captured,
        caller: WRITER_CALLER,
        outcome: { kind: "failure" },
        now: 1_000,
      }) as never,
    applied: (snapshot) => {
      const sync = snapshot?.sync_state?.[0] as
        | { read_retry_states?: Record<string, unknown> }
        | undefined;
      return sync?.read_retry_states?.[WRITER_CALLER] !== undefined;
    },
  };
}

/** The kernel's own bounds: when a hold is revoked, and when work that is still unresolved after that is reported as stalled. */
const HOLD_BOUND_MS = DEFAULT_CONFIG.persistenceHoldMs;
const STALL_MS = DEFAULT_CONFIG.persistenceStallMs;

async function drive<T>(world: DataTestWorld, promise: Promise<T>): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  let failed = false;
  promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      failed = true;
      error = e;
    },
  );
  for (let turn = 0; turn < 100 && !done; turn += 1)
    await world.world.runUntilIdle();
  // A transition waiting for a persistence hold whose holder never releases it is let in by the hold's bound (a holder that
  // registered no work): that needs time. A holder with unresolved work keeps the lock for as long as the work is unresolved, so
  // the scenarios end that work before they wait for the transition.
  if (!done) await world.world.advance(HOLD_BOUND_MS + STALL_MS + 1_000);
  for (let turn = 0; turn < 100 && !done; turn += 1)
    await world.world.runUntilIdle();
  if (!done) throw new Error("the promise did not settle");
  if (failed) throw error;
  return value as T;
}

const stripStamp = (
  snapshot: Record<string, object[]> | null,
): Record<string, object[]> | null => {
  if (snapshot === null) return null;
  const copy = structuredClone(snapshot);
  for (const row of copy.sync_state ?? [])
    (row as { stamp?: unknown }).stamp = null;
  return copy;
};

export async function runScenario(
  params: Params,
  modules: DataModules = srcDataModules,
  writer: WriterSpec = recordReadOutcomeWriter(modules),
  options: RunOptions = {},
): Promise<Outcome> {
  const withHold = options.persistence !== false;
  const env = new DataTestWorld(modules);
  const { world, idb } = env;
  const violations: string[] = [];
  let epochCounter = 1;
  const durable: { account: AccountId | null; epoch: number } = {
    account: A,
    epoch: 1,
  };
  const transitionSeq: number[] = [];
  const noteTransition = (what: string): void => {
    world.log({ type: "auth.transition", what });
    transitionSeq.push(world.logs.length - 1);
  };

  /**
   * The persistence hold as the kernel gives it, over the fake world's Web Locks and the scenario's durable identity (the oracle,
   * which stands for `auth_state.settled`): a shared `atlas-auth` lock, then the verdict at the record. What follows the verdict (the
   * revocation at the bound, the registered work, the drain, the release) is the KERNEL's own `openHold`, not a copy of it.
   */
  const gateOf = (pageEnv: PageEnv): Persistence => ({
    async hold(account, epoch) {
      const lock = await pageEnv.locks.acquireShared("atlas-auth");
      if (lock === null) return { kind: "unavailable" };
      if (durable.account !== account || durable.epoch !== epoch) {
        lock.release();
        return { kind: "stale" };
      }
      return openHold(lock, {
        clock: {
          abortAfter(ms) {
            const controller = new AbortController();
            world.schedule(
              "timer",
              pageEnv.id,
              { what: "persistence.bound" },
              () => controller.abort(),
              ms,
            );
            return controller.signal;
          },
        },
        holdMs: HOLD_BOUND_MS,
        stallMs: STALL_MS,
        emit: (event) =>
          world.log({ type: `trace.${event}`, page: pageEnv.id }),
      });
    },
  });
  const makePage = (
    id: string,
    initial: { account: AccountId; epoch: number },
  ): Page => {
    const pageEnv = env.page(id);
    const identity = new PageIdentity(pageEnv, initial);
    const runtime = new modules.accountService.DataRuntime({
      identity,
      persistence: withHold
        ? gateOf(pageEnv)
        : modules.accountService.unorderedPersistence,
      registry: pageEnv.registry,
      open: (account, options) => pageEnv.open(account, options),
    });
    return { env: pageEnv, identity, runtime };
  };
  const p1 = makePage("P1", { account: A, epoch: 1 });
  const p2 = makePage("P2", { account: A, epoch: 1 });

  // Both pages hold A's database; B's database exists (so a misdirected write would have somewhere to land).
  const created = await drive(env, p1.runtime.open(A, { create: true }));
  if (created.kind !== "opened") throw new Error(`setup: ${created.kind}`);
  const opened2 = await drive(env, p2.runtime.open(A));
  if (opened2.kind !== "opened") throw new Error(`setup: ${opened2.kind}`);
  const p3 = makePage("P3", { account: B, epoch: 1 });
  const createdB = await drive(env, p3.runtime.open(B, { create: true }));
  if (createdB.kind !== "opened") throw new Error(`setup: ${createdB.kind}`);
  p3.runtime.dispose();

  let service = created.service;
  const captured = service.capture(1);
  const capturedIncarnation = captured.incarnationId;
  const nameB = accountDatabaseName(B);

  // ---- the database state arranged BEFORE the request is committed ----
  if (params.db === "latched") {
    p1.env.registry.closeAll(A, { latch: "closed_for_deletion" });
  } else if (params.db === "closing") {
    await drive(
      env,
      service.store.run(
        modules.fencePlans.setClosing as never,
        {
          incarnationId: service.incarnationId,
          now: 1,
          token: "t",
        } as never,
      ),
    );
  } else if (params.db === "deleted" || params.db === "recreated") {
    // Another page deletes the database while this page still names the account (a wipe that finished elsewhere, or damage):
    // the identity facts are NOT moved, so the late commit has to be stopped by the database's own state.
    const deleted = await drive(env, p2.env.host.delete(nameA));
    if (!["deleted", "blocked_then_deleted"].includes(deleted))
      violations.push(`setup: delete ${deleted}`);
    if (params.db === "recreated") {
      const again = await drive(env, p1.runtime.open(A, { create: true }));
      if (again.kind !== "opened")
        throw new Error(`setup: recreate ${again.kind}`);
      service = again.service;
    }
  }

  const snapshotBefore = stripStamp(idb.snapshot(nameA));
  const input = writer.input(captured);

  // ---- the transition ----
  const delayedNotices: Array<() => void> = [];
  /**
   * The transition itself, at the moment it is SETTLED. With the hold it is made under the exclusive `atlas-auth` lock, as every
   * settlement of the real record is (`settleAttempt`, the completion of a wipe), so it waits for any persistence hold still kept.
   */
  const settleTransition = (): void => {
    const t = params.transition;
    if (t === "none") return;
    const actor = t.startsWith("self_") ? p1 : p2;
    const notify = (to: { account: AccountId; epoch: number } | null): void => {
      if (actor !== p2) return;
      const deliver = () => p1.identity.set(to);
      if (params.hint === "delivered") deliver();
      else if (params.hint === "delayed") delayedNotices.push(deliver);
      // `absent`: this page is never told.
    };
    if (t.endsWith("switch")) {
      epochCounter += 1;
      const to = { account: B, epoch: epochCounter };
      durable.account = B;
      durable.epoch = epochCounter;
      noteTransition("switch");
      actor.identity.set(to);
      notify(to);
    } else if (t.endsWith("reauth")) {
      epochCounter += 1;
      const to = { account: A, epoch: epochCounter };
      durable.epoch = epochCounter;
      noteTransition("reauth");
      actor.identity.set(to);
      notify(to);
    } else if (t.endsWith("signout")) {
      durable.account = null;
      noteTransition("signout");
      actor.identity.set(null);
      notify(null);
    }
  };
  const applyTransition = async (): Promise<void> => {
    if (params.transition === "none") return;
    if (params.transition === "wipe") {
      // A confirmed wipe CLOSES the data first (the canonical procedure: coordinated closure, then the deletion, under its own
      // `atlas-delete` lock) and settles `atlas-auth` last, under the exclusive lock. P1 learns of the deletion through its
      // engine's `versionchange`, whatever its notices do; its identity copy follows with the notice.
      p2.identity.set(null);
      p1.identity.set(null);
      const lock = withHold ? await p2.env.locks.acquire("atlas-auth") : null;
      try {
        durable.account = null;
        noteTransition("wipe");
      } finally {
        lock?.release();
      }
      return;
    }
    if (!withHold) {
      settleTransition();
      return;
    }
    const actor = params.transition.startsWith("self_") ? p1 : p2;
    const lock = await actor.env.locks.acquire("atlas-auth");
    try {
      settleTransition();
    } finally {
      lock?.release();
    }
  };

  let blocked = false;
  const blockQueue = async (): Promise<void> => {
    idb.inject({
      match: (tx) => tx.label === "test.blocker" && tx.page === "P1",
      mode: "pending_blocking",
      times: 1,
    });
    const blocker: Plan<null, null, null> = {
      name: "test.blocker",
      scope: ["sync_state"],
      mode: "readonly",
      durability: "default",
      read: async () => null,
      decide: () => ({ writes: [], result: null }),
    };
    void service.store.run(blocker, null).catch(() => undefined);
    await world.runUntilIdle();
    blocked = true;
  };
  // The two ways a commit can still be outstanding after the hold's bound: the engine is still committing (the data is not durable),
  // or the data is durable and only the completion has not been delivered.
  if (params.completion === "unfinished")
    idb.inject({
      match: (tx) => tx.label === writer.plan.name,
      mode: "stall_commit",
      times: 1,
    });
  if (params.completion === "late" || params.position === "executed")
    world.setKnob("D0", "unbounded", (meta) => meta.label === writer.plan.name);
  const outstanding = params.completion !== "normal";
  /** The engine finishes the commit (makes it durable) or the completion is delivered. */
  const endOutstanding = (): void => {
    if (params.completion === "unfinished") idb.completeStalled(nameA);
    world.release("D0");
  };

  const commitFlow = (): Promise<unknown> =>
    service.commit(writer.plan as never, input as never);
  const settled: { result: Outcome["result"]; reason: string | null } = {
    result: "unresolved",
    reason: null,
  };
  let commitCreated = false;
  const settle = (
    outcome: { kind: string; reason?: string } | undefined,
  ): void => {
    if (!outcome) return;
    settled.result = outcome.kind as Outcome["result"];
    settled.reason = outcome.reason ?? null;
  };
  const startCommit = (): void => {
    commitCreated = true;
    void commitFlow().then((o) => settle(o as never));
  };

  /**
   * The commit is outstanding when the transition is requested: it keeps the lock, so the transition must NOT be made, however long it
   * waits (well past the hold's bound and the stall report, the interval in which an earlier revision gave the lock up); then the
   * commit ends, and the transition is made after it. Without the hold nothing orders them and nothing is asserted.
   */
  const waitForCommit = async (): Promise<void> => {
    if (outstanding && withHold && params.transition !== "none") {
      const before = transitionSeq.length;
      await world.runUntilIdle();
      await world.advance(HOLD_BOUND_MS + STALL_MS + 1_000);
      if (settled.result === "unresolved" && transitionSeq.length > before)
        violations.push(
          "a transition was settled while the commit was outstanding (the lock was given up under it)",
        );
    }
    endOutstanding();
    await world.runUntilIdle();
  };

  if (params.position === "before_g2") {
    await drive(env, applyTransition());
    startCommit();
    await world.runUntilIdle();
  } else if (params.position === "queued") {
    await blockQueue();
    startCommit();
    await world.runUntilIdle();
    // The transition is requested while the commit is queued behind a blocker; with the hold it waits for the commit to persist.
    const settledTransition = applyTransition();
    await world.runUntilIdle();
    idb.releaseStuck(nameA);
    await world.runUntilIdle();
    await waitForCommit();
    await drive(env, settledTransition);
  } else {
    // `executed`: the completion is held back until the transition has been requested. `completed`: the commit has run, and with a
    // `normal` completion has completed before the transition is requested.
    startCommit();
    await world.runUntilIdle();
    const settledTransition = applyTransition();
    await world.runUntilIdle();
    await waitForCommit();
    await drive(env, settledTransition);
  }
  void blocked;
  // A commit that nothing waited for (no transition, or the commit was dropped before it reached the store) is ended now.
  endOutstanding();
  await world.runUntilIdle();
  // Notices that were only delayed arrive now, after the commit has had its chance.
  for (const deliver of delayedNotices) deliver();
  await world.runUntilIdle();
  if (params.transition === "wipe") {
    // The wipe's delete completes once every connection has closed.
    const deleted = await drive(env, p2.env.host.delete(nameA));
    if (!["deleted", "blocked_then_deleted"].includes(deleted))
      violations.push(`wipe: ${deleted}`);
  }

  // ---- the oracle ----
  const finalA = idb.snapshot(nameA);
  const keyWrittenInA = writer.applied(finalA);
  const foreignWrites: string[] = [];
  for (const name of idb.databases.keys())
    if (name !== nameA && writer.applied(idb.snapshot(name)))
      foreignWrites.push(name);
  if (writer.applied(idb.snapshot(nameB)) && !foreignWrites.includes(nameB))
    foreignWrites.push(nameB);
  const aExists = idb.has(nameA);
  const commitEntry = world.logs.find(
    (entry) =>
      entry.type === "idb.commit" &&
      entry.label === writer.plan.name &&
      entry.wrote === true,
  );
  const staleApplied =
    keyWrittenInA &&
    commitEntry !== undefined &&
    transitionSeq.some((seq) => seq < commitEntry.seq);
  const finalIncarnation =
    (finalA?.sync_state?.[0] as { incarnation_id?: string } | undefined)
      ?.incarnation_id ?? null;

  if (foreignWrites.length > 0)
    violations.push(`C1: written outside A: ${foreignWrites.join(",")}`);
  if (params.db === "deleted" && aExists)
    violations.push("C2: a deleted database was re-created");
  if (params.transition === "wipe" && aExists)
    violations.push("C2: the wiped database exists afterwards");
  if (params.db === "recreated") {
    if (keyWrittenInA)
      violations.push(
        "C2: a commit landed in an incarnation other than the one captured",
      );
    if (finalIncarnation === capturedIncarnation)
      violations.push("setup: the incarnation did not change");
  }
  if (
    params.db === "latched" ||
    params.db === "closing" ||
    params.db === "deleted"
  ) {
    if (keyWrittenInA) violations.push(`${params.db}: the commit was applied`);
  }
  const expected = expectsStale(params, options);
  if (staleApplied !== expected)
    violations.push(
      `C3: stale commit ${staleApplied ? "applied" : "not applied"}, ${withHold ? "the persistence hold allows none" : "the characterised window says"} ${expected ? "applied" : "not applied"}`,
    );
  const { result, reason } = settled;
  if (result === "dropped" && keyWrittenInA)
    violations.push("a dropped commit wrote");
  if (result === "dropped") {
    const after = stripStamp(finalA);
    if (aExists && JSON.stringify(after) !== JSON.stringify(snapshotBefore))
      violations.push("a dropped commit changed the database");
  }
  if (result === "unresolved" && commitCreated)
    violations.push("the commit never settled");
  for (const page of [p1, p2]) page.runtime.dispose();

  return {
    params,
    result,
    reason,
    keyWrittenInA,
    foreignWrites,
    aExists,
    staleApplied,
    incarnation: { captured: capturedIncarnation, final: finalIncarnation },
    violations,
  };
}
