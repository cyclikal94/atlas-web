import { describe, expect, test } from "vitest";
import {
  createImportEditor,
  type ImportSaveOutcome,
} from "../../../src/features/calendars/import-editor";

/**
 * WEB-13b revision 6 (review 6 R7; design assessment C1/C3, invariants 4-6, schedules I5-I11): the import dialog's editing session as a
 * model. Every read and every save is held by an explicit barrier and released in a counted order, so each schedule is deterministic.
 */
const ICS =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a@example\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:A\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** A file whose bytes arrive when the test says (`deliver`), or whose read fails (`fail`). */
function heldFile(name: string, text = ICS) {
  const bytes = deferred<ArrayBuffer>();
  const file = new File([text], name, { type: "text/calendar" });
  Object.defineProperty(file, "arrayBuffer", { value: () => bytes.promise });
  return {
    file,
    deliver: () => bytes.resolve(new TextEncoder().encode(text).buffer),
    fail: () => bytes.reject(new DOMException("gone", "NotReadableError")),
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function editor(options: { keys?: string[] } = {}) {
  const keys = [...(options.keys ?? ["k1", "k2", "k3", "k4"])];
  let consumed = 0;
  const made = createImportEditor({
    today: "2026-10-27",
    mintKey: () => keys.shift() ?? "spare",
    onConsumed: () => {
      consumed += 1;
    },
  });
  return { e: made, consumed: () => consumed };
}

async function chosen(e: ReturnType<typeof editor>["e"], name = "a.ics") {
  const read = heldFile(name);
  e.choose(read.file);
  read.deliver();
  await flush();
  const file = e.state().file;
  expect(file?.name).toBe(name);
  return file as NonNullable<typeof file>;
}

const choice = (
  e: ReturnType<typeof editor>["e"],
  source = "s1",
): { source: string; from: string; through: string; file: number } => ({
  source,
  from: e.state().window.from,
  through: e.state().window.through,
  file: e.state().file?.token ?? -1,
});

describe("reads (I5-I7)", () => {
  test("I5: a read held while nothing shows the session settles in it once, and saves nothing by itself", async () => {
    const { e } = editor();
    const read = heldFile("late.ics");
    e.choose(read.file);
    expect(e.state()).toMatchObject({ reading: true, file: null });
    read.deliver();
    await flush();
    expect(e.state().reading).toBe(false);
    expect(e.state().file?.name).toBe("late.ics");
    expect(e.state().file?.check.ok).toBe(true);
    expect(e.state().busy).toBe(false);
  });

  test("I5: a failed read leaves the session with that file's problem, not reading", async () => {
    const { e } = editor();
    const read = heldFile("broken.ics");
    e.choose(read.file);
    read.fail();
    await flush();
    expect(e.state().reading).toBe(false);
    expect(e.state().file?.check).toEqual({ ok: false, reason: "unreadable" });
  });

  test("I6: a valid A then a replacement B: A is unusable at once; picker cancellation (no file) changes nothing", async () => {
    const { e } = editor();
    await chosen(e, "a.ics");
    const revision = e.state().revision;
    e.choose(undefined);
    expect(e.state().file?.name).toBe("a.ics");
    expect(e.state().revision).toBe(revision);
    const b = heldFile("b.ics");
    e.choose(b.file);
    expect(e.state().file).toBeNull();
    expect(e.state().reading).toBe(true);
    expect(e.state().revision).toBe(revision + 1);
    b.fail();
    await flush();
    // The failure is B's: A never comes back.
    expect(e.state().file?.name).toBe("b.ics");
    expect(e.state().file?.check.ok).toBe(false);
  });

  test("I7: read A pending, choose B, B delivered then A: the latest choice wins and A's late completion changes nothing", async () => {
    const { e } = editor();
    const a = heldFile("a.ics");
    const b = heldFile("b.ics");
    e.choose(a.file);
    e.choose(b.file);
    b.deliver();
    await flush();
    expect(e.state().file?.name).toBe("b.ics");
    a.deliver();
    await flush();
    expect(e.state().file?.name).toBe("b.ics");
    expect(e.state().reading).toBe(false);
  });

  test("I7: a read that completes after the session ended changes nothing (no file, nothing read)", async () => {
    const { e } = editor();
    const a = heldFile("a.ics");
    e.choose(a.file);
    e.end();
    a.deliver();
    await flush();
    expect(e.ended()).toBe(true);
    expect(e.state().file).toBeNull();
  });

  test("I7 control: a read whose session is still the owner completes", async () => {
    const { e } = editor();
    await chosen(e, "a.ics");
    expect(e.ended()).toBe(false);
  });
});

describe("saves (I8-I11)", () => {
  test("I8: one save at a time; a queued save with nothing edited consumes the session and spends its identity", async () => {
    const { e, consumed } = editor();
    await chosen(e);
    const save = deferred<ImportSaveOutcome>();
    const keys: string[] = [];
    let queued = 0;
    expect(
      e.submit(
        choice(e),
        (key) => {
          keys.push(key);
          return save.promise;
        },
        () => {
          queued += 1;
        },
      ),
    ).toBe(true);
    expect(e.state().busy).toBe(true);
    // A second press while the first is being stored stores nothing more.
    expect(e.submit(choice(e), async () => ({ kind: "queued" }))).toBe(false);
    save.resolve({ kind: "queued" });
    await flush();
    expect(keys).toEqual(["k1"]);
    expect(queued).toBe(1);
    expect(consumed()).toBe(1);
    expect(e.ended()).toBe(true);
    expect(e.state().file).toBeNull();
  });

  test("I9: a queued save after newer input (changed and changed back) keeps the input, says so, and the next Import is a NEW operation", async () => {
    const { e, consumed } = editor();
    await chosen(e);
    const save = deferred<ImportSaveOutcome>();
    const keys: string[] = [];
    const pressed = choice(e);
    e.submit(pressed, (key) => {
      keys.push(key);
      return save.promise;
    });
    const from = e.state().window.from;
    e.editWindow({ from: "2026-01-01" });
    e.editWindow({ from });
    save.resolve({ kind: "queued" });
    await flush();
    expect(consumed()).toBe(0);
    expect(e.ended()).toBe(false);
    expect(e.state()).toMatchObject({ busy: false, window: { from } });
    expect(e.state().message).toMatch(/queued/i);
    e.submit(choice(e), async (key) => {
      keys.push(key);
      return { kind: "refused", message: "no" };
    });
    await flush();
    expect(keys).toEqual(["k1", "k2"]);
  });

  test("I10: a refused save keeps the input and its words and clears busy; the same choices pressed again reuse the identity; a throw only clears busy", async () => {
    const { e, consumed } = editor();
    await chosen(e);
    const keys: string[] = [];
    e.submit(choice(e), async (key) => {
      keys.push(key);
      return { kind: "refused", message: "Not saved: the device is full." };
    });
    await flush();
    expect(e.state()).toMatchObject({
      busy: false,
      message: "Not saved: the device is full.",
    });
    expect(e.state().file?.name).toBe("a.ics");
    e.submit(choice(e), (key) => {
      keys.push(key);
      return Promise.reject(new Error("unclassified"));
    });
    await flush();
    expect(e.state().busy).toBe(false);
    e.submit(choice(e), async (key) => {
      keys.push(key);
      return { kind: "queued" };
    });
    await flush();
    expect(keys).toEqual(["k1", "k1", "k1"]);
    expect(consumed()).toBe(1);
  });

  test("I10: a different explicit choice after a refusal is a new operation", async () => {
    const { e } = editor();
    await chosen(e);
    const keys: string[] = [];
    e.submit(choice(e), async (key) => {
      keys.push(key);
      return { kind: "refused", message: "no" };
    });
    await flush();
    e.submit(choice(e, "s2"), async (key) => {
      keys.push(key);
      return { kind: "refused", message: "no" };
    });
    await flush();
    expect(keys).toEqual(["k1", "k2"]);
  });

  for (const reason of ["discarded", "revoked"] as const)
    test(`I11/I12: a save pending when the session is ${reason} settles nothing in it (no consumption, no change); stored, it is announced only when the session was not revoked`, async () => {
      const { e, consumed } = editor();
      await chosen(e);
      const save = deferred<ImportSaveOutcome>();
      let queued = 0;
      e.submit(
        choice(e),
        () => save.promise,
        () => {
          queued += 1;
        },
      );
      e.end(reason);
      const after = e.state();
      save.resolve({ kind: "queued" });
      await flush();
      expect(queued).toBe(reason === "revoked" ? 0 : 1);
      expect(consumed()).toBe(0);
      expect(e.state()).toBe(after);
    });

  test("I11: a refused save of an ended session announces nothing", async () => {
    const { e } = editor();
    await chosen(e);
    const save = deferred<ImportSaveOutcome>();
    let queued = 0;
    e.submit(
      choice(e),
      () => save.promise,
      () => {
        queued += 1;
      },
    );
    e.end();
    save.resolve({ kind: "refused", message: "no" });
    await flush();
    expect(queued).toBe(0);
  });

  test("I11: an ended session's late completion never touches a NEW session at the same edit count", async () => {
    const first = editor();
    await chosen(first.e);
    const save = deferred<ImportSaveOutcome>();
    first.e.submit(choice(first.e), () => save.promise);
    first.e.end();
    const second = editor();
    await chosen(second.e);
    expect(second.e.state().revision).toBe(first.e.state().revision);
    const before = second.e.state();
    save.resolve({ kind: "queued" });
    await flush();
    expect(second.e.ended()).toBe(false);
    expect(second.consumed()).toBe(0);
    expect(second.e.state()).toBe(before);
  });

  test("an ended session refuses every change (choose, source, window, save)", async () => {
    const { e } = editor();
    e.end();
    const before = e.state();
    e.choose(heldFile("x.ics").file);
    e.chooseSource("s9");
    e.editWindow({ from: "2026-01-01" });
    e.setMessage("x");
    expect(e.submit(choice(e), async () => ({ kind: "queued" }))).toBe(false);
    expect(e.state()).toBe(before);
  });

  test("source: choosing one is an edit; pinning one shown is not, and never replaces a choice", () => {
    const { e } = editor();
    e.pinSource("first");
    expect(e.state()).toMatchObject({ chosen: "first", revision: 0 });
    e.pinSource("other");
    expect(e.state().chosen).toBe("first");
    e.chooseSource("s2");
    expect(e.state()).toMatchObject({ chosen: "s2", revision: 1 });
  });
});
