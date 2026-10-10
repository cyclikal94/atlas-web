// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { WipeService } from "../../src/session/kernel/wipe";
import { RealData } from "../support/data/real-ports";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  newWorld,
  openPage,
  type SignedIn,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-W4 (plan 8.6; WEB-08a hand-off HO-3): the 14 consent-serialisation regressions of `tests/session/consent-serialised.test.ts`,
 * run against the REAL adapters over REAL rows in the data layer's IndexedDB double. They were fixture-only until now: the 08a
 * fakes held "work" as a count and a digest per account, which the primitives' own tests could not turn into an integration.
 *
 * The intent of every schedule is unchanged. What differs is how the SITUATION is arranged, because the counts and digests are
 * now computed by the production code from the rows:
 *  - the work the person saw is three queued drafts;
 *  - "work that changed after the confirmation" is a recovery copy that appears at step 3a, before `closing` is written (a draft
 *    cannot appear after the fence: the fence refuses it, which is the point);
 *  - "work saved after Keep" is a new draft, which a released fence no longer covers.
 * Wherever the 08a test asserted a literal count or digest, this one asserts the value the production code computed.
 */
type Scene = Awaited<ReturnType<typeof twoPagesShowingTheSamePrompt>>;

const deletes = (real: RealData) => real.deletes();

function promptOf(page: FakePage) {
  const view = page.session.view.get();
  if (view.kind !== "neutral" || !view.consent)
    throw new Error(`no consent prompt is showing: ${JSON.stringify(view)}`);
  return view.consent;
}

function watch(promise: Promise<unknown>) {
  const state = { done: false };
  promise.then(
    () => {
      state.done = true;
    },
    () => {
      state.done = true;
    },
  );
  return state;
}

async function twoPagesShowingTheSamePrompt() {
  const real = new RealData();
  const f = await newWorld({ dataPorts: real.dataPorts });
  real.attach(f.world);
  const l: SignedIn = await signedInPage(f);
  const account = l.account;
  await real.createAccountDb(account, "inc-original");
  real.addDrafts(account, 3);
  await f.settle();
  // What the person saw and confirmed: three changes.
  const seen = await f.runWith(l.page.session.operations.summariseLocalWork());
  expect(seen?.count).toBe(3);
  // An unfinished form is autosaved between the confirmation and the closure.
  real.onBroadcastImminent = () => real.addRecovery(account);
  await f.runWith(
    l.page.session.operations.logout({
      unsynced: seen as NonNullable<typeof seen>,
    }),
  );
  await f.settle();
  expect(f.store.records.pending_deletions[account]?.status).toBe(
    "awaiting_consent",
  );
  const other = await openPage(f);
  await f.settle();
  return {
    real,
    f,
    l,
    other,
    account,
    mine: promptOf(l.page),
    theirs: promptOf(other),
  };
}

/** What "Keep for now" leaves behind: no envelope, no draft fence, no ledger entry, and the database retained. */
function expectKept({ f, real }: Pick<Scene, "f" | "real">, account: string) {
  expect(f.store.records.pending_deletions[account]).toBeUndefined();
  expect(stateOf(f).fences[account]).toBeUndefined();
  expect(real.fenceOf(account)).toBeNull();
  expect(real.hasDb(account)).toBe(true);
  expect(deletes(real)).toEqual([]);
}

const holdFor = (
  f: Fixture,
  page: FakePage,
  label: "ledger:read" | "ledger:status" | "ledger:clear",
) =>
  f.world.setKnob(
    "D0",
    "unbounded",
    (meta) => meta.page === page.id && meta.label === label,
  );

describe("the scene itself is real", () => {
  test("the renewed prompt counts the production code's live work: three drafts and the recovery copy", async () => {
    const { f, account, real } = await twoPagesShowingTheSamePrompt();
    expect(f.store.records.pending_deletions[account]).toMatchObject({
      status: "awaiting_consent",
      count: 4,
    });
    // The fence the wipe set before the network call is still in the database, with the digest of the THREE drafts.
    expect(real.fenceOf(account)).toMatchObject({
      closing: true,
      operation_ids: [expect.any(String)],
    });
    expect(real.drafts(account)).toBe(3);
  });
});

describe("a choice waits for the account's critical section and is decided after it", () => {
  test("a Delete whose ledger read is delayed holds the lock: the other page's Keep is queued behind it, and is refused once the deletion has finished", async () => {
    const { f, l, other, account, mine, theirs, real } =
      await twoPagesShowingTheSamePrompt();
    holdFor(f, l.page, "ledger:read");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    await f.world.runUntilIdle();
    expect(f.world.heldCount("D0")).toBe(1);

    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    const kept = watch(keeping);
    await f.world.runUntilIdle();
    expect(kept.done).toBe(false);
    expect(real.callsOf("releaseFence", account)).toEqual([]);
    expect(f.store.records.pending_deletions[account]?.status).toBe(
      "awaiting_consent",
    );
    expect(stateOf(f).fences[account]).toBeDefined();

    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(deleting)).toEqual({ kind: "deleted" });
    expect(await f.runWith(keeping)).toEqual({ kind: "prompt_superseded" });
    expect(deletes(real)).toEqual([`delete:${account}`]);
    expect(real.callsOf("releaseFence", account)).toEqual([]);
    expect(real.hasDb(account)).toBe(false);
    expect(f.store.records.pending_deletions[account]).toBeUndefined();
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same when it is the Delete's STATUS change whose completion is delayed (the approval is already committed)", async () => {
    const { f, l, other, account, mine, theirs, real } =
      await twoPagesShowingTheSamePrompt();
    holdFor(f, l.page, "ledger:status");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    await f.world.runUntilIdle();
    expect(f.world.heldCount("D0")).toBe(1);
    expect(f.store.records.pending_deletions[account]?.status).toBe(
      "deletion_approved",
    );

    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    const kept = watch(keeping);
    await f.world.runUntilIdle();
    expect(kept.done).toBe(false);
    expect(real.callsOf("releaseFence", account)).toEqual([]);
    expect(f.store.records.pending_deletions[account]?.status).toBe(
      "deletion_approved",
    );

    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(deleting)).toEqual({ kind: "deleted" });
    expect(await f.runWith(keeping)).toEqual({ kind: "prompt_superseded" });
    expect(deletes(real)).toEqual([`delete:${account}`]);
    expect(real.hasDb(account)).toBe(false);
    expect(f.store.records.pending_deletions[account]).toBeUndefined();
    expect(checkProperties(f)).toEqual([]);
  });

  test("work saved while the Delete waited is NOT deleted: the approval covers the set the person saw, so the prompt is renewed and the queued Keep is refused as superseded", async () => {
    const { f, l, other, account, mine, theirs, real } =
      await twoPagesShowingTheSamePrompt();
    const approvedDigest = f.store.records.pending_deletions[account]?.digest;
    holdFor(f, l.page, "ledger:status");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    await f.world.runUntilIdle();
    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    await f.world.runUntilIdle();
    // New work arrives after the approval, before the deletion would run (step 3a compares against the approved digest).
    real.addDrafts(account, 1);
    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(deleting)).toEqual({
      kind: "awaiting_consent",
      count: 5, // three drafts, the recovery copy and the draft just saved
    });
    expect(await f.runWith(keeping)).toEqual({ kind: "prompt_superseded" });
    expect(deletes(real)).toEqual([]);
    expect(real.hasDb(account)).toBe(true);
    expect(real.drafts(account)).toBe(4);
    expect(f.store.records.pending_deletions[account]).toMatchObject({
      status: "awaiting_consent",
    });
    expect(f.store.records.pending_deletions[account]?.digest).not.toBe(
      approvedDigest,
    );
    expect(
      await f.runWith(
        l.page.session.wipe.resolveConsent(promptOf(l.page).ticket, "keep"),
      ),
    ).toEqual({ kind: "absent" });
    expectKept({ f, real }, account);
    expect(real.drafts(account)).toBe(4);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a Keep holds the lock through its three writes: a Delete made meanwhile finds nothing to delete, recreates nothing, and the work saved after Keep survives", async () => {
    const { f, l, other, account, mine, theirs, real } =
      await twoPagesShowingTheSamePrompt();
    holdFor(f, other, "ledger:clear");
    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    const kept = watch(keeping);
    await f.world.runUntilIdle();
    expect(f.world.heldCount("D0")).toBe(1);
    expect(kept.done).toBe(false);
    expect(real.callsOf("releaseFence", account)).toHaveLength(1);
    // The released draft fence has no baseline any more, and the person saves new work that neither prompt covered.
    expect(real.fenceOf(account)).toBeNull();
    real.addDrafts(account, 1);
    const callsBefore = real.calls.length;

    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    const deleteDone = watch(deleting);
    await f.world.runUntilIdle();
    expect(deleteDone.done).toBe(false);

    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(keeping)).toEqual({ kind: "absent" });
    expect(await f.runWith(deleting)).toEqual({ kind: "prompt_superseded" });
    expect(real.calls.slice(callsBefore)).toEqual([]);
    expect(real.drafts(account)).toBe(4);
    expectKept({ f, real }, account);
    expect(l.page.session.view.get().kind).not.toBe("neutral");
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("the change is committed only against the entry the person answered", () => {
  test("a status update refused because the entry was resolved meanwhile is `prompt_superseded`: nothing is recreated or deleted, and the newly retained work survives", async () => {
    const { f, l, account, mine, real } = await twoPagesShowingTheSamePrompt();
    holdFor(f, l.page, "ledger:read");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    await f.world.runUntilIdle();
    expect(f.world.heldCount("D0")).toBe(1);
    // A writer that does NOT take the lock resolves the operation exactly as "Keep for now" would, while the read result is in
    // flight. The commit must still refuse the change on its own.
    delete f.store.records.pending_deletions[account];
    delete f.store.records.auth_state.fences[account];
    real.clearFence(account);
    real.addDrafts(account, 1);
    const callsBefore = real.calls.length;

    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(deleting)).toEqual({ kind: "prompt_superseded" });
    expect(real.calls.slice(callsBefore)).toEqual([]);
    expect(f.store.records.pending_deletions[account]).toBeUndefined();
    expect(real.hasDb(account)).toBe(true);
    expect(real.drafts(account)).toBe(4);
    expect(deletes(real)).toEqual([]);
  });

  test("a status update refused because the entry was replaced by a renewed prompt applies nothing to it", async () => {
    const { f, l, account, mine, real } = await twoPagesShowingTheSamePrompt();
    holdFor(f, l.page, "ledger:read");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    await f.world.runUntilIdle();
    const entry = f.store.records.pending_deletions[account];
    if (!entry) throw new Error("no entry");
    f.store.records.pending_deletions[account] = {
      ...entry,
      digest: "renewed",
      count: 9,
    };

    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(deleting)).toEqual({ kind: "prompt_superseded" });
    expect(f.store.records.pending_deletions[account]).toMatchObject({
      status: "awaiting_consent",
      digest: "renewed",
      approved_digest: null,
    });
    expect(deletes(real)).toEqual([]);
    expect(real.hasDb(account)).toBe(true);
  });
});

describe("the procedure's own renewal of the prompt is committed the same way", () => {
  test("an entry resolved while the procedure measured the live work is not claimed as awaiting consent", async () => {
    const real = new RealData();
    const f = await newWorld({ dataPorts: real.dataPorts });
    real.attach(f.world);
    const l = await signedInPage(f);
    const account = l.account;
    await real.createAccountDb(account, "inc-1");
    real.addDrafts(account, 2);
    // No fence and two drafts: the baseline is a digest nothing can equal, so the live digest differs and the prompt is renewed.
    const ports = l.page.kernel.ports.deletion;
    const measure = ports.coordination.liveDigest.bind(ports.coordination);
    ports.coordination.liveDigest = async (a) => {
      const digest = await measure(a);
      // A writer that does not take the lock resolves the entry while the digest is being measured.
      delete f.store.records.pending_deletions[a];
      return digest;
    };
    const outcome = await f.runWith(
      l.page.session.wipe.run(account, "11111111-1111-4111-8111-111111111111"),
    );
    expect(outcome).toEqual({ kind: "absent" });
    expect(f.store.records.pending_deletions[account]).toBeUndefined();
    expect(l.page.session.view.get()).not.toMatchObject({
      state: "wipe.consent",
    });
    expect(deletes(real)).toEqual([]);
    expect(real.hasDb(account)).toBe(true);
  });
});

describe("two pages choosing at the same time", () => {
  test("Delete then Keep: the first issued wins, the other is refused, and exactly one outcome is applied", async () => {
    const { f, l, other, account, mine, theirs, real } =
      await twoPagesShowingTheSamePrompt();
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    const [deleted, kept] = await Promise.all([
      f.runWith(deleting),
      f.runWith(keeping),
    ]);
    expect(deleted).toEqual({ kind: "deleted" });
    expect(kept).toEqual({ kind: "prompt_superseded" });
    expect(deletes(real)).toEqual([`delete:${account}`]);
    expect(real.callsOf("releaseFence", account)).toEqual([]);
    expect(real.hasDb(account)).toBe(false);
    expect(f.store.records.pending_deletions[account]).toBeUndefined();
    expect(checkProperties(f)).toEqual([]);
  });

  test("Keep then Delete: the first issued wins, the other is refused, and the database is retained", async () => {
    const { f, l, other, account, mine, theirs, real } =
      await twoPagesShowingTheSamePrompt();
    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    const [kept, deleted] = await Promise.all([
      f.runWith(keeping),
      f.runWith(deleting),
    ]);
    expect(kept).toEqual({ kind: "absent" });
    expect(deleted).toEqual({ kind: "prompt_superseded" });
    expectKept({ f, real }, account);
    expect(real.drafts(account)).toBe(3);
    expect(real.callsOf("releaseFence", account)).toHaveLength(1);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same choice on both pages is applied once", async () => {
    for (const choice of ["delete", "keep"] as const) {
      const { f, l, other, account, mine, theirs, real } =
        await twoPagesShowingTheSamePrompt();
      const first = l.page.session.wipe.resolveConsent(mine.ticket, choice);
      const second = other.session.wipe.resolveConsent(theirs.ticket, choice);
      const outcomes = await Promise.all([f.runWith(first), f.runWith(second)]);
      expect(outcomes[1]).toEqual({ kind: "prompt_superseded" });
      if (choice === "delete") {
        expect(outcomes[0]).toEqual({ kind: "deleted" });
        expect(deletes(real)).toEqual([`delete:${account}`]);
        expect(real.hasDb(account)).toBe(false);
      } else {
        expect(outcomes[0]).toEqual({ kind: "absent" });
        expect(real.callsOf("releaseFence", account)).toHaveLength(1);
        expectKept({ f, real }, account);
      }
      expect(checkProperties(f)).toEqual([]);
    }
  });
});

describe("the lock is taken once, before anything is read, and released only at the end", () => {
  const sequence = (f: Fixture, page: FakePage, from: number) =>
    f.world.logs
      .slice(from)
      .filter((entry) => entry.page === page.id)
      .flatMap((entry) => {
        if (entry.type === "lock.held") return [`+${String(entry.name)}`];
        if (entry.type === "lock.release_called")
          return [`-${String(entry.name)}`];
        if (entry.type === "store.create") return [`tx:${String(entry.label)}`];
        return [];
      });

  test("Delete: one acquisition of atlas-delete, taken before the ledger is read; atlas-auth only inside it; the data ports take no lock of their own", async () => {
    const { f, l, account, mine } = await twoPagesShowingTheSamePrompt();
    const from = f.world.logs.length;
    expect(
      await f.runWith(
        l.page.session.wipe.resolveConsent(mine.ticket, "delete"),
      ),
    ).toEqual({ kind: "deleted" });
    const steps = sequence(f, l.page, from);
    const lock = `atlas-delete:${account}`;
    expect(steps.filter((step) => step === `+${lock}`)).toHaveLength(1);
    expect(steps.filter((step) => step === `-${lock}`)).toHaveLength(1);
    const acquired = steps.indexOf(`+${lock}`);
    expect(acquired).toBe(0);
    expect(steps.indexOf("tx:ledger:read")).toBeGreaterThan(acquired);
    expect(steps.indexOf("tx:ledger:status")).toBeGreaterThan(acquired);
    expect(steps.indexOf("+atlas-auth")).toBeGreaterThan(acquired);
    expect(steps.indexOf(`-${lock}`)).toBe(steps.length - 1);
    expect(steps.lastIndexOf("-atlas-auth")).toBeLessThan(
      steps.indexOf(`-${lock}`),
    );
    // Web Locks are not re-entrant: no port may request a lock the kernel already holds.
    expect(steps.filter((step) => step.startsWith("+"))).toEqual([
      `+${lock}`,
      "+atlas-auth",
    ]);
  });

  test("Keep: the lock is taken before the ledger is read and released after the entry is cleared", async () => {
    const { f, other, account, theirs } = await twoPagesShowingTheSamePrompt();
    const from = f.world.logs.length;
    expect(
      await f.runWith(other.session.wipe.resolveConsent(theirs.ticket, "keep")),
    ).toEqual({ kind: "absent" });
    const steps = sequence(f, other, from);
    const lock = `atlas-delete:${account}`;
    expect(steps[0]).toBe(`+${lock}`);
    expect(steps.filter((step) => step === `+${lock}`)).toHaveLength(1);
    expect(steps.indexOf("tx:ledger:read")).toBeGreaterThan(0);
    expect(steps.indexOf(`-${lock}`)).toBeGreaterThan(
      steps.lastIndexOf("tx:ledger:clear"),
    );
    expect(steps.indexOf(`-${lock}`)).toBe(steps.length - 1);
  });
});

describe("a continuation never recreates the entry of a resolved operation", () => {
  const service = (page: FakePage) =>
    page.session.wipe as unknown as WipeService;

  async function kept() {
    const scene = await twoPagesShowingTheSamePrompt();
    const { f, other, theirs, account, real } = scene;
    const operationId = f.store.records.pending_deletions[account]
      ?.operation_id as string;
    expect(
      await f.runWith(other.session.wipe.resolveConsent(theirs.ticket, "keep")),
    ).toEqual({ kind: "absent" });
    // Keep released the draft fence; work saved afterwards belongs to no prompt.
    real.addDrafts(account, 1);
    real.calls.length = 0;
    return { ...scene, operationId };
  }

  test("a continuation of an entry seen earlier (a fresh sign-in, recovery at boot) finds it gone and does nothing", async () => {
    const { f, l, account, operationId, real } = await kept();
    expect(
      await f.runWith(
        service(l.page).run(account, operationId, { create: "never" }),
      ),
    ).toEqual({ kind: "absent" });
    expect(real.calls).toEqual([]);
    expectKept({ f, real }, account);
    expect(real.drafts(account)).toBe(4);
  });

  test("a confirmed operation's own continuation needs its envelope fence: Keep removed it first, so nothing is created", async () => {
    const { f, l, account, operationId, real } = await kept();
    expect(stateOf(f).fences[account]).toBeUndefined();
    expect(
      await f.runWith(
        service(l.page).run(account, operationId, {
          create: "operation",
          callLease: "lease-that-was-retired",
        }),
      ),
    ).toEqual({ kind: "absent" });
    expectKept({ f, real }, account);
    expect(real.calls).toEqual([`exists:${account}`, `incarnation:${account}`]);
    expect(real.drafts(account)).toBe(4);
  });
});
