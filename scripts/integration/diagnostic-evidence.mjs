// WEB-09c revision 26 (R26-DIAG; design assessment C5): the INDEPENDENT reader of diagnostic evidence. Two records, both re-derived from
// retained bytes, never from a producer's success flag:
//
//   - the ATTEMPT envelope (`web09c-diagnostic-attempt/1`, written by the runner): one fixture attempt's selection, launch, ready receipt,
//     complete stdin/stdout/stderr transcript (a JSON-lines file, re-read and re-hashed here), accounts, the spec's bridge calls and the
//     owned termination. Valid only when every command we sent was answered exactly once, in order, `ok` with its operation's effect;
//     nothing was rejected, lost, partial or unknown; no HTTP admission was refused; the sequenced shutdown was answered by its `stopped`
//     with `served: true`, the owned files removed and no clean-up error; the process exited 0; and the fixture is gone.
//   - the case's causal PROOF (`web09c-diagnostic-proof/1`, written by the spec) for PAIR-X0 (real continuation EXPIRY) or PAIR-X2 (real
//     PRUNING), checked against that transcript (the control answers it names, by sequence number) and the interval's tap records (the
//     browser's gated continuation request and the server's real 410). The chronology uses one clock: the runner process hosts both the
//     tap and the control transcript.
//
// A diagnostic 503, an ownership loss, a partial/unknown/unaccounted effect, a missing acknowledgement, an incomplete drain, `served:false`,
// a missing envelope, an injected (TAP) 410, an X1 record relabelled X0/X2, an expired X2 token, a collected X0 attempt, a wrong attempt,
// account, token or floor: each is refused. Historical schema-3 interval validation (pair-evidence.mjs) is unchanged and still required.
import { createHash } from "node:crypto";
import {
  continuationOf,
  OWNED_FILES,
  parseLine,
  SUCCESS_EFFECT,
} from "./diagnostic-fixture.mjs";

export const ATTEMPT_SCHEMA = "web09c-diagnostic-attempt/1";
export const PROOF_SCHEMA = "web09c-diagnostic-proof/1";
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
        n: e.n,
        answers: [],
      };
      commands.push(current);
    } else if (e.stream === "stdout") {
      if (ready === null && commands.length === 0 && stray.length === 0) {
        ready = { event: value, at: e.at, n: e.n };
        continue;
      }
      if (current) current.answers.push({ event: value, at: e.at, n: e.n });
      else stray.push({ event: value, at: e.at, n: e.n });
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
 * The attempt envelope's problems (none: a complete, owned, gracefully ended attempt). `readFile(path)` reads a retained file (bytes) or
 * throws. `expected`: { selectionIdentity, executableSha256, apiVersion, features, retentionSeconds, publicOrigin? }.
 */
export function attemptProblems(envelope, { readFile, expected }) {
  const problems = [];
  const bad = (p) => problems.push(p);
  if (envelope === null || typeof envelope !== "object")
    return ["the attempt envelope is not an object"];
  if (envelope.schema !== ATTEMPT_SCHEMA)
    bad(
      `schema ${JSON.stringify(envelope.schema)}, expected ${ATTEMPT_SCHEMA}`,
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
  if (x.commands.at(-1)?.op !== "shutdown")
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
  // The spec's bridge calls: each a successful command of the transcript, with the same operation.
  for (const call of envelope.spec_calls ?? []) {
    if (call.outcome !== "ok")
      bad(
        `the spec's ${call.op} call ended ${call.outcome}: ${call.error ?? ""}`,
      );
    const c = x.commands.find((k) => k.seq === call.seq);
    if (!c || c.op !== call.op)
      bad(
        `the spec's ${call.op} call names #${call.seq}, which the transcript does not hold`,
      );
  }
  const bridged = new Set((envelope.spec_calls ?? []).map((c) => c.seq));
  for (const c of x.commands)
    if (!["add_account", "shutdown"].includes(c.op) && !bridged.has(c.seq))
      bad(`#${c.seq} ${c.op} is not one of the spec's recorded calls`);
  if (envelope.exit?.code !== 0 || envelope.exit?.signal !== null)
    bad(`the executable exited ${JSON.stringify(envelope.exit)}`);
  if (envelope.fixture_after?.leaf_exists !== false)
    bad("the fixture directory still exists after the shutdown");
  return problems;
}

// ---- the causal proofs --------------------------------------------------------------------------------------------------------------
const answerOf = (x, seq) => {
  const c = x.commands.find((k) => k.seq === seq);
  return c
    ? {
        command: c,
        answer: c.answers[0]?.event ?? null,
        at: c.answers[0]?.at ?? null,
        sentAt: c.at,
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

/** The browser's gated continuation request, answered by the SERVER's real 410 (never a tap alteration). Shared by X0 and X2. */
function gatedRefusalProblems(proof, requests, control, bad) {
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
    if (staged.seq >= refused.seq)
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
  if (!(refused.t_request < control.sentAt))
    bad(
      "the continuation request was not queued at the gate before the control command",
    );
  if (!(refused.t_gate_open > control.at))
    bad(
      "the continuation request was forwarded before the control command's acknowledgement",
    );
  if (proof.hand_off_seq !== refused.seq)
    bad("the interval did not hand off at the real 410");
  return { refused, token, header };
}

/**
 * PAIR-X0: the continuation EXPIRED. The issued token's expiry E is the receipt's sync start + retention; the clock moved only forward to
 * E−1 (where the same token, same session, was still accepted) and then to E, with the browser's request queued at the gate in between;
 * the server's real 410 followed; nothing was ever collected or aged; the durable state (floors, history, receipts, resources, sessions)
 * did not change across either clock step or with the refusal; the session stayed live (wall time); E+1 is refused too.
 */
export function x0Problems(proof, { attempt, entries, requests, readFile }) {
  const problems = [];
  const bad = (p) => problems.push(p);
  if (proof?.schema !== PROOF_SCHEMA || proof.case !== "PAIR-X0")
    return [`not an X0 proof: ${proof?.schema} ${proof?.case}`];
  if (proof.attempt !== attempt.attempt) bad("the proof names another attempt");
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
  const before = step("inspect_before");
  const afterE = step("inspect_after_e");
  const atRefusal = step("inspect_at_refusal");
  for (const [name, s, op] of [
    ["advance_e_minus_1", minus, "advance_clock"],
    ["advance_e", atE, "advance_clock"],
    ["advance_e_plus_1", plus, "advance_clock"],
    ["inspect_before", before, "inspect"],
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
      before.at < minus.sentAt &&
      minus.at < afterE.sentAt &&
      atE.at < afterE.sentAt
    )
  )
    bad("the inspections do not bracket the clock steps");
  const g = gatedRefusalProblems(proof, requests, minus, bad);
  if (g && !(g.refused.t_gate_open > atE.at))
    bad("the continuation was forwarded before the clock reached E");
  if (g && !(atRefusal.sentAt > g.refused.t_upstream_end))
    bad("the refusal inspection does not follow the refusal");
  // Durable state: unchanged by the clock steps and by the refusal (the refused transaction rolled back): no collection, no ageing.
  if (!same(durable(before.answer.result), durable(afterE.answer.result)))
    bad("the durable state changed across the clock steps");
  for (const k of [
    "revision_clock",
    "accounts",
    "batches",
    "receipts_sha256",
    "resources_sha256",
  ])
    if (!same(before.answer.result?.[k], atRefusal.answer.result?.[k]))
      bad(`${k} changed by the time of the refusal`);
  if (before.answer.result?.truncated || atRefusal.answer.result?.truncated)
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
  // The same token, same session, accepted at E−1 (direct, labelled control probe; its bytes retained).
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
    if (!(probe.at_sent > minus.at && probe.at_answered < atE.sentAt))
      bad("the E−1 probe is not between the two clock steps");
  }
  const live = proof.probes?.session_after_e;
  if (live?.status !== 200 || !(live.at_sent > atE.at))
    bad("the session was not shown live after the clock reached E");
  const late = proof.probes?.e_plus_1;
  if (
    late?.status !== 410 ||
    late?.code !== "resync_required" ||
    !(late.at_sent > plus.at) ||
    late.token_sha256 !== proof.continuation?.token_sha256
  )
    bad("the same continuation at E+1 was not refused 410 resync_required");
  return problems;
}

/**
 * PAIR-X2: the continuation's revision was PRUNED. With the request gate closed and drained BEFORE the grant, the reader's target batch
 * (account, revision, payload digest) was aged in setup before any of it was requested; the browser staged a prefix; with its next
 * continuation queued at the gate, the REAL collector ran at the sync start (no clock step), removing exactly that batch and raising the
 * reader's floor past the continuation's boundary, while the token was unexpired; the untouched control account's floor, history and
 * continuation were unaffected; sessions, devices, receipts, resources and the revision clock were unchanged; the server's real 410 followed.
 */
export function x2Problems(proof, { attempt, entries, requests, readFile }) {
  const problems = [];
  const bad = (p) => problems.push(p);
  if (proof?.schema !== PROOF_SCHEMA || proof.case !== "PAIR-X2")
    return [`not an X2 proof: ${proof?.schema} ${proof?.case}`];
  if (proof.attempt !== attempt.attempt) bad("the proof names another attempt");
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
  if (!(ageInspect.at < aged.sentAt))
    bad("the target batch was not inspected before ageing");
  // Nothing of the target was requested before the ageing was acknowledged (the gate was closed and drained before the grant).
  for (const r of requests) {
    const forwarded = r.t_gate_open ?? r.t_request;
    const carries =
      r.revision === revision ||
      r.last_revision === revision ||
      continuationOf(r.query?.cursor)?.revision === revision;
    if (carries && !(forwarded > aged.at))
      bad(
        `exchange ${r.seq} carried the target before the ageing was acknowledged`,
      );
  }
  if (
    !(
      Number.isInteger(proof.drained_before_grant_at) &&
      proof.drained_before_grant_at < (proof.grant_at ?? 0) &&
      proof.grant_at < aged.sentAt
    )
  )
    bad(
      "the gate was not closed and drained before the grant, or the grant did not precede the ageing",
    );
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
  if (g && !(atRefusal.sentAt > g.refused.t_upstream_end))
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
  if (probe?.status !== 200 || !(probe.at_sent > collected.at))
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
  return problems;
}

export const PROOF_VALIDATORS = Object.freeze({
  "PAIR-X0": x0Problems,
  "PAIR-X2": x2Problems,
});
