import { waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * An element the test ASSERTS is on screen, found with a `queryBy*` query. Testing Library's `getBy*` and `findBy*` throw their own error
 * when the element is missing, which the unit mutation runner rightly does not take for an assertion (scripts/validation/unit-results.mjs,
 * WEB-08d revision 17): a mutant that removes or renames what the requirement names would then fail its run as a crash. This states the
 * same check as an assertion, naming what was looked for.
 */
export function shown<T extends Element>(element: T | null, what: string): T {
  expect(element, `${what} is shown`).not.toBeNull();
  return element as T;
}

/** `shown`, waited for exactly as `findBy*` waits (Testing Library's `waitFor` with its default timeout and observer). */
export function eventuallyShown<T extends Element>(
  query: () => T | null,
  what: string,
): Promise<T> {
  return waitFor(() => shown(query(), what));
}
