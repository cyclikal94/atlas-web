// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  DiscardResult,
  SaveResult,
} from "../../src/lib/form-recovery/port";
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

/**
 * WEB-14a revision 7 (review of 13 October 2026, R13 and R6; design assessment of 13 October 2026, Q2 and Q11). A form whose look could not
 * read the store (`unresolved`) does not know what was left to it: every way to the reload checks it in the same step, asks the form to look
 * again once, and reloads only when it has read the store. "Discard and reload anyway" reaches every form of the act, also one that left
 * the registry since its save failed, and waits for each to say nothing of it can come back (`discarded`).
 */
class UnresolvedForm extends HandoffForm {
  unread = false;
  /** What the next look does: reads the store (true) or not. */
  readable = true;
  retries = 0;
  unresolved = () => this.unread;
  retryRecovery = async (): Promise<boolean> => {
    this.retries += 1;
    if (this.readable) this.unread = false;
    return !this.unread;
  };
}

describe("revision 7, R13: every way to the reload checks that each form knows what was left to it", () => {
  const exits: Array<{
    name: string;
    controlled?: boolean;
    prepare?(tab: Tab, waiting: FakeWorker): void;
    arrive(origin: FakeOrigin, waiting: FakeWorker): Promise<void>;
  }> = [
    {
      name: "the controller change",
      arrive: async (origin, waiting) => {
        await origin.clock.advance(FLUSH_START_GRACE_MS);
        await origin.activate(waiting);
      },
    },
    {
      name: "the waiting worker's activation (an uncontrolled tab)",
      controlled: false,
      arrive: async (origin, waiting) => {
        await origin.clock.advance(FLUSH_START_GRACE_MS);
        await origin.activate(waiting);
      },
    },
    {
      name: "the activation fallback",
      arrive: async (origin) => {
        await origin.clock.advance(FLUSH_START_GRACE_MS);
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
      arrive: (origin) => origin.clock.advance(FLUSH_START_GRACE_MS),
    },
    {
      name: "a worker already activated by another tab",
      prepare: (_tab, waiting) => {
        waiting.state = "activated";
      },
      arrive: (origin) => origin.clock.advance(FLUSH_START_GRACE_MS),
    },
    {
      name: "no waiting worker (updated in another tab)",
      prepare: (tab) => {
        tab.registration.waiting = null;
      },
      arrive: (origin) => origin.clock.advance(FLUSH_START_GRACE_MS),
    },
  ];
  for (const exit of exits)
    for (const readable of [true, false])
      test(`${exit.name}: a form whose look fails after the save ${readable ? "reads the store when asked again, then the tab reloads once" : "still cannot read it: no reload, 'could not save'"}`, async () => {
        const origin = new FakeOrigin();
        const tab = await origin
          .tab({ controlled: exit.controlled ?? true })
          .start();
        const form = new UnresolvedForm();
        tab.forms.register(form);
        const waiting = await origin.installNew(2);
        exit.prepare?.(tab, waiting);
        tab.actions?.accept();
        await flush();
        expect(form.calls).toBe(1);
        // The form is mounted again while the tab waits, and its look cannot read the store.
        form.unread = true;
        form.readable = readable;
        await exit.arrive(origin, waiting);
        await flush();
        expect(form.retries).toBe(1);
        if (readable) expect(tab.reloads).toBe(1);
        else {
          expect(tab.reloads).toBe(0);
          expect(tab.state).toEqual({ kind: "save_failed", refused: false });
        }
      });

  test("a form unresolved before 'Save and reload' is asked to look once; control: one that is not is never asked", async () => {
    for (const unread of [false, true]) {
      const { origin, waiting, tab } = await withForm();
      const form = new UnresolvedForm();
      form.unread = unread;
      tab.forms.register(form);
      tab.actions?.accept();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await origin.activate(waiting);
      expect(form.retries).toBe(unread ? 1 : 0);
      expect(tab.reloads).toBe(1);
    }
  });
});

describe("revision 7, R6: 'Discard and reload anyway' reaches every form of the act and waits for each", () => {
  /** A form that saved (clean) and whose hand-off failed; `discarded` only once its discard landed. */
  class SavedForm extends HandoffForm {
    discards = 0;
    gone = false;
    discardResult: DiscardResult = "discarded";
    discarded = () => this.gone;
    discard = async (): Promise<DiscardResult> => {
      this.discards += 1;
      if (this.discardResult === "discarded") this.gone = true;
      return this.discardResult;
    };
  }

  test("a clean form with copies whose hand-off failed is discarded, even after it left the registry; the reload waits for it", async () => {
    const { origin, waiting, tab } = await withForm();
    const form = new SavedForm();
    form.result = "failed";
    const unregister = tab.forms.register(form);
    tab.actions?.accept();
    await flush();
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    // The form leaves the registry (its mount went) before the person chooses.
    unregister();
    tab.actions?.discardAndReload();
    await flush();
    expect(form.discards).toBe(1);
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
  });

  test("its discard fails: 'could not clear', no reload; control: a form that says nothing of it can come back is not discarded", async () => {
    const { origin, waiting, tab } = await withForm();
    const form = new SavedForm();
    form.result = "failed";
    form.discardResult = "failed";
    const done = new SavedForm();
    done.gone = true;
    tab.forms.register(form);
    tab.forms.register(done);
    tab.actions?.accept();
    await flush();
    tab.actions?.discardAndReload();
    await flush();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(tab.state).toEqual({ kind: "discard_failed" });
    expect(tab.reloads).toBe(0);
    expect(done.discards).toBe(0);
  });

  test("a new 'Save and reload' starts a new act: a form of the earlier act that left the registry is not discarded by a later discard", async () => {
    const { tab } = await withForm();
    const form = new SavedForm();
    form.result = "failed";
    const unregister = tab.forms.register(form);
    tab.actions?.accept();
    await flush();
    unregister();
    const next = new SavedForm();
    next.result = "failed";
    tab.forms.register(next);
    tab.actions?.accept();
    await flush();
    tab.actions?.discardAndReload();
    await flush();
    expect(form.discards).toBe(0);
    expect(next.discards).toBe(1);
  });
});
