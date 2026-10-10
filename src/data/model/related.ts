import { isTerminal } from "./outbox";
import type { DraftRow, ResourceId } from "./types";

/**
 * What the outbox needs to know about the drafts that share a target with the one it is deciding about, reduced as the population is
 * read so that no more than a few HEADERS of it are ever held (R21, revision 9). A target can be shared by any number of drafts (offline
 * input is not capped), and every reader of "the other drafts that touch this id" asks one of three questions of the population, none of
 * which needs the population itself:
 *
 *  - `latest`: the LAST draft against the target that is not terminal, by `created_seq`: what a new draft waits on (`dependencies`);
 *  - `earliest`: the FIRST one: the dispatcher's rule that a draft never overtakes an earlier unsettled draft against one of its
 *    targets (`candidateEligibility`): a draft is held back by the target exactly when `earliest` is older than it;
 *  - `floor`: among the outstanding drafts that raised the version of the target, the one whose base is highest: the version the record
 *    must not fall below while any of them stands (`recomputeVersions`).
 *
 * Non-terminal and OUTSTANDING are the same five statuses (`queued`, `in_flight`, `version_conflict`, `operation_conflict`, `blocked`),
 * so `latest` also says whether any outstanding draft still targets the id. The fold is fed one row at a time, in any order, in any
 * windows, and keeps at most these three rows. `rows()` (`latest` and `floor`) is a list that stands in for the population in the
 * pure decisions that take "the other drafts" (`planEnqueue`, `recomputeVersions`) and gives the same answer as the whole of it, and
 * `earliest` is what the dispatcher asks (`tests/data/related-fold.test.ts` holds each to the full list).
 */
export class TargetFold {
  latest: DraftRow | undefined;
  earliest: DraftRow | undefined;
  floor: DraftRow | undefined;

  constructor(readonly id: ResourceId) {}

  /** A draft whose `index_targets` names this target. */
  add(row: DraftRow): void {
    if (isTerminal(row)) return;
    if (this.latest === undefined || row.created_seq > this.latest.created_seq)
      this.latest = row;
    if (
      this.earliest === undefined ||
      row.created_seq < this.earliest.created_seq
    )
      this.earliest = row;
    if (
      row.bumped.includes(this.id) &&
      row.bases[this.id] !== undefined &&
      (this.floor === undefined ||
        (row.bases[this.id] as number) > (this.floor.bases[this.id] as number))
    )
      this.floor = row;
  }

  /** The distinct rows that stand in for the population in `planEnqueue` and `recomputeVersions` (at most two). */
  rows(): DraftRow[] {
    const out = new Map<string, DraftRow>();
    for (const row of [this.latest, this.floor])
      if (row !== undefined) out.set(row.local_id, row);
    return [...out.values()];
  }
}

/**
 * The OLDEST `size` of a population of drafts, by `created_seq`, and its exact size (R21, revision 10): what the merged read of one
 * resource the cache does not hold needs of the drafts that target it. Offline input is not capped, so a new resource can have any
 * number of saved edits queued behind it, and the read must neither hold nor join the bodies of all of them. The fold is fed one
 * header at a time, in any order and in any windows (the store reads `index_targets` by key, which is not `created_seq` order), and
 * keeps at most `size` headers: the population's `total` is exact and nothing is dropped from the queue, only from this page of it.
 *
 * `after` is the cursor of a later page (the `created_seq` the previous page ended at): headers at or before it are counted in
 * `total` and skipped. `next` is where the following page begins (the last header kept) when more follow, else null, so a caller that
 * passes it back meets every header exactly once, whatever is added or removed between the reads.
 */
export class OldestDrafts {
  /** Every header offered, whatever its place. */
  total = 0;
  private after = 0;
  private later = 0;
  private kept: DraftRow[] = [];

  constructor(
    readonly size: number,
    after: number | null = null,
  ) {
    this.after = after ?? 0;
  }

  add(row: DraftRow): void {
    this.total += 1;
    if (row.created_seq <= this.after) return;
    this.later += 1;
    const at = this.kept.findIndex(
      (held) => held.created_seq > row.created_seq,
    );
    if (at === -1) this.kept.push(row);
    else this.kept.splice(at, 0, row);
    if (this.kept.length > this.size) this.kept.length = this.size;
  }

  /** The oldest headers after the cursor, oldest first, at most `size`. */
  rows(): DraftRow[] {
    return [...this.kept];
  }

  /** The cursor of the next page: the last header kept when more follow it, else null. */
  get next(): number | null {
    const last = this.kept[this.kept.length - 1];
    return this.later > this.kept.length && last !== undefined
      ? last.created_seq
      : null;
  }
}
