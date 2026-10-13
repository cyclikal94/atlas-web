import {
  type OutstandingCreatesPage,
  readOutstandingCreates,
} from "../plans/outstanding-reads";
import type { Loadable } from "../store/port";
import { useWatch } from "./react";

/**
 * WEB-11a's live read of outstanding work, in a module of its own: only the (lazy) people screens import it, so the plan stays out of every
 * initial bundle.
 */

/**
 * One window of this device's OUTSTANDING saves of the command kinds asked for, with their bodies (`readOutstandingCreates`): the
 * queued, in-flight and capacity-blocked drafts, and the acknowledged ones whose change the cache has not published yet, oldest first,
 * at most 100. Pass the page's `next` back as `after` to read the following window. A screen uses it to show what the cache cannot yet
 * (a resource created on this device, a change not yet sent); it never creates a database.
 */
export function useOutstandingCreates(
  kinds: readonly string[],
  after?: number | null,
): Loadable<OutstandingCreatesPage> {
  const key = kinds.join("\u0000");
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readOutstandingCreates, {
            incarnationId: service.incarnationId,
            kinds: key === "" ? [] : key.split("\u0000"),
            ...(typeof after === "number" ? { after } : {}),
          })
        : null;
    },
    [key, after],
  );
}
