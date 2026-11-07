import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { DevicesSection } from "../../../src/features/settings/sessions-devices/DevicesSection";
import { deviceNameContext } from "../../../src/features/settings/sessions-devices/NameDeviceDialog";
import {
  flushDirty,
  pageFormRegistry,
} from "../../../src/lib/form-recovery/registry";
import { type Operations, SessionProvider } from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import { deviceRow, sessionDouble } from "../../helpers/session-double";
import {
  contextsOf,
  forgetRecoveryWorld,
  freeze,
  installRecoveryLocks,
  left,
  protectedTree,
  store,
} from "../../support/recovery-editors";

/**
 * WEB-14a revision 39 (design assessment DA-DEVICE-NAME, C4, I10, Q7): the device name dialog merged from WEB-08d takes part in app-update
 * recovery. The production `DevicesSection` and `NameDeviceDialog`, the page's real registry, editor bridge and recoverable models, over an
 * OPEN recovery port on a memory store (`tests/support/recovery-editors.tsx`) and a double of the PUBLIC session interface. Holds are
 * explicit promises. Fixture evidence: the native recovery journeys are the `fixture.pwa-*` specs.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
afterEach(() => {
  forgetRecoveryWorld();
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
});

const ok = <T,>(value: T) => ({ ok: true as const, value });
const capacity = { limit: 8, used: 2 };
const devices = (withNaming = true) =>
  ok({
    devices: [
      deviceRow({ name: null }),
      deviceRow({
        id: "dev-2",
        current: false,
        name: "Kieran's phone",
        state_token: "tok-2",
      }),
    ],
    ...(withNaming ? { sync_capacity: capacity } : {}),
  });

function mount(operations: Partial<Operations> = {}, withNaming = true) {
  const session = sessionDouble({
    readDevices: vi.fn(async () => devices(withNaming)),
    ...operations,
  });
  const tree = () => (
    <SessionProvider session={session}>
      {protectedTree(<DevicesSection />)}
    </SessionProvider>
  );
  const view = render(tree());
  return { session, view, again: () => render(tree()) };
}

const listed = () => screen.findByRole("button", { name: "Name this device" });
async function openNaming(): Promise<HTMLElement> {
  fireEvent.click(await listed());
  return screen.findByRole("dialog");
}
const field = (dialog: HTMLElement) =>
  within(dialog).getByLabelText("Device name") as HTMLInputElement;
const type = (dialog: HTMLElement, value: string) =>
  fireEvent.change(field(dialog), { target: { value } });
const CONTEXT = deviceNameContext("dev-1");
/** The name dialog is open (an assertion, not a locator: the oracle of the host's reopening). */
async function shownDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
  return screen.getByRole("dialog");
}

describe("participation (I10)", () => {
  test("a typed name is the update's unfinished input; only its raw text is saved, in the account's store", async () => {
    mount();
    const dialog = await openNaming();
    type(dialog, "Desk  Mac");
    expect(contextsOf(pageFormRegistry.dirty())).toEqual([CONTEXT]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    const [copy] = await store().list(CONTEXT);
    expect(copy?.values).toEqual({ model: "Desk  Mac" });
  });

  test("CONTROL: opened and untouched, it is not unfinished input", async () => {
    mount();
    await openNaming();
    expect(pageFormRegistry.dirty()).toEqual([]);
  });
});

describe("the devices list reopens the dialog on a name left before a reload (host)", () => {
  test("a copy for a listed device: the dialog opens on it once the list is read; nothing is sent", async () => {
    await left(CONTEXT, "Desk Mac");
    const nameDevice = vi.fn();
    mount({ nameDevice });
    const dialog = await shownDialog();
    await waitFor(() => expect(field(dialog).value).toBe("Desk Mac"));
    expect(nameDevice).not.toHaveBeenCalled();
  });

  test("a copy for a device no longer listed: no dialog, nothing sent, the copy is neither restored nor removed", async () => {
    await left(deviceNameContext("dev-gone"), "Old name");
    const nameDevice = vi.fn();
    mount({ nameDevice });
    await listed();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(nameDevice).not.toHaveBeenCalled();
    expect(await store().list(deviceNameContext("dev-gone"))).toHaveLength(1);
  });

  test("naming not offered by the server: no host, no dialog, the copy stays", async () => {
    await left(CONTEXT, "Desk Mac");
    mount({}, false);
    await screen.findByText("Devices that sync");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await store().list(CONTEXT)).toHaveLength(1);
  });
});

describe("Sync retention versus dismissal (C4)", () => {
  test("the dialog's sync control keeps the name for the visit: coming back reopens the dialog on it", async () => {
    const { view, again } = mount();
    const dialog = await openNaming();
    type(dialog, "Desk Mac");
    fireEvent.click(within(dialog).getByRole("button", { name: /sync/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    // Kept: still the page's unfinished input.
    expect(contextsOf(pageFormRegistry.dirty())).toEqual([CONTEXT]);
    view.unmount();
    again();
    const reopened = await shownDialog();
    expect(field(reopened).value).toBe("Desk Mac");
  });

  test("CONTROL: Cancel discards it: nothing unfinished, nothing reopened", async () => {
    const { view, again } = mount();
    const dialog = await openNaming();
    type(dialog, "Desk Mac");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(pageFormRegistry.dirty()).toEqual([]);
    view.unmount();
    again();
    await listed();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("admission while an update reload is being prepared (C4, I3/I4)", () => {
  for (const frozen of [false, true])
    test(`${frozen ? "FROZEN" : "CONTROL"}: Save (Enter) ${frozen ? "sends nothing" : "sends the name"}`, async () => {
      const nameDevice = vi.fn(async () => ok("named" as const));
      mount({ nameDevice });
      const dialog = await openNaming();
      type(dialog, "Desk Mac");
      if (frozen) act(() => freeze());
      await act(async () => {
        fireEvent.submit(field(dialog).closest("form") as HTMLFormElement);
      });
      expect(nameDevice).toHaveBeenCalledTimes(frozen ? 0 : 1);
      if (frozen) expect(field(dialog).value).toBe("Desk Mac");
    });

  for (const frozen of [false, true])
    test(`${frozen ? "FROZEN" : "CONTROL"}: Remove name ${frozen ? "sends nothing" : "sends null"}`, async () => {
      const nameDevice = vi.fn(async () => ok("cleared" as const));
      mount({ nameDevice });
      fireEvent.click(
        await screen.findByRole("button", {
          name: /^Rename \u2068Kieran.s phone/,
        }),
      );
      const dialog = await screen.findByRole("dialog");
      if (frozen) act(() => freeze());
      const remove = within(dialog).getByRole("button", {
        name: "Remove name",
      });
      // Frozen, the footer says why it is unavailable (the button presses nothing); the send's own ticket is the admission behind it.
      if (frozen) expect(remove).toBeDisabled();
      else expect(remove).toBeEnabled();
      await act(async () => fireEvent.click(remove));
      expect(nameDevice).toHaveBeenCalledTimes(frozen ? 0 : 1);
    });

  test("a save held across a later edit: its success acknowledges only what it sent; the later name stays unfinished input", async () => {
    let answer!: (value: ReturnType<typeof ok<"named">>) => void;
    const nameDevice = vi.fn(
      () =>
        new Promise<ReturnType<typeof ok<"named">>>((resolve) => {
          answer = resolve;
        }),
    );
    mount({ nameDevice: nameDevice as never });
    const dialog = await openNaming();
    type(dialog, "Desk Mac");
    await act(async () => {
      fireEvent.submit(field(dialog).closest("form") as HTMLFormElement);
    });
    expect(nameDevice).toHaveBeenCalledTimes(1);
    // Outstanding work of the page while it is held.
    expect(pageFormRegistry.pending()).toBe(1);
    type(dialog, "Desk Mac 2");
    await act(async () => answer(ok("named")));
    expect(pageFormRegistry.pending()).toBe(0);
    expect(field(dialog).value).toBe("Desk Mac 2");
    expect(contextsOf(pageFormRegistry.dirty())).toEqual([CONTEXT]);
  });
});
