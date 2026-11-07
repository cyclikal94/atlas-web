import type {
  DependencyGraph,
  DependencyItem,
  DependencyPreview,
} from "./contract";

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
  /** "Mark done" (`require_satisfied`): every prerequisite done and nothing private, and a root I can complete (review R15). */
  require_satisfied: null | "open" | "root";
  complete_prerequisites: null | "unavailable" | "cannot_complete" | "root";
  advisory_override: null | "strict" | "root";
}

/**
 * Whether what the dialog would send completes the ROOT (review R15). The released backend completes the root, in EVERY mode, only with
 * the evidence sent for it (`root_evidence`) or, without any, when the preview says I can complete it (`can_complete`), recording a tick.
 * So a tick-box root needs its `can_complete`, and a numeric or checklist root needs the evidence the person entered on its card (its
 * `can_complete` would record a tick its goal refuses). A preview that does not hold the root admits nothing.
 */
export function rootAdmitted(
  preview: DependencyPreview,
  rootId: string,
  goalKind: string,
  evidence: boolean,
): boolean {
  const root = rootItemOf(preview, rootId);
  if (root === null) return false;
  return goalKind === "checkbox" ? root.can_complete : evidence;
}

/**
 * Which modes can be chosen, and why not (the dialog's disabled reasons). EVERY mode completes the root, so every mode needs it admitted
 * (`rootCompletable`, from `rootAdmitted`; review R15). Besides:
 *  - `require_satisfied` ("Mark done") needs every prerequisite done and nothing private;
 *  - `complete_prerequisites` needs nothing private and every INCOMPLETE prerequisite completable by me from here;
 *  - `advisory_override` ("Start anyway") is refused by a strict rule.
 * While something is open, `require_satisfied` is "Wait until everything's done" (no command).
 */
export function modesOf(
  preview: DependencyPreview,
  rootId: string,
  rootCompletable: boolean,
): ModeAvailability {
  const open = prerequisitesOf(preview, rootId).filter(
    (item) => !item.complete,
  );
  const root = rootCompletable ? null : ("root" as const);
  return {
    require_satisfied: !satisfiedPreview(preview, rootId) ? "open" : root,
    complete_prerequisites: preview.unavailable
      ? "unavailable"
      : open.some((item) => !item.can_complete)
        ? "cannot_complete"
        : root,
    advisory_override: preview.strict ? "strict" : root,
  };
}

/**
 * The completion that may be sent for `chosen` on this preview, or null (Wait) (reviews R12, R15): ONE rule for the choice shown, the
 * button and the send, so a mode remembered from a refused draft or chosen before the preview changed is never offered or sent once the
 * preview forbids it. A satisfied day is completed plainly (`require_satisfied`) and only then; every mode needs the root admitted.
 */
export function admittedMode(
  preview: DependencyPreview,
  rootId: string,
  rootCompletable: boolean,
  chosen: Mode | "wait",
): Mode | null {
  if (chosen === "wait") return null;
  const modes = modesOf(preview, rootId, rootCompletable);
  if (satisfiedPreview(preview, rootId) !== (chosen === "require_satisfied"))
    return null;
  return modes[chosen] === null ? chosen : null;
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

/** WEB-18: what the editor's own fresh depth-one graph read says of the day (its root). */
export interface EditorRootFacts {
  can_edit: boolean;
  restricted_prerequisites: boolean | null;
}

export type EditorBlock =
  | "offline"
  | "denied"
  | "loading"
  | "unavailable"
  | "restricted"
  | "pending"
  | "changed"
  | null;

/**
 * Whether the editor may save: online, a fresh preview read with nothing private (else it would erase edges the person cannot see), and
 * (WEB-18, D-18-6/7) its own fresh depth-one graph read (`root`; null while not read; absent where a caller does not consult it) saying
 * the person may edit the day and the day has no hidden prerequisite, no other unsettled change of the day's version (`pending`), and the
 * list it was built from still the current one (`changed`).
 */
export function editorBlock(input: {
  online: boolean;
  canEdit: boolean;
  preview: DependencyPreview | null;
  root?: EditorRootFacts | null;
  pending?: boolean;
  changed?: boolean;
}): EditorBlock {
  if (!input.canEdit) return "denied";
  if (!input.online) return "offline";
  if (input.preview === null) return "loading";
  if (input.preview.unavailable) return "unavailable";
  if (input.root === undefined) return null;
  if (input.root === null) return "loading";
  if (!input.root.can_edit) return "denied";
  if (input.root.restricted_prerequisites === true) return "restricted";
  if (input.pending === true) return "pending";
  if (input.changed === true) return "changed";
  return null;
}

/** The base an edit was built from (D-18-7): the root's version and direct list of the graph read it was seeded from. */
export interface EditorBase {
  version: number;
  list: string[];
}

/** The base of a graph answer: its root's version and its direct list (as a set: order carries no meaning). */
export function baseOf(graph: DependencyGraph): EditorBase {
  const root = graph.nodes[0];
  return {
    version: root?.version ?? 0,
    list: [...graph.direct_prerequisites].sort(),
  };
}

/** Whether `graph` still says what `base` says: the same root version and the same direct list. */
export function baseMatches(base: EditorBase, graph: DependencyGraph): boolean {
  const now = baseOf(graph);
  return (
    now.version === base.version &&
    now.list.length === base.list.length &&
    now.list.every((id, i) => id === base.list[i])
  );
}

/** The draft statuses that settle a draft (the data layer's terminal set). */
const SETTLED: ReadonlySet<string> = new Set([
  "acknowledged",
  "rejected",
  "superseded",
]);

/**
 * WEB-18 (D-18-7, E-14): whether another unsettled draft of `occurrenceId` is checked against its version (`versioned`: the kinds whose
 * builder does so, `OCCURRENCE_VERSIONED_KINDS`), so a graph read cannot reflect what it will leave and a save on that read's version
 * would be based on a version this device is about to move. `except`: the draft being replaced ("Keep editing").
 */
export function pendingVersioned(
  drafts: readonly {
    local_id: string;
    kind: string;
    status: string;
    /** The draft's command (`commandOf`), or null when it has none readable. */
    command: Readonly<Record<string, unknown>> | null;
  }[],
  occurrenceId: string,
  versioned: ReadonlySet<string>,
  except: string | null,
): boolean {
  return drafts.some(
    (draft) =>
      draft.local_id !== except &&
      !SETTLED.has(draft.status) &&
      versioned.has(draft.kind) &&
      (draft.command?.occurrence_id === occurrenceId ||
        draft.command?.id === occurrenceId),
  );
}
