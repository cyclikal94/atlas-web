import { act } from "@testing-library/react";
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
  RecoverySnapshot,
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
  ORIGINAL,
  SpyPort,
  TabStorage,
  updated,
  World,
} from "../support/recovery-pages";

/**
 * WEB-14a revision 40: the review of revision 39, R42 (`recovery-shared-source-reload-coverage`), and its design assessment (token
 * ae2a506e…, C3, I6/I7, Q2), under the owner's decision WEB14A-R42-NON-CONSUMING-20261028 (28 October 2026): no signal this build reads tells the writer's
 * replacement (B) from a tab copied from the writer (D, its `sessionStorage` and hand-off reference included), so NO PAGE that takes a
 * referenced hand-off over may remove it, through any destructive path: its own `end`, "Discard instead", a successful unchanged submission,
 * its own save's clean-up (debts), "Discard and reload anyway", or a later choice of an alternative. It restores it; the ordinary copies its
 * lineage names may go (the hand-off, which stays, holds everything they hold). The writer itself (alive) still removes its own hand-off,
 * and a hand-off no live page holds is still removed by the person's explicit "Discard this copy".
 *
 * The review's independent schedule (`.agtx/evidence/review-r39-20261027/account-handoff.test.ts`) is promoted first, then every consumer.
 * The real recoverable model, session, registry, hand-off store and recovery identity, over the memory store and one Web Locks double
 * that releases a page's locks when it leaves. Copied storage is modelled (`TabStorage.copy`): this qualifies the schedule, not a native
 * duplicate-tab gesture.
 */
const CONTEXT = "task-form:new";
const UNSENT = '{"title":"ORIGINAL UNSENT"}';

class ModelPage {
  readonly registry: RecoverableFormRegistry = createRecoverableFormRegistry();
  readonly tab: RecoveryTab;
  readonly handoffs: HandoffStore;
  readonly spy: SpyPort;
  value = "";
  revision = 0;
  submitting = false;
  model: RecoverableModel;
  private counter = 0;
  constructor(
    readonly world: World,
    readonly name: string,
    readonly storage: TabStorage,
  ) {
    this.spy = new SpyPort(world.store);
    this.tab = createRecoveryTab({
      uuid: () => `${name}-id-${++this.counter}`,
      locks: world.locks.forPage(name),
    });
    this.handoffs = storageHandoffs(() => storage as unknown as Storage);
    this.model = createRecoverableModel({
      formContext: CONTEXT,
      start: "",
      restore: (text, chosen) => {
        if (chosen ? this.submitting : this.revision !== 0) return false;
        this.value = text;
        this.revision += 1;
        return true;
      },
      untouched: () => this.revision === 0,
      registry: this.registry,
      tab: this.tab,
      handoffs: this.handoffs,
    });
    this.model.show();
  }
  type(text: string): void {
    expect(this.model.edit(text)).toBe(true);
    this.value = text;
    this.revision += 1;
  }
  async bound(port: FormRecoveryPort = this.spy): Promise<this> {
    this.model.bind(port);
    await until(() => this.model.view().ready || this.model.view().unavailable);
    return this;
  }
  async update(): Promise<SaveResult[]> {
    const saved = await flushDirty(this.registry);
    const handed = await prepareHandoffs(this.registry);
    return [...saved, ...handed];
  }
  sealed(): boolean {
    return (
      this.registry.pending() === 0 &&
      this.registry.dirty().length === 0 &&
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
const page = (name: string, storage = new TabStorage()) =>
  new ModelPage(world, name, storage);
const handoffRows = () => world.store.list(handoffContext(CONTEXT));
const ordinaryRows = () => world.store.list(CONTEXT);
/** A row as identity and content: the exact copy, whatever its order in the list. */
const exact = (copy: RecoverySnapshot) => ({
  id: copy.tabInstanceId,
  capture: copy.capture,
  values: copy.values,
});

/** A typed UNSENT, saved and handed off; `clone` is a tab copied from it after the reference was written; A then goes. */
async function writer(): Promise<{
  a: ModelPage;
  storage: TabStorage;
  clone: TabStorage;
  handoff: ReturnType<typeof exact>;
}> {
  const storage = new TabStorage();
  const a = await page("A", storage).bound();
  a.model.begin("{}");
  a.type(UNSENT);
  expect(await a.update()).toEqual(["saved", "saved"]);
  expect(a.sealed()).toBe(true);
  const clone = storage.copy();
  expect(clone.getItem("atlas-update-handoff")).toBe(
    storage.getItem("atlas-update-handoff"),
  );
  const rows = await handoffRows();
  expect(rows).toHaveLength(1);
  return { a, storage, clone, handoff: exact(rows[0] as RecoverySnapshot) };
}

/** What D (holding the copied reference, after A went, before B) does with what it restored. */
const consumers: Record<string, (d: ModelPage) => Promise<unknown>> = {
  "its own end (a dismissal)": async (d) =>
    expect(await d.model.end()).toBe("discarded"),
  "'Discard instead'": async (d) =>
    expect(await d.model.discard("")).toBe("discarded"),
  "a successful submission of exactly what it restored": async (d) => {
    const ticket = d.model.submitting();
    expect(await ticket?.succeeded()).toBe("discarded");
  },
  "its own save (the source's clean-up, its debts)": async (d) => {
    d.type('{"title":"D EDITED"}');
    expect(await flushDirty(d.registry)).toEqual(["saved"]);
  },
  "its own clean save (back to where it starts: its copies discarded)": async (
    d,
  ) => {
    d.type("");
    expect(await flushDirty(d.registry)).toEqual(["saved"]);
  },
  "'Discard and reload anyway' (the registry handle)": async (d) =>
    expect(await discardDirty(d.registry, d.registry.all())).toEqual([
      "discarded",
    ]),
  "a later choice of another copy, then a discard": async (d) => {
    // Another gone tab's copy is offered beside the restored hand-off: D chooses it, then the hand-off again, then discards.
    const other = d.model
      .view()
      .alternatives.find((copy) => copy.tabInstanceId === "X-gone");
    expect(other).toBeDefined();
    expect(await d.model.restoreAlternative("X-gone")).toBe("restored");
    const claimed = d.model
      .view()
      .alternatives.find((copy) =>
        copy.formContext.startsWith("atlas-update-handoff:"),
      );
    expect(claimed).toBeDefined();
    expect(
      await d.model.restoreAlternative(claimed?.tabInstanceId as string),
    ).toBe("restored");
    expect(await d.model.discard("")).toBe("discarded");
  },
};

describe("R42: the review's schedule, promoted", () => {
  for (const claimant of [
    "CONTROL the replacement only",
    "CONTROL an ordinary peer (no reference) first",
    "a copied-reference tab first",
  ] as const)
    test(`${claimant}: the original tab's replacement restores the update's input exactly`, async () => {
      const { a, storage, clone, handoff } = await writer();
      a.leave();
      if (claimant !== "CONTROL the replacement only") {
        const d = await page(
          "D",
          claimant === "a copied-reference tab first"
            ? clone
            : new TabStorage(),
        ).bound();
        expect(d.value).toBe(UNSENT);
        expect(await d.model.end()).toBe("discarded");
        d.leave();
      }
      expect((await handoffRows()).map(exact)).toEqual([handoff]);
      const b = await page("B", storage).bound();
      expect(b.model.view().ready).toBe(true);
      expect(b.value).toBe(UNSENT);
    });
});

describe("R42 (Q2): no destructive path of a copied-reference claimant consumes the protected hand-off", () => {
  for (const [name, consume] of Object.entries(consumers))
    test(`D's ${name}: the hand-off stays exactly; A's ordinary copy goes; B restores UNSENT; D's own copies are its own`, async () => {
      const { a, storage, clone, handoff } = await writer();
      const aOwn = a.tab.current();
      a.leave();
      // An unrelated gone tab's copy, left after A went, offered beside (the alternative path needs one).
      await world.store.save({
        formContext: CONTEXT,
        tabInstanceId: "X-gone",
        values: { model: '{"title":"X"}' },
        savedAt: new Date(0).toISOString(),
        capture: "x-capture",
      } as RecoverySnapshot);
      const d = await page("D", clone).bound();
      expect(d.value).toBe(UNSENT);
      await consume(d);
      // The protected hand-off, exactly as A wrote it.
      expect((await handoffRows()).map(exact)).toEqual([handoff]);
      // The ordinary copy it names (A's own, the same capture) may go once D accounted for it: it never outlives a removal D owed.
      const ordinary = (await ordinaryRows()).map((row) => row.tabInstanceId);
      if (name !== "its own save (the source's clean-up, its debts)")
        expect(ordinary).not.toContain(aOwn);
      d.leave();
      const b = await page("B", storage).bound();
      expect(b.value).toBe(UNSENT);
      expect(b.model.view().restored?.tabInstanceId).toBe(handoff.id);
    });
});

describe("R42 (Q2): the authority that remains, and the reference that is used up", () => {
  test("CONTROL the writer, still alive (its reload abandoned), removes its own hand-off at its own discard", async () => {
    const { a } = await writer();
    expect(await a.model.discard("")).toBe("discarded");
    expect(await handoffRows()).toEqual([]);
    expect(await ordinaryRows()).toEqual([]);
  });

  test("CONTROL a hand-off no live page holds is offered later, and the person's 'Discard this copy' removes it", async () => {
    const { a, storage, handoff } = await writer();
    a.leave();
    const b = await page("B", storage).bound();
    expect(b.value).toBe(UNSENT);
    const ticket = b.model.submitting();
    expect(await ticket?.succeeded()).toBe("discarded");
    // B's submission consumed its own input and A's ordinary copy, never the hand-off; while B lives, nobody else is offered it.
    expect((await handoffRows()).map(exact)).toEqual([handoff]);
    const e = await page("E").bound();
    expect(
      e.model.view().alternatives.map((copy) => copy.tabInstanceId),
    ).not.toContain(handoff.id);
    b.leave();
    const later = await page("F").bound();
    expect(later.value).toBe("");
    expect(
      later.model.view().alternatives.map((copy) => copy.tabInstanceId),
    ).toContain(handoff.id);
    expect(await later.model.discardAlternative(handoff.id)).toBe("discarded");
    expect(await handoffRows()).toEqual([]);
  });

  test("the claim uses the reference up: an ordinary reload of B's tab is offered the hand-off once B has gone, never restores it over its input", async () => {
    const { a, storage, handoff } = await writer();
    a.leave();
    const b = await page("B", storage).bound();
    expect(b.value).toBe(UNSENT);
    expect(storage.getItem("atlas-update-handoff")).toBeNull();
    const ticket = b.model.submitting();
    expect(await ticket?.succeeded()).toBe("discarded");
    b.leave();
    const reloaded = await page("B2", storage).bound();
    expect(reloaded.value).toBe("");
    expect(
      reloaded.model.view().alternatives.map((copy) => copy.tabInstanceId),
    ).toContain(handoff.id);
  });

  test("a tab copied BEFORE the reference was written holds none: an ordinary peer, the hand-off untouched", async () => {
    const storage = new TabStorage();
    const early = storage.copy();
    const a = await page("A", storage).bound();
    a.model.begin("{}");
    a.type(UNSENT);
    expect(await a.update()).toEqual(["saved", "saved"]);
    const handoff = exact((await handoffRows())[0] as RecoverySnapshot);
    a.leave();
    const d = await page("D", early).bound();
    expect(await d.model.end()).toBe("discarded");
    expect((await handoffRows()).map(exact)).toEqual([handoff]);
    const b = await page("B", storage).bound();
    expect(b.value).toBe(UNSENT);
  });

  test("D still alive when B looks: B cannot take the lock and falls back; the hand-off survives D's discard and is offered once D goes", async () => {
    const { a, storage, clone, handoff } = await writer();
    a.leave();
    const d = await page("D", clone).bound();
    expect(d.value).toBe(UNSENT);
    expect(await d.model.discard("")).toBe("discarded");
    const b = page("B", storage);
    b.model.bind(b.spy);
    await until(() => b.model.view().ready, 5_000);
    expect(b.value).toBe("");
    d.leave();
    expect((await handoffRows()).map(exact)).toEqual([handoff]);
    const c = await page("C").bound();
    expect(
      c.model.view().alternatives.map((copy) => copy.tabInstanceId),
    ).toContain(handoff.id);
  }, 10_000);
});

describe("R42 (Q2): the DOM form adapter keeps the same rule", () => {
  for (const consumer of ["Discard instead", "submission", "own save"] as const)
    test(`a copied-reference tab's ${consumer}: the hand-off stays; the replacement restores ORIGINAL`, async () => {
      const dom = new World();
      const { storage } = await updated(dom);
      const handoff = (await dom.handoffs())[0] as RecoverySnapshot;
      const d = await dom.page("D", storage.copy()).mount(5_000);
      expect(d.title).toBe(ORIGINAL);
      await act(async () => {
        if (consumer === "Discard instead")
          expect(await d.handle?.discard()).toBe("discarded");
        else if (consumer === "submission")
          expect(await d.handle?.submitting()?.succeeded()).toBe("discarded");
      });
      if (consumer === "own save") {
        d.type("D EDITED");
        expect(await d.flush()).toEqual(["saved"]);
      }
      expect((await dom.handoffs()).map(exact)).toEqual([exact(handoff)]);
      d.leave();
      const b = await dom.page("B", storage).mount(5_000);
      expect(b.title).toBe(ORIGINAL);
      // Nothing is restored over the replacement's own registry: its copy of the form is the one it shows.
      expect(handoffHandles(b.registry)).toHaveLength(1);
    }, 10_000);
});
