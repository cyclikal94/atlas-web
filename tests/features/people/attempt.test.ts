// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  afterOutcome,
  attemptFor,
  canonicalBody,
} from "../../../src/features/people/model/attempt";

/** One attempt per body for the online-only people commands (§4.7; WEB-12a rule 5, reused). */
let n = 0;
const newKey = () => {
  n += 1;
  return `key-${n}`;
};
const body = (name: string) => ({
  command: {
    kind: "rename_profile",
    person_id: "p",
    expected_version: 3,
    name,
  },
});

describe("online-only attempts", () => {
  test("after an uncertain outcome, the same body is resent under the SAME key and byte-identical body", () => {
    const first = attemptFor(null, body("Mo"), newKey);
    const kept = afterOutcome(first, null, "uncertain");
    const again = attemptFor(kept, body("Mo"), newKey);
    expect(again).toBe(first);
    expect(again.body).toBe(canonicalBody(body("Mo")));
  });

  test("an edit after an uncertain outcome is a new body under a NEW key", () => {
    const first = attemptFor(null, body("Mo"), newKey);
    const edited = attemptFor(first, body("Mohammed"), newKey);
    expect(edited.key).not.toBe(first.key);
  });

  test("a Try again that was not sent keeps the uncertain attempt as it was", () => {
    const first = attemptFor(null, body("Mo"), newKey);
    const kept = afterOutcome(first, null, "uncertain");
    const retry = attemptFor(kept, body("Mo"), newKey);
    expect(afterOutcome(retry, kept, "not_sent")).toBe(kept);
  });

  test("a definite answer ends the attempt", () => {
    const first = attemptFor(null, body("Mo"), newKey);
    expect(afterOutcome(first, first, "ok")).toBeNull();
    expect(afterOutcome(first, first, "refused")).toBeNull();
  });

  test("the body is canonical: key order does not make a different body", () => {
    expect(canonicalBody({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalBody({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});
