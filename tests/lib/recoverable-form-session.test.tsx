import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
import type {
  DiscardResult,
  FormRecoveryPort,
  RecoverySnapshot,
  SaveResult,
} from "../../src/lib/form-recovery/port";
import {
  createRecoverableFormRegistry,
  type RecoverableFormRegistry,
} from "../../src/lib/form-recovery/registry";
import {
  createRecoveryTab,
  type RecoveryTab,
} from "../../src/lib/form-recovery/tab-identity";
import {
  type RecoverableForm,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";

/**
 * WEB-14a revision 2: ONE form session per form, whatever mounts it (findings R2, R4, R3 at the hook, DA-1 and DA-2 of the design
 * assessment of 10 October 2026; its qualification items Q1-Q10). Each case forces its schedule with explicit gates (deferred identity
 * grants, held lists and owner probes, held port calls), never with time. FIXTURE evidence over the memory adapter or a double of the
 * port's documented order; the real store and Web Locks are the `fixture.pwa-forms.spec.ts` revision-2 cases in three engines.
 */
const ALLOW = [{ name: "title" }];
const CONTEXT = "task-edit:/tasks/7";

let handle: RecoverableForm | null = null;
function Form(props: {
  port: FormRecoveryPort | null;
  registry: RecoverableFormRegistry;
  tab: RecoveryTab;
}) {
  const ref = useRef<HTMLFormElement>(null);
  handle = useRecoverableForm({
    formContext: CONTEXT,
    allow: ALLOW,
    formRef: ref,
    ...props,
  });
  return (
    <form ref={ref} aria-label="Task">
      <input name="title" aria-label="Title" defaultValue="" />
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
const gate = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
};

const title = () => screen.getByLabelText("Title") as HTMLInputElement;
const type = (value: string) => {
  act(() => {
    title().value = value;
  });
};
const ready = () => waitFor(() => expect(handle?.ready).toBe(true));
const mount = async (
  port: FormRecoveryPort | null,
  registry: RecoverableFormRegistry,
  tab: RecoveryTab,
) => {
  render(<Form port={port} registry={registry} tab={tab} />);
  if (port) await ready();
};
/** The same form mounted again in the same page (another page's boot remounts the protected tree, F-1). */
const remount = async (
  port: FormRecoveryPort | null,
  registry: RecoverableFormRegistry,
  tab: RecoveryTab,
) => {
  cleanup();
  handle = null;
  await mount(port, registry, tab);
};
/** The next page of the tab (a reload): a new registry and identity over the same store. */
const nextPage = async (port: FormRecoveryPort) => {
  cleanup();
  handle = null;
  await mount(port, createRecoverableFormRegistry(), tabFor());
  return title().value;
};
const flushOne = (registry: RecoverableFormRegistry) => {
  const dirty = registry.dirty();
  expect(dirty).toHaveLength(1);
  return dirty[0]?.flush() as Promise<SaveResult>;
};
const stored = async (port: FormRecoveryPort) =>
  (await port.list(CONTEXT)).map((copy) => copy.values.title);
const copy = (tab: string, value: string, at: string): RecoverySnapshot => ({
  formContext: CONTEXT,
  tabInstanceId: tab,
  values: { title: value },
  savedAt: at,
});

afterEach(() => {
  cleanup();
  handle = null;
});

describe("Q1 (R2): one baseline across a remount", () => {
  test("saves 'one' and 'two', 'three' carried by a remount, its first save moves the baseline, and an edit back to 'two' is dirty", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(port, registry, tab);
    type("one");
    expect(await flushOne(registry)).toBe("saved");
    type("two");
    expect(await flushOne(registry)).toBe("saved");
    expect(registry.dirty()).toHaveLength(0);
    type("three");
    await remount(port, registry, tab);
    expect(title().value).toBe("three");
    expect(registry.all()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual(["three"]);
    expect(registry.dirty()).toHaveLength(0);
    type("two");
    // The baseline is 'three' (what is durable), so 'two' is unsaved input.
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual(["two"]);
    expect(await nextPage(port)).toBe("two");
  });

  test("no remount (control): the same schedule in one mount", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount(port, registry, tabFor());
    type("one");
    await flushOne(registry);
    type("two");
    await flushOne(registry);
    type("three");
    await flushOne(registry);
    type("two");
    expect(registry.dirty()).toHaveLength(1);
    await flushOne(registry);
    expect(await nextPage(port)).toBe("two");
  });

  test("carried input back at the initial value after saves: dirty, and the save discards the copies", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(port, registry, tab);
    type("one");
    await flushOne(registry);
    type("two, unsaved");
    await remount(port, registry, tab);
    type("");
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual([]);
    expect(await nextPage(port)).toBe("");
  });

  test("a submission straight after a remount discards the copies saved by the previous mount", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(port, registry, tab);
    type("saved before");
    await flushOne(registry);
    type("submitted");
    await remount(port, registry, tab);
    expect(await handle?.onSubmitted()).toBe("discarded");
    expect(registry.dirty()).toHaveLength(0);
    expect(await stored(port)).toEqual([]);
  });

  test("the restored copy and the alternatives survive the remount with the input", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(copy("gone-old", "older", "2026-10-01T09:00:00.000Z"));
    await port.save(copy("gone-new", "newer", "2026-10-01T10:00:00.000Z"));
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(port, registry, tab);
    expect(handle?.restored?.tabInstanceId).toBe("gone-new");
    type("newer, edited");
    await remount(port, registry, tab);
    expect(title().value).toBe("newer, edited");
    expect(handle?.restored?.tabInstanceId).toBe("gone-new");
    expect(handle?.alternatives.map((c) => c.tabInstanceId)).toEqual([
      "gone-old",
    ]);
  });
});

describe("a mount resuming its session (revision 2, driver attempt 5)", () => {
  test("is not ready until the copies other tabs left since are known; then it offers them", async () => {
    const store = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    let hold: Promise<void> | null = null;
    const port: FormRecoveryPort = {
      save: (s) => store.save(s),
      load: (c, t) => store.load(c, t),
      discard: (c, t) => store.discard(c, t),
      list: async (c) => {
        if (hold) await hold;
        return store.list(c);
      },
    };
    await mount(port, registry, tab);
    type("mine");
    expect(await flushOne(registry)).toBe("saved");
    await store.save(
      copy("gone-late", "left since", "2099-01-01T00:00:00.000Z"),
    );
    const { opened, open } = gate();
    hold = opened;
    cleanup();
    handle = null;
    render(<Form port={port} registry={registry} tab={tab} />);
    // The input is shown at once; readiness waits for the look.
    expect(title().value).toBe("mine");
    await act(async () => {
      await Promise.resolve();
    });
    // (`tsc` narrows the module-level `handle` to null after the assignment above.)
    const resumed = () => handle as RecoverableForm | null;
    expect(resumed()?.ready).toBe(false);
    await act(async () => open());
    await ready();
    expect(resumed()?.alternatives.map((c) => c.tabInstanceId)).toEqual([
      "gone-late",
    ]);
  });
});

describe("Q2 (R4): a terminal act in any mount overtakes every earlier save", () => {
  test.each(["submission", "discard"] as const)(
    "a save asked for by a mount that has gone, still waiting for the identifier, is overtaken by the next mount's %s",
    async (kind) => {
      const port = new MemoryRecoveryAdapter();
      const registry = createRecoverableFormRegistry();
      const { tab, grant } = heldTab();
      await mount(port, registry, tab);
      type("submitted after remount");
      const pending = flushOne(registry);
      await remount(port, registry, tab);
      expect(title().value).toBe("submitted after remount");
      expect(
        await (kind === "submission"
          ? handle?.onSubmitted()
          : handle?.discard()),
      ).toBe("discarded");
      grant();
      expect(await pending).toBe("failed");
      expect(await stored(port)).toEqual([]);
      expect(registry.dirty()).toHaveLength(0);
      expect(await nextPage(port)).toBe("");
    },
  );

  test("control: the terminal act in the same mount overtakes it too", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const { tab, grant } = heldTab();
    await mount(port, registry, tab);
    type("submitted");
    const pending = flushOne(registry);
    expect(await handle?.onSubmitted()).toBe("discarded");
    grant();
    expect(await pending).toBe("failed");
    expect(await stored(port)).toEqual([]);
  });

  test("an identifier already minted: the next mount's submission, asked before the save resumes, still overtakes it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(port, registry, tab);
    type("first");
    await flushOne(registry);
    type("submitted");
    const pending = flushOne(registry);
    // Synchronously: the remount and the submission come before the save's identifier microtask.
    cleanup();
    handle = null;
    render(<Form port={port} registry={registry} tab={tab} />);
    // (`tsc` narrows the module-level `handle` to null after the assignment above.)
    const submitted = (handle as RecoverableForm | null)?.onSubmitted();
    expect(await pending).toBe("failed");
    expect(await submitted).toBe("discarded");
    expect(await stored(port)).toEqual([]);
  });

  test("a save asked for AFTER the next mount's submission is a new capture and is written", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(port, registry, tab);
    type("one");
    await remount(port, registry, tab);
    await handle?.onSubmitted();
    type("another one");
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual(["another one"]);
  });
});

/** A port whose saves wait until the test releases them, over a memory store (the lower layer reports what it is told). */
const heldSaves = (port: MemoryRecoveryAdapter) => {
  const waiting: Array<() => void> = [];
  let holding = true;
  const held: FormRecoveryPort = {
    save: async (snapshot) => {
      if (holding) await new Promise<void>((resolve) => waiting.push(resolve));
      return port.save(snapshot);
    },
    load: (c, t) => port.load(c, t),
    discard: (c, t) => port.discard(c, t),
    list: (c) => port.list(c),
  };
  return {
    held,
    stop: () => {
      holding = false;
    },
    release: (index: number) => waiting[index]?.(),
  };
};

describe("Q3 (R2 + R4): an older save completing last never moves the baseline back", () => {
  test("the previous mount's save completes after the next mount's: the baseline stays the newer one", async () => {
    const store = new MemoryRecoveryAdapter();
    const { held, stop, release } = heldSaves(store);
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(held, registry, tab);
    type("older");
    const older = flushOne(registry);
    await waitFor(() => expect(tab.current()).not.toBeNull());
    await remount(held, registry, tab);
    type("newer");
    stop();
    const newer = flushOne(registry);
    // The lower layer here answers "saved" for the late older capture too (a store without the port's order): the hook must not believe it.
    expect(await newer).toBe("saved");
    release(0);
    expect(await older).toBe("saved");
    expect(registry.dirty()).toHaveLength(0);
    type("older");
    expect(registry.dirty()).toHaveLength(1);
  });
});

describe("Q4 (DA-1): a look answered after a terminal act restores nothing", () => {
  const slowList = (port: MemoryRecoveryAdapter, wait: Promise<void>) => {
    const slow: FormRecoveryPort = {
      save: (s) => port.save(s),
      load: (c, t) => port.load(c, t),
      discard: (c, t) => port.discard(c, t),
      list: async (c) => {
        await wait;
        return port.list(c);
      },
    };
    return slow;
  };

  test.each(["discard", "submission"] as const)(
    "the list is held, then a %s of the untouched form: the copy found is offered, not put in the form",
    async (kind) => {
      const port = new MemoryRecoveryAdapter();
      await port.save(copy("gone", "obsolete", "2026-10-01T09:00:00.000Z"));
      const { opened, open } = gate();
      const registry = createRecoverableFormRegistry();
      render(
        <Form
          port={slowList(port, opened)}
          registry={registry}
          tab={tabFor()}
        />,
      );
      await act(async () => {
        await (kind === "discard" ? handle?.discard() : handle?.onSubmitted());
      });
      await act(async () => open());
      await ready();
      expect(title().value).toBe("");
      expect(handle?.restored).toBeNull();
      expect(handle?.alternatives.map((c) => c.tabInstanceId)).toEqual([
        "gone",
      ]);
      expect(registry.dirty()).toHaveLength(0);
      // A later deliberate edit is saved as usual.
      type("new input");
      expect(await flushOne(registry)).toBe("saved");
    },
  );

  test("the last owner probe is held, then a discard: nothing is restored", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(copy("gone", "obsolete", "2026-10-01T09:00:00.000Z"));
    const { opened, open } = gate();
    const base = tabFor();
    const tab: RecoveryTab = {
      ...base,
      ownerOpen: async (id) => {
        await opened;
        return base.ownerOpen(id);
      },
    };
    render(
      <Form port={port} registry={createRecoverableFormRegistry()} tab={tab} />,
    );
    await act(async () => {
      await handle?.discard();
    });
    await act(async () => open());
    await ready();
    expect(title().value).toBe("");
    expect(handle?.restored).toBeNull();
  });

  test("control: with no terminal act the held look restores the copy", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(copy("gone", "restorable", "2026-10-01T09:00:00.000Z"));
    const { opened, open } = gate();
    render(
      <Form
        port={slowList(port, opened)}
        registry={createRecoverableFormRegistry()}
        tab={tabFor()}
      />,
    );
    await act(async () => open());
    await ready();
    expect(title().value).toBe("restorable");
    expect(handle?.restored?.tabInstanceId).toBe("gone");
  });
});

describe("Q5 (R3): while an update reload is prepared, the recovery actions are refused", () => {
  const twoCopies = async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(copy("gone-old", "older", "2026-10-01T09:00:00.000Z"));
    await port.save(copy("gone-new", "newer", "2026-10-01T10:00:00.000Z"));
    const registry = createRecoverableFormRegistry();
    await mount(port, registry, tabFor());
    expect(title().value).toBe("newer");
    return { port, registry };
  };

  test("another copy, 'Discard instead' and a new submission change nothing; `locked` says so; the release gives them back", async () => {
    const { port, registry } = await twoCopies();
    expect(handle?.locked).toBe(false);
    // The restored form owes its own copy (revision 5, R13: a restored copy protects nobody): the refused actions below change nothing.
    expect(registry.dirty()).toHaveLength(1);
    let release: () => void = () => undefined;
    act(() => {
      release = registry.freeze();
    });
    expect(handle?.locked).toBe(true);
    // Revision 7 (DA-B): the choice reads the copy again before it is shown; awaited.
    await act(async () => {
      await handle?.restoreAlternative("gone-old");
    });
    expect(title().value).toBe("newer");
    expect(handle?.restored?.tabInstanceId).toBe("gone-new");
    expect(await handle?.discard()).toBe("failed");
    expect(title().value).toBe("newer");
    expect(await stored(port)).toEqual(["newer", "older"]);
    expect(handle?.submitting()).toBeNull();
    // ADAPTED (revision 5, R13). Was `toHaveLength(0)` (the restored copy counted as protection); the intent, "the refused actions made no
    // new work", is the same count as before the freeze.
    expect(registry.dirty()).toHaveLength(1);
    act(() => release());
    expect(handle?.locked).toBe(false);
    // Revision 7 (DA-B): the choice reads the copy again before it is shown; awaited.
    await act(async () => {
      await handle?.restoreAlternative("gone-old");
    });
    expect(title().value).toBe("older");
  });

  test("an alternative chosen BEFORE the freeze is what the update's save keeps", async () => {
    const { port, registry } = await twoCopies();
    // Revision 7 (DA-B): the choice reads the copy again before it is shown; awaited.
    await act(async () => {
      await handle?.restoreAlternative("gone-old");
    });
    let release: () => void = () => undefined;
    act(() => {
      release = registry.freeze();
    });
    expect(await flushOne(registry)).toBe("saved");
    act(() => release());
    expect(await nextPage(port)).toBe("older");
  });
});

describe("Q6 (R3): unfinished work stays in the registry while no mount shows it", () => {
  test("a dirty form between its unmount and its remount is still listed, and can be saved from what it left", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(port, registry, tab);
    type("typed before the gap");
    cleanup();
    handle = null;
    expect(registry.all()).toHaveLength(1);
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(await stored(port)).toEqual(["typed before the gap"]);
    expect(registry.dirty()).toHaveLength(0);
    // Clean, owing nothing and with nothing outstanding: no longer needed.
    expect(registry.all()).toHaveLength(0);
  });

  test("a clean form with a save outstanding is listed (pending) until the save settles", async () => {
    const store = new MemoryRecoveryAdapter();
    const { held, release } = heldSaves(store);
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(held, registry, tab);
    type("saving");
    const saving = flushOne(registry);
    await waitFor(() => expect(tab.current()).not.toBeNull());
    cleanup();
    handle = null;
    expect(registry.pending()).toBe(1);
    expect(registry.all()).toHaveLength(1);
    release(0);
    expect(await saving).toBe("saved");
    await registry.settled();
    expect(registry.pending()).toBe(0);
    expect(registry.all()).toHaveLength(0);
  });

  test("a form mounted again while a freeze stands is held still as it attaches, and its look restores nothing", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(port, registry, tab);
    type("carried while frozen");
    cleanup();
    handle = null;
    const release = registry.freeze();
    await mount(port, registry, tab);
    const form = screen.getByRole("form", { name: "Task" });
    expect(form.hasAttribute("inert")).toBe(true);
    expect(title().value).toBe("carried while frozen");
    release();
    expect(form.hasAttribute("inert")).toBe(false);
  });

  test("a CLEAN form (its input saved) mounted again while a freeze stands shows what was saved and is held still", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(port, registry, tab);
    type("saved before the freeze");
    expect(await flushOne(registry)).toBe("saved");
    const release = registry.freeze();
    cleanup();
    handle = null;
    // Clean and idle: not listed while no mount shows it, but kept for the next mount.
    expect(registry.all()).toHaveLength(0);
    await mount(port, registry, tab);
    expect(title().value).toBe("saved before the freeze");
    expect(
      screen.getByRole("form", { name: "Task" }).hasAttribute("inert"),
    ).toBe(true);
    expect(registry.all()).toHaveLength(1);
    expect(registry.dirty()).toHaveLength(0);
    expect(registry.unheld()).toBe(0);
    release();
  });

  test("a new form whose look answers during a freeze: the copy is offered, the form is not changed", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(
      copy("gone", "would be restored", "2026-10-01T09:00:00.000Z"),
    );
    const registry = createRecoverableFormRegistry();
    const release = registry.freeze();
    await mount(port, registry, tabFor());
    expect(title().value).toBe("");
    expect(handle?.restored).toBeNull();
    expect(handle?.alternatives.map((c) => c.tabInstanceId)).toEqual(["gone"]);
    expect(registry.dirty()).toHaveLength(0);
    release();
  });

  test("a mount with no database yet is listed (dirty when typed) and its save fails honestly", async () => {
    const registry = createRecoverableFormRegistry();
    await mount(null, registry, tabFor());
    expect(registry.all()).toHaveLength(1);
    type("x");
    expect(await flushOne(registry)).toBe("failed");
  });
});

describe("Q7 (R3): a submission sent before an update is waited for", () => {
  test("a submission ticket is outstanding until it settles; its success discards the copies", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount(port, registry, tabFor());
    type("sending");
    await flushOne(registry);
    const ticket = handle?.submitting();
    expect(ticket).not.toBeNull();
    expect(registry.pending()).toBe(1);
    const settled = registry.settled();
    expect(await ticket?.succeeded()).toBe("discarded");
    await settled;
    expect(registry.pending()).toBe(0);
    expect(registry.dirty()).toHaveLength(0);
    expect(await stored(port)).toEqual([]);
  });

  test("a submission that fails leaves the input and its copy", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    await mount(port, registry, tabFor());
    type("not sent");
    await flushOne(registry);
    const ticket = handle?.submitting();
    ticket?.failed();
    await registry.settled();
    expect(registry.pending()).toBe(0);
    expect(await stored(port)).toEqual(["not sent"]);
  });

  test("a ticket outlives a remount: the next mount's registry still waits for it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(port, registry, tab);
    type("sending");
    const ticket = handle?.submitting();
    await remount(port, registry, tab);
    expect(registry.pending()).toBe(1);
    await ticket?.succeeded();
    await registry.settled();
    expect(registry.dirty()).toHaveLength(0);
    expect(await stored(port)).toEqual([]);
  });
});

/** A port over two accounts' stores; `recreate` deletes and creates an account's database again (a new store, a new incarnation). */
const accounts = () => {
  const stores: Record<string, MemoryRecoveryAdapter> = {
    "A:1": new MemoryRecoveryAdapter(),
    "B:1": new MemoryRecoveryAdapter(),
  };
  let account: "A" | "B" = "A";
  const incarnation = { A: 1, B: 1 };
  const scope = () => `${account}:${incarnation[account]}`;
  const live = () => stores[scope()] as MemoryRecoveryAdapter;
  const port: FormRecoveryPort = {
    save: (s) => live().save(s),
    load: (c, t) => live().load(c, t),
    discard: (c, t) => live().discard(c, t),
    list: (c) => live().list(c),
    pin: () => ({ account, scope: scope(), port: live() }),
  };
  return {
    stores,
    port,
    switchTo: (next: "A" | "B") => {
      account = next;
    },
    recreate: (which: "A" | "B") => {
      incarnation[which] += 1;
      stores[`${which}:${incarnation[which]}`] = new MemoryRecoveryAdapter();
    },
  };
};

describe("Q8 (DA-2): a mounted form never writes into another scope", () => {
  test("its account's database is deleted and created again while it stays mounted: nothing is written into the new one", async () => {
    const world = accounts();
    const registry = createRecoverableFormRegistry();
    await mount(world.port, registry, tabFor());
    type("saved in the first database");
    expect(await flushOne(registry)).toBe("saved");
    type("input of the deleted database");
    world.recreate("A");
    expect(await flushOne(registry)).toBe("failed");
    expect(await world.stores["A:2"]?.list(CONTEXT)).toEqual([]);
    // Its copies cannot be reached through the new database: the discard does not claim they are gone.
    expect(await handle?.discard()).toBe("failed");
    expect(await world.stores["A:2"]?.list(CONTEXT)).toEqual([]);
  });

  test("a save asked for before the re-creation lands only in the database it was asked for", async () => {
    const world = accounts();
    const registry = createRecoverableFormRegistry();
    const { tab, grant } = heldTab();
    await mount(world.port, registry, tab);
    type("asked before");
    const pending = flushOne(registry);
    world.recreate("A");
    grant();
    expect(await pending).toBe("saved");
    expect(await world.stores["A:1"]?.list(CONTEXT)).toHaveLength(1);
    expect(await world.stores["A:2"]?.list(CONTEXT)).toEqual([]);
  });

  test("control: a new port for the same database (the same scope) saves", async () => {
    const world = accounts();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const { rerender } = render(
      <Form port={world.port} registry={registry} tab={tab} />,
    );
    await ready();
    const again: FormRecoveryPort = { ...world.port };
    rerender(<Form port={again} registry={registry} tab={tab} />);
    type("same database");
    expect(await flushOne(registry)).toBe("saved");
    expect(await world.stores["A:1"]?.list(CONTEXT)).toHaveLength(1);
  });
});

describe("Q9: an older discard landing late never clears a newer debt", () => {
  test("a submission's discard is held, a later discard fails, then the first lands: copies are still owed", async () => {
    const store = new MemoryRecoveryAdapter();
    const waiting: Array<() => void> = [];
    let hold = true;
    let fail = false;
    const port: FormRecoveryPort = {
      save: (s) => store.save(s),
      load: (c, t) => store.load(c, t),
      list: (c) => store.list(c),
      discard: async (c, t): Promise<DiscardResult> => {
        if (hold) await new Promise<void>((resolve) => waiting.push(resolve));
        if (fail) return "failed";
        return store.discard(c, t);
      },
    };
    const registry = createRecoverableFormRegistry();
    await mount(port, registry, tabFor());
    type("sent");
    await flushOne(registry);
    const first = handle?.onSubmitted();
    hold = false;
    fail = true;
    expect(await handle?.discard()).toBe("failed");
    fail = false;
    waiting[0]?.();
    expect(await first).toBe("discarded");
    expect(registry.dirty()).toHaveLength(1);
    expect(await flushOne(registry)).toBe("saved");
    expect(registry.dirty()).toHaveLength(0);
  });

  test("the identifier cannot be had: the save fails and the input stays", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab: RecoveryTab = {
      id: () => Promise.reject(new Error("no lock")),
      current: () => null,
      ownerOpen: async () => false,
    };
    await mount(port, registry, tab);
    type("kept");
    expect(await flushOne(registry)).toBe("failed");
    expect(title().value).toBe("kept");
    expect(registry.dirty()).toHaveLength(1);
  });
});

describe("Q10: a form bound to another scope retires the sessions of the old one", () => {
  test("another account's form binds: the unsaved input of the first account is dropped, never shown or written there", async () => {
    const world = accounts();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(world.port, registry, tab);
    type("account A's input");
    cleanup();
    handle = null;
    expect(registry.all()).toHaveLength(1);
    world.switchTo("B");
    await mount(world.port, registry, tab);
    expect(title().value).toBe("");
    expect(registry.all()).toHaveLength(1);
    expect(registry.dirty()).toHaveLength(0);
    expect(await world.stores["B:1"]?.list(CONTEXT)).toEqual([]);
  });

  test("the account's database deleted and created again: the old input never reaches the new one", async () => {
    const world = accounts();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(world.port, registry, tab);
    type("before the deletion");
    cleanup();
    handle = null;
    world.recreate("A");
    await mount(world.port, registry, tab);
    expect(title().value).toBe("");
    expect(registry.dirty()).toHaveLength(0);
    expect(await world.stores["A:2"]?.list(CONTEXT)).toEqual([]);
  });
  test("after another account's form, the same form mounted again for the first account restores this page's own copy first", async () => {
    const world = accounts();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    await mount(world.port, registry, tab);
    type("mine");
    expect(await flushOne(registry)).toBe("saved");
    // A gone tab's copy, newer than this page's own.
    await world.stores["A:1"]?.save(
      copy("gone-1", "older tab", "2099-01-01T00:00:00.000Z"),
    );
    world.switchTo("B");
    await remount(world.port, registry, tab);
    world.switchTo("A");
    await remount(world.port, registry, tab);
    expect(title().value).toBe("mine");
    expect(handle?.alternatives.map((c) => c.tabInstanceId)).toEqual([
      "gone-1",
    ]);
  });
});
