import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  handoffContext,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import {
  createRecoverableModel,
  type RecoverableModel,
} from "../../src/lib/form-recovery/model";
import {
  createRecoverableFormRegistry,
  flushDirty,
} from "../../src/lib/form-recovery/registry";
import {
  createRecoveryTab,
  handoffLockName,
  type RecoveryTab,
  recoveryLockName,
} from "../../src/lib/form-recovery/tab-identity";
import { Locks, SpyPort, TabStorage, World } from "../support/recovery-pages";

/**
 * WEB-14a revision 52 (Review52 F-R52-1, family `recovery-owner-probe-self-contention`, and the design assessment's DA-N1; assessment of
 * 3 November 2026, C1/C3, invariants L1-L3, schedules Q1-Q5): OBSERVING whether a recovery copy's tab (or an abandoned hand-off's page)
 * is still open never makes the observer look like that owner to another observer. Every form of a page saves under the page's one
 * identifier, so a tab that closed with several forms saved leaves several copies with one id: concurrent looks (forms of one new page,
 * several new tabs) all observe that one id at once. Authority stays exclusive: a page's identifier, a hand-off claim and an action over an
 * abandoned hand-off.
 *
 * Over the actual `createRecoveryTab` and the shared Web Locks double, which models shared observations as the specification grants them
 * (`tests/support/recovery-pages.tsx`, revision 52). The double's probe hold lasts until a microtask after its callback, so the concurrent
 * cases really overlap (each test's controls show the overlap is not vacuous). Native counterparts: `fixture.pwa-forms.spec.ts`.
 */

const tabOf = (locks: Locks, page: string, ids = ["id"]) => {
  let n = 0;
  return createRecoveryTab({
    uuid: () => ids[n++] ?? `${page}-${n}`,
    locks: locks.forPage(page),
  });
};

describe("observing a recovery owner (Q1): observers never contend", () => {
  test("two and three concurrent observations of ONE closed owner all find it gone, across independent pages", async () => {
    const locks = new Locks();
    const a = tabOf(locks, "A");
    const b = tabOf(locks, "B");
    const c = tabOf(locks, "C");
    expect(await Promise.all([a.ownerOpen("S"), b.ownerOpen("S")])).toEqual([
      false,
      false,
    ]);
    expect(
      await Promise.all([a.ownerOpen("S"), b.ownerOpen("S"), c.ownerOpen("S")]),
    ).toEqual([false, false, false]);
    // The observations really were shared and passive.
    const probes = locks.requests.filter(
      (r) => r.name === recoveryLockName("S"),
    );
    expect(probes).toHaveLength(5);
    for (const probe of probes)
      expect(probe).toMatchObject({ mode: "shared", ifAvailable: true });
  });

  test("concurrent observations by the forms of ONE page (one instance) all find the closed owner gone", async () => {
    const locks = new Locks();
    const page = tabOf(locks, "P");
    expect(
      await Promise.all([
        page.ownerOpen("S"),
        page.ownerOpen("S"),
        page.ownerOpen("S"),
      ]),
    ).toEqual([false, false, false]);
  });

  test("CONTROL: sequential observations and observations of distinct owners find them gone", async () => {
    const locks = new Locks();
    const a = tabOf(locks, "A");
    const b = tabOf(locks, "B");
    expect(await a.ownerOpen("S")).toBe(false);
    expect(await b.ownerOpen("S")).toBe(false);
    expect(await Promise.all([a.ownerOpen("S"), b.ownerOpen("T")])).toEqual([
      false,
      false,
    ]);
  });

  test("CONTROL (L2): a live owner's EXCLUSIVE identifier is open to every concurrent observer, and gone once its page leaves", async () => {
    const locks = new Locks();
    const owner = tabOf(locks, "OWNER", ["S"]);
    expect(await owner.id()).toBe("S");
    expect(locks.requests.at(-1)).toMatchObject({
      name: recoveryLockName("S"),
      mode: "exclusive",
      ifAvailable: false,
    });
    const a = tabOf(locks, "A");
    const b = tabOf(locks, "B");
    expect(
      await Promise.all([a.ownerOpen("S"), b.ownerOpen("S"), a.ownerOpen("S")]),
    ).toEqual([true, true, true]);
    locks.leave("OWNER");
    expect(await Promise.all([a.ownerOpen("S"), b.ownerOpen("S")])).toEqual([
      false,
      false,
    ]);
  });

  test("CONTROL (L2): an identifier being ACQUIRED (an exclusive request waiting) is open to an observer: conservative", async () => {
    const locks = new Locks();
    locks.held.set(recoveryLockName("S"), "a page that is going");
    const owner = tabOf(locks, "OWNER", ["S"]);
    const acquired = owner.id();
    await waitFor(() =>
      expect(locks.waits("OWNER", "atlas-recovery-tab-")).toBe(true),
    );
    const observer = tabOf(locks, "A");
    // Held now, and after its holder goes the waiting exclusive request is ahead of any observation.
    expect(await observer.ownerOpen("S")).toBe(true);
    locks.leave("a page that is going");
    expect(await acquired).toBe("S");
    expect(await observer.ownerOpen("S")).toBe(true);
  });

  test("Q2: a lock manager that refuses says nothing: the owner is treated as open (the copy is left alone)", async () => {
    const locks = new Locks();
    locks.refuse = (name) => name.startsWith("atlas-recovery-tab-");
    const page = tabOf(locks, "P");
    expect(
      await Promise.all([page.ownerOpen("S"), page.ownerOpen("S")]),
    ).toEqual([true, true]);
  });

  test("Q2: an observation never acquires the page's identity, and the page's own identifier is always open", async () => {
    const locks = new Locks();
    const page = tabOf(locks, "P", ["MINE"]);
    expect(await page.ownerOpen("S")).toBe(false);
    expect(page.current()).toBeNull();
    expect(await page.id()).toBe("MINE");
    expect(await page.ownerOpen("MINE")).toBe(true);
    // Another page observing this page's identifier sees it open, however many observe at once.
    const other = tabOf(locks, "Q");
    expect(
      await Promise.all([other.ownerOpen("MINE"), other.ownerOpen("MINE")]),
    ).toEqual([true, true]);
  });
});

describe("observing an abandoned hand-off (DA-N1, Q1/Q5): observers never contend; claims and actions stay exclusive", () => {
  test("concurrent observations of one abandoned hand-off, by independent pages and by one page, all find nobody holding it", async () => {
    const locks = new Locks();
    const a = tabOf(locks, "A");
    const b = tabOf(locks, "B");
    expect(
      await Promise.all([
        a.handoffHeld?.("H"),
        b.handoffHeld?.("H"),
        a.handoffHeld?.("H"),
      ]),
    ).toEqual([false, false, false]);
    for (const probe of locks.requests.filter(
      (r) => r.name === handoffLockName("H"),
    ))
      expect(probe).toMatchObject({ mode: "shared", ifAvailable: true });
  });

  test("CONTROL: a hand-off CLAIMED (held for the page's life) is held for every observer, and free once its page leaves", async () => {
    const locks = new Locks();
    const claimant = tabOf(locks, "CLAIMANT");
    expect(await claimant.holdHandoff?.("H")).toBe(true);
    expect(
      locks.requests.filter((r) => r.name === handoffLockName("H")).at(-1),
    ).toMatchObject({ mode: "exclusive" });
    const a = tabOf(locks, "A");
    const b = tabOf(locks, "B");
    expect(
      await Promise.all([a.handoffHeld?.("H"), b.handoffHeld?.("H")]),
    ).toEqual([true, true]);
    // The claimant sees its own claim as held.
    expect(await claimant.handoffHeld?.("H")).toBe(true);
    locks.leave("CLAIMANT");
    expect(
      await Promise.all([a.handoffHeld?.("H"), b.handoffHeld?.("H")]),
    ).toEqual([false, false]);
  });

  test("CONTROL: an action over the hand-off (whileFree) holds it exclusively: an observer sees it held, a second action runs nothing", async () => {
    const locks = new Locks();
    const a = tabOf(locks, "A");
    const b = tabOf(locks, "B");
    let finish: () => void = () => undefined;
    const acting = a.whileFree?.(
      "H",
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve("done");
        }),
    );
    await waitFor(() => expect(locks.held.get(handoffLockName("H"))).toBe("A"));
    expect(
      locks.requests.filter((r) => r.name === handoffLockName("H")).at(-1),
    ).toMatchObject({ mode: "exclusive", ifAvailable: true });
    expect(await b.handoffHeld?.("H")).toBe(true);
    let ran = false;
    expect(
      await b.whileFree?.("H", async () => {
        ran = true;
        return "second";
      }),
    ).toBeNull();
    expect(ran).toBe(false);
    finish();
    expect(await acting).toBe("done");
    expect(await b.handoffHeld?.("H")).toBe(false);
  });

  test("CONTROL: a claim asked for while observers look is granted once they finish (observations only delay, never refuse, a waiting claim)", async () => {
    const locks = new Locks();
    const a = tabOf(locks, "A");
    const claimant = tabOf(locks, "CLAIMANT");
    const looking = a.handoffHeld?.("H");
    const claimed = claimant.holdHandoff?.("H", 2_000);
    expect(await looking).toBe(false);
    expect(await claimed).toBe(true);
    expect(await a.handoffHeld?.("H")).toBe(true);
  });

  test("Q2: a lock manager that refuses says held: nothing is offered as abandoned", async () => {
    const locks = new Locks();
    locks.refuse = (name) => name.startsWith("atlas-recovery-handoff-");
    const a = tabOf(locks, "A");
    expect(
      await Promise.all([a.handoffHeld?.("H"), a.handoffHeld?.("H")]),
    ).toEqual([true, true]);
  });
});

const X = "task-edit:/tasks/1";
const Y = "task-edit:/tasks/2";
const Z = "task-edit:/tasks/3";

let world = new World();
afterEach(() => {
  cleanup();
  world = new World();
});

/** Page P types into each of `forms`, saves them all under its ONE identifier (as a peer flush does) and closes. */
async function closedWithCopies(forms: string[]): Promise<string> {
  const p = await world.page("P", new TabStorage(), forms).mount();
  for (const [n, context] of forms.entries()) p.type(`P-${n}`, context);
  expect(await p.flush()).toEqual(forms.map(() => "saved"));
  const id = p.tab.current() as string;
  const owners = new Set(
    (await Promise.all(forms.map((form) => world.store.list(form))))
      .flat()
      .map((copy) => copy.tabInstanceId),
  );
  expect(
    [...owners],
    "every form's copy is saved under the page's one id",
  ).toEqual([id]);
  p.leave();
  return id;
}

describe("Q3 (DOM adapter, use-recoverable-form): every copy one closed tab left is restored, whatever its other forms do", () => {
  test("a new page mounting all three forms at once restores each one; nothing is removed", async () => {
    const forms = [X, Y, Z];
    await closedWithCopies(forms);
    const q = await world.page("Q", new TabStorage(), forms).mount();
    for (const [n, context] of forms.entries()) {
      expect(q.value(context), `form ${n} restored`).toBe(`P-${n}`);
      expect(q.handles.get(context)?.restored?.formContext).toBe(context);
    }
    // Restoring removes nothing of the source until this page has a copy of its own.
    for (const context of forms)
      expect((await world.rows(context)).map(([, , title]) => title)).toEqual([
        `P-${forms.indexOf(context)}`,
      ]);
  });

  test("two new tabs looking at once both restore every form from the closed tab", async () => {
    const forms = [X, Y];
    await closedWithCopies(forms);
    const q = world.page("Q", new TabStorage(), forms).show();
    const r = world.page("R", new TabStorage(), forms).show();
    await waitFor(() =>
      expect(
        [q, r].every((page) =>
          forms.every((context) => page.handles.get(context)?.ready),
        ),
      ).toBe(true),
    );
    for (const page of [q, r])
      for (const [n, context] of forms.entries())
        expect(page.value(context), `${page.name} form ${n}`).toBe(`P-${n}`);
  });

  test("CONTROL (live owner): while P is open none of its copies is restored, offered or removed, in any of the new page's forms", async () => {
    const forms = [X, Y, Z];
    const p = await world.page("P", new TabStorage(), forms).mount();
    for (const [n, context] of forms.entries()) p.type(`P-${n}`, context);
    await p.flush();
    const q = await world.page("Q", new TabStorage(), forms).mount();
    for (const context of forms) {
      expect(q.value(context)).toBe("");
      expect(q.handles.get(context)?.restored).toBeNull();
      expect(q.handles.get(context)?.alternatives).toEqual([]);
    }
    for (const context of forms)
      expect(await world.rows(context)).toHaveLength(1);
  });

  test("CONTROL (separate sources): three closed tabs, one form each, restore into the three forms", async () => {
    const forms = [X, Y, Z];
    for (const [n, context] of forms.entries()) {
      const p = await world.page(`P${n}`, new TabStorage(), [context]).mount();
      p.type(`P-${n}`, context);
      await p.flush();
      p.leave();
    }
    const q = await world.page("Q", new TabStorage(), forms).mount();
    for (const [n, context] of forms.entries())
      expect(q.value(context)).toBe(`P-${n}`);
  });

  test("Q4: an explicit choice of the closed tab's copy, made while another form's look observes the same owner, is taken", async () => {
    const forms = [X, Y];
    await closedWithCopies(forms);
    // Q's first form was typed into before its look answered, so the closed tab's copy is OFFERED there, then chosen.
    const q = world.page("Q", new TabStorage(), forms).show();
    q.type("TYPED FIRST", X);
    await waitFor(() =>
      expect(forms.every((context) => q.handles.get(context)?.ready)).toBe(
        true,
      ),
    );
    const offered = q.handles.get(X)?.alternatives ?? [];
    expect(offered.map((copy) => copy.values.title)).toEqual(["P-0"]);
    // A second page observes the same closed owner while the choice re-checks ownership.
    const r = world.page("R", new TabStorage(), forms).show();
    const choice = q.handles
      .get(X)
      ?.restoreAlternative(offered[0]?.tabInstanceId as string);
    expect(await choice).toBe("restored");
    await waitFor(() => expect(q.value(X)).toBe("P-0"));
    await waitFor(() => expect(r.handles.get(Y)?.ready).toBe(true));
    expect(r.value(Y)).toBe("P-1");
  });
});

describe("Q3 (model adapter, model.ts): every copy one closed tab left is restored into its untouched owner", () => {
  interface Owned {
    context: string;
    model: RecoverableModel;
    restored: string[];
    revision: number;
  }
  /** One page: one registry, one recovery identity, one tab storage, a model per context (as the product owners make them). */
  function modelPage(name: string, contexts: string[]) {
    const registry = createRecoverableFormRegistry();
    let counter = 0;
    const tab: RecoveryTab = createRecoveryTab({
      uuid: () => `${name}-id-${++counter}`,
      locks: world.locks.forPage(name),
    });
    const handoffs = storageHandoffs(
      () => new TabStorage() as unknown as Storage,
    );
    const port = new SpyPort(world.store);
    const owned: Owned[] = contexts.map((context) => {
      const entry: Owned = {
        context,
        restored: [],
        revision: 0,
        model: undefined as unknown as RecoverableModel,
      };
      entry.model = createRecoverableModel({
        formContext: context,
        start: "",
        restore: (text, chosen) => {
          if (!chosen && entry.revision !== 0) return false;
          entry.restored.push(text);
          entry.revision += 1;
          return true;
        },
        untouched: () => entry.revision === 0,
        registry,
        tab,
        handoffs,
      });
      return entry;
    });
    return { registry, tab, port, owned, name };
  }
  const settled = async (page: ReturnType<typeof modelPage>) =>
    waitFor(() =>
      expect(
        page.owned.every(
          (o) => o.model.view().ready || o.model.view().unavailable,
        ),
      ).toBe(true),
    );

  test("three models of a closed page, bound at once by a new page, each restore their own copy", async () => {
    const contexts = [X, Y, Z];
    const p = modelPage("P", contexts);
    for (const o of p.owned) o.model.bind(p.port);
    await settled(p);
    for (const [n, o] of p.owned.entries()) {
      o.model.show();
      o.model.begin("{}");
      expect(o.model.edit(`{P-${n}}`)).toBe(true);
    }
    expect(await flushDirty(p.registry)).toEqual(["saved", "saved", "saved"]);
    const id = p.tab.current();
    expect(id).not.toBeNull();
    world.locks.leave("P");
    const q = modelPage("Q", contexts);
    for (const o of q.owned) o.model.bind(q.port);
    await settled(q);
    for (const [n, o] of q.owned.entries()) {
      expect(o.restored, `model ${n}`).toEqual([`{P-${n}}`]);
      expect(o.model.view().restored?.tabInstanceId).toBe(id);
    }
    expect(
      (await world.store.list(handoffContext(X))).length,
      "no hand-off was involved",
    ).toBe(0);
  });

  test("CONTROL (live owner): while P is open its models' copies are not restored by another page's models", async () => {
    const contexts = [X, Y];
    const p = modelPage("P", contexts);
    for (const o of p.owned) o.model.bind(p.port);
    await settled(p);
    for (const [n, o] of p.owned.entries()) {
      o.model.show();
      o.model.begin("{}");
      o.model.edit(`{P-${n}}`);
    }
    await flushDirty(p.registry);
    const q = modelPage("Q", contexts);
    for (const o of q.owned) o.model.bind(q.port);
    await settled(q);
    for (const o of q.owned) {
      expect(o.restored).toEqual([]);
      expect(o.model.view().alternatives).toEqual([]);
    }
  });
});

describe("Q5: several pages listing one abandoned hand-off all offer it", () => {
  test("two new tabs (and two forms' looks) find the hand-off nobody holds, and offer it, at once", async () => {
    // Page A prepared an update (a hand-off for its form) and never came back; its tab's next page never loaded.
    const storage = new TabStorage();
    const a = await world.page("A", storage, [X]).mount();
    a.type("HANDED", X);
    await a.update();
    a.leave();
    expect(await world.handoffs(X)).toHaveLength(1);
    // Two OTHER tabs (no reference to it): each finds it abandoned and offers it; neither restores or removes it.
    const q = world.page("Q", new TabStorage(), [X]).show();
    const r = world.page("R", new TabStorage(), [X]).show();
    await waitFor(() =>
      expect([q, r].every((page) => page.handles.get(X)?.ready)).toBe(true),
    );
    for (const page of [q, r]) {
      const offered = page.handles.get(X)?.alternatives ?? [];
      expect(
        offered.some((copy) => copy.values.title === "HANDED"),
        `${page.name} offers the hand-off`,
      ).toBe(true);
    }
    expect(await world.handoffs(X)).toHaveLength(1);
  });
});
