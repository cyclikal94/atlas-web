import { RouterProvider } from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountSlot } from "../../src/app/AccountSlot";
import { ProtectedProviders } from "../../src/app/providers";
import { createAppRouter } from "../../src/app/router";
import { ShellEnvProvider, type ShellSlotState } from "../../src/app/shell/env";
import { SyncStatusProvider } from "../../src/components/ui/sync-status";
import { DataEnvProvider } from "../../src/data";
import { SwitchHost } from "../../src/features/switch/entry";
import { switchFlow } from "../../src/features/switch/state";
import { SWITCH_COPY, stayAs } from "../../src/features/switch/switch-copy";
import type { SyncStatusModel } from "../../src/lib/sync-chip";
import { type Session, SessionProvider } from "../../src/session";
import { installMatchMedia } from "../helpers/match-media";
import { sessionDouble } from "../helpers/session-double";
import { stubEnv } from "../support/data/ui-env";

/**
 * R10 of the review of 15 October 2026: closing the account switcher returns focus to a control that is still there. On mobile the
 * account control sits in the More sheet, which closes as the switcher opens, so the switcher returns focus to More; on the rail the
 * control stays and takes focus back itself. Moving between the switcher's steps (a row chosen, Back) never pulls focus out of the
 * step that follows.
 *
 * The production composition: the real shell (More sheet, rail), the protected tree's account slot and the switcher's host, mounted in
 * `#protected-root` as the application mounts it. jsdom does not make the page behind a dialog inert for focus, so a step's close that
 * tried to return focus would succeed here; the browser counterparts are `production.switcher-focus.spec.ts` and (DA-F1, the flow
 * outliving the control that opened it) `production.switcher-focus-lifetime.spec.ts`.
 */
vi.mock("../../src/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/data")>()),
  listRetainedAccounts: async () => ({ kind: "ok", accounts: [] }),
}));

const OWNER = "acct";
const model: SyncStatusModel = {
  phase: "synced",
  pendingCount: 0,
  conflictCount: 0,
};
const media = installMatchMedia({ width: 390 });

/** Radix returns focus on a timer after a dialog unmounts: let it run. */
const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

beforeEach(() => {
  document.body.innerHTML = "";
  switchFlow.close();
});
afterEach(async () => {
  cleanup();
  switchFlow.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

type View = ReturnType<Session["view"]["get"]>;

/** The session's displayed view, changeable by the test (another account displaying). */
function viewStore(initial: View) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: View) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * Mounts the composition in a fresh `#protected-root`. `handOff: false` is the composition before R10: the slot ignores the sheet's
 * return target. Returns the way to unmount it (with its root), as a refused activation does to the outgoing account's tree.
 */
async function mount(
  width: number,
  {
    handOff = true,
    view = viewStore({ kind: "displaying", account_id: OWNER, epoch: 1 }),
  } = {},
) {
  media.set({ width });
  const env = stubEnv();
  env.setLabel("kieran");
  const router = createAppRouter({ initialPath: "/today" });
  const root = document.body.appendChild(document.createElement("div"));
  root.id = "protected-root";
  const view_ = render(
    <SessionProvider session={sessionDouble({}, { view })}>
      <ProtectedProviders>
        <DataEnvProvider env={env}>
          <ShellEnvProvider
            value={{
              syncModel: model,
              onOpenSync: vi.fn(),
              accountSlot: ({ collapsed, returnFocus }: ShellSlotState) => (
                <AccountSlot
                  label="kieran"
                  account={OWNER}
                  collapsed={collapsed}
                  returnFocus={handOff ? returnFocus : undefined}
                />
              ),
            }}
          >
            <RouterProvider router={router} />
            <SyncStatusProvider value={{ model, onOpen: () => {} }}>
              <SwitchHost />
            </SyncStatusProvider>
          </ShellEnvProvider>
        </DataEnvProvider>
      </ProtectedProviders>
    </SessionProvider>,
    { container: root },
  );
  await screen.findByRole("main", { hidden: true });
  return {
    root,
    unmount() {
      view_.unmount();
      root.remove();
    },
  };
}

/** Opens the picker from the More sheet; returns the More button. */
async function openFromMore(): Promise<HTMLElement> {
  const more = screen.getByRole("button", { name: "More" });
  fireEvent.click(more);
  const sheet = await screen.findByRole("dialog", { name: "More" });
  fireEvent.click(
    within(sheet).getByRole("button", { name: "kieran, switch account" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "More" })).toBeNull(),
  );
  return more;
}

/** The rail's account control, also while a dialog makes the page behind it aria-hidden. */
const accountControl = () =>
  screen.getByRole("button", { name: "kieran, switch account", hidden: true });

async function pickerList(): Promise<HTMLElement> {
  const picker = await screen.findByRole("dialog", { name: SWITCH_COPY.title });
  const list = await within(picker).findByRole("listbox");
  await waitFor(() => expect(list).toHaveFocus());
  return list;
}

/** "Add another account" (the only other row with no retained account): WF-SWITCH-02 with the username focused. */
async function toCredentials(list: HTMLElement): Promise<HTMLElement> {
  fireEvent.keyDown(list, { key: "End" });
  fireEvent.keyDown(list, { key: "Enter" });
  const form = await screen.findByRole("dialog", {
    name: SWITCH_COPY.signInOther,
  });
  const username = within(form).getByLabelText("Username");
  await waitFor(() => expect(username).toHaveFocus());
  return username;
}

async function closed() {
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await settle();
  expect(switchFlow.get().stage).toBe("closed");
}

describe("R10: the mobile account entry (More → account control)", () => {
  test("Escape on the picker returns focus to More (the account control closed with the sheet)", async () => {
    await mount(390);
    const more = await openFromMore();
    // R10's hand-off: the flow keeps More itself as the control that opened it (not the account control that closed with the sheet).
    expect(switchFlow.returnFocus()).toBe(more);
    const list = await pickerList();
    fireEvent.keyDown(list, { key: "Escape" });
    await closed();
    expect(more).toHaveFocus();
  });

  test("the picker's Close returns focus to More", async () => {
    await mount(390);
    const more = await openFromMore();
    await pickerList();
    fireEvent.click(
      within(screen.getByRole("dialog", { name: SWITCH_COPY.title })).getByRole(
        "button",
        { name: "Close" },
      ),
    );
    await closed();
    expect(more).toHaveFocus();
  });

  test("picker → credentials: the username keeps focus after the picker has gone; Escape there returns focus to More", async () => {
    await mount(390);
    const more = await openFromMore();
    const username = await toCredentials(await pickerList());
    await settle();
    expect(username).toHaveFocus();
    fireEvent.keyDown(username, { key: "Escape" });
    await closed();
    expect(more).toHaveFocus();
  });

  test("credentials → Back: the picker's list keeps focus after the form has gone; Close then returns focus to More", async () => {
    await mount(390);
    const more = await openFromMore();
    await toCredentials(await pickerList());
    fireEvent.click(screen.getByRole("button", { name: stayAs("kieran") }));
    const list = await pickerList();
    await settle();
    expect(list).toHaveFocus();
    fireEvent.click(
      within(screen.getByRole("dialog", { name: SWITCH_COPY.title })).getByRole(
        "button",
        { name: "Close" },
      ),
    );
    await closed();
    expect(more).toHaveFocus();
  });

  // ADAPTED (WEB-08c revision 10, DA-F1): before R10's hand-off this case left focus on the body (revision 9's characterisation). The
  // flow now finds the same entry in the page when the control that opened it is gone, so the pre-R10 wiring is no longer a focus loss:
  // the hand-off itself is pinned by the opener assertions above, and the resolution by the DA-F1 cases below.
  test("without the hand-off (the composition before R10), the opener is the account control that closed with the sheet, and the flow's own resolution still returns focus to More", async () => {
    await mount(390, { handOff: false });
    const more = await openFromMore();
    const opener = switchFlow.returnFocus();
    expect(opener).not.toBe(more);
    expect(opener?.isConnected).toBe(false);
    const list = await pickerList();
    fireEvent.keyDown(list, { key: "Escape" });
    await closed();
    expect(more).toHaveFocus();
  });
});

describe("R10 controls: a persistent entry control takes focus back itself", () => {
  test("desktop rail: Escape on the picker returns focus to the account control", async () => {
    await mount(1440);
    const control = screen.getByRole("button", {
      name: "kieran, switch account",
    });
    fireEvent.click(control);
    const list = await pickerList();
    fireEvent.keyDown(list, { key: "Escape" });
    await closed();
    expect(control).toHaveFocus();
  });

  test("desktop rail: picker → credentials keeps the username focused; Escape returns focus to the account control", async () => {
    await mount(1440);
    const control = screen.getByRole("button", {
      name: "kieran, switch account",
    });
    fireEvent.click(control);
    const username = await toCredentials(await pickerList());
    await settle();
    expect(username).toHaveFocus();
    fireEvent.keyDown(username, { key: "Escape" });
    await closed();
    expect(control).toHaveFocus();
  });

  test("tablet icon rail: the compact control is its own return target", async () => {
    await mount(834);
    const control = screen.getByRole("button", {
      name: "kieran, switch account",
    });
    fireEvent.click(control);
    const list = await pickerList();
    fireEvent.keyDown(list, { key: "Escape" });
    await closed();
    expect(control).toHaveFocus();
  });
});

describe("DA-F1: the flow outlives the control that opened it; focus goes to the same entry in the page as it is now", () => {
  test("More at 390 px, the layout changes to 1440 px at the picker: Escape returns focus to the rail's account control", async () => {
    await mount(390);
    const more = await openFromMore();
    const list = await pickerList();
    act(() => media.set({ width: 1440 }));
    expect(more.isConnected).toBe(false);
    const rail = accountControl();
    fireEvent.keyDown(list, { key: "Escape" });
    await closed();
    expect(rail).toHaveFocus();
  });

  test("the rail at 1440 px, the layout changes to 390 px at the credential step: Escape returns focus to More", async () => {
    await mount(1440);
    const control = accountControl();
    fireEvent.click(control);
    const username = await toCredentials(await pickerList());
    act(() => media.set({ width: 390 }));
    expect(control.isConnected).toBe(false);
    fireEvent.keyDown(username, { key: "Escape" });
    await closed();
    expect(
      screen.getByRole("button", { name: "More", hidden: true }),
    ).toHaveFocus();
  });

  test("a refused activation rebuilds the same account's tree with the flow kept: Escape returns focus to the NEW tree's account control", async () => {
    const first = await mount(1440);
    const control = accountControl();
    fireEvent.click(control);
    await toCredentials(await pickerList());
    first.unmount();
    expect(switchFlow.get().stage).toBe("sign-in");
    await mount(1440);
    expect(control.isConnected).toBe(false);
    const form = await screen.findByRole("dialog", {
      name: SWITCH_COPY.signInOther,
    });
    const username = within(form).getByLabelText("Username");
    await waitFor(() => expect(username).toHaveFocus());
    fireEvent.keyDown(username, { key: "Escape" });
    await closed();
    expect(accountControl()).toHaveFocus();
  });

  test("another account displaying drops the flow: nothing of the old flow takes focus, though its control is still in the page", async () => {
    const view = viewStore({ kind: "displaying", account_id: OWNER, epoch: 1 });
    await mount(1440, { view });
    const control = accountControl();
    fireEvent.click(control);
    await pickerList();
    act(() => view.set({ kind: "displaying", account_id: "other", epoch: 2 }));
    await closed();
    expect(control).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  test("a gate over the tree (inert) when the flow closes: focus is not returned behind it", async () => {
    const { root } = await mount(1440);
    const control = accountControl();
    fireEvent.click(control);
    const list = await pickerList();
    root.setAttribute("inert", "");
    fireEvent.keyDown(list, { key: "Escape" });
    await closed();
    expect(control).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });
});
