import type { DraftWithCommand } from "../model/types";
import { readDraftWithCommand } from "../plans/draft-detail";
import type { Loadable } from "../store/port";
import { useWatch } from "./react";

/**
 * ONE draft with its body, live (`readDraftWithCommand`), in a module of its own: only the (lazy) people screens import it, so it stays out
 * of every initial bundle. A feature screen uses it to show what a conflicted save of the person's said (WEB-11a: "Save mine" restores
 * the conflicted draft's own content, never the cache's). Null when there is no such draft; it never creates a database.
 */
export function useDraftWithCommand(
  localId: string | null,
): Loadable<DraftWithCommand | null> {
  return useWatch(
    (env) => {
      const service = env.service();
      return service && localId !== null
        ? service.store.watch(readDraftWithCommand, {
            incarnationId: service.incarnationId,
            localId,
          })
        : null;
    },
    [localId],
  );
}
