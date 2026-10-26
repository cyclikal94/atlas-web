import { describe, expect, test } from "vitest";
import {
  type ArmResult,
  type BarrierPort,
  type BarrierState,
  cleanReasons,
  judgeOrderedClose,
  mark,
  type OrderedCloseOptions,
  type OrderedCloseReceipt,
  orderedClose,
  type ProducerPort,
  type RecordSummary,
  type RosterEntry,
} from "./ordered-close";

/**
 * WEB-08d revision 34 (review 37 R37-N1): the I-13 ordered-close judge against valid and invalid receipts, and the driver's own
 * schedules over fake ports (the order of its steps, and every way it must stop instead of calling a close clean). The real
 * barrier's ordering is qualified natively by the I-13 premise controls in integration.pages.spec.ts.
 */

const identity = { account_id: "acc-a", epoch: 3, session_id: "ses-a" };
const clean = (): RecordSummary => ({
  settled: { ...identity },
  attempt: false,
  fences: 0,
  leases: {},
});
const withLease = (id: string): RecordSummary => ({
  ...clean(),
  leases: {
    [id]: { account_id: "acc-a", epoch: 3, boot_id: "seed", class: "ordinary" },
  },
});

/** A receipt of a correct ordered close followed by a correct target. */
function good(): OrderedCloseReceipt {
  return {
    identity,
    roster: [
      { name: "about:blank", role: "inert" },
      { name: "producer-1", role: "producer" },
      { name: "observer", role: "observer" },
    ],
    workers: 0,
    observer: { booted: false },
    arms: [{ seq: 1, kind: "armed", snapshot: clean() }],
    keepaliveAtArm: 4,
    closes: [
      {
        name: "producer-1",
        seq: 2,
        ok: true,
        phaseAfter: "armed",
        keepaliveAfter: 90,
      },
    ],
    release: { seq: 3, phase: "completed" },
    after: { seq: 4, snapshot: clean(), locks: { held: [], pending: [] } },
    observerClosed: 5,
    failure: null,
    seq: 7,
    target: {
      refusalSeq: 6,
      bootSeq: 7,
      boot: "target-boot",
      producerBoots: ["seed-boot"],
      captured: [[]],
    },
  };
}

type Edit = (r: OrderedCloseReceipt) => void;
const invalid: Array<[string, Edit, string]> = [
  [
    "the setup's own failure",
    (r) => {
      r.failure = "boom";
    },
    "the setup stopped: boom",
  ],
  [
    "an unlisted document",
    (r) => {
      r.roster.push({ name: "http://x/today", role: "unlisted" });
    },
    "an unlisted document of the context can still produce requests: http://x/today",
  ],
  [
    "no observer in the roster",
    (r) => {
      r.roster = r.roster.filter((e) => e.role !== "observer");
    },
    "the roster does not name the observer document",
  ],
  [
    "a worker",
    (r) => {
      r.workers = 1;
    },
    "the context runs 1 worker(s) the setup does not account for",
  ],
  [
    "a booted observer",
    (r) => {
      r.observer.booted = true;
    },
    "the observer document runs a session",
  ],
  [
    "an unknown observer",
    (r) => {
      r.observer.booted = null;
    },
    "the observer's session state is unknown",
  ],
  [
    "never armed",
    (r) => {
      r.arms = [
        {
          seq: 1,
          kind: "declined",
          reasons: ["x"],
          snapshot: withLease("L1"),
          settledPhase: "idle",
        },
      ];
    },
    "the barrier never armed over a clean record",
  ],
  [
    "armed over a lease",
    (r) => {
      r.arms[0] = { seq: 1, kind: "armed", snapshot: withLease("L1") };
    },
    'the barrier armed over unresolved leases ["L1"]',
  ],
  [
    "armed over another identity",
    (r) => {
      r.arms[0] = {
        seq: 1,
        kind: "armed",
        snapshot: {
          ...clean(),
          settled: { account_id: "acc-b", epoch: 3, session_id: "ses-a" },
        },
      };
    },
    "the barrier armed over a different settled identity (acc-b/3)",
  ],
  [
    "armed over another epoch of the identity",
    (r) => {
      r.arms[0] = {
        seq: 1,
        kind: "armed",
        snapshot: { ...clean(), settled: { ...identity, epoch: 4 } },
      };
    },
    "the barrier armed over a different settled identity (acc-a/4)",
  ],
  [
    "armed over another session of the identity",
    (r) => {
      r.arms[0] = {
        seq: 1,
        kind: "armed",
        snapshot: {
          ...clean(),
          settled: { ...identity, session_id: "ses-other" },
        },
      };
    },
    "the barrier armed over a different settled identity (acc-a/3)",
  ],
  [
    "armed over no settlement",
    (r) => {
      r.arms[0] = {
        seq: 1,
        kind: "armed",
        snapshot: { ...clean(), settled: null },
      };
    },
    "the barrier armed over no settled identity",
  ],
  [
    "armed over an attempt",
    (r) => {
      r.arms[0] = {
        seq: 1,
        kind: "armed",
        snapshot: { ...clean(), attempt: true },
      };
    },
    "the barrier armed over an attempt in progress",
  ],
  [
    "armed over a fence",
    (r) => {
      r.arms[0] = {
        seq: 1,
        kind: "armed",
        snapshot: { ...clean(), fences: 2 },
      };
    },
    "the barrier armed over 2 fence(s)",
  ],
  [
    "an earlier attempt that failed",
    (r) => {
      r.arms.unshift({ seq: 0, kind: "failed", reasons: ["x"] });
    },
    "an earlier barrier attempt was failed, not declined",
  ],
  [
    "an earlier declined transaction still open",
    (r) => {
      r.arms.unshift({
        seq: 0,
        kind: "declined",
        reasons: ["x"],
        snapshot: withLease("L1"),
        settledPhase: "timeout",
      });
    },
    "a declined barrier transaction was timeout before the next attempt",
  ],
  [
    "no close",
    (r) => {
      r.closes = [];
    },
    "no producer document was closed",
  ],
  [
    "a listed producer not closed",
    (r) => {
      r.roster.push({ name: "producer-2", role: "producer" });
    },
    "producer-2 was not closed under the barrier",
  ],
  [
    "a failed close",
    (r) => {
      Object.assign(r.closes[0] as object, { ok: false, error: "gone" });
    },
    "closing producer-1 failed: gone",
  ],
  [
    "closed before the barrier armed",
    (r) => {
      Object.assign(r.closes[0] as object, { seq: 0 });
    },
    "producer-1 was closed before the barrier armed",
  ],
  [
    "the barrier ended before the close finished",
    (r) => {
      Object.assign(r.closes[0] as object, { phaseAfter: "ended_early" });
    },
    "the barrier was ended_early, not armed, when producer-1 had closed",
  ],
  [
    "no barrier progress across the close",
    (r) => {
      Object.assign(r.closes[0] as object, { keepaliveAfter: 4 });
    },
    "the barrier transaction made no progress across the close of producer-1",
  ],
  [
    "never released",
    (r) => {
      r.release = null;
    },
    "the barrier was never released",
  ],
  [
    "released before the close",
    (r) => {
      r.release = { seq: 1.5, phase: "completed" };
    },
    "the barrier was released before every producer had closed",
  ],
  [
    "the barrier transaction aborted",
    (r) => {
      r.release = { seq: 3, phase: "aborted" };
    },
    "the barrier transaction ended aborted, not completed",
  ],
  [
    "no reread",
    (r) => {
      r.after = null;
    },
    "the record was not read again after the release",
  ],
  [
    "a reread before the release",
    (r) => {
      Object.assign(r.after as object, { seq: 2.5 });
    },
    "the record was read again before the release",
  ],
  [
    "a lease after the release (a queued write committed)",
    (r) => {
      Object.assign(r.after as object, { snapshot: withLease("L9") });
    },
    'after the release the record has unresolved leases ["L9"]',
  ],
  [
    "a request lock still held",
    (r) => {
      Object.assign(r.after as object, {
        locks: { held: ["atlas-lease-L9", "atlas-auth"], pending: [] },
      });
    },
    "request locks are still held or requested after the close: atlas-lease-L9",
  ],
  [
    "a request lock still requested",
    (r) => {
      Object.assign(r.after as object, {
        locks: { held: [], pending: ["atlas-issue-L9"] },
      });
    },
    "request locks are still held or requested after the close: atlas-issue-L9",
  ],
  [
    "the observer closed before the final read",
    (r) => {
      r.observerClosed = 3.5;
    },
    "the observer document was not closed after the final read",
  ],
  [
    "credential-bearing evidence",
    (r) => {
      r.roster.push({ name: "http://x/?csrf=abc", role: "inert" });
    },
    "the receipt carries credential-bearing fields",
  ],
  [
    "no target",
    (r) => {
      r.target = undefined;
    },
    "the target was not recorded",
  ],
  [
    "the refusal before the setup ended",
    (r) => {
      Object.assign(r.target as object, { refusalSeq: 4.5 });
    },
    "the API refusal was installed before the setup ended",
  ],
  [
    "the target before the refusal",
    (r) => {
      Object.assign(r.target as object, { bootSeq: 5.5 });
    },
    "the target booted before the API refusal was installed",
  ],
  [
    "the target is a producer",
    (r) => {
      Object.assign(r.target as object, { boot: "seed-boot" });
    },
    "the target is a producer document",
  ],
  [
    "the target captured a lease",
    (r) => {
      Object.assign(r.target as object, { captured: [[], ["L1", "L2"]] });
    },
    'the target\'s verification captured unresolved leases ["L1","L2"]',
  ],
];

describe("R37-N1: the I-13 ordered-close judge", () => {
  test("a correct receipt and target are accepted", () => {
    expect(judgeOrderedClose(good(), { target: true }).problems).toEqual([]);
  });

  test("a correct receipt after declined attempts that each ended, with two producers and a declared-inert page, is accepted", () => {
    const r = good();
    r.roster.push(
      { name: "producer-2", role: "producer" },
      { name: "http://x/__session", role: "declared-inert" },
    );
    r.arms = [
      {
        seq: 0.1,
        kind: "declined",
        reasons: ['unresolved leases ["L1"]'],
        snapshot: withLease("L1"),
        settledPhase: "idle",
      },
      {
        seq: 0.2,
        kind: "declined",
        reasons: ['unresolved leases ["L1"]'],
        snapshot: withLease("L1"),
        settledPhase: "idle",
      },
      ...r.arms,
    ];
    r.closes.push({
      name: "producer-2",
      seq: 2.5,
      ok: true,
      phaseAfter: "armed",
      keepaliveAfter: 120,
    });
    expect(judgeOrderedClose(r, { target: true }).problems).toEqual([]);
  });

  test("without `target`, the target is not required", () => {
    const r = good();
    r.target = undefined;
    expect(judgeOrderedClose(r).problems).toEqual([]);
  });

  test.each(invalid)("rejected: %s", (_name, edit, problem) => {
    const r = good();
    edit(r);
    expect(judgeOrderedClose(r, { target: true }).problems).toContain(problem);
  });

  test("review 37's own close (one empty read, the seed closed, a lease committed in between) is rejected for its reasons", () => {
    const r: OrderedCloseReceipt = {
      ...good(),
      arms: [],
      keepaliveAtArm: null,
      closes: [
        {
          name: "producer-1",
          seq: 2,
          ok: true,
          phaseAfter: null,
          keepaliveAfter: null,
        },
      ],
      release: null,
      after: {
        seq: 3,
        snapshot: {
          ...clean(),
          leases: Object.fromEntries(
            ["5b91", "d33a", "6252"].map((id) => [id, { boot_id: "seed" }]),
          ),
        },
        locks: { held: [], pending: [] },
      },
    };
    r.target = {
      ...(r.target as NonNullable<OrderedCloseReceipt["target"]>),
      captured: [["5b91", "d33a", "6252"]],
    };
    expect(judgeOrderedClose(r, { target: true }).problems).toEqual(
      expect.arrayContaining([
        "the barrier never armed over a clean record",
        "producer-1 was closed before the barrier armed",
        "the barrier was never released",
        'after the release the record has unresolved leases ["5b91","6252","d33a"]',
        'the target\'s verification captured unresolved leases ["5b91","d33a","6252"]',
      ]),
    );
  });

  test("cleanReasons lists every reason, sorted leases last", () => {
    expect(
      cleanReasons(
        { settled: null, attempt: true, fences: 1, leases: { b: {}, a: {} } },
        identity,
      ),
    ).toEqual([
      "no settled identity",
      "an attempt in progress",
      "1 fence(s)",
      'unresolved leases ["a","b"]',
    ]);
    expect(cleanReasons(clean(), identity)).toEqual([]);
  });

  test("mark continues the receipt's sequence", () => {
    const r = good();
    expect(mark(r)).toBe(8);
    expect(r.seq).toBe(8);
  });
});

/** A fake barrier: `arms` are answered in order (a function result is awaited; `"pending"` never answers). */
function fakeBarrier(script: {
  arms: Array<ArmResult | "pending">;
  settled?: BarrierState | "pending";
  stateAfterClose?: BarrierState | "throw";
  release?: BarrierState | "pending" | "throw";
  reread?: RecordSummary;
  locks?: { held: string[]; pending: string[] };
  booted?: boolean;
  log: string[];
}): BarrierPort {
  let keepalive = 0;
  let armed = false;
  const never = new Promise<never>(() => undefined);
  return {
    arm: async () => {
      const next = script.arms.shift();
      script.log.push("arm");
      if (next === undefined) throw new Error("no more scripted arms");
      if (next === "pending") return never;
      if (next.kind === "armed") armed = true;
      return next;
    },
    abandon: async () => {
      script.log.push("abandon");
      return { phase: "abandoned", keepalive: 0 };
    },
    settled: async () => {
      script.log.push("settled");
      if (script.settled === "pending") return never;
      return script.settled ?? { phase: "idle", keepalive: 0 };
    },
    state: async () => {
      keepalive += 10;
      const after = script.log.some((l) => l.startsWith("close:"))
        ? script.stateAfterClose
        : undefined;
      if (after === "throw")
        throw new Error("Target page, context or browser has been closed");
      if (after) return after;
      return { phase: armed ? "armed" : "idle", keepalive };
    },
    release: async () => {
      script.log.push("release");
      if (script.release === "pending") return never;
      if (script.release === "throw")
        throw new Error("Target page, context or browser has been closed");
      return script.release ?? { phase: "completed", keepalive };
    },
    reread: async () => {
      script.log.push("reread");
      return script.reread ?? clean();
    },
    locks: async () => script.locks ?? { held: [], pending: [] },
    booted: async () => script.booted ?? false,
    close: async () => {
      script.log.push("observer-close");
    },
  };
}

const producer = (
  name: string,
  log: string[],
  fails = false,
): ProducerPort => ({
  name,
  close: async () => {
    log.push(`close:${name}`);
    if (fails) throw new Error("boom");
  },
});
const roster =
  (extra: RosterEntry[] = [], workers = 0) =>
  async () => ({
    roster: [
      { name: "observer", role: "observer" as const },
      { name: "producer-1", role: "producer" as const },
      ...extra,
    ],
    workers,
  });
/** A fake clock: every sleep advances it and answers at once. */
function fakeTime(): Pick<OrderedCloseOptions, "now" | "sleep"> {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

describe("R37-N1: the ordered-close driver's schedules", () => {
  test("clean: arm, the instrumentation, close under the barrier, release, read again, close the observer; accepted", async () => {
    const log: string[] = [];
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [{ kind: "armed", snapshot: clean() }],
          log,
        }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      {
        ...fakeTime(),
        whileArmed: async () => {
          log.push("while-armed");
        },
      },
    );
    expect(log).toEqual([
      "arm",
      "while-armed",
      "close:producer-1",
      "release",
      "reread",
      "observer-close",
    ]);
    expect(receipt.failure).toBeNull();
    expect(judgeOrderedClose(receipt).problems).toEqual([]);
  });

  test("a live lease at the read: declined, its transaction ends, the instrumentation lets it retire, then armed; accepted", async () => {
    const log: string[] = [];
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [
            {
              kind: "declined",
              snapshot: withLease("L1"),
              reasons: cleanReasons(withLease("L1"), identity),
            },
            { kind: "armed", snapshot: clean() },
          ],
          log,
        }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      {
        ...fakeTime(),
        onDeclined: async () => {
          log.push("on-declined");
        },
      },
    );
    expect(log).toEqual([
      "arm",
      "settled",
      "on-declined",
      "arm",
      "close:producer-1",
      "release",
      "reread",
      "observer-close",
    ]);
    expect(receipt.arms.map((a) => [a.kind, a.settledPhase])).toEqual([
      ["declined", "idle"],
      ["armed", undefined],
    ]);
    expect(judgeOrderedClose(receipt).problems).toEqual([]);
  });

  test("never clean within the bound: stops with the last reasons; nothing is closed or released", async () => {
    const log: string[] = [];
    const declined = {
      kind: "declined" as const,
      snapshot: withLease("L1"),
      reasons: cleanReasons(withLease("L1"), identity),
    };
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: Array.from({ length: 40 }, () => declined),
          log,
        }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      { ...fakeTime(), deadlineMs: 3_000, pollMs: 100 },
    );
    expect(receipt.failure).toBe(
      'the record was never clean within 3000 ms: unresolved leases ["L1"]',
    );
    expect(
      log.filter((l) => l.startsWith("close:") || l === "release"),
    ).toEqual([]);
    expect(log.at(-1)).toBe("observer-close");
    expect(judgeOrderedClose(receipt).problems).toContain(
      'the setup stopped: the record was never clean within 3000 ms: unresolved leases ["L1"]',
    );
  });

  test("an acquisition that never starts: abandoned within its bound and reported; nothing is closed", async () => {
    const log: string[] = [];
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({ arms: ["pending"], log }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      { ...fakeTime(), acquireMs: 1_000 },
    );
    expect(receipt.failure).toBe(
      "the barrier could not be acquired within 1000 ms",
    );
    expect(receipt.arms).toEqual([
      { seq: 1, kind: "blocked", settledPhase: "abandoned" },
    ]);
    expect(log).toEqual(["arm", "abandon", "observer-close"]);
  });

  test("a declined transaction that does not end: stops instead of trying again", async () => {
    const log: string[] = [];
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [
            { kind: "declined", snapshot: withLease("L1"), reasons: ["x"] },
          ],
          settled: "pending",
          log,
        }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      fakeTime(),
    );
    expect(receipt.failure).toBe(
      "a declined barrier transaction was timeout instead of ended",
    );
    expect(log).toEqual(["arm", "settled", "observer-close"]);
  });

  test("a producer's close fails: the barrier is still released and the observer closed; no reread; rejected", async () => {
    const log: string[] = [];
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [{ kind: "armed", snapshot: clean() }],
          log,
        }),
        producers: [producer("producer-1", log, true)],
        roster: roster(),
      },
      identity,
      fakeTime(),
    );
    expect(receipt.failure).toBe("closing producer-1 failed: boom");
    expect(log).toEqual([
      "arm",
      "close:producer-1",
      "release",
      "observer-close",
    ]);
    expect(receipt.after).toBeNull();
  });

  test("the barrier ended before a close finished: stops at that producer, later producers stay open", async () => {
    const log: string[] = [];
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [{ kind: "armed", snapshot: clean() }],
          stateAfterClose: { phase: "ended_early", keepalive: 9 },
          release: { phase: "ended_early", keepalive: 9 },
          log,
        }),
        producers: [producer("producer-1", log), producer("producer-2", log)],
        roster: roster(),
      },
      identity,
      fakeTime(),
    );
    expect(receipt.failure).toBe(
      "the barrier was ended_early, not armed, when producer-1 had closed",
    );
    expect(log).toEqual([
      "arm",
      "close:producer-1",
      "release",
      "observer-close",
    ]);
  });

  test("the observer is lost while armed: reported, never a clean close", async () => {
    const log: string[] = [];
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [{ kind: "armed", snapshot: clean() }],
          stateAfterClose: "throw",
          release: "throw",
          log,
        }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      fakeTime(),
    );
    expect(receipt.failure).toBe(
      "the observer document was lost or failed: Target page, context or browser has been closed",
    );
    expect(receipt.release?.phase).toBe("lost");
    expect(receipt.after).toBeNull();
  });

  test("a release that never completes is reported as a timeout and nothing is read again", async () => {
    const log: string[] = [];
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [{ kind: "armed", snapshot: clean() }],
          release: "pending",
          log,
        }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      fakeTime(),
    );
    expect(receipt.release?.phase).toBe("timeout");
    expect(receipt.after).toBeNull();
    expect(judgeOrderedClose(receipt).problems).toEqual(
      expect.arrayContaining([
        "the barrier transaction ended timeout, not completed",
        "the record was not read again after the release",
      ]),
    );
  });

  test("an armed attempt that failed (the transaction aborted before its read) stops the setup", async () => {
    const log: string[] = [];
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [
            {
              kind: "failed",
              reason: "the barrier transaction aborted (AbortError)",
            },
          ],
          log,
        }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      fakeTime(),
    );
    expect(receipt.failure).toBe(
      "the barrier transaction aborted (AbortError)",
    );
    expect(log).toEqual(["arm", "observer-close"]);
  });

  test("an unlisted document, a worker or a booted observer stops the setup before any barrier", async () => {
    for (const [ports, failure] of [
      [
        { roster: roster([{ name: "http://x/today", role: "unlisted" }]) },
        "an unlisted document of the context can still produce requests: http://x/today",
      ],
      [
        { roster: roster([], 2) },
        "the context runs 2 worker(s) the setup does not account for",
      ],
      [
        { roster: roster(), booted: true },
        "the observer document runs a session",
      ],
    ] as const) {
      const log: string[] = [];
      const receipt = await orderedClose(
        {
          barrier: fakeBarrier({
            arms: [{ kind: "armed", snapshot: clean() }],
            log,
            booted: "booted" in ports,
          }),
          producers: [producer("producer-1", log)],
          roster: ports.roster,
        },
        identity,
        fakeTime(),
      );
      expect(receipt.failure).toBe(failure);
      expect(log).toEqual(["observer-close"]);
    }
  });

  test("a failing assertion of the instrumentation while armed: the barrier is still released and the observer closed, nothing is closed, and the caller's own error is rethrown", async () => {
    const log: string[] = [];
    const own = new Error("the caller's own assertion");
    const outcome = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [{ kind: "armed", snapshot: clean() }],
          log,
        }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      {
        ...fakeTime(),
        whileArmed: async () => {
          throw own;
        },
      },
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(outcome).toBe(own);
    expect(log).toEqual(["arm", "release", "observer-close"]);
  });

  test("a failing assertion of the instrumentation after a decline: the observer is closed and the caller's own error is rethrown", async () => {
    const log: string[] = [];
    const own = new Error("the caller's own assertion");
    const outcome = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [
            { kind: "declined", snapshot: withLease("L1"), reasons: ["x"] },
          ],
          log,
        }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      {
        ...fakeTime(),
        onDeclined: async () => {
          throw own;
        },
      },
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(outcome).toBe(own);
    expect(log).toEqual(["arm", "settled", "observer-close"]);
  });

  test("a write queued behind the barrier that committed after it would show in the reread: rejected", async () => {
    const log: string[] = [];
    const receipt = await orderedClose(
      {
        barrier: fakeBarrier({
          arms: [{ kind: "armed", snapshot: clean() }],
          reread: withLease("late"),
          log,
        }),
        producers: [producer("producer-1", log)],
        roster: roster(),
      },
      identity,
      fakeTime(),
    );
    expect(judgeOrderedClose(receipt).problems).toEqual([
      'after the release the record has unresolved leases ["late"]',
    ]);
  });
});
