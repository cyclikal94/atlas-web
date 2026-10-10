// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  createOutbox,
  type EnqueueOutcome,
  type Outbox,
} from "../../src/data/outbox/outbox";
import { unrevokedHold } from "../../src/session";
import { fakeOrigin } from "../support/data/origin-ledger";
import { outboxWorld } from "../support/data/outbox-world";
import { uuid } from "../support/data/sync-pages";

/**
 * R28 (revision 15): the origin's reserve is kept by the outbox's PUBLIC `enqueue`, across every schedule of the family, over the production
 * plans, the production facade and a shared model of the origin's ledger. The review of revision 14 reproduced it through exactly this seam
 * (separate account databases, so that the serialisation of one database's transactions is not what protects the reserve; a fixed,
 * injected estimate that never reflects a write; one writer held immediately before its transaction; the retained command bodies counted
 * alone, so every header and index byte comes on top):
 *
 *  - a writer outstanding on a healthy ledger while another page's ledger calls fail, saving a smaller write (1,300,000 bytes retained in
 *    room for 1,200,000);
 *  - a degraded writer that a healthy page could not see (the same);
 *  - three independent 900,000-byte saves each losing their ledger calls (2,700,000 in room for 2,000,000);
 *  - a writer already INSIDE its commit when its page is suspended and the lease runs out (3,594,304 bytes left of the 4,194,304-byte floor).
 *
 * A reservation is admitted only on an answer of the ledger, so a failing ledger refuses, and a hold lasts as long as its writer can still write (until the writer's own settlement; when its owner is proven gone, as a landed debit for one estimate lifetime, never as nothing: revision 16). The
 * reviewer's two probe files are preserved byte for byte in `.agtx/evidence/WEB-09a/review-revision-14/`; this file is the same seam
 * with the family widened (asymmetric sizes, more pages, ledger failures that are absorbed, persistent and later recovered) and with the
 * controls that must not change. PROTOCOL evidence: injected estimate and clock and the double of IndexedDB, not native quota and not a
 * real freeze.
 */
const FLOOR = DATA_CONFIG.quotaReserveBytes / 2;
const LEASE = DATA_CONFIG.quotaHoldLeaseMs;
const ATTEMPTS = DATA_CONFIG.quotaLedgerAttempts;

type Account = Awaited<ReturnType<typeof separateAccount>>;

/** One page of the origin with its own account database (so a held transaction in one cannot serialise another). */
async function separateAccount(n: number) {
  const w = await outboxWorld();
  const account = uuid(700 + n);
  w.identity.move({ account, epoch: 1 });
  const runtime = new w.env.modules.accountService.DataRuntime({
    identity: w.identity,
    persistence: { hold: async () => unrevokedHold(() => undefined) },
    registry: w.page.registry,
    open: (a, o) => w.page.open(a, o),
  });
  const opened = await runtime.open(account, { create: true });
  if (opened.kind !== "opened") throw new Error(opened.kind);
  await w.env.settle();
  return {
    ...w,
    service: opened.service,
    drafts: () => w.env.idb.snapshot(`atlas-${account}`)?.drafts ?? [],
  };
}

type EnqueueRequest = Parameters<Outbox["enqueue"]>[0];

const request = (n: number, size: number): EnqueueRequest => ({
  localId: uuid(100 + n),
  endpoint: "/commands",
  targets: [],
  build: () => ({ command: { kind: "create", text: "x".repeat(size) } }),
});

const guardOf = (
  origin: ReturnType<typeof fakeOrigin>,
  name: string,
  free: number,
  clock: { t: number } = { t: 0 },
): QuotaGuard =>
  createQuotaGuard({
    storage: { estimate: async () => ({ usage: 0, quota: free }) },
    now: () => clock.t,
    ledger: origin.page(name).ledger,
  });

const boxOf = (page: Account, quota: QuotaGuard, service = page.service) =>
  createOutbox({
    service,
    quota,
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => 0, iso: () => new Date(0).toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
  });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Holds the page's first draft write at the step just before its transaction, and says when it got there. */
function heldService(page: Account) {
  const entered = deferred();
  const release = deferred();
  let used = false;
  const service = new Proxy(page.service, {
    get(target, key) {
      if (key !== "store") return Reflect.get(target, key, target);
      return new Proxy(target.store, {
        get(store, k) {
          if (k !== "run") return Reflect.get(store, k, store);
          return async (
            plan: { name: string },
            input: unknown,
            ...rest: unknown[]
          ) => {
            if (!used && plan.name === "data.enqueueDraft") {
              used = true;
              entered.resolve();
              await release.promise;
            }
            return (store.run as (...a: unknown[]) => Promise<unknown>)(
              plan,
              input,
              ...rest,
            );
          };
        },
      });
    },
  });
  return { entered, release, service };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Ledger = "healthy" | "absorbed" | "persistent";
type Room = "tight" | "exact" | "roomy";
const SHAPES: ReadonlyArray<{ name: string; sizes: number[] }> = [
  { name: "a larger unseen write", sizes: [900_000, 400_000] },
  { name: "an invisible degraded writer", sizes: [400_000, 900_000] },
  { name: "three pages of one size", sizes: [900_000, 900_000, 900_000] },
  {
    name: "four pages of mixed sizes",
    sizes: [700_000, 300_000, 500_000, 650_000],
  },
  {
    name: "eight small saves",
    sizes: Array.from({ length: 8 }, () => 150_000),
  },
];

/**
 * The room above the floor for a shape: only page 0 fits (so the writer that is held is admitted, and the others compete for what is
 * left), about the bodies' total (headers come on top, so the last page may or may not fit), or ample.
 */
const roomAbove = (sizes: number[], room: Room): number => {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return room === "tight"
    ? (sizes[0] as number) + 100_000
    : room === "exact"
      ? total + 20_000
      : total + 4_000_000;
};

/**
 * Page 0 (healthy) is outstanding, held just before its transaction, while every other page saves in turn. `ledger` is what the OTHER
 * pages' ledger does: nothing, a few rejected calls (fewer than the tries), or none answered at all.
 */
async function schedule(sizes: number[], ledger: Ledger, room: Room) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const above = roomAbove(sizes, room);
  const free = FLOOR + above;
  const origin = fakeOrigin();
  const pages = await Promise.all(sizes.map((_, i) => separateAccount(i)));
  const guards = sizes.map((_, i) => guardOf(origin, String(i), free));
  for (let i = 1; i < sizes.length; i += 1) {
    if (ledger === "absorbed") origin.fail(String(i), ATTEMPTS - 1);
    if (ledger === "persistent") origin.fail(String(i), 1_000);
  }
  const held = heldService(pages[0] as Account);
  const first = boxOf(
    pages[0] as Account,
    guards[0] as QuotaGuard,
    held.service,
  ).enqueue(request(0, sizes[0] as number));
  await held.entered.promise;
  const outcomes: EnqueueOutcome[] = [];
  for (let i = 1; i < sizes.length; i += 1) {
    const asked = boxOf(pages[i] as Account, guards[i] as QuotaGuard).enqueue(
      request(i, sizes[i] as number),
    );
    await vi.advanceTimersByTimeAsync(30 * DATA_CONFIG.quotaLedgerWaitMs);
    outcomes.push(await asked);
  }
  held.release.resolve();
  outcomes.unshift(await first);
  await vi.advanceTimersByTimeAsync(0);
  const kept = pages.map((page, i) =>
    page.drafts().length > 0 ? (sizes[i] as number) : 0,
  );
  return { outcomes, kept, free, above, origin };
}

describe("the reserve holds through the public `enqueue`, for every size, page count and ledger condition", () => {
  for (const shape of SHAPES)
    for (const ledger of ["healthy", "absorbed", "persistent"] as Ledger[])
      for (const room of ["tight", "exact", "roomy"] as Room[])
        test(`${shape.name}; ledger ${ledger}; room ${room}`, async () => {
          const { outcomes, kept, free } = await schedule(
            shape.sizes,
            ledger,
            room,
          );
          const retained = kept.reduce((sum, size) => sum + size, 0);
          const seen = JSON.stringify({
            outcomes: outcomes.map((outcome) => outcome.kind),
            kept,
          });
          // THE GUARANTEE: the bodies alone leave the origin above the input floor, whatever each page's ledger did.
          expect(free - retained, seen).toBeGreaterThanOrEqual(FLOOR);
          // What is reported queued is what is stored, and nothing refused was written.
          outcomes.forEach((outcome, i) => {
            expect(outcome.kind === "queued", `page ${i}: ${seen}`).toBe(
              (kept[i] as number) > 0,
            );
          });
          if (ledger === "persistent") {
            // A page whose ledger never answers admits nothing, whatever the room: refused for the quota.
            for (let i = 1; i < shape.sizes.length; i += 1)
              expect(outcomes[i], `page ${i}`).toEqual({
                kind: "refused",
                reason: "quota",
              });
            expect(outcomes[0]?.kind).toBe("queued");
          } else if (room === "roomy") {
            // Generous space and a ledger that answered: every page is queued (user input is not refused for no reason).
            for (const outcome of outcomes) expect(outcome.kind).toBe("queued");
          }
        });

  for (const shape of SHAPES)
    for (const room of ["tight", "exact", "roomy"] as Room[])
      test(`${shape.name}; room ${room}: a few rejected calls cost nothing of the origin-wide judgement (the outcome equals the healthy ledger's, page by page)`, async () => {
        const healthy = await schedule(shape.sizes, "healthy", room);
        const absorbed = await schedule(shape.sizes, "absorbed", room);
        expect(absorbed.outcomes.map((outcome) => outcome.kind)).toEqual(
          healthy.outcomes.map((outcome) => outcome.kind),
        );
        expect(absorbed.kept).toEqual(healthy.kept);
      });

  test("the control: every page healthy, room for one: the first is queued, and the others are refused for want of space", async () => {
    const origin = fakeOrigin();
    const free = FLOOR + 1_200_000;
    const pages = await Promise.all([separateAccount(0), separateAccount(1)]);
    const held = heldService(pages[0] as Account);
    const first = boxOf(
      pages[0] as Account,
      guardOf(origin, "0", free),
      held.service,
    ).enqueue(request(0, 900_000));
    await held.entered.promise;
    const second = await boxOf(
      pages[1] as Account,
      guardOf(origin, "1", free),
    ).enqueue(request(1, 900_000));
    held.release.resolve();
    expect((await first).kind).toBe("queued");
    expect(second).toEqual({ kind: "refused", reason: "quota" });
    expect((pages[1] as Account).drafts()).toHaveLength(0);
  });
});

describe("degraded-to-healthy: a page whose ledger fails and then answers again, with a writer outstanding throughout", () => {
  test("it is refused while the failures last, and judged exactly (against what is outstanding) the moment the ledger answers: no promise of its own is left invisible", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const origin = fakeOrigin();
    const free = FLOOR + 1_200_000;
    const pages = await Promise.all([separateAccount(0), separateAccount(1)]);
    const held = heldService(pages[0] as Account);
    const first = boxOf(
      pages[0] as Account,
      guardOf(origin, "0", free),
      held.service,
    ).enqueue(request(0, 900_000));
    await held.entered.promise;
    const box = boxOf(pages[1] as Account, guardOf(origin, "1", free));
    origin.fail("1", 1_000);
    const refused = box.enqueue(request(1, 100_000));
    await vi.advanceTimersByTimeAsync(30 * DATA_CONFIG.quotaLedgerWaitMs);
    // Revision 14 admitted these 100,000 bytes on the page's own accounting, which no other page could see.
    expect(await refused).toEqual({ kind: "refused", reason: "quota" });
    expect((pages[1] as Account).drafts()).toHaveLength(0);
    // The ledger answers again: the same page is judged by the origin, with the outstanding 900,000 counted. 400,000 does not fit beside
    // it; 100,000 does.
    origin.heal("1");
    expect(await box.enqueue(request(2, 400_000))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect((await box.enqueue(request(3, 100_000))).kind).toBe("queued");
    held.release.resolve();
    expect((await first).kind).toBe("queued");
    const retained = 900_000 + 100_000;
    expect(free - retained).toBeGreaterThanOrEqual(FLOOR);
  });
});

describe("a writer already inside its commit when its page is suspended and the lease runs out (the review's schedule)", () => {
  /** A's draft write is stalled at the commit (`stall_commit`), the clock moves, B saves into the room the lapsed hold had counted. */
  async function stalled(options: {
    expired: boolean;
    roomy: boolean;
    delaySettlement?: boolean;
  }) {
    const a = await separateAccount(0);
    const b = await separateAccount(1);
    const origin = fakeOrigin();
    const clock = { t: 0 };
    const free = FLOOR + (options.roomy ? 2_500_000 : 1_200_000);
    const qa = guardOf(origin, "a", free, clock);
    const qb = guardOf(origin, "b", free, clock);
    a.env.idb.inject({
      match: (tx: { label?: string }) => tx.label === "data.enqueueDraft",
      mode: "stall_commit",
      times: 1,
    });
    const first = boxOf(a, qa).enqueue(request(500, 900_000));
    await a.env.settle();
    const name = `atlas-${a.service.account}`;
    expect(a.env.idb.hasStalledCommit(name)).toBe(true);
    expect(a.drafts()).toHaveLength(0);
    // The writer's plan already checked `live()`; its page is suspended; the other page's clock advances without running its timers.
    clock.t = options.expired ? LEASE + 1 : 1;
    const settlement = options.delaySettlement ? origin.delay("a") : undefined;
    const second = await boxOf(b, qb).enqueue(request(501, 900_000));
    expect(a.env.idb.completeStalled(name)).toBe(true);
    await a.env.settle();
    const one = await first;
    return { a, b, origin, one, second, free, clock, qb, settlement };
  }

  for (const expired of [false, true])
    for (const roomy of [false, true])
      test(`lease ${expired ? "expired" : "standing"}; room ${roomy ? "for both" : "for one"}: the origin stays above the floor, and with room for both both are queued`, async () => {
        const { a, b, one, second, free } = await stalled({ expired, roomy });
        const retained = (a.drafts().length + b.drafts().length) * 900_000;
        expect(free - retained).toBeGreaterThanOrEqual(FLOOR);
        if (roomy)
          expect([one.kind, second.kind]).toEqual(["queued", "queued"]);
        else expect([one.kind, second.kind]).toEqual(["queued", "refused"]);
      });

  test("the completion notification is delayed (the write landed, its settlement has not reached the ledger): the other page is still refused, before and after it does", async () => {
    const { a, b, origin, one, second, free, clock, qb, settlement } =
      await stalled({ expired: true, roomy: false, delaySettlement: true });
    expect([one.kind, second.kind]).toEqual(["queued", "refused"]);
    // However far the clock moves, the hold stands while its settlement is on its way: the owner has not let go.
    clock.t = 50 * LEASE;
    expect(await boxOf(b, qb).enqueue(request(502, 900_000))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect(origin.claimed()).toHaveLength(1);
    // The settlement arrives: the bytes are in the ledger of writes the estimate may not show, and the owner lets go.
    settlement?.release();
    await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
    // The bound the facade reserved (the body and its header), which is at least the body.
    expect(origin.state().landed?.landed).toBeGreaterThanOrEqual(900_000);
    expect(await boxOf(b, qb).enqueue(request(503, 900_000))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    const retained = (a.drafts().length + b.drafts().length) * 900_000;
    expect(free - retained).toBeGreaterThanOrEqual(FLOOR);
  });
});

/**
 * R28 (revision 16): the review of revision 15 reproduced two more schedules through exactly this seam (distinct account databases, a
 * fixed injected estimate that never shows a write, the production plans and facade, one writer stalled INSIDE its commit).
 *
 *  - The completed write whose settlement fails: A's save lands, exactly its two settlement ledger calls fail, its lock is released, and a
 *    healthy page B saves a second body (1,800,000 bytes retained in room for 1,200,000: 3,594,304 left of the 4,194,304-byte floor).
 *  - The unfinished commit at the maximum age: A is in `stall_commit`, the clock moves the production `quotaHoldMaxAgeMs` (600,000 ms), the
 *    real renewal tick fires, and B saves into the room (the same 3,594,304).
 *
 * The production constants are unchanged; only the guard's timers are faked (as in `schedule()` above), so the renewal tick of a third of
 * a lease fires when the fake time advances and the clock the guard reads is the test's.
 */
describe("R28 revision 16: the public reserve holds for a completed write whose settlement fails, and for a commit that outlives the maximum age", () => {
  async function stalledWrite(options: {
    aged?: boolean;
    failSettlement?: number;
    roomy: boolean;
  }) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const a = await separateAccount(0);
    const b = await separateAccount(1);
    const origin = fakeOrigin();
    const clock = { t: 0 };
    const free = FLOOR + (options.roomy ? 2_500_000 : 1_200_000);
    const qa = guardOf(origin, "a", free, clock);
    const qb = guardOf(origin, "b", free, clock);
    a.env.idb.inject({
      match: (tx: { label?: string }) => tx.label === "data.enqueueDraft",
      mode: "stall_commit",
      times: 1,
    });
    const first = boxOf(a, qa).enqueue(request(600, 900_000));
    await a.env.settle();
    const name = `atlas-${a.service.account}`;
    expect(a.env.idb.hasStalledCommit(name)).toBe(true);
    expect(a.drafts()).toHaveLength(0);
    if (options.aged !== undefined) {
      // The writer's plan has read `live()` (it began): the production age, and the real renewal tick that used to untrack the hold.
      clock.t = options.aged ? DATA_CONFIG.quotaHoldMaxAgeMs : LEASE;
      await vi.advanceTimersByTimeAsync(Math.floor(LEASE / 3) + 100);
      expect(a.env.idb.hasStalledCommit(name)).toBe(true);
    }
    return { a, b, origin, first, free, clock, qa, qb, name };
  }

  for (const aged of [false, true])
    for (const roomy of [false, true])
      test(`the unfinished commit; ${aged ? "at the production maximum age" : "at the lease (the control)"}; room ${roomy ? "for both" : "for one"}: the origin stays above the floor, and with room for both both are queued`, async () => {
        const { a, b, origin, first, free, qb, name } = await stalledWrite({
          aged,
          roomy,
        });
        const second = await boxOf(b, qb).enqueue(request(601, 900_000));
        expect(a.env.idb.completeStalled(name)).toBe(true);
        await a.env.settle();
        const one = await first;
        const retained = (a.drafts().length + b.drafts().length) * 900_000;
        expect(free - retained).toBeGreaterThanOrEqual(roomy ? 0 : FLOOR);
        if (roomy)
          expect([one.kind, second.kind]).toEqual(["queued", "queued"]);
        else expect([one.kind, second.kind]).toEqual(["queued", "refused"]);
        // The hold, its owner and its renewals stood throughout, and became the landed debit when the commit completed.
        await vi.advanceTimersByTimeAsync(0);
        expect(origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(
          900_000,
        );
      });

  for (const failSettlement of [0, 2, 1_000])
    for (const roomy of [false, true])
      test(`the completed write; ${failSettlement === 0 ? "a healthy settlement (the control)" : failSettlement === 2 ? "two settlement calls rejected (the review's schedule)" : "every settlement call rejected until the ledger heals"}; room ${roomy ? "for both" : "for one"}`, async () => {
        const { a, b, origin, first, free, qb, name } = await stalledWrite({
          roomy,
        });
        if (failSettlement > 0) origin.fail("a", failSettlement);
        expect(a.env.idb.completeStalled(name)).toBe(true);
        await a.env.settle();
        const one = await first;
        // The reviewer's step: wait until the first page's lock is gone... or, when its settlement keeps failing, until it has been offered.
        if (failSettlement === 2)
          await vi.advanceTimersByTimeAsync(DATA_CONFIG.quotaLedgerRetryMs * 2);
        const second = await boxOf(b, qb).enqueue(request(601, 900_000));
        const retained = (a.drafts().length + b.drafts().length) * 900_000;
        expect(
          free - retained,
          JSON.stringify({ one, second }),
        ).toBeGreaterThanOrEqual(roomy ? 0 : FLOOR);
        if (roomy)
          expect([one.kind, second.kind]).toEqual(["queued", "queued"]);
        else expect([one.kind, second.kind]).toEqual(["queued", "refused"]);
        origin.heal("a");
        await vi.advanceTimersByTimeAsync(DATA_CONFIG.quotaLedgerWaitMs);
        expect(origin.state().holds).toEqual({});
        expect(origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(
          900_000,
        );
      });
});
