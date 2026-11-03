import { beforeEach, describe, expect, test } from "vitest";
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import {
  captureMergeName,
  chooseMergeName,
  consumeMergeName,
  mergeNameChoice,
  mergeNameDraft,
  mergeNameKey,
} from "../../../src/features/people/requests/mergeName";

/**
 * The sender's name-choice ownership mechanics (R1 of review 4, `requests/mergeName.ts`): each edit is a new record (its ticket); a fresh
 * attempt captures the current record (a default is made explicit); a success consumes only its own still-current record in the identity's
 * current memory, notifying readers. These qualify the mechanism; the mounted schedules are in `merge-name-ownership.test.tsx`.
 */
const P = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
] as const;
const Q = [
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
] as const;
beforeEach(() => forgetAllPeopleMemory());

/** How many times readers of `memory` were notified while `act` ran. */
function notified(memory: ReturnType<typeof peopleMemory>, act: () => void) {
  let count = 0;
  const stop = memory.subscribe(() => {
    count += 1;
  });
  act();
  stop();
  return count;
}

describe("the merge name choice: records and tickets", () => {
  test("nothing chosen: no record, and the kept person's name applies", () => {
    const memory = peopleMemory("me:1");
    expect(mergeNameDraft(memory, ...P)).toBeNull();
    expect(mergeNameChoice(null)).toBe("target");
  });

  test("every edit is a new frozen record, even one that chooses the same value again, and readers are notified", () => {
    const memory = peopleMemory("me:1");
    let first = null as ReturnType<typeof chooseMergeName> | null;
    expect(
      notified(memory, () => {
        first = chooseMergeName(memory, ...P, "source");
      }),
    ).toBe(1);
    const again = chooseMergeName(memory, ...P, "source");
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
    expect(Object.isFrozen(again)).toBe(true);
    expect(mergeNameDraft(memory, ...P)).toBe(again);
    expect(again.key).toBe(mergeNameKey(...P));
  });

  test("a value that is not a record of the pair is not read as a choice", () => {
    const memory = peopleMemory("me:1");
    memory.drafts.set(mergeNameKey(...P), "source");
    expect(mergeNameDraft(memory, ...P)).toBeNull();
    memory.drafts.set(mergeNameKey(...P), {
      key: mergeNameKey(...Q),
      choice: "source",
    });
    expect(mergeNameDraft(memory, ...P)).toBeNull();
  });
});

describe("the merge name choice: capture at the original preparation", () => {
  test("a default never chosen is made an explicit record (without notifying), and a capture without an edit is that same record", () => {
    const memory = peopleMemory("me:1");
    let captured = null as ReturnType<typeof captureMergeName>;
    expect(
      notified(memory, () => {
        captured = captureMergeName(memory, ...P, null);
      }),
    ).toBe(0);
    expect(captured).toEqual({ key: mergeNameKey(...P), choice: "target" });
    expect(mergeNameDraft(memory, ...P)).toBe(captured);
    expect(captureMergeName(memory, ...P, captured)).toBe(captured);
  });

  test("the chosen record is captured as it is", () => {
    const memory = peopleMemory("me:1");
    const chosen = chooseMergeName(memory, ...P, "source");
    expect(captureMergeName(memory, ...P, chosen)).toBe(chosen);
  });

  test("a stale render (its record is no longer the current one) captures nothing", () => {
    const memory = peopleMemory("me:1");
    const rendered = chooseMergeName(memory, ...P, "source");
    chooseMergeName(memory, ...P, "source");
    expect(captureMergeName(memory, ...P, rendered)).toBeNull();
    expect(captureMergeName(memory, ...P, null)).toBeNull();
  });
});

describe("the merge name choice: a success consumes only its own capture", () => {
  test("its own, still current record: consumed, and readers are notified", () => {
    const memory = peopleMemory("me:1");
    const owned = captureMergeName(
      memory,
      ...P,
      chooseMergeName(memory, ...P, "source"),
    );
    let outcome = "";
    expect(
      notified(memory, () => {
        outcome = consumeMergeName(memory, owned);
      }),
    ).toBe(1);
    expect(outcome).toBe("consumed");
    expect(mergeNameDraft(memory, ...P)).toBeNull();
    expect(memory.drafts.has(mergeNameKey(...P))).toBe(false);
  });

  test("a newer record (even of the same value) is kept, untouched and unnotified", () => {
    const memory = peopleMemory("me:1");
    const owned = captureMergeName(memory, ...P, null);
    chooseMergeName(memory, ...P, "source");
    const newer = chooseMergeName(memory, ...P, "target");
    expect(newer.choice).toBe(owned?.choice);
    let outcome = "";
    expect(
      notified(memory, () => {
        outcome = consumeMergeName(memory, owned);
      }),
    ).toBe(0);
    expect(outcome).toBe("kept");
    expect(mergeNameDraft(memory, ...P)).toBe(newer);
  });

  test("an unknown owner (no origin) never adopts the current record", () => {
    const memory = peopleMemory("me:1");
    const current = chooseMergeName(memory, ...P, "source");
    expect(consumeMergeName(memory, null)).toBe("kept");
    expect(mergeNameDraft(memory, ...P)).toBe(current);
  });

  test("already gone: nothing is removed or notified", () => {
    const memory = peopleMemory("me:1");
    const owned = captureMergeName(memory, ...P, null);
    memory.drafts.delete(mergeNameKey(...P));
    expect(notified(memory, () => consumeMergeName(memory, owned))).toBe(0);
  });

  test("another pair's record is never consumed by this pair's ticket", () => {
    const memory = peopleMemory("me:1");
    const owned = captureMergeName(memory, ...P, null);
    const theirs = chooseMergeName(memory, ...Q, "source");
    expect(consumeMergeName(memory, owned)).toBe("consumed");
    expect(mergeNameDraft(memory, ...Q)).toBe(theirs);
    // The reversed pair is another pair.
    const reversed = chooseMergeName(memory, P[1], P[0], "source");
    expect(consumeMergeName(memory, theirs)).toBe("consumed");
    expect(mergeNameDraft(memory, P[1], P[0])).toBe(reversed);
  });

  test("a continuation of a replaced memory (another identity) consumes nothing, there or in the current memory", () => {
    const old = peopleMemory("me:1");
    const owned = captureMergeName(
      old,
      ...P,
      chooseMergeName(old, ...P, "source"),
    );
    const next = peopleMemory("other:1");
    const theirs = chooseMergeName(next, ...P, "source");
    expect(notified(old, () => consumeMergeName(old, owned))).toBe(0);
    expect(consumeMergeName(old, owned)).toBe("stale");
    expect(mergeNameDraft(old, ...P)).toBe(owned);
    expect(mergeNameDraft(next, ...P)).toBe(theirs);
  });

  test("compared and consumed in one synchronous step (no promise between)", () => {
    const memory = peopleMemory("me:1");
    const owned = captureMergeName(memory, ...P, null);
    const outcome = consumeMergeName(memory, owned);
    expect(typeof outcome).toBe("string");
    expect(memory.drafts.has(mergeNameKey(...P))).toBe(false);
  });
});
