// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { SaveResult } from "../../src/lib/form-recovery/port";
import type { RecoverableFormHandle } from "../../src/lib/form-recovery/registry";
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
 * WEB-14a revision 6 (R13; design assessment of 11 October 2026, C4 and the "all coordinator reload exits" row): "Save and reload" hands
 * every form's copy to the next page of the tab (`handoff`) after the saves, and EVERY way to the reload checks, in the same step as the
 * reload, that each form with a copy has handed it off for its current copy (`handedOff`). A hand-off that fails is a failed save; the
 * person's explicit "Discard and reload anyway" and "Reload anyway" write none. Production constants on a manual clock.
 */
class HandoffForm implements RecoverableFormHandle {
  readonly formContext = "task-edit:/tasks/9";
  /** The order of the form's copy, and the copy its hand-off holds. */
  copy = 1;
  handed = 0;
  result: SaveResult = "saved";
  calls = 0;
  isDirty = () => false;
  flush = async (): Promise<SaveResult> => "saved";
  /** Held still like every real form (a form that cannot be is never taken for safe). */
  freeze = () => () => undefined;
  handoff = async (): Promise<SaveResult> => {
    this.calls += 1;
    const copy = this.copy;
    if (this.result === "saved") this.handed = copy;
    return this.result;
  };
  handedOff = () => this.handed >= this.copy;
}

const skipWaitings = (worker: FakeWorker) =>
  worker.messages.filter((m) => m.message.type === "atlas:skip-waiting").length;

async function withForm(): Promise<{
  origin: FakeOrigin;
  tab: Tab;
  form: HandoffForm;
  waiting: FakeWorker;
}> {
  const origin = new FakeOrigin();
  const tab = await origin.tab().start();
  const form = new HandoffForm();
  tab.forms.register(form);
  const waiting = await origin.installNew(2);
  return { origin, tab, form, waiting };
}

describe("R13: 'Save and reload' hands the forms to the next page first", () => {
  test("the hand-off is written before the other tabs are asked and the worker told; the tab reloads at activation", async () => {
    const { origin, tab, form, waiting } = await withForm();
    tab.actions?.accept();
    await flush();
    expect(form.calls).toBe(1);
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(skipWaitings(waiting)).toBe(1);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
    expect(form.calls).toBe(1);
  });

  test("a hand-off that fails: 'could not save', the update stays pending, nothing reloads; 'Retry save' writes it and proceeds", async () => {
    const { origin, tab, form, waiting } = await withForm();
    form.result = "failed";
    tab.actions?.accept();
    await origin.clock.advance(ACTIVATION_FALLBACK_MS * 2);
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    expect(skipWaitings(waiting)).toBe(0);
    expect(tab.reloads).toBe(0);
    form.result = "saved";
    tab.actions?.retrySave();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(skipWaitings(waiting)).toBe(1);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
  });

  test("a hand-off refused (the account is being signed out): 'can't save while signing out', nothing reloads", async () => {
    const { origin, tab, form } = await withForm();
    form.result = "refused";
    tab.actions?.accept();
    await origin.clock.advance(ACTIVATION_FALLBACK_MS * 2);
    expect(tab.state).toEqual({ kind: "save_failed", refused: true });
    expect(tab.reloads).toBe(0);
  });

  test("control: a form with no copy (already handed off) needs no hand-off; the tab reloads as before", async () => {
    const { origin, tab, form, waiting } = await withForm();
    form.handed = 1;
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(form.calls).toBe(0);
    expect(tab.reloads).toBe(1);
  });

  test("'Discard and reload anyway' and 'Reload anyway' write no hand-off", async () => {
    for (const choice of ["discardAndReload", "reloadAnyway"] as const) {
      const { origin, tab, form, waiting } = await withForm();
      form.result = "failed";
      tab.actions?.accept();
      await flush();
      expect(tab.state).toEqual({ kind: "save_failed", refused: false });
      const before = form.calls;
      tab.actions?.[choice]();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await origin.activate(waiting);
      expect(form.calls).toBe(before);
      expect(tab.reloads).toBe(1);
    }
  });
});

describe("R13: every way to the reload checks the hand-offs in the same step", () => {
  type Exit = {
    name: string;
    controlled?: boolean;
    prepare?(tab: Tab, waiting: FakeWorker): void;
    /** After the hand-off is written: the copy changes (the hand-off is stale), then the tab reaches its reload. */
    arrive(
      origin: FakeOrigin,
      waiting: FakeWorker,
      stale: () => void,
    ): Promise<void>;
  };
  const afterGrace = async (
    origin: FakeOrigin,
    _waiting: FakeWorker,
    stale: () => void,
  ) => {
    stale();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
  };
  const exits: Exit[] = [
    {
      name: "the controller change",
      arrive: async (origin, waiting, stale) => {
        await origin.clock.advance(FLUSH_START_GRACE_MS);
        stale();
        await origin.activate(waiting);
      },
    },
    {
      name: "the waiting worker's activation (an uncontrolled tab)",
      controlled: false,
      arrive: async (origin, waiting, stale) => {
        await origin.clock.advance(FLUSH_START_GRACE_MS);
        stale();
        await origin.activate(waiting);
      },
    },
    {
      name: "the activation fallback",
      arrive: async (origin, _waiting, stale) => {
        await origin.clock.advance(FLUSH_START_GRACE_MS);
        stale();
        await origin.clock.advance(ACTIVATION_FALLBACK_MS);
      },
    },
    {
      name: "a skip-waiting message that cannot be posted",
      prepare: (_tab, waiting) => {
        waiting.postMessage = () => {
          throw new Error("detached");
        };
      },
      arrive: afterGrace,
    },
    {
      name: "a worker already activated by another tab",
      prepare: (_tab, waiting) => {
        waiting.state = "activated";
      },
      arrive: afterGrace,
    },
    {
      name: "no waiting worker (updated in another tab)",
      prepare: (tab) => {
        tab.registration.waiting = null;
      },
      arrive: afterGrace,
    },
  ];
  for (const exit of exits)
    test(`${exit.name}: a hand-off made stale before it is written again first, then the tab reloads once`, async () => {
      const origin = new FakeOrigin();
      const tab = await origin
        .tab({ controlled: exit.controlled ?? true })
        .start();
      const form = new HandoffForm();
      tab.forms.register(form);
      const waiting = await origin.installNew(2);
      exit.prepare?.(tab, waiting);
      tab.actions?.accept();
      await flush();
      expect(form.calls).toBe(1);
      await exit.arrive(origin, waiting, () => {
        form.copy = 2;
      });
      await flush();
      // Not reloaded on the stale hand-off: written again, then reloaded.
      expect(form.calls).toBe(2);
      expect(form.handed).toBe(2);
      expect(tab.reloads).toBe(1);
    });
});
