// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  type CallAttempt,
  type FirstObserverInput,
  judgeFirstObserver,
  type KernelEvent,
} from "./first-observer";

/**
 * WEB-08d revision 32 (R33-N1): the first-observer witness against records it must accept and records it must reject, each for its
 * own reason. The valid records are shaped like the harness page's kernel trace and the delaying proxy's log in review 33's failure
 * (a competing stamped read observed first) and in the original premise (the list call observed first). The real kernel's own
 * schedules are judged in tests/session/i05-first-observer.test.ts.
 */
const A = "account-a";
const LIST = "/api/experimental/v1/sessions";
const SNAPSHOT = "/api/experimental/v1/defaults/snapshot";

const ev = (
  event: string,
  data: Record<string, unknown> = {},
): KernelEvent => ({
  event,
  data,
});
/** One stamped request of activity `n` (lease `L<n>`), answered `status`, classified `cause` and recorded. */
const answered = (
  n: number,
  options: {
    status?: number;
    cause?: string;
    epoch?: number;
    recorded?: boolean;
    identityRead?: boolean;
  } = {},
): KernelEvent[] => {
  const lease = `L${n}`;
  const epoch = options.epoch ?? 1;
  return [
    ev("activity.create", { n, kind: "request", klass: "ordinary" }),
    ev("cover.begin", { n, klass: "ordinary", lease }),
    ev("cover.committed", { n, klass: "ordinary", lease, unresolved: [] }),
    ev("request.issued", { n, lease, klass: "ordinary", account: A, epoch }),
    ev("surrender", {
      n,
      lease,
      account: A,
      epoch,
      klass: "ordinary",
      status: options.status ?? 403,
      identityRead: options.identityRead ?? false,
    }),
    ev("hold.set", { account: A, id: `d:${lease}`, cause: "detection" }),
    ev("hold.set", {
      account: A,
      id: `d:${lease}`,
      cause: options.cause ?? "observation:credential_mismatch",
    }),
    ev("record.attempt", { obs: `o${n}`, kind: "credential_mismatch" }),
    ...(options.recorded === false
      ? []
      : [
          ev("record.complete", { obs: `o${n}`, outcome: "DONE" }),
          ev("hold.release", { account: A, id: `d:${lease}` }),
        ]),
  ];
};
/** An attempt refused before it was sent: created, refused at the top guard (not_sent) or by the cover (closed). */
const refused = (n: number, how: "not_sent" | "closed"): KernelEvent[] =>
  how === "not_sent"
    ? [ev("activity.create", { n, kind: "request", klass: "ordinary" })]
    : [
        ev("activity.create", { n, kind: "request", klass: "ordinary" }),
        ev("cover.begin", { n, klass: "ordinary", lease: `L${n}` }),
        ev("evaluate", { reason: "cover_closed", settled: A }),
      ];
const before: KernelEvent[] = [
  ev("evaluate", { reason: "boot" }),
  ev("activity.create", { n: 1, kind: "exposure", klass: "exposure" }),
];
const wire403 = (id: number, path: string, delivered = true) => ({
  id,
  method: "GET",
  path,
  status: 403,
  events: [
    { event: "upstream_response", status: 403 },
    delivered
      ? { event: "delivered", status: 403 }
      : { event: "held", status: undefined },
  ],
});
const preCutWire = [
  {
    id: 7,
    method: "GET",
    path: "/api/experimental/v1/me",
    status: 200,
    events: [
      { event: "upstream_response", status: 200 },
      { event: "delivered", status: 200 },
    ],
  },
];

/** The list call observed first (the original premise, forced). */
const selfFirst = (): FirstObserverInput => {
  const call: CallAttempt[] = [
    { n: 5, result: { ok: false, error: "auth_state" } },
  ];
  return {
    identity: { account: A, epoch: 1 },
    document: { atCut: "doc", atJudgement: "doc" },
    trace: [...before, ...answered(5)],
    cut: before.length,
    call,
    wire: [...preCutWire, wire403(8, LIST)],
    wireCut: 7,
    answers: [
      { method: "GET", path: LIST, status: 403, code: "credential_mismatch" },
    ],
    exclusive: [{ method: "GET", path: LIST, calls: [call] }],
  };
};
/** A competing stamped read observed first (review 33's order): the list call is refused unsent, then closed. */
const otherFirst = (): FirstObserverInput => {
  const call: CallAttempt[] = [
    { n: 6, result: { ok: false, error: "not_sent" } },
    { n: 7, result: { ok: false, error: "closed" } },
  ];
  const competitor: CallAttempt[] = [
    { n: 5, result: { ok: false, error: "auth_state" } },
  ];
  return {
    identity: { account: A, epoch: 1 },
    document: { atCut: "doc", atJudgement: "doc" },
    trace: [
      ...before,
      ...answered(5),
      ...refused(6, "not_sent"),
      ...refused(7, "closed"),
    ],
    cut: before.length,
    call,
    wire: [...preCutWire, wire403(8, SNAPSHOT)],
    wireCut: 7,
    answers: [
      {
        method: "GET",
        path: SNAPSHOT,
        status: 403,
        code: "credential_mismatch",
      },
    ],
    exclusive: [
      { method: "GET", path: LIST, calls: [call] },
      { method: "GET", path: SNAPSHOT, calls: [competitor] },
    ],
  };
};

describe("valid records are accepted, with the observer they show", () => {
  test("the list call's own answer observed first: self", () => {
    const verdict = judgeFirstObserver(selfFirst());
    expect(verdict.problems).toEqual([]);
    expect(verdict.observer).toBe("self");
    expect(verdict.witness?.n).toBe(5);
    expect(verdict.first?.n).toBe(5);
  });
  test("a competing read observed and recorded first, the call refused unsent: other", () => {
    const verdict = judgeFirstObserver(otherFirst());
    expect(verdict.problems).toEqual([]);
    expect(verdict.observer).toBe("other");
    expect(verdict.witness?.n).toBe(5);
  });
  test("a competing observation came first but the call was already issued: its own answer decides (self), both are kept", () => {
    const input = selfFirst();
    const call: CallAttempt[] = [
      { n: 6, result: { ok: false, error: "auth_state" } },
    ];
    input.trace = [...before, ...answered(5), ...answered(6)];
    input.call = call;
    input.wire = [...preCutWire, wire403(8, SNAPSHOT), wire403(9, LIST)];
    input.answers = [
      {
        method: "GET",
        path: SNAPSHOT,
        status: 403,
        code: "credential_mismatch",
      },
      { method: "GET", path: LIST, status: 403, code: "credential_mismatch" },
    ];
    input.exclusive = [{ method: "GET", path: LIST, calls: [call] }];
    const verdict = judgeFirstObserver(input);
    expect(verdict.problems).toEqual([]);
    expect(verdict.observer).toBe("self");
    expect(verdict.first?.n).toBe(5);
    expect(verdict.observations.map((o) => o.n)).toEqual([5, 6]);
  });
});

describe("invalid records are rejected for their own reason", () => {
  const rejects = (input: FirstObserverInput, reason: RegExp) => {
    const verdict = judgeFirstObserver(input);
    expect(verdict.problems.join("\n")).toMatch(reason);
    return verdict;
  };
  test("records from another document", () => {
    const input = otherFirst();
    input.document.atJudgement = null;
    rejects(input, /not collected from the document the cut was taken in/);
  });
  test("the observation happened before the cut (a pre-swap event)", () => {
    const input = otherFirst();
    input.cut = before.length + answered(5).length;
    expect(
      rejects(input, /no other activity's credential_mismatch/).observer,
    ).toBeNull();
  });
  test("the observation was stamped for another epoch", () => {
    const input = otherFirst();
    input.trace = [
      ...before,
      ...answered(5, { epoch: 2 }),
      ...refused(6, "not_sent"),
      ...refused(7, "closed"),
    ];
    rejects(input, /no other activity's credential_mismatch/);
  });
  test("closed after an unrelated 401 (an invalid_session fence, not this observation)", () => {
    const input = otherFirst();
    input.trace = [
      ...before,
      ...answered(5, { status: 401, cause: "observation:invalid_session" }),
      ...refused(6, "not_sent"),
      ...refused(7, "closed"),
    ];
    input.answers = [
      { method: "GET", path: SNAPSHOT, status: 401, code: "unauthenticated" },
    ];
    rejects(input, /no other activity's credential_mismatch/);
  });
  test("closed with no observation at all (an unrelated fence closed admission)", () => {
    const input = otherFirst();
    input.trace = [
      ...before,
      ...refused(6, "not_sent"),
      ...refused(7, "closed"),
    ];
    input.wire = [...preCutWire];
    input.answers = [];
    rejects(input, /no other activity's credential_mismatch/);
  });
  test("the competing observation was classified but never durably recorded", () => {
    const input = otherFirst();
    input.trace = [
      ...before,
      ...answered(5, { recorded: false }),
      ...refused(6, "not_sent"),
      ...refused(7, "closed"),
    ];
    rejects(input, /no other activity's credential_mismatch/);
  });
  test("the competing observation was recorded only after the call's final attempt began", () => {
    const input = otherFirst();
    const competing = answered(5);
    input.trace = [
      ...before,
      ...competing.slice(0, -2),
      ...refused(6, "not_sent"),
      ...refused(7, "closed"),
      ...competing.slice(-2),
    ];
    rejects(input, /no other activity's credential_mismatch/);
  });
  test("closed, but an attempt of the call was issued", () => {
    const input = otherFirst();
    input.trace = [
      ...before,
      ...answered(5),
      ...refused(6, "not_sent"),
      ev("activity.create", { n: 7, kind: "request", klass: "ordinary" }),
      ev("request.issued", { n: 7, lease: "L7", klass: "ordinary" }),
    ];
    rejects(input, /an attempt of the call was issued/);
  });
  test("auth_state, but the kernel did not classify the call's own answer as credential_mismatch", () => {
    const input = selfFirst();
    input.trace = [
      ...before,
      ...answered(5, { cause: "observation:invalid_session" }),
    ];
    rejects(input, /did not classify the call's own answer/);
  });
  test("auth_state, but the call's observation was never durably recorded", () => {
    const input = selfFirst();
    input.trace = [...before, ...answered(5, { recorded: false })];
    rejects(input, /never durably recorded/);
  });
  test("auth_state, but the call's final attempt was never issued", () => {
    const input = selfFirst();
    input.trace = [...before, ...answered(4), ...refused(5, "not_sent")];
    rejects(input, /never issued/);
  });
  test("auth_state, but only ANOTHER activity's answer was classified, not the call's own", () => {
    const input = selfFirst();
    input.trace = [
      ...before,
      ...answered(4),
      ...answered(5, { cause: "observation:invalid_session" }),
    ];
    rejects(input, /did not classify the call's own answer/);
  });
  test("a surrender other than 403 is not this observation, whatever its hold says", () => {
    const input = otherFirst();
    input.trace = [
      ...before,
      ...answered(5, { status: 401 }),
      ...refused(6, "not_sent"),
      ...refused(7, "closed"),
    ];
    rejects(input, /no other activity's credential_mismatch/);
  });
  test("an identity read's 403 is not this observation (it carried no CSRF token)", () => {
    const input = otherFirst();
    input.trace = [
      ...before,
      ...answered(5, { identityRead: true }),
      ...refused(6, "not_sent"),
      ...refused(7, "closed"),
    ];
    rejects(input, /no other activity's credential_mismatch/);
  });
  test("an outcome that is neither auth_state nor closed", () => {
    const input = selfFirst();
    input.call = [{ n: 5, result: { ok: true } }];
    rejects(input, /neither its own observation/);
  });
  test("no attempt the kernel saw", () => {
    const input = selfFirst();
    input.call = [{ n: null, result: { ok: false, error: "not_sent" } }];
    rejects(input, /made no attempt/);
  });
  test("the backend answered an ordinary forbidden 403, not credential_mismatch", () => {
    const input = otherFirst();
    input.answers = [
      { method: "GET", path: SNAPSHOT, status: 403, code: "forbidden" },
    ];
    rejects(input, /not credential_mismatch: GET .* forbidden/);
  });
  test("the page never received the 403 the kernel classified (missing delivery)", () => {
    const input = otherFirst();
    input.answers = [];
    rejects(input, /the page received 0 stamped 403/);
  });
  test("the proxy still holds the 403 (answered upstream, never delivered)", () => {
    const input = otherFirst();
    input.wire = [...preCutWire, wire403(8, SNAPSHOT, false)];
    rejects(input, /the proxy delivered 0 stamped 403/);
  });
  test("the call the kernel says was never issued reached the proxy", () => {
    const input = otherFirst();
    input.wire = [
      ...preCutWire,
      wire403(8, SNAPSHOT),
      wire403(9, `${LIST}?x=1`),
    ];
    rejects(
      input,
      /1 GET \/api\/experimental\/v1\/sessions request\(s\) reached the proxy after the cut, but the test's own calls issued 0/,
    );
  });
  test("another caller used a route the test claimed for itself", () => {
    const input = selfFirst();
    input.wire = [...preCutWire, wire403(8, LIST), wire403(9, LIST)];
    input.answers = [
      { method: "GET", path: LIST, status: 403, code: "credential_mismatch" },
      { method: "GET", path: LIST, status: 403, code: "credential_mismatch" },
    ];
    rejects(
      input,
      /2 GET .* reached the proxy after the cut, but the test's own calls issued 1/,
    );
  });
});
