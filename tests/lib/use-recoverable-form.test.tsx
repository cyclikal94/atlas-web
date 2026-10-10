import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
import type { FormRecoveryPort } from "../../src/lib/form-recovery/port";
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
 * WEB-14a D-P6/D-P7: the recoverable-form contract. Dirty tracking; the recovery identifier is minted at the FIRST SAVE (not at load, and
 * never in sessionStorage); restore of the newest copy left by a tab that has gone, never another open tab's; the copy restored from is
 * discarded once this page's own copy is saved; a submission or "Discard instead" discards both; sensitive fields are never captured.
 * FIXTURE evidence over the memory adapter; the real store in three engines is P-U3/P-U5 (`fixture.pwa-forms.spec.ts`).
 */
const ALLOW = [{ name: "title" }, { name: "notes" }];
/** A form that (wrongly) allow-lists its password field. */
const WITH_PASSWORD = [...ALLOW, { name: "password" }];
const CONTEXT = "task-edit:/tasks/1";

let handle: RecoverableForm | null = null;
function Form({
  allow = ALLOW,
  ...props
}: {
  port: FormRecoveryPort | null;
  registry: RecoverableFormRegistry;
  tab: RecoveryTab;
  allow?: typeof WITH_PASSWORD;
}) {
  const ref = useRef<HTMLFormElement>(null);
  handle = useRecoverableForm({
    formContext: CONTEXT,
    allow,
    formRef: ref,
    ...props,
  });
  return (
    <form ref={ref} aria-label="Task">
      <input name="title" aria-label="Title" defaultValue="" />
      <textarea name="notes" aria-label="Notes" defaultValue="" />
      <input name="password" type="password" aria-label="Password" />
      {handle.restored ? (
        <p>restored from {handle.restored.tabInstanceId}</p>
      ) : null}
    </form>
  );
}

let counter = 0;
const tabFor = (open: Set<string> = new Set()) => {
  const tab = createRecoveryTab({
    uuid: () => `tab-${++counter}`,
    locks: null,
  });
  return {
    ...tab,
    ownerOpen: async (id: string) => id === tab.current() || open.has(id),
  } satisfies RecoveryTab;
};
const type = (label: string, value: string) => {
  const field = screen.getByLabelText(label) as HTMLInputElement;
  act(() => {
    field.value = value;
  });
};
const snapshot = (tab: string, title: string, at: string) => ({
  formContext: CONTEXT,
  tabInstanceId: tab,
  values: { title, notes: "" },
  savedAt: at,
});

afterEach(() => {
  cleanup();
  handle = null;
});

describe("dirty tracking and saving", () => {
  test("clean at mount; dirty after an edit; the identifier is minted at the first save, not at load", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    render(<Form port={port} registry={registry} tab={tab} />);
    await waitFor(() => expect(handle?.ready).toBe(true));
    expect(registry.all()).toHaveLength(1);
    expect(registry.dirty()).toHaveLength(0);
    expect(tab.current()).toBeNull();
    type("Title", "Half-written");
    expect(registry.dirty()).toHaveLength(1);
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    const id = tab.current();
    expect(id).not.toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect((await port.load(CONTEXT, id as string))?.values.title).toBe(
      "Half-written",
    );
    // The same page keeps its identifier for later saves.
    type("Title", "More");
    await registry.dirty()[0]?.flush();
    expect(tab.current()).toBe(id);
  });

  test("a sensitive field is never captured: an allow-listed password makes the save fail in development (the guard's strict mode), and nothing is stored", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    render(
      <Form
        port={port}
        registry={registry}
        tab={tabFor()}
        allow={WITH_PASSWORD}
      />,
    );
    type("Title", "x");
    type("Password", "hunter2");
    await act(async () => {
      expect(await registry.dirty()[0]?.flush()).toBe("failed");
    });
    expect(await port.list(CONTEXT)).toEqual([]);
  });

  test("a password field outside the allow-list is never captured", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    render(<Form port={port} registry={registry} tab={tabFor()} />);
    type("Title", "x");
    type("Password", "hunter2");
    await act(async () => {
      expect(await registry.dirty()[0]?.flush()).toBe("saved");
    });
    const [copy] = await port.list(CONTEXT);
    expect(copy?.values).toEqual({ title: "x", notes: "" });
  });

  test("no port (no open database): the save fails honestly", async () => {
    const registry = createRecoverableFormRegistry();
    render(<Form port={null} registry={registry} tab={tabFor()} />);
    type("Title", "x");
    expect(await registry.dirty()[0]?.flush()).toBe("failed");
  });

  test("unregistered when unmounted", () => {
    const registry = createRecoverableFormRegistry();
    const { unmount } = render(
      <Form port={null} registry={registry} tab={tabFor()} />,
    );
    expect(registry.all()).toHaveLength(1);
    unmount();
    expect(registry.all()).toHaveLength(0);
  });
});

describe("restore after a reload", () => {
  test("the newest copy left by a gone tab is restored (never submitted); the others are alternatives; an open tab's copy is left alone", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("old-1", "older", "2026-10-01T09:00:00.000Z"));
    await port.save(snapshot("old-2", "newest", "2026-10-01T10:00:00.000Z"));
    await port.save(
      snapshot("open-3", "still editing", "2026-10-01T11:00:00.000Z"),
    );
    const registry = createRecoverableFormRegistry();
    render(
      <Form
        port={port}
        registry={registry}
        tab={tabFor(new Set(["open-3"]))}
      />,
    );
    await waitFor(() => expect(handle?.ready).toBe(true));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "newest",
    );
    expect(handle?.restored?.tabInstanceId).toBe("old-2");
    expect(handle?.alternatives.map((c) => c.tabInstanceId)).toEqual(["old-1"]);
    // A restored form is not dirty until it is edited.
    expect(registry.dirty()).toHaveLength(0);
    // The alternative can be chosen instead.
    act(() => handle?.restoreAlternative("old-1"));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "older",
    );
    expect(handle?.alternatives.map((c) => c.tabInstanceId)).toEqual(["old-2"]);
  });

  test("after this page's own copy is saved, the copy it was restored from is discarded once", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("old-1", "before", "2026-10-01T09:00:00.000Z"));
    const registry = createRecoverableFormRegistry();
    render(<Form port={port} registry={registry} tab={tabFor()} />);
    await waitFor(() => expect(handle?.restored).not.toBeNull());
    type("Title", "before and after");
    await act(async () => {
      expect(await registry.dirty()[0]?.flush()).toBe("saved");
    });
    const listed = await port.list(CONTEXT);
    expect(listed.map((c) => c.values.title)).toEqual(["before and after"]);
  });

  test("a failed own save does not discard the restored-from copy", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("old-1", "before", "2026-10-01T09:00:00.000Z"));
    const registry = createRecoverableFormRegistry();
    render(<Form port={port} registry={registry} tab={tabFor()} />);
    await waitFor(() => expect(handle?.restored).not.toBeNull());
    port.failSaves = true;
    type("Title", "x");
    await act(async () => {
      expect(await registry.dirty()[0]?.flush()).toBe("failed");
    });
    expect((await port.list(CONTEXT)).map((c) => c.tabInstanceId)).toEqual([
      "old-1",
    ]);
  });

  test("submission discards both copies", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("old-1", "before", "2026-10-01T09:00:00.000Z"));
    const registry = createRecoverableFormRegistry();
    render(<Form port={port} registry={registry} tab={tabFor()} />);
    await waitFor(() => expect(handle?.restored).not.toBeNull());
    port.failSaves = true;
    type("Title", "x");
    await registry.dirty()[0]?.flush();
    port.failSaves = false;
    type("Title", "y");
    await registry.dirty()[0]?.flush();
    await act(async () => {
      await handle?.onSubmitted();
    });
    expect(await port.list(CONTEXT)).toEqual([]);
    expect(registry.dirty()).toHaveLength(0);
  });

  test("'Discard instead' discards the copies and puts back what the form showed before the restore", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("old-1", "before", "2026-10-01T09:00:00.000Z"));
    render(
      <Form
        port={port}
        registry={createRecoverableFormRegistry()}
        tab={tabFor()}
      />,
    );
    await waitFor(() => expect(handle?.restored).not.toBeNull());
    await act(async () => {
      await handle?.discard();
    });
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
    expect(handle?.restored).toBeNull();
    expect(await port.list(CONTEXT)).toEqual([]);
  });
});

describe("remounts and typed input", () => {
  test("a form mounted again in the SAME page restores this page's own copy first (another page's boot remounts the tree)", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor(new Set(["open-other"]));
    const { unmount } = render(
      <Form port={port} registry={registry} tab={tab} />,
    );
    await waitFor(() => expect(handle?.ready).toBe(true));
    type("Title", "mine");
    await act(async () => {
      expect(await registry.dirty()[0]?.flush()).toBe("saved");
    });
    // A gone tab's copy, newer than this page's own.
    await port.save(
      snapshot("gone-1", "older tab", "2099-01-01T00:00:00.000Z"),
    );
    await port.save(
      snapshot("open-other", "open tab", "2099-01-02T00:00:00.000Z"),
    );
    unmount();
    render(<Form port={port} registry={registry} tab={tab} />);
    await waitFor(() => expect(handle?.ready).toBe(true));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "mine",
    );
    expect(handle?.alternatives.map((c) => c.tabInstanceId)).toEqual([
      "gone-1",
    ]);
  });

  test("a copy is never restored over input typed before the look finished; it is offered instead", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("gone-1", "saved", "2026-10-01T09:00:00.000Z"));
    // The look's gate is made up front (revision 1: the look now first waits for any save of the form's previous mount, one microtask, so
    // a gate made inside `list` was released before it existed); what is typed still lands before the look finishes.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: FormRecoveryPort = {
      ...port,
      save: (s) => port.save(s),
      load: (c, t) => port.load(c, t),
      discard: (c, t) => port.discard(c, t),
      list: async (c) => {
        await gate;
        return port.list(c);
      },
    };
    render(
      <Form
        port={slow}
        registry={createRecoverableFormRegistry()}
        tab={tabFor()}
      />,
    );
    type("Title", "typed meanwhile");
    await act(async () => release());
    await waitFor(() => expect(handle?.ready).toBe(true));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "typed meanwhile",
    );
    expect(handle?.restored).toBeNull();
    expect(handle?.alternatives.map((c) => c.tabInstanceId)).toEqual([
      "gone-1",
    ]);
  });

  test("the look is made once per mount: a new port (the store bound again) restores nothing more", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = createRecoverableFormRegistry();
    const tab = tabFor();
    const { rerender } = render(
      <Form port={port} registry={registry} tab={tab} />,
    );
    await waitFor(() => expect(handle?.ready).toBe(true));
    type("Title", "typing");
    await port.save(
      snapshot("gone-2", "late copy", "2099-01-01T00:00:00.000Z"),
    );
    const again = new MemoryRecoveryAdapter();
    await again.save(
      snapshot("gone-2", "late copy", "2099-01-01T00:00:00.000Z"),
    );
    rerender(<Form port={again} registry={registry} tab={tab} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "typing",
    );
    // No second look was made: nothing more is offered either.
    expect(handle?.alternatives).toEqual([]);
  });
});

describe("the recovery identifier and its owner lock", () => {
  test("two pages never share an identifier; an open owner's lock is held, a gone owner's is free", async () => {
    const held = new Set<string>();
    const locks = {
      request: async (
        name: string,
        options: { ifAvailable?: boolean },
        callback: (lock: unknown) => unknown,
      ) => {
        if (options.ifAvailable && held.has(name)) return callback(null);
        if (!options.ifAvailable) held.add(name);
        return callback({ name });
      },
    } as unknown as Pick<LockManager, "request">;
    let n = 0;
    const a = createRecoveryTab({ uuid: () => `id-${++n}`, locks });
    const b = createRecoveryTab({ uuid: () => `id-${++n}`, locks });
    const idA = await a.id();
    const idB = await b.id();
    expect(idA).not.toBe(idB);
    expect(await b.ownerOpen(idA)).toBe(true);
    expect(await b.ownerOpen("id-gone")).toBe(false);
    expect(await a.ownerOpen(idA)).toBe(true);
  });
});

/** The next page of the same tab (a reload): a new identifier, the same store; the previous page's copies belong to a gone tab. */
const nextPage = async (port: FormRecoveryPort) => {
  cleanup();
  handle = null;
  render(
    <Form
      port={port}
      registry={createRecoverableFormRegistry()}
      tab={tabFor()}
    />,
  );
  await waitFor(() => expect(handle?.ready).toBe(true));
  return (screen.getByLabelText("Title") as HTMLInputElement).value;
};
const mounted = async (port: FormRecoveryPort, tab: RecoveryTab = tabFor()) => {
  const registry = createRecoverableFormRegistry();
  render(<Form port={port} registry={registry} tab={tab} />);
  await waitFor(() => expect(handle?.ready).toBe(true));
  return registry;
};

/**
 * Revision 1, R2: a form is dirty when a reload would not bring back what it shows. Revision 0 compared only with the mount (or restore)
 * values, so a form returned to them after a save looked clean and the next page restored the obsolete copy.
 */
describe("dirty means: a reload would not bring back what the form shows (R2)", () => {
  test("mount baseline: saved, then cleared back to the mount value: dirty, and the flush leaves nothing to restore", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = await mounted(port);
    type("Title", "stale proactive copy");
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    expect(registry.dirty()).toHaveLength(0);
    type("Title", "");
    expect(registry.dirty()).toHaveLength(1);
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    expect(registry.dirty()).toHaveLength(0);
    expect(await port.list(CONTEXT)).toEqual([]);
    expect(await nextPage(port)).toBe("");
    expect(handle?.restored).toBeNull();
  });

  test("restore baseline: restored X, saved Y, back to X: dirty, and the next page restores X (not Y)", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("gone", "X", "2026-10-01T09:00:00.000Z"));
    const registry = await mounted(port);
    expect(handle?.restored?.tabInstanceId).toBe("gone");
    expect(registry.dirty()).toHaveLength(0);
    type("Title", "Y");
    // The save another tab's accepted update asks for (a peer flush).
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    type("Title", "X");
    expect(registry.dirty()).toHaveLength(1);
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    expect(await nextPage(port)).toBe("X");
  });

  test("restore baseline: restored X, then cleared back to the mount value: dirty, and the next page shows it empty", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("gone", "X", "2026-10-01T09:00:00.000Z"));
    const registry = await mounted(port);
    expect(registry.dirty()).toHaveLength(0);
    type("Title", "");
    expect(registry.dirty()).toHaveLength(1);
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    expect(await port.list(CONTEXT)).toEqual([]);
    expect(await nextPage(port)).toBe("");
  });

  test("an alternative chosen instead of the newest copy is dirty until this page has saved it", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("older", "A", "2026-10-01T09:00:00.000Z"));
    await port.save(snapshot("newer", "B", "2026-10-01T10:00:00.000Z"));
    const registry = await mounted(port);
    expect(handle?.restored?.tabInstanceId).toBe("newer");
    act(() => handle?.restoreAlternative("older"));
    expect(registry.dirty()).toHaveLength(1);
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    expect(registry.dirty()).toHaveLength(0);
    expect(await nextPage(port)).toBe("A");
  });
});

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

/**
 * Revision 1, R4: a flush takes its place in the order when it is ASKED FOR. A submission or discard asked for while the flush waits for the
 * page's identifier overtakes it, and the flush then writes nothing: it can never bring back input submitted or discarded after it was asked.
 */
describe("a capture overtaken by a submission or a discard is never written (R4)", () => {
  test.each(["submission", "discard"] as const)(
    "first identifier still being granted, then a %s: the pending flush fails and nothing can be restored",
    async (kind) => {
      const port = new MemoryRecoveryAdapter();
      const { tab, grant } = heldTab();
      const registry = await mounted(port, tab);
      type("Title", "already submitted input");
      const pending = registry.dirty()[0]?.flush();
      expect(
        await (kind === "submission"
          ? handle?.onSubmitted()
          : handle?.discard()),
      ).toBe("discarded");
      grant();
      expect(await pending).toBe("failed");
      expect(await port.list(CONTEXT)).toEqual([]);
      expect(await nextPage(port)).toBe("");
    },
  );

  test("an identifier already minted: a submission asked right after the flush still overtakes it", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = await mounted(port);
    type("Title", "first");
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    type("Title", "submitted");
    const pending = registry.dirty()[0]?.flush();
    const submitted = handle?.onSubmitted();
    expect(await pending).toBe("failed");
    expect(await submitted).toBe("discarded");
    expect(await port.list(CONTEXT)).toEqual([]);
  });

  test("a form unmounted while its first flush waits (a remount) still saves: the copy is the page's own latest input", async () => {
    const port = new MemoryRecoveryAdapter();
    const { tab, grant } = heldTab();
    const registry = await mounted(port, tab);
    type("Title", "typed before the remount");
    const pending = registry.dirty()[0]?.flush();
    cleanup();
    grant();
    expect(await pending).toBe("saved");
    expect((await port.list(CONTEXT))[0]?.values.title).toBe(
      "typed before the remount",
    );
  });

  test("a flush asked for AFTER a submission is a new capture and is written", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = await mounted(port);
    type("Title", "one");
    await registry.dirty()[0]?.flush();
    await handle?.onSubmitted();
    type("Title", "another one");
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    expect((await port.list(CONTEXT))[0]?.values.title).toBe("another one");
  });
});

/**
 * Revision 1, R6: a discard says what it did. A discard that did not land leaves the copies owed: the form counts as dirty, and the next
 * flush (an update's save) discards them before anything reloads.
 */
describe("a discard answers what it did, and a failed one is owed (R6)", () => {
  test("submission whose discard fails: `failed`, the form stays dirty, and the next flush discards", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = await mounted(port);
    type("Title", "sent");
    await registry.dirty()[0]?.flush();
    port.failDiscards = true;
    expect(await handle?.onSubmitted()).toBe("failed");
    expect(registry.dirty()).toHaveLength(1);
    expect(await registry.dirty()[0]?.flush()).toBe("failed");
    port.failDiscards = false;
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    expect(registry.dirty()).toHaveLength(0);
    expect(await port.list(CONTEXT)).toEqual([]);
  });

  test("'Discard instead' whose discard fails: `failed`, owed, and discarded by the next flush", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("gone", "X", "2026-10-01T09:00:00.000Z"));
    const registry = await mounted(port);
    port.failDiscards = true;
    expect(await handle?.discard()).toBe("failed");
    expect(registry.dirty()).toHaveLength(1);
    port.failDiscards = false;
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    expect(await port.list(CONTEXT)).toEqual([]);
  });

  test("the registry's discard ('Discard and reload anyway') discards this page's copy and the one it was restored from", async () => {
    const port = new MemoryRecoveryAdapter();
    await port.save(snapshot("gone", "X", "2026-10-01T09:00:00.000Z"));
    const registry = await mounted(port);
    type("Title", "Y");
    await registry.dirty()[0]?.flush();
    type("Title", "Z, not saved");
    const form = registry.dirty()[0];
    expect(await form?.discard?.()).toBe("discarded");
    expect(await port.list(CONTEXT)).toEqual([]);
    expect(await nextPage(port)).toBe("");
  });

  test("refused while signing out", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = await mounted(port);
    type("Title", "x");
    await registry.dirty()[0]?.flush();
    port.refuseSaves = true;
    expect(await handle?.onSubmitted()).toBe("refused");
  });
});

describe("the freeze (R3)", () => {
  test("a frozen form is inert and busy until released; a form that registers during a freeze is frozen too", async () => {
    const port = new MemoryRecoveryAdapter();
    const registry = await mounted(port);
    const form = screen.getByRole("form", { name: "Task" }) as HTMLFormElement;
    const release = registry.freeze();
    expect(form.hasAttribute("inert")).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");
    release();
    expect(form.hasAttribute("inert")).toBe(false);
    expect(form.hasAttribute("aria-busy")).toBe(false);
    const again = registry.freeze();
    cleanup();
    handle = null;
    render(<Form port={port} registry={registry} tab={tabFor()} />);
    const late = screen.getByRole("form", { name: "Task" }) as HTMLFormElement;
    expect(late.hasAttribute("inert")).toBe(true);
    again();
    expect(late.hasAttribute("inert")).toBe(false);
  });
});

/** A port over two accounts' stores: `pin` answers the account it reaches NOW (as the data layer's port does). */
const twoAccounts = () => {
  const stores = {
    A: new MemoryRecoveryAdapter(),
    B: new MemoryRecoveryAdapter(),
  };
  let now: "A" | "B" = "A";
  // The database's incarnation, per account: a deletion and re-creation is a new scope.
  const incarnation = { A: 1, B: 1 };
  const port: FormRecoveryPort = {
    save: (s) => stores[now].save(s),
    load: (c, t) => stores[now].load(c, t),
    discard: (c, t) => stores[now].discard(c, t),
    list: (c) => stores[now].list(c),
    pin: () => ({
      account: now,
      scope: `${now}:${incarnation[now]}`,
      port: stores[now],
    }),
  };
  return {
    stores,
    port,
    switchTo: (next: "A" | "B") => (now = next),
    recreate: (account: "A" | "B") => (incarnation[account] += 1),
  };
};

/**
 * Revision 1, finding F-1 (reassessed): another page's boot remounts the protected tree. A form that unmounts dirty saves a copy from the
 * element it leaves behind, and the form mounted again in its place restores it once that save has landed.
 */
describe("a remount keeps the unsaved input (F-1)", () => {
  const remount = async (
    port: FormRecoveryPort,
    registry: RecoverableFormRegistry,
    tab: RecoveryTab,
  ) => {
    cleanup();
    handle = null;
    render(<Form port={port} registry={registry} tab={tab} />);
    await waitFor(() => expect(handle?.ready).toBe(true));
    return (screen.getByLabelText("Title") as HTMLInputElement).value;
  };

  test("a dirty form that unmounts leaves its input (memory only) to the form mounted again in the same page, which is still dirty", async () => {
    const { stores, port } = twoAccounts();
    const tab = tabFor();
    const registry = await mounted(port, tab);
    type("Title", "typed, never saved");
    expect(await remount(port, registry, tab)).toBe("typed, never saved");
    // Nothing was written while the tree was torn down; the form still needs saving before a reload.
    expect(await stores.A.list(CONTEXT)).toEqual([]);
    expect(registry.dirty()).toHaveLength(1);
    expect(await registry.dirty()[0]?.flush()).toBe("saved");
    expect((await stores.A.list(CONTEXT))[0]?.values.title).toBe(
      "typed, never saved",
    );
  });

  test("a clean form that unmounts leaves nothing; its saved copy is restored as before", async () => {
    const { port } = twoAccounts();
    const tab = tabFor();
    const registry = await mounted(port, tab);
    type("Title", "saved first");
    await registry.dirty()[0]?.flush();
    expect(await remount(port, registry, tab)).toBe("saved first");
    expect(registry.dirty()).toHaveLength(0);
  });

  test("never to another account, nor to the account's database deleted and created again since", async () => {
    const { port, switchTo, recreate } = twoAccounts();
    const tab = tabFor();
    let registry = await mounted(port, tab);
    type("Title", "account A's input");
    switchTo("B");
    expect(await remount(port, registry, tab)).toBe("");
    switchTo("A");
    registry = await (async () => {
      cleanup();
      handle = null;
      return mounted(port, tab);
    })();
    type("Title", "before a sign-out");
    recreate("A");
    expect(await remount(port, registry, tab)).toBe("");
  });
});

/** Revision 1: a write is pinned to the account it reaches when it is asked for, and never made for another account than the form's. */
describe("never into another account", () => {
  test("the displayed account changed under the form: its flush writes nothing anywhere", async () => {
    const { stores, port, switchTo } = twoAccounts();
    const registry = await mounted(port);
    type("Title", "account A's input");
    switchTo("B");
    expect(await registry.dirty()[0]?.flush()).toBe("failed");
    expect(await stores.A.list(CONTEXT)).toEqual([]);
    expect(await stores.B.list(CONTEXT)).toEqual([]);
  });

  test("the account changes while the first save waits for its identifier: the copy lands in the form's account only", async () => {
    const { stores, port, switchTo } = twoAccounts();
    const { tab, grant } = heldTab();
    const registry = await mounted(port, tab);
    type("Title", "account A's input");
    const pending = registry.dirty()[0]?.flush();
    switchTo("B");
    grant();
    expect(await pending).toBe("saved");
    expect((await stores.A.list(CONTEXT))[0]?.values.title).toBe(
      "account A's input",
    );
    expect(await stores.B.list(CONTEXT)).toEqual([]);
  });
});
