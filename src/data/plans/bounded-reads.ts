import { DATA_CONFIG } from "../model/config";
import { ObservationFold } from "../model/observation";
import { TargetFold } from "../model/related";
import type { RowOf, StoreName } from "../model/schema";
import type {
  CacheRow,
  DraftRow,
  LocalId,
  ResourceId,
  ResourceVersionRow,
} from "../model/types";
import { type Key, type KeyRange, type Reader, range } from "../store/port";

/**
 * Reads of the outbox that are BOUNDED by a window, whatever the size of the population they ask about (R21, revision 9).
 *
 * The outbox keeps every change a person makes offline (nothing is capped), so a target, a status or a review can be shared by any
 * number of drafts. Every read below asks the store for at most `window` rows at a time (`queueWorkingSet`, 100) and either reduces
 * what it reads as it goes (a fold, a count, a minimum) or hands it to the caller window by window; none reads a whole population into
 * one array, and none leaves a population's rows held after the window has been looked at. They run inside ONE read transaction (the
 * plan's `read`), so a walk by offset meets every row once, and a loop is bounded by the COUNT taken at its start, never by its own
 * bookkeeping.
 */
export const WINDOW = DATA_CONFIG.queueWorkingSet;

/** Walks the entries of an index in `window`-row windows, handing each row to `visit` and keeping none of them. */
export async function walkIndex<K extends StoreName>(
  reader: Reader,
  store: K,
  index: string,
  key: KeyRange,
  visit: (row: RowOf<K>) => void,
  window: number = WINDOW,
): Promise<void> {
  const size = Math.max(1, window);
  const windows = Math.ceil((await reader.count(store, index, key)) / size);
  for (let at = 0; at < windows; at += 1) {
    const rows = await reader.byIndex(store, index, key, size, at * size);
    for (const row of rows) visit(row);
    if (rows.length < size) return;
  }
}

/** Every row of an index range, read a window at a time: for a result the caller must hold (a cascade is one atomic unit). */
export async function collectIndex<K extends StoreName>(
  reader: Reader,
  store: K,
  index: string,
  key: KeyRange,
  window: number = WINDOW,
): Promise<RowOf<K>[]> {
  const out: RowOf<K>[] = [];
  await walkIndex(reader, store, index, key, (row) => out.push(row), window);
  return out;
}

/** `bulkGet` in windows: no single read returns more than `window` rows however many keys are asked for. */
export async function bulkGetWindowed<K extends StoreName>(
  reader: Reader,
  store: K,
  keys: readonly Key[],
  window: number = WINDOW,
): Promise<(RowOf<K> | undefined)[]> {
  const size = Math.max(1, window);
  const out: (RowOf<K> | undefined)[] = [];
  for (let at = 0; at < keys.length; at += size)
    out.push(...(await reader.bulkGet(store, keys.slice(at, at + size))));
  return out;
}

/**
 * The `local_id`s among `ids` that still have a draft, a window at a time and keeping NONE of the rows (R21, revision 10): what a
 * stop of a draft's local writes needs to know is that the draft exists, and a population of stops can be as large as the queue. No
 * read returns more than `window` headers, and each is reduced to its id before the next is read.
 */
export async function existingDrafts(
  reader: Reader,
  ids: readonly LocalId[],
  window: number = WINDOW,
): Promise<LocalId[]> {
  const size = Math.max(1, window);
  const out: LocalId[] = [];
  for (let at = 0; at < ids.length; at += size)
    for (const row of await reader.bulkGet("drafts", ids.slice(at, at + size)))
      if (row) out.push(row.local_id);
  return out;
}

export interface Touched {
  cache: Map<ResourceId, CacheRow>;
  versions: Map<ResourceId, ResourceVersionRow>;
  /**
   * Drafts that stand in for every draft that is not in `exclude` and targets one of `ids`: for each id, the last unsettled one and
   * the outstanding one whose base is highest (`TargetFold.rows`). Not the population: what the pure decisions ask of it is the same
   * whether they are given the population or these (`tests/data/related-fold.test.ts`).
   */
  others: DraftRow[];
}

/** The cached rows and version records of `ids`, and the stand-ins for the other drafts that target them. Windowed. */
export async function readTouched(
  reader: Reader,
  ids: readonly ResourceId[],
  exclude: ReadonlySet<LocalId>,
  window: number = WINDOW,
): Promise<Touched> {
  const unique = [...new Set(ids)];
  const cache = new Map<ResourceId, CacheRow>();
  const versions = new Map<ResourceId, ResourceVersionRow>();
  const cached = await bulkGetWindowed(reader, "cache", unique, window);
  const tracked = await bulkGetWindowed(
    reader,
    "resource_versions",
    unique,
    window,
  );
  unique.forEach((id, index) => {
    const row = cached[index];
    if (row) cache.set(id, row);
    const record = tracked[index];
    if (record) versions.set(id, record);
  });
  const others = new Map<LocalId, DraftRow>();
  for (const id of unique) {
    const fold = new TargetFold(id);
    await walkIndex(
      reader,
      "drafts",
      "index_targets",
      range.only(id),
      (row) => {
        if (!exclude.has(row.local_id)) fold.add(row);
      },
      window,
    );
    for (const row of fold.rows()) others.set(row.local_id, row);
  }
  return { cache, versions, others: [...others.values()] };
}

/**
 * The earliest unsettled draft that targets each of `ids`, for the dispatcher's rule that a draft is never sent ahead of an earlier
 * one against the same target. Each target is walked ONCE per read (`known` remembers it for the next candidate), a window at a time.
 */
export async function readEarliestSharing(
  reader: Reader,
  ids: readonly ResourceId[],
  known: Map<ResourceId, DraftRow | null>,
  window: number = WINDOW,
): Promise<DraftRow[]> {
  const out = new Map<LocalId, DraftRow>();
  for (const id of ids) {
    let earliest = known.get(id);
    if (earliest === undefined) {
      const fold = new TargetFold(id);
      await walkIndex(
        reader,
        "drafts",
        "index_targets",
        range.only(id),
        (row) => fold.add(row),
        window,
      );
      earliest = fold.earliest ?? null;
      known.set(id, earliest);
    }
    if (earliest !== null) out.set(earliest.local_id, earliest);
  }
  return [...out.values()];
}

/**
 * What a caller saw of one resource (`model/observation.ts`): its cached row, its version record, and every draft that names it, walked
 * a window at a time and folded into one token. `visit` sees each of those drafts as it is walked (a caller that folds them for itself
 * reads the population once). The SAME read serves a screen's view and the enqueue or supersede transaction that checks it.
 */
export async function readObservation(
  reader: Reader,
  incarnationId: string,
  id: ResourceId,
  visit?: (row: DraftRow) => void,
  window: number = WINDOW,
): Promise<{
  base: CacheRow | undefined;
  version: ResourceVersionRow | undefined;
  token: string;
}> {
  const base = await reader.get("cache", id);
  const version = await reader.get("resource_versions", id);
  const fold = new ObservationFold(incarnationId, id, base, version);
  await walkIndex(
    reader,
    "drafts",
    "index_targets",
    range.only(id),
    (row) => {
      fold.add(row);
      visit?.(row);
    },
    window,
  );
  return { base, version, token: fold.token() };
}
