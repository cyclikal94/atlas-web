import type { DependencyItem, DependencyPreview } from "./contract";

/**
 * WF-TASK-04 (CM-354, 423, 424; TASK-14/14a; WEB-10c D-10c-6/7, escalations E-1/E-2). PURE.
 *
 * The released contract publishes NO dependency edges: a preview lists the visible TRANSITIVE prerequisites in completion order with the
 * root last, and nothing names an occurrence's DIRECT prerequisites. So the screen shows an ordered list (never a tree), and the editor
 * replaces the whole direct list, starting empty, only while nothing is private (`unavailable` false), because `set_dependencies` also
 * replaces the edges the person cannot see.
 */
export type Mode =
  | "require_satisfied"
  | "complete_prerequisites"
  | "advisory_override";

/** The prerequisites of the preview (every item but the root), in the server's completion order. */
export function prerequisitesOf(
  preview: DependencyPreview,
  rootId: string,
): DependencyItem[] {
  return preview.items.filter((item) => item.occurrence_id !== rootId);
}

/** The root's own item (the last), or null when the answer does not hold it. */
export const rootItemOf = (
  preview: DependencyPreview,
  rootId: string,
): DependencyItem | null =>
  preview.items.find((item) => item.occurrence_id === rootId) ?? null;

/** Every visible prerequisite is complete, and nothing is private. */
export function satisfiedPreview(
  preview: DependencyPreview,
  rootId: string,
): boolean {
  return (
    !preview.unavailable &&
    prerequisitesOf(preview, rootId).every((item) => item.complete)
  );
}

export interface ModeAvailability {
  complete_prerequisites: null | "unavailable" | "cannot_complete" | "root";
  advisory_override: null | "strict";
}

/**
 * Which modes can be chosen, and why not (the dialog's disabled reasons):
 *  - `complete_prerequisites` needs nothing private, every INCOMPLETE prerequisite completable by me from here, and a root I can
 *    complete (my own checkbox, or the evidence the person entered for a numeric or checklist root);
 *  - `advisory_override` ("Start anyway") is refused by a strict rule.
 * `require_satisfied` is "Wait until everything's done" (no command) until every prerequisite is done, then the primary "Mark done".
 */
export function modesOf(
  preview: DependencyPreview,
  rootId: string,
  rootCompletable: boolean,
): ModeAvailability {
  const open = prerequisitesOf(preview, rootId).filter(
    (item) => !item.complete,
  );
  return {
    complete_prerequisites: preview.unavailable
      ? "unavailable"
      : open.some((item) => !item.can_complete)
        ? "cannot_complete"
        : !rootCompletable
          ? "root"
          : null,
    advisory_override: preview.strict ? "strict" : null,
  };
}

/** The progress counts of the detail's row ("{done} of {n} done"). */
export function progressOf(
  preview: DependencyPreview,
  rootId: string,
): { done: number; total: number; firstOpen: DependencyItem | null } {
  const items = prerequisitesOf(preview, rootId);
  return {
    done: items.filter((item) => item.complete).length,
    total: items.length,
    firstOpen: items.find((item) => !item.complete) ?? null,
  };
}

/**
 * Why a queued `complete_dependencies` met a conflict, said from a FRESH preview read after it (the server's `409` carries no detail).
 * In order: everything is done now (send again as a plain completion), something is private, the rule is strict and "Start anyway" was
 * asked, an item cannot be completed from here, or the list changed.
 */
export type ConflictCause =
  | "satisfied"
  | "unavailable"
  | "strict"
  | "cannot_complete"
  | "changed";
export function causeOf(
  submittedMode: Mode,
  submittedToken: string,
  fresh: DependencyPreview,
  rootId: string,
): ConflictCause {
  if (satisfiedPreview(fresh, rootId)) return "satisfied";
  if (fresh.unavailable && submittedMode === "complete_prerequisites")
    return "unavailable";
  if (fresh.strict && submittedMode === "advisory_override") return "strict";
  if (
    submittedMode === "complete_prerequisites" &&
    prerequisitesOf(fresh, rootId).some(
      (item) => !item.complete && !item.can_complete,
    )
  )
    return "cannot_complete";
  // Anything else: what it waits for is not what was sent (another item, another state, or a token that moved).
  return submittedToken === fresh.token ? "cannot_complete" : "changed";
}

/** The most direct prerequisites `set_dependencies` accepts. */
export const MAX_PREREQUISITES = 32;

export type EditorError = "too_many" | "duplicate" | "self";
/** The editor's validation of the WHOLE list it will save (the server checks visibility and cycles). */
export function validateList(
  rootId: string,
  prerequisites: readonly string[],
): EditorError | null {
  if (prerequisites.length > MAX_PREREQUISITES) return "too_many";
  if (prerequisites.includes(rootId)) return "self";
  if (new Set(prerequisites).size !== prerequisites.length) return "duplicate";
  return null;
}

/** Whether the editor may open: online, a fresh preview read, nothing private (else it would erase edges the person cannot see). */
export function editorBlock(input: {
  online: boolean;
  canEdit: boolean;
  preview: DependencyPreview | null;
}): "offline" | "denied" | "loading" | "unavailable" | null {
  if (!input.canEdit) return "denied";
  if (!input.online) return "offline";
  if (input.preview === null) return "loading";
  if (input.preview.unavailable) return "unavailable";
  return null;
}
