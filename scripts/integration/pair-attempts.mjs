// WEB-09c revision 24 (R23-PAIR.a, family `segmented-sync-development-pairing`): the development pair's ATTEMPT accounting, kept apart from
// the browser so it can be qualified with the real tap → holding proxy → client boundary and with doubles (pair-attempts.test.mjs).
//
// Several things are easily mistaken for one another, and each is kept as its own observation:
//   - the SERVER answered (the tap's record: upstream bytes, `seq`);
//   - the TAP wrote to the proxy (`t_delivered` / `client_gone` on the tap's record: the tap → proxy hop only);
//   - the PROXY wrote downstream, or found its client gone (the proxy log entry `proxy_id`: `delivered`, `client_closed`, `client_gone`). Its
//     client is the preview server's proxied connection for the page, so `delivered` is a socket write on that hop, never the page's receipt;
//   - the CLIENT persisted it (a raw IndexedDB read: the stage's next index, the cursor), or activated it (applied revision, nothing staged).
// An attempt the case made unreachable (the page reloaded or closed while the answer was held) is LOST: it is kept, with the proxy's own
// outcome (whichever it is: a page that departed may still have been written to), in every record and total, but it is not a piece the
// client received, and it gives the chain no cursor. The client's next request must then ask from the unchanged stored cursor (the driver's
// model is not advanced; its raw stored-state check at the next request is the corroboration). An attempt the case expected to reach the
// client must have been delivered downstream: anything else is a contradiction, never a pass.
//
// Correlation is exact or refused: every tap record names the proxy log entry it came through (`proxy_id`); a held entry with no tap
// record, or with more than one, is ambiguity, never "the newest one".

/** The header the pair runner gives both the proxy and the tap (stripped by the tap before the backend). */
export const CORRELATION_HEADER = "x-atlas-pair-proxy-id";

const FINAL_EVENTS = new Set([
  "delivered",
  "client_gone",
  "upstream_error",
  "dropped",
  "discarded",
  "discarded_at_stop",
]);
/** A proxy log entry's downstream outcome: its last terminal event (`pending` while none). `client_closed` before a release stays visible. */
export function outcomeOf(entry) {
  if (!entry || !Array.isArray(entry.events)) return "unknown";
  const last = entry.events.filter((e) => FINAL_EVENTS.has(e.event)).at(-1);
  return last ? last.event : "pending";
}

/**
 * The held answer to handle next: the OLDEST held proxy entry of the rule and the one tap record carrying its id. Null while that record
 * is not complete. Throws on any record without a correlation id, or a held entry claimed by several records.
 */
export function pickHeld(heldIds, records) {
  const uncorrelated = records.filter((r) => !Number.isInteger(r.proxy_id));
  if (uncorrelated.length > 0)
    throw new Error(
      `tap records ${uncorrelated.map((r) => r.seq).join(",")} carry no proxy correlation id: the hold cannot be joined to an exchange`,
    );
  const ids = [...heldIds].sort((a, b) => a - b);
  if (ids.length === 0) return null;
  const proxyId = ids[0];
  const own = records.filter((r) => r.proxy_id === proxyId);
  if (own.length > 1)
    throw new Error(
      `proxy entry ${proxyId} is claimed by tap records ${own.map((r) => r.seq).join(",")}`,
    );
  const record = own[0];
  if (!record || record.status === null || record.status === undefined)
    return null;
  return { proxyId, record };
}

/** What a received answer did to the driver's chain model (before → after `advance`). */
export function effectOf(before, after) {
  if (after.restarted > before.restarted) return "restarted";
  if (after.activated !== before.activated && after.activated !== null)
    return "activated";
  if (
    after.stage !== null &&
    (before.stage === null ||
      after.stage.next_index !== before.stage.next_index ||
      after.stage.revision !== before.stage.revision)
  )
    return "staged";
  return "none";
}

/**
 * The ledger of one driven interval. `open` begins an attempt at a held answer; `observe` is told of the stored state read at each later
 * held answer and returns the ONE persistence event a previously received, staged piece earns (a repeated observation of the same stage
 * earns nothing); `settle` closes the attempt with the case's claim and the proxy's outcome; `unheld` keeps an answer that never reached
 * the hold (the tap dropped the connection). `received()` is the client's applied order of answers.
 */
export function createLedger() {
  const attempts = [];
  const persisted = [];
  let pending = null;
  return {
    attempts,
    persisted,
    open({ step, record, proxyId }) {
      const attempt = {
        step,
        seq: record.seq,
        proxy_id: proxyId,
        request_cursor: record.query?.cursor ?? null,
        segment: record.segment ?? null,
        revision: record.revision ?? null,
        sha256: record.sha256 ?? null,
        client: null,
        downstream: null,
        effect: null,
      };
      attempts.push(attempt);
      return attempt;
    },
    observe({ atSeq, stage }) {
      if (pending === null) return null;
      const event = {
        applied_seq: pending.seq,
        observed_at_seq: atSeq,
        next_index: stage?.next_index ?? null,
      };
      pending = null;
      persisted.push(event);
      return event;
    },
    settle(attempt, { reached, downstream, effect }) {
      attempt.downstream = downstream;
      // A lost attempt changes nothing the client stored: a received piece still awaiting its witness keeps waiting for it.
      if (reached === false) {
        attempt.client = "lost";
        attempt.effect = "none";
        return attempt;
      }
      if (downstream !== "delivered")
        throw new Error(
          `seq ${attempt.seq}: the case expected the answer to reach the client, but the proxy recorded ${downstream}`,
        );
      attempt.client = "received";
      attempt.effect = effect;
      pending = effect === "staged" ? attempt : null;
      return attempt;
    },
    unheld(record, downstream) {
      if (!record.dropped)
        throw new Error(
          `seq ${record.seq}: an answer of the interval was neither held nor dropped by the tap`,
        );
      const attempt = {
        step: null,
        seq: record.seq,
        proxy_id: record.proxy_id ?? null,
        request_cursor: record.query?.cursor ?? null,
        segment: record.segment ?? null,
        revision: record.revision ?? null,
        sha256: record.sha256 ?? null,
        client: "dropped",
        downstream,
        effect: "none",
      };
      attempts.push(attempt);
      return attempt;
    },
    received() {
      return attempts.filter((a) => a.client === "received");
    },
  };
}

/** What the client was answered: the injected answer when there was one, else the server's (dropped: nothing). */
export function seenOf(r) {
  const d = r.delivered;
  return {
    status: r.dropped ? null : d ? d.status : r.status,
    batches: d ? (d.batches ?? null) : (r.batches ?? null),
    revision: d ? d.revision : (r.revision ?? null),
    last_revision: d ? d.last_revision : (r.last_revision ?? null),
    segment: d ? d.segment : (r.segment ?? null),
    has_more: d ? d.has_more : (r.has_more ?? null),
    next_cursor: d ? d.next_cursor : (r.next_cursor ?? null),
  };
}

/** Whether `r` (an answer carrying its join: `downstream.outcome`, optional `attempt.client`) reached a live client. */
export const reachedClient = (r) =>
  !r.dropped &&
  r.downstream?.outcome === "delivered" &&
  r.attempt?.client !== "lost";

/** Whether answer `r` can be the one that ACTIVATED `revision`: a final piece of it, or a whole/snapshot page whose last batch is it. */
export function activates(r, revision) {
  const s = seenOf(r);
  if (s.status !== 200 || !(Number.isInteger(s.batches) && s.batches > 0))
    return false;
  if (s.segment) return s.segment.last === true && s.revision === revision;
  return s.last_revision === revision;
}

/**
 * The terminal references of an interval whose answers were not driven one by one (recovery, a fenced catch-up): the last answer that
 * reached the client with `has_more: false` (feed completion) and the last one at or before it that activated `revision`. Null when either
 * is missing (the interval is then incomplete, not passed).
 */
export function terminalOf(requests, revision) {
  const reached = requests.filter(reachedClient);
  const final = reached
    .filter((r) => seenOf(r).status === 200 && seenOf(r).has_more === false)
    .at(-1);
  if (!final) return null;
  const by = reached
    .filter((r) => r.seq <= final.seq && activates(r, revision))
    .at(-1);
  if (!by) return null;
  return { final_seq: final.seq, activated_by_seq: by.seq };
}

/**
 * The shape of a bounded delivery, over the answers the client RECEIVED in order: more than one piece, every request asked for `m` and every
 * answer stays within it, the pieces of one revision are indexed 0, 1, 2, … with exactly one last piece. Returns the problems (none: valid).
 */
export function segmentedProblems(answers, m, revision = null) {
  const problems = [];
  const ok = answers.filter((r) => r.status === 200);
  if (!(ok.length > 1))
    problems.push(`more than one piece: ${ok.length} answer(s)`);
  for (const r of ok) {
    if (r.query?.max_changes !== String(m))
      problems.push(
        `seq ${r.seq}: the request's budget ${r.query?.max_changes}, not ${m}`,
      );
    if (!((r.changes ?? 0) <= m))
      problems.push(
        `seq ${r.seq}: ${r.changes} changes, above the budget ${m}`,
      );
  }
  const pieces = ok.filter(
    (r) => r.segment && (revision === null || r.revision === revision),
  );
  const indices = pieces.map((r) => r.segment.index);
  if (indices.some((index, i) => index !== i))
    problems.push(`piece indices ${indices.join(",")} are not 0, 1, 2, …`);
  const lasts = pieces.filter((r) => r.segment.last).length;
  if (lasts !== 1) problems.push(`${lasts} last pieces, not exactly one`);
  return problems;
}
