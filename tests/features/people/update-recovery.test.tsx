import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import {
  type FieldInput,
  fieldCodec,
  personCodec,
  renameCodec,
} from "../../../src/features/people/model/recovery";
import { handoffHandles } from "../../../src/lib/form-recovery/handoff";
import type { MemoryRecoveryAdapter } from "../../../src/lib/form-recovery/memory-adapter";
import {
  RESTORED_TEXT,
  UNAVAILABLE_WHILE_RELOADING,
} from "../../../src/lib/form-recovery/RecoveryBanner";
import {
  flushDirty,
  pageFormRegistry,
} from "../../../src/lib/form-recovery/registry";
import { FLUSH_START_GRACE_MS } from "../../../src/lib/pwa/coordinator";
import { installMatchMedia } from "../../helpers/match-media";
import { FakeForm, FakeOrigin } from "../../pwa/coordinator-world";
import { draftRow } from "../../support/data/rows";
import { HOME, record } from "../../support/people/records";
import { fieldRow, peopleWorld, person } from "../../support/people/world";
import { Locks } from "../../support/recovery-pages";
import { ok } from "../../support/sharing/fake-api";

/**
 * WEB-14a integration revision (review of 2 November 2026, F-INT-PEOPLE-Q4; family `people-update-recovery-participant`). The People
 * forms (new person `people-new:dialog`, rename `people-rename:<person>`, the field editor `people-field:<person>:<field>` and
 * `people-field:<person>:new:dialog`) through the maintained People world, the production page form registry (`pageFormRegistry`), the
 * page's real recovery identity (over a Web Locks double) and the production app-update coordinator; only the worker, clock, reload and
 * recovery store (`MemoryRecoveryAdapter`) are doubles. COMPONENT/COMPOSITION evidence, not a native browser or released-backend result:
 * the actual reload/restore of New person, Rename and the field editor on a typed field in the three engines is
 * `tests/e2e/fixture.pwa-people.spec.ts` (revision 50: on a seeded person, see its header).
 *
 * The first describe keeps the reviewer's exact witness and its two controls (`.agtx/evidence/integration-independent-review/probe.test.tsx`
 * of the integration worktree), unchanged except for imports, clean-up, formatting and `[0]!` read through `first` (lint), with added
 * assertions after the original one: with no recovery store open the unfinished input cannot be saved, so the update must not reload.
 */
installMatchMedia({ width: 1440 });
const locks = new Locks();
beforeAll(() => {
  // The page's recovery identity is made at its first use from `navigator.locks` (jsdom has none).
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks.forPage("this-page"),
  });
});
/** Every coordinator a test started, disposed after it whatever happened (a frozen registry must never leak into the next test). */
const started: { dispose(): void }[] = [];
afterEach(async () => {
  for (const coordinator of started.splice(0)) coordinator.dispose();
  cleanup();
  for (const handle of handoffHandles(pageFormRegistry))
    void handle.discard?.();
  forgetAllPeopleMemory();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const P = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const WITNESS = "unsaved integration witness";

/** The world's recovery store, opened (the account's database is open: `useFormRecoveryPort` gives the port). */
function openStore(w: ReturnType<typeof peopleWorld>): MemoryRecoveryAdapter {
  const env = w.env as unknown as {
    formRecovery: MemoryRecoveryAdapter;
    formRecoveryOpen: { set(open: boolean): void };
  };
  act(() => env.formRecoveryOpen.set(true));
  return env.formRecovery;
}

/** A copy another tab left (its tab has gone: no lock holds its id), as the store keeps it. */
async function left(
  store: MemoryRecoveryAdapter,
  formContext: string,
  text: string,
): Promise<void> {
  expect(
    await store.save({
      formContext,
      tabInstanceId: "gone-tab",
      values: { model: text },
      savedAt: new Date().toISOString(),
      capture: "gone-capture",
    }),
  ).toBe("saved");
}

/** The live copies of `formContext` this page or another left, decoded by `decode`. */
async function copiesOf<T>(
  store: MemoryRecoveryAdapter,
  formContext: string,
  decode: (text: string) => T | null,
): Promise<(T | null)[]> {
  const copies = await store.list(formContext);
  return copies.map((copy) => decode(copy.values.model ?? ""));
}

/** The first element (a lint-clean `[0]!`: the witness's only change besides imports and clean-up). */
function first(elements: HTMLElement[]): HTMLElement {
  const [element] = elements;
  if (element === undefined) throw new Error("setup: no such element");
  return element;
}

const contexts = (handles: readonly { formContext: string }[]) =>
  handles.map((handle) => handle.formContext).sort();

/** A tab of the production coordinator over the production page registry (worker, clock and reload are doubles). */
async function updatingTab() {
  const origin = new FakeOrigin();
  const tab = origin.tab();
  Object.defineProperty(tab, "forms", { value: pageFormRegistry });
  await tab.start();
  if (tab.coordinator) started.push(tab.coordinator);
  return { origin, tab };
}

async function acceptUpdate(
  origin: FakeOrigin,
  tab: Awaited<ReturnType<typeof updatingTab>>["tab"],
) {
  const waiting = await origin.installNew(2);
  await act(async () => {
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
  });
}

async function openNewPerson() {
  fireEvent.click(
    first(await screen.findAllByRole("button", { name: "New person" })),
  );
  return screen.findByRole("dialog", { name: "New person" });
}
const nameOf = (scope: HTMLElement) =>
  within(scope).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
/**
 * WEB-14a revision 51 (F-R51-1, family `restored-form-focus-exposure-order`): "Discard instead" used from the keyboard in `scope` (the
 * button has focus when pressed; jsdom does not focus on click, so the control focuses it first). The restored banner goes with the copy.
 */
async function keyboardDiscard(scope: HTMLElement): Promise<void> {
  const button = within(scope).getByRole("button", { name: "Discard instead" });
  button.focus();
  expect(button, "the control: Discard instead has focus").toHaveFocus();
  fireEvent.click(button);
  await waitFor(() => expect(scope).not.toHaveTextContent(RESTORED_TEXT));
}
const header = () =>
  document.querySelector("[data-identity-header]") as HTMLElement;

describe("the reviewer's witness and controls (F-INT-PEOPLE-Q4, preserved)", () => {
  test("registered dirty control is visible to the production page registry", () => {
    const f = new FakeForm("control");
    f.dirty = true;
    const off = pageFormRegistry.register(f);
    try {
      expect(pageFormRegistry.dirty()).toContain(f);
    } finally {
      off();
    }
  });

  test("People unfinished new-person input must stop or survive update reload", async () => {
    forgetAllPeopleMemory();
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    await w.mount("/people");
    fireEvent.click(
      first(await screen.findAllByRole("button", { name: "New person" })),
    );
    const d = await screen.findByRole("dialog", { name: "New person" });
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: WITNESS },
    });
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
      WITNESS,
    );
    expect(w.people.memory.drafts.size).toBeGreaterThan(0);
    const { origin, tab } = await updatingTab();
    await acceptUpdate(origin, tab);
    const observed = {
      registry: contexts(pageFormRegistry.all()),
      dirty: contexts(pageFormRegistry.dirty()),
      reloads: tab.reloads,
      state: tab.state.kind,
    };
    tab.coordinator?.dispose();
    expect(
      tab.reloads,
      "unfinished People input has no durable recovery participant",
    ).toBe(0);
    // Added (the fix's own account of the witness): the form is a dirty participant, and its save failed honestly (no store open).
    expect(observed.registry).toContain("people-new:dialog");
    expect(observed.dirty).toContain("people-new:dialog");
    expect(observed.state).toBe("save_failed");
    expect(nameOf(d)).toHaveValue(WITNESS);
    expect(w.built).toHaveLength(0);
  });

  test("registered dirty control whose save fails blocks the same coordinator", async () => {
    const { origin, tab } = await updatingTab();
    const f = new FakeForm("control-failed-save");
    f.dirty = true;
    f.result = "failed";
    const off = pageFormRegistry.register(f);
    try {
      await origin.installNew(2);
      tab.actions?.accept();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      expect(f.saves).toBeGreaterThan(0);
      expect(tab.reloads).toBe(0);
      expect(tab.state.kind).toBe("save_failed");
    } finally {
      tab.coordinator?.dispose();
      off();
    }
  });
});

describe("New person (people-new:dialog)", () => {
  test("typed input is a dirty participant; the update saves it, then reloads once; nothing is sent", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const store = openStore(w);
    await w.mount("/people");
    const d = await openNewPerson();
    // Shown, untouched: a registered participant (the update freezes it), not dirty.
    expect(contexts(pageFormRegistry.all())).toEqual(["people-new:dialog"]);
    expect(contexts(pageFormRegistry.dirty())).toEqual([]);
    fireEvent.change(nameOf(d), { target: { value: WITNESS } });
    expect(contexts(pageFormRegistry.dirty())).toEqual(["people-new:dialog"]);
    // The update's own save (the coordinator's "Save and reload").
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    expect(
      (await copiesOf(store, "people-new:dialog", personCodec.decode)).map(
        (copy) => copy?.name,
      ),
    ).toEqual([WITNESS]);
    const { origin, tab } = await updatingTab();
    await acceptUpdate(origin, tab);
    expect(tab.reloads).toBe(1);
    tab.coordinator?.dispose();
    expect(w.built).toHaveLength(0);
  });

  test("a copy left before the reload opens the form on it, raw, restored, never saved until Save", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const store = openStore(w);
    await left(
      store,
      "people-new:dialog",
      personCodec.encode({
        name: WITNESS,
        sharing: "only_you",
        noteOpen: false,
        note: "a hidden first note",
        revision: 0,
      }),
    );
    await w.mount("/people");
    const d = await screen.findByRole("dialog", { name: "New person" });
    await waitFor(() => expect(nameOf(d)).toHaveValue(WITNESS));
    // Q4 state 3 (revision 51, F-R51-1): focus is in the restored form, on its first field.
    await waitFor(() => expect(nameOf(d)).toHaveFocus());
    expect(within(d).getByRole("radio", { name: "Only you" })).toBeChecked();
    expect(d).toHaveTextContent(RESTORED_TEXT);
    expect(w.built).toHaveLength(0);
    // The hidden note comes back with it and is still not sent (PRODUCT-DECISIONS item 2).
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(JSON.stringify(w.built[0]?.command)).not.toContain(
      "a hidden first note",
    );
    // A durable success covers what it sent: the copy it was restored from is gone.
    await waitFor(async () =>
      expect(await store.list("people-new:dialog")).toEqual([]),
    );
  });

  test("revision 51 (F-R51-1): Discard instead from the keyboard clears the restored copy, keeps the form open and leaves focus on Name; nothing is sent", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const store = openStore(w);
    await left(
      store,
      "people-new:dialog",
      personCodec.encode({
        name: WITNESS,
        sharing: "only_you",
        noteOpen: false,
        note: "",
        revision: 0,
      }),
    );
    await w.mount("/people");
    const d = await screen.findByRole("dialog", { name: "New person" });
    await waitFor(() => expect(nameOf(d)).toHaveValue(WITNESS));
    await waitFor(() => expect(nameOf(d)).toHaveFocus());
    await keyboardDiscard(d);
    expect(screen.getByRole("dialog", { name: "New person" })).toBe(d);
    expect(nameOf(d)).toHaveValue("");
    expect(nameOf(d), "focus stays in the form, on Name").toHaveFocus();
    await waitFor(async () =>
      expect(await store.list("people-new:dialog")).toEqual([]),
    );
    expect(nameOf(d)).toHaveFocus();
    expect(w.built).toHaveLength(0);
  });

  test("a failed save keeps the form and refuses the reload", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const store = openStore(w);
    await w.mount("/people");
    const d = await openNewPerson();
    fireEvent.change(nameOf(d), { target: { value: WITNESS } });
    store.failSaves = true;
    const { origin, tab } = await updatingTab();
    await acceptUpdate(origin, tab);
    expect(tab.reloads).toBe(0);
    expect(tab.state.kind).toBe("save_failed");
    tab.coordinator?.dispose();
    expect(nameOf(d)).toHaveValue(WITNESS);
    expect(contexts(pageFormRegistry.dirty())).toEqual(["people-new:dialog"]);
  });

  test("a pending save is waited for: the reload follows its durable success, and nothing is sent twice", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const store = openStore(w);
    await w.mount("/people");
    const d = await openNewPerson();
    fireEvent.change(nameOf(d), { target: { value: WITNESS } });
    // The outbox write is held until released.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = w.env as unknown as { outbox: () => unknown };
    const real = env.outbox;
    env.outbox = () => {
      const outbox = real() as { enqueue: (...args: unknown[]) => unknown };
      return {
        ...outbox,
        enqueue: async (...args: unknown[]) => {
          await gate;
          return outbox.enqueue(...args);
        },
      };
    };
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(pageFormRegistry.pending()).toBe(1);
    const { origin, tab } = await updatingTab();
    const waiting = await origin.installNew(2);
    await act(async () => {
      tab.actions?.accept();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    // The update waits for the save admitted before it: no reload, and nothing more is sent.
    expect(tab.reloads).toBe(0);
    expect(w.built).toHaveLength(0);
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(w.built).toHaveLength(1));
    await waitFor(() => expect(tab.state.kind).toBe("reloading"));
    // The update's own flush follows the settled save on the production schedule (its grace, on the manual clock), then the activation.
    await act(async () => {
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    expect(tab.reloads).toBe(0);
    await act(async () => {
      await origin.activate(waiting);
    });
    expect(tab.reloads).toBe(1);
    expect(w.built).toHaveLength(1);
    expect(await store.list("people-new:dialog")).toEqual([]);
  });

  test("Cancel ends the session (its copy is discarded); the next New person is a new, untouched session", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const store = openStore(w);
    await w.mount("/people");
    let d = await openNewPerson();
    fireEvent.change(nameOf(d), { target: { value: WITNESS } });
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    expect(await store.list("people-new:dialog")).toHaveLength(1);
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(async () =>
      expect(await store.list("people-new:dialog")).toEqual([]),
    );
    expect(contexts(pageFormRegistry.dirty())).toEqual([]);
    // Closed and clean: no longer listed.
    expect(contexts(pageFormRegistry.all())).toEqual([]);
    d = await openNewPerson();
    expect(nameOf(d)).toHaveValue("");
    expect(contexts(pageFormRegistry.dirty())).toEqual([]);
    // A later edit of the new session is its own (dirty again), never the ended one's.
    fireEvent.change(nameOf(d), { target: { value: "Someone else" } });
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    expect(
      (await copiesOf(store, "people-new:dialog", personCodec.decode)).map(
        (copy) => copy?.name,
      ),
    ).toEqual(["Someone else"]);
  });

  test("a session kept by a remount (the dialog unmounted, page memory keeps it) is still saved by an update", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const store = openStore(w);
    const { router } = await w.mount("/people");
    const d = await openNewPerson();
    fireEvent.change(nameOf(d), { target: { value: WITNESS } });
    // Leaving the list unmounts the dialog without a dismissal: page memory keeps the session.
    await act(async () => {
      await router.navigate({ to: "/settings" });
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New person" })).toBeNull(),
    );
    expect(w.people.memory.drafts.has("new-person")).toBe(true);
    expect(contexts(pageFormRegistry.dirty())).toEqual(["people-new:dialog"]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    expect(
      (await copiesOf(store, "people-new:dialog", personCodec.decode)).map(
        (copy) => copy?.name,
      ),
    ).toEqual([WITNESS]);
  });

  test("while an update reload is being prepared nothing is typed or saved", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    openStore(w);
    await w.mount("/people");
    const d = await openNewPerson();
    fireEvent.change(nameOf(d), { target: { value: WITNESS } });
    const thaw = pageFormRegistry.freeze();
    try {
      fireEvent.change(nameOf(d), { target: { value: `${WITNESS} later` } });
      expect(nameOf(d)).toHaveValue(WITNESS);
      expect(within(d).getByRole("button", { name: "Save" })).toBeDisabled();
      expect(d).toHaveTextContent(UNAVAILABLE_WHILE_RELOADING);
      fireEvent.click(within(d).getByRole("button", { name: "Save" }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(w.built).toHaveLength(0);
    } finally {
      act(() => thaw());
    }
  });

  test("a Save pressed in the turn the freeze began (before the form shows it) sends nothing: the model's ticket refuses it", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    openStore(w);
    await w.mount("/people");
    const d = await openNewPerson();
    fireEvent.change(nameOf(d), { target: { value: WITNESS } });
    const save = within(d).getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    let thaw: () => void = () => undefined;
    // One synchronous step: the freeze, then the press on the button as last rendered (React renders the freeze after it).
    act(() => {
      thaw = pageFormRegistry.freeze();
      save.click();
    });
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(w.built).toHaveLength(0);
      expect(pageFormRegistry.pending()).toBe(0);
      // Nothing was admitted either: the session is free for a Save after the freeze.
      expect(w.people.memory.pending.size).toBe(0);
    } finally {
      act(() => thaw());
    }
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
  });
});

describe("Rename (people-rename:<person>)", () => {
  test("a typed name is saved with the binding it was typed against, and restored after the reload into the reopened form", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada", version: 5, policy_version: 3 }),
    ]);
    const store = openStore(w);
    await w.mount(`/people/${P}`);
    await within(header()).findByText("Not linked to an account");
    fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(header()).getByRole("textbox", { name: "Name" }), {
      target: { value: "Ada L." },
    });
    expect(contexts(pageFormRegistry.dirty())).toEqual([`people-rename:${P}`]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    const [saved] = await copiesOf(
      store,
      `people-rename:${P}`,
      renameCodec(P).decode,
    );
    expect(saved?.name).toBe("Ada L.");
    expect(saved?.snapshot.version).toBe(5);
    expect(saved?.snapshot.policyVersion).toBe(3);
    expect(w.built).toHaveLength(0);
  });

  test("a copy left before the reload reopens the rename form on it; nothing is sent until Save", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada", version: 5, policy_version: 3 }),
    ]);
    const store = openStore(w);
    await left(
      store,
      `people-rename:${P}`,
      renameCodec(P).encode({
        name: "Ada Lovelace",
        snapshot: {
          version: 5,
          policyVersion: 3,
          expectedBase: 5,
          latestLocalId: null,
          latestDigest: null,
        },
      }),
    );
    await w.mount(`/people/${P}`);
    const box = await within(header()).findByRole("textbox", { name: "Name" });
    await waitFor(() => expect(box).toHaveValue("Ada Lovelace"));
    // Q4 state 3 (revision 51, F-R51-1): the host opened the rename on the copy; focus is on its Name, not the page's heading.
    await waitFor(() => expect(box).toHaveFocus());
    expect(w.built).toHaveLength(0);
    expect(w.api.calls.map((call) => call.op)).not.toContain("peopleCommand");
    // "Discard instead" from the keyboard: the rename shows the person's name again and focus stays on Name.
    const form = header().querySelector("[data-rename-form]") as HTMLElement;
    await keyboardDiscard(form);
    expect(box).toHaveValue("Ada");
    expect(box, "focus stays in the form, on Name").toHaveFocus();
    expect(w.built).toHaveLength(0);
    expect(w.api.calls.map((call) => call.op)).not.toContain("peopleCommand");
  });

  test("a stale binding: the restored name is not saved over the person's later version; it is re-bound for a deliberate save", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada (changed elsewhere)", version: 7 }),
    ]);
    const store = openStore(w);
    await left(
      store,
      `people-rename:${P}`,
      renameCodec(P).encode({
        name: "Ada Lovelace",
        snapshot: {
          version: 5,
          policyVersion: 3,
          expectedBase: 5,
          latestLocalId: null,
          latestDigest: null,
        },
      }),
    );
    await w.mount(`/people/${P}`);
    const box = await within(header()).findByRole("textbox", { name: "Name" });
    await waitFor(() => expect(box).toHaveValue("Ada Lovelace"));
    await within(header()).findByText("Not linked to an account");
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(header().querySelector("[data-rename-form]")).toHaveTextContent(
        /changed/i,
      ),
    );
    expect(w.built).toHaveLength(0);
    // The input stays the person's, unsaved: an update still saves it.
    expect(contexts(pageFormRegistry.dirty())).toEqual([`people-rename:${P}`]);
  });
});

describe("The field editor (people-field:<person>:<field> and :new:dialog)", () => {
  test("a new field's hidden typed slot is captured with the shown one, and an update saves it; nothing is sent", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(record());
    const store = openStore(w);
    await w.mount(`/people/${P}/fields/new`);
    const d = await screen.findByRole("dialog");
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Weight" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "about 70" },
    });
    fireEvent.change(within(d).getByRole("combobox", { name: "Type" }), {
      target: { value: "quantity" },
    });
    const context = `people-field:${P}:new:dialog`;
    expect(contexts(pageFormRegistry.dirty())).toEqual([context]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    const [saved] = await copiesOf(store, context, fieldCodec(P, null).decode);
    expect(saved?.form.name).toBe("Weight");
    expect(saved?.form.kind).toBe("quantity");
    expect(saved?.form.slots.text).toEqual({ text: "about 70" });
    expect(saved?.newFieldId).toMatch(/.+/);
    expect(w.built).toHaveLength(0);
  });

  test("an existing field's editor restores a copy left before the reload (its binding and hidden slots), never saving it", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F, parent_id: P, label: "Phone", version: 2 }),
    ]);
    const store = openStore(w);
    const codec = fieldCodec(P, F);
    const base: FieldInput = {
      form: {
        name: "Mobile",
        kind: "text",
        slots: {
          text: { text: "07700 900999" },
          quantity: { amount: "3", unit: "kg" },
          date: { day: "", month: "", year: "" },
          url: { url: "" },
          boolean: { value: null },
          choices: { options: [] },
          checklist: { items: [] },
        },
        audience: "only_you",
        revision: 0,
      },
      touched: false,
      snapshot: {
        version: 2,
        policyVersion: 1,
        expectedBase: 2,
        latestLocalId: null,
        latestDigest: null,
      },
      origin: { kind: "field" },
      newFieldId: "77777777-7777-4777-8777-777777777777",
    };
    await left(store, codec.context, codec.encode(base));
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
        "Mobile",
      ),
    );
    expect(within(d).getByRole("textbox", { name: "Value" })).toHaveValue(
      "07700 900999",
    );
    // Q4 state 3 (revision 51, F-R51-1): focus is in the restored editor, on its Name.
    await waitFor(() =>
      expect(within(d).getByRole("textbox", { name: "Name" })).toHaveFocus(),
    );
    expect(d).toHaveTextContent(RESTORED_TEXT);
    expect(w.built).toHaveLength(0);
    // The hidden quantity slot came back too.
    fireEvent.change(within(d).getByRole("combobox", { name: "Type" }), {
      target: { value: "quantity" },
    });
    expect(within(d).getByRole("textbox", { name: "Amount" })).toHaveValue("3");
    expect(w.built).toHaveLength(0);
    // "Discard instead" from the keyboard: the editor shows the field as read again, stays open, and focus is back on its Name.
    await keyboardDiscard(d);
    expect(screen.getByRole("dialog")).toBe(d);
    expect(within(d).getByRole("textbox", { name: "Name" })).not.toHaveValue(
      "Mobile",
    );
    expect(
      within(d).getByRole("textbox", { name: "Name" }),
      "focus stays in the editor, on Name",
    ).toHaveFocus();
    expect(w.built).toHaveLength(0);
  });

  test("a failed save keeps the editor's input dirty for an update (the outbox refused it)", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(record());
    openStore(w);
    await w.mount(`/people/${P}/fields/new`);
    const d = await screen.findByRole("dialog");
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Weight" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "70" },
    });
    w.outcomes.push({ kind: "refused", reason: "quota_exceeded" });
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(pageFormRegistry.pending()).toBe(0));
    expect(w.built).toHaveLength(0);
    expect(contexts(pageFormRegistry.dirty())).toEqual([
      `people-field:${P}:new:dialog`,
    ]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
  });

  test("a held audience change (people-held:) is never a form: not offered, restored, saved or discarded by the editor's recovery", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F, parent_id: P, label: "Phone", version: 2 }),
    ]);
    const store = openStore(w);
    // A held operation's row in the same store, under its own context (written by the conditional port in production).
    const held = `people-held:${P}:${F}`;
    expect(
      await store.save({
        formContext: held,
        tabInstanceId: "hold-1",
        values: { held: '{"v":1}' },
        savedAt: new Date().toISOString(),
        capture: "hold-capture",
      }),
    ).toBe("saved");
    const before = JSON.stringify(await store.list(held));
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await screen.findByRole("dialog");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(d.querySelector("[data-recovery-alternatives]")).toBeNull();
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Mobile" },
    });
    expect(contexts(pageFormRegistry.dirty())).toEqual([
      `people-field:${P}:${F}`,
    ]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(async () =>
      expect(await store.list(`people-field:${P}:${F}`)).toEqual([]),
    );
    expect(JSON.stringify(await store.list(held))).toBe(before);
    expect(contexts(pageFormRegistry.all())).not.toContain(held);
  });
});

test("another identity's page memory retires its forms' models (nothing of it is saved by an update)", async () => {
  const w = peopleWorld();
  w.setCache([]);
  w.env.setDefaults(record());
  openStore(w);
  await w.mount("/people");
  const d = await openNewPerson();
  fireEvent.change(nameOf(d), { target: { value: WITNESS } });
  expect(contexts(pageFormRegistry.dirty())).toEqual(["people-new:dialog"]);
  cleanup();
  peopleMemory("someone-else:1");
  expect(contexts(pageFormRegistry.all())).toEqual([]);
});

// ---- Revision 50 (review of revision 49: F-R49-1, F-R49-2; family `people-update-recovery-participant`, incomplete_fix) ----------------
// The reviewer's three probes (`.agtx/evidence/review-r49-20261102/pending-probe.test.tsx`, `archive-probe.test.tsx`,
// `settlement-probe.test.tsx`) are kept below as maintained witnesses with the same fixture, departure, update path and assertions; their
// controls are kept beside them, and the ownership neighbours each correction must preserve are added. Only imports, formatting and
// lint-clean typing differ (and named helpers in place of the probes' inline set-up).

const PRIVATE = { grants: [], exclude_accounts: [] };
const HOME_VIEW = {
  grants: [{ kind: "household" as const, id: HOME, edit: false }],
  exclude_accounts: [],
};
const FIELD_CONTEXT = `people-field:${P}:${F}`;
const FIELD_KEY = `field:${P}:${F}`;

/** The outbox's `method` held after the operation was admitted, until `release` (`entered`: the calls that reached it). */
function holdOutbox(
  w: ReturnType<typeof peopleWorld>,
  method: "enqueue" | "supersede",
) {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const held = { entered: 0, release: () => open() };
  const env = w.env as unknown as { outbox: () => unknown };
  const real = env.outbox;
  env.outbox = () => {
    const outbox = real() as Record<
      string,
      (...args: unknown[]) => unknown
    > | null;
    if (outbox === null) return null;
    const write = outbox[method] as (...args: unknown[]) => unknown;
    return {
      ...outbox,
      [method]: async (...args: unknown[]) => {
        held.entered += 1;
        await gate;
        return write(...args);
      },
    };
  };
  return held;
}

/** A conflicted field save (the reviewer's fixture): stored as `version_conflict` against the field's version 9. */
const CONFLICTED = {
  command: {
    kind: "put_field",
    id: F,
    parent_id: P,
    expected_version: 8,
    expected_policy_version: 3,
    label: "Phone",
    value: { kind: "text", text: "07700 900999" },
  },
};

/** The reviewer's field world: an existing field (version 9, policy version 3); with `conflict`, its conflicted save. */
function operationWorld(conflict: boolean) {
  const w = peopleWorld();
  w.setCache([
    person({ id: P, label: "Ada" }),
    fieldRow({ id: F, parent_id: P, version: 9, policy_version: 3 }),
  ]);
  w.env.setDefaults(record());
  const store = openStore(w);
  if (conflict) {
    w.env.setDrafts([
      draftRow({
        local_id: "c",
        kind: "put_field",
        status: "version_conflict",
        index_targets: [F],
        target_resource_ids: [F],
        command: CONFLICTED,
      }),
    ]);
    w.putBody("c", CONFLICTED);
  } else w.sharing.next.policy.push(ok({ version: 3, policy: PRIVATE }));
  return { w, store };
}

type Operation = "save" | "conflict" | "archive";
const PRESS: Record<Operation, string> = {
  save: "Save",
  conflict: "Save mine on the current version",
  archive: "Archive",
};

async function openOperationEditor(
  w: ReturnType<typeof peopleWorld>,
  conflict: boolean,
) {
  const { router } = await w.mount(`/people/${P}/fields/${F}`);
  const d = await screen.findByRole("dialog");
  if (!conflict)
    await within(d).findByRole("radio", { name: "Only you", checked: true });
  return { router, d };
}

/** The editor's in-dialog sync control: the editor unmounts, its session kept in page memory. */
async function leaveBySync(d: HTMLElement) {
  const sync = d.querySelector("[data-sync-tone]") as HTMLElement | null;
  expect(sync).not.toBeNull();
  fireEvent.click(sync as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("Every admitted operation of a field editor's session is outstanding for an update (revision 50, F-R49-1)", () => {
  for (const operation of ["save", "conflict", "archive"] as const)
    for (const remount of [false, true])
      test(`${operation}${operation === "save" ? " (ordinary-save control)" : ""}: held after admission, left by the Sync control${remount ? " and reopened" : ""}: no reload until it completes, then one`, async () => {
        const conflict = operation === "conflict";
        const { w, store } = operationWorld(conflict);
        const { router, d } = await openOperationEditor(w, conflict);
        const held = holdOutbox(w, conflict ? "supersede" : "enqueue");
        if (operation === "save")
          fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
            target: { value: "07700 900999" },
          });
        fireEvent.click(
          await within(d).findByRole("button", {
            name: PRESS[operation],
          }),
        );
        await waitFor(() => expect(held.entered).toBe(1));
        expect(w.people.memory.pending.size).toBeGreaterThan(0);
        // Outstanding in the page's registry from its admission, whatever shows the editor.
        expect(pageFormRegistry.pending()).toBeGreaterThan(0);
        await leaveBySync(d);
        expect(pageFormRegistry.pending()).toBeGreaterThan(0);
        if (remount) {
          await act(async () => {
            router.history.back();
          });
          const again = await screen.findByRole("dialog");
          // Every mount of the session shows its operation running (and admits nothing more).
          expect(
            (again.querySelector("fieldset") as HTMLFieldSetElement).disabled,
          ).toBe(true);
          expect(pageFormRegistry.pending()).toBeGreaterThan(0);
        }
        const { origin, tab } = await updatingTab();
        let before: { reloads: number; state: string; built: number } | null =
          null;
        try {
          await acceptUpdate(origin, tab);
          before = {
            reloads: tab.reloads,
            state: tab.state.kind,
            built: w.built.length,
          };
        } finally {
          await act(async () => {
            held.release();
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        }
        // Releasing the hold completes exactly one write: it was live work.
        await waitFor(() => expect(w.built).toHaveLength(1));
        expect(
          before,
          "an update must wait for this admitted save, including through the sync-control departure",
        ).toEqual({ reloads: 0, state: "saving", built: 0 });
        // Then the update goes on, on its production schedule: one reload, nothing more sent, no unfinished copy left behind.
        await act(async () => {
          await origin.clock.advance(FLUSH_START_GRACE_MS);
        });
        await waitFor(() => expect(tab.reloads).toBe(1));
        expect(w.built).toHaveLength(1);
        expect(await store.list(FIELD_CONTEXT)).toEqual([]);
      });

  test("Save mine sends the stored conflicted save, not the editor's input: input typed before it stays unfinished, and the update saves it before its one reload", async () => {
    const { w, store } = operationWorld(true);
    const { d } = await openOperationEditor(w, true);
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Mobile" },
    });
    const held = holdOutbox(w, "supersede");
    fireEvent.click(
      await within(d).findByRole("button", {
        name: PRESS.conflict,
      }),
    );
    await waitFor(() => expect(held.entered).toBe(1));
    const { origin, tab } = await updatingTab();
    let before = -1;
    try {
      await acceptUpdate(origin, tab);
      before = tab.reloads;
    } finally {
      await act(async () => {
        held.release();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(before).toBe(0);
    await act(async () => {
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    await waitFor(() => expect(tab.reloads).toBe(1));
    // The replacement's success never marked the typed input saved: the update kept it for the next page.
    expect(
      (await copiesOf(store, FIELD_CONTEXT, fieldCodec(P, F).decode)).map(
        (copy) => copy?.form.name,
      ),
    ).toEqual(["Mobile"]);
    expect(w.built).toHaveLength(1);
  });

  for (const operation of ["conflict", "archive"] as const)
    test(`a refused ${operation} is waited for too; the input typed before it is then saved by the update, and nothing is written`, async () => {
      const conflict = operation === "conflict";
      const { w, store } = operationWorld(conflict);
      const { d } = await openOperationEditor(w, conflict);
      fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
        target: { value: "Mobile" },
      });
      const held = holdOutbox(w, conflict ? "supersede" : "enqueue");
      w.outcomes.push({ kind: "refused", reason: "quota_exceeded" });
      fireEvent.click(
        await within(d).findByRole("button", {
          name: PRESS[operation],
        }),
      );
      await waitFor(() => expect(held.entered).toBe(1));
      const { origin, tab } = await updatingTab();
      let before = -1;
      try {
        await acceptUpdate(origin, tab);
        before = tab.reloads;
      } finally {
        await act(async () => {
          held.release();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      expect(before).toBe(0);
      await act(async () => {
        await origin.clock.advance(FLUSH_START_GRACE_MS);
      });
      await waitFor(() => expect(tab.reloads).toBe(1));
      expect(w.built).toHaveLength(0);
      expect(
        (await copiesOf(store, FIELD_CONTEXT, fieldCodec(P, F).decode)).map(
          (copy) => copy?.form.name,
        ),
      ).toEqual(["Mobile"]);
    });

  for (const operation of ["conflict", "archive"] as const)
    test(`${operation} pressed in the turn an update reload's preparation began admits nothing and sends nothing`, async () => {
      const conflict = operation === "conflict";
      const { w } = operationWorld(conflict);
      const { d } = await openOperationEditor(w, conflict);
      const held = holdOutbox(w, conflict ? "supersede" : "enqueue");
      const press = await within(d).findByRole("button", {
        name: PRESS[operation],
      });
      let thaw: () => void = () => undefined;
      // One synchronous step: the freeze, then the press on the button as last rendered (React renders the freeze after it).
      act(() => {
        thaw = pageFormRegistry.freeze();
        press.click();
      });
      try {
        await tick();
        expect(held.entered).toBe(0);
        expect(w.people.memory.pending.size).toBe(0);
        expect(pageFormRegistry.pending()).toBe(0);
      } finally {
        act(() => thaw());
        held.release();
      }
      expect(w.built).toHaveLength(0);
    });
});

/** The reviewer's settlement world: an existing field shared with Home (policy version 6), its content write held after admission. */
async function savingField(policyChange: boolean) {
  const w = peopleWorld();
  w.setCache([
    person({ id: P, label: "Ada" }),
    fieldRow({
      id: F,
      parent_id: P,
      label: "Phone",
      version: 4,
      policy_version: 6,
    }),
  ]);
  w.env.setDefaults(record());
  const store = openStore(w);
  w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
  if (policyChange)
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
  const { router } = await w.mount(`/people/${P}/fields/${F}`);
  const held = holdOutbox(w, "enqueue");
  const d = await screen.findByRole("dialog");
  await within(d).findByRole("radio", {
    name: "Home · can view",
    checked: true,
  });
  fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
    target: { value: "0771" },
  });
  if (policyChange)
    fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
  fireEvent.click(within(d).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(held.entered).toBe(1));
  return { w, store, router, d, held };
}

const leave = (router: Awaited<ReturnType<typeof savingField>>["router"]) =>
  act(async () => {
    await router.navigate({ to: "/settings" });
  });

describe("A successful save of a session no editor shows retires its recovery (revision 50, F-R49-2)", () => {
  for (const policyChange of [false, true])
    for (const unmounted of [false, true])
      test(`settled field success leaves no unfinished recovery: policyChange=${policyChange} unmounted=${unmounted}`, async () => {
        const { w, store, router, held } = await savingField(policyChange);
        if (unmounted) await leave(router);
        await act(async () => {
          held.release();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await waitFor(() => expect(w.built).toHaveLength(1));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await waitFor(() => expect(pageFormRegistry.pending()).toBe(0));
        expect(w.people.memory.drafts.has(FIELD_KEY)).toBe(false);
        const [content] = w.built;
        expect(
          (
            content?.command as {
              command?: { expected_policy_version?: number };
            }
          )?.command?.expected_policy_version,
        ).toBe(policyChange ? 7 : 6);
        const dirty = contexts(pageFormRegistry.dirty());
        const flushed = await flushDirty(pageFormRegistry);
        const copies = await copiesOf(
          store,
          FIELD_CONTEXT,
          fieldCodec(P, F).decode,
        );
        expect(
          dirty,
          "a successfully saved closed editor must not be resurrected as unfinished",
        ).toEqual([]);
        expect(flushed).toEqual([]);
        expect(copies).toEqual([]);
      });

  test("a partial save while no editor shows it (the audience saved, the content refused) keeps the input unfinished, bound to the confirmed audience", async () => {
    const { w, store, router, held } = await savingField(true);
    w.outcomes.push({ kind: "refused", reason: "quota_exceeded" });
    await leave(router);
    await act(async () => {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(pageFormRegistry.pending()).toBe(0));
    expect(w.built).toHaveLength(0);
    expect(w.people.memory.drafts.has(FIELD_KEY)).toBe(true);
    expect(contexts(pageFormRegistry.dirty())).toEqual([FIELD_CONTEXT]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    const [copy] = await copiesOf(
      store,
      FIELD_CONTEXT,
      fieldCodec(P, F).decode,
    );
    expect(copy?.form.slots.text).toEqual({ text: "0771" });
    expect(copy?.snapshot?.policyVersion).toBe(7);
    expect(copy?.touched).toBe(false);
  });

  test("a later session of the editor is never retired by an earlier session's success (Cancel while it saves, reopen, type; then it completes)", async () => {
    const { w, store, router, d, held } = await savingField(false);
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
    await act(async () => {
      await router.navigate({
        to: "/people/$personId/fields/$fieldId",
        params: { personId: P, fieldId: F },
      });
    });
    const later = await screen.findByRole("dialog");
    await within(later).findByRole("radio", {
      name: "Home · can view",
      checked: true,
    });
    fireEvent.change(within(later).getByRole("textbox", { name: "Name" }), {
      target: { value: "Later" },
    });
    await act(async () => {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(w.built).toHaveLength(1));
    await waitFor(() => expect(pageFormRegistry.pending()).toBe(0));
    // The later session is untouched: still shown, still unfinished, and an update saves it.
    expect(within(later).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Later",
    );
    expect(contexts(pageFormRegistry.dirty())).toEqual([FIELD_CONTEXT]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    expect(
      (await copiesOf(store, FIELD_CONTEXT, fieldCodec(P, F).decode)).map(
        (copy) => copy?.form.name,
      ),
    ).toEqual(["Later"]);
  });

  test("another identity's session that completes after the switch is not the new identity's, and leaves nothing in the registry", async () => {
    const { store, router, held } = await savingField(true);
    await leave(router);
    cleanup();
    peopleMemory("someone-else:1");
    await act(async () => {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await tick();
    expect(contexts(pageFormRegistry.all())).toEqual([]);
    expect(await flushDirty(pageFormRegistry)).toEqual([]);
    expect(await store.list(FIELD_CONTEXT)).toEqual([]);
  });

  test("a rename queued while no form shows it (control: no re-binding) leaves no unfinished recovery", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada", version: 5, policy_version: 3 }),
    ]);
    const store = openStore(w);
    const { router } = await w.mount(`/people/${P}`);
    await within(header()).findByText("Not linked to an account");
    fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(header()).getByRole("textbox", { name: "Name" }), {
      target: { value: "Ada L." },
    });
    const held = holdOutbox(w, "enqueue");
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.entered).toBe(1));
    await leave(router);
    await act(async () => {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(w.built).toHaveLength(1));
    await waitFor(() => expect(pageFormRegistry.pending()).toBe(0));
    expect(contexts(pageFormRegistry.dirty())).toEqual([]);
    expect(await flushDirty(pageFormRegistry)).toEqual([]);
    expect(await store.list(`people-rename:${P}`)).toEqual([]);
  });

  test("New person saved while no form shows it (control: no re-binding) leaves no unfinished recovery", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const store = openStore(w);
    const { router } = await w.mount("/people");
    const d = await openNewPerson();
    fireEvent.change(nameOf(d), { target: { value: WITNESS } });
    const held = holdOutbox(w, "enqueue");
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.entered).toBe(1));
    await act(async () => {
      await router.navigate({ to: "/settings" });
    });
    await act(async () => {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(w.built).toHaveLength(1));
    await waitFor(() => expect(pageFormRegistry.pending()).toBe(0));
    expect(w.people.memory.drafts.has("new-person")).toBe(false);
    expect(contexts(pageFormRegistry.dirty())).toEqual([]);
    expect(await flushDirty(pageFormRegistry)).toEqual([]);
    expect(await store.list("people-new:dialog")).toEqual([]);
  });
});
