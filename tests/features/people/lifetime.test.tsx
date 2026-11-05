import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  admit,
  completeSession,
  isPending,
  preparedFor,
  reportSession,
  settle,
  useEditingSession,
} from "../../../src/features/people/lifetime";
import {
  forgetAllPeopleMemory,
  type PeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";

/**
 * Review 7, finding 1: the admission, report and preparation primitives of an editing session (`lifetime.ts`), as pure page-memory
 * operations, and which mount owns a session. The component schedules are `session-admission.test.tsx`.
 */
beforeEach(() => forgetAllPeopleMemory());
afterEach(() => cleanup());

let n = 0;
const newId = () => {
  n += 1;
  return `id-${n}`;
};

describe("admit / settle", () => {
  test("one save per key at a time; every key of a claim is taken at once, or none", () => {
    const memory = peopleMemory("a:1");
    const first = admit(memory, ["s1"], newId);
    expect(first).not.toBeNull();
    expect(isPending(memory, "s1")).toBe(true);
    expect(admit(memory, ["s1"], newId)).toBeNull();
    // A claim of the session AND the field's archive is refused whole while the session's save runs: nothing of it is taken.
    expect(admit(memory, ["s1", "archive:f"], newId)).toBeNull();
    expect(isPending(memory, "archive:f")).toBe(false);
    settle(first as NonNullable<typeof first>);
    expect(isPending(memory, "s1")).toBe(false);
    expect(admit(memory, ["s1", "archive:f"], newId)).not.toBeNull();
  });

  test("an old save's settlement never frees a later save's claim of the same key", () => {
    const memory = peopleMemory("a:1");
    const first = admit(memory, ["s1"], newId) as NonNullable<
      ReturnType<typeof admit>
    >;
    settle(first);
    const second = admit(memory, ["s1"], newId) as NonNullable<
      ReturnType<typeof admit>
    >;
    settle(first);
    expect(isPending(memory, "s1")).toBe(true);
    settle(second);
    expect(isPending(memory, "s1")).toBe(false);
  });

  test("another identity's memory admits nothing for the old one", () => {
    const memory = peopleMemory("a:1");
    peopleMemory("b:1");
    expect(admit(memory, ["s1"], newId)).toBeNull();
  });
});

describe("reportSession", () => {
  test("told to the mounted form of the session; kept (merged) for its next mount while none is; dropped for an ended session", () => {
    const memory = peopleMemory("a:1");
    const told: unknown[] = [];
    function Form({ session }: { session: string }) {
      useEditingSession<Record<string, unknown>>(memory, session, {
        revision: () => 0,
        close: () => undefined,
        keep: () => undefined,
        report: (update) => told.push(update),
      });
      return null;
    }
    const view = render(<Form session="s1" />);
    reportSession(memory, "k", "s1", { a: 1 });
    expect(told).toEqual([{ a: 1 }]);
    view.unmount();
    // Kept input of the session: the reports wait for the next mount, merged later over earlier.
    memory.drafts.set("k", { session: "s1" });
    reportSession(memory, "k", "s1", { a: 2, b: 1 });
    reportSession(memory, "k", "s1", { a: 3 });
    render(<Form session="s1" />);
    expect(told).toEqual([{ a: 1 }, { a: 3, b: 1 }]);
    expect(memory.reports.has("s1")).toBe(false);
    cleanup();
    // Another session's input under the key (Cancel and a new form): nothing is kept for the ended one.
    memory.drafts.set("k", { session: "s2" });
    reportSession(memory, "k", "s1", { a: 4 });
    expect(memory.reports.has("s1")).toBe(false);
  });
});

describe("preparedFor", () => {
  test("the same basis is the same request; another basis prepares anew; the session's completion spends it", () => {
    const memory: PeopleMemory = peopleMemory("a:1");
    const one = preparedFor(memory, "s1", "x", () => ({ id: newId() }));
    expect(preparedFor(memory, "s1", "x", () => ({ id: newId() }))).toBe(one);
    const two = preparedFor(memory, "s1", "y", () => ({ id: newId() }));
    expect(two).not.toBe(one);
    expect(preparedFor(memory, "s2", "y", () => ({ id: newId() }))).not.toBe(
      two,
    );
    memory.drafts.set("k", { session: "s1" });
    completeSession(memory, "k", "s1", null, () => 0);
    expect(preparedFor(memory, "s1", "y", () => ({ id: newId() }))).not.toBe(
      two,
    );
  });
});

describe("useEditingSession: which mount owns the session", () => {
  test("the latest mount owns it; an earlier mount does not, even while still mounted, nor after the latest is gone", () => {
    const memory = peopleMemory("a:1");
    const owns: Record<string, () => boolean> = {};
    function Form({ name }: { name: string }) {
      owns[name] = useEditingSession(memory, "s1", {
        revision: () => 0,
        close: () => undefined,
        keep: () => undefined,
        report: () => undefined,
      });
      return null;
    }
    const a = render(<Form name="a" />);
    expect(owns.a?.()).toBe(true);
    const b = render(<Form name="b" />);
    expect(owns.b?.()).toBe(true);
    expect(owns.a?.()).toBe(false);
    b.unmount();
    expect(owns.a?.()).toBe(false);
    a.unmount();
    expect(owns.a?.()).toBe(false);
  });
});
