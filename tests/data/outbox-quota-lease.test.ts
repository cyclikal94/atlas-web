// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createQuotaGuard,
  type QuotaGuard,
  type QuotaReservation,
} from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { createOutbox, type Outbox } from "../../src/data/outbox/outbox";
import {
  editQueuedDraft,
  enqueueDraft,
  supersedeDraft,
} from "../../src/data/plans/outbox";
import { fakeOrigin } from "../support/data/origin-ledger";
import { outboxWorld } from "../support/data/outbox-world";
import { uuid } from "../support/data/sync-pages";

/**
 * R28 (revision 14): a save whose hold ended before its transaction began writes nothing and is admitted again, through the public
 * outbox over the production plans and the origin's ledger model.
 *
 * The review's schedule: the first public save is held immediately before its store transaction, the clock moves 30,001 ms (the
 * production lease constant, not a shortened one), a second save is admitted into the room the lapsed hold had counted, and then the
 * first is released: both 900,000-byte bodies were written and 3,594,304 bytes were left of a 4,194,304-byte floor. Counting the late
 * write when it lands cannot undo the second admission, so the first write's permission to begin has to end with its hold. FIXTURE
 * evidence: a controlled delayed write, not a real browser freeze.
 */
const FLOOR = DATA_CONFIG.quotaReserveBytes / 2;
const LEASE = DATA_CONFIG.quotaHoldLeaseMs;
const THIRD = Math.floor(LEASE / 3);
const BODY = 900_000;
const OLD = uuid(50);

type World = Awaited<ReturnType<typeof outboxWorld>>;
type Path = "enqueue" | "edit" | "supersede";
const PATHS: Path[] = ["enqueue", "edit", "supersede"];
const PLAN: Record<Path, string> = {
  enqueue: "data.enqueueDraft",
  edit: "data.editQueuedDraft",
  supersede: "data.supersedeDraft",
};

interface Clock {
  t: number;
}

const request = (id: string, size = BODY): EnqueueRequest => ({
  localId: id,
  endpoint: "/commands",
  targets: [],
  build: () => ({ command: { kind: "create", text: "x".repeat(size) } }),
});

/** A page's outbox over the world's database, with its own guard on the origin's ledger. */
function page(
  w: World,
  origin: ReturnType<typeof fakeOrigin>,
  name: string,
  free: number,
  clock: Clock,
  hold?: { enters: () => void; gate: Promise<void>; plan: string },
): { outbox: Outbox; guard: QuotaGuard } {
  const guard = createQuotaGuard({
    storage: { estimate: async () => ({ usage: 0, quota: free }) },
    now: () => clock.t,
    ledger: origin.page(name).ledger,
  });
  // The page's transaction is held immediately before it begins (the review's pause), for the one plan it names.
  const service = hold
    ? new Proxy(w.service, {
        get(target, key) {
          if (key !== "store") return Reflect.get(target, key, target);
          return new Proxy(target.store, {
            get(store, member) {
              if (member !== "run") return Reflect.get(store, member, store);
              return async (plan: { name: string }, ...rest: unknown[]) => {
                if (plan.name === hold.plan) {
                  hold.enters();
                  await hold.gate;
                }
                return (store.run as (...a: unknown[]) => unknown)(
                  plan,
                  ...rest,
                );
              };
            },
          });
        },
      })
    : w.service;
  const outbox = createOutbox({
    service,
    quota: guard,
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => 0, iso: () => new Date(0).toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
  });
  return { outbox, guard };
}

/** A queued small draft under `OLD` (for the edit and supersede paths), in a conflict when it is to be superseded. */
async function seeded(w: World, path: Path): Promise<void> {
  if (path === "enqueue") return;
  expect((await w.outbox.enqueue(request(OLD, 100))).kind).toBe("queued");
  if (path === "supersede")
    w.put("drafts", [{ ...w.drafts()[0], status: "version_conflict" }]);
}

const startFirst = (
  path: Path,
  outbox: Outbox,
  id: string,
): Promise<{ kind: string }> =>
  path === "enqueue"
    ? outbox.enqueue(request(id))
    : path === "edit"
      ? outbox.editQueued(OLD, request(OLD))
      : outbox.supersede(OLD, request(id));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the review's schedule: a live save outlasting its lease, on every growth path", () => {
  for (const path of PATHS)
    for (const expired of [false, true])
      for (const roomy of [false, true])
        test(`${path}: the lease ${expired ? "ran out (clock +30,001 ms)" : "stands"}, ${roomy ? "room for both" : "room for one"}: ${
          roomy || !expired
            ? roomy
              ? "both are written"
              : "only the first is written"
            : "only one is written"
        }`, async () => {
          const w = await outboxWorld();
          await seeded(w, path);
          const origin = fakeOrigin();
          const clock: Clock = { t: 0 };
          const free = FLOOR + (roomy ? 2_500_000 : 1_200_000);
          let enters!: () => void;
          let release!: () => void;
          const entered = new Promise<void>((resolve) => {
            enters = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const a = page(w, origin, "A", free, clock, {
            enters,
            gate,
            plan: PLAN[path],
          });
          const b = page(w, origin, "B", free, clock);
          const rowsBefore = w.drafts().length;
          const first = startFirst(path, a.outbox, uuid(51));
          await entered;
          clock.t = expired ? LEASE + 1 : 1;
          const second = await b.outbox.enqueue(request(uuid(52)));
          release();
          const one = await first;
          const written = [one, second].filter(
            (outcome) => outcome.kind !== "refused",
          );
          // An enqueue adds a row; an edit rewrites the one it had and a supersession replaces it: the second save is the only one that
          // adds a row on those paths.
          const added = w.drafts().length - rowsBefore;
          expect(written).toHaveLength(roomy ? 2 : 1);
          expect(added).toBe(
            path === "enqueue"
              ? written.length
              : Number(second.kind === "queued"),
          );
          if (!roomy)
            expect(
              [one, second].find((outcome) => outcome.kind === "refused"),
            ).toEqual({ kind: "refused", reason: "quota" });
          // Whatever was written, the origin kept the headroom: the bodies written leave at least the floor.
          expect(free - written.length * BODY).toBeGreaterThanOrEqual(
            roomy ? 0 : FLOOR,
          );
        });
});

describe("a live save that is merely slow keeps its hold, so no other page is admitted into its room", () => {
  for (const path of PATHS)
    test(`${path}: the save waits three leases before its transaction; the guard renews, the other page is refused, and the save is written`, async () => {
      // Only the timers and the date are faked: the database double runs on the rest.
      const w = await outboxWorld();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await seeded(w, path);
      const origin = fakeOrigin();
      const clock: Clock = {
        get t() {
          return Date.now();
        },
        set t(_value: number) {
          throw new Error("moved by the timers");
        },
      };
      const free = FLOOR + 1_200_000;
      let enters!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enters = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const a = page(w, origin, "A", free, clock, {
        enters,
        gate,
        plan: PLAN[path],
      });
      const b = page(w, origin, "B", free, clock);
      const first = startFirst(path, a.outbox, uuid(51));
      await entered;
      for (let i = 0; i < 9; i += 1) await vi.advanceTimersByTimeAsync(THIRD);
      const second = await b.outbox.enqueue(request(uuid(52)));
      expect(second).toEqual({ kind: "refused", reason: "quota" });
      release();
      expect((await first).kind).not.toBe("refused");
      await vi.advanceTimersByTimeAsync(0);
      // The settlement removed the hold and the timer.
      expect(origin.state().holds).toEqual({});
      expect(vi.getTimerCount()).toBe(0);
    });
});

describe("the plans write nothing for a hold that ended, and say so", () => {
  const exec = (w: World, plan: unknown, over: object): Promise<unknown> =>
    w.service.store.run(
      plan as never,
      { ...over, incarnationId: w.service.incarnationId } as never,
    );
  const NOW = "2026-10-04T10:00:00.000Z";
  const inputs = (path: Path, leaseLive: (() => boolean) | undefined) =>
    path === "enqueue"
      ? [
          enqueueDraft,
          {
            request: request(uuid(60)),
            localId: uuid(60),
            accountId: "11111111-1111-4111-8111-111111111111",
            now: NOW,
            maxBytes: 10_000_000,
            ...(leaseLive ? { leaseLive } : {}),
          },
        ]
      : path === "edit"
        ? [
            editQueuedDraft,
            {
              localId: OLD,
              request: request(OLD),
              maxBytes: 10_000_000,
              ...(leaseLive ? { leaseLive } : {}),
            },
          ]
        : [
            supersedeDraft,
            {
              oldLocalId: OLD,
              request: request(uuid(60)),
              localId: uuid(60),
              accountId: "11111111-1111-4111-8111-111111111111",
              now: NOW,
              maxBytes: 10_000_000,
              ...(leaseLive ? { leaseLive } : {}),
            },
          ];

  for (const path of PATHS) {
    test(`${path}: a hold that is no longer live: lease_lapsed, nothing written`, async () => {
      const w = await outboxWorld();
      await seeded(w, path);
      const before = JSON.stringify(w.snapshot());
      const [plan, input] = inputs(path, () => false) as [unknown, object];
      expect(await exec(w, plan, input)).toEqual({ kind: "lease_lapsed" });
      expect(JSON.stringify(w.snapshot())).toBe(before);
    });

    test(`${path}: the control: a live hold writes`, async () => {
      const w = await outboxWorld();
      await seeded(w, path);
      const [plan, input] = inputs(path, () => true) as [unknown, object];
      const result = (await exec(w, plan, input)) as { kind: string };
      expect(["queued", "edited", "superseded"]).toContain(result.kind);
    });

    test(`${path}: the control: no reservation (no bound, no lease) writes, as the plan-level tests always have`, async () => {
      const w = await outboxWorld();
      await seeded(w, path);
      const [plan, input] = inputs(path, undefined) as [unknown, object];
      const { maxBytes: _maxBytes, ...unbounded } = input as {
        maxBytes: number;
      };
      const result = (await exec(w, plan, unbounded)) as { kind: string };
      expect(["queued", "edited", "superseded"]).toContain(result.kind);
    });

    test(`${path}: the lease is read in the step that decides: a hold that ends DURING the transaction's reads is caught`, async () => {
      const w = await outboxWorld();
      await seeded(w, path);
      let live = true;
      const reads = vi.fn(() => live);
      const [plan, input] = inputs(path, reads) as [unknown, object];
      // The hold ends before the decision is made (the read of the plan awaits the database first).
      queueMicrotask(() => {
        live = false;
      });
      const result = (await exec(w, plan, input)) as { kind: string };
      expect(reads).toHaveBeenCalled();
      expect(["lease_lapsed", "queued", "edited", "superseded"]).toContain(
        result.kind,
      );
      if (result.kind === "lease_lapsed") expect(live).toBe(false);
    });
  }
});

describe("the facade admits a save again, a bounded number of times, when its hold ended", () => {
  /** A guard whose reservations are live or lapsed as scripted, and which counts what it was asked and what was settled. */
  function scripted(lapses: number, size = 3) {
    const asked: number[] = [];
    const settled: string[] = [];
    let made = 0;
    const quota = {
      check: async () => "ok",
      reserve: async (
        _kind: string,
        bytes: number,
      ): Promise<QuotaReservation> => {
        asked.push(bytes);
        made += 1;
        const mine = made;
        return {
          verdict: "ok",
          live: () => mine > lapses,
          settle: (outcome) => {
            settled.push(`${mine}:${outcome}`);
          },
        };
      },
      lastFree: () => null,
      invalidate: () => undefined,
    } as unknown as QuotaGuard;
    return { quota, asked, settled, size };
  }
  const outboxOver = (w: World, quota: QuotaGuard) =>
    createOutbox({
      service: w.service,
      quota,
      ids: { uuid: () => crypto.randomUUID() },
      clock: { now: () => 0, iso: () => new Date(0).toISOString() },
      fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    });

  for (const path of PATHS)
    test(`${path}: a hold that ended once is admitted again at the same size, and the save is written under the second`, async () => {
      const w = await outboxWorld();
      await seeded(w, path);
      const probe = scripted(1);
      const outcome = await startFirst(
        path,
        outboxOver(w, probe.quota),
        uuid(53),
      );
      expect(outcome.kind).not.toBe("refused");
      expect(probe.asked).toHaveLength(2);
      expect(probe.asked[1]).toBe(probe.asked[0]);
      // The lapsed reservation was released without a write, the second landed.
      expect(probe.settled).toEqual(["1:not_written", "2:written"]);
    });

  for (const path of PATHS)
    test(`${path}: holds that end on every admission refuse the save as quota after the bounded rounds, writing nothing`, async () => {
      const w = await outboxWorld();
      await seeded(w, path);
      const before = JSON.stringify(w.snapshot());
      const probe = scripted(Number.POSITIVE_INFINITY);
      const outcome = await startFirst(
        path,
        outboxOver(w, probe.quota),
        uuid(53),
      );
      expect(outcome).toEqual({ kind: "refused", reason: "quota" });
      expect(probe.asked).toHaveLength(3);
      expect(probe.settled).toEqual([
        "1:not_written",
        "2:not_written",
        "3:not_written",
      ]);
      expect(JSON.stringify(w.snapshot())).toBe(before);
    });

  test("a hold that ended AND a write larger than reserved spend the same bounded rounds, in either order", async () => {
    const w = await outboxWorld();
    // The base-dependent command is larger than the first estimate and the hold ends on the first admission.
    const probe = scripted(1);
    const outcome = await outboxOver(w, probe.quota).enqueue({
      localId: uuid(54),
      endpoint: "/commands",
      targets: [
        {
          resourceId: uuid(55),
          role: "primary",
          basis: "resource",
          versionChecked: true,
          seedIfUntracked: 1,
        },
      ],
      build: (bases) =>
        Object.keys(bases).length === 0
          ? { command: { kind: "update", text: "" } }
          : { command: { kind: "update", text: "y".repeat(50_000) } },
    });
    expect(outcome.kind).toBe("queued");
    expect(probe.asked.length).toBeLessThanOrEqual(3);
    expect(probe.settled.at(-1)).toMatch(/:written$/);
  });
});

/**
 * R28 (revision 16), through the PUBLIC outbox on every growth path. (1) A completed write whose settlement does not reach the ledger: the
 * review's schedule was two rejected ledger calls, then the owner letting go, a healthy page proving it, removing the hold, and admitting a
 * second body (1,800,000 bytes retained in room for 1,200,000). The bytes of a write that landed are never forgotten: the hold stands, owned,
 * while the settlement is on its way, and becomes the landed debit in one change. (2) A reservation that waited past `quotaHoldMaxAgeMs`
 * before its writer BEGAN is a leak: its permission to begin is revoked, the room it held goes back exactly, and the save is admitted again.
 * (The writer that BEGAN, the unfinished commit, is in `outbox-quota-origin.test.ts`, which needs separate account databases.)
 */
describe("R28 revision 16: a completed write whose settlement does not reach the ledger stays counted, on every growth path", () => {
  type Behaviour =
    | "rejected twice"
    | "rejected until healed"
    | "silent until it arrives"
    | "answer lost";
  const BEHAVIOURS: Behaviour[] = [
    "rejected twice",
    "rejected until healed",
    "silent until it arrives",
    "answer lost",
  ];

  for (const path of PATHS)
    for (const behaviour of BEHAVIOURS)
      for (const roomy of [false, true])
        test(`${path}; ${behaviour}; ${roomy ? "room for both: both are written" : "room for one: only the first is written"}`, async () => {
          const w = await outboxWorld();
          await seeded(w, path);
          const origin = fakeOrigin();
          const clock: Clock = { t: 0 };
          const free = FLOOR + (roomy ? 2_500_000 : 1_200_000);
          let arrive: (() => void) | undefined;
          // The reservation is made; the plan is about to run. What the ledger does from here is what happens to the SETTLEMENT.
          const arm = (): void => {
            if (behaviour === "rejected twice") origin.fail("A", 2);
            if (behaviour === "rejected until healed") origin.fail("A", 1_000);
            if (behaviour === "silent until it arrives")
              arrive = origin.hang("A").arrive;
            if (behaviour === "answer lost") origin.loseAnswers("A", 1);
          };
          const a = page(w, origin, "A", free, clock, {
            enters: arm,
            gate: Promise.resolve(),
            plan: PLAN[path],
          });
          const b = page(w, origin, "B", free, clock);
          const rowsBefore = w.drafts().length;
          const one = await startFirst(path, a.outbox, uuid(51));
          expect(one.kind).not.toBe("refused");
          const second = await b.outbox.enqueue(request(uuid(52)));
          const written = [one, second].filter(
            (outcome) => outcome.kind !== "refused",
          );
          expect(written, "the reserve").toHaveLength(roomy ? 2 : 1);
          if (!roomy)
            expect(second).toEqual({ kind: "refused", reason: "quota" });
          expect(free - written.length * BODY).toBeGreaterThanOrEqual(
            roomy ? 0 : FLOOR,
          );
          expect(w.drafts().length - rowsBefore).toBe(
            path === "enqueue"
              ? written.length
              : Number(second.kind === "queued"),
          );
          // The ledger answers again (or the late settlement arrives): nothing is lost on the way, and nothing is counted twice.
          origin.heal("A");
          arrive?.();
          await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
          expect(origin.state().holds).toEqual({});
          const landed = origin.state().landed?.landed ?? 0;
          expect(landed).toBeGreaterThanOrEqual(BODY * (roomy ? 2 : 1));
          expect(landed).toBeLessThan(BODY * (roomy ? 2 : 1) + 50_000 * 2);
        });
});

describe("R28 revision 16: a save that waited past the maximum age before it began is a leak, and the room goes back exactly", () => {
  for (const path of PATHS)
    test(`${path}: the permission to begin is revoked at the age (no landed debit), the other page is admitted, and the late save is admitted AGAIN and refused: the floor holds`, async () => {
      const w = await outboxWorld();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await seeded(w, path);
      const origin = fakeOrigin();
      const clock: Clock = {
        get t() {
          return Date.now();
        },
        set t(_value: number) {
          throw new Error("moved by the timers");
        },
      };
      const free = FLOOR + 1_200_000;
      let enters!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enters = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const a = page(w, origin, "A", free, clock, {
        enters,
        gate,
        plan: PLAN[path],
      });
      const b = page(w, origin, "B", free, clock);
      const rowsBefore = w.drafts().length;
      const first = startFirst(path, a.outbox, uuid(51));
      await entered;
      // The production maximum age, through the real renewal ticks of a guard whose writer has not begun.
      await vi.advanceTimersByTimeAsync(DATA_CONFIG.quotaHoldMaxAgeMs + THIRD);
      expect(origin.state().holds).toEqual({});
      expect(origin.state().landed).toBeNull();
      const second = await b.outbox.enqueue(request(uuid(52)));
      expect(second.kind).toBe("queued");
      release();
      // The writer finds its permission revoked (`lease_lapsed`) and asks again: the room is B's now.
      expect(await first).toEqual({ kind: "refused", reason: "quota" });
      await vi.advanceTimersByTimeAsync(0);
      expect(w.drafts().length - rowsBefore).toBe(1);
      expect(free - BODY).toBeGreaterThanOrEqual(FLOOR);
    });
});
