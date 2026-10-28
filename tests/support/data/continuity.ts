import type { Continuity } from "../../../src/data/model/outbox";
import type { SyncStateRow } from "../../../src/data/model/types";

/**
 * The cache's history a test's import states (WEB-13b revision 10, review 10 R7e: `importRequest` requires one, as the dialog's press
 * always captures one): its database's own, as the singleton says now. A setup that seeds an import through the facade states this, so
 * W2 admits it exactly as it admits a press verified against the same history.
 */
export const historyOf = (world: { sync(): SyncStateRow }): Continuity => {
  const sync = world.sync();
  return {
    incarnationId: sync.incarnation_id,
    invalidations: sync.cache_invalidation_seq ?? 0,
  };
};
