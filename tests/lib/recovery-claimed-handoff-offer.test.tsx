import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { lineageOf } from "../../src/lib/form-recovery/control-state";
import {
  type HandoffStore,
  handoffContext,
  prepareHandoffs,
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
} from "../../src/lib/form-recovery/tab-identity";
import {
  FORM,
  ORIGINAL,
  SpyPort,
  TabStorage,
  updated,
  World,
} from "../support/recovery-pages";

/**
 * WEB-14a revision 55 (Review 54, F-R54-2; design assessment of 5 November 2026, RC-2, corrections C-L1 to C-L3, invariants L-4 to L-8,
 * schedules T-L1 to T-L9; family `recovery-owner-probe-self-contention`): every OFFER-mode look (the person's "Check saved copies again",
 * "Try again" after a failed check, and the DOM adapter's resumed mount) reads the update hand-off THIS page claims under the claim it
 * already holds (no lock request, no wait, no new claim). So a claimed, still-valid hand-off that was OFFERED rather than restored (the
 * person typed before the look finished; the owner's opening is input; the person restored it and then chose another copy) stays offered
 * and restorable, and its lineage keeps the copies it names out of the offer. A hand-off this page restored and then resolved by a terminal
 * act (a discard, an acknowledged submission) is not offered again by this page (the session's `claimedResolved`); it stays in the store
 * (R42) and a later page offers it as abandoned. Nothing is restored, removed, polled or re-offered by itself.
 *
 * Model adapter (the product editors' path) and DOM adapter over the actual sessions, look, hand-off store and recovery identity, with the
 * shared Web Locks double. Named configurations (design assessment section 11): the LIVE page exists before the writer saves (a page bound
 * after the writer went would restore the writer's closed copy and its save would remove it); the writer's hand-off names its ordinary copy
 * (its lineage), which is never offered beside it.
 */
let world = new World();
afterEach(() => {
  cleanup();
  world = new World();
  vi.restoreAllMocks();
});
const X = "household-create";

/** One page of the form: its registry, recovery identity, tab storage and model; `opened`: the owner's opening is input (never untouched). */
function modelPage(name: string, storage: TabStorage, opened = false) {
  const registry = createRecoverableFormRegistry();
  let counter = 0;
  const tab: RecoveryTab = createRecoveryTab({
    uuid: () => `${name}-id-${++counter}`,
    locks: world.locks.forPage(name),
  });
  const handoffs: HandoffStore = storageHandoffs(
    () => storage as unknown as Storage,
  );
  const port = new SpyPort(world.store);
  const owner = { value: "", revision: opened ? 1 : 0 };
  const model: RecoverableModel = createRecoverableModel({
    formContext: X,
    start: "",
    restore: (text, chosen) => {
      if (!chosen && owner.revision !== 0) return false;
      owner.value = text;
      owner.revision += 1;
      return true;
    },
    untouched: () => owner.revision === 0,
    registry,
    tab,
    handoffs,
  });
  const type = (text: string) => {
    expect(model.edit(text)).toBe(true);
    owner.value = text;
    owner.revision += 1;
  };
  const settled = () =>
    waitFor(() =>
      expect(model.view().ready || model.view().unavailable).toBe(true),
    );
  const ids = () => model.view().alternatives.map((copy) => copy.tabInstanceId);
  return {
    name,
    registry,
    port,
    owner,
    model,
    type,
    settled,
    ids,
    leave: () => world.locks.leave(name),
  };
}
type ModelPage = ReturnType<typeof modelPage>;

/** L: a live page with its own copy of the form, open before the writer saves (so a look withholds a copy and the check is offered). */
async function livePage(): Promise<ModelPage> {
  const l = modelPage("L", new TabStorage());
  l.model.bind(l.port);
  await l.settled();
  l.model.show();
  l.model.begin("");
  l.type("live draft");
  expect(await flushDirty(l.registry)).toEqual(["saved"]);
  return l;
}
/** A: types, saves and prepares its update hand-off (the coordinator's "Save and reload"), then goes; the hand-off names A's copy. */
async function writerLeft() {
  const storage = new TabStorage();
  const a = modelPage("A", storage);
  a.model.bind(a.port);
  await a.settled();
  a.model.show();
  a.model.begin("");
  a.type("left before update");
  expect(await flushDirty(a.registry)).toEqual(["saved"]);
  expect(await prepareHandoffs(a.registry)).toEqual(["saved"]);
  a.leave();
  const [handoff] = await world.store.list(handoffContext(X));
  if (!handoff) throw new Error("setup: no hand-off");
  const lineage = lineageOf(handoff);
  expect(lineage.length, "setup: the hand-off names its writer's copy").toBe(1);
  return { storage, handoff, handed: handoff.tabInstanceId, lineage };
}
/** B: the writer tab's next page; the person typed before its look finished, so what was left (the hand-off included) is OFFERED. */
async function typedEarly(storage: TabStorage, opened = false) {
  const b = modelPage("B", storage, opened);
  b.model.show();
  b.model.begin("");
  if (!opened) b.type("early input");
  b.model.bind(b.port);
  await b.settled();
  expect(b.model.view().restored, "nothing restored").toBeNull();
  return b;
}
/** B: the writer tab's next page, untouched: the hand-off is restored at once. */
async function restoredAtOnce(storage: TabStorage) {
  const b = modelPage("B", storage);
  b.model.bind(b.port);
  await b.settled();
  b.model.show();
  return b;
}
const handoffsInStore = async () =>
  (await world.store.list(handoffContext(X))).map((copy) => copy.tabInstanceId);
/** C: another tab that closed, leaving an ordinary copy of the form (offered to B beside the hand-off). */
async function goneCopy(text: string) {
  const c = modelPage("C", new TabStorage());
  c.model.bind(c.port);
  await c.settled();
  c.model.show();
  c.model.begin("");
  c.type(text);
  expect(await flushDirty(c.registry)).toEqual(["saved"]);
  c.leave();
  return (await world.store.list(X)).find(
    (copy) => copy.values.model?.includes(text) ?? false,
  )?.tabInstanceId as string;
}

describe("revision 55 (F-R54-2, model adapter): an offer look keeps this page's claimed hand-off", () => {
  test.each(["none", "check"] as const)(
    "T-L1 (Review 54 C1) offer look by %s: the hand-off offered after early input stays offered and restorable; the lock stays this page's; the store is unchanged",
    async (how) => {
      await livePage();
      const { storage, handed } = await writerLeft();
      const b = await typedEarly(storage);
      expect(b.model.view().withheld, "L's live copy is withheld").toBe(true);
      expect(b.ids(), "the hand-off alone (its lineage is part of it)").toEqual(
        [handed],
      );
      expect(world.locks.held.get(handoffLockName(handed))).toBe("B");
      const before = await world.store.list(X);
      if (how === "check") expect(await b.model.checkAgain()).toBe(true);
      expect(b.ids(), "F-R54-2: still offered after the offer look").toEqual([
        handed,
      ]);
      expect(await handoffsInStore()).toEqual([handed]);
      expect(await world.store.list(X)).toEqual(before);
      expect(world.locks.held.get(handoffLockName(handed))).toBe("B");
      expect(b.owner.value, "the check restored nothing").toBe("early input");
      expect(await b.model.restoreAlternative(handed)).toBe("restored");
      expect(b.owner.value).toBe("left before update");
    },
  );

  test("T-L2 (manifestation c): the hand-off's lineage member still in the store is not offered as a branch of its own, before or after the check", async () => {
    await livePage();
    const { storage, handoff, handed, lineage } = await writerLeft();
    const member = lineage[0] as NonNullable<(typeof lineage)[0]>;
    // The W9 removal of the writer's copy did not land (it stays owed): the copy the hand-off names is still in the store.
    expect(
      await world.store.save({
        formContext: member.formContext,
        tabInstanceId: member.tabInstanceId,
        values: handoff.values,
        savedAt: handoff.savedAt,
        ...(member.capture === null ? {} : { capture: member.capture }),
      }),
    ).toBe("saved");
    const b = await typedEarly(storage);
    expect(b.ids(), "CONTROL (restore look): the member is excluded").toEqual([
      handed,
    ]);
    const before = await world.store.list(X);
    expect(await b.model.checkAgain()).toBe(true);
    expect(b.ids(), "oracle 1: the claimed hand-off stays offered").toContain(
      handed,
    );
    expect(
      b.ids(),
      "oracle 2: its lineage member is not offered on its own",
    ).not.toContain(member.tabInstanceId);
    expect(await world.store.list(X), "nothing removed").toEqual(before);
  });

  test.each([
    "ordinary listing",
    "hand-off listing",
    "claimed hand-off read",
  ] as const)(
    "T-L3 (manifestation d): a check whose %s fails is unavailable and changes nothing; Try again offers the hand-off again",
    async (what) => {
      await livePage();
      const { storage, handed } = await writerLeft();
      const b = await typedEarly(storage);
      expect(b.ids()).toEqual([handed]);
      if (what === "ordinary listing") b.port.failLists = 1;
      if (what === "hand-off listing") b.port.failHandoffLists = 1;
      if (what === "claimed hand-off read") b.port.failHandoffLoads = 1;
      expect(await b.model.checkAgain(), "the check could not read").toBe(
        false,
      );
      expect(b.model.view().unavailable).toBe(true);
      expect(b.ids(), "nothing changed while unavailable").toEqual([handed]);
      expect(await b.model.retry(), "Try again reads the store").toBe(true);
      expect(b.model.view().unavailable).toBe(false);
      expect(b.ids(), "the claimed hand-off stays offered").toEqual([handed]);
      expect(await b.model.restoreAlternative(handed)).toBe("restored");
      expect(b.owner.value).toBe("left before update");
    },
  );

  test("T-L4 resolved for this page: restored at once, then discarded: no check of this page offers it again; it stays in the store and a later page offers it as abandoned (R42)", async () => {
    await livePage();
    const { storage, handed } = await writerLeft();
    const b = await restoredAtOnce(storage);
    expect(b.model.view().restored?.tabInstanceId).toBe(handed);
    expect(b.owner.value).toBe("left before update");
    expect(await b.model.discard("")).toBe("discarded");
    expect(await b.model.checkAgain()).toBe(true);
    expect(b.ids(), "not re-offered in this page").not.toContain(handed);
    expect(await b.model.checkAgain()).toBe(true);
    expect(b.ids(), "nor on a repeated check").not.toContain(handed);
    expect(await handoffsInStore(), "R42: the hand-off stays").toEqual([
      handed,
    ]);
    b.leave();
    const later = modelPage("D", new TabStorage());
    later.model.bind(later.port);
    await later.settled();
    expect(
      later.ids(),
      "a later page offers it as abandoned (no page holds it)",
    ).toContain(handed);
    expect(later.owner.value, "offered, never restored").toBe("");
  });

  test("T-L5 restored at once, then another copy chosen (the hand-off goes back to the offer), then a check: the hand-off stays offered; the chosen copy is shown, not offered", async () => {
    await livePage();
    const { storage, handed } = await writerLeft();
    const other = await goneCopy("other tab's copy");
    const b = await restoredAtOnce(storage);
    expect(b.model.view().restored?.tabInstanceId).toBe(handed);
    expect(b.ids()).toContain(other);
    expect(await b.model.restoreAlternative(other)).toBe("restored");
    expect(b.ids(), "the hand-off goes back to the offer").toContain(handed);
    expect(await b.model.checkAgain()).toBe(true);
    expect(b.ids(), "F-R54-2: the hand-off stays offered").toContain(handed);
    expect(b.ids(), "the copy shown is not offered").not.toContain(other);
    expect(await b.model.restoreAlternative(handed)).toBe("restored");
    expect(b.owner.value).toBe("left before update");
  });

  test("T-L6 as T-L5, then the chosen copy discarded, then a check: the hand-off (never resolved by this page) is offered again", async () => {
    await livePage();
    const { storage, handed } = await writerLeft();
    const other = await goneCopy("other tab's copy");
    const b = await restoredAtOnce(storage);
    expect(await b.model.restoreAlternative(other)).toBe("restored");
    expect(await b.model.discard("")).toBe("discarded");
    expect(await b.model.checkAgain()).toBe(true);
    expect(b.ids(), "offered again").toContain(handed);
    expect(b.ids(), "the discarded copy is gone").not.toContain(other);
  });

  test("T-L7 the claimed hand-off absent at the offer look's read: nothing offered for it, no throw, everything else unchanged", async () => {
    await livePage();
    const { storage, handed } = await writerLeft();
    const b = await typedEarly(storage);
    expect(b.ids()).toEqual([handed]);
    const load = world.store.load.bind(world.store);
    vi.spyOn(world.store, "load").mockImplementation(async (context, id) =>
      id === handed ? null : load(context, id),
    );
    expect(await b.model.checkAgain()).toBe(true);
    expect(b.model.view().unavailable).toBe(false);
    expect(b.ids(), "nothing offered for it").not.toContain(handed);
    expect(b.model.view().withheld, "L's copy still withheld").toBe(true);
  });

  test("T-L8 an owner whose opening is input (the correction owner, a kept input): the hand-off is offered at open without typing, and stays offered after the check", async () => {
    await livePage();
    const { storage, handed } = await writerLeft();
    const b = await typedEarly(storage, true);
    expect(b.ids()).toEqual([handed]);
    expect(await b.model.checkAgain()).toBe(true);
    expect(b.ids()).toEqual([handed]);
  });
});

describe("revision 55 (F-R54-2, DOM adapter): the same rule through the check, the resumed mount and Try again", () => {
  test.each(["none", "check", "resume", "retry"] as const)(
    "T-L1 (Review 54 C2) offer look by %s: the claimed hand-off offered after early input stays offered and restorable",
    async (how) => {
      const l = await world.page("L").mount();
      l.type("live draft");
      expect(await l.flush()).toEqual(["saved"]);
      const { storage } = await updated(world);
      const [handed] = (await world.handoffs()).map((c) => c.tabInstanceId);
      const b = world.page("B", storage).show();
      b.type("early input");
      await waitFor(() => expect(b.handle?.ready).toBe(true));
      expect(b.handle?.restored).toBeNull();
      expect(b.handle?.withheld, "L's live copy is withheld").toBe(true);
      const ids = () =>
        b.handle?.alternatives.map((copy) => copy.tabInstanceId) ?? [];
      expect(ids()).toEqual([handed]);
      expect(world.locks.held.get(handoffLockName(handed as string))).toBe(
        b.name,
      );
      if (how === "check")
        expect(
          await act(() => b.handle?.checkAgain() as Promise<boolean>),
        ).toBe(true);
      if (how === "resume") {
        b.rerender([]);
        b.rerender([FORM]);
        await waitFor(() => expect(b.handle?.ready).toBe(true));
      }
      if (how === "retry") {
        b.spy.failLists = 1;
        expect(
          await act(() => b.handle?.checkAgain() as Promise<boolean>),
        ).toBe(false);
        await waitFor(() => expect(b.handle?.unavailable).toBe(true));
        expect(ids(), "unchanged while unavailable").toEqual([handed]);
        expect(await act(() => b.handle?.retry() as Promise<boolean>)).toBe(
          true,
        );
        await waitFor(() => expect(b.handle?.ready).toBe(true));
      }
      expect(ids(), `F-R54-2 (${how}): still offered`).toEqual([handed]);
      expect((await world.handoffs()).map((c) => c.tabInstanceId)).toEqual([
        handed,
      ]);
      expect(
        await act(
          () =>
            b.handle?.restoreAlternative(handed as string) as Promise<string>,
        ),
      ).toBe("restored");
      expect(b.title).toBe(ORIGINAL);
    },
  );
});
