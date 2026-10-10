/**
 * FIXTURE ONLY (never packaged; `check-no-fixture`). The device page's protocol state (WEB-09c revision 2; design assessment DA-1): ONE
 * versioned envelope per collection in this origin's localStorage, owned by ONE tab, changed only by whole-envelope writes.
 *
 * - **One write per transition.** Reserving an attempt (before it runs), storing its result together with the end of the reservation
 *   (after it runs), recording an interrupted attempt and finishing the protocol are each a single `setItem` of the whole envelope, so a
 *   reload, a killed tab or a storage error between two writes can never skip an attempt, lose a result or record one twice.
 * - **Compare and set.** Every write first reads the envelope again and refuses if anything changed since this page read it (another tab,
 *   a clear, a take-over); nothing is overwritten blind.
 * - **One owner.** The tab that starts a protocol owns it: its token lives in that tab's sessionStorage (it survives the protocol's
 *   reloads, and no other tab has it). Any other page, a plain menu page included, only reads: it cannot run, recover, clear or delete,
 *   and it says why. Ownership moves only by an explicit, recorded take-over (the operator's tab was lost).
 * - **Errors stop, they do not reset.** An unreadable envelope or a refused write stops the protocol with its error shown; the stored
 *   evidence is left as it is, never replaced by an empty collection.
 *
 * Revision 3 (review 3 R5, design assessment section B): compare-and-set is only a stale-state check, not an atomic swap. The page takes
 * ONE origin-wide collector guard (a Web Lock, `profile-page.ts`) before it reads or creates either envelope, and every mutating entry
 * point (protocol, manual run, recovery, capture restoration, take-over, clear, delete) runs under it. Here: `admission` (an active
 * protocol excludes every manual run, a manual attempt still reserved excludes a protocol start, an unreadable envelope blocks both),
 * `permitProblem` (an attempt's result is stored only into the very reservation its page made: same collection, owner and reservation;
 * a freshly read envelope never authorises old work) and the structural invariants `readEnvelope` checks (plan, next, reservation,
 * results, terminal and take-overs agree).
 *
 * A results file is the envelope's runs with its identity (schema 2): one `protocol_id` on every run, every (workload, run) once.
 */
import type { ProfileRun } from "./profile-page";

export const PROTOCOL_KEY = "atlas-profile-protocol";
export const MANUAL_KEY = "atlas-profile-manual";
export const OWNER_KEY = "atlas-profile-owner";
export const SCHEMA = 2;

/** The parts of `Storage` the protocol uses (localStorage, sessionStorage, or a test's own). */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Attempt {
  name: string;
  run: number;
}

export interface Reservation extends Attempt {
  index: number;
  at: string;
  page: string;
}

export interface Envelope {
  schema: typeof SCHEMA;
  kind: "protocol" | "manual";
  protocol_id: string;
  owner: string;
  workload_version: number;
  w2sha256: string | null;
  plan: Attempt[];
  created_at: string;
  recorded_at: string;
  machine: Record<string, unknown>;
  next: number;
  reserved: Reservation | null;
  runs: ProfileRun[];
  terminal: null | "complete" | "error";
  error: string | null;
  takeovers: Array<{ at: string; from: string; to: string }>;
}

export type Read =
  | { state: "absent" }
  | { state: "corrupt"; raw: string; error: string }
  | { state: "present"; envelope: Envelope; raw: string };

/** Reads an envelope. Anything that is not a whole schema-2 envelope is `corrupt`, with its raw text kept for the operator. */
export function readEnvelope(store: KeyValue, key: string): Read {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch (error) {
    return { state: "corrupt", raw: "", error: `unreadable: ${String(error)}` };
  }
  if (raw === null) return { state: "absent" };
  try {
    const envelope = JSON.parse(raw) as Envelope;
    if (
      envelope?.schema !== SCHEMA ||
      typeof envelope.protocol_id !== "string" ||
      typeof envelope.owner !== "string" ||
      !Array.isArray(envelope.plan) ||
      !Array.isArray(envelope.runs) ||
      !Number.isInteger(envelope.next)
    )
      return {
        state: "corrupt",
        raw,
        error: "not a schema-2 protocol envelope",
      };
    const problem = structuralProblem(envelope);
    if (problem)
      return {
        state: "corrupt",
        raw,
        error: `an inconsistent schema-2 envelope: ${problem}`,
      };
    return { state: "present", envelope, raw };
  } catch (error) {
    return { state: "corrupt", raw, error: String(error).slice(0, 160) };
  }
}

const isText = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0;
const isRun = (x: unknown): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= 1;

/**
 * What makes a schema-2 envelope inconsistent (design assessment D9): its kind, plan, next, reservation, results, terminal state and
 * take-overs must agree, so a hand-edited, truncated or mixed record is never driven as if it were a collection.
 */
export function structuralProblem(e: Envelope): string | null {
  if (e.kind !== "protocol" && e.kind !== "manual")
    return `kind ${String(e.kind)}`;
  if (!isText(e.protocol_id) || !isText(e.owner))
    return "no collection id or owner";
  if (!Number.isInteger(e.workload_version)) return "no workload version";
  if (e.w2sha256 !== null && !/^[0-9a-f]{64}$/.test(String(e.w2sha256)))
    return "its W2 capture is not a SHA-256";
  if (!e.plan.every((a) => isText(a?.name) && isRun(a?.run)))
    return "a planned attempt has no workload or run";
  if (e.kind === "manual" && e.plan.length !== 0)
    return "a manual collection has a plan";
  const seen = new Set<string>();
  for (const r of e.runs) {
    if (!isText(r?.workload) || !isRun(r?.run))
      return "a stored result has no workload or run";
    const key = `${r.workload}#${r.run}`;
    if (seen.has(key)) return `the result ${key} is stored twice`;
    seen.add(key);
  }
  if (e.next !== e.runs.length)
    return `next is ${e.next} but ${e.runs.length} results are stored`;
  if (e.kind === "protocol") {
    if (e.next > e.plan.length) return "next is past the plan";
    for (const [i, r] of e.runs.entries())
      if (r.workload !== e.plan[i]?.name || r.run !== e.plan[i]?.run)
        return `result ${i + 1} is not the planned attempt`;
  }
  const r = e.reserved;
  if (r !== null) {
    if (
      typeof r !== "object" ||
      !isText(r.name) ||
      !isRun(r.run) ||
      r.index !== e.next ||
      !isText(r.at) ||
      !isText(r.page)
    )
      return "the reservation is not the next attempt's";
    if (
      e.kind === "protocol" &&
      (r.name !== e.plan[e.next]?.name || r.run !== e.plan[e.next]?.run)
    )
      return "the reservation is not the planned attempt";
    if (e.terminal) return "a finished collection holds a reservation";
  }
  if (
    e.terminal !== null &&
    e.terminal !== "complete" &&
    e.terminal !== "error"
  )
    return `terminal ${String(e.terminal)}`;
  if (
    e.kind === "protocol" &&
    (e.terminal === "complete") !== (e.next === e.plan.length) &&
    e.terminal !== "error"
  )
    return "its completion does not agree with its plan";
  if (e.kind === "manual" && e.terminal === "complete")
    return "a manual collection cannot be complete";
  if (e.error !== null && typeof e.error !== "string") return "error";
  if (
    !Array.isArray(e.takeovers) ||
    !e.takeovers.every((t) => isText(t?.at) && isText(t?.from) && isText(t?.to))
  )
    return "the take-over record is malformed";
  return null;
}

export type Written =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: string };

/**
 * Writes `next` in place of `expected` (the raw text this page read), or refuses: if the stored text is no longer `expected` (another
 * writer, a clear, a take-over), or if the storage refuses the write (quota, denied). A refused `setItem` leaves the previous value.
 */
export function compareAndSet(
  store: KeyValue,
  key: string,
  expected: string | null,
  next: Envelope,
): Written {
  let current: string | null;
  try {
    current = store.getItem(key);
  } catch (error) {
    return {
      ok: false,
      error: `the envelope cannot be read again: ${String(error)}`,
    };
  }
  if (current !== expected)
    return {
      ok: false,
      error:
        "the stored protocol changed since this page read it (another tab, a clear or a take-over): nothing was written",
    };
  try {
    store.setItem(key, JSON.stringify(next));
  } catch (error) {
    return {
      ok: false,
      error: `the storage refused the write (${String(error).slice(0, 120)}): the stored protocol is unchanged`,
    };
  }
  return { ok: true, envelope: next };
}

/** This tab's owner token, created once per tab (sessionStorage is per tab and survives the tab's reloads). */
export function tabToken(session: KeyValue, make: () => string): string {
  const kept = session.getItem(OWNER_KEY);
  if (kept) return kept;
  const token = make();
  session.setItem(OWNER_KEY, token);
  return token;
}

/** What a page may do with what it read. */
export type Decision =
  | { action: "start" }
  | { action: "corrupt"; error: string }
  | { action: "foreign"; envelope: Envelope }
  | { action: "terminal"; envelope: Envelope }
  | { action: "recover"; envelope: Envelope }
  | { action: "ready"; envelope: Envelope };

/**
 * Only the owner acts. An absent collection may be started; an unreadable one stops everything; another tab's is read only; a reserved
 * attempt is recovered before anything else; otherwise the owner may run its next attempt.
 */
export function decide(read: Read, owner: string): Decision {
  if (read.state === "absent") return { action: "start" };
  if (read.state === "corrupt") return { action: "corrupt", error: read.error };
  const e = read.envelope;
  if (e.owner !== owner) return { action: "foreign", envelope: e };
  if (e.terminal) return { action: "terminal", envelope: e };
  if (e.reserved) return { action: "recover", envelope: e };
  return { action: "ready", envelope: e };
}

export function newEnvelope(init: {
  kind: Envelope["kind"];
  protocolId: string;
  owner: string;
  workloadVersion: number;
  w2sha256: string | null;
  plan: Attempt[];
  machine: Record<string, unknown>;
  now: string;
}): Envelope {
  return {
    schema: SCHEMA,
    kind: init.kind,
    protocol_id: init.protocolId,
    owner: init.owner,
    workload_version: init.workloadVersion,
    w2sha256: init.w2sha256,
    plan: init.plan,
    created_at: init.now,
    recorded_at: init.now,
    machine: init.machine,
    next: 0,
    reserved: null,
    runs: [],
    terminal:
      init.plan.length === 0 && init.kind === "protocol" ? "complete" : null,
    error: null,
    takeovers: [],
  };
}

/** Reserves attempt `index` BEFORE it runs: if the page dies now, the next load of the owner records it as interrupted, once. */
export function reserve(
  e: Envelope,
  index: number,
  attempt: Attempt,
  page: string,
  now: string,
): Envelope {
  return {
    ...e,
    reserved: { ...attempt, index, at: now, page },
    recorded_at: now,
  };
}

const done = (e: Envelope, next: number): Envelope["terminal"] =>
  e.kind === "protocol" && next >= e.plan.length ? "complete" : null;

/**
 * Stores the reserved attempt's result and ends its reservation in the same write; the protocol moves on (or is complete). There must be
 * a reservation: a result is never appended to a collection that holds none (revision 3: no unreserved fallback).
 */
export function complete(
  e: Envelope,
  result: ProfileRun,
  now: string,
): Envelope {
  if (!e.reserved)
    throw new Error(
      "no reserved attempt: a result is stored only into its own reservation",
    );
  const next = e.reserved.index + 1;
  return {
    ...e,
    runs: [...e.runs, { ...result, protocol_id: e.protocol_id }],
    reserved: null,
    next,
    terminal: done(e, next),
    recorded_at: now,
  };
}

/** The reserved attempt never finished (the tab or its process was killed): recorded as `killed`, once, and the protocol moves on. */
export function recoverInterrupted(
  e: Envelope,
  killed: ProfileRun,
  now: string,
): Envelope {
  return complete(e, killed, now);
}

/** The operator's explicit take-over (the owning tab is gone): recorded in the envelope; nothing else changes. */
export function takeOver(e: Envelope, owner: string, now: string): Envelope {
  return {
    ...e,
    owner,
    takeovers: [...e.takeovers, { at: now, from: e.owner, to: owner }],
    recorded_at: now,
  };
}

/** Stops the protocol with an error that is kept (the evidence stays; the page says why it stopped). */
export function fail(e: Envelope, error: string, now: string): Envelope {
  return { ...e, terminal: "error", error, recorded_at: now };
}

/** The results file of an envelope (what the validator reads). */
export function exportResults(e: Envelope) {
  return {
    schema: SCHEMA,
    kind: e.kind,
    protocol_id: e.protocol_id,
    workload_version: e.workload_version,
    w2sha256: e.w2sha256,
    recorded_at: e.recorded_at,
    created_at: e.created_at,
    machine: e.machine,
    planned_runs: e.plan.length,
    terminal: e.terminal,
    error: e.error,
    takeovers: e.takeovers,
    runs: e.runs,
  };
}

/** The identity of the attempt a page reserved: the only reservation its result may be stored into. */
export interface Permit {
  protocol_id: string;
  owner: string;
  reservation: Reservation;
}

/**
 * Why a result may NOT be stored now (null: it may). After the run's asynchronous work the page reads the envelope again; it stores its
 * result only if that envelope is still the same collection, with the same owner, unfinished, and still holds exactly the reservation the
 * page made. A clear, a re-creation, a take-over or another page's reservation in between makes the late result a diagnostic, never an
 * append to whatever is stored now.
 */
export function permitProblem(read: Read, permit: Permit): string | null {
  if (read.state === "absent")
    return "the collection is no longer stored (cleared)";
  if (read.state === "corrupt")
    return `the stored collection is unreadable (${read.error})`;
  const e = read.envelope;
  if (e.protocol_id !== permit.protocol_id)
    return `another collection (${e.protocol_id}) is stored in its place`;
  if (e.owner !== permit.owner) return "its owner changed (a take-over)";
  if (e.terminal) return `it is ${e.terminal}`;
  const r = e.reserved;
  const p = permit.reservation;
  if (
    !r ||
    r.index !== p.index ||
    r.name !== p.name ||
    r.run !== p.run ||
    r.at !== p.at ||
    r.page !== p.page
  )
    return "it no longer holds the reservation this page made";
  return null;
}

export type Route = "protocol" | "manual";

/**
 * Whether a collecting route may proceed with what is stored, across BOTH collections (review 3 R5): an active protocol excludes every
 * manual run (whoever owns either, a copied owner token included); a manual attempt still reserved (running, or interrupted and not yet
 * recorded) excludes a protocol start; an unreadable envelope blocks both until it is copied and cleared explicitly. An idle manual
 * history may stay beside a protocol; it authorises nothing during it.
 */
export function admission(
  route: Route,
  protocol: Read,
  manual: Read,
): { ok: true } | { ok: false; why: string } {
  for (const [name, read] of [
    ["protocol", protocol],
    ["manual", manual],
  ] as const)
    if (read.state === "corrupt")
      return {
        ok: false,
        why: `the stored ${name} collection is unreadable (${read.error}); copy it below, then clear it explicitly. Nothing was changed`,
      };
  if (
    route === "manual" &&
    protocol.state === "present" &&
    !protocol.envelope.terminal
  )
    return {
      ok: false,
      why: `protocol ${protocol.envelope.protocol_id} is active on this origin: a manual run is refused until it is complete or cleared (one collector at a time)`,
    };
  if (
    route === "protocol" &&
    manual.state === "present" &&
    manual.envelope.reserved !== null
  )
    return {
      ok: false,
      why: `a manual attempt (${manual.envelope.reserved.name} run ${manual.envelope.reserved.run}) is reserved: let its page record it (or reopen its link in its tab), or clear, before a protocol starts`,
    };
  return { ok: true };
}

/** Whether a page holding `owner` may clear this collection or delete the profiling databases now. */
export function mayClear(
  read: Read,
  owner: string,
): { ok: boolean; why: string } {
  if (read.state !== "present") return { ok: true, why: "" };
  const e = read.envelope;
  if (e.terminal) return { ok: true, why: "" };
  if (e.owner !== owner)
    return {
      ok: false,
      why: "another tab owns the active collection: only that tab (or a recorded take-over) may clear it",
    };
  if (e.reserved)
    return {
      ok: false,
      why: "an attempt is in progress: wait for it to be recorded",
    };
  return { ok: true, why: "" };
}
