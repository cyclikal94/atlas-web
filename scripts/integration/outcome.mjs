// Each stack's terminal outcome, and the schedule that stops at the first one that is not a pass (WEB-08d review r5, H4).
import { casesOf } from "./stacks.mjs";

/**
 * Judge one stack run from what the runner itself knows (exit, signal, spawn error, the time it launched Playwright) and the JSON
 * report Playwright wrote to the run's own fresh path. Only a complete, fresh, consistent report of exactly the planned cases, none
 * of them failed, and a clean exit is a pass. Skipped cases stay skipped (an opt-in case is never counted as passed).
 */
export function judge({ expected, report, readError, exit, launchedAt }) {
  const record = {
    exit_code: exit?.code ?? null,
    signal: exit?.signal ?? null,
    expected: expected.length,
  };
  if (exit?.spawnError)
    return {
      ...record,
      outcome: "error",
      reason: `Playwright did not start: ${exit.spawnError}`,
    };
  if (!report)
    return {
      ...record,
      outcome: "incomplete",
      reason: `no readable report (${readError ?? "missing"})`,
    };
  const started = Date.parse(report.stats?.startTime ?? "");
  if (!Number.isFinite(started) || started < launchedAt - 1000)
    return {
      ...record,
      outcome: "incomplete",
      reason: `the report was not written by this launch (it started at ${report.stats?.startTime ?? "an unknown time"})`,
    };
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
  if (counts.failed + counts.flaky > 0)
    return { ...out, outcome: "failed", reason: `${failed.length} failed` };
  if (out.report_errors.length > 0)
    return { ...out, outcome: "failed", reason: "the report has errors" };
  if (missing.length + extra.length + counts.not_run + counts.interrupted > 0)
    return {
      ...out,
      outcome: "incomplete",
      reason: `${missing.length} planned case(s) missing, ${extra.length} unplanned, ${counts.interrupted} interrupted, ${counts.not_run} not run`,
    };
  if (exit?.signal || exit?.code !== 0)
    return {
      ...out,
      outcome: "failed",
      reason: `Playwright exited ${exit?.signal ?? exit?.code} with a report that has no failure`,
    };
  return { ...out, outcome: "passed", reason: null };
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
  if (record.outcome !== "passed") return { ...out, budget_exceeded: budget };
  return {
    ...out,
    outcome: "budget_exceeded",
    reason: `${budget}, so a case may have passed on a refusal`,
  };
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
 * A stack that was stopped (a signal, the runner's own stop) keeps what it had established before (review r6 design assessment, I4):
 * a pass stays a pass, and a failure the report recorded, a budget excess or a clean-up failure is never turned into a cancellation.
 * Only an outcome the stop itself caused (an interrupted or missing case, a preparation step that was stopped) becomes `cancelled`,
 * with what it was beside it.
 */
export function withCancellation(record, reason) {
  if (!reason) return record;
  const kept =
    record.outcome === "passed" ||
    record.outcome === "cancelled" ||
    record.outcome === "budget_exceeded" ||
    record.outcome === "cleanup_failed" ||
    (record.outcome === "failed" &&
      (record.counts?.failed ?? 0) + (record.counts?.flaky ?? 0) > 0);
  if (kept) return { ...record, cancellation: reason };
  return {
    ...record,
    outcome: "cancelled",
    reason: `stopped: ${reason}`,
    cancellation: reason,
    before_cancellation: { outcome: record.outcome, reason: record.reason },
  };
}

/** The run's outcome: a failure anywhere is a failure (even when a signal came later); otherwise cancelled, or passed. */
export function overall(records, { signalled = null, planned = 0 } = {}) {
  if (
    records.some((r) => !["passed", "not_run", "cancelled"].includes(r.outcome))
  )
    return "failed";
  if (signalled || records.some((r) => r.outcome === "cancelled"))
    return "cancelled";
  return records.length === planned &&
    records.every((r) => r.outcome === "passed")
    ? "passed"
    : "failed";
}

export const describe = (record) =>
  `integration-${record.browser} ${record.stack} ${record.outcome}${record.reason ? ` (${record.reason})` : ""}`;
