import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DraftWithCommand } from "../../../src/data";
import {
  EDITOR_CHANGES_CAPPED,
  EDITOR_CHANGES_UNREAD,
  REFUSED,
  RESTORED_DRAFT,
} from "../../../src/features/people/copy";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { record } from "../../support/people/records";
import {
  fieldRow,
  type PeopleWorld,
  peopleWorld,
  person,
} from "../../support/people/world";

/**
 * Review 8, finding 1 (`people-form-completion-lifetime`): the field editor's session is the person's to end even while this device's
 * unsent changes cannot be read whole (the editor shows "can't be edited yet" instead of its form). Cancel, Escape, the close icon and the
 * overlay end the session shown (the input kept for it is forgotten: reopening shows the saved value), exactly as the form's own do; Try
 * again and the in-dialog sync control keep it. A save that runs keeps its own claim and completion: ending the session never undoes it,
 * and its completion never closes or empties a later session. Each case has its control in the normal editor. Fixture evidence (jsdom).
 */
installMatchMedia({ width: 1440 });
beforeEach(() => {
  forgetAllPeopleMemory();
  forgetRefusedPolicies();
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const P = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const G = "88888888-8888-4888-8888-888888888888";
const OUTSTANDING = "data.readOutstandingCreates";

/** More unsent changes (of other people) than the editor reads: its chain is capped. */
const capping = (): DraftWithCommand[] =>
  Array.from({ length: 1001 }, (_, i) =>
    draftRow({
      local_id: `a${i + 1}`,
      created_seq: i + 1,
      command: {
        command: {
          kind: "archive",
          id: `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`,
          expected_version: 1,
          archived: true,
        },
      },
    }),
  );

function world() {
  const w = peopleWorld();
  w.setCache([
    person({ id: P, label: "Ada" }),
    fieldRow({
      id: F,
      parent_id: P,
      label: "Note",
      value: { kind: "text", text: "Saved value" },
    }),
    fieldRow({
      id: G,
      parent_id: P,
      label: "Other",
      value: { kind: "text", text: "Other saved" },
    }),
  ]);
  w.env.setDefaults(record());
  return w;
}

const editor = (name = "Edit Note") => screen.findByRole("dialog", { name });
const value = (d: HTMLElement) =>
  within(d).getByRole("textbox", { name: "Value" });
const unread = (d: HTMLElement) =>
  d.querySelector('[data-people-state="editor-unread"]');
const closed = () =>
  waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

type Reads = "failed" | "capped";
/** The chain made unreadable (or capped) for the next watches; `repair` makes it readable again. */
function spoil(w: PeopleWorld, reads: Reads) {
  if (reads === "failed") w.failRead(OUTSTANDING);
  else w.setDrafts(capping());
}
function repair(w: PeopleWorld, reads: Reads) {
  if (reads === "failed") w.restoreReads();
  else w.setDrafts([]);
}

/** Types into Note's editor, then remounts the tree (the same identity) onto an editor whose chain is `reads` (or readable: null). */
async function kept(w: PeopleWorld, text: string, reads: Reads | null) {
  await w.mount(`/people/${P}/fields/${F}`);
  const d = await editor();
  fireEvent.change(value(d), { target: { value: text } });
  cleanup();
  if (reads !== null) spoil(w, reads);
  await w.mount(`/people/${P}/fields/${F}`);
  const again = await editor();
  if (reads !== null)
    expect(unread(again), "the editor's chain is not readable").not.toBeNull();
  else expect(value(again)).toHaveValue(text);
  return again;
}

/**
 * The overlay is not driven here: jsdom does not dismiss the dialog on a synthetic pointerdown outside it (not even the normal editor's, a
 * harness limit of this world). It closes through the same Radix `onOpenChange(false)` → `discard` as Escape (`components/ui/dialog.tsx`).
 */
const ENDINGS = ["Cancel", "Close", "Escape"] as const;
type Ending = (typeof ENDINGS)[number];
async function dismiss(d: HTMLElement, ending: Ending) {
  if (ending === "Escape") fireEvent.keyDown(d, { key: "Escape" });
  else fireEvent.click(within(d).getByRole("button", { name: ending }));
  await closed();
}

async function reopened(w: PeopleWorld, name = "Edit Note") {
  cleanup();
  await w.mount(
    name === "Edit Note"
      ? `/people/${P}/fields/${F}`
      : `/people/${P}/fields/new`,
  );
  return editor(name);
}

describe("review 8, finding 1: the person ends the session while the editor cannot be read", () => {
  for (const reads of ["failed", "capped"] as const)
    for (const ending of ENDINGS)
      test(`${reads} chain, ${ending}: the kept input is forgotten (reopened on the saved value)`, async () => {
        const w = world();
        const d = await kept(w, "Intentionally discarded secret", reads);
        expect(
          within(d).queryByText(
            reads === "failed" ? EDITOR_CHANGES_UNREAD : EDITOR_CHANGES_CAPPED,
          ),
        ).not.toBeNull();
        await dismiss(d, ending);
        repair(w, reads);
        const again = await reopened(w);
        expect(
          value(again),
          "the ended session's input is not shown",
        ).toHaveValue("Saved value");
        expect(within(again).queryByText(RESTORED_DRAFT)).toBeNull();
        expect(w.built).toHaveLength(0);
      });

  for (const ending of ENDINGS)
    test(`control: the normal editor's ${ending} forgets it too`, async () => {
      const w = world();
      const d = await kept(w, "Intentionally discarded secret", null);
      await dismiss(d, ending);
      expect(value(await reopened(w))).toHaveValue("Saved value");
    });

  test("a new field's kept input, its chain unreadable, Cancel: reopening shows an empty new field", async () => {
    const w = world();
    await w.mount(`/people/${P}/fields/new`);
    let d = await editor("Add a field");
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Secret name" },
    });
    cleanup();
    w.failRead(OUTSTANDING);
    await w.mount(`/people/${P}/fields/new`);
    d = await editor("Add a field");
    expect(unread(d)).not.toBeNull();
    await dismiss(d, "Cancel");
    w.restoreReads();
    d = await reopened(w, "Add a field");
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue("");
  });

  test("nothing kept yet (the chain unreadable on the first open): Cancel closes and touches no other field's kept input", async () => {
    const w = world();
    await w.mount(`/people/${P}/fields/${G}`);
    const other = await editor("Edit Other");
    fireEvent.change(value(other), { target: { value: "Other kept" } });
    fireEvent.click(within(other).getByRole("button", { name: /sync/i }));
    await closed();
    cleanup();
    w.failRead(OUTSTANDING);
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await editor();
    expect(unread(d)).not.toBeNull();
    await dismiss(d, "Cancel");
    w.restoreReads();
    cleanup();
    await w.mount(`/people/${P}/fields/${G}`);
    expect(value(await editor("Edit Other"))).toHaveValue("Other kept");
  });
});

describe("review 8, finding 1: Try again and the sync control keep the session", () => {
  for (const reads of ["failed", "capped"] as const)
    test(`${reads} chain, repaired, Try again: the same input comes back, nothing is saved`, async () => {
      const w = world();
      const d = await kept(w, "Kept through Try again", reads);
      repair(w, reads);
      fireEvent.click(within(d).getByRole("button", { name: "Try again" }));
      await waitFor(() =>
        expect(value(screen.getByRole("dialog"))).toHaveValue(
          "Kept through Try again",
        ),
      );
      expect(w.built).toHaveLength(0);
    });

  test("failed chain, the sync control: the input is kept for the next open", async () => {
    const w = world();
    const d = await kept(w, "Kept by the sync control", "failed");
    fireEvent.click(within(d).getByRole("button", { name: /sync/i }));
    await closed();
    w.restoreReads();
    expect(value(await reopened(w))).toHaveValue("Kept by the sync control");
    expect(w.built).toHaveLength(0);
  });
});

/** Holds the outbox's `enqueue` until released (every call once released). */
function holdEnqueue(w: PeopleWorld) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state = { entered: 0 };
  const outbox = w.env.outbox();
  if (outbox === null) throw new Error("no outbox");
  const original = outbox.enqueue.bind(outbox);
  outbox.enqueue = async (...args: Parameters<typeof original>) => {
    state.entered += 1;
    await opened;
    return original(...args);
  };
  return {
    state,
    release: async () => {
      await act(async () => {
        open();
        await opened;
      });
    },
  };
}

/** Note's name edited and saved; the save is held after it started; the tree remounted onto an unreadable chain. */
async function savingThenUnread(w: PeopleWorld) {
  const g = holdEnqueue(w);
  await w.mount(`/people/${P}/fields/${F}`);
  const d = await editor();
  fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
    target: { value: "Note, renamed" },
  });
  const save = within(d).getByRole("button", { name: "Save" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => expect(g.state.entered).toBe(1));
  cleanup();
  w.failRead(OUTSTANDING);
  await w.mount(`/people/${P}/fields/${F}`);
  const unreadable = await editor();
  expect(unread(unreadable)).not.toBeNull();
  return { g, unreadable };
}

describe("review 8, finding 1: a running save keeps its own claim and completion", () => {
  test("ended while its save runs, then a new session: the save is made once, and its completion neither closes nor empties the new session", async () => {
    const w = world();
    const { g, unreadable } = await savingThenUnread(w);
    await dismiss(unreadable, "Cancel");
    w.restoreReads();
    const replacement = await reopened(w);
    fireEvent.change(value(replacement), {
      target: { value: "Replacement input" },
    });
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(screen.getByRole("dialog", { name: /Edit Note/ })).toBe(replacement);
    expect(value(replacement)).toHaveValue("Replacement input");
  });

  test("not ended: saved while the editor could not be read, its input is consumed once (reopened without it)", async () => {
    const w = world();
    const { g } = await savingThenUnread(w);
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    w.restoreReads();
    cleanup();
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await screen.findByRole("dialog");
    expect(within(d).queryByText(RESTORED_DRAFT)).toBeNull();
  });

  test("not ended: refused while the editor could not be read, the refusal and the input wait for Try again", async () => {
    const w = world();
    w.outcomes.push({ kind: "refused", reason: "quota" });
    const { g, unreadable } = await savingThenUnread(w);
    await g.release();
    w.restoreReads();
    fireEvent.click(
      within(unreadable).getByRole("button", { name: "Try again" }),
    );
    const d = await waitFor(() => {
      const shown = screen.getByRole("dialog");
      expect(within(shown).queryByText(REFUSED.quota)).not.toBeNull();
      return shown;
    });
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Note, renamed",
    );
    expect(w.built).toHaveLength(0);
  });
});
