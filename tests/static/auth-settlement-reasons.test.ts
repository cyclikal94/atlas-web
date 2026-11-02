// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  busyReasons,
  type DurableWork,
  durableReasons,
  expectNoArrivalsSince,
  type PageWork,
  type Settled,
} from "../e2e/auth-settlement";
import type { AuthStub, Delivery } from "../e2e/auth-stub";

/**
 * WEB-14a revision 23 (review r22 R28, design assessment C2-C4): the decisions of the production-auth completion boundary, without a
 * browser. A body read, a cancellation, an unobserved consumer and a sample taken while work changed are unfinished work on the page;
 * an unretired request lease or an unexplained attempt is unfinished work in the shared record; an answer that changes state, a new
 * login request or a cookie change after the boundary moves the oracle.
 */
const quiet: PageWork = {
  url: "http://127.0.0.1/today",
  path: "/today",
  doc: "d1",
  submits: [],
  digests: 0,
  pending: [],
  held: ["atlas-lease-exposure"],
  authTx: 0,
  otherTx: {},
  fetches: [],
  bodies: [],
  cancels: [],
  bodyReads: { done: 4, failed: 0, cancelled: 0, clones: 0 },
  unobserved: [],
  dom: "displaying",
  neutral: null,
  seq: 10,
  seqAfter: 10,
  delayed: { digest: false, locks: false, retirement: false },
  durable: null,
};
const record: DurableWork = {
  readable: true,
  leases: {},
  exposure: 1,
  attempt: null,
  fences: [],
  settledEpoch: 3,
  latestEpoch: 3,
  fenceSeq: 0,
  pendingDeletions: 0,
};
const parkedExchange = {
  n: 1,
  method: "POST",
  path: "/browser-sessions",
  page: null,
  hold: null,
  state: "held",
  status: null,
  cookieChange: null,
} as Delivery;

describe("revision 23, C2: a page's unfinished response work", () => {
  it("a quiet displaying page with a held exposure lease has no reasons", () => {
    expect(busyReasons(quiet, [])).toEqual([]);
  });
  it("a response body being read is unfinished, and no parked answer explains it", () => {
    expect(
      busyReasons({ ...quiet, bodies: ["json /browser-sessions/current"] }, [
        parkedExchange,
      ]),
    ).toEqual(["reading response bodies: json /browser-sessions/current"]);
  });
  it("a body-stream cancellation not yet settled is unfinished", () => {
    expect(busyReasons({ ...quiet, cancels: ["cancel /me"] }, [])).toEqual([
      "cancelling response bodies: cancel /me",
    ]);
  });
  it("an unobserved consumer or a displaced body method fails the page", () => {
    expect(
      busyReasons(
        { ...quiet, unobserved: ["getReader on the body of /me"] },
        [],
      ),
    ).toEqual(["unobserved body consumers: getReader on the body of /me"]);
  });
  it("a sample during which work changed is not a quiet sample", () => {
    expect(busyReasons({ ...quiet, seqAfter: 11 }, [])).toEqual([
      "work changed while the sample was taken",
    ]);
  });
  it("two parked answers of one request on one page are ambiguous, and refused", () => {
    expect(
      busyReasons(
        {
          ...quiet,
          fetches: ["POST /browser-sessions", "POST /browser-sessions"],
        },
        [parkedExchange, { ...parkedExchange, n: 2 }],
      ),
    ).toEqual(["ambiguous parked answers: POST /browser-sessions"]);
    expect(
      busyReasons({ ...quiet, fetches: ["POST /browser-sessions"] }, [
        parkedExchange,
      ]),
      "one parked answer explains its own fetch",
    ).toEqual([]);
  });
  it("an account-store transaction in flight is unfinished", () => {
    expect(busyReasons({ ...quiet, otherTx: { "atlas-a1": 1 } }, [])).toEqual([
      "transactions on atlas-a1 (1)",
    ]);
  });
});

describe("revision 23, C3: the shared record's unfinished obligations", () => {
  it("a record with only an exposure lease and a settled session has no reasons", () => {
    expect(durableReasons(record, [])).toEqual([]);
  });
  it("an unretired request lease is unfinished, whatever is parked", () => {
    expect(
      durableReasons({ ...record, leases: { verification: 1 } }, [
        parkedExchange,
      ]),
    ).toEqual(["unretired request leases: verification (1)"]);
  });
  it("an attempt in the record is unfinished unless a parked login request explains it", () => {
    const attempt = { ...record, attempt: "exchanging" };
    expect(durableReasons(attempt, [])).toEqual([
      "an attempt is unresolved (exchanging)",
    ]);
    expect(durableReasons(attempt, [parkedExchange])).toEqual([]);
  });
  it("an unreadable record, or none, is never quiet", () => {
    expect(
      durableReasons({ ...record, readable: false, error: "x" }, []),
    ).toEqual(["the auth record could not be read (x)"]);
    expect(durableReasons(null, [])).toEqual([
      "no page could report the auth record",
    ]);
  });
  it("fences are waiting states: compared, never a reason by themselves", () => {
    expect(
      durableReasons({ ...record, fences: ["invalid_session"] }, []),
    ).toEqual([]);
  });
});

describe("revision 23, C4: the oracle frozen at the boundary", () => {
  const stubWith = (
    deliveries: Array<Partial<Delivery>>,
    cookies: number,
  ): AuthStub =>
    ({
      deliveries: deliveries as Delivery[],
      cookieHistory: Array.from({ length: cookies }, () => null),
    }) as unknown as AuthStub;
  const boundary: Settled = {
    pages: [],
    arrivals: 1,
    states: ["fulfilled"],
    cookieRevision: 2,
    activations: [],
    durable: record,
  };
  const activate = { method: "POST", path: "/browser-sessions/activate" };
  it("nothing moved: no failure", () => {
    expect(() =>
      expectNoArrivalsSince(
        stubWith([{ ...activate, state: "fulfilled" }], 2),
        boundary,
        [activate.path],
      ),
    ).not.toThrow();
  });
  it("a new login request after the boundary moves the oracle", () => {
    expect(() =>
      expectNoArrivalsSince(
        stubWith(
          [
            { ...activate, state: "fulfilled" },
            { ...activate, state: "processing" },
          ],
          2,
        ),
        boundary,
        [activate.path],
      ),
    ).toThrow(/An authentication request arrived/);
  });
  it("an answer that changes state after the boundary moves the oracle", () => {
    expect(() =>
      expectNoArrivalsSince(
        stubWith([{ ...activate, state: "aborted" }], 2),
        boundary,
        [activate.path],
      ),
    ).toThrow(/An answer changed state/);
  });
  it("a cookie change after the boundary moves the oracle", () => {
    expect(() =>
      expectNoArrivalsSince(
        stubWith([{ ...activate, state: "fulfilled" }], 3),
        boundary,
        [activate.path],
      ),
    ).toThrow(/The cookie changed/);
  });
});
