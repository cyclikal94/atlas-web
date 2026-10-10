import { DATA_CONFIG } from "../model/config";
import type { Mention, Reconciled } from "../model/reconcile";
import {
  initialReadRetry,
  invalidateOperation,
  onLocalWriteSuccess,
} from "../model/retry";
import type { CacheRow, Captured } from "../model/types";
import type { ScanOk } from "../scan/scan";
import { type DecodeDeps, decodeChange, PageInvalid } from "../scan/validate";
import { PlanRejected } from "../store/port";
import { guardedPlan } from "./builders";
import {
  hasLocalWork,
  interestingOf,
  reconcileInWindows,
} from "./reconcile-windows";

/**
 * W1: the delta page commit (plan 5.4.4; WEB-04 design 4.2). ONE transaction applies a whole page: every change in the server's
 * order, the page's `next_cursor` VERBATIM, `page_seq`, `applied_revision`, `last_synced_at`, the per-id mention records, the
 * overlay and draft reconciliation and the `resource_versions` reconciliation. A page that fails anywhere (a fault at any write,
 * an invalid element, the watchdog) aborts the transaction, so nothing of it is durable: the last valid cursor is unchanged and
 * the same page is simply requested again. That is safe because `Upsert` and `Remove` are absolute and idempotent by id.
 *
 * The guards (G3): the incarnation of the handle, a closing fence, the cursor compare-and-set, the recovery generation, the
 * ownership token and the epoch mirror, all read from the database in this transaction. The chain of the others (G1, G2, G2b) is
 * the account service's.
 *
 * BOUNDED PROCESSING (decision D-08, revised by R6). Nothing is read up front: the page is decoded ONE change at a time from byte
 * offsets the scan recorded and written in chunks, and as each chunk is written the ids it names are looked up (`interestingOf`: a
 * batched read of the tracked versions and existence rounds over the pending effects, none returning more than the window) so only
 * the ids that have local work are remembered, as small records and never as rows. When the page is written its reconciliation is done in WINDOWS of `queueWorkingSet` rows
 * (`reconcile-windows.ts`), each window's writes made before the next is read: what the transaction holds at once is a window,
 * whatever the size of the queue and whatever the page says. A page that names nothing of the local work reads none of it.
 */
export interface CommitPageInput {
  captured: Captured;
  /** The response body as bytes, and what pass 1 recorded about it. */
  bytes: Uint8Array;
  scan: ScanOk;
  /** An ISO instant, for `last_synced_at`. */
  now: string;
  decode: DecodeDeps;
  /** Elapsed milliseconds from a monotonic clock; injected so a test can drive the watchdog. */
  elapsed?: () => number;
  applyChunk?: number;
  watchdogMs?: number;
  /** Rows in hand at once while the page is reconciled (default `queueWorkingSet`); a test shrinks it to exercise the windows. */
  reconcileWindow?: number;
  /**
   * The quota reservation's `live()` (R28, revision 14): the page was admitted under a hold that the origin's other pages count only
   * while it stands, so the commit begins only while it does. Read in the step that decides what is written, before anything is.
   */
  leaseLive?: () => boolean;
  /**
   * WEB-09b: `recovery` is a catch-up page applied by the recovery job while the account is fenced (matrix 3.7.3). The page and its
   * position are applied exactly as an ordinary page's, but NOTHING of the queue is written (no draft, body or effect row, R8 of the review
   * of 10 October 2026), and no tracked version is deleted; the receipt bookkeeping it skips is owed (`recovery_reconcile_pending`) and
   * done by W26 once the account is displayed. Absent (`ordinary`): the WEB-09a behaviour, unchanged.
   */
  mode?: "ordinary" | "recovery";
}

export type CommitPageResult =
  | {
      kind: "committed";
      pageSeq: number;
      changes: number;
      /** The highest batch revision on the page, or null for an empty page. */
      revision: number | null;
      hasMore: boolean;
      stats: Reconciled["stats"];
    }
  /** The database is not in a state that takes an ordinary page: nothing was written (apart from the epoch mirror). */
  | { kind: "not_ready"; reason: "phase" | "cache_status" | "page_phase" }
  /** The hold the page was admitted under has ended (R28): nothing was written; the engine admits the page again. */
  | { kind: "lease_lapsed" };

export const commitPage = guardedPlan<CommitPageInput, null, CommitPageResult>({
  name: "data.commitPage",
  meta: {
    writer: "W1",
    guards: ["INC", "CLS", "CAS", "GEN", "OWN", "EPO"],
    quota: "cache",
  },
  scope: [
    "cache",
    "pending_effects",
    "resource_versions",
    "drafts",
    "draft_commands",
  ],
  durability: "default",

  /** Nothing is read before the page: what local work the page names is looked up as it is decoded (see the header). */
  read: async () => null,

  decide({ sync, input }) {
    if (input.leaseLive !== undefined && !input.leaseLive())
      return { result: { kind: "lease_lapsed" } };
    if (sync.phase !== "delta")
      return { result: { kind: "not_ready", reason: "phase" } };
    if (sync.cache_status !== "valid")
      return { result: { kind: "not_ready", reason: "cache_status" } };
    if (input.scan.phase !== "delta")
      return { result: { kind: "not_ready", reason: "page_phase" } };

    const { scan } = input;
    let revision: number | null = null;
    for (const batch of scan.batches)
      if (revision === null || batch.revision > revision)
        revision = batch.revision;
    const pageSeq = sync.page_seq + 1;
    const operation = `page:${input.captured.expectedPosition ?? ""}`;
    return {
      sync: {
        ...sync,
        // The cursor is stored VERBATIM; an empty page still writes it (it may be a renewed one).
        cursor: scan.nextCursor,
        page_seq: pageSeq,
        applied_revision:
          revision === null
            ? sync.applied_revision
            : Math.max(sync.applied_revision ?? revision, revision),
        last_synced_at: scan.hasMore ? sync.last_synced_at : input.now,
        // A page that commits is this operation's success, this read's success, and an admitted page for the sizing ladder.
        read_retry_states: {
          ...sync.read_retry_states,
          sync: initialReadRetry(),
        },
        local_write_streaks: onLocalWriteSuccess(
          onLocalWriteSuccess(sync.local_write_streaks, operation),
          // A page that commits moves the position on: an admitted invalidation's failures at the old one are moot (R10).
          invalidateOperation(input.captured.expectedPosition),
        ),
        sizing: { ...sync.sizing, attempt: null, floor_hits: 0 },
        // R8: a recovery-mode page skips the queue's bookkeeping; it is owed to the ordinary write after the recovery (W26).
        ...(input.mode === "recovery"
          ? { recovery_reconcile_pending: true }
          : {}),
      },
      result: {
        kind: "committed",
        pageSeq,
        changes: scan.totalChanges,
        revision,
        hasMore: scan.hasMore,
        stats: {
          mentioned: 0,
          resolvedNoPublication: 0,
          heldReleased: 0,
          unavailable: 0,
        },
      },
    };
  },

  async apply(sink, { reader, input, result }) {
    if (result.kind !== "committed") return result;
    const { scan, bytes } = input;
    const chunkSize = input.applyChunk ?? DATA_CONFIG.applyChunk;
    const window = input.reconcileWindow ?? DATA_CONFIG.queueWorkingSet;
    const watchdogMs = input.watchdogMs ?? DATA_CONFIG.syncApplyWatchdogMs;
    const elapsed = input.elapsed ?? (() => performance.now());
    // Only the ids that have local work, with the page's last word on each. Small records, never rows.
    const mentions = new Map<string, Mention>();
    // The page's last word on each id since the last lookup: at most one chunk of them.
    const chunk = new Map<string, Mention>();
    // Whether there is any local work at all (counted once, lazily): a page over an empty queue looks nothing up.
    let localWork: boolean | null = null;
    const startedAt = elapsed();
    const runs = runBuffer(chunkSize);
    // Each run is written with ONE await; everything between two awaits is synchronous (decoding a chunk issues no await at all).
    // A transaction stays alive only while requests keep being placed from the continuation of the previous request's callback,
    // so the fewer promise hops between chunks, the less there is for the engine and Dexie's zones to get wrong.
    const flush = async (run: Run | null): Promise<void> => {
      if (run === null) return;
      if (run.kind === "put") await sink.bulkPut("cache", run.rows);
      else await sink.bulkDelete("cache", run.keys);
    };
    const lookUp = async (): Promise<void> => {
      if (chunk.size === 0) return;
      localWork ??= await hasLocalWork(reader);
      if (localWork) {
        // In batches of the window, so a lookup never has more in hand than the reconciliation will.
        const ids = [...chunk.keys()];
        for (let from = 0; from < ids.length; from += window)
          for (const id of await interestingOf(
            reader,
            ids.slice(from, from + window),
            window,
          ))
            mentions.set(id, chunk.get(id) as Mention);
      }
      chunk.clear();
    };

    try {
      for (let index = 0; index < scan.totalChanges; index += 1) {
        const change = decodeChange(
          bytes,
          scan.elements[index * 2] as number,
          scan.elements[index * 2 + 1] as number,
          scan.nodes[index] as number,
          input.decode,
        );
        let ready: Run | null;
        if (change.kind === "upsert") {
          ready = runs.put(change.row);
          chunk.set(change.row.id, {
            removed: false,
            version: change.row.version,
          });
        } else {
          ready = runs.remove(change.id);
          chunk.set(change.id, { removed: true, version: null });
        }
        await flush(ready);
        if (chunk.size >= chunkSize) await lookUp();
        // A chunk boundary: the only place the watchdog looks, so a stuck apply is abandoned without an unbounded loop.
        if ((index + 1) % chunkSize === 0 && elapsed() - startedAt > watchdogMs)
          throw new PlanRejected("apply", "watchdog");
      }
      await flush(runs.take());
      await lookUp();
    } catch (error) {
      // A refusal of the page becomes a fixed-shape rejection of the TRANSACTION: everything streamed so far rolls back.
      if (error instanceof PageInvalid)
        throw new PlanRejected(error.stage, error.reason);
      throw error;
    }

    // The live edge: a final page (`has_more: false`) from a request that has a sequence number can resolve an effect the page does
    // not name, so every effect row is visited; any other page reconciles only the effects of the ids it names.
    const liveEdge = !scan.hasMore && input.captured.requestSeq !== null;
    localWork ??= await hasLocalWork(reader);
    const stats: Reconciled["stats"] = localWork
      ? await reconcileInWindows({
          reader,
          sink,
          mentions,
          facts: {
            pageSeq: result.pageSeq,
            hasMore: scan.hasMore,
            requestSeq: input.captured.requestSeq,
          },
          walkAllEffects: liveEdge,
          window,
          ...(input.mode === "recovery" ? { recovery: true } : {}),
        })
      : {
          mentioned: 0,
          resolvedNoPublication: 0,
          heldReleased: 0,
          unavailable: 0,
        };
    return { ...result, stats };
  },
});

/** One ordered run of the same kind of change. */
type Run =
  | { kind: "put"; rows: CacheRow[] }
  | { kind: "delete"; keys: string[] };

/**
 * Groups changes into ordered runs, PRESERVING ORDER: a run of upserts is one `bulkPut`, a run of removes one `bulkDelete`, and a
 * switch of kind ends the current run first, so "upsert X then remove X" is never reordered. At most `size` rows are held at once.
 * SYNCHRONOUS: `put` and `remove` return a finished run (or null) for the caller to write.
 */
function runBuffer(size: number) {
  let current: Run | null = null;
  const finish = (): Run | null => {
    const run = current;
    current = null;
    return run;
  };
  return {
    put(row: CacheRow): Run | null {
      let ready: Run | null = null;
      if (current?.kind === "delete") ready = finish();
      if (current === null) current = { kind: "put", rows: [] };
      (current as { kind: "put"; rows: CacheRow[] }).rows.push(row);
      if (
        ready === null &&
        (current as { rows: CacheRow[] }).rows.length >= size
      )
        ready = finish();
      return ready;
    },
    remove(id: string): Run | null {
      let ready: Run | null = null;
      if (current?.kind === "put") ready = finish();
      if (current === null) current = { kind: "delete", keys: [] };
      (current as { kind: "delete"; keys: string[] }).keys.push(id);
      if (ready === null && (current as { keys: string[] }).keys.length >= size)
        ready = finish();
      return ready;
    },
    take: finish,
  };
}
