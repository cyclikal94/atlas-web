import type { Observation } from "../model/observation";
import { applyOverlay } from "../model/overlay";
import type {
  CacheRow,
  DraftRow,
  DraftStatus,
  DraftWithCommand,
  ResourceId,
} from "../model/types";
import { type Reader, range } from "../store/port";
import {
  bulkGetWindowed,
  readObservation,
  WINDOW,
  walkIndex,
} from "./bounded-reads";
import { readPlan } from "./builders";
import { readOverlays } from "./overlay-windows";

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
  /**
   * The newest of them of the kind asked for (`OutstandingInput.kind`) that is still expected to APPLY (queued, in flight or
   * acknowledged; never a conflict, a rejection or a blocked one), whose first primary target is the resource, with its body; null when
   * there is none or no kind was asked for. A newer draft of another kind (an import queued after a settings change) does not hide it.
   */
  latestOfKind: DraftWithCommand | null;
}

export interface OutstandingInput {
  incarnationId: string;
  id: ResourceId;
  /** The command kind whose newest applicable draft is wanted as `latestOfKind` (for example `configure_source`). */
  kind?: string;
}

/** A draft that is still expected to apply: what a screen may show as the values the person asked for. */
const applies = (row: DraftRow): boolean =>
  row.status === "queued" ||
  row.status === "in_flight" ||
  row.status === "acknowledged";

/** Folds the drafts that name one resource into exact counts, the newest header, and the newest of each kind asked for. */
class OutstandingFold {
  total = 0;
  byStatus: Partial<Record<DraftStatus, number>> = {};
  newest: DraftRow | null = null;
  /** By kind: the newest unsettled draft of that kind whose first primary target is the resource, whatever its status. */
  readonly newestOf = new Map<string, DraftRow>();
  /** By kind: the same, among the drafts that still apply (`applies`). */
  readonly applicableOf = new Map<string, DraftRow>();

  constructor(
    private readonly id: ResourceId,
    private readonly kinds: readonly string[],
  ) {}

  add(row: DraftRow): void {
    if (!unsettled(row)) return;
    this.total += 1;
    this.byStatus[row.status] = (this.byStatus[row.status] ?? 0) + 1;
    if (this.newest === null || row.created_seq > this.newest.created_seq)
      this.newest = row;
    if (
      !this.kinds.includes(row.kind) ||
      row.target_resource_ids[0] !== this.id
    )
      return;
    const newer = (held: DraftRow | undefined) =>
      held === undefined || row.created_seq > held.created_seq;
    if (newer(this.newestOf.get(row.kind))) this.newestOf.set(row.kind, row);
    if (applies(row) && newer(this.applicableOf.get(row.kind)))
      this.applicableOf.set(row.kind, row);
  }
}

/** The bodies of `rows` (one bounded read), joined to them by `local_id`; a draft whose body is missing is left out. */
async function withBodies(
  reader: Reader,
  rows: readonly DraftRow[],
): Promise<Map<string, DraftWithCommand>> {
  const unique = [...new Map(rows.map((row) => [row.local_id, row])).values()];
  const bodies = await bulkGetWindowed(
    reader,
    "draft_commands",
    unique.map((row) => row.local_id),
  );
  const out = new Map<string, DraftWithCommand>();
  unique.forEach((row, index) => {
    const body = bodies[index];
    if (body) out.set(row.local_id, { ...row, command: body.command });
  });
  return out;
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
    const fold = new OutstandingFold(
      input.id,
      input.kind === undefined ? [] : [input.kind],
    );
    await walkIndex(
      reader,
      "drafts",
      "index_targets",
      range.only(input.id),
      (row) => fold.add(row),
    );
    const { bodies: _, ...outstanding } = await outstandingOf(
      reader,
      fold,
      input.kind,
    );
    return outstanding;
  },
  decide: ({ reads }) => reads,
});

/** The fold as an `Outstanding`, reading the bodies of its newest draft and of the newest applicable draft of `kind` (at most two). */
async function outstandingOf(
  reader: Reader,
  fold: OutstandingFold,
  kind: string | undefined,
  more: readonly DraftRow[] = [],
): Promise<Outstanding & { bodies: Map<string, DraftWithCommand> }> {
  const ofKind = kind === undefined ? undefined : fold.applicableOf.get(kind);
  const bodies = await withBodies(reader, [
    ...(fold.newest === null ? [] : [fold.newest]),
    ...(ofKind === undefined ? [] : [ofKind]),
    ...more,
  ]);
  return {
    total: fold.total,
    byStatus: fold.byStatus,
    latest:
      fold.newest === null ? null : (bodies.get(fold.newest.local_id) ?? null),
    latestOfKind:
      ofKind === undefined ? null : (bodies.get(ofKind.local_id) ?? null),
    bodies,
  };
}

/**
 * One resource as ONE read transaction saw it (WEB-13a revision 2): what a dialog that edits it needs so that everything it shows and
 * every value it saves come from the same moment.
 */
export interface ResourceView {
  /** The cached row, or null when the cache does not hold the resource. */
  base: CacheRow | null;
  /** `base` with the overlay of its admitted changes (as a list shows it), or null with it. */
  merged: CacheRow | null;
  /** The unsettled drafts that name the resource, as `readOutstanding` counts them (`latestOfKind` for `settingsKind`). */
  outstanding: Outstanding;
  /**
   * The newest unsettled draft of `createKind` whose first primary target is the resource, WHATEVER its status (a create waiting, sent,
   * receipted and not yet published, or refused), with its body; null when there is none or no kind was asked for.
   */
  create: DraftWithCommand | null;
  /** What this read saw, for a save made from it (`EnqueueRequest.observed`): checked again inside the writing transaction. */
  observation: Observation;
}

export interface ResourceViewInput {
  incarnationId: string;
  id: ResourceId;
  /** The kind of command that creates the resource (`create_source`). */
  createKind?: string;
  /** The kind of command whose newest applicable draft states the resource's settings (`configure_source`). */
  settingsKind?: string;
}

/**
 * The resource view (see above): its cached row and overlay, its outstanding drafts and the observation token, from ONE walk of the
 * drafts that name it. At most three bodies are read (the newest draft, the newest applicable settings draft, the newest create).
 */
export const readResourceView = readPlan<
  ResourceViewInput,
  ResourceView,
  ResourceView
>({
  name: "data.readResourceView",
  scope: [
    "cache",
    "pending_effects",
    "resource_versions",
    "drafts",
    "draft_commands",
  ],
  read: async (reader, input) => {
    const kinds = [input.createKind, input.settingsKind].filter(
      (kind): kind is string => kind !== undefined,
    );
    const fold = new OutstandingFold(input.id, kinds);
    const seen = await readObservation(
      reader,
      input.incarnationId,
      input.id,
      (row) => fold.add(row),
    );
    const create =
      input.createKind === undefined
        ? undefined
        : fold.newestOf.get(input.createKind);
    const { bodies, ...outstanding } = await outstandingOf(
      reader,
      fold,
      input.settingsKind,
      create === undefined ? [] : [create],
    );
    const base = seen.base ?? null;
    const overlay =
      base === null
        ? null
        : ((await readOverlays(reader, [base.id], WINDOW)).get(base.id) ??
          null);
    return {
      base,
      merged:
        base === null
          ? null
          : overlay === null
            ? base
            : applyOverlay(base, overlay),
      outstanding,
      create:
        create === undefined ? null : (bodies.get(create.local_id) ?? null),
      observation: { resourceId: input.id, token: seen.token },
    };
  },
  decide: ({ reads }) => reads,
});
