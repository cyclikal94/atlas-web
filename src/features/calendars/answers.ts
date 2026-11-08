import type { ConflictHandlerRegistry } from "../../data";
import { IMPORT_ENDPOINT } from "./model/commands";

/**
 * The import draft's two terminal answers (WEB-13b, §5 of the plan; case 4 and 7(a)/(e)): answers the generic rule would retry under the
 * same key, but which resending the same body cannot change.
 *
 *  - `409 stale_refresh` (`generation_changed`, `lease_expired`): this attempt did not commit, and a newer update of the source finished
 *    first; the person imports the file again.
 *  - `502 fetch_failed` with an Atlas body: the server could not read the file (a title over 300 characters, a date outside 1900–9999).
 *    A gateway's `502` has no Atlas body and stays the generic retry.
 *
 * Only drafts addressed to the import endpoint are reclassified; every other draft keeps the generic rule. Registered once per page host,
 * before any of its dispatchers can send (`src/app/commands.ts`), and by the fixture harness for its own registry.
 */
export function registerImportAnswers(
  conflicts: ConflictHandlerRegistry,
): void {
  for (const code of ["stale_refresh", "fetch_failed"])
    conflicts.register(code, ({ draft }) =>
      draft.endpoint === IMPORT_ENDPOINT
        ? { kind: "reclassify", as: "rejected" }
        : { kind: "default" },
    );
}
