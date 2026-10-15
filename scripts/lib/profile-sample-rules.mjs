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
//   draft  `draft-request-sample/1`: no draft waiting at the mark, the enqueue, ONE first send (`resend: false`) after it, the first answer
//          after that send with no second send or failed step between, the ONE `/commands` entry inside [send, answer] and the draft's own
//          outcome recorded (its `localId` no longer queued or in flight). A first attempt that got no answer can never donate its send.
//
// Pending (the operation has not finished) is distinct from invalid (it finished, or the witness shows it cannot be the sample's).

export const SYNC_WITNESS_METHOD = "sync-request-sample/2";
export const DRAFT_WITNESS_METHOD = "draft-request-sample/1";
/** The trace's own millisecond rounding (`Math.round(performance.now())`): a resource time may lie up to this far outside its line. */
export const TRACE_ROUNDING_MS = 1;
/** The default ResourceTiming buffer: at this many entries the browser drops new ones, so the inventory may be incomplete. */
export const RESOURCE_BUFFER = 250;

const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isCount = (x) => Number.isInteger(x) && x >= 0;
const fin = (x) => typeof x === "number" && Number.isFinite(x);
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

/** The shape, page identity and trace continuity every witness shares; a problem string or null. */
function frameProblem(w) {
  if (!isObj(w) || !isObj(w.mark) || !isObj(w.read))
    return "the witness is not a mark and a read";
  if (!Array.isArray(w.lines) || !w.lines.every((l) => typeof l === "string"))
    return "the witness retains no trace slice";
  if (!Array.isArray(w.resources)) return "the witness retains no requests";
  if (
    typeof w.mark.page !== "string" ||
    w.read.page !== w.mark.page ||
    !fin(w.mark.time_origin) ||
    w.read.time_origin !== w.mark.time_origin
  )
    return "the page was reloaded or replaced during the sample";
  if (!isCount(w.mark.from) || w.read.to !== w.mark.from + w.lines.length)
    return "its trace slice is not contiguous from the mark to the read";
  if (!isCount(w.read.resource_entries))
    return "the witness does not record the resource buffer's entries";
  if (w.read.resource_entries >= RESOURCE_BUFFER)
    return "the resource-timing buffer was full: requests may be missing";
  return null;
}

/**
 * The one request entry of an operation from `from` to `to` (trace times) that closed at `end`: the unique entry inside [from − 1, to + 1];
 * an entry that began before the operation, or overlaps it up to its end without lying inside, makes it ambiguous. Entries that begin
 * after the end belong to later operations and are ignored. Returns `{ request, problem }`.
 */
function oneRequest(resources, from, to, end, label) {
  // Judged once the operation is known, so a relation the trace already refutes (a second send, an earlier step's end) is named first.
  for (const r of resources)
    if (
      !isObj(r) ||
      ![r.startTime, r.requestStart, r.responseEnd].every(fin) ||
      !(r.startTime <= r.requestStart && r.requestStart <= r.responseEnd)
    )
      return { request: null, problem: "a request entry has no usable timing" };
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
 * The operation of a `sync-request-sample/2` witness: `{ status: "complete" | "pending" | "invalid", problem, selected, values }`.
 * `selected` holds absolute trace positions (`start`, `commit`, `end`) and the request's index in `resources`.
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
  const tick = msOf(line(start));
  const committed = msOf(line(commit));
  const ended = msOf(line(end));
  if (![tick, committed, ended].every(fin))
    return invalid("a step line carries no time");
  const { request, problem } = oneRequest(
    w.resources,
    tick,
    committed,
    ended,
    "/sync",
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
const UNSETTLED = ["queued", "in_flight"];

/**
 * The operation of a `draft-request-sample/1` witness: `{ status, problem, selected, values }`; `selected` holds the absolute outbox trace
 * positions of the send and the answer and the request's index in `resources`.
 */
export function draftWitnessSelection(w) {
  const frame = frameProblem(w);
  if (frame) return invalid(frame);
  if (w.mark.waiting !== 0)
    return invalid("another draft was waiting when the sample began");
  if (typeof w.local_id !== "string" || w.local_id === "")
    return invalid("the sample's draft was not enqueued");
  if (!fin(w.mark.t0) || !fin(w.mark.t1) || !(w.mark.t0 <= w.mark.t1))
    return invalid("the enqueue's times are not an interval");
  let send = -1;
  let answer = -1;
  for (const [i, line] of w.lines.entries()) {
    const event = eventOf(line);
    if (!OUTBOX.includes(event)) continue;
    const at = w.mark.from + i;
    if (send < 0) {
      if (event !== "data.outbox_send")
        return invalid(`${event} came before the sample's send`);
      if (payloadOf(line)?.resend !== false)
        return invalid("the sample's first send is a resend");
      send = at;
      continue;
    }
    if (event === "data.outbox_send")
      return invalid(
        "the draft was sent again before an answer: a first attempt that got no answer cannot donate its send",
      );
    if (event === "data.outbox_step_failed")
      return invalid("the dispatcher's step failed before the answer");
    answer = at;
    break;
  }
  if (send < 0) return pending("the draft has not been sent");
  if (answer < 0) return pending("the draft's send has no answer yet");
  const line = (at) => w.lines[at - w.mark.from];
  const sent = msOf(line(send));
  const answered = msOf(line(answer));
  if (![sent, answered].every(fin))
    return invalid("an outbox line carries no time");
  if (sent < w.mark.t1 - TRACE_ROUNDING_MS)
    return invalid("its send precedes the end of its enqueue");
  if (!fin(w.read.done) || w.read.done < answered - TRACE_ROUNDING_MS)
    return invalid("the sample was read before its answer");
  if (
    !isObj(w.settled) ||
    w.settled.local_id !== w.local_id ||
    typeof w.settled.status !== "string" ||
    UNSETTLED.includes(w.settled.status)
  )
    return invalid("the draft's outcome was not recorded");
  const { request, problem } = oneRequest(
    w.resources,
    sent,
    answered,
    answered,
    "/commands",
  );
  if (problem) return invalid(problem);
  const r = w.resources[request];
  return {
    status: "complete",
    problem: null,
    selected: { send, answer, request },
    values: {
      enqueue_ms: w.mark.t1 - w.mark.t0,
      claim_ms: sent - w.mark.t1,
      stamping_ms: r.requestStart - sent,
      request_ms: r.responseEnd - r.requestStart,
      record_ms: answered - r.responseEnd,
      total_ms: w.read.done - w.mark.t0,
    },
  };
}
