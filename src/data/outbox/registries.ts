import type { CacheRow, DraftRow, DraftWithCommand } from "../model/types";

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
   * body, which the merged read of ONE resource joins for the queued creates against that resource.
   */
  projectCreate?(draft: DraftWithCommand): CacheRow | null;
}

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
  projectCreate(draft: DraftWithCommand): CacheRow | null;
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
    projectCreate: (draft) =>
      specs.get(commandKind(draft))?.projectCreate?.(draft) ?? null,
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
