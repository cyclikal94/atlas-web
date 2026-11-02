import { afterEach, describe, expect, test } from "vitest";
import {
  type HandoffStore,
  handedOff,
  handoffContext,
  handoffHandles,
  prepareHandoffs,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import type { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
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
  /** Revision 38: the copies the person chose that it took (a choice needs no untouched input; a pending submission refuses it). */
  chosen: string[] = [];
  submitting = false;
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
      restore: (text, chosen) => {
        if (!this.owner.takes) return false;
        // Revision 38 (R40-B): as the product owners (kept-input, correction-owner): automatic only into untouched input; a choice
        // replaces what the owner holds unless a submission of it is pending.
        if (chosen ? this.owner.submitting : this.owner.revision !== 0)
          return false;
        this.owner.value = text;
        this.owner.revision += 1;
        (chosen ? this.owner.chosen : this.owner.restored).push(text);
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

/**
 * WEB-14a revision 38 (review of revision 37, R40-A/R40-B; design assessment C2-C5, I3-I7, Q3/Q4/Q6, schedules S3-S6). The owner's actions
 * at the model: the look's automatic restore against the person's choice of a copy, competing actions while a choice's read is held, the
 * claimed hand-off's lineage on reselection, a submission's `current`, a settlement's `settle` and admission (`accepting`). Every order is
 * forced by explicit held reads (entered/released), never by time.
 */
/** A port whose ORDINARY loads (an explicit choice's re-read) are each held, in the order asked, until that one is released. */
class HeldLoads extends SpyPort {
  readonly waiting: Array<() => void> = [];
  holding = false;
  constructor(private readonly memory: MemoryRecoveryAdapter) {
    super(memory);
  }
  override async load(formContext: string, id: string) {
    if (!this.holding || formContext.startsWith("atlas-update-handoff:"))
      return super.load(formContext, id);
    const answer = await this.memory.load(formContext, id);
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return answer;
  }
  /** Releases the `n`th held load (in the order asked); resolves once it has been applied. */
  async answer(n: number): Promise<void> {
    this.waiting[n]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** A copy a tab that has gone left (no lock holds its id). */
async function gone(id: string, text: string, savedAt: string): Promise<void> {
  expect(
    await world.store.save({
      formContext: CONTEXT,
      tabInstanceId: id,
      values: { model: text },
      savedAt,
      capture: `${id}-capture`,
    }),
  ).toBe("saved");
}
const OLDER = "2026-10-25T10:00:00.000Z";
const NEWER = "2026-10-25T11:00:00.000Z";
const NEWEST = "2026-10-25T12:00:00.000Z";

describe("revision 38: automatic restore and the person's choice (R40-B, S3)", () => {
  test("after the automatic restore, the copy the person chooses replaces it; nothing is submitted", async () => {
    await gone("gone-older", "{older}", OLDER);
    await gone("gone-newer", "{newer}", NEWER);
    const b = await page("B").bound();
    expect(b.owner.restored).toEqual(["{newer}"]);
    expect(b.model.view().alternatives.map((c) => c.tabInstanceId)).toEqual([
      "gone-older",
    ]);
    expect(await b.model.restoreAlternative("gone-older")).toBe("restored");
    expect(b.owner.value).toBe("{older}");
    expect(b.owner.chosen).toEqual(["{older}"]);
    expect(b.model.view().restored?.tabInstanceId).toBe("gone-older");
    expect(b.model.view().alternatives.map((c) => c.tabInstanceId)).toEqual([
      "gone-newer",
    ]);
    // The model holds what the owner shows: an update saves the chosen text.
    b.model.show();
    expect(await flushDirty(b.registry)).toEqual(["saved"]);
    expect(
      (await world.store.list(CONTEXT))
        .filter((copy) => copy.tabInstanceId.startsWith("B-"))
        .map((copy) => copy.values.model),
    ).toEqual(["{older}"]);
  });

  test("a choice made after the person typed replaces what they typed (the choice is the later act)", async () => {
    await gone("gone-older", "{older}", OLDER);
    await gone("gone-newer", "{newer}", NEWER);
    const b = await page("B").bound();
    expect(b.type("{typed after the restore}")).toBe(true);
    expect(await b.model.restoreAlternative("gone-older")).toBe("restored");
    expect(b.owner.value).toBe("{older}");
  });

  test("CONTROL: the look's automatic restore still never overwrites input typed before it answered", async () => {
    await gone("gone-newer", "{newer}", NEWER);
    const b = page("B");
    b.model.begin("{}");
    b.type("{typed first}");
    await b.bound();
    expect(b.owner.restored).toEqual([]);
    expect(b.owner.value).toBe("{typed first}");
  });

  test("an owner with a submission pending refuses a choice: nothing changes, the copy stays offered", async () => {
    await gone("gone-older", "{older}", OLDER);
    await gone("gone-newer", "{newer}", NEWER);
    const b = await page("B").bound();
    b.owner.submitting = true;
    expect(await b.model.restoreAlternative("gone-older")).toBe("refused");
    expect(b.owner.value).toBe("{newer}");
    expect(b.model.view().alternatives.map((c) => c.tabInstanceId)).toEqual([
      "gone-older",
    ]);
  });
});

describe("revision 38: a choice while a submission is pending (S4, I7)", () => {
  test("a choice is refused while the model's submission is pending, whatever the owner says; after it settles the choice is taken", async () => {
    await gone("gone-older", "{older}", OLDER);
    await gone("gone-newer", "{newer}", NEWER);
    const b = await page("B").bound();
    const ticket = b.model.submitting();
    if (!ticket) throw new Error("no ticket");
    expect(await b.model.restoreAlternative("gone-older")).toBe("refused");
    expect(b.owner.value).toBe("{newer}");
    ticket.failed();
    expect(await b.model.restoreAlternative("gone-older")).toBe("restored");
    expect(b.owner.value).toBe("{older}");
  });
});

describe("revision 38: what happens while a choice's read is held (S4)", () => {
  async function threeCopies(): Promise<ModelPage & { port: HeldLoads }> {
    await gone("gone-a", "{a}", OLDER);
    await gone("gone-b", "{b}", NEWER);
    await gone("gone-c", "{c}", NEWEST);
    const b = page("B");
    const port = new HeldLoads(world.store);
    await b.bound(port);
    expect(b.owner.restored).toEqual(["{c}"]);
    port.holding = true;
    return Object.assign(b, { port });
  }

  test("input typed after the choice wins: the choice's late answer is refused, the input stays", async () => {
    const b = await threeCopies();
    const choice = b.model.restoreAlternative("gone-a");
    await until(() => b.port.waiting.length === 1);
    expect(b.type("{typed while it read}")).toBe(true);
    await b.port.answer(0);
    expect(await choice).toBe("refused");
    expect(b.owner.value).toBe("{typed while it read}");
    expect(b.owner.chosen).toEqual([]);
  });

  test("a discard after the choice wins: the choice's late answer is refused, the discarded input stays discarded", async () => {
    const b = await threeCopies();
    const choice = b.model.restoreAlternative("gone-a");
    await until(() => b.port.waiting.length === 1);
    expect(await b.model.discard("{}")).toBe("discarded");
    b.owner.value = "{}";
    await b.port.answer(0);
    expect(await choice).toBe("refused");
    expect(b.owner.chosen).toEqual([]);
    expect(b.owner.value).toBe("{}");
  });

  test("of two choices, the later one wins whichever read answers first", async () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      world = new World();
      const b = await threeCopies();
      const first = b.model.restoreAlternative("gone-a");
      const second = b.model.restoreAlternative("gone-b");
      await until(() => b.port.waiting.length === 2);
      for (const n of order) await b.port.answer(n);
      expect(await first, `order ${order}`).toBe("refused");
      expect(await second, `order ${order}`).toBe("restored");
      expect(b.owner.value, `order ${order}`).toBe("{b}");
      b.leave();
    }
  });

  test("a freeze after the choice wins: refused, nothing changes", async () => {
    const b = await threeCopies();
    const choice = b.model.restoreAlternative("gone-a");
    await until(() => b.port.waiting.length === 1);
    const release = b.registry.freeze();
    await b.port.answer(0);
    expect(await choice).toBe("refused");
    expect(b.owner.value).toBe("{c}");
    release();
  });

  test("CONTROL: with nothing in between, the held choice is applied when its read answers", async () => {
    const b = await threeCopies();
    const choice = b.model.restoreAlternative("gone-a");
    await until(() => b.port.waiting.length === 1);
    await b.port.answer(0);
    expect(await choice).toBe("restored");
    expect(b.owner.value).toBe("{a}");
  });
});

describe("revision 38: the claimed hand-off chosen again keeps its lineage (DA-R40-C, S5)", () => {
  /** Page A leaves an ordinary copy O and the hand-off H naming it; X is an independent gone copy; B claims H and offers X. */
  async function claimed(): Promise<{
    b: ModelPage;
    storage: TabStorage;
    ordinary: string;
    handoff: string;
  }> {
    const storage = new TabStorage();
    const a = await page("A", storage).bound();
    a.model.show();
    a.model.begin("{}");
    a.type("{A}");
    expect(await a.update()).toEqual(["saved", "saved"]);
    const ordinary = (await world.store.list(CONTEXT))[0]?.tabInstanceId;
    if (!ordinary) throw new Error("setup: no ordinary copy");
    a.leave();
    await gone("gone-x", "{X}", OLDER);
    const b = await page("B", storage).bound();
    expect(b.owner.restored).toEqual(["{A}"]);
    const handoff = b.model.view().restored?.tabInstanceId;
    if (!handoff) throw new Error("setup: the hand-off was not restored");
    // O is part of the hand-off (never offered on its own); X is another branch.
    expect(b.model.view().alternatives.map((c) => c.tabInstanceId)).toEqual([
      "gone-x",
    ]);
    return { b, storage, ordinary, handoff };
  }

  test("choose X, choose the hand-off again, discard: the copy it names goes, the hand-off stays (R42); X stays; a later page restores {X} and only offers {A}", async () => {
    const { b, ordinary, handoff } = await claimed();
    const kept = await world.handoffs(CONTEXT);
    expect(await b.model.restoreAlternative("gone-x")).toBe("restored");
    expect(await b.model.restoreAlternative(handoff)).toBe("restored");
    expect(b.owner.value).toBe("{A}");
    expect(await b.model.discard("{}")).toBe("discarded");
    const left = (await world.store.list(CONTEXT)).map((c) => c.tabInstanceId);
    expect(left).not.toContain(ordinary);
    expect(left).toContain("gone-x");
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was no hand-off left; now H stays exactly (same id
    // and capture): B's claim restores it, never removes it.
    expect(
      (await world.handoffs(CONTEXT)).map((c) => [c.tabInstanceId, c.capture]),
    ).toEqual(kept.map((c) => [c.tabInstanceId, c.capture]));
    b.leave();
    const c = await page("C").bound();
    expect(c.owner.restored).toEqual(["{X}"]);
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was {A} neither restored nor offered; now {A} is
    // not restored but is offered, from the retained hand-off only (B has gone; nobody holds it), for the person to restore or discard.
    expect(
      c.model
        .view()
        .alternatives.filter((copy) => copy.values.model === "{A}")
        .map((copy) => copy.tabInstanceId),
    ).toEqual([handoff]);
  });

  test("CONTROL: the hand-off restored at once and discarded removes the same copy it names and keeps the hand-off (R42)", async () => {
    const { b, ordinary } = await claimed();
    const kept = await world.handoffs(CONTEXT);
    expect(await b.model.discard("{}")).toBe("discarded");
    const left = (await world.store.list(CONTEXT)).map((c) => c.tabInstanceId);
    expect(left).not.toContain(ordinary);
    expect(left).toContain("gone-x");
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was no hand-off left; now H stays exactly.
    expect(
      (await world.handoffs(CONTEXT)).map((c) => [c.tabInstanceId, c.capture]),
    ).toEqual(kept.map((c) => [c.tabInstanceId, c.capture]));
  });

  test("a predecessor whose removal fails keeps the hand-off as its carrier (removed last, never before what it names)", async () => {
    const { b, ordinary, handoff } = await claimed();
    expect(await b.model.restoreAlternative("gone-x")).toBe("restored");
    expect(await b.model.restoreAlternative(handoff)).toBe("restored");
    world.store.failDiscardOf = (_context, id) => id === ordinary;
    await b.model.discard("{}");
    expect(
      (await world.store.list(CONTEXT)).map((c) => c.tabInstanceId),
    ).toContain(ordinary);
    expect(
      (await world.handoffs(CONTEXT)).map((c) => c.tabInstanceId),
    ).toContain(handoff);
  });
});

describe("revision 38: admission, a submission's currency and a settlement (R40-A, I5, I7, C5)", () => {
  test("accepting: false while an update reload is prepared and once retired; the discard then changes nothing", async () => {
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{}");
    a.type("{typed}");
    expect(a.model.accepting()).toBe(true);
    const release = a.registry.freeze();
    expect(a.model.accepting()).toBe(false);
    expect(await a.model.discard("{}")).toBe("failed");
    release();
    expect(a.registry.dirty()).toHaveLength(1);
    a.model.retire();
    expect(a.model.accepting()).toBe(false);
    expect(await a.model.discard("{}")).toBe("failed");
  });

  test("the discard takes the input at the gesture: input typed while its removal is pending is the person's, dirty and saved", async () => {
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{}");
    a.type("{restored-ish}");
    await flushDirty(a.registry);
    // Still pending (its removal not landed): the person types again before it completes.
    const discarded = a.model.discard("{}");
    a.type("{newer}");
    expect(await discarded).toBe("discarded");
    expect(a.registry.dirty()).toHaveLength(1);
    expect(await flushDirty(a.registry)).toEqual(["saved"]);
    expect(
      (await world.store.list(CONTEXT)).map((copy) => copy.values.model),
    ).toEqual(["{newer}"]);
  });

  test("a ticket is current until the input changes, even back to the same text", async () => {
    const a = await page("A").bound();
    a.model.begin("{}");
    a.type("{sent}");
    const ticket = a.model.submitting();
    if (!ticket) throw new Error("no ticket");
    expect(ticket.current()).toBe(true);
    a.type("{other}");
    a.type("{sent}");
    expect(ticket.current()).toBe(false);
  });

  test("a settlement reaches the model while frozen (the update waits for it before its last save); an edit does not", async () => {
    const a = await page("A").bound();
    a.model.show();
    a.model.begin("{}");
    a.type("{all selected}");
    const ticket = a.model.submitting();
    const release = a.registry.freeze();
    expect(a.type("{typed while frozen}")).toBe(false);
    a.model.settle("{the rest}");
    ticket?.failed();
    expect(await flushDirty(a.registry)).toEqual(["saved"]);
    release();
    expect(
      (await world.store.list(CONTEXT)).map((copy) => copy.values.model),
    ).toEqual(["{the rest}"]);
  });
});
