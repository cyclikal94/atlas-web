import {
  act,
  cleanup,
  type RenderResult,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  forgetHandoff,
  HANDOFF_PREFIX,
  type HandoffStore,
  handoffContext,
  prepareHandoffs,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
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
  handoffLockName,
  type RecoveryTab,
} from "../../src/lib/form-recovery/tab-identity";
import {
  isHandoff,
  type RecoverableForm,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";

/**
 * WEB-14a revision 6 (review of 11 October 2026, R13 `recovery-shared-source-reload-coverage`, incomplete fix; design assessment of 11
 * October 2026, invariants 1-11 and the caller/schedule matrix; owner decision of 12 October 2026: "protected hand-off", an abandoned
 * hand-off "revealed, can't be removed"). A = the page that updates, A2 = the next page of the SAME tab, C/D = other tabs. Each case forces
 * its order by what it does when (a page reads when it mounts; held port calls), never by time, and asserts the decisive outcome: what A2
 * shows, which copies the store holds (by where they are stored), and who may remove what.
 *
 * The pages run the REAL recovery identity (`createRecoveryTab`) over one shared lock manager double that releases a page's locks when it
 * leaves (as a browser does at unload), and each TAB has its own session storage (a reload keeps it; a duplicated tab copies it). The store
 * is the memory adapter (no native ordering): the real store, Web Locks, `sessionStorage` and the worker update are the
 * `fixture.pwa-forms.spec.ts` revision-6 cases and the native hand-off probe in three engines. FIXTURE evidence.
 */
const A = "task-edit:/tasks/41";
const TITLE: readonly RecoverableFieldSpec[] = [{ name: "title" }];
const ORIGINAL = "ORIGINAL UNSENT";
const THIRD = "THIRD PAGE DIFFERENT";

/** A Web Locks double shared by every page of the test: exclusive locks, `ifAvailable`, `signal`, released when the holder leaves. */
class Locks {
  readonly held = new Map<string, string>();
  private waiting: Array<{ name: string; wake: () => void }> = [];
  /** Lock names whose requests are refused (the lock manager throws). */
  refuse: (name: string) => boolean = () => false;
  forPage(page: string): Pick<LockManager, "request"> {
    return {
      request: ((
        name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) => this.request(page, name, options, callback)) as never,
    };
  }
  private async request(
    page: string,
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<unknown>,
  ): Promise<unknown> {
    if (this.refuse(name))
      throw new DOMException("refused", "InvalidStateError");
    while (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve, reject) => {
        const entry = { name, wake: resolve };
        this.waiting.push(entry);
        options.signal?.addEventListener("abort", () => {
          this.waiting = this.waiting.filter((other) => other !== entry);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    this.held.set(name, page);
    const result = callback({ name, mode: "exclusive" } as Lock);
    void Promise.resolve(result).then(
      () => this.release(name, page),
      () => this.release(name, page),
    );
    return result;
  }
  private release(name: string, page: string): void {
    if (this.held.get(name) !== page) return;
    this.held.delete(name);
    const next = this.waiting.find((entry) => entry.name === name);
    if (next) {
      this.waiting = this.waiting.filter((entry) => entry !== next);
      next.wake();
    }
  }
  /** The page goes: every lock it holds is released. */
  leave(page: string): void {
    for (const [name, holder] of [...this.held])
      if (holder === page) this.release(name, page);
  }
}

/** A tab's session storage (a `Storage` double); `failing` makes every write throw. */
class TabStorage {
  readonly items = new Map<string, string>();
  failing = false;
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failing) throw new DOMException("full", "QuotaExceededError");
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failing) throw new DOMException("full", "QuotaExceededError");
    this.items.delete(key);
  }
  /** A duplicated (or opener-copied) tab: a copy of this tab's session storage. */
  copy(): TabStorage {
    const twin = new TabStorage();
    for (const [key, value] of this.items) twin.items.set(key, value);
    return twin;
  }
}

class World {
  readonly locks = new Locks();
  readonly store = new MemoryRecoveryAdapter();
  private pages = 0;
  page(name: string, storage = new TabStorage()): Page {
    this.pages += 1;
    return new Page(this, `${name}-${this.pages}`, storage);
  }
  /** The copies the store holds, as [where, id, title], ordinary copies and hand-offs. */
  async rows(): Promise<Array<[string, string, string | undefined]>> {
    const all = [
      ...(await this.store.list(A)),
      ...(await this.store.list(handoffContext(A))),
    ];
    return all.map((copy) => [
      copy.formContext === A ? "ordinary" : "handoff",
      copy.tabInstanceId,
      copy.values.title,
    ]);
  }
  async handoffs(): Promise<RecoverySnapshot[]> {
    return [...(await this.store.list(handoffContext(A)))];
  }
}

function Form({ page }: { page: Page }) {
  const ref = useRef<HTMLFormElement>(null);
  page.handle = useRecoverableForm({
    formContext: A,
    allow: TITLE,
    formRef: ref,
    port: page.port,
    registry: page.registry,
    tab: page.tab,
    handoffs: page.handoffs,
  });
  return (
    <form ref={ref} aria-label="Task">
      <input name="title" aria-label="Title" defaultValue="" />
    </form>
  );
}

class Page {
  readonly registry: RecoverableFormRegistry = createRecoverableFormRegistry();
  readonly tab: RecoveryTab;
  readonly handoffs: HandoffStore;
  port: FormRecoveryPort;
  handle: RecoverableForm | null = null;
  private view: RenderResult | null = null;
  private counter = 0;
  constructor(
    readonly world: World,
    readonly name: string,
    readonly storage: TabStorage,
  ) {
    this.port = world.store;
    this.tab = createRecoveryTab({
      uuid: () => `${name}-id-${++this.counter}`,
      locks: world.locks.forPage(name),
    });
    this.handoffs = storageHandoffs(() => storage as unknown as Storage);
  }
  async mount(timeout = 1_000): Promise<this> {
    this.view = render(<Form page={this} />);
    await waitFor(() => expect(this.handle?.ready).toBe(true), { timeout });
    return this;
  }
  get title(): string {
    return (
      within(this.view?.container as HTMLElement).getByLabelText(
        "Title",
      ) as HTMLInputElement
    ).value;
  }
  type(value: string): void {
    act(() => {
      const element = within(
        this.view?.container as HTMLElement,
      ).getByLabelText("Title") as HTMLInputElement;
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async flush(): Promise<SaveResult[]> {
    let results: SaveResult[] = [];
    await act(async () => {
      results = await flushDirty(this.registry);
    });
    return results;
  }
  /** "Save and reload" as the coordinator makes it: the saves, then the hand-offs. */
  async update(): Promise<SaveResult[]> {
    const saved = await this.flush();
    let handed: SaveResult[] = [];
    await act(async () => {
      handed = await prepareHandoffs(this.registry);
    });
    return [...saved, ...handed];
  }
  /** The form is unmounted; the page stays. */
  leaveMountOnly(): void {
    this.view?.unmount();
    this.view = null;
  }
  /** The page goes (unload): unmounted, and its locks released by the browser. */
  leave(): void {
    this.view?.unmount();
    this.view = null;
    this.world.locks.leave(this.name);
  }
  dirty(): number {
    return this.registry.dirty().length;
  }
  handedOff(): boolean {
    return this.registry.all().every((handle) => handle.handedOff?.() ?? true);
  }
}

/** A typed ORIGINAL, saved it, prepared its update (the hand-off) and went; the next page of its tab is not loaded yet. */
async function updated(
  world: World,
): Promise<{ a: Page; storage: TabStorage }> {
  const storage = new TabStorage();
  const a = await world.page("A", storage).mount();
  a.type(ORIGINAL);
  expect(await a.update()).toEqual(["saved", "saved"]);
  expect(a.handedOff()).toBe(true);
  a.leave();
  return { a, storage };
}

afterEach(() => {
  cleanup();
});

describe("R13: the next page of the tab restores the update's input, whatever another tab did with the copies meanwhile", () => {
  type Act = {
    name: string;
    control?: boolean;
    run(c: Page): Promise<void>;
    /** What C shows afterwards. */
    shows: string;
    /** How many ordinary copies hold ORIGINAL once A2 has saved its own (A2's, and C's own copy when C saved it unchanged). */
    copies: number;
  };
  const acts: Act[] = [
    {
      name: "no other tab",
      control: true,
      run: async () => undefined,
      shows: "",
      copies: 1,
    },
    {
      name: "C restores only",
      control: true,
      run: async () => undefined,
      shows: ORIGINAL,
      copies: 1,
    },
    {
      name: "C saves it unchanged",
      run: async (c) => {
        expect(await c.flush()).toEqual(["saved"]);
      },
      shows: ORIGINAL,
      copies: 2,
    },
    {
      name: "C saves different input",
      run: async (c) => {
        c.type(THIRD);
        expect(await c.flush()).toEqual(["saved"]);
      },
      shows: THIRD,
      copies: 1,
    },
    {
      name: "C discards it ('Discard instead')",
      run: async (c) => {
        let result: string | undefined;
        await act(async () => {
          result = await c.handle?.discard();
        });
        expect(result).toBe("discarded");
      },
      shows: "",
      copies: 1,
    },
    {
      name: "C's submission of it succeeds",
      run: async (c) => {
        const ticket = c.handle?.submitting();
        let result: string | undefined;
        await act(async () => {
          result = await ticket?.succeeded();
        });
        expect(result).toBe("discarded");
      },
      shows: ORIGINAL,
      copies: 1,
    },
    {
      name: "C clears it back to the clean value, then saves (the copies are discarded)",
      run: async (c) => {
        c.type("");
        expect(await c.flush()).toEqual(["saved"]);
      },
      shows: "",
      copies: 1,
    },
  ];
  for (const step of acts)
    test(`${step.control ? "control: " : ""}A updates; ${step.name} before A2 reads; A2 restores ORIGINAL; C keeps its own`, async () => {
      const world = new World();
      const { storage } = await updated(world);
      const handoff = (await world.handoffs())[0];
      expect(handoff?.values).toEqual({ title: ORIGINAL });
      let c: Page | null = null;
      if (step.name !== "no other tab") {
        c = await world.page("C").mount();
        // C restores the ordinary copy A left (a gone tab's), never the hand-off (it is not listed as C's form).
        expect(c.title).toBe(ORIGINAL);
        await step.run(c);
        expect(c.title).toBe(step.shows);
      }
      // Whatever C did, the hand-off is still there, untouched.
      expect(await world.handoffs()).toEqual([handoff]);
      const a2 = await world.page("A2", storage).mount();
      expect(a2.title).toBe(ORIGINAL);
      expect(a2.handle?.restored?.formContext).toBe(handoffContext(A));
      // Nothing was submitted; A2 is dirty until it has a copy of its own (the hand-off is its source).
      expect(a2.dirty()).toBe(1);
      expect(await a2.flush()).toEqual(["saved"]);
      // Its own copy saved, A2 removed the hand-off (and A's identical ordinary copy, if C left it) and its reference.
      expect(await world.handoffs()).toEqual([]);
      expect(storage.getItem("atlas-update-handoff")).toBeNull();
      const rows = await world.rows();
      expect(
        rows.filter(([, , value]) => value === ORIGINAL).map(([w]) => w),
      ).toEqual(Array(step.copies).fill("ordinary"));
      if (c) expect(c.title).toBe(step.shows);
    });

  test("A2 lists the ordinary copies only after C has removed them (A2's read held): A2 still restores ORIGINAL from the hand-off", async () => {
    const world = new World();
    const { storage } = await updated(world);
    const a2 = world.page("A2", storage);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = false;
    a2.port = {
      ...world.store,
      load: world.store.load.bind(world.store),
      save: world.store.save.bind(world.store),
      discard: world.store.discard.bind(world.store),
      list: async (context) => {
        if (context === A) {
          asked = true;
          await gate;
        }
        return world.store.list(context);
      },
    };
    const view = render(<Form page={a2} />);
    await waitFor(() => expect(asked).toBe(true));
    const c = await world.page("C").mount();
    c.type(THIRD);
    expect(await c.flush()).toEqual(["saved"]);
    expect((await world.rows()).filter(([w]) => w === "ordinary")).toHaveLength(
      1,
    );
    release();
    await waitFor(() => expect(a2.handle?.ready).toBe(true));
    expect(
      within(view.container).getByLabelText<HTMLInputElement>("Title").value,
    ).toBe(ORIGINAL);
  });

  test("A2's submission succeeds: the hand-off and its reference are removed; nothing comes back", async () => {
    const world = new World();
    const { storage } = await updated(world);
    const a2 = await world.page("A2", storage).mount();
    const ticket = a2.handle?.submitting();
    let result: string | undefined;
    await act(async () => {
      result = await ticket?.succeeded();
    });
    expect(result).toBe("discarded");
    expect(await world.rows()).toEqual([]);
    expect(storage.getItem("atlas-update-handoff")).toBeNull();
  });

  test("A2's 'Discard instead' removes the hand-off with the other copies", async () => {
    const world = new World();
    const { storage } = await updated(world);
    const a2 = await world.page("A2", storage).mount();
    let result: string | undefined;
    await act(async () => {
      result = await a2.handle?.discard();
    });
    expect(result).toBe("discarded");
    expect(await world.rows()).toEqual([]);
  });

  test("chained: A2 updates again before saving; its own copy replaces the first hand-off and A3 restores ORIGINAL", async () => {
    const world = new World();
    const { storage } = await updated(world);
    const a2 = await world.page("A2", storage).mount();
    const first = (await world.handoffs())[0]?.tabInstanceId;
    expect(await a2.update()).toEqual(["saved", "saved"]);
    const second = await world.handoffs();
    expect(second).toHaveLength(1);
    expect(second[0]?.tabInstanceId).not.toBe(first);
    a2.leave();
    const c = await world.page("C").mount();
    let discarded: string | undefined;
    await act(async () => {
      discarded = await c.handle?.discard();
    });
    expect(discarded).toBe("discarded");
    const a3 = await world.page("A3", storage).mount();
    expect(a3.title).toBe(ORIGINAL);
  });

  test("the reference holds no form value: only the form, the scope and the hand-off identifier", async () => {
    const world = new World();
    const { storage } = await updated(world);
    const raw = storage.getItem("atlas-update-handoff") ?? "";
    expect(raw).not.toContain(ORIGINAL);
    const refs = JSON.parse(raw) as Array<Record<string, string>>;
    expect(refs).toHaveLength(1);
    expect(Object.keys(refs[0] ?? {}).sort()).toEqual(["form", "id", "scope"]);
    expect(refs[0]?.form).toBe(A);
    // Never a writer identity: the hand-off identifier is not the page's recovery identifier.
    expect(refs[0]?.id?.startsWith("A-")).toBe(false);
  });
});

describe("R13: who may remove a hand-off", () => {
  test("a hand-off is shown to no other page while a live page holds it (A after an abandoned reload, A2 once it took it)", async () => {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage).mount();
    a.type(ORIGINAL);
    expect(await a.update()).toEqual(["saved", "saved"]);
    // The reload did not happen: A still holds its hand-off; C sees neither A's live copy nor the hand-off.
    const c = await world.page("C").mount();
    expect(c.title).toBe("");
    expect(c.handle?.alternatives).toEqual([]);
    // A2 cannot happen while A lives; a page of another tab cannot remove the hand-off explicitly either.
    const id = (await world.handoffs())[0]?.tabInstanceId as string;
    expect(world.locks.held.get(handoffLockName(id))).toBe(a.name);
  });

  test("abandoned (A2 never came) and A's ordinary copy removed by C: D is offered the hand-off, may restore it, never removes it unasked; only 'Discard this copy' does", async () => {
    const world = new World();
    await updated(world);
    const c = await world.page("C").mount();
    let discarded: string | undefined;
    await act(async () => {
      discarded = await c.handle?.discard();
    });
    expect(discarded).toBe("discarded");
    c.leave();
    const d = await world.page("D").mount();
    // Offered, not restored at once.
    expect(d.title).toBe("");
    expect(d.handle?.restored).toBeNull();
    const offered = d.handle?.alternatives ?? [];
    expect(offered).toHaveLength(1);
    expect(offered[0] && isHandoff(offered[0])).toBe(true);
    // Revision 7 (DA-B): the choice reads the hand-off again (holding its lock) before it is shown; awaited.
    await act(async () => {
      await d.handle?.restoreAlternative(offered[0]?.tabInstanceId as string);
    });
    expect(d.title).toBe(ORIGINAL);
    // D's own save, and then its discard, leave the hand-off where it is.
    expect(await d.flush()).toEqual(["saved"]);
    expect(await world.handoffs()).toHaveLength(1);
    await act(async () => {
      await d.handle?.discard();
    });
    expect(await world.handoffs()).toHaveLength(1);
    d.leave();
    // A later page removes it explicitly.
    const e = await world.page("E").mount();
    const left = e.handle?.alternatives ?? [];
    expect(left).toHaveLength(1);
    let removed: string | undefined;
    await act(async () => {
      removed = await e.handle?.discardAlternative(
        left[0]?.tabInstanceId as string,
      );
    });
    expect(removed).toBe("discarded");
    expect(await world.handoffs()).toEqual([]);
    expect(e.handle?.alternatives).toEqual([]);
  });

  test("'Discard this copy' is refused for an ordinary copy and for a hand-off a live page holds", async () => {
    const world = new World();
    await updated(world);
    const c = await world.page("C").mount();
    let discarded: string | undefined;
    await act(async () => {
      discarded = await c.handle?.discard();
    });
    c.leave();
    const d = await world.page("D").mount();
    const offered = d.handle?.alternatives ?? [];
    const id = offered[0]?.tabInstanceId as string;
    // Another page takes the hand-off meanwhile (as its replacement would): D's explicit discard is refused and removes nothing.
    world.locks.held.set(handoffLockName(id), "someone");
    let refused: string | undefined;
    await act(async () => {
      refused = await d.handle?.discardAlternative(id);
    });
    expect(refused).toBe("failed");
    expect(await world.handoffs()).toHaveLength(1);
    // An ordinary copy is never removed this way.
    expect(discarded).toBe("discarded");
    let ordinary: string | undefined;
    await act(async () => {
      ordinary = await d.handle?.discardAlternative("not-a-handoff");
    });
    expect(ordinary).toBe("failed");
  });

  test("a duplicated tab carrying the same reference: both restore ORIGINAL; only the page holding the hand-off removes it", async () => {
    const world = new World();
    const { storage } = await updated(world);
    const a2 = await world.page("A2", storage).mount();
    const duplicate = await world.page("DUP", storage.copy()).mount(5_000);
    expect(a2.title).toBe(ORIGINAL);
    expect(duplicate.title).toBe(ORIGINAL);
    // The duplicate's own save removes nothing (it does not hold the hand-off).
    expect(await duplicate.flush()).toEqual(["saved"]);
    expect(await world.handoffs()).toHaveLength(1);
    expect(await a2.flush()).toEqual(["saved"]);
    expect(await world.handoffs()).toEqual([]);
  }, 10_000);
});

describe("R13: an update reload only after the hand-off and its reference are written", () => {
  test("the hand-off's save fails: not handed off, no reference; the retry writes both", async () => {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage).mount();
    a.type(ORIGINAL);
    expect(await a.flush()).toEqual(["saved"]);
    world.store.failSaves = true;
    let results: SaveResult[] = [];
    await act(async () => {
      results = await prepareHandoffs(a.registry);
    });
    expect(results).toEqual(["failed"]);
    expect(a.handedOff()).toBe(false);
    expect(storage.getItem("atlas-update-handoff")).toBeNull();
    world.store.failSaves = false;
    await act(async () => {
      results = await prepareHandoffs(a.registry);
    });
    expect(results).toEqual(["saved"]);
    expect(a.handedOff()).toBe(true);
  });

  test("the reference cannot be written (session storage refuses): not handed off", async () => {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage).mount();
    a.type(ORIGINAL);
    expect(await a.flush()).toEqual(["saved"]);
    storage.failing = true;
    let results: SaveResult[] = [];
    await act(async () => {
      results = await prepareHandoffs(a.registry);
    });
    expect(results).toEqual(["failed"]);
    expect(a.handedOff()).toBe(false);
  });

  test("the hand-off's lock is refused: nothing is written under it", async () => {
    const world = new World();
    const a = await world.page("A").mount();
    a.type(ORIGINAL);
    expect(await a.flush()).toEqual(["saved"]);
    world.locks.refuse = (name) => name.startsWith("atlas-recovery-handoff-");
    let results: SaveResult[] = [];
    await act(async () => {
      results = await prepareHandoffs(a.registry);
    });
    expect(results).toEqual(["failed"]);
    expect(await world.handoffs()).toEqual([]);
  });

  test("an edit after the hand-off makes the form dirty and the hand-off stale; the next save and hand-off cover it", async () => {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage).mount();
    a.type(ORIGINAL);
    expect(await a.update()).toEqual(["saved", "saved"]);
    a.type("LATER");
    expect(a.dirty()).toBe(1);
    expect(await a.flush()).toEqual(["saved"]);
    expect(a.handedOff()).toBe(false);
    expect(await a.update()).toEqual(["saved"]);
    expect((await world.handoffs()).map((copy) => copy.values.title)).toEqual([
      "LATER",
    ]);
  });

  test("a kept session no mount shows (clean, with a copy of its own) is handed off too", async () => {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage).mount();
    a.type(ORIGINAL);
    expect(await a.flush()).toEqual(["saved"]);
    // The form is unmounted (another route), the page stays: its session is kept, listed nowhere.
    a.leaveMountOnly();
    expect(a.registry.all()).toHaveLength(0);
    let results: SaveResult[] = [];
    await act(async () => {
      results = await prepareHandoffs(a.registry);
    });
    expect(results).toEqual(["saved"]);
    expect((await world.handoffs()).map((copy) => copy.values)).toEqual([
      { title: ORIGINAL },
    ]);
    expect(storage.getItem("atlas-update-handoff")).not.toBeNull();
  });

  test("a clean form with no copy needs no hand-off", async () => {
    const world = new World();
    const a = await world.page("A").mount();
    expect(a.handedOff()).toBe(true);
    let results: SaveResult[] = [];
    await act(async () => {
      results = await prepareHandoffs(a.registry);
    });
    expect(results).toEqual([]);
  });

  test("A's own submission after an abandoned reload removes its hand-off and the reference", async () => {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage).mount();
    a.type(ORIGINAL);
    expect(await a.update()).toEqual(["saved", "saved"]);
    const ticket = a.handle?.submitting();
    await act(async () => {
      await ticket?.succeeded();
    });
    expect(await world.rows()).toEqual([]);
    expect(storage.getItem("atlas-update-handoff")).toBeNull();
  });

  test("a reference for another account's database is not taken", async () => {
    const world = new World();
    const storage = new TabStorage();
    await updated(world).then(({ storage: written }) => {
      // Re-scope the reference as if written by another account's page.
      const refs = JSON.parse(written.getItem("atlas-update-handoff") ?? "[]");
      refs[0].scope = "another-account";
      storage.setItem("atlas-update-handoff", JSON.stringify(refs));
    });
    const c = await world.page("C").mount();
    let discarded: string | undefined;
    await act(async () => {
      discarded = await c.handle?.discard();
    });
    expect(discarded).toBe("discarded");
    const a2 = await world.page("A2", storage).mount();
    expect(a2.title).toBe("");
  });

  test("a page records the hand-offs it wrote (never one left to it); forgetting another hand-off removes only that exact reference", async () => {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage).mount();
    a.type(ORIGINAL);
    expect(await a.update()).toEqual(["saved", "saved"]);
    const id = (await world.handoffs())[0]?.tabInstanceId as string;
    expect(a.handoffs.written.has(id)).toBe(true);
    forgetHandoff(a.handoffs, "unrelated");
    expect(storage.getItem("atlas-update-handoff")).toContain(id);
  });

  test("a form context with the reserved prefix is refused", () => {
    const world = new World();
    const page = world.page("A");
    function Reserved() {
      const ref = useRef<HTMLFormElement>(null);
      useRecoverableForm({
        formContext: `${HANDOFF_PREFIX}x`,
        allow: TITLE,
        formRef: ref,
        port: page.port,
        registry: page.registry,
        tab: page.tab,
        handoffs: page.handoffs,
      });
      return <form ref={ref} />;
    }
    const errors = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<Reserved />)).toThrow(
        /reserved for update hand-offs/,
      );
    } finally {
      console.error = errors;
    }
  });
});
