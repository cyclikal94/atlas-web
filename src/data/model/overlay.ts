import type {
  CacheRow,
  DraftWithCommand,
  PendingEffectRow,
  ProjectionPatch,
} from "./types";

/**
 * Reading with the overlay (plan 5.5.6, WEB-04 D:2047, D:911): a resource as it is in the cache, with each admitted change layered
 * over it in the order the changes were made. `display` is a `ProjectionPatch` (`label`, `archived`, and a SHALLOW merge of the
 * keys of `value`): a later effect's field wins and a field no effect touches falls through to the cache. Richer per-command
 * reducers are a feature slice's (CommandRegistry); this generic merge is the data layer's public contract.
 *
 * `by_resource` is NOT an ordering: rows are ordered by their own copied `created_at`, with `local_id` as the tie-break.
 */
export interface MergedResource {
  base: CacheRow | null;
  /** Ordered by `created_at` then `local_id`. */
  effects: PendingEffectRow[];
  /**
   * The queued and in-flight drafts for this id that the cache does not hold it for yet, WITH their bodies (a projection needs the
   * command): the OLDEST window of them, `queueWorkingSet` (100) at most, oldest first by `created_seq`, so the create that introduces
   * the resource comes first. A new resource can have any number of saved edits queued behind it (offline input is not capped) and the
   * read neither holds nor joins the bodies of all of them (R21, revision 10); every one is still queued, sent and counted. A
   * resource the cache holds projects none, and its drafts are not read at all.
   */
  creates: DraftWithCommand[];
  /** How many such drafts there are in all, exactly (`creates.length` when they fit in one window). */
  createsTotal: number;
  /** Where the next window of `creates` begins (pass it as `after`: the `created_seq` the previous window ended at), or null on the last. */
  createsNext: number | null;
  merged: CacheRow | null;
}

export function orderEffects(
  effects: readonly PendingEffectRow[],
): PendingEffectRow[] {
  return [...effects].sort((a, b) =>
    a.created_at < b.created_at
      ? -1
      : a.created_at > b.created_at
        ? 1
        : a.local_id < b.local_id
          ? -1
          : a.local_id > b.local_id
            ? 1
            : 0,
  );
}

/** One patch over one row. Returns a new row; never edits its argument. */
export function applyPatch(row: CacheRow, patch: ProjectionPatch): CacheRow {
  return {
    ...row,
    ...(patch.label === undefined ? {} : { label: patch.label }),
    ...(patch.archived === undefined ? {} : { archived: patch.archived }),
    ...(patch.value === undefined
      ? {}
      : {
          value: {
            ...(row.value ?? {}),
            ...(patch.value as Record<string, never>),
          },
        }),
  };
}

export function mergeResource(
  base: CacheRow | null,
  effects: readonly PendingEffectRow[],
  creates: readonly DraftWithCommand[] = [],
  /** A feature slice's projection of a create that is not in the cache yet (CommandRegistry.projectCreate). */
  projectCreate?: (draft: DraftWithCommand) => CacheRow | null,
  /** Where `creates` is a window of a larger population: its exact size and the cursor of the next window. */
  window: { total?: number; next?: number | null } = {},
): MergedResource {
  const ordered = orderEffects(effects);
  let merged: CacheRow | null = base;
  if (merged === null && projectCreate)
    for (const draft of creates) {
      const projected = projectCreate(draft);
      if (projected !== null) {
        merged = projected;
        break;
      }
    }
  if (merged !== null)
    for (const effect of ordered)
      if (effect.display !== null) merged = applyPatch(merged, effect.display);
  return {
    base,
    effects: ordered,
    creates: [...creates],
    createsTotal: window.total ?? creates.length,
    createsNext: window.next ?? null,
    merged,
  };
}

// ---- the overlay of a LIST, reduced as it is read (R14) ---------------------------------------------------------------------------
/**
 * What a list shows of one resource is `base` with every outstanding change over it applied. A resource can have any number of them
 * (offline input is not capped), and a list of 100 resources must not hold all of them at once, so a change is FOLDED into this small
 * state as it is read and then dropped: the state is bounded by the fields the patches name, never by how many patches there are.
 *
 * The fold is the sequential `applyPatch` over the effects in (`created_at`, `local_id`) order, written so that the ORDER THE EFFECTS
 * ARE READ IN does not matter: a patch only sets a field (`label`, `archived`, one key of `value`), so the value a field ends with is
 * the one of the LATEST effect that names it, whichever window it came in. `foldEffect` keeps, per field, the latest effect's value and
 * its (`created_at`, `local_id`) position; `applyOverlay` applies them. Equal to `mergeResource(base, effects).merged` for every
 * population of effects and every way of cutting it into windows (`tests/data/overlay-fold.test.ts`).
 */
interface Latest<T> {
  at: string;
  id: string;
  value: T;
}

export interface Overlay {
  /** Every outstanding change over the resource, whether or not it carries a display patch. */
  pending: number;
  label: Latest<string> | null;
  archived: Latest<boolean> | null;
  /** `null`: no change carries a `value` patch, so the cached `value` is left exactly as it is. */
  value: Map<string, Latest<unknown>> | null;
}

export const emptyOverlay = (): Overlay => ({
  pending: 0,
  label: null,
  archived: null,
  value: null,
});

const newer = (
  held: { at: string; id: string } | null | undefined,
  effect: PendingEffectRow,
): boolean =>
  held === null ||
  held === undefined ||
  effect.created_at > held.at ||
  (effect.created_at === held.at && effect.local_id > held.id);

/** Folds one change into the state (in place). Reads the effect and keeps nothing of it but the fields it is the latest to name. */
export function foldEffect(overlay: Overlay, effect: PendingEffectRow): void {
  overlay.pending += 1;
  const patch = effect.display;
  if (patch === null) return;
  const at = effect.created_at;
  const id = effect.local_id;
  if (patch.label !== undefined && newer(overlay.label, effect))
    overlay.label = { at, id, value: patch.label };
  if (patch.archived !== undefined && newer(overlay.archived, effect))
    overlay.archived = { at, id, value: patch.archived };
  if (patch.value !== undefined) {
    overlay.value ??= new Map();
    for (const [field, value] of Object.entries(patch.value))
      if (newer(overlay.value.get(field), effect))
        overlay.value.set(field, { at, id, value });
  }
}

/** `base` with the folded changes applied: a new row, never an edit of `base`. */
export function applyOverlay(base: CacheRow, overlay: Overlay): CacheRow {
  let merged = base;
  if (overlay.label !== null)
    merged = { ...merged, label: overlay.label.value };
  if (overlay.archived !== null)
    merged = { ...merged, archived: overlay.archived.value };
  if (overlay.value !== null)
    merged = {
      ...merged,
      value: {
        ...(merged.value ?? {}),
        ...Object.fromEntries(
          [...overlay.value].map(([field, held]) => [field, held.value]),
        ),
      } as CacheRow["value"],
    };
  return merged;
}
