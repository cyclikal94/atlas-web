import { expect } from "vitest";

/**
 * WEB-18 revision 4 (review 5 F-R11/F-R12, finding family `mutant-oracle-throws-before-asserting`): the element a test is about to
 * judge or use, asserted present first, so that a lookup which finds nothing fails by an `expect` assertion. Without it a missing
 * element fails by something that THROWS before anything is compared: jest-dom's "received value must be a Node" (`toHaveTextContent`
 * on `null`), a Testing Library `getBy…` error, or a `TypeError` reading a property of `null`. The merged unit-mutation runner
 * (`scripts/mutation/unit-runner.mjs`, WEB-14a revisions 27 to 29) admits a catch only on a recorded assertion origin, so such a throw
 * makes a mutant's catch `crash_only` or `tainted`. This adds an assertion and changes none: the matcher that follows is the same.
 *
 * `undefined` (an index past the end of a list) counts as absent too.
 */
export function present<T extends Element>(
  element: T | null | undefined,
  what: string,
): T {
  expect(element ?? null, `${what} is shown`).not.toBeNull();
  return element as T;
}
