import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  handoffContext,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import { createRecoveryTab } from "../../src/lib/form-recovery/tab-identity";
import {
  type RecoverableForm,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";
import { FLUSH_START_GRACE_MS } from "../../src/lib/pwa/coordinator";
import { TabStorage, World } from "../support/recovery-pages";
import { FakeOrigin, flush, type Tab } from "./coordinator-world";

/**
 * WEB-14a revision 9 (R17, review of 14 October 2026; design assessment Q8 and the "mutation during freeze / reload exits" row): the REAL
 * form (hook, session, registry handle, recovery identity, hand-off) registered with the REAL app-update coordinator on its deterministic
 * world (manual clock with production constants, fake worker registration). "Save and reload" saves and hands off the form with B chosen;
 * then, while the tab is held still and the worker activates, the page removes only option B (a programmatic change the freeze does not
 * stop). The activation's reload checks the form in the same step: it owes B, so the tab does not reload and says the save failed; once B
 * is shown again (chosen again), "Retry save" reloads. Control: no change, the tab reloads at activation. Memory store and jsdom.
 */
afterEach(cleanup);

const CONTEXT = "coordinator-shapes";

async function mounted(tab: Tab, world: World) {
  let shown = ["a", "b", "c"];
  let handle: RecoverableForm | null = null;
  const recoveryTab = createRecoveryTab({
    uuid: () => crypto.randomUUID(),
    locks: world.locks.forPage("A"),
  });
  const storage = new TabStorage();
  const handoffs = storageHandoffs(() => storage as unknown as Storage);
  function Form() {
    const formRef = useRef<HTMLFormElement>(null);
    handle = useRecoverableForm({
      formContext: CONTEXT,
      allow: [{ name: "choice" }],
      formRef,
      port: world.store,
      registry: tab.forms,
      tab: recoveryTab,
      handoffs,
    });
    return (
      <form ref={formRef}>
        <select aria-label="Choice" name="choice" defaultValue="a">
          {shown.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </form>
    );
  }
  const view = render(<Form />);
  await waitFor(() => expect(handle?.ready).toBe(true));
  const select = () => view.getByLabelText("Choice") as HTMLSelectElement;
  return {
    select,
    show: async (values: string[]) => {
      shown = values;
      await act(async () => {
        view.rerender(<Form />);
      });
    },
  };
}

describe("R17 (Q8): an option removed while the tab is held for the reload is caught by the reload's own check", () => {
  for (const removed of [true, false])
    test(`${removed ? "REQUIREMENT" : "CONTROL"}: saved and handed off with B; ${removed ? "B removed before the activation: no reload, 'could not save'; B back: 'Retry save' reloads" : "nothing changes: the tab reloads at activation"}`, async () => {
      const world = new World();
      const origin = new FakeOrigin();
      const tab = await origin.tab().start();
      const form = await mounted(tab, world);
      act(() => {
        form.select().value = "b";
        form.select().dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(tab.forms.dirty()).toHaveLength(1);
      const waiting = await origin.installNew(2);
      await act(async () => {
        tab.actions?.accept();
        await flush();
        await origin.clock.advance(FLUSH_START_GRACE_MS);
      });
      // Saved and handed off with B (the ordinary copy and the hand-off).
      const copies = [
        ...(await world.store.list(CONTEXT)),
        ...(await world.store.list(handoffContext(CONTEXT))),
      ];
      expect(copies.map((copy) => copy.values.choice)).toEqual(["b", "b"]);
      expect(tab.reloads).toBe(0);
      if (removed) await form.show(["a", "c"]);
      await act(async () => {
        await origin.activate(waiting);
        await flush();
      });
      if (!removed) {
        expect(tab.reloads).toBe(1);
        return;
      }
      expect(tab.reloads).toBe(0);
      expect(tab.state).toEqual({ kind: "save_failed", refused: false });
      // The durable copies still hold B (nothing replaced them with what the form shows instead).
      expect(
        [
          ...(await world.store.list(CONTEXT)),
          ...(await world.store.list(handoffContext(CONTEXT))),
        ].map((copy) => copy.values.choice),
      ).toEqual(["b", "b"]);
      await form.show(["a", "b", "c"]);
      expect(form.select().value).toBe("b");
      await act(async () => {
        tab.actions?.retrySave();
        await flush();
        await origin.clock.advance(FLUSH_START_GRACE_MS);
        await flush();
      });
      expect(tab.reloads).toBe(1);
    });
});
