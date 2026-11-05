import { expect } from "@playwright/test";
import type { RuntimeDisposalObservation } from "../../src/fixture/data-harness/runtime-lifetime";

/**
 * Shared by the original R43 arrangement and its deterministic native controls. The old native-success prediction
 * remains an explicit input for historical evidence and the negative qualification probe; it is not installation.
 */
export function assertRuntimeClosures(input: {
  disposals: RuntimeDisposalObservation[];
  closed: number;
  legacyNativeSuccess: boolean;
}): void {
  for (const disposal of input.disposals) {
    expect(
      disposal.closesAfter,
      "disposal observation completed",
    ).not.toBeNull();
    expect((disposal.closesAfter ?? -1) - disposal.closesBefore).toBe(
      disposal.live ? 1 : 0,
    );
    if (disposal.live) expect(disposal.service).not.toBeNull();
  }
  expect(
    input.closed,
    "every closure belongs to an observed installed-service disposal, including repeated tree lifetimes",
  ).toBe(input.disposals.filter((disposal) => disposal.live).length);
  const expectedClosure = input.disposals.some((disposal) => disposal.live);
  expect(input.closed > 0, "installed service is the closure predicate").toBe(
    expectedClosure,
  );
}
