import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  forgetHandoff,
  handoffContext,
  handoffFor,
  prepareHandoffs,
  referenced,
  rememberHandoff,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import type { SaveResult } from "../../src/lib/form-recovery/port";
import { handoffLockName } from "../../src/lib/form-recovery/tab-identity";
import { isHandoff } from "../../src/lib/form-recovery/use-recoverable-form";
import { FLUSH_START_GRACE_MS } from "../../src/lib/pwa/coordinator";
import { FakeOrigin, flush, type Tab } from "../pwa/coordinator-world";
import {
  FORM,
  ORIGINAL,
  type Page,
  type ScopedSpyPort,
  TabStorage,
  THIRD,
  updated,
  World,
} from "../support/recovery-pages";

/**
 * WEB-14a revision 7 (review of 13 October 2026: R6 `update-discard-recovery-invalidation`, regression; R13
 * `recovery-shared-source-reload-coverage`, incomplete fix; R15 `recovery-handoff-read-before-claim`, new; design assessment of 13 October
 * 2026: DA-A `handoff-reference-read-modify-write-failure`, DA-B `recovery-cached-alternative-freshness`, caller/schedule matrix Q1-Q11).
 * A = the page that updates, A2 = the next page of the SAME tab, C/D/E = other tabs, DUP = a duplicated (opener-copied) tab of A's. Every
 * order is forced by what a page does when (a held or refused read, a lock request seen waiting), never by time, except where the
 * production 2 s hand-off claim wait IS the schedule (Q7). Each case asserts the decisive outcome (what a page shows, what the store holds,
 * who may remove what) with a control that differs only in the fault. Real hook, session, registry, identity and coordinator; memory store.
 * FIXTURE evidence: the native store/locks and the worker update are the revision-7 browser cases.
 */
afterEach(() => {
  cleanup();
});

const OTHER = "task-edit:/tasks/42";
const PENDING = "atlas-recovery-handoff-";

/** C restores A's ordinary copy and saves different input, and stays alive: A's ordinary copy is gone (consumed). */
async function consumer(world: World): Promise<Page> {
  const c = await world.page("C").mount();
  expect(c.title).toBe(ORIGINAL);
  c.type(THIRD);
  expect(await c.flush()).toEqual(["saved"]);
  return c;
}

describe("R13 (Q4, Q5): a look that cannot read the store is not an empty answer", () => {
  for (const failing of [false, true])
    test(`${failing ? "" : "control: "}A2's hand-off read ${failing ? "fails after C consumed A's ordinary copy: not ready, unavailable, nothing restored, offered, claimed or forgotten; repaired, 'Try again' restores ORIGINAL" : "succeeds: ORIGINAL"}`, async () => {
      const world = new World();
      const { storage } = await updated(world);
      const handoff = (await world.handoffs())[0];
      await consumer(world);
      const a2 = world.page("A2", storage);
      if (failing) a2.spy.failHandoffLoads = 1;
      a2.show();
      await waitFor(() =>
        expect(
          a2.handle?.ready === true || a2.handle?.unavailable === true,
        ).toBe(true),
      );
      if (failing) {
        expect(a2.handle?.unavailable).toBe(true);
        expect(a2.handle?.ready).toBe(false);
        expect(a2.title).toBe("");
        expect(a2.handle?.restored).toBeNull();
        expect(a2.handle?.alternatives).toEqual([]);
        // Nothing removed or forgotten: the hand-off and its reference are still there; A2 holds the lock it read under.
        expect((await world.handoffs()).map((c) => c.values.title)).toEqual([
          ORIGINAL,
        ]);
        expect(storage.getItem("atlas-update-handoff")).not.toBeNull();
        // Not ready, so nothing of the form is taken for clean: the update's checkpoint sees it unresolved.
        expect(a2.registry.all().some((h) => h.unresolved?.())).toBe(true);
        let again: boolean | undefined;
        await act(async () => {
          again = await a2.handle?.retry();
        });
        expect(again).toBe(true);
      }
      expect(a2.handle?.ready).toBe(true);
      expect(a2.handle?.unavailable).toBe(false);
      expect(a2.title).toBe(ORIGINAL);
      expect(a2.handle?.restored?.formContext).toBe(handoffContext(FORM));
      // A2 holds the hand-off. Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was "its own save removes it"; now
      // its own save leaves it exactly as A wrote it (A2 restores it, never removes it), and its reference went once A2's look was applied.
      expect(await a2.flush()).toEqual(["saved"]);
      expect(await world.handoffs()).toEqual([handoff]);
      expect(storage.getItem("atlas-update-handoff")).toBeNull();
    });

  type Fault = { name: string; inject(a2: Page, storage: TabStorage): void };
  const faults: Fault[] = [
    {
      name: "the ordinary list",
      inject: (a2) => {
        a2.spy.failLists = 1;
      },
    },
    {
      name: "the list of abandoned hand-offs",
      inject: (a2) => {
        a2.spy.failHandoffLists = 1;
      },
    },
    {
      name: "the tab's reference record",
      inject: (_a2, storage) => {
        storage.failReads = 1;
      },
    },
  ];
  for (const fault of faults)
    test(`${fault.name} cannot be read: unavailable (nothing restored or claimed); 'Try again' restores ORIGINAL`, async () => {
      const world = new World();
      const { storage } = await updated(world);
      await consumer(world);
      const a2 = world.page("A2", storage);
      fault.inject(a2, storage);
      a2.show();
      await waitFor(() => expect(a2.handle?.unavailable).toBe(true));
      expect(a2.handle?.ready).toBe(false);
      expect(a2.title).toBe("");
      expect(a2.handle?.alternatives).toEqual([]);
      expect(await world.handoffs()).toHaveLength(1);
      await act(async () => {
        expect(await a2.handle?.retry()).toBe(true);
      });
      expect(a2.title).toBe(ORIGINAL);
      expect(a2.handle?.ready).toBe(true);
    });

  test("controls: a genuinely empty store, and a hand-off already resolved (its writer discarded it), are successful empty looks: ready, blank, the stale reference forgotten; a hand-off A2 submitted stays, and DUP restores it", async () => {
    const empty = await new World().page("X").mount();
    expect(empty.handle?.unavailable).toBe(false);
    expect(empty.title).toBe("");
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was "a hand-off A2 submitted is resolved:
    // DUP's look is empty"; A2's submission no longer removes it (below), so the resolved hand-off is now one its own writer removed: A
    // prepared its update, the reload did not happen, and A discarded its form (its own hand-off goes with it).
    const resolved = new World();
    const tab = new TabStorage();
    const a = await resolved.page("A", tab).mount();
    a.type(ORIGINAL);
    expect(await a.update()).toEqual(["saved", "saved"]);
    const stale = tab.copy();
    await act(async () => {
      expect(await a.handle?.discard()).toBe("discarded");
    });
    a.leave();
    expect(await resolved.handoffs()).toEqual([]);
    // A copy of the tab's storage still names the hand-off A resolved.
    expect(stale.getItem("atlas-update-handoff")).not.toBeNull();
    const after = await resolved.page("DUP", stale).mount();
    expect(after.handle?.unavailable).toBe(false);
    expect(after.title).toBe("");
    expect(after.handle?.alternatives).toEqual([]);
    expect(stale.getItem("atlas-update-handoff")).toBeNull();
    // The old schedule: A2 submits and leaves; DUP's copied reference finds the hand-off, which stayed, and restores it (never submitted).
    const world = new World();
    const { storage } = await updated(world);
    const handoff = (await world.handoffs())[0];
    const copied = storage.copy();
    const a2 = await world.page("A2", storage).mount();
    const ticket = a2.handle?.submitting();
    await act(async () => {
      expect(await ticket?.succeeded()).toBe("discarded");
    });
    a2.leave();
    expect(await world.handoffs()).toEqual([handoff]);
    expect(copied.getItem("atlas-update-handoff")).not.toBeNull();
    const later = await world.page("DUP", copied).mount();
    expect(later.handle?.unavailable).toBe(false);
    expect(later.title).toBe(ORIGINAL);
    expect(later.handle?.restored?.formContext).toBe(handoffContext(FORM));
    expect(copied.getItem("atlas-update-handoff")).toBeNull();
    expect(await world.handoffs()).toEqual([handoff]);
  });

  test("a form mounted again whose offer look fails is not ready until it has read the store again", async () => {
    const world = new World();
    const a = await world.page("A").mount();
    a.type(ORIGINAL);
    expect(await a.flush()).toEqual(["saved"]);
    a.rerender([]);
    // Another tab left a copy meanwhile; A's form comes back, resuming its session, and cannot list it.
    const gone = await world.page("G").mount();
    gone.type("LEFT BY G");
    expect(await gone.flush()).toEqual(["saved"]);
    gone.leave();
    a.spy.failLists = 1;
    a.rerender([FORM]);
    await waitFor(() => expect(a.handle?.unavailable).toBe(true));
    expect(a.handle?.ready).toBe(false);
    // Its own input is shown at once (resumed), untouched by the failure.
    expect(a.title).toBe(ORIGINAL);
    await act(async () => {
      expect(await a.handle?.retry()).toBe(true);
    });
    expect(a.handle?.ready).toBe(true);
    expect(a.handle?.alternatives.map((c) => c.values.title)).toEqual([
      "LEFT BY G",
    ]);
  });
});

describe("C4 (Q13): one look reads one account database", () => {
  for (const changed of [false, true])
    test(`${changed ? "" : "control: "}the account's database ${changed ? "is created again while A2's look reads: nothing is restored or claimed; the look is unavailable" : "stays the same: ORIGINAL"}`, async () => {
      const world = new World();
      world.scoped = true;
      const { storage } = await updated(world);
      const a2 = world.page("A2", storage);
      a2.spy.hold();
      a2.show();
      await waitFor(() => expect(a2.spy.reached).toBe(true));
      if (changed) (a2.spy as ScopedSpyPort).scope = "scope-2";
      a2.spy.release();
      await waitFor(() =>
        expect(
          a2.handle?.ready === true || a2.handle?.unavailable === true,
        ).toBe(true),
      );
      if (changed) {
        expect(a2.handle?.unavailable).toBe(true);
        expect(a2.title).toBe("");
        expect(a2.handle?.restored).toBeNull();
      } else expect(a2.title).toBe(ORIGINAL);
    });
});

describe("R13 (Q4): an update's save does not reload a page whose look could not read the store", () => {
  /** A2 (unavailable) with a coordinator over its registry and B waiting. */
  async function unresolvedPage(): Promise<{
    world: World;
    storage: TabStorage;
    a2: Page;
    origin: FakeOrigin;
    tab: Tab;
    waiting: Awaited<ReturnType<FakeOrigin["installNew"]>>;
  }> {
    const world = new World();
    const { storage } = await updated(world);
    const a2 = world.page("A2", storage);
    a2.spy.failHandoffLoads = 2;
    a2.show();
    await waitFor(() => expect(a2.handle?.unavailable).toBe(true));
    const origin = new FakeOrigin();
    const tab = origin.tab();
    Object.defineProperty(tab, "forms", { value: a2.registry });
    await tab.start();
    const waiting = await origin.installNew(2);
    return { world, storage, a2, origin, tab, waiting };
  }

  test("still unreadable at the update's own retry: 'could not save', nothing reloads; repaired, 'Retry save' reads it and reloads; A3 restores ORIGINAL", async () => {
    const { world, storage, a2, origin, tab, waiting } = await unresolvedPage();
    const loads = a2.spy.handoffLoads;
    await act(async () => {
      tab.actions?.accept();
      await flush();
    });
    // The coordinator asked the form to look again (once): still unreadable.
    expect(a2.spy.handoffLoads).toBe(loads + 1);
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(tab.reloads).toBe(0);
    // Repaired (failHandoffLoads used up): the retry reads it, and the reload goes ahead.
    await act(async () => {
      tab.actions?.retrySave();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await origin.activate(waiting);
    });
    expect(tab.reloads).toBe(1);
    a2.leave();
    // Nothing was lost on the way: the next page restores ORIGINAL from the same hand-off.
    const a3 = await world.page("A3", storage).mount();
    expect(a3.title).toBe(ORIGINAL);
  });

  test("control: readable at the update's own retry: the update proceeds at once", async () => {
    const { a2, origin, tab, waiting } = await unresolvedPage();
    a2.spy.failHandoffLoads = 0;
    await act(async () => {
      tab.actions?.accept();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await origin.activate(waiting);
    });
    expect(tab.reloads).toBe(1);
  });
});

describe("R15 (Q6, Q7): the hand-off is read only under its lock, and only what was read then is shown", () => {
  type Terminal = {
    name: string;
    control?: boolean;
    run(a2: Page): Promise<void>;
  };
  const terminals: Terminal[] = [
    {
      name: "A2 leaves with no terminal act",
      control: true,
      run: async () => undefined,
    },
    {
      name: "A2 discards ('Discard instead'), then leaves",
      run: async (a2) => {
        await act(async () => {
          expect(await a2.handle?.discard()).toBe("discarded");
        });
      },
    },
    {
      name: "A2's submission succeeds, then A2 leaves",
      run: async (a2) => {
        const ticket = a2.handle?.submitting();
        await act(async () => {
          expect(await ticket?.succeeded()).toBe("discarded");
        });
      },
    },
  ];
  for (const terminal of terminals)
    test(`${terminal.control ? "control: " : ""}DUP (copied reference) waits for the lock A2 holds; ${terminal.name}; DUP reads only once it holds it and shows ${terminal.control ? "ORIGINAL, as its source" : "ORIGINAL from the hand-off, which stayed"}`, async () => {
      const world = new World();
      const { storage } = await updated(world);
      const handoff = (await world.handoffs())[0];
      const copied = storage.copy();
      const a2 = await world.page("A2", storage).mount();
      expect(a2.title).toBe(ORIGINAL);
      const dup = world.page("DUP", copied);
      dup.spy.hold();
      dup.show();
      // DUP is waiting for the hand-off's lock, and has read nothing of it.
      await waitFor(() =>
        expect(world.locks.waits(dup.name, PENDING)).toBe(true),
      );
      expect(dup.spy.handoffLoads).toBe(0);
      await terminal.run(a2);
      a2.leave();
      // DUP holds the lock now and reads; its completed read is held, then delivered.
      await waitFor(() => expect(dup.spy.reached).toBe(true));
      dup.spy.release();
      await waitFor(() => expect(dup.handle?.ready).toBe(true));
      expect(dup.spy.handoffLoads).toBe(1);
      if (terminal.control) {
        expect(dup.title).toBe(ORIGINAL);
        // It holds the hand-off. Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was "its own save removes it";
        // now it stays exactly (DUP's copied reference proves nothing about which page replaced A).
        expect(await dup.flush()).toEqual(["saved"]);
        expect(await world.handoffs()).toEqual([handoff]);
      } else {
        // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was "DUP shows nothing and the store is
        // empty" (A2's terminal act consumed the hand-off); now A2's act removed only its own copies and A's ordinary one, the hand-off
        // stayed, and DUP (which nothing distinguishes from A's replacement) restores it, never submitting it.
        expect(dup.title).toBe(ORIGINAL);
        expect(dup.handle?.restored?.formContext).toBe(handoffContext(FORM));
        expect(await world.rows()).toEqual([
          ["handoff", handoff?.tabInstanceId, ORIGINAL],
        ]);
      }
    });

  test("A2 stays: DUP's lock wait (the production 2 s) ends; DUP falls back to the ordinary copies without reading the hand-off, and never removes it", async () => {
    const world = new World();
    const { storage } = await updated(world);
    const handoff = (await world.handoffs())[0];
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): the duplicate was copied after A2's
    // look; now it is copied before (A2's applied look drops the tab's reference, so a later copy would carry none and wait for nothing).
    const copied = storage.copy();
    const a2 = await world.page("A2", storage).mount();
    expect(copied.getItem("atlas-update-handoff")).not.toBeNull();
    const dup = await world.page("DUP", copied).mount(5_000);
    // Ordinary selection: A's ordinary copy (A has gone; A2 has not saved yet), never the hand-off A2 holds.
    expect(dup.spy.handoffLoads).toBe(0);
    expect(dup.title).toBe(ORIGINAL);
    expect(dup.handle?.restored?.formContext).toBe(FORM);
    expect(await dup.flush()).toEqual(["saved"]);
    expect(await world.handoffs()).toHaveLength(1);
    // A2 still holds it and is unaffected.
    expect(a2.title).toBe(ORIGINAL);
    expect(await a2.flush()).toEqual(["saved"]);
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was "A2's own save removes it"; now
    // it stays exactly (A2 restores it, never removes it).
    expect(await world.handoffs()).toEqual([handoff]);
  }, 10_000);

  test("A2 stays and has saved its own copy: DUP finds no gone tab's copy and shows nothing; the input stays A2's", async () => {
    const world = new World();
    const { storage } = await updated(world);
    const a2 = await world.page("A2", storage).mount();
    expect(await a2.flush()).toEqual(["saved"]);
    // A2's own save removed A's twin (revision 40, R42: the hand-off stays, held by A2, and the tab's reference went at A2's look); no gone
    // tab's copy is left to take over.
    const dup = await world.page("DUP", storage.copy()).mount(5_000);
    expect(dup.title).toBe("");
    expect(dup.handle?.alternatives).toEqual([]);
    expect(a2.title).toBe(ORIGINAL);
  }, 10_000);

  test("DUP typed before its look answered: its own input stays; nothing is restored over it", async () => {
    const world = new World();
    const { storage } = await updated(world);
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): the duplicate was copied after A2's
    // look; now before it (A2's applied look drops the tab's reference, so a later copy would carry none and wait for nothing).
    const copied = storage.copy();
    await world.page("A2", storage).mount();
    const dup = world.page("DUP", copied);
    dup.show();
    await waitFor(() =>
      expect(world.locks.waits(dup.name, PENDING)).toBe(true),
    );
    dup.type("TYPED IN DUP");
    await waitFor(() => expect(dup.handle?.ready).toBe(true), {
      timeout: 5_000,
    });
    expect(dup.title).toBe("TYPED IN DUP");
    expect(dup.handle?.restored).toBeNull();
  }, 10_000);

  test("a reference to a hand-off that no longer exists: an empty look (ordinary selection); the stale reference is forgotten", async () => {
    const world = new World();
    const storage = new TabStorage();
    storage.setItem(
      "atlas-update-handoff",
      JSON.stringify([{ form: FORM, scope: "", id: "gone-handoff" }]),
    );
    const a2 = await world.page("A2", storage).mount();
    expect(a2.handle?.unavailable).toBe(false);
    expect(a2.title).toBe("");
    expect(storage.getItem("atlas-update-handoff")).toBeNull();
  });

  test("the hand-off's lock cannot be requested (the lock manager throws): no read, no claim; ordinary selection", async () => {
    const world = new World();
    const { storage } = await updated(world);
    world.locks.refuse = (name) => name.startsWith(PENDING);
    const a2 = await world.page("A2", storage).mount();
    expect(a2.spy.handoffLoads).toBe(0);
    // A's ordinary copy, as a gone tab's, never as the hand-off's successor.
    expect(a2.title).toBe(ORIGINAL);
    expect(a2.handle?.restored?.formContext).toBe(FORM);
    world.locks.refuse = () => false;
    expect(await a2.flush()).toEqual(["saved"]);
    expect(await world.handoffs()).toHaveLength(1);
  });
});

describe("DA-B (Q8): a chosen alternative is read again before it is shown", () => {
  /** A's update was abandoned and C removed A's ordinary copy: D is offered only the hand-off. */
  async function abandoned(world: World): Promise<Page> {
    await updated(world);
    const c = await world.page("C").mount();
    await act(async () => {
      expect(await c.handle?.discard()).toBe("discarded");
    });
    c.leave();
    const d = await world.page("D").mount();
    expect(d.handle?.alternatives.map((copy) => isHandoff(copy))).toEqual([
      true,
    ]);
    return d;
  }

  for (const resolved of [false, true])
    test(`${resolved ? "" : "control: "}an abandoned hand-off ${resolved ? "explicitly discarded by E after D listed it: D's choice reads it again, 'gone', nothing shown, no longer offered" : "still there: D's choice shows it"}`, async () => {
      const world = new World();
      const d = await abandoned(world);
      const id = d.handle?.alternatives[0]?.tabInstanceId as string;
      if (resolved) {
        const e = await world.page("E").mount();
        await act(async () => {
          expect(await e.handle?.discardAlternative(id)).toBe("discarded");
        });
        e.leave();
      }
      let result: string | undefined;
      await act(async () => {
        result = await d.handle?.restoreAlternative(id);
      });
      if (resolved) {
        expect(result).toBe("gone");
        expect(d.title).toBe("");
        expect(d.handle?.restored).toBeNull();
        expect(d.handle?.alternatives).toEqual([]);
      } else {
        expect(result).toBe("restored");
        expect(d.title).toBe(ORIGINAL);
        // Never taken over: D's own save leaves the hand-off.
        expect(await d.flush()).toEqual(["saved"]);
        expect(await world.handoffs()).toHaveLength(1);
      }
    });

  test("an ordinary alternative discarded since it was listed: 'gone'; one that cannot be read: 'unavailable', still offered", async () => {
    const world = new World();
    // Two tabs, both open while they save (neither restores the other's copy), then both gone.
    const pages: Page[] = [];
    for (const name of ["OLD", "NEW"])
      pages.push(await world.page(name).mount());
    for (const [page, text] of [
      [pages[0], "OLDER COPY"],
      [pages[1], "NEWER COPY"],
    ] as const) {
      page?.type(text);
      expect(await page?.flush()).toEqual(["saved"]);
    }
    for (const page of pages) page.leave();
    const d = await world.page("D").mount();
    // One is restored (the newest by its save time, which may tie within a millisecond here), the other offered.
    const shown = d.title;
    const older = d.handle?.alternatives[0];
    expect([shown, older?.values.title].sort()).toEqual([
      "NEWER COPY",
      "OLDER COPY",
    ]);
    d.spy.failLists = 0;
    const failing = d.port.load;
    d.port.load = () => Promise.reject(new Error("unreadable"));
    let result: string | undefined;
    await act(async () => {
      result = await d.handle?.restoreAlternative(
        older?.tabInstanceId as string,
      );
    });
    expect(result).toBe("unavailable");
    expect(d.title).toBe(shown);
    expect(d.handle?.alternatives).toHaveLength(1);
    d.port.load = failing;
    // Another page resolved it meanwhile (its terminal row is durable).
    await world.store.discard(FORM, older?.tabInstanceId as string);
    await act(async () => {
      result = await d.handle?.restoreAlternative(
        older?.tabInstanceId as string,
      );
    });
    expect(result).toBe("gone");
    expect(d.title).toBe(shown);
    expect(d.handle?.alternatives).toEqual([]);
  });

  test("a live page took the abandoned hand-off before D chose it: refused, nothing shown", async () => {
    const world = new World();
    const d = await abandoned(world);
    const id = d.handle?.alternatives[0]?.tabInstanceId as string;
    world.locks.held.set(handoffLockName(id), "someone");
    let result: string | undefined;
    await act(async () => {
      result = await d.handle?.restoreAlternative(id);
    });
    expect(result).toBe("refused");
    expect(d.title).toBe("");
  });

  test("the form changed while the choice read the copy: refused, the person's input stays", async () => {
    const world = new World();
    const d = await abandoned(world);
    const id = d.handle?.alternatives[0]?.tabInstanceId as string;
    d.spy.hold();
    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = d.handle?.restoreAlternative(id);
    });
    await waitFor(() => expect(d.spy.reached).toBe(true));
    d.type("TYPED MEANWHILE");
    d.spy.release();
    let result: unknown;
    await act(async () => {
      result = await pending;
    });
    expect(result).toBe("refused");
    expect(d.title).toBe("TYPED MEANWHILE");
  });

  test("D restored the abandoned hand-off and edited it; E's explicit discard of the hand-off afterwards leaves D's input, and D's own save keeps it", async () => {
    const world = new World();
    const d = await abandoned(world);
    const id = d.handle?.alternatives[0]?.tabInstanceId as string;
    await act(async () => {
      expect(await d.handle?.restoreAlternative(id)).toBe("restored");
    });
    d.type(`${ORIGINAL} EDITED BY D`);
    const e = await world.page("E").mount();
    await act(async () => {
      expect(await e.handle?.discardAlternative(id)).toBe("discarded");
    });
    expect(d.title).toBe(`${ORIGINAL} EDITED BY D`);
    expect(await d.flush()).toEqual(["saved"]);
    expect((await world.rows()).map(([, , title]) => title)).toEqual([
      `${ORIGINAL} EDITED BY D`,
    ]);
  });
});

describe("DA-A (Q9): the tab's reference record is never rewritten from an unknown base", () => {
  test("unreadable or not a list: nothing written, no reference taken, nothing certified; entries this page cannot read are kept as they are", () => {
    const storage = new TabStorage();
    const store = storageHandoffs(() => storage as unknown as Storage);
    const ref = { form: FORM, scope: "s", id: "ref-one" };
    expect(rememberHandoff(store, ref)).toBe(true);
    // Unreadable: no write, unknown.
    storage.unreadable = true;
    expect(
      rememberHandoff(store, { form: OTHER, scope: "s", id: "ref-two" }),
    ).toBe(false);
    expect(handoffFor(store, FORM, "s")).toEqual({ kind: "unknown" });
    expect(referenced(store, ref)).toBe(false);
    expect(forgetHandoff(store, "ref-one")).toBe(false);
    storage.unreadable = false;
    expect(JSON.parse(storage.getItem("atlas-update-handoff") ?? "")).toEqual([
      ref,
    ]);
    // Not a list: no write over it.
    storage.items.set("atlas-update-handoff", '{"not":"a list"}');
    expect(
      rememberHandoff(store, { form: OTHER, scope: "s", id: "ref-two" }),
    ).toBe(false);
    expect(storage.getItem("atlas-update-handoff")).toBe('{"not":"a list"}');
    // An entry of another build is kept through writes and forgets.
    storage.items.set(
      "atlas-update-handoff",
      JSON.stringify([{ v: 2, opaque: true }, ref]),
    );
    expect(
      rememberHandoff(store, { form: OTHER, scope: "s", id: "ref-two" }),
    ).toBe(true);
    expect(forgetHandoff(store, "ref-one")).toBe(true);
    expect(JSON.parse(storage.getItem("atlas-update-handoff") ?? "")).toEqual([
      { v: 2, opaque: true },
      { form: OTHER, scope: "s", id: "ref-two" },
    ]);
    // Control: a missing record is an empty one.
    storage.items.clear();
    expect(handoffFor(store, FORM, "s")).toEqual({ kind: "none" });
  });

  test("two forms: the record cannot be read during the second form's hand-off; the first form's reference is kept, the update is not certified until the retry writes the second", async () => {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage, [FORM, OTHER]).mount();
    a.type(ORIGINAL, FORM);
    a.type("SECOND FORM", OTHER);
    expect(await a.flush()).toEqual(["saved", "saved"]);
    const [first, second] = a.registry.all();
    let results: SaveResult[] = [];
    await act(async () => {
      results = [(await first?.handoff?.()) as SaveResult];
    });
    expect(results).toEqual(["saved"]);
    const firstRefs = storage.getItem("atlas-update-handoff");
    // The second form's read of the record fails once (its write must not replace the first form's reference).
    storage.failReads = 1;
    await act(async () => {
      results = [(await second?.handoff?.()) as SaveResult];
    });
    expect(results).toEqual(["failed"]);
    expect(storage.getItem("atlas-update-handoff")).toBe(firstRefs);
    expect(first?.handedOff?.()).toBe(true);
    expect(second?.handedOff?.()).toBe(false);
    await act(async () => {
      results = await prepareHandoffs(a.registry);
    });
    expect(results).toEqual(["saved"]);
    expect(a.registry.all().every((h) => h.handedOff?.())).toBe(true);
    a.leave();
    const a2 = await world.page("A2", storage, [FORM, OTHER]).mount();
    expect(a2.value(FORM)).toBe(ORIGINAL);
    expect(a2.value(OTHER)).toBe("SECOND FORM");
  });

  // Adapted in revision 8 (review of 13 October 2026, DA-C; design assessment C3): the original (preserved in
  // `.agtx/evidence/WEB-14a/revision-8/adapted/original/`) expected the second mount offered ONCE, because revision 7 hid an abandoned
  // hand-off whenever another offered copy held equal text. Equal text is no identity: the second mount's ordinary copy and its unreferenced
  // hand-off are two copies, and each stays addressable (neither is named by the hand-off this page took over: the ordinary copy now holds
  // the second mount's capture, not the one the first mount's hand-off owes). Same intent: one reference, certified, ORIGINAL restored, the
  // other mount's input offered.
  test("two mounts of one form context: only the context's session is referenced (they never replace each other's reference); the update is certified; the next page restores one and offers the other (adapted, revision 8)", async () => {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage, [FORM, FORM]).mount();
    a.typeAt(0, ORIGINAL);
    a.typeAt(1, "SECOND MOUNT");
    expect(await a.update()).toEqual(["saved", "saved", "saved", "saved"]);
    expect(a.registry.all().every((h) => h.handedOff?.())).toBe(true);
    expect(
      JSON.parse(storage.getItem("atlas-update-handoff") ?? "[]"),
    ).toHaveLength(1);
    a.leave();
    const a2 = await world.page("A2", storage).mount();
    const shown = a2.title;
    expect(shown).toBe(ORIGINAL);
    const offered = (a2.handle?.alternatives ?? []).map((c) => [
      c.formContext === FORM ? "ordinary" : "handoff",
      c.values.title,
    ]);
    expect(offered.sort()).toEqual(
      [
        ["handoff", "SECOND MOUNT"],
        ["ordinary", "SECOND MOUNT"],
      ].sort(),
    );
  });

  test("a form's reference dropped from the record after its hand-off (another writer): no longer certified; the next preparation writes it again", async () => {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage).mount();
    a.type(ORIGINAL);
    expect(await a.update()).toEqual(["saved", "saved"]);
    const handle = a.registry.all()[0];
    expect(handle?.handedOff?.()).toBe(true);
    storage.items.delete("atlas-update-handoff");
    expect(handle?.handedOff?.()).toBe(false);
    let results: SaveResult[] = [];
    await act(async () => {
      results = await prepareHandoffs(a.registry);
    });
    expect(results).toEqual(["saved"]);
    expect(handle?.handedOff?.()).toBe(true);
  });
});

describe("R6 (Q1-Q3): 'Discard and reload anyway' after a save that failed part of the way, over the real form and coordinator", () => {
  /** A typed ORIGINAL; a coordinator over its registry with B waiting; `fault` injected before "Save and reload". */
  async function failedSave(
    fault: (world: World, a: Page, storage: TabStorage) => void,
    forms = [FORM],
  ) {
    const world = new World();
    const storage = new TabStorage();
    const a = await world.page("A", storage, forms).mount();
    for (const context of forms) a.type(ORIGINAL, context);
    const origin = new FakeOrigin();
    const tab = origin.tab();
    Object.defineProperty(tab, "forms", { value: a.registry });
    await tab.start();
    const waiting = await origin.installNew(2);
    fault(world, a, storage);
    await act(async () => {
      tab.actions?.accept();
      await flush();
    });
    return { world, storage, a, origin, tab, waiting };
  }
  const handoffSavesFail = (world: World, a: Page) => {
    const save = world.store.save.bind(world.store);
    a.port.save = (snapshot) =>
      snapshot.formContext.startsWith("atlas-update-handoff:")
        ? Promise.resolve<SaveResult>("failed")
        : save(snapshot);
  };
  const legs = [
    {
      name: "the reference cannot be written",
      fault: (_w: World, _a: Page, storage: TabStorage) => {
        storage.failing = true;
      },
    },
    { name: "the hand-off row cannot be written", fault: handoffSavesFail },
  ];
  for (const leg of legs)
    test(`${leg.name}: the form's own copy was saved (clean); the discard removes it and every hand-off; the reload follows; A2 shows the form empty`, async () => {
      const { world, storage, a, origin, tab, waiting } = await failedSave(
        leg.fault,
      );
      expect(tab.state).toEqual({ kind: "save_failed", refused: false });
      expect(a.dirty()).toBe(0);
      expect((await world.rows()).map(([where]) => where)).toContain(
        "ordinary",
      );
      storage.failing = false;
      await act(async () => {
        tab.actions?.discardAndReload();
        await flush();
        await origin.clock.advance(FLUSH_START_GRACE_MS);
        await origin.activate(waiting);
      });
      expect(tab.reloads).toBe(1);
      expect(await world.rows()).toEqual([]);
      a.leave();
      const a2 = await world.page("A2", storage).mount();
      expect(a2.title).toBe("");
      expect(a2.handle?.restored).toBeNull();
      expect(a2.handle?.alternatives).toEqual([]);
    });

  test("control: the reference repaired, 'Retry save' writes it and reloads; A2 restores ORIGINAL", async () => {
    const { world, storage, origin, tab, waiting, a } = await failedSave(
      legs[0]?.fault as never,
    );
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    storage.failing = false;
    await act(async () => {
      tab.actions?.retrySave();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await origin.activate(waiting);
    });
    expect(tab.reloads).toBe(1);
    a.leave();
    const a2 = await world.page("A2", storage).mount();
    expect(a2.title).toBe(ORIGINAL);
  });

  test("two forms and a kept form no mount shows: the first hands off, the second's hand-off fails; the discard removes every copy and the first form's hand-off and reference", async () => {
    const world = new World();
    const storage = new TabStorage();
    const kept = "task-edit:/tasks/43";
    const a = await world.page("A", storage, [FORM, OTHER, kept]).mount();
    for (const context of [FORM, OTHER, kept]) a.type(ORIGINAL, context);
    expect(await a.flush()).toEqual(["saved", "saved", "saved"]);
    // The third form is unmounted (another route): clean, with a copy, kept by the page.
    a.rerender([FORM, OTHER]);
    const origin = new FakeOrigin();
    const tab = origin.tab();
    Object.defineProperty(tab, "forms", { value: a.registry });
    await tab.start();
    const waiting = await origin.installNew(2);
    const save = world.store.save.bind(world.store);
    a.port.save = (snapshot) =>
      snapshot.formContext === handoffContext(OTHER)
        ? Promise.resolve<SaveResult>("failed")
        : save(snapshot);
    await act(async () => {
      tab.actions?.accept();
      await flush();
    });
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    // The first (and kept) forms' hand-offs and references were written before the second failed.
    expect(await world.handoffs(FORM)).toHaveLength(1);
    expect(storage.getItem("atlas-update-handoff")).not.toBeNull();
    await act(async () => {
      tab.actions?.discardAndReload();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await origin.activate(waiting);
    });
    expect(tab.reloads).toBe(1);
    for (const context of [FORM, OTHER, kept])
      expect(await world.rows(context)).toEqual([]);
    expect(storage.getItem("atlas-update-handoff")).toBeNull();
  });

  test("a discard that does not land: 'could not clear', nothing reloads; repaired, trying again discards and reloads", async () => {
    const { world, storage, origin, tab, waiting } = await failedSave(
      (_w, _a, s) => {
        s.failing = true;
      },
    );
    storage.failing = false;
    world.store.failDiscards = true;
    await act(async () => {
      tab.actions?.discardAndReload();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    expect(tab.state).toEqual({ kind: "discard_failed" });
    expect(tab.reloads).toBe(0);
    expect((await world.rows()).length).toBeGreaterThan(0);
    world.store.failDiscards = false;
    await act(async () => {
      tab.actions?.discardAndReload();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await origin.activate(waiting);
    });
    expect(tab.reloads).toBe(1);
    expect(await world.rows()).toEqual([]);
  });

  test("a discard refused (the account is being signed out): the reload goes ahead without claiming the copies are gone", async () => {
    const { world, storage, origin, tab, waiting } = await failedSave(
      (_w, _a, s) => {
        s.failing = true;
      },
    );
    storage.failing = false;
    world.store.refuseSaves = true;
    await act(async () => {
      tab.actions?.discardAndReload();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await origin.activate(waiting);
    });
    expect(tab.reloads).toBe(1);
    // Nothing was written: the copies are still there (the account's database goes with every copy when the sign-out completes).
    expect((await world.rows()).length).toBeGreaterThan(0);
  });
});
