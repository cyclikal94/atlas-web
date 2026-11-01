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
  if (!["full", "prefix", "none"].includes(driven))
    bad(`driven ${JSON.stringify(driven)}`);
  const handOff = record.hand_off ?? null;
  if (driven === "prefix") {
    if (!Number.isInteger(handOff?.at_seq) || !isText(handOff?.reason))
      bad("a partly driven record names no hand-off");
  } else if (handOff !== null)
    bad("only a partly driven record has a hand-off");
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
  if (driven === "prefix" && attemptOf.get(handOff?.at_seq)?.step == null)
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
      : driven === "prefix"
        ? handOff?.at_seq
        : null;
  for (const r of requests ?? []) {
    if (Number.isInteger(end) && r.seq <= end && !attemptOf.has(r.seq))
      bad(`exchange ${r.seq} precedes the end of the drive but is no attempt`);
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
    } else bad(`unknown required observation ${kind}`);
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
    hand_off: iv.handOff ?? null,
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
