import type { Loadable } from "../../../data";
import { type ChainResult, statusOf } from "../reads";

/**
 * What the field editor's reads establish before anything is edited (review 9, finding 2): the person's, the field's (none for a new
 * field) and this device's whole chain of unsent changes.
 *
 *  - `failed`: one of them could not be read (an error, or a closed database). Said AT ONCE, even while another read still loads (a known
 *    failure is never hidden behind a wait), and never taken as "nothing there": no row is projected over a guessed empty base. `read`
 *    names the read that failed, so the editor says which and offers "Try again" (new watches for all of them).
 *  - `loading`: a read still loading, or a later window of the changes still loading: not "none".
 *  - `capped`: more unsent changes than the page reads: nothing is edited on a base that may miss one (review 7's design assessment, C15).
 *  - `read`: every read answered; whether the person and the field are THERE is the caller's to decide from the rows (and a missing field
 *    is said only once a composed read confirms it, DA7-12). An absent database (`statusOf` absent) holds nothing: it is read.
 *
 * PURE (its tests drive every combination).
 */
export type EditorReads =
  | { kind: "loading" }
  | { kind: "failed"; read: "person" | "field" | "changes" }
  | { kind: "capped" }
  | { kind: "read" };

export function editorReads(
  person: Loadable<unknown>,
  field: Loadable<unknown> | null,
  outstanding: ChainResult<unknown>,
): EditorReads {
  if (statusOf(person) === "failed") return { kind: "failed", read: "person" };
  if (field !== null && statusOf(field) === "failed")
    return { kind: "failed", read: "field" };
  if (outstanding.status === "failed")
    return { kind: "failed", read: "changes" };
  if (
    person.status === "loading" ||
    field?.status === "loading" ||
    outstanding.status === "loading" ||
    (outstanding.status === "ready" &&
      !outstanding.complete &&
      !outstanding.capped)
  )
    return { kind: "loading" };
  if (outstanding.capped) return { kind: "capped" };
  return { kind: "read" };
}
