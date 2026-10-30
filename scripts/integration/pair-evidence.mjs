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
//   - the spec's barriers, in its own clock, in order: pre_grant_complete, grant_complete, [piece_persisted…], final_released (driven
//     cases), activation_complete. Each piece_persisted names the received non-final piece it witnessed (`applied_seq`), at most once;
//   - the TERMINAL: the applied revision, the included answer that activated it (`activated_by_seq`: a final piece of that revision, or a
//     whole/snapshot page ending in it) and the feed's completion (`final_seq`: has_more false), both answers that reached the client;
//     final_released (driven) names that completion, delivered; a recovery shows a 410 the client was answered before its activation;
//   - the independent content oracle's verdict;
//   - memory: either real samples of a named kind, or null WITH a reason. A zero or an empty sample list is never a bound.
// Schema 2 (revision 24) is a new contract: a schema-1 record is refused, never upgraded.
import { createHash } from "node:crypto";
import { activates, reachedClient, seenOf } from "./pair-attempts.mjs";
import { describeSync } from "./pair-tap.mjs";

export const SCHEMA = "web09c-pair-interval/2";
const ORDER = [
  "pre_grant_complete",
  "grant_complete",
  "piece_persisted",
  "final_released",
  "activation_complete",
];
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
    record.backend === "development" &&
    !isText(record.selection_manifest_sha256)
  )
    bad("a development interval names no selection manifest hash");
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

  // The barriers, in the spec's clock.
  const barriers = Array.isArray(record.barriers) ? record.barriers : [];
  let rank = -1;
  let at = Number.NEGATIVE_INFINITY;
  for (const [i, b] of barriers.entries()) {
    const r = ORDER.indexOf(b?.name);
    if (r < 0)
      bad(`barriers[${i}]: unknown barrier ${JSON.stringify(b?.name)}`);
    else if (r < rank) bad(`barriers[${i}]: ${b.name} after ${ORDER[rank]}`);
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
  const witnessed = new Set();
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
    witnessed.add(b.detail?.applied_seq);
  }
  if (record.barriered === true) {
    const persisted = names.filter((n) => n === "piece_persisted").length;
    if (persisted !== record.pieces_persisted)
      bad(
        `${persisted} piece_persisted barriers, recorded ${record.pieces_persisted}`,
      );
  }

  // Terminal state, bound to the included answers, and the independent oracle.
  const t = record.terminal;
  if (!["activated", "recovered"].includes(t?.kind))
    bad(`terminal ${JSON.stringify(t?.kind)}`);
  if (!Number.isInteger(t?.applied_revision))
    bad("the terminal names no applied revision");
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
  const activation = barriers.find((b) => b?.name === "activation_complete");
  if (activation && activation.detail?.applied_revision !== t?.applied_revision)
    bad("activation_complete names another revision than the terminal");
  if (record.barriered === true) {
    const released = barriers.filter((b) => b?.name === "final_released");
    if (released.length !== 1)
      bad(`${released.length} final_released barriers, not one`);
    else if (
      released[0].detail?.seq !== t?.final_seq ||
      released[0].detail?.outcome !== "delivered"
    )
      bad(
        "final_released does not name the feed's completion, delivered to the client",
      );
  }
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
  else if ((record?.workload ?? null) !== row.workload)
    problems.push(
      `workload ${record?.workload}, the matrix says ${row.workload}`,
    );
  if (
    typeof record?.interval !== "string" ||
    !record.interval.startsWith(`${record?.case}:${record?.engine}:`)
  )
    problems.push("the interval id does not name its case and engine");
  return problems;
}
