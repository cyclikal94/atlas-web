import { type CommandRegistry, getPageDataHost } from "../data";
import { registerCalendarCommands } from "../features/calendars/register";

/**
 * Register the feature commands once in the page's shared registry (WEB-09b P-4, WEB-13a D-13a-5). The protected tree and the
 * page's data host use the same registry. Remounts and Strict Mode replays retain it; a fresh test host gets its own registration.
 * Importing this module does nothing by itself.
 */
const registered = new WeakSet<CommandRegistry>();

export function appCommands(): CommandRegistry {
  const registry = getPageDataHost().commands;
  if (!registered.has(registry)) {
    registerCalendarCommands(registry);
    registered.add(registry);
  }
  return registry;
}
