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
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import { isolate } from "../../../src/features/settings/sessions-devices/labels";
import type {
  DeviceRow,
  Identity,
  Operations,
  Result,
  SessionSummary,
  Store,
} from "../../../src/session";
import { SessionProvider } from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  deviceRow,
  sessionDouble,
  sessionRow,
} from "../../helpers/session-double";
import { eventuallyShown, shown } from "../../helpers/shown";

/**
 * WEB08D-NAVIGATION-FRESHNESS-20261011 (Q8): both management lists read again, quietly, when the person comes back to the tab
 * (visible again) or to its window (focus while visible). Through the composed Settings screen over a double of the PUBLIC session
 * interface: a change made elsewhere appears after a return; one return is one read per list however many notifications it brings;
 * what is on screen (rows, focus, an open dialog and its typed value) stays while the read is made; an older or other-identity answer
 * never replaces a newer one; nothing is read after the screen is left, while offline, or while hidden; a failed read shows the usual
 * error, never stale rows presented as fresh. No polling: without a return nothing is read.
 */
installMatchMedia({ width: 1440 });

let visibility: DocumentVisibilityState = "visible";
let online = true;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#08090A">';
  visibility = "visible";
  online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const ok = <T,>(value: T) => ({ ok: true as const, value });
const chrome = { channel: "browser", browser: "chrome", platform: "macos" };
const iosApp = { channel: "native", browser: null, platform: "ios" };
const capacity = (used: number, limit: number) => ({
  limit,
  used,
  remaining: Math.max(limit - used, 0),
});
const A: Identity = { account_id: "acct", epoch: 1, session_id: "sess-1" };

function identityStore(initial: Identity) {
  let value: Identity | null = initial;
  const listeners = new Set<() => void>();
  const store: Store<Identity | null> & { set(next: Identity | null): void } = {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
  return store;
}

/** An answer the test releases inside `act`. */
function later<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, release: (value: T) => act(async () => resolve(value)) };
}

type Sessions = { sessions: SessionSummary[]; session_capacity: unknown };
type Devices = { devices: DeviceRow[]; sync_capacity: unknown };

/** The server's state for one account (two sessions on two devices) as another tab or device may change it. */
function server() {
  let sessions = [
    sessionRow({ client: chrome }),
    sessionRow({
      id: "sess-2",
      device_id: "dev-2",
      current: false,
      client: iosApp,
      created_at: "2026-09-27T12:00:00.000Z",
    }),
  ];
  let devices: Array<ReturnType<typeof deviceRow> & { name?: string | null }> =
    [
      deviceRow({ client: chrome, name: null }),
      deviceRow({
        id: "dev-2",
        current: false,
        client: iosApp,
        name: "Kieran's phone",
        state_token: "tok-2",
        last_synced_at: "2026-09-30T09:00:00.000Z",
      }),
    ];
  const sessionsAnswer = (): Result<Sessions> =>
    ok({
      sessions: sessions as unknown as SessionSummary[],
      session_capacity: capacity(sessions.length, 32),
    });
  const devicesAnswer = (): Result<Devices> =>
    ok({
      devices: devices as unknown as DeviceRow[],
      sync_capacity: capacity(devices.length, 8),
    });
  const listSessions = vi.fn(async () => sessionsAnswer());
  const readDevices = vi.fn(async () => devicesAnswer());
  return {
    listSessions,
    readDevices,
    sessionsAnswer,
    devicesAnswer,
    /** Another device signs in elsewhere: a third session and a third device. */
    elsewhere() {
      sessions = [
        ...sessions,
        sessionRow({
          id: "sess-3",
          device_id: "dev-3",
          current: false,
          client: { channel: "browser", browser: "firefox", platform: "linux" },
          created_at: "2026-09-30T11:00:00.000Z",
        }),
      ];
      devices = [
        ...devices,
        deviceRow({
          id: "dev-3",
          current: false,
          client: {
            channel: "browser",
            browser: "firefox",
            platform: "linux",
          },
          name: null,
          state_token: "tok-3",
        }),
      ];
    },
    rename(id: string, name: string) {
      devices = devices.map((device) =>
        device.id === id ? { ...device, name } : device,
      );
    },
  };
}

async function mount(
  operations: Partial<Operations>,
  identity = identityStore(A),
) {
  const session = sessionDouble(operations, { identity });
  const router = createAppRouter({ initialPath: "/settings/sessions" });
  render(
    <SessionProvider session={session}>
      <ProtectedProviders>
        <ShellEnvProvider
          value={{
            syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
            onOpenSync: () => {},
          }}
        >
          <RouterProvider router={router} />
        </ShellEnvProvider>
      </ProtectedProviders>
    </SessionProvider>,
  );
  await screen.findByText("2 of 32 sign-ins in use.");
  await screen.findByText("2 of 8 places for syncing in use.");
  return { session, router, identity };
}

const reads = (world: ReturnType<typeof server>) => ({
  sessions: world.listSessions.mock.calls.length,
  devices: world.readDevices.mock.calls.length,
});
const line = (kind: "sessions" | "devices") =>
  document.querySelector(`[data-capacity=${kind}]`)?.textContent ?? null;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

const hide = () =>
  act(() => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
const show = () =>
  act(() => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
const blur = () => act(() => window.dispatchEvent(new Event("blur")));
const focus = () => act(() => window.dispatchEvent(new Event("focus")));
/** A tab return as browsers report it: visible, then the window's focus. */
const returnToTab = async () => {
  await hide();
  await show();
  await focus();
};

const renamePhone = () =>
  shown(
    screen.queryByRole("button", {
      name: `Rename ${isolate("Kieran's phone")}, last synced 3 hours ago`,
    }),
    "the named device's Rename button",
  );

describe("a return reads both lists again (Q8)", () => {
  test("a change made elsewhere appears after the tab is visible again; each list is read once", async () => {
    const world = server();
    await mount(world);
    const before = reads(world);
    world.elsewhere();
    await settle();
    // No polling: nothing is read without a return.
    expect(reads(world)).toEqual(before);
    expect(line("sessions")).toBe("2 of 32 sign-ins in use.");
    await returnToTab();
    await waitFor(() =>
      expect(line("sessions")).toBe("3 of 32 sign-ins in use."),
    );
    await waitFor(() =>
      expect(line("devices")).toBe("3 of 8 places for syncing in use."),
    );
    expect(document.querySelectorAll("[data-session-row]")).toHaveLength(3);
    expect(document.querySelectorAll("[data-device-row]")).toHaveLength(3);
    await settle();
    expect(reads(world)).toEqual({
      sessions: before.sessions + 1,
      devices: before.devices + 1,
    });
  });

  test("a return to the window (blur, then focus while visible) reads again; a focus with no departure reads nothing", async () => {
    const world = server();
    await mount(world);
    const before = reads(world);
    await focus();
    await settle();
    expect(reads(world)).toEqual(before);
    world.elsewhere();
    await blur();
    await focus();
    await waitFor(() =>
      expect(line("sessions")).toBe("3 of 32 sign-ins in use."),
    );
    await settle();
    expect(reads(world)).toEqual({
      sessions: before.sessions + 1,
      devices: before.devices + 1,
    });
  });

  test("overlapping notifications while the read is outstanding make no second read, and nothing is replaced by a loading state", async () => {
    const world = server();
    await mount(world);
    const before = reads(world);
    const held = later<Result<Devices>>();
    world.readDevices.mockImplementationOnce(() => held.promise);
    world.elsewhere();
    await hide();
    await show();
    await focus();
    await blur();
    await focus();
    await hide();
    await show();
    await settle();
    expect(reads(world).devices).toBe(before.devices + 1);
    // The rows stay on screen while the read is made (quiet).
    expect(screen.queryByText("Loading your devices…")).toBeNull();
    expect(document.querySelectorAll("[data-device-row]")).toHaveLength(2);
    await held.release(world.devicesAnswer());
    await waitFor(() =>
      expect(line("devices")).toBe("3 of 8 places for syncing in use."),
    );
    await settle();
    expect(reads(world).devices).toBe(before.devices + 1);
  });

  test("a focus while the tab is hidden reads nothing", async () => {
    const world = server();
    await mount(world);
    const before = reads(world);
    await hide();
    await blur();
    await focus();
    await settle();
    expect(reads(world)).toEqual(before);
  });
});

describe("what is on screen stays (Q8)", () => {
  test("an open naming dialog keeps its typed value and focus while both lists refresh behind it", async () => {
    const world = server();
    await mount(world);
    fireEvent.click(renamePhone());
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("Device name");
    fireEvent.change(field, { target: { value: "Work phone (draft)" } });
    act(() => field.focus());
    world.elsewhere();
    await returnToTab();
    await waitFor(() =>
      expect(line("devices")).toBe("3 of 8 places for syncing in use."),
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByLabelText("Device name")).toBe(field);
    expect((field as HTMLInputElement).value).toBe("Work phone (draft)");
    expect(document.activeElement).toBe(field);
  });

  test("keyboard focus on a row's control stays on the same control after the refresh", async () => {
    const world = server();
    await mount(world);
    const control = renamePhone();
    act(() => control.focus());
    world.rename("dev-1", "Desk Mac");
    await returnToTab();
    await waitFor(() =>
      expect(document.querySelector("[data-device-name]")?.textContent).toBe(
        "Desk Mac",
      ),
    );
    expect(renamePhone()).toBe(control);
    expect(document.activeElement).toBe(control);
  });
});

describe("only the newest answer for the identity still settled is shown (Q8)", () => {
  test("a return-triggered answer that arrives after the identity moved on is dropped", async () => {
    const world = server();
    const identity = identityStore(A);
    await mount(world, identity);
    const held = later<Result<Devices>>();
    world.readDevices.mockImplementationOnce(() => held.promise);
    world.elsewhere();
    await returnToTab();
    act(() => identity.set({ ...A, epoch: 2 }));
    await held.release(world.devicesAnswer());
    await settle();
    expect(line("devices")).toBe("2 of 8 places for syncing in use.");
    expect(document.querySelectorAll("[data-device-row]")).toHaveLength(2);
  });

  test("an older return-triggered answer never replaces a newer read made for a change on this page", async () => {
    const world = server();
    const nameDevice = vi.fn(async (id: string, name: string | null) => {
      if (name !== null) world.rename(id, name);
      return ok("named" as const);
    });
    await mount({ ...world, nameDevice });
    const stale = world.devicesAnswer();
    const held = later<Result<Devices>>();
    world.readDevices.mockImplementationOnce(() => held.promise);
    await returnToTab();
    // While the refresh is outstanding, a name saved here reads the lists again (and is answered first).
    fireEvent.click(renamePhone());
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Device name"), {
      target: { value: "Work phone" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(
        [...document.querySelectorAll("[data-device-name]")].map(
          (node) => node.textContent,
        ),
      ).toContain("Work phone"),
    );
    await held.release(stale);
    await settle();
    expect(
      [...document.querySelectorAll("[data-device-name]")].map(
        (node) => node.textContent,
      ),
    ).toContain("Work phone");
  });
});

describe("lifetime, offline and failure (Q8)", () => {
  test("after the screen is left a return reads nothing", async () => {
    const world = server();
    const { router } = await mount(world);
    await act(() => router.navigate({ to: "/settings" }));
    await waitFor(() =>
      expect(document.querySelector("[data-capacity]")).toBeNull(),
    );
    const before = reads(world);
    await returnToTab();
    await settle();
    expect(reads(world)).toEqual(before);
  });

  test("while the browser says it is offline a return reads nothing and the rows stay", async () => {
    const world = server();
    await mount(world);
    const before = reads(world);
    online = false;
    await returnToTab();
    await settle();
    expect(reads(world)).toEqual(before);
    expect(document.querySelectorAll("[data-device-row]")).toHaveLength(2);
    expect(document.querySelector("[data-load-error]")).toBeNull();
  });

  test("a failed refresh shows the usual error and its Retry, never the old rows as fresh", async () => {
    const world = server();
    await mount(world);
    world.readDevices.mockImplementationOnce(async () => ({
      ok: false as const,
      error: "http" as const,
      status: 503,
    }));
    world.elsewhere();
    await returnToTab();
    await eventuallyShown(
      () =>
        screen.queryByText("Couldn't load your devices — please try again.", {
          selector: "main p",
        }),
      "the devices list's load error",
    );
    expect(document.querySelectorAll("[data-device-row]")).toHaveLength(0);
    // The sessions list read on its own and shows the change.
    await waitFor(() =>
      expect(line("sessions")).toBe("3 of 32 sign-ins in use."),
    );
    // The error keeps its Retry: another return does not read in its place.
    const before = reads(world);
    await returnToTab();
    await settle();
    expect(reads(world).devices).toBe(before.devices);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(line("devices")).toBe("3 of 8 places for syncing in use."),
    );
  });
});
