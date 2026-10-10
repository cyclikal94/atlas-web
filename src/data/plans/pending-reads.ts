import type {
  DraftRow,
  DraftStatus,
  DraftWithCommand,
  ResourceId,
} from "../model/types";
import { range } from "../store/port";
import { bulkGetWindowed, WINDOW, walkIndex } from "./bounded-reads";
import { readPlan } from "./builders";

/**
 * Two READ plans a feature screen needs over the outbox that the merged reads deliberately do not give (WEB-13a, D-13a-4):
 *
 *  - `readPendingCreates`: this device's saves that CREATE a resource the cache does not hold yet. A queued create has no
 *    `pending_effects` row until it is claimed, so `readResourceList` (which lists the cache) cannot show the "Pending — will create
 *    when back online" row; and `readMerged` reads drafts only for one id the caller already knows.
 *  - `readOutstanding`: the unsettled drafts that target one resource, counted by status, with the newest of them: what a row needs to
 *    say "Queued — will apply once synced", "Saving — will confirm on next sync" or "Needs a decision". `readMerged` reads no drafts for
 *    a resource the cache holds.
 *
 * Both are R21 reads: no single read returns more than `queueWorkingSet` rows, a population is reduced as it is read (a count, a fold,
 * the oldest window), the `total` is exact, and only ONE window of bodies is ever read. They write nothing.
 *
 * "Unsettled" is every draft still in the store except a superseded one: queued, in flight, a conflict, rejected, blocked, or
 * acknowledged. An acknowledged draft leaves the store once its overlay is released (a delta page published the resource, or the live
 * edge showed nothing will) and its flags are clear, so one that is still here is a change the server has receipted and this device
 * has not yet seen published: "Saving — will confirm on next sync".
 */
const unsettled = (row: DraftRow): boolean => row.status !== "superseded";

/** One window of the creates of one kind whose resource the cache does not hold, oldest first. */
export interface PendingCreatesPage {
  /**
   * At most `queueWorkingSet` drafts after the cursor, oldest first by `created_seq`, each with its body: only drafts of `kind` that are
   * unsettled and whose FIRST primary target is not in the cache.
   */
  drafts: DraftWithCommand[];
  /** The exact number of such drafts, wherever they are. */
  total: number;
  /** The `created_seq` to pass back as `after` for the next window, or null when this is the last. */
  next: number | null;
}

export interface PendingCreatesInput {
  incarnationId: string;
  /** The command kind as the header records it (`DraftRow.kind`, for example `create_source`). */
  kind: string;
  after?: number | null;
}

/**
 * The creates of one kind that the cache does not hold yet (see above). It walks `created_seq` a window of HEADERS at a time (the store
 * has no index by kind, and a create's id is not known in advance), looks up the window's candidate ids in the cache in one bounded
 * `bulkGet`, keeps the oldest window after the cursor and counts the rest, and reads the bodies of the window it keeps and no others.
 */
export const readPendingCreates = readPlan<
  PendingCreatesInput,
  { drafts: DraftWithCommand[]; total: number; next: number | null },
  PendingCreatesPage
>({
  name: "data.readPendingCreates",
  scope: ["drafts", "draft_commands", "cache"],
  read: async (reader, input) => {
    const after = input.after ?? null;
    const kept: DraftRow[] = [];
    let total = 0;
    let later = 0;
    let cursor: number | null = null;
    for (;;) {
      const rows: DraftRow[] = await reader.byIndex(
        "drafts",
        "created_seq",
        cursor === null ? range.all() : range.atLeast(cursor, true),
        WINDOW,
      );
      const candidates = rows.filter(
        (row) =>
          row.kind === input.kind &&
          unsettled(row) &&
          row.target_resource_ids[0] !== undefined,
      );
      if (candidates.length > 0) {
        const cached = await reader.bulkGet(
          "cache",
          candidates.map((row) => row.target_resource_ids[0] as ResourceId),
        );
        candidates.forEach((row, index) => {
          if (cached[index] !== undefined) return;
          total += 1;
          if (after !== null && row.created_seq <= after) return;
          later += 1;
          if (kept.length < WINDOW) kept.push(row);
        });
      }
      const tail = rows[rows.length - 1];
      if (rows.length < WINDOW || tail === undefined) break;
      cursor = tail.created_seq;
    }
    const bodies = await bulkGetWindowed(
      reader,
      "draft_commands",
      kept.map((row) => row.local_id),
    );
    const last = kept[kept.length - 1];
    return {
      drafts: kept.flatMap((row, index) => {
        const body = bodies[index];
        return body ? [{ ...row, command: body.command }] : [];
      }),
      total,
      next: later > kept.length && last !== undefined ? last.created_seq : null,
    };
  },
  decide: ({ reads }) => reads,
});

/** The unsettled drafts that target one resource. */
export interface Outstanding {
  /** Every unsettled draft whose `index_targets` names the resource (a primary target or a side effect). */
  total: number;
  /** The same drafts, counted by status: exact. */
  byStatus: Partial<Record<DraftStatus, number>>;
  /** The NEWEST of them (the largest `created_seq`), with its body, or null when there is none. */
  latest: DraftWithCommand | null;
}

export interface OutstandingInput {
  incarnationId: string;
  id: ResourceId;
}

/**
 * The unsettled drafts against one resource (see above): its `index_targets` population is walked a window at a time and folded into
 * exact counts and the newest header; only that one draft's body is read.
 */
export const readOutstanding = readPlan<
  OutstandingInput,
  Outstanding,
  Outstanding
>({
  name: "data.readOutstanding",
  scope: ["drafts", "draft_commands"],
  read: async (reader, input) => {
    let total = 0;
    const byStatus: Partial<Record<DraftStatus, number>> = {};
    let newest: DraftRow | null = null;
    await walkIndex(
      reader,
      "drafts",
      "index_targets",
      range.only(input.id),
      (row) => {
        if (!unsettled(row)) return;
        total += 1;
        byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
        if (newest === null || row.created_seq > newest.created_seq)
          newest = row;
      },
    );
    const latest = newest as DraftRow | null;
    const body =
      latest === null
        ? undefined
        : await reader.get("draft_commands", latest.local_id);
    return {
      total,
      byStatus,
      latest:
        latest === null || body === undefined
          ? null
          : { ...latest, command: body.command },
    };
  },
  decide: ({ reads }) => reads,
});
