import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  completeKept,
  editKept,
  forgetKept,
  keptEntry,
  keptKey,
  openKept,
  releaseKept,
  submitKept,
  subscribeKept,
  useKeptInput,
} from "../../../src/features/tasks/kept-input";

/**
 * WEB-10b revision 2 (review 2 R1, design assessment P1/Q1): settling a save is ONE transition of the kept session. The ticket names the
 * session's single pending save (its flight); `change` (what the save leaves: an id retired or bound) is evaluated once and does not move
 * the revision; the note and the end of the flight are set before anyone is told; and every editor holding the session then shows the
 * entry as it is, including an editor mounted after the save was taken (the dialog removed for the sync screens and mounted again).
 */
const ME = "me:1";
const key = keptKey(ME, "editor");
afterEach(() => {
  cleanup();
  forgetKept();
});

interface Value {
  text: string;
  id: string;
}

describe("the flight", () => {
  test("a second submit while a save is pending is refused; after it settles, the next one is taken", () => {
    const entry = openKept<Value>(key, ME, () => ({ text: "", id: "a" }));
    editKept(key, entry.session, { text: "one", id: "a" });
    const first = submitKept(key, entry.session);
    expect(first).not.toBeNull();
    expect(submitKept(key, entry.session), "one save at a time").toBeNull();
    expect(completeKept(first as never, false, { note: "no" })).toBe("kept");
    const second = submitKept(key, entry.session);
    expect(second).not.toBeNull();
    expect(second?.flight).not.toBe(first?.flight);
  });

  test("a ticket that is not the pending save settles nothing: its change is not run, the pending save stays pending", () => {
    const entry = openKept<Value>(key, ME, () => ({ text: "", id: "a" }));
    editKept(key, entry.session, { text: "one", id: "a" });
    const first = submitKept(key, entry.session) as NonNullable<
      ReturnType<typeof submitKept>
    >;
    completeKept(first, false, { note: "first refused" });
    const second = submitKept(key, entry.session);
    let ran = 0;
    const again = completeKept<Value>(first, false, {
      note: "late",
      change: (v) => {
        ran += 1;
        return { ...v, id: "stale" };
      },
    });
    expect(again).toBe("gone");
    expect(ran).toBe(0);
    const now = keptEntry<Value>(key);
    expect(now?.submitting, "the pending save is still pending").not.toBeNull();
    expect(now?.value.id).toBe("a");
    expect(now?.note).toBe("first refused");
    // Control: the pending save's own ticket settles it.
    expect(completeKept(second as never, false, { note: "second" })).toBe(
      "kept",
    );
    expect(keptEntry<Value>(key)?.submitting).toBeNull();
  });

  test("a ticket of another session of the same key settles nothing", () => {
    const entry = openKept<Value>(key, ME, () => ({ text: "", id: "a" }));
    editKept(key, entry.session, { text: "one", id: "a" });
    const ticket = submitKept(key, entry.session) as NonNullable<
      ReturnType<typeof submitKept>
    >;
    expect(
      completeKept({ ...ticket, session: ticket.session + 1000 }, true),
    ).toBe("gone");
    expect(keptEntry<Value>(key)?.submitting).not.toBeNull();
  });
});

describe("one transition", () => {
  test("the change runs once, before the editors are told; it does not move the revision; the note and the end of the flight with it", () => {
    const entry = openKept<Value>(key, ME, () => ({ text: "", id: "a" }));
    editKept(key, entry.session, { text: "one", id: "a" });
    const ticket = submitKept(key, entry.session) as NonNullable<
      ReturnType<typeof submitKept>
    >;
    // Newer input while the save is pending.
    editKept(key, entry.session, { text: "two", id: "a" });
    const revision = keptEntry<Value>(key)?.revision;
    const told: Array<{ value: Value | undefined; busy: boolean }> = [];
    const stop = subscribeKept(key, () => {
      const now = keptEntry<Value>(key);
      told.push({ value: now?.value, busy: now?.submitting !== null });
    });
    let ran = 0;
    const result = completeKept<Value>(ticket, true, {
      note: "newer kept",
      change: (v) => {
        ran += 1;
        return { ...v, id: `fresh-${ran}` };
      },
    });
    stop();
    expect(result).toBe("kept");
    expect(ran, "evaluated once").toBe(1);
    expect(told, "told once, of the final state").toEqual([
      { value: { text: "two", id: "fresh-1" }, busy: false },
    ]);
    const now = keptEntry<Value>(key);
    expect(now?.revision, "what a save leaves is not an edit").toBe(revision);
    expect(now?.note).toBe("newer kept");
  });

  test("a success at the submitted revision consumes the session: the change is not run", () => {
    const entry = openKept<Value>(key, ME, () => ({ text: "", id: "a" }));
    editKept(key, entry.session, { text: "one", id: "a" });
    const ticket = submitKept(key, entry.session) as NonNullable<
      ReturnType<typeof submitKept>
    >;
    let ran = 0;
    expect(
      completeKept<Value>(ticket, true, {
        change: (v) => {
          ran += 1;
          return v;
        },
      }),
    ).toBe("consumed");
    expect(ran).toBe(0);
    expect(keptEntry(key)).toBeNull();
  });
});

describe("the editor mounted when it settles", () => {
  const consumed = () => null;
  test("an editor mounted after the save was taken shows the settled value, note and busy state (the original mount gone)", () => {
    const first = renderHook(() =>
      useKeptInput<Value>(key, ME, () => ({ text: "", id: "a" }), {
        consumed,
      }),
    );
    act(() => first.result.current.edit((v) => ({ ...v, text: "one" })));
    let ticket: ReturnType<typeof submitKept> = null;
    act(() => {
      ticket = first.result.current.submit();
    });
    expect(ticket).not.toBeNull();
    act(() => first.result.current.edit((v) => ({ ...v, text: "two" })));
    // Another editor holds the session before the first lets go (as Back mounts the dialog while React removes the old one).
    const second = renderHook(() =>
      useKeptInput<Value>(key, ME, () => ({ text: "", id: "a" }), {
        consumed,
      }),
    );
    first.unmount();
    expect(second.result.current.busy).toBe(true);
    expect(second.result.current.value).toEqual({ text: "two", id: "a" });
    act(() => {
      completeKept<Value>(ticket as never, true, {
        note: "kept",
        change: (v) => ({ ...v, id: "fresh" }),
      });
    });
    expect(second.result.current.value).toEqual({ text: "two", id: "fresh" });
    expect(second.result.current.note).toBe("kept");
    expect(second.result.current.busy).toBe(false);
    second.unmount();
  });

  test("control: the editor that took the save shows the same final state", () => {
    const only = renderHook(() =>
      useKeptInput<Value>(key, ME, () => ({ text: "", id: "a" }), {
        consumed,
      }),
    );
    act(() => only.result.current.edit((v) => ({ ...v, text: "one" })));
    let ticket: ReturnType<typeof submitKept> = null;
    act(() => {
      ticket = only.result.current.submit();
    });
    act(() => only.result.current.edit((v) => ({ ...v, text: "two" })));
    act(() => {
      completeKept<Value>(ticket as never, true, {
        note: "kept",
        change: (v) => ({ ...v, id: "fresh" }),
      });
    });
    expect(only.result.current.value).toEqual({ text: "two", id: "fresh" });
    expect(only.result.current.busy).toBe(false);
    expect(keptEntry<Value>(key)?.value).toEqual({ text: "two", id: "fresh" });
    only.unmount();
  });

  test("settled while no editor holds it, a later editor opens on the settled state", () => {
    const first = renderHook(() =>
      useKeptInput<Value>(key, ME, () => ({ text: "", id: "a" }), {
        consumed,
      }),
    );
    act(() => first.result.current.edit((v) => ({ ...v, text: "one" })));
    let ticket: ReturnType<typeof submitKept> = null;
    act(() => {
      ticket = first.result.current.submit();
    });
    act(() => first.result.current.edit((v) => ({ ...v, text: "two" })));
    const session = keptEntry<Value>(key)?.session as number;
    // Kept by a second holder (the owning visit is out of scope here) while the first is gone.
    const hold = openKept<Value>(key, ME, () => ({ text: "", id: "a" }));
    first.unmount();
    act(() => {
      completeKept<Value>(ticket as never, false, {
        note: "refused",
        change: (v) => ({ ...v, id: "bound" }),
      });
    });
    const later = renderHook(() =>
      useKeptInput<Value>(key, ME, () => ({ text: "", id: "a" }), {
        consumed,
      }),
    );
    releaseKept(key, hold.session);
    expect(keptEntry<Value>(key)?.session).toBe(session);
    expect(later.result.current.value).toEqual({ text: "two", id: "bound" });
    expect(later.result.current.note).toBe("refused");
    expect(later.result.current.busy).toBe(false);
    later.unmount();
  });
});
