// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { WipeService } from "../../src/session/kernel/wipe";
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
 * F-CONSENT-LOCK-*: the renewed-consent choice is part of the account's ONE critical section (WEB-04 7.8, F5: "every code
 * path that could touch `atlas-pending-deletions:{account_id}`, call `deleteDatabase()` ... first acquires
 * `atlas-delete:<account>` and performs the ENTIRE sequence inside that one held lock"; reconciliation trace 7 step 7; plan
 * 7.11). Before this, the choice read and validated the ledger entry OUTSIDE the lock, ignored a refused status update, and
 * the Delete branch then re-entered the procedure, which RECREATED a missing entry as `pending` before taking the lock. With
 * two pages showing the same prompt, a page that had captured the entry before the other page's "Keep for now" completed
 * could therefore delete the database the person had just chosen to keep, together with work saved after that choice.
 *
 * Two pages show the prompt of one account. The fake-world schedules below hold exactly the deliveries the review held.
 */
const deletes = (f: Fixture) =>
  f.data.calls.filter((call) => call.startsWith("delete:"));
const callsOf = (f: Fixture, name: string, account: string) =>
  f.data.calls.filter((call) => call === `${name}:${account}`);

function promptOf(page: FakePage) {
  const view = page.session.view.get();
  if (view.kind !== "neutral" || !view.consent)
    throw new Error(`no consent prompt is showing: ${JSON.stringify(view)}`);
  return view.consent;
}

/** Whether a promise has settled yet (the world is driven by the test, so this is a question about the schedule). */
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

/**
 * A confirmed logout whose local work changed after the confirmation: the account is left awaiting renewed consent, and a
 * second page of the same origin shows the same prompt.
 */
async function twoPagesShowingTheSamePrompt() {
  const f = await newWorld();
  const l: SignedIn = await signedInPage(f);
  const account = l.account;
  f.data.databases.set(account, { incarnation: "inc-original" });
  f.data.work.set(account, { count: 3, digest: "old" });
  f.data.liveDigests.set(account, "confirmed");
  await f.runWith(
    l.page.session.operations.logout({
      unsynced: { count: 3, items: [], digest: "old" },
    }),
  );
  await f.settle();
  expect(f.store.records.pending_deletions[account]?.status).toBe(
    "awaiting_consent",
  );
  const other = await openPage(f);
  await f.settle();
  return {
    f,
    l,
    other,
    account,
    mine: promptOf(l.page),
    theirs: promptOf(other),
  };
}

/** What "Keep for now" leaves behind: no envelope, no draft fence, no ledger entry, and the database retained. */
function expectKept(f: Fixture, account: string) {
  expect(f.store.records.pending_deletions[account]).toBeUndefined();
  expect(stateOf(f).fences[account]).toBeUndefined();
  expect(f.data.draftFences.has(account)).toBe(false);
  expect(f.data.databases.has(account)).toBe(true);
  expect(deletes(f)).toEqual([]);
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

describe("a choice waits for the account's critical section and is decided after it", () => {
  test("a Delete whose ledger read is delayed holds the lock: the other page's Keep is queued behind it, and is refused once the deletion has finished", async () => {
    const { f, l, other, account, mine, theirs } =
      await twoPagesShowingTheSamePrompt();
    holdFor(f, l.page, "ledger:read");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    await f.world.runUntilIdle();
    expect(f.world.heldCount("D0")).toBe(1);

    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    const kept = watch(keeping);
    await f.world.runUntilIdle();
    // Keep has not begun: the critical section is held by the Delete, whose read result has not arrived.
    expect(kept.done).toBe(false);
    expect(callsOf(f, "releaseFence", account)).toEqual([]);
    expect(f.store.records.pending_deletions[account]?.status).toBe(
      "awaiting_consent",
    );
    expect(stateOf(f).fences[account]).toBeDefined();

    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(deleting)).toEqual({ kind: "deleted" });
    // The queued Keep is validated only NOW, against a ledger with no entry: nothing is applied and nothing is recreated.
    expect(await f.runWith(keeping)).toEqual({ kind: "prompt_superseded" });
    expect(deletes(f)).toEqual([`delete:${account}`]);
    expect(callsOf(f, "releaseFence", account)).toEqual([]);
    expect(f.store.records.pending_deletions[account]).toBeUndefined();
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same when it is the Delete's STATUS change whose completion is delayed (the approval is already committed)", async () => {
    const { f, l, other, account, mine, theirs } =
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
    expect(callsOf(f, "releaseFence", account)).toEqual([]);
    // The approval stands and is not undone by the queued choice.
    expect(f.store.records.pending_deletions[account]?.status).toBe(
      "deletion_approved",
    );

    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(deleting)).toEqual({ kind: "deleted" });
    expect(await f.runWith(keeping)).toEqual({ kind: "prompt_superseded" });
    expect(deletes(f)).toEqual([`delete:${account}`]);
    expect(f.store.records.pending_deletions[account]).toBeUndefined();
    expect(checkProperties(f)).toEqual([]);
  });

  test("work saved while the Delete waited is NOT deleted: the approval covers the set the person saw, so the prompt is renewed and the queued Keep is refused as superseded", async () => {
    const { f, l, other, account, mine, theirs } =
      await twoPagesShowingTheSamePrompt();
    holdFor(f, l.page, "ledger:status");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    await f.world.runUntilIdle();
    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    await f.world.runUntilIdle();
    // New work arrives after the approval, before the deletion would run (step 3a compares against the approved digest).
    f.data.work.set(account, { count: 4, digest: "saved-meanwhile" });
    f.data.liveDigests.set(account, "saved-meanwhile");
    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(deleting)).toEqual({
      kind: "awaiting_consent",
      count: 4,
    });
    // Keep was made on the previous prompt: it is refused, and does not silently cover the renewed one.
    expect(await f.runWith(keeping)).toEqual({ kind: "prompt_superseded" });
    expect(deletes(f)).toEqual([]);
    expect(f.data.databases.has(account)).toBe(true);
    expect(f.store.records.pending_deletions[account]).toMatchObject({
      status: "awaiting_consent",
      digest: "saved-meanwhile",
    });
    // The renewed prompt can be answered: Keep now, with the new ticket, retains everything.
    expect(
      await f.runWith(
        l.page.session.wipe.resolveConsent(promptOf(l.page).ticket, "keep"),
      ),
    ).toEqual({ kind: "absent" });
    expectKept(f, account);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a Keep holds the lock through its three writes: a Delete made meanwhile finds nothing to delete, recreates nothing, and the work saved after Keep survives", async () => {
    const { f, l, other, account, mine, theirs } =
      await twoPagesShowingTheSamePrompt();
    holdFor(f, other, "ledger:clear");
    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    const kept = watch(keeping);
    await f.world.runUntilIdle();
    // All three writes are committed; only the completion of the last one has not been delivered, so the lock is still held.
    expect(f.world.heldCount("D0")).toBe(1);
    expect(kept.done).toBe(false);
    expect(callsOf(f, "releaseFence", account)).toHaveLength(1);
    // The released draft fence has no baseline any more, and the person saves new work that neither prompt covered.
    f.data.baselineDigests.set(account, null);
    f.data.work.set(account, { count: 4, digest: "new-after-keep" });
    f.data.liveDigests.set(account, "new-after-keep");
    const callsBefore = f.data.calls.length;

    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    const deleteDone = watch(deleting);
    await f.world.runUntilIdle();
    expect(deleteDone.done).toBe(false); // queued on the same lock

    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(keeping)).toEqual({ kind: "absent" });
    expect(await f.runWith(deleting)).toEqual({ kind: "prompt_superseded" });
    // No second procedure ran: no existence probe, no closure, no delete; the new work is intact; nothing was recreated.
    expect(f.data.calls.slice(callsBefore)).toEqual([]);
    expect(f.data.work.get(account)).toEqual({
      count: 4,
      digest: "new-after-keep",
    });
    expectKept(f, account);
    expect(l.page.session.view.get().kind).not.toBe("neutral");
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("the change is committed only against the entry the person answered", () => {
  test("a status update refused because the entry was resolved meanwhile is `prompt_superseded`: nothing is recreated or deleted, and the newly retained work survives", async () => {
    const { f, l, account, mine } = await twoPagesShowingTheSamePrompt();
    holdFor(f, l.page, "ledger:read");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    await f.world.runUntilIdle();
    expect(f.world.heldCount("D0")).toBe(1);
    // A writer that does NOT take the lock (another build of the page, or a defect) resolves the operation exactly as "Keep
    // for now" would, while the read result is in flight. The commit must still refuse the change on its own.
    delete f.store.records.pending_deletions[account];
    delete f.store.records.auth_state.fences[account];
    f.data.draftFences.delete(account);
    f.data.baselineDigests.set(account, null);
    f.data.work.set(account, { count: 4, digest: "new-after-keep" });
    f.data.liveDigests.set(account, "new-after-keep");
    const callsBefore = f.data.calls.length;

    f.world.clearKnobs();
    f.world.release("D0");
    expect(await f.runWith(deleting)).toEqual({ kind: "prompt_superseded" });
    expect(f.data.calls.slice(callsBefore)).toEqual([]);
    expect(f.store.records.pending_deletions[account]).toBeUndefined();
    expect(f.data.databases.has(account)).toBe(true);
    expect(f.data.work.get(account)?.count).toBe(4);
    expect(deletes(f)).toEqual([]);
  });

  test("a status update refused because the entry was replaced by a renewed prompt applies nothing to it", async () => {
    const { f, l, account, mine } = await twoPagesShowingTheSamePrompt();
    holdFor(f, l.page, "ledger:read");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    await f.world.runUntilIdle();
    // The entry the read captured is replaced (same operation, renewed digest) before the approval is committed.
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
    expect(deletes(f)).toEqual([]);
    expect(f.data.databases.has(account)).toBe(true);
  });
});

describe("the procedure's own renewal of the prompt is committed the same way", () => {
  test("an entry resolved while the procedure measured the live work is not claimed as awaiting consent", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const account = l.account;
    f.data.databases.set(account, { incarnation: "inc-1" });
    f.data.work.set(account, { count: 2, digest: "d2" });
    f.data.liveDigests.set(account, "d3"); // changed since the confirmation: the prompt would be renewed
    const ports = l.page.kernel.ports.deletion;
    const real = ports.coordination.liveDigest.bind(ports.coordination);
    ports.coordination.liveDigest = async (a) => {
      const digest = await real(a);
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
    expect(deletes(f)).toEqual([]);
    expect(f.data.databases.has(account)).toBe(true);
  });
});

describe("two pages choosing at the same time", () => {
  test("Delete then Keep: the first issued wins, the other is refused, and exactly one outcome is applied", async () => {
    const { f, l, other, account, mine, theirs } =
      await twoPagesShowingTheSamePrompt();
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    const [deleted, kept] = await Promise.all([
      f.runWith(deleting),
      f.runWith(keeping),
    ]);
    expect(deleted).toEqual({ kind: "deleted" });
    expect(kept).toEqual({ kind: "prompt_superseded" });
    expect(deletes(f)).toEqual([`delete:${account}`]);
    expect(callsOf(f, "releaseFence", account)).toEqual([]);
    expect(f.store.records.pending_deletions[account]).toBeUndefined();
    expect(checkProperties(f)).toEqual([]);
  });

  test("Keep then Delete: the first issued wins, the other is refused, and the database is retained", async () => {
    const { f, l, other, account, mine, theirs } =
      await twoPagesShowingTheSamePrompt();
    const keeping = other.session.wipe.resolveConsent(theirs.ticket, "keep");
    const deleting = l.page.session.wipe.resolveConsent(mine.ticket, "delete");
    const [kept, deleted] = await Promise.all([
      f.runWith(keeping),
      f.runWith(deleting),
    ]);
    expect(kept).toEqual({ kind: "absent" });
    expect(deleted).toEqual({ kind: "prompt_superseded" });
    expectKept(f, account);
    expect(callsOf(f, "releaseFence", account)).toHaveLength(1);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same choice on both pages is applied once", async () => {
    for (const choice of ["delete", "keep"] as const) {
      const { f, l, other, account, mine, theirs } =
        await twoPagesShowingTheSamePrompt();
      const first = l.page.session.wipe.resolveConsent(mine.ticket, choice);
      const second = other.session.wipe.resolveConsent(theirs.ticket, choice);
      const outcomes = await Promise.all([f.runWith(first), f.runWith(second)]);
      expect(outcomes[1]).toEqual({ kind: "prompt_superseded" });
      if (choice === "delete") {
        expect(outcomes[0]).toEqual({ kind: "deleted" });
        expect(deletes(f)).toEqual([`delete:${account}`]);
      } else {
        expect(outcomes[0]).toEqual({ kind: "absent" });
        expect(callsOf(f, "releaseFence", account)).toHaveLength(1);
        expectKept(f, account);
      }
      expect(checkProperties(f)).toEqual([]);
    }
  });
});

describe("the lock is taken once, before anything is read, and released only at the end", () => {
  /** This page's lock grants and releases, and the store transactions it created, in order. */
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

  test("Delete: one acquisition of atlas-delete, taken before the ledger is read; atlas-auth only inside it", async () => {
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
  /** Run the procedure the way the kernel's own callers do; the public `Wipe` type only offers the direct entry. */
  const service = (page: FakePage) =>
    page.session.wipe as unknown as WipeService;

  async function kept() {
    const scene = await twoPagesShowingTheSamePrompt();
    const { f, other, theirs, account } = scene;
    const operationId = f.store.records.pending_deletions[account]
      ?.operation_id as string;
    expect(
      await f.runWith(other.session.wipe.resolveConsent(theirs.ticket, "keep")),
    ).toEqual({ kind: "absent" });
    // Keep released the draft fence; work saved afterwards belongs to no prompt.
    f.data.baselineDigests.set(account, null);
    f.data.work.set(account, { count: 4, digest: "new-after-keep" });
    f.data.liveDigests.set(account, "new-after-keep");
    f.data.calls.length = 0;
    return { ...scene, operationId };
  }

  test("a continuation of an entry seen earlier (a fresh sign-in, recovery at boot) finds it gone and does nothing", async () => {
    const { f, l, account, operationId } = await kept();
    expect(
      await f.runWith(
        service(l.page).run(account, operationId, { create: "never" }),
      ),
    ).toEqual({ kind: "absent" });
    expect(f.data.calls).toEqual([]);
    expectKept(f, account);
  });

  test("a confirmed operation's own continuation needs its envelope fence: Keep removed it first, so nothing is created", async () => {
    const { f, l, account, operationId } = await kept();
    expect(stateOf(f).fences[account]).toBeUndefined();
    expect(
      await f.runWith(
        service(l.page).run(account, operationId, {
          create: "operation",
          callLease: "lease-that-was-retired",
        }),
      ),
    ).toEqual({ kind: "absent" });
    expectKept(f, account);
    // Only the read-only probes that stamp an incarnation onto a NEW entry ran, before the creating transaction refused it:
    // no closure, no draft-fence call, no deletion, nothing recorded.
    expect(f.data.calls).toEqual([
      `exists:${account}`,
      `incarnation:${account}`,
    ]);
  });
});
