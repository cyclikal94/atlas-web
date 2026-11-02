// WEB-09c (R23-PAIR, invariant I7): what ONE paired interval record must hold before it can be evidence. The spec writes the record and
// validates it BEFORE asserting anything else; the runner validates every record again after the run, and checks it is the record of the
// case, engine, backend and selection it is filed under. A record that fails here is not a measurement and not a pass, whatever the
// browser did.
//
// One interval = one case in one engine, from the pre-grant barrier to the terminal state. It binds:
//   - COLLECTION: the tap's sequence window (since, until] of the interval; every tap exchange in it is listed exactly once (sync answers
//     in `requests`, all others in `other_requests`), none was lost from the tap's bounded log, no body write failed or is pending, nothing
//     is unsettled;
//   - every sync EXCHANGE: exact upstream body bytes AND any altered (TAP-INJECTED) body's bytes, each re-read, hash- and length-checked,
//     and re-parsed, so the metadata the checks below use is the bytes' own (a recorded cursor, segment or revision that differs from the
//     bytes is refused); the proxy log entry it came through (`proxy_id`) and that entry's DOWNSTREAM outcome; for a driven answer, the
//     case's ATTEMPT (`received`, `lost`, `dropped`) and what it did. Only an answer that reached a live client gives the chain a cursor;
//   - the spec's barriers, in its own clock, in order: pre_grant_complete, grant_complete, [piece_persisted… target_activated…],
//     final_released (fully driven cases), activation_complete;
//   - the TERMINAL: the applied revision, the included answer that activated it (`activated_by_seq`: a final piece of that revision, or a
//     whole/snapshot page ending in it) and the feed's completion (`final_seq`: has_more false), both answers that reached the client;
//     final_released (driven) names that completion, delivered; a recovery shows a 410 the client was answered before its activation;
//   - the independent content oracle's verdict;
//   - memory: either real samples of a named kind, or null WITH a reason. A zero or an empty sample list is never a bound.
// Schema 3 (revision 25: R24-PAIR.c and DA-PAIR-E) closes the record over what it ADVERTISES, derived and cross-checked, never taken from a
// count the producer reports:
//   - the TARGET: the workload's revisions, each with its source (the writer's receipt, the synthetic transaction, A1's revocation), bound
//     to grant_complete, to every received delta answer carrying batches (no other revision) and to the terminal revision;
//   - how it was DRIVEN (`full`, `prefix` up to an explicit `hand_off`, `none`), which the runner also checks against the matrix row: every
//     exchange up to the drive's end is an attempt; the top-level attempts and each exchange's join are the same attempts, with the role
//     the server's bytes give them; every driven attempt's answer was HELD by the proxy; every held answer is an attempt or a recorded
//     release of the hold (`hold_releases`); the window starts at the OPENING's label;
//   - the persistence witnesses: EXACTLY one per received staged piece that has a later held request, observed at that next request;
//   - one durable `target_activated` per activating attempt, in increasing target revisions; a fully driven record activates the last
//     milestone, and its terminal is that activation;
//   - the case's REQUIRED observations (T1's follower at the actual last piece, and after the activation), bound to those exchanges and to
//     the old and activated cache digests.
// A schema-1 or schema-2 record is refused, never upgraded or re-annotated.
// Revision 27 (R27-DIAG.b; design assessment C2/C3, additive to schema 3, so every earlier record keeps its meaning): the drive mode
// `rearmed_prefix` (the recovery caller's hold, armed again before the grant: `rearm`) and the RECOVERY observations every real-410
// diagnostic case must bind at held snapshot pages: `recovery_invalidated` (the refusal processed: cache hidden, cursor and both stagings
// abandoned, a new generation; W24's snapshot restart and the job's notice for the recovery caller), `recovery_staged_hidden` (snapshot rows
// staged while the live cache is untouched and hidden), `recovery_final_held` (the last snapshot page held, still hidden), and
// `recovery_exposed` (one atomic exposure of the complete cache, nothing staged), each made by the LEADER and an independent FOLLOWER page
// reading its own connection. The caller and the local-work declaration are the matrix row's (`identityProblems`).
// Revision 28 (R28-DIAG.b; design assessment C2-C5): the stored cache status is never evidence of what a page shows. Every recovery
// observation must carry the observation contract `web09c-recovery-observation/2` (an earlier one, such as revision 27's, is INCOMPLETE and
// refused, never upgraded): each reader's separate RENDERING (session view, protected root, visible refreshing placeholders, attachment, a
// per-document identity) and its fences, complete, for the same account and documents throughout. Hidden and shown are judged here from
// the rendering alone, written independently of the live observer (pair-recovery.mjs). `recovery_exposed` is renamed `recovery_activated`
// (the DATA activation), `recovery_final_held` carries BOTH readers at every held snapshot page, and `recovery_rendered` binds the moment
// both pages show the recovered cache (for the recovery caller, with the fence cleared).
// Revision 29 (R29-DIAG): every complete sample of every recovery observation (and every held page) satisfies the fence implication — a
// standing fence means the neutral covered surface — and each `recovery_activated` sample is hidden while waiting or shown unfenced. The
// observer's settlement polls are not persisted: this reader can judge every RECORDED sample, never the discarded polls between them.
import { createHash } from "node:crypto";
import {
  activates,
  outcomeOf,
  reachedClient,
  seenOf,
  terminalOf,
} from "./pair-attempts.mjs";
import { describeSync } from "./pair-tap.mjs";

export const SCHEMA = "web09c-pair-interval/3";
const RANK = {
  pre_grant_complete: 0,
  grant_complete: 1,
  piece_persisted: 2,
  target_activated: 2,
  final_released: 3,
  activation_complete: 4,
};
const NAMES = Object.keys(RANK);
/** The metadata the tap derives from a body's bytes (describeSync) and records beside it: each must be the bytes' own. */
const DESCRIBED = [
  "phase",
  "batches",
  "changes",
  "revision",
  "last_revision",
  "segment",
  "has_more",
  "next_cursor",
  "code",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isText = (v) => typeof v === "string" && v.length > 0;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Returns the problems of `record` (empty: valid). `readBody(file)` reads a body file of the tap (bytes) or throws. It is REQUIRED: a
 * record whose bodies cannot be re-read is not evidence.
 */
export function validateInterval(record, { readBody } = {}) {
  const problems = [];
  const bad = (p) => problems.push(p);
  if (record === null || typeof record !== "object")
    return ["the record is not an object"];
  if (typeof readBody !== "function")
    bad("no body reader: every upstream and altered body must be re-read");
  if (record.schema !== SCHEMA)
    bad(`schema ${JSON.stringify(record.schema)}, expected ${SCHEMA}`);
  for (const key of ["interval", "case", "engine", "backend"])
    if (!isText(record[key])) bad(`${key} is missing`);
  if (
    (record.backend === "development" || record.backend === "diagnostic") &&
    !isText(record.selection_manifest_sha256)
  )
    bad(`a ${record.backend} interval names no selection manifest hash`);
  if (!["ordinary", "recovery", "none", undefined].includes(record.caller))
    bad(`unknown caller ${record.caller}`);
  if (!["W-real", "W-synthetic", null].includes(record.workload ?? null))
    bad(`unknown workload ${record.workload}`);
  if (record.workload === "W-synthetic" && record.synthetic !== true)
    bad("a W-synthetic interval is not labelled synthetic");

  // A body descriptor (upstream or altered): its bytes re-read, checked and re-described.
  const verify = (where, d) => {
    if (
      !isText(d?.sha256) ||
      !Number.isInteger(d?.bytes) ||
      !isText(d?.body_file)
    ) {
      bad(`${where}: no body hash, length or file`);
      return;
    }
    if (typeof readBody !== "function") return;
    let bytes = null;
    try {
      bytes = readBody(d.body_file);
    } catch (error) {
      bad(
        `${where}: body file unreadable: ${String(error?.message ?? error).split("\n")[0]}`,
      );
      return;
    }
    if (bytes.length !== d.bytes)
      bad(`${where}: body is ${bytes.length} bytes, recorded ${d.bytes}`);
    if (sha256(bytes) !== d.sha256) {
      bad(`${where}: body hash differs from the record`);
      return;
    }
    const own = describeSync(Buffer.from(bytes));
    for (const key of DESCRIBED)
      if (key in d && !same(d[key], own[key]))
        bad(`${where}: recorded ${key} is not the body's own`);
    for (const key of ["segment", "has_more", "next_cursor", "revision"])
      if (!(key in d) && own[key] !== null)
        bad(`${where}: the body's ${key} is not recorded`);
  };

  // Collection: the tap's window of this interval, complete.
  const c = record.collection;
  const requests = Array.isArray(record.requests) ? record.requests : null;
  const others = Array.isArray(record.other_requests)
    ? record.other_requests
    : [];
  if (
    !c ||
    !Number.isInteger(c.since) ||
    !Number.isInteger(c.until) ||
    c.until < c.since
  )
    bad("the collection window (since, until) is not recorded");
  else {
    if (!(Number.isInteger(c.dropped_through) && c.dropped_through <= c.since))
      bad(
        `the tap's bounded log lost records of this interval (dropped through ${c.dropped_through}, interval after ${c.since})`,
      );
    if (!Array.isArray(c.write_errors) || c.write_errors.length > 0)
      bad(
        `body writes failed: ${JSON.stringify(c.write_errors ?? "not recorded")}`,
      );
    if (c.pending_writes !== 0)
      bad(`${c.pending_writes} body writes were still pending`);
    if (!Array.isArray(c.unsettled) || c.unsettled.length > 0)
      bad(
        `exchanges still open when the interval ended: ${JSON.stringify(c.unsettled ?? "not recorded")}`,
      );
    const seqs = [...(requests ?? []), ...others].map((r) => r?.seq);
    const unique = new Set(seqs);
    if (unique.size !== seqs.length)
      bad("an exchange is listed more than once");
    for (const s of unique)
      if (!(Number.isInteger(s) && s > c.since && s <= c.until))
        bad(`exchange ${s} is outside the interval (${c.since}, ${c.until}]`);
    if (unique.size !== c.until - c.since)
      bad(
        `${c.until - c.since} tap exchanges in the interval, ${unique.size} recorded`,
      );
  }
  for (const [i, r] of others.entries()) {
    if (r?.label !== record.interval)
      bad(
        `other_requests[${i}]: labelled ${JSON.stringify(r?.label)}, not this interval`,
      );
    if (
      (r?.status === null || r?.status === undefined) &&
      !isText(r?.upstream_error)
    )
      bad(`other_requests[${i}]: no status (the exchange did not complete)`);
  }

  // The tap's sync exchanges, their bodies, their downstream outcomes and the chain the client could follow.
  const bySeq = new Map();
  if (!requests || requests.length === 0)
    bad("no exchange is bound to the interval");
  else {
    let last = 0;
    const known = new Set([record.pre_grant_cursor]);
    const proxyIds = new Set();
    for (const [i, r] of requests.entries()) {
      const where = `requests[${i}]`;
      if (!(Number.isInteger(r.seq) && r.seq > last))
        bad(`${where}: sequence ${r.seq} is not after ${last}`);
      last = Number.isInteger(r.seq) ? r.seq : last;
      bySeq.set(r.seq, r);
      if (r.label !== record.interval)
        bad(`${where}: labelled ${JSON.stringify(r.label)}, not this interval`);
      if (!Number.isInteger(r.proxy_id) || proxyIds.has(r.proxy_id))
        bad(`${where}: no unique proxy correlation id`);
      proxyIds.add(r.proxy_id);
      if (!isText(r.downstream?.outcome))
        bad(`${where}: no downstream outcome`);
      if (r.status === null || r.status === undefined) {
        bad(`${where}: no status (the exchange did not complete)`);
        continue;
      }
      verify(`${where} upstream`, r);
      if (r.delivered) {
        if (
          !isText(r.delivered.injected) ||
          !Number.isInteger(r.delivered.status)
        )
          bad(
            `${where}: an altered answer is not labelled as injected with its status`,
          );
        verify(`${where} delivered`, r.delivered);
      }
      if (r.dropped !== undefined && (!isText(r.dropped) || r.delivered))
        bad(`${where}: a dropped answer is not labelled, or also delivered`);
      if (isText(r.dropped) && r.downstream?.outcome === "delivered")
        bad(`${where}: a dropped answer is recorded as delivered downstream`);
      const client = r.attempt?.client;
      if (r.attempt !== undefined) {
        if (!["received", "lost", "dropped"].includes(client))
          bad(`${where}: attempt ${JSON.stringify(client)}`);
        if (client === "received" && r.downstream?.outcome !== "delivered")
          bad(
            `${where}: received by the client, but the proxy recorded ${r.downstream?.outcome}`,
          );
        if (client === "dropped" && !isText(r.dropped))
          bad(`${where}: an attempt recorded as dropped the tap did not drop`);
      }
      // Chain: every request's cursor is the pre-grant cursor or a cursor an earlier answer of this interval gave the CLIENT.
      const cursor = r.query?.cursor ?? null;
      if (!known.has(cursor))
        bad(`${where}: cursor not delivered earlier in this interval`);
      if (!reachedClient(r)) continue;
      const s = seenOf(r);
      if (s.status === 200 && isText(s.next_cursor)) known.add(s.next_cursor);
      // A 410 sends the client to a fresh snapshot, which starts without a cursor.
      if (s.status === 410) known.add(null);
    }
    const injected = requests.filter((r) => r.delivered || r.dropped).length;
    if (injected > 0 && record.unaltered !== false)
      bad(
        "injected answers are present but the interval claims to be unaltered",
      );
    if (
      injected === 0 &&
      record.unaltered !== true &&
      !isText(record.injected_outside_tap)
    )
      bad(
        "no injected answer recorded, yet the interval does not say it is unaltered or name the injection",
      );
  }

  // The workload: named independently of the feed (the writer's receipt, the synthetic transaction, a later milestone), never by an answer.
  const target = record.target;
  const revisions = Array.isArray(target?.revisions) ? target.revisions : [];
  if (
    revisions.length === 0 ||
    !revisions.every(
      (v, i) =>
        Number.isInteger(v) && v > 0 && (i === 0 || v > revisions[i - 1]),
    )
  )
    bad("the target names no increasing positive revisions");
  if (target?.through !== (revisions.at(-1) ?? null))
    bad("the target's through revision is not its last milestone");
  if (
    !Array.isArray(target?.sources) ||
    target.sources.length !== revisions.length ||
    !target.sources.every(
      (x, i) => x?.revision === revisions[i] && isText(x?.source),
    )
  )
    bad("a target revision names no source");
  const inTarget = (v) => revisions.includes(v);
  // The server's own answer to the workload (the upstream bytes, never an injected copy): the role the driver must have given it.
  const roleOf = (r) =>
    r.status !== 200
      ? "other"
      : !(Number.isInteger(r.batches) && r.batches > 0)
        ? "incidental"
        : inTarget(r.revision) && inTarget(r.last_revision)
          ? "target"
          : "unrelated";
  for (const r of requests ?? [])
    if (r.phase === "delta" && roleOf(r) === "unrelated")
      bad(
        `exchange ${r.seq}: revision ${r.revision}..${r.last_revision} is not a target revision`,
      );

  // How the record was driven (the runner checks it against the matrix row), and the attempts, joined both ways.
  const driven = record.driven;
  if (!["full", "prefix", "none", "rearmed_prefix"].includes(driven))
    bad(`driven ${JSON.stringify(driven)}`);
  const partly = driven === "prefix" || driven === "rearmed_prefix";
  const handOff = record.hand_off ?? null;
  if (partly) {
    if (!Number.isInteger(handOff?.at_seq) || !isText(handOff?.reason))
      bad("a partly driven record names no hand-off");
  } else if (handOff !== null)
    bad("only a partly driven record has a hand-off");
  // Revision 27: the re-armed hold of the recovery caller (`rearm.at_seq`: the tap's last sequence number when the new hold was armed).
  const rearm = record.rearm ?? null;
  if (driven === "rearmed_prefix") {
    if (!Number.isInteger(rearm?.at_seq) || !isText(rearm?.reason))
      bad("a re-armed record names no re-arming");
    else if (
      Number.isInteger(handOff?.at_seq) &&
      !(rearm.at_seq < handOff.at_seq)
    )
      bad("the hold was re-armed after the hand-off");
  } else if (rearm !== null) bad("only a re-armed record has a re-arming");
  const attempts = Array.isArray(record.attempts) ? record.attempts : null;
  if (!attempts) bad("the attempts are not recorded");
  const attemptOf = new Map();
  for (const a of attempts ?? []) {
    if (attemptOf.has(a?.seq)) bad(`attempt ${a?.seq} is listed twice`);
    attemptOf.set(a?.seq, a);
    const r = bySeq.get(a?.seq);
    if (!r) {
      bad(`attempt ${a?.seq} names no included exchange`);
      continue;
    }
    if (
      r.attempt?.step !== a.step ||
      r.attempt?.client !== a.client ||
      r.attempt?.effect !== a.effect
    )
      bad(`attempt ${a.seq}: the exchange's join is not the attempt`);
    if (a.proxy_id !== r.proxy_id)
      bad(
        `attempt ${a.seq}: proxy entry ${a.proxy_id}, the exchange's ${r.proxy_id}`,
      );
    if (a.role !== roleOf(r))
      bad(
        `attempt ${a.seq}: role ${a.role}, the server's answer is ${roleOf(r)}`,
      );
    if (a.step !== null) {
      if (!Number.isInteger(a.step) || a.client === "dropped")
        bad(
          `attempt ${a.seq}: a driven attempt (step ${a.step}) recorded as ${a.client}`,
        );
      if (!(r.downstream?.events ?? []).includes("held"))
        bad(`attempt ${a.seq} was driven, but the proxy never held its answer`);
    } else if (a.client !== "dropped")
      bad(
        `attempt ${a.seq}: an attempt the driver never held that the tap did not drop`,
      );
  }
  for (const r of requests ?? [])
    if (r.attempt !== undefined && !attemptOf.has(r.seq))
      bad(`exchange ${r.seq} carries an attempt the record does not list`);
  if (driven === "none" && (attempts?.length ?? 0) > 0)
    bad("an undriven record lists attempts");
  if (partly && attemptOf.get(handOff?.at_seq)?.step == null)
    bad(`the hand-off ${handOff?.at_seq} is not a driven attempt`);
  // Coverage: every exchange up to the drive's end is an attempt; every held answer is an attempt or a recorded release of the hold.
  const releases = Array.isArray(record.hold_releases)
    ? record.hold_releases
    : null;
  if (!releases) bad("the hold's releases are not recorded");
  const releasedIds = new Set((releases ?? []).map((x) => x?.proxy_id));
  const end =
    driven === "full"
      ? record.terminal?.final_seq
      : partly
        ? handOff?.at_seq
        : null;
  const from =
    driven === "rearmed_prefix" && Number.isInteger(rearm?.at_seq)
      ? rearm.at_seq
      : Number.NEGATIVE_INFINITY;
  for (const r of requests ?? []) {
    if (
      Number.isInteger(end) &&
      r.seq <= end &&
      r.seq > from &&
      !attemptOf.has(r.seq)
    )
      bad(`exchange ${r.seq} precedes the end of the drive but is no attempt`);
    if (driven === "rearmed_prefix" && r.seq <= from) {
      // Before the new hold: the fence and its 401; nothing of the workload may have been answered unheld.
      if (attemptOf.has(r.seq))
        bad(`exchange ${r.seq} is an attempt before the hold was re-armed`);
      if (roleOf(r) === "target")
        bad(
          `exchange ${r.seq} carried the target before the hold was re-armed`,
        );
    }
    if (
      (r.downstream?.events ?? []).includes("held") &&
      !attemptOf.has(r.seq) &&
      !releasedIds.has(r.proxy_id)
    )
      bad(
        `exchange ${r.seq} was held, but is neither an attempt nor a recorded release`,
      );
  }
  // The opening: the window starts at the label it set once every earlier /sync had settled.
  const opening = record.opening;
  if (
    !Number.isInteger(opening?.rounds) ||
    opening.rounds < 1 ||
    !Array.isArray(opening?.released)
  )
    bad(
      "the opening (its rounds and what it released before the label) is not recorded",
    );
  else if (c && opening.label_seq !== c.since)
    bad("the window does not start at the opening's label");

  // The barriers, in the spec's clock.
  const barriers = Array.isArray(record.barriers) ? record.barriers : [];
  let rank = -1;
  let at = Number.NEGATIVE_INFINITY;
  for (const [i, b] of barriers.entries()) {
    const r = NAMES.includes(b?.name) ? RANK[b.name] : -1;
    if (r < 0)
      bad(`barriers[${i}]: unknown barrier ${JSON.stringify(b?.name)}`);
    else if (r < rank) bad(`barriers[${i}]: ${b.name} out of order`);
    if (!(typeof b?.at === "number" && b.at >= at))
      bad(`barriers[${i}]: time goes backwards`);
    rank = Math.max(rank, r);
    at = typeof b?.at === "number" ? b.at : at;
  }
  const names = barriers.map((b) => b?.name);
  for (const required of [
    "pre_grant_complete",
    "grant_complete",
    "activation_complete",
  ])
    if (!names.includes(required)) bad(`missing barrier ${required}`);
  const pre = barriers.find((b) => b?.name === "pre_grant_complete");
  if (!isText(pre?.detail?.cache_digest))
    bad("pre_grant_complete names no old cache digest");
  const grant = barriers.find((b) => b?.name === "grant_complete");
  if (grant && grant.detail?.revision !== revisions[0])
    bad("grant_complete does not name the target's first revision");
  // Persistence: per witness, a received non-final piece observed later, at most once; and EXACTLY the witnesses the attempts require.
  const witnessed = new Map();
  for (const b of barriers.filter((x) => x?.name === "piece_persisted")) {
    const applied = bySeq.get(b.detail?.applied_seq);
    const observed = bySeq.get(b.detail?.observed_at_seq);
    if (!applied || !reachedClient(applied))
      bad(
        `piece_persisted names ${b.detail?.applied_seq}: not an included answer the client received`,
      );
    else if (!seenOf(applied).segment || seenOf(applied).segment.last)
      bad(`piece_persisted names ${applied.seq}: not a non-final piece`);
    if (!observed || !(observed.seq > (applied?.seq ?? Infinity)))
      bad(
        `piece_persisted of ${b.detail?.applied_seq} was not observed at a later included request`,
      );
    if (witnessed.has(b.detail?.applied_seq))
      bad(`piece ${b.detail?.applied_seq} is counted as persisted twice`);
    witnessed.set(b.detail?.applied_seq, b.detail?.observed_at_seq);
  }
  const sorted = [...(attempts ?? [])].sort((a, b) => a.seq - b.seq);
  const owed = new Map();
  for (const a of sorted) {
    if (a.client !== "received" || a.effect !== "staged") continue;
    const next = sorted.find((x) => x.seq > a.seq && x.step !== null);
    if (next) owed.set(a.seq, next.seq);
  }
  for (const [applied, observed] of owed)
    if (witnessed.get(applied) !== observed)
      bad(
        `staged piece ${applied} has no persistence witness at the next held request ${observed}`,
      );
  for (const applied of witnessed.keys())
    if (!owed.has(applied))
      bad(
        `piece_persisted names ${applied}: not a received staged piece with a later held request`,
      );
  if (record.pieces_persisted !== owed.size)
    bad(
      `${record.pieces_persisted} pieces persisted recorded, ${owed.size} derived from the attempts`,
    );
  // Activations: one durable witness per activating attempt, in increasing target revisions.
  const activating = sorted.filter(
    (a) => a.client === "received" && a.effect === "activated",
  );
  const witnesses = barriers.filter((b) => b?.name === "target_activated");
  if (witnesses.length !== activating.length)
    bad(
      `${witnesses.length} target_activated barriers, ${activating.length} activating attempts`,
    );
  let previous = Number.NEGATIVE_INFINITY;
  for (const [i, a] of activating.entries()) {
    const r = bySeq.get(a.seq);
    const s = r ? seenOf(r) : null;
    const revision = s?.segment ? s.revision : (s?.last_revision ?? null);
    const w = witnesses[i];
    if (!inTarget(revision))
      bad(
        `attempt ${a.seq} activates revision ${revision}, not a target revision`,
      );
    if (!(revision > previous))
      bad(
        `attempt ${a.seq} activates revision ${revision} again or out of order`,
      );
    previous = revision ?? previous;
    if (
      w?.detail?.activated_by_seq !== a.seq ||
      w?.detail?.revision !== revision ||
      !isText(w?.detail?.cache_digest)
    )
      bad(
        `the activation by ${a.seq} has no durable witness (target_activated)`,
      );
  }
  const throughWitness = witnesses.find(
    (w) => w?.detail?.revision === target?.through,
  );

  // Terminal state, bound to the included answers, the target and the drive, and the independent oracle.
  const t = record.terminal;
  if (!["activated", "recovered"].includes(t?.kind))
    bad(`terminal ${JSON.stringify(t?.kind)}`);
  if (!Number.isInteger(t?.applied_revision))
    bad("the terminal names no applied revision");
  else if (t?.kind === "activated" && t.applied_revision !== target?.through)
    bad(
      `the terminal revision ${t.applied_revision} is not the target's ${target?.through}`,
    );
  else if (t?.kind === "recovered" && !(t.applied_revision >= target?.through))
    bad(
      `the recovered revision ${t.applied_revision} precedes the target's ${target?.through}`,
    );
  const final = bySeq.get(t?.final_seq);
  const by = bySeq.get(t?.activated_by_seq);
  if (!final || !reachedClient(final))
    bad(
      `the feed's completion ${t?.final_seq} is not an included answer the client received`,
    );
  else if (seenOf(final).status !== 200 || seenOf(final).has_more !== false)
    bad(`the feed's completion ${final.seq} is not a 200 with has_more false`);
  if (!by || !reachedClient(by))
    bad(
      `the activating answer ${t?.activated_by_seq} is not an included answer the client received`,
    );
  else if (!activates(by, t?.applied_revision))
    bad(
      `answer ${by.seq} does not activate revision ${t?.applied_revision} (a final piece of it, or a page ending in it)`,
    );
  if (by && final && by.seq > final.seq)
    bad("the activating answer comes after the feed's completion");
  if (driven === "full") {
    if (
      !throughWitness ||
      activating.at(-1)?.seq !== throughWitness.detail?.activated_by_seq
    )
      bad(
        "the drive did not end with the activation of the target's last milestone",
      );
    else if (t?.activated_by_seq !== throughWitness.detail.activated_by_seq)
      bad(
        "the terminal's activating answer is not the drive's activation of the target",
      );
  }
  const activation = barriers.find((b) => b?.name === "activation_complete");
  if (activation && activation.detail?.applied_revision !== t?.applied_revision)
    bad("activation_complete names another revision than the terminal");
  const released = barriers.filter((b) => b?.name === "final_released");
  if (driven === "full") {
    if (released.length !== 1)
      bad(`${released.length} final_released barriers, not one`);
    else if (
      released[0].detail?.seq !== t?.final_seq ||
      released[0].detail?.outcome !== "delivered"
    )
      bad(
        "final_released does not name the feed's completion, delivered to the client",
      );
  } else if (released.length > 0)
    bad("only a fully driven record names final_released");
  if (t?.kind === "recovered") {
    const refused = (requests ?? []).some(
      (r) =>
        reachedClient(r) &&
        seenOf(r).status === 410 &&
        r.seq < (by?.seq ?? Number.NEGATIVE_INFINITY),
    );
    if (!refused)
      bad(
        "a recovered interval shows no 410 the client was answered before its activation",
      );
  }
  if (record.oracle?.verdict !== "match")
    bad(`the content oracle says ${JSON.stringify(record.oracle?.verdict)}`);

  // The case's required observations, bound to the exchanges and cache digests they claim.
  const required = Array.isArray(record.required_observations)
    ? record.required_observations
    : null;
  const observations = Array.isArray(record.observations)
    ? record.observations
    : null;
  if (!required || !observations)
    bad("the observations (required and made) are not recorded");
  for (const kind of required ?? []) {
    const o = (observations ?? []).find((x) => x?.kind === kind);
    if (!o) {
      bad(`the required observation ${kind} is missing`);
      continue;
    }
    if (kind === "follower_old_at_last_piece") {
      if (
        !throughWitness ||
        o.at_seq !== throughWitness.detail?.activated_by_seq ||
        attemptOf.get(o.at_seq)?.step == null
      )
        bad(`${kind} is not made at the target's held last piece`);
      if (o.cache_digest !== pre?.detail?.cache_digest)
        bad(`${kind} does not show the old live cache`);
    } else if (kind === "follower_new_after_activation") {
      if (
        !throughWitness ||
        !(o.at_seq >= throughWitness.detail?.activated_by_seq)
      )
        bad(`${kind} is not made after the target's activation`);
      if (o.cache_digest !== throughWitness?.detail?.cache_digest)
        bad(`${kind} does not show the activated cache`);
    } else if (kind === "reader_old_at_refusal") {
      // Revision 26 (R26-DIAG): while the server's real 410 is HELD, the reader still shows the old live cache and keeps its persisted stage.
      const at = (record.requests ?? []).find((r) => r?.seq === o.at_seq);
      if (
        o.at_seq !== record.hand_off?.at_seq ||
        attemptOf.get(o.at_seq)?.step == null ||
        at?.status !== 410
      )
        bad(`${kind} is not made at the held 410 the interval handed off at`);
      if (o.cache_digest !== pre?.detail?.cache_digest)
        bad(`${kind} does not show the old live cache`);
      if (!(Number.isInteger(o.stage?.next_index) && o.stage.next_index >= 1))
        bad(`${kind} does not show a persisted stage`);
    } else if (RECOVERY_KINDS.includes(kind))
      problems.push(
        ...recoveryObservationProblems(kind, o, {
          record,
          bySeq,
          releasedIds,
          pre,
          handOff,
          terminal: t,
          observations: observations ?? [],
        }),
      );
    else bad(`unknown required observation ${kind}`);
  }

  // Memory: samples of a named kind, or null with a reason.
  const memory = record.memory;
  if (memory === null || memory === undefined || typeof memory !== "object")
    bad("memory is not recorded (samples or a reason)");
  else if (memory.kind === null) {
    if (!isText(memory.reason)) bad("memory unavailable without a reason");
    if (memory.samples !== undefined && memory.samples !== null)
      bad("memory unavailable but samples are present");
  } else {
    if (!isText(memory.kind)) bad("memory kind is not named");
    if (!Array.isArray(memory.samples) || memory.samples.length === 0)
      bad("memory has a kind but no samples");
    else if (!memory.samples.every((s) => Number.isFinite(s) && s > 0))
      bad("memory samples include a zero or non-number");
    if (!isText(memory.scope)) bad("memory does not say what it covers");
  }
  return problems;
}

/**
 * The runner's identity check of one record against where it is filed: its file name, the stack's engine and backend, the approved
 * selection, and the case's matrix row (its workload). Returns the problems (none: it is that case's record).
 */
export function identityProblems(
  record,
  { file, engine, backend, manifest, row },
) {
  const problems = [];
  if (file !== `${record?.case}.${record?.engine}.json`)
    problems.push(
      `${file} holds the record of ${record?.case} in ${record?.engine}`,
    );
  if (record?.engine !== engine)
    problems.push(`engine ${record?.engine}, the stack ran ${engine}`);
  if (record?.backend !== backend)
    problems.push(`backend ${record?.backend}, the stack ran ${backend}`);
  if ((record?.selection_manifest_sha256 ?? null) !== (manifest ?? null))
    problems.push("the selection manifest is not the approved one");
  if (!row) problems.push(`${record?.case} is not a case of the matrix`);
  else {
    if ((record?.workload ?? null) !== row.workload)
      problems.push(
        `workload ${record?.workload}, the matrix says ${row.workload}`,
      );
    // Revision 25: how the record must be driven and what it must observe are the matrix's, never the producer's choice.
    if ((record?.driven ?? null) !== (row.driven ?? null))
      problems.push(`driven ${record?.driven}, the matrix says ${row.driven}`);
    // Revision 27: the caller and the local-work declaration are the matrix's (a recovery case cannot be filed as ordinary, or the reverse).
    if (row.observations?.some((k) => RECOVERY_KINDS.includes(k))) {
      if (record?.caller !== row.caller)
        problems.push(
          `caller ${record?.caller}, the matrix says ${row.caller}`,
        );
      if ((record?.local_work ?? false) !== (row.local_work ?? false))
        problems.push(
          `local work ${record?.local_work ?? false}, the matrix says ${row.local_work ?? false}`,
        );
    }
    if (
      JSON.stringify(record?.required_observations ?? null) !==
      JSON.stringify(row.observations ?? [])
    )
      problems.push(
        `required observations ${JSON.stringify(record?.required_observations)}, the matrix says ${JSON.stringify(row.observations ?? [])}`,
      );
  }
  if (
    typeof record?.interval !== "string" ||
    !record.interval.startsWith(`${record?.case}:${record?.engine}:`)
  )
    problems.push("the interval id does not name its case and engine");
  return problems;
}

/**
 * Each tap exchange joined to its proxy log entry's DOWNSTREAM outcome (by the correlation id) and to the driver's attempt: the join the
 * spec's collection makes (tests/pair/support.ts) and the qualification controls make the same way (pair-driver.test.mjs).
 */
export function joinExchanges(records, proxyEntries, attempts) {
  const byProxy = new Map(proxyEntries.map((e) => [e.id, e]));
  const attemptOf = new Map(attempts.map((a) => [a.seq, a]));
  return records.map((r) => {
    const entry = byProxy.get(r.proxy_id);
    const attempt = attemptOf.get(r.seq);
    return {
      ...r,
      downstream: {
        outcome: outcomeOf(entry),
        events: entry ? entry.events.map((e) => e.event) : null,
      },
      ...(attempt
        ? {
            attempt: {
              step: attempt.step,
              client: attempt.client,
              effect: attempt.effect,
            },
          }
        : {}),
    };
  });
}

/** Counts per response: changes, and how many are the workload person repeated as an ancestor (ancestor overhead). Every attempt counts. */
export function overheadOf(syncs, person, readBody) {
  return syncs
    .filter((r) => r.status === 200 && r.body_file)
    .map((r) => {
      const page = JSON.parse(readBody(r.body_file).toString("utf8"));
      const changes = page.batches.flatMap((b) => b.changes);
      return {
        seq: r.seq,
        client: r.attempt?.client ?? null,
        downstream: r.downstream?.outcome ?? null,
        bytes: r.bytes,
        changes: changes.length,
        person_upserts: changes.filter(
          (c) => c.kind === "upsert" && c.resource?.id === person,
        ).length,
        removals: changes.filter((c) => c.kind === "remove").length,
        server_ms:
          r.t_upstream_end === null || r.t_upstream_end === undefined
            ? null
            : Math.round((r.t_upstream_end - r.t_request) * 1000) / 1000,
      };
    });
}

/**
 * The interval record (schema 3) from its parts: the interval's own observations (`iv`: barriers, attempts, target, drive mode, hand-off,
 * opening, hold releases, observations, traces), the joined exchanges of its window and their collection, and the case's details. The
 * terminal references are the driver's, or else the answers that reached the client (`terminalOf`). Pure: written and validated by the caller.
 */
export function assembleInterval({
  iv,
  records,
  collection,
  details,
  memory,
  readBody,
}) {
  const syncs = records.filter(
    (r) => r.method === "GET" && r.path.endsWith("/sync"),
  );
  const terminalRefs =
    iv.terminal ?? terminalOf(syncs, details.appliedRevision);
  return {
    schema: SCHEMA,
    interval: iv.id,
    case: iv.caseId,
    engine: iv.engine,
    backend: details.backend,
    selection_manifest_sha256: details.selection || null,
    api_version: details.apiVersion,
    workload: details.workload,
    synthetic: details.workload === "W-synthetic",
    pre_grant_cursor: details.preGrantCursor,
    correlation:
      "proxy log entry id (x-atlas-pair-proxy-id), joined to the proxy's downstream outcome",
    target: iv.target,
    driven: details.driven,
    ...(details.caller ? { caller: details.caller } : {}),
    ...(details.localWork !== undefined
      ? { local_work: details.localWork }
      : {}),
    hand_off: iv.handOff ?? null,
    ...(iv.rearm ? { rearm: iv.rearm } : {}),
    // Revision 28: the account the recovery observer was asked to observe (every recovery sample must be of it).
    ...(iv.readerAccount ? { reader_account: iv.readerAccount } : {}),
    opening: iv.opening,
    hold_releases: iv.holdReleases,
    collection,
    requests: syncs,
    other_requests: records
      .filter((r) => !syncs.includes(r))
      .map((r) => ({
        seq: r.seq,
        label: r.label,
        proxy_id: r.proxy_id ?? null,
        method: r.method,
        path: r.path,
        status: r.status,
        ...(r.upstream_error ? { upstream_error: r.upstream_error } : {}),
        downstream: r.downstream,
      })),
    attempts: iv.attempts,
    unaltered:
      syncs.every((r) => !r.delivered && !r.dropped) &&
      details.injectedOutsideTap === undefined,
    ...(details.injectedOutsideTap
      ? { injected_outside_tap: details.injectedOutsideTap }
      : {}),
    barriers: iv.barriers,
    pieces_persisted: iv.piecesPersisted,
    required_observations: details.requiredObservations,
    observations: iv.observations,
    terminal: {
      kind: details.terminal,
      applied_revision: details.appliedRevision,
      final_seq: terminalRefs?.final_seq ?? null,
      activated_by_seq: terminalRefs?.activated_by_seq ?? null,
      source: iv.terminal ? "driver" : "answers that reached the client",
    },
    oracle: details.oracle,
    overhead: overheadOf(syncs, details.person, readBody),
    totals: {
      requests: syncs.length,
      received: syncs.filter((r) => r.downstream?.outcome === "delivered")
        .length,
      bytes: syncs.reduce((n, r) => n + (r.bytes ?? 0), 0),
      max_bytes: Math.max(0, ...syncs.map((r) => r.bytes ?? 0)),
      wall_ms_grant_to_activation:
        (iv.barriers.find((b) => b.name === "activation_complete")?.at ??
          Number.NaN) -
        (iv.barriers.find((b) => b.name === "grant_complete")?.at ??
          Number.NaN),
      wall_resolution:
        "Node polling of raw IndexedDB every 25 ms (an upper bound on the moment, not the commit's own time)",
    },
    browser_traces: iv.traces,
    memory,
    ...(details.extra ? { extra: details.extra } : {}),
  };
}

// ---- revision 27 (R27-DIAG.b): the recovery observations; revision 28 (R28-DIAG.b): their renderings --------------------------------
export const RECOVERY_KINDS = Object.freeze([
  "recovery_invalidated",
  "recovery_staged_hidden",
  "recovery_final_held",
  "recovery_activated",
  "recovery_rendered",
]);
// Revision 29 (C5): /3 — each sample coherent (fences and stored state unchanged across its capture) with its counted re-reads.
export const RECOVERY_OBSERVATION_SCHEMA = "web09c-recovery-observation/3";
/** Why a reader's sample is not a complete observation of its page (the same account `account`); none: it is one. */
function sampleProblems(r, account) {
  const g = r?.rendering;
  const who = r?.reader ?? "a reader";
  if (g?.status !== "observed")
    return [`${who}'s rendering is not observed (${g?.status ?? "missing"})`];
  const p = [];
  if (!isText(g.document)) p.push(`${who} names no document`);
  if (!isText(r.account) || r.account !== account)
    p.push(`${who} is not a sample of the account ${account}`);
  if (g.attachment !== (r.reader === "leader" ? "leader" : "follower"))
    p.push(`${who}'s page is attached as ${g.attachment ?? "nothing"}`);
  if (!isText(g.view?.kind)) p.push(`${who}'s session view is not observed`);
  else if (g.view.kind === "displaying" && g.view.account_id !== account)
    p.push(`${who} displays another account`);
  if (
    g.root?.present !== true ||
    typeof g.root.gated !== "boolean" ||
    typeof g.root.mounted !== "boolean"
  )
    p.push(`${who}'s protected root is not observed`);
  if (
    !Number.isInteger(g.placeholders?.present) ||
    !Number.isInteger(g.placeholders?.refreshing_visible)
  )
    p.push(`${who}'s cache-gate placeholders are not observed`);
  if (typeof r.fenced !== "boolean")
    p.push(`${who}'s auth fences are not observed`);
  // Revision 29 (C5): only a coherent capture is a sample; its re-reads are counted, never hidden.
  if (r.coherent !== true) p.push(`${who}'s sample is not coherent`);
  if (!(Number.isInteger(r.incoherent_rereads) && r.incoherent_rereads >= 0))
    p.push(`${who}'s incoherent re-reads are not counted`);
  return p;
}
/**
 * A complete sample shows NO account content: the protected tree gated or unmounted under the neutral state (the only shape for the fenced
 * recovery caller), or — for the ordinary caller — the displaying account behind at least one VISIBLE refreshing placeholder in the lifted
 * tree, or a gated/unmounted tree. Any other session kind (signed_out, booting, incompatible, an unknown one), the floor, or an invisible
 * placeholder is not hidden.
 */
function renderedHidden(r, caller) {
  const g = r.rendering;
  const covered = g.root.gated === true || g.root.mounted === false;
  if (g.view.kind === "neutral") return covered;
  if (g.view.kind !== "displaying" || caller === "recovery") return false;
  return covered || g.placeholders.refreshing_visible > 0;
}
/** A complete sample SHOWS the recovered account: displaying it, the tree lifted and mounted, no cache-gate placeholder at all. */
const renderedShown = (r) =>
  r.rendering.view.kind === "displaying" &&
  r.rendering.root.gated === false &&
  r.rendering.root.mounted === true &&
  r.rendering.placeholders.present === 0;
/**
 * Revision 29 (R29-DIAG; design assessment C3, written independently of pair-recovery.mjs's `admissibilityProblems`): a complete sample
 * whose auth fence stands shows the neutral state over a covered (gated or unmounted) protected tree — on either page, for either caller,
 * in EVERY recovery observation, whatever its peer shows. Revision 28 checked the fence only in the final `recovery_rendered` record, so a
 * saved `recovery_activated` sample displaying while fenced was accepted.
 */
function fencedButUncovered(r) {
  if (r.fenced !== true) return false;
  const g = r.rendering;
  const covered = g.root.gated === true || g.root.mounted === false;
  return !(g.view.kind === "neutral" && covered);
}
/**
 * After the complete replacement, a complete sample is either SHOWN with no fence, or HIDDEN while it waits: under a standing fence the
 * neutral covered tree, without one also the ordinary hidden forms (the displaying account behind a visible refreshing placeholder). Either
 * page may show first; complete data while fenced and hidden is legal (§3.7.3: the data commits before the auth release).
 */
const admissibleAfterActivation = (r) =>
  renderedShown(r)
    ? r.fenced === false
    : renderedHidden(r, r.fenced === true ? "recovery" : "ordinary");
/**
 * One recovery observation's problems. Each is made at a HELD snapshot answer after the hand-off (so the client has committed everything
 * before that request and nothing after it), released by a recorded release of the hold, by two readers: `leader` (the leading page) and
 * `follower` (another page, its own connection). States: {reader, page, cache_status, cursor, delta_stage, staged, staging_rows,
 * staging_generations, recovery_generation, cache_digest, applied_revision, phase, gate, view, notice}.
 */
function recoveryObservationProblems(kind, o, ctx) {
  const problems = [];
  const bad = (p) => problems.push(`${kind}: ${p}`);
  const { record, bySeq, releasedIds, pre, handOff, terminal } = ctx;
  const at = bySeq.get(o.at_seq);
  const old = pre?.detail?.cache_digest;
  const leader = o.detail?.leader;
  const follower = o.detail?.follower;
  if (!at) {
    bad(`made at ${o.at_seq}, not an exchange of the interval`);
    return problems;
  }
  if (!(Number.isInteger(handOff?.at_seq) && at.seq > handOff.at_seq))
    bad("not made after the hand-off at the refusal");
  if (at.status !== 200 || at.phase !== "snapshot")
    bad(`exchange ${at.seq} is not a snapshot page (${at.status} ${at.phase})`);
  if (
    !(at.downstream?.events ?? []).includes("held") ||
    !releasedIds.has(at.proxy_id)
  )
    bad(`exchange ${at.seq} was not held and released by a recorded release`);
  if (leader?.reader !== "leader" || follower?.reader !== "follower")
    bad("not made by the leader AND a follower");
  else if (leader.page === follower.page)
    bad("the follower is the leading page itself");
  const refusalGen = o.detail?.generation_at_refusal;
  const invalidated = ctx.observations.find(
    (x) => x?.kind === "recovery_invalidated",
  );
  const gen = invalidated?.detail?.leader?.recovery_generation;
  // Revision 28: the observation contract, and complete samples of the same account and the same two documents throughout.
  if (o.detail?.schema !== RECOVERY_OBSERVATION_SCHEMA)
    bad(
      `made under the observation contract ${JSON.stringify(o.detail?.schema ?? null)}, not ${RECOVERY_OBSERVATION_SCHEMA} (incomplete)`,
    );
  const account = record.reader_account;
  if (!isText(account)) bad("the interval names no observed reader account");
  const documentOf = (who) =>
    invalidated?.detail?.[who]?.rendering?.document ?? null;
  const sampled = (r) => {
    const p = sampleProblems(r, account);
    for (const x of p) bad(`an incomplete sample: ${x}`);
    if (p.length > 0) return false;
    if (r.rendering.document !== documentOf(r.reader))
      bad(`${r.reader}'s document is not the one observed at the invalidation`);
    // Revision 29 (R29-DIAG): the fence implication, per sample (top-level and every held page), independent of the peer.
    if (fencedButUncovered(r))
      bad(
        `${r.reader}'s page is not the neutral covered surface while its recovery fence stands`,
      );
    return true;
  };
  const complete = [leader, follower].filter(Boolean).filter(sampled);
  if (
    complete.length === 2 &&
    leader.rendering.document === follower.rendering.document
  )
    bad("the follower is the leading page's own document");
  const readers = [leader, follower].filter(Boolean);
  const hiddenOf = (r, what) => {
    if (complete.includes(r) && !renderedHidden(r, record.caller))
      bad(`${r.reader}'s page shows account content ${what}`);
  };

  if (kind === "recovery_invalidated") {
    for (const r of readers) {
      if (r.cache_status === "valid")
        bad(`${r.reader} still shows a valid cache`);
      if (r.cursor !== null) bad(`${r.reader} keeps a cursor`);
      if (r.delta_stage !== null || r.staged !== 0)
        bad(`${r.reader} keeps the abandoned delta stage`);
      if (r.staging_rows !== 0)
        bad(`${r.reader} holds snapshot rows before the first page`);
      if (!(Number.isInteger(refusalGen) && r.recovery_generation > refusalGen))
        bad(`${r.reader} has no new recovery generation`);
      if (r.cache_digest !== old)
        bad(`${r.reader}'s live cache changed before the snapshot`);
      hiddenOf(r, "while the cache is invalid");
    }
    if (
      leader &&
      follower &&
      leader.recovery_generation !== follower.recovery_generation
    )
      bad("the follower does not read the leader's generation");
    if (record.caller === "recovery") {
      // W24 (server restart), not W18: the snapshot restart and the job's own notice of it.
      if (leader?.phase !== "snapshot")
        bad("the recovery caller's refusal did not restart the snapshot");
      if (leader?.notice?.reason !== "resync_required")
        bad(
          "the recovery job did not record its server restart (no resync_required notice)",
        );
      if (leader?.fenced !== true)
        bad("the recovery caller is no longer fenced");
    } else if (leader?.fenced === true) bad("an ordinary caller is fenced");
  } else if (
    kind === "recovery_staged_hidden" ||
    kind === "recovery_final_held"
  ) {
    if (!invalidated || !(at.seq > invalidated.at_seq))
      bad("not made after the invalidation was observed");
    for (const r of readers) {
      if (!(Number.isInteger(r.staging_rows) && r.staging_rows > 0))
        bad(`${r.reader} holds no staged snapshot rows`);
      if (
        !(
          r.staging_generations?.length === 1 &&
          r.staging_generations[0] === gen
        )
      )
        bad(
          `${r.reader}'s staged rows are not all of the recovery's generation`,
        );
      if (r.recovery_generation !== gen)
        bad(`${r.reader} moved to another generation`);
      if (r.cache_digest !== old)
        bad(`${r.reader}'s live cache changed before the activation`);
      if (r.cache_status === "valid")
        bad(`${r.reader} shows a valid cache before the last page`);
      hiddenOf(r, "while the snapshot is staged");
      if (
        record.caller === "recovery" &&
        r.reader === "leader" &&
        r.fenced !== true
      )
        bad("the fence was cleared before the snapshot was complete");
    }
    if (kind === "recovery_final_held") {
      if (at.has_more !== false)
        bad(`exchange ${at.seq} is not the last snapshot page`);
      // Revision 28 (C4): both readers at EVERY held snapshot page after the first, each complete, hidden, of the recovery's generation and
      // the old live cache — exactly the interval's snapshot exchanges between the invalidation and this one.
      const held = Array.isArray(o.detail?.pages) ? o.detail.pages : null;
      const expected = [...bySeq.values()]
        .filter(
          (x) =>
            x.status === 200 &&
            x.phase === "snapshot" &&
            x.seq > (invalidated?.at_seq ?? Number.POSITIVE_INFINITY) &&
            x.seq <= at.seq,
        )
        .map((x) => x.seq)
        .sort((x, y) => x - y);
      if (!held) bad("the held snapshot pages are not recorded");
      else {
        const seqs = JSON.stringify(held.map((x) => x?.seq));
        if (seqs !== JSON.stringify(expected))
          bad(
            `the held pages recorded ${seqs} are not the snapshot pages ${JSON.stringify(expected)}`,
          );
        for (const page of held) {
          if (
            page?.leader?.reader !== "leader" ||
            page?.follower?.reader !== "follower"
          ) {
            bad(`page ${page?.seq} is not read by the leader AND a follower`);
            continue;
          }
          for (const r of [page.leader, page.follower]) {
            if (!sampled(r)) continue;
            if (!renderedHidden(r, record.caller))
              bad(
                `${r.reader}'s page shows account content at page ${page.seq}`,
              );
            if (r.cache_digest !== old || r.cache_status === "valid")
              bad(
                `${r.reader}'s live cache is not the old hidden one at page ${page.seq}`,
              );
            if (
              !(r.staging_rows > 0) ||
              r.recovery_generation !== gen ||
              !(
                r.staging_generations?.length === 1 &&
                r.staging_generations[0] === gen
              )
            )
              bad(
                `${r.reader} does not hold the recovery's staged rows at page ${page.seq}`,
              );
          }
        }
      }

      if (terminal?.activated_by_seq !== at.seq)
        bad(
          "the last snapshot page held is not the terminal's activating answer",
        );
      const staged = ctx.observations.find(
        (x) => x?.kind === "recovery_staged_hidden",
      );
      if (!(staged && staged.at_seq <= at.seq))
        bad(
          "no staged page was observed by the last one (fewer than two snapshot pages)",
        );
      else if (!(leader?.staging_rows >= staged.detail?.leader?.staging_rows))
        bad("the staged rows went backwards");
    }
  } else if (kind === "recovery_activated") {
    if (terminal?.activated_by_seq !== at.seq)
      bad("not made at the terminal's activating snapshot page");
    for (const r of readers) {
      if (r.cache_status !== "valid")
        bad(`${r.reader} does not show a valid cache`);
      if (r.staging_rows !== 0 || r.delta_stage !== null || r.staged !== 0)
        bad(`${r.reader} still holds staged rows after the activation`);
      if (r.cache_digest === old) bad(`${r.reader} still shows the old cache`);
      if (r.applied_revision !== terminal?.applied_revision)
        bad(
          `${r.reader} applied ${r.applied_revision}, the terminal ${terminal?.applied_revision}`,
        );
      if (r.split === true) bad(`${r.reader} observed a split activation`);
      // Revision 29 (R29-DIAG): the DATA activation's samples are judged for what each page shows too — hidden while it waits, or shown
      // with its fence clear; never shown (or displayed behind a placeholder) while fenced.
      if (complete.includes(r) && !admissibleAfterActivation(r))
        bad(
          `${r.reader}'s page is neither hidden while waiting nor shown unfenced at the data activation`,
        );
    }
    if (leader && follower && leader.cache_digest !== follower.cache_digest)
      bad("the follower does not read the activated cache");
    if (leader?.cache_digest !== o.cache_digest)
      bad("the observation's digest is not the leader's");
    if (!isText(o.detail?.rows_sha256))
      bad("the activated rows are not hashed");
  } else if (kind === "recovery_rendered") {
    // Revision 28 (C5): after the data activation, both pages SHOW the recovered cache (the recovery caller's with its fence cleared).
    const activated = ctx.observations.find(
      (x) => x?.kind === "recovery_activated",
    );
    if (!activated) bad("no data activation was observed before it");
    if (terminal?.activated_by_seq !== at.seq)
      bad("not made at the terminal's activating snapshot page");
    for (const r of readers) {
      if (!complete.includes(r)) continue;
      if (!renderedShown(r))
        bad(`${r.reader}'s page does not show the recovered cache`);
      if (
        r.cache_status !== "valid" ||
        r.staging_rows !== 0 ||
        r.delta_stage !== null ||
        r.staged !== 0
      )
        bad(`${r.reader} does not hold the complete activated cache`);
      if (r.cache_digest !== activated?.cache_digest)
        bad(`${r.reader} shows another cache than the activated one`);
      // Revision 29: for either caller (an ordinary caller's page shown while fenced is no settlement either).
      if (r.fenced !== false)
        bad(`${r.reader} shows the recovered cache while fenced`);
    }
    if (o.cache_digest !== activated?.cache_digest)
      bad("the observation's digest is not the activated cache");
  }
  return problems;
}
