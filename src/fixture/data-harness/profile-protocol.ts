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
    return { state: "present", envelope, raw };
  } catch (error) {
    return { state: "corrupt", raw, error: String(error).slice(0, 160) };
  }
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

/** Stores the reserved attempt's result and ends its reservation in the same write; the protocol moves on (or is complete). */
export function complete(
  e: Envelope,
  result: ProfileRun,
  now: string,
): Envelope {
  const index = e.reserved?.index ?? e.next;
  const next = e.kind === "protocol" ? index + 1 : e.next + 1;
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
