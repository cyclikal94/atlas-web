// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import {
  forgetAllPeopleMemory,
  isCurrentMemory,
  peopleMemory,
} from "../../../src/features/people/memory";

/** The people page memory (§3.2): kept for ONE displayed identity, outliving remounts, never crossing identities (A20). */
beforeEach(() => forgetAllPeopleMemory());

describe("page memory", () => {
  test("the same identity gets the same memory (a remount keeps what was learnt)", () => {
    const a = peopleMemory("acct:1");
    a.refused.set("p", "forbidden");
    expect(peopleMemory("acct:1")).toBe(a);
    expect(peopleMemory("acct:1").refused.get("p")).toBe("forbidden");
  });

  test("another identity (another account, or a later epoch of the same one) starts empty and the old memory is dropped", () => {
    const a = peopleMemory("acct:1");
    a.dismiss("p", "q");
    a.attempts.set("rename:p", { key: "k", body: "{}" });
    a.held.set("f", {} as never);
    const b = peopleMemory("acct:2");
    expect(b.dismissedOf("p").size).toBe(0);
    expect(b.attempts.size).toBe(0);
    expect(b.held.size).toBe(0);
    expect(isCurrentMemory(a)).toBe(false);
    // Coming back to the first identity does not bring its memory back.
    expect(peopleMemory("acct:1").dismissedOf("p").size).toBe(0);
  });

  test("a dismissed pair is one pair from either side, and every change is observed", () => {
    const memory = peopleMemory("acct:1");
    let seen = 0;
    const off = memory.subscribe(() => {
      seen += 1;
    });
    memory.dismiss("p", "q");
    expect(memory.dismissedOf("p").has("q")).toBe(true);
    expect(memory.dismissedOf("q").has("p")).toBe(true);
    expect(seen).toBe(1);
    off();
  });

  test("a superseded memory tells its readers to look again", () => {
    const memory = peopleMemory("acct:1");
    let seen = 0;
    memory.subscribe(() => {
      seen += 1;
    });
    peopleMemory("acct:2");
    expect(seen).toBe(1);
  });
});
