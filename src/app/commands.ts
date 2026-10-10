import { type CommandRegistry, createCommandRegistry } from "../data";
import { registerCalendarCommands } from "../features/calendars/register";

/**
 * The application's command registry (WEB-13a, D-13a-5): what each feature slice registered about its queued commands. ONE per
 * module, built on first use and filled once, so a remount of the protected tree or a Strict Mode replay never registers twice and
 * importing this module does nothing by itself.
 */
let registry: CommandRegistry | null = null;

export function appCommands(): CommandRegistry {
  if (registry === null) {
    const built = createCommandRegistry();
    registerCalendarCommands(built);
    registry = built;
  }
  return registry;
}
