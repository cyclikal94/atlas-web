import { waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * Element lookups that fail by an ASSERTION (VR-20261007 and the mutation runners: a mutant is caught only by an assertion of the test
 * written for it; a Testing Library `findBy…`/`getBy…` throw is an error and makes the verdict INVALID). Same semantics as `findBy…` (the
 * default `waitFor` timeout) and `getBy…` (present now), with the absence reported by `expect`.
 */
export async function present<T>(query: () => T | null): Promise<T> {
  await waitFor(() => expect(query()).not.toBeNull());
  return query() as T;
}
export async function presentAll<T>(query: () => T[]): Promise<T[]> {
  await waitFor(() => expect(query().length).toBeGreaterThan(0));
  return query();
}
export function must<T>(value: T | null): T {
  expect(value).not.toBeNull();
  return value as T;
}
