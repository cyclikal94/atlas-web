import {
  type FormCopiesPage,
  type FormCopyCursor,
  readFormCopies,
} from "../plans/form-copies";
import type { Loadable } from "../store/port";
import { useWatch } from "./react";

/**
 * The live form copies of one family of forms (`readFormCopies`), one bounded page after `after` (null: the first), in a module of its
 * own: only the (lazy) people screens import it, so the plan stays out of every initial bundle. It never creates a database: with none,
 * the read is `unavailable` (`absent`).
 */
export function useFormCopies(
  prefix: string,
  after: FormCopyCursor | null = null,
): Loadable<FormCopiesPage> {
  const from = after === null ? null : after[0];
  const fromTab = after === null ? null : after[1];
  return useWatch(
    (env) => {
      const service = env.service();
      return service && prefix !== ""
        ? service.store.watch(readFormCopies, {
            incarnationId: service.incarnationId,
            prefix,
            after: from === null || fromTab === null ? null : [from, fromTab],
          })
        : null;
    },
    [prefix, from, fromTab],
  );
}
