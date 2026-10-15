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
//   draft  `draft-request-sample/2` (revision 14, review 14 R2): no draft waiting at the mark, the enqueue, ONE first send (`resend:
//          false`) after it, its answer (a receipt) and the ONE `/commands` entry inside [send, answer]; completion is the observed
//          dispatcher's own applied/admitted receipt of that local ID, by the same dispatcher, run and service, with nothing else recorded
//          or traced up to the completion read, and the binding unchanged across every await. Revision 13's `draft-request-sample/1` closed
//          the sample on any later queue status but queued/in_flight (an unreadable read, a replaced page, a later retry's row).
//
// Pending (the operation has not finished) is distinct from invalid (it finished, or the witness shows it cannot be the sample's).

export const SYNC_WITNESS_METHOD = "sync-request-sample/2";
export const DRAFT_WITNESS_METHOD = "draft-request-sample/2";
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
 * The operation of a `draft-request-sample/2` witness (WEB-09c revision 14; review 14 R2, design assessment DA-R14-A/B/C): `{ status, problem,
 * selected, values }`. `selected` holds the absolute outbox trace positions of the send and the answer, the request's index in `resources`
 * and the sequence numbers of the dispatcher's claim, request, receipt call and receipt result.
 *
 * Revision 13's rule broke at the first answer and accepted any queue status but `queued`/`in_flight` read later, unfenced: a read that
 * threw, a replacement page's empty queue and a row a later retry acknowledged all passed. Here completion is POSITIVE and the SAME
 * dispatch's: the observed dispatcher's one claim of this local ID (applied/claimed), its one request keyed by it, answered, and its one
 * `data.admitReceipt` of it, applied/admitted, all by the sample's dispatcher, run and service, at its epoch, with nothing else recorded and
 * no further send, answer or failure traced up to the completion read. The identity is the same before and after every await. The row read
 * through the bound service corroborates (`removed` ⇒ gone, otherwise `acknowledged`); a read failure or a contradiction is invalid,
 * never absence. The values are revision 13's: completion is evidence, not an endpoint.
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
  if (!isCount(completion.resource_entries) || !isCount(timing.requests))
    return invalid("the witness does not record the resource buffer's entries");
  if (completion.resource_entries >= RESOURCE_BUFFER)
    return invalid(
      "the resource-timing buffer was full: requests may be missing",
    );
  if (timing.requests > w.resources.length)
    return invalid("its timing read saw requests the completion read lost");
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

  // The dispatcher's records, from the mark to the completion read: the claim, the request and the receipt of THIS draft, and nothing else.
  const L = w.local_id;
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
    if (r.event === "write_begin" || r.event === "write_end") {
      note(`the dispatcher ran ${String(r.plan)} during the sample`);
      continue;
    }
    const subject =
      typeof r.event === "string" && r.event.startsWith("request_")
        ? r.key
        : r.local_id;
    if (
      ![
        "commit_begin",
        "commit_end",
        "commit_gated",
        "request_begin",
        "request_end",
      ].includes(r.event)
    ) {
      note(`an unrecognised dispatch record (${String(r.event)})`);
      continue;
    }
    if (subject !== L) {
      note(
        `another draft's dispatch (${String(r.plan ?? r.path)}) was recorded during the sample`,
      );
      continue;
    }
    if (r.event === "commit_gated") {
      // A qualification gate held the dispatcher's call (its transaction not yet admitted): the receipt is still to come.
      if (r.plan === "data.admitReceipt" && !receipt) gated = true;
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
  if (!fin(timing.done) || timing.done < answeredMs - TRACE_ROUNDING_MS)
    return invalid("the sample was read before its answer");

  // The same dispatch, positively: claim → request → receipt, by the sample's dispatcher, run and service, at its epoch.
  const own = (r) =>
    r.dispatcher === id.dispatcher &&
    r.run === id.run &&
    (r.service === undefined || r.service === id.service);
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
  if (![issued.at, answered.at, receipt.at].every(fin))
    return invalid("a dispatch record carries no time");
  if (issued.at < sent - TRACE_ROUNDING_MS)
    return invalid("its recorded request precedes its send");
  if (answered.at > answeredMs + TRACE_ROUNDING_MS)
    return invalid("its recorded response follows its answer");
  if (receipt.at < answeredMs - TRACE_ROUNDING_MS)
    return invalid("its receipt was committed before its answer");
  if (extra) return invalid(extra);
  if (after) return invalid(after);

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

  // The one `/commands` entry since the mark (the buffer was cleared there), inside [send, answer], seen by the timing read.
  const { request, problem } = oneRequest(
    w.resources,
    sent,
    answeredMs,
    Number.POSITIVE_INFINITY,
    "/commands",
  );
  if (problem) return invalid(problem);
  if (request >= timing.requests)
    return invalid("its timing read did not see its request");
  const r = w.resources[request];
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
