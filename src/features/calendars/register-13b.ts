import type { CommandRegistry } from "../../data";
import { DESCRIBE_SET_ANCHOR } from "./copy-anchor";
import { DESCRIBE_IMPORT } from "./copy-import";
import { DESCRIBE_RESOLVE_REVIEW } from "./copy-review";
import { IMPORT_ENDPOINT } from "./model/commands";

/** The kinds of WEB-13b's queued calendar commands, as the draft header records them (`commandKindOf`). */
export const SET_ANCHOR = "set_anchor";
export const RESOLVE_REVIEW = "resolve_review";

const registered = new WeakSet<CommandRegistry>();

/**
 * What WEB-13b teaches the queue about its three queued commands: a content-free description each (the header only; an import's body is
 * never read for it). Nothing more: no projection (none of them creates a resource), no rebuild and no current-state read, so the queue's
 * item dialog offers what the store can do (discard) and never renders an import's text. Idempotent per registry; loaded lazily (the
 * protected tree's lazy registrations, and the calendar screen for a test's or the fixture's own registry).
 */
export function registerCalendarExtensions(registry: CommandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register(IMPORT_ENDPOINT, { describe: () => DESCRIBE_IMPORT });
  registry.register(SET_ANCHOR, { describe: () => DESCRIBE_SET_ANCHOR });
  registry.register(RESOLVE_REVIEW, {
    describe: () => DESCRIBE_RESOLVE_REVIEW,
  });
}
