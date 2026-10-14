import { act, cleanup, render, waitFor } from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { handoffContext } from "../../src/lib/form-recovery/handoff";
import type {
  FormRecoveryPort,
  RecoverySnapshot,
  SaveResult,
} from "../../src/lib/form-recovery/port";
import {
  createRecoverableFormRegistry,
  flushDirty,
  type RecoverableFormRegistry,
} from "../../src/lib/form-recovery/registry";
import type { FormSession } from "../../src/lib/form-recovery/session";
import { createRecoveryTab } from "../../src/lib/form-recovery/tab-identity";
import {
  type RecoverableForm,
  type SubmissionTicket,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";
import { World } from "../support/recovery-pages";

/**
 * WEB-14a revision 11 (review of 14 October 2026, R18 `recovery-form-associated-control-boundary`; design assessment of 14 October 2026,
 * C1-C5, I1-I8, Q1-Q8). A control outside the form that belongs to it by its `form` attribute is a member of the form's field (`namedItem`
 * names it, so revision 10 READ it), but revision 10 followed edits and held the form still only inside the form's subtree: what the person
 * typed into such a control was never seen, so removing the control left the form clean (an update reloaded without it), an edit away and
 * back left an older ticket looking current (its copy was discarded), and the control took typing all through an update.
 *
 * Every pair here differs only in where the admitted control is: inside the form (DESCENDANT, the control that passed on revision 10) or
 * beside it, associated by `form="membership"` (SIBLING). Each asserts its native-like preconditions (`.form`, the field's members,
 * containment, the value) and the exact rows, the dirty count and the save results. Over the real hook, session, registry, recovery identity
 * and hand-off store, with the memory store and jsdom (which models association by `form`, `namedItem` by name and id, and an external
 * reset button). Native counterparts: `.agtx/evidence/WEB-14a/revision-11/native/` and the review's unchanged specs.
 */
afterEach(() => {
  cleanup();
  // Controls a case appended outside React (a late member, a password) never outlive it, even when it fails before removing them.
  document.body.replaceChildren();
});

const CONTEXT = "membership";
const FORM_ID = "membership";

type Place = "descendant" | "sibling";
const PLACES: readonly Place[] = ["descendant", "sibling"];

interface Layout {
  inside?: ReactNode;
  outside?: ReactNode;
}

interface Mounted {
  view: ReturnType<typeof render>;
  registry: RecoverableFormRegistry;
  handle: () => RecoverableForm;
  form: () => HTMLFormElement;
  set: (next: () => Layout) => Promise<void>;
  session: () => FormSession;
}

function mountPage(
  world: World,
  page: string,
  initial: () => Layout,
  options: {
    allow?: readonly string[];
    port?: FormRecoveryPort | null;
    registry?: RecoverableFormRegistry;
  } = {},
): Mounted {
  const registry = options.registry ?? createRecoverableFormRegistry();
  let seq = 0;
  const tab = createRecoveryTab({
    uuid: () => `${page}-${++seq}`,
    locks: world.locks.forPage(page),
  });
  const port = options.port === undefined ? world.store : options.port;
  const allow = options.allow ?? ["amount"];
  let layout = initial;
  let handle: RecoverableForm | null = null;
  function Page() {
    const formRef = useRef<HTMLFormElement>(null);
    handle = useRecoverableForm({
      formContext: CONTEXT,
      allow: allow.map((name) => ({ name })),
      formRef,
      port,
      registry,
      tab,
    });
    const { inside, outside } = layout();
    return (
      <>
        <form
          id={FORM_ID}
          ref={formRef}
          aria-label="membership"
          onSubmit={(event) => event.preventDefault()}
        >
          {inside}
        </form>
        {outside}
      </>
    );
  }
  const view = render(<Page />);
  return {
    view,
    registry,
    handle: () => handle as RecoverableForm,
    form: () => document.getElementById(FORM_ID) as HTMLFormElement,
    set: (next) =>
      act(async () => {
        layout = next;
        view.rerender(<Page />);
      }),
    session: () => registry.session(CONTEXT) as unknown as FormSession,
  };
}

/** The admitted text field `amount`, inside the form or beside it (associated by its `form` attribute). */
const amountIn =
  (place: Place, extra: Layout = {}) =>
  (): Layout => {
    const input = (
      <label key="amount">
        Amount
        <input id="amount" name="amount" form={FORM_ID} defaultValue="" />
      </label>
    );
    return place === "descendant"
      ? { inside: [input, extra.inside], outside: extra.outside }
      : { inside: extra.inside, outside: [input, extra.outside] };
  };

const ready = async (page: Mounted): Promise<void> => {
  await waitFor(() => expect(page.handle().ready).toBe(true));
};

/** What the browser names `name` in the form (`form.elements.namedItem`), as elements: the precondition's oracle, never the code under test. */
function named(form: HTMLFormElement, name: string): Element[] {
  const item = form.elements.namedItem(name);
  if (item === null) return [];
  return item instanceof Element
    ? [item]
    : Array.from(item as ArrayLike<Element>);
}

const byId = (id: string) => document.getElementById(id) as HTMLInputElement;

/** The browser's own facts about the control, as the review's native preconditions assert them. */
function preconditions(page: Mounted, id: string, place: Place) {
  const control = byId(id);
  return {
    owner: control.form === page.form(),
    member: named(page.form(), control.name || id).includes(control),
    descendant: page.form().contains(control),
    place,
  };
}

/** The person types `value` (the value, and the input event the browser fires on the control). */
function type(control: HTMLInputElement, value: string): void {
  act(() => {
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A focus change commits an edited field: the change event, the value it already reported. */
function commit(control: HTMLInputElement): void {
  act(() => {
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function flush(registry: RecoverableFormRegistry): Promise<SaveResult[]> {
  let saves: SaveResult[] = [];
  await act(async () => {
    saves = await flushDirty(registry);
  });
  return saves;
}

/** Every live row of the form (ordinary and hand-off), exactly: key, capture and values. */
async function rows(world: World): Promise<unknown[]> {
  const all: RecoverySnapshot[] = [
    ...(await world.store.list(CONTEXT)),
    ...(await world.store.list(handoffContext(CONTEXT))),
  ];
  return all.map((copy) => ({
    id: copy.tabInstanceId,
    capture: copy.capture,
    values: copy.values,
    controls: copy.controls,
  }));
}

// ---- Q1: native input reaches the ledger before a removal ----------------------------------------------------------------------------

describe("R18 (Q1): what the person typed into a member is retained when the member goes", () => {
  for (const place of PLACES)
    test(`${place === "sibling" ? "REQUIREMENT" : "CONTROL"} (${place}): typed UNFINISHED, the control removed before any recovery read: dirty, the save fails, nothing is written`, async () => {
      const world = new World();
      const page = mountPage(world, "A", amountIn(place));
      await ready(page);
      type(byId("amount"), "UNFINISHED");
      expect(preconditions(page, "amount", place)).toEqual({
        owner: true,
        member: true,
        descendant: place === "descendant",
        place,
      });
      // Removed by the page directly (as the review's harness does), with no read of the form in between.
      act(() => byId("amount").remove());
      expect(page.registry.dirty()).toHaveLength(1);
      expect(await flush(page.registry)).toEqual(["failed"]);
      expect(await rows(world)).toEqual([]);
      expect(page.registry.dirty()).toHaveLength(1);
    });

  for (const place of PLACES)
    test(`${place === "sibling" ? "REQUIREMENT" : "CONTROL"} (${place}): the control removed by a handler of the very input event that typed it: retained`, async () => {
      const world = new World();
      const page = mountPage(world, "A", amountIn(place));
      await ready(page);
      const control = byId("amount");
      control.addEventListener("input", () => control.remove(), { once: true });
      type(control, "UNFINISHED");
      expect(document.getElementById("amount")).toBeNull();
      expect(page.registry.dirty()).toHaveLength(1);
      expect(await flush(page.registry)).toEqual(["failed"]);
      expect(await rows(world)).toEqual([]);
    });

  for (const place of PLACES)
    test(`${place} member removed, then a new untouched one shown: the retained text comes back exactly and is saved`, async () => {
      const world = new World();
      const page = mountPage(world, "A", amountIn(place));
      await ready(page);
      type(byId("amount"), "UNFINISHED");
      await page.set(() => ({}));
      expect(document.getElementById("amount")).toBeNull();
      expect(page.registry.dirty()).toHaveLength(1);
      await page.set(amountIn(place));
      expect(byId("amount").value).toBe("UNFINISHED");
      expect(await flush(page.registry)).toEqual(["saved"]);
      expect(await rows(world)).toEqual([
        expect.objectContaining({ values: { amount: "UNFINISHED" } }),
      ]);
    });

  for (const place of PLACES)
    test(`CONTROL (${place}): the member still shown is saved normally, exactly`, async () => {
      const world = new World();
      const page = mountPage(world, "A", amountIn(place));
      await ready(page);
      type(byId("amount"), "KEPT");
      expect(page.registry.dirty()).toHaveLength(1);
      expect(await flush(page.registry)).toEqual(["saved"]);
      expect(await rows(world)).toEqual([
        expect.objectContaining({ values: { amount: "KEPT" } }),
      ]);
      expect(page.registry.dirty()).toHaveLength(0);
    });

  test("a member inserted and typed into in the same task (before any observer delivery) is followed", async () => {
    const world = new World();
    const page = mountPage(world, "A", () => ({}));
    await ready(page);
    act(() => {
      const late = document.createElement("input");
      late.id = "amount";
      late.name = "amount";
      late.setAttribute("form", FORM_ID);
      document.body.append(late);
      late.value = "LATE";
      late.dispatchEvent(new Event("input", { bubbles: true }));
      late.remove();
    });
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
  });
});

// ---- I5: one edit per event --------------------------------------------------------------------------------------------------------

describe("R18 (I5): each event is one edit, whichever paths it takes to the form", () => {
  for (const place of PLACES)
    test(`(${place}) one input event moves the input revision by exactly one`, async () => {
      const world = new World();
      const page = mountPage(world, "A", amountIn(place));
      await ready(page);
      const before = page.session().fields.input;
      type(byId("amount"), "ONE");
      expect(page.session().fields.input).toBe(before + 1);
      type(byId("amount"), "TWO");
      expect(page.session().fields.input).toBe(before + 2);
    });
});

// ---- Q2: tickets and later edits -----------------------------------------------------------------------------------------------------

describe("R18 (Q2): an older submission never acknowledges a later edit of a member", () => {
  for (const place of PLACES)
    test(`${place === "sibling" ? "REQUIREMENT" : "CONTROL"} (${place}): FIRST saved, ticket, SECOND then FIRST typed, the ticket succeeds: kept, the durable copy stays`, async () => {
      const world = new World();
      const page = mountPage(world, "A", amountIn(place));
      await ready(page);
      type(byId("amount"), "FIRST");
      expect(await flush(page.registry)).toEqual(["saved"]);
      const saved = await rows(world);
      let ticket: SubmissionTicket | null = null;
      act(() => {
        ticket = page.handle().submitting();
      });
      type(byId("amount"), "SECOND");
      type(byId("amount"), "FIRST");
      let outcome: unknown = null;
      await act(async () => {
        outcome = await (ticket as unknown as SubmissionTicket).succeeded();
      });
      expect(outcome).toBe("kept");
      const now = await rows(world);
      expect(now).toHaveLength(1);
      expect(now[0]).toEqual(
        expect.objectContaining({ values: { amount: "FIRST" } }),
      );
      expect(saved).toHaveLength(1);
      expect(page.registry.dirty()).toHaveLength(0);
    });

  for (const place of PLACES)
    for (const committed of [false, true])
      test(`CONTROL (${place}): FIRST saved, ticket, ${committed ? "only the focus change committing FIRST" : "no later edit"}: discarded, no copy left`, async () => {
        const world = new World();
        const page = mountPage(world, "A", amountIn(place));
        await ready(page);
        type(byId("amount"), "FIRST");
        expect(await flush(page.registry)).toEqual(["saved"]);
        let ticket: SubmissionTicket | null = null;
        act(() => {
          ticket = page.handle().submitting();
        });
        if (committed) commit(byId("amount"));
        let outcome: unknown = null;
        await act(async () => {
          outcome = await (ticket as unknown as SubmissionTicket).succeeded();
        });
        expect(outcome).toBe("discarded");
        expect(await rows(world)).toEqual([]);
      });
});

// ---- Q3: membership, association and isolation ---------------------------------------------------------------------------------------

describe("R18 (Q3): the field's members wherever they are, and nothing else", () => {
  test("REQUIREMENT: a checkbox group split inside and beside the form: checking the outside (non-first) member is an edit, saved exactly", async () => {
    const world = new World();
    const page = mountPage(
      world,
      "A",
      () => ({
        inside: <input type="checkbox" name="days" value="mon" />,
        outside: (
          <span>
            <input
              id="tue"
              type="checkbox"
              name="days"
              value="tue"
              form={FORM_ID}
            />
          </span>
        ),
      }),
      { allow: ["days"] },
    );
    await ready(page);
    expect(named(page.form(), "days")).toHaveLength(2);
    act(() => {
      byId("tue").checked = true;
      byId("tue").dispatchEvent(new Event("input", { bubbles: true }));
      byId("tue").dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => byId("tue").remove());
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
  });

  test("REQUIREMENT: a member found by its id (no name) is followed as the field it names", async () => {
    const world = new World();
    const page = mountPage(
      world,
      "A",
      () => ({
        outside: (
          <span>
            <input id="nick" form={FORM_ID} defaultValue="" />
          </span>
        ),
      }),
      { allow: ["nick"] },
    );
    await ready(page);
    expect(named(page.form(), "nick")).toEqual([byId("nick")]);
    type(byId("nick"), "ALIAS");
    act(() => byId("nick").remove());
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
  });

  test("a member found by its id: the focus change committing what it already reported is no new edit (an earlier ticket discards)", async () => {
    const world = new World();
    const page = mountPage(
      world,
      "A",
      () => ({
        outside: (
          <span>
            <input id="nick" form={FORM_ID} defaultValue="" />
          </span>
        ),
      }),
      { allow: ["nick"] },
    );
    await ready(page);
    type(byId("nick"), "FIRST");
    expect(await flush(page.registry)).toEqual(["saved"]);
    let ticket: SubmissionTicket | null = null;
    act(() => {
      ticket = page.handle().submitting();
    });
    commit(byId("nick"));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await (ticket as unknown as SubmissionTicket).succeeded();
    });
    expect(outcome).toBe("discarded");
    expect(await rows(world)).toEqual([]);
  });

  test("a control inside the form that belongs to ANOTHER form is not this form's input (never read, no edit)", async () => {
    const world = new World();
    const page = mountPage(world, "A", () => ({
      inside: <input id="foreign" name="amount" form="other" defaultValue="" />,
      outside: <form id="other" />,
    }));
    await ready(page);
    expect(byId("foreign").form?.id).toBe("other");
    expect(named(page.form(), "amount")).toEqual([]);
    const before = page.session().fields.input;
    type(byId("foreign"), "NOT MINE");
    expect(page.session().fields.input).toBe(before);
    expect(page.registry.dirty()).toHaveLength(0);
  });

  test("an unrelated form with a field of the same name: its edits never stamp this form, and its freeze never holds it", async () => {
    const world = new World();
    const page = mountPage(world, "A", () => ({
      outside: (
        <form id="unrelated">
          <input id="theirs" name="amount" defaultValue="" />
        </form>
      ),
    }));
    await ready(page);
    const before = page.session().fields.input;
    type(byId("theirs"), "THEIRS");
    expect(page.session().fields.input).toBe(before);
    expect(page.registry.dirty()).toHaveLength(0);
    const release = page.registry.freeze();
    expect(byId("theirs").hasAttribute("inert")).toBe(false);
    expect(
      (document.getElementById("unrelated") as HTMLElement).hasAttribute(
        "inert",
      ),
    ).toBe(false);
    release();
  });

  test("REQUIREMENT: a typed member reassociated to another form leaves this form owing what it held; the other form's later edits are not this form's", async () => {
    const world = new World();
    const page = mountPage(
      world,
      "A",
      amountIn("sibling", {
        outside: <form id="other" key="other" />,
      }),
    );
    await ready(page);
    type(byId("amount"), "UNFINISHED");
    await act(async () => {
      byId("amount").setAttribute("form", "other");
    });
    expect(byId("amount").form?.id).toBe("other");
    const before = page.session().fields.input;
    type(byId("amount"), "ELSEWHERE");
    expect(page.session().fields.input).toBe(before);
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
  });

  test("REQUIREMENT: the form's id changes away from a typed member's `form` attribute: what it held stays owed", async () => {
    const world = new World();
    const page = mountPage(world, "A", amountIn("sibling"));
    await ready(page);
    type(byId("amount"), "UNFINISHED");
    await act(async () => {
      page.form().id = "renamed";
    });
    expect(byId("amount").form).toBeNull();
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["failed"]);
  });
});

// ---- Q4: resets ---------------------------------------------------------------------------------------------------------------------

describe("R18 (Q4): a reset is the form's own, and resets every member of it", () => {
  test("an external reset button resets the associated member; the reset is the form's edit, and nothing is owed afterwards", async () => {
    const world = new World();
    const page = mountPage(
      world,
      "A",
      amountIn("sibling", {
        outside: (
          <button key="reset" type="reset" form={FORM_ID}>
            Reset
          </button>
        ),
      }),
    );
    await ready(page);
    type(byId("amount"), "TYPED");
    const before = page.session().fields.input;
    await act(async () => {
      (
        document.querySelector("button[type=reset]") as HTMLButtonElement
      ).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(byId("amount").value).toBe("");
    expect(page.session().fields.input).toBeGreaterThan(before);
    expect(page.registry.dirty()).toHaveLength(0);
  });

  test("a cancelled reset keeps what the member shows (still the person's, dirty)", async () => {
    const world = new World();
    const page = mountPage(world, "A", amountIn("sibling"));
    await ready(page);
    type(byId("amount"), "TYPED");
    page.form().addEventListener("reset", (event) => event.preventDefault(), {
      once: true,
    });
    await act(async () => {
      page.form().reset();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(byId("amount").value).toBe("TYPED");
    expect(page.registry.dirty()).toHaveLength(1);
    expect(await flush(page.registry)).toEqual(["saved"]);
    expect(await rows(world)).toEqual([
      expect.objectContaining({ values: { amount: "TYPED" } }),
    ]);
  });

  test("another form's reset is not this form's edit", async () => {
    const world = new World();
    const page = mountPage(
      world,
      "A",
      amountIn("sibling", { outside: <form id="other" key="other" /> }),
    );
    await ready(page);
    const before = page.session().fields.input;
    await act(async () => {
      (document.getElementById("other") as HTMLFormElement).reset();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(page.session().fields.input).toBe(before);
  });
});

// ---- Q5: sensitivity ----------------------------------------------------------------------------------------------------------------

describe("R18 (Q5): a sensitive member outside the form is never read", () => {
  test("an associated password beside the form: its edits are never read (no value read) nor captured; the admitted sibling is saved", async () => {
    const world = new World();
    const page = mountPage(world, "A", amountIn("sibling"), {
      allow: ["amount"],
    });
    await ready(page);
    // Not rendered by React (whose own value tracker reads every input it renders): only the recovery code could read it.
    const pin = document.createElement("input");
    pin.type = "password";
    pin.name = "pin";
    pin.setAttribute("form", FORM_ID);
    document.body.append(pin);
    const native = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ) as PropertyDescriptor;
    let reads = 0;
    Object.defineProperty(pin, "value", {
      configurable: true,
      get() {
        reads += 1;
        return native.get?.call(this);
      },
      set(next: string) {
        native.set?.call(this, next);
      },
    });
    act(() => {
      native.set?.call(pin, "SECRET");
      pin.dispatchEvent(new Event("input", { bubbles: true }));
    });
    type(byId("amount"), "VISIBLE");
    expect(await flush(page.registry)).toEqual(["saved"]);
    expect(reads).toBe(0);
    expect(JSON.stringify(await rows(world))).not.toContain("SECRET");
    expect(await rows(world)).toEqual([
      expect.objectContaining({ values: { amount: "VISIBLE" } }),
    ]);
    pin.remove();
  });
});

describe("R18 (Q5): an ADMITTED field with a sensitive member outside the form", () => {
  test("its edits are edits, but its value is never read nor kept (no change-rule state, no ledger entry)", async () => {
    const world = new World();
    const page = mountPage(world, "A", amountIn("sibling"), {
      allow: ["amount", "pin"],
    });
    await ready(page);
    // Not rendered by React (whose own value tracker reads every input it renders): only the recovery code could read it.
    const pin = document.createElement("input");
    pin.type = "password";
    pin.name = "pin";
    pin.setAttribute("form", FORM_ID);
    document.body.append(pin);
    const native = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ) as PropertyDescriptor;
    native.set?.call(pin, "SECRET");
    let reads = 0;
    Object.defineProperty(pin, "value", {
      configurable: true,
      get() {
        reads += 1;
        return native.get?.call(this);
      },
    });
    const before = page.session().fields.input;
    act(() => {
      pin.dispatchEvent(new Event("input", { bubbles: true }));
      pin.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const fields = page.session().fields;
    expect(fields.input).toBeGreaterThan(before);
    expect(fields.evented.has("pin")).toBe(false);
    expect(fields.ledger.pin).toBeUndefined();
    expect(reads).toBe(0);
  });
});

// ---- Q6: before the form has a session -----------------------------------------------------------------------------------------------

describe("R18 (Q6): the mount's own follower before a port binds it", () => {
  for (const place of PLACES)
    test(`${place === "sibling" ? "REQUIREMENT" : "CONTROL"} (${place}): no port yet, typed then removed: the provisional form is dirty`, async () => {
      const world = new World();
      const page = mountPage(world, "A", amountIn(place), { port: null });
      type(byId("amount"), "UNFINISHED");
      act(() => byId("amount").remove());
      expect(page.registry.dirty()).toHaveLength(1);
    });
});

// ---- Q7: a delayed read never lands over input --------------------------------------------------------------------------------------

describe("R18 (Q7): a copy found by a look that answers late is never restored over a member edited meanwhile", () => {
  for (const edited of [true, false])
    test(`${edited ? "REQUIREMENT: the associated member edited away and back while the look's read is held: nothing restored over it, the copy offered" : "CONTROL: untouched while the read is held: the copy is restored into the member"}`, async () => {
      const world = new World();
      await world.store.save({
        formContext: CONTEXT,
        tabInstanceId: "gone-1",
        values: { amount: "SAVED" },
        savedAt: "2026-10-01T09:00:00.000Z",
      });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const store = world.store;
      const slow: FormRecoveryPort = {
        save: (snapshot) => store.save(snapshot),
        load: (formContext, id) => store.load(formContext, id),
        discard: (formContext, id, capture) =>
          capture === undefined
            ? store.discard(formContext, id)
            : store.discard(formContext, id, capture),
        list: async (formContext) => {
          await gate;
          return store.list(formContext);
        },
      };
      const page = mountPage(world, "A", amountIn("sibling"), { port: slow });
      if (edited) {
        type(byId("amount"), "AWAY");
        type(byId("amount"), "");
      }
      await act(async () => release());
      await ready(page);
      expect(byId("amount").value).toBe(edited ? "" : "SAVED");
      expect(page.handle().restored?.tabInstanceId ?? null).toBe(
        edited ? null : "gone-1",
      );
      expect(
        page.handle().alternatives.map((copy) => copy.tabInstanceId),
      ).toEqual(edited ? ["gone-1"] : []);
    });
});

// ---- Q8: holding the form still -------------------------------------------------------------------------------------------------------

describe("R18 (Q8): a freeze holds every member, and only them", () => {
  test("REQUIREMENT: the associated member is held (inert) with the form, aria-busy on the form only; release restores everything exactly", async () => {
    const world = new World();
    const page = mountPage(world, "A", amountIn("sibling"));
    await ready(page);
    const release = page.registry.freeze();
    expect(page.form().hasAttribute("inert")).toBe(true);
    expect(page.form().getAttribute("aria-busy")).toBe("true");
    expect(byId("amount").hasAttribute("inert")).toBe(true);
    expect(byId("amount").hasAttribute("aria-busy")).toBe(false);
    expect(page.registry.unheld()).toBe(0);
    release();
    expect(page.form().hasAttribute("inert")).toBe(false);
    expect(page.form().hasAttribute("aria-busy")).toBe(false);
    expect(byId("amount").hasAttribute("inert")).toBe(false);
  });

  test("a member's own inert and nested freezes: held until the last release, then exactly as before", async () => {
    const world = new World();
    const page = mountPage(world, "A", amountIn("sibling"));
    await ready(page);
    byId("amount").setAttribute("inert", "");
    const first = page.registry.freeze();
    const second = page.registry.freeze();
    first();
    expect(byId("amount").hasAttribute("inert")).toBe(true);
    expect(page.form().hasAttribute("inert")).toBe(true);
    second();
    expect(page.form().hasAttribute("inert")).toBe(false);
    expect(byId("amount").hasAttribute("inert")).toBe(true);
  });

  test("REQUIREMENT: a member associated while held is held before the registry certifies the hold (same step, no observer needed)", async () => {
    const world = new World();
    const page = mountPage(world, "A", () => ({}));
    await ready(page);
    const release = page.registry.freeze();
    const late = document.createElement("input");
    late.name = "amount";
    late.setAttribute("form", FORM_ID);
    document.body.append(late);
    expect(page.registry.unheld()).toBe(0);
    expect(late.hasAttribute("inert")).toBe(true);
    release();
    expect(late.hasAttribute("inert")).toBe(false);
    late.remove();
  });

  test("REQUIREMENT: a render that takes a member's inert away while held: the form is unheld, never taken for held", async () => {
    const world = new World();
    const page = mountPage(world, "A", amountIn("sibling"));
    await ready(page);
    const release = page.registry.freeze();
    expect(page.registry.unheld()).toBe(0);
    byId("amount").removeAttribute("inert");
    expect(page.registry.unheld()).toBe(1);
    release();
  });

  test("the provisional mount (no port yet) holds its associated member too", async () => {
    const world = new World();
    const page = mountPage(world, "A", amountIn("sibling"), { port: null });
    const release = page.registry.freeze();
    expect(byId("amount").hasAttribute("inert")).toBe(true);
    expect(page.registry.unheld()).toBe(0);
    release();
    expect(byId("amount").hasAttribute("inert")).toBe(false);
  });

  for (const place of PLACES)
    test(`(${place}) a focused member loses focus as the hold starts; its change event only commits the last edit, so an earlier ticket still covers it`, async () => {
      const world = new World();
      const page = mountPage(world, "A", amountIn(place));
      await ready(page);
      const control = byId("amount");
      act(() => control.focus());
      type(control, "FIRST");
      expect(await flush(page.registry)).toEqual(["saved"]);
      let ticket: SubmissionTicket | null = null;
      act(() => {
        ticket = page.handle().submitting();
      });
      const events: string[] = [];
      for (const kind of ["change", "blur"])
        control.addEventListener(kind, () => events.push(kind));
      // jsdom fires no change on blur: the engines do (measured: change, blur, focusout), so it is dispatched as they do.
      control.addEventListener(
        "blur",
        () => control.dispatchEvent(new Event("change", { bubbles: true })),
        { once: true, capture: true },
      );
      const release = page.registry.freeze();
      expect(document.activeElement).not.toBe(control);
      expect(events).toEqual(["change", "blur"]);
      release();
      let outcome: unknown = null;
      await act(async () => {
        outcome = await (ticket as unknown as SubmissionTicket).succeeded();
      });
      expect(outcome).toBe("discarded");
    });
});
