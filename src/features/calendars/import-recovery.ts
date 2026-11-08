import type { ImportInput } from "./import-editor";

/**
 * WEB-13b maintenance merge of accepted main, correction M-13b-1 G-3 (Kieran, 7 November 2026): the import dialog's recovery
 * around an app-update reload (Q4; docs/pwa.md "WEB-13b's editors"). PURE. A copy holds the source the drop zone's dialog had chosen and
 * the window AS TYPED (valid or not), version 1, under the context of the entry that opened the dialog: a source's row
 * (`calendar-import:<source>`) or the drop zone's chooser (`calendar-import:chooser`), so the screen's host for that entry reopens it.
 *
 * NEVER THE FILE: its text is page memory only (E11), and a file control cannot be captured (WEB-14a D-P7). A session holding a file, or
 * a file being read, is input the model cannot hold: the update stops (retry, or "Discard and reload anyway") instead of reloading over
 * it, and nothing of the file is written anywhere. A text of another version or shape is offered as it is, never restored in part.
 */
export const IMPORT_INPUT_VERSION = 1;

export const importContext = (sourceId: string | null) =>
  sourceId === null ? "calendar-import:chooser" : `calendar-import:${sourceId}`;

/** A window field as typed is a date's text; a source id is an id: anything longer is no copy of this dialog. */
const WINDOW_BOUND = 64;
const SOURCE_BOUND = 200;

export const encodeImportInput = (input: ImportInput): string =>
  JSON.stringify({
    v: IMPORT_INPUT_VERSION,
    chosen: input.chosen,
    from: input.from,
    through: input.through,
  });

export function decodeImportInput(text: string): ImportInput | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      return null;
    if (raw.v !== IMPORT_INPUT_VERSION) return null;
    const { chosen, from, through } = raw;
    if (
      chosen !== null &&
      (typeof chosen !== "string" || chosen.length > SOURCE_BOUND)
    )
      return null;
    if (typeof from !== "string" || from.length > WINDOW_BOUND) return null;
    if (typeof through !== "string" || through.length > WINDOW_BOUND)
      return null;
    return { chosen, from, through };
  } catch {
    return null;
  }
}
