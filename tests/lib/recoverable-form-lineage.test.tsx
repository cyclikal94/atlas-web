import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { lineageOf } from "../../src/lib/form-recovery/control-state";
import { handoffContext } from "../../src/lib/form-recovery/handoff";
import type {
  DiscardResult,
  RecoverySnapshot,
  SaveResult,
} from "../../src/lib/form-recovery/port";
import { isHandoff } from "../../src/lib/form-recovery/use-recoverable-form";
import {
  FORM,
  ORIGINAL,
  type Page,
  TabStorage,
  World,
} from "../support/recovery-pages";

/**
 * WEB-14a revision 8, R16 (review of 13 October 2026, `recovery-equal-value-twin-authority`; design assessment C1-C3, DA-C; Q1-Q5), over the
 * real hook, session, registry and recovery identity (`recovery-pages.tsx`). Revision 7 took the first ordinary copy of a gone tab holding
 * the hand-off's TEXT for the hand-off's predecessor, and removed it with the hand-off. Every case here asserts COPY IDENTITIES (row ids,
 * which copy is restored after a reload), never only the text, so equal text cannot hide a wrong removal.
 *
 * The review's schedule: B opens and saves and stays open; A opens independently (B is live: A starts blank), types ORIGINAL, saves and
 * prepares its update (its ordinary copy P and its hand-off H), and goes; B then holds `bText` (equal: ORIGINAL; the control: other text),
 * saves LATER than A and closes; A2 (A's tab) returns and takes H over.
 */
afterEach(cleanup);

interface Schedule {
  world: World;
  storage: TabStorage;
  a2: Page;
  aId: string;
  bId: string;
  /** The hand-off's id. */
  hId: string;
}

async function reviewSchedule(
  bText: string,
  options: { bFirst?: boolean; tied?: boolean; extraEqual?: number } = {},
): Promise<Schedule> {
  const world = new World();
  const pin = (page: Page): Page => {
    // Every copy saved at one instant (the "equal timestamps" variant): order by time confers nothing either.
    if (options.tied) {
      const save = world.store.save.bind(world.store);
      page.port.save = (snapshot) =>
        save({ ...snapshot, savedAt: "2026-10-14T10:00:00.000Z" });
    }
    return page;
  };
  const b = pin(world.page("B"));
  await b.mount();
  b.type("B FIRST");
  if (options.bFirst) b.type(bText);
  expect(await b.flush()).toEqual(["saved"]);
  const storage = new TabStorage();
  const a = pin(world.page("A", storage));
  await a.mount();
  expect(a.title).toBe("");
  a.type(ORIGINAL);
  expect(await a.update()).toEqual(["saved", "saved"]);
  const aId = a.tab.current() as string;
  a.leave();
  if (!options.bFirst) {
    b.type(bText);
    expect(await b.flush()).toEqual(["saved"]);
  }
  const bId = b.tab.current() as string;
  b.leave();
  for (let i = 0; i < (options.extraEqual ?? 0); i += 1) {
    const c = pin(world.page(`C${i}`));
    await c.mount();
    c.type(bText);
    expect(await c.flush()).toEqual(["saved"]);
    c.leave();
  }
  const [h] = await world.handoffs();
  const a2 = pin(world.page("A2", storage));
  await a2.mount();
  expect(a2.title).toBe(ORIGINAL);
  expect(a2.handle?.restored?.formContext).toBe(handoffContext(FORM));
  return { world, storage, a2, aId, bId, hId: h?.tabInstanceId as string };
}

/** The ordinary copies left, by id; the hand-offs left, by id. */
async function left(world: World): Promise<{
  ordinary: string[];
  handoffs: string[];
}> {
  return {
    ordinary: (await world.store.list(FORM)).map((c) => c.tabInstanceId).sort(),
    handoffs: (await world.handoffs()).map((c) => c.tabInstanceId).sort(),
  };
}

/** A page of a NEW tab (no reference): what it restores, and (revision 40, R42; was `nextTab`, the restored id only) the hand-offs it offers, by id. */
async function nextTabSees(
  world: World,
): Promise<{ restored: string | undefined; handoffs: string[] }> {
  const page = await world.page("NEXT").mount();
  return {
    restored: page.handle?.restored?.tabInstanceId,
    handoffs: (page.handle?.alternatives ?? [])
      .filter(isHandoff)
      .map((c) => c.tabInstanceId),
  };
}

/** Revision 40 (R42): the hand-offs left are exactly `kept`, each its row as first read (same id and capture). */
async function handoffsKept(
  world: World,
  kept: readonly RecoverySnapshot[],
): Promise<void> {
  expect(
    (await world.handoffs()).map((c) => [c.tabInstanceId, c.capture]).sort(),
  ).toEqual(kept.map((c) => [c.tabInstanceId, c.capture]).sort());
}

const ends: Array<{
  name: string;
  act: (s: Schedule) => Promise<unknown>;
  expect: unknown;
}> = [
  {
    name: "explicit discard (the form's 'Discard instead')",
    act: async ({ a2 }) => {
      let result: unknown;
      await act(async () => {
        result = await a2.handle?.discard();
      });
      return result;
    },
    expect: "discarded",
  },
  {
    name: "a successful submission of exactly what was restored",
    act: async ({ a2 }) => {
      const ticket = a2.handle?.submitting();
      let result: unknown;
      await act(async () => {
        result = await ticket?.succeeded();
      });
      return result;
    },
    expect: "discarded",
  },
  {
    name: "the update's 'Discard and reload anyway' (the registry handle)",
    act: async ({ a2 }) => {
      let result: unknown;
      await act(async () => {
        result = await a2.registry.all()[0]?.discard?.();
      });
      return result;
    },
    expect: "discarded",
  },
  {
    name: "a flush of the form returned to where it starts (its copies discarded)",
    act: async ({ a2 }) => {
      a2.type("");
      return a2.flush();
    },
    expect: ["saved"],
  },
];

describe("R16 (Q1): equal text is no predecessor; every clean-up removes exactly the hand-off's own predecessor", () => {
  for (const same of [false, true])
    for (const end of ends)
      test(`${same ? "REQUIREMENT (equal text)" : "CONTROL (other text)"}: ${end.name} removes A's copy and keeps the hand-off (R42), B's copy stays, and the next tab restores B's and offers the hand-off`, async () => {
        const s = await reviewSchedule(same ? ORIGINAL : "B INDEPENDENT");
        const before = await left(s.world);
        expect(before.ordinary).toEqual([s.aId, s.bId].sort());
        // The hand-off names its predecessor exactly (written by A, never guessed): A's copy and the capture A saved.
        const [h] = await s.world.handoffs();
        const p = await s.world.store.load(FORM, s.aId);
        expect(h?.lineage).toEqual({
          version: 1,
          entries: [
            { formContext: FORM, tabInstanceId: s.aId, capture: p?.capture },
          ],
        });
        expect(await end.act(s)).toEqual(end.expect);
        // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was the hand-off removed with A's copy; now A's copy
        // (named by the hand-off) goes and the hand-off stays exactly (A2 holds a copied-or-original reference alike: never its to remove).
        expect(await left(s.world)).toEqual({
          ordinary: [s.bId],
          handoffs: [s.hId],
        });
        await handoffsKept(s.world, h ? [h] : []);
        s.a2.leave();
        // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was the next tab restoring B's copy only; now it still
        // restores B's, and offers the retained hand-off (no live page holds it) for the person to restore or discard.
        expect(await nextTabSees(s.world)).toEqual({
          restored: s.bId,
          handoffs: [s.hId],
        });
      });

  test("REQUIREMENT: the page's own save cleans up exactly A's copy, never the hand-off (R42) (B's equal copy stays)", async () => {
    const s = await reviewSchedule(ORIGINAL);
    const [h] = await s.world.handoffs();
    expect(await s.a2.flush()).toEqual(["saved"]);
    const a2Id = s.a2.tab.current() as string;
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was the hand-off removed by the own save; now it stays exactly.
    expect(await left(s.world)).toEqual({
      ordinary: [a2Id, s.bId].sort(),
      handoffs: [s.hId],
    });
    await handoffsKept(s.world, h ? [h] : []);
  });

  for (const variant of [
    {
      name: "B saved its equal text BEFORE A's update",
      options: { bFirst: true },
    },
    { name: "every copy saved at the same instant", options: { tied: true } },
    {
      name: "three more closed tabs hold the equal text",
      options: { extraEqual: 3 },
    },
  ])
    test(`REQUIREMENT: ${variant.name}: the discard removes A's copy only (the hand-off stays, R42)`, async () => {
      const s = await reviewSchedule(ORIGINAL, variant.options);
      const [h] = await s.world.handoffs();
      const others = (await s.world.store.list(FORM))
        .map((c) => c.tabInstanceId)
        .filter((id) => id !== s.aId);
      let result: unknown;
      await act(async () => {
        result = await s.a2.handle?.discard();
      });
      expect(result).toBe("discarded");
      // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was the hand-off removed with A's copy; now it stays exactly.
      expect(await left(s.world)).toEqual({
        ordinary: others.sort(),
        handoffs: [s.hId],
      });
      await handoffsKept(s.world, h ? [h] : []);
    });

  test("the restored hand-off's predecessor is part of it (not offered on its own); B's equal copy is offered", async () => {
    const s = await reviewSchedule(ORIGINAL);
    const offered = (s.a2.handle?.alternatives ?? []).map(
      (c) => c.tabInstanceId,
    );
    expect(offered).toEqual([s.bId]);
  });
});

describe("R16 (Q2): the hand-off chosen later brings the same lineage as one restored at once", () => {
  async function typedFirst() {
    const world = new World();
    const b = await world.page("B").mount();
    const storage = new TabStorage();
    const a = await world.page("A", storage).mount();
    a.type(ORIGINAL);
    expect(await a.update()).toEqual(["saved", "saved"]);
    const aId = a.tab.current() as string;
    a.leave();
    b.type(ORIGINAL);
    expect(await b.flush()).toEqual(["saved"]);
    const bId = b.tab.current() as string;
    b.leave();
    const a2 = world.page("A2", storage);
    // The hand-off's read is held (completed, not delivered) while the person types: nothing is restored, the hand-off is offered.
    a2.spy.hold();
    a2.show();
    await waitFor(() => expect(a2.spy.reached).toBe(true));
    a2.type("TYPED FIRST");
    a2.spy.release();
    await waitFor(() => expect(a2.handle?.ready).toBe(true));
    const [h] = await world.handoffs();
    return { world, a2, aId, bId, hId: h?.tabInstanceId as string };
  }

  test("the hand-off is offered (not A's copy, which it names); B's equal copy is offered; choosing it then discarding removes A's copy only and keeps the hand-off (R42)", async () => {
    const { world, a2, aId, bId, hId } = await typedFirst();
    expect(a2.title).toBe("TYPED FIRST");
    const offered = (a2.handle?.alternatives ?? []).map((c) => c.tabInstanceId);
    expect(offered.sort()).toEqual([bId, hId].sort());
    expect(offered).not.toContain(aId);
    let chosen: unknown;
    await act(async () => {
      chosen = await a2.handle?.restoreAlternative(hId);
    });
    expect(chosen).toBe("restored");
    expect(a2.title).toBe(ORIGINAL);
    let result: unknown;
    await act(async () => {
      result = await a2.handle?.discard();
    });
    expect(result).toBe("discarded");
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was { ordinary: [B], handoffs: [] }; now the chosen
    // hand-off stays (a claim restores it, never removes it) while A's copy it names still goes.
    expect(await left(world)).toEqual({ ordinary: [bId], handoffs: [hId] });
  });

  test("switching to B's copy and back to the hand-off keeps the hand-off's lineage: the discard removes A's copy, never B's or the hand-off (R42)", async () => {
    const { world, a2, bId, hId } = await typedFirst();
    for (const id of [hId, bId, hId]) {
      let chosen: unknown;
      await act(async () => {
        chosen = await a2.handle?.restoreAlternative(id);
      });
      expect(chosen).toBe("restored");
    }
    let result: unknown;
    await act(async () => {
      result = await a2.handle?.discard();
    });
    expect(result).toBe("discarded");
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was { ordinary: [B], handoffs: [] }; now the chosen
    // hand-off stays (a claim restores it, never removes it) while A's copy it names still goes.
    expect(await left(world)).toEqual({ ordinary: [bId], handoffs: [hId] });
  });
});

describe("R16 (Q3): a predecessor its own page wrote again is not removed", () => {
  for (const changed of [false, true])
    test(`${changed ? "REQUIREMENT: A's copy holds a newer capture of A's (the same text)" : "CONTROL: A's copy is as A left it"}: the discard ${changed ? "leaves it" : "removes it"}`, async () => {
      const s = await reviewSchedule("B INDEPENDENT");
      if (changed)
        await s.world.store.save({
          formContext: FORM,
          tabInstanceId: s.aId,
          values: { title: ORIGINAL },
          savedAt: "2026-10-14T11:00:00.000Z",
          capture: "cap-newer",
        });
      let result: unknown;
      await act(async () => {
        result = await s.a2.handle?.discard();
      });
      expect(result).toBe("discarded");
      // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was handoffs: []; now the hand-off stays.
      expect(await left(s.world)).toEqual({
        ordinary: changed ? [s.aId, s.bId].sort() : [s.bId],
        handoffs: [s.hId],
      });
      // Conditional on exactly the capture the hand-off named.
      const asked = s.world.store.discards.find(
        (d) => d.tabInstanceId === s.aId,
      );
      expect(asked?.capture).toBeDefined();
      expect(asked?.capture).not.toBe("cap-newer");
    });
});

describe("R16 (Q4): a clean-up that does not land stays owed, durably, until it lands", () => {
  test("explicit discard while A's copy cannot be removed: `failed`, the hand-off is KEPT (it is the record of what is owed), the form stays dirty; again once it can: `discarded`", async () => {
    const s = await reviewSchedule(ORIGINAL);
    s.world.store.failDiscardOf = (_ctx, id) => id === s.aId;
    let result: unknown;
    await act(async () => {
      result = await s.a2.handle?.discard();
    });
    expect(result).toBe("failed");
    expect(await left(s.world)).toEqual({
      ordinary: [s.aId, s.bId].sort(),
      handoffs: [s.hId],
    });
    expect(s.a2.dirty()).toBe(1);
    s.world.store.failDiscardOf = () => false;
    await act(async () => {
      result = await s.a2.handle?.discard();
    });
    expect(result).toBe("discarded");
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was handoffs: [] once A's copy went; now the hand-off
    // stays (it was never this page's to remove; only what it names was owed).
    expect(await left(s.world)).toEqual({
      ordinary: [s.bId],
      handoffs: [s.hId],
    });
  });

  test("the own save lands while A's copy cannot be removed; the next update writes what is owed into its hand-off (never the hand-off A2 restored, R42); the page after it removes every owed copy", async () => {
    const s = await reviewSchedule(ORIGINAL);
    s.world.store.failDiscardOf = (_ctx, id) => id === s.aId;
    expect(await s.a2.flush()).toEqual(["saved"]);
    const a2Id = s.a2.tab.current() as string;
    // The own save is durable; A's copy and the hand-off (which names it) are still there.
    expect(await left(s.world)).toEqual({
      ordinary: [s.aId, a2Id, s.bId].sort(),
      handoffs: [s.hId],
    });
    expect(await s.a2.update()).toEqual(["saved"]);
    const h2 = (await s.world.handoffs()).find(
      (c) => c.tabInstanceId !== s.hId,
    ) as RecoverySnapshot;
    expect(
      lineageOf(h2)
        .map((t) => [t.formContext, t.tabInstanceId])
        .sort(),
    ).toEqual(
      // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was [A2, A, H]; now [A2, A]: H is
      // never owed by a page that restored it, so the next hand-off does not name it either.
      [
        [FORM, a2Id],
        [FORM, s.aId],
      ].sort(),
    );
    s.a2.leave();
    s.world.store.failDiscardOf = () => false;
    const a3 = await s.world.page("A3", s.storage).mount();
    expect(a3.title).toBe(ORIGINAL);
    expect(a3.handle?.restored?.tabInstanceId).toBe(h2.tabInstanceId);
    // Nothing the chain owes is offered on its own; B's copy is.
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was [B] only; now the retained first
    // hand-off H is offered too (A2 has gone, nobody holds it, and H2 does not name it).
    expect(
      (a3.handle?.alternatives ?? []).map((c) => c.tabInstanceId).sort(),
    ).toEqual([s.bId, s.hId].sort());
    expect(await a3.flush()).toEqual(["saved"]);
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was handoffs: []; now both hand-offs
    // stay (H, and H2 that A3 restored); the ordinary copies owed (A's, A2's) still go.
    expect(await left(s.world)).toEqual({
      ordinary: [a3.tab.current() as string, s.bId].sort(),
      handoffs: [h2.tabInstanceId, s.hId].sort(),
    });
  });

  test("a removal that landed but whose answer was lost is asked again and settles (nothing comes back)", async () => {
    const s = await reviewSchedule(ORIGINAL);
    const discard = s.world.store.discard.bind(s.world.store);
    let lose = true;
    s.a2.port.discard = async (ctx, id, capture) => {
      const result = await discard(ctx, id, capture);
      if (lose && id === s.aId) throw new DOMException("lost", "AbortError");
      return result;
    };
    let result: unknown;
    await act(async () => {
      result = await s.a2.handle?.discard();
    });
    expect(result).toBe("failed");
    // A's copy is gone, the hand-off stays until the removal is known.
    expect(await left(s.world)).toEqual({
      ordinary: [s.bId],
      handoffs: [s.hId],
    });
    lose = false;
    await act(async () => {
      result = await s.a2.handle?.discard();
    });
    expect(result).toBe("discarded");
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was handoffs: []; now the hand-off stays.
    expect(await left(s.world)).toEqual({
      ordinary: [s.bId],
      handoffs: [s.hId],
    });
  });

  test("CONTROL: every removal lands: the own save leaves only the page's copy and B's, and the hand-off (R42)", async () => {
    const s = await reviewSchedule(ORIGINAL);
    expect(await s.a2.flush()).toEqual(["saved"]);
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was handoffs: []; now the hand-off stays.
    expect(await left(s.world)).toEqual({
      ordinary: [s.a2.tab.current() as string, s.bId].sort(),
      handoffs: [s.hId],
    });
  });
});

describe("R16 (Q5, DA-C): an abandoned hand-off is offered whatever text another copy holds; its explicit discard removes it only", () => {
  for (const same of [false, true])
    test(`${same ? "REQUIREMENT (equal text)" : "CONTROL (other text)"}: A updates and never returns; B's copy ${same ? "equals" : "differs from"} A's; a new tab offers every copy by identity`, async () => {
      const world = new World();
      const b = await world.page("B").mount();
      const a = await world.page("A", new TabStorage()).mount();
      a.type(ORIGINAL);
      expect(await a.update()).toEqual(["saved", "saved"]);
      const aId = a.tab.current() as string;
      a.leave();
      b.type(same ? ORIGINAL : "B INDEPENDENT");
      expect(await b.flush()).toEqual(["saved"]);
      const bId = b.tab.current() as string;
      b.leave();
      const [h] = await world.handoffs();
      const hId = h?.tabInstanceId as string;
      const d = await world.page("D").mount();
      const shownIds = [
        d.handle?.restored?.tabInstanceId,
        ...(d.handle?.alternatives ?? []).map((c) => c.tabInstanceId),
      ].sort();
      expect(shownIds).toEqual([aId, bId, hId].sort());
      const abandoned = d.handle?.alternatives.find(isHandoff);
      expect(abandoned?.tabInstanceId).toBe(hId);
      let result: DiscardResult | undefined;
      await act(async () => {
        result = await d.handle?.discardAlternative(hId);
      });
      expect(result).toBe("discarded");
      // Only the chosen alternative: both ordinary copies stay (one of them is D's source now).
      expect(await left(world)).toEqual({
        ordinary: [aId, bId].sort(),
        handoffs: [],
      });
    });
});

describe("R16: a landed save owes only the copy it holds", () => {
  test("a save asked BEFORE another copy is chosen, landing after: the chosen copy is not removed for it (it does not hold it); the next save is", async () => {
    const world = new World();
    await world.store.save({
      formContext: FORM,
      tabInstanceId: "gone-older",
      values: { title: "OLDER TEXT" },
      savedAt: "2026-10-14T06:00:00.000Z",
      capture: "cap-older",
    });
    await world.store.save({
      formContext: FORM,
      tabInstanceId: "gone-newer",
      values: { title: ORIGINAL },
      savedAt: "2026-10-14T07:00:00.000Z",
      capture: "cap-newer",
    });
    const a = await world.page("A").mount();
    expect(a.handle?.restored?.tabInstanceId).toBe("gone-newer");
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached = false;
    const save = world.store.save.bind(world.store);
    a.port.save = async (snapshot) => {
      reached = true;
      await gate;
      return save(snapshot);
    };
    let saving: Promise<SaveResult[]> = Promise.resolve([]);
    act(() => {
      saving = a.flush();
    });
    await waitFor(() => expect(reached).toBe(true));
    let chosen: unknown;
    await act(async () => {
      chosen = await a.handle?.restoreAlternative("gone-older");
    });
    expect(chosen).toBe("restored");
    open();
    await act(async () => {
      expect(await saving).toEqual(["saved"]);
    });
    const aId = a.tab.current() as string;
    // The save held ORIGINAL, not the copy chosen since: that copy is not removed (it is the form's source, and A is dirty). The copy
    // restored before stays too, as the alternative it is offered as (choosing another copy never removes the one it replaced).
    const ids = async () =>
      (await world.store.list(FORM)).map((c) => c.tabInstanceId).sort();
    expect(await ids()).toEqual([aId, "gone-newer", "gone-older"].sort());
    expect(a.dirty()).toBe(1);
    // The next save holds the chosen copy: it is removed then.
    a.port.save = save;
    expect(await a.flush()).toEqual(["saved"]);
    expect(await ids()).toEqual([aId, "gone-newer"].sort());
  });
});

describe("R16: an explicit alternative discard is outstanding work of the session (C3)", () => {
  test("the update's checkpoint waits for a hand-off discard in progress", async () => {
    const world = new World();
    const a = await world.page("A", new TabStorage()).mount();
    a.type(ORIGINAL);
    expect(await a.update()).toEqual(["saved", "saved"]);
    a.leave();
    const [h] = await world.handoffs();
    const d = await world.page("D").mount();
    let release: () => void = () => undefined;
    const discard = world.store.discard.bind(world.store);
    d.port.discard = async (ctx, id, capture) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return discard(ctx, id, capture);
    };
    let pending: Promise<DiscardResult> | undefined;
    act(() => {
      pending = d.handle?.discardAlternative(h?.tabInstanceId as string);
    });
    await waitFor(() =>
      expect(
        d.registry
          .all()
          .some((handle) => (handle.settled?.() ?? null) !== null),
      ).toBe(true),
    );
    release();
    await act(async () => {
      await pending;
    });
    expect(
      d.registry.all().every((handle) => (handle.settled?.() ?? null) === null),
    ).toBe(true);
    expect(await world.handoffs()).toEqual([]);
  });
});
