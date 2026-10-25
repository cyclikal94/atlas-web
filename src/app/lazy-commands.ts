import type { CommandRegistry } from "../data";
import { registerCalendarExtensions } from "../features/calendars/register-13b";
import { registerTaskCommands } from "../features/tasks/register";

/**
 * The feature registrations that are not needed to draw the shell (WEB-10a's task kinds, WEB-13b's queued calendar kinds): one chunk of
 * their own, loaded by the protected tree, into the page's shared registry. Each registration is idempotent per registry.
 */
export function registerLazyCommands(registry: CommandRegistry): void {
  registerTaskCommands(registry);
  registerCalendarExtensions(registry);
}
