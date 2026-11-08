import { readFormAnchor, readKeptPanel } from "../../calendars/anchor-recovery";
import type {
  AnchorDraft,
  AnchorNames,
  CalendarAnchor,
} from "../../calendars/anchors";
import type { TaskFormState } from "../model/form";
import { decodeTaskFormInput, restoreTaskForm } from "../model/recovery";

/**
 * WEB-13b: the new task's calendar anchor as the anchor panel last saved it: the panel's whole state (every field, so it opens again as
 * it was left), the anchor it validated to, and the names its summary shows.
 */
export interface FormAnchor {
  draft: AnchorDraft;
  anchor: CalendarAnchor;
  names: AnchorNames;
}

/** A form's editing session (R33): the values it began from (a locked choice is judged against them) and what is typed now. */
export interface FormInput {
  initial: TaskFormState;
  state: TaskFormState;
  /**
   * WEB-13b, new tasks only: the anchor, kept while "Repeats" hides its section (PRODUCT-DECISIONS-20261011: it comes back with its value);
   * a save of a repeating task sends none and says nothing about it.
   */
  anchor?: FormAnchor | null;
  /**
   * WEB-13b revision 1: the anchor panel as its in-dialog sync control left it (every field, unsaved), so the next panel opened resumes it
   * (ia.md §1.3.3, I1); part of the form's session, kept and dropped with it.
   */
  panel?: { draft: AnchorDraft; names: AnchorNames } | null;
}

/**
 * WEB-13b maintenance merge of accepted main, correction M-13b-1 G-1 (Kieran, 7 November 2026): the task form's recoverable text
 * around an app-update reload (Q4; WEB-14a revision 37, R40), VERSION 2. WEB-14a's version 1 (`model/recovery.ts`) holds the values the
 * session began from and what is typed now; WEB-13b's form session also holds the new task's calendar ANCHOR and the PANEL kept by its
 * in-dialog sync control, and version 1 dropped both: an update restored the form without its anchor, saying nothing, and Save then
 * created a task with no anchor whose first day came from its own schedule. Version 2 keeps them, read back strictly
 * (`calendars/anchor-recovery.ts`: an anchor only if its draft still validates to exactly it). A version-1 copy (written by a build
 * without anchors) restores with none, which is what that build held; a text of any other version or shape is offered, never restored in
 * part. No secrets: a task form and an anchor have none.
 */
export const TASK_FORM_INPUT_VERSION = 2;

export function encodeFormInput(input: FormInput): string {
  return JSON.stringify({
    v: TASK_FORM_INPUT_VERSION,
    initial: input.initial,
    state: input.state,
    anchor: input.anchor ?? null,
    panel: input.panel ?? null,
  });
}

export function decodeFormInput(text: string): FormInput | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object") return null;
    if (raw.v === 1) return decodeTaskFormInput(text);
    if (raw.v !== TASK_FORM_INPUT_VERSION) return null;
    const initial = restoreTaskForm({ form: JSON.stringify(raw.initial) });
    const state = restoreTaskForm({ form: JSON.stringify(raw.state) });
    if (initial === null || state === null) return null;
    const anchor = raw.anchor === null ? null : readFormAnchor(raw.anchor);
    if (raw.anchor !== null && anchor === null) return null;
    const panel = raw.panel === null ? null : readKeptPanel(raw.panel);
    if (raw.panel !== null && panel === null) return null;
    return { initial, state, anchor, panel };
  } catch {
    return null;
  }
}
