import { charCount, valueProblem } from "./values";

/**
 * The "New person" form (WEB-11a §4.2). PURE.
 *
 * The optional first note can be shown and hidden; hiding it KEEPS what was typed (PRODUCT-DECISIONS-20261011 item 2), and a save sends
 * the note only while it is shown and not blank, with no warning about a hidden one. Every change raises `revision` (the save's ticket).
 * A note that is sent must be a text value the server accepts (`valueProblem`, the same check as every other field's value, review 21):
 * at most 4,096 characters, and at most 8,192 bytes once encoded, so a note of fewer characters can still be too long to save.
 */
export type PersonSharing = "defaults" | "only_you";

export interface NewPersonState {
  name: string;
  sharing: PersonSharing;
  noteOpen: boolean;
  note: string;
  revision: number;
}

export const NOTE_LABEL = "Note";
export const PERSON_NAME_MAX = 300;

export const newPersonForm = (): NewPersonState => ({
  name: "",
  sharing: "defaults",
  noteOpen: false,
  note: "",
  revision: 0,
});

export type NewPersonAction =
  | { type: "name"; value: string }
  | { type: "sharing"; value: PersonSharing }
  | { type: "note_open"; value: boolean }
  | { type: "note"; value: string };

export function reduceNewPerson(
  state: NewPersonState,
  action: NewPersonAction,
): NewPersonState {
  const revision = state.revision + 1;
  switch (action.type) {
    case "name":
      return { ...state, name: action.value, revision };
    case "sharing":
      return { ...state, sharing: action.value, revision };
    case "note_open":
      // Hiding the note keeps its text: it is only left out of a save.
      return { ...state, noteOpen: action.value, revision };
    case "note":
      return { ...state, note: action.value, revision };
  }
}

export type NewPersonProblem =
  | "name_missing"
  | "name_too_long"
  | "note_too_long"
  | "value_too_large";

export type NewPersonApplicable =
  | {
      ok: true;
      name: string;
      sharing: PersonSharing;
      /** The note to create with the person, or null when it is hidden or blank. */
      note: string | null;
    }
  | {
      ok: false;
      problems: Partial<Record<"name" | "note", NewPersonProblem>>;
    };

export function applicablePerson(state: NewPersonState): NewPersonApplicable {
  const problems: Partial<Record<"name" | "note", NewPersonProblem>> = {};
  const name = state.name.trim();
  if (name === "") problems.name = "name_missing";
  else if (charCount(name) > PERSON_NAME_MAX) problems.name = "name_too_long";
  const sendNote = state.noteOpen && state.note.trim() !== "";
  const noteProblem = sendNote
    ? valueProblem({ kind: "text", text: state.note })
    : null;
  if (noteProblem === "text_too_long") problems.note = "note_too_long";
  else if (noteProblem !== null) problems.note = "value_too_large";
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return {
    ok: true,
    name,
    sharing: state.sharing,
    note: sendNote ? state.note : null,
  };
}
