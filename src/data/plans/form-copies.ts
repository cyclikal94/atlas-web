import type { FormRecoveryRow } from "../model/types";
import { type Key, range } from "../store/port";
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
 * A READ, never a writer (writes go through the ports, which order and admit them). Bounded like every read of this layer (R21, Q9), and
 * RESUMABLE (review 2 of 22 October 2026, finding 4): it walks the store's primary key `[form_context, tab_instance_id]` over the prefix,
 * AFTER the caller's cursor (exclusive), a window at a time, keeps at most one window (100) of live copies and looks at no more than
 * `SCAN_WINDOWS` windows of rows. Terminal rows are kept by the store (they order late captures against a discard) and are skipped here,
 * but they move the cursor: `next` is the key of the last row this read CONSUMED (never one beyond a live copy it did not return), so a
 * range of terminal rows of any length is crossed by a finite sequence of bounded reads, and every live copy of a stable set is met
 * exactly once. A key cursor does not shift when rows are added or removed before it (an offset would). `next` is null only when the
 * prefix was read to its end; an empty page with a `next` is NOT "nothing held". The copies of one page are sorted by `saved_at` for
 * display; that says nothing about the order across pages.
 */
export type FormCopyCursor = readonly [
  formContext: string,
  tabInstanceId: string,
];

export interface FormCopiesInput {
  incarnationId: string;
  /** The family's `form_context` prefix (for example `people-held:<person>:`). Never empty. */
  prefix: string;
  /** Continue after this key (a previous page's `next`); absent or null: from the start. A cursor outside the prefix reads nothing. */
  after?: FormCopyCursor | null;
}

export interface FormCopiesPage {
  copies: FormRecoveryRow[];
  /** Where the next page continues (exclusive), or null when the prefix has been read to its end. */
  next: FormCopyCursor | null;
  /** `next !== null`: more copies may follow this page. */
  more: boolean;
}

const SCAN_WINDOWS = 10;
/** Above every character a `form_context` uses: the upper end of a prefix range. */
const PREFIX_END = "\uffff";
/** The store's primary key, as an index name (`[form_context+tab_instance_id]`). */
const PRIMARY = "[form_context+tab_instance_id]";

const page = (
  copies: FormRecoveryRow[],
  next: FormCopyCursor | null,
): FormCopiesPage => ({
  copies: sortCopies(copies),
  next,
  more: next !== null,
});

export const readFormCopies = readPlan<
  FormCopiesInput,
  FormCopiesPage,
  FormCopiesPage
>({
  name: "data.readFormCopies",
  scope: ["form_recovery"],
  read: async (reader, input) => {
    if (input.prefix === "") return page([], null);
    const after = input.after ?? null;
    if (after !== null && !after[0].startsWith(input.prefix))
      return page([], null);
    const upper: Key = [`${input.prefix}${PREFIX_END}`, ""];
    let cursor: FormCopyCursor | null = after;
    const copies: FormRecoveryRow[] = [];
    for (let window = 0; window < SCAN_WINDOWS; window += 1) {
      const rows = await reader.byIndex(
        "form_recovery",
        PRIMARY,
        range.between(cursor ?? [input.prefix, ""], upper, {
          lowerOpen: cursor !== null,
          upperOpen: true,
        }),
        WINDOW,
      );
      for (const row of rows) {
        cursor = [row.form_context, row.tab_instance_id];
        if (row.terminal) continue;
        copies.push(row);
        // A full window ends the page AT this copy: the next page begins after it, so nothing unreturned is skipped.
        if (copies.length === WINDOW) return page(copies, cursor);
      }
      if (rows.length < WINDOW) return page(copies, null);
    }
    // The scan bound: the next page continues after the last row consumed, even when this one holds no live copy.
    return page(copies, cursor);
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

/**
 * One form copy as it is stored (review 2 of 22 October 2026, finding 2): `live` with its row, `ended` (terminal: discarded or finished)
 * or `absent`, kept apart, because an operation that ended must never be taken for one that was never there, nor a failed read for
 * either (the caller's failure). READONLY.
 */
export const inspectFormRecovery = readPlan<
  { incarnationId: string; formContext: string; tabInstanceId: string },
  FormRecoveryRow | undefined,
  | { kind: "live"; row: FormRecoveryRow }
  | { kind: "ended" }
  | { kind: "absent" }
>({
  name: "data.inspectFormRecovery",
  scope: ["form_recovery"],
  read: (reader, input) =>
    reader.get("form_recovery", [input.formContext, input.tabInstanceId]),
  decide: ({ reads: stored }) =>
    stored === undefined
      ? { kind: "absent" }
      : stored.terminal
        ? { kind: "ended" }
        : { kind: "live", row: stored },
});
