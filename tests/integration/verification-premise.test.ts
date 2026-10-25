// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  judgeTypedCall,
  judgeVerificationPremise,
  type KernelEvent,
  type TypedCallInput,
  type VerificationPremiseInput,
} from "./verification-premise";

/**
 * WEB-08d revision 33 (R34-N1): the I-14d premise and typed-call witnesses against records they must accept and records they must
 * reject, each for its own reason. The valid premise is shaped like the real kernel's target trace (the verification is created
 * between `act.begin` and `act.end`, because display sets the view inside `act`); the rejected navigation record is review 34's
 * Chromium failure (three abandoned display reads verified before any display). The real kernel's own schedules are judged in
 * tests/session/i14d-verification-premise.test.ts.
 */
const A = "account-a";
const S = "session-a";
const SEED = "boot-seed";
const TARGET = "boot-target";
const VL = "lease-verification";
const AGED = "2026-10-25T04:07:53.233Z";

const ev = (
  event: string,
  data: Record<string, unknown> = {},
): KernelEvent => ({
  event,
  data,
});

/** The target's trace: boot, exposure, display, then its optional verification (committed after `act.end`) issued. */
const displayed = (): KernelEvent[] => [
  ev("evaluate", { reason: "boot", settled: A }),
  ev("activity.create", {
    n: 1,
    kind: "exposure",
    klass: "exposure",
    account: A,
    epoch: 1,
  }),
  ev("cover.begin", { n: 1, klass: "exposure", lease: "lease-exposure" }),
  ev("cover.committed", {
    n: 1,
    klass: "exposure",
    lease: "lease-exposure",
    unresolved: [],
  }),
  ev("act.begin", { n: 1, account: A, epoch: 1 }),
  ev("activity.create", {
    n: 2,
    kind: "request",
    klass: "verification",
    account: A,
    epoch: 1,
  }),
  ev("cover.begin", { n: 2, klass: "verification", lease: VL }),
  ev("act.end", { n: 1 }),
  ev("cover.committed", {
    n: 2,
    klass: "verification",
    lease: VL,
    unresolved: [],
  }),
  ev("request.issued", {
    n: 2,
    lease: VL,
    klass: "verification",
    account: A,
    epoch: 1,
  }),
];

const premise = (
  change: (input: VerificationPremiseInput) => void = () => undefined,
): VerificationPremiseInput => {
  const input: VerificationPremiseInput = {
    identity: { account: A, epoch: 1, session: S },
    seed: { boot: SEED },
    target: { boot: TARGET, token: { atBoot: "t1", atJudgement: "t1" } },
    trace: displayed(),
    record: {
      settled: { account_id: A, epoch: 1, session_id: S },
      confirmation: {
        account_id: A,
        epoch: 1,
        session_id: S,
        confirmed_at: AGED,
      },
      leases: {
        [VL]: {
          account_id: A,
          epoch: 1,
          boot_id: TARGET,
          class: "verification",
        },
      },
    },
    agedConfirmedAt: AGED,
    identityReads: { seed: 0, target: 1, wire: 1, held: 1 },
  };
  change(input);
  return input;
};

/** Review 34's navigation: three old-boot display reads, the exposure closed over them, their verification issued, no display. */
const navigated = (): VerificationPremiseInput =>
  premise((input) => {
    const orphans = ["o1", "o2", "o3"];
    input.trace = [
      ev("evaluate", { reason: "boot", settled: A }),
      ev("activity.create", {
        n: 1,
        kind: "exposure",
        klass: "exposure",
        account: A,
        epoch: 1,
      }),
      ev("cover.begin", { n: 1, klass: "exposure", lease: "lease-exposure" }),
      ev("display.closed", { account: A, cause: "unresolved" }),
      ev("activity.create", {
        n: 2,
        kind: "request",
        klass: "verification",
        account: A,
        epoch: 1,
      }),
      ev("cover.begin", { n: 2, klass: "verification", lease: VL }),
      ev("cover.committed", {
        n: 2,
        klass: "verification",
        lease: VL,
        unresolved: orphans,
      }),
      ev("request.issued", {
        n: 2,
        lease: VL,
        klass: "verification",
        account: A,
        epoch: 1,
      }),
    ];
    for (const id of orphans)
      input.record.leases[id] = {
        account_id: A,
        epoch: 1,
        boot_id: SEED,
        class: "ordinary",
      };
    input.identityReads.seed = 0;
  });

const problemsOf = (input: VerificationPremiseInput) =>
  judgeVerificationPremise(input).problems;

describe("the I-14d premise witness", () => {
  test("accepts a target that displayed, then made one verification with nothing captured, held at the proxy", () => {
    const verdict = judgeVerificationPremise(premise());
    expect(verdict.problems).toEqual([]);
    expect(verdict.exposure).toEqual({ n: 1, begin: 4, end: 7 });
    expect(verdict.verification).toEqual({
      n: 2,
      lease: VL,
      created: 5,
      committed: 8,
      issued: 9,
    });
  });

  test("accepts a live seed lease in the record (the seed is still at work)", () => {
    expect(
      problemsOf(
        premise((input) => {
          input.record.leases.seed = {
            account_id: A,
            epoch: 1,
            boot_id: SEED,
            class: "ordinary",
          };
        }),
      ),
    ).toEqual([]);
  });

  test("rejects review 34's navigation: abandoned leases verified before any display", () => {
    const verdict = judgeVerificationPremise(navigated());
    expect(verdict.problems).toEqual([
      'a verification captured unresolved leases ["o1","o2","o3"]: it verifies abandoned requests, it is not the optional check',
      "the target never exposed the identity (no act.begin/act.end)",
      'the verification\'s captured set is ["o1","o2","o3"], not empty',
    ]);
    expect(verdict.exposure).toBeNull();
  });

  const rejected: Array<
    [string, (input: VerificationPremiseInput) => void, string]
  > = [
    [
      "records from another document",
      (i) => {
        i.target.token.atJudgement = null;
      },
      "the records were not collected from the target document the setup booted",
    ],
    [
      "one boot for seed and target",
      (i) => {
        i.target.boot = SEED;
      },
      "the seed and the target are one boot (the setup needs a separate target document)",
    ],
    [
      "another settled session",
      (i) => {
        i.record.settled = {
          account_id: A,
          epoch: 1,
          session_id: "other",
        };
      },
      "the record no longer settles the identity",
    ],
    [
      "another epoch settled",
      (i) => {
        i.record.settled = { account_id: A, epoch: 2, session_id: S };
      },
      "the record no longer settles the identity",
    ],
    [
      "no confirmation",
      (i) => {
        i.record.confirmation = null;
      },
      "the record has no shared confirmation of the identity",
    ],
    [
      "a refreshed confirmation",
      (i) => {
        i.record.confirmation = {
          account_id: A,
          epoch: 1,
          session_id: S,
          confirmed_at: "2026-10-25T04:09:53.300Z",
        };
      },
      "the shared confirmation is not the one the setup aged (it was refreshed or replaced)",
    ],
    [
      "no verification",
      (i) => {
        i.trace = displayed()
          .slice(0, 5)
          .concat([ev("act.end", { n: 1 })]);
      },
      "the target made no verification of the identity",
    ],
    [
      "two verifications",
      (i) =>
        void i.trace.push(
          ev("activity.create", {
            n: 3,
            kind: "request",
            klass: "verification",
            account: A,
            epoch: 1,
          }),
        ),
      "the target made 2 verifications of the identity (exactly one expected)",
    ],
    [
      "a verification created before the exposure began",
      (i) => {
        const t = displayed();
        i.trace = [
          t[0],
          t[1],
          t[5],
          t[2],
          t[3],
          t[4],
          t[6],
          t[7],
          t[8],
          t[9],
        ] as KernelEvent[];
      },
      "the verification was created before the target's exposure began (it is the check that gates display)",
    ],
    [
      "a verification committed before the exposure ended",
      (i) => {
        const t = displayed();
        i.trace = [
          t[0],
          t[1],
          t[2],
          t[3],
          t[4],
          t[5],
          t[6],
          t[8],
          t[7],
          t[9],
        ] as KernelEvent[];
      },
      "the verification's cover committed before the target's exposure ended",
    ],
    [
      "a cover that never committed",
      (i) => {
        i.trace = displayed().filter(
          (e) => !(e.event === "cover.committed" && e.data?.n === 2),
        );
      },
      "the verification's cover never committed",
    ],
    [
      "a captured set after display",
      (i) => {
        (i.trace[8] as KernelEvent).data = {
          n: 2,
          klass: "verification",
          lease: VL,
          unresolved: ["late"],
        };
      },
      'the verification\'s captured set is ["late"], not empty',
    ],
    [
      "a verification never issued",
      (i) => void i.trace.pop(),
      "the verification was never issued",
    ],
    [
      "its lease no longer in the record (answered already)",
      (i) => {
        i.record.leases = {};
      },
      "the verification's lease is not in the record as the target's outstanding verification",
    ],
    [
      "its lease another boot's",
      (i) => {
        (i.record.leases[VL] as { boot_id: string }).boot_id = SEED;
      },
      "the verification's lease is not in the record as the target's outstanding verification",
    ],
    [
      "a third document's lease",
      (i) => {
        i.record.leases.third = {
          account_id: A,
          epoch: 1,
          boot_id: "boot-third",
          class: "ordinary",
        };
      },
      "lease third belongs to neither the seed nor the target",
    ],
    [
      "an exposure of another account",
      (i) => {
        (i.trace[4] as KernelEvent).data = {
          n: 1,
          account: "account-b",
          epoch: 1,
        };
      },
      "the target never exposed the identity (no act.begin/act.end)",
    ],
    [
      "an exposure and a verification of another epoch",
      (i) => {
        for (const entry of i.trace)
          if (entry.data?.epoch === 1) entry.data.epoch = 2;
      },
      "the target never exposed the identity (no act.begin/act.end)",
    ],
    [
      "an exposure that never ended",
      (i) => {
        i.trace = displayed().filter((e) => e.event !== "act.end");
      },
      "the target never exposed the identity (no act.begin/act.end)",
    ],
    [
      "a seed identity read",
      (i) => {
        i.identityReads = { seed: 1, target: 1, wire: 2, held: 1 };
      },
      "the seed made 1 identity read(s), not 0",
    ],
    [
      "a second target identity read",
      (i) => {
        i.identityReads.target = 2;
      },
      "the target made 2 identity read(s), not 1",
    ],
    [
      "a second identity read at the proxy",
      (i) => {
        i.identityReads.wire = 2;
      },
      "2 identity read(s) reached the proxy, not 1",
    ],
    [
      "nothing held by the proxy",
      (i) => {
        i.identityReads.held = 0;
      },
      "the proxy holds 0 identity answer(s), not 1",
    ],
  ];
  for (const [name, change, problem] of rejected)
    test(`rejects ${name}`, () => {
      expect(problemsOf(premise(change))).toContain(problem);
    });
});

/** The verification is issued at index 9 of `displayed()`; the hook runs as its answer is delivered (trace length 10). */
const VERIFICATION = { n: 2, lease: VL, issued: 9 };
const ordinary = (n: number): KernelEvent =>
  ev("activity.create", {
    n,
    kind: "request",
    klass: "ordinary",
    account: A,
    epoch: 1,
  });
/** After the hook: the call's first attempt (n 7) is created and cancelled by the answer's detection hold; then the hold ends. */
const refusedAtAnswer = (): KernelEvent[] => [
  ...displayed(),
  ordinary(7),
  ev("surrender", {
    n: 2,
    lease: VL,
    account: A,
    epoch: 1,
    klass: "verification",
    status: 200,
    identityRead: true,
  }),
  ev("hold.set", { account: A, id: `d:${VL}`, cause: "detection" }),
  ev("activity.cancel", {
    n: 7,
    kind: "request",
    klass: "ordinary",
    account: A,
    reason: "hold",
    lease: null,
  }),
  ev("hold.release", { account: A, id: `d:${VL}` }),
];
/** The page's own reads made after the hook (Firefox, revision 33's second validation run: its Today reads 280 ms later): not the call's. */
const pageReads = (): KernelEvent[] => [
  ordinary(4),
  ordinary(5),
  ev("request.issued", {
    n: 4,
    lease: "L4",
    klass: "ordinary",
    account: A,
    epoch: 1,
  }),
  ev("request.issued", {
    n: 5,
    lease: "L5",
    klass: "ordinary",
    account: A,
    epoch: 1,
  }),
];
const retriedAndSent = (): KernelEvent[] => [
  ...refusedAtAnswer(),
  ordinary(8),
  ev("cover.begin", { n: 8, klass: "ordinary", lease: "L8" }),
  ev("cover.committed", {
    n: 8,
    klass: "ordinary",
    lease: "L8",
    unresolved: [],
  }),
  ev("request.issued", {
    n: 8,
    lease: "L8",
    klass: "ordinary",
    account: A,
    epoch: 1,
  }),
];

const typed = (
  change: (input: TypedCallInput) => void = () => undefined,
): TypedCallInput => {
  const input: TypedCallInput = {
    identity: { account: A, epoch: 1 },
    trace: refusedAtAnswer(),
    verification: VERIFICATION,
    hook: { runs: 1, at: 10 },
    attempts: [{ n: 7, outcome: "not_sent" }],
    retry: false,
    wireSessions: 0,
  };
  change(input);
  return input;
};
const retried = (change: (input: TypedCallInput) => void = () => undefined) =>
  typed((input) => {
    input.trace = retriedAndSent();
    input.retry = true;
    input.attempts = [
      { n: 7, outcome: "not_sent" },
      { n: 8, outcome: null },
    ];
    input.wireSessions = 1;
    change(input);
  });
const typedProblems = (input: TypedCallInput) => judgeTypedCall(input).problems;

describe("the I-14d typed-call witness", () => {
  test("accepts the call refused not_sent by the answer's detection hold, nothing sent", () => {
    const verdict = judgeTypedCall(typed());
    expect(verdict.problems).toEqual([]);
    expect(verdict.activities).toEqual([{ n: 7, created: 10, issued: null }]);
    expect(verdict.detection).toEqual({ set: 12, release: 14 });
  });
  test("accepts an attempt refused at the top guard while the hold is in force (no cancel event)", () => {
    const trace = refusedAtAnswer().filter(
      (e) => e.event !== "activity.cancel",
    );
    const [create] = trace.splice(10, 1);
    trace.splice(12, 0, create as KernelEvent);
    expect(
      typedProblems(
        typed((i) => {
          i.trace = trace;
        }),
      ),
    ).toEqual([]);
  });
  test("accepts the retry: refused once, then sent once (outstanding), and once it returned", () => {
    expect(typedProblems(retried())).toEqual([]);
    expect(
      typedProblems(
        retried((i) => {
          i.attempts = [
            { n: 7, outcome: "not_sent" },
            { n: 8, outcome: "returned" },
          ];
        }),
      ),
    ).toEqual([]);
  });
  test("accepts the page's own reads made after the hook, beside the call (they are not its attempts)", () => {
    expect(
      typedProblems(
        typed((i) => {
          i.trace = [...refusedAtAnswer(), ...pageReads()];
        }),
      ),
    ).toEqual([]);
    expect(
      typedProblems(
        retried((i) => {
          i.trace = [...retriedAndSent(), ...pageReads()];
        }),
      ),
    ).toEqual([]);
  });

  const rejected: Array<[string, () => TypedCallInput, string]> = [
    [
      "a hook that never ran",
      () =>
        typed((i) => {
          i.hook = { runs: 0, at: null };
        }),
      "the hook never ran",
    ],
    [
      "a hook that ran twice",
      () =>
        typed((i) => {
          i.hook.runs = 2;
        }),
      "the hook ran 2 time(s), not once",
    ],
    [
      "a hook that ran before the verification was issued",
      () =>
        typed((i) => {
          i.hook.at = 9;
        }),
      "the hook ran before the verification was issued (it must run as its answer is delivered)",
    ],
    [
      "a hook that ran after the kernel handled the answer",
      () =>
        typed((i) => {
          i.trace = [
            ...refusedAtAnswer().filter(
              (e) => e.event !== "activity.create" || e.data?.n !== 7,
            ),
            ordinary(7),
          ];
          i.hook.at = i.trace.length - 1;
        }),
      "the verification's answer set no detection hold after the hook ran (the hook did not run before the kernel handled it)",
    ],
    [
      "an attempt that names no activity",
      () =>
        typed((i) => {
          i.attempts = [{ n: null, outcome: "not_sent" }];
        }),
      "attempt 1 of the call names no ordinary activity of the identity in the trace",
    ],
    [
      "an attempt that names another kind of activity",
      () =>
        typed((i) => {
          i.attempts = [{ n: 2, outcome: "not_sent" }];
        }),
      "attempt 1 of the call names no ordinary activity of the identity in the trace",
    ],
    [
      "an attempt created before the hook",
      () =>
        typed((i) => {
          i.trace = [
            ...displayed().slice(0, 9),
            ordinary(7),
            ...refusedAtAnswer()
              .slice(9)
              .filter((e) => e.event !== "activity.create" || e.data?.n !== 7),
          ];
          i.hook.at = 11;
        }),
      "attempt 1 of the call was created before the hook ran",
    ],
    [
      "a first attempt made after the hold ended",
      () =>
        typed((i) => {
          i.trace = [
            ...refusedAtAnswer().filter(
              (e) =>
                !(e.event === "activity.create" && e.data?.n === 7) &&
                e.event !== "activity.cancel",
            ),
            ordinary(7),
          ];
        }),
      "the call's first attempt was made after the verification's detection hold ended",
    ],
    [
      "a first attempt that was issued",
      () =>
        typed((i) => {
          i.trace.push(
            ev("request.issued", {
              n: 7,
              lease: "L7",
              klass: "ordinary",
              account: A,
              epoch: 1,
            }),
          );
        }),
      "the call's first attempt was issued (it was not refused while the hold was in force)",
    ],
    [
      "no attempt after the hook",
      () =>
        typed((i) => {
          i.attempts = [];
        }),
      "the call made no attempt after the hook ran",
    ],
    [
      "an earlier attempt that never finished",
      () =>
        retried((i) => {
          i.attempts = [
            { n: 7, outcome: null },
            { n: 8, outcome: null },
          ];
        }),
      "an attempt of the call before the last never finished",
    ],
    [
      "without retry, a second attempt",
      () =>
        typed((i) => {
          i.trace = retriedAndSent();
          i.attempts = [
            { n: 7, outcome: "not_sent" },
            { n: 8, outcome: null },
          ];
          i.wireSessions = 1;
        }),
      "without retry the call made 2 attempts, not 1",
    ],
    [
      "without retry, an answer other than not_sent",
      () =>
        typed((i) => {
          i.attempts = [{ n: 7, outcome: "closed" }];
        }),
      "without retry the call answered closed, not not_sent",
    ],
    [
      "a peer's GET /sessions at the proxy",
      () =>
        typed((i) => {
          i.wireSessions = 1;
        }),
      "1 GET /sessions request(s) reached the proxy, but the call issued 0",
    ],
    [
      "with retry, nothing issued (the retry disabled)",
      () =>
        retried((i) => {
          i.trace = refusedAtAnswer();
          i.attempts = [{ n: 7, outcome: "not_sent" }];
          i.wireSessions = 0;
        }),
      "with retry 0 attempt(s) of the call were issued, not 1",
    ],
    [
      "with retry, two attempts issued",
      () =>
        retried((i) => {
          i.trace = [
            ...retriedAndSent(),
            ordinary(9),
            ev("request.issued", {
              n: 9,
              lease: "L9",
              klass: "ordinary",
              account: A,
              epoch: 1,
            }),
          ];
          i.attempts = [
            { n: 7, outcome: "not_sent" },
            { n: 8, outcome: "closed" },
            { n: 9, outcome: "returned" },
          ];
          i.wireSessions = 2;
        }),
      "with retry 2 attempt(s) of the call were issued, not 1",
    ],
    [
      "with retry, an earlier attempt that was not not_sent",
      () =>
        retried((i) => {
          i.attempts = [
            { n: 7, outcome: "closed" },
            { n: 8, outcome: null },
          ];
        }),
      'with retry an attempt before the last answered ["closed"] (only not_sent is retried)',
    ],
    [
      "with retry, a last attempt that did not return",
      () =>
        retried((i) => {
          i.attempts = [
            { n: 7, outcome: "not_sent" },
            { n: 8, outcome: "stale" },
          ];
        }),
      "with retry the call's last attempt answered stale, not returned",
    ],
    [
      "with retry, the sent attempt at the proxy twice",
      () =>
        retried((i) => {
          i.wireSessions = 2;
        }),
      "2 GET /sessions request(s) reached the proxy, but the call issued 1",
    ],
  ];
  for (const [name, input, problem] of rejected)
    test(`rejects ${name}`, () => {
      expect(typedProblems(input())).toContain(problem);
    });

  test("rejects, with retry, an issued attempt that is not the call's last", () => {
    expect(
      typedProblems(
        retried((i) => {
          i.trace = [...retriedAndSent(), ordinary(9)];
          i.attempts = [
            { n: 7, outcome: "not_sent" },
            { n: 8, outcome: "returned" },
            { n: 9, outcome: null },
          ];
        }),
      ),
    ).toContain("with retry the issued attempt is not the call's last");
  });
  test("rejects, without retry, a second attempt that was sent, by every rule it breaks", () => {
    expect(
      typedProblems(
        typed((i) => {
          i.trace = retriedAndSent();
          i.attempts = [
            { n: 7, outcome: "not_sent" },
            { n: 8, outcome: "returned" },
          ];
          i.wireSessions = 1;
        }),
      ),
    ).toEqual([
      "without retry the call made 2 attempts, not 1",
      "without retry an attempt of the call was issued",
      "without retry the call answered returned, not not_sent",
    ]);
  });
});
