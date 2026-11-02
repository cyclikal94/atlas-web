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
  encodeState,
  encodeText,
  type FieldAccess,
  fieldOf,
  sameShape,
} from "../../src/lib/form-recovery/controls";
import {
  hasDebt,
  noteInput,
  openFields,
  sync,
} from "../../src/lib/form-recovery/fields";
import {
  handoffContext,
  prepareHandoffs,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import type {
  RecoverableFieldSpec,
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
 * WEB-14a revision 9, R17 (review of 14 October 2026, `recovery-control-state-value-projection`, incomplete_fix; design assessment of
 * 14 October 2026, C1-C5, Q2-Q8). Revision 8 took what a control showed as the field's value whenever the element and its kind were the
 * same, so removing ONLY the selected option or member (the select or the first radio stays) lost the choice without an event (R17-A); and
 * a single select's write returned true for an option it did not have, so a successor reported the restore complete, saved the empty
 * selection and removed both copies that held the choice (R17-B). Over the real hook, session, registry, recovery identity and hand-off, with
 * the memory store and jsdom (native engines: `tests/e2e/fixture.pwa-shapes.spec.ts`). Each case asserts the selected state itself, the
 * dirty count, the save result and the exact rows; nothing is ever submitted (no submit handler runs).
 */
afterEach(cleanup);

const FORM_CONTEXT = "review-shapes";

interface Mounted {
  view: ReturnType<typeof render>;
  registry: ReturnType<typeof createRecoverableFormRegistry>;
  handle: () => RecoverableForm;
  submits: () => number;
  /** Renders the form again and lets the page's observers run (as a browser does before the next task). */
  rerender: () => Promise<void>;
  /** Renders the form again NOW: nothing else runs before the hook's render reads the fields. */
  rerenderNow: () => void;
}

function mountPage(
  world: World,
  storage: TabStorage,
  page: string,
  markup: () => ReactNode,
  allow: readonly RecoverableFieldSpec[],
  port: World["store"] | null = world.store,
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
      port,
      registry,
      tab,
      handoffs,
    });
    return (
      <form
        ref={formRef}
        aria-label="shapes"
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
    rerender: () =>
      act(async () => {
        view.rerender(<Form />);
      }),
    rerenderNow: () => act(() => view.rerender(<Form />)),
  };
}

async function update(registry: Mounted["registry"]): Promise<SaveResult[]> {
  let saves: SaveResult[] = [];
  let handed: SaveResult[] = [];
  await act(async () => {
    saves = await flushDirty(registry);
    handed = await prepareHandoffs(registry);
  });
  return [...saves, ...handed];
}

/** Every live row of the form (ordinary and hand-off), as [where, id, its state of `choice`]. */
async function rows(world: World): Promise<[string, string, unknown][]> {
  const all = [
    ...(await world.store.list(FORM_CONTEXT)),
    ...(await world.store.list(handoffContext(FORM_CONTEXT))),
  ];
  return all.map((copy) => [
    copy.formContext === FORM_CONTEXT ? "ordinary" : "handoff",
    copy.tabInstanceId,
    (copy.controls?.entries as Record<string, unknown> | undefined)?.choice ??
      copy.values.choice,
  ]);
}

const CHOICE: readonly RecoverableFieldSpec[] = [{ name: "choice" }];

const selectOf = (view: Mounted["view"]) =>
  view.getByLabelText("Choice") as HTMLSelectElement;
const selectedOf = (view: Mounted["view"]) =>
  [...selectOf(view).selectedOptions].map((option) => option.value);
const checkedOf = (view: Mounted["view"]) =>
  [
    ...(view.container.querySelectorAll(
      'input[name="choice"]',
    ) as NodeListOf<HTMLInputElement>),
  ]
    .filter((member) => member.checked)
    .map((member) => member.value);

/** A kind of admitted choice control: its markup given which values are shown, the edit to B, and the state the person sees. */
interface Kind {
  name: string;
  markup: (shown: readonly string[]) => ReactNode;
  /** Chooses B (and, for a multiple control, keeps A). */
  chooseB: (view: Mounted["view"]) => void;
  state: (view: Mounted["view"]) => unknown;
  /** The state with B chosen. */
  withB: unknown;
  /** The state stored for it (`controls` entry, or the text of a single select). */
  stored: unknown;
}

const options = (shown: readonly string[]) =>
  shown.map((value) => (
    <option key={value} value={value}>
      {value.toUpperCase()}
    </option>
  ));
const members = (shown: readonly string[], type: "radio" | "checkbox") =>
  shown.map((value) => (
    <input
      key={value}
      aria-label={`Member ${value}`}
      name="choice"
      type={type}
      value={value}
      defaultChecked={type === "checkbox" && value === "a"}
    />
  ));

const KINDS: Kind[] = [
  {
    name: "a single select",
    markup: (shown) => (
      <select aria-label="Choice" name="choice" defaultValue="a">
        {options(shown)}
      </select>
    ),
    chooseB: (view) => {
      selectOf(view).value = "b";
      fireEvent.change(selectOf(view));
    },
    state: (view) => selectedOf(view),
    withB: ["b"],
    stored: "b",
  },
  {
    name: "a multiple select",
    markup: (shown) => (
      <select aria-label="Choice" name="choice" multiple defaultValue={["a"]}>
        {options(shown)}
      </select>
    ),
    chooseB: (view) => {
      const b = [...selectOf(view).options].find((o) => o.value === "b");
      (b as HTMLOptionElement).selected = true;
      fireEvent.change(selectOf(view));
    },
    state: (view) => selectedOf(view),
    withB: ["a", "b"],
    stored: { kind: "multiple", selected: ["a", "b"] },
  },
  {
    name: "a radio group",
    markup: (shown) => <>{members(shown, "radio")}</>,
    chooseB: (view) => fireEvent.click(view.getByLabelText("Member b")),
    state: (view) => checkedOf(view),
    withB: ["b"],
    stored: { kind: "radio", value: "b" },
  },
  {
    name: "same-named checkboxes",
    markup: (shown) => <>{members(shown, "checkbox")}</>,
    chooseB: (view) => fireEvent.click(view.getByLabelText("Member b")),
    state: (view) => checkedOf(view),
    withB: ["a", "b"],
    stored: { kind: "checkboxes", checked: ["a", "b"] },
  },
];

const ALL = ["a", "b", "c"];

describe("R17-A (Q2, Q3): removing only the chosen option or member keeps the choice owed", () => {
  for (const kind of KINDS) {
    test(`REQUIREMENT ${kind.name}: B removed (the control and its first member stay): dirty, the update's save fails, no row; B shown again comes back chosen and is then saved exactly`, async () => {
      const world = new World();
      let shown = ALL;
      const a = mountPage(
        world,
        new TabStorage(),
        "A",
        () => kind.markup(shown),
        CHOICE,
      );
      await waitFor(() => expect(a.handle().ready).toBe(true));
      act(() => kind.chooseB(a.view));
      expect(kind.state(a.view)).toEqual(kind.withB);
      shown = ["a", "c"];
      await a.rerender();
      expect(a.registry.dirty()).toHaveLength(1);
      expect(await update(a.registry)).toEqual(["failed"]);
      expect(await rows(world)).toEqual([]);
      shown = ALL;
      await a.rerender();
      await waitFor(() => expect(kind.state(a.view)).toEqual(kind.withB));
      expect(await update(a.registry)).toEqual(["saved", "saved"]);
      expect((await rows(world)).map(([, , state]) => state)).toEqual([
        kind.stored,
        kind.stored,
      ]);
      expect(a.submits()).toBe(0);
    });

    test(`CONTROL ${kind.name}: an UNCHOSEN member (C) removed is no debt: the choice is saved as it is`, async () => {
      const world = new World();
      let shown = ALL;
      const a = mountPage(
        world,
        new TabStorage(),
        "A",
        () => kind.markup(shown),
        CHOICE,
      );
      await waitFor(() => expect(a.handle().ready).toBe(true));
      act(() => kind.chooseB(a.view));
      shown = ["a", "b"];
      await a.rerender();
      expect(kind.state(a.view)).toEqual(kind.withB);
      expect(await update(a.registry)).toEqual(["saved", "saved"]);
      expect((await rows(world)).map(([, , state]) => state)).toEqual([
        kind.stored,
        kind.stored,
      ]);
    });

    test(`CONTROL ${kind.name}: the whole field hidden is retained and comes back chosen`, async () => {
      const world = new World();
      let shown: readonly string[] = ALL;
      let field = true;
      const a = mountPage(
        world,
        new TabStorage(),
        "A",
        () => (field ? kind.markup(shown) : null),
        CHOICE,
      );
      await waitFor(() => expect(a.handle().ready).toBe(true));
      act(() => kind.chooseB(a.view));
      field = false;
      await a.rerender();
      expect(a.registry.dirty()).toHaveLength(1);
      expect(await update(a.registry)).toEqual(["failed"]);
      field = true;
      shown = ALL;
      await a.rerender();
      await waitFor(() => expect(kind.state(a.view)).toEqual(kind.withB));
    });
  }

  test("the shape is checked at the read itself: B removed from the page and the form asked at once (before any observer runs) is dirty and its save fails", async () => {
    const world = new World();
    const kind = KINDS[0] as Kind;
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => kind.markup(ALL),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => kind.chooseB(a.view));
    const b = selectOf(a.view).querySelector('option[value="b"]') as Element;
    const after = b.nextSibling;
    b.remove();
    // Synchronously: no MutationObserver record has been delivered yet.
    expect(selectedOf(a.view)).toEqual(["a"]);
    expect(a.registry.dirty()).toHaveLength(1);
    let saved: SaveResult[] = [];
    await act(async () => {
      saved = await flushDirty(a.registry);
    });
    expect(saved).toEqual(["failed"]);
    selectOf(a.view).insertBefore(b, after);
    expect(a.registry.dirty()).toHaveLength(1);
    expect(selectedOf(a.view)).toEqual(["b"]);
  });

  test("a render that reads the fields (refresh) never takes the reduced state: B removed, the form rendered before any sync, B still owed and back when shown", async () => {
    const world = new World();
    const kind = KINDS[2] as Kind;
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => kind.markup(ALL),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => kind.chooseB(a.view));
    const b = a.view.getByLabelText("Member b");
    const after = b.nextSibling;
    const parent = b.parentNode as ParentNode & Node;
    b.remove();
    // The hook renders (and reads the followed fields) before the observer delivers anything.
    a.rerenderNow();
    expect(checkedOf(a.view)).toEqual([]);
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
    parent.insertBefore(b, after);
    expect(a.registry.dirty()).toHaveLength(1);
    expect(checkedOf(a.view)).toEqual(["b"]);
  });

  test("an option's VALUE changed in place (no element removed) is another shape: the choice stays owed", async () => {
    const world = new World();
    let bValue = "b";
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => (
        <select aria-label="Choice" name="choice" defaultValue="a">
          <option value="a">A</option>
          <option value={bValue}>B</option>
        </select>
      ),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => {
      selectOf(a.view).value = "b";
      fireEvent.change(selectOf(a.view));
    });
    bValue = "b2";
    await a.rerender();
    // The browser still selects the same option element, which now reads "b2": not what the person chose.
    expect(selectOf(a.view).value).toBe("b2");
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
    bValue = "b";
    await a.rerender();
    expect(selectOf(a.view).value).toBe("b");
    expect(await update(a.registry)).toEqual(["saved", "saved"]);
  });

  test("a multiple select's options reordered: the same selections in another order are not taken for the held sequence (owed); the order back: saved", async () => {
    const world = new World();
    let order = ["a", "b", "c"];
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => (KINDS[1] as Kind).markup(order),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => (KINDS[1] as Kind).chooseB(a.view));
    order = ["b", "a", "c"];
    await a.rerender();
    expect(selectedOf(a.view)).toEqual(["b", "a"]);
    expect(await update(a.registry)).toEqual(["failed"]);
    order = ["a", "b", "c"];
    await a.rerender();
    expect(selectedOf(a.view)).toEqual(["a", "b"]);
    expect(await update(a.registry)).toEqual(["saved", "saved"]);
  });

  test("CONTROL: an option's label changed is no change of shape: no debt", async () => {
    const world = new World();
    let label = "B";
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => (
        <select aria-label="Choice" name="choice" defaultValue="a">
          <option value="a">A</option>
          <option value="b">{label}</option>
        </select>
      ),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => {
      selectOf(a.view).value = "b";
      fireEvent.change(selectOf(a.view));
    });
    label = "Bee";
    await a.rerender();
    expect(await update(a.registry)).toEqual(["saved", "saved"]);
  });

  test("a number typed, then the input becomes a date (React keeps the element): the number is owed, never replaced by the empty date", async () => {
    const world = new World();
    let type = "number";
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => <input aria-label="Choice" name="choice" type={type} />,
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    const field = () => a.view.getByLabelText("Choice") as HTMLInputElement;
    act(() => fireEvent.input(field(), { target: { value: "42" } }));
    type = "date";
    await a.rerender();
    expect(field().value).toBe("");
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
    type = "number";
    await a.rerender();
    expect(field().value).toBe("42");
    expect(await update(a.registry)).toEqual(["saved", "saved"]);
  });

  test("before the form has a database (provisional), B removed is still dirty and cannot be saved", async () => {
    const world = new World();
    let shown = ALL;
    const kind = KINDS[1] as Kind;
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => kind.markup(shown),
      CHOICE,
      null,
    );
    act(() => kind.chooseB(a.view));
    shown = ["a", "c"];
    await a.rerender();
    expect(a.registry.dirty()).toHaveLength(1);
    let saved: SaveResult[] = [];
    await act(async () => {
      saved = await flushDirty(a.registry);
    });
    expect(saved).toEqual(["failed"]);
    shown = ALL;
    await a.rerender();
    expect(selectedOf(a.view)).toEqual(["a", "b"]);
  });

  test("a remount while B is gone keeps it owed; the next mount showing B gets it back", async () => {
    const world = new World();
    const storage = new TabStorage();
    let shown = ALL;
    let mounted = true;
    const kind = KINDS[0] as Kind;
    const a = mountPage(
      world,
      storage,
      "A",
      () => (mounted ? kind.markup(shown) : null),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => kind.chooseB(a.view));
    shown = ["a", "c"];
    await a.rerender();
    mounted = false;
    await a.rerender();
    expect(a.registry.dirty()).toHaveLength(1);
    shown = ALL;
    mounted = true;
    await a.rerender();
    await waitFor(() => expect(selectedOf(a.view)).toEqual(["b"]));
    expect(await update(a.registry)).toEqual(["saved", "saved"]);
  });
});

describe("R17 (Q6): repeated transitions keep every owed value", () => {
  test("B removed (owed), C chosen, C removed (owed too), B shown: B does NOT come back over the later edit; C shown: C comes back; B is still owed", async () => {
    const world = new World();
    let shown: readonly string[] = ["a", "b", "c", "d"];
    const kind = KINDS[0] as Kind;
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => kind.markup(shown),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => kind.chooseB(a.view));
    shown = ["a", "c", "d"];
    await a.rerender();
    act(() => {
      selectOf(a.view).value = "c";
      fireEvent.change(selectOf(a.view));
    });
    shown = ["a", "d"];
    await a.rerender();
    expect(selectedOf(a.view)).toEqual(["a"]);
    shown = ["a", "b", "d"];
    await a.rerender();
    // B was owed before the person chose C: it never comes back over that choice.
    expect(selectedOf(a.view)).toEqual(["a"]);
    shown = ["a", "b", "c", "d"];
    await a.rerender();
    expect(selectedOf(a.view)).toEqual(["c"]);
    // C is shown, B still owed (no second removal replaced the first).
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
    // Choosing B again holds it: nothing is owed any more, and C... is what the person changed from: saved as B.
    act(() => kind.chooseB(a.view));
    expect(await update(a.registry)).toEqual(["saved", "saved"]);
    expect((await rows(world)).map(([, , state]) => state)).toEqual(["b", "b"]);
  });

  test("text typed over twice in fields shown again: BOTH earlier values stay owed (typing the second again settles only it)", () => {
    const element = document.createElement("form");
    document.body.append(element);
    const show = (typed: string) => {
      element.replaceChildren();
      const field = document.createElement("input");
      field.name = "t";
      element.append(field);
      // Typed into the new field before anything noticed it (no observer here): the person's text.
      field.value = typed;
      noteInput(fields, ["t"]);
      sync(fields);
    };
    const hide = () => {
      element.replaceChildren();
      sync(fields);
    };
    const fields = openFields(() => element, [{ name: "t" }]);
    show("x");
    hide();
    show("y");
    hide();
    show("z");
    expect(fields.owed.get("t")?.map((entry) => entry.value)).toEqual([
      "x",
      "y",
    ]);
    (element.elements.namedItem("t") as HTMLInputElement).value = "y";
    noteInput(fields, ["t"]);
    sync(fields);
    expect(fields.owed.get("t")?.map((entry) => entry.value)).toEqual(["x"]);
    expect(hasDebt(fields)).toBe(true);
    element.remove();
  });
});

describe("R17-B (Q5): a restore the form cannot show is never certified", () => {
  /** Page A chooses B, saves P and hands off H; it leaves; its successor A2 shows `shown`. */
  async function successor(shown: readonly string[], kind = KINDS[0] as Kind) {
    const world = new World();
    const storage = new TabStorage();
    const a = mountPage(world, storage, "A", () => kind.markup(ALL), CHOICE);
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => kind.chooseB(a.view));
    expect(await update(a.registry)).toEqual(["saved", "saved"]);
    const before = await rows(world);
    const captures = [
      ...(await world.store.list(FORM_CONTEXT)),
      ...(await world.store.list(handoffContext(FORM_CONTEXT))),
    ].map((copy) => copy.capture);
    a.view.unmount();
    world.locks.leave("A");
    let now = shown;
    const a2 = mountPage(world, storage, "A2", () => kind.markup(now), CHOICE);
    await waitFor(() => expect(a2.handle().ready).toBe(true));
    return {
      world,
      a2,
      before,
      captures,
      show: async (next: readonly string[]) => {
        now = next;
        await a2.rerender();
      },
    };
  }

  for (const kind of KINDS)
    test(`REQUIREMENT ${kind.name}: the successor without B reports the restore incomplete, its save fails, P and H stay exactly; B shown: back, saved, then P removed and H kept exactly`, async () => {
      const { world, a2, before, captures, show } = await successor(
        ["a", "c"],
        kind,
      );
      expect(a2.handle().restored).not.toBeNull();
      expect(a2.handle().incomplete).toEqual(["choice"]);
      expect(a2.registry.dirty()).toHaveLength(1);
      expect(await update(a2.registry)).toEqual(["failed"]);
      expect(await rows(world)).toEqual(before);
      expect(
        [
          ...(await world.store.list(FORM_CONTEXT)),
          ...(await world.store.list(handoffContext(FORM_CONTEXT))),
        ].map((copy) => copy.capture),
      ).toEqual(captures);
      await show(ALL);
      await waitFor(() => expect(kind.state(a2.view)).toEqual(kind.withB));
      expect(await update(a2.registry)).toEqual(["saved", "saved"]);
      const after = await rows(world);
      // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was only A2's own copies left (A's P and H removed);
      // now A's P is removed (exact, authorised clean-up) and A's hand-off H stays exactly beside A2's own copies, all holding B (no page
      // that claims a hand-off may remove it).
      const aHandoff = before.filter(([where]) => where === "handoff");
      const aOrdinary = before.filter(([where]) => where === "ordinary");
      expect(aHandoff).toHaveLength(1);
      expect(aOrdinary).toHaveLength(1);
      for (const row of aHandoff) expect(after).toContainEqual(row);
      for (const [, id] of aOrdinary)
        expect(after.map(([, own]) => own)).not.toContain(id);
      const own = after.filter(
        ([, id]) => !aHandoff.some(([, handed]) => handed === id),
      );
      expect(own.map(([where, , state]) => [where, state])).toEqual([
        ["ordinary", kind.stored],
        ["handoff", kind.stored],
      ]);
      expect(a2.submits()).toBe(0);
    });

  test("CONTROL: the successor showing B restores it completely, and its save removes P (the hand-off H is kept exactly)", async () => {
    const { world, a2, before } = await successor(ALL);
    expect(a2.handle().incomplete).toEqual([]);
    expect(selectedOf(a2.view)).toEqual(["b"]);
    expect(await update(a2.registry)).toEqual(["saved", "saved"]);
    const after = await rows(world);
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was neither P nor H left; now P is removed and H stays
    // exactly (no page that claims a hand-off may remove it).
    for (const [, id] of before.filter(([where]) => where === "ordinary"))
      expect(after.map(([, own]) => own)).not.toContain(id);
    for (const row of before.filter(([where]) => where === "handoff"))
      expect(after).toContainEqual(row);
  });

  test("the person chooses C while B cannot be shown: C is theirs, B stays owed (still not saved, P and H kept)", async () => {
    const { world, a2, before } = await successor(["a", "c"]);
    act(() => {
      selectOf(a2.view).value = "c";
      fireEvent.change(selectOf(a2.view));
    });
    expect(await update(a2.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual(before);
  });

  test("an ordinary copy chosen from the alternatives that the form cannot show answers `incomplete`, never `restored`; the copy stays", async () => {
    const world = new World();
    await world.store.save({
      formContext: FORM_CONTEXT,
      tabInstanceId: "gone-tab",
      values: { choice: "z" },
      savedAt: "2026-10-14T09:00:00.000Z",
    });
    // Mounted after its own edit (the look does not restore over input): the gone tab's copy is offered.
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => (KINDS[0] as Kind).markup(ALL),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    // Restored at once (untouched form): incomplete.
    expect(a.handle().incomplete).toEqual(["choice"]);
    expect(selectedOf(a.view)).toEqual(["a"]);
    expect(await update(a.registry)).toEqual(["failed"]);
    expect((await world.store.list(FORM_CONTEXT)).length).toBe(1);
  });
});

describe("R17 (Q7): submissions and discards with a choice that cannot be shown", () => {
  test("a ticket taken with B; B removed; the submission succeeds: it sent B, which is covered: clean", async () => {
    const world = new World();
    let shown = ALL;
    const kind = KINDS[0] as Kind;
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => kind.markup(shown),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => kind.chooseB(a.view));
    const ticket = a.handle().submitting();
    shown = ["a", "c"];
    await a.rerender();
    expect(a.registry.dirty()).toHaveLength(1);
    await act(async () => {
      await ticket?.succeeded();
    });
    expect(a.registry.dirty()).toHaveLength(0);
  });

  test("CONTROL: the same ticket FAILS: B stays owed (dirty, not saved)", async () => {
    const world = new World();
    let shown = ALL;
    const kind = KINDS[0] as Kind;
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => kind.markup(shown),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => kind.chooseB(a.view));
    const ticket = a.handle().submitting();
    shown = ["a", "c"];
    await a.rerender();
    act(() => ticket?.failed());
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
  });

  test("a ticket taken with B, a NEWER choice C, then C removed: the success covers B only; C stays owed", async () => {
    const world = new World();
    let shown = ALL;
    const kind = KINDS[0] as Kind;
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => kind.markup(shown),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().ready).toBe(true));
    act(() => kind.chooseB(a.view));
    const ticket = a.handle().submitting();
    act(() => {
      selectOf(a.view).value = "c";
      fireEvent.change(selectOf(a.view));
    });
    shown = ["a", "b"];
    await a.rerender();
    let result: unknown;
    await act(async () => {
      result = await ticket?.succeeded();
    });
    expect(result).toBe("kept");
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await update(a.registry)).toEqual(["failed"]);
  });

  test("'Discard instead' when the initial option is gone: the copies are discarded and the form is clean with what it shows (no false reset)", async () => {
    const world = new World();
    await world.store.save({
      formContext: FORM_CONTEXT,
      tabInstanceId: "gone-tab",
      values: { choice: "b" },
      savedAt: "2026-10-14T09:00:00.000Z",
    });
    let shown = ALL;
    const a = mountPage(
      world,
      new TabStorage(),
      "A",
      () => (KINDS[0] as Kind).markup(shown),
      CHOICE,
    );
    await waitFor(() => expect(a.handle().restored).not.toBeNull());
    expect(selectedOf(a.view)).toEqual(["b"]);
    shown = ["b", "c"];
    await a.rerender();
    let discarded: unknown;
    await act(async () => {
      discarded = await a.handle().discard();
    });
    expect(discarded).toBe("discarded");
    // "a" (the initial option) cannot be shown: the field keeps what it shows, and that is what the discard leaves.
    expect(selectedOf(a.view)).toEqual(["b"]);
    expect(a.registry.dirty()).toHaveLength(0);
    expect(await world.store.list(FORM_CONTEXT)).toEqual([]);
  });
});

describe("R17 (Q4): every write is exact, or changes nothing", () => {
  const form = (html: string): HTMLFormElement => {
    const element = document.createElement("form");
    element.innerHTML = html;
    document.body.append(element);
    return element;
  };
  afterEach(() => {
    document.body.innerHTML = "";
  });
  const access = (element: HTMLFormElement, name: string): FieldAccess => {
    const field = fieldOf(element, name);
    if (field === null || field === "sensitive") throw new Error("setup");
    return field;
  };

  test("a single select: an option it does not have is not written (the selection stays, a sibling untouched); one it has is", () => {
    const element = form(`
      <input name="title" value="t">
      <select name="s"><option value="a">A</option><option value="b" selected>B</option><option value="">None</option></select>
    `);
    const s = access(element, "s");
    expect(s.write(encodeText("z"))).toBe(false);
    expect(s.read()).toBe("b");
    expect(
      (element.elements.namedItem("title") as HTMLInputElement).value,
    ).toBe("t");
    // The empty text is an option here: shown exactly.
    expect(s.write(encodeText(""))).toBe(true);
    expect(s.read()).toBe("");
    expect(s.write(encodeText("a"))).toBe(true);
    expect(s.read()).toBe("a");
    const none = access(
      form(`<select name="n"><option value="a">A</option></select>`),
      "n",
    );
    // No option of the empty text: not shown (assigning it would leave no option selected).
    expect(none.write(encodeText(""))).toBe(false);
    expect(none.read()).toBe("a");
  });

  test("a multiple select, radio group and same-named checkboxes: a member they do not have, or another order, changes nothing", () => {
    const element = form(`
      <select name="m" multiple><option value="b" selected>B</option><option value="a">A</option></select>
      <input name="r" type="radio" value="a" checked><input name="r" type="radio" value="b">
      <input name="g" type="checkbox" value="a" checked><input name="g" type="checkbox" value="b">
    `);
    const m = access(element, "m");
    expect(m.write(encodeState({ kind: "multiple", selected: ["z"] }))).toBe(
      false,
    );
    expect(
      m.write(encodeState({ kind: "multiple", selected: ["a", "b"] })),
    ).toBe(false);
    expect(m.read()).toBe(encodeState({ kind: "multiple", selected: ["b"] }));
    expect(
      m.write(encodeState({ kind: "multiple", selected: ["b", "a"] })),
    ).toBe(true);
    const r = access(element, "r");
    expect(r.write(encodeState({ kind: "radio", value: "z" }))).toBe(false);
    expect(r.read()).toBe(encodeState({ kind: "radio", value: "a" }));
    expect(r.write(encodeState({ kind: "radio", value: null }))).toBe(true);
    expect(r.read()).toBe(encodeState({ kind: "radio", value: null }));
    const g = access(element, "g");
    expect(
      g.write(encodeState({ kind: "checkboxes", checked: ["b", "a"] })),
    ).toBe(false);
    expect(g.write(encodeState({ kind: "checkboxes", checked: ["z"] }))).toBe(
      false,
    );
    expect(g.read()).toBe(encodeState({ kind: "checkboxes", checked: ["a"] }));
  });

  test("an input whose type would change the text (number, date, range, colour, a line break) is not written; text it keeps is, even when it is not valid", () => {
    const element = form(`
      <input name="n" type="number" value="5">
      <input name="d" type="date" value="2026-10-14">
      <input name="r" type="range" min="0" max="10" value="5">
      <input name="c" type="color" value="#aabbcc">
      <input name="t" value="kept" pattern="[0-9]+" required>
      <input name="e" type="email" value="">
      <textarea name="x"></textarea>
    `);
    const refused: [string, string, string][] = [
      ["n", "abc", "5"],
      ["d", "not a date", "2026-10-14"],
      ["r", "50", "5"],
      ["c", "red", "#aabbcc"],
      ["t", "two\nlines", "kept"],
    ];
    for (const [name, text, stays] of refused) {
      const field = access(element, name);
      expect(field.write(encodeText(text)), name).toBe(false);
      expect(field.read(), name).toBe(stays);
    }
    const kept: [string, string][] = [
      ["n", "7"],
      ["d", "2026-10-15"],
      ["r", "3"],
      ["t", "letters fail the pattern"],
      ["e", "not-an-email"],
      ["x", "two\nlines"],
    ];
    for (const [name, text] of kept) {
      const field = access(element, name);
      expect(field.write(encodeText(text)), name).toBe(true);
      expect(field.read(), name).toBe(text);
    }
  });

  test("a write the browser does not show exactly is put back: the field reads what it read before, and the write fails", () => {
    const element = form(`<input name="t" value="before">`);
    const control = element.elements.namedItem("t") as HTMLInputElement;
    // This control shows "after" in capitals (its own setter; a copy of it does not): the probe passes, the read-back does not.
    const native = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ) as PropertyDescriptor;
    Object.defineProperty(control, "value", {
      configurable: true,
      get() {
        return native.get?.call(this);
      },
      set(text: string) {
        native.set?.call(this, text === "after" ? "AFTER" : text);
      },
    });
    native.set?.call(control, "before");
    const t = access(element, "t");
    expect(t.write(encodeText("after"))).toBe(false);
    expect(control.value).toBe("before");
    expect(t.write(encodeText("other"))).toBe(true);
    expect(control.value).toBe("other");
  });

  test("a text the input's type would change is never assigned to it at all (it is tried on a copy first): the control is not touched", () => {
    const element = form(`<input name="n" type="number" value="5">`);
    const control = element.elements.namedItem("n") as HTMLInputElement;
    const native = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ) as PropertyDescriptor;
    const assigned: string[] = [];
    Object.defineProperty(control, "value", {
      configurable: true,
      get() {
        return native.get?.call(this);
      },
      set(text: string) {
        assigned.push(text);
        native.set?.call(this, text);
      },
    });
    const n = access(element, "n");
    expect(n.write(encodeText("abc"))).toBe(false);
    expect(assigned).toEqual([]);
    expect(control.value).toBe("5");
    expect(n.write(encodeText("7"))).toBe(true);
    expect(assigned).toEqual(["7"]);
  });

  test("shapes: a label or an unrelated attribute is no change; an option's value, a replaced member, a type or a sanitising attribute is", () => {
    const element = form(`
      <select name="s"><option value="a">A</option><option value="b">B</option></select>
      <input name="r" type="radio" value="a"><input name="r" type="radio" value="b">
      <input name="n" type="range" min="0" max="10">
    `);
    const shape = (name: string) => access(element, name).shape;
    const s = shape("s");
    (element.querySelector('option[value="b"]') as HTMLOptionElement).text =
      "Bee";
    (element.elements.namedItem("s") as HTMLSelectElement).className = "x";
    expect(sameShape(s, shape("s"))).toBe(true);
    (element.querySelector('option[value="b"]') as HTMLOptionElement).value =
      "b2";
    expect(sameShape(s, shape("s"))).toBe(false);
    const r = shape("r");
    const b = element.querySelector('input[name="r"][value="b"]') as Element;
    b.replaceWith(b.cloneNode(false));
    expect(sameShape(r, shape("r"))).toBe(false);
    const n = shape("n");
    (element.elements.namedItem("n") as HTMLInputElement).setAttribute(
      "max",
      "5",
    );
    expect(sameShape(n, shape("n"))).toBe(false);
    const n2 = shape("n");
    (element.elements.namedItem("n") as HTMLInputElement).type = "number";
    expect(sameShape(n2, shape("n"))).toBe(false);
  });
});
