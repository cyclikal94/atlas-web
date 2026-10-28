import type { SyncStateRow } from "./types";

/**
 * The cache's INVALIDATION WITNESS (WEB-13b revision 8, review 8 R7b; design assessment C2): `sync_state.cache_invalidation_seq`, a
 * per-database counter that moves by one in the SAME transaction as every committed invalidation of the cache: W18 (an ordinary sync's
 * `410` or a cursor that could not be built on), and W24 when it abandons an attempt under a cache that was still `valid`. Nothing else
 * moves it: a first fill, the restart of an empty attempt, a valid takeover, an activation (W23) and every other writer keep it (they spread
 * the row). So two reads of one incarnation that give the same number saw no invalidation between them, whatever `recovery_generation`
 * did, which a first fill or a restart moves too.
 *
 * Absent: 0 (a database written before it existed; the account schema's version 4 is the barrier that keeps an older build, which
 * invalidates without moving it, from writing beside a page that relies on it). Not a non-negative safe integer: unknown (null), never
 * guessed; a writer then starts again from 1, which no earlier reading could have agreed with. A database deleted and created again
 * restarts at 0 under a new `incarnation_id`, so a reader compares the pair, never the number alone.
 *
 * A module of its own: the sync facts (in the initial bundle) read it, and `sync-state.ts` (the seeded row) belongs to the adapter's chunk.
 */
export const invalidationsOf = (sync: SyncStateRow): number | null => {
  const seq = sync.cache_invalidation_seq ?? 0;
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
};

/** The witness after one more committed invalidation. */
export const nextInvalidation = (sync: SyncStateRow): number =>
  (invalidationsOf(sync) ?? 0) + 1;
