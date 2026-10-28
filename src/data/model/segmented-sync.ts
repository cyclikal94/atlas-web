/**
 * Segmented delta delivery (WEB-09c, BOUNDED-SYNC-PAGINATION-20261027): the client's half of BE-Q23's opt-in finer `/sync` pagination. Pure.
 *
 * THE CONTRACT IS BE-Q23's, AND PROVISIONAL. This module is the ONE place the client spells it: BE-Q23's plan §5.2 (Option C, 11 October 2026,
 * `.agtx/plan.md` SHA-256 `e088522a…4189` of task f3852338), which the new authority asks BE-Q23 to reconcile and publish as the single
 * cross-repository contract. The pinned API types (`0.29.0-rc.1`) do not contain it, so nothing here is integration: production never opts in
 * until `DATA_CONFIG.segmentedSync.minApiVersion` is set from a released, reviewed pin. If the published contract differs, this module and its
 * tests change; the staging and activation do not.
 *
 *  - Request: `max_changes=m`, an integer in [4, 800] (4 = one change and at most three required ancestors; 800 = `Batch.changes.maxItems`).
 *    Absent: today's response exactly.
 *  - Response: a batch too large for `m` arrives as ordered SEGMENTS, one per page and alone on it, each `{ index, last }` with the batch's
 *    revision; `next_cursor` after a non-final segment is a continuation the client stores verbatim and never parses. A continuation sent
 *    without `max_changes` is answered with the remainder as one segment marked `last`.
 *
 * THE CLIENT'S RULE. A non-final segment is STAGED (W27, `delta_staging`), never shown; the final one is applied by W1 together with every
 * staged piece in ONE transaction, so the live cache moves from the whole previous revision to the whole next one. The stage records where
 * the revision began (`boundary_cursor`), so a broken sequence is abandoned by asking for the revision again from there.
 */

import type { DeltaStage } from "./types";

export const SEGMENT_CONTRACT = Object.freeze({
  parameter: "max_changes",
  /** One primary change plus at most three required ancestors. */
  minChanges: 4,
  /** `Batch.changes.maxItems`. */
  maxChanges: 800,
});

export type { DeltaStage } from "./types";

/** The row of `delta_staging`: the LAST word of the staged revision about one resource. */
export interface DeltaStagingRow<Row> {
  id: string;
  revision: number;
  removed: boolean;
  row: Row | null;
  /**
   * The `request_seq` the request that delivered this word was captured with (R20-SEG): WHEN the word was true, which the activation needs
   * because a staged word may be much older than the candidates it meets. Null: the request had none; absent (a row staged before it):
   * unknown. Either way the word is evidence about no candidate (`stagedMentionReaches`).
   */
  request_seq?: number | null;
}

/** A segment as the scan read it. */
export interface Segment {
  index: number;
  last: boolean;
}

/** Clamps a value to the contract's structural range. */
export const clampChanges = (m: number): number =>
  Math.max(
    SEGMENT_CONTRACT.minChanges,
    Math.min(SEGMENT_CONTRACT.maxChanges, Math.floor(m)),
  );

/**
 * The `max_changes` this request carries, or `null` for none.
 *  - While a revision is staged the cursor is a continuation, which only a server that segments can have issued: the request carries the
 *    budget in force (a stepped-down one first) if there is one, and otherwise none, which the contract answers with the remainder in one
 *    final segment. Either way the page may carry a segment (`allowSegment`).
 *  - Otherwise the request opts in only when the server is known to support it (`capable`) and a starting value is configured.
 */
export function maxChangesFor(input: {
  configured: number | null;
  capable: boolean;
  /** The ladder's stepped-down budget (`sizing.max_changes`), if any. */
  stepped: number | null | undefined;
  staged: boolean;
}): { maxChanges: number | null; allowSegment: boolean } {
  const budget = input.stepped ?? input.configured;
  if (input.staged)
    return {
      maxChanges: budget === null ? null : clampChanges(budget),
      allowSegment: true,
    };
  if (!input.capable || budget === null)
    return { maxChanges: null, allowSegment: false };
  return { maxChanges: clampChanges(budget), allowSegment: true };
}

/**
 * Where a page stands against the stage, decided by the writer IN ITS TRANSACTION from the stored stage:
 *  - `whole`: an ordinary page (no segment, nothing staged);
 *  - `start` / `continue`: a non-final segment to stage (the first, or the next in order);
 *  - `finish`: the final segment: activate with what is staged (`staged: false` for a revision that came in one piece);
 *  - `broken`: out of order, repeated, another revision, a segment where none was asked for, or a whole batch while a revision is staged.
 */
export type Continuity =
  | { kind: "whole" }
  | { kind: "start" }
  | { kind: "continue" }
  | { kind: "finish"; staged: boolean }
  | { kind: "broken"; reason: string };

export function continuityOf(
  stage: DeltaStage | null,
  page: { revision: number | null; segment: Segment | null },
): Continuity {
  const { segment } = page;
  if (segment === null)
    return stage === null
      ? { kind: "whole" }
      : { kind: "broken", reason: "a whole page while a revision is staged" };
  if (stage === null) {
    if (segment.index !== 0)
      return { kind: "broken", reason: "a later segment with nothing staged" };
    return segment.last ? { kind: "finish", staged: false } : { kind: "start" };
  }
  if (page.revision !== stage.revision)
    return { kind: "broken", reason: "a segment of another revision" };
  if (segment.index !== stage.next_index)
    return { kind: "broken", reason: "a segment out of order" };
  return segment.last ? { kind: "finish", staged: true } : { kind: "continue" };
}

/** The stage in force: the row's, while the row's cursor is still the one it stored (absent, or retired by a newer cursor: none). */
export const stageOf = (sync: {
  cursor: string | null;
  delta_stage?: DeltaStage | null;
}): DeltaStage | null => {
  const stage = sync.delta_stage ?? null;
  return stage !== null && stage.cursor === sync.cursor ? stage : null;
};
