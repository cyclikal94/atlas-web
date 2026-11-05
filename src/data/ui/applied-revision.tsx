import { readAppliedRevision } from "../plans/applied-revision";
import type { Loadable } from "../store/port";
import { useWatch } from "./react";

/**
 * The live applied revision (`readAppliedRevision`), in a module of its own: only the (lazy) people screens import it, so the plan stays
 * out of every initial bundle. It never creates a database: with none, the read is `unavailable` (`absent`).
 */
export function useAppliedRevision(): Loadable<number | null> {
  return useWatch((env) => {
    const service = env.service();
    return service
      ? service.store.watch(readAppliedRevision, {
          incarnationId: service.incarnationId,
        })
      : null;
  }, []);
}
