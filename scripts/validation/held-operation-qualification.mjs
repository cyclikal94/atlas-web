// WEB-08d revision 23 (review r22 R22-N1; design assessment 3bef3bd4, invariants I1-I10, correction steps 1-5): the pure evaluator of the
// held-operation qualification (scripts/validation/held-operation-probes.mjs). Importing it builds nothing, allocates no output and starts
// no process.
//
// Revision 22's runner counted a helper/fixture mutant as caught when every selected case merely DEVIATED from its healthy oracle in a
// complete non-zero run. An ordinary error before the probe body, or a timeout in a hook, deviates too: it was a "catch" that proved
// nothing about the mutation (review r22 reproduced both in three engines). Here every mutation has an affirmative, versioned contract:
// for each probe it names, the exact Playwright errors (their order, kind per engine, origin, text, and for a spec assertion the source
// line and test it failed in) and the held-operation ledger the case must report, plus the unchanged native reader's whole-mutant verdict.
// Each case is judged against its mutation's delta profile and against its healthy profile:
//  - delta: the mutation's specific effect, with every other piece of evidence conserved;
//  - unchanged: exactly the healthy profile (the case did not notice the mutation);
//  - invalid: anything else (a setup, runtime, timeout, inventory or evidence failure, an extra or missing error, a damaged attachment).
// A mutant is `caught` only when every case of every named probe is `delta` in a complete, exactly inventoried, one-attempt run with the
// expected native verdicts; `survived` when every case is valid but at least one is unchanged; `invalid` otherwise. Both survived and
// invalid fail the campaign. The healthy profiles are the controls' oracle; they are strictly the revision 22 oracle plus attribution
// (source line, own test, exact publisher entries and ledger).
import { classifyMutant, inspectReport } from "./engine-results.mjs";

export const CONTRACT_VERSION = "web08d-held-operation-qualification/1";
export const ENGINES = ["chromium", "firefox", "webkit"];
export const HELPER = "tests/e2e/held-operation.ts";
export const LEDGER = "tests/e2e/held-operation-ledger.ts";
export const HARNESS = "src/fixture/data-harness/main.ts";
export const PROBE_SPEC = "tests/e2e/probe.held-operation.spec.ts";
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
// An error's text printed inside another error's message (a `toBe` of a thrown matcher message) carries its colours escaped.
const ESCAPED_ANSI = /\\x1b\[[0-9;]*m/g;
const basename = (path) =>
  String(path ?? "")
    .split("/")
    .at(-1);

/** The exact case titles of every probe id (P03 is parameterised twice): a changed or substituted title is a different case. */
export const TITLES = {
  P01: [
    "P01 healthy: the held edit is released at its success-path position and settles with its real answer; nothing stays armed or held",
  ],
  P02: [
    "P02 a body that fails after arming, before the plan is reached: the arm is cancelled, the body's own failure is the one thrown, and a later edit is not held",
  ],
  P03: [
    "P03 a body that fails once the answer is held (before its write is observed): the hold is released, the edit settles with its real answer and is joined before the failure is thrown",
    "P03 a body that fails once the answer is held (after its write is observed): the hold is released, the edit settles with its real answer and is joined before the failure is thrown",
  ],
  P04: [
    "P04 a body that fails after its explicit release: the cleanup finds nothing to release, and joins the edit",
  ],
  P05: [
    "P05 the cleanup of an earlier arm cannot release a later one: a stale token does nothing, and the later arm's own cleanup disarms it",
  ],
  P06: [
    "P06 an operation that really fails while its answer is held: its rejection is kept, and delivered to the case after the release",
  ],
  P07: [
    "P07 a body that fails while an operation that really fails is held: the body's failure is thrown, the operation's is recorded separately",
  ],
  P08: [
    "P08 an operation that cannot settle: the cleanup's wait is bounded and the failure to settle is recorded, not treated as success",
  ],
  P09: [
    "P09 the page is navigated to a new document while its edit is held: the edit's loss and the gone hold are recorded, the new document's hold is untouched, and the committed row survives",
  ],
  P10: [
    "P10 two pages hold independently: one hold at a time per page, another page's token is stale, a repeated release is harmless, and one scope releases each page's hold by its own token",
  ],
  P11: [
    "P11 an engine hold the body never reaches: disarmed by its own token, and the engine seam is idle",
  ],
  P12: [
    "P12 a body that ends without releasing its hold or joining its edit: the scope releases and joins them, and says so as its error",
  ],
  P13: [
    "P13 a release answered with something that is not a hold release (as a fixture build older than the seam answers): the body's failure is thrown, the bad answer is recorded, and the scope finishes",
  ],
  P14: [
    "P14 an operation the case expects to reject: `expectRejection()` with its matcher passes and nothing is witnessed, even when the body fails later for another reason",
  ],
  P15: [
    "P15 witnesses are per call, by id: a rejection handed over twice, a value that is not an Error that escapes, and an unjoined synchronous throw are three entries, each once",
  ],
  S1: [
    "S1 shape: an assertion fails while an edit's answer is held (the MU-990 schedule's shape): the assertion is the case's only error",
  ],
  S2: [
    "S2 shape: an operation fails and the body never asks for its answer: the operation's error is the case's only error",
  ],
  S3: [
    "S3 shape: an assertion fails while an operation that really fails is held: two errors, the assertion and the operation's",
  ],
  S4: [
    "S4 shape: an assertion fails while an operation cannot settle: two errors, the assertion and the cleanup's",
  ],
  S5: [
    "S5 shape: the page is lost while its edit is held, then an assertion fails: the assertion and the cleanup's failure are separate errors",
  ],
  S6: [
    "S6 shape: the case times out while its edit is held: a timeout, and the scope that never finished is reported",
  ],
  S7: [
    "S7 shape: a plain assertion with no hold at all (the reporter's baseline)",
  ],
  S8: [
    "S8 shape: an assertion fails while an operation whose error reads like an assertion is held: the operation's error is still an error",
  ],
  S9: [
    "S9 shape: an operation whose error reads like an assertion fails and the body never asks for its answer: an error, not an assertion",
  ],
  S10: [
    "S10 shape: an explicitly joined page operation whose error reads like an assertion escapes the body (the review's J1): the case is an error, with a separate runtime-origin witness",
  ],
  S11: [
    "S11 shape: an explicitly joined page operation that fails plainly escapes the body: its error and a separate runtime-origin witness",
  ],
  S12: [
    "S12 shape: the launched callback's own rejection, reading like an assertion, escapes through an explicit join (the review's J2): an error, never a catch",
  ],
  S13: [
    "S13 shape: a callback that throws synchronously, reading like an assertion, escapes through an explicit join: an error",
  ],
  S14: [
    "S14 shape: a rejection that is not an Error, reading like an assertion, escapes through an explicit join: an error",
  ],
  S15: [
    "S15 shape: a joined rejection escapes while another operation fails unjoined: the escaped error, then one error with both the cleanup failure and the witness",
  ],
  S16: [
    "S16 shape: a joined rejection escapes and a later hold's release fails: the escaped error, then one error with the release failure and the witness",
  ],
  S17: [
    "S17 shape: a successful join, then a genuine assertion fails: the assertion is the case's only error",
  ],
  S18: [
    "S18 shape: an expected rejection whose message is not the expected one: the matcher's assertion is the case's only error",
  ],
  S19: [
    "S19 shape: a rejection handed over by `settled()` and handled, then a genuine assertion fails: observing is not expecting, so the case is an error",
  ],
  S20: [
    "S20 shape: an expected rejection asserted by its matcher, then a different genuine assertion fails: the assertion is the case's only error",
  ],
  S21: [
    "S21 shape: an expected rejection, reading like an assertion, escapes the body unasserted: it is the body's failure, so it is witnessed and the case is an error",
  ],
};
export const PROBE_IDS = Object.keys(TITLES);

// ---------------------------------------------------------------------------------------------------------------------------------------
// Evidence patterns. A pattern object matches when each of its keys matches (other keys of the evidence are free); an array matches an
// array of the same length element by element; anything else is compared exactly.
const INCLUDES = Symbol("includes");
const ONE_OF = Symbol("one of");
/** Absent (or undefined) in the evidence. */
export const ABSENT = Symbol("absent");
/** A string containing every part. */
const inc = (...parts) => ({ [INCLUDES]: parts });
/** One of the values (a variation evidence shows and the mutation does not decide, such as a join racing a teardown). */
const oneOf = (...values) => ({ [ONE_OF]: values });

function mismatch(actual, pattern, at = "") {
  if (pattern === ABSENT)
    return actual === undefined
      ? null
      : `${at}: expected absent, found ${JSON.stringify(actual)}`;
  if (pattern !== null && typeof pattern === "object" && INCLUDES in pattern)
    return typeof actual === "string" &&
      pattern[INCLUDES].every((p) => actual.includes(p))
      ? null
      : `${at}: expected text with ${JSON.stringify(pattern[INCLUDES])}, found ${JSON.stringify(actual)}`;
  if (pattern !== null && typeof pattern === "object" && ONE_OF in pattern)
    return pattern[ONE_OF].some((p) => mismatch(actual, p, at) === null)
      ? null
      : `${at}: ${JSON.stringify(actual)} is none of the allowed values`;
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual) || actual.length !== pattern.length)
      return `${at}: expected ${pattern.length} item(s), found ${Array.isArray(actual) ? actual.length : JSON.stringify(actual)}`;
    for (let i = 0; i < pattern.length; i++) {
      const found = mismatch(actual[i], pattern[i], `${at}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (pattern !== null && typeof pattern === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual))
      return `${at}: expected an object, found ${JSON.stringify(actual)}`;
    for (const key of Object.keys(pattern)) {
      const found = mismatch(actual[key], pattern[key], `${at}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return Object.is(actual, pattern)
    ? null
    : `${at}: expected ${JSON.stringify(pattern)}, found ${JSON.stringify(actual)}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Error specifications.
//  kind: the unchanged reader's kind, or a map by engine (an error raised in the page reads differently in Firefox: it has no `Error: `
//        before an `expect(` the operation wrote, so the reader calls it an error there and an assertion in Chromium and WebKit).
//  origin: the file the error is located in: "spec" (the probe spec), "helper" (held-operation.ts), "ledger" (held-operation-ledger.ts),
//        "none" (no location); unset for an error raised in the page, whose location differs by engine.
//  frame: for a spec assertion, text of the source line the code frame marks; with `own`, that line lies inside the case's own test.
//  first / starts / has / lacks: the error's first line (exact / prefix / every part / no part); text: parts of the whole message.
//  match: a pattern for the first line. publisher: the `heldOperations` fixture's one error, entry by entry.
const PAGE_ASSERTION_LIKE = {
  chromium: "assertion",
  firefox: "error",
  webkit: "assertion",
};
const INTENDED = {
  kind: "assertion",
  origin: "spec",
  frame: `expect("fixed.1", "the probe's intended assertion").not.toBe("fixed.1");`,
  own: true,
  first: "Error: the probe's intended assertion",
};
const TIMEOUT = {
  kind: "error",
  origin: "none",
  match: /^Test timeout of \d+ms exceeded\.$/,
};
/** An operation's rejection raised in the page (`page.evaluate`), whose text the operation wrote. */
const pageError = (text, kind) => ({
  kind,
  starts: "Error: page.evaluate: ",
  has: [text],
  lacks: ["held-operation"],
});
const ASSERTION_LIKE = pageError(
  "expect(received).toBe(expected) inside the operation",
  PAGE_ASSERTION_LIKE,
);
const PLAIN = pageError("probe operation failure after edited", "error");
/** The owner's own error, thrown when a body that succeeded leaves a cleanup problem; `raw` allows `expect(` (HM8). */
const helperError = (has, { kind = "error", raw = false } = {}) => ({
  kind,
  origin: "helper",
  starts: "Error: held operations: ",
  has,
  lacks: [
    "held-operation cleanup failed",
    "held-operation runtime failure",
    ...(raw ? [] : ["expect("]),
  ],
});
/** A P control's failure at its intended assertion: the source line in its own test, and the delta the message shows. */
const failsAt = (frame, ...text) => ({
  kind: "assertion",
  origin: "spec",
  frame,
  own: true,
  text,
});
export const witnessText = (id, name) =>
  `operation ${id} (${name}) rejected and its rejection reached the case's body, which then failed: a runtime failure of the operation, not an assertion (its error is in the held-operations attachment)`;
/**
 * The `heldOperations` fixture's error (held-operation-ledger.ts): `held-operation cleanup failed: <entries joined by " | ">` and/or
 * `held-operation runtime failure: <witnesses joined by " | ">`, joined by " || ". Every entry is named: an extra or missing one is a
 * different report. `raw` allows `expect(` in its text (HM8 removes the neutralisation).
 */
const publisher = ({ cleanup = [], runtime = [], raw = false, kind }) => ({
  kind: kind ?? "error",
  origin: "ledger",
  publisher: { cleanup, runtime, raw },
});

// Ledger patterns: the attachment reduced to what the qualification reads (hold and call events by name, release details).
const call = (id, name, state, joined, delivered, expected, events) => ({
  id,
  name,
  state,
  joined,
  rejectionsDelivered: delivered,
  rejectionExpected: expected,
  events,
});
const RELEASED = { outcome: "released", armed: false, held: false };
const IDLE = { outcome: "idle", armed: false, held: false };
const DISARMED = { outcome: "disarmed", armed: false, held: false };
const holdWith = (events, details = {}) => ({
  events,
  release: ABSENT,
  cleanup: ABSENT,
  ...details,
});
/** Armed, held, released by the body; the failed body's cleanup finds nothing more to release. */
const RELEASED_THEN_IDLE = holdWith(
  ["armed", "held", "release", "cleanup-release"],
  { release: RELEASED, cleanup: IDLE },
);
const CLEANUP_RELEASED = holdWith(["armed", "held", "cleanup-release"], {
  cleanup: RELEASED,
});
/** A failed body's one finished scope; `witnessed` names the calls (id, name) whose runtime origin it recorded. */
const ledger = ({ errors = [], witnessed = [], ...scope }) => ({
  errors,
  escaped: witnessed.map(([id, name]) => witnessText(id, name)),
  scopes: [
    {
      finalised: true,
      bodyFailed: true,
      escaped: witnessed.map(([id]) => id),
      problems: errors,
      ...scope,
    },
  ],
});
const CLOSED = "Target page, context or browser has been closed";

// ---------------------------------------------------------------------------------------------------------------------------------------
/**
 * The healthy profile of every probe: what the live and the unmutated copy-tree controls must report. A P control passes with no error
 * and no case ledger (it inspects a private ledger itself); a shape fails on purpose exactly as below. `native` is the unchanged
 * reader's whole-mutant verdict over the probe's cases in every engine, with and without a matching case expectation.
 */
const passes = { status: "passed", errors: [], ledger: null };
export const HEALTHY = {
  ...Object.fromEntries(
    PROBE_IDS.filter((id) => id.startsWith("P")).map((id) => [id, passes]),
  ),
  S1: {
    status: "failed",
    errors: [INTENDED],
    ledger: ledger({
      holds: [CLEANUP_RELEASED],
      calls: [
        call("s1.c1", "the saved edit", "fulfilled", true, 0, false, [
          "launched",
          "fulfilled",
        ]),
      ],
    }),
    native: "caught",
  },
  S2: {
    status: "failed",
    errors: [
      helperError([
        "the operation the failing edit failed: ",
        "probe operation failure after edited",
      ]),
    ],
    ledger: {
      errors: [],
      escaped: [],
      scopes: [
        {
          finalised: true,
          bodyFailed: false,
          escaped: ABSENT,
          problems: [
            inc(
              "the operation the failing edit failed: ",
              "probe operation failure after edited",
            ),
          ],
          holds: [
            holdWith(["armed", "held", "release"], { release: RELEASED }),
          ],
          calls: [
            call("s1.c1", "the failing edit", "rejected", true, 0, false, [
              "launched",
              "rejected",
            ]),
          ],
        },
      ],
    },
    native: "refused",
  },
  S3: {
    status: "failed",
    errors: [
      INTENDED,
      publisher({
        cleanup: [
          [
            "the operation the failing edit failed: ",
            "probe operation failure after edited",
          ],
        ],
      }),
    ],
    ledger: ledger({
      errors: [
        inc(
          "the operation the failing edit failed: ",
          "probe operation failure after edited",
        ),
      ],
      holds: [CLEANUP_RELEASED],
      calls: [
        call("s1.c1", "the failing edit", "rejected", true, 0, false, [
          "launched",
          "rejected",
        ]),
      ],
    }),
    native: "refused",
  },
  S4: {
    status: "failed",
    errors: [
      INTENDED,
      publisher({
        cleanup: [
          [
            "the operation the never-settling call did not settle within 1000 ms of its hold's release",
          ],
          [
            "the operation the never-settling call was never joined by its scope (pending)",
          ],
        ],
      }),
    ],
    ledger: ledger({
      errors: [
        "the operation the never-settling call did not settle within 1000 ms of its hold's release",
      ],
      holds: [holdWith(["armed", "cleanup-release"], { cleanup: DISARMED })],
      calls: [
        call("s1.c1", "the never-settling call", "pending", false, 0, false, [
          "launched",
          "did-not-settle",
        ]),
      ],
    }),
    native: "refused",
  },
  S5: {
    status: "failed",
    errors: [
      INTENDED,
      publisher({
        cleanup: [
          ["releasing the held data.editQueuedDraft answer failed: ", CLOSED],
          ["the operation the saved edit failed: ", CLOSED],
        ],
      }),
    ],
    ledger: ledger({
      errors: [
        inc("releasing the held data.editQueuedDraft answer failed: ", CLOSED),
        inc("the operation the saved edit failed: ", CLOSED),
      ],
      holds: [
        holdWith(["armed", "held", "cleanup-release"], {
          cleanup: inc(CLOSED),
        }),
      ],
      calls: [
        call("s1.c1", "the saved edit", "rejected", true, 0, false, [
          "launched",
          "rejected",
        ]),
      ],
    }),
    native: "refused",
  },
  S6: {
    status: "timedOut",
    errors: [
      TIMEOUT,
      publisher({
        cleanup: [
          [
            "a held-operation scope never finished (1 hold(s), 1 operation(s) still pending)",
          ],
        ],
      }),
    ],
    ledger: {
      errors: [],
      escaped: [],
      scopes: [
        {
          finalised: false,
          bodyFailed: ABSENT,
          escaped: ABSENT,
          problems: [],
          holds: [holdWith(["armed", "held"])],
          calls: [
            call("s1.c1", "the saved edit", "pending", false, 0, false, [
              "launched",
            ]),
          ],
        },
      ],
    },
    native: "refused",
  },
  S7: { status: "failed", errors: [INTENDED], ledger: null, native: "caught" },
  S8: {
    status: "failed",
    errors: [
      INTENDED,
      publisher({
        cleanup: [
          [
            "the operation the assertion-like failure failed: ",
            "expect (received).toBe(expected) inside the operation",
          ],
        ],
      }),
    ],
    ledger: ledger({
      errors: [
        inc(
          "the operation the assertion-like failure failed: ",
          "expect(received).toBe(expected) inside the operation",
        ),
      ],
      holds: [CLEANUP_RELEASED],
      calls: [
        call(
          "s1.c1",
          "the assertion-like failure",
          "rejected",
          true,
          0,
          false,
          ["launched", "rejected"],
        ),
      ],
    }),
    native: "refused",
  },
  S9: {
    status: "failed",
    errors: [
      helperError([
        "the operation the assertion-like failure failed: ",
        "expect (received).toBe(expected) inside the operation",
      ]),
    ],
    ledger: {
      errors: [],
      escaped: [],
      scopes: [
        {
          finalised: true,
          bodyFailed: false,
          escaped: ABSENT,
          problems: [
            inc(
              "the operation the assertion-like failure failed: ",
              "expect(received).toBe(expected) inside the operation",
            ),
          ],
          holds: [
            holdWith(["armed", "held", "release"], { release: RELEASED }),
          ],
          calls: [
            call(
              "s1.c1",
              "the assertion-like failure",
              "rejected",
              true,
              0,
              false,
              ["launched", "rejected"],
            ),
          ],
        },
      ],
    },
    native: "refused",
  },
  S10: escapedShape(ASSERTION_LIKE, "the assertion-like failure"),
  S11: escapedShape(PLAIN, "the failing edit"),
  S12: escapedShape(
    {
      kind: "assertion",
      origin: "spec",
      first:
        "Error: expect(received).toBe(expected) inside the operation callback",
    },
    "the callback failure",
  ),
  S13: escapedShape(
    {
      kind: "assertion",
      origin: "spec",
      frame: "throw new Error(",
      own: true,
      first: "Error: expect(received).toBe(expected) thrown synchronously",
    },
    "the synchronous throw",
    { holds: [] },
  ),
  S14: escapedShape(
    {
      kind: "error",
      origin: "none",
      first: "'expect(received).toBe(expected) as a string'",
    },
    "the value",
    { holds: [] },
  ),
  S15: {
    status: "failed",
    errors: [
      ASSERTION_LIKE,
      publisher({
        cleanup: [
          [
            "the operation the second failure failed: the second operation failed",
          ],
        ],
        runtime: [["s1.c1", "the assertion-like failure"]],
      }),
    ],
    ledger: ledger({
      errors: [
        "the operation the second failure failed: the second operation failed",
      ],
      witnessed: [["s1.c1", "the assertion-like failure"]],
      holds: [RELEASED_THEN_IDLE],
      calls: [
        call(
          "s1.c1",
          "the assertion-like failure",
          "rejected",
          true,
          1,
          false,
          [
            "launched",
            "rejected",
            "rejection-delivered",
            "runtime-origin-witnessed",
          ],
        ),
        call("s1.c2", "the second failure", "rejected", true, 0, false, [
          "launched",
          "rejected",
        ]),
      ],
    }),
    native: "refused",
  },
  S16: {
    status: "failed",
    errors: [
      ASSERTION_LIKE,
      publisher({
        cleanup: [
          [
            "releasing the held data.commitPage answer failed: the harness answered a release with undefined, not a hold release",
          ],
        ],
        runtime: [["s1.c1", "the assertion-like failure"]],
      }),
    ],
    ledger: ledger({
      errors: [
        inc(
          "releasing the held data.commitPage answer failed: the harness answered a release with undefined, not a hold release",
        ),
      ],
      witnessed: [["s1.c1", "the assertion-like failure"]],
      holds: [
        RELEASED_THEN_IDLE,
        holdWith(["armed", "cleanup-release"], {
          kind: "engine",
          plan: "data.commitPage",
          cleanup: inc("the harness answered a release with undefined"),
        }),
      ],
      calls: [
        call(
          "s1.c1",
          "the assertion-like failure",
          "rejected",
          true,
          1,
          false,
          [
            "launched",
            "rejected",
            "rejection-delivered",
            "runtime-origin-witnessed",
          ],
        ),
      ],
    }),
    native: "refused",
  },
  S17: {
    status: "failed",
    errors: [INTENDED],
    ledger: ledger({
      holds: [RELEASED_THEN_IDLE],
      calls: [
        call("s1.c1", "the saved edit", "fulfilled", true, 0, false, [
          "launched",
          "fulfilled",
        ]),
      ],
    }),
    native: "caught",
  },
  S18: {
    status: "failed",
    errors: [
      {
        kind: "assertion",
        origin: "spec",
        frame: "await expect(call.expectRejection()).rejects.toThrow(",
        own: true,
        first: "Error: expect(received).rejects.toThrow(expected)",
        text: ["a message the operation never had"],
      },
    ],
    ledger: ledger({
      holds: [RELEASED_THEN_IDLE],
      calls: [
        call("s1.c1", "the failing edit", "rejected", true, 0, true, [
          "launched",
          "rejected",
          "expected-rejection-delivered",
        ]),
      ],
    }),
    native: "caught",
  },
  S19: {
    status: "failed",
    errors: [INTENDED, publisher({ runtime: [["s1.c1", "the failing edit"]] })],
    ledger: ledger({
      witnessed: [["s1.c1", "the failing edit"]],
      holds: [RELEASED_THEN_IDLE],
      calls: [
        call("s1.c1", "the failing edit", "rejected", true, 1, false, [
          "launched",
          "rejected",
          "rejection-delivered",
          "runtime-origin-witnessed",
        ]),
      ],
    }),
    native: "refused",
  },
  S20: {
    status: "failed",
    errors: [INTENDED],
    ledger: ledger({
      holds: [RELEASED_THEN_IDLE],
      calls: [
        call("s1.c1", "the failing edit", "rejected", true, 0, true, [
          "launched",
          "rejected",
          "expected-rejection-delivered",
        ]),
      ],
    }),
    native: "caught",
  },
  S21: {
    status: "failed",
    errors: [
      ASSERTION_LIKE,
      publisher({ runtime: [["s1.c1", "the assertion-like failure"]] }),
    ],
    ledger: ledger({
      witnessed: [["s1.c1", "the assertion-like failure"]],
      holds: [RELEASED_THEN_IDLE],
      calls: [
        call("s1.c1", "the assertion-like failure", "rejected", true, 0, true, [
          "launched",
          "rejected",
          "expected-rejection-delivered",
          "runtime-origin-witnessed",
        ]),
      ],
    }),
    native: "refused",
  },
};
/** A joined rejection that escapes the body (S10-S14): its own error, then the separate witness. */
function escapedShape(primary, name, scope = { holds: [RELEASED_THEN_IDLE] }) {
  return {
    status: "failed",
    errors: [primary, publisher({ runtime: [["s1.c1", name]] })],
    ledger: ledger({
      witnessed: [["s1.c1", name]],
      ...scope,
      calls: [
        call("s1.c1", name, "rejected", true, 1, false, [
          "launched",
          "rejected",
          "rejection-delivered",
          "runtime-origin-witnessed",
        ]),
      ],
    }),
    native: "refused",
  };
}
/** A healthy profile with some of its parts replaced: a delta keeps everything the mutation does not change. */
const healthyWith = (id, change) => {
  const base = structuredCloneProfile(HEALTHY[id]);
  return change(base) ?? base;
};
function structuredCloneProfile(profile) {
  // Patterns hold symbols and regular expressions; copy the containers and keep the leaves.
  const copy = (value) => {
    if (value instanceof RegExp || typeof value !== "object" || value === null)
      return value;
    if (Array.isArray(value)) return value.map(copy);
    const out = {};
    for (const key of Reflect.ownKeys(value)) out[key] = copy(value[key]);
    return out;
  };
  return copy(profile);
}
const scopeOf = (profile) => profile.ledger.scopes[0];
const withoutWitness = (id) =>
  healthyWith(id, (p) => {
    p.errors = p.errors.slice(0, 1);
    p.ledger.escaped = [];
    scopeOf(p).escaped = [];
    for (const c of scopeOf(p).calls)
      c.events = c.events.filter((e) => e !== "runtime-origin-witnessed");
  });
const unpublished = (id) =>
  healthyWith(id, (p) => {
    p.errors = p.errors.slice(0, 1);
  });

// ---------------------------------------------------------------------------------------------------------------------------------------
const sub = (text, from, to) => {
  const count = text.split(from).length - 1;
  if (count !== 1)
    throw new Error(`anchor found ${count} times: ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

/**
 * Helper mutants (patched copies of the test tree) and fixture mutants (patched harness, mutant build), each with its contract: the
 * probes it names, the delta profile of each, and the native verdict of each shape under it. Revision 23 runs the mutants that exercise
 * the runtime-origin witness first (HM10, HM12, HM14, HM7: the design assessment's affected selections), then the rest.
 */
export const MUTANTS = [
  {
    id: "HM10",
    title:
      "an explicitly joined rejection that escapes the body is not witnessed (the R21-N1 defect)",
    file: HELPER,
    patch: (t) =>
      sub(
        t,
        "        failed !== null &&\n        (call.rejectionsDelivered",
        "        failed === Symbol.for(String(failed)) &&\n        (call.rejectionsDelivered",
      ),
    // The rejection is still delivered (or matched), the scope finalised and the call joined; only the witness is gone, in the scope,
    // the ledger and the publication. Each original rejection stays the case's error. Firefox reads the page's assertion-like text as an
    // error, so S10/S21 stay refused in the three-engine verdict; S11/S14 never read as assertions; S12/S13 become catches.
    deltas: {
      S10: { ...withoutWitness("S10"), native: "refused" },
      S11: { ...withoutWitness("S11"), native: "refused" },
      S12: { ...withoutWitness("S12"), native: "caught" },
      S13: { ...withoutWitness("S13"), native: "caught" },
      S14: { ...withoutWitness("S14"), native: "refused" },
      S21: { ...withoutWitness("S21"), native: "refused" },
    },
  },
  {
    id: "HM12",
    title:
      "the body's failure is never matched to an operation's rejection (only deliveries by `settled()` are witnessed)",
    file: HELPER,
    patch: (t) =>
      sub(
        t,
        "    if (current === error) return true;",
        "    if (current === Symbol.for(String(error))) return true;",
      ),
    // The expected rejection escapes unasserted: delivered as an expectation, never as an ordinary delivery, and no longer matched.
    deltas: { S21: { ...withoutWitness("S21"), native: "refused" } },
  },
  {
    id: "HM14",
    title: "the ledger's runtime-origin witnesses are never published",
    file: LEDGER,
    patch: (t) =>
      sub(
        t,
        "    ...(ledger.escaped.length > 0",
        "    ...(ledger.escaped.length < 0",
      ),
    // The witness stays in the scope and the ledger; only its publication is gone. S15/S16 keep their independent cleanup errors.
    deltas: {
      S10: { ...unpublished("S10"), native: "refused" },
      S12: { ...unpublished("S12"), native: "caught" },
      S15: healthyWith("S15", (p) => {
        p.errors[1] = publisher({
          cleanup: [
            [
              "the operation the second failure failed: the second operation failed",
            ],
          ],
        });
        p.native = "refused";
      }),
      S16: healthyWith("S16", (p) => {
        p.errors[1] = publisher({
          cleanup: [
            [
              "releasing the held data.commitPage answer failed: the harness answered a release with undefined, not a hold release",
            ],
          ],
        });
        p.native = "refused";
      }),
    },
  },
  {
    id: "HM7",
    title: "the ledger is attached but its failures are never reported",
    file: LEDGER,
    patch: (t) => sub(t, "  if (parts.length > 0)", "  if (parts.length < 0)"),
    // The ledger is attached with its problem, unfinished scope or witness; only the publisher's error is gone. S6 must still have
    // reached its held call (armed and held, the call pending) and then timed out inside its unfinished scope.
    deltas: {
      S3: { ...unpublished("S3"), native: "caught" },
      S4: { ...unpublished("S4"), native: "caught" },
      S5: { ...unpublished("S5"), native: "caught" },
      S6: { ...unpublished("S6"), native: "refused" },
      S10: { ...unpublished("S10"), native: "refused" },
    },
  },
  {
    id: "HM1",
    title: "a failed body's cleanup releases nothing (the R20-N1 defect)",
    file: HELPER,
    patch: (t) =>
      sub(
        t,
        "if (held.released && !bodyFailed) continue;",
        "if (held.released || bodyFailed) continue;",
      ),
    // Not released, so the held edit cannot settle within the bounded wait and is never joined.
    deltas: {
      P03: {
        status: "failed",
        errors: [
          failsAt(
            "expect(ledger.errors).toEqual([]);",
            "the operation the saved edit did not settle within 5000 ms of its hold's release",
          ),
        ],
        ledger: null,
      },
      S1: healthyWith("S1", (p) => {
        p.errors.push(
          publisher({
            cleanup: [
              [
                "the operation the saved edit did not settle within 5000 ms of its hold's release",
              ],
              [
                "the operation the saved edit was never joined by its scope (pending)",
              ],
            ],
          }),
        );
        p.ledger = ledger({
          errors: [
            "the operation the saved edit did not settle within 5000 ms of its hold's release",
          ],
          holds: [holdWith(["armed", "held"])],
          calls: [
            call("s1.c1", "the saved edit", "pending", false, 0, false, [
              "launched",
              "did-not-settle",
            ]),
          ],
        });
        p.native = "refused";
      }),
    },
  },
  {
    id: "HM2",
    title: "the cleanup never joins the operations",
    file: HELPER,
    patch: (t) =>
      sub(
        t,
        "for (const { record: call, outcome } of calls) {",
        "for (const { record: call, outcome } of calls.slice(calls.length)) {",
      ),
    // Released but never joined: the publisher names the unjoined call. Whether the released edit has settled by the teardown is
    // timing, not the mutation (both are recorded in revision 22's evidence); joining is what the delta is about.
    deltas: {
      P03: {
        status: "failed",
        errors: [
          failsAt(
            "expect(ledger.scopes[0]?.calls[0]).toMatchObject({",
            '-   "joined": true,',
            '+   "joined": false,',
          ),
        ],
        ledger: null,
      },
      S1: healthyWith("S1", (p) => {
        p.errors.push(
          publisher({
            cleanup: [
              ["the operation the saved edit was never joined by its scope ("],
            ],
          }),
        );
        Object.assign(scopeOf(p).calls[0], {
          state: oneOf("fulfilled", "pending"),
          joined: false,
          events: oneOf(["launched", "fulfilled"], ["launched"]),
        });
        p.native = "refused";
      }),
    },
  },
  {
    id: "HM3",
    title: "an operation's rejection is swallowed by `settled()`",
    file: HELPER,
    patch: (t) =>
      sub(
        t,
        'event: "rejection-delivered" });\n            throw settled.error;',
        'event: "rejection-delivered" });\n            return undefined as T;',
      ),
    deltas: {
      P06: {
        status: "failed",
        errors: [
          failsAt(
            "await expect(call.settled()).rejects.toThrow(",
            "Received promise resolved instead of rejected",
          ),
        ],
        ledger: null,
      },
    },
  },
  {
    id: "HM4",
    title:
      "a failed body's cleanup failures are dropped (never reach the ledger)",
    file: HELPER,
    patch: (t) => sub(t, "    ledger.errors.push(...problems);\n", ""),
    // The scope still records its problems; the ledger's error list loses them, so the intended assertion is the case's only error.
    deltas: {
      P07: {
        status: "failed",
        errors: [
          failsAt(
            "expect(ledger.errors).toHaveLength(1);",
            "Received length: 0",
          ),
        ],
        ledger: null,
      },
      S3: healthyWith("S3", (p) => {
        p.errors = [INTENDED];
        p.ledger.errors = [];
        p.native = "caught";
      }),
      S5: healthyWith("S5", (p) => {
        p.errors = [INTENDED];
        p.ledger.errors = [];
        p.native = "caught";
      }),
    },
  },
  {
    id: "HM5",
    title:
      "the cleanup releases without its token (whatever hold the page has now)",
    file: HELPER,
    patch: (t) => sub(t, "{ kind, token },", "{ kind, token: undefined },"),
    // The tokenless release disarms the new document's arm instead of finding the old token stale.
    deltas: {
      P09: {
        status: "failed",
        errors: [
          failsAt(
            "expect(cleanup(ledger)).toEqual({",
            '-   "outcome": "stale",',
            '+   "outcome": "disarmed",',
          ),
        ],
        ledger: null,
      },
    },
  },
  {
    id: "HM6",
    title: "the body's own failure is replaced by a cleanup error",
    file: HELPER,
    patch: (t) =>
      sub(
        t,
        "    throw failure;",
        '    throw new Error("held operations failed");',
      ),
    // The one deliberate exception to conserving the primary failure: it is replaced by exactly this error, and the cleanup is healthy.
    deltas: {
      P02: {
        status: "failed",
        errors: [
          failsAt(
            "expect((thrown as Error | null)?.message).toBe(SENTINEL);",
            'Received: "held operations failed"',
          ),
        ],
        ledger: null,
      },
      S1: healthyWith("S1", (p) => {
        p.errors = [
          {
            kind: "error",
            origin: "helper",
            first: "Error: held operations failed",
          },
        ];
        p.native = "refused";
      }),
    },
  },
  {
    id: "HM9",
    title: "the owner trusts a release answer that is not a hold release",
    file: HELPER,
    patch: (t) =>
      sub(
        t,
        "  if (!isRelease(released))",
        "  if (released === Symbol.for(String(released)))",
      ),
    deltas: {
      P13: {
        status: "failed",
        errors: [
          failsAt(
            "expect(ledger.errors[0]).toContain(",
            'Received string:    "the cleanup itself failed: ',
          ),
        ],
        ledger: null,
      },
    },
  },
  {
    id: "HM11",
    title:
      "a rejection `settled()` handed to the body is witnessed only when it is the body's failure (observing taken for expecting)",
    file: HELPER,
    patch: (t) =>
      sub(
        t,
        "(call.rejectionsDelivered > 0 || carries(",
        "(call.rejectionsDelivered < 0 || carries(",
      ),
    deltas: {
      P15: {
        status: "failed",
        errors: [
          failsAt(
            'expect(ledger.scopes[0]?.escaped).toEqual(["s1.c1", "s1.c3"]);',
            '-   "s1.c1",',
          ),
        ],
        ledger: null,
      },
      S19: { ...withoutWitness("S19"), native: "caught" },
    },
  },
  {
    id: "HM13",
    title:
      "an expected rejection is witnessed like any other (`expectRejection()` counted as a delivery)",
    file: HELPER,
    patch: (t) =>
      sub(
        t,
        "          call.rejectionExpected = true;\n",
        "          call.rejectionExpected = true;\n          call.rejectionsDelivered += 1;\n",
      ),
    deltas: {
      P14: {
        status: "failed",
        errors: [
          failsAt(
            "expect(ledger.scopes[0]?.calls[0]).toMatchObject({",
            '-   "rejectionsDelivered": 0,',
            '+   "rejectionsDelivered": 1,',
          ),
        ],
        ledger: null,
      },
      S20: healthyWith("S20", (p) => {
        p.errors.push(publisher({ runtime: [["s1.c1", "the failing edit"]] }));
        p.ledger.escaped = [witnessText("s1.c1", "the failing edit")];
        scopeOf(p).escaped = ["s1.c1"];
        Object.assign(scopeOf(p).calls[0], {
          rejectionsDelivered: 1,
          events: [
            "launched",
            "rejected",
            "expected-rejection-delivered",
            "runtime-origin-witnessed",
          ],
        });
        p.native = "refused";
      }),
    },
  },
  {
    id: "HM8",
    title:
      "an operation error that reads like an assertion is reported as written",
    file: LEDGER,
    patch: (t) =>
      sub(t, '  text.replaceAll("expect(", "expect (");', "  text;"),
    // The same failures; only the neutralisation of `expect(` is gone, so their text reads as an assertion except in Firefox.
    deltas: {
      S8: healthyWith("S8", (p) => {
        p.errors[1] = publisher({
          cleanup: [
            [
              "the operation the assertion-like failure failed: ",
              "expect(received).toBe(expected) inside the operation",
            ],
          ],
          raw: true,
          kind: PAGE_ASSERTION_LIKE,
        });
        p.native = "refused";
      }),
      S9: healthyWith("S9", (p) => {
        p.errors = [
          helperError(
            [
              "the operation the assertion-like failure failed: ",
              "expect(received).toBe(expected) inside the operation",
            ],
            { kind: PAGE_ASSERTION_LIKE, raw: true },
          ),
        ];
        p.native = "refused";
      }),
    },
  },
  {
    id: "FM1",
    title: "the fixture's release of an unreached arm leaves it armed",
    file: HARNESS,
    patch: (t) =>
      sub(
        t,
        '    hold.plan = null;\n    outcome = "disarmed";',
        '    outcome = "disarmed";',
      ),
    deltas: {
      P02: {
        status: "failed",
        errors: [
          failsAt(
            "expect(ledger.errors).toEqual([]);",
            "the data.editQueuedDraft hold is still armed after its release",
          ),
        ],
        ledger: null,
      },
      P10: {
        status: "failed",
        errors: [
          failsAt(
            'expect(await releaseRaw(other, "outbox", theirs)).toEqual({',
            '-   "armed": false,',
            '+   "armed": true,',
            '"outcome": "disarmed",',
          ),
        ],
        ledger: null,
      },
      P11: {
        status: "failed",
        errors: [
          failsAt(
            "expect(ledger.errors).toEqual([]);",
            "the data.commitPage hold is still armed after its release",
          ),
        ],
        ledger: null,
      },
    },
  },
  {
    id: "FM2",
    title: "the fixture lets a second arm replace a live one",
    file: HARNESS,
    patch: (t) =>
      sub(
        t,
        "  if (hold.plan !== null || hold.held)\n",
        "  if (hold.plan === Symbol.for(String(hold.held)))\n",
      ),
    // Reached only after both documents' tokens were compared (the line before it), so both identities exist.
    deltas: {
      P10: {
        status: "failed",
        errors: [
          failsAt(
            'await expect(armRaw(other)).rejects.toThrow("one hold at a time");',
            "Received promise resolved instead of rejected",
            '"generation": 2',
          ),
        ],
        ledger: null,
      },
    },
  },
  {
    id: "FM3",
    title: "the fixture's release ignores whose token it is",
    file: HARNESS,
    patch: (t) =>
      sub(
        t,
        "  const stale =\n    token !== undefined &&",
        "  const stale =\n    token === Symbol.for(String(token)) &&",
      ),
    // P05's stale-token assertion fails inside its private scope, so the case reports it as the scope's thrown failure.
    deltas: {
      P05: {
        status: "failed",
        errors: [
          failsAt(
            "expect((thrown as Error | null)?.message).toBe(SENTINEL);",
            "- probe sentinel: the body failed here",
            "toEqual(expected)",
            '-   "outcome": "stale",',
            '+   "outcome": "disarmed",',
          ),
        ],
        ledger: null,
      },
      P09: {
        status: "failed",
        errors: [
          failsAt(
            "expect(cleanup(ledger)).toEqual({",
            '-   "outcome": "stale",',
            '+   "outcome": "disarmed",',
          ),
        ],
        ledger: null,
      },
      P10: {
        status: "failed",
        errors: [
          failsAt(
            'expect(await releaseRaw(page, "outbox", theirs)).toEqual({',
            '-   "outcome": "stale",',
            '+   "outcome": "disarmed",',
          ),
        ],
        ledger: null,
      },
    },
  },
];
for (const mutant of MUTANTS) mutant.probes = Object.keys(mutant.deltas);
export const MUTANT_IDS = MUTANTS.map((m) => m.id);
export const mutantOf = (id) => {
  const mutant = MUTANTS.find((m) => m.id === id);
  if (!mutant) throw new Error(`No contract for mutant ${id}`);
  return mutant;
};

/**
 * Negative controls (design assessment Q5): unmutated probes (NC4: one genuine mutant) with an unrelated fault injected by an opt-in hook
 * appended to a COPY of the probe spec (never the live spec). Each is judged by the named mutant's contract and must be `invalid` in
 * every case: an ordinary error or a hook timeout before the body (review r22's two reproductions), an assertion in setup, and an extra
 * teardown error beside a genuine delta are never a catch.
 */
export const NEGATIVE_CONTROLS = [
  {
    id: "NC1",
    title:
      "an ordinary error before the probe body (review r22 runtime reproduction), judged by HM10's contract",
    contract: "HM10",
    fault: "runtime",
    probes: ["S10", "S11", "S12", "S13", "S14", "S21"],
  },
  {
    id: "NC2",
    title:
      "a beforeEach that never settles, ending at the original 30 s test timeout (review r22 timeout reproduction), judged by HM12's contract",
    contract: "HM12",
    fault: "timeout",
    probes: ["S21"],
  },
  {
    id: "NC3",
    title:
      "an assertion that fails in setup, before a P control's body, judged by HM1's contract",
    contract: "HM1",
    fault: "setup-assertion",
    probes: ["P03"],
  },
  {
    id: "NC4",
    title:
      "an unrelated teardown error beside HM2's genuine delta, judged by HM2's contract",
    contract: "HM2",
    mutant: "HM2",
    fault: "teardown-error",
    probes: ["S1"],
  },
];
/** The hook a negative control appends to its copy of the probe spec; ATLAS_PROBE_FAULT selects the fault, ATLAS_PROBE_FAULT_IDS the probes. */
export const FAULT_HOOK = `
// Revision 23 negative-control hook (appended by scripts/validation/held-operation-probes.mjs to a COPY of this spec, never the live spec).
const faultIds = (process.env.ATLAS_PROBE_FAULT_IDS ?? "").split(",");
const faulted = (title: string) => faultIds.includes(title.split(" ")[0] ?? "");
test.beforeEach(async ({}, info) => {
  if (!faulted(info.title)) return;
  if (process.env.ATLAS_PROBE_FAULT === "runtime")
    throw new Error("negative control: an ordinary runtime error before the probe body");
  if (process.env.ATLAS_PROBE_FAULT === "timeout")
    await new Promise<never>(() => undefined);
  if (process.env.ATLAS_PROBE_FAULT === "setup-assertion")
    expect(1, "negative control: a setup assertion before the probe body").toBe(2);
});
test.afterEach(async ({}, info) => {
  if (faulted(info.title) && process.env.ATLAS_PROBE_FAULT === "teardown-error")
    throw new Error("negative control: an unrelated teardown error after the probe body");
});
`;

// ---------------------------------------------------------------------------------------------------------------------------------------
/** Every contract is total and well formed (design assessment step 2): checked before anything is built or launched. */
export function validateContracts() {
  const problems = [];
  const ids = new Set();
  for (const mutant of MUTANTS) {
    if (ids.has(mutant.id)) problems.push(`${mutant.id}: duplicate mutant`);
    ids.add(mutant.id);
    if (![HELPER, LEDGER, HARNESS].includes(mutant.file))
      problems.push(`${mutant.id}: unknown file ${mutant.file}`);
    if (typeof mutant.patch !== "function")
      problems.push(`${mutant.id}: no patch`);
    if (!mutant.probes.length) problems.push(`${mutant.id}: names no probe`);
    for (const id of mutant.probes) {
      const delta = mutant.deltas[id];
      if (!TITLES[id]) problems.push(`${mutant.id}/${id}: unknown probe`);
      problems.push(
        ...profileProblems(delta).map((p) => `${mutant.id}/${id}: ${p}`),
      );
      if (id.startsWith("S") !== ["caught", "refused"].includes(delta?.native))
        problems.push(`${mutant.id}/${id}: native verdict ${delta?.native}`);
    }
  }
  for (const id of PROBE_IDS) {
    problems.push(...profileProblems(HEALTHY[id]).map((p) => `${id}: ${p}`));
    if (
      id.startsWith("S") !== ["caught", "refused"].includes(HEALTHY[id]?.native)
    )
      problems.push(`${id}: healthy native verdict ${HEALTHY[id]?.native}`);
  }
  for (const nc of NEGATIVE_CONTROLS) {
    const mutant = MUTANTS.find((m) => m.id === nc.contract);
    if (!mutant) problems.push(`${nc.id}: unknown contract ${nc.contract}`);
    else if (nc.probes.some((id) => !mutant.probes.includes(id)))
      problems.push(`${nc.id}: probes outside ${nc.contract}'s contract`);
    if (nc.mutant !== undefined && nc.mutant !== nc.contract)
      problems.push(
        `${nc.id}: a negative control installs its own contract's mutant only`,
      );
  }
  return problems;
}
function profileProblems(profile) {
  if (!profile) return ["no profile"];
  const problems = [];
  if (!["passed", "failed", "timedOut"].includes(profile.status))
    problems.push(`status ${profile.status}`);
  if (!Array.isArray(profile.errors)) return [...problems, "no error list"];
  if ((profile.status === "passed") !== (profile.errors.length === 0))
    problems.push("a passing profile has errors, or a failing one none");
  for (const error of profile.errors) {
    const kinds =
      typeof error.kind === "string"
        ? [error.kind]
        : ENGINES.map((e) => error.kind?.[e]);
    if (kinds.some((k) => !["assertion", "error"].includes(k)))
      problems.push(`error kind ${JSON.stringify(error.kind)} is not total`);
    if (
      error.first === undefined &&
      error.starts === undefined &&
      error.match === undefined &&
      error.publisher === undefined &&
      error.frame === undefined
    )
      problems.push("an error with no identifying text or line");
    if (error.frame !== undefined && error.origin !== "spec")
      problems.push("a source line outside the probe spec");
  }
  if (profile.ledger !== null && typeof profile.ledger !== "object")
    problems.push("ledger is neither a pattern nor null");
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
/**
 * Normalises a Playwright JSON report (design assessment step 1): every case with the unchanged reader's view (scripts/validation/
 * engine-results.mjs: status, attempts, kind, every error's kind) and the full evidence the contracts read: each error's whole text,
 * location and code-frame line (the reader's precedence: the `errors` array, else the single `error`, never both), the attachments by name,
 * the case's own line range in its spec, and its probe id. Nothing is reduced to a deviation string before it is judged.
 *
 * `specText` is the exact text of the probe spec that ran (the tree's copy). A `-g` selection reports only the selected tests, so a test's
 * own range (from its `test(` line to the next one) is taken from the spec itself; a reported test that does not start at a `test(` line
 * of that text means the text is not the spec that ran, and the run is invalid.
 */
export function normalise(report, browsers, exit, specText) {
  if (typeof specText !== "string")
    throw new Error("normalise needs the text of the probe spec that ran");
  const starts = specText
    .split("\n")
    .flatMap((line, i) => (/^[ \t]*test\(/.test(line) ? [i + 1] : []));
  const inspected = inspectReport(report, browsers, exit);
  const raw = [];
  const visit = (suite, parents = []) => {
    for (const spec of suite.specs ?? []) {
      const file = basename(spec.file ?? suite.file);
      for (const test of spec.tests ?? []) {
        const last = (test.results ?? []).at(-1);
        const reported = Array.isArray(last?.errors)
          ? last.errors
          : last?.error
            ? [last.error]
            : [];
        raw.push({
          engine: test.projectName,
          title: [...parents, suite.title, spec.title]
            .filter(Boolean)
            .join(" › "),
          spec: spec.title,
          file,
          line: spec.line,
          reported,
          attachments: last?.attachments ?? [],
        });
      }
    }
    for (const child of suite.suites ?? [])
      visit(child, [...parents, suite.title].filter(Boolean));
  };
  for (const suite of report.suites ?? []) visit(suite);
  if (raw.length !== inspected.cases.length)
    throw new Error("the report's cases could not be paired with the reader's");
  const cases = inspected.cases.map((c, i) => {
    const r = raw[i];
    if (r.engine !== c.engine || r.title !== c.title)
      throw new Error(
        "the report's cases could not be paired with the reader's",
      );
    const after = starts.filter((l) => l > r.line);
    const errors = r.reported.map((e, ordinal) => {
      const text = String(e?.message ?? "")
        .replace(ANSI, "")
        .replace(ESCAPED_ANSI, "");
      const frame = /^>\s*(\d+)\s*\|(.*)$/m.exec(text);
      return {
        ordinal,
        kind: c.errors[ordinal]?.kind,
        first: text.split("\n")[0],
        text,
        location: e?.location
          ? { file: basename(e.location.file), line: e.location.line }
          : null,
        frame: frame ? { line: Number(frame[1]), source: frame[2] } : null,
      };
    });
    const ledgers = r.attachments.filter((a) => a.name === "held-operations");
    let ledger;
    if (ledgers.length === 0) ledger = undefined;
    else if (ledgers.length > 1) ledger = { damaged: "duplicate attachment" };
    else if (ledgers[0].contentType !== "application/json" || !ledgers[0].body)
      ledger = { damaged: "not an inline JSON attachment" };
    else
      try {
        ledger = JSON.parse(
          Buffer.from(ledgers[0].body, "base64").toString("utf8"),
        );
      } catch {
        ledger = { damaged: "unparseable" };
      }
    return {
      engine: c.engine,
      title: c.title,
      spec: r.spec,
      id: r.spec.split(" ")[0],
      status: c.status,
      attempts: c.attempts,
      expectedStatus: c.expectedStatus,
      kind: c.kind,
      errors,
      range: {
        file: r.file,
        from: r.line,
        to: after[0] ?? Number.POSITIVE_INFINITY,
      },
      attachments: r.attachments.map((a) => a.name),
      ledger,
    };
  });
  return {
    exit,
    complete: inspected.complete,
    report_errors: (report.errors ?? []).length,
    spec_mismatch: cases
      .filter(
        (c) =>
          c.range.file !== basename(PROBE_SPEC) ||
          !starts.includes(c.range.from),
      )
      .map((c) => `${c.engine} ${c.id}: ${c.range.file}:${c.range.from}`),
    cases,
  };
}

/** The ledger attachment reduced to what the contracts read: events by name, release details, no stacks, tokens or timings. */
export function ledgerView(attached) {
  if (attached === undefined || attached === null) return attached;
  if (attached.damaged) return attached;
  if (!Array.isArray(attached.scopes)) return { damaged: "no scopes" };
  const detailOf = (events, name) => {
    const found = (events ?? []).filter((e) => e.event === name);
    if (found.length > 1) return { damaged: `${name} recorded twice` };
    return found[0]?.detail;
  };
  return {
    errors: attached.errors,
    escaped: attached.escaped,
    scopes: attached.scopes.map((s) => ({
      finalised: s.finalised,
      bodyFailed: s.bodyFailed,
      escaped: s.escaped,
      problems: s.problems,
      holds: (s.holds ?? []).map((h) => ({
        kind: h.kind,
        plan: h.plan,
        released: h.released,
        events: (h.events ?? []).map((e) => e.event),
        release: detailOf(h.events, "release"),
        cleanup: detailOf(h.events, "cleanup-release"),
      })),
      calls: (s.calls ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        state: c.state,
        joined: c.joined,
        rejectionsDelivered: c.rejectionsDelivered,
        rejectionExpected: c.rejectionExpected,
        events: (c.events ?? []).map((e) => e.event),
        rejection: c.rejection?.type,
      })),
    })),
  };
}

const kindFor = (kind, engine) =>
  typeof kind === "string" ? kind : kind?.[engine.replace(/^fixture-/, "")];

/** Why one reported error does not meet its specification (an empty list when it does). */
function errorProblems(spec, error, c) {
  const problems = [];
  const at = `error ${error.ordinal}`;
  const kind = kindFor(spec.kind, c.engine);
  if (error.kind !== kind)
    problems.push(`${at}: kind ${error.kind}, expected ${kind}`);
  const origins = {
    spec: "probe.held-operation.spec.ts",
    helper: "held-operation.ts",
    ledger: "held-operation-ledger.ts",
  };
  if (spec.origin === "none" && error.location !== null)
    problems.push(
      `${at}: located at ${error.location.file}, expected no location`,
    );
  if (
    spec.origin &&
    spec.origin !== "none" &&
    error.location?.file !== origins[spec.origin]
  )
    problems.push(
      `${at}: located in ${error.location?.file ?? "nothing"}, expected ${origins[spec.origin]}`,
    );
  if (spec.frame !== undefined) {
    if (!error.frame?.source.includes(spec.frame))
      problems.push(
        `${at}: failed at ${JSON.stringify(error.frame?.source?.trim() ?? null)}, not ${JSON.stringify(spec.frame)}`,
      );
    else if (error.frame.line !== error.location?.line)
      problems.push(`${at}: its code frame and location disagree`);
    if (
      spec.own &&
      !(
        error.location?.file === c.range.file &&
        error.location.line >= c.range.from &&
        error.location.line < c.range.to
      )
    )
      problems.push(
        `${at}: line ${error.location?.line} is outside the case's own test (${c.range.from}-${c.range.to})`,
      );
  }
  if (spec.first !== undefined && error.first !== spec.first)
    problems.push(
      `${at}: ${JSON.stringify(error.first)}, expected ${JSON.stringify(spec.first)}`,
    );
  if (spec.starts !== undefined && !error.first.startsWith(spec.starts))
    problems.push(
      `${at}: ${JSON.stringify(error.first)} does not start ${JSON.stringify(spec.starts)}`,
    );
  if (spec.match !== undefined && !spec.match.test(error.first))
    problems.push(
      `${at}: ${JSON.stringify(error.first)} does not match ${spec.match}`,
    );
  for (const part of spec.has ?? [])
    if (!error.first.includes(part))
      problems.push(
        `${at}: ${JSON.stringify(error.first)} lacks ${JSON.stringify(part)}`,
      );
  for (const part of spec.lacks ?? [])
    if (error.first.includes(part))
      problems.push(
        `${at}: ${JSON.stringify(error.first)} has ${JSON.stringify(part)}`,
      );
  for (const part of spec.text ?? [])
    if (!error.text.includes(part))
      problems.push(`${at}: its message lacks ${JSON.stringify(part)}`);
  if (spec.publisher)
    problems.push(...publisherProblems(spec.publisher, error.first, at));
  return problems;
}
function publisherProblems({ cleanup, runtime, raw }, first, at) {
  if (!first.startsWith("Error: ")) return [`${at}: not an Error`];
  const segments = first.slice("Error: ".length).split(" || ");
  const wanted = [
    ...(cleanup.length ? ["cleanup"] : []),
    ...(runtime.length ? ["runtime"] : []),
  ];
  const prefixes = {
    cleanup: "held-operation cleanup failed: ",
    runtime: "held-operation runtime failure: ",
  };
  if (segments.length !== wanted.length)
    return [
      `${at}: ${segments.length} publisher part(s), expected ${wanted.join(" and ")}`,
    ];
  const problems = [];
  wanted.forEach((part, i) => {
    if (!segments[i].startsWith(prefixes[part])) {
      problems.push(`${at}: part ${i} is not the ${part} part`);
      return;
    }
    const entries = segments[i].slice(prefixes[part].length).split(" | ");
    if (part === "cleanup") {
      if (entries.length !== cleanup.length)
        problems.push(
          `${at}: ${entries.length} cleanup entries, expected ${cleanup.length}`,
        );
      else
        cleanup.forEach((parts, j) => {
          if (!parts.every((p) => entries[j].includes(p)))
            problems.push(
              `${at}: cleanup entry ${j} ${JSON.stringify(entries[j])} lacks ${JSON.stringify(parts)}`,
            );
        });
    } else {
      const expected = runtime.map(([id, name]) => witnessText(id, name));
      if (JSON.stringify(entries) !== JSON.stringify(expected))
        problems.push(
          `${at}: witnesses ${JSON.stringify(entries)}, expected ${JSON.stringify(expected)}`,
        );
    }
  });
  if (!raw && first.includes("expect("))
    problems.push(`${at}: the publisher's text reads as an assertion`);
  return problems;
}

/** Why a case does not match a profile: an empty list when it does. */
export function profileMismatch(profile, c) {
  const problems = [];
  if (c.attempts !== 1) problems.push(`${c.attempts} attempt(s)`);
  if (c.expectedStatus !== "passed")
    problems.push(`expected status ${c.expectedStatus}`);
  if (c.status !== profile.status)
    problems.push(`status ${c.status}, expected ${profile.status}`);
  if (c.errors.length !== profile.errors.length)
    problems.push(
      `${c.errors.length} error(s), expected ${profile.errors.length}: ${JSON.stringify(c.errors.map((e) => e.first))}`,
    );
  else
    profile.errors.forEach((spec, i) => {
      problems.push(...errorProblems(spec, c.errors[i], c));
    });
  if (profile.ledger === null) {
    if (c.ledger !== undefined)
      problems.push("a held-operations ledger the probe never publishes");
  } else if (c.ledger === undefined) problems.push("no held-operations ledger");
  else {
    const view = ledgerView(c.ledger);
    if (view.damaged) problems.push(`ledger: ${view.damaged}`);
    else {
      const found = mismatch(view, profile.ledger, "ledger");
      if (found) problems.push(found);
    }
  }
  return problems;
}

/** The unchanged reader's whole-mutant verdict over one shape probe's cases (with and without a matching case expectation). */
function nativeVerdict(run, id, browsers) {
  const mine = run.cases.filter((c) => c.id === id);
  const subset = {
    code: run.exit,
    complete:
      run.complete && mine.length === browsers.length * TITLES[id].length,
    cases: mine,
    failures: mine.filter((c) => c.status !== "passed"),
    failed: mine.filter((c) => c.status !== "passed").map((c) => c.engine),
    passed: mine.filter((c) => c.status === "passed").map((c) => c.engine),
  };
  const matching = classifyMutant(
    { expect: { source: `(?:^|\\s)${id}\\s`, flags: "" } },
    subset,
    browsers,
  );
  const any = classifyMutant({}, subset, browsers);
  return {
    verdict:
      matching.caught && any.caught
        ? "caught"
        : !matching.caught && !any.caught
          ? "refused"
          : "inconsistent",
    matching,
    any,
  };
}

/** The exact inventory: every case of the selected probes in every selected engine, once, and nothing else. */
function inventoryProblems(run, ids, browsers) {
  const expected = browsers.flatMap((b) =>
    ids.flatMap((id) => TITLES[id].map((title) => `fixture-${b}::${title}`)),
  );
  const got = run.cases.map((c) => `${c.engine}::${c.spec}`);
  const problems = [];
  for (const key of new Set([...expected, ...got])) {
    const want = expected.filter((k) => k === key).length;
    const have = got.filter((k) => k === key).length;
    if (want !== have)
      problems.push(`inventory: ${key} ${have} time(s), expected ${want}`);
  }
  return problems;
}
function runProblems(run, ids, browsers) {
  const problems = [];
  if (!run.complete)
    problems.push(
      "incomplete report (missing engine, retried, skipped, interrupted or damaged case, or a report error)",
    );
  if (run.report_errors)
    problems.push(`${run.report_errors} report-level error(s)`);
  if (run.spec_mismatch.length)
    problems.push(
      `the spec text is not the spec that ran: ${run.spec_mismatch.join(", ")}`,
    );
  problems.push(...inventoryProblems(run, ids, browsers));
  const failing = run.cases.some((c) => c.status !== "passed");
  if (failing !== (run.exit !== 0))
    problems.push(`exit ${run.exit} disagrees with the cases`);
  return problems;
}

/** A control run (live or copy tree): complete, exactly inventoried, and every case its healthy profile with its healthy native verdict. */
export function judgeControl(run, ids, browsers) {
  for (const id of ids) if (!TITLES[id]) throw new Error(`Unknown probe ${id}`);
  const problems = runProblems(run, ids, browsers);
  const cases = run.cases.map((c) => {
    const why = HEALTHY[c.id]
      ? profileMismatch(HEALTHY[c.id], c)
      : ["not a selected probe"];
    return {
      engine: c.engine,
      id: c.id,
      spec: c.spec,
      status: c.status,
      kind: c.kind,
      healthy: why.length === 0,
      why,
    };
  });
  for (const c of cases)
    if (!c.healthy) problems.push(`${c.engine} ${c.id}: ${c.why.join("; ")}`);
  const native = {};
  for (const id of ids.filter((i) => i.startsWith("S"))) {
    native[id] = nativeVerdict(run, id, browsers);
    if (native[id].verdict !== HEALTHY[id].native)
      problems.push(
        `${id}: native verdict ${native[id].verdict}, expected ${HEALTHY[id].native}`,
      );
  }
  return { ok: problems.length === 0, problems, cases, native };
}

/**
 * A mutant's (or a negative control's) run judged by the mutant's contract (design assessment step 3): `caught`, `survived` or `invalid`,
 * with every reason. `probes` restricts the judgement to some of the contract's probes (a negative control's selection).
 */
export function judgeMutant(id, run, browsers, probes) {
  const mutant = mutantOf(id);
  const selected = probes ?? mutant.probes;
  for (const p of selected)
    if (!mutant.probes.includes(p))
      throw new Error(`${id} has no contract for ${p}`);
  const problems = runProblems(run, selected, browsers);
  const cases = run.cases.map((c) => {
    const delta = mutant.deltas[c.id];
    const toDelta = delta
      ? profileMismatch(delta, c)
      : ["outside the contract"];
    const toHealthy = HEALTHY[c.id]
      ? profileMismatch(HEALTHY[c.id], c)
      : ["unknown probe"];
    let role;
    if (toDelta.length === 0 && toHealthy.length === 0) role = "invalid";
    else if (toDelta.length === 0) role = "delta";
    else if (toHealthy.length === 0) role = "unchanged";
    else role = "invalid";
    return {
      engine: c.engine,
      id: c.id,
      spec: c.spec,
      status: c.status,
      kind: c.kind,
      role,
      ...(role === "delta" ? {} : { not_delta: toDelta }),
      ...(role === "invalid" ? { not_healthy: toHealthy } : {}),
      ...(toDelta.length === 0 && toHealthy.length === 0
        ? {
            ambiguity:
              "the delta and the healthy profile both match: the contract cannot tell them apart",
          }
        : {}),
    };
  });
  for (const c of cases.filter((x) => x.role === "invalid"))
    problems.push(
      `${c.engine} ${c.id}: invalid (${[...(c.not_delta ?? []), ...(c.ambiguity ? [c.ambiguity] : [])].join("; ")})`,
    );
  const native = {};
  for (const p of selected.filter((x) => x.startsWith("S"))) {
    native[p] = nativeVerdict(run, p, browsers);
    const mine = cases.filter((c) => c.id === p);
    const expected = mine.every((c) => c.role === "delta")
      ? mutant.deltas[p].native
      : mine.every((c) => c.role === "unchanged")
        ? HEALTHY[p].native
        : undefined;
    native[p].expected = expected ?? null;
    if (expected !== undefined && native[p].verdict !== expected)
      problems.push(
        `${p}: native verdict ${native[p].verdict}, expected ${expected}`,
      );
  }
  const verdict =
    problems.length > 0
      ? "invalid"
      : cases.length > 0 && cases.every((c) => c.role === "delta")
        ? "caught"
        : "survived";
  return {
    contract: CONTRACT_VERSION,
    mutant: id,
    probes: selected,
    verdict,
    caught: verdict === "caught",
    problems,
    cases,
    native,
  };
}

/** A negative control passes only when its run is `invalid` and no case of it is a delta or unchanged (never evidence of anything). */
export function judgeNegative(nc, run, browsers) {
  const judged = judgeMutant(nc.contract, run, browsers, nc.probes);
  const refused =
    judged.verdict === "invalid" &&
    judged.cases.length > 0 &&
    judged.cases.every((c) => c.role === "invalid");
  return { ...judged, negative_control: nc.id, refused };
}

/**
 * The campaign's outcome from its parts: exit 0 only when nothing failed or was interrupted, the source is unchanged, and EVERY planned
 * part ran and is sound (each control healthy, each negative control refused, each mutant caught). A survived or invalid mutant, a
 * negative control that was not refused, or a part that never ran fails it, so the shared driver stops before later work.
 */
export function campaignOutcome({
  preflight,
  fatal,
  interrupted,
  sourceUnchanged,
  planned,
  controls,
  negatives,
  mutants,
}) {
  const reasons = [];
  if (interrupted) reasons.push("interrupted");
  if (fatal) reasons.push(`failed: ${fatal.split("\n")[0]}`);
  if (!preflight) reasons.push("preflight did not pass");
  if (!sourceUnchanged) reasons.push("the source changed during the run");
  if (controls.length !== planned.controls)
    reasons.push(`${controls.length} of ${planned.controls} control(s) ran`);
  if (negatives.length !== planned.negatives.length)
    reasons.push(
      `${negatives.length} of ${planned.negatives.length} negative control(s) ran`,
    );
  if (mutants.length !== planned.mutants.length)
    reasons.push(
      `${mutants.length} of ${planned.mutants.length} mutant(s) ran`,
    );
  for (const c of controls)
    if (!c.ok) reasons.push(`control ${c.name} is not healthy`);
  for (const n of negatives)
    if (!n.refused)
      reasons.push(
        `negative control ${n.negative_control} was ${n.verdict}, not refused`,
      );
  for (const m of mutants)
    if (m.verdict !== "caught") reasons.push(`mutant ${m.mutant} ${m.verdict}`);
  return {
    passed: reasons.length === 0,
    exitCode: reasons.length === 0 ? 0 : 1,
    reasons,
  };
}
