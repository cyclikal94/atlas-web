import { DATA_CONFIG } from "../model/config";
import { initialReadRetry, onLocalWriteSuccess } from "../model/retry";
import type { DeltaStagingStoreRow } from "../model/schema";
import { continuityOf, stageOf } from "../model/segmented-sync";
import type { Captured, DeltaStage, SyncStateRow } from "../model/types";
import type { ScanOk } from "../scan/scan";
import { type DecodeDeps, decodeChange, PageInvalid } from "../scan/validate";
import { PlanRejected, type Write, w } from "../store/port";
import { guardedPlan } from "./builders";

/**
 * W27: one NON-FINAL segment of a delta revision into `delta_staging` (WEB-09c, segmented delivery; `model/segmented-sync.ts`).
 *
 * ONE transaction stages the segment and moves the position: the segment's changes are decoded one at a time from the offsets the scan recorded
 * (the same bounded decode as W1) and written as the LAST WORD per resource id, chunk by chunk, so nothing larger than a chunk is ever in hand;
 * `sync_state.cursor` becomes the segment's continuation VERBATIM and `delta_stage` records where the revision began and which segment comes
 * next. NOTHING the person can see changes: not the cache, not `applied_revision`, `last_synced_at` or `page_seq`, not the queue, the
 * overlays or the composition generation. The final segment is W1's (`commitPage`), which applies every staged word and its own changes in
 * one transaction.
 *
 * A page that does not continue the stage (out of order, repeated, another revision, a later segment with nothing staged, a non-final
 * segment that says the feed ends) is NOT staged: the stage is abandoned (`restartStage`) and the result is `restarted`, which the engine
 * counts as an unrecognised answer. Guarded like W1 (INC, CLS, CAS, GEN, OWN, EPO): a duplicated or late response for a cursor that has since
 * moved is dropped by CAS and stages nothing twice.
 */
export interface StageSegmentInput {
  captured: Captured;
  bytes: Uint8Array;
  scan: ScanOk;
  /** Client clock (ms), for `delta_stage.started_at`. */
  now: number;
  decode: DecodeDeps;
  elapsed?: () => number;
  applyChunk?: number;
  watchdogMs?: number;
  /** The quota reservation's `live()` (R28): the segment's growth is admitted like a page's. */
  leaseLive?: () => boolean;
}

export type StageSegmentResult =
  | { kind: "staged"; revision: number; index: number; changes: number }
  | {
      kind: "not_ready";
      reason: "phase" | "cache_status" | "page_phase" | "segment";
    }
  | { kind: "restarted"; reason: string }
  | { kind: "lease_lapsed" };

/**
 * The abandonment of a broken stage, as a decision of the writer that found it: the staged words are cleared and the position goes back to
 * where the revision began (with no stage in force, the position stays). Nothing live changes. The next request asks for the revision again.
 */
export function restartStage(
  sync: SyncStateRow,
  reason: string,
): {
  writes?: Write[];
  sync?: SyncStateRow;
  result: { kind: "restarted"; reason: string };
} {
  const stage = stageOf(sync);
  // Nothing staged and nothing left behind: there is nothing to abandon, and nothing is written.
  if (stage === null && sync.delta_stage == null)
    return { result: { kind: "restarted", reason } };
  return {
    writes: [w.clear("delta_staging")],
    sync: {
      ...sync,
      cursor: stage === null ? sync.cursor : stage.boundary_cursor,
      delta_stage: null,
    },
    result: { kind: "restarted", reason },
  };
}

export const stageDeltaSegment = guardedPlan<
  StageSegmentInput,
  null,
  StageSegmentResult
>({
  name: "data.stageDeltaSegment",
  meta: {
    writer: "W27",
    guards: ["INC", "CLS", "CAS", "GEN", "OWN", "EPO"],
    quota: "cache",
  },
  scope: ["delta_staging"],
  durability: "default",
  read: async () => null,

  decide({ sync, input }) {
    if (input.leaseLive !== undefined && !input.leaseLive())
      return { result: { kind: "lease_lapsed" } };
    if (sync.phase !== "delta")
      return { result: { kind: "not_ready", reason: "phase" } };
    if (sync.cache_status !== "valid")
      return { result: { kind: "not_ready", reason: "cache_status" } };
    const { scan } = input;
    if (scan.phase !== "delta")
      return { result: { kind: "not_ready", reason: "page_phase" } };
    const batch = scan.batches.length === 1 ? scan.batches[0] : undefined;
    // Only a non-final segment is this writer's; anything else reaching it is a routing defect, and writes nothing.
    if (batch?.segment === undefined || batch.segment.last)
      return { result: { kind: "not_ready", reason: "segment" } };
    const stage = stageOf(sync);
    const continuity = continuityOf(stage, {
      revision: batch.revision,
      segment: batch.segment,
    });
    if (continuity.kind === "broken")
      return restartStage(sync, continuity.reason);
    if (!scan.hasMore)
      return restartStage(sync, "a non-final segment that ends the feed");
    if (continuity.kind === "start" && sync.cursor === null)
      return { result: { kind: "not_ready", reason: "page_phase" } };

    const next: DeltaStage =
      continuity.kind === "start" || stage === null
        ? {
            revision: batch.revision,
            next_index: 1,
            boundary_cursor: sync.cursor as string,
            cursor: scan.nextCursor,
            changes: scan.totalChanges,
            bytes: scan.stats.bytes,
            started_at: input.now,
          }
        : {
            ...stage,
            next_index: stage.next_index + 1,
            cursor: scan.nextCursor,
            changes: stage.changes + scan.totalChanges,
            bytes: stage.bytes + scan.stats.bytes,
          };
    const operation = `page:${input.captured.expectedPosition ?? ""}`;
    return {
      // A first segment begins from an empty staging store: nothing of an earlier, retired stage can join this revision.
      writes: continuity.kind === "start" ? [w.clear("delta_staging")] : [],
      sync: {
        ...sync,
        cursor: scan.nextCursor,
        delta_stage: next,
        // A staged segment is a success of the read, but NOT the end of an unrecognised streak: only the activation of the whole
        // revision ends that, or a server that broke every revision after its first segment would be asked again for ever.
        read_retry_states: {
          ...sync.read_retry_states,
          sync: {
            ...initialReadRetry(),
            unrecognised_streak:
              sync.read_retry_states.sync?.unrecognised_streak ?? 0,
          },
        },
        local_write_streaks: onLocalWriteSuccess(
          sync.local_write_streaks,
          operation,
        ),
        // A staged segment is an admitted page for the sizing ladder (W1's rule).
        sizing: { ...sync.sizing, attempt: null, floor_hits: 0 },
      },
      result: {
        kind: "staged",
        revision: batch.revision,
        index: batch.segment.index,
        changes: scan.totalChanges,
      },
    };
  },

  async apply(sink, { input, result }) {
    if (result.kind !== "staged") return result;
    const { scan, bytes } = input;
    const chunkSize = input.applyChunk ?? DATA_CONFIG.applyChunk;
    const watchdogMs = input.watchdogMs ?? DATA_CONFIG.syncApplyWatchdogMs;
    const elapsed = input.elapsed ?? (() => performance.now());
    const startedAt = elapsed();
    // The last word per id within one chunk; a later chunk's (or segment's) put of the same id replaces it, in order.
    const words = new Map<string, DeltaStagingStoreRow>();
    const flush = async (): Promise<void> => {
      if (words.size === 0) return;
      const rows = [...words.values()];
      words.clear();
      await sink.bulkPut("delta_staging", rows);
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
        const id = change.kind === "upsert" ? change.row.id : change.id;
        // Re-inserted so the map's order is the order of last words.
        words.delete(id);
        words.set(
          id,
          change.kind === "upsert"
            ? { id, revision: result.revision, removed: false, row: change.row }
            : { id, revision: result.revision, removed: true, row: null },
        );
        if (words.size >= chunkSize) await flush();
        if ((index + 1) % chunkSize === 0 && elapsed() - startedAt > watchdogMs)
          throw new PlanRejected("apply", "watchdog");
      }
      await flush();
    } catch (error) {
      if (error instanceof PageInvalid)
        throw new PlanRejected(error.stage, error.reason);
      throw error;
    }
    return result;
  },
});
