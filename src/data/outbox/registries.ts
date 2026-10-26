import type { EnqueueRequest, TargetNeeds } from "../model/outbox";
import { projectionTarget } from "../model/overlay";
import type {
  CacheRow,
  DraftRow,
  DraftWithCommand,
  ResourceId,
} from "../model/types";

/**
 * The seams through which feature slices teach the generic outbox what its commands mean (plan 5.9). The data layer knows
 * endpoints, wire shapes and store rules; it does not know what a command DOES. A slice registers once, at start-up; a
 * registration of a kind or a code that has one is a defect and throws.
 */

// ---- CommandRegistry ----------------------------------------------------------------------------------------------------------
export interface CommandSpec {
  /**
   * A generic, content-free label for a draft of this kind (the queue panel, the wipe dialog's category lines never use it). It
   * sees the draft's HEADER only: the body is a separate, possibly large record that a list never reads.
   */
  describe(draft: DraftRow): string;
  /**
   * A projection of a create that is not in the cache yet, so the merged reads can show it. `null`: nothing to show. It sees the
   * body, which the merged read of ONE resource joins for the queued creates against that resource, and the id of THAT resource: a
   * create that introduces several resources (a task, its details, its first occurrence and progress) returns the row of the one
   * asked for. A row with any other id is never shown in its place (`mergeResource`).
   */
  projectCreate?(
    draft: DraftWithCommand,
    resourceId: ResourceId,
  ): CacheRow | null;
  /**
   * WEB-09b's seam for the generic item-detail dialog (WF-QUEUE-02): a NEW command built from a failed or conflicting draft and `current`,
   * the value of the authorised current read (`readCurrent`) the person reviewed, or `null` when they continued without it (never the
   * cache), for "Resend as a new operation" / "Review, then save as new". `null`: nothing can be rebuilt.
   * A kind that registers none is never offered them: the dialog offers only what the store can do (discard). `related`: the other rows
   * the same authorised read returned (`CurrentRead.related`), for their facts (a task's details and whether I may change them), never a
   * base.
   */
  rebuild?(
    draft: DraftWithCommand,
    current: CacheRow | null,
    related?: readonly CacheRow[],
  ): EnqueueRequest | null;
  /**
   * The command needs a connection and is never queued (enrolment, rota consent, a sharing or policy change): the dialog shows the
   * online-only variant, with nothing to compare or resend.
   */
  onlineOnly?: boolean;
  /**
   * WEB-09b's seam for WF-QUEUE-02's "Currently saved" (R7 of the review of 10 October 2026; the approved amendment
   * `gaps/queue-02-desktop.html` and follow-up decision 4): the target's CURRENT state from an ordinary AUTHORISED read of the server,
   * authorised the same way any ordinary view of it would be. Never the cache: the cache may predate the conflict, be paused or offline,
   * or still hold a resource whose access has changed. The slice knows its resource's endpoint and shape; the data layer supplies the
   * stamped request (`io.get`). `indeterminate`: the read succeeded but cannot be compared (the field or the shape changed). A kind that
   * registers none has no authorised read: the dialog says it could not load the current state and asks before continuing. The data
   * layer seals the WHOLE result this returns against the durable record and the call's scope (R7, second cycle): the slice need not.
   */
  readCurrent?(
    draft: DraftWithCommand,
    io: CurrentReadIo,
  ): Promise<CurrentRead>;
  /**
   * What the kind's commands need of the person's access, by target (`TargetSpec.requiresEdit`/`joinRequiresEdit`), derived from the
   * STORED draft and its body (WEB-10a DA17-N2): a request the data layer rebuilds itself from a stored draft (the defaults review's
   * confirmation) states them again, so a known denial refuses it as it refuses the slice's own save. None: nothing is required.
   */
  admission?(draft: DraftWithCommand): TargetNeeds;
}

/** What the data layer gives a slice's `readCurrent`: one ordinary, stamped, authorised `GET` for the displayed account and epoch. */
export interface CurrentReadIo {
  /** `path` is under the API base (`/tasks/<id>`). A refusal of the session (`StampedRequestError`) or a network failure rejects. */
  get(path: string): Promise<Response>;
  readonly signal: AbortSignal;
}

/** The authorised current-state read of WF-QUEUE-02, as the dialog distinguishes it. */
export type CurrentRead =
  | {
      kind: "loaded";
      value: CacheRow;
      /**
       * Other rows the SAME authorised response returned (a task's details with the task, WEB-10a DA-A1), for a rebuild to consult their
       * facts; the reviewed value, and the only base, is `value`. Absent: none.
       */
      related?: readonly CacheRow[];
    }
  /** The read succeeded but the current state cannot be compared to the queued attempt. */
  | { kind: "indeterminate" }
  | {
      kind: "failed";
      /**
       * `inaccessible`: access was revoked or the target was deleted (`403`/`404`/`410`); `unavailable`: no authorised read exists for
       * this kind, or none could be made (no open account, offline, the session refused it); `error`: anything else.
       */
      reason: "inaccessible" | "unavailable" | "error";
    };

/**
 * The kind of a draft: `command.kind`, else the first member of a command group, else the endpoint, derived once at enqueue into
 * the header (`model/outbox.commandKindOf`). A registry is keyed by it; the data layer never branches on the value.
 */
export function commandKind(draft: Pick<DraftRow, "kind">): string {
  return draft.kind;
}

export interface CommandRegistry {
  register(kind: string, spec: CommandSpec): void;
  describe(draft: DraftRow): string | null;
  /** `resourceId`: the resource asked for (else the draft's only target). A projection of another resource is `null`. */
  projectCreate(
    draft: DraftWithCommand,
    resourceId?: ResourceId,
  ): CacheRow | null;
  /** Whether the draft's kind registered `rebuild` (the dialog's "save as new" actions are offered only then). */
  canRebuild(draft: Pick<DraftRow, "kind">): boolean;
  rebuild(
    draft: DraftWithCommand,
    current: CacheRow | null,
    related?: readonly CacheRow[],
  ): EnqueueRequest | null;
  onlineOnly(draft: Pick<DraftRow, "kind">): boolean;
  /** The kind's authorised current-state read (R7); `failed`/`unavailable` when it registered none, `failed`/`error` if it threw. */
  readCurrent(draft: DraftWithCommand, io: CurrentReadIo): Promise<CurrentRead>;
  /** What the draft's commands need of the person's access (`CommandSpec.admission`); `{}` when its kind registered none. */
  admission(draft: DraftWithCommand): TargetNeeds;
}

export function createCommandRegistry(): CommandRegistry {
  const specs = new Map<string, CommandSpec>();
  return {
    register(kind, spec) {
      if (specs.has(kind))
        throw new Error(`a command kind is registered twice: ${kind}`);
      specs.set(kind, spec);
    },
    describe: (draft) => specs.get(commandKind(draft))?.describe(draft) ?? null,
    projectCreate(draft, resourceId) {
      const target = projectionTarget(draft, resourceId);
      const project = specs.get(commandKind(draft))?.projectCreate;
      if (target === null || project === undefined) return null;
      const projected = project(draft, target);
      return projected !== null && projected.id === target ? projected : null;
    },
    canRebuild: (draft) =>
      typeof specs.get(commandKind(draft))?.rebuild === "function",
    rebuild: (draft, current, related) =>
      specs.get(commandKind(draft))?.rebuild?.(draft, current, related) ?? null,
    onlineOnly: (draft) => specs.get(commandKind(draft))?.onlineOnly === true,
    admission: (draft) =>
      specs.get(commandKind(draft))?.admission?.(draft) ?? {},
    async readCurrent(draft, io) {
      const read = specs.get(commandKind(draft))?.readCurrent;
      if (read === undefined) return { kind: "failed", reason: "unavailable" };
      try {
        return await read(draft, io);
      } catch {
        return { kind: "failed", reason: "error" };
      }
    },
  };
}

// ---- ConflictHandlerRegistry -----------------------------------------------------------------------------------------------------
/** What a handler decides about a `409` it recognises. `default` leaves the generic rule of plan 5.5.4 in place. */
export type ConflictDecision =
  | { kind: "default" }
  | {
      kind: "reclassify";
      /** `retry`: treat it as the unrecognised path (stays `in_flight`, retried with the same key under the back-off). */
      as: "version_conflict" | "operation_conflict" | "rejected" | "retry";
    };

export interface ConflictContext {
  /** The draft with its body: the dispatcher holds it from the claim, so a handler may inspect the command it sent. */
  draft: DraftWithCommand;
  /** The HTTP status (a `409`) and the error `code`. */
  status: number;
  code: string;
}

export interface ConflictHandlerRegistry {
  register(
    code: string,
    handler: (context: ConflictContext) => ConflictDecision,
  ): void;
  decide(context: ConflictContext): ConflictDecision;
}

export function createConflictHandlerRegistry(): ConflictHandlerRegistry {
  const handlers = new Map<
    string,
    (context: ConflictContext) => ConflictDecision
  >();
  return {
    register(code, handler) {
      if (handlers.has(code))
        throw new Error(`a conflict handler is registered twice: ${code}`);
      handlers.set(code, handler);
    },
    decide(context) {
      const handler = handlers.get(context.code);
      if (handler === undefined) return { kind: "default" };
      try {
        return handler(context);
      } catch {
        // A throwing handler must not wedge the queue: the generic rule applies.
        return { kind: "default" };
      }
    },
  };
}
