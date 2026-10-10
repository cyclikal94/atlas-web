import type { SyncPhase, SyncStatusModel } from "../../lib/sync-chip";
import type { DispatcherState } from "../engine/outbox-dispatcher";
import type { EngineState } from "../engine/sync-engine";
import { DATA_CONFIG } from "./config";
import type { QueueSummary } from "./queue-summary";

/**
 * The status model (plan 5.7), as PURE functions. `deriveSyncStatus` returns the existing `SyncStatusModel` the chip reads;
 * `deriveNotices` says which of the banners and terminal states apply; `deriveGate` says what a cache-sourced view shows.
 *
 * Two independent axes, never collapsed (ia.md 1.3.1): the INBOUND cache phase and the OUTBOUND counts. "Up to date" is never
 * shown unless a sync has actually completed: in production, where no engine runs (WEB-09b supplies the leader), the chip therefore
 * reads "Updates stopped", which is true.
 */
export type CacheState =
  | "empty"
  | "valid"
  | "invalid"
  /** There is no open account database on this page (nothing is readable, so nothing is gated). */
  | "unknown"
  /**
   * The account database is open and its display state is NOT established: the first read of `sync_state` is pending, or it failed
   * and no earlier read of this database stands (R13). The cache is readable and may be invalid, so it stays hidden, exactly as
   * for `invalid`, until a successful read says otherwise.
   */
  | "unverified";

export interface StatusInputs {
  /** The page's own knowledge of connectivity (`navigator.onLine` and the `online`/`offline` events). */
  online: boolean;
  /** `null`: no engine exists on this page. */
  engine: EngineState | null;
  recovery: { registered: boolean; active: boolean };
  /** `unknown`: no account database is open here (nothing is cached or readable, nothing is gated). */
  cache: CacheState;
  lastSyncedAt: string | null;
  /** `null`: no queue is readable (no database, or it is latched). */
  summary: QueueSummary | null;
  outbox: DispatcherState | null;
  /** Three durable failures of one save (the facade's own flag). */
  storageNotResponding: boolean;
  /** That stop is held in this tab alone (neither the durable streak nor the fallback marker recorded it). */
  storageMemoryOnly?: boolean;
  /** The phase the chip showed last, so a transient back-off keeps it. */
  previous?: SyncPhase;
}

/** The phase of the INBOUND axis. */
export function derivePhase(inputs: StatusInputs, now: number): SyncPhase {
  if (!inputs.online) return "offline";
  if (inputs.recovery.active) return "resyncing";
  const engine = inputs.engine;
  if (engine === null) return "interrupted";
  switch (engine.kind) {
    case "not_started":
      return "interrupted";
    case "running":
      // The live-edge poll is not "catching up": the chip keeps what it showed.
      return engine.catchingUp
        ? "resyncing"
        : (inputs.previous ??
            (inputs.lastSyncedAt === null ? "interrupted" : "synced"));
    case "idle":
      return "synced";
    case "waiting":
      if (engine.reason === "offline") return "offline";
      if (engine.reason === "cache_not_valid")
        // Recovery is automatic and starts the instant a `410` arrives (Q24): with a recovery job the chip says so.
        return inputs.recovery.registered ? "resyncing" : "interrupted";
      return "interrupted";
    case "backing_off":
      // A short back-off is not worth the person's attention: only a SUSTAINED failure changes the chip.
      return now - engine.since >= DATA_CONFIG.retrySustainedMs
        ? "interrupted"
        : (inputs.previous ?? "interrupted");
    case "paused":
    case "stopped":
      return "interrupted";
  }
}

export function deriveSyncStatus(
  inputs: StatusInputs,
  now: number,
): SyncStatusModel {
  return {
    phase: derivePhase(inputs, now),
    pendingCount: inputs.summary?.waiting ?? 0,
    conflictCount: inputs.summary?.needsDecision ?? 0,
    ...(inputs.lastSyncedAt === null
      ? {}
      : { lastSyncedAt: inputs.lastSyncedAt }),
  };
}

// ---- the banners and terminal states -------------------------------------------------------------------------------------------
export type Notice =
  /** The Q23 floor, states (a) (the cache stays visible) and (b) (the cache stays hidden). */
  | { kind: "floor"; variant: "a" | "b" }
  /** The quota reserve: "Couldn't finish updating/refreshing your offline data". Never claims an automatic retry. */
  | { kind: "storage_full"; cache: "valid" | "invalid" }
  /**
   * A page's three local write failures: "Couldn't finish saving that page" with "Retry applying changes". `memoryOnly`: the stop is
   * held in this tab alone and will not survive a reload, which the notice says plainly.
   */
  | { kind: "page_not_saved"; memoryOnly: boolean }
  /** Three durable failures of a save: "Local storage isn't responding" with "Try again". `memoryOnly` as above. */
  | { kind: "storage_not_responding"; memoryOnly: boolean }
  /** The compatibility pause (`unsupported`, `missing`): drafts kept, nothing sent. */
  | { kind: "compat_paused"; reason: "unsupported" | "missing" }
  /** A sustained failure: automatic retry has paused and "Retry now" is offered. */
  | { kind: "still_trying"; scope: "updates" | "changes"; count: number }
  | { kind: "device_capacity" }
  | { kind: "unrecognised" }
  /** The 200-entry warning: informational only; nothing is disabled. */
  | { kind: "queue_warning"; total: number };

/**
 * Whether the cache must be hidden: the database says it is invalid, OR its display state is not established (R13: the database is
 * open and its facts are pending or could not be read, and no earlier read stands), OR the engine holds an invalidation the server
 * admitted whose write is outstanding (R10). In the third case the database may still say `valid`, because the write that would say
 * otherwise is what failed, and the cache is nevertheless KNOWN to be invalid: it is not shown, and the notice says it is being
 * refreshed. The engine reports the hold on EVERY state it shows while it holds one (a stop of the write, an offline wake, a retry in
 * flight, a paced wait), never only on the stop: display safety does not depend on what the engine happens to be doing.
 *
 * Only `unknown` (no open database: nothing is readable) and a state that a read ESTABLISHED (`empty`, `valid`) show content.
 */
export function cacheHidden(inputs: StatusInputs): boolean {
  return (
    inputs.cache === "invalid" ||
    inputs.cache === "unverified" ||
    inputs.engine?.invalidating === true
  );
}

export function deriveNotices(inputs: StatusInputs): Notice[] {
  const out: Notice[] = [];
  const { engine, outbox } = inputs;
  const stopped = engine?.kind === "stopped" ? engine.cause : null;
  const cache: "valid" | "invalid" = cacheHidden(inputs) ? "invalid" : "valid";

  if (stopped === "floor")
    out.push({
      kind: "floor",
      variant: cacheHidden(inputs) ? "b" : "a",
    });
  if (
    stopped === "storage_full" ||
    (outbox?.kind === "stopped" && outbox.cause === "storage_full")
  )
    out.push({ kind: "storage_full", cache });
  if (stopped === "local_storage")
    out.push({
      kind: "page_not_saved",
      memoryOnly: engine?.kind === "stopped" && engine.memoryOnly === true,
    });
  if (
    inputs.storageNotResponding ||
    (outbox?.kind === "stopped" && outbox.cause === "local_storage")
  )
    out.push({
      kind: "storage_not_responding",
      memoryOnly:
        inputs.storageMemoryOnly === true ||
        (outbox?.kind === "stopped" && outbox.memoryOnly === true),
    });
  if (outbox?.kind === "paused")
    out.push({
      kind: "compat_paused",
      reason: outbox.reason === "compat_missing" ? "missing" : "unsupported",
    });
  if (engine?.kind === "paused")
    out.push({ kind: "still_trying", scope: "updates", count: 1 });
  if (outbox?.kind === "needs_retry")
    out.push({ kind: "still_trying", scope: "changes", count: outbox.count });
  if (stopped === "device_capacity") out.push({ kind: "device_capacity" });
  if (stopped === "unrecognised") out.push({ kind: "unrecognised" });
  if (inputs.summary?.warn === true)
    out.push({ kind: "queue_warning", total: inputs.summary.total });
  return out;
}

/**
 * What a view that reads from the CACHE shows (plan 5.7, WEB-04 wireframe 12). The shell, navigation, drafts and the queue are not
 * cache-sourced and stay interactive whatever this says.
 *
 *  - `open`: show the content;
 *  - `refreshing`: the cache is hidden while it is brought up to date ("Refreshing your data");
 *  - `floor`: the cache is hidden and WILL NOT be refreshed on this device (the floor state replaces "Refreshing").
 */
export type GateState = "open" | "refreshing" | "floor";

export function deriveGate(inputs: StatusInputs): GateState {
  if (!cacheHidden(inputs)) return "open";
  return inputs.engine?.kind === "stopped" && inputs.engine.cause === "floor"
    ? "floor"
    : "refreshing";
}
