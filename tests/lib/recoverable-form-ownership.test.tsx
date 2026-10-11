import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
import type {
  FormRecoveryPort,
  RecoverableFieldSpec,
  SaveResult,
} from "../../src/lib/form-recovery/port";
import {
  createRecoverableFormRegistry,
  type RecoverableFormRegistry,
} from "../../src/lib/form-recovery/registry";
import {
  createRecoveryTab,
  RecoveryIdentityError,
  type RecoveryTab,
} from "../../src/lib/form-recovery/tab-identity";
import {
  type RecoverableForm,
  type SubmissionTicket,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";

/**
 * WEB-14a revision 3: what a submission, a mount's schema and the page's identity OWN (review of 11 October 2026, findings R3, R10, R11 and
 * R12; design assessment of 11 October 2026, invariants I1-I8 and qualification items Q1-Q8). Each case forces its schedule with explicit
 * gates (held tickets, deferred identity grants, held port calls), never with time. FIXTURE evidence over the memory adapter or doubles of
 * the port and the lock manager; the real store, Web Locks and the update coordinator are the `fixture.pwa-forms.spec.ts` revision-3 cases
 * in three engines.
 */
const A = "task-edit:/tasks/7";
const B = "task-edit:/tasks/8";
const TITLE: readonly RecoverableFieldSpec[] = [{ name: "title" }];
const BOTH: readonly RecoverableFieldSpec[] = [
  { name: "title" },
  { name: "notes" },
];

let handle: RecoverableForm | null = null;
type Props = {
  port: FormRecoveryPort | null;
  registry: RecoverableFormRegistry;
  tab: RecoveryTab;
  context?: string;
  allow?: readonly RecoverableFieldSpec[];
};
function Form({ context = A, allow = TITLE, ...props }: Props) {
  const ref = useRef<HTMLFormElement>(null);
  handle = useRecoverableForm({
    formContext: context,
    allow,
    formRef: ref,
    ...props,
  });
  return (
    <form ref={ref} aria-label="Task">
      <input name="title" aria-label="Title" defaultValue="" />
      <textarea name="notes" aria-label="Notes" defaultValue="" />
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
/** The same form mounted again in the same page (another page's boot remounts the protected tree, F-1). */
const remount = async (props: Props) => {
  cleanup();
  handle = null;
  return mount(props);
};
/** The next page of the tab (a reload): a new registry and identity over the same store. */
const nextPage = async (port: FormRecoveryPort, context = A, allow = TITLE) => {
  cleanup();
  handle = null;
  await mount({
    port,
    registry: createRecoverableFormRegistry(),
    tab: tabFor(),
    context,
    allow,
  });
  return { title: title().value, notes: field("Notes").value };
};
const flushOne = (registry: RecoverableFormRegistry) => {
  const dirty = registry.dirty();
  expect(dirty).toHaveLength(1);
  return dirty[0]?.flush() as Promise<SaveResult>;
};
const stored = async (port: FormRecoveryPort, context = A) =>
  (await port.list(context)).map((copy) => copy.values);
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

afterEach(() => {
  cleanup();
  handle = null;
});

describe("R3 / Q1: a success acknowledges what was SENT, never what the form holds when it answers", () => {
  test("changed after the send: the success keeps the later input, its copy replaces the sent one, and the next page restores it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("submitted text");
    expect(await flushOne(registry)).toBe("saved");
    const ticket = ticketOf();
    type("LATER UNSENT EDIT");
    expect(await succeed(ticket)).toBe("kept");
    expect(title().value).toBe("LATER UNSENT EDIT");
    await registry.settled();
    expect(registry.pending()).toBe(0);
    expect(await stored(port)).toEqual([{ title: "LATER UNSENT EDIT" }]);
    expect(registry.dirty()).toHaveLength(0);
    expect((await nextPage(port)).title).toBe("LATER UNSENT EDIT");
  });

  test("control: unchanged since the send, the success discards the copies and the next page shows the form empty", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("submitted text");
    expect(await flushOne(registry)).toBe("saved");
    const ticket = ticketOf();
    expect(await succeed(ticket)).toBe("discarded");
    expect(await stored(port)).toEqual([]);
    expect(registry.dirty()).toHaveLength(0);
    expect((await nextPage(port)).title).toBe("");
  });

  test("changed after the send with no copy in the store: kept and dirty, nothing written until a save; the save keeps it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("submitted text");
    const ticket = ticketOf();
    type("typed after sending");
    expect(await succeed(ticket)).toBe("kept");
    expect(await stored(port)).toEqual([]);
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "typed after sending" }]);
  });

  test("a save of the later input waiting for the identifier is not cancelled by the earlier submission's success", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const { tab, grant } = heldTab();
    await mount({ port, registry, tab });
    type("submitted text");
    const ticket = ticketOf();
    type("later, being saved");
    const saving = flushOne(registry);
    // Answered while the save still waits: its reconciliation (a save of the later input) waits for the same identifier.
    const answered = ticket.succeeded();
    grant();
    expect(await answered).toBe("kept");
    expect(await saving).toBe("saved");
    await registry.settled();
    expect(await stored(port)).toEqual([{ title: "later, being saved" }]);
    expect(registry.dirty()).toHaveLength(0);
  });

  test("changed after the send back to the initial value: kept, and the sent copy is discarded rather than brought back", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("submitted text");
    expect(await flushOne(registry)).toBe("saved");
    const ticket = ticketOf();
    type("");
    expect(await succeed(ticket)).toBe("kept");
    await registry.settled();
    expect(await stored(port)).toEqual([]);
    expect(registry.dirty()).toHaveLength(0);
    expect((await nextPage(port)).title).toBe("");
  });
});

describe("R3 / Q2: an edit is an edit even when it returns to the same text; older responses never regress newer ones", () => {
  test("changed away and back to the sent text after the send: kept, and the person's re-entered text is what the next page restores", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("same text");
    expect(await flushOne(registry)).toBe("saved");
    const ticket = ticketOf();
    type("something else");
    type("same text");
    expect(await succeed(ticket)).toBe("kept");
    await registry.settled();
    expect(await stored(port)).toEqual([{ title: "same text" }]);
    expect((await nextPage(port)).title).toBe("same text");
  });

  test("two submissions answered newest first: the older success answers the newer outcome and changes nothing", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("first send");
    expect(await flushOne(registry)).toBe("saved");
    const first = ticketOf();
    type("second send");
    const second = ticketOf();
    expect(await succeed(second)).toBe("discarded");
    expect(await stored(port)).toEqual([]);
    type("typed after both");
    expect(await succeed(first)).toBe("discarded");
    await registry.settled();
    expect(title().value).toBe("typed after both");
    expect(registry.dirty()).toHaveLength(1);
    expect(registry.pending()).toBe(0);
  });

  test("two submissions answered oldest first: the first keeps the second's input, the second then discards it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("first send");
    expect(await flushOne(registry)).toBe("saved");
    const first = ticketOf();
    type("second send");
    const second = ticketOf();
    // Its answer comes once the save of the later input has settled (the second ticket is still outstanding).
    expect(await succeed(first)).toBe("kept");
    expect(registry.pending()).toBe(1);
    expect(await stored(port)).toEqual([{ title: "second send" }]);
    expect(await succeed(second)).toBe("discarded");
    expect(await stored(port)).toEqual([]);
    expect(registry.dirty()).toHaveLength(0);
  });

  test("an older success after a newer one that kept later input never clears that input", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("first send");
    expect(await flushOne(registry)).toBe("saved");
    const first = ticketOf();
    type("second send");
    const second = ticketOf();
    type("still unsent");
    expect(await succeed(second)).toBe("kept");
    expect(await succeed(first)).toBe("kept");
    await registry.settled();
    expect(await stored(port)).toEqual([{ title: "still unsent" }]);
    expect((await nextPage(port)).title).toBe("still unsent");
  });
});

describe("Q8: a ticket completes once", () => {
  test("a second success answers the first outcome; failure after success changes nothing; nothing counts below zero", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("sent");
    expect(await flushOne(registry)).toBe("saved");
    const ticket = ticketOf();
    expect(await succeed(ticket)).toBe("discarded");
    type("typed after");
    expect(await flushOne(registry)).toBe("saved");
    expect(await succeed(ticket)).toBe("discarded");
    ticket.failed();
    await registry.settled();
    expect(registry.pending()).toBe(0);
    expect(await stored(port)).toEqual([{ title: "typed after" }]);
  });

  test("a failure first: a later success answers `failed` and discards nothing", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab: tabFor() });
    type("not sent");
    expect(await flushOne(registry)).toBe("saved");
    const ticket = ticketOf();
    ticket.failed();
    expect(await succeed(ticket)).toBe("failed");
    expect(await stored(port)).toEqual([{ title: "not sent" }]);
    expect(registry.pending()).toBe(0);
  });
});

describe("R10 / Q3: a ticket belongs to the session it was sent from", () => {
  test("context A's success arrives after the same hook shows context B: B's input and copy stay, only A's copy is discarded", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab });
    type("A submitted");
    expect(await flushOne(registry)).toBe("saved");
    const ticket = ticketOf();
    view.rerender(
      <Form port={port} registry={registry} tab={tab} context={B} />,
    );
    await waitFor(() => expect(registry.session(B)).toBeDefined());
    type("B unsent");
    await Promise.all(registry.dirty().map((form) => form.flush()));
    expect(await stored(port, B)).toEqual([{ title: "B unsent" }]);
    expect(await succeed(ticket)).toBe("discarded");
    expect(await stored(port, B)).toEqual([{ title: "B unsent" }]);
    expect(await stored(port, A)).toEqual([]);
    expect(title().value).toBe("B unsent");
    type("B changed again");
    expect(registry.dirty()).toHaveLength(1);
  });

  test("control: with no late response from A, both contexts keep their copies", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab });
    type("A");
    expect(await flushOne(registry)).toBe("saved");
    view.rerender(
      <Form port={port} registry={registry} tab={tab} context={B} />,
    );
    await waitFor(() => expect(registry.session(B)).toBeDefined());
    type("B");
    await Promise.all(registry.dirty().map((form) => form.flush()));
    expect(await stored(port, A)).toEqual([{ title: "A" }]);
    expect(await stored(port, B)).toEqual([{ title: "B" }]);
  });

  test("A changed after its send, then the hook shows B: A's success keeps A's later input (A's copy holds it), B is untouched", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab });
    type("A sent");
    expect(await flushOne(registry)).toBe("saved");
    const ticket = ticketOf();
    type("A later");
    view.rerender(
      <Form port={port} registry={registry} tab={tab} context={B} />,
    );
    await waitFor(() => expect(registry.session(B)).toBeDefined());
    type("B input");
    expect(await succeed(ticket)).toBe("kept");
    await registry.settled();
    expect(await stored(port, A)).toEqual([{ title: "A later" }]);
    expect(await stored(port, B)).toEqual([]);
    expect(title().value).toBe("B input");
  });

  test("a ticket outlives the account it was sent for: its success writes nothing to the other account and says it could not discard", async () => {
    const stores: Record<string, MemoryRecoveryAdapter> = {
      A: new MemoryRecoveryAdapter(),
      B: new MemoryRecoveryAdapter(),
    };
    let account: "A" | "B" = "A";
    const live = () => stores[account] as MemoryRecoveryAdapter;
    const port: FormRecoveryPort = {
      save: (s) => live().save(s),
      load: (c, t) => live().load(c, t),
      discard: (c, t) => live().discard(c, t),
      list: (c) => live().list(c),
      pin: () => ({ account, scope: `${account}:1`, port: live() }),
    };
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount({ port, registry, tab });
    type("account A sent");
    expect(await flushOne(registry)).toBe("saved");
    const ticket = ticketOf();
    account = "B";
    await remount({ port, registry, tab });
    type("account B input");
    expect(await flushOne(registry)).toBe("saved");
    expect(await succeed(ticket)).toBe("failed");
    expect(await stored(stores.B as MemoryRecoveryAdapter)).toEqual([
      { title: "account B input" },
    ]);
    expect(await stored(stores.A as MemoryRecoveryAdapter)).toEqual([
      { title: "account A sent" },
    ]);
  });
});

describe("R10 / Q8: a ticket taken before the form had a session", () => {
  test("is waited for while unbound, joins the session the same mount binds for its context, and discards only what it sent", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port: null, registry, tab });
    type("sent before the database opened");
    const ticket = ticketOf();
    expect(registry.pending()).toBe(1);
    view.rerender(<Form port={port} registry={registry} tab={tab} />);
    await ready();
    expect(registry.pending()).toBe(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await succeed(ticket)).toBe("discarded");
    await registry.settled();
    expect(registry.pending()).toBe(0);
    expect(await stored(port)).toEqual([]);
  });

  test("input changed after the unbound send is kept after binding", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port: null, registry, tab });
    type("sent");
    const ticket = ticketOf();
    type("changed before binding");
    view.rerender(<Form port={port} registry={registry} tab={tab} />);
    await ready();
    expect(await flushOne(registry)).toBe("saved");
    expect(await succeed(ticket)).toBe("kept");
    await registry.settled();
    expect(await stored(port)).toEqual([{ title: "changed before binding" }]);
  });

  test("never joins a session of another form context", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port: null, registry, tab });
    type("A sent unbound");
    const ticket = ticketOf();
    view.rerender(
      <Form port={port} registry={registry} tab={tab} context={B} />,
    );
    await ready();
    type("B input");
    expect(await flushOne(registry)).toBe("saved");
    expect(await succeed(ticket)).toBe("kept");
    await registry.settled();
    expect(await stored(port, B)).toEqual([{ title: "B input" }]);
    expect(registry.pending()).toBe(0);
  });
});

describe("R10 / Q8: a ticket taken before the form had a session (ownership alone)", () => {
  test("never joins a session of another form context, even one that shows exactly the sent text: B's copy stays", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port: null, registry, tab });
    type("A sent unbound");
    const ticket = ticketOf();
    view.rerender(
      <Form port={port} registry={registry} tab={tab} context={B} />,
    );
    await ready();
    // Set without input events (a programmatic change): no input revision separates A's ticket from B, only its owner does.
    act(() => {
      title().value = "B unsent";
    });
    expect(await flushOne(registry)).toBe("saved");
    act(() => {
      title().value = "A sent unbound";
    });
    expect(await succeed(ticket)).toBe("discarded");
    await registry.settled();
    expect(await stored(port, B)).toEqual([{ title: "B unsent" }]);
    expect(registry.dirty()).toHaveLength(1);
  });
});

describe("R11 / Q5: the attached mount's allow-list is the schema", () => {
  test("expanded on a remount: the carried title is restored, the new field starts from the mount, and both are captured", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount({ port, registry, tab });
    type("saved title");
    expect(await flushOne(registry)).toBe("saved");
    await remount({ port, registry, tab, allow: BOTH });
    expect(title().value).toBe("saved title");
    expect(registry.dirty()).toHaveLength(0);
    typeInto("Notes", "new notes");
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([
      { title: "saved title", notes: "new notes" },
    ]);
    expect(await nextPage(port, A, BOTH)).toEqual({
      title: "saved title",
      notes: "new notes",
    });
  });

  test("expanded on a remount with unsaved carried input: both fields' input is captured", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount({ port, registry, tab });
    type("unsaved title");
    await remount({ port, registry, tab, allow: BOTH });
    expect(title().value).toBe("unsaved title");
    typeInto("Notes", "and notes");
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([
      { title: "unsaved title", notes: "and notes" },
    ]);
  });

  test("control: the same fields in another order are the same schema; the carried input is restored and clean", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount({ port, registry, tab, allow: BOTH });
    type("t");
    typeInto("Notes", "n");
    expect(await flushOne(registry)).toBe("saved");
    await remount({
      port,
      registry,
      tab,
      allow: [{ name: "notes" }, { name: "title" }],
    });
    expect(title().value).toBe("t");
    expect(field("Notes").value).toBe("n");
    expect(registry.dirty()).toHaveLength(0);
  });

  test("reduced on a remount: a removed field at its initial value is no obligation, and new input in it is never captured", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount({ port, registry, tab, allow: BOTH });
    type("old title");
    expect(await flushOne(registry)).toBe("saved");
    await remount({ port, registry, tab, allow: TITLE });
    type("new title");
    typeInto("Notes", "NOW EXCLUDED INPUT");
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "new title" }]);
  });

  test("reduced on a remount while the removed field holds input: it is held, never captured or dropped; saves fail until it is discarded", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount({ port, registry, tab, allow: BOTH });
    type("title");
    typeInto("Notes", "unfinished notes");
    expect(await flushOne(registry)).toBe("saved");
    await remount({ port, registry, tab, allow: TITLE });
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("failed");
    // The copy that holds the notes is not replaced by a capture without them.
    expect(await stored(port)).toEqual([
      { title: "title", notes: "unfinished notes" },
    ]);
    expect(await handle?.discard()).toBe("discarded");
    expect(registry.dirty()).toHaveLength(0);
    expect(await stored(port)).toEqual([]);
  });

  test("admitted again: the held content comes back into the field and is captured", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "held notes");
    await remount({ port, registry, tab, allow: TITLE });
    expect(registry.dirty()).toHaveLength(1);
    await remount({ port, registry, tab, allow: BOTH });
    expect(field("Notes").value).toBe("held notes");
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "", notes: "held notes" }]);
  });

  test("changed while mounted: an admitted field is captured from then on, a removed one with input is held", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const view = await mount({ port, registry, tab });
    type("title");
    typeInto("Notes", "typed before it was admitted");
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "title" }]);
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={BOTH} />,
    );
    await waitFor(() => expect(registry.dirty()).toHaveLength(1));
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([
      { title: "title", notes: "typed before it was admitted" },
    ]);
    view.rerender(
      <Form port={port} registry={registry} tab={tab} allow={TITLE} />,
    );
    await waitFor(() => expect(registry.dirty()).toHaveLength(1));
    expect(await flushOne(registry)).toBe("failed");
  });
});

describe("R11 / Q6: a capture keeps its own schema; the current one decides what is durable", () => {
  test("a title-only save waiting for the identifier lands after the remount admits notes: the notes are still dirty and saved next", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const { tab, grant } = heldTab();
    await mount({ port, registry, tab });
    type("t");
    const pending = flushOne(registry);
    await remount({ port, registry, tab, allow: BOTH });
    typeInto("Notes", "n");
    grant();
    expect(await pending).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "t" }]);
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([{ title: "t", notes: "n" }]);
  });
});

/** A lock manager double: `refuse` makes the next owning requests reject as `UnknownError`; `held` are the names held. */
const lockManager = () => {
  const held = new Set<string>();
  const state = { refuse: 0, owning: 0 };
  const locks = {
    request: async (
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: unknown) => unknown,
    ) => {
      if (options.ifAvailable) return callback(held.has(name) ? null : {});
      state.owning += 1;
      if (state.refuse > 0) {
        state.refuse -= 1;
        throw new DOMException("injected", "UnknownError");
      }
      held.add(name);
      return callback({ name });
    },
  } as unknown as Pick<LockManager, "request">;
  return { locks, held, state };
};

describe("R12 / Q7: ownership precedes exposure", () => {
  test("a refused owning lock: the save fails, nothing is written, the input stays; the retry acquires a new lock and saves", async () => {
    const manager = lockManager();
    manager.state.refuse = 1;
    let n = 0;
    const tab = createRecoveryTab({
      uuid: () => `id-${++n}`,
      locks: manager.locks,
    });
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount({ port, registry, tab });
    type("still editing");
    expect(await flushOne(registry)).toBe("failed");
    expect(await stored(port)).toEqual([]);
    expect(tab.current()).toBeNull();
    expect(title().value).toBe("still editing");
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(manager.state.owning).toBe(2);
    expect(tab.current()).toBe("id-2");
    const other = createRecoveryTab({
      uuid: () => "other",
      locks: manager.locks,
    });
    expect(await other.ownerOpen("id-2")).toBe(true);
    expect(await other.ownerOpen("id-1")).toBe(false);
  });

  test("the failure rejects every waiter with a typed error; concurrent callers share one acquisition", async () => {
    const manager = lockManager();
    manager.state.refuse = 1;
    const tab = createRecoveryTab({ uuid: () => "id", locks: manager.locks });
    const both = [tab.id(), tab.id()];
    for (const waiting of both)
      await expect(waiting).rejects.toBeInstanceOf(RecoveryIdentityError);
    expect(manager.state.owning).toBe(1);
    expect(await Promise.all([tab.id(), tab.id()])).toEqual(["id", "id"]);
    expect(manager.state.owning).toBe(2);
  });

  test("a lock manager that throws as it is asked: a typed failure, then a real acquisition", async () => {
    let calls = 0;
    const locks = {
      request: (_n: string, _o: unknown, callback: () => unknown) => {
        calls += 1;
        if (calls === 1) throw new TypeError("injected");
        callback();
        return new Promise(() => undefined);
      },
    } as unknown as Pick<LockManager, "request">;
    const tab = createRecoveryTab({ uuid: () => `id-${calls}`, locks });
    await expect(tab.id()).rejects.toBeInstanceOf(RecoveryIdentityError);
    expect(tab.current()).toBeNull();
    expect(await tab.id()).toBe("id-1");
    expect(tab.current()).toBe("id-1");
  });

  test("a candidate still being granted is not advertised as the page's identifier", async () => {
    let grant: () => void = () => undefined;
    const locks = {
      request: (_n: string, _o: unknown, callback: () => unknown) =>
        new Promise((resolve) => {
          grant = () => resolve(callback());
        }),
    } as unknown as Pick<LockManager, "request">;
    const tab = createRecoveryTab({ uuid: () => "candidate", locks });
    const waiting = tab.id();
    expect(tab.current()).toBeNull();
    expect(await tab.ownerOpen("candidate")).toBe(true);
    grant();
    expect(await waiting).toBe("candidate");
    expect(tab.current()).toBe("candidate");
  });

  test("a page with no lock manager has no recovery identity: nothing can be saved under one", async () => {
    vi.resetModules();
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    });
    try {
      const fresh = await import("../../src/lib/form-recovery/tab-identity");
      const page = fresh.getPageRecoveryTab();
      await expect(page.id()).rejects.toBeInstanceOf(
        fresh.RecoveryIdentityError,
      );
      expect(page.current()).toBeNull();
      expect(await page.ownerOpen("another")).toBe(true);
    } finally {
      if (locks) Object.defineProperty(navigator, "locks", locks);
      else Reflect.deleteProperty(navigator, "locks");
    }
  });
});
