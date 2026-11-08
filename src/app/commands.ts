import { type CommandRegistry, getPageDataHost } from "../data";
import { registerImportAnswers } from "../features/calendars/answers";
import { registerCalendarCommands } from "../features/calendars/register";

/**
 * Register the feature commands once in the page's shared registry (WEB-09b P-4, WEB-13a D-13a-5), and the import's terminal answers
 * once in the page's conflict registry (WEB-13b). The protected tree and the page's data host use the same registries. Remounts and
 * Strict Mode replays retain them; a fresh test host gets its own registration. Importing this module does nothing by itself.
 */
const registered = new WeakSet<object>();

export function appCommands(): CommandRegistry {
  const host = getPageDataHost();
  const registry = host.commands;
  if (!registered.has(registry)) {
    registerCalendarCommands(registry);
    registered.add(registry);
  }
  if (!registered.has(host.conflicts)) {
    registerImportAnswers(host.conflicts);
    registered.add(host.conflicts);
  }
  return registry;
}
