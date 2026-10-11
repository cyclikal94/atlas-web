import type { DraftRow, DraftStatus, DraftWithCommand } from "../model/types";
import { range } from "../store/port";
import { bulkGetWindowed, WINDOW } from "./bounded-reads";
import { readPlan } from "./builders";

/**
 * This device's OUTSTANDING saves of some command kinds, with their bodies (WEB-10a/WEB-11a §3.1): what a feature screen needs to show a
 * change the person made that the cache does not show yet. The merged reads deliberately do not give it: a queued draft has no
 * `pending_effects` row until it is claimed, so `readResourceList` lists only the cache, and `readMerged` reads drafts only for an id the
 * caller already knows. A screen of NEW resources (a person created offline, a field created under them) knows no id in advance.
 *
 * "Outstanding" is a draft that is still expected to apply and that the cache may not reflect yet:
 *  - `queued` (a review block included: the person has not confirmed its audience yet), `in_flight` and `blocked` (capacity);
 *  - `acknowledged` only WHILE its own `pending_effects` row for its first primary target stands: the server receipted it and this device
 *    has not yet seen it published. Once that row is released, the cache speaks for the change, and the draft is no longer listed.
 * A conflict, a rejection and a superseded draft are not: they are decided in the queue, never shown as a change that will apply.
 *
 * A READ, never a writer: it is bounded like every outbox read (R21): it walks the `[status+created_seq]` index of each status a window
 * at a time, keeps only headers of the kinds asked for, holds at most one window (`queueWorkingSet`, 100) of them, oldest first by
 * `created_seq` (queue order), and reads the bodies of that window and no others. `next` is the `created_seq` to pass back as `after` for
 * the following window, or null on the last.
 */
export interface OutstandingCreatesInput {
  incarnationId: string;
  /** The command kinds as the header records them (`DraftRow.kind`, for example `create_person`, `put_field`). */
  kinds: readonly string[];
  /** Only drafts after this `created_seq` (a later window); omitted or null: from the oldest. */
  after?: number | null;
}

export interface OutstandingCreatesPage {
  /** At most one window of outstanding drafts of the kinds asked for, oldest first, each with its body. */
  drafts: DraftWithCommand[];
  /** The `created_seq` to pass back as `after` for the next window, or null when this is the last. */
  next: number | null;
}

const LIVE: readonly DraftStatus[] = ["queued", "in_flight", "blocked"];
const FAR = Number.MAX_SAFE_INTEGER;

export const readOutstandingCreates = readPlan<
  OutstandingCreatesInput,
  { drafts: DraftWithCommand[]; next: number | null },
  OutstandingCreatesPage
>({
  name: "data.readOutstandingCreates",
  scope: ["drafts", "draft_commands", "pending_effects"],
  read: async (reader, input) => {
    const kinds = new Set(input.kinds);
    const after = input.after ?? 0;
    // The oldest `WINDOW + 1` of every status together: the one more says whether another window follows.
    const keep = WINDOW + 1;
    let kept: DraftRow[] = [];
    const offer = (row: DraftRow): void => {
      kept.push(row);
      if (kept.length > keep * 2) {
        kept.sort((a, b) => a.created_seq - b.created_seq);
        kept = kept.slice(0, keep);
      }
    };
    for (const status of [...LIVE, "acknowledged"] as const) {
      // A keyset walk of ONE status after the cursor, a window of headers at a time; a status contributes at most `keep` rows, because
      // only the oldest `keep` of all of them can be shown.
      let cursor = after;
      let found = 0;
      for (;;) {
        const rows: DraftRow[] = await reader.byIndex(
          "drafts",
          "[status+created_seq]",
          range.between([status, cursor], [status, FAR], { lowerOpen: true }),
          WINDOW,
        );
        for (const row of rows) {
          if (!kinds.has(row.kind)) continue;
          if (status === "acknowledged") {
            const first = row.target_resource_ids[0];
            if (first === undefined) continue;
            const effect = await reader.get("pending_effects", [
              first,
              row.local_id,
            ]);
            if (effect === undefined) continue;
          }
          offer(row);
          found += 1;
        }
        const tail = rows[rows.length - 1];
        if (rows.length < WINDOW || tail === undefined || found >= keep) break;
        cursor = tail.created_seq;
      }
    }
    kept.sort((a, b) => a.created_seq - b.created_seq);
    const more = kept.length > WINDOW;
    const window = kept.slice(0, WINDOW);
    const bodies = await bulkGetWindowed(
      reader,
      "draft_commands",
      window.map((row) => row.local_id),
    );
    const last = window[window.length - 1];
    return {
      drafts: window.flatMap((row, index) => {
        const body = bodies[index];
        return body ? [{ ...row, command: body.command }] : [];
      }),
      next: more && last !== undefined ? last.created_seq : null,
    };
  },
  decide: ({ reads }) => reads,
});
