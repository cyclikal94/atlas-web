import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
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
import {
  FORM,
  ORIGINAL,
  ScopedSpyPort,
  SpyPort,
  TabStorage,
  updated,
  World,
} from "../support/recovery-pages";

/**
 * WEB-14a revision 53, decision D-R53-1 (Kieran, 3 November 2026: /Users/kieran/atlas/atlas-orchestrator/approval/
 * web14a-r53-decisions-20261103.json; family `recovery-owner-probe-self-contention`, Review53's mixed-version obstacle): a page of an older
 * build still observes a recovery owner with an EXCLUSIVE `ifAvailable` probe. While that probe holds the owner's lock, a current page's
 * shared observation is refused, so it conservatively takes the closed tab for an open one and withholds its copy; a later read sees it
 * gone. Nothing looks again by itself. "Check saved copies again" (`checkAgain`) is the person's explicit repeat: the same reads and
 * ownership rules, and what it finds is only OFFERED (never restored, submitted or removed). A genuine owner still withholds.
 *
 * The older build's probe is modelled exactly as it held the lock: an exclusive hold of `atlas-recovery-tab-<id>` by another page
 * ("OLD") in the shared Web Locks double, released when that probe's callback settles (`locks.leave("OLD")`). Over the actual
 * `createRecoveryTab`, sessions, look and both adapters. Native counterpart: `fixture.pwa-editors.spec.ts` (revision 53).
 */

let world = new World();
afterEach(() => {
  cleanup();
  world = new World();
  vi.restoreAllMocks();
});

const X = "household-create";
const Y = "household-invite:h1";

/** An older build's exclusive probe of `name`, held until `locks.leave("OLD")`. */
const oldProbe = (name: string) => world.locks.held.set(name, "OLD");

interface Owned {
  context: string;
  model: RecoverableModel;
  restored: Array<[string, boolean]>;
  revision: number;
}

/** One page: one registry, one recovery identity, one tab storage, a model per context (as the product owners make them). */
function modelPage(name: string, contexts: string[], port?: SpyPort) {
  const registry = createRecoverableFormRegistry();
  let counter = 0;
  const tab: RecoveryTab = createRecoveryTab({
    uuid: () => `${name}-id-${++counter}`,
    locks: world.locks.forPage(name),
  });
  const handoffs = storageHandoffs(
    () => new TabStorage() as unknown as Storage,
  );
  const spy = port ?? new SpyPort(world.store);
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
        entry.restored.push([text, chosen]);
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
  return { registry, tab, port: spy, owned, name };
}
type ModelPage = ReturnType<typeof modelPage>;

const settled = async (page: ModelPage) =>
  waitFor(() =>
    expect(
      page.owned.every(
        (o) => o.model.view().ready || o.model.view().unavailable,
      ),
    ).toBe(true),
  );

/** P types `{P-n}` into each context, saves them under its one identifier, and stays open. Returns P and its identifier. */
async function wrote(contexts: string[], name = "P") {
  const p = modelPage(name, contexts);
  for (const o of p.owned) o.model.bind(p.port);
  await settled(p);
  for (const [n, o] of p.owned.entries()) {
    o.model.show();
    o.model.begin("{}");
    expect(o.model.edit(`{${name}-${n}}`)).toBe(true);
  }
  expect(await flushDirty(p.registry)).toEqual(contexts.map(() => "saved"));
  const id = p.tab.current() as string;
  expect(id).not.toBeNull();
  return { p, id };
}

/** A new page whose models are bound (their looks made) and settled. */
async function looked(contexts: string[], name = "Q", port?: SpyPort) {
  const q = modelPage(name, contexts, port);
  for (const o of q.owned) o.model.bind(q.port);
  await settled(q);
  return q;
}

const ids = (o: Owned) =>
  o.model.view().alternatives.map((copy) => copy.tabInstanceId);

describe("D-R53-1 (model adapter): an older build's exclusive probe withholds a copy; the person checks again", () => {
  test("OMITTED-ALL: every copy of a closed tab withheld while the old probe holds it; nothing restored, offered or removed; checked again after release it is OFFERED, never restored", async () => {
    const { p, id } = await wrote([X, Y]);
    world.locks.leave(p.name);
    oldProbe(recoveryLockName(id));
    const q = await looked([X, Y]);
    for (const o of q.owned) {
      expect(
        o.restored,
        "a current reader takes the old probe for a live owner",
      ).toEqual([]);
      expect(o.model.view().alternatives).toEqual([]);
      expect(o.model.view().withheld, "the look says it withheld a copy").toBe(
        true,
      );
    }
    expect((await world.store.list(X)).length, "nothing removed").toBe(1);
    expect((await world.store.list(Y)).length, "nothing removed").toBe(1);
    // The old probe ends. Nothing looks again by itself: no polling, no automatic re-offer.
    const lists = vi.spyOn(q.port, "list");
    world.locks.leave("OLD");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      lists,
      "no read is made without the person's request",
    ).not.toHaveBeenCalled();
    for (const o of q.owned) expect(o.model.view().withheld).toBe(true);
    // The person checks again, form by form.
    expect(await q.owned[0]?.model.checkAgain()).toBe(true);
    const [x, y] = q.owned as [Owned, Owned];
    expect(ids(x), "the closed tab's copy is offered").toEqual([id]);
    expect(x.model.view().withheld).toBe(false);
    expect(x.restored, "offered, never restored automatically").toEqual([]);
    expect(x.model.view().restored).toBeNull();
    expect(ids(y), "the other form's check is its own").toEqual([]);
    expect(y.model.view().withheld).toBe(true);
    expect(await y.model.checkAgain()).toBe(true);
    expect(ids(y)).toEqual([id]);
    expect(y.restored).toEqual([]);
    // The person restores the offered copy explicitly: the established guarded choice, read again.
    expect(await x.model.restoreAlternative(id)).toBe("restored");
    expect(x.restored).toEqual([["{P-0}", true]]);
    expect((await world.store.list(X)).length, "a choice removes nothing").toBe(
      1,
    );
  });

  test("OMITTED-ONE: of two closed tabs' copies, the one the old probe holds is withheld while the other is restored; checking again offers it beside the restored copy", async () => {
    // Both write while the other is open (a page restoring a closed tab's copy would remove it once its own save lands).
    const first = await wrote([X], "P");
    const second = await wrote([X], "R");
    world.locks.leave(first.p.name);
    world.locks.leave(second.p.name);
    oldProbe(recoveryLockName(first.id));
    const q = await looked([X]);
    const x = q.owned[0] as Owned;
    expect(x.restored, "the copy no probe holds is restored").toEqual([
      ["{R-0}", false],
    ]);
    expect(x.model.view().restored?.tabInstanceId).toBe(second.id);
    expect(ids(x), "the probed one is not offered").toEqual([]);
    expect(x.model.view().withheld).toBe(true);
    world.locks.leave("OLD");
    expect(await x.model.checkAgain()).toBe(true);
    expect(ids(x)).toEqual([first.id]);
    expect(
      x.model.view().restored?.tabInstanceId,
      "the restored copy is still shown",
    ).toBe(second.id);
    expect(x.restored, "nothing restored by the check").toEqual([
      ["{R-0}", false],
    ]);
    expect(x.model.view().withheld).toBe(false);
  });

  test("GENUINE LIVE OWNER: checking again while the owner is open keeps its copy withheld (conservative); once it leaves, the next check offers it", async () => {
    const { p, id } = await wrote([X]);
    const q = await looked([X]);
    const x = q.owned[0] as Owned;
    expect(x.model.view().withheld).toBe(true);
    expect(await x.model.checkAgain()).toBe(true);
    expect(ids(x), "a live page's copy is never offered").toEqual([]);
    expect(x.model.view().withheld).toBe(true);
    expect(x.restored).toEqual([]);
    world.locks.leave(p.name);
    expect(await x.model.checkAgain()).toBe(true);
    expect(ids(x)).toEqual([id]);
    expect(x.restored).toEqual([]);
  });

  test("CONTROL: a look that withheld nothing says so; checking again changes nothing", async () => {
    const { p, id } = await wrote([X]);
    world.locks.leave(p.name);
    const q = await looked([X]);
    const x = q.owned[0] as Owned;
    expect(x.restored).toEqual([["{P-0}", false]]);
    expect(x.model.view().withheld).toBe(false);
    expect(await x.model.checkAgain()).toBe(true);
    expect(ids(x), "the copy shown is not offered beside itself").toEqual([]);
    expect(x.model.view().restored?.tabInstanceId).toBe(id);
  });

  test("REPEATED CHECKS: a later check replaces one still reading; the earlier read's late answer is never applied", async () => {
    const { p, id } = await wrote([X]);
    world.locks.leave(p.name);
    oldProbe(recoveryLockName(id));
    const q = await looked([X]);
    const x = q.owned[0] as Owned;
    // The first check's listing is held; meanwhile the old probe still holds the lock for its observation.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const list = q.port.list.bind(q.port);
    let held = true;
    vi.spyOn(q.port, "list").mockImplementation(async (context) => {
      const answer = await list(context);
      if (held && context === X) {
        held = false;
        await gate;
      }
      return answer;
    });
    const earlier = x.model.checkAgain();
    await waitFor(() => expect(held).toBe(false));
    world.locks.leave("OLD");
    expect(await x.model.checkAgain(), "the later check read").toBe(true);
    expect(ids(x)).toEqual([id]);
    open();
    expect(
      await earlier,
      "the earlier check was replaced: nothing applied",
    ).toBe(false);
    expect(ids(x)).toEqual([id]);
    expect(x.model.view().withheld).toBe(false);
  });

  test("LATE READ vs DISCARD: a check still reading when the person discards the restored copy never offers that copy again", async () => {
    const { p, id } = await wrote([X]);
    world.locks.leave(p.name);
    const q = await looked([X]);
    const x = q.owned[0] as Owned;
    expect(x.model.view().restored?.tabInstanceId).toBe(id);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const list = q.port.list.bind(q.port);
    vi.spyOn(q.port, "list").mockImplementation(async (context) => {
      const answer = await list(context);
      if (context === X) await gate;
      return answer;
    });
    // The store's removal is held too, so the copy is still listed when the check's answer comes.
    const discard = vi
      .spyOn(q.port, "discard")
      .mockImplementation(() => new Promise(() => undefined));
    const check = x.model.checkAgain();
    void x.model.discard("");
    open();
    expect(await check).toBe(true);
    expect(discard).toHaveBeenCalled();
    expect(ids(x), "the copy being discarded is not offered again").toEqual([]);
    expect(x.model.view().restored).toBeNull();
  });

  test("GUARDS: refused while an update reload is prepared, before the look has finished, while unavailable and once retired; nothing read", async () => {
    const { p, id } = await wrote([X]);
    world.locks.leave(p.name);
    oldProbe(recoveryLockName(id));
    const q = modelPage("Q", [X]);
    const x = q.owned[0] as Owned;
    expect(await x.model.checkAgain(), "no session yet").toBe(false);
    q.port.failLists = 1;
    x.model.bind(q.port);
    await settled(q);
    expect(x.model.view().unavailable).toBe(true);
    expect(
      x.model.view().withheld,
      "an unread look withholds nothing it knows of",
    ).toBeFalsy();
    expect(
      await x.model.checkAgain(),
      "unavailable: Try again, not a check",
    ).toBe(false);
    expect(await x.model.retry()).toBe(true);
    expect(x.model.view().withheld).toBe(true);
    const lists = vi.spyOn(q.port, "list");
    const release = q.registry.freeze();
    expect(await x.model.checkAgain(), "frozen").toBe(false);
    release();
    x.model.retire();
    expect(await x.model.checkAgain(), "retired").toBe(false);
    expect(lists).not.toHaveBeenCalled();
  });

  test("ACCOUNT/INCARNATION: a check whose database is replaced while it reads applies nothing; the copy stays withheld and in its store", async () => {
    world.scoped = true;
    const { p, id } = await wrote([X]);
    world.locks.leave(p.name);
    oldProbe(recoveryLockName(id));
    const port = new ScopedSpyPort(world.store);
    const q = await looked([X], "Q", port);
    const x = q.owned[0] as Owned;
    expect(x.model.view().withheld).toBe(true);
    world.locks.leave("OLD");
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const list = port.list.bind(port);
    vi.spyOn(port, "list").mockImplementation(async (context) => {
      const answer = await list(context);
      await gate;
      return answer;
    });
    const check = x.model.checkAgain();
    // The account database is re-created meanwhile (another incarnation): the session's pinned target is no longer the port's.
    port.scope = "scope-2";
    open();
    expect(await check).toBe(false);
    expect(ids(x), "nothing from another database is offered").toEqual([]);
    expect(x.model.view().unavailable).toBe(true);
    expect(x.restored).toEqual([]);
    expect((await world.store.list(X)).length).toBe(1);
  });

  test("SAVED-COPY GUARDS after a check: a copy offered by the check whose tab came back, or that was resolved meanwhile, is not restored", async () => {
    // Both write while the other is open (a page restoring a closed tab's copy would remove it once its own save lands).
    const first = await wrote([X], "P");
    const second = await wrote([X], "R");
    world.locks.leave(first.p.name);
    world.locks.leave(second.p.name);
    oldProbe(recoveryLockName(first.id));
    oldProbe(recoveryLockName(second.id));
    const q = await looked([X]);
    const x = q.owned[0] as Owned;
    expect(x.model.view().withheld).toBe(true);
    world.locks.leave("OLD");
    expect(await x.model.checkAgain()).toBe(true);
    expect(ids(x).sort()).toEqual([first.id, second.id].sort());
    // One owner's lock is held again (a live page holds that id: never taken over); the other copy is removed elsewhere meanwhile.
    world.locks.held.set(recoveryLockName(first.id), "BACK");
    expect(await x.model.restoreAlternative(first.id)).toBe("refused");
    await world.store.discard(X, second.id);
    expect(await x.model.restoreAlternative(second.id)).toBe("gone");
    expect(x.restored, "nothing restored past a guard").toEqual([]);
  });
});

describe("D-R53-1 (model adapter): abandoned hand-offs", () => {
  /** A hand-off no live page holds, left for `context` (its page never came back). */
  async function abandonedHandoff(context: string, id: string) {
    expect(
      await world.store.save({
        formContext: handoffContext(context),
        tabInstanceId: id,
        values: { model: "{handed}" },
        savedAt: new Date().toISOString(),
        capture: `${id}-capture`,
      }),
    ).toBe("saved");
  }

  test("an older build's exclusive probe of an abandoned hand-off withholds it; checked again after release it is offered, never restored", async () => {
    await abandonedHandoff(X, "h-1");
    oldProbe(handoffLockName("h-1"));
    const q = await looked([X]);
    const x = q.owned[0] as Owned;
    expect(ids(x)).toEqual([]);
    expect(x.model.view().withheld).toBe(true);
    world.locks.leave("OLD");
    expect(await x.model.checkAgain()).toBe(true);
    expect(ids(x)).toEqual(["h-1"]);
    expect(x.restored).toEqual([]);
    expect((await world.handoffs(X)).length, "nothing removed").toBe(1);
  });

  test("CONTROL: an abandoned hand-off chosen and restored (held only during that action) is not withheld afterwards", async () => {
    await abandonedHandoff(X, "h-2");
    const q = await looked([X]);
    const x = q.owned[0] as Owned;
    expect(await x.model.restoreAlternative("h-2")).toBe("restored");
    expect(await x.model.checkAgain()).toBe(true);
    expect(x.model.view().withheld).toBe(false);
  });
});

describe("D-R53-1 (DOM adapter, use-recoverable-form): the same rule", () => {
  test("CONTROL: the hand-off left to this page by its previous page, claimed and held for this page's life, is never counted as withheld", async () => {
    const { storage } = await updated(world);
    const b = await world.page("A-next", storage).mount();
    expect(b.title, "the next page of the tab restores its hand-off").toBe(
      ORIGINAL,
    );
    const handoff = (await world.handoffs())[0]?.tabInstanceId as string;
    expect(
      world.locks.held.get(handoffLockName(handoff)),
      "this page holds the claimed hand-off",
    ).toBe(b.name);
    expect(b.handle?.withheld).toBe(false);
    expect(await act(() => b.handle?.checkAgain() as Promise<boolean>)).toBe(
      true,
    );
    expect(b.handle?.withheld, "its own claim withholds nothing").toBe(false);
    expect(b.handle?.alternatives).toEqual([]);
  });

  test("OMITTED-ALL then checked again after release: offered, never put into the form; a live owner's copy stays withheld", async () => {
    const a = await world.page("A").mount();
    a.type("A's unsent title");
    expect(await a.flush()).toEqual(["saved"]);
    const id = a.tab.current() as string;
    const b = await world.page("B").mount();
    expect(b.handle?.withheld, "live owner: withheld").toBe(true);
    expect(await act(() => b.handle?.checkAgain() as Promise<boolean>)).toBe(
      true,
    );
    expect(b.handle?.alternatives).toEqual([]);
    expect(b.handle?.withheld).toBe(true);
    a.leave();
    oldProbe(recoveryLockName(id));
    const c = await world.page("C").mount();
    expect(c.title, "the old probe makes the closed tab look open").toBe("");
    expect(c.handle?.alternatives).toEqual([]);
    expect(c.handle?.withheld).toBe(true);
    world.locks.leave("OLD");
    expect(await act(() => c.handle?.checkAgain() as Promise<boolean>)).toBe(
      true,
    );
    await waitFor(() =>
      expect(c.handle?.alternatives.map((copy) => copy.tabInstanceId)).toEqual([
        id,
      ]),
    );
    expect(c.title, "offered, never restored by the check").toBe("");
    expect(c.handle?.restored).toBeNull();
    expect(c.handle?.withheld).toBe(false);
    expect(
      await act(() => c.handle?.restoreAlternative(id) as Promise<string>),
    ).toBe("restored");
    expect(c.title).toBe("A's unsent title");
    expect((await world.rows(FORM)).length, "nothing removed").toBe(1);
  });

  test("GUARD: refused while an update reload is prepared", async () => {
    const a = await world.page("A").mount();
    a.type("A's unsent title");
    await a.flush();
    const b = await world.page("B").mount();
    const release = b.registry.freeze();
    expect(await act(() => b.handle?.checkAgain() as Promise<boolean>)).toBe(
      false,
    );
    release();
  });
});
