import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  handoffContext,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import type { RecoverableFormRegistry } from "../../src/lib/form-recovery/registry";
import { createRecoveryTab } from "../../src/lib/form-recovery/tab-identity";
import {
  type RecoverableForm,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";
import {
  ACTIVATION_FALLBACK_MS,
  FLUSH_START_GRACE_MS,
} from "../../src/lib/pwa/coordinator";
import { TabStorage, World } from "../support/recovery-pages";
import {
  FakeOrigin,
  type FakeWorker,
  flush,
  type Tab,
} from "./coordinator-world";

/**
 * WEB-14a revision 10 (review of 14 October 2026, R17 and R11; design assessment Q12): the REAL form (hook, session, registry handle,
 * recovery identity, hand-off) registered with the REAL app-update coordinator on its deterministic world (manual clock with production
 * constants, fake worker registration). Every normal way an accepted update reaches `reload()` (no waiting worker, the activation, the
 * activation fallback, a skip-waiting message that throws, a worker already activated or redundant) checks the forms in the same step: an
 * unfinished number entry (`validity.badInput`, modelled in jsdom; native: the revision-10 probes) typed AFTER the save landed and before
 * that step keeps the tab on its page with "could not save", whatever the exit. A copy restored into a form that does not admit one of its
 * fields stops the update the same way. Another tab's update (its flush request, then "updated elsewhere") never reloads this tab and
 * never certifies its input. Controls: the same schedules without the unfinished entry reload once.
 */
afterEach(cleanup);

const CONTEXT = "coordinator-completeness";

function badInput(input: HTMLInputElement, on: boolean): void {
  Object.defineProperty(input, "validity", {
    configurable: true,
    value: { ...input.validity, badInput: on, valid: !on },
  });
}

async function mounted(
  forms: RecoverableFormRegistry,
  world: World,
  page: string,
  options: { allow?: string[]; storage?: TabStorage } = {},
) {
  let handle: RecoverableForm | null = null;
  const tab = createRecoveryTab({
    uuid: () => crypto.randomUUID(),
    locks: world.locks.forPage(page),
  });
  const storage = options.storage ?? new TabStorage();
  const handoffs = storageHandoffs(() => storage as unknown as Storage);
  const allow = options.allow ?? ["amount", "title"];
  function Form() {
    const formRef = useRef<HTMLFormElement>(null);
    handle = useRecoverableForm({
      formContext: CONTEXT,
      allow: allow.map((name) => ({ name })),
      formRef,
      port: world.store,
      registry: forms,
      tab,
      handoffs,
    });
    return (
      <form ref={formRef}>
        <input
          aria-label="Amount"
          name="amount"
          type="number"
          defaultValue=""
        />
        <input aria-label="Title" name="title" defaultValue="" />
      </form>
    );
  }
  const view = render(<Form />);
  await waitFor(() => expect(handle?.ready).toBe(true));
  const input = (name: string) =>
    view.container.querySelector(`[name="${name}"]`) as HTMLInputElement;
  return {
    view,
    handle: () => handle as RecoverableForm,
    type: (name: string, value: string) =>
      act(() => {
        badInput(input(name), false);
        input(name).value = value;
        input(name).dispatchEvent(new Event("input", { bubbles: true }));
      }),
    unfinished: () =>
      act(() => {
        badInput(input("amount"), true);
        input("amount").value = "";
        input("amount").dispatchEvent(new Event("input", { bubbles: true }));
      }),
  };
}

const live = async (world: World) =>
  [
    ...(await world.store.list(CONTEXT)),
    ...(await world.store.list(handoffContext(CONTEXT))),
  ].map((copy) => [copy.formContext, copy.tabInstanceId, copy.capture]);

type Exit =
  | "activation"
  | "fallback"
  | "no waiting worker"
  | "skip-waiting throws"
  | "already redundant";

/** Arranges the exit on `waiting` (or none) before "Save and reload"; returns how to reach it once the save has landed. */
function arrange(
  exit: Exit,
  origin: FakeOrigin,
  tab: Tab,
  waiting: FakeWorker,
): () => Promise<void> {
  if (exit === "no waiting worker") tab.registration.waiting = null;
  if (exit === "skip-waiting throws") {
    const post = waiting.postMessage.bind(waiting);
    waiting.postMessage = (message, transfer) => {
      if (message.type === "atlas:skip-waiting")
        throw new Error("TEST: the worker is gone");
      post(message, transfer);
    };
  }
  if (exit === "already redundant") {
    const post = waiting.postMessage.bind(waiting);
    waiting.postMessage = (message, transfer) => {
      if (message.type === "atlas:skip-waiting") waiting.state = "redundant";
      else post(message, transfer);
    };
  }
  return async () => {
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await flush();
    if (exit === "activation") await origin.activate(waiting);
    if (exit === "fallback") await origin.clock.advance(ACTIVATION_FALLBACK_MS);
    await flush();
  };
}

describe("R17 (Q12): every normal reload exit checks the form in the same step", () => {
  for (const exit of [
    "activation",
    "fallback",
    "no waiting worker",
    "skip-waiting throws",
    "already redundant",
  ] as const)
    for (const unfinished of [true, false])
      test(`${unfinished ? "REQUIREMENT" : "CONTROL"} (${exit}): saved and handed off; ${unfinished ? "then `1e` typed before the exit: no reload, 'could not save', the copies kept" : "nothing typed: one reload"}`, async () => {
        const world = new World();
        const origin = new FakeOrigin();
        const tab = await origin.tab().start();
        const form = await mounted(tab.forms, world, "A");
        form.type("title", "SAVED");
        const waiting = await origin.installNew(2);
        const reach = arrange(exit, origin, tab, waiting);
        await act(async () => {
          tab.actions?.accept();
          await flush();
        });
        const saved = await live(world);
        expect(saved).toHaveLength(2);
        expect(tab.reloads).toBe(0);
        if (unfinished) form.unfinished();
        await act(reach);
        if (!unfinished) {
          expect(tab.reloads).toBe(1);
          return;
        }
        expect(tab.reloads).toBe(0);
        expect(tab.state).toEqual({ kind: "save_failed", refused: false });
        expect(tab.forms.dirty()).toHaveLength(1);
        expect(await live(world)).toEqual(saved);
      });

  test("'Discard and reload anyway' after it: discarded, one reload (the unfinished entry is the person's to drop)", async () => {
    const world = new World();
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const form = await mounted(tab.forms, world, "A");
    form.unfinished();
    const waiting = await origin.installNew(2);
    await act(async () => {
      tab.actions?.accept();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await flush();
    });
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    expect(tab.reloads).toBe(0);
    await act(async () => {
      tab.actions?.discardAndReload();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await flush();
      await origin.activate(waiting);
      await flush();
    });
    expect(tab.reloads).toBe(1);
  });
});

describe("R17 (Q12): another tab's update never reloads this tab nor certifies its unfinished entry", () => {
  test("the other tab accepts and activates: this tab's flush fails, it never reloads, its form stays dirty with nothing written", async () => {
    const world = new World();
    const origin = new FakeOrigin();
    const mine = await origin.tab().start();
    const other = await origin.tab().start();
    const form = await mounted(mine.forms, world, "A");
    form.unfinished();
    const waiting = await origin.installNew(2);
    await act(async () => {
      other.actions?.accept();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await flush();
      await origin.activate(waiting);
      await flush();
    });
    expect(other.reloads).toBe(1);
    expect(mine.reloads).toBe(0);
    expect(mine.state.kind).toBe("updated_elsewhere");
    expect(mine.forms.dirty()).toHaveLength(1);
    expect(await live(world)).toEqual([]);
  });
});

describe("R11 (Q12): a restore the form does not account for stops the update", () => {
  for (const admitted of [false, true])
    test(`${admitted ? "CONTROL: the successor admits the saved field: saved, one reload" : "REQUIREMENT: the successor does not admit the saved field: 'could not save', no reload, the closed tab's copy kept"}`, async () => {
      const world = new World();
      const origin = new FakeOrigin();
      // A closed tab left a copy with a title.
      const writer = await origin.tab().start();
      const a = await mounted(writer.forms, world, "W");
      a.type("title", "LEFT BEHIND");
      await act(async () => {
        await writer.forms.dirty()[0]?.flush();
      });
      a.view.unmount();
      world.locks.leave("W");
      const before = await live(world);
      const tab = await origin.tab().start();
      const form = await mounted(tab.forms, world, "B", {
        allow: admitted ? ["amount", "title"] : ["amount"],
      });
      expect(form.handle().restored).not.toBeNull();
      expect(form.handle().incomplete).toEqual(admitted ? [] : ["title"]);
      const waiting = await origin.installNew(2);
      await act(async () => {
        tab.actions?.accept();
        await flush();
        await origin.clock.advance(FLUSH_START_GRACE_MS);
        await flush();
        await origin.activate(waiting);
        await flush();
      });
      if (admitted) {
        expect(tab.reloads).toBe(1);
        return;
      }
      expect(tab.reloads).toBe(0);
      expect(tab.state).toEqual({ kind: "save_failed", refused: false });
      expect(await live(world)).toEqual(before);
    });
});
