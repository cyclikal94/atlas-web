// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import {
  doubtPolicy,
  forgetAllPeopleMemory,
  isCurrentMemory,
  notePolicy,
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
    a.heldRuns.set("h", { holdId: "h", cancelled: false, policyDone: false });
    const b = peopleMemory("acct:2");
    expect(b.dismissedOf("p").size).toBe(0);
    expect(b.attempts.size).toBe(0);
    expect(b.heldRuns.size).toBe(0);
    expect(isCurrentMemory(a)).toBe(false);
    // Coming back to the first identity does not bring its PAGE memory back (held changes are durable, in the account's database:
    // field/held-store.ts; this memory holds only what a page learnt).
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

describe("review 3, finding 3: a late policy read never lowers the one kept (C6, A1)", () => {
  test("notePolicy keeps the higher version; an equal or higher one replaces it", () => {
    const memory = peopleMemory("acct:1");
    const policy = { grants: [], exclude_accounts: [] };
    notePolicy(memory, "f", { version: 7, policy, checkedAt: 2 });
    notePolicy(memory, "f", { version: 6, policy, checkedAt: 3 });
    expect(memory.policies.get("f")).toMatchObject({
      version: 7,
      checkedAt: 2,
    });
    notePolicy(memory, "f", { version: 7, policy, checkedAt: 4 });
    expect(memory.policies.get("f")).toMatchObject({
      version: 7,
      checkedAt: 4,
    });
  });
});

describe("review 23, R23.1: a kept policy the sharing editor may have changed is doubted until a read asked after it answers", () => {
  const policy = { grants: [], exclude_accounts: [] };

  test("a doubt keeps the read's version as the floor and takes the field's read away from the one on its way", () => {
    const memory = peopleMemory("acct:1");
    notePolicy(memory, "f", { version: 6, policy, checkedAt: 1 });
    const pending = {};
    memory.policyReads.set("f", pending);
    let seen = 0;
    memory.subscribe(() => {
      seen += 1;
    });
    doubtPolicy(memory, "f");
    expect(memory.policyDoubts.has("f")).toBe(true);
    expect(memory.policyReads.has("f")).toBe(false);
    expect(memory.policies.get("f")?.version).toBe(6);
    expect(seen).toBe(1);
    // An answer asked before the doubt is still evidence of the version, but it ends nothing.
    notePolicy(memory, "f", { version: 5, policy, checkedAt: 2 });
    expect(memory.policies.get("f")?.version).toBe(6);
    expect(memory.policyDoubts.has("f")).toBe(true);
    notePolicy(memory, "f", { version: 7, policy, checkedAt: 3 });
    expect(memory.policies.get("f")?.version).toBe(7);
    expect(memory.policyDoubts.has("f")).toBe(true);
  });

  test("only the read asked after the LATEST doubt ends it; another field's doubt is its own", () => {
    const memory = peopleMemory("acct:1");
    notePolicy(memory, "f", { version: 6, policy, checkedAt: 1 });
    doubtPolicy(memory, "f");
    const first = memory.policyDoubts.get("f");
    doubtPolicy(memory, "f");
    const second = memory.policyDoubts.get("f");
    expect(second).not.toBe(first);
    doubtPolicy(memory, "g");
    notePolicy(memory, "f", { version: 7, policy, checkedAt: 2 }, first);
    expect(memory.policyDoubts.get("f")).toBe(second);
    notePolicy(memory, "f", { version: 7, policy, checkedAt: 3 }, second);
    expect(memory.policyDoubts.has("f")).toBe(false);
    expect(memory.policyDoubts.has("g")).toBe(true);
  });

  test("a lower version asked after the doubt ends it, but never lowers the kept read", () => {
    const memory = peopleMemory("acct:1");
    notePolicy(memory, "f", { version: 7, policy, checkedAt: 1 });
    doubtPolicy(memory, "f");
    notePolicy(
      memory,
      "f",
      { version: 6, policy, checkedAt: 2 },
      memory.policyDoubts.get("f"),
    );
    expect(memory.policyDoubts.has("f")).toBe(false);
    expect(memory.policies.get("f")).toMatchObject({
      version: 7,
      checkedAt: 1,
    });
  });
});
