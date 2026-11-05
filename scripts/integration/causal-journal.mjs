// WEB-09c revision 27 (R27-DIAG.a, family `segmented-sync-development-pairing`; design assessment C1): the attempt-scoped CAUSAL JOURNAL.
//
// The review of revision 26 showed that the diagnostic reader compared timestamps from different clocks: the tap's `performance.now()`
// (milliseconds since the runner process started) with the control transcript's `Date.now()` (epoch milliseconds), so a correctly ordered
// real expiry or pruning could never pass. The correction is not a common wall clock (equal ticks, a wall-clock step and the spec's own
// process would still break it): it is ONE total order of the events the RUNNER observes, shared by every producer in the runner process.
//
//   - `record(producer, kind, ref)` appends one event and answers its position `j` (1, 2, 3 … with no gap). The runner's tap, its stdin
//     control and its private bridge all record into the SAME journal of the attempt, synchronously, at the moment the action happens: a
//     request received or forwarded by the tap gate, a command line written, an acknowledgement read, a bridge call or a marker. One event
//     is never reordered after another, so `j` is the causal order of those observations, whatever any clock says.
//   - each event keeps its RAW timestamp with the clock it came from (`clock`: `parent-epoch-ms`, Date.now in the runner), for diagnosis
//     only. No reader orders events by it; equal ticks and a clock that goes backwards change nothing.
//   - the spec (a separate Playwright process) never puts its own clock beside the runner's: it brackets its actions with acknowledged
//     MARKERS through the bridge (the marker's `j` is assigned when the runner receives it, before the spec acts, and the end marker after the
//     spec's awaited result), so "the probe ran between the two clock steps" is `ack(E−1).j < mark(begin).j < mark(end).j < command(E).j`.
//   - persisted incrementally (one JSON line per event, appended at once), bounded (`maxEvents`): an event beyond the bound, or one whose
//     line could not be written, makes the journal INCOMPLETE (`state().complete === false`), and an incomplete journal is never evidence.
//
// `journalProblems` is the independent reader: it re-reads the file, re-hashes it and requires a gap-free sequence of well-formed events of
// one attempt. It answers the events by position so the evidence readers can bind each referenced `j` to the producer, kind and reference
// it claims (a `j` that names another event, or none, is refused).
import { createHash } from "node:crypto";

export const JOURNAL_SCHEMA = "web09c-causal-journal/1";
export const CLOCK = "parent-epoch-ms";
export const PRODUCERS = Object.freeze({
  control: ["stdin", "stdout", "stderr"],
  tap: ["request", "gate_open", "upstream_end", "delivered"],
  bridge: ["call", "answer", "mark"],
});
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * One attempt's journal. `append(line)` persists one line (the runner's `appendFileSync`; it may throw). `now()` is only the raw timestamp.
 * Returns { record(producer, kind, ref) → j, state() → {events, complete, overflowed, write_errors}, attempt }.
 */
export function createJournal({
  attempt,
  append = () => undefined,
  now = () => Date.now(),
  maxEvents = 200_000,
}) {
  if (typeof attempt !== "string" || attempt.length === 0)
    throw new Error("a journal belongs to one named attempt");
  let j = 0;
  let overflowed = false;
  const writeErrors = [];
  return {
    attempt,
    record(producer, kind, ref = {}) {
      if (!PRODUCERS[producer]?.includes(kind))
        throw new Error(`unknown journal event ${producer}.${kind}`);
      j += 1;
      if (j > maxEvents) {
        overflowed = true;
        return j;
      }
      const event = {
        schema: JOURNAL_SCHEMA,
        attempt,
        j,
        producer,
        kind,
        ref,
        at: now(),
        clock: CLOCK,
      };
      try {
        append(`${JSON.stringify(event)}\n`);
      } catch (error) {
        writeErrors.push({ j, error: String(error?.message ?? error) });
      }
      return j;
    },
    state: () => ({
      events: j,
      complete: !overflowed && writeErrors.length === 0,
      overflowed,
      write_errors: [...writeErrors],
    }),
  };
}

/**
 * The journal file's problems and its events by position. `expected`: { attempt, sha256?, events? } (the envelope's record of it).
 * Returns { problems, events: Map<j, event> }.
 */
export function journalProblems(bytes, expected) {
  const problems = [];
  const events = new Map();
  if (bytes === null || bytes === undefined)
    return { problems: ["the causal journal cannot be read"], events };
  if (expected.sha256 !== undefined && sha256(bytes) !== expected.sha256)
    problems.push(
      "the causal journal's bytes are not the ones the envelope names",
    );
  const lines = String(bytes)
    .split("\n")
    .filter((l) => l.length > 0);
  lines.forEach((line, i) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      problems.push(`journal line ${i + 1} is not JSON`);
      return;
    }
    if (e?.schema !== JOURNAL_SCHEMA)
      problems.push(
        `journal line ${i + 1}: schema ${JSON.stringify(e?.schema)}`,
      );
    if (e?.attempt !== expected.attempt)
      problems.push(`journal line ${i + 1} belongs to attempt ${e?.attempt}`);
    if (e?.j !== i + 1)
      problems.push(
        `journal line ${i + 1} is event ${e?.j} (a gap, a replay or a reorder)`,
      );
    if (!PRODUCERS[e?.producer]?.includes(e?.kind))
      problems.push(
        `journal line ${i + 1}: unknown event ${e?.producer}.${e?.kind}`,
      );
    if (e?.clock !== CLOCK || typeof e?.at !== "number")
      problems.push(`journal line ${i + 1} does not name its raw clock`);
    if (Number.isInteger(e?.j) && !events.has(e.j)) events.set(e.j, e);
  });
  if (expected.events !== undefined && lines.length !== expected.events)
    problems.push(
      `the causal journal holds ${lines.length} events, the attempt recorded ${expected.events}`,
    );
  return { problems, events };
}

/**
 * A reference check: the event at `j` is `producer.kind` and its `ref` holds `match` (every key equal). Returns null, or the problem.
 */
export function bindingProblem(events, j, producer, kind, match, what) {
  if (!Number.isInteger(j)) return `${what} names no journal position`;
  const e = events.get(j);
  if (!e)
    return `${what} names journal event ${j}, which the journal does not hold`;
  if (e.producer !== producer || e.kind !== kind)
    return `${what} names journal event ${j}, a ${e.producer}.${e.kind}, not a ${producer}.${kind}`;
  for (const [k, v] of Object.entries(match ?? {}))
    if (JSON.stringify(e.ref?.[k]) !== JSON.stringify(v))
      return `${what} names journal event ${j}, whose ${k} is ${JSON.stringify(e.ref?.[k])}, not ${JSON.stringify(v)}`;
  return null;
}

/** `a` strictly precedes `b` in the journal (both positions). False when either is missing. */
export const before = (a, b) =>
  Number.isInteger(a) && Number.isInteger(b) && a < b;
