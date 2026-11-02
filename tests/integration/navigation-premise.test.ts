// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { KernelEvent } from "./first-observer";
import {
  type AbandonmentInput,
  type DocumentSample,
  judgeAbandonment,
  judgeReplacement,
  type ReplacementInput,
} from "./navigation-premise";

/**
 * WEB-14a revision 46 (review r45 F-R45-I14D, R34-N1): the intentional-abandonment witnesses against records they must accept and
 * records they must reject, each for its own exact reason. The accepted old document is shaped like review r45's preserved WebKit
 * trace (four display requests issued and retired, then the frozen `/sessions` request, activity 6, issued and never retired). The real
 * kernel's own schedules (frozen owner destroyed; live owner handles the answer first; other requests outstanding) are judged in
 * tests/session/i14d-verification-premise.test.ts.
 */
const A = "account-a";
const S = "session-a";
const SEED = "boot-seed";
const NEXT = "boot-next";
const ORPHAN = "lease-orphan";
const RULE = "rule-sessions";
const OLD_DOC = "document-old";
const expected = { account_id: A, epoch: 1, session_id: S };
const witness = { lease: ORPHAN, boot: SEED, held: RULE };
const ordinary = (boot = SEED) => ({
  account_id: A,
  epoch: 1,
  boot_id: boot,
  class: "ordinary",
});

const ev = (
  event: string,
  data: Record<string, unknown> = {},
): KernelEvent => ({ event, data });

const request = (n: number, lease: string, retired: boolean) => [
  ev("activity.create", {
    n,
    kind: "request",
    klass: "ordinary",
    account: A,
    epoch: 1,
  }),
  ev("cover.begin", { n, klass: "ordinary", lease }),
  ev("cover.committed", { n, klass: "ordinary", lease, unresolved: [] }),
  ev("request.issued", {
    n,
    lease,
    klass: "ordinary",
    account: A,
    epoch: 1,
  }),
  ...(retired ? [ev("lease.retired", { lease })] : []),
];

/** The seed's trace: exposure, four display reads retired, then the frozen request issued (review r45's WebKit order). */
const seedTrace = (): KernelEvent[] => [
  ev("evaluate", { reason: "boot", settled: null }),
  ev("activity.create", {
    n: 1,
    kind: "exposure",
    klass: "exposure",
    account: A,
    epoch: 1,
  }),
  ev("cover.committed", {
    n: 1,
    klass: "exposure",
    lease: "lease-exposure",
    unresolved: [],
  }),
  ev("act.begin", { n: 1, account: A, epoch: 1 }),
  ev("act.end", { n: 1 }),
  ...request(2, "lease-2", true),
  ...request(3, "lease-3", true),
  ...request(4, "lease-4", true),
  ...request(5, "lease-5", true),
  ...request(6, ORPHAN, false),
];

const oldDocument = (): DocumentSample => ({
  bridged: true,
  boot: SEED,
  document: OLD_DOC,
  settled: { ...expected },
  // The seed's exposure lease (finished) may remain beside the orphan; it is not a request.
  leases: {
    "lease-exposure": { ...ordinary(), class: "exposure" },
    [ORPHAN]: ordinary(),
  },
  trace: seedTrace(),
});

const abandonment = (
  change: (input: AbandonmentInput) => void = () => undefined,
): AbandonmentInput => {
  const input: AbandonmentInput = {
    expected: { ...expected },
    witness: { ...witness },
    document: OLD_DOC,
    before: oldDocument(),
    held: 1,
  };
  change(input);
  return input;
};

const replacement = (
  change: (input: ReplacementInput) => void = () => undefined,
): ReplacementInput => {
  const input: ReplacementInput = {
    expected: { ...expected },
    witness: { ...witness },
    document: OLD_DOC,
    after: {
      bridged: true,
      boot: NEXT,
      document: "document-new",
      settled: { ...expected },
      leases: { [ORPHAN]: ordinary() },
      trace: [ev("evaluate", { reason: "boot", settled: A })],
    },
  };
  change(input);
  return input;
};

describe("judgeAbandonment: the old document, before the navigation", () => {
  test("the frozen request alone is outstanding, correlated and held: accepted, with its activity", () => {
    expect(judgeAbandonment(abandonment())).toEqual({
      problems: [],
      waiting: [],
      issued: 6,
    });
  });

  test("another request lease is still outstanding: not a problem, but waited for (its live owner may retire it)", () => {
    const verdict = judgeAbandonment(
      abandonment((input) => {
        input.before.leases["lease-daily"] = ordinary();
      }),
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.waiting).toEqual(["lease-daily (ordinary, boot boot-seed)"]);
  });

  test("a peer's lease of another boot is also waited for, never counted as the abandoned one", () => {
    const verdict = judgeAbandonment(
      abandonment((input) => {
        input.before.leases["lease-peer"] = {
          ...ordinary("boot-peer"),
          class: "verification",
        };
      }),
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.waiting).toEqual([
      "lease-peer (verification, boot boot-peer)",
    ]);
  });

  test("only an exposure lease besides it: nothing to wait for (an exposure is not a request)", () => {
    expect(judgeAbandonment(abandonment()).waiting).toEqual([]);
  });

  const rejected: Array<[string, (input: AbandonmentInput) => void, string]> = [
    [
      "zero leases: the request was retired (the clean schedule)",
      (input) => {
        input.before.leases = {};
      },
      "before: the abandoned request's lease lease-orphan is not in the record (retired, or never written): this is not an abandonment",
    ],
    [
      "the lease is another boot's",
      (input) => {
        input.before.leases[ORPHAN] = ordinary("boot-other");
      },
      "before: the abandoned lease belongs to boot boot-other, not the witnessed owner boot-seed",
    ],
    [
      "the lease is of another class",
      (input) => {
        input.before.leases[ORPHAN] = {
          ...ordinary(),
          class: "verification",
        };
      },
      "before: the abandoned lease is of class verification, not ordinary",
    ],
    [
      "the lease is another account's",
      (input) => {
        input.before.leases[ORPHAN] = {
          ...ordinary(),
          account_id: "account-b",
        };
      },
      "before: the abandoned lease is for account-b@1, not the expected account-a@1",
    ],
    [
      "the lease is of another epoch",
      (input) => {
        input.before.leases[ORPHAN] = { ...ordinary(), epoch: 2 };
      },
      "before: the abandoned lease is for account-a@2, not the expected account-a@1",
    ],
    [
      "the lease is uncorrelated: the trace never issued a request on it",
      (input) => {
        input.before.trace = input.before.trace.filter(
          (e) => !(e.event === "request.issued" && e.data?.lease === ORPHAN),
        );
      },
      "before: the owner's trace issued 0 request(s) on the abandoned lease, not exactly one (uncorrelated)",
    ],
    [
      "two requests were issued on it",
      (input) => {
        input.before.trace.push(...request(6, ORPHAN, false).slice(3));
      },
      "before: the owner's trace issued 2 request(s) on the abandoned lease, not exactly one (uncorrelated)",
    ],
    [
      "the issued request is not the settled account's ordinary request",
      (input) => {
        input.before.trace = input.before.trace.map((e) =>
          e.event === "request.issued" && e.data?.lease === ORPHAN
            ? ev("request.issued", { ...e.data, account: "account-b" })
            : e,
        );
      },
      "before: the issued request on the abandoned lease is not the expected ordinary request of the settled account and epoch",
    ],
    [
      "the issued request is of another class",
      (input) => {
        input.before.trace = input.before.trace.map((e) =>
          e.event === "request.issued" && e.data?.lease === ORPHAN
            ? ev("request.issued", { ...e.data, klass: "verification" })
            : e,
        );
      },
      "before: the issued request on the abandoned lease is not the expected ordinary request of the settled account and epoch",
    ],
    [
      "the issued request is of another epoch",
      (input) => {
        input.before.trace = input.before.trace.map((e) =>
          e.event === "request.issued" && e.data?.lease === ORPHAN
            ? ev("request.issued", { ...e.data, epoch: 2 })
            : e,
        );
      },
      "before: the issued request on the abandoned lease is not the expected ordinary request of the settled account and epoch",
    ],
    [
      "the owner's trace retired it",
      (input) => {
        input.before.trace.push(ev("lease.retired", { lease: ORPHAN }));
      },
      "before: the owner's trace retired the abandoned lease",
    ],
    [
      "the proxy holds no answer for the rule",
      (input) => {
        input.held = 0;
      },
      "before: the proxy holds no response for rule rule-sessions (the abandoned request's answer is not held)",
    ],
    [
      "the record settles another session",
      (input) => {
        input.before.settled = { ...expected, session_id: "session-b" };
      },
      "before: the record no longer settles the expected session",
    ],
    [
      "the record settles nothing",
      (input) => {
        input.before.settled = null;
      },
      "before: the record no longer settles the expected session",
    ],
    [
      "the document was replaced between samples",
      (input) => {
        input.before.document = "document-other";
      },
      "before: the document was replaced during the setup",
    ],
    [
      "the sample is not the witnessed owner's boot",
      (input) => {
        input.before.boot = "boot-other";
      },
      "before: the sampled document is boot boot-other, not the witnessed owner boot-seed",
    ],
    [
      "the document has no bridge",
      (input) => {
        input.before.bridged = false;
      },
      "before: the document has no fixture session bridge",
    ],
  ];
  for (const [name, change, problem] of rejected)
    test(`rejected: ${name}`, () => {
      expect(judgeAbandonment(abandonment(change)).problems).toEqual([problem]);
    });
});

describe("judgeReplacement: the new document, after the navigation", () => {
  test("a new bridged document and boot, the same settlement, the lease unchanged: accepted", () => {
    expect(judgeReplacement(replacement())).toEqual([]);
  });

  const rejected: Array<[string, (input: ReplacementInput) => void, string]> = [
    [
      "the owner retired the lease before it was destroyed (it handled the request: not an abandonment)",
      (input) => {
        input.after.leases = {};
      },
      "after: the abandoned request's lease lease-orphan is not in the record (retired, or never written): this is not an abandonment",
    ],
    [
      "the lease changed owner",
      (input) => {
        input.after.leases[ORPHAN] = ordinary(NEXT);
      },
      "after: the abandoned lease belongs to boot boot-next, not the witnessed owner boot-seed",
    ],
    [
      "the new document has no bridge (the app route itself)",
      (input) => {
        input.after.bridged = false;
      },
      "after: the new document has no fixture session bridge",
    ],
    [
      "the document was not replaced",
      (input) => {
        input.after.document = OLD_DOC;
      },
      "after: the document was not replaced (same marker)",
    ],
    [
      "the boot is the abandoned owner's",
      (input) => {
        input.after.boot = SEED;
      },
      "after: the new document did not boot a new session (boot boot-seed)",
    ],
    [
      "no session booted",
      (input) => {
        input.after.boot = null;
      },
      "after: the new document did not boot a new session (boot null)",
    ],
    [
      "the settlement changed",
      (input) => {
        input.after.settled = { ...expected, epoch: 2 };
      },
      "after: the new document's record does not settle the expected session",
    ],
  ];
  for (const [name, change, problem] of rejected)
    test(`rejected: ${name}`, () => {
      expect(judgeReplacement(replacement(change))).toEqual([problem]);
    });
});
