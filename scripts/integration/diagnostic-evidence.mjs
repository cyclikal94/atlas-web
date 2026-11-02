// WEB-09c revision 26 (R26-DIAG; design assessment C5): the INDEPENDENT reader of diagnostic evidence. Two records, both re-derived from
// retained bytes, never from a producer's success flag:
//
//   - the ATTEMPT envelope (`web09c-diagnostic-attempt/1`, written by the runner): one fixture attempt's selection, launch, ready receipt,
//     complete stdin/stdout/stderr transcript (a JSON-lines file, re-read and re-hashed here), accounts, the spec's bridge calls and the
//     owned termination. Valid only when every command we sent was answered exactly once, in order, `ok` with its operation's effect;
//     nothing was rejected, lost, partial or unknown; no HTTP admission was refused; the sequenced shutdown was answered by its `stopped`
//     with `served: true`, the owned files removed and no clean-up error; the process exited 0; and the fixture is gone.
//   - the case's causal PROOF (`web09c-diagnostic-proof/2`, written by the spec) for PAIR-X0 (real continuation EXPIRY) or PAIR-X2 (real
//     PRUNING), and their revision-27 variants (PAIR-XR0/XR2: the fenced RECOVERY caller; PAIR-XL0: X0 with named admitted local work and a
//     reload), checked against that transcript (the control answers it names, by sequence number) and the interval's tap records (the
//     browser's gated continuation request and the server's real 410).
//
// Revision 27 (R27-DIAG.a, design assessment C1): the chronology is the attempt's CAUSAL JOURNAL (causal-journal.mjs), never a comparison of
// timestamps. Revision 26 compared the tap's `performance.now()` with the transcript's epoch milliseconds, so a correct real order could
// not pass. Now every ordering claim is between journal POSITIONS of events the runner observed (a tap request's arrival or gate opening, a
// command line written, an acknowledgement read, a bridge marker), each bound to the event it claims to be: the journal is re-read and
// re-hashed, gap-free and of this attempt, and a position that names another event, or none, is refused. Raw timestamps stay in the
// records for diagnosis only. Envelope schema 2 and proof schema 2 carry the positions; a schema-1 record is refused, never upgraded.
//
// A diagnostic 503, an ownership loss, a partial/unknown/unaccounted effect, a missing acknowledgement, an incomplete drain, `served:false`,
// a missing envelope, an injected (TAP) 410, an X1 record relabelled X0/X2, an expired X2 token, a collected X0 attempt, a wrong attempt,
// account, token or floor: each is refused. Historical schema-3 interval validation (pair-evidence.mjs) is unchanged and still required.
import { createHash } from "node:crypto";
import { before, bindingProblem, journalProblems } from "./causal-journal.mjs";
import {
  continuationOf,
  OWNED_FILES,
  parseLine,
  SUCCESS_EFFECT,
} from "./diagnostic-fixture.mjs";

export const ATTEMPT_SCHEMA = "web09c-diagnostic-attempt/2";
export const PROOF_SCHEMA = "web09c-diagnostic-proof/2";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Key-order-independent equality of JSON values. */
const canonical = (v) =>
  JSON.stringify(v ?? null, (_k, x) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
const same = (a, b) => canonical(a) === canonical(b);

/** The transcript file's entries ({n, at, stream, line}), in order; throws on a malformed file. */
export function readTranscript(bytes) {
  return String(bytes)
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * The control exchanges of a transcript: every stdin command with the stdout lines that followed it before the next command. Returns
 * {ready, commands: [{seq, op, args, at, answers: [{event, at}]}], events (stdout lines that answer nothing), stderr, problems}.
 */
export function exchangesOf(entries, attempt) {
  const problems = [];
  const commands = [];
  const stray = [];
  let ready = null;
  let current = null;
  entries.forEach((e, i) => {
    if (e.n !== i + 1)
      problems.push(`transcript entry ${i + 1} is numbered ${e.n}`);
  });
  for (const e of entries) {
    if (e.stream === "stderr") continue;
    let value;
    try {
      value = parseLine(e.line);
    } catch {
      problems.push(`transcript entry ${e.n} (${e.stream}) is not JSON`);
      continue;
    }
    if (e.stream === "stdin") {
      if (value?.attempt !== attempt)
        problems.push(`command ${e.n} names attempt ${value?.attempt}`);
      current = {
        seq: value?.seq,
        op: value?.op,
        args: value?.args,
        at: e.at,
        j: e.j,
        n: e.n,
        answers: [],
      };
      commands.push(current);
    } else if (e.stream === "stdout") {
      if (ready === null && commands.length === 0 && stray.length === 0) {
        ready = { event: value, at: e.at, j: e.j, n: e.n };
        continue;
      }
      if (current)
        current.answers.push({ event: value, at: e.at, j: e.j, n: e.n });
      else stray.push({ event: value, at: e.at, j: e.j, n: e.n });
    } else problems.push(`transcript entry ${e.n} has stream ${e.stream}`);
  }
  return {
    ready,
    commands,
    stray,
    stderr: entries.filter((e) => e.stream === "stderr"),
    problems,
  };
}

/**
 * The journal of an attempt, re-read from its retained file and bound to the envelope: `{problems, events}`. The envelope's `journal`
 * names the file, its hash and event count, and the runner's state of it (complete: nothing over the bound, no failed write).
 */
export function attemptJournal(envelope, readFile) {
  const record = envelope?.journal;
  const problems = [];
  if (!record || typeof record !== "object")
    return {
      problems: ["the attempt names no causal journal"],
      events: new Map(),
    };
  if (record.complete !== true || record.overflowed !== false)
    problems.push(
      `the causal journal is incomplete (overflowed ${record.overflowed}, ${record.write_errors?.length ?? "unknown"} write errors)`,
    );
  if ((record.write_errors ?? ["missing"]).length > 0)
    problems.push("a causal journal line could not be written");
  let bytes = null;
  try {
    bytes = readFile(record.file);
  } catch (error) {
    problems.push(
      `the causal journal cannot be re-read: ${error?.message ?? error}`,
    );
  }
  const read = journalProblems(bytes, {
    attempt: envelope.attempt,
    sha256: record.sha256,
    events: record.events,
  });
  return { problems: [...problems, ...read.problems], events: read.events };
}

/** Every transcript entry is the journal event of its own line: control.<stream> with the same `n`, positions increasing with `n`. */
function transcriptBindingProblems(entries, events) {
  const problems = [];
  let previous = 0;
  for (const e of entries) {
    const p = bindingProblem(
      events,
      e.j,
      "control",
      e.stream,
      { n: e.n },
      `transcript entry ${e.n}`,
    );
    if (p) problems.push(p);
    else if (!(e.j > previous))
      problems.push(`transcript entry ${e.n} is out of the journal's order`);
    if (Number.isInteger(e.j)) previous = e.j;
  }
  return problems;
}

/**
 * The attempt envelope's problems (none: a complete, owned, gracefully ended attempt). `readFile(path)` reads a retained file (bytes) or
 * throws. `expected`: { selectionIdentity, executableSha256, apiVersion, features, retentionSeconds, publicOrigin? }.
 *
 * `stage` (revision 27, DA-DIAG-F): `terminal` (the default) is the whole attempt, ended by its sequenced shutdown; `preliminary` is the
 * attempt BEFORE the shutdown is asked (the runner's decision whether the fixture may be removed): everything up to now must already be
 * valid, and no shutdown, exit or removal may be claimed yet.
 */
export function attemptProblems(
  envelope,
  { readFile, expected, stage = "terminal" },
) {
  const problems = [];
  const bad = (p) => problems.push(p);
  const terminal = stage === "terminal";
  if (!["terminal", "preliminary"].includes(stage))
    return [`unknown validation stage ${stage}`];
  if (envelope === null || typeof envelope !== "object")
    return ["the attempt envelope is not an object"];
  if (envelope.schema !== ATTEMPT_SCHEMA)
    bad(
      `schema ${JSON.stringify(envelope.schema)}, expected ${ATTEMPT_SCHEMA} (an older envelope is refused, never upgraded)`,
    );
  if (envelope.selection_identity !== expected.selectionIdentity)
    bad("the attempt does not name the approved diagnostic selection");
  if (envelope.executable?.sha256 !== expected.executableSha256)
    bad("the staged executable is not the approved one");
  if ((envelope.ready_problems ?? ["missing"]).length > 0)
    bad(
      `the ready receipt was refused at launch: ${(envelope.ready_problems ?? ["missing"]).join("; ")}`,
    );
  if (envelope.latched !== null)
    bad(`the attempt latched: ${JSON.stringify(envelope.latched)}`);
  if (
    (envelope.env_keys ?? []).some((k) => String(k).startsWith("ATLAS_")) ||
    !Array.isArray(envelope.env_keys)
  )
    bad("the child environment is not recorded, or held an ATLAS_ variable");
  const journal = attemptJournal(envelope, readFile);
  problems.push(...journal.problems);
  let bytes = null;
  try {
    bytes = readFile(envelope.transcript?.file);
  } catch (error) {
    bad(`the transcript cannot be re-read: ${error?.message ?? error}`);
  }
  if (bytes === null) return problems;
  if (sha256(bytes) !== envelope.transcript?.sha256)
    bad("the transcript's bytes are not the ones the envelope names");
  let entries;
  try {
    entries = readTranscript(bytes);
  } catch {
    return [...problems, "the transcript is not JSON lines"];
  }
  problems.push(...transcriptBindingProblems(entries, journal.events));
  const x = exchangesOf(entries, envelope.attempt);
  problems.push(...x.problems);
  // The ready receipt, re-checked from the transcript's own line.
  const receipt = x.ready?.event?.receipt;
  if (x.ready?.event?.event !== "ready" || !receipt)
    bad("the transcript does not open with the ready event");
  else {
    if (receipt.attempt !== envelope.attempt)
      bad(`the receipt names attempt ${receipt.attempt}`);
    if (receipt.executable?.sha256 !== expected.executableSha256)
      bad("the receipt's executable hash is not the approved one");
    if (!same(receipt.features, expected.features))
      bad(`the receipt's features ${JSON.stringify(receipt.features)}`);
    if (receipt.api_version !== expected.apiVersion)
      bad(`the receipt's api_version ${receipt.api_version}`);
    if (receipt.retention_seconds !== expected.retentionSeconds)
      bad(`the receipt's retention ${receipt.retention_seconds}`);
    if (
      expected.publicOrigin &&
      receipt.public_origin !== expected.publicOrigin
    )
      bad(`the receipt's public origin ${receipt.public_origin}`);
    if (x.ready.event.receipt_sha256 !== envelope.ready?.receipt_sha256)
      bad("the envelope's receipt hash is not the transcript's");
    try {
      const copy = readFile(envelope.ready?.receipt_file);
      if (sha256(copy) !== x.ready.event.receipt_sha256)
        bad("the retained receipt.json copy is not the ready receipt");
    } catch {
      bad("the retained receipt.json copy cannot be re-read");
    }
  }
  if (x.stray.length > 0)
    bad(
      `stdout lines that answer no command: ${x.stray.map((s) => s.n).join(",")}`,
    );
  // Every command: the next sequence number, answered exactly once, `ok`, with its operation's effect.
  x.commands.forEach((c, i) => {
    if (c.seq !== i + 1)
      bad(`command ${c.n} has seq ${c.seq}, expected ${i + 1}`);
    const last = i === x.commands.length - 1;
    if (c.op === "shutdown") {
      if (!terminal) bad(`shutdown #${c.seq} before the removal decision`);
      if (!last) bad(`shutdown #${c.seq} is not the last command`);
      if (c.args?.remove !== true) bad("the shutdown did not ask for removal");
      const [only, ...more] = c.answers;
      if (more.length > 0 || !only)
        bad(`shutdown #${c.seq} has ${c.answers.length} answers`);
      const s = only?.event;
      if (
        s?.event !== "stopped" ||
        s.seq !== c.seq ||
        s.attempt !== envelope.attempt
      )
        bad(`shutdown #${c.seq} was not answered by its stopped event`);
      else {
        if (s.served !== true)
          bad(
            "stopped with served:false (the server did not drain gracefully)",
          );
        if (s.cleanup_error !== null && s.cleanup_error !== undefined)
          bad(`clean-up error: ${s.cleanup_error}`);
        const removed = Array.isArray(s.removed) ? s.removed : [];
        for (const name of ["fixture.sqlite", "receipt.json"])
          if (!removed.includes(name)) bad(`stopped did not remove ${name}`);
        for (const name of removed)
          if (!OWNED_FILES.includes(name))
            bad(`stopped removed ${name}, which the fixture does not own`);
      }
      return;
    }
    if (!(c.op in SUCCESS_EFFECT))
      bad(`command #${c.seq} has an unknown operation ${c.op}`);
    const [only, ...more] = c.answers;
    if (!only || more.length > 0) {
      bad(`#${c.seq} ${c.op} has ${c.answers.length} answers`);
      return;
    }
    const a = only.event;
    if (a?.seq !== c.seq || a?.op !== c.op || a?.attempt !== envelope.attempt)
      bad(`#${c.seq} ${c.op} was answered by another line`);
    if (a?.ok !== true)
      bad(`#${c.seq} ${c.op} failed: ${a?.error} (effect ${a?.effect})`);
    if (a?.ownership_lost) bad(`#${c.seq} ${c.op}: ownership lost`);
    if (a?.effect !== SUCCESS_EFFECT[c.op])
      bad(
        `#${c.seq} ${c.op} effect ${a?.effect}, expected ${SUCCESS_EFFECT[c.op]}`,
      );
    if (a?.partial !== undefined)
      bad(`#${c.seq} ${c.op} reports a partial state`);
  });
  if (terminal && x.commands.at(-1)?.op !== "shutdown")
    bad("the attempt was not ended by its sequenced shutdown");
  // Setup commands precede the first clock or collection command (the executable enforces it; the evidence must agree).
  const firstTimed = x.commands.findIndex(
    (c) => c.op === "advance_clock" || c.op === "collect",
  );
  if (firstTimed >= 0)
    for (const c of x.commands.slice(firstTimed + 1))
      if (c.op === "add_account" || c.op === "age_history")
        bad(`#${c.seq} ${c.op} after setup ended`);
  for (const e of x.stderr)
    if (e.line.includes('"diagnostic_http"') && e.line.includes('"refused"'))
      bad(`a refused HTTP admission (stderr ${e.n})`);
  // Accounts: each was the answer of its own add_account.
  for (const [name, account] of Object.entries(envelope.accounts ?? {})) {
    const c = x.commands.find((k) => k.seq === account.seq);
    if (
      c?.op !== "add_account" ||
      c.args?.username !== name ||
      c.answers[0]?.event?.result?.account !== account.account_id
    )
      bad(`account ${name} is not the answer of add_account #${account.seq}`);
  }
  // The spec's bridge calls: each a successful command of the transcript, with the same operation, bracketing it in the journal.
  for (const call of envelope.spec_calls ?? []) {
    if (call.outcome !== "ok")
      bad(
        `the spec's ${call.op} call ended ${call.outcome}: ${call.error ?? ""}`,
      );
    const c = x.commands.find((k) => k.seq === call.seq);
    if (!c || c.op !== call.op) {
      bad(
        `the spec's ${call.op} call names #${call.seq}, which the transcript does not hold`,
      );
      continue;
    }
    for (const p of [
      bindingProblem(
        journal.events,
        call.j_request,
        "bridge",
        "call",
        { op: call.op },
        `the ${call.op} call`,
      ),
      bindingProblem(
        journal.events,
        call.j_answer,
        "bridge",
        "answer",
        { op: call.op, seq: call.seq, outcome: "ok" },
        `the ${call.op} answer`,
      ),
    ])
      if (p) bad(p);
    if (
      !(
        before(call.j_request, c.j) &&
        before(c.j, c.answers[0]?.j) &&
        before(c.answers[0]?.j, call.j_answer)
      )
    )
      bad(
        `the spec's ${call.op} call does not bracket command #${call.seq} and its acknowledgement in the journal`,
      );
  }
  const bridged = new Set((envelope.spec_calls ?? []).map((c) => c.seq));
  for (const c of x.commands)
    if (!["add_account", "shutdown"].includes(c.op) && !bridged.has(c.seq))
      bad(`#${c.seq} ${c.op} is not one of the spec's recorded calls`);
  // The spec's markers: each the journal's bridge.mark of that name.
  for (const m of envelope.spec_marks ?? []) {
    const p = bindingProblem(
      journal.events,
      m.j,
      "bridge",
      "mark",
      { name: m.name },
      `marker ${m.name}`,
    );
    if (p) bad(p);
  }
  if (terminal) {
    if (envelope.exit?.code !== 0 || envelope.exit?.signal !== null)
      bad(`the executable exited ${JSON.stringify(envelope.exit)}`);
    if (envelope.fixture_after?.leaf_exists !== false)
      bad("the fixture directory still exists after the shutdown");
  } else if (envelope.shutdown !== null && envelope.shutdown !== undefined)
    bad("a preliminary attempt already records a shutdown");
  return problems;
}

// ---- the causal proofs --------------------------------------------------------------------------------------------------------------
/** A control the proof names by sequence number: its command, its answer and both journal positions. */
const answerOf = (x, seq) => {
  const c = x.commands.find((k) => k.seq === seq);
  return c
    ? {
        command: c,
        answer: c.answers[0]?.event ?? null,
        ack: c.answers[0]?.j ?? null,
        sent: c.j ?? null,
      }
    : null;
};
const batchKey = (b) => `${b.account}@${b.revision}`;
const durable = (state) => ({
  revision_clock: state?.revision_clock,
  accounts: state?.accounts,
  batches: state?.batches,
  receipts_sha256: state?.receipts_sha256,
  resources_sha256: state?.resources_sha256,
  sessions: state?.sessions,
});

/**
 * The proof's context: the journal (re-read by the caller and passed as `journal`, or empty), each tap exchange's journal positions bound to
 * the events they claim, and the named markers (`proof.marks[name]`, each a bridge.mark of `<case-prefix>:<name>`).
 */
function contextOf(proof, { journal, requests, interval }, bad) {
  const events = journal ?? new Map();
  // Revision 28 (R28-DIAG.b, DA28-OBS): the runner gives the interval; its observed reader account is the proof's reader.
  if (
    interval !== undefined &&
    (typeof proof.reader_account !== "string" ||
      proof.reader_account !== interval?.reader_account)
  )
    bad(
      "the proof's reader is not the account the interval's recovery observed",
    );
  if (events.size === 0)
    bad("no causal journal was given to the proof's reader");
  for (const r of requests ?? []) {
    const p = [
      bindingProblem(
        events,
        r.j_request,
        "tap",
        "request",
        { seq: r.seq },
        `exchange ${r.seq}'s arrival`,
      ),
      r.j_gate_open === undefined
        ? null
        : bindingProblem(
            events,
            r.j_gate_open,
            "tap",
            "gate_open",
            { seq: r.seq },
            `exchange ${r.seq}'s gate opening`,
          ),
      r.j_upstream_end === undefined
        ? null
        : bindingProblem(
            events,
            r.j_upstream_end,
            "tap",
            "upstream_end",
            { seq: r.seq, status: r.status },
            `exchange ${r.seq}'s upstream end`,
          ),
    ];
    for (const x of p) if (x) bad(x);
    if (r.gated === true && r.j_gate_open === undefined && r.status !== null)
      bad(
        `exchange ${r.seq} was gated but answered without a recorded gate opening`,
      );
  }
  const mark = (name) => {
    const m = proof.marks?.[name];
    const p = bindingProblem(
      events,
      m,
      "bridge",
      "mark",
      { name: `${proof.mark_prefix}:${name}` },
      `marker ${name}`,
    );
    if (p) bad(p);
    return p ? null : m;
  };
  return { events, mark };
}
/** When an exchange went to the backend: its gate opening if it waited at the gate, else its arrival. Null: never forwarded. */
const forwardedAt = (r) =>
  r.gated === true ? (r.j_gate_open ?? null) : (r.j_request ?? null);
/** A labelled probe the spec bracketed with two acknowledged markers (`<label>:begin`, `<label>:end`). */
function probeMarks(probe, ctx, what, bad) {
  const begin = ctx.mark(`${probe?.label}:begin`);
  const end = ctx.mark(`${probe?.label}:end`);
  if (begin === null || end === null || !before(begin, end)) {
    bad(`${what} is not bracketed by its own two markers`);
    return null;
  }
  return { begin, end };
}

/**
 * The browser's gated continuation request, answered by the SERVER's real 410 (never a tap alteration). Shared by every causal case.
 * `control`: the command the gate waited for (queued before it was written, forwarded after its acknowledgement). Returns the refused
 * exchange, its token and header (or null).
 */
function gatedRefusalProblems(
  proof,
  requests,
  control,
  bad,
  { queuedBy = control } = {},
) {
  const staged = requests.find((r) => r.seq === proof.staged?.tap_seq);
  const refused = requests.find((r) => r.seq === proof.refused?.tap_seq);
  if (!staged)
    bad(
      `the staged piece ${proof.staged?.tap_seq} is not an exchange of the interval`,
    );
  if (!refused) {
    bad(
      `the refused request ${proof.refused?.tap_seq} is not an exchange of the interval`,
    );
    return null;
  }
  const token = refused.query?.cursor ?? null;
  const header = continuationOf(token);
  if (!header) bad("the refused request did not carry a continuation");
  if (sha256(String(token)) !== proof.continuation?.token_sha256)
    bad("the refused request's continuation is not the proof's");
  if (!same(header, proof.continuation?.header))
    bad("the proof's continuation header is not the token's own");
  if (staged) {
    if (staged.status !== 200 || staged.delivered)
      bad("the staged piece is not the server's unaltered 200");
    if (staged.next_cursor !== token)
      bad(
        "the refused request does not ask from the staged piece's continuation",
      );
    if (staged.segment?.last !== false || staged.has_more !== true)
      bad("the staged piece is not a non-final piece");
    if (
      header &&
      (staged.revision !== header.revision ||
        staged.segment?.index + 1 !== header.index)
    )
      bad("the continuation is not the staged piece's next one");
    if (
      staged.seq >= refused.seq ||
      !before(staged.j_request, refused.j_request)
    )
      bad("the staged piece does not precede the refusal");
  }
  if (refused.gated !== true)
    bad("the refused request was not held at the request gate");
  if (refused.status !== 410 || refused.code !== "resync_required")
    bad(
      `the refusal is ${refused.status} ${refused.code}, not the server's 410 resync_required`,
    );
  if (refused.delivered !== undefined)
    bad(
      "the 410 was altered by the tap (an injected answer is not a real expiry or pruning)",
    );
  if (queuedBy && !before(refused.j_request, queuedBy.sent))
    bad(
      "the continuation request was not queued at the gate before the control command",
    );
  if (!before(control.ack, refused.j_gate_open))
    bad(
      "the continuation request was forwarded before the control command's acknowledgement",
    );
  if (!before(refused.j_gate_open, refused.j_upstream_end))
    bad("the refusal's upstream end does not follow its gate opening");
  if (proof.hand_off_seq !== refused.seq)
    bad("the interval did not hand off at the real 410");
  return { refused, token, header };
}

/**
 * PAIR-X0: the continuation EXPIRED. The issued token's expiry E is the receipt's sync start + retention; the clock moved only forward to
 * E−1 (where the same token, same session, was still accepted) and then to E, with the browser's request queued at the gate in between;
 * the server's real 410 followed; nothing was ever collected or aged; the durable state (floors, history, receipts, resources, sessions)
 * did not change across either clock step or with the refusal; the session stayed live (wall time); E+1 is refused too.
 *
 * PAIR-XR0 (revision 27): the same schedule for the fenced RECOVERY caller (its catch-up's continuation; the caller evidence is checked by
 * `callerProblems`). PAIR-XL0: the same expiry with named admitted local work and a RELOAD after E: the request that was queued before the
 * clock steps reached the departed page (`proof.lost`), and the reloaded page's own request with the same stored continuation, queued after
 * the reload began, is the refusal the interval hands off at (`localWorkProblems`).
 */
export function x0Problems(proof, ctx) {
  const problems = [];
  const bad = (p) => problems.push(p);
  const cases = ["PAIR-X0", "PAIR-XR0", "PAIR-XL0"];
  if (proof?.schema !== PROOF_SCHEMA || !cases.includes(proof.case))
    return [`not an X0 proof: ${proof?.schema} ${proof?.case}`];
  const { attempt, entries, requests, readFile } = ctx;
  if (proof.attempt !== attempt.attempt) bad("the proof names another attempt");
  if (proof.mark_prefix !== proof.case.toLowerCase().replace("pair-", ""))
    bad("the proof's markers are not named for its case");
  const j = contextOf(proof, ctx, bad);
  const x = exchangesOf(entries, attempt.attempt);
  const receipt = x.ready?.event?.receipt;
  if (x.commands.some((c) => c.op === "collect" || c.op === "age_history"))
    bad(
      "an X0 attempt collected or aged history: the expiry cause is confounded",
    );
  const step = (name) => answerOf(x, proof.controls?.[name]);
  const minus = step("advance_e_minus_1");
  const atE = step("advance_e");
  const plus = step("advance_e_plus_1");
  const beforeSteps = step("inspect_before");
  const afterE = step("inspect_after_e");
  const atRefusal = step("inspect_at_refusal");
  for (const [name, s, op] of [
    ["advance_e_minus_1", minus, "advance_clock"],
    ["advance_e", atE, "advance_clock"],
    ["advance_e_plus_1", plus, "advance_clock"],
    ["inspect_before", beforeSteps, "inspect"],
    ["inspect_after_e", afterE, "inspect"],
    ["inspect_at_refusal", atRefusal, "inspect"],
  ])
    if (s?.command.op !== op || s?.answer?.ok !== true)
      bad(`control ${name} is not a successful ${op}`);
  if (problems.length > 0) return problems;
  const expiry = proof.continuation?.header?.expiry;
  if (expiry !== receipt.sync_start + receipt.retention_seconds)
    bad(`the token's expiry ${expiry} is not the sync start + retention`);
  if (
    minus.answer.result?.to !== expiry - 1 ||
    minus.answer.result?.from !== receipt.sync_start
  )
    bad("the first clock step is not start → E−1");
  if (
    atE.answer.result?.from !== expiry - 1 ||
    atE.answer.result?.to !== expiry
  )
    bad("the second clock step is not E−1 → E");
  if (
    plus.answer.result?.from !== expiry ||
    plus.answer.result?.to !== expiry + 1
  )
    bad("the third clock step is not E → E+1");
  if (
    !(
      before(beforeSteps.ack, minus.sent) &&
      before(minus.ack, atE.sent) &&
      before(atE.ack, afterE.sent)
    )
  )
    bad("the inspections do not bracket the clock steps");
  // The request the gate held across the clock steps: for X0/XR0 the refusal itself; for XL0 the one the departed page had queued.
  let g;
  if (proof.case === "PAIR-XL0") {
    g = gatedRefusalProblems(proof, requests, atE, bad, { queuedBy: null });
    const lost = requests.find((r) => r.seq === proof.lost?.tap_seq);
    if (!lost)
      bad(
        `the lost request ${proof.lost?.tap_seq} is not an exchange of the interval`,
      );
    else {
      if (lost.gated !== true || !before(lost.j_request, minus.sent))
        bad(
          "the departed page's continuation was not queued at the gate before the clock steps",
        );
      if (lost.query?.cursor !== g?.token)
        bad("the departed page's request does not carry the same continuation");
      if (
        lost.status !== 410 ||
        lost.code !== "resync_required" ||
        lost.delivered !== undefined
      )
        bad(
          "the departed page's request was not refused by the server's own 410",
        );
      if (!before(atE.ack, lost.j_gate_open))
        bad(
          "the departed page's request was forwarded before the clock reached E",
        );
      if (!(lost.seq < (g?.refused.seq ?? 0)))
        bad("the departed page's request does not precede the refusal");
    }
  } else g = gatedRefusalProblems(proof, requests, minus, bad);
  if (g && !before(atE.ack, g.refused.j_gate_open))
    bad("the continuation was forwarded before the clock reached E");
  if (g && !before(g.refused.j_upstream_end, atRefusal.sent))
    bad("the refusal inspection does not follow the refusal");
  // Durable state: unchanged by the clock steps and by the refusal (the refused transaction rolled back): no collection, no ageing.
  if (!same(durable(beforeSteps.answer.result), durable(afterE.answer.result)))
    bad("the durable state changed across the clock steps");
  for (const k of [
    "revision_clock",
    "accounts",
    "batches",
    "receipts_sha256",
    "resources_sha256",
  ])
    if (!same(beforeSteps.answer.result?.[k], atRefusal.answer.result?.[k]))
      bad(`${k} changed by the time of the refusal`);
  if (
    beforeSteps.answer.result?.truncated ||
    atRefusal.answer.result?.truncated
  )
    bad("an inspection was truncated");
  const reader = proof.reader_account;
  const floor = atRefusal.answer.result?.accounts?.find(
    (a) => a.id === reader,
  )?.sync_floor;
  if (!(Number.isInteger(floor) && g?.header && floor <= g.header.boundary))
    bad(
      "the reader's floor is not at or below the continuation's boundary (pruning would confound expiry)",
    );
  if (
    !atRefusal.answer.result?.batches?.some(
      (b) => b.account === reader && b.revision === g?.header?.revision,
    )
  )
    bad(
      "the continuation's revision is no longer stored (pruning would confound expiry)",
    );
  // The same token, same session, accepted at E−1 (direct, labelled control probe; its bytes retained), bracketed by markers.
  const probe = proof.probes?.e_minus_1;
  if (probe?.status !== 200)
    bad(`the same continuation at E−1 was answered ${probe?.status}, not 200`);
  else {
    try {
      const body = readFile(probe.body_file);
      if (sha256(body) !== probe.body_sha256)
        bad("the E−1 probe's body is not the retained bytes");
      const page = JSON.parse(String(body));
      if (
        page.batches?.[0]?.segment?.index !== g?.header?.index ||
        page.batches?.[0]?.revision !== g?.header?.revision
      )
        bad("the E−1 probe was not answered with the continuation's own piece");
    } catch (error) {
      bad(`the E−1 probe's body: ${error?.message ?? error}`);
    }
    if (
      probe.token_sha256 !== proof.continuation?.token_sha256 ||
      probe.session !== "browser"
    )
      bad("the E−1 probe is not the same token on the browser's session");
    const m = probeMarks(probe, j, "the E−1 probe", bad);
    if (m && !(before(minus.ack, m.begin) && before(m.end, atE.sent)))
      bad("the E−1 probe is not between the two clock steps");
  }
  const live = proof.probes?.session_after_e;
  const liveMarks = live ? probeMarks(live, j, "the session probe", bad) : null;
  if (live?.status !== 200 || !(liveMarks && before(atE.ack, liveMarks.begin)))
    bad("the session was not shown live after the clock reached E");
  const late = proof.probes?.e_plus_1;
  const lateMarks = late ? probeMarks(late, j, "the E+1 probe", bad) : null;
  if (
    late?.status !== 410 ||
    late?.code !== "resync_required" ||
    !(lateMarks && before(plus.ack, lateMarks.begin)) ||
    late.token_sha256 !== proof.continuation?.token_sha256
  )
    bad("the same continuation at E+1 was not refused 410 resync_required");
  if (proof.case === "PAIR-XR0")
    problems.push(...callerProblems(proof, ctx, j));
  else if (proof.caller !== "ordinary")
    bad(`an ordinary-caller proof names the caller ${proof.caller}`);
  if (proof.case === "PAIR-XL0")
    problems.push(
      ...localWorkProblems(proof, { ...ctx, atE, beforeSteps, g }, j),
    );
  else if (proof.local_work !== undefined && proof.local_work !== null)
    bad("a zero-local-work case carries local work");
  return problems;
}

/**
 * PAIR-X2: the continuation's revision was PRUNED. With the request gate closed and drained BEFORE the grant, the reader's target batch
 * (account, revision, payload digest) was aged in setup before any of it was requested; the browser staged a prefix; with its next
 * continuation queued at the gate, the REAL collector ran at the sync start (no clock step), removing exactly that batch and raising the
 * reader's floor past the continuation's boundary, while the token was unexpired; the untouched control account's floor, history and
 * continuation were unaffected; sessions, devices, receipts, resources and the revision clock were unchanged; the server's real 410 followed.
 * PAIR-XR2 (revision 27): the same for the fenced RECOVERY caller.
 */
export function x2Problems(proof, ctx) {
  const problems = [];
  const bad = (p) => problems.push(p);
  if (
    proof?.schema !== PROOF_SCHEMA ||
    !["PAIR-X2", "PAIR-XR2"].includes(proof.case)
  )
    return [`not an X2 proof: ${proof?.schema} ${proof?.case}`];
  const { attempt, entries, requests, readFile } = ctx;
  if (proof.attempt !== attempt.attempt) bad("the proof names another attempt");
  if (proof.mark_prefix !== proof.case.toLowerCase().replace("pair-", ""))
    bad("the proof's markers are not named for its case");
  const j = contextOf(proof, ctx, bad);
  const x = exchangesOf(entries, attempt.attempt);
  const receipt = x.ready?.event?.receipt;
  if (x.commands.some((c) => c.op === "advance_clock"))
    bad("an X2 attempt moved the clock: expiry would confound pruning");
  const step = (name) => answerOf(x, proof.controls?.[name]);
  const ageInspect = step("inspect_before_ageing");
  const aged = step("age_history");
  const collected = step("collect");
  const atRefusal = step("inspect_at_refusal");
  for (const [name, s, op] of [
    ["inspect_before_ageing", ageInspect, "inspect"],
    ["age_history", aged, "age_history"],
    ["collect", collected, "collect"],
    ["inspect_at_refusal", atRefusal, "inspect"],
  ])
    if (s?.command.op !== op || s?.answer?.ok !== true)
      bad(`control ${name} is not a successful ${op}`);
  if (problems.length > 0) return problems;
  const {
    account: reader,
    revision,
    payload_sha256: digest,
  } = proof.target ?? {};
  const earliest = receipt.sync_start - receipt.retention_seconds;
  // The ageing: exactly the target batch, pinned by its digest, back-dated to the earliest the collector's cutoff needs.
  const declared = aged.command.args?.batches ?? [];
  if (
    !same(declared, [
      {
        account: reader,
        revision,
        payload_sha256: digest,
        created_at: earliest,
      },
    ])
  )
    bad(
      "age_history did not age exactly the target batch to sync start − retention",
    );
  const stored = ageInspect.answer.result?.batches?.find(
    (b) => b.account === reader && b.revision === revision,
  );
  if (stored?.payload_sha256 !== digest)
    bad("the aged batch's digest is not the stored target batch's");
  if (!before(ageInspect.ack, aged.sent))
    bad("the target batch was not inspected before ageing");
  // The gate was closed and DRAINED before the grant, and the grant preceded the ageing (markers of the spec, positions of the runner).
  const drained = j.mark("drain_complete");
  const grantBegin = j.mark("grant_begin");
  const grantEnd = j.mark("grant_end");
  if (
    !(
      before(drained, grantBegin) &&
      before(grantBegin, grantEnd) &&
      before(grantEnd, aged.sent)
    )
  )
    bad(
      "the gate was not closed and drained before the grant, or the grant did not precede the ageing",
    );
  for (const r of requests) {
    const forwarded = forwardedAt(r);
    // Nothing reached the backend between the drain and the ageing's acknowledgement (the gate held every /sync).
    if (
      forwarded !== null &&
      before(drained, r.j_request) &&
      !before(aged.ack, forwarded)
    )
      bad(
        `exchange ${r.seq} reached the backend between the drain and the ageing`,
      );
    // Nothing of the target was forwarded before the ageing was acknowledged.
    const carries =
      r.revision === revision ||
      r.last_revision === revision ||
      continuationOf(r.query?.cursor)?.revision === revision;
    if (carries && forwarded !== null && !before(aged.ack, forwarded))
      bad(
        `exchange ${r.seq} carried the target before the ageing was acknowledged`,
      );
  }
  // The collection: the real collector at the sync start, removing exactly the target batch, raising the reader's floor to it.
  const c = collected.answer.result;
  if (
    collected.command.args?.time !== receipt.sync_start ||
    c?.time !== receipt.sync_start
  )
    bad("the collection did not run at the sync start");
  if (collected.answer.sync_now !== receipt.sync_start)
    bad("the clock is not at the sync start at collection");
  if (
    !same((c?.removed_batches ?? []).map(batchKey), [`${reader}@${revision}`])
  )
    bad(
      `the collector removed ${JSON.stringify((c?.removed_batches ?? []).map(batchKey))}, not exactly the target batch`,
    );
  const floorOf = (state, id) =>
    state?.accounts?.find((a) => a.id === id)?.sync_floor;
  if (floorOf(c?.after, reader) !== revision)
    bad(
      `the reader's floor after collection is ${floorOf(c?.after, reader)}, not ${revision}`,
    );
  if (!(floorOf(c?.before, reader) < revision))
    bad("the reader's floor was already at the target before collection");
  for (const k of [
    "revision_clock",
    "receipts_sha256",
    "resources_sha256",
    "sessions",
    "devices",
  ])
    if (!same(c?.before?.[k], c?.after?.[k]))
      bad(`${k} changed in the collection`);
  if (c?.before?.truncated || c?.after?.truncated)
    bad("a collection state was truncated");
  const g = gatedRefusalProblems(proof, requests, collected, bad);
  if (g?.header) {
    if (!(g.header.boundary < revision))
      bad("the continuation's boundary is not below the pruned revision");
    if (!(g.header.expiry > collected.answer.sync_now))
      bad("the continuation had expired: expiry would confound pruning");
    if (g.header.revision !== revision)
      bad("the continuation is not of the pruned revision");
  }
  if (g && !before(g.refused.j_upstream_end, atRefusal.sent))
    bad("the refusal inspection does not follow the refusal");
  if (floorOf(atRefusal.answer.result, reader) !== revision)
    bad("the reader's floor at the refusal is not the pruned revision");
  // The untouched control account: its floor and history unchanged, its own live continuation still answered after the collection.
  const control = proof.control_account ?? {};
  if (
    floorOf(c?.before, control.account) !==
      floorOf(c?.after, control.account) ||
    floorOf(c?.after, control.account) === undefined
  )
    bad("the control account's floor changed (or is absent)");
  const keep = (s) =>
    (s?.batches ?? [])
      .filter((b) => b.account === control.account)
      .map((b) => [b.revision, b.created_at, b.payload_sha256]);
  if (
    !same(keep(c?.before), keep(c?.after)) ||
    !keep(c?.after).some(([r]) => r === control.revision)
  )
    bad("the control account's history changed");
  const probe = control.probe_after;
  const probed = probe ? probeMarks(probe, j, "the control probe", bad) : null;
  if (probe?.status !== 200 || !(probed && before(collected.ack, probed.begin)))
    bad(
      "the control account's continuation was not answered 200 after the collection",
    );
  else if (
    probe.token_sha256 !== control.continuation_sha256 ||
    probe.session !== "control"
  )
    bad("the control probe is not the control account's continuation");
  else {
    try {
      const body = readFile(probe.body_file);
      if (sha256(body) !== probe.body_sha256)
        bad("the control probe's body is not the retained bytes");
      const page = JSON.parse(String(body));
      if (
        page.batches?.[0]?.revision !== control.revision ||
        page.batches?.[0]?.segment?.index !== control.continuation_header?.index
      )
        bad(
          "the control probe was not answered with its continuation's own piece",
        );
    } catch (error) {
      bad(`the control probe's body: ${error?.message ?? error}`);
    }
  }
  if (!(control.continuation_header?.expiry > collected.answer.sync_now))
    bad("the control continuation was not live at the collection");
  if (control.account === reader) bad("the control account is the reader");
  if (proof.case === "PAIR-XR2")
    problems.push(...callerProblems(proof, ctx, j));
  else if (proof.caller !== "ordinary")
    bad(`an ordinary-caller proof names the caller ${proof.caller}`);
  if (proof.local_work !== undefined && proof.local_work !== null)
    bad("a zero-local-work case carries local work");
  return problems;
}

/**
 * The fenced RECOVERY caller (PAIR-XR0/XR2, revision 27; design assessment C3): the page's session was revoked and the real 401 recorded as
 * a fence BEFORE the hold was armed again and before the grant; the password sign-in began after the grant; every request the page issued
 * from the fence until the recovery finished was of the recovery class (the page's own trace, a count-ordered window from the fence: no
 * clock is compared), at least one was, and the recovery finished by clearing the fence. W24's state at the hand-off is the interval's
 * `recovery_invalidated` observation (pair-evidence.mjs), checked there with the caller the matrix names.
 */
function callerProblems(proof, ctx, j) {
  const problems = [];
  const bad = (p) => problems.push(p);
  if (proof.caller !== "recovery")
    bad(`a recovery-caller proof names the caller ${proof.caller}`);
  const fenced = j.mark("fence_recorded");
  const rearmed = j.mark("hold_rearmed");
  const grantEnd = j.mark("grant_end");
  const signIn = j.mark("sign_in_begin");
  if (
    !(
      before(fenced, rearmed) &&
      before(rearmed, grantEnd) &&
      before(grantEnd, signIn)
    )
  )
    bad(
      "the fence, the re-armed hold, the grant and the sign-in are not in that order",
    );
  const window = proof.caller_evidence?.trace_window;
  if (!Array.isArray(window) || window.length === 0)
    bad("the recovery caller's trace window is not recorded");
  else {
    const cleared = window.findIndex(
      (e) =>
        e?.event === "data.recovery_finish" && e?.data?.result === "cleared",
    );
    if (cleared < 0) bad("the recovery did not finish by clearing the fence");
    const issued = window
      .slice(0, cleared < 0 ? window.length : cleared)
      .filter((e) => e?.event === "request.issued");
    if (!issued.some((e) => e?.data?.klass === "recovery"))
      bad("no recovery-class request was issued while fenced");
    if (issued.some((e) => e?.data?.klass === "ordinary"))
      bad("an ordinary request was issued while fenced");
  }
  if (proof.caller_evidence?.sign_in !== "settled")
    bad(`the sign-in ended ${proof.caller_evidence?.sign_in}`);
  // The refusal belongs to the catch-up the RE-ARMED hold drove: it was requested after the sign-in began.
  const refused = (ctx.requests ?? []).find(
    (r) => r.seq === proof.refused?.tap_seq,
  );
  if (refused && !before(signIn, refused.j_request))
    bad(
      "the refused continuation was not requested by the recovery caller (after the sign-in began)",
    );
  return problems;
}

/**
 * PAIR-XL0 (revision 27; design assessment C4): the named admitted LOCAL WORK across the expiry, the reload and the recovery. One real
 * command through the production outbox (its local id is the Idempotency-Key), sent exactly once, receipted at a revision AFTER the staged
 * revision and BEFORE the clock steps (so the durable baseline the expiry is judged on already includes it); the reload began after E was
 * acknowledged and before the gate opened; at every barrier BEFORE the recovery's exposure the same draft, command digest, key, receipt and
 * pending effect stand (never retired by an older staged word, never reconciled while the cache is invalid or hidden); at the exposure
 * they stand or are settled together (ordinary W23 reconciles in the activation; a reconciliation owed to W26 is settled after display);
 * once the account is displayed they are settled, the cache holds the resource exactly once and the exposure is at or after the receipt.
 */
function localWorkProblems(proof, ctx, j) {
  const problems = [];
  const bad = (p) => problems.push(p);
  const w = proof.local_work;
  if (!w || typeof w !== "object")
    return ["the local-work case records no local work"];
  for (const k of ["local_id", "resource_id", "command_sha256"])
    if (typeof w[k] !== "string" || w[k].length === 0)
      bad(`local work names no ${k}`);
  const sent = Array.isArray(w.sent) ? w.sent : [];
  if (sent.length !== 1)
    bad(
      `the local command was sent ${sent.length} times (exactly once is required)`,
    );
  else {
    if (sent[0].idempotency_key !== w.local_id)
      bad(
        "the local command was not sent with its local id as the Idempotency-Key",
      );
    if (
      typeof sent[0].body_sha256 !== "string" ||
      sent[0].body_sha256.length !== 64
    )
      bad("the local command's sent body is not hashed");
    if (sent[0].status !== 200)
      bad(`the local command was answered ${sent[0].status}`);
  }
  const staged = (ctx.requests ?? []).find(
    (r) => r.seq === proof.staged?.tap_seq,
  );
  if (
    !(
      Number.isInteger(w.receipt_revision) &&
      staged &&
      w.receipt_revision > staged.revision
    )
  )
    bad("the local work's receipt is not at a revision after the staged one");
  const admitted = j.mark("receipt_admitted");
  if (!before(admitted, ctx.beforeSteps?.sent))
    bad(
      "the local work's receipt was not admitted before the durable baseline of the clock steps",
    );
  const reloadBegin = j.mark("reload_begin");
  const reloadEnd = j.mark("reload_end");
  if (!(before(ctx.atE?.ack, reloadBegin) && before(reloadBegin, reloadEnd)))
    bad("the reload did not begin after E was acknowledged");
  const refused = ctx.g?.refused;
  if (
    refused &&
    !(
      before(reloadBegin, refused.j_request) &&
      before(reloadEnd, refused.j_gate_open)
    )
  )
    bad(
      "the refusal is not the reloaded page's own request, forwarded after the reload",
    );
  // The barrier table: the same identities until the activation, settled after it. Revision 28: `recovery_activated` is revision 27's
  // `recovery_exposed` (the data activation); `recovery_rendered` is the moment both pages show the recovered cache.
  const order = [
    "receipt_admitted",
    "after_reload",
    "recovery_invalidated",
    "recovery_staged_hidden",
    "recovery_final_held",
    "recovery_activated",
    "recovery_rendered",
    "settled",
  ];
  const table = w.barriers ?? {};
  for (const name of order)
    if (!table[name]) bad(`local work is not observed at ${name}`);
  const settledAt = (b) =>
    b && b.draft === null && (b.effects ?? []).length === 0;
  const standing = (b) =>
    b &&
    b.draft?.local_id === w.local_id &&
    b.draft?.command_digest === w.command_sha256 &&
    b.draft?.receipt_revision === w.receipt_revision &&
    b.effects?.length === 1 &&
    b.effects[0].local_id === w.local_id &&
    b.effects[0].resource_id === w.resource_id &&
    b.effects[0].receipt_revision === w.receipt_revision;
  for (const name of order.slice(0, 5))
    if (table[name] && !standing(table[name]))
      bad(
        `local work at ${name} is not the same admitted draft and pending effect`,
      );
  for (const name of ["recovery_activated", "recovery_rendered"]) {
    const b = table[name];
    if (b && !standing(b) && !settledAt(b))
      bad(
        `local work at ${name} is neither standing nor settled (a partial reconciliation)`,
      );
  }
  for (const name of ["recovery_activated", "recovery_rendered", "settled"]) {
    const b = table[name];
    if (!b) continue;
    if (b.resource_in_cache !== 1)
      bad(
        `the cache holds the local resource ${b.resource_in_cache} times at ${name}`,
      );
    if (
      !(
        Number.isInteger(b.applied_revision) &&
        b.applied_revision >= w.receipt_revision
      )
    )
      bad(`${name} is not at or after the local work's receipt`);
  }
  if (table.settled && !settledAt(table.settled))
    bad("the local work was not settled once the account was displayed");
  for (const name of [
    "recovery_invalidated",
    "recovery_staged_hidden",
    "recovery_final_held",
  ])
    if (table[name] && table[name].resource_in_cache !== 0)
      bad(
        `the local resource is in the live cache at ${name} (the old cache never held it)`,
      );
  return problems;
}

/**
 * Revision 33 (R33-DIAG): the exchanges a SAVED interval gives its causal proof's reader — every exchange of its window, the sync answers
 * (`requests`) and every other exchange (`other_requests`, whose compact projection keeps its journal references), exactly as the runner
 * reads the record back. The reader binds each one's arrival to its own journal event, so none may be left out.
 */
export function proofExchanges(interval) {
  return [...(interval?.requests ?? []), ...(interval?.other_requests ?? [])];
}

export const PROOF_VALIDATORS = Object.freeze({
  "PAIR-X0": x0Problems,
  "PAIR-XR0": x0Problems,
  "PAIR-XL0": x0Problems,
  "PAIR-X2": x2Problems,
  "PAIR-XR2": x2Problems,
});
