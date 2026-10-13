import type { FormRecoveryRow } from "../model/types";
import { range } from "../store/port";
import { WINDOW } from "./bounded-reads";
import { readPlan } from "./builders";

/**
 * The LIVE form copies of one family of forms (WEB-11a, finding 6 of the review of 13 October 2026): the `form_recovery` rows whose
 * `form_context` begins with `prefix` and that are not terminal (a discarded or finished copy has its fields cleared and is never listed).
 *
 * WEB-11a keeps a person's explicitly HELD audience changes ("Hold it as a draft until I'm online", D-11a-12) as form copies of the
 * account's database: durable across reloads and account switches (Q3, Q20(a)), counted in the unsynced local work a logout warns about
 * and binds its consent to (`local-work.ts`, category `form_copy`), admitted by the quota guard and refused while signing out (the port,
 * D-16), deleted with the account's data only on a confirmed logout or self-retirement, and shown only while the account's protected tree
 * may display (Q20(b)): the store is the account's own.
 *
 * A READ, never a writer (writes go through `FormRecoveryPort`, which orders and admits them). Bounded like every read of this layer (R21,
 * Q9): it walks the `form_context` index over the prefix a window at a time, keeps at most one window (100) of live copies, oldest first by
 * `saved_at`, and looks at no more than `SCAN_WINDOWS` windows of rows (terminal rows are skipped, never kept). `more` says that further
 * live copies (or unread rows) may follow, so a caller never takes the list for a complete inventory when it is not.
 */
export interface FormCopiesInput {
  incarnationId: string;
  /** The family's `form_context` prefix (for example `people-held:<person>:`). Never empty. */
  prefix: string;
}

export interface FormCopiesPage {
  copies: FormRecoveryRow[];
  /** More copies may exist than the window shows (the window filled, or the scan bound was reached). */
  more: boolean;
}

const SCAN_WINDOWS = 10;
/** Above every character a `form_context` uses: the upper end of a prefix range. */
const PREFIX_END = "\uffff";

export const readFormCopies = readPlan<
  FormCopiesInput,
  FormCopiesPage,
  FormCopiesPage
>({
  name: "data.readFormCopies",
  scope: ["form_recovery"],
  read: async (reader, input) => {
    if (input.prefix === "") return { copies: [], more: false };
    const span = range.between(input.prefix, `${input.prefix}${PREFIX_END}`);
    const copies: FormRecoveryRow[] = [];
    for (let window = 0; window < SCAN_WINDOWS; window += 1) {
      const rows = await reader.byIndex(
        "form_recovery",
        "form_context",
        span,
        WINDOW,
        window * WINDOW,
      );
      for (const row of rows) {
        if (row.terminal) continue;
        copies.push(row);
        if (copies.length > WINDOW) break;
      }
      if (copies.length > WINDOW) break;
      if (rows.length < WINDOW)
        return { copies: sortCopies(copies), more: false };
    }
    return { copies: sortCopies(copies).slice(0, WINDOW), more: true };
  },
  decide: ({ reads }) => reads,
});

function sortCopies(rows: FormRecoveryRow[]): FormRecoveryRow[] {
  return rows.sort((a, b) =>
    a.saved_at < b.saved_at
      ? -1
      : a.saved_at > b.saved_at
        ? 1
        : a.form_context < b.form_context
          ? -1
          : a.form_context > b.form_context
            ? 1
            : a.tab_instance_id < b.tab_instance_id
              ? -1
              : a.tab_instance_id > b.tab_instance_id
                ? 1
                : 0,
  );
}
