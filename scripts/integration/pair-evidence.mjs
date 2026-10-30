// WEB-09c (R23-PAIR, invariant I7): what ONE paired interval record must hold before it can be evidence. The spec writes the record and
// validates it BEFORE asserting anything else; the runner validates every record again after the run. A record that fails here is not a
// measurement and not a pass, whatever the browser did.
//
// One interval = one case in one engine, from the pre-grant barrier to the terminal state. It binds:
//   - the TAP's exchanges labelled with this interval (and no other label): exact upstream body bytes (hash and length re-checked from the
//     body files), request cursors and budgets, segment indices, injected answers kept apart from unaltered ones;
//   - the spec's barriers, in its own clock, in order: pre_grant_complete, grant_complete, [piece_persisted…], final_released (barriered
//     cases), activation_complete;
//   - the terminal state (activated / recovered) and the independent content oracle's verdict;
//   - memory: either real samples of a named kind, or null WITH a reason. A zero or an empty sample list is never a bound.
import { createHash } from "node:crypto";

export const SCHEMA = "web09c-pair-interval/1";
const ORDER = [
  "pre_grant_complete",
  "grant_complete",
  "piece_persisted",
  "final_released",
  "activation_complete",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isText = (v) => typeof v === "string" && v.length > 0;

/**
 * Returns the problems of `record` (empty: valid). `readBody(file)` reads a body file of the tap (bytes) or throws; without it the bodies
 * are not re-checked and the result says so (`unchecked_bodies`).
 */
export function validateInterval(record, { readBody } = {}) {
  const problems = [];
  const bad = (p) => problems.push(p);
  if (record === null || typeof record !== "object")
    return ["the record is not an object"];
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

  // The tap's exchanges.
  const requests = Array.isArray(record.requests) ? record.requests : null;
  if (!requests || requests.length === 0)
    bad("no exchange is bound to the interval");
  else {
    let last = 0;
    const known = new Set([record.pre_grant_cursor]);
    for (const [i, r] of requests.entries()) {
      const where = `requests[${i}]`;
      if (!(Number.isInteger(r.seq) && r.seq > last))
        bad(`${where}: sequence ${r.seq} is not after ${last}`);
      last = Number.isInteger(r.seq) ? r.seq : last;
      if (r.label !== record.interval)
        bad(`${where}: labelled ${JSON.stringify(r.label)}, not this interval`);
      if (r.status === null || r.status === undefined) {
        bad(`${where}: no status (the exchange did not complete)`);
        continue;
      }
      if (
        !isText(r.sha256) ||
        !Number.isInteger(r.bytes) ||
        !isText(r.body_file)
      )
        bad(`${where}: no body hash, length or file`);
      else if (readBody) {
        let bytes = null;
        try {
          bytes = readBody(r.body_file);
        } catch (error) {
          bad(
            `${where}: body file unreadable: ${String(error?.message ?? error).split("\n")[0]}`,
          );
        }
        if (bytes !== null) {
          if (bytes.length !== r.bytes)
            bad(`${where}: body is ${bytes.length} bytes, recorded ${r.bytes}`);
          if (sha256(bytes) !== r.sha256)
            bad(`${where}: body hash differs from the record`);
        }
      }
      if (
        r.delivered &&
        (!isText(r.delivered.injected) || !Number.isInteger(r.delivered.status))
      )
        bad(
          `${where}: an altered answer is not labelled as injected with its status`,
        );
      // Chain: every request's cursor is the pre-grant cursor or a cursor an earlier answer of this interval delivered.
      const cursor = r.query?.cursor ?? null;
      if (!known.has(cursor))
        bad(`${where}: cursor not delivered earlier in this interval`);
      // What the client received: the injected answer when there was one; nothing when the connection was dropped.
      if (r.dropped !== undefined && (!isText(r.dropped) || r.delivered))
        bad(`${where}: a dropped answer is not labelled, or also delivered`);
      if (isText(r.dropped)) continue;
      const status = r.delivered ? r.delivered.status : r.status;
      const delivered = r.delivered ? r.delivered.next_cursor : r.next_cursor;
      if (status === 200 && isText(delivered)) known.add(delivered);
      // A 410 sends the client to a fresh snapshot, which starts without a cursor.
      if (status === 410) known.add(null);
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
  if (record.barriered === true) {
    if (!names.includes("final_released"))
      bad("a barriered interval has no final_released barrier");
    const persisted = names.filter((n) => n === "piece_persisted").length;
    if (persisted !== record.pieces_persisted)
      bad(
        `${persisted} piece_persisted barriers, recorded ${record.pieces_persisted}`,
      );
  }

  // Terminal state and the independent oracle.
  if (!["activated", "recovered"].includes(record.terminal?.kind))
    bad(`terminal ${JSON.stringify(record.terminal?.kind)}`);
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
