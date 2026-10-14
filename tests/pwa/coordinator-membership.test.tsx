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
 * WEB-14a revision 11 (review of 14 October 2026, R18; design assessment Q10/Q11): the REAL form (hook, session, registry handle, recovery
 * identity, hand-off) with its admitted field `amount` BESIDE the form, associated by `form="coordinator-membership"`, registered with the
 * REAL app-update coordinator on its deterministic world (manual clock with production constants, fake worker registration). Every normal
 * way an accepted update reaches `reload()` checks the form in the same step: a member typed into and then removed after the save landed
 * (input the person typed, gone from the page, held by nothing but the form's ledger) keeps the tab on its page with "could not save",
 * whatever the exit. Controls: the same schedules with the member typed and LEFT (saved: one reload), or nothing typed (one reload). A
 * member that comes to belong to the form while the update holds it is held before the reload is certified. Another tab's update never
 * reloads this tab nor certifies its input. (jsdom delivers a dispatched event to an inert control, as a script or a late engine key would.)
 */
afterEach(() => {
  cleanup();
  // Controls a case appended outside React (a late member, a password) never outlive it, even when it fails before removing them.
  document.body.replaceChildren();
});

const CONTEXT = "coordinator-membership";
const FORM_ID = "coordinator-membership";

async function mounted(
  forms: RecoverableFormRegistry,
  world: World,
  page: string,
) {
  let handle: RecoverableForm | null = null;
  const tab = createRecoveryTab({
    uuid: () => crypto.randomUUID(),
    locks: world.locks.forPage(page),
  });
  const storage = new TabStorage();
  const handoffs = storageHandoffs(() => storage as unknown as Storage);
  function Page() {
    const formRef = useRef<HTMLFormElement>(null);
    handle = useRecoverableForm({
      formContext: CONTEXT,
      allow: [{ name: "amount" }, { name: "title" }],
      formRef,
      port: world.store,
      registry: forms,
      tab,
      handoffs,
    });
    return (
      <>
        <form id={FORM_ID} ref={formRef}>
          <input aria-label="Title" name="title" defaultValue="" />
        </form>
        <span>
          <input
            id={`${page}-amount`}
            aria-label="Amount"
            name="amount"
            form={FORM_ID}
            defaultValue=""
          />
        </span>
      </>
    );
  }
  const view = render(<Page />);
  await waitFor(() => expect(handle?.ready).toBe(true));
  const control = (name: string) =>
    (name === "amount"
      ? document.getElementById(`${page}-amount`)
      : view.container.querySelector(`[name="${name}"]`)) as HTMLInputElement;
  return {
    view,
    handle: () => handle as RecoverableForm,
    control,
    type: (name: string, value: string) =>
      act(() => {
        control(name).value = value;
        control(name).dispatchEvent(new Event("input", { bubbles: true }));
      }),
    /** The page removes the associated member (a conditional field hidden), directly, with no read of the form in between. */
    removeAmount: () => act(() => control("amount").remove()),
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

const EXITS: readonly Exit[] = [
  "activation",
  "fallback",
  "no waiting worker",
  "skip-waiting throws",
  "already redundant",
];

describe("R18 (Q10): every normal reload exit sees the associated member's input", () => {
  test("REQUIREMENT: accepted: the associated member is held with the form until the act ends", async () => {
    const world = new World();
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const form = await mounted(tab.forms, world, "A");
    form.type("title", "SAVED");
    await origin.installNew(2);
    await act(async () => {
      tab.actions?.accept();
      await flush();
    });
    expect(form.control("amount").hasAttribute("inert")).toBe(true);
    expect(tab.forms.unheld()).toBe(0);
  });

  for (const exit of EXITS)
    for (const schedule of ["typed and removed", "typed and left"] as const)
      test(`${schedule === "typed and removed" ? "REQUIREMENT" : "CONTROL"} (${exit}): saved and handed off; then the member ${schedule} before the exit: ${schedule === "typed and removed" ? "no reload, 'could not save', the copies kept" : "saved again, one reload"}`, async () => {
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
        expect(form.control("amount").form?.id).toBe(FORM_ID);
        form.type("amount", "UNFINISHED");
        if (schedule === "typed and removed") form.removeAmount();
        await act(reach);
        if (schedule === "typed and left") {
          expect(tab.reloads).toBe(1);
          return;
        }
        expect(tab.reloads).toBe(0);
        expect(tab.state).toEqual({ kind: "save_failed", refused: false });
        expect(tab.forms.dirty()).toHaveLength(1);
        expect(await live(world)).toEqual(saved);
      });

  test("CONTROL: nothing typed into the member: one reload", async () => {
    const world = new World();
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const form = await mounted(tab.forms, world, "A");
    form.type("title", "SAVED");
    const waiting = await origin.installNew(2);
    await act(async () => {
      tab.actions?.accept();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await flush();
      await origin.activate(waiting);
      await flush();
    });
    expect(tab.reloads).toBe(1);
  });

  test("REQUIREMENT: a member that comes to belong to the form while the update holds it is held before the reload (and its input stops it)", async () => {
    const world = new World();
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const form = await mounted(tab.forms, world, "A");
    form.type("title", "SAVED");
    const waiting = await origin.installNew(2);
    await act(async () => {
      tab.actions?.accept();
      await flush();
    });
    const late = document.createElement("input");
    late.name = "amount";
    late.setAttribute("form", FORM_ID);
    act(() => {
      document.body.append(late);
      late.value = "LATE";
      late.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(tab.forms.unheld()).toBe(0);
    expect(late.hasAttribute("inert")).toBe(true);
    act(() => late.remove());
    await act(async () => {
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await flush();
      await origin.activate(waiting);
      await flush();
    });
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    expect(form.control("amount").hasAttribute("inert")).toBe(false);
  });

  test("REQUIREMENT: typed and removed before the update: 'could not save'; then 'Discard and reload anyway': discarded, one reload (the input is the person's to drop)", async () => {
    const world = new World();
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const form = await mounted(tab.forms, world, "A");
    form.type("amount", "UNFINISHED");
    form.removeAmount();
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

describe("R18 (Q11): another tab's update never reloads this tab nor certifies its member's input", () => {
  test("the other tab accepts and activates: this tab's flush fails, it never reloads, its form stays dirty with nothing written", async () => {
    const world = new World();
    const origin = new FakeOrigin();
    const mine = await origin.tab().start();
    const other = await origin.tab().start();
    const form = await mounted(mine.forms, world, "A");
    form.type("amount", "UNFINISHED");
    form.removeAmount();
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

  test("CONTROL: the member typed and left: this tab's flush saves it exactly, it never reloads", async () => {
    const world = new World();
    const origin = new FakeOrigin();
    const mine = await origin.tab().start();
    const other = await origin.tab().start();
    const form = await mounted(mine.forms, world, "A");
    form.type("amount", "KEPT");
    const waiting = await origin.installNew(2);
    await act(async () => {
      other.actions?.accept();
      await flush();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      await flush();
      await origin.activate(waiting);
      await flush();
    });
    expect(mine.reloads).toBe(0);
    const rows = await world.store.list(CONTEXT);
    expect(rows.map((copy) => copy.values)).toEqual([
      { amount: "KEPT", title: "" },
    ]);
  });
});
