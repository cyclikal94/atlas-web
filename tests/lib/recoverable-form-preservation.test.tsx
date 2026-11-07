import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
import type {
  FormRecoveryPort,
  RecoverableFieldSpec,
  RecoverySnapshot,
  SaveResult,
} from "../../src/lib/form-recovery/port";
import {
  createRecoverableFormRegistry,
  flushDirty,
  type RecoverableFormRegistry,
} from "../../src/lib/form-recovery/registry";
import {
  createRecoveryTab,
  type RecoveryTab,
} from "../../src/lib/form-recovery/tab-identity";
import {
  type RecoverableForm,
  type SubmissionTicket,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";
import {
  ACTIVATION_FALLBACK_MS,
  FLUSH_START_GRACE_MS,
} from "../../src/lib/pwa/coordinator";
import { FakeOrigin } from "../pwa/coordinator-world";

/**
 * WEB-14a revision 4: what a form must keep until it is covered (review of 11 October 2026, R3 `update-reload-after-capture-edit` and R11
 * `recovery-remount-field-schema-stale-session`; design assessment of 11 October 2026, invariants 1-10, C1-C5 and the qualification matrix
 * Q1-Q12; PRODUCT-DECISIONS-20261011 item 2). Each case forces its schedule with explicit gates (held tickets, deferred identity grants, held
 * port calls, committed renders), never with time, and asserts the decisive public outcome: the registry's dirty and pending forms, the
 * rows in the store, and what the next page (a new registry and identity over the same store) shows. FIXTURE evidence over the memory
 * adapter; the real store, Web Locks, worker generations and the coordinator in three engines are the `fixture.pwa-forms.spec.ts`
 * revision-4 cases.
 */
const A = "task-edit:/tasks/41";
const TITLE: readonly RecoverableFieldSpec[] = [{ name: "title" }];
const BOTH: readonly RecoverableFieldSpec[] = [
  { name: "title" },
  { name: "notes" },
];
const NONE: readonly RecoverableFieldSpec[] = [];

/** The memory adapter, counting the saves that reach it (a rerender must write nothing). */
class CountingAdapter extends MemoryRecoveryAdapter {
  saveCount = 0;
  override async save(snapshot: RecoverySnapshot): Promise<SaveResult> {
    this.saveCount += 1;
    return super.save(snapshot);
  }
}

let handle: RecoverableForm | null = null;
const current = (): RecoverableForm | null => handle;
type Props = {
  port: FormRecoveryPort | null;
  registry: RecoverableFormRegistry;
  tab: RecoveryTab;
  allow?: readonly RecoverableFieldSpec[];
  /** Whether the notes field is on the page (a conditional field). */
  notes?: boolean;
  /** The title's default value (an edit form starts from the stored value). */
  titleDefault?: string;
};
function Form({
  allow = TITLE,
  notes = true,
  titleDefault = "",
  ...props
}: Props) {
  const ref = useRef<HTMLFormElement>(null);
  handle = useRecoverableForm({
    formContext: A,
    allow,
    formRef: ref,
    ...props,
  });
  return (
    <form ref={ref} aria-label="Task">
      <input name="title" aria-label="Title" defaultValue={titleDefault} />
      {notes ? (
        <textarea name="notes" aria-label="Notes" defaultValue="" />
      ) : null}
    </form>
  );
}

/** A form whose notes field is shown by a CHILD that owns the switch: hiding it does not render the hook's component again. */
function Switch() {
  const [shown, setShown] = useState(true);
  return (
    <>
      {shown ? (
        <textarea name="notes" aria-label="Notes" defaultValue="" />
      ) : null}
      <button type="button" onClick={() => setShown((now) => !now)}>
        Switch notes
      </button>
    </>
  );
}
function SwitchForm(props: Props) {
  const ref = useRef<HTMLFormElement>(null);
  handle = useRecoverableForm({
    formContext: A,
    allow: BOTH,
    formRef: ref,
    port: props.port,
    registry: props.registry,
    tab: props.tab,
  });
  return (
    <form ref={ref} aria-label="Task">
      <input name="title" aria-label="Title" defaultValue="" />
      <Switch />
    </form>
  );
}

let counter = 0;
const tabFor = (): RecoveryTab =>
  createRecoveryTab({ uuid: () => `page-${++counter}`, locks: null });
/** A recovery identity whose Web Lock is still being granted: `id()` waits until `grant()`. */
const heldTab = () => {
  let minted: string | null = null;
  let grant: () => void = () => undefined;
  const granted = new Promise<void>((resolve) => {
    grant = resolve;
  });
  const tab: RecoveryTab = {
    id: async () => {
      minted ??= `held-${++counter}`;
      await granted;
      return minted;
    },
    current: () => minted,
    ownerOpen: async (id) => id === minted,
  };
  return { tab, grant: () => grant() };
};

const field = (name: "Title" | "Notes") =>
  screen.getByLabelText(name) as HTMLInputElement | HTMLTextAreaElement;
const title = () => field("Title");
const notesShown = () => screen.queryByLabelText("Notes") !== null;
/** The person types: the value changes and the field says so (`input`), as a browser does. */
const typeInto = (name: "Title" | "Notes", value: string) => {
  act(() => {
    const element = field(name);
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const type = (value: string) => typeInto("Title", value);
const ready = () => waitFor(() => expect(handle?.ready).toBe(true));
const mount = async (props: Props) => {
  const view = render(<Form {...props} />);
  if (props.port) await ready();
  return view;
};
/** The next page of the tab (a reload): a new registry and identity over the same store. */
const nextPage = async (port: FormRecoveryPort, allow = BOTH) => {
  cleanup();
  handle = null;
  await mount({
    port,
    registry: createRecoverableFormRegistry(),
    tab: tabFor(),
    allow,
  });
  return {
    title: title().value,
    notes: notesShown() ? field("Notes").value : null,
  };
};
const flushOne = (registry: RecoverableFormRegistry) => {
  const dirty = registry.dirty();
  expect(dirty).toHaveLength(1);
  return dirty[0]?.flush() as Promise<SaveResult>;
};
const stored = async (port: FormRecoveryPort) =>
  (await port.list(A)).map((copy) => copy.values);
const ticketOf = (): SubmissionTicket => {
  const ticket = handle?.submitting();
  if (!ticket) throw new Error("no ticket");
  return ticket;
};
const succeed = async (ticket: SubmissionTicket) => {
  let result: string | undefined;
  await act(async () => {
    result = await ticket.succeeded();
  });
  return result;
};
/** A first submission of `text` that succeeds unchanged: the form's clean state is now that submitted text. */
const submitted = async (text: string) => {
  type(text);
  expect(await succeed(ticketOf())).toBe("discarded");
};

afterEach(() => {
  cleanup();
  handle = null;
});

describe("Q1 (R3): a later edit back to an EARLIER successful submission is unfinished", () => {
  test("A succeeds; B saved and sent; edited back to A; B succeeds: A is saved, kept, and the next page restores it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    await submitted("FIRST SUBMITTED");
    expect(registry.dirty()).toHaveLength(0);
    type("SECOND SEND");
    expect(await flushOne(registry)).toBe("saved");
    const second = ticketOf();
    type("FIRST SUBMITTED");
    // Before B answers: the edit is unfinished (dirty), whatever earlier submission it equals.
    expect(registry.dirty()).toHaveLength(1);
    expect(await succeed(second)).toBe("kept");
    await registry.settled();
    expect(await stored(port)).toEqual([{ title: "FIRST SUBMITTED" }]);
    expect(registry.dirty()).toHaveLength(0);
    expect((await nextPage(port, TITLE)).title).toBe("FIRST SUBMITTED");
  });

  test("control: a distinct later text after the second send is kept the same way", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    await submitted("FIRST SUBMITTED");
    type("SECOND SEND");
    expect(await flushOne(registry)).toBe("saved");
    const second = ticketOf();
    type("LATER NEW INPUT");
    expect(await succeed(second)).toBe("kept");
    await registry.settled();
    expect(await stored(port)).toEqual([{ title: "LATER NEW INPUT" }]);
    expect((await nextPage(port, TITLE)).title).toBe("LATER NEW INPUT");
  });

  test("control: B unchanged since its send is covered; its copy is discarded and nothing is dirty", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    await submitted("FIRST SUBMITTED");
    type("SECOND SEND");
    expect(await flushOne(registry)).toBe("saved");
    expect(await succeed(ticketOf())).toBe("discarded");
    expect(await stored(port)).toEqual([]);
    expect(registry.dirty()).toHaveLength(0);
  });

  test("a submitted text needs no copy until it is edited; an edit away and back to it is unfinished", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    await submitted("SENT ONCE");
    expect(registry.dirty()).toHaveLength(0);
    type("something else");
    type("SENT ONCE");
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "SENT ONCE" }]);
  });
});

describe("Q2 (R3): no clean gap with an absent or failed copy, a proactive save, or a later flush", () => {
  test("no copy was ever saved: B succeeds after the edit back to A; the form stays dirty and its save keeps A", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    await submitted("FIRST SUBMITTED");
    type("SECOND SEND");
    const second = ticketOf();
    type("FIRST SUBMITTED");
    expect(await succeed(second)).toBe("kept");
    expect(await stored(port)).toEqual([]);
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "FIRST SUBMITTED" }]);
    expect((await nextPage(port, TITLE)).title).toBe("FIRST SUBMITTED");
  });

  test("a failed save of A, and B's reconciling save failing too: still dirty after B; the retry saves A", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    await submitted("FIRST SUBMITTED");
    type("SECOND SEND");
    const second = ticketOf();
    type("FIRST SUBMITTED");
    port.failSaves = true;
    expect(await flushOne(registry)).toBe("failed");
    expect(await succeed(second)).toBe("kept");
    await registry.settled();
    expect(registry.dirty()).toHaveLength(1);
    port.failSaves = false;
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "FIRST SUBMITTED" }]);
    expect(registry.dirty()).toHaveLength(0);
  });

  test("a proactive save of A before B succeeds, then a normal flush: A is never discarded", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    await submitted("FIRST SUBMITTED");
    type("SECOND SEND");
    expect(await flushOne(registry)).toBe("saved");
    const second = ticketOf();
    type("FIRST SUBMITTED");
    expect(await flushOne(registry)).toBe("saved");
    expect(await succeed(second)).toBe("kept");
    await registry.settled();
    // A normal flush afterwards (another tab's update asks): nothing to save, and nothing discarded.
    expect(await flushDirty(registry)).toEqual([]);
    expect(await stored(port)).toEqual([{ title: "FIRST SUBMITTED" }]);
    expect((await nextPage(port, TITLE)).title).toBe("FIRST SUBMITTED");
  });

  test("non-empty defaults: back to the default after a send is resolved (the next page starts from it), an earlier submission is not", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor(), titleDefault: "STORED" });
    await submitted("EDIT ONE");
    type("EDIT TWO");
    const second = ticketOf();
    type("STORED");
    expect(await succeed(second)).toBe("kept");
    expect(registry.dirty()).toHaveLength(0);
    type("EDIT ONE");
    expect(registry.dirty()).toHaveLength(1);
  });

  test("control (R2): initial-value reversal after a save discards the stale copy and is clean", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("X");
    expect(await flushOne(registry)).toBe("saved");
    type("");
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([]);
    expect(registry.dirty()).toHaveLength(0);
  });
});

describe("Q3 (R3): several submissions; any order; failures and duplicates", () => {
  test("three sends, answered newest first, after the form went back to the first: nothing clears the later edit", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("ONE");
    const one = ticketOf();
    type("TWO");
    const two = ticketOf();
    type("THREE");
    const three = ticketOf();
    type("ONE");
    expect(await succeed(three)).toBe("kept");
    expect(await succeed(two)).toBe("kept");
    expect(await succeed(one)).toBe("kept");
    await registry.settled();
    expect(registry.pending()).toBe(0);
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "ONE" }]);
  });

  test("three sends answered oldest first, the last unchanged: the last covers the form and discards its copy", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("ONE");
    expect(await flushOne(registry)).toBe("saved");
    const one = ticketOf();
    type("TWO");
    const two = ticketOf();
    type("THREE");
    const three = ticketOf();
    expect(await succeed(one)).toBe("kept");
    expect(await succeed(two)).toBe("kept");
    expect(await stored(port)).toEqual([{ title: "THREE" }]);
    expect(await succeed(three)).toBe("discarded");
    await registry.settled();
    expect(await stored(port)).toEqual([]);
    expect(registry.dirty()).toHaveLength(0);
    expect(registry.pending()).toBe(0);
  });

  test("two sends of the same revision (a double click): one covers, the other answers the same and changes nothing", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("ONCE");
    const first = ticketOf();
    const second = ticketOf();
    expect(await succeed(first)).toBe("discarded");
    type("AFTER");
    expect(await succeed(second)).toBe("discarded");
    expect(registry.dirty()).toHaveLength(1);
  });

  test("a failure then a success of a later send after the edit back: the failure covers nothing", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    await submitted("FIRST SUBMITTED");
    type("TWO");
    const two = ticketOf();
    two.failed();
    type("FIRST SUBMITTED");
    expect(await succeed(two)).toBe("failed");
    expect(registry.dirty()).toHaveLength(1);
  });

  test("a success while a save of the later edit waits for the identifier: the save lands and the edit stays covered by it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const { tab, grant } = heldTab();
    await mount({ port, registry, tab });
    await submitted("FIRST SUBMITTED");
    type("TWO");
    const two = ticketOf();
    type("FIRST SUBMITTED");
    const saving = flushOne(registry);
    const answered = two.succeeded();
    grant();
    expect(await answered).toBe("kept");
    expect(await saving).toBe("saved");
    await registry.settled();
    expect(await stored(port)).toEqual([{ title: "FIRST SUBMITTED" }]);
    expect(registry.dirty()).toHaveLength(0);
  });
});

describe("Q4 (R11): the committed schema admits, the empty schema included", () => {
  test("allow=[title] committed to allow=[] while blank; the title typed afterwards is never captured, locally or for another tab", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab });
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={NONE} />,
    );
    type("EXCLUDED AFTER EMPTY LIST");
    expect(registry.dirty()).toHaveLength(0);
    // Another tab's update asks this one to save (`flushDirty`), and a direct flush: neither captures the title.
    expect(await flushDirty(registry)).toEqual([]);
    for (const form of registry.all()) await form.flush();
    expect(await stored(port)).toEqual([]);
  });

  test("control: a fresh mount with the empty list captures nothing", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor(), allow: NONE });
    type("excluded");
    for (const form of registry.all()) await form.flush();
    expect(await stored(port)).toEqual([]);
  });

  test("a save asked before the commit uses the schema still committed; one asked straight after it uses the empty schema", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab });
    type("typed while admitted");
    let before: Promise<SaveResult[]> = Promise.resolve([]);
    act(() => {
      view.rerender(
        <Form port={port} registry={registry} tab={tab} allow={NONE} />,
      );
      // Inside the same act the render is not committed yet: the title is still admitted.
      before = Promise.all(registry.all().map((form) => form.flush()));
    });
    // Committed now (synchronously, at the end of the act): the title's content is retained (owed), never captured again.
    const after = Promise.all(registry.all().map((form) => form.flush()));
    expect(await before).toEqual(["saved"]);
    expect(await after).toEqual(["failed"]);
    expect(await stored(port)).toEqual([{ title: "typed while admitted" }]);
    type("typed after the exclusion");
    expect(await flushOne(registry)).toBe("failed");
    expect(await stored(port)).toEqual([{ title: "typed while admitted" }]);
  });

  test("empty -> non-empty -> empty -> re-admitted: admitted content is captured only while admitted", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: NONE });
    type("first");
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={TITLE} />,
    );
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "first" }]);
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={NONE} />,
    );
    // The title's content is retained (owed); the copy that holds it is not replaced.
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    expect(await stored(port)).toEqual([{ title: "first" }]);
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={TITLE} />,
    );
    expect(title().value).toBe("first");
    expect(registry.dirty()).toHaveLength(0);
  });

  test("control: the same fields reordered or repeated are the same schema; nothing is owed and nothing is written", async () => {
    const port = new CountingAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    type("t");
    expect(await flushOne(registry)).toBe("saved");
    const saves = port.saveCount;
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={[{ name: "notes" }, { name: "title" }, { name: "title" }]}
      />,
    );
    expect(registry.dirty()).toHaveLength(0);
    expect(port.saveCount).toBe(saves);
  });
});

describe("Q5 (R11): a field removed from the page keeps its unfinished input", () => {
  test("notes typed, then the element and its admission removed in ONE render: dirty, saves fail, nothing lost; shown again it comes back", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "UNFINISHED NOTES");
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    expect(notesShown()).toBe(false);
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    expect(await stored(port)).toEqual([]);
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={BOTH} />,
    );
    expect(field("Notes").value).toBe("UNFINISHED NOTES");
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([
      { title: "", notes: "UNFINISHED NOTES" },
    ]);
    expect(await nextPage(port)).toEqual({
      title: "",
      notes: "UNFINISHED NOTES",
    });
  });

  test("saved first, then removed with its admission: the copy holding the notes is never replaced by one without them", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "saved notes");
    expect(await flushOne(registry)).toBe("saved");
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    type("title after");
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    expect(await stored(port)).toEqual([{ title: "", notes: "saved notes" }]);
  });

  test("the element removed while still admitted (a conditional field hidden): dirty, saves fail; shown again it comes back", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "hidden notes");
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={BOTH}
        notes={false}
      />,
    );
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={BOTH} />,
    );
    await waitFor(() => expect(field("Notes").value).toBe("hidden notes"));
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "", notes: "hidden notes" }]);
  });

  test("a value changed WITHOUT an input event, then removed by the next render of the form: the render-time read keeps it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    act(() => {
      field("Notes").value = "set by code";
    });
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
  });

  test("hidden by a child that owns the switch (the hook's component does not render): the value read at the input event is kept", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    render(<SwitchForm port={port} registry={registry} tab={tabFor()} />);
    await ready();
    typeInto("Notes", "typed, then switched off");
    act(() => screen.getByRole("button", { name: "Switch notes" }).click());
    expect(notesShown()).toBe(false);
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    act(() => screen.getByRole("button", { name: "Switch notes" }).click());
    await waitFor(() =>
      expect(field("Notes").value).toBe("typed, then switched off"),
    );
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([
      { title: "", notes: "typed, then switched off" },
    ]);
  });

  test("unmounted in the same change (a remount without the field): the next mount still owes the notes", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "notes across the remount");
    cleanup();
    handle = null;
    await mount({ port, registry, tab, allow: TITLE, notes: false });
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    cleanup();
    handle = null;
    await mount({ port, registry, tab, allow: BOTH });
    expect(field("Notes").value).toBe("notes across the remount");
  });

  test("control: a removed field that was never edited (its default) is no obligation", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    type("title only");
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "title only" }]);
    expect(registry.dirty()).toHaveLength(0);
  });

  test("control: the list narrowed while the element stays: still owed (no capture of the excluded notes)", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "unfinished");
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={TITLE} />,
    );
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    expect(await stored(port)).toEqual([]);
  });
});

describe("PRODUCT-DECISIONS-20261011 item 2: a successful save of the visible state covers hidden values", () => {
  test("notes hidden with input, the form submitted and successful: no block, no dirty form; the hidden value comes back if shown", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    type("visible title");
    typeInto("Notes", "hidden then");
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={BOTH}
        notes={false}
      />,
    );
    expect(await succeed(ticketOf())).toBe("discarded");
    expect(registry.dirty()).toHaveLength(0);
    type("edited after the save");
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "edited after the save" }]);
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={BOTH} />,
    );
    await waitFor(() => expect(field("Notes").value).toBe("hidden then"));
  });

  test("a newer conditional-field edit after the send is not consumed by its success", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "sent notes");
    const sent = ticketOf();
    typeInto("Notes", "newer notes");
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={BOTH}
        notes={false}
      />,
    );
    expect(await succeed(sent)).toBe("kept");
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
  });

  test("a failed submission covers nothing: the hidden input stays owed", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "kept for retry");
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={BOTH}
        notes={false}
      />,
    );
    const sent = ticketOf();
    sent.failed();
    expect(registry.dirty()).toHaveLength(1);
  });
});

describe("Q6 (R11): re-admission and captures of another schema", () => {
  test("re-admitted while still absent: still owed until shown; then it comes back", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "held");
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={BOTH}
        notes={false}
      />,
    );
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={BOTH} />,
    );
    await waitFor(() => expect(field("Notes").value).toBe("held"));
    expect(await flushOne(registry)).toBe("saved");
  });

  test("re-admitted into a field the person typed something else into: their text stays, the held value stays owed", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "held");
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={TITLE} />,
    );
    typeInto("Notes", "typed while excluded");
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={BOTH} />,
    );
    expect(field("Notes").value).toBe("typed while excluded");
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    expect(await handle?.discard()).toBe("discarded");
    expect(registry.dirty()).toHaveLength(0);
  });

  test("a capture of both fields waiting for the identifier through the narrowing lands with its own schema; the notes stay owed", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const { tab, grant } = heldTab();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "N");
    const pending = flushOne(registry);
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    grant();
    expect(await pending).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "", notes: "N" }]);
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    expect(await stored(port)).toEqual([{ title: "", notes: "N" }]);
  });

  test("removed in one render, then re-admitted and shown untouched: the held value comes back and is saved", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "held");
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={BOTH} />,
    );
    expect(field("Notes").value).toBe("held");
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "", notes: "held" }]);
  });
});

describe("Q7: before the form has a session, and across binding", () => {
  test("unbound: a field removed with its admission is owed; bound later, the session owes it and gets it back", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port: null, registry, tab, allow: BOTH });
    typeInto("Notes", "typed before the database opened");
    view.rerender(
      <Form
        port={null}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    expect(registry.dirty()).toHaveLength(1);
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    await ready();
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={BOTH} />,
    );
    await waitFor(() =>
      expect(field("Notes").value).toBe("typed before the database opened"),
    );
    expect(await flushOne(registry)).toBe("saved");
  });

  test("unbound in a remount: a field removed before the mount binds its resumed session is still owed by that session", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    // The session begins title-only: it has never held the notes.
    await mount({ port, registry, tab, allow: TITLE });
    cleanup();
    handle = null;
    const view = await mount({ port: null, registry, tab, allow: BOTH });
    typeInto("Notes", "typed in the unbound remount");
    view.rerender(
      <Form
        port={null}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    view.rerender(
      <Form
        port={port}
        registry={registry}
        tab={tab}
        allow={TITLE}
        notes={false}
      />,
    );
    await ready();
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={BOTH} />,
    );
    await waitFor(() =>
      expect(field("Notes").value).toBe("typed in the unbound remount"),
    );
  });

  test("unbound: a later edit back to an earlier successful submission stays dirty", async () => {
    const registry = createRecoverableFormRegistry();
    await mount({ port: null, registry, tab: tabFor() });
    await submitted("FIRST SUBMITTED");
    expect(registry.dirty()).toHaveLength(0);
    type("SECOND SEND");
    const second = ticketOf();
    type("FIRST SUBMITTED");
    expect(await succeed(second)).toBe("kept");
    expect(registry.dirty()).toHaveLength(1);
  });

  test("control: an unbound submission unchanged since its send covers the form", async () => {
    const registry = createRecoverableFormRegistry();
    await mount({ port: null, registry, tab: tabFor() });
    type("SENT");
    expect(await succeed(ticketOf())).toBe("discarded");
    expect(registry.dirty()).toHaveLength(0);
  });
});

describe("Q7: a remount whose new mount was typed into before it bound", () => {
  test("the person's new text stays; the session's unsaved value for the field stays owed until a save covers or a discard drops it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount({ port, registry, tab });
    type("unsaved in the first mount");
    cleanup();
    handle = null;
    const view = await mount({ port: null, registry, tab });
    type("typed in the new mount");
    view.rerender(<Form port={port} registry={registry} tab={tab} />);
    await ready();
    expect(title().value).toBe("typed in the new mount");
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    // (`handle` is reassigned by the render: read through a function so the reset above does not narrow it.)
    expect(await current()?.discard()).toBe("discarded");
    expect(registry.dirty()).toHaveLength(0);
  });

  test("control: the new mount untouched takes the session's value back and saves it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount({ port, registry, tab });
    type("unsaved in the first mount");
    cleanup();
    handle = null;
    const view = await mount({ port: null, registry, tab });
    view.rerender(<Form port={port} registry={registry} tab={tab} />);
    await ready();
    expect(title().value).toBe("unsaved in the first mount");
    expect(await flushOne(registry)).toBe("saved");
  });
});

describe("Q8: a look answered late never overwrites a newer edit", () => {
  test("an edit away and back while the owner probe is held: the copy is offered, not restored", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save({
      formContext: A,
      tabInstanceId: "gone",
      values: { title: "left by a gone tab" },
      savedAt: new Date().toISOString(),
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tab: RecoveryTab = {
      id: async () => "this-page",
      current: () => null,
      ownerOpen: async () => {
        await held;
        return false;
      },
    };
    const registry = createRecoverableFormRegistry();
    render(<Form port={port} registry={registry} tab={tab} />);
    await waitFor(() => expect(registry.all()).toHaveLength(1));
    type("typed");
    type("");
    release();
    await ready();
    expect(title().value).toBe("");
    expect(handle?.restored).toBeNull();
    expect(
      handle?.alternatives.map((copy: RecoverySnapshot) => copy.tabInstanceId),
    ).toEqual(["gone"]);
  });
});

describe("Q12: input, reset and unchanged values", () => {
  test("a reset puts the form back to its defaults: after the browser's reset nothing is unfinished", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor(), allow: BOTH });
    type("to be reset");
    expect(await flushOne(registry)).toBe("saved");
    act(() => {
      (screen.getByRole("form") as HTMLFormElement).reset();
    });
    expect(title().value).toBe("");
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([]);
    expect(registry.dirty()).toHaveLength(0);
  });

  test("a cancelled reset changes nothing: the input stays unfinished", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("kept");
    const form = screen.getByRole("form") as HTMLFormElement;
    form.addEventListener("reset", (event) => event.preventDefault());
    act(() => form.reset());
    expect(title().value).toBe("kept");
    expect(registry.dirty()).toHaveLength(1);
  });

  test("control: rerenders with the same values and schema fabricate no debt and no write", async () => {
    const port = new CountingAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "n");
    expect(await flushOne(registry)).toBe("saved");
    const saves = port.saveCount;
    for (let i = 0; i < 3; i += 1)
      view.rerender(
        <Form port={port} registry={registry} tab={tab} allow={[...BOTH]} />,
      );
    expect(registry.dirty()).toHaveLength(0);
    expect(port.saveCount).toBe(saves);
  });
});

describe("Q11: the update coordinator saves through the real form and reloads only when it is covered", () => {
  const coordinated = async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const port = new MemoryRecoveryAdapter();
    const view = await mount({
      port,
      registry: tab.forms,
      tab: tabFor(),
      allow: BOTH,
    });
    return { origin, tab, port, view };
  };
  const settle = async (origin: FakeOrigin) => {
    for (let i = 0; i < 5; i += 1)
      await act(async () => {
        await origin.clock.advance(FLUSH_START_GRACE_MS);
      });
  };

  test("R3 schedule: B held through 'Save and reload'; after its success the later A is saved, then the tab reloads", async () => {
    const { origin, tab, port } = await coordinated();
    await submitted("FIRST SUBMITTED");
    type("SECOND SEND");
    const second = ticketOf();
    type("FIRST SUBMITTED");
    const waiting = await origin.installNew(2);
    act(() => tab.actions?.accept());
    await settle(origin);
    expect(tab.reloads).toBe(0);
    await succeed(second);
    await settle(origin);
    await act(async () => {
      await origin.activate(waiting);
    });
    await act(async () => {
      await origin.clock.advance(ACTIVATION_FALLBACK_MS);
    });
    expect(await stored(port)).toEqual([
      { title: "FIRST SUBMITTED", notes: "" },
    ]);
    expect(tab.reloads).toBe(1);
  });

  test("R11 schedule: notes removed with their admission; 'Save and reload' stops with save_failed and does not reload", async () => {
    const { origin, tab, port, view } = await coordinated();
    typeInto("Notes", "UNFINISHED NOTES");
    view.rerender(
      <Form
        port={port}
        registry={tab.forms}
        tab={tabFor()}
        allow={TITLE}
        notes={false}
      />,
    );
    const waiting = await origin.installNew(2);
    act(() => tab.actions?.accept());
    await settle(origin);
    await act(async () => {
      await origin.activate(waiting);
    });
    expect(tab.state.kind).toBe("save_failed");
    expect(tab.reloads).toBe(0);
    expect(await stored(port)).toEqual([]);
  });

  test("control: a covered form (its submission succeeded unchanged) reloads once with nothing saved", async () => {
    const { origin, tab, port } = await coordinated();
    await submitted("SENT");
    const waiting = await origin.installNew(2);
    act(() => tab.actions?.accept());
    await settle(origin);
    await act(async () => {
      await origin.activate(waiting);
    });
    expect(tab.reloads).toBe(1);
    expect(await stored(port)).toEqual([]);
  });
});
