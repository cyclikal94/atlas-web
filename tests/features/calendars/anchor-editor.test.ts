import { describe, expect, test } from "vitest";
import { createAnchorEditor } from "../../../src/features/calendars/anchor-editor";
import { ANCHOR_SAVED_NEWER } from "../../../src/features/calendars/copy-anchor";
import { EMPTY_ANCHOR } from "../../../src/features/calendars/model/anchor";

/**
 * WEB-13b revision 2 (review 2 R3a/R3b; design assessment invariants 1–4): ONE anchor editing session owns its input, the save it is making
 * and that save's outcome, whichever panel shows it. The state transitions alone (no panel, no outbox): a save is settled exactly once, by
 * its own ticket, and only on a session that has not ended; success consumes only what was submitted.
 */
type Context = { renewed: number };

function deferred() {
  let resolve!: (value: string | null) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string | null>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function session() {
  const consumed: number[] = [];
  const editor = createAnchorEditor<Context>({
    draft: EMPTY_ANCHOR,
    names: {},
    context: { renewed: 0 },
    renew: (c) => ({ renewed: c.renewed + 1 }),
    onConsumed: () => consumed.push(editor.session),
  });
  const events: string[] = [];
  editor.subscribe((event) => events.push(event));
  return { editor, consumed, events };
}

describe("an anchor editing session (revision 2)", () => {
  test("session numbers are never reused, so two sessions never match", () => {
    const a = session().editor;
    const b = session().editor;
    expect(b.session).toBeGreaterThan(a.session);
  });

  test("done with nothing edited since: consumed once, the listener hears it and the session has ended", async () => {
    const { editor, consumed, events } = session();
    const save = deferred();
    expect(editor.submit(() => save.promise)).toBe(true);
    expect(editor.state().busy).toBe(true);
    save.resolve(null);
    await flush();
    expect(editor.ended()).toBe(true);
    expect(consumed).toEqual([editor.session]);
    expect(events.at(-1)).toBe("consumed");
  });

  test("done with newer input: kept, renewed once, the note says so, and the next save sees the renewed context", async () => {
    const { editor, consumed } = session();
    const save = deferred();
    editor.submit(() => save.promise);
    editor.edit({ days: "-3" });
    save.resolve(null);
    await flush();
    expect(editor.ended()).toBe(false);
    expect(consumed).toEqual([]);
    expect(editor.state()).toMatchObject({
      busy: false,
      note: ANCHOR_SAVED_NEWER,
      revision: 1,
    });
    expect(editor.state().draft.days).toBe("-3");
    const seen: Context[] = [];
    editor.submit(async (context) => {
      seen.push(context);
      return null;
    });
    await flush();
    expect(seen).toEqual([{ renewed: 1 }]);
  });

  test("refused: nothing is consumed or renewed, the refusal's words stay with the input", async () => {
    const { editor, consumed } = session();
    editor.edit({ days: "-5" });
    const save = deferred();
    editor.submit(() => save.promise);
    save.resolve("Not saved: storage");
    await flush();
    expect(editor.ended()).toBe(false);
    expect(consumed).toEqual([]);
    expect(editor.state()).toMatchObject({
      busy: false,
      note: "Not saved: storage",
    });
    expect(editor.state().draft.days).toBe("-5");
    expect(editor.context()).toEqual({ renewed: 0 });
  });

  test("a refusal that renews: nothing is consumed, the words stay with the input, and the next save sees the context it gave", async () => {
    const { editor, consumed } = session();
    editor.edit({ days: "-5" });
    editor.submit(async () => ({
      refused: "The task changed",
      context: { renewed: 7 },
    }));
    await flush();
    expect(editor.ended()).toBe(false);
    expect(consumed).toEqual([]);
    expect(editor.state()).toMatchObject({
      busy: false,
      note: "The task changed",
      revision: 1,
    });
    const seen: Context[] = [];
    editor.submit(async (context) => {
      seen.push(context);
      return null;
    });
    await flush();
    expect(seen).toEqual([{ renewed: 7 }]);
  });

  test("a save that throws only clears the busy mark (nothing consumed, the input stays)", async () => {
    const { editor } = session();
    editor.edit({ days: "-2" });
    const save = deferred();
    editor.submit(() => save.promise);
    save.reject(new Error("lost"));
    await flush();
    expect(editor.ended()).toBe(false);
    expect(editor.state()).toMatchObject({ busy: false, revision: 1 });
  });

  test("at most one save at a time: a second submission while one is unsettled is refused and never run", async () => {
    const { editor } = session();
    const save = deferred();
    let runs = 0;
    expect(
      editor.submit(() => {
        runs += 1;
        return save.promise;
      }),
    ).toBe(true);
    expect(
      editor.submit(() => {
        runs += 1;
        return Promise.resolve(null);
      }),
    ).toBe(false);
    expect(runs).toBe(1);
    save.resolve("refused");
    await flush();
    expect(
      editor.submit(() => {
        runs += 1;
        return Promise.resolve(null);
      }),
    ).toBe(true);
    expect(runs).toBe(2);
  });

  test("an ended session's late completion changes nothing (a cancelled panel's save), success or refusal", async () => {
    for (const answer of [null, "refused"] as const) {
      const { editor, consumed, events } = session();
      editor.edit({ days: "-2" });
      const save = deferred();
      editor.submit(() => save.promise);
      editor.end();
      const before = editor.state();
      save.resolve(answer);
      await flush();
      expect(consumed).toEqual([]);
      expect(events.filter((e) => e === "consumed")).toEqual([]);
      expect(editor.state()).toBe(before);
      expect(editor.submit(() => Promise.resolve(null))).toBe(false);
      editor.edit({ days: "-9" });
      expect(editor.state()).toBe(before);
    }
  });

  test("retained by the sync control until shown again; an ended session cannot be retained", () => {
    const { editor } = session();
    editor.retain();
    expect(editor.retained()).toBe(true);
    editor.resume();
    expect(editor.retained()).toBe(false);
    editor.end();
    editor.retain();
    expect(editor.retained()).toBe(false);
  });
});
