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
  EDITOR_FIELD_UNREAD,
  EDITOR_PERSON_UNREAD,
  FIELD_NOT_ON_DEVICE,
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
 * Review 9, finding 2 (`people-detail-read-failure-as-empty`, incomplete fix in the editor): the field editor's reads are the person's,
 * the field's and this device's whole chain of unsent changes. A read that FAILED is said (with "Try again", which makes NEW watches for
 * every read of the editor: a live query ends at its first error), never taken as "nothing there"; a field that is not there is said
 * only once one composed read of the cache and the unsent changes agrees; the person's absence is the detail's (it withdraws the editor,
 * PPL-5). The input kept for the editor stays kept through all of it. Every case has its healthy control. Fixture evidence (jsdom, the
 * people world's controlled read faults). Review 9's design assessment, DA9-04 to DA9-09.
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
const Q = "57575757-5757-4575-8575-575757575757";
const F = "66666666-6666-4666-8666-666666666666";
const G = "88888888-8888-4888-8888-888888888888";
const MERGED = "data.readMerged";
const OUTSTANDING = "data.readOutstandingCreates";

function world() {
  const w = peopleWorld();
  w.setCache([
    person({ id: P, label: "Ada" }),
    person({ id: Q, label: "Bo" }),
    fieldRow({
      id: F,
      parent_id: P,
      label: "Note",
      value: { kind: "text", text: "Saved value" },
    }),
    fieldRow({
      id: G,
      parent_id: Q,
      label: "Bo's secret label",
      value: { kind: "text", text: "Bo's secret value" },
    }),
  ]);
  w.env.setDefaults(record());
  return w;
}

/** The dialog named `name`, once shown (its absence is an assertion failure, never a query error). */
async function dialogNamed(name: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen.queryByRole("dialog", { name });
    expect(found, `the dialog ${String(name)} is shown`).not.toBeNull();
    return found as HTMLElement;
  });
}
const dialogs = () => screen.queryAllByRole("dialog");
/** The editor's Value input (its absence is an assertion failure). */
function value(d: HTMLElement): HTMLElement {
  const box = within(d).queryByRole("textbox", { name: "Value" });
  expect(box, "the editor's Value input is shown").not.toBeNull();
  return box as HTMLElement;
}
const stateOf = (d: HTMLElement) =>
  d.querySelector("[data-people-state]")?.getAttribute("data-people-state") ??
  null;
const detailShown = (personId = P) =>
  waitFor(() =>
    expect(
      document.querySelector(`[data-person-detail="${personId}"]`),
    ).not.toBeNull(),
  );
/** A fault on the editor's read of `id` only, counting its visits (the selected fault is positively reached). */
function faultOn(w: PeopleWorld, id: string) {
  const visits = { count: 0 };
  w.failRead(MERGED, (input) => {
    if (input.id !== id) return false;
    visits.count += 1;
    return true;
  });
  return visits;
}
const watchesOf = (w: PeopleWorld, plan: string, id?: string) =>
  w.watches.filter(
    (entry) =>
      entry.plan === plan && (id === undefined || entry.input.id === id),
  ).length;
const closed = () => waitFor(() => expect(dialogs()).toHaveLength(0));

/** The editor shows the state `state` (and nothing editable). */
async function showing(state: string, name = "Edit field") {
  const d = await dialogNamed(name);
  await waitFor(() => expect(stateOf(d)).toBe(state));
  expect(within(d).queryByRole("textbox")).toBeNull();
  return d;
}

describe("DA9-04: a failed read of the edited field (or its person) is said, never an absent field", () => {
  test("control: healthy reads open Edit Note", async () => {
    const w = world();
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialogNamed("Edit Note");
    expect(value(d)).toHaveValue("Saved value");
  });

  test("the field's read fails on the first open: the editor says so, with Try again; the detail and its row stay", async () => {
    const w = world();
    const visits = faultOn(w, F);
    await w.mount(`/people/${P}/fields/${F}`);
    await detailShown();
    await waitFor(() =>
      expect(document.querySelector(`[data-field-row="${F}"]`)).not.toBeNull(),
    );
    const d = await showing("editor-read-failed");
    expect(
      visits.count,
      "the selected watch reached the fault",
    ).toBeGreaterThan(0);
    expect(within(d).queryByText(EDITOR_FIELD_UNREAD)).not.toBeNull();
    expect(within(d).getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(within(d).queryByText("Saved value")).toBeNull();
    expect(w.built).toHaveLength(0);
  });

  test("the field's read fails DURING an edit: the input is kept; repaired, Try again shows it again, nothing saved", async () => {
    const w = world();
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialogNamed("Edit Note");
    fireEvent.change(value(d), { target: { value: "Typed before the fault" } });
    faultOn(w, F);
    const failed = await showing("editor-read-failed");
    w.restoreReads();
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    const again = await dialogNamed("Edit Note");
    await waitFor(() =>
      expect(value(again)).toHaveValue("Typed before the fault"),
    );
    expect(w.built).toHaveLength(0);
  });

  test("the field's read fails during an edit, Cancel: that session ends (reopened on the saved value)", async () => {
    const w = world();
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialogNamed("Edit Note");
    fireEvent.change(value(d), { target: { value: "Discarded on purpose" } });
    faultOn(w, F);
    const failed = await showing("editor-read-failed");
    fireEvent.click(within(failed).getByRole("button", { name: "Cancel" }));
    await closed();
    w.restoreReads();
    cleanup();
    await w.mount(`/people/${P}/fields/${F}`);
    const again = await dialogNamed("Edit Note");
    expect(value(again)).toHaveValue("Saved value");
    expect(within(again).queryByText(RESTORED_DRAFT)).toBeNull();
  });

  test("the editor's read of the PERSON fails while the detail's read is healthy: said, and nothing of the field is shown", async () => {
    const w = world();
    const { router } = await w.mount(`/people/${P}`);
    await detailShown();
    // The detail's existing watches keep their answer; the editor's new read of the person fails (a fault on that read alone).
    w.freezeReads(MERGED);
    const visits = faultOn(w, P);
    await act(async () => {
      await router.navigate({
        to: "/people/$personId/fields/$fieldId",
        params: { personId: P, fieldId: F },
      });
    });
    const d = await showing("editor-read-failed");
    expect(visits.count).toBeGreaterThan(0);
    expect(within(d).queryByText(EDITOR_PERSON_UNREAD)).not.toBeNull();
    expect(within(d).queryByText("Saved value")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Edit field" })).toBe(d);
    expect(
      document.querySelector(`[data-person-detail="${P}"]`),
      "the healthy detail stays",
    ).not.toBeNull();
  });

  test("a field that is truly not here: said once the composed read agrees, with Cancel and no Try again", async () => {
    const w = world();
    const missing = "77777777-7777-4777-8777-777777777777";
    await w.mount(`/people/${P}/fields/${missing}`);
    const d = await showing("editor-not-on-device");
    expect(within(d).queryByText(FIELD_NOT_ON_DEVICE)).not.toBeNull();
    expect(within(d).queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await closed();
  });

  test("another person's field (wrong parent, PPL-5): not here, and nothing of it is named", async () => {
    const w = world();
    await w.mount(`/people/${P}/fields/${G}`);
    const d = await showing("editor-not-on-device");
    expect(document.body.textContent).not.toContain("Bo's secret");
    expect(within(d).queryByText(FIELD_NOT_ON_DEVICE)).not.toBeNull();
  });

  test("another person's field while the chain is unread (PPL-5): the title names nothing of it", async () => {
    const w = world();
    w.failRead(OUTSTANDING);
    await w.mount(`/people/${P}/fields/${G}`);
    await showing("editor-unread");
    expect(document.body.textContent).not.toContain("Bo's secret");
  });

  test("control: the person's own field while the chain is unread: the title names it", async () => {
    const w = world();
    w.failRead(OUTSTANDING);
    await w.mount(`/people/${P}/fields/${F}`);
    await showing("editor-unread", "Edit Note");
  });

  test("a person's id as the field (wrong kind): not here", async () => {
    const w = world();
    await w.mount(`/people/${P}/fields/${Q}`);
    await showing("editor-not-on-device");
  });

  test("the composed confirmation's read fails: said as a failed read, with Try again (never 'not here')", async () => {
    const w = world();
    const missing = "77777777-7777-4777-8777-777777777777";
    w.failRead("data.readInventory");
    await w.mount(`/people/${P}/fields/${missing}`);
    const d = await showing("editor-read-failed");
    expect(within(d).getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});

describe("DA9-05: Try again makes new watches for every failed read; nothing recovers without it", () => {
  test("repaired without any notification: the failed watch stays failed until Try again, which reads afresh (new watches)", async () => {
    const w = world();
    faultOn(w, F);
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await showing("editor-read-failed");
    w.restoreReads({ notify: false });
    // Control: an unrelated notification wakes the old watch, which stays failed (a live query ends at its first error).
    w.advanceRevision();
    await act(async () => undefined);
    expect(stateOf(screen.getByRole("dialog"))).toBe("editor-read-failed");
    const fieldWatches = watchesOf(w, MERGED, F);
    const chainWatches = watchesOf(w, OUTSTANDING);
    fireEvent.click(within(d).getByRole("button", { name: "Try again" }));
    const again = await dialogNamed("Edit Note");
    expect(value(again)).toHaveValue("Saved value");
    expect(watchesOf(w, MERGED, F)).toBeGreaterThan(fieldWatches);
    expect(watchesOf(w, OUTSTANDING)).toBeGreaterThan(chainWatches);
    expect(w.built).toHaveLength(0);
  });

  test("Try again while the read still fails: still said (and dismissible); repaired, Try again again: the editor", async () => {
    const w = world();
    faultOn(w, F);
    await w.mount(`/people/${P}/fields/${F}`);
    let d = await showing("editor-read-failed");
    const before = watchesOf(w, MERGED, F);
    fireEvent.click(within(d).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(watchesOf(w, MERGED, F)).toBeGreaterThan(before),
    );
    d = await showing("editor-read-failed");
    w.restoreReads({ notify: false });
    fireEvent.click(within(d).getByRole("button", { name: "Try again" }));
    expect(value(await dialogNamed("Edit Note"))).toHaveValue("Saved value");
  });

  test("the field AND the chain fail: one Try again reads both afresh", async () => {
    const w = world();
    faultOn(w, F);
    w.failRead(OUTSTANDING);
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await showing("editor-read-failed");
    w.restoreReads({ notify: false });
    const fieldWatches = watchesOf(w, MERGED, F);
    const chainWatches = watchesOf(w, OUTSTANDING);
    fireEvent.click(within(d).getByRole("button", { name: "Try again" }));
    expect(value(await dialogNamed("Edit Note"))).toHaveValue("Saved value");
    expect(watchesOf(w, MERGED, F)).toBeGreaterThan(fieldWatches);
    expect(watchesOf(w, OUTSTANDING)).toBeGreaterThan(chainWatches);
  });
});

describe("DA9-06: the person not shown: nothing of the field, the kept input neither shown nor lost", () => {
  test("the person isn't on this device: the detail says so, no editor, nothing of the field", async () => {
    const w = world();
    const R = "59595959-5959-4595-8595-595959595959";
    await w.mount(`/people/${R}/fields/${F}`);
    await waitFor(() =>
      expect(
        document.querySelector('[data-people-state="not-on-device"]'),
      ).not.toBeNull(),
    );
    expect(dialogs()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Saved value");
  });

  test("the person's read fails everywhere: the detail says so, no editor, nothing of the field", async () => {
    const w = world();
    faultOn(w, P);
    await w.mount(`/people/${P}/fields/${F}`);
    await waitFor(() =>
      expect(
        document.querySelector('[data-people-state="read-failed"]'),
      ).not.toBeNull(),
    );
    expect(dialogs()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Note");
  });

  test("the person goes during an edit, then comes back: withdrawn at once, then the same input (not discarded)", async () => {
    const w = world();
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialogNamed("Edit Note");
    fireEvent.change(value(d), { target: { value: "Kept while hidden" } });
    const rows = [
      person({ id: Q, label: "Bo" }),
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        value: { kind: "text", text: "Saved value" },
      }),
    ];
    w.setCache(rows);
    await waitFor(() => expect(dialogs()).toHaveLength(0));
    expect(document.body.textContent).not.toContain("Kept while hidden");
    w.setCache([person({ id: P, label: "Ada" }), ...rows]);
    const again = await dialogNamed("Edit Note");
    expect(value(again)).toHaveValue("Kept while hidden");
    expect(w.built).toHaveLength(0);
  });
});

describe("DA9-07: loading, later windows and the cap: never 'none', and a failure is not starved by a wait", () => {
  test("the chain still loading: nothing editable; answered: the editor", async () => {
    const w = world();
    w.holdReads(OUTSTANDING);
    await w.mount(`/people/${P}/fields/${F}`);
    await detailShown().catch(() => undefined);
    await waitFor(() => expect(w.gated.length).toBeGreaterThan(0));
    expect(screen.queryByRole("textbox", { name: "Value" })).toBeNull();
    w.releaseReads();
    expect(value(await dialogNamed("Edit Note"))).toHaveValue("Saved value");
  });

  test("the field's read fails while the chain still loads: the failure is said at once", async () => {
    const w = world();
    const { router } = await w.mount(`/people/${P}`);
    await detailShown();
    w.holdReads(OUTSTANDING);
    faultOn(w, F);
    await act(async () => {
      await router.navigate({
        to: "/people/$personId/fields/$fieldId",
        params: { personId: P, fieldId: F },
      });
    });
    await waitFor(() => expect(w.gated.length).toBeGreaterThan(0));
    await showing("editor-read-failed");
    w.releaseReads();
  });

  test("capped, Try again still capped: still says it is capped (truthful), nothing editable", async () => {
    const w = world();
    w.setDrafts(
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
      ) as DraftWithCommand[],
    );
    await w.mount(`/people/${P}/fields/${F}`);
    let d = await showing("editor-unread", "Edit Note");
    expect(within(d).queryByText(EDITOR_CHANGES_CAPPED)).not.toBeNull();
    const before = watchesOf(w, OUTSTANDING);
    fireEvent.click(within(d).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(watchesOf(w, OUTSTANDING)).toBeGreaterThan(before),
    );
    d = await showing("editor-unread", "Edit Note");
    expect(within(d).queryByText(EDITOR_CHANGES_CAPPED)).not.toBeNull();
  });

  test("a new field reads no target: a failing read of any field does not stop Add a field", async () => {
    const w = world();
    w.failRead(MERGED, (input) => input.id !== P);
    await w.mount(`/people/${P}/fields/new`);
    const d = await dialogNamed("Add a field");
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue("");
  });
});

/** Adds a field through the editor (Only you): it is queued, so the editor of it edits an unsent create (projected). */
async function queuedField(w: PeopleWorld) {
  await w.mount(`/people/${P}/fields/new`);
  const d = await dialogNamed("Add a field");
  fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
    target: { value: "Queued" },
  });
  fireEvent.change(value(d), { target: { value: "Queued value" } });
  fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
  fireEvent.click(within(d).getByRole("button", { name: "Save" }));
  await closed();
  const id = w.built[0]?.request.targets[0]?.resourceId;
  if (id === undefined) throw new Error("no create queued");
  cleanup();
  return id;
}

describe("DA9-08: one commit publishing the field, its reads delivered in either order", () => {
  for (const first of ["queue", "cache"] as const)
    test(`${first} delivered first: never 'not here', the input typed meanwhile is the same after`, async () => {
      const w = world();
      const id = await queuedField(w);
      await w.mount(`/people/${P}/fields/${id}`);
      const d = await dialogNamed("Edit Queued");
      fireEvent.change(value(d), {
        target: { value: "Typed over the create" },
      });
      const seen: Array<string | null> = [];
      const observer = new MutationObserver(() => {
        for (const node of document.querySelectorAll("[data-people-state]"))
          seen.push(node.getAttribute("data-people-state"));
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      // The cache's (or the queue's) existing watches have not delivered the commit yet.
      w.freezeReads(first === "queue" ? MERGED : OUTSTANDING);
      w.handOff(
        [
          fieldRow({
            id,
            parent_id: P,
            label: "Queued",
            value: { kind: "text", text: "Queued value" },
          }),
        ],
        [],
      );
      await act(async () => undefined);
      w.thawReads();
      const again = await dialogNamed("Edit Queued");
      await waitFor(() =>
        expect(value(again)).toHaveValue("Typed over the create"),
      );
      observer.disconnect();
      expect(seen).not.toContain("editor-not-on-device");
      expect(seen).not.toContain("editor-read-failed");
      expect(w.built).toHaveLength(1);
    });

  test("control: the create discarded (no publication): the field is said not to be here", async () => {
    const w = world();
    const id = await queuedField(w);
    await w.mount(`/people/${P}/fields/${id}`);
    await dialogNamed("Edit Queued");
    w.setDrafts([]);
    await showing("editor-not-on-device");
  });
});

/** Holds the outbox's `enqueue` until released. */
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

describe("DA9-09: a save held while the field's read fails", () => {
  async function savingThenFailed(w: PeopleWorld) {
    const g = holdEnqueue(w);
    const { router } = await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialogNamed("Edit Note");
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Note, renamed" },
    });
    const save = within(d).getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(g.state.entered).toBe(1));
    faultOn(w, F);
    const failed = await showing("editor-read-failed");
    return { g, failed, router };
  }

  test("not ended: the save is made once; its completion ends the session (reopened without its input)", async () => {
    const w = world();
    const { g } = await savingThenFailed(w);
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    w.restoreReads();
    cleanup();
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialogNamed(/Edit Note/);
    expect(within(d).queryByText(RESTORED_DRAFT)).toBeNull();
    expect(w.built).toHaveLength(1);
  });

  test("ended (Cancel) while saved, then a new session: the save is made once, the new session stays open and intact", async () => {
    const w = world();
    const { g, failed } = await savingThenFailed(w);
    fireEvent.click(within(failed).getByRole("button", { name: "Cancel" }));
    await closed();
    w.restoreReads();
    cleanup();
    await w.mount(`/people/${P}/fields/${F}`);
    const replacement = await dialogNamed(/Edit Note/);
    fireEvent.change(value(replacement), {
      target: { value: "Replacement input" },
    });
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: /Edit Note/ })).toBe(
      replacement,
    );
    expect(value(replacement)).toHaveValue("Replacement input");
  });

  test("another field shown meanwhile: the save's completion leaves it open and intact", async () => {
    const w = world();
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
    const { g, router } = await savingThenFailed(w);
    w.restoreReads();
    await act(async () => {
      await router.navigate({
        to: "/people/$personId/fields/$fieldId",
        params: { personId: P, fieldId: G },
      });
    });
    const other = await dialogNamed("Edit Other");
    fireEvent.change(value(other), { target: { value: "Other typed" } });
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Edit Other" })).toBe(other);
    expect(value(other)).toHaveValue("Other typed");
  });
});
