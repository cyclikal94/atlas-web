import type { CacheRow, CommandRegistry, DraftWithCommand } from "../../data";
import { DESCRIBE_CONFIGURE, DESCRIBE_CREATE } from "./copy";
import { CONFIGURE_SOURCE, CREATE_SOURCE } from "./model/commands";

/**
 * What the calendar slice teaches the generic outbox about its two QUEUED commands (WEB-13a): a content-free description for the
 * queue (`/sync`) and, for a create, the projection that shows the source before the server has it. Registered once, at composition
 * (`src/app/commands.ts`).
 */
export function registerCalendarCommands(registry: CommandRegistry): void {
  registry.register(CREATE_SOURCE, {
    describe: () => DESCRIBE_CREATE,
    projectCreate: projectSourceCreate,
  });
  registry.register(CONFIGURE_SOURCE, { describe: () => DESCRIBE_CONFIGURE });
}

/** A queued `create_source` as the cache row it will become, or null when the body is not one. */
export function projectSourceCreate(draft: DraftWithCommand): CacheRow | null {
  const wrapped = (draft.command as { command?: unknown }).command;
  if (typeof wrapped !== "object" || wrapped === null) return null;
  const { kind, id, label, timezone } = wrapped as Record<string, unknown>;
  if (
    kind !== CREATE_SOURCE ||
    typeof id !== "string" ||
    typeof label !== "string" ||
    typeof timezone !== "string"
  )
    return null;
  return {
    id,
    kind: "calendar_source",
    parent_id: null,
    label,
    value: {
      health: "pending",
      last_success: null,
      coverage_start: null,
      coverage_end: null,
      timezone,
    },
    version: 1,
    can_edit: true,
    archived: false,
    kind_date: null,
  };
}
