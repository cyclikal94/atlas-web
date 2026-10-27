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
//
// Revision 24 (review r23 R23-N1; design assessment e228174c, invariants I1-I12, correction C1-C7): a negative control "passed" when the
// mutant's contract found its run invalid, so an unrelated setup error, a missing engine or a wrong fault qualified as the intended
// scenario. Three judgements are now kept apart: the run's integrity (complete, exact inventory in all three engines, one attempt, the
// spec with exactly the fault hook appended, exit and signal), the scenario (each case is the negative control's own affirmative
// profile: its status, every error at its line of the appended hook, NC2's original 30 s beforeEach timeout, NC4's genuine HM2 delta
// with the teardown error, and no ledger where none is published), and the classifier (the named mutant's contract refuses it). A
// negative control is `qualified` only when all three hold; nothing else is admitted.
//
// Revision 25 (review r24 R24-N1; design assessment 91d0404c, invariants I1-I10, correction C1-C7): a recorded invocation was checked
// only against itself and only when supplied, so a receipt with the wrong report digest, exit, spec, hook or installed patch, a receipt
// of another invocation, or none at all, still qualified. Integrity now requires the VERIFIED evidence bundle of this very run
// (held-operation-evidence.mjs: every claim compared with the bytes and the execution record it names, and the judged report, spec, exit
// and signal being exactly the bundle's). Without it a judgement is a labelled diagnostic and never qualified; the campaign admits only
// verified parts of its own invocation, and a --stage negatives prerequisite is the predecessor's raw controls, re-verified and re-judged.
//
// Revision 28 (review r27 R27-N1/R27-N2; design assessment 3f7047c0 I4-I6, I10, step C5): a part's own integrity is not its run's
// completion. Parts are published while their run is still going; a later change, a failed final collection or an interruption could
// leave a healthy part on disk that the standalone judge (which read only snapshot.json) still admitted. Every completed-run admission
// now consumes the producing run's TERMINAL completion record (completion.json, published exclusively after every process closed, the
// final applicability and seals were checked, the source was compared and the owned directories were removed) through ONE verifier,
// completionProblems: the campaign's split-stage prerequisite and both judge target modes. A missing, partial, failed, foreign or
// legacy completion record is never admission. snapshotProblems (schema /2) also requires the private runtime's seal unchanged at every
// check and the end and removed, every guarded tree unchanged, and the source installation's state unchanged by the preparation.
import { createHash } from "node:crypto";
import { classifyMutant, inspectReport } from "./engine-results.mjs";
import {
  applicabilityReasons,
  canonical,
  compareApplicability,
} from "./held-operation-applicability.mjs";
import {
  EXECUTION_POLICY,
  GENERATED_TREES,
  POLICY_SHA256,
} from "./held-operation-execution.mjs";
import { SNAPSHOT_SCHEMA } from "./held-operation-installation.mjs";

/** The terminal completion record of a held-operation run (revision 28): the only evidence of a COMPLETED run. */
export const COMPLETION_SCHEMA = "web08d-held-operation-completion/1";

export const CONTRACT_VERSION = "web08d-held-operation-qualification/1";
export const NEGATIVE_CONTRACT_VERSION = "web08d-held-operation-negative/3";
/**
 * The evidence bundle's schema (held-operation-evidence.mjs): a part's report, spec, execution record, source, copy inventories and
 * (revision 26) the run's runtime applicability record. A revision 25 bundle (`/1`) is still read and verified as historical evidence,
 * but it records no applicability and is never admitted.
 */
export const EVIDENCE_SCHEMA = "web08d-held-operation-evidence/2";
export const LEGACY_EVIDENCE_SCHEMAS = ["web08d-held-operation-evidence/1"];
/** The negative contract each legacy evidence schema was published under (a revision 25 bundle names negative/2). */
export const LEGACY_NEGATIVE_CONTRACTS = {
  "web08d-held-operation-evidence/1": "web08d-held-operation-negative/2",
};
/** The integrity problem of a judgement made without a verified evidence bundle: a diagnostic, never a qualification. */
export const NO_EVIDENCE =
  "no verified invocation evidence: a diagnostic judgement, never admissible";
const DIGEST = /^[0-9a-f]{64}$/;
const sha256Of = (text) => createHash("sha256").update(text).digest("hex");
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
 * An error raised by the appended fault hook: `hook` is the exact (trimmed) source line it must be located at, which must occur once in
 * the hook; the line number is the hook's own line in the spec that ran (normalise), never a line of a case's body or another hook.
 */
const hookError = (kind, hook, first, ...text) => ({
  kind,
  origin: "spec",
  hook,
  first,
  text,
});
const HM2_S1 = mutantOf("HM2").deltas.S1;
/**
 * Negative controls (design assessment Q5): unmutated probes (NC4: one genuine mutant) with an unrelated fault injected by an opt-in hook
 * appended to a COPY of the probe spec (never the live spec). Each `scenario` is the control's own affirmative profile, case by case: the
 * fault must be shown to have happened, exactly where and as it was injected, with no other fault (revision 24). Independently, the named
 * mutant's contract must refuse the run (every case `invalid`): an ordinary error or a hook timeout before the body, an assertion in
 * setup, and an extra teardown error beside a genuine delta are never a catch.
 */
export const NEGATIVE_CONTROLS = [
  {
    id: "NC1",
    title:
      "an ordinary error before the probe body (review r22 runtime reproduction), judged by HM10's contract",
    contract: "HM10",
    fault: "runtime",
    probes: ["S10", "S11", "S12", "S13", "S14", "S21"],
    // The beforeEach throws before the body: its error alone, and no held-operations ledger (the body never ran).
    scenario: {
      status: "failed",
      errors: [
        hookError(
          "error",
          'throw new Error("negative control: an ordinary runtime error before the probe body");',
          "Error: negative control: an ordinary runtime error before the probe body",
        ),
      ],
      ledger: null,
    },
  },
  {
    id: "NC2",
    title:
      "a beforeEach that never settles, ending at the original 30 s test timeout (review r22 timeout reproduction), judged by HM12's contract",
    contract: "HM12",
    fault: "timeout",
    probes: ["S21"],
    // The original 30 s test timeout, spent in the appended beforeEach (Playwright locates a hook timeout at the hook's declaration).
    scenario: {
      status: "timedOut",
      minDuration: 30000,
      errors: [
        hookError(
          "error",
          "test.beforeEach(async ({}, info) => {",
          'Test timeout of 30000ms exceeded while running "beforeEach" hook.',
        ),
      ],
      ledger: null,
    },
  },
  {
    id: "NC3",
    title:
      "an assertion that fails in setup, before a P control's body, judged by HM1's contract",
    contract: "HM1",
    fault: "setup-assertion",
    probes: ["P03"],
    // Both P03 parameterisations, each failing at the setup assertion with its own expected and received values.
    scenario: {
      status: "failed",
      errors: [
        hookError(
          "assertion",
          'expect(1, "negative control: a setup assertion before the probe body").toBe(2);',
          "Error: negative control: a setup assertion before the probe body",
          "Expected: 2",
          "Received: 1",
        ),
      ],
      ledger: null,
    },
  },
  {
    id: "NC4",
    title:
      "an unrelated teardown error beside HM2's genuine delta, judged by HM2's contract",
    contract: "HM2",
    mutant: "HM2",
    fault: "teardown-error",
    probes: ["S1"],
    // HM2's genuine S1 delta (the intended assertion in S1's own test, the unjoined-call publisher error and its ledger) with the
    // teardown error between them: the afterEach hook runs before the heldOperations fixture's teardown publishes.
    scenario: {
      status: "failed",
      errors: [
        HM2_S1.errors[0],
        hookError(
          "error",
          'throw new Error("negative control: an unrelated teardown error after the probe body");',
          "Error: negative control: an unrelated teardown error after the probe body",
        ),
        HM2_S1.errors[1],
      ],
      ledger: HM2_S1.ledger,
    },
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
export const FAULTS = [
  "runtime",
  "timeout",
  "setup-assertion",
  "teardown-error",
];
/**
 * Where the fault hook is in a spec text (null when it is absent): whether it occurs once and is appended at the very end (the runner's
 * copy is exactly the live spec followed by it), the line it starts at, and the line number of each of its lines that occurs once in it.
 */
export function faultHookOf(specText) {
  const at = specText.indexOf(FAULT_HOOK);
  if (at < 0) return null;
  const base = specText.slice(0, at).split("\n").length;
  const own = FAULT_HOOK.split("\n").map((l) => l.trim());
  const lines = {};
  own.forEach((line, j) => {
    if (line && own.indexOf(line) === own.lastIndexOf(line))
      lines[line] = base + j;
  });
  return {
    once: specText.indexOf(FAULT_HOOK, at + 1) < 0,
    appended: at + FAULT_HOOK.length === specText.length,
    from: base + 1,
    lines,
  };
}

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
  const negativeIds = new Set();
  const hookLines = faultHookOf(FAULT_HOOK).lines;
  for (const nc of NEGATIVE_CONTROLS) {
    if (negativeIds.has(nc.id))
      problems.push(`${nc.id}: duplicate negative control`);
    negativeIds.add(nc.id);
    const mutant = MUTANTS.find((m) => m.id === nc.contract);
    if (!mutant) problems.push(`${nc.id}: unknown contract ${nc.contract}`);
    else if (nc.probes.some((id) => !mutant.probes.includes(id)))
      problems.push(`${nc.id}: probes outside ${nc.contract}'s contract`);
    if (!nc.probes.length || new Set(nc.probes).size !== nc.probes.length)
      problems.push(`${nc.id}: an empty or repeated probe selection`);
    if (nc.mutant !== undefined && nc.mutant !== nc.contract)
      problems.push(
        `${nc.id}: a negative control installs its own contract's mutant only`,
      );
    if (
      !FAULTS.includes(nc.fault) ||
      !FAULT_HOOK.includes(`process.env.ATLAS_PROBE_FAULT === "${nc.fault}"`)
    )
      problems.push(`${nc.id}: unknown fault ${nc.fault}`);
    problems.push(
      ...profileProblems(nc.scenario).map((p) => `${nc.id} scenario: ${p}`),
    );
    if (nc.scenario?.status === "passed")
      problems.push(`${nc.id} scenario: a negative control's cases fail`);
    const hooked = (nc.scenario?.errors ?? []).filter((e) => e.hook);
    if (!hooked.length)
      problems.push(`${nc.id} scenario: no error raised by the fault hook`);
    for (const e of hooked)
      if (!hookLines[e.hook])
        problems.push(
          `${nc.id} scenario: ${JSON.stringify(e.hook)} is not a line that occurs once in the fault hook`,
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
 * of that text means the text is not the spec that ran, and the run is invalid. `signal` is the signal that ended Playwright, if any
 * (a run ended by a signal is never a completed run, whatever exit code it was given).
 */
export function normalise(report, browsers, exit, specText, signal = null) {
  if (typeof specText !== "string")
    throw new Error("normalise needs the text of the probe spec that ran");
  const starts = specText
    .split("\n")
    .flatMap((line, i) => (/^[ \t]*test\(/.test(line) ? [i + 1] : []));
  // An appended fault hook ends the last test's own lines (revision 24): its lines belong to no case.
  const faultHook = faultHookOf(specText);
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
          duration: last?.duration,
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
    const after = [
      ...starts.filter((l) => l > r.line),
      ...(faultHook && faultHook.from > r.line ? [faultHook.from] : []),
    ];
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
      duration: r.duration,
      errors,
      range: {
        file: r.file,
        from: r.line,
        to: after.length ? Math.min(...after) : Number.POSITIVE_INFINITY,
      },
      hook: faultHook?.lines ?? null,
      attachments: r.attachments.map((a) => a.name),
      ledger,
    };
  });
  return {
    exit,
    signal,
    fault_hook: faultHook
      ? {
          once: faultHook.once,
          appended: faultHook.appended,
          from: faultHook.from,
        }
      : null,
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
  if (spec.hook !== undefined) {
    // Raised at that one line of the appended fault hook: located there, with its code frame on the same line and text.
    const line = c.hook?.[spec.hook];
    if (line === undefined)
      problems.push(
        `${at}: the spec that ran has no fault hook line ${JSON.stringify(spec.hook)}`,
      );
    else if (
      error.location?.file !== basename(PROBE_SPEC) ||
      error.location.line !== line ||
      error.frame?.line !== line ||
      error.frame.source.trim() !== spec.hook
    )
      problems.push(
        `${at}: raised at ${error.location?.file ?? "nothing"}:${error.location?.line ?? "-"} (${JSON.stringify(error.frame?.source?.trim() ?? null)}), not at the fault hook's line ${line} ${JSON.stringify(spec.hook)}`,
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
  if (
    profile.minDuration !== undefined &&
    !(Number.isFinite(c.duration) && c.duration >= profile.minDuration)
  )
    problems.push(
      `ran ${c.duration ?? "an unrecorded time"} ms, not the ${profile.minDuration} ms it must spend`,
    );
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
  if (run.signal) problems.push(`Playwright was ended by ${run.signal}`);
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

const sameList = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((x, i) => x === b[i]);

/**
 * Why a judged run is not the run its verified evidence bundle records (revision 25, design assessment C3, I2, I3): the bundle must be a
 * verified negative-control bundle of this very control (held-operation-evidence.mjs verifyBundle), and the report, spec, exit and signal
 * that were judged must be exactly the ones it binds. A supplied record is never its own proof: `status` is the verifier's result over the
 * bytes, and every digest is compared with the run's own.
 */
export function evidenceProblems(nc, run, evidence) {
  if (evidence === null || typeof evidence !== "object")
    return ["no invocation evidence"];
  const problems = [];
  // A revision 25 bundle is still verifiable evidence of its own bytes; it records no applicability, so it is never admitted (I5).
  if (
    evidence.schema !== EVIDENCE_SCHEMA &&
    !LEGACY_EVIDENCE_SCHEMAS.includes(evidence.schema)
  )
    problems.push(`evidence schema ${evidence.schema}, not ${EVIDENCE_SCHEMA}`);
  if (evidence.status !== "verified")
    problems.push(
      `the invocation evidence is ${evidence.status ?? "unverified"}`,
    );
  for (const p of Array.isArray(evidence.problems)
    ? evidence.problems
    : ["the evidence lists no problems array"])
    problems.push(`evidence: ${p}`);
  if (evidence.kind !== "negative" || evidence.part !== nc.id)
    problems.push(
      `the evidence is ${evidence.kind} part ${evidence.part}, not negative control ${nc.id}`,
    );
  for (const name of ["manifest_sha256", "source_sha256"])
    if (!DIGEST.test(String(evidence[name])))
      problems.push(`the evidence has no ${name}`);
  if (typeof evidence.invocation !== "string" || !evidence.invocation)
    problems.push("the evidence names no invocation");
  if (
    !DIGEST.test(String(run.report_sha256)) ||
    run.report_sha256 !== evidence.report_sha256
  )
    problems.push(
      `the judged report (${run.report_sha256}) is not the bundle's (${evidence.report_sha256})`,
    );
  if (
    !DIGEST.test(String(run.spec_sha256)) ||
    run.spec_sha256 !== evidence.spec_sha256
  )
    problems.push(
      `the judged spec (${run.spec_sha256}) is not the bundle's (${evidence.spec_sha256})`,
    );
  if (run.exit !== evidence.execution?.exit)
    problems.push(
      `the judged exit ${run.exit} is not the recorded execution's ${evidence.execution?.exit}`,
    );
  if (run.signal !== evidence.execution?.signal)
    problems.push(
      `the judged signal ${run.signal} is not the recorded execution's ${evidence.execution?.signal}`,
    );
  return problems;
}

/**
 * A negative control's run (revision 24, design assessment C2): three separate judgements, all of which must hold.
 *  - integrity: complete, the exact inventory in all three engines (a narrower selection is a diagnostic, never a qualification), one
 *    attempt each, no report error or signal, exit 1, the spec that ran being a spec with exactly the fault hook appended once at its
 *    end, and its verified evidence bundle (evidenceProblems; revision 25: without one the judgement is a diagnostic, never qualified);
 *  - scenario: every case is the control's affirmative `scenario` profile (the fault really happened, where and as injected, alone);
 *  - classifier: the named mutant's contract (judgeMutant, unchanged) refuses the run, every case `invalid`.
 * `qualified` is their conjunction, and the only result any consumer admits. A classifier refusal alone proves nothing.
 *
 * Revision 26 (review r25 R25-N1; design assessment 26f1a626 I2): a fourth, separate fact, the evidence's runtime APPLICABILITY to its
 * consumer (held-operation-evidence.mjs applicabilityOf: the bundle's record compared with the consumer's own). Integrity, scenario and
 * classifier say what the bytes show; applicability says whether they apply here. `qualified` needs it to be `applicable`; a judgement
 * whose other three hold is `historical` without a target and `inapplicable` with a target it does not match.
 */
export function judgeNegative(nc, run, browsers, evidence) {
  const integrity = runProblems(run, nc.probes, browsers);
  const coverage =
    browsers.length === ENGINES.length &&
    ENGINES.every((e) => browsers.includes(e))
      ? "full"
      : "narrow";
  if (coverage !== "full")
    integrity.push(
      `narrow engine selection ${browsers.join(",")}: a negative control qualifies only in ${ENGINES.join(", ")}`,
    );
  if (run.exit !== 1) integrity.push(`exit ${run.exit}, expected 1`);
  if (!run.fault_hook)
    integrity.push("the spec that ran has no negative-control fault hook");
  else if (!run.fault_hook.once || !run.fault_hook.appended)
    integrity.push(
      "the spec that ran is not a spec with exactly the fault hook appended once at its end",
    );
  if (evidence === undefined) integrity.push(NO_EVIDENCE);
  else integrity.push(...evidenceProblems(nc, run, evidence));
  const cases = run.cases.map((c) => {
    const why = nc.probes.includes(c.id)
      ? profileMismatch(nc.scenario, c)
      : ["not a selected probe"];
    return {
      engine: c.engine,
      id: c.id,
      spec: c.spec,
      status: c.status,
      valid: why.length === 0,
      why,
    };
  });
  const scenario = cases
    .filter((c) => !c.valid)
    .map((c) => `${c.engine} ${c.id}: ${c.why.join("; ")}`);
  if (!cases.length) scenario.push("no case ran");
  const judged = judgeMutant(nc.contract, run, browsers, nc.probes);
  const refused =
    judged.verdict === "invalid" &&
    judged.cases.length > 0 &&
    judged.cases.every((c) => c.role === "invalid");
  const applicability =
    evidence === undefined
      ? {
          decision: "unassessed",
          reasons: ["a diagnostic without evidence has no applicability"],
        }
      : evidence?.applicability && typeof evidence.applicability === "object"
        ? evidence.applicability
        : {
            decision: "unknown",
            reasons: ["the evidence carries no applicability decision"],
          };
  const holds = integrity.length === 0 && scenario.length === 0 && refused;
  const qualified = holds && applicability.decision === "applicable";
  return {
    contract: NEGATIVE_CONTRACT_VERSION,
    negative_control: nc.id,
    fault: nc.fault,
    probes: nc.probes,
    coverage,
    mode: evidence === undefined ? "diagnostic" : "bound",
    evidence: evidence ?? null,
    integrity: { valid: integrity.length === 0, problems: integrity },
    scenario: { valid: scenario.length === 0, problems: scenario, cases },
    classifier: {
      contract: judged.contract,
      mutant: judged.mutant,
      verdict: judged.verdict,
      refused,
      problems: judged.problems,
      cases: judged.cases,
      native: judged.native,
    },
    applicability,
    qualified,
    outcome: qualified
      ? "qualified"
      : !holds
        ? "unqualified"
        : applicability.decision === "unassessed"
          ? "historical"
          : "inapplicable",
    problems: [
      ...integrity.map((p) => `integrity: ${p}`),
      ...scenario.map((p) => `scenario: ${p}`),
      ...(applicability.decision === "applicable" || evidence === undefined
        ? []
        : (Array.isArray(applicability.reasons) && applicability.reasons.length
            ? applicability.reasons
            : [`decision ${applicability.decision}`]
          ).map((r) => `applicability ${applicability.decision}: ${r}`)),
      ...(refused
        ? []
        : [
            `classifier: ${nc.contract}'s contract judged it ${judged.verdict}, not invalid in every case`,
          ]),
    ],
  };
}

/** Why a set of recorded parts is not exactly the planned one: each planned identity once, nothing unplanned. */
function identityProblems(kind, planned, got) {
  const problems = [];
  if (new Set(planned).size !== planned.length)
    problems.push(`the plan names a ${kind} twice`);
  for (const id of new Set([...planned, ...got])) {
    const want = planned.filter((p) => p === id).length;
    const have = got.filter((g) => g === id).length;
    if (!want) problems.push(`${kind} ${id} was not planned`);
    else if (have !== want)
      problems.push(`${kind} ${id} ran ${have} time(s), planned once`);
  }
  return problems;
}

/**
 * Revision 27 (review r26 R26-N1; design assessment eff76566 I4, I5, H5, H8): why a run's EXECUTION SNAPSHOT record (its snapshot.json,
 * held-operation-installation.mjs) does not show that it executed exactly what its applicability record measured. The snapshot must be
 * of the current schema; sealed with a stat inventory that every check before a child started and the check at the end found unchanged;
 * removed; and bound to the record (`record`: the installation digest and root the run measured and judged under). A missing snapshot
 * (a revision 26 or earlier run) is unknown, never "unchanged".
 *
 * Revision 28 (review r27 R27-N1/N2; design assessment 3f7047c0 I2-I4, I7): schema /2 also records the PRIVATE RUNTIME every child ran
 * from (held-operation-execution.mjs): sealed before the first launch, unchanged at every check (the ones before the snapshot was sealed
 * included) and at the end, removed, and bound to the record's `runtime` digest and root; every guarded tree (a copied test tree once its
 * patches were installed, a completed build, a mutant's build input) unchanged at every later check and at the end; and the source
 * installation's state the same after preparation as before it. One failed check stays a failure: nothing later clears it.
 *
 * Revision 29 (review r28 R28-N1; design assessment d3cff73e I6, I7): the snapshot record must also name the CURRENT execution policy
 * (held-operation-execution.mjs EXECUTION_POLICY and its digest), the same one its applicability record names, and show each of the
 * policy's generated directories guarded empty (its own entry sealed) from sealing to the end. A record of an older or missing policy
 * is unknown: what generated code it ran was never classified, and nothing is inferred from an empty list of checks.
 */
export function snapshotProblems(snapshot, record) {
  if (!snapshot || typeof snapshot !== "object")
    return [
      "no execution snapshot record: what the run executed is unknown (a revision 26 or earlier run, or an unreadable record)",
    ];
  const problems = [];
  if (snapshot.schema !== SNAPSHOT_SCHEMA)
    problems.push(
      `its execution snapshot is of schema ${JSON.stringify(snapshot.schema)}, not ${SNAPSHOT_SCHEMA}`,
    );
  if (!DIGEST.test(String(snapshot.sealed_sha256)))
    problems.push("its execution snapshot was never sealed");
  const checks = Array.isArray(snapshot.checks) ? snapshot.checks : null;
  if (!checks) problems.push("its execution snapshot records no checks");
  for (const c of checks ?? [])
    if (c?.sha256 !== snapshot.sealed_sha256)
      problems.push(
        `its execution snapshot changed (${c?.when ?? "at a check"})`,
      );
  if (snapshot.end_sha256 !== snapshot.sealed_sha256)
    problems.push(
      "its execution snapshot changed by the end of the run (or was not checked at the end)",
    );
  if (snapshot.unchanged !== true)
    problems.push("its execution snapshot is not recorded unchanged");
  if (snapshot.removed !== true)
    problems.push(
      `its execution snapshot was not removed: ${snapshot.removal_error ?? "no removal recorded"}`,
    );
  // Revision 28: the private runtime.
  if (!DIGEST.test(String(snapshot.runtime_sealed_sha256)))
    problems.push("its private runtime was never sealed");
  const early = Array.isArray(snapshot.runtime_checks)
    ? snapshot.runtime_checks
    : null;
  if (!early)
    problems.push("its private runtime records no checks before sealing");
  for (const c of [...(early ?? []), ...(checks ?? [])])
    if (c?.runtime_sha256 !== snapshot.runtime_sealed_sha256)
      problems.push(`its private runtime changed (${c?.when ?? "at a check"})`);
  if (snapshot.runtime_end_sha256 !== snapshot.runtime_sealed_sha256)
    problems.push(
      "its private runtime changed by the end of the run (or was not checked at the end)",
    );
  if (snapshot.runtime_removed !== true)
    problems.push(
      `its private runtime was not removed: ${snapshot.runtime_removal_error ?? "no removal recorded"}`,
    );
  const trees =
    snapshot.trees && typeof snapshot.trees === "object"
      ? snapshot.trees
      : null;
  if (!trees) problems.push("its guarded trees are not recorded");
  for (const [name, t] of Object.entries(trees ?? {})) {
    if (!DIGEST.test(String(t?.sealed_sha256)))
      problems.push(`its guarded tree ${name} was never sealed`);
    if (snapshot.trees_end?.[name] !== t?.sealed_sha256)
      problems.push(
        `its guarded tree ${name} changed by the end of the run (or was not checked at the end)`,
      );
  }
  for (const c of checks ?? [])
    for (const [name, digest] of Object.entries(c?.trees ?? {}))
      if (digest !== trees?.[name]?.sealed_sha256)
        problems.push(`its guarded tree ${name} changed (${c.when})`);
  if (
    !DIGEST.test(String(snapshot.source_state_before_sha256)) ||
    snapshot.source_state_after_sha256 !== snapshot.source_state_before_sha256
  )
    problems.push(
      "the source installation is not recorded unchanged by the snapshot's preparation",
    );
  // Revision 29 (review r28 R28-N1): the execution policy every child ran under, its guarded-empty generated directories included. A
  // record of an older or missing policy is unknown: nothing it does not record (what generated code ran) is inferred.
  const policy = snapshot.policy;
  if (policy?.id !== EXECUTION_POLICY || policy?.sha256 !== POLICY_SHA256)
    problems.push(
      `its execution ran under no current execution policy (${policy?.id ?? "none recorded"}, ${policy?.sha256 ?? "no digest"}; this reader requires ${EXECUTION_POLICY})`,
    );
  for (const name of GENERATED_TREES)
    if (trees?.[name]?.entries !== 0 || typeof trees?.[name]?.self !== "string")
      problems.push(`its ${name} was not guarded empty from sealing`);
  if (!record || typeof record !== "object")
    problems.push(
      "its execution snapshot cannot be bound: there is no applicability record of what it measured",
    );
  else {
    if (snapshot.installation_sha256 !== record.installation?.sha256)
      problems.push(
        `its execution snapshot measured installation ${snapshot.installation_sha256}, but its applicability record names ${record.installation?.sha256}`,
      );
    if (!snapshot.root || snapshot.root !== record.installation?.root)
      problems.push(
        `its execution snapshot is ${snapshot.root}, but its applicability record was collected at ${record.installation?.root}`,
      );
    if (
      !DIGEST.test(String(snapshot.runtime_sha256)) ||
      snapshot.runtime_sha256 !== record.runtime?.sha256
    )
      problems.push(
        `its private runtime measured ${snapshot.runtime_sha256}, but its applicability record names ${record.runtime?.sha256}`,
      );
    if (
      !snapshot.runtime_root ||
      snapshot.runtime_root !== record.runtime?.root
    )
      problems.push(
        `its private runtime is ${snapshot.runtime_root}, but its applicability record was collected from ${record.runtime?.root}`,
      );
    if (record.runtime?.policy_sha256 !== policy?.sha256)
      problems.push(
        `its execution ran under policy ${policy?.sha256}, but its applicability record names ${record.runtime?.policy_sha256}`,
      );
  }
  return problems;
}

/**
 * Revision 28 (review r27 R27-N1; design assessment 3f7047c0 I6, H10, H12, H13, step C5): why a producing run is not COMPLETED evidence.
 * `run` is what a reader read from the run directory, each file once (held-operation-evidence.mjs readRunCompletion): the completion
 * record, the applicability records before and after, the snapshot record and the summary, each with its bytes' digest. `expect` names
 * the invocation (the run directory's name) and, for a part, its name and its manifest's digest (and the digest of the record the part
 * carries). The completion record must be of the current schema, of that invocation, terminal and passed; every digest it binds must
 * be the bytes read now; the runtime must have stayed applicable to itself from start to end; the snapshot record must show sealed,
 * unchanged, removed execution of that record; and the part must be one the run completed with. Returns the problems.
 */
export function completionProblems(run, expect = {}) {
  const c = run?.completion?.record;
  if (!c || typeof c !== "object")
    return [
      "no completion record: the producing run never completed (it was interrupted, is still running, or is of revision 27 or earlier), so none of its parts is admitted",
    ];
  const problems = [];
  if (c.schema !== COMPLETION_SCHEMA)
    problems.push(
      `its completion record is of schema ${JSON.stringify(c.schema)}, not ${COMPLETION_SCHEMA}`,
    );
  if (!expect.invocation || c.invocation !== expect.invocation)
    problems.push(
      `its completion record is of invocation ${c.invocation}, not ${expect.invocation}`,
    );
  if (c.passed !== true)
    problems.push(
      `the producing run did not pass: ${(Array.isArray(c.reasons) ? c.reasons : []).slice(0, 3).join("; ") || "no reason recorded"}`,
    );
  if (c.processes_closed !== true)
    problems.push("its completion record does not show every process closed");
  // Revision 29: the execution policy the run's own records bind (an older or missing policy is never admitted).
  if (
    c.policy !== EXECUTION_POLICY ||
    c.policy_sha256 !== POLICY_SHA256 ||
    c.policy_sha256 !==
      run.applicability?.before?.record?.runtime?.policy_sha256
  )
    problems.push(
      `its completion record names execution policy ${c.policy ?? "none"} (${c.policy_sha256 ?? "no digest"}), not the current ${EXECUTION_POLICY} its run's applicability record binds`,
    );
  if (
    !DIGEST.test(String(c.source_sha256)) ||
    c.source_after_sha256 !== c.source_sha256
  )
    problems.push("its source is not recorded unchanged from start to end");
  const before = run.applicability?.before;
  const after = run.applicability?.after;
  if (!before?.sha256 || c.applicability_sha256 !== before.sha256)
    problems.push(
      `its completion record binds applicability ${c.applicability_sha256}, not the run's recorded ${before?.sha256}`,
    );
  if (expect.record_sha256 && c.applicability_sha256 !== expect.record_sha256)
    problems.push(
      `its completion record binds applicability ${c.applicability_sha256}, but the part carries ${expect.record_sha256}`,
    );
  if (!after?.sha256 || c.applicability_after_sha256 !== after.sha256)
    problems.push(
      `its completion record binds the final applicability ${c.applicability_after_sha256}, not the run's recorded ${after?.sha256}`,
    );
  if (after?.record && before?.record) {
    const cmp = compareApplicability(before.record, after.record);
    if (cmp.decision !== "applicable")
      problems.push(
        ...applicabilityReasons(cmp).map(
          (r) =>
            `its completed run's records differ from start to end (${cmp.decision}): ${r}`,
        ),
      );
  } else
    problems.push("its applicability before or after the run is unreadable");
  if (!run.snapshot?.sha256 || c.snapshot_sha256 !== run.snapshot.sha256)
    problems.push(
      `its completion record binds snapshot record ${c.snapshot_sha256}, not the run's ${run.snapshot?.sha256}`,
    );
  problems.push(...snapshotProblems(run.snapshot?.record, before?.record));
  if (!run.summary?.sha256 || c.summary_sha256 !== run.summary.sha256)
    problems.push(
      `its completion record binds summary ${c.summary_sha256}, not the run's ${run.summary?.sha256}`,
    );
  if (expect.part) {
    const bound = c.parts?.[expect.part];
    if (!DIGEST.test(String(bound)) || bound !== expect.manifest_sha256)
      problems.push(
        `its completion record binds part ${expect.part} to manifest ${bound}, not ${expect.manifest_sha256}`,
      );
  }
  return problems;
}

/**
 * A `--stage negatives` run's prerequisite (design assessment C3): a passed `--stage controls` run of the same source, engines and
 * contract whose live and copy controls covered every probe the negative controls inject into. Returns why it is not.
 *
 * Revision 25 (design assessment 91d0404c C5, I7): its summary is a derived view and never enough. `evidence.controls` must be both
 * controls' RAW evidence, re-read, re-verified (held-operation-evidence.mjs judgeControlEvidence) and re-judged healthy now: each a
 * verified bundle of that run (`evidence.invocation`) on this source, in these engines, covering the probes, and agreeing with the summary.
 *
 * Revision 26 (review r25 R25-N1; design assessment 26f1a626 I3-I6, step 4): and of a runtime that applies HERE. `target` is the
 * applicability record this consumer collected from its own environment before anything is built. The producing run's records before
 * and after it ran (`evidence.applicability.before/after`, its applicability.json and applicability-after.json) must be complete and
 * agree with each other and with the target, field by field; each control's bundle must carry exactly that run's record and be judged
 * applicable to this target; its inputs' Node/platform/architecture must be its record's. A missing record (a revision 25 run) is
 * unknown, never equal. Source equality says nothing about any of this.
 *
 * Revision 27 (review r26 R26-N1; design assessment eff76566 I4, I5, H8): the records now name the complete installed content, and the
 * producing run's execution snapshot (`evidence.snapshot`, its snapshot.json) must show that it executed exactly that content, unchanged
 * from sealing to its end (snapshotProblems). An unchanged installation that a controls run measured but did not execute from, or one
 * that changed and was restored during it, does not admit its controls.
 */
export function prerequisiteProblems(
  evidence,
  { source, browsers, probes, target },
) {
  const problems = [];
  const summary = evidence?.summary;
  if (!summary) return ["no controls evidence"];
  const targetSha =
    target && typeof target === "object" ? sha256Of(canonical(target)) : null;
  if (!targetSha)
    problems.push(
      "no consuming target: this consumer's own runtime applicability was not collected",
    );
  const before = evidence.applicability?.before;
  const after = evidence.applicability?.after;
  if (!before?.record)
    problems.push(
      "the controls run recorded no applicability before it ran (a revision 25 or earlier run, or an unreadable record): its runtime is unknown",
    );
  if (!after?.record)
    problems.push(
      "the controls run recorded no applicability after it ran: its runtime at the end is unknown",
    );
  if (before?.record && after?.record) {
    const c = compareApplicability(before.record, after.record);
    if (c.decision !== "applicable")
      problems.push(
        ...applicabilityReasons(c).map(
          (r) => `its runtime changed during the run (${c.decision}): ${r}`,
        ),
      );
  }
  if (before?.record && targetSha) {
    const c = compareApplicability(target, before.record);
    if (c.decision !== "applicable")
      problems.push(
        ...applicabilityReasons(c).map(
          (r) =>
            `its controls do not apply to this consumer (${c.decision}): ${r}`,
        ),
      );
  }
  if (before?.record)
    for (const key of ["node", "platform", "arch"])
      if (evidence.inputs_runtime?.[key] !== before.record.controller?.[key])
        problems.push(
          `its inputs record ${key} ${JSON.stringify(evidence.inputs_runtime?.[key])}, but its applicability record's controller ${JSON.stringify(before.record.controller?.[key])}`,
        );
  if (summary.applicability_sha256 !== before?.sha256)
    problems.push(
      `its summary names applicability ${summary.applicability_sha256}, not its recorded ${before?.sha256}`,
    );
  problems.push(
    ...snapshotProblems(evidence.snapshot, before?.record).map(
      (p) => `the controls run: ${p}`,
    ),
  );
  // Revision 28: the producing run's terminal completion record, binding exactly these two raw controls.
  for (const name of ["control", "copy-control"]) {
    const raw = (evidence.controls ?? []).find((x) => x.name === name);
    problems.push(
      ...completionProblems(evidence.completion, {
        invocation: evidence.invocation,
        part: name,
        manifest_sha256: raw?.evidence?.manifest_sha256,
        record_sha256: raw?.evidence?.applicability_sha256,
      }).map((p) => `the controls run (${name}): ${p}`),
    );
  }
  if (summary.passed !== true) problems.push("the controls run did not pass");
  if (summary.stage !== "controls")
    problems.push(`the evidence is a ${summary.stage} run, not a controls run`);
  if (summary.contract !== CONTRACT_VERSION)
    problems.push(`contract ${summary.contract}, not ${CONTRACT_VERSION}`);
  if (summary.source_unchanged !== true)
    problems.push("its source changed during the run");
  if (evidence.source !== source)
    problems.push(
      `it ran on source ${evidence.source}, not this run's ${source}`,
    );
  if (!sameList(summary.browsers, browsers))
    problems.push(
      `it ran in ${JSON.stringify(summary.browsers)}, not ${JSON.stringify(browsers)}`,
    );
  problems.push(
    ...identityProblems(
      "control",
      ["control", "copy-control"],
      (summary.controls ?? []).map((c) => c.name),
    ),
  );
  for (const c of summary.controls ?? [])
    if (c.ok !== true) problems.push(`control ${c.name} is not healthy`);
  const covered = summary.control_probes ?? [];
  const missing = probes.filter((p) => !covered.includes(p));
  if (missing.length)
    problems.push(`its controls did not cover ${missing.join(", ")}`);
  const raw = Array.isArray(evidence.controls) ? evidence.controls : [];
  problems.push(
    ...identityProblems(
      "re-verified control",
      ["control", "copy-control"],
      raw.map((c) => c.name),
    ),
  );
  for (const c of raw) {
    const e = c.evidence;
    if (e?.status !== "verified")
      problems.push(
        `control ${c.name}'s raw evidence is ${e?.status ?? "missing"}: ${(e?.problems ?? []).slice(0, 3).join("; ")}`,
      );
    if (e?.invocation !== evidence.invocation || !evidence.invocation)
      problems.push(
        `control ${c.name}'s evidence is invocation ${e?.invocation}, not the prerequisite run ${evidence.invocation}`,
      );
    if (e?.source_sha256 !== source)
      problems.push(
        `control ${c.name}'s evidence ran on source ${e?.source_sha256}, not ${source}`,
      );
    if (c.healthy !== true)
      problems.push(
        `control ${c.name} re-judged from its raw report is not healthy`,
      );
    const a = c.applicability ?? e?.applicability;
    if (a?.decision !== "applicable")
      problems.push(
        `control ${c.name}'s raw evidence is ${a?.decision ?? "unassessed"} for this consumer: ${(a?.reasons ?? []).slice(0, 3).join("; ")}`,
      );
    if (!targetSha || a?.target_sha256 !== targetSha)
      problems.push(
        `control ${c.name} was judged against applicability target ${a?.target_sha256}, not this consumer's ${targetSha}`,
      );
    if (!before?.sha256 || e?.applicability_sha256 !== before.sha256)
      problems.push(
        `control ${c.name}'s bundle carries applicability ${e?.applicability_sha256}, not its run's recorded ${before?.sha256}`,
      );
    if (!sameList(c.browsers, browsers))
      problems.push(
        `control ${c.name}'s raw evidence ran in ${JSON.stringify(c.browsers)}, not ${JSON.stringify(browsers)}`,
      );
    const unseen = probes.filter((p) => !(c.probes ?? []).includes(p));
    if (unseen.length)
      problems.push(
        `control ${c.name}'s raw evidence did not cover ${unseen.join(", ")}`,
      );
    if (!sameList(c.probes, covered))
      problems.push(
        `control ${c.name}'s raw evidence ran ${JSON.stringify(c.probes)}, but its summary says ${JSON.stringify(covered)}`,
      );
    const said = (summary.controls ?? []).find((x) => x.name === c.name);
    if (said && said.ok !== c.healthy)
      problems.push(
        `control ${c.name}'s summary says ok ${said.ok}, its raw evidence ${c.healthy}`,
      );
  }
  return problems;
}

/**
 * The campaign's outcome from its parts: exit 0 only when nothing failed or was interrupted, the source is unchanged, any prerequisite
 * holds, and EXACTLY the planned parts ran, each once and sound: each control healthy, each negative control `qualified` under the
 * current negative contract, each mutant caught under the current contract. Identities, not counts: a part run twice, an unplanned
 * part, or one that never ran fails it, so the shared driver stops before later work.
 *
 * Revision 25 (design assessment 91d0404c C5): each control and negative control must also carry the VERIFIED evidence of its own bundle
 * in this invocation (`planned.invocation`), one bundle per part. A `qualified: true` without it (a legacy record, a diagnostic, another
 * invocation's part) is not admitted.
 *
 * Revision 26 (review r25 R25-N1; design assessment 26f1a626 I5, I6, H8): `planned.applicability` is the digest of this run's own
 * applicability record (collected before anything was built); every control and negative control must carry exactly that record and be
 * judged `applicable` against exactly that target, and `applicability.after` (the record collected again at the end, compared with it)
 * must be `applicable`: a runtime that changed during the run, or that could not be collected again, fails it.
 *
 * Revision 27 (review r26 R26-N1; design assessment eff76566 I4, I6): `snapshot` is the run's own execution snapshot record; it must
 * show that every child ran from the sealed, unchanged snapshot its record measured, and that the snapshot was removed
 * (snapshotProblems against `applicability.record`, the record collected before anything was built).
 */
export function campaignOutcome({
  preflight,
  fatal,
  interrupted,
  sourceUnchanged,
  applicability,
  snapshot,
  prerequisite,
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
  if (!DIGEST.test(String(planned.applicability)))
    reasons.push(
      "the plan names no applicability target: this run's own runtime was not collected",
    );
  if (applicability?.after?.decision !== "applicable")
    reasons.push(
      ...(applicability?.after
        ? applicabilityReasons(applicability.after).map(
            (r) =>
              `the runtime changed during the run (${applicability.after.decision}): ${r}`,
          )
        : ["the runtime after the run is unknown (not collected again)"]),
    );
  reasons.push(
    ...snapshotProblems(snapshot, applicability?.record).map(
      (p) => `this run: ${p}`,
    ),
  );
  if (prerequisite?.problems.length)
    reasons.push(
      ...prerequisite.problems.map((p) => `prerequisite controls: ${p}`),
    );
  reasons.push(
    ...identityProblems(
      "control",
      planned.controls,
      controls.map((c) => c.name),
    ),
    ...identityProblems(
      "negative control",
      planned.negatives,
      negatives.map((n) => n.negative_control),
    ),
    ...identityProblems(
      "mutant",
      planned.mutants,
      mutants.map((m) => m.mutant),
    ),
  );
  const bound = (part, name, kind) => {
    const e = part.evidence;
    if (
      e?.status !== "verified" ||
      e.kind !== kind ||
      e.part !== name ||
      !planned.invocation ||
      e.invocation !== planned.invocation ||
      !DIGEST.test(String(e.manifest_sha256))
    )
      reasons.push(
        `${kind} ${name} has no verified evidence of this invocation (${e?.status ?? "none"}, invocation ${e?.invocation})`,
      );
    const a = e?.applicability;
    if (
      a?.decision !== "applicable" ||
      !DIGEST.test(String(planned.applicability)) ||
      a?.target_sha256 !== planned.applicability ||
      a?.record_sha256 !== planned.applicability ||
      e.applicability_sha256 !== planned.applicability
    )
      reasons.push(
        `${kind} ${name}'s evidence is not applicable to this run's own runtime (${a?.decision ?? "none"}, record ${e?.applicability_sha256}, target ${a?.target_sha256})`,
      );
    return e?.manifest_sha256;
  };
  const manifests = [];
  for (const c of controls) {
    if (c.ok !== true) reasons.push(`control ${c.name} is not healthy`);
    manifests.push(bound(c, c.name, "control"));
  }
  for (const n of negatives) {
    if (n.contract !== NEGATIVE_CONTRACT_VERSION || n.qualified !== true)
      reasons.push(
        `negative control ${n.negative_control} is ${n.contract === NEGATIVE_CONTRACT_VERSION ? (n.outcome ?? "unjudged") : `judged under ${n.contract}`}, not qualified`,
      );
    manifests.push(bound(n, n.negative_control, "negative"));
  }
  const digests = manifests.filter(Boolean);
  if (new Set(digests).size !== digests.length)
    reasons.push("one evidence bundle stands for more than one part");
  for (const m of mutants)
    if (m.contract !== CONTRACT_VERSION || m.verdict !== "caught")
      reasons.push(
        `mutant ${m.mutant} ${m.contract === CONTRACT_VERSION ? m.verdict : `judged under ${m.contract}`}`,
      );
  return {
    passed: reasons.length === 0,
    exitCode: reasons.length === 0 ? 0 : 1,
    reasons,
  };
}
