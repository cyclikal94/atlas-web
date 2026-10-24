// WEB-14a revision 27 (review r26 R31, design assessment DA-H2, C1-C4): the evidence contract shared by every consumer that judges a
// Vitest run by its failures (scripts/run-data-mutants.mjs and the WEB-14a counterfactual runner). Pure: nothing here spawns or
// writes, so the self-test (vitest-evidence.test.mjs) drives it with synthetic envelopes and the supervised child
// (vitest-supervised.mjs) uses `project` for its records.
//
// Why: Vitest 5.0.1's JSON reporter keeps only the first top-level file error's MESSAGE (an empty message reads as no error), drops the
// nested suite errors and the unhandled errors, and is written before shutdown, whose failures Vitest only logs. Judging from it alone
// admitted runs with errors beside an intended assertion. Here an error is present because it was COUNTED, never because its value
// printed as something (invariant I1), every channel is counted (I2), and only a terminal envelope written after an owned shutdown can
// be admitted (I3).
//
// Revision 28 (review r27 R31 incomplete_fix, design assessment C1-C3): an error is an ASSERTION only on positive evidence of the
// framework class that produced it, recorded in the worker (vitest-origin-setup.mjs) and bound to this run's nonce. Wrapper frames,
// names and messages are kept for diagnostics and message oracles, never as proof: a matcher that crashed before comparing carries
// the same frames as one that compared and failed. Evidence without the origin capability (envelope schema 1) is refused.
//
// Revision 29 (review r28 R31 incomplete_fix, design assessment C2-C4): class membership is no proof either: chai constructs its
// assertion class for argument validation and to wrap an execution error. The origin is now a RECEIPT attached in the worker to the one
// error an audited framework site constructed (vitest-origin-sites.mjs), naming the site and its role for that occurrence, the
// `expect()` root and the test. An error is an assertion only when its receipt is of this run and adapter, its site's role is a
// completed comparison (or an explicit fail) on an `expect()` root of THIS test, not nested in another matcher, and the error has the
// class that site constructs. Precondition, execution-wrapper, internal, nested, unsupported, unknown, foreign or absent receipts are
// errors. The `test.fails` inversion is admitted from its own runner-site receipt, no longer from its name and text. Envelope schema 3
// binds the adapter digest, which the reader recomputes from the files it would run, so older evidence cannot satisfy this rule.
//
// Revision 30 (review r29 R31 incomplete_fix, design assessment b8e8e25d I2-I4/I6, C2/C4): a construction receipt is not the failure
// that reached the runner. Review r29 rethrew a genuine comparison error (caught earlier in the same test) from a later matcher's body,
// message function or getter, used a receiver made before an asynchronous matcher inside it, and called `expect.fail` in a formatter: all
// admitted by their receipts. Admission is now per OCCURRENCE: the runner's record of ONE collected error (vitest-origin-runtime.mjs),
// with the phase and attempt it was collected in, the construction receipt of the object, and every invocation the object left. It is an
// assertion only when it was collected in the test body of the attempt that made it, its receipt is a comparison (or explicit failure)
// that the runtime did not find nested in another invocation (synchronous frames or the asynchronous context), the object left its own
// invocation and NO other one (a borrowed error leaving another matcher is that matcher's execution failure), no asynchronous matcher of
// that attempt settled unobserved, no other test was running, and the worker attested the occurrence (its per-file health record). A
// hook, cleanup or lifecycle collection is a veto whatever it carries. Envelope schema 4 requires every run module's health record.
//
// Revision 31 (review r30 R31/R33 incomplete_fix, design assessment 34d402c4 RC1/RC2, C1-C4): the framework flattens a thrown array and
// each AggregateError in it before collecting, so a donor's genuine comparison wrapped and thrown by ANOTHER matcher reached the reader
// with only the donor's clean edges, and both consumers continued. An occurrence (origin schema 4) now carries its collection PATH (the
// array the framework iterated and the AggregateError it expanded, each with the edges and receipt it had when collection began): an
// edge on any of them is a veto, and a record whose snapshots could not be taken (`complete: false`) is never admitted. An asynchronous
// matcher result or `.resolves`/`.rejects` subject that was not an intrinsic promise makes the WORKER opaque from then on (`opaque`:
// every later occurrence refused whatever its handler did);
// an intrinsic promise's rejection is observed by the framework's own reaction, so it needs no wait. Envelope schema 5.
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  adapterDigest,
  OCCURRENCE_KEY,
  ORIGIN_FILES,
  ORIGIN_KEY,
  ORIGIN_NONCE_ENV,
  ORIGIN_SCHEMA,
  PHASES,
  SITES,
} from "./vitest-origin-sites.mjs";

export {
  adapterDigest,
  OCCURRENCE_KEY,
  ORIGIN_FILES,
  ORIGIN_KEY,
  ORIGIN_NONCE_ENV,
  ORIGIN_SCHEMA,
  SITES,
};
export const REQUEST_SCHEMA = "atlas-vitest-request/1";
export const ENVELOPE_SCHEMA = "atlas-vitest-evidence/5";
/** The lifecycle this adapter was qualified against. Any other version is refused, not assumed compatible. */
export const PINNED_VITEST = "5.0.1";
export const ORIGIN_SETUP = ORIGIN_FILES.setup;
/** The adapter digest of the files as they are now: what a run's envelope and receipts must name to be read. */
export const currentAdapter = () => adapterDigest().digest;

/**
 * A JSON-safe record of one thrown value. Presence is never decided here: callers count the values before projecting them, and a
 * value that cannot be read is still one occurrence (`kind: "unserialisable"`).
 */
export function project(value) {
  try {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return {
        kind: value === null ? "null" : typeof value,
        text: safeString(value),
      };
    const text = (key) => {
      const v = value[key];
      if (typeof v === "function") return `Function<${v.name || "anonymous"}>`;
      return typeof v === "string" ? v : v === undefined ? null : safeString(v);
    };
    return {
      kind: "object",
      name: text("name"),
      message: text("message"),
      type: text("type"),
      stack: text("stack"),
      constructor: text("constructor"),
      occurrence: occurrenceOf(value),
      assertionName: assertionNameOf(value),
    };
  } catch {
    return { kind: "unserialisable" };
  }
}

const isInt = (v) => Number.isInteger(v);
const isOptionalInt = (v) => v === null || Number.isInteger(v);
const isOptionalString = (v) => v === null || typeof v === "string";
const EDGE_KINDS = ["sync", "soft", "async-result", "async-rejection"];

/** A construction receipt inside an occurrence record, exactly of its shape, or `undefined` when malformed. */
function receiptOf(record) {
  if (record === null) return null;
  if (typeof record !== "object") return undefined;
  const {
    schema,
    nonce,
    adapter,
    site,
    role,
    invocation,
    framed,
    root,
    test,
    current,
    phase,
    attempt,
    concurrent,
  } = record;
  if (
    ![schema, nonce, adapter, site, role].every((v) => typeof v === "string") ||
    !isOptionalInt(invocation) ||
    typeof framed !== "boolean" ||
    !isOptionalInt(root) ||
    !isOptionalString(test) ||
    !isOptionalString(current) ||
    !isOptionalString(phase) ||
    !isOptionalInt(attempt) ||
    typeof concurrent !== "boolean"
  )
    return undefined;
  return {
    schema,
    nonce,
    adapter,
    site,
    role,
    invocation,
    framed,
    root,
    test,
    current,
    phase,
    attempt,
    concurrent,
  };
}

const PATH_KINDS = ["array", "aggregate"];
const isEdge = (e) =>
  e !== null &&
  typeof e === "object" &&
  isInt(e.invocation) &&
  EDGE_KINDS.includes(e.kind);

/** One element of an occurrence's collection path (revision 31), exactly of its shape, or `undefined` when malformed. */
function pathElementOf(p) {
  if (p === null || typeof p !== "object") return undefined;
  const { kind, object, receipt, edges } = p;
  const r = receiptOf(receipt);
  if (
    !PATH_KINDS.includes(kind) ||
    typeof object !== "boolean" ||
    r === undefined ||
    !Array.isArray(edges) ||
    !edges.every(isEdge)
  )
    return undefined;
  return {
    kind,
    object,
    receipt: r,
    edges: edges.map((e) => ({ invocation: e.invocation, kind: e.kind })),
  };
}

/**
 * The occurrence record of one serialised error, read without trusting it: `null` when absent, `{ invalid: true }` when present but
 * not exactly of the record's shape (or unreadable), else `{ schema, nonce, adapter, id, test, phase, attempt, concurrent, opaque,
 * complete, path, receipt, edges }`. Whether it ADMITS the error is `admission`'s decision.
 */
function occurrenceOf(value) {
  let record;
  try {
    record = value[OCCURRENCE_KEY];
  } catch {
    return { invalid: true };
  }
  if (record === undefined || record === null) return null;
  try {
    const {
      schema,
      nonce,
      adapter,
      id,
      test,
      phase,
      attempt,
      concurrent,
      opaque,
      complete,
      path,
      receipt,
      edges,
    } = record;
    const r = receiptOf(receipt);
    const elements = Array.isArray(path) ? path.map(pathElementOf) : null;
    if (
      ![schema, nonce, adapter, phase].every((v) => typeof v === "string") ||
      !isInt(id) ||
      !isOptionalString(test) ||
      !isOptionalInt(attempt) ||
      typeof concurrent !== "boolean" ||
      typeof complete !== "boolean" ||
      !Array.isArray(opaque) ||
      !opaque.every(isInt) ||
      elements === null ||
      elements.length > PATH_KINDS.length ||
      elements.some((p) => p === undefined) ||
      // outermost first: at most the iterated array, then the expanded aggregate
      (elements.length === 2 &&
        (elements[0].kind !== "array" || elements[1].kind !== "aggregate")) ||
      !Array.isArray(edges) ||
      !edges.every(isEdge) ||
      r === undefined
    )
      return { invalid: true };
    return {
      schema,
      nonce,
      adapter,
      id,
      test,
      phase,
      attempt,
      concurrent,
      opaque: [...opaque],
      complete,
      path: elements,
      receipt: r,
      edges: edges.map((e) => ({ invocation: e.invocation, kind: e.kind })),
    };
  } catch {
    return { invalid: true };
  }
}

function assertionNameOf(value) {
  try {
    const name = value.__vitest_error_context__?.assertionName;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

function safeString(value) {
  try {
    return typeof value === "symbol" ? value.toString() : String(value);
  } catch {
    return "<unprintable>";
  }
}

/** The first line Vitest's JSON reporter prints for a failure (`stack || message`), which named-message oracles match. */
export function firstLine(error) {
  if (error?.kind !== "object") return String(error?.text ?? "");
  return String(error.stack || error.message || "").split("\n")[0] ?? "";
}

/** Whether a projected error has the class its site constructs (a receipt copied onto another object is refused). */
function shapeProblem(error, constructs) {
  if (constructs === "AssertionError")
    return error.name === "AssertionError"
      ? null
      : "an AssertionError site's receipt on an error not named AssertionError";
  if (constructs === "JestExtendError")
    return error.constructor === "Function<JestExtendError>" &&
      typeof error.assertionName === "string" &&
      error.assertionName.length > 0
      ? null
      : "an extended-matcher site's receipt without its class or assertion name";
  if (constructs === "Error")
    return error.name === "Error" && error.message === "Expect test to fail"
      ? null
      : "the inversion site's receipt on another error";
  return `unknown constructed class ${JSON.stringify(constructs)}`;
}

/**
 * The admission of ONE projected error occurrence of the test `testId` (each separately, so an assertion never conceals another, DA-H2):
 * `{ kind, why, site, role }` with kind
 *   timeout    a test or hook time-out (a veto; recognised by its text, which can only refuse, never admit)
 *   inverted   the runner's `test.fails` inversion of this very test, which is a test.fails case
 *   assertion  (revision 30) an occurrence collected in this test's body, of this run and adapter, attested by its worker, whose object
 *              is a completed comparison (or explicit failure) of an un-nested invocation of this test and attempt, that left that
 *              invocation and no other one, with no opaque asynchronous matcher earlier in the attempt and no other test running, and
 *              (revision 31) a complete record whose framework-expanded containers left no invocation
 *   error      anything else, with `why`, whatever its name, frames or text say
 * `issued` is the list of occurrence ids the worker attested for this test (its module's health record), or null when none.
 */
export function admission(
  error,
  { fails = false, nonce, adapter, testId, issued = null } = {},
) {
  const occurrence = error?.occurrence;
  const receipt = occurrence?.receipt ?? null;
  const no = (why) => ({
    kind: "error",
    why,
    site: receipt?.site ?? null,
    role: receipt?.role ?? null,
    phase: occurrence?.phase ?? null,
  });
  if (error?.kind !== "object") return no("not an object");
  const message = error.message ?? "";
  if (/timed out/i.test(message.split("\n")[0] ?? ""))
    return {
      kind: "timeout",
      why: "time-out",
      site: null,
      role: null,
      phase: occurrence?.phase ?? null,
    };
  if (occurrence === null || occurrence === undefined)
    return no(
      "no occurrence record (not collected by an instrumented runner path)",
    );
  if (occurrence.invalid === true) return no("invalid occurrence record");
  if (occurrence.schema !== ORIGIN_SCHEMA)
    return no(
      `unsupported occurrence schema ${JSON.stringify(occurrence.schema)}`,
    );
  if (typeof nonce !== "string" || occurrence.nonce !== nonce)
    return no("an occurrence of another run");
  if (typeof adapter !== "string" || occurrence.adapter !== adapter)
    return no("an occurrence of another adapter");
  const ofThisTest = (id) => typeof testId === "string" && id === testId;
  if (!ofThisTest(occurrence.test))
    return no("an occurrence collected for another test (or for none)");
  if (!Array.isArray(issued) || !issued.includes(occurrence.id))
    return no("an occurrence its worker did not attest");
  if (!PHASES.includes(occurrence.phase))
    return no(`unknown collection phase ${JSON.stringify(occurrence.phase)}`);
  if (occurrence.concurrent)
    return no(
      "collected while another test was running (concurrent tests are unsupported)",
    );
  // Revision 31 (RC1/I2): a container the framework expanded to reach this error is not an assertion; if it left any invocation (by a
  // throw, a soft collection, a handler or a rejection) that invocation failed by executing, and the children cannot launder it.
  if (!occurrence.complete)
    return no(
      "an incomplete occurrence record (a snapshot or the collection context could not be taken)",
    );
  for (const p of occurrence.path) {
    if (p.edges.length > 0)
      return no(
        `collected out of ${p.kind === "array" ? "an array" : "an AggregateError"} that left a matcher invocation (an execution failure of that matcher)`,
      );
    if (p.receipt !== null)
      return no(`collected out of ${p.kind} carrying a construction receipt`);
  }
  if (receipt === null) return no("no assertion origin");
  if (receipt.schema !== ORIGIN_SCHEMA)
    return no(`unsupported origin schema ${JSON.stringify(receipt.schema)}`);
  if (receipt.nonce !== nonce) return no("assertion origin of another run");
  if (receipt.adapter !== adapter)
    return no("assertion origin of another adapter");
  const spec = Object.hasOwn(SITES, receipt.site) ? SITES[receipt.site] : null;
  if (spec === null) return no(`unknown site ${JSON.stringify(receipt.site)}`);
  const shape = shapeProblem(error, spec.constructs);
  if (shape !== null) return no(shape);
  const derivable =
    spec.role === "comparison"
      ? ["comparison", "internal", "nested", "unattributed"]
      : spec.role === "explicit"
        ? ["explicit", "nested"]
        : [];
  if (receipt.role !== spec.role && !derivable.includes(receipt.role))
    return no(`role ${receipt.role} is not ${receipt.site}'s`);
  const yes = (kind) => ({
    kind,
    why: null,
    site: receipt.site,
    role: receipt.role,
    phase: occurrence.phase,
  });
  if (occurrence.phase === "inversion")
    return receipt.role === "inversion" &&
      fails &&
      ofThisTest(receipt.test) &&
      occurrence.edges.length === 0 &&
      occurrence.path.length === 0
      ? yes("inverted")
      : no(
          "an inversion of another test, of no test.fails case or of another error",
        );
  if (occurrence.phase !== "body")
    return no(`collected in the ${occurrence.phase} phase, not the test body`);
  // Revision 31 (RC2/I5): an asynchronous matcher result (or `.resolves`/`.rejects` subject) that was not an intrinsic promise may have
  // handed anything back; every later occurrence of the worker is refused, whatever its handler did.
  if (occurrence.opaque.length > 0)
    return no(
      "an earlier asynchronous matcher result or promise subject of this worker was a non-intrinsic thenable (its outcome cannot be observed)",
    );
  switch (receipt.role) {
    case "comparison":
      if (!(ofThisTest(receipt.test) && ofThisTest(receipt.current)))
        return no("a comparison of another test (or of none)");
      break;
    case "explicit":
      if (!ofThisTest(receipt.current))
        return no("an explicit fail outside this test");
      break;
    case "internal":
      return no("an internal (precondition) assertion, not an expect() root");
    case "nested":
      return no("an assertion nested in another matcher's execution");
    case "unattributed":
      return no("an asynchronous result outside its matcher's handler");
    default:
      return no(`the ${receipt.role} site ${receipt.site}, not a comparison`);
  }
  if (
    receipt.phase !== "body" ||
    receipt.attempt !== occurrence.attempt ||
    receipt.concurrent
  )
    return no(
      "made outside this attempt's test body (or while another test was running)",
    );
  if (receipt.invocation === null)
    return no("a comparison without an invocation");
  if (occurrence.edges.some((e) => e.kind === "async-rejection"))
    return no(
      "propagated as the rejection of an asynchronous matcher's body (an execution failure)",
    );
  if (occurrence.edges.some((e) => e.invocation !== receipt.invocation))
    return no(
      "propagated out of another matcher invocation (an execution failure of that matcher)",
    );
  // A framed comparison must have left its own invocation: by a throw out of its outermost frame (or by being collected inside it by
  // `expect.soft`), or, for the extended matcher's asynchronous result, through that matcher's handler.
  const terminal = spec.handler === true ? ["async-result"] : ["sync", "soft"];
  if (
    receipt.framed &&
    !occurrence.edges.some(
      (e) => e.invocation === receipt.invocation && terminal.includes(e.kind),
    )
  )
    return no("never left its own invocation as that invocation's failure");
  return yes("assertion");
}

/** The kind alone (`admission(...).kind`). */
export function classify(error, context = {}) {
  return admission(error, context).kind;
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * Validate a terminal envelope against the request it must answer. Returns the problems (empty when admissible as COMPLETE evidence;
 * whether the run was clean is decided by `readRun`). Anything missing, extra, inconsistent or of another version is a problem.
 */
export function validateEnvelope(
  envelope,
  { nonce, label, vitest = PINNED_VITEST, adapter = currentAdapter() } = {},
) {
  const problems = [];
  const fail = (text) => problems.push(text);
  if (envelope === null || typeof envelope !== "object")
    return ["envelope is not an object"];
  if (envelope.schema !== ENVELOPE_SCHEMA)
    fail(`unsupported envelope schema ${JSON.stringify(envelope.schema)}`);
  if (nonce !== undefined && envelope.nonce !== nonce)
    fail("envelope answers another request (nonce)");
  if (label !== undefined && envelope.label !== label)
    fail(
      `envelope is for ${JSON.stringify(envelope.label)}, not ${JSON.stringify(label)}`,
    );
  if (envelope.vitest !== vitest)
    fail(
      `Vitest ${JSON.stringify(envelope.vitest)} is not the qualified ${vitest}`,
    );
  if (envelope.supported !== true)
    fail(
      `unsupported lifecycle: ${(envelope.unsupported ?? ["unknown"]).join("; ")}`,
    );
  if (envelope.complete !== true)
    fail("envelope does not record a completed run and shutdown");
  if (!isCount(envelope.exitCode)) fail("exit code missing");
  const w = envelope.witness;
  if (!w || typeof w !== "object") {
    fail("no witness record");
    return problems;
  }
  if (w.onTestRunEndCalls !== 1)
    fail(
      `onTestRunEnd reported ${JSON.stringify(w.onTestRunEndCalls)} time(s), expected once`,
    );
  if (!["passed", "failed"].includes(w.reason))
    fail(`run ended ${JSON.stringify(w.reason)}`);
  if (Array.isArray(w.tests))
    for (const t of w.tests)
      if (typeof t?.id !== "string" || t.id.length === 0)
        fail("witness test without an id");
  for (const [key, list] of [
    ["modules", w.modules],
    ["suites", w.suites],
    ["tests", w.tests],
  ]) {
    if (!Array.isArray(list)) {
      fail(`witness ${key} missing`);
      continue;
    }
    for (const node of list) {
      if (
        !node ||
        typeof node !== "object" ||
        !isCount(node.errorCount) ||
        !Array.isArray(node.errors) ||
        node.errors.length !== node.errorCount
      )
        fail(
          `witness ${key} entry with inconsistent errors: ${JSON.stringify(node?.fullName ?? node?.id ?? node).slice(0, 120)}`,
        );
    }
  }
  if (!Array.isArray(w.modules) || w.modules.length === 0)
    fail("no test module was reported");
  // Revision 30: every module that ran carries the runtime's health attestation of THIS run and adapter, with no instrumentation
  // failure and balanced frames (a module whose tests were all skipped runs no hook and may have none).
  for (const m of Array.isArray(w.modules) ? w.modules : []) {
    const h = m?.health;
    if (h === null || h === undefined) {
      if (m?.state !== "skipped")
        fail(
          `module ${JSON.stringify(m?.id)} has no assertion-origin health attestation`,
        );
      continue;
    }
    if (
      typeof h !== "object" ||
      h.schema !== ORIGIN_SCHEMA ||
      (nonce !== undefined && h.nonce !== nonce) ||
      h.adapter !== adapter ||
      !Array.isArray(h.failures) ||
      !isCount(h.depth) ||
      h.issued === null ||
      typeof h.issued !== "object"
    ) {
      fail(
        `module ${JSON.stringify(m.id)}: malformed or foreign assertion-origin health attestation`,
      );
      continue;
    }
    if (h.failures.length > 0)
      fail(
        `module ${JSON.stringify(m.id)}: assertion-origin instrumentation failed: ${h.failures.slice(0, 3).join("; ")}`,
      );
    if (h.depth !== 0)
      fail(
        `module ${JSON.stringify(m.id)}: assertion-origin frames unbalanced (${h.depth})`,
      );
  }
  for (const [key, count, list] of [
    ["unhandled", w.unhandledCount, w.unhandled],
    ["witness failures", w.failureCount, w.failures],
    ["late unhandled", envelope.lateUnhandledCount, envelope.lateUnhandled],
    ["logged", envelope.logged?.count, envelope.logged?.calls],
    ["process", envelope.processEvents?.count, envelope.processEvents?.events],
  ])
    if (!isCount(count) || !Array.isArray(list) || list.length !== count)
      fail(`${key} count is missing or disagrees with its occurrences`);
  if (
    typeof envelope.startError !== "object" ||
    typeof envelope.closeError !== "object"
  )
    fail("start/close error records missing");
  if (typeof envelope.closeTimedOut !== "boolean")
    fail("close time-out record missing");
  const o = envelope.origin;
  if (!o || typeof o !== "object") fail("no assertion-origin record");
  else {
    if (o.schema !== ORIGIN_SCHEMA)
      fail(`unsupported assertion-origin schema ${JSON.stringify(o.schema)}`);
    if (o.installed !== true)
      fail(
        "the assertion-origin setup and loading hook were not installed in every project",
      );
    if (o.adapter !== adapter)
      fail(
        `assertion-origin adapter ${JSON.stringify(o.adapter)} is not the current ${adapter}`,
      );
  }
  return problems;
}

/**
 * Read one supervised child's complete evidence: process outcome, terminal envelope and JSON report, bound together. `child` is
 * `{ code, signal, spawnError }`. Returns `{ complete, problems, cases, taint, exitCode }`: `cases` lists each case (`name` is
 * `ancestors > title`; titles may repeat) with its module, status, mode and classified errors; `taint` lists every error outside a test (module, suite,
 * unhandled, late, logged, process, start, close, witness), each counted, never inferred from text.
 */
export function readRun({
  child,
  envelopePath,
  reportPath,
  startedMs,
  nonce,
  label,
}) {
  const problems = [];
  if (child?.spawnError)
    return { complete: false, problems: [`spawn error: ${child.spawnError}`] };
  if (child?.signal)
    return { complete: false, problems: [`terminated by ${child.signal}`] };
  const envelope = readJson(envelopePath, startedMs, "envelope");
  if (envelope.problem)
    return { complete: false, problems: [envelope.problem] };
  const adapter = currentAdapter();
  problems.push(...validateEnvelope(envelope, { nonce, label, adapter }));
  if (child?.code !== envelope.exitCode)
    problems.push(
      `child exited ${child?.code}, envelope records ${envelope.exitCode}`,
    );
  const report = readJson(reportPath, startedMs, "JSON report");
  if (report.problem) problems.push(report.problem);
  if (problems.length > 0) return { complete: false, problems };

  const w = envelope.witness;
  // Revision 30: the occurrence ids each module's worker attested, per test id.
  const attested = new Map(
    w.modules.map((m) => [m.id, m.health?.issued ?? {}]),
  );
  // Case titles need not be unique (parametrised tests repeat them, files share them): cases are a list, matched to the JSON report
  // by module and name in order of appearance.
  const cases = w.tests.map((t) => ({
    id: t.id,
    name: [...t.ancestors, t.name].join(" > "),
    jsonName: [...t.ancestors, t.name].join(" "),
    module: t.module,
    moduleId: t.moduleId,
    status: t.state,
    fails: t.fails === true,
    ms: t.ms ?? null,
    errors: t.errors.map((e) => {
      const issued = attested.get(t.module)?.[t.id];
      const a = admission(e, {
        fails: t.fails === true,
        nonce,
        adapter,
        testId: t.id,
        issued: Array.isArray(issued) ? issued : null,
      });
      return {
        kind: a.kind,
        firstLine: firstLine(e),
        site: a.site,
        role: a.role,
        phase: a.phase,
        ...(a.kind === "error" ? { why: a.why } : {}),
      };
    }),
  }));
  // The JSON report is kept for inspection and must describe exactly the same cases, outcomes and number of failures.
  const keyOf = (moduleId, name) => `${moduleId}\u0000${name}`;
  const jsonCases = new Map();
  let jsonCount = 0;
  if (!Array.isArray(report.testResults))
    problems.push("JSON report has no testResults");
  for (const file of Array.isArray(report.testResults)
    ? report.testResults
    : [])
    for (const t of file.assertionResults ?? []) {
      const key = keyOf(
        file.name,
        [...(t.ancestorTitles ?? []), t.title].join(" > "),
      );
      jsonCases.set(key, [...(jsonCases.get(key) ?? []), t]);
      jsonCount += 1;
    }
  if (jsonCount !== cases.length)
    problems.push(
      `JSON report lists ${jsonCount} case(s), the witness ${cases.length}`,
    );
  const taken = new Map();
  for (const c of cases) {
    const key = keyOf(c.moduleId, c.name);
    const index = taken.get(key) ?? 0;
    taken.set(key, index + 1);
    const j = jsonCases.get(key)?.[index];
    if (!j) {
      problems.push(`JSON report lacks ${c.module} > ${c.name}`);
      continue;
    }
    if (j.status !== c.status)
      problems.push(`${c.name}: JSON status ${j.status}, witness ${c.status}`);
    if ((j.failureMessages ?? []).length !== c.errors.length)
      problems.push(
        `${c.name}: JSON reports ${(j.failureMessages ?? []).length} failure(s), witness ${c.errors.length}`,
      );
  }
  if (problems.length > 0) return { complete: false, problems };

  const taint = [];
  for (const m of w.modules)
    if (m.errorCount > 0)
      taint.push(`module ${m.id}: ${m.errorCount} error(s)`);
  for (const s of w.suites)
    if (s.errorCount > 0)
      taint.push(`suite ${s.fullName}: ${s.errorCount} error(s)`);
  if (w.unhandledCount > 0)
    taint.push(`${w.unhandledCount} unhandled error(s)`);
  if (w.failureCount > 0) taint.push(`${w.failureCount} witness failure(s)`);
  if (envelope.lateUnhandledCount > 0)
    taint.push(
      `${envelope.lateUnhandledCount} unhandled error(s) after the run`,
    );
  if (envelope.logged.count > 0)
    taint.push(
      `${envelope.logged.count} error(s) logged by Vitest (${[...new Set(envelope.logged.calls.map((c) => c.phase))].join(", ")})`,
    );
  if (envelope.processEvents.count > 0)
    taint.push(`${envelope.processEvents.count} process-level error event(s)`);
  if (envelope.startError !== null) taint.push("the run itself threw");
  if (envelope.closeError !== null) taint.push("shutdown threw");
  if (envelope.closeTimedOut) taint.push("shutdown timed out");
  // Counts per channel (module and suite errors are the earlier runner's `suite` kind).
  const outside = {
    suite:
      w.modules.reduce((n, m) => n + m.errorCount, 0) +
      w.suites.reduce((n, s) => n + s.errorCount, 0),
    unhandled: w.unhandledCount + envelope.lateUnhandledCount,
    logged: envelope.logged.count,
    process: envelope.processEvents.count,
    lifecycle:
      w.failureCount +
      (envelope.startError === null ? 0 : 1) +
      (envelope.closeError === null ? 0 : 1) +
      (envelope.closeTimedOut ? 1 : 0),
  };
  return {
    complete: true,
    problems: [],
    cases,
    taint,
    outside,
    exitCode: envelope.exitCode,
    reason: w.reason,
  };
}

function readJson(path, startedMs, what) {
  if (!path || !existsSync(path)) return { problem: `${what} missing` };
  if (statSync(path).mtimeMs < startedMs)
    return { problem: `${what} stale (older than its child)` };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { problem: `${what} malformed: ${error?.message ?? error}` };
  }
}

/** Counts of each kind over the failed cases, and whether any case failed by something other than an assertion. */
export function failureKinds(cases) {
  const kinds = { assertion: 0, inverted: 0, timeout: 0, error: 0 };
  const failed = [];
  for (const c of cases) {
    if (c.status !== "failed") continue;
    if (c.errors.length === 0) kinds.error += 1;
    for (const e of c.errors) kinds[e.kind] += 1;
    failed.push(c);
  }
  return { kinds, failed };
}

/**
 * A clean healthy control: complete evidence, no taint, every case passed or skipped (designed skips stay visible in `skipped`),
 * exit code 0.
 */
export function controlVerdict(run) {
  if (!run.complete) return { verdict: "incomplete", reasons: run.problems };
  if (run.taint.length > 0) return { verdict: "error", reasons: run.taint };
  const bad = run.cases.filter(
    (c) => c.status !== "passed" && c.status !== "skipped",
  );
  const skipped = run.cases.filter((c) => c.status === "skipped").length;
  if (bad.length > 0 || run.exitCode !== 0)
    return {
      verdict: "fail",
      reasons: [
        `exit ${run.exitCode}; ${bad.length} case(s) not passed: ${bad
          .slice(0, 5)
          .map((c) => `${c.name} (${c.status})`)
          .join("; ")}`,
      ],
      skipped,
    };
  return { verdict: "pass", reasons: [], skipped, total: run.cases.length };
}

/**
 * A unit mutant (scripts/run-data-mutants.mjs). The catalogue's existing rule is kept: with `expect`, an ASSERTION failure of a test
 * whose JSON full name matches it; without (an earlier revision's mutant), any assertion, and a run with failures but no assertion is
 * `crash_only` (listed, never counted). New with DA-H2: a catch must also be clean, so any time-out, non-assertion error or error
 * outside a test beside the assertions makes the run `tainted` (never caught), and incomplete evidence is `incomplete`. A `test.fails`
 * inversion counts as an assertion only for a case the mutant's own `expect` names (I5). Revision 28: an assertion is an error whose
 * worker-recorded origin names a qualified producer of this run (`classify`), so a matcher that crashed is an error here. Revision 29:
 * that origin is a per-occurrence site receipt (`admission`), so framework argument validation and wrapped execution errors are errors.
 */
export function unitVerdict(run, mutant) {
  if (!run.complete) return { verdict: "incomplete", reasons: run.problems };
  const { kinds, failed } = failureKinds(run.cases);
  const base = {
    // `suite` keeps the earlier runner's field (module and suite errors); `outside` counts every error outside a test.
    kinds: {
      ...kinds,
      suite: run.outside?.suite ?? 0,
      outside: Object.values(run.outside ?? {}).reduce((a, b) => a + b, 0),
    },
    failedTests: failed.map((c) => `${c.module} > ${c.jsonName}`),
  };
  // A test.fails inversion is Vitest's assertion of an expected failure: it counts toward a catch only for a case the mutant's
  // `expect` names, and elsewhere stands like an unrelated assertion (neither a catch nor a veto), as the earlier runner had it.
  const admissible = (c, e) =>
    e.kind === "assertion" ||
    (e.kind === "inverted" && mutant.expect?.test(c.jsonName) === true);
  const clean = (e) => e.kind === "assertion" || e.kind === "inverted";
  const assertions = failed.filter(
    (c) => c.errors.length > 0 && c.errors.every((e) => admissible(c, e)),
  );
  const dirty =
    run.taint.length > 0 ||
    failed.some(
      (c) => c.errors.length === 0 || c.errors.some((e) => !clean(e)),
    );
  if (failed.length === 0 && run.taint.length === 0)
    return { ...base, verdict: "survived", reasons: ["no test failed"] };
  const anyAssertion = failed.some((c) =>
    c.errors.some((e) => admissible(c, e)),
  );
  // Why each error of a failed case was not an assertion (revision 29: its receipt's site and role), so a refusal says what it saw.
  const whys = new Map();
  for (const c of failed)
    for (const e of c.errors)
      if (e.kind === "error")
        whys.set(e.why ?? "unknown", (whys.get(e.why ?? "unknown") ?? 0) + 1);
  const whyText =
    whys.size > 0
      ? [
          `not assertions: ${[...whys].map(([why, n]) => `${n}x ${why}`).join("; ")}`,
        ]
      : [];
  if (!anyAssertion)
    return {
      ...base,
      verdict: "crash_only",
      reasons: [
        ...run.taint,
        `${kinds.timeout} time-out(s), ${kinds.error} error(s), ${kinds.inverted} inversion(s) no oracle names, no assertion`,
        ...whyText,
      ],
    };
  if (dirty)
    return {
      ...base,
      verdict: "tainted",
      reasons: [
        ...run.taint,
        `${kinds.timeout} time-out(s) and ${kinds.error} non-assertion error(s) beside the assertions`,
        ...whyText,
      ],
    };
  if (run.exitCode === 0)
    return {
      ...base,
      verdict: "incomplete",
      reasons: ["failed cases but exit code 0"],
    };
  if (mutant.expect && !assertions.some((c) => mutant.expect.test(c.jsonName)))
    return {
      ...base,
      verdict: "wrong_test",
      reasons: [`no assertion failure matches ${mutant.expect}`],
    };
  return { ...base, verdict: "caught", reasons: [] };
}

/** A Vitest `testNamePattern` (as `{ source, flags }`) selecting exactly these full test names (`describe > … > title`). */
export function namePatternOf(names) {
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    source: `^(?:${[...new Set(names)].map(literal).join("|")})$`,
    flags: "",
  };
}

/**
 * A narrowed selection (scripts/mutation/unit-selections.mjs) must have run EXACTLY its declared cases: every declared `{ module,
 * name }` once and nothing else (every other case of the files skipped by the name filter). Returns the problems (empty when exact).
 */
export function selectionProblems(run, cases) {
  if (!run.complete) return [];
  const key = (c) => `${c.module} :: ${c.name}`;
  const ran = run.cases
    .filter((c) => c.status !== "skipped")
    .map(key)
    .sort();
  const declared = cases.map(key).sort();
  const problems = [];
  const missing = declared.filter(
    (k, i) => declared.indexOf(k) === i && !ran.includes(k),
  );
  const extra = ran.filter((k) => !declared.includes(k));
  if (missing.length > 0)
    problems.push(`declared case(s) not run: ${missing.join("; ")}`);
  if (extra.length > 0)
    problems.push(`undeclared case(s) run: ${extra.join("; ")}`);
  if (ran.length !== declared.length)
    problems.push(`ran ${ran.length} case(s), declared ${declared.length}`);
  return problems;
}
