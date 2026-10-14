import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  decode,
  encodeState,
  encodeText,
  fieldOf,
  internalOf,
  snapshotParts,
  UNSUPPORTED,
} from "../../src/lib/form-recovery/controls";
import {
  buildSnapshot,
  restoreSnapshot,
  SensitiveFieldError,
} from "../../src/lib/form-recovery/guard";
import {
  prepareHandoffs,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import type {
  RecoverableFieldSpec,
  RecoverySnapshot,
  SaveResult,
} from "../../src/lib/form-recovery/port";
import {
  createRecoverableFormRegistry,
  flushDirty,
} from "../../src/lib/form-recovery/registry";
import { createRecoveryTab } from "../../src/lib/form-recovery/tab-identity";
import {
  type RecoverableForm,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";
import { TabStorage, World } from "../support/recovery-pages";

/**
 * WEB-14a revision 8, R17 (review of 13 October 2026, `recovery-control-state-value-projection`; design assessment C4, C5; Q6-Q9). Revision 7
 * read every admitted field as `.value`, so checking a checkbox or adding a selection to a multiple select compared equal to the initial
 * state: no dirty form, no copy, and the reload lost it. Over the real hook, session, registry, recovery identity and hand-off, with the
 * memory store and jsdom (not a native browser: the native cases are the browser specs). Every requirement case asserts the STATE itself
 * (checked, selected) after the next page, and that the form was dirty before the update; each kind has a text control beside it.
 */
afterEach(cleanup);

const FORM_CONTEXT = "review-choices";

interface Mounted {
  view: ReturnType<typeof render>;
  registry: ReturnType<typeof createRecoverableFormRegistry>;
  handle: () => RecoverableForm;
  submits: () => number;
  /** Renders the form again (its markup function read afresh). */
  rerender: () => void;
}

/** A page of the tab `storage` showing `markup` in a recoverable form admitting `allow`. */
function mountPage(
  world: World,
  storage: TabStorage,
  page: string,
  markup: () => ReactNode,
  allow: readonly RecoverableFieldSpec[],
): Mounted {
  const registry = createRecoverableFormRegistry();
  let seq = 0;
  const tab = createRecoveryTab({
    uuid: () => `${page}-${++seq}`,
    locks: world.locks.forPage(page),
  });
  const handoffs = storageHandoffs(() => storage as unknown as Storage);
  let handle: RecoverableForm | null = null;
  let submits = 0;
  function Form() {
    const formRef = useRef<HTMLFormElement>(null);
    handle = useRecoverableForm({
      formContext: FORM_CONTEXT,
      allow,
      formRef,
      port: world.store,
      registry,
      tab,
      handoffs,
    });
    return (
      <form
        ref={formRef}
        aria-label="choices"
        onSubmit={(event) => {
          event.preventDefault();
          submits += 1;
        }}
      >
        {markup()}
      </form>
    );
  }
  const view = render(<Form />);
  return {
    view,
    registry,
    handle: () => handle as RecoverableForm,
    submits: () => submits,
    rerender: () => act(() => view.rerender(<Form />)),
  };
}

/** "Save and reload": the saves, then the hand-offs. */
async function update(registry: Mounted["registry"]): Promise<SaveResult[]> {
  let saves: SaveResult[] = [];
  let handed: SaveResult[] = [];
  await act(async () => {
    saves = await flushDirty(registry);
    handed = await prepareHandoffs(registry);
  });
  return [...saves, ...handed];
}

const input = (view: Mounted["view"], label: string) =>
  view.getByLabelText(label) as HTMLInputElement;
const select = (view: Mounted["view"], label: string) =>
  view.getByLabelText(label) as HTMLSelectElement;
const selected = (element: HTMLSelectElement) =>
  [...element.selectedOptions].map((option) => option.value);
const checkedOf = (view: Mounted["view"], name: string) =>
  [
    ...(view.container.querySelectorAll(
      `input[name="${name}"]`,
    ) as NodeListOf<HTMLInputElement>),
  ]
    .filter((member) => member.checked)
    .map((member) => member.value);

interface Kind {
  name: string;
  allow: readonly RecoverableFieldSpec[];
  markup: () => ReactNode;
  edit: (view: Mounted["view"]) => void;
  state: (view: Mounted["view"]) => unknown;
}

const TEXT_SIBLING = <input aria-label="Title" name="title" defaultValue="" />;

const KINDS: Kind[] = [
  {
    name: "CONTROL text input",
    allow: [{ name: "title" }],
    markup: () => TEXT_SIBLING,
    edit: (view) =>
      fireEvent.input(input(view, "Title"), { target: { value: "typed" } }),
    state: (view) => input(view, "Title").value,
  },
  {
    name: "a checkbox checked",
    allow: [{ name: "agree" }],
    markup: () => (
      <input aria-label="Agree" name="agree" type="checkbox" value="yes" />
    ),
    edit: (view) => fireEvent.click(input(view, "Agree")),
    state: (view) => input(view, "Agree").checked,
  },
  {
    name: "a checkbox checked by default, unchecked",
    allow: [{ name: "agree" }],
    markup: () => (
      <input
        aria-label="Agree"
        name="agree"
        type="checkbox"
        value="yes"
        defaultChecked
      />
    ),
    edit: (view) => fireEvent.click(input(view, "Agree")),
    state: (view) => input(view, "Agree").checked,
  },
  {
    name: "a multiple select: a second option selected (the first unchanged)",
    allow: [{ name: "pick" }],
    markup: () => (
      <select aria-label="Pick" name="pick" multiple defaultValue={["a"]}>
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </select>
    ),
    edit: (view) => {
      const element = select(view, "Pick");
      (element.options[1] as HTMLOptionElement).selected = true;
      fireEvent.change(element);
    },
    state: (view) => selected(select(view, "Pick")),
  },
  {
    name: "a multiple select: every selection removed (none is a state)",
    allow: [{ name: "pick" }],
    markup: () => (
      <select aria-label="Pick" name="pick" multiple defaultValue={["a", "c"]}>
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </select>
    ),
    edit: (view) => {
      const element = select(view, "Pick");
      for (const option of element.options) option.selected = false;
      fireEvent.change(element);
    },
    state: (view) => selected(select(view, "Pick")),
  },
  {
    name: "a radio group switched",
    allow: [{ name: "colour" }],
    markup: () => (
      <>
        <input
          aria-label="Red"
          name="colour"
          type="radio"
          value="red"
          defaultChecked
        />
        <input aria-label="Blue" name="colour" type="radio" value="blue" />
      </>
    ),
    edit: (view) => fireEvent.click(input(view, "Blue")),
    state: (view) => checkedOf(view, "colour"),
  },
  {
    name: "a radio group left with no choice",
    allow: [{ name: "colour" }],
    markup: () => (
      <>
        <input
          aria-label="Red"
          name="colour"
          type="radio"
          value="red"
          defaultChecked
        />
        <input aria-label="Blue" name="colour" type="radio" value="blue" />
      </>
    ),
    edit: (view) => {
      input(view, "Red").checked = false;
      fireEvent.change(input(view, "Red"));
    },
    state: (view) => checkedOf(view, "colour"),
  },
  {
    name: "same-named checkboxes: two checked",
    allow: [{ name: "tags" }],
    markup: () => (
      <>
        <input aria-label="Tag A" name="tags" type="checkbox" value="a" />
        <input aria-label="Tag B" name="tags" type="checkbox" value="b" />
        <input aria-label="Tag C" name="tags" type="checkbox" value="c" />
      </>
    ),
    edit: (view) => {
      fireEvent.click(input(view, "Tag A"));
      fireEvent.click(input(view, "Tag C"));
    },
    state: (view) => checkedOf(view, "tags"),
  },
  {
    name: "a checkbox checked beside a changed text (a snapshot is written either way)",
    allow: [{ name: "title" }, { name: "agree" }],
    markup: () => (
      <>
        {TEXT_SIBLING}
        <input aria-label="Agree" name="agree" type="checkbox" value="yes" />
      </>
    ),
    edit: (view) => {
      fireEvent.input(input(view, "Title"), { target: { value: "typed" } });
      fireEvent.click(input(view, "Agree"));
    },
    state: (view) => [input(view, "Title").value, input(view, "Agree").checked],
  },
];

describe("R17 (Q6): an admitted control's state survives an update checkpoint", () => {
  for (const kind of KINDS)
    test(`${kind.name.startsWith("CONTROL") ? "" : "REQUIREMENT: "}${kind.name}: dirty, saved and handed off, and the next page shows the same state (nothing submitted)`, async () => {
      const world = new World();
      const storage = new TabStorage();
      const a = mountPage(world, storage, "A", kind.markup, kind.allow);
      await waitFor(() => expect(a.handle().ready).toBe(true));
      const initial = kind.state(a.view);
      act(() => kind.edit(a.view));
      const before = kind.state(a.view);
      expect(before).not.toEqual(initial);
      expect(a.registry.dirty()).toHaveLength(1);
      expect(await update(a.registry)).toEqual(["saved", "saved"]);
      a.view.unmount();
      world.locks.leave("A");
      const a2 = mountPage(world, storage, "A2", kind.markup, kind.allow);
      await waitFor(() => expect(a2.handle().ready).toBe(true));
      expect(kind.state(a2.view)).toEqual(before);
      expect(a.submits() + a2.submits()).toBe(0);
    });

  test("CONTROL: an untouched checkbox is clean: no copy is written", async () => {
    const world = new World();
    const kind = KINDS[1] as Kind;
    const a = mountPage(world, new TabStorage(), "A", kind.markup, kind.allow);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    expect(a.registry.dirty()).toHaveLength(0);
    expect(await update(a.registry)).toEqual([]);
    expect(await world.store.list(FORM_CONTEXT)).toEqual([]);
  });

  test("a checkbox checked and unchecked again is back where it starts: clean", async () => {
    const world = new World();
    const kind = KINDS[1] as Kind;
    const a = mountPage(world, new TabStorage(), "A", kind.markup, kind.allow);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => kind.edit(a.view));
    act(() => kind.edit(a.view));
    expect(a.registry.dirty()).toHaveLength(0);
  });

  test("the stored copy holds the state as control state (version 1), never as text", async () => {
    const world = new World();
    const kind = KINDS[8] as Kind;
    const a = mountPage(world, new TabStorage(), "A", kind.markup, kind.allow);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => kind.edit(a.view));
    expect(await update(a.registry)).toEqual(["saved", "saved"]);
    const [copy] = await world.store.list(FORM_CONTEXT);
    expect(copy?.values).toEqual({ title: "typed" });
    expect(copy?.controls).toEqual({
      version: 1,
      entries: { agree: { kind: "checkbox", checked: true } },
    });
  });
});

describe("R17 (Q7): defaults, reset, discard and a hidden choice", () => {
  const box = () => (
    <input aria-label="Agree" name="agree" type="checkbox" value="yes" />
  );
  test("a reset takes the checkbox back to its default: clean, no copy", async () => {
    const world = new World();
    const a = mountPage(world, new TabStorage(), "A", box, [{ name: "agree" }]);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => fireEvent.click(input(a.view, "Agree")));
    expect(a.registry.dirty()).toHaveLength(1);
    const form = a.view.getByRole("form") as HTMLFormElement;
    await act(async () => {
      form.reset();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(input(a.view, "Agree").checked).toBe(false);
    expect(a.registry.dirty()).toHaveLength(0);
  });

  test("'Discard instead' takes the checkbox back to its initial state", async () => {
    const world = new World();
    const a = mountPage(world, new TabStorage(), "A", box, [{ name: "agree" }]);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => fireEvent.click(input(a.view, "Agree")));
    let result: unknown;
    await act(async () => {
      result = await a.handle().discard();
    });
    expect(result).toBe("discarded");
    expect(input(a.view, "Agree").checked).toBe(false);
    expect(a.registry.dirty()).toHaveLength(0);
  });

  test("a checked box hidden is retained (dirty, cannot be saved), and comes back checked when shown again untouched", async () => {
    const world = new World();
    let shown = true;
    const markup = () => (shown ? box() : null);
    const a = mountPage(world, new TabStorage(), "A", markup, [
      { name: "agree" },
    ]);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => fireEvent.click(input(a.view, "Agree")));
    shown = false;
    a.rerender();
    expect(a.view.queryByLabelText("Agree")).toBeNull();
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
    shown = true;
    a.rerender();
    await waitFor(() => expect(input(a.view, "Agree").checked).toBe(true));
    expect(await update(a.registry)).toEqual(["saved", "saved"]);
    const [copy] = await world.store.list(FORM_CONTEXT);
    expect(copy?.controls).toEqual({
      version: 1,
      entries: { agree: { kind: "checkbox", checked: true } },
    });
  });
});

describe("R17 (Q7): the same field name shown by another kind of control", () => {
  test("text typed, then the field is shown as a checkbox (React keeps the element, only its type changes): the text cannot be shown there and stays owed (dirty, not saved), never replaced silently", async () => {
    const world = new World();
    let asBox = false;
    const markup = () =>
      asBox ? (
        <input aria-label="Choice" name="choice" type="checkbox" value="yes" />
      ) : (
        <input aria-label="Choice" name="choice" defaultValue="" />
      );
    const a = mountPage(world, new TabStorage(), "A", markup, [
      { name: "choice" },
    ]);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() =>
      fireEvent.input(input(a.view, "Choice"), { target: { value: "typed" } }),
    );
    asBox = true;
    a.rerender();
    expect(input(a.view, "Choice").type).toBe("checkbox");
    expect(input(a.view, "Choice").checked).toBe(false);
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
    expect(await world.store.list(FORM_CONTEXT)).toEqual([]);
  });
});

describe("R17 (Q8): a submission covers only the state it sent", () => {
  test("a ticket taken with one tag checked; a second checked after the send: `kept`, dirty, and the next page shows both", async () => {
    const world = new World();
    const storage = new TabStorage();
    const kind = KINDS[7] as Kind;
    const a = mountPage(world, storage, "A", kind.markup, kind.allow);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => fireEvent.click(input(a.view, "Tag A")));
    const ticket = a.handle().submitting();
    act(() => fireEvent.click(input(a.view, "Tag B")));
    let result: unknown;
    await act(async () => {
      result = await ticket?.succeeded();
    });
    expect(result).toBe("kept");
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["saved", "saved"]);
    a.view.unmount();
    world.locks.leave("A");
    const a2 = mountPage(world, storage, "A2", kind.markup, kind.allow);
    await waitFor(() => expect(a2.handle().ready).toBe(true));
    expect(checkedOf(a2.view, "tags")).toEqual(["a", "b"]);
  });

  test("CONTROL: the ticket's exact state succeeds: discarded, clean", async () => {
    const world = new World();
    const kind = KINDS[7] as Kind;
    const a = mountPage(world, new TabStorage(), "A", kind.markup, kind.allow);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => fireEvent.click(input(a.view, "Tag A")));
    const ticket = a.handle().submitting();
    let result: unknown;
    await act(async () => {
      result = await ticket?.succeeded();
    });
    expect(result).toBe("discarded");
    expect(a.registry.dirty()).toHaveLength(0);
  });
});

describe("R17 (Q9): sensitive, unsupported, legacy and unreadable state", () => {
  test("an admitted control this build cannot represent (a file input) is clean untouched, and once edited it is dirty and cannot be saved (never a silent clean reload)", async () => {
    const world = new World();
    const markup = () => (
      <>
        {TEXT_SIBLING}
        <input aria-label="Attachment" name="attachment" type="file" />
      </>
    );
    const a = mountPage(world, new TabStorage(), "A", markup, [
      { name: "title" },
      { name: "attachment" },
    ]);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    expect(a.registry.dirty()).toHaveLength(0);
    act(() => {
      fireEvent.change(input(a.view, "Attachment"));
    });
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
    expect(await world.store.list(FORM_CONTEXT)).toEqual([]);
    // An explicit discard is the person's act: then nothing is owed.
    await act(async () => {
      await a.handle().discard();
    });
    expect(a.registry.dirty()).toHaveLength(0);
  });

  test("two text inputs of one name (no single state) are unsupported: edited, dirty and not saved", async () => {
    const world = new World();
    const markup = () => (
      <>
        <input aria-label="First" name="dup" defaultValue="" />
        <input aria-label="Second" name="dup" defaultValue="" />
      </>
    );
    const a = mountPage(world, new TabStorage(), "A", markup, [
      { name: "dup" },
    ]);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() =>
      fireEvent.input(input(a.view, "Second"), { target: { value: "x" } }),
    );
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
  });

  test("a stored text that looks like a control state stays literal text", async () => {
    const world = new World();
    const literal = `${String.fromCharCode(1)}{"kind":"checkbox","checked":true}`;
    await world.store.save({
      formContext: FORM_CONTEXT,
      tabInstanceId: "gone-tab",
      values: { title: literal },
      savedAt: "2026-10-14T09:00:00.000Z",
    });
    const a = mountPage(world, new TabStorage(), "A", () => TEXT_SIBLING, [
      { name: "title" },
    ]);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    expect(input(a.view, "Title").value).toBe(literal);
  });

  test("a copy holding state this build cannot read is offered, never restored in part, never chosen", async () => {
    const world = new World();
    await world.store.save({
      formContext: FORM_CONTEXT,
      tabInstanceId: "gone-tab",
      values: { title: "from a newer build" },
      // Control state of a later version: this build cannot read it.
      controls: {
        version: 2,
        entries: { agree: { kind: "toggle", on: true } },
      },
      savedAt: "2026-10-14T09:00:00.000Z",
    });
    const a = mountPage(world, new TabStorage(), "A", () => TEXT_SIBLING, [
      { name: "title" },
    ]);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    expect(input(a.view, "Title").value).toBe("");
    expect(a.handle().restored).toBeNull();
    expect(a.handle().alternatives.map((c) => c.tabInstanceId)).toEqual([
      "gone-tab",
    ]);
    let chosen: unknown;
    await act(async () => {
      chosen = await a.handle().restoreAlternative("gone-tab");
    });
    expect(chosen).toBe("refused");
    expect(input(a.view, "Title").value).toBe("");
    expect(await world.store.list(FORM_CONTEXT)).toHaveLength(1);
  });

  test("a copy whose choice no longer fits the field (an option gone) is restored for the rest; the choice stays owed: dirty, not saved", async () => {
    const world = new World();
    await world.store.save({
      formContext: FORM_CONTEXT,
      tabInstanceId: "gone-tab",
      values: { title: "kept" },
      controls: {
        version: 1,
        entries: { pick: { kind: "multiple", selected: ["a", "z"] } },
      },
      savedAt: "2026-10-14T09:00:00.000Z",
    });
    const markup = () => (
      <>
        {TEXT_SIBLING}
        <select aria-label="Pick" name="pick" multiple defaultValue={[]}>
          <option value="a">A</option>
          <option value="b">B</option>
        </select>
      </>
    );
    const a = mountPage(world, new TabStorage(), "A", markup, [
      { name: "title" },
      { name: "pick" },
    ]);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    expect(input(a.view, "Title").value).toBe("kept");
    expect(selected(select(a.view, "Pick"))).toEqual([]);
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
    // The copy it came from is not removed.
    expect(await world.store.list(FORM_CONTEXT)).toHaveLength(1);
  });
});

describe("R17: the codec and the guard (C4, C5)", () => {
  const form = (html: string): HTMLFormElement => {
    const element = document.createElement("form");
    element.innerHTML = html;
    document.body.append(element);
    return element;
  };
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("texts are themselves; choices and unsupported states never read as text; a text that begins with the tag is escaped", () => {
    expect(encodeText("plain")).toBe("plain");
    const tagged = `${String.fromCharCode(1)}{"kind":"radio","value":null}`;
    expect(decode(encodeText(tagged))).toEqual({ kind: "text", text: tagged });
    expect(decode(encodeState({ kind: "radio", value: null }))).toEqual({
      kind: "state",
      state: { kind: "radio", value: null },
    });
    expect(decode(UNSUPPORTED)).toEqual({ kind: "unsupported" });
    // Absent, empty text, unchecked and no selection are four different states.
    const states = [
      encodeText(""),
      encodeState({ kind: "checkbox", checked: false }),
      encodeState({ kind: "multiple", selected: [] }),
      encodeState({ kind: "radio", value: null }),
      encodeState({ kind: "checkboxes", checked: [] }),
    ];
    expect(new Set(states).size).toBe(states.length);
  });

  test("a snapshot keeps texts in `values` and choices in `controls`; read back, it is the same state", () => {
    const values = {
      title: encodeText("x"),
      agree: encodeState({ kind: "checkbox", checked: true }),
      unsupported: UNSUPPORTED,
    };
    const parts = snapshotParts(values);
    expect(parts).toEqual({
      values: { title: "x" },
      controls: {
        version: 1,
        entries: { agree: { kind: "checkbox", checked: true } },
      },
    });
    expect(internalOf(parts)).toEqual({
      title: values.title,
      agree: values.agree,
    });
    expect(snapshotParts({ title: "x" })).toEqual({ values: { title: "x" } });
  });

  test("each kind of field, and what cannot be one field", () => {
    const element = form(`
      <input name="t" value="v">
      <input name="c" type="checkbox" value="yes" checked>
      <input name="r" type="radio" value="a"><input name="r" type="radio" value="b" checked>
      <input name="g" type="checkbox" value="a" checked><input name="g" type="checkbox" value="b">
      <select name="m" multiple><option value="a" selected>A</option><option value="b">B</option></select>
      <select name="dupm" multiple><option value="a">A</option><option value="a">A2</option></select>
      <input name="dupr" type="radio" value="a"><input name="dupr" type="radio" value="a">
      <input name="mix" type="radio" value="a"><input name="mix" type="checkbox" value="b">
      <input name="f" type="file">
      <input name="s" type="checkbox" value="a"><input name="s" type="checkbox" value="b" data-atlas-sensitive>
      <fieldset name="fs"></fieldset>
    `);
    const read = (name: string) => {
      const field = fieldOf(element, name);
      return field === null || field === "sensitive" ? field : field.read();
    };
    expect(read("t")).toBe("v");
    expect(read("c")).toBe(encodeState({ kind: "checkbox", checked: true }));
    expect(read("r")).toBe(encodeState({ kind: "radio", value: "b" }));
    expect(read("g")).toBe(encodeState({ kind: "checkboxes", checked: ["a"] }));
    expect(read("m")).toBe(encodeState({ kind: "multiple", selected: ["a"] }));
    for (const name of ["dupm", "dupr", "mix", "f"])
      expect(read(name)).toBe(UNSUPPORTED);
    expect(read("s")).toBe("sensitive");
    expect(read("fs")).toBeNull();
    expect(read("absent")).toBeNull();
  });

  test("a state is written only into a field that can show it; nothing is changed otherwise", () => {
    const element = form(`
      <input name="c" type="checkbox" value="yes">
      <select name="m" multiple><option value="a">A</option><option value="b">B</option></select>
    `);
    const c = fieldOf(element, "c");
    const m = fieldOf(element, "m");
    if (c === null || c === "sensitive" || m === null || m === "sensitive")
      throw new Error("setup");
    expect(c.write(encodeText("yes"))).toBe(false);
    expect(c.write(encodeState({ kind: "radio", value: "yes" }))).toBe(false);
    expect((element.elements.namedItem("c") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(
      m.write(encodeState({ kind: "multiple", selected: ["a", "z"] })),
    ).toBe(false);
    expect(m.read()).toBe(encodeState({ kind: "multiple", selected: [] }));
    expect(m.write(encodeState({ kind: "multiple", selected: ["b"] }))).toBe(
      true,
    );
    expect(m.read()).toBe(encodeState({ kind: "multiple", selected: ["b"] }));
  });

  test("the strict guard refuses a group with a sensitive member; the lenient one leaves it out; a restore never writes it", () => {
    const element = form(`
      <input name="title" value="t">
      <input name="s" type="checkbox" value="a" checked><input name="s" type="checkbox" value="b" data-atlas-sensitive>
    `);
    const allow = [{ name: "title" }, { name: "s" }];
    const base = { form: element, formContext: "f", tabInstanceId: "t", allow };
    expect(() => buildSnapshot({ ...base, strict: true })).toThrow(
      SensitiveFieldError,
    );
    const lenient = buildSnapshot({ ...base, strict: false });
    expect(lenient.values).toEqual({ title: "t" });
    expect(lenient.controls).toBeUndefined();
    const copy: RecoverySnapshot = {
      formContext: "f",
      tabInstanceId: "t",
      values: { title: "u" },
      controls: {
        version: 1,
        entries: { s: { kind: "checkboxes", checked: ["b"] } },
      },
      savedAt: "",
    };
    expect(restoreSnapshot(element, copy, allow)).toEqual([]);
    const members = element.querySelectorAll<HTMLInputElement>('[name="s"]');
    expect([...members].map((m) => m.checked)).toEqual([true, false]);
  });
});
