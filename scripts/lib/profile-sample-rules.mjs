// The per-request witnesses of the P-4/P-10 timed samples (WEB-09c revision 13; review 13 R2 and design assessment DA-R2-A, DA-R2-B and
// DA-N1; family profiling-evidence-completeness). Dependency-free and pure: the writers (tests/e2e/profile-samples.ts) and the evidence
// contract (scripts/lib/profile-contract.mjs) derive a sample's operation from the SAME retained witness with these rules, so a consumer
// can re-derive what the writer selected instead of trusting a repetition of its answer. Their tests state every expectation by hand.
//
// Revision 12 selected the first real tick, the first commit anywhere after it and an end after that: a completed step that sent no request
// (a local-storage stop, an offline or session gate) donated its start to a LATER step's request and commit (review 13: tick 10, end 11,
// tick 100, request 102, commit 115, end 116 gave a 92 ms pre-issue instead of 2), and its three selected lines could not show the end in
// between. Here a sample is the FIRST real step after its mark, closed by that step's own end before its commit or request is looked for:
//
//   sync   `sync-request-sample/2`: one non-coalesced `data.sync_tick`, the first `data.sync_next`/`data.sync_step_failed` after it, exactly
//          one `data.sync_commit` between them (latency needs no written page: its value is recorded, not judged), and the ONE `/sync`
//          ResourceTiming entry inside [tick, commit] (1 ms trace rounding) with no other entry before the step or overlapping it. A step
//          that ends with no commit fails the sample at that end; nothing later can repair it.
//   draft  `draft-request-sample/3` (revision 15, review 15 R2): no draft waiting at the mark, the enqueue, ONE first send (`resend:
//          false`) after it, its answer (a receipt) and the ONE `/commands` entry inside [send, answer]; completion is the observed
//          dispatcher's own applied/admitted receipt of that local ID, by the same dispatcher, run and service, with nothing else recorded
//          or traced up to the completion read, and the binding unchanged across every await. Every record is checked against its kind's
//          schema and every result against its own call; the records and the trace are one closed, ordered interval, and the receipt's
//          result was delivered before the completion read began. Revision 14's `/2` accepted a result that omitted its service, named
//          another plan or epoch than its call, carried no time or a time after the read, and a completion read before the mark (review
//          15); revision 13's `/1` closed the sample on any later queue status but queued/in_flight.
//
// Revision 16 (review 16 R16-SYNC, design assessment DA16-S1/S2/D1/H1, invariants I1-I8): positions, identities and derived values agreeing with
// each other did not prove the observation they claim. `sync-request-sample/3` types the mark's and the read's own times and closes the
// interval between them: every retained trace line is timed, its times never go back, and they lie inside [mark.at, read.at] within the
// trace rounding; the engine was started (a generation, not two matching absent ones); the inventory count covers the retained entries.
// Every retained request entry, for both helper callers, is the EXACT configured endpoint pathname the writer stores (`SYNC_PATH`,
// `COMMANDS_PATH`), never a label, and lies inside the observation on the page clock. `draft-request-sample/4` adds the draft's endpoint
// (its request, result and entry agreeing on a foreign path is not `/commands`) and the observation bounds of its entries. Revision 15's
// `/2` sync rule accepted a read timed before its mark, absent times, a step end traced before its tick and an entry named `/not-sync`.
//
// Revision 17 (review 17 R17-REQUEST/R17-BUFFER, design assessment DA17-RQ/BF/HR, invariants 2, 4 and 5): `draft-request-sample/5` binds
// the selected entry to the dispatcher's observed call (the observer appends `request_begin` before it calls the stamped sender, so the
// call began no later than its entry started; the call returned no earlier than its entry's request was sent) and validates BOTH buffer
// snapshots: each total typed and below the buffer, each count within its own total, and the totals of one uninterrupted buffer (nothing
// clears it between the timing and completion reads) never shrinking, nor losing entries other than the retained requests. Revision 16's
// `/4` accepted a call that began after its entry ended, a missing or zero timing total and a later total below its retained entries.
//
// Pending (the operation has not finished) is distinct from invalid (it finished, or the witness shows it cannot be the sample's).

export const SYNC_WITNESS_METHOD = "sync-request-sample/3";
export const DRAFT_WITNESS_METHOD = "draft-request-sample/5";
/**
 * The pathnames the measurement writers store for their requests (`new URL(entry.name).pathname`): `apiUrl("/sync")` and
 * `apiUrl("/commands")` under `API_BASE` (src/lib/api-client/wire.ts; tests/profiling/profile-samples.test.ts checks the route). A query
 * is never part of a stored pathname. Exact: a suffix or substring test would admit `/not-sync`.
 */
export const SYNC_PATH = "/api/experimental/v1/sync";
export const COMMANDS_PATH = "/api/experimental/v1/commands";
/** The trace's own millisecond rounding (`Math.round(performance.now())`): a resource time may lie up to this far outside its line. */
export const TRACE_ROUNDING_MS = 1;
/** The default ResourceTiming buffer: at this many entries the browser drops new ones, so the inventory may be incomplete. */
export const RESOURCE_BUFFER = 250;
/**
 * The draft request's causal edges (revision 17, DA17-RQ, invariant 2) compare two raw page-clock times, the observer's `performance.now()`
 * and ResourceTiming's: no allowance. The trace's rounding is not a timestamp tolerance; ties are valid (inclusive comparisons). Qualified
 * on the pinned native engines (tests/e2e/fixture.profile-outcome.spec.ts records each healthy margin).
 */
export const RAW_CLOCK_ALLOWANCE_MS = 0;

const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isCount = (x) => Number.isInteger(x) && x >= 0;
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const isText = (x) => typeof x === "string" && x !== "";
const eventOf = (line) => {
  const parts = String(line ?? "").split(" ");
  return parts.length >= 2 && /^-?\d+ms$/.test(parts[0]) ? parts[1] : null;
};
const payloadOf = (line) => {
  const text = String(line ?? "");
  const at = text.indexOf("{");
  if (at < 0) return null;
  try {
    const value = JSON.parse(text.slice(at));
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
};
const msOf = (line) => Number(/^(-?\d+)ms /.exec(String(line))?.[1] ?? NaN);
const STEP_ENDS = ["data.sync_next", "data.sync_step_failed"];

const invalid = (problem) => ({
  status: "invalid",
  problem,
  selected: null,
  values: null,
});
const pending = (problem) => ({
  status: "pending",
  problem,
  selected: null,
  values: null,
});

/** A page time: a finite, non-negative number (never a string, null or a coerced value). */
const isPageTime = (x) => fin(x) && x >= 0;

/**
 * Two ResourceTiming snapshots of ONE uninterrupted buffer (revision 17, DA17-BF, invariant 5): `earlier` and `later` are
 * `{ total, retained }`, each total the whole buffer's entry count and each `retained` the endpoint's entries in that same read, already
 * judged credible on their own. With nothing cleared between the reads the total never shrinks, and entries other than the retained ones
 * never leave (a later total that grew by less than the retained count did lost entries). Null, or the problem. In a complete draft
 * witness both reads retain exactly the one request, so the second relation adds nothing to the first there (it names a different reason
 * only for witnesses that are invalid anyway).
 */
export function bufferLifetimeProblem(earlier, later) {
  if (later.total < earlier.total)
    return "the resource-timing buffer shrank between the timing and completion reads: it was cleared or lost entries";
  if (later.total - later.retained < earlier.total - earlier.retained)
    return "entries other than the requests left the resource-timing buffer between the timing and completion reads";
  return null;
}

/**
 * The shape, page identity, trace continuity and observation interval of a sync witness (revision 16, invariant I1); a problem string or
 * null. The mark's and the read's own times are the page clock's (`performance.now()`, unrounded) and must be an interval.
 */
function frameProblem(w) {
  if (!isObj(w) || !isObj(w.mark) || !isObj(w.read))
    return "the witness is not a mark and a read";
  if (!Array.isArray(w.lines) || !w.lines.every((l) => typeof l === "string"))
    return "the witness retains no trace slice";
  if (!Array.isArray(w.resources)) return "the witness retains no requests";
  if (
    !isText(w.mark.page) ||
    w.read.page !== w.mark.page ||
    !fin(w.mark.time_origin) ||
    w.read.time_origin !== w.mark.time_origin
  )
    return "the page was reloaded or replaced during the sample";
  if (!isCount(w.mark.from) || w.read.to !== w.mark.from + w.lines.length)
    return "its trace slice is not contiguous from the mark to the read";
  if (!isPageTime(w.mark.at))
    return "its mark records no finite, non-negative page time";
  if (!isPageTime(w.read.at))
    return "its read records no finite, non-negative page time";
  if (!(w.mark.at <= w.read.at)) return "its read is timed before its mark";
  if (!isCount(w.read.resource_entries))
    return "the witness does not record the resource buffer's entries";
  if (w.read.resource_entries >= RESOURCE_BUFFER)
    return "the resource-timing buffer was full: requests may be missing";
  if (w.resources.length > w.read.resource_entries)
    return "the witness retains more requests than the buffer held";
  return null;
}

/**
 * The retained slice's chronology (revision 16, invariant I2): every line is timed (the engine trace stamps every line), the rounded
 * times never go back (no rounding allowance between two rounded lines) and each lies inside [mark.at, read.at] within the trace's own
 * rounding. Judged on the WHOLE slice, separately from the selection, so a later step's lines are held to the observation too without
 * extending the selected operation. Null, or the problem.
 */
function chronologyProblem(w) {
  let last = Number.NEGATIVE_INFINITY;
  for (const [i, line] of w.lines.entries()) {
    const ms = eventOf(line) === null ? Number.NaN : msOf(line);
    if (!fin(ms))
      return `a trace line (${w.mark.from + i}) carries no time or event`;
    if (ms < w.mark.at - TRACE_ROUNDING_MS)
      return `a trace line (${w.mark.from + i}) precedes the sample's mark`;
    if (ms > w.read.at + TRACE_ROUNDING_MS)
      return `a trace line (${w.mark.from + i}) follows the sample's read`;
    if (ms < last) return `the trace's times go back (line ${w.mark.from + i})`;
    last = ms;
  }
  return null;
}

/**
 * The one request entry of an operation from `from` to `to` (trace times) that closed at `end`: the unique entry inside [from − 1, to + 1];
 * an entry that began before the operation, or overlaps it up to its end without lying inside, makes it ambiguous. Entries that begin
 * after the end belong to later operations and are ignored. Revision 16 (invariants I3, I4): `endpoint` is `{ path, label }` and EVERY
 * retained entry must name exactly `path` (the writer's stored pathname; the label only words the problem) and lie inside the
 * observation `[observed.from, observed.to]` on the page clock (the entries and the observation times are the same unrounded clock, so no
 * rounding allowance). A malformed or foreign entry is refused, never filtered out. Returns `{ request, problem }`.
 */
function oneRequest(resources, from, to, end, endpoint, observed) {
  // Judged once the operation is known, so a relation the trace already refutes (a second send, an earlier step's end) is named first.
  const { path, label } = endpoint;
  for (const r of resources)
    if (
      !isObj(r) ||
      ![r.startTime, r.requestStart, r.responseEnd].every(fin) ||
      !(
        r.startTime >= 0 &&
        r.startTime <= r.requestStart &&
        r.requestStart <= r.responseEnd
      )
    )
      return { request: null, problem: "a request entry has no usable timing" };
  for (const r of resources)
    if (typeof r.name !== "string" || r.name !== path)
      return {
        request: null,
        problem: `a retained request entry is not the ${label} endpoint (${typeof r.name === "string" ? r.name : String(r.name)})`,
      };
  for (const r of resources)
    if (r.startTime < observed.from || r.responseEnd > observed.to)
      return {
        request: null,
        problem: `a ${label} request entry lies outside the sample's observation`,
      };
  const inside = [];
  for (const [i, r] of resources.entries()) {
    if (
      r.startTime >= from - TRACE_ROUNDING_MS &&
      r.responseEnd <= to + TRACE_ROUNDING_MS
    )
      inside.push(i);
    else if (r.startTime < from - TRACE_ROUNDING_MS)
      return {
        request: null,
        problem: `a ${label} request began before the sample's operation`,
      };
    else if (r.startTime <= end + TRACE_ROUNDING_MS)
      return {
        request: null,
        problem: `a ${label} request overlaps the sample's operation without lying inside it`,
      };
  }
  if (inside.length !== 1)
    return {
      request: null,
      problem: `${inside.length} ${label} requests lie inside the operation (${resources.length} since the sample began)`,
    };
  return { request: inside[0], problem: null };
}

/**
 * The operation of a `sync-request-sample/3` witness: `{ status: "complete" | "pending" | "invalid", problem, selected, values }`.
 * `selected` holds absolute trace positions (`start`, `commit`, `end`) and the request's index in `resources`. Revision 16: the frame's
 * observation interval, the engine's start and the whole slice's chronology are judged first; the selection is unchanged.
 */
export function syncWitnessSelection(w) {
  const frame = frameProblem(w);
  if (frame) return invalid(frame);
  if (
    !Array.isArray(w.read.epochs) ||
    w.read.epochs.length !== 0 ||
    w.read.generation !== w.mark.generation
  )
    return invalid("the engine was started again during the sample");
  if (
    !Number.isInteger(w.mark.epochs) ||
    w.mark.epochs < 1 ||
    !Number.isInteger(w.mark.generation)
  )
    return invalid("the sample's engine had not been started");
  const disorder = chronologyProblem(w);
  if (disorder) return invalid(disorder);
  let start = -1;
  let commit = -1;
  let end = -1;
  for (const [i, line] of w.lines.entries()) {
    const event = eventOf(line);
    const at = w.mark.from + i;
    if (start < 0) {
      if (event === "data.sync_tick" && payloadOf(line)?.coalesced === false)
        start = at;
      else if (event === "data.sync_commit" || STEP_ENDS.includes(event))
        return invalid(
          `a step that began before the sample traced ${event} inside it`,
        );
      continue;
    }
    if (event === "data.sync_tick" && payloadOf(line)?.coalesced === false)
      return invalid("a second step started before the sample's step ended");
    if (event === "data.sync_commit") {
      if (commit >= 0) return invalid("the sample's step traced two commits");
      commit = at;
    } else if (STEP_ENDS.includes(event)) {
      end = at;
      break;
    }
  }
  if (start < 0) return pending("no step has started since the mark");
  if (end < 0) return pending("the sample's step has not ended");
  const line = (at) => w.lines[at - w.mark.from];
  if (commit < 0)
    return invalid(
      `the sample's step ended without a commit (${line(end).trim()}): no later step can stand for it`,
    );
  // Every line is timed and ordered (the chronology above), so tick <= commit <= end.
  const tick = msOf(line(start));
  const committed = msOf(line(commit));
  const ended = msOf(line(end));
  const { request, problem } = oneRequest(
    w.resources,
    tick,
    committed,
    ended,
    { path: SYNC_PATH, label: "/sync" },
    { from: w.mark.at, to: w.read.at },
  );
  if (problem) return invalid(problem);
  const r = w.resources[request];
  return {
    status: "complete",
    problem: null,
    selected: { start, commit, end, request },
    values: {
      pre_issue_ms: r.requestStart - tick,
      request_ms: r.responseEnd - r.requestStart,
      post_response_ms: committed - r.responseEnd,
      total_ms: committed - tick,
      duration_ms: r.responseEnd - r.startTime,
    },
  };
}

const OUTBOX = [
  "data.outbox_send",
  "data.outbox_answer",
  "data.outbox_step_failed",
];
/** The fields of a dispatch identity (`DataHarness.dispatchIdentity` plus the page's time origin), compared across every await. */
const IDENTITY = [
  "page",
  "time_origin",
  "account",
  "identity_account",
  "epoch",
  "service",
  "incarnation",
  "live",
  "current_service",
  "dispatcher",
  "run",
  "running",
  "observing",
];
const LIFECYCLE = [
  "dispatcher_built",
  "dispatcher_started",
  "dispatcher_stopped",
  "service_ended",
];

// ---- the dispatch records' schema (revision 15, review 15 R2, design assessment DA15-R2a, invariants 1-2) ----------------------------------
// Each kind's required fields, as src/fixture/data-harness/dispatch-observer.ts writes them. A required field that is absent, null where a
// value is required, non-finite or of another type makes the record malformed: never a wildcard. A request carries no service or epoch
// (its actor is its dispatcher, run and key); a commit always carries its service.
const COMMIT_KINDS = ["commit_begin", "commit_end", "commit_gated"];
const WRITE_KINDS = ["write_begin", "write_end"];
const REQUEST_KINDS = ["request_begin", "request_end"];
const OUTCOMES = {
  commit_end: ["applied", "dropped", "failed", "threw", "unknown"],
  request_end: ["response", "error"],
  write_end: ["ran", "threw"],
};
/** The begin kind an end record closes. */
const BEGIN_OF = {
  commit_end: "commit_begin",
  request_end: "request_begin",
  write_end: "write_begin",
};
/** The fields an end record repeats from its call (the run is the run at delivery and may differ: a restart shows). */
const CALL_FIELDS = {
  commit_end: ["dispatcher", "service", "plan", "local_id", "epoch"],
  request_end: ["dispatcher", "key", "path"],
  write_end: ["dispatcher", "service", "plan", "local_id"],
};
const isIdOrNull = (x) => x === null || typeof x === "string";
const isIntOrNull = (x) => x === null || Number.isInteger(x);

/** Why a retained dispatch record is not a well-formed record of its kind (null: it is). */
function recordProblem(r) {
  if (!isObj(r)) return "it is not a record";
  if (!fin(r.at) || r.at < 0)
    return "its time is not a finite, non-negative page time";
  if (!Number.isInteger(r.dispatcher) || r.dispatcher < 0 || !isCount(r.run))
    return "it names no dispatcher and run";
  const event = r.event;
  if (COMMIT_KINDS.includes(event) || WRITE_KINDS.includes(event)) {
    if (!Number.isInteger(r.service)) return `its ${event} names no service`;
    if (!isText(r.plan)) return `its ${event} names no plan`;
    if (!isIdOrNull(r.local_id))
      return `its ${event}'s local ID is not a string or null`;
    if (
      (event === "commit_begin" || event === "commit_end") &&
      !isIntOrNull(r.epoch)
    )
      return `its ${event}'s epoch is not an integer or null`;
  } else if (REQUEST_KINDS.includes(event)) {
    if (!isIdOrNull(r.key) || !isText(r.path))
      return `its ${event} names no key and path`;
  } else if (event === "service_ended") {
    if (!isIntOrNull(r.service)) return "its service_ended names no service";
  } else if (!LIFECYCLE.includes(event))
    return `its event (${String(event)}) is not a dispatch record`;
  if (!(event in BEGIN_OF)) return null;
  if (!isCount(r.of) || r.of >= r.seq)
    return `its ${event} names no earlier call`;
  if (!OUTCOMES[event].includes(r.outer))
    return `its ${event}'s outcome (${String(r.outer)}) is not one of ${OUTCOMES[event].join(", ")}`;
  if (event === "commit_end") {
    if (r.outer === "applied" && !isText(r.inner))
      return "its applied commit_end names no inner result";
    if (
      (r.outer === "dropped" || r.outer === "failed") &&
      typeof r.reason !== "string"
    )
      return `its ${r.outer} commit_end names no reason`;
    if (r.removed !== undefined && typeof r.removed !== "boolean")
      return "its commit_end's removal is not a boolean";
  }
  if (
    event === "request_end" &&
    r.outer === "response" &&
    !Number.isInteger(r.http)
  )
    return "its answered request_end names no HTTP status";
  if (r.outer === "threw" || (event === "request_end" && r.outer === "error"))
    if (typeof r.error !== "string") return `its ${event} names no error`;
  return null;
}

/**
 * Every end record whose call is in the slice is that call's only result and repeats its identity (invariant 2): null, or the problem. An
 * end whose call precedes the slice is judged by the selection (it cannot be the sample's).
 */
function pairingProblem(records) {
  const bySeq = new Map(records.map((r) => [r.seq, r]));
  const closed = new Set();
  for (const r of records) {
    if (!(r.event in BEGIN_OF)) continue;
    const call = bySeq.get(r.of);
    if (call === undefined) continue;
    const kind = r.event.slice(0, r.event.indexOf("_"));
    if (call.event !== BEGIN_OF[r.event])
      return `a ${kind} result (record ${r.seq}) names a ${String(call.event)} as its call`;
    if (closed.has(r.of))
      return `a ${kind} call (record ${r.of}) has two results`;
    closed.add(r.of);
    const differ = CALL_FIELDS[r.event].filter((k) => r[k] !== call[k]);
    if (differ.length > 0)
      return `a ${kind} result (record ${r.seq}) contradicts its call (${differ.join(", ")})`;
  }
  return null;
}

/**
 * The closed interval of the sample's observations (invariant 3): the records' times do not go back and lie inside [t0, the completion
 * read's end]; each watermark (the timing read, the completion read's start, its end) has every earlier record no later and every later
 * record no earlier than its time; the trace's rounded lines likewise, within the trace rounding. Ties are valid. Null, or the problem.
 */
function intervalProblem(w) {
  const { mark, timing, completion } = w;
  const marks = [
    ["the timing read", timing.log_to, timing.done],
    [
      "the completion read's start",
      completion.log_before,
      completion.started_at,
    ],
    ["the completion read's end", completion.log_to, completion.at],
  ];
  let previous = mark.t0;
  for (const r of w.records) {
    if (r.at < previous)
      return r.at < mark.t0
        ? `a dispatch record (${r.seq}) precedes the sample's mark`
        : `the dispatch records' times go back (record ${r.seq})`;
    previous = r.at;
    for (const [what, seq, at] of marks)
      if (r.seq < seq ? r.at > at : r.at < at)
        return `a dispatch record's time (${r.seq}) contradicts ${what} (its record position and its time disagree)`;
  }
  let last = mark.t0 - TRACE_ROUNDING_MS;
  for (const [i, text] of w.lines.entries()) {
    if (eventOf(text) === null) continue;
    const ms = msOf(text);
    const at = mark.from + i;
    if (!fin(ms)) return "an outbox line carries no time";
    if (ms < last)
      return ms < mark.t0 - TRACE_ROUNDING_MS
        ? "an outbox line precedes the sample's mark"
        : "the outbox trace's times go back";
    last = ms;
    if (ms > completion.at + TRACE_ROUNDING_MS)
      return "an outbox line follows the completion read";
    if (
      at < timing.to
        ? ms > timing.done + TRACE_ROUNDING_MS
        : ms < timing.done - TRACE_ROUNDING_MS
    )
      return "an outbox line's time contradicts the timing read (its position and its time disagree)";
  }
  return null;
}

/** Why the first identity is not a complete binding of an observed, running dispatcher to the sample's account (null: it is). */
function bindingProblem(w, id) {
  if (!isObj(id)) return "the witness records no dispatch identity";
  if (id.page !== w.mark.page || id.time_origin !== w.mark.time_origin)
    return "the page was reloaded or replaced during the sample";
  if (id.observing !== true) return "the sample's dispatcher was not observed";
  if (
    id.running !== true ||
    !Number.isInteger(id.dispatcher) ||
    !Number.isInteger(id.run)
  )
    return "the sample's outbox had no running dispatcher";
  if (
    id.live !== true ||
    !Number.isInteger(id.service) ||
    typeof id.incarnation !== "string"
  )
    return "the sample's outbox had no live service";
  if (id.current_service !== id.service)
    return "the dispatcher resolved another service than the outbox it belongs to";
  if (
    typeof w.account !== "string" ||
    id.account !== w.account ||
    id.identity_account !== w.account ||
    !Number.isInteger(id.epoch)
  )
    return "the session was not on the sample's account";
  return null;
}
/** What changed between two dispatch identities, as the sample's problem (null: nothing). The writer refuses with it too. */
export function draftBindingChange(a, b, where) {
  return changeProblem(a, b, where);
}
function changeProblem(a, b, where) {
  if (!isObj(b)) return `the witness records no dispatch identity ${where}`;
  const changed = IDENTITY.filter((k) => a[k] !== b[k]);
  if (changed.length === 0) return null;
  const any = (...keys) => keys.some((k) => changed.includes(k));
  const what = any("page", "time_origin")
    ? "the page was reloaded or replaced"
    : any("dispatcher", "run", "running", "observing")
      ? "the dispatcher was rebuilt, restarted or stopped"
      : any("service", "current_service", "incarnation", "live")
        ? "the account service ended or was replaced"
        : "the account or its epoch changed";
  return `${what} during the sample (${where}: ${changed.join(", ")})`;
}

/**
 * The operation of a `draft-request-sample/5` witness (WEB-09c revision 15; review 15 R2, design assessment DA15-R2a/R2b; revision 14's
 * DA-R14-A/B/C kept): `{ status, problem, selected, values }`. `selected` holds the absolute outbox trace positions of the send and the
 * answer, the request's index in `resources` and the sequence numbers of the dispatcher's claim, request, receipt call and receipt result.
 *
 * Completion is POSITIVE and the SAME dispatch's: the observed dispatcher's one claim of this local ID (applied/claimed), its one request
 * keyed by it, answered, and its one `data.admitReceipt` of it, applied/admitted, all by the sample's dispatcher, run and service, at its
 * epoch, with nothing else recorded and no further send, answer or failure traced up to the completion read; the identity is the same
 * before and after every await. Revision 15: every record must be well formed for its kind, every result must repeat its call's identity
 * (dispatcher, service, plan, local ID, epoch; a request's key and path) and be its only result, the records and the trace are ordered in
 * time inside [t0, the completion read's end] and agree with each read's record position and time, and the receipt's result lies before
 * the completion read's recorded start (`started_at`, `log_before`): a result delivered during the read cannot be corroborated by it. The
 * row read through the bound service corroborates (`removed` ⇒ gone, otherwise `acknowledged`); a read failure or a contradiction is
 * invalid, never absence. The values are revision 13's: completion is evidence, not an endpoint. Revision 16 (`/4`; DA16-D1, I3/I4): the
 * dispatcher's request is to the `/commands` pathname, and every retained entry is that pathname and lies inside [t0, completion.at].
 * Revision 17 (`/5`; DA17-RQ/BF): the dispatcher's call began no later than its entry started and returned no earlier than the entry's
 * request was sent; both buffer snapshots are typed, below the buffer and contain their counts, and the buffer never shrank between them.
 */
export function draftWitnessSelection(w) {
  if (
    !isObj(w) ||
    !isObj(w.mark) ||
    !isObj(w.timing) ||
    !isObj(w.completion) ||
    !isObj(w.identities) ||
    !isObj(w.enqueue)
  )
    return invalid(
      "the witness is not a mark, an enqueue, a timing read and a completion read",
    );
  if (!Array.isArray(w.lines) || !w.lines.every((l) => typeof l === "string"))
    return invalid("the witness retains no trace slice");
  if (!Array.isArray(w.resources))
    return invalid("the witness retains no requests");
  if (!Array.isArray(w.records))
    return invalid("the witness retains no dispatch records");
  const { mark, timing, completion } = w;
  if (typeof mark.page !== "string" || !fin(mark.time_origin))
    return invalid("the witness does not name its page");
  // One binding, unchanged across every await (first: a replaced page or dispatcher explains whatever its slices show).
  const stages = [
    ["after the queue read", w.identities.queued],
    ["after the enqueue", w.identities.enqueued],
    ["at the timing read", timing.identity],
    ["before the completion read", completion.identity_before],
    ["after the completion read", completion.identity_after],
  ];
  const id = w.identities.before;
  const bound = bindingProblem(w, id);
  if (bound) return invalid(bound);
  for (const [where, other] of stages) {
    const changed = changeProblem(id, other, where);
    if (changed) return invalid(changed);
  }
  if (!isCount(mark.from) || completion.to !== mark.from + w.lines.length)
    return invalid(
      "its trace slice is not contiguous from the mark to the completion read",
    );
  if (!isCount(timing.to) || timing.to < mark.from || timing.to > completion.to)
    return invalid("its timing read does not lie inside the sample");
  if (
    !isCount(mark.log_from) ||
    !isCount(completion.log_first) ||
    completion.log_first > mark.log_from
  )
    return invalid("dispatch records of the sample were trimmed from the log");
  if (
    !w.records.every((r, i) => isObj(r) && r.seq === mark.log_from + i) ||
    completion.log_to !== mark.log_from + w.records.length
  )
    return invalid(
      "its dispatch records are not contiguous from the mark to the completion read",
    );
  if (
    !isCount(timing.log_to) ||
    timing.log_to < mark.log_from ||
    timing.log_to > completion.log_to
  )
    return invalid("its timing read does not lie inside the sample's records");
  // Revision 15: the completion read's start, recorded before it awaited the row (record position and time).
  if (
    !isCount(completion.log_before) ||
    completion.log_before < timing.log_to ||
    completion.log_before > completion.log_to
  )
    return invalid(
      "its completion read records no start inside the sample's records",
    );
  if (!isCount(completion.resource_entries) || !isCount(timing.requests))
    return invalid("the witness does not record the resource buffer's entries");
  if (completion.resource_entries >= RESOURCE_BUFFER)
    return invalid(
      "the resource-timing buffer was full: requests may be missing",
    );
  // Revision 17 (DA17-BF, invariants 4 and 5): both snapshots, each read's count within its own total, and one uninterrupted buffer.
  if (w.resources.length > completion.resource_entries)
    return invalid(
      "the completion read retains more requests than the buffer held",
    );
  if (!isCount(timing.resource_entries))
    return invalid(
      "its timing read does not record the resource buffer's entries",
    );
  if (timing.resource_entries >= RESOURCE_BUFFER)
    return invalid(
      "the resource-timing buffer was full at the timing read: requests may be missing",
    );
  if (timing.requests > timing.resource_entries)
    return invalid("its timing read saw more requests than the buffer held");
  if (timing.requests > w.resources.length)
    return invalid("its timing read saw requests the completion read lost");
  const lifetime = bufferLifetimeProblem(
    { total: timing.resource_entries, retained: timing.requests },
    { total: completion.resource_entries, retained: w.resources.length },
  );
  if (lifetime) return invalid(lifetime);
  if (mark.waiting !== 0)
    return invalid("another draft was waiting when the sample began");
  if (
    typeof w.local_id !== "string" ||
    w.local_id === "" ||
    w.enqueue.kind !== "queued" ||
    w.enqueue.local_id !== w.local_id
  )
    return invalid(
      `the sample's draft was not enqueued (${String(w.enqueue.kind)})`,
    );
  if (!fin(mark.t0) || !fin(mark.t1) || !(mark.t0 <= mark.t1))
    return invalid("the enqueue's times are not an interval");
  // Revision 15 (invariant 3): the reads' own times, in order: the timing read, then the completion read's start and end.
  if (!fin(timing.done) || timing.at !== timing.done)
    return invalid("its timing read does not record one time");
  if (timing.done < mark.t1)
    return invalid("its timing read's time is not after the enqueue");
  if (
    !fin(completion.started_at) ||
    !fin(completion.at) ||
    !(timing.done <= completion.started_at) ||
    !(completion.started_at <= completion.at)
  )
    return invalid(
      "its completion read's times are not after its timing read and in order",
    );
  // Every record well formed for its kind, every result its call's only one with its call's identity, and one ordered interval.
  for (const r of w.records) {
    const problem = recordProblem(r);
    if (problem)
      return invalid(`dispatch record ${r.seq} is malformed: ${problem}`);
  }
  const unpaired = pairingProblem(w.records);
  if (unpaired) return invalid(unpaired);
  const outside = intervalProblem(w);
  if (outside) return invalid(outside);

  // The dispatcher's records, from the mark to the completion read: the claim, the request and the receipt of THIS draft, and nothing else.
  const L = w.local_id;
  // The sample's actor: its dispatcher and run, and (a commit) its service.
  const own = (r) =>
    r.dispatcher === id.dispatcher &&
    r.run === id.run &&
    (!COMMIT_KINDS.includes(r.event) || r.service === id.service);
  let claim = null;
  let claimed = null;
  let issued = null;
  let answered = null;
  let receipt = null;
  let received = null;
  let gated = false;
  let extra = null;
  const note = (problem) => {
    extra ??= problem;
  };
  for (const r of w.records) {
    if (LIFECYCLE.includes(r.event)) {
      note(`the dispatcher's lifecycle changed during the sample (${r.event})`);
      continue;
    }
    if (WRITE_KINDS.includes(r.event)) {
      note(`the dispatcher ran ${String(r.plan)} during the sample`);
      continue;
    }
    const subject = REQUEST_KINDS.includes(r.event) ? r.key : r.local_id;
    if (subject !== L) {
      note(
        `another draft's dispatch (${String(r.plan ?? r.path)}) was recorded during the sample`,
      );
      continue;
    }
    if (r.event === "commit_gated") {
      // A qualification gate held the dispatcher's call (its transaction not yet admitted): the receipt is still to come. Only the
      // sample's own actor's receipt call can be held so.
      if (r.plan !== "data.admitReceipt" || !own(r))
        note(
          `the dispatcher held ${String(r.plan)} of another actor or plan during the sample`,
        );
      else if (!receipt) gated = true;
      continue;
    }
    if (r.event === "commit_begin") {
      if (r.plan === "data.markInFlight") {
        if (claim) note("the draft was claimed twice during the sample");
        else claim = r;
      } else if (r.plan === "data.admitReceipt") {
        if (receipt)
          note("the draft's receipt was committed twice during the sample");
        else receipt = r;
      } else
        note(
          `the dispatcher committed ${String(r.plan)} for the draft during the sample`,
        );
    } else if (r.event === "commit_end") {
      if (claim && r.of === claim.seq && !claimed) claimed = r;
      else if (receipt && r.of === receipt.seq && !received) received = r;
      else note("a commit result has no recorded call in the sample");
    } else if (r.event === "request_begin") {
      if (issued)
        note(
          "the draft was requested again during the sample: a later attempt cannot complete the sample's",
        );
      else issued = r;
    } else if (issued && r.of === issued.seq && !answered) answered = r;
    else note("a request result has no recorded request in the sample");
  }

  // The outbox trace: the first send, its answer (a receipt), and no further send, answer or failure up to the completion read.
  let send = -1;
  let answer = -1;
  let after = null;
  for (const [i, line] of w.lines.entries()) {
    const event = eventOf(line);
    if (!OUTBOX.includes(event)) continue;
    const at = mark.from + i;
    if (send < 0) {
      if (event !== "data.outbox_send")
        return invalid(`${event} came before the sample's send`);
      if (payloadOf(line)?.resend !== false)
        return invalid("the sample's first send is a resend");
      send = at;
    } else if (answer < 0) {
      if (event === "data.outbox_send")
        return invalid(
          "the draft was sent again before an answer: a first attempt that got no answer cannot donate its send",
        );
      if (event === "data.outbox_step_failed")
        return invalid("the dispatcher's step failed before the answer");
      answer = at;
      const kind = payloadOf(line)?.kind;
      if (kind !== "receipt")
        return invalid(
          `the draft's answer was ${String(kind)}, not a receipt: outside the measured population`,
        );
    } else
      after ??=
        event === "data.outbox_send"
          ? "the draft was sent again after its answer: a later attempt cannot complete the sample's"
          : event === "data.outbox_answer"
            ? "a second answer followed the sample's answer"
            : "the dispatcher's step failed after the answer";
  }
  if (send < 0)
    return extra ? invalid(extra) : pending("the draft has not been sent");
  if (answer < 0)
    return extra
      ? invalid(extra)
      : pending("the draft's send has no answer yet");
  const line = (at) => w.lines[at - mark.from];
  const sent = msOf(line(send));
  const answeredMs = msOf(line(answer));
  if (![sent, answeredMs].every(fin))
    return invalid("an outbox line carries no time");
  if (sent < mark.t1 - TRACE_ROUNDING_MS)
    return invalid("its send precedes the end of its enqueue");
  if (answer >= timing.to)
    return invalid("its timing read did not see its answer");
  if (timing.done < answeredMs - TRACE_ROUNDING_MS)
    return invalid("the sample was read before its answer");

  // The same dispatch, positively: claim → request → receipt, by the sample's dispatcher, run and service, at its epoch.
  if (!claim) return invalid(extra ?? "the sample's claim was not recorded");
  if (!claimed) return invalid(extra ?? "the claim's result was not recorded");
  if (claimed.outer !== "applied" || claimed.inner !== "claimed")
    return invalid(
      `the claim did not claim the draft (${String(claimed.outer)}/${String(claimed.inner ?? claimed.reason)})`,
    );
  if (!issued) return invalid(extra ?? "the sample's request was not recorded");
  if (issued.seq < claimed.seq)
    return invalid("the request was issued before its claim completed");
  if (!answered)
    return invalid(extra ?? "the sample's request has no recorded result");
  if (answered.outer !== "response")
    return invalid(
      `the sample's request got no response (${String(answered.error)})`,
    );
  if (!receipt)
    return gated && !extra
      ? pending("the draft's receipt transaction has not been admitted yet")
      : invalid(extra ?? "the answer's receipt was never committed");
  if (receipt.seq < answered.seq)
    return invalid("the receipt was committed before its request's response");
  if (!received)
    return extra
      ? invalid(extra)
      : pending("the draft's receipt transaction has not completed");
  for (const [what, r] of [
    ["claim", claim],
    ["claim's result", claimed],
    ["request", issued],
    ["request's result", answered],
    ["receipt", receipt],
    ["receipt's result", received],
  ])
    if (!own(r))
      return invalid(
        `the ${what} was made by another dispatcher, run or service than the sample's`,
      );
  if (claim.epoch !== id.epoch || receipt.epoch !== id.epoch)
    return invalid(
      "the dispatch was captured at another epoch than the sample's",
    );
  if (received.outer !== "applied")
    return invalid(
      `the draft's receipt transaction was not applied (${String(received.outer)}${received.reason ? `/${received.reason}` : ""})`,
    );
  if (received.inner !== "admitted")
    return invalid(
      `the draft's receipt was not admitted (${String(received.inner)}${received.reason ? `/${received.reason}` : ""})`,
    );
  if (typeof received.removed !== "boolean")
    return invalid(
      "the receipt's result does not say whether it removed the row",
    );
  if (issued.at < sent - TRACE_ROUNDING_MS)
    return invalid("its recorded request precedes its send");
  if (answered.at > answeredMs + TRACE_ROUNDING_MS)
    return invalid("its recorded response follows its answer");
  if (receipt.at < answeredMs - TRACE_ROUNDING_MS)
    return invalid("its receipt was committed before its answer");
  if (extra) return invalid(extra);
  if (after) return invalid(after);
  // Revision 15: the receipt's result was delivered before the completion read began, so the read can corroborate it.
  if (received.seq >= completion.log_before)
    return invalid(
      "the receipt's result was delivered during the completion read: the read cannot corroborate it",
    );

  // The row, read through the bound service once the receipt's result was delivered.
  const row = completion.row;
  if (!isObj(row))
    return invalid("the completion read returned no recognised result");
  if (row.kind === "error")
    return invalid(`the completion read failed: ${String(row.problem)}`);
  if (row.kind === "row") {
    if (row.local_id !== L)
      return invalid("the completion read returned another draft's row");
    if (received.removed)
      return invalid(
        `the receipt removed the draft's row but the completion read found it (${String(row.status)})`,
      );
    if (row.status !== "acknowledged")
      return invalid(
        `the completion read found the draft ${String(row.status)}, not acknowledged`,
      );
  } else if (row.kind === "absent") {
    if (!received.removed)
      return invalid(
        "the draft's row is gone though its receipt kept it: no recorded relation explains the removal",
      );
  } else return invalid("the completion read returned no recognised result");
  if (completion.waiting !== 0)
    return invalid("another draft was waiting at the completion read");

  // The one `/commands` entry since the mark (the buffer was cleared there), inside [send, answer], seen by the timing read, and the
  // one the dispatcher's request was made to.
  // Revision 16 (DA16-D1): every retained entry is the /commands endpoint itself (the helper's exact pathname), and the dispatcher's
  // request (whose result repeats its path: pairing) must be to that entry's path below. Three fields agreeing on a foreign path are
  // refused by the first; a request to another path than a /commands entry by the second.
  const { request, problem } = oneRequest(
    w.resources,
    sent,
    answeredMs,
    Number.POSITIVE_INFINITY,
    { path: COMMANDS_PATH, label: "/commands" },
    { from: mark.t0, to: completion.at },
  );
  if (problem) return invalid(problem);
  const r = w.resources[request];
  if (request >= timing.requests || r.responseEnd > timing.done)
    return invalid("its timing read did not see its request");
  if (r.name !== issued.path)
    return invalid(
      "the dispatcher's request was made to another path than its /commands entry",
    );
  // Revision 17 (DA17-RQ, invariant 2): the entry is causally possible for the dispatcher's one observed call. The observer records the
  // call's begin before it calls the stamped sender, so the call began no later than its entry started; its result is recorded once
  // the sender returned, which needs at least the response headers, so no earlier than the entry's request was sent. Not required:
  // `responseEnd <= request_end` (a generic fetch can return before its body ends; review 17).
  if (!(issued.at <= r.startTime + RAW_CLOCK_ALLOWANCE_MS))
    return invalid(
      "the dispatcher's request began after its /commands entry started: the entry is not that call's",
    );
  if (!(r.requestStart <= answered.at + RAW_CLOCK_ALLOWANCE_MS))
    return invalid(
      "the dispatcher's request returned before its /commands entry's request was sent: the entry is not that call's",
    );
  return {
    status: "complete",
    problem: null,
    selected: {
      send,
      answer,
      request,
      claim: claim.seq,
      issued: issued.seq,
      receipt: receipt.seq,
      received: received.seq,
    },
    values: {
      enqueue_ms: mark.t1 - mark.t0,
      claim_ms: sent - mark.t1,
      stamping_ms: r.requestStart - sent,
      request_ms: r.responseEnd - r.requestStart,
      record_ms: answeredMs - r.responseEnd,
      total_ms: timing.done - mark.t0,
    },
  };
}
