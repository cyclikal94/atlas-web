// Each stack's terminal outcome, and the schedule that stops at the first one that is not a pass (WEB-08d review r5, H4).
import { casesOf } from "./stacks.mjs";

/**
 * Judge one stack run from what the runner itself knows (exit, signal, spawn error, the time it launched Playwright) and the JSON
 * report Playwright wrote to the run's own fresh path. Only a complete, fresh, consistent report of exactly the planned cases, none
 * of them failed, and a clean exit is a pass. Skipped cases stay skipped (an opt-in case is never counted as passed).
 *
 * Review r7 H4c (revision 8): the record also carries the FAILURE FACT it establishes (`failure`), which no later stop, budget audit,
 * clean-up, evidence write or take-over removes. A failed or flaky case, an error in the report and a Playwright that did not start
 * are failures whatever else happened. A missing, stale or incomplete report, or an exit with no failure in the report, is a failure
 * only when no stop had been latched before Playwright ended (`stop: null`); after a stop it is what the stop caused. A caller that
 * does not say (`stop` undefined) leaves those to the stop, as before.
 */
export function judge({ expected, report, readError, exit, launchedAt, stop }) {
  const record = {
    exit_code: exit?.code ?? null,
    signal: exit?.signal ?? null,
    expected: expected.length,
  };
  const independent = (out, kind) =>
    stop === null ? { ...out, failure: { kind, reason: out.reason } } : out;
  if (exit?.spawnError) {
    const reason = `Playwright did not start: ${exit.spawnError}`;
    return {
      ...record,
      outcome: "error",
      reason,
      failure: { kind: "spawn", reason },
    };
  }
  if (!report)
    return independent(
      {
        ...record,
        outcome: "incomplete",
        reason: `no readable report (${readError ?? "missing"})`,
      },
      "report_missing",
    );
  const started = Date.parse(report.stats?.startTime ?? "");
  if (!Number.isFinite(started) || started < launchedAt - 1000)
    return independent(
      {
        ...record,
        outcome: "incomplete",
        reason: `the report was not written by this launch (it started at ${report.stats?.startTime ?? "an unknown time"})`,
      },
      "report_stale",
    );
  const want = new Set(expected.map((c) => c.key));
  const seen = new Map();
  for (const c of casesOf(report)) seen.set(c.key, c);
  const missing = expected.filter((c) => !seen.has(c.key));
  const extra = [...seen.values()].filter((c) => !want.has(c.key));
  const counts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    interrupted: 0,
    not_run: 0,
  };
  const failed = [];
  const skipped = [];
  const interrupted = [];
  for (const c of seen.values()) {
    if (!want.has(c.key)) continue;
    const results = c.test.results ?? [];
    // A case stopped part-way (Playwright on SIGINT) is reported "skipped" with an interrupted result: it is neither.
    if (results.some((r) => r.status === "interrupted")) {
      counts.interrupted += 1;
      interrupted.push(c.title);
    } else if (c.test.status === "skipped") {
      counts.skipped += 1;
      skipped.push(c.title);
    } else if (c.test.status === "expected" && results.length > 0)
      counts.passed += 1;
    else if (c.test.status === "flaky") {
      counts.flaky += 1;
      failed.push(c.title);
    } else if (c.test.status === "unexpected") {
      counts.failed += 1;
      failed.push(c.title);
    } else counts.not_run += 1;
  }
  const out = {
    ...record,
    counts,
    missing: missing.map((c) => c.title),
    extra: extra.map((c) => c.title),
    failed,
    skipped,
    interrupted,
    report_errors: (report.errors ?? []).map((e) =>
      String(e.message ?? e).slice(0, 500),
    ),
  };
  if (counts.failed + counts.flaky > 0) {
    const reason = `${failed.length} failed`;
    return {
      ...out,
      outcome: "failed",
      reason,
      failure: { kind: "cases", reason },
    };
  }
  if (out.report_errors.length > 0) {
    const reason = "the report has errors";
    return {
      ...out,
      outcome: "failed",
      reason,
      failure: { kind: "report_errors", reason },
    };
  }
  if (missing.length + extra.length + counts.not_run + counts.interrupted > 0)
    return independent(
      {
        ...out,
        outcome: "incomplete",
        reason: `${missing.length} planned case(s) missing, ${extra.length} unplanned, ${counts.interrupted} interrupted, ${counts.not_run} not run`,
      },
      "incomplete",
    );
  if (exit?.signal || exit?.code !== 0)
    return independent(
      {
        ...out,
        outcome: "failed",
        reason: `Playwright exited ${exit?.signal ?? exit?.code} with a report that has no failure`,
      },
      "exit",
    );
  return { ...out, outcome: "passed", reason: null };
}

/**
 * The independent failure a record establishes (review r7 H4c): the fact it carries, or one its raw report fields show (a failed or
 * flaky case, an error in the report) for a record made without facts. Null when it establishes none.
 */
export function failureOf(record) {
  if (record?.failure) return record.failure;
  const counts = record?.counts ?? {};
  if ((counts.failed ?? 0) + (counts.flaky ?? 0) > 0)
    return { kind: "cases", reason: record.reason ?? "a case failed" };
  if ((record?.report_errors ?? []).length > 0)
    return { kind: "report_errors", reason: "the report has errors" };
  return null;
}

/** The labels that are themselves failures established after the report: kept as they are by a later stop or fact. */
const SETTLED_FAILURES = [
  "budget_exceeded",
  "cleanup_failed",
  "evidence_failed",
];

/**
 * A later fact (a budget excess, a clean-up that was not verified, evidence that was not written) becomes the record's outcome unless
 * the record already established a failure: a pass, a cancellation and an outcome no fact explains (one the stop may have caused) are
 * all outranked by it. What the record was is kept beside it.
 */
function promote(record, outcome, reason, before) {
  if (failureOf(record) !== null || SETTLED_FAILURES.includes(record.outcome))
    return record;
  return {
    ...record,
    outcome,
    reason,
    ...(record.outcome === "passed"
      ? {}
      : { [before]: { outcome: record.outcome, reason: record.reason } }),
  };
}

/**
 * A stack whose source traffic did not fit the backend's budget is not a pass, whatever its report says: a case can pass on a 429
 * (review r5 H3, and revision 6's measurement of the base cases). The busiest 60 s of what the proxy forwarded bounds every window
 * the backend can have opened, so a peak within the limit means the source never refused anything; above it, refusals depend on
 * the window's alignment and the composition is not safe. (A principal refusal, such as I-30b's deliberate one, is not affected.)
 */
export function applyBudget(record, admissions) {
  const out = { ...record, admissions };
  if (admissions.within_limit) return out;
  const budget = `the stack's sign-in traffic reached ${admissions.sliding_peak_60s} source uses within 60 s (the backend admits ${admissions.limit}); ${admissions.rate_limited.length} answered 429`;
  // An excess is a failure of its own (review r7 H4c): it outranks a pass and a cancellation, and never replaces an earlier failure.
  return promote(
    { ...out, budget_exceeded: budget },
    "budget_exceeded",
    `${budget}, so a case may have passed on a refusal`,
    "before_budget",
  );
}

/**
 * Review r7 H4c (revision 8): the one reducer of a stack's record after its report or preparation was judged, used by the runner's
 * own stack end, its finaliser and the reaper. The stop (`stop`), the source budget (`admissions`), the clean-up (`cleanup`) and the
 * evidence writes (`evidenceErrors`) are ADDED to what the record established: a failure stays a failure; a clean-up that was not
 * verified or evidence that could not be written outranks a pass and a cancellation; what only the stop caused is `cancelled`. Every
 * failure fact is listed in `failures`, in the order it was established.
 */
export function settleStack(
  record,
  { stop = null, admissions = null, cleanup = null, evidenceErrors = [] } = {},
) {
  let out = withCancellation(record, stop);
  if (admissions) out = applyBudget(out, admissions);
  if (cleanup) {
    // Review r8 H4d: a later clean-up observation is added, never a replacement for an earlier one that was not verified.
    const earlier =
      record.cleanup && record.cleanup !== cleanup && record.cleanup.ok !== true
        ? [...(record.earlier_cleanups ?? []), record.cleanup]
        : record.earlier_cleanups;
    out = {
      ...out,
      cleanup,
      ...(earlier ? { earlier_cleanups: earlier } : {}),
    };
  }
  if (evidenceErrors.length > 0)
    out = {
      ...out,
      evidence_errors: [
        ...new Set([...(record.evidence_errors ?? []), ...evidenceErrors]),
      ],
    };
  if (cleanup && !cleanup.ok)
    out = promote(
      out,
      "cleanup_failed",
      "the stack's clean-up was not verified",
      "before_settling",
    );
  if (evidenceErrors.length > 0)
    out = promote(
      out,
      "evidence_failed",
      evidenceErrors.join("; "),
      "before_settling",
    );
  // Review r8 H4d (revision 9): the facts a record already listed are kept (a record settled again, by its own end, the finaliser
  // or the reaper, accumulates them); new ones are added once.
  const failures = unionFailures(record.failures, [failureOf(record)]);
  const add = (fact) => {
    if (!failures.some((f) => sameFact(f, fact))) failures.push(fact);
  };
  if (out.budget_exceeded) add({ kind: "budget", reason: out.budget_exceeded });
  if (cleanup && !cleanup.ok) add({ kind: "cleanup", reason: "not verified" });
  for (const reason of evidenceErrors) add({ kind: "evidence", reason });
  return { ...out, failures };
}

const sameFact = (a, b) => a.kind === b.kind && a.reason === b.reason;
/** Every fact of the given lists, once each, in order (null entries skipped). */
function unionFailures(...lists) {
  const out = [];
  for (const list of lists)
    for (const fact of list ?? [])
      if (fact && !out.some((f) => sameFact(f, fact))) out.push(fact);
  return out;
}

/**
 * Review r8 H4d (revision 9): the one fact merger of two versions of a stack's record (an earlier and a later one: the later's
 * fields win, by sequence; a field only the earlier has is kept). Every failure fact either established is kept, the first failure established stays the record's `failure`,
 * an earlier clean-up that was not verified stays beside a later one, and a later label that would hide an established failure
 * (passed, cancelled, not_run) becomes `failed`, with what it said beside it.
 */
export function mergeFacts(earlier, later) {
  if (!earlier) return later;
  if (!later) return earlier;
  const failures = unionFailures(
    [failureOf(earlier)],
    earlier.failures,
    [failureOf(later)],
    later.failures,
  );
  // Nothing the earlier version said is dropped unless the later one says it again (a report path, a launch time, counts).
  let out = {
    ...earlier,
    ...later,
    failure: earlier.failure ?? later.failure,
    failures,
  };
  if (out.failure === undefined) delete out.failure;
  const cleanups = [
    ...(earlier.earlier_cleanups ?? []),
    ...(earlier.cleanup &&
    earlier.cleanup.ok !== true &&
    earlier.cleanup !== later.cleanup
      ? [earlier.cleanup]
      : []),
    ...(later.earlier_cleanups ?? []),
  ];
  if (cleanups.length > 0) out.earlier_cleanups = [...new Set(cleanups)];
  const evidence = [
    ...new Set([
      ...(earlier.evidence_errors ?? []),
      ...(later.evidence_errors ?? []),
    ]),
  ];
  if (evidence.length > 0) out.evidence_errors = evidence;
  if (earlier.budget_exceeded && !out.budget_exceeded)
    out.budget_exceeded = earlier.budget_exceeded;
  const hiding = ["passed", "cancelled", "not_run", "running"];
  if (failures.length > 0 && hiding.includes(out.outcome))
    out = {
      ...out,
      // The earlier version's own failure label when it had one (`evidence_failed`, `cleanup_failed`, ...), else `failed`.
      outcome: hiding.includes(earlier.outcome) ? "failed" : earlier.outcome,
      reason: hiding.includes(earlier.outcome)
        ? failures[0].reason
        : (earlier.reason ?? failures[0].reason),
      before_merge: { outcome: later.outcome, reason: later.reason ?? null },
    };
  return out;
}

/**
 * Launch every (browser, stack) of the plan in order, one at a time, and stop at the first record that is not `passed`: the rest
 * are recorded `not_run` with that first failure as their reason. `launch` returns the stack's record; a thrown error is a
 * preparation error. `latched()` is checked before every launch so a signal stops scheduling too. `onRecord` sees every record as
 * soon as it exists, so a partial summary can be written while the run goes on.
 */
export async function schedule({
  browsers,
  stacks,
  launch,
  latched = () => null,
  onRecord = () => undefined,
}) {
  const records = [];
  let first = null;
  for (const browser of browsers)
    for (const [index, stack] of stacks.entries()) {
      const name = { browser, stack: stack.suffix || "base", index };
      const stoppedBy = first ? describe(first) : latched();
      if (stoppedBy) {
        const record = {
          ...name,
          outcome: "not_run",
          reason: `not launched: ${stoppedBy}`,
        };
        records.push(record);
        onRecord(record, records);
        continue;
      }
      let record;
      try {
        record = { ...name, ...(await launch(browser, stack, index)) };
      } catch (error) {
        record = {
          ...name,
          outcome: error?.name === "Cancelled" ? "cancelled" : "error",
          reason: String(error?.message ?? error),
          error: String(error?.stack ?? error),
        };
      }
      records.push(record);
      if (record.outcome !== "passed") first = record;
      onRecord(record, records);
    }
  return { records, first, passed: first === null && !latched() };
}

/**
 * A stack that was stopped (a signal, the runner's own stop) keeps what it had established before (review r6 design assessment, I4;
 * review r7 H4c): a pass stays a pass, and a failure fact (a failed case, an error in the report, a preparation error raised before the
 * stop, an incomplete report with no stop before it), a budget excess or a clean-up or evidence failure is never turned into a
 * cancellation. Only an outcome the stop itself may have caused (an interrupted or missing case after the stop, a preparation step
 * that was stopped) becomes `cancelled`, with what it was beside it.
 */
export function withCancellation(record, reason) {
  if (!reason) return record;
  const kept =
    failureOf(record) !== null ||
    ["passed", "cancelled", ...SETTLED_FAILURES].includes(record.outcome);
  if (kept) return { ...record, cancellation: reason };
  return {
    ...record,
    outcome: "cancelled",
    reason: `stopped: ${reason}`,
    cancellation: reason,
    before_cancellation: { outcome: record.outcome, reason: record.reason },
  };
}

/**
 * The run's outcome: a failure anywhere is a failure (even when a signal came later), and so is a record that carries a failure fact
 * whatever its label, or a run-level failure (`failures`: evidence that could not be written); otherwise cancelled, or passed.
 */
export function overall(
  records,
  { signalled = null, planned = 0, failures = [] } = {},
) {
  if (
    failures.length > 0 ||
    records.some(
      (r) =>
        !["passed", "not_run", "cancelled"].includes(r.outcome) ||
        failureOf(r) !== null ||
        (r.failures?.length ?? 0) > 0 ||
        Boolean(r.budget_exceeded) ||
        (r.cleanup ? r.cleanup.ok !== true : false),
    )
  )
    return "failed";
  if (signalled || records.some((r) => r.outcome === "cancelled"))
    return "cancelled";
  return records.length === planned &&
    records.every((r) => r.outcome === "passed")
    ? "passed"
    : "failed";
}

/**
 * Review r9 H4e (revision 10): what a summary derives from its stack records (the first record that is not a pass, each engine's
 * counts and whether they cover its whole plan), computed the same way by the runner and by the reaper after it merged its evidence,
 * so a reconciled summary never keeps the projection of an older one.
 */
export function project(records, { browsers, planned }) {
  const engines = {};
  for (const browser of browsers) {
    const mine = records.filter((r) => r.browser === browser);
    const merged = { passed: 0, failed: 0, skipped: 0, flaky: 0, not_run: 0 };
    for (const r of mine)
      for (const [k, n] of Object.entries(r.counts ?? {}))
        merged[k] = (merged[k] ?? 0) + n;
    engines[browser] = {
      // Counts are of judged reports only; `complete` says whether they cover the whole plan for this browser.
      complete:
        mine.length === (planned ?? -1) &&
        mine.every((r) => r.outcome === "passed"),
      counts: merged,
    };
  }
  const failure = records.find(
    (r) => r.outcome !== "passed" && r.outcome !== "not_run",
  );
  return { first_failure: failure ? describe(failure) : null, engines };
}

export const describe = (record) =>
  `integration-${record.browser} ${record.stack} ${record.outcome}${record.reason ? ` (${record.reason})` : ""}`;
