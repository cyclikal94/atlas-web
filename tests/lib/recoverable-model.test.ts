import { afterEach, describe, expect, test } from "vitest";
import {
  type HandoffStore,
  handedOff,
  handoffContext,
  handoffHandles,
  prepareHandoffs,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import {
  createRecoverableModel,
  type RecoverableModel,
} from "../../src/lib/form-recovery/model";
import type {
  FormRecoveryPort,
  SaveResult,
} from "../../src/lib/form-recovery/port";
import {
  createRecoverableFormRegistry,
  discardDirty,
  flushDirty,
  type RecoverableFormRegistry,
} from "../../src/lib/form-recovery/registry";
import {
  createRecoveryTab,
  type RecoveryTab,
} from "../../src/lib/form-recovery/tab-identity";
import {
  ScopedSpyPort,
  SpyPort,
  TabStorage,
  World,
} from "../support/recovery-pages";

/**
 * WEB-14a revision 37 (review of 25 October 2026, R40 `production-form-update-recovery-registration`; design assessment Q1-Q3): the
 * RECOVERABLE MODEL (`model.ts`) over the real session, registry, hand-off store and recovery identity, the memory store and one shared Web
 * Locks double that releases a page's locks when it leaves. An OWNER stands in for a product editor's model owner (kept-input): it holds the
 * input and its revision, and gives every change to the model in the same step, as the task editor's owner does. Order is forced by what
 * each step does when (held ports, explicit freezes), never by time. Native/worker coverage: `fixture.pwa-forms.spec.ts` revision 37.
 */
const CONTEXT = "task-form:new";

class Owner {
  value = "";
  revision = 0;
  /** What `restore` is told and whether it takes it. */
  takes = true;
  restored: string[] = [];
}

class ModelPage {
  readonly registry: RecoverableFormRegistry = createRecoverableFormRegistry();
  readonly tab: RecoveryTab;
  readonly handoffs: HandoffStore;
  readonly spy: SpyPort;
  readonly owner = new Owner();
  model: RecoverableModel;
  private counter = 0;
  constructor(
    readonly world: World,
    readonly name: string,
    readonly storage: TabStorage,
    start = "",
    readonly context = CONTEXT,
  ) {
    this.spy = world.scoped
      ? new ScopedSpyPort(world.store)
      : new SpyPort(world.store);
    this.tab = createRecoveryTab({
      uuid: () => `${name}-id-${++this.counter}`,
      locks: world.locks.forPage(name),
    });
    this.handoffs = storageHandoffs(() => storage as unknown as Storage);
    this.owner.value = start;
    this.model = createRecoverableModel({
      formContext: context,
      start,
      restore: (text) => {
        if (!this.owner.takes || this.owner.revision !== 0) return false;
        this.owner.value = text;
        this.owner.revision += 1;
        this.owner.restored.push(text);
        return true;
      },
      untouched: () => this.owner.revision === 0,
      registry: this.registry,
      tab: this.tab,
      handoffs: this.handoffs,
    });
  }
  /** The person types: the owner takes the change only if the model does (R40: refused while an update reload is prepared). */
  type(text: string): boolean {
    if (!this.model.edit(text)) return false;
    this.owner.value = text;
    this.owner.revision += 1;
    return true;
  }
  async bound(port: FormRecoveryPort | null = this.spy): Promise<this> {
    this.model.bind(port);
    await until(() => this.model.view().ready || this.model.view().unavailable);
    return this;
  }
  /** "Save and reload" as the coordinator makes it: the saves, then the hand-offs. */
  async update(): Promise<SaveResult[]> {
    const saved = await flushDirty(this.registry);
    const handed = await prepareHandoffs(this.registry);
    return [...saved, ...handed];
  }
  /** The coordinator's final check, made in one step before an update reload (`coordinator.ts` `sealed`, mode save). */
  sealed(): boolean {
    return (
      this.registry.pending() === 0 &&
      this.registry.unheld() === 0 &&
      this.registry.dirty().length === 0 &&
      !handoffHandles(this.registry).some((h) => h.unresolved?.() ?? false) &&
      handedOff(this.registry)
    );
  }
  leave(): void {
    this.world.locks.leave(this.name);
  }
}

async function until(check: () => boolean, ms = 1_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

let world = new World();
afterEach(() => {
  world = new World();
});

const page = (name: string, storage = new TabStorage(), start = "") =>
  new ModelPage(world, name, storage, start);

describe("a recoverable model in the page's registry (R40, Q2)", () => {
  test("an editor shown is registered before any input; a clean one is not dirty and the page is sealed", async () => {
    const a = await page("A", new TabStorage(), "START").bound();
    expect(a.registry.all()).toHaveLength(0);
    const release = a.model.show();
    expect(a.registry.all()).toHaveLength(1);
    expect(a.registry.dirty()).toHaveLength(0);
    expect(a.sealed()).toBe(true);
    release();
    expect(a.registry.all()).toHaveLength(0);
  });

  test("CONTROL: input typed while no editor shows the model keeps it registered and dirty", async () => {
    const a = await page("A").bound();
    a.model.begin("{}");
    expect(a.type("{typed}")).toBe(true);
    expect(a.registry.dirty()).toHaveLength(1);
    expect(a.sealed()).toBe(false);
  });

  test("before the store is open a provisional handle is dirty and its save FAILS (never a silent reload)", async () => {
    const a = page("A");
    a.model.show();
    a.model.begin("{}");
    a.type("{typed}");
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await flushDirty(a.registry)).toEqual(["failed"]);
    expect(a.sealed()).toBe(false);
    // Bound later: the session replaces it, and saves.
    await a.bound();
    expect(a.registry.all()).toHaveLength(1);
    expect(await a.update()).toEqual(["saved", "saved"]);
    expect(a.sealed()).toBe(true);
  });

  test("opening an editor whose opening is input (a stage chosen) is dirty from its start", async () => {
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{stage}", true);
    expect(a.registry.dirty()).toHaveLength(1);
    a.model.begin("{stage}", false);
    expect(a.registry.dirty()).toHaveLength(0);
  });
});

describe("save, hand-off and restore across an update (R40, Q1/Q4 at the model)", () => {
  test("the next page of the tab restores the hand-off into an untouched owner, nothing submitted; a second page sees none of it", async () => {
    const storage = new TabStorage();
    const a = await page("A", storage).bound();
    a.model.show();
    a.model.begin("{}");
    a.type('{"title":"UNFINISHED"}');
    expect(a.sealed()).toBe(false);
    expect(await a.update()).toEqual(["saved", "saved"]);
    expect(a.sealed()).toBe(true);
    a.leave();
    const b = await page("B", storage).bound();
    expect(b.owner.restored).toEqual(['{"title":"UNFINISHED"}']);
    expect(b.model.view().restored?.formContext).toBe(handoffContext(CONTEXT));
    // Restored from a hand-off: dirty until this page has a copy of its own.
    b.model.show();
    expect(b.registry.dirty()).toHaveLength(1);
    expect(await b.update()).toEqual(["saved", "saved"]);
    // The hand-off it took over was removed once its own copy landed (its source), and its own copy stands.
    const handoffs = await world.handoffs(CONTEXT);
    expect(handoffs.map((copy) => copy.tabInstanceId)).not.toContain(
      a.model.view().restored?.tabInstanceId ?? "none",
    );
  });

  test("CONTROL: an owner the person touched before the look answered is not overwritten; the copy is offered", async () => {
    const storage = new TabStorage();
    const a = await page("A", storage).bound();
    a.model.begin("{}");
    a.type("{A}");
    await a.update();
    a.leave();
    const b = page("B", storage);
    b.model.begin("{}");
    b.type("{typed first}");
    await b.bound();
    expect(b.owner.restored).toEqual([]);
    expect(b.owner.value).toBe("{typed first}");
    expect(b.model.view().alternatives).toHaveLength(1);
  });

  test("a copy the owner's codec cannot read is offered as it is, never restored, never removed", async () => {
    const storage = new TabStorage();
    const a = await page("A", storage).bound();
    a.model.begin("{}");
    a.type("{v0-copy}");
    await a.update();
    a.leave();
    const b = page("B", storage);
    b.owner.takes = false;
    await b.bound();
    expect(b.owner.restored).toEqual([]);
    expect(b.model.view().restored).toBeNull();
    expect(b.model.view().alternatives).toHaveLength(1);
    expect(await world.handoffs(CONTEXT)).toHaveLength(1);
  });

  test("a look that cannot read the store is UNAVAILABLE: unresolved for the update until a retry reads it", async () => {
    const storage = new TabStorage();
    const a = await page("A", storage).bound();
    a.model.begin("{}");
    a.type("{A}");
    await a.update();
    a.leave();
    const b = page("B", storage);
    b.spy.failLists = 1;
    await b.bound();
    expect(b.model.view().unavailable).toBe(true);
    b.model.show();
    expect(b.sealed()).toBe(false);
    expect(await b.model.retry()).toBe(true);
    expect(b.owner.restored).toEqual(["{A}"]);
  });
});

describe("freeze, submissions and the person's discard (R40, Q3)", () => {
  test("while an update reload is prepared, input, submissions and discards are refused", async () => {
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{}");
    a.type("{saved}");
    const release = a.registry.freeze();
    expect(a.registry.unheld()).toBe(0);
    expect(a.type("{after the save}")).toBe(false);
    expect(a.owner.value).toBe("{saved}");
    expect(a.model.submitting()).toBeNull();
    expect(await a.model.discard("{}")).toBe("failed");
    release();
    expect(a.type("{after the release}")).toBe(true);
  });

  test("a submission covers exactly what it sent: an edit after it (even back to the same text) stays the person's", async () => {
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{}");
    a.type("{sent}");
    const ticket = a.model.submitting();
    if (!ticket) throw new Error("no ticket");
    a.type("{newer}");
    a.type("{sent}");
    expect(await ticket.succeeded()).toBe("kept");
    expect(a.registry.dirty()).toHaveLength(1);
  });

  test("CONTROL: a submission of what the page still holds discards its copies; the page is clean", async () => {
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{}");
    a.type("{sent}");
    await flushDirty(a.registry);
    expect(await world.store.list(CONTEXT)).toHaveLength(1);
    const ticket = a.model.submitting();
    expect(await ticket?.succeeded()).toBe("discarded");
    expect(await world.store.list(CONTEXT)).toHaveLength(0);
    expect(a.registry.dirty()).toHaveLength(0);
  });

  test("a failed submission covers nothing: the input stays dirty and saved", async () => {
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{}");
    a.type("{sent}");
    const ticket = a.model.submitting();
    ticket?.failed();
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await flushDirty(a.registry)).toEqual(["saved"]);
  });

  test("a departure that drops the input (end) removes its copies: nothing comes back after a later reload", async () => {
    const storage = new TabStorage();
    const a = await page("A", storage).bound();
    a.model.begin("{}");
    a.type("{left behind}");
    await flushDirty(a.registry);
    expect(await world.store.list(CONTEXT)).toHaveLength(1);
    expect(await a.model.end()).toBe("discarded");
    expect(await world.store.list(CONTEXT)).toHaveLength(0);
    expect(a.registry.dirty()).toHaveLength(0);
    a.leave();
    const b = await page("B", storage).bound();
    expect(b.owner.restored).toEqual([]);
  });

  test("'Discard and reload anyway' through the registry removes the copies and the hand-off", async () => {
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{}");
    a.type("{typed}");
    await a.update();
    expect(await discardDirty(a.registry, a.registry.all())).toEqual([
      "discarded",
    ]);
    expect(await world.store.list(CONTEXT)).toHaveLength(0);
    expect(await world.handoffs(CONTEXT)).toHaveLength(0);
  });
});

describe("unfinished native input and account scope (R40, I2/I4)", () => {
  test("a native editing state the model cannot hold makes it dirty and unsaveable, never saved as its last value", async () => {
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{}");
    let partial = true;
    a.model.probe(() => partial);
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await flushDirty(a.registry)).toEqual(["failed"]);
    expect(await world.store.list(CONTEXT)).toHaveLength(0);
    // Cleared by the person (the field shows nothing again, the owner's value is its start): nothing of theirs is left to save.
    partial = false;
    expect(a.registry.dirty()).toHaveLength(0);
    // Partly typed again, then completed: the completed value is input, saved as it is.
    partial = true;
    expect(a.registry.dirty()).toHaveLength(1);
    partial = false;
    a.type('{"date":"2026-10-25"}');
    expect(await flushDirty(a.registry)).toEqual(["saved"]);
    expect(
      (await world.store.list(CONTEXT)).map((copy) => copy.values.model),
    ).toEqual(['{"date":"2026-10-25"}']);
  });

  test("a write asked for after the account's database changed scope writes nothing there", async () => {
    world.scoped = true;
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{}");
    a.type("{account A}");
    (a.spy as ScopedSpyPort).scope = "scope-2";
    expect(await flushDirty(a.registry)).toEqual(["failed"]);
    expect(await world.store.list(CONTEXT)).toHaveLength(0);
  });
});
