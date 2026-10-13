import { type FormCopiesPage, readFormCopies } from "../plans/form-copies";
import type { Loadable } from "../store/port";
import { useWatch } from "./react";

/**
 * The live form copies of one family of forms (`readFormCopies`), in a module of its own: only the (lazy) people screens import it, so the
 * plan stays out of every initial bundle. It never creates a database: with none, the read is `unavailable` (`absent`).
 */
export function useFormCopies(prefix: string): Loadable<FormCopiesPage> {
  return useWatch(
    (env) => {
      const service = env.service();
      return service && prefix !== ""
        ? service.store.watch(readFormCopies, {
            incarnationId: service.incarnationId,
            prefix,
          })
        : null;
    },
    [prefix],
  );
}
