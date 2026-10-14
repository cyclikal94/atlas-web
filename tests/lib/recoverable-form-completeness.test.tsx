import { act, cleanup, render, waitFor } from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { fieldOf, OPAQUE } from "../../src/lib/form-recovery/controls";
import {
  handoffContext,
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
import type { FormSession } from "../../src/lib/form-recovery/session";
import {
  createRecoveryTab,
  type RecoveryTab,
} from "../../src/lib/form-recovery/tab-identity";
import {
  type RecoverableForm,
  type SubmissionTicket,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";
import { TabStorage, World } from "../support/recovery-pages";

/**
 * WEB-14a revision 10 (review of 14 October 2026; design assessment of 14 October 2026, RC1/RC2, I1-I8, C1-C5, Q1-Q11). Two projections were
 * taken for the whole of the person's input:
 *
 *  - R17 (`recovery-control-state-value-projection`, incomplete_fix): a number field showing `1e` has the value "" (`validity.badInput`).
 *    Revision 9 read it as an empty field: with no copy the form looked clean and the update reloaded; with an own copy of `12` the save
 *    took the "clean" path and discarded that copy. Here the native editing state is modelled in jsdom by the element's own `validity`
 *    (`badInput`) with the value the browser gives ("") and the events the browser fires; the native precondition itself is asserted in
 *    Chromium, Firefox and WebKit by `.agtx/evidence/WEB-14a/revision-10/native/native-r10.spec.ts` and the review's own probes.
 *  - R11 (`recovery-remount-field-schema-stale-session`, incomplete_fix): a copy restored into a form that does not admit (or show) one of its
 *    fields kept only the admitted ones: the restore was reported complete, the next save took the clean path and removed the protected
 *    hand-off and its predecessor, and the value never came back.
 *
 * Over the real hook, session, registry, recovery identity and hand-off store, with the memory store and jsdom. Each case asserts the exact
 * rows (key and capture), the dirty count and the save result; nothing is ever submitted unless a ticket says so.
 */
afterEach(cleanup);

const CONTEXT = "completeness";

type Props = {
  allow: readonly string[];
  shown: readonly string[];
  markup: (shown: readonly string[]) => ReactNode;
};

interface Mounted {
  view: ReturnType<typeof render>;
  registry: ReturnType<typeof createRecoverableFormRegistry>;
  tab: RecoveryTab;
  handle: () => RecoverableForm;
  /** Renders with other props, and lets the page's observers run (as a browser does before the next task). */
  set: (next: Partial<Props>) => Promise<void>;
  /** Renders again NOW: nothing else runs before the hook's render reads the fields. */
  rerenderNow: () => void;
  input: (name: string) => HTMLInputElement;
  session: () => FormSession;
}

function mountPage(
  world: World,
  storage: TabStorage,
  page: string,
  initial: Props,
  options: { port?: World["store"] | null; tab?: RecoveryTab } = {},
): Mounted {
  const registry = createRecoverableFormRegistry();
  let seq = 0;
  const tab =
    options.tab ??
    createRecoveryTab({
      uuid: () => `${page}-${++seq}`,
      locks: world.locks.forPage(page),
    });
  const handoffs = storageHandoffs(() => storage as unknown as Storage);
  const port = options.port === undefined ? world.store : options.port;
  let props = initial;
  let handle: RecoverableForm | null = null;
  function Form() {
    const formRef = useRef<HTMLFormElement>(null);
    handle = useRecoverableForm({
      formContext: CONTEXT,
      allow: props.allow.map((name): RecoverableFieldSpec => ({ name })),
      formRef,
      port,
      registry,
      tab,
      handoffs,
    });
    return (
      <form
        ref={formRef}
        aria-label="completeness"
        onSubmit={(event) => event.preventDefault()}
      >
        {props.markup(props.shown)}
      </form>
    );
  }
  const view = render(<Form />);
  return {
    view,
    registry,
    tab,
    handle: () => handle as RecoverableForm,
    set: (next) =>
      act(async () => {
        props = { ...props, ...next };
        view.rerender(<Form />);
      }),
    rerenderNow: () => act(() => view.rerender(<Form />)),
    input: (name) =>
      view.container.querySelector(`[name="${name}"]`) as HTMLInputElement,
    session: () => registry.session(CONTEXT) as unknown as FormSession,
  };
}

const ready = async (page: Mounted): Promise<void> => {
  await waitFor(() => expect(page.handle().ready).toBe(true));
};

async function flush(registry: Mounted["registry"]): Promise<SaveResult[]> {
  let saves: SaveResult[] = [];
  await act(async () => {
    saves = await flushDirty(registry);
  });
  return saves;
}

async function update(registry: Mounted["registry"]): Promise<SaveResult[]> {
  let handed: SaveResult[] = [];
  const saves = await flush(registry);
  await act(async () => {
    handed = await prepareHandoffs(registry);
  });
  return [...saves, ...handed];
}

/** Every live row of the form (ordinary and hand-off), exactly: where, key, capture and values. */
async function rows(world: World): Promise<unknown[]> {
  const all: RecoverySnapshot[] = [
    ...(await world.store.list(CONTEXT)),
    ...(await world.store.list(handoffContext(CONTEXT))),
  ];
  return all.map((copy) => ({
    where: copy.formContext === CONTEXT ? "ordinary" : "handoff",
    id: copy.tabInstanceId,
    capture: copy.capture,
    values: copy.values,
    controls: copy.controls,
  }));
}

/** A browser's native editing state with no value (jsdom has none): the element's own `validity`, as the engine reports it. */
function badInput(input: HTMLInputElement, on: boolean): void {
  Object.defineProperty(input, "validity", {
    configurable: true,
    value: { ...input.validity, badInput: on, valid: !on },
  });
}

/** The person types something the number field cannot give as a value (`1e`): "" and `badInput`, with the input event the browser fires. */
function typeUnfinished(input: HTMLInputElement): void {
  act(() => {
    badInput(input, true);
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The person types (or completes the entry to) `value`: a value, no bad input, the input event. */
function typeValue(input: HTMLInputElement, value: string): void {
  act(() => {
    badInput(input, false);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A script (not the person) sets the field: the native editing state is gone, no event. */
function scriptSets(input: HTMLInputElement, value: string): void {
  act(() => {
    badInput(input, false);
    input.value = value;
  });
}

/** Counts writes of the element's value (the native setter still runs). */
function countWrites(input: HTMLInputElement): () => number {
  const native = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  ) as PropertyDescriptor;
  let writes = 0;
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return native.get?.call(this);
    },
    set(next: string) {
      writes += 1;
      native.set?.call(this, next);
    },
  });
  return () => writes;
}

const numberMarkup = (shown: readonly string[]) => (
  <>
    {shown.includes("amount") ? (
      <label>
        Amount
        <input name="amount" type="number" defaultValue="" />
      </label>
    ) : null}
    <label>
      Title
      <input name="title" defaultValue="" />
    </label>
  </>
);

const number = (world: World, page = "A", port?: World["store"] | null) =>
  mountPage(
    world,
    new TabStorage(),
    page,
    {
      allow: ["amount", "title"],
      shown: ["amount", "title"],
      markup: numberMarkup,
    },
    port === undefined ? {} : { port },
  );

// ---- R17: a native editing state is input, never an empty value ---------------------------------------------------------------------

describe("R17 (Q1): an unfinished number is never taken for an empty one", () => {
  for (const unfinished of [true, false])
    test(`${unfinished ? 'REQUIREMENT: `1e` (bad input, value "")' : "CONTROL: `12`"} in an initially empty number field: ${unfinished ? "dirty, the save fails, nothing is written and the field is never written over" : "dirty, saved exactly"}`, async () => {
      const world = new World();
      const page = number(world);
      await ready(page);
      const amount = page.input("amount");
      if (unfinished) typeUnfinished(amount);
      else typeValue(amount, "12");
      const writes = countWrites(amount);
      expect(page.registry.dirty()).toHaveLength(1);
      expect(await flush(page.registry)).toEqual([
        unfinished ? "failed" : "saved",
      ]);
      const saved = await rows(world);
      if (!unfinished) {
        expect(saved).toHaveLength(1);
        expect((saved[0] as { values: unknown }).values).toEqual({
          amount: "12",
          title: "",
        });
        return;
      }
      expect(saved).toEqual([]);
      expect(page.registry.dirty()).toHaveLength(1);
      expect(writes()).toBe(0);
      expect(amount.validity.badInput).toBe(true);
    });

  for (const unfinished of [true, false])
    test(`${unfinished ? "REQUIREMENT" : "CONTROL"}: an own copy of 12 saved, then the field ${unfinished ? "cleared and `1e` typed: the save fails and the copy (key and capture) is kept" : "cleared (no bad input): the clean path discards the copy"}`, async () => {
      const world = new World();
      const page = number(world);
      await ready(page);
      const amount = page.input("amount");
      typeValue(amount, "12");
      expect(await flush(page.registry)).toEqual(["saved"]);
      const saved = await rows(world);
      typeValue(amount, "");
      if (unfinished) typeUnfinished(amount);
      expect(page.registry.dirty()).toHaveLength(1);
      expect(await flush(page.registry)).toEqual([
        unfinished ? "failed" : "saved",
      ]);
      expect(await rows(world)).toEqual(unfinished ? saved : []);
      expect(page.registry.dirty()).toHaveLength(unfinished ? 1 : 0);
    });

  test("the field is never written over: `write` refuses a native editing state and touches nothing (no value assignment)", async () => {
    const world = new World();
    const page = number(world);
    await ready(page);
    const amount = page.input("amount");
    typeUnfinished(amount);
    const writes = countWrites(amount);
    const field = fieldOf(
      page.view.container.querySelector("form") as HTMLFormElement,
      "amount",
    );
    if (field === null || field === "sensitive") throw new Error("no field");
    expect(field.read()).toBe(OPAQUE);
    expect(field.write("5")).toBe(false);
    expect(field.write("")).toBe(false);
    expect(writes()).toBe(0);
    expect(amount.validity.badInput).toBe(true);
  });
});

describe("R17 (Q3): a native editing state across the field's life", () => {
  for (const opaque of [true, false])
    test(`${opaque ? "REQUIREMENT: already there when the form first reads it (no edit event yet)" : "CONTROL: an empty field at mount"}: ${opaque ? "dirty and unsaved (an untouched count is no proof)" : "clean"}`, async () => {
      const world = new World();
      const page = mountPage(world, new TabStorage(), "A", {
        allow: ["amount"],
        shown: ["amount"],
        markup: () => (
          <input
            name="amount"
            type="number"
            defaultValue=""
            ref={(element) => {
              if (element && opaque) badInput(element, true);
            }}
          />
        ),
      });
      await ready(page);
      expect(page.registry.dirty()).toHaveLength(opaque ? 1 : 0);
      if (opaque) expect(await flush(page.registry)).toEqual(["failed"]);
      expect(await rows(world)).toEqual([]);
    });

  for (const how of ["completes", "clears", "a script sets"] as const)
    test(`${how === "a script sets" ? "REQUIREMENT" : "CONTROL"}: \`1e\` typed, then ${how === "completes" ? "the person completes it (1e5, as the engine gives it): exact, saved" : how === "clears" ? "the person clears it: clean, nothing to save" : "a script sets 7 without an event: what was typed is gone from the page, still owed (dirty, unsaved)"}`, async () => {
      const world = new World();
      const page = number(world);
      await ready(page);
      const amount = page.input("amount");
      typeUnfinished(amount);
      if (how === "completes") typeValue(amount, "1e5");
      else if (how === "clears") typeValue(amount, "");
      else scriptSets(amount, "7");
      if (how === "completes") {
        expect(await flush(page.registry)).toEqual(["saved"]);
        expect(
          (await rows(world)).map((row) => (row as { values: unknown }).values),
        ).toEqual([{ amount: "1e5", title: "" }]);
      } else if (how === "clears") {
        expect(page.registry.dirty()).toHaveLength(0);
        expect(await rows(world)).toEqual([]);
      } else {
        expect(page.registry.dirty()).toHaveLength(1);
        expect(await flush(page.registry)).toEqual(["failed"]);
        expect(await rows(world)).toEqual([]);
        // A later edit of the field does not bring back what was gone: still owed.
        typeValue(amount, "5");
        expect(await flush(page.registry)).toEqual(["failed"]);
      }
    });

  test("a render that reads the fields (before any observer or event) never takes a script's value over the unfinished entry", async () => {
    const world = new World();
    const page = number(world);
    await ready(page);
    const amount = page.input("amount");
    typeUnfinished(amount);
    act(() => {
      badInput(amount, false);
      amount.value = "";
    });
    page.rerenderNow();
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
  });

  test("a form reset ends it (the browser resets after the reset event): clean, as the person asked", async () => {
    const world = new World();
    const page = number(world);
    await ready(page);
    const amount = page.input("amount");
    typeUnfinished(amount);
    const form = page.view.container.querySelector("form") as HTMLFormElement;
    // The event first, then the browser's reset of every field, then the deferred read.
    act(() => {
      form.dispatchEvent(new Event("reset", { bubbles: true }));
      badInput(amount, false);
      amount.value = "";
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(page.registry.dirty()).toHaveLength(0);
  });

  test("a change event that only commits it is no clean state: still dirty", async () => {
    const world = new World();
    const page = number(world);
    await ready(page);
    const amount = page.input("amount");
    typeUnfinished(amount);
    act(() => {
      amount.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
  });

  test("the field removed while unfinished: still owed (dirty, unsaved); shown again (a new, empty element): still owed, the new element never written; 'Discard instead' ends it", async () => {
    const world = new World();
    const page = number(world);
    await ready(page);
    typeUnfinished(page.input("amount"));
    await page.set({ shown: ["title"] });
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
    await page.set({ shown: ["amount", "title"] });
    expect(page.input("amount").value).toBe("");
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
    typeValue(page.input("amount"), "5");
    expect(await flush(page.registry)).toEqual(["failed"]);
    let discarded: unknown;
    await act(async () => {
      discarded = await page.handle().discard();
    });
    expect(discarded).toBe("discarded");
    expect(page.registry.dirty()).toHaveLength(0);
    expect(await rows(world)).toEqual([]);
  });

  test("the field removed while unfinished and shown again; the person types a NEW unfinished entry and completes it: the first one is still owed (one native state never settles another)", async () => {
    const world = new World();
    const page = number(world);
    await ready(page);
    typeUnfinished(page.input("amount"));
    await page.set({ shown: ["title"] });
    await page.set({ shown: ["amount", "title"] });
    typeUnfinished(page.input("amount"));
    typeValue(page.input("amount"), "1e5");
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual([]);
  });

  test("the form mounted again in the page while unfinished (the session's other mount): still owed in the new mount", async () => {
    const world = new World();
    const storage = new TabStorage();
    const tab = createRecoveryTab({
      uuid: () => crypto.randomUUID(),
      locks: world.locks.forPage("A"),
    });
    const props: Props = {
      allow: ["amount", "title"],
      shown: ["amount", "title"],
      markup: numberMarkup,
    };
    const first = mountPage(world, storage, "A", props, { tab });
    await ready(first);
    typeUnfinished(first.input("amount"));
    const registry = first.registry;
    // The same registry (the page's), another mount of the form.
    first.view.unmount();
    let handle: RecoverableForm | null = null;
    function Again() {
      const formRef = useRef<HTMLFormElement>(null);
      handle = useRecoverableForm({
        formContext: CONTEXT,
        allow: [{ name: "amount" }, { name: "title" }],
        formRef,
        port: world.store,
        registry,
        tab,
        handoffs: storageHandoffs(() => storage as unknown as Storage),
      });
      return <form ref={formRef}>{numberMarkup(props.shown)}</form>;
    }
    render(<Again />);
    await waitFor(() => expect(handle?.ready).toBe(true));
    expect(registry.dirty()).toHaveLength(1);
    expect(await flush(registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual([]);
  });

  test("before the form has a database (provisional): dirty, unsaved; the coordinator's discard covers it (clean afterwards)", async () => {
    const world = new World();
    const page = number(world, "A", null);
    await waitFor(() => expect(page.registry.dirty()).toHaveLength(0));
    typeUnfinished(page.input("amount"));
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
    const [handle] = page.registry.dirty();
    expect(await handle?.discard?.()).toBe("discarded");
    expect(page.registry.dirty()).toHaveLength(0);
  });

  test("'Discard and reload anyway' (the coordinator's discard of the session) covers it: discarded, nothing can come back", async () => {
    const world = new World();
    const page = number(world);
    await ready(page);
    typeUnfinished(page.input("amount"));
    const [handle] = page.registry.dirty();
    let result: unknown;
    await act(async () => {
      result = await handle?.discard?.();
    });
    expect(result).toBe("discarded");
    expect(handle?.discarded?.()).toBe(true);
    expect(page.registry.dirty()).toHaveLength(0);
  });
});

describe("R17 (Q8): submissions cover only the occurrence they sent", () => {
  async function sentUnfinished(world: World) {
    const page = number(world);
    await ready(page);
    typeUnfinished(page.input("amount"));
    let ticket: SubmissionTicket | null = null;
    act(() => {
      ticket = page.handle().submitting();
    });
    return { page, ticket: ticket as unknown as SubmissionTicket };
  }

  test("sent while unfinished; it succeeds: covered (clean); a NEW unfinished entry typed afterwards is dirty again", async () => {
    const world = new World();
    const { page, ticket } = await sentUnfinished(world);
    await act(async () => {
      await ticket.succeeded();
    });
    expect(page.registry.dirty()).toHaveLength(0);
    typeValue(page.input("amount"), "");
    typeUnfinished(page.input("amount"));
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
  });

  test("the same submission FAILS: still dirty, unsaved (it covered nothing)", async () => {
    const world = new World();
    const { page, ticket } = await sentUnfinished(world);
    act(() => ticket.failed());
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
  });
});

describe("R17 (Q2): a value that is merely invalid is still a value", () => {
  test("an e-mail address with a typo, a number out of range and an empty required field are captured exactly", async () => {
    const world = new World();
    const page = mountPage(world, new TabStorage(), "A", {
      allow: ["email", "count", "need"],
      shown: [],
      markup: () => (
        <>
          <input name="email" type="email" defaultValue="" />
          <input name="count" type="number" max="10" defaultValue="" />
          <input name="need" required defaultValue="" />
        </>
      ),
    });
    await ready(page);
    typeValue(page.input("email"), "not an address");
    typeValue(page.input("count"), "999");
    expect(await flush(page.registry)).toEqual(["saved"]);
    expect(
      (await rows(world)).map((row) => (row as { values: unknown }).values),
    ).toEqual([{ email: "not an address", count: "999", need: "" }]);
  });
});

// ---- R11: every value of a restored copy is the form's, whatever it admits -------------------------------------------------------------

const choiceMarkup = (shown: readonly string[]) => (
  <>
    {shown.includes("title") ? (
      <input aria-label="Title" name="title" defaultValue="" />
    ) : null}
    {shown.includes("choice") ? (
      <input aria-label="Choice" name="choice" defaultValue="" />
    ) : null}
  </>
);

const FULL: Props = {
  allow: ["title", "choice"],
  shown: ["title", "choice"],
  markup: choiceMarkup,
};

/** Page A of a tab types `values`, saves, writes its hand-off and goes (an update reload). Its rows. */
async function updatedFrom(
  world: World,
  storage: TabStorage,
  values: Record<string, string>,
  props: Props = FULL,
): Promise<unknown[]> {
  const a = mountPage(world, storage, "A", props);
  await ready(a);
  for (const [name, value] of Object.entries(values))
    typeValue(a.input(name), value);
  expect(await update(a.registry)).toEqual(["saved", "saved"]);
  a.view.unmount();
  world.locks.leave("A");
  return rows(world);
}

describe("R11 (Q4): a successor that does not admit a saved field keeps the protected copies", () => {
  for (const admitted of [false, true])
    test(`${admitted ? "CONTROL: the successor admits it: restored completely, saved, A's copies removed" : "REQUIREMENT: the successor admits nothing: incomplete, the save fails, P and H (key and capture) and the reference stay; admitted and shown again, the value comes back and is saved"}`, async () => {
      const world = new World();
      const storage = new TabStorage();
      const before = await updatedFrom(world, storage, {
        choice: "UNFINISHED",
      });
      expect(before).toHaveLength(2);
      const reference = [...storage.items];
      const b = mountPage(
        world,
        storage,
        "A2",
        admitted ? FULL : { ...FULL, allow: [], shown: [] },
      );
      await ready(b);
      expect(b.handle().restored).not.toBeNull();
      if (admitted) {
        expect(b.handle().incomplete).toEqual([]);
        expect(await flush(b.registry)).toEqual(["saved"]);
        const after = await rows(world);
        expect(after).toHaveLength(1);
        expect((after[0] as { values: unknown }).values).toEqual({
          choice: "UNFINISHED",
          title: "",
        });
        return;
      }
      expect(b.handle().incomplete).toEqual(["choice", "title"]);
      expect(b.registry.dirty()).toHaveLength(1);
      expect(await flush(b.registry)).toEqual(["failed"]);
      expect(await rows(world)).toEqual(before);
      expect([...storage.items]).toEqual(reference);
      await b.set({ allow: FULL.allow, shown: FULL.shown });
      expect(b.input("choice").value).toBe("UNFINISHED");
      expect(b.handle().incomplete).toEqual([]);
      expect(await flush(b.registry)).toEqual(["saved"]);
      const after = await rows(world);
      expect(after).toHaveLength(1);
      expect((after[0] as { values: unknown }).values).toEqual({
        choice: "UNFINISHED",
        title: "",
      });
    });

  test("partial admission: the admitted field is restored, the other is incomplete; the save fails until it is shown, then both are saved and A's copies removed", async () => {
    const world = new World();
    const storage = new TabStorage();
    const before = await updatedFrom(world, storage, {
      title: "KEPT",
      choice: "UNFINISHED",
    });
    const b = mountPage(world, storage, "A2", {
      ...FULL,
      allow: ["title"],
      shown: ["title"],
    });
    await ready(b);
    expect(b.input("title").value).toBe("KEPT");
    expect(b.handle().incomplete).toEqual(["choice"]);
    expect(await flush(b.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual(before);
    await b.set({ allow: FULL.allow, shown: FULL.shown });
    expect(b.input("choice").value).toBe("UNFINISHED");
    expect(await flush(b.registry)).toEqual(["saved"]);
    expect(
      (await rows(world)).map((row) => (row as { values: unknown }).values),
    ).toEqual([{ title: "KEPT", choice: "UNFINISHED" }]);
  });
});

describe("R11 (Q5): every entry of the copy is accounted for, empty ones and choices included, without reading what is not admitted", () => {
  test("an EMPTY saved value of a field the successor never showed is not taken for its default: incomplete, the save fails", async () => {
    const world = new World();
    const storage = new TabStorage();
    const before = await updatedFrom(world, storage, { title: "T" });
    const b = mountPage(world, storage, "A2", {
      ...FULL,
      allow: ["title"],
      shown: ["title"],
    });
    await ready(b);
    expect(b.handle().incomplete).toEqual(["choice"]);
    expect(await flush(b.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual(before);
  });

  test("an unchecked checkbox and an empty multiple select saved, not admitted by the successor: incomplete, kept", async () => {
    const world = new World();
    const storage = new TabStorage();
    const markup = (shown: readonly string[]) => (
      <>
        <input aria-label="Title" name="title" defaultValue="" />
        {shown.includes("pinned") ? (
          <input name="pinned" type="checkbox" value="yes" />
        ) : null}
        {shown.includes("tags") ? (
          <select name="tags" multiple defaultValue={[]}>
            <option value="home">Home</option>
          </select>
        ) : null}
      </>
    );
    const props: Props = {
      allow: ["title", "pinned", "tags"],
      shown: ["title", "pinned", "tags"],
      markup,
    };
    const before = await updatedFrom(world, storage, { title: "T" }, props);
    const b = mountPage(world, storage, "A2", {
      ...props,
      allow: ["title"],
      shown: ["title"],
    });
    await ready(b);
    expect([...b.handle().incomplete].sort()).toEqual(["pinned", "tags"]);
    expect(await flush(b.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual(before);
    await b.set({ allow: props.allow, shown: props.shown });
    expect(b.handle().incomplete).toEqual([]);
    expect(await flush(b.registry)).toEqual(["saved"]);
  });

  test("a field ON THE PAGE but not admitted is never read or written; a field admitted but not shown is retained the same way", async () => {
    const world = new World();
    const storage = new TabStorage();
    await updatedFrom(world, storage, { title: "T", choice: "UNFINISHED" });
    let reads = 0;
    let writes = 0;
    const b = mountPage(world, storage, "A2", {
      allow: ["choice"],
      shown: ["choice"],
      markup: () => (
        <input
          aria-label="Title"
          name="title"
          defaultValue=""
          ref={(element) => {
            if (!element || Object.hasOwn(element, "value")) return;
            const native = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value",
            ) as PropertyDescriptor;
            Object.defineProperty(element, "value", {
              configurable: true,
              get() {
                reads += 1;
                return native.get?.call(this);
              },
              set(next: string) {
                writes += 1;
                native.set?.call(this, next);
              },
            });
          }}
        />
      ),
    });
    await ready(b);
    // `choice` admitted but not on the page, `title` on the page but not admitted: both incomplete, neither touched.
    expect([...b.handle().incomplete].sort()).toEqual(["choice", "title"]);
    expect(await flush(b.registry)).toEqual(["failed"]);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(b.input("title").value).toBe("");
  });

  test("a field that is SENSITIVE in the successor is never written with the saved value, nor captured: retained, incomplete", async () => {
    const world = new World();
    const storage = new TabStorage();
    const before = await updatedFrom(world, storage, {
      title: "T",
      choice: "UNFINISHED",
    });
    const b = mountPage(world, storage, "A2", {
      ...FULL,
      markup: () => (
        <>
          <input aria-label="Title" name="title" defaultValue="" />
          <input
            aria-label="Choice"
            name="choice"
            defaultValue=""
            data-atlas-sensitive=""
          />
        </>
      ),
    });
    await ready(b);
    expect(b.input("choice").value).toBe("");
    expect(b.handle().incomplete).toEqual(["choice"]);
    expect(await flush(b.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual(before);
  });
});

describe("R11 (Q6): every reader of a copy accounts for what it does not show", () => {
  test("this page's OWN copy read again by a later mount with a narrower schema: incomplete, the own copy is never replaced", async () => {
    const world = new World();
    const storage = new TabStorage();
    const tab = createRecoveryTab({
      uuid: () => "A-own",
      locks: world.locks.forPage("A"),
    });
    const a = mountPage(world, storage, "A", FULL, { tab });
    await ready(a);
    typeValue(a.input("choice"), "UNFINISHED");
    expect(await flush(a.registry)).toEqual(["saved"]);
    const before = await rows(world);
    a.view.unmount();
    // The same page (its identity and lock), another registry: the form's session has gone; its own copy is what it reads.
    const b = mountPage(
      world,
      storage,
      "A",
      { ...FULL, allow: ["title"], shown: ["title"] },
      { tab },
    );
    await ready(b);
    expect(b.handle().restored?.tabInstanceId).toBe("A-own");
    expect(b.handle().incomplete).toEqual(["choice"]);
    typeValue(b.input("title"), "MORE");
    expect(await flush(b.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual(before);
  });

  test("a closed tab's ORDINARY copy: incomplete, the save fails, the copy stays", async () => {
    const world = new World();
    const a = mountPage(world, new TabStorage(), "A", FULL);
    await ready(a);
    typeValue(a.input("choice"), "UNFINISHED");
    expect(await flush(a.registry)).toEqual(["saved"]);
    a.view.unmount();
    world.locks.leave("A");
    const before = await rows(world);
    const b = mountPage(world, new TabStorage(), "B", {
      ...FULL,
      allow: [],
      shown: [],
    });
    await ready(b);
    expect(b.handle().restored).not.toBeNull();
    expect(b.handle().incomplete).toEqual(["choice", "title"]);
    expect(await flush(b.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual(before);
  });

  test("an ordinary copy CHOSEN from the alternatives: `incomplete`, never `restored`; neither the chosen copy nor the first restored one is removed", async () => {
    const world = new World();
    // Two tabs open at once (neither restores the other's copy), then both go.
    const writers: [string, Mounted][] = [];
    for (const [page, text] of [
      ["A", "OLDER"],
      ["C", "NEWER"],
    ] as const) {
      const p = mountPage(world, new TabStorage(), page, FULL);
      await ready(p);
      typeValue(p.input("choice"), text);
      expect(await flush(p.registry)).toEqual(["saved"]);
      writers.push([page, p]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (const [page, p] of writers) {
      p.view.unmount();
      world.locks.leave(page);
    }
    expect(await rows(world)).toHaveLength(2);
    const before = await rows(world);
    const b = mountPage(world, new TabStorage(), "B", {
      ...FULL,
      allow: ["title"],
      shown: ["title"],
    });
    await ready(b);
    expect(b.handle().incomplete).toEqual(["choice"]);
    const older = b.handle().alternatives[0] as RecoverySnapshot;
    let result: unknown;
    await act(async () => {
      result = await b.handle().restoreAlternative(older.tabInstanceId);
    });
    expect(result).toBe("incomplete");
    expect(b.handle().incomplete).toEqual(["choice"]);
    // The session keeps everything the chosen copy holds, never what the form shows of it.
    expect(b.session().persisted.source?.values).toEqual({
      choice: "OLDER",
      title: "",
    });
    expect(await flush(b.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual(before);
    // Shown: the CHOSEN copy's value comes back; its save removes only the chosen copy (the other stays, offered).
    await b.set({ allow: FULL.allow, shown: FULL.shown });
    expect(b.input("choice").value).toBe("OLDER");
    expect(await flush(b.registry)).toEqual(["saved"]);
    const after = await rows(world);
    expect(
      after.map(
        (row) => (row as { values: { choice?: string } }).values.choice,
      ),
    ).toContain("NEWER");
    expect(after.map((row) => (row as { id: string }).id)).not.toContain(
      older.tabInstanceId,
    );
  });

  test("an ABANDONED hand-off chosen: `incomplete`; it is never removed by this page, not even after the value is shown and saved", async () => {
    const world = new World();
    // A's tab writes its hand-off and goes; the reference is in A's tab storage only, so B (another tab) finds it abandoned.
    await updatedFrom(world, new TabStorage(), { choice: "UNFINISHED" });
    const handoff = (await world.store.list(handoffContext(CONTEXT)))[0];
    const b = mountPage(world, new TabStorage(), "B", {
      ...FULL,
      allow: ["title"],
      shown: ["title"],
    });
    await ready(b);
    const offered = b
      .handle()
      .alternatives.find(
        (copy) => copy.tabInstanceId === handoff?.tabInstanceId,
      );
    expect(offered).toBeDefined();
    let result: unknown;
    await act(async () => {
      result = await b
        .handle()
        .restoreAlternative(offered?.tabInstanceId as string);
    });
    expect(result).toBe("incomplete");
    expect(await flush(b.registry)).toEqual(["failed"]);
    await b.set({ allow: FULL.allow, shown: FULL.shown });
    expect(b.input("choice").value).toBe("UNFINISHED");
    expect(await flush(b.registry)).toEqual(["saved"]);
    expect(
      (await world.store.list(handoffContext(CONTEXT))).map(
        (copy) => copy.tabInstanceId,
      ),
    ).toEqual([handoff?.tabInstanceId]);
  });
});

describe("R11 (Q7): shown again, edited, or fully adopted", () => {
  test("the field comes back already holding the person's newer text: theirs stays visible, the saved value stays owed (incomplete, unsaved)", async () => {
    const world = new World();
    const storage = new TabStorage();
    const before = await updatedFrom(world, storage, { choice: "UNFINISHED" });
    const b = mountPage(world, storage, "A2", {
      ...FULL,
      allow: ["title"],
      shown: ["title"],
    });
    await ready(b);
    await b.set({
      allow: FULL.allow,
      shown: FULL.shown,
      markup: (shown) => (
        <>
          <input aria-label="Title" name="title" defaultValue="" />
          {shown.includes("choice") ? (
            <input
              aria-label="Choice"
              name="choice"
              defaultValue=""
              ref={(element) => {
                if (element && element.dataset.typed !== "1") {
                  element.dataset.typed = "1";
                  element.value = "LATER";
                }
              }}
            />
          ) : null}
        </>
      ),
    });
    expect(b.input("choice").value).toBe("LATER");
    expect(b.handle().incomplete).toEqual(["choice"]);
    expect(await flush(b.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual(before);
  });

  test("CONTROL: fully adopted, then edited: the edit is the person's progress; saved, and A's copies removed", async () => {
    const world = new World();
    const storage = new TabStorage();
    await updatedFrom(world, storage, { choice: "UNFINISHED" });
    const b = mountPage(world, storage, "A2", FULL);
    await ready(b);
    typeValue(b.input("choice"), "EDITED");
    expect(await flush(b.registry)).toEqual(["saved"]);
    expect(
      (await rows(world)).map((row) => (row as { values: unknown }).values),
    ).toEqual([{ choice: "EDITED", title: "" }]);
  });
});

describe("R11 (Q8): only a terminal act resolves what is not shown", () => {
  for (const outcome of ["succeeds", "fails"] as const)
    test(`a ticket taken with the saved value not shown; the submission ${outcome}: ${outcome === "succeeds" ? "it covered it (the state it saved): clean, P and H removed" : "still incomplete and unsaved, P and H kept"}`, async () => {
      const world = new World();
      const storage = new TabStorage();
      const before = await updatedFrom(world, storage, {
        choice: "UNFINISHED",
      });
      const b = mountPage(world, storage, "A2", {
        ...FULL,
        allow: ["title"],
        shown: ["title"],
      });
      await ready(b);
      let ticket: SubmissionTicket | null = null;
      act(() => {
        ticket = b.handle().submitting();
      });
      const sent = ticket as unknown as SubmissionTicket;
      if (outcome === "succeeds")
        await act(async () => {
          expect(await sent.succeeded()).toBe("discarded");
        });
      else act(() => sent.failed());
      if (outcome === "succeeds") {
        expect(b.registry.dirty()).toHaveLength(0);
        expect(await rows(world)).toEqual([]);
        return;
      }
      expect(await flush(b.registry)).toEqual(["failed"]);
      expect(await rows(world)).toEqual(before);
    });

  test("'Discard instead' resolves it; when the clean-up of P and H fails, a later save still cleans them up (the act resolved what they held)", async () => {
    const world = new World();
    const storage = new TabStorage();
    await updatedFrom(world, storage, { choice: "UNFINISHED" });
    const b = mountPage(world, storage, "A2", {
      ...FULL,
      allow: ["title"],
      shown: ["title"],
    });
    await ready(b);
    world.store.failDiscardOf = () => true;
    let result: unknown;
    await act(async () => {
      result = await b.handle().discard();
    });
    expect(result).toBe("failed");
    world.store.failDiscardOf = () => false;
    typeValue(b.input("title"), "NEW");
    expect(await flush(b.registry)).toEqual(["saved"]);
    expect(
      (await rows(world)).map((row) => (row as { values: unknown }).values),
    ).toEqual([{ title: "NEW" }]);
  });
});

describe("R11 (C4): a save accounts for the copy positively, at its destructive step", () => {
  for (const consistent of [false, true])
    test(`${consistent ? "CONTROL: the copy's other field shown and admitted again: accounted for, saved, A's copies removed" : "REQUIREMENT: the form holds NO value for one of the copy's fields (no debt to see): the save neither replaces nor cleans up the copy"}`, async () => {
      const world = new World();
      const storage = new TabStorage();
      const before = await updatedFrom(world, storage, {
        title: "T",
        choice: "UNFINISHED",
      });
      const b = mountPage(world, storage, "A2", {
        ...FULL,
        allow: ["title"],
        shown: ["title"],
      });
      await ready(b);
      const session = b.session();
      expect(session.persisted.source?.values).toEqual({
        title: "T",
        choice: "UNFINISHED",
      });
      if (consistent) await b.set({ allow: FULL.allow, shown: FULL.shown });
      else {
        // What a projection would have left: the copy's other field in no ledger at all.
        delete session.fields.ledger.choice;
        session.fields.owed.delete("choice");
      }
      typeValue(b.input("title"), "T2");
      expect(await flush(b.registry)).toEqual([
        consistent ? "saved" : "failed",
      ]);
      if (!consistent) {
        expect(await rows(world)).toEqual(before);
        return;
      }
      expect(
        (await rows(world)).map((row) => (row as { values: unknown }).values),
      ).toEqual([{ title: "T2", choice: "UNFINISHED" }]);
    });

  for (const consistent of [false, true])
    test(`${consistent ? "CONTROL" : "REQUIREMENT"}: this page's OWN copy read again with a narrower schema; ${consistent ? "the field shown again: saved over the own copy, with it" : "the form holds no value for one of its fields (no debt to see): the save never overwrites the own copy"}`, async () => {
      const world = new World();
      const storage = new TabStorage();
      const tab = createRecoveryTab({
        uuid: () => "A-own",
        locks: world.locks.forPage("A"),
      });
      const a = mountPage(world, storage, "A", FULL, { tab });
      await ready(a);
      typeValue(a.input("choice"), "UNFINISHED");
      expect(await flush(a.registry)).toEqual(["saved"]);
      const before = await rows(world);
      a.view.unmount();
      const b = mountPage(
        world,
        storage,
        "A",
        { ...FULL, allow: ["title"], shown: ["title"] },
        { tab },
      );
      await ready(b);
      const session = b.session();
      expect(session.persisted.own?.values).toEqual({
        choice: "UNFINISHED",
        title: "",
      });
      if (consistent) await b.set({ allow: FULL.allow, shown: FULL.shown });
      else {
        delete session.fields.ledger.choice;
        session.fields.owed.delete("choice");
      }
      typeValue(b.input("title"), "MORE");
      expect(await flush(b.registry)).toEqual([
        consistent ? "saved" : "failed",
      ]);
      if (!consistent) {
        expect(await rows(world)).toEqual(before);
        return;
      }
      expect(
        (await rows(world)).map((row) => (row as { values: unknown }).values),
      ).toEqual([{ title: "MORE", choice: "UNFINISHED" }]);
    });

  test("'Discard instead' with an own copy holding a field now hidden, whose clean-up fails: a later save is not refused (the act resolved the own copy's values)", async () => {
    const world = new World();
    const page = mountPage(world, new TabStorage(), "A", FULL);
    await ready(page);
    typeValue(page.input("choice"), "UNFINISHED");
    expect(await flush(page.registry)).toEqual(["saved"]);
    await page.set({ allow: ["title"], shown: ["title"] });
    expect(await flush(page.registry)).toEqual(["failed"]);
    world.store.failDiscardOf = () => true;
    let result: unknown;
    await act(async () => {
      result = await page.handle().discard();
    });
    expect(result).toBe("failed");
    world.store.failDiscardOf = () => false;
    typeValue(page.input("title"), "NEW");
    expect(await flush(page.registry)).toEqual(["saved"]);
    expect(
      (await rows(world)).map((row) => (row as { values: unknown }).values),
    ).toEqual([{ title: "NEW" }]);
  });

  test("Q9: a save asked for BEFORE another copy is chosen, landing after it, never cleans up or forgets the copy chosen later", async () => {
    const world = new World();
    const writers: [string, Mounted][] = [];
    for (const [page, text] of [
      ["A", "OLDER"],
      ["C", "NEWER"],
    ] as const) {
      const p = mountPage(world, new TabStorage(), page, FULL);
      await ready(p);
      typeValue(p.input("choice"), text);
      expect(await flush(p.registry)).toEqual(["saved"]);
      writers.push([page, p]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (const [page, p] of writers) {
      p.view.unmount();
      world.locks.leave(page);
    }
    // B's port holds its first write until released.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    const port = Object.create(world.store) as World["store"];
    port.save = async (snapshot) => {
      if (holding) {
        holding = false;
        await held;
      }
      return world.store.save(snapshot);
    };
    const b = mountPage(world, new TabStorage(), "B", FULL, { port });
    await ready(b);
    const newer = b.handle().restored as RecoverySnapshot;
    const older = b.handle().alternatives[0] as RecoverySnapshot;
    typeValue(b.input("title"), "EDIT");
    let saving: Promise<SaveResult[]> = Promise.resolve([]);
    act(() => {
      saving = flushDirty(b.registry);
    });
    let chosen: unknown;
    await act(async () => {
      chosen = await b.handle().restoreAlternative(older.tabInstanceId);
    });
    expect(chosen).toBe("restored");
    release();
    await act(async () => {
      await saving;
    });
    // The chosen copy is still this page's source (it is cleaned up only by a save taken after it), and still stored.
    expect(b.session().persisted.source?.id).toBe(older.tabInstanceId);
    expect(
      (await rows(world)).map((row) => (row as { id: string }).id),
    ).toContain(older.tabInstanceId);
    expect(newer.tabInstanceId).not.toBe(older.tabInstanceId);
  });

  test("the clean path too: everything shown back at its start, the copy's other field held nowhere: nothing is discarded", async () => {
    const world = new World();
    const storage = new TabStorage();
    const before = await updatedFrom(world, storage, { choice: "UNFINISHED" });
    const b = mountPage(world, storage, "A2", {
      ...FULL,
      allow: ["title"],
      shown: ["title"],
    });
    await ready(b);
    const session = b.session();
    delete session.fields.ledger.choice;
    expect(await flush(b.registry)).toEqual(["failed"]);
    expect(await rows(world)).toEqual(before);
  });
});
