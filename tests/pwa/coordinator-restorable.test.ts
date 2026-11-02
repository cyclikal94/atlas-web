import { afterEach, describe, expect, test } from "vitest";
import {
  admitActivity,
  holdUnrestorable,
  isActivity,
} from "../../src/lib/form-recovery/activity";
import { createRecoverableFormRegistry } from "../../src/lib/form-recovery/registry";
import {
  ACTIVATION_FALLBACK_MS,
  FLUSH_START_GRACE_MS,
} from "../../src/lib/pwa/coordinator";
import {
  FakeOrigin,
  type FakeWorker,
  flush,
  type Tab,
} from "./coordinator-world";

/**
 * WEB-14a revision 39: the review of revision 38 (R40-COMPOSITION, R40-FREEZE) and its design assessment (C1/C2, I1-I4, Q2). The
 * coordinator's checkpoint for input no reload brings back (`restorable` false), made in the same step as EVERY way to the reload (the
 * activation, a controller change alone, the fallback, a refused skip-waiting, an update another tab applied), and for page work admitted
 * before the freeze (`activity.ts`). Deterministic world (`coordinator-world.ts`); the production forms' composition is
 * `tests/features/authentication-update.test.tsx`.
 */
const disposers: Tab[] = [];
afterEach(() => {
  for (const tab of disposers.splice(0)) tab.coordinator?.dispose();
});

const skipWaitings = (worker: FakeWorker) =>
  worker.messages.filter(({ message }) => message.type === "atlas:skip-waiting")
    .length;

async function started(origin: FakeOrigin): Promise<Tab> {
  const tab = await origin.tab().start();
  disposers.push(tab);
  return tab;
}
/** A form whose input no reload brings back (a sign-in's username, say), clean until it is edited. */
function unrestorable(tab: Tab, restorable: () => boolean = () => false) {
  return Object.assign(tab.form("sign-in"), { restorable });
}

describe("C1: input no reload brings back stops a save's reload, before anything is saved for it", () => {
  test("dirty at the acceptance: kept_input, nothing saved, nothing reloaded, the freeze released", async () => {
    const origin = new FakeOrigin();
    const tab = await started(origin);
    const form = unrestorable(tab);
    // As the pre-account model's: nothing of it can be saved.
    form.result = "failed";
    form.dirty = true;
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(tab.state).toEqual({ kind: "kept_input" });
    expect(form.saves).toBe(0);
    expect(skipWaitings(waiting)).toBe(0);
    expect(form.frozen).toBe(false);
    // Another tab applies the update meanwhile: this tab is told so (its copy saved as a peer's), and still does not reload.
    await origin.activate(waiting);
    expect(tab.reloads).toBe(0);
    expect(form.dirty).toBe(true);
  });

  test("CONTROL: the same form, restorable, is saved and the tab reloads", async () => {
    const origin = new FakeOrigin();
    const tab = await started(origin);
    const form = unrestorable(tab, () => true);
    form.dirty = true;
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(form.saves).toBe(1);
    expect(tab.reloads).toBe(1);
  });

  test("CONTROL: clean, it holds nothing to lose: the tab reloads", async () => {
    const origin = new FakeOrigin();
    const tab = await started(origin);
    unrestorable(tab);
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
  });

  test("a form that cannot say whether it is restorable is taken for one that is not", async () => {
    const origin = new FakeOrigin();
    const tab = await started(origin);
    const form = unrestorable(tab, () => {
      throw new Error("TEST: cannot say");
    });
    form.dirty = true;
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(tab.state).toEqual({ kind: "kept_input" });
    expect(tab.reloads).toBe(0);
  });

  test('"Discard and reload anyway" discards it (the person\'s explicit choice) and reloads', async () => {
    const origin = new FakeOrigin();
    const tab = await started(origin);
    const form = unrestorable(tab);
    form.dirty = true;
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await flush();
    expect(tab.state).toEqual({ kind: "kept_input" });
    tab.actions?.discardAndReload();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(form.discards).toBe(1);
    expect(tab.reloads).toBe(1);
  });

  // Q2: input that becomes unfinished while the act waits (a mount, a settlement) is found by the checkpoint of each way to the reload.
  const exits: Array<
    [
      string,
      (origin: FakeOrigin, tab: Tab, waiting: FakeWorker) => Promise<void>,
    ]
  > = [
    ["the activation", (origin, _tab, waiting) => origin.activate(waiting)],
    [
      "a controller change alone",
      async (_origin, tab, waiting) => {
        tab.container.changeController(waiting);
        await flush();
      },
    ],
    [
      "the activation fallback",
      (origin) => origin.clock.advance(ACTIVATION_FALLBACK_MS),
    ],
  ];
  for (const [name, exit] of exits)
    test(`unfinished while the act waits: ${name} does not reload over it`, async () => {
      const origin = new FakeOrigin();
      const tab = await started(origin);
      const form = unrestorable(tab);
      const waiting = await origin.installNew(2);
      tab.actions?.accept();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      expect(tab.state).toEqual({ kind: "reloading" });
      form.dirty = true;
      await exit(origin, tab, waiting);
      await flush();
      expect(tab.reloads).toBe(0);
      expect(tab.state).toEqual({ kind: "kept_input" });
      expect(form.saves).toBe(0);
    });

  test("clean but holding a copy no reload brings back, while the act waits: the reload's own checkpoint refuses it", async () => {
    const origin = new FakeOrigin();
    const tab = await started(origin);
    const form = unrestorable(tab);
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(tab.state).toEqual({ kind: "reloading" });
    // Not dirty, yet something of it could come back only to a reader the next page does not have.
    Object.assign(form, { discarded: () => false });
    await origin.activate(waiting);
    await flush();
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
  });

  test("unfinished while the act waits: a refused skip-waiting message does not reload over it", async () => {
    const origin = new FakeOrigin();
    const tab = await started(origin);
    const form = unrestorable(tab);
    const waiting = await origin.installNew(2);
    waiting.postMessage = () => {
      form.dirty = true;
      throw new Error("TEST: the worker is gone");
    };
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await flush();
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
  });

  test("unfinished while the act waits: an update another tab applied (no waiting worker) does not reload over it", async () => {
    const origin = new FakeOrigin();
    const acting = await started(origin);
    const tab = await started(origin);
    const form = unrestorable(tab);
    const waiting = await origin.installNew(2);
    acting.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(acting.reloads).toBe(1);
    expect(tab.state).toEqual({ kind: "updated_elsewhere", dismissed: false });
    tab.actions?.accept();
    await flush();
    form.dirty = true;
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
  });

  test("I9: a peer asked to save keeps its unfinished input and never reloads; the acting tab goes on", async () => {
    const origin = new FakeOrigin();
    const acting = await started(origin);
    const peer = await started(origin);
    const form = unrestorable(peer);
    // As the pre-account model's: nothing of it can be saved.
    form.result = "failed";
    form.dirty = true;
    const waiting = await origin.installNew(2);
    acting.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(acting.reloads).toBe(1);
    expect(peer.reloads).toBe(0);
    expect(form.dirty).toBe(true);
    expect(form.frozen).toBe(false);
  });
});

describe("C2: page work admitted before the freeze (activity.ts)", () => {
  test("admitted, it is outstanding until it ends; refused while frozen; ending is idempotent", () => {
    const registry = createRecoverableFormRegistry();
    const work = admitActivity("sso", registry);
    expect(work).not.toBeNull();
    expect(registry.pending()).toBe(1);
    expect(registry.dirty()).toEqual([]);
    expect(registry.all().every(isActivity)).toBe(true);
    const release = registry.freeze();
    expect(admitActivity("sso", registry)).toBeNull();
    expect(registry.unheld()).toBe(0);
    work?.end();
    work?.end();
    expect(registry.pending()).toBe(0);
    expect(registry.all()).toEqual([]);
    release();
  });

  test("departing, it stays outstanding until the page is shown again", () => {
    const registry = createRecoverableFormRegistry();
    const work = admitActivity("sso", registry);
    work?.depart();
    expect(registry.pending()).toBe(1);
    window.dispatchEvent(new Event("pageshow"));
    expect(registry.pending()).toBe(0);
  });

  test("an act waits for it: no reload until it ends", async () => {
    const origin = new FakeOrigin();
    const tab = await started(origin);
    const work = admitActivity("sso", tab.forms);
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(tab.state).toEqual({ kind: "saving" });
    expect(tab.reloads).toBe(0);
    work?.end();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(tab.reloads).toBe(1);
  });

  test("held page state no reload brings back stops the update until released or discarded", async () => {
    const origin = new FakeOrigin();
    const tab = await started(origin);
    const release = holdUnrestorable("join-outcome", tab.forms);
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await flush();
    expect(tab.state).toEqual({ kind: "kept_input" });
    release();
    tab.actions?.retrySave();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
  });

  test('held page state: "Discard and reload anyway" reloads', async () => {
    const origin = new FakeOrigin();
    const tab = await started(origin);
    holdUnrestorable("join-outcome", tab.forms);
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await flush();
    tab.actions?.discardAndReload();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
  });
});
