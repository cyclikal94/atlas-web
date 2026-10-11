import { RouterProvider } from "@tanstack/react-router";
import {
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
import {
  type DeviceRow,
  type Operations,
  type Result,
  SessionProvider,
} from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  deviceRow,
  sessionDouble,
  sessionRow,
} from "../../helpers/session-double";

/**
 * Review R1 (WEB-08d cycle 1): one server change touches BOTH lists. Retiring another device ends its sessions; signing out the last
 * session of a never-synced device removes that device (and a synced device's session count drops). Through the composed Settings
 * screen, over a double of the PUBLIC session interface whose answers follow a small model of the server's state, a confirmed change
 * (or one whose outcome is unknown) must read both lists again; a definite refusal reads nothing again. Naming is the healthy control.
 */
installMatchMedia({ width: 1440 });

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#08090A">';
});

const ok = <T,>(value: T) => ({ ok: true as const, value });
const chrome = { channel: "browser", browser: "chrome", platform: "macos" };
const firefox = { channel: "browser", browser: "firefox", platform: "windows" };
const iosApp = { channel: "native", browser: null, platform: "ios" };
const capacity = (used: number, limit: number) => ({
  limit,
  used,
  remaining: Math.max(limit - used, 0),
});
const unsynced = {
  sessions: 1,
  native_handoffs: 0,
  notification_subscriptions: 0,
  pending_sign_ins: 0,
  sync_registered: false,
};

/** The server's state for one account: three sessions on three devices; dev-3 has never synced. */
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
    sessionRow({
      id: "sess-3",
      device_id: "dev-3",
      current: false,
      client: firefox,
      created_at: "2026-09-29T12:00:00.000Z",
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
      deviceRow({
        id: "dev-3",
        current: false,
        client: firefox,
        name: null,
        state_token: "tok-3",
        last_synced_at: null,
        summary: unsynced,
      }),
    ];
  const nameOf = (id: string) =>
    devices.find((device) => device.id === id)?.name ?? null;
  const count = (id: string) =>
    sessions.filter((row) => row.device_id === id).length;
  const apply = {
    /** The session ends; a device that never synced leaves with its last session. */
    revoke(id: string) {
      const ended = sessions.find((row) => row.id === id);
      sessions = sessions.filter((row) => row.id !== id);
      if (!ended) return;
      devices = devices.filter(
        (device) =>
          device.id !== ended.device_id ||
          device.summary.sync_registered ||
          count(device.id) > 0,
      );
    },
    /** The device and every session on it end. */
    retire(id: string) {
      devices = devices.filter((device) => device.id !== id);
      sessions = sessions.filter((row) => row.device_id !== id);
    },
    name(id: string, name: string | null) {
      devices = devices.map((device) =>
        device.id === id ? { ...device, name } : device,
      );
    },
  };
  const listSessions = vi.fn(async () =>
    ok({
      sessions: sessions.map((row) => ({
        ...row,
        device_name: nameOf(row.device_id),
      })),
      session_capacity: capacity(sessions.length, 32),
    }),
  );
  const readDevices = vi.fn(async () =>
    ok({
      devices: devices.map((device) => ({
        ...device,
        active_sessions: count(device.id),
      })),
      sync_capacity: capacity(
        devices.filter((device) => device.summary.sync_registered).length,
        8,
      ),
    }),
  );
  return { apply, listSessions, readDevices };
}

async function mount(operations: Partial<Operations>) {
  const session = sessionDouble(operations);
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
  await screen.findByText("3 of 32 sign-ins in use.");
  await screen.findByText("2 of 8 places for syncing in use.");
  return session;
}

const sessionRows = () => document.querySelectorAll("[data-session-row]");
const deviceRows = () => document.querySelectorAll("[data-device-row]");
const assertive = () =>
  document.querySelector("[aria-live=assertive]")?.textContent ?? "";
const reads = (world: ReturnType<typeof server>) => ({
  sessions: world.listSessions.mock.calls.length,
  devices: world.readDevices.mock.calls.length,
});
const signOutFirefox = () =>
  screen.getByRole("button", { name: /^Sign out Firefox on Windows/ });
const signOutPhone = () =>
  screen.getByRole("button", { name: /^Sign out Atlas app on iOS/ });
const retirePhone = () =>
  screen.getByRole("button", {
    name: `Retire ${isolate("Kieran's phone")}, last synced 3 hours ago`,
  });
/** The capacity line's text, read through `expect` so a stale line is an assertion failure, not a lookup error. */
const line = (kind: "sessions" | "devices") =>
  document.querySelector(`[data-capacity=${kind}]`)?.textContent ?? null;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a change in one section reads both lists (R1)", () => {
  test("retiring another device ends its sessions: the sessions list and the sign-in capacity follow", async () => {
    const world = server();
    const retireOtherDevice = vi.fn(async (row: DeviceRow) => {
      world.apply.retire(row.id);
      return ok("confirmed_applied" as const);
    });
    await mount({ ...world, retireOtherDevice });
    const before = reads(world);
    fireEvent.click(retirePhone());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Retire device" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(line("sessions")).toBe("2 of 32 sign-ins in use."),
    );
    await waitFor(() =>
      expect(line("devices")).toBe("1 of 8 places for syncing in use."),
    );
    expect(sessionRows()).toHaveLength(2);
    expect(deviceRows()).toHaveLength(2);
    expect(
      screen.queryAllByRole("button", { name: /^Sign out Atlas app on iOS/ }),
    ).toHaveLength(0);
    // Each list is read once more: no double read from the section that made the change.
    expect(reads(world)).toEqual({
      sessions: before.sessions + 1,
      devices: before.devices + 1,
    });
  });

  test("signing out a never-synced device's last session removes the device and its controls", async () => {
    const world = server();
    const revokeOtherSession = vi.fn(async (id: string) => {
      world.apply.revoke(id);
      return ok("revoked" as const);
    });
    await mount({ ...world, revokeOtherSession });
    const before = reads(world);
    fireEvent.click(signOutFirefox());
    await waitFor(() =>
      expect(line("sessions")).toBe("2 of 32 sign-ins in use."),
    );
    await waitFor(() => expect(deviceRows()).toHaveLength(2));
    expect(
      screen.queryAllByRole("button", { name: /Firefox on Windows/ }),
    ).toHaveLength(0);
    expect(line("devices")).toBe("2 of 8 places for syncing in use.");
    expect(reads(world)).toEqual({
      sessions: before.sessions + 1,
      devices: before.devices + 1,
    });
  });

  test("signing out a synced device's session keeps the device, with its session count read again", async () => {
    const world = server();
    const revokeOtherSession = vi.fn(async (id: string) => {
      world.apply.revoke(id);
      return ok("revoked" as const);
    });
    await mount({ ...world, revokeOtherSession });
    const phone = () =>
      screen
        .getByRole("button", {
          name: `Retire ${isolate("Kieran's phone")}, last synced 3 hours ago`,
        })
        .closest("li") as HTMLElement;
    expect(phone()).toHaveTextContent("1 active session");
    fireEvent.click(signOutPhone());
    await waitFor(() => expect(phone()).toHaveTextContent("0 active sessions"));
    expect(deviceRows()).toHaveLength(3);
    expect(line("devices")).toBe("2 of 8 places for syncing in use.");
  });

  test("control: naming a device still reads both lists once, and the session row shows the new name", async () => {
    const world = server();
    const nameDevice = vi.fn(async (id: string, name: string | null) => {
      world.apply.name(id, name);
      return ok("named" as const);
    });
    await mount({ ...world, nameDevice });
    const before = reads(world);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Name Firefox on Windows, never synced",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Name a device" });
    fireEvent.change(within(dialog).getByLabelText("Device name"), {
      target: { value: "Den" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        (signOutFirefox().closest("li") as HTMLElement).querySelector(
          "[data-device-name] bdi",
        )?.textContent,
      ).toBe("Den"),
    );
    expect(reads(world)).toEqual({
      sessions: before.sessions + 1,
      devices: before.devices + 1,
    });
  });
});

/** Answers whose effect nobody can confirm: the server applied the change, but the answer was lost, refused by a 5xx, or threw. */
const UNKNOWN: Array<[string, () => Promise<Result<never>>]> = [
  ["offline after sending", async () => ({ ok: false, error: "offline" })],
  ["a 503", async () => ({ ok: false, error: "http", status: 503 })],
  [
    "a thrown call",
    async () => {
      throw new Error("lost");
    },
  ],
];

describe("an outcome nobody can confirm reads both lists (R1)", () => {
  test.each(UNKNOWN)("sign-out, %s", async (_name, answer) => {
    const world = server();
    const revokeOtherSession = vi.fn(async (id: string) => {
      world.apply.revoke(id);
      return answer();
    });
    await mount({ ...world, revokeOtherSession });
    fireEvent.click(signOutFirefox());
    await waitFor(() =>
      expect(assertive()).toMatch(/^Couldn't sign out Firefox on Windows/),
    );
    await waitFor(() => expect(deviceRows()).toHaveLength(2));
    await waitFor(() => expect(sessionRows()).toHaveLength(2));
    expect(line("sessions")).toBe("2 of 32 sign-ins in use.");
  });

  test("sign-out, a 503 for a session that is still there: the row keeps its failure line after the lists are read again", async () => {
    const world = server();
    const revokeOtherSession = vi.fn(async () => ({
      ok: false as const,
      error: "http" as const,
      status: 503,
      atlasError: { code: "internal", message: "boom", request_id: "req-7" },
    }));
    await mount({ ...world, revokeOtherSession });
    const before = reads(world);
    fireEvent.click(signOutFirefox());
    await waitFor(() =>
      expect(reads(world)).toEqual({
        sessions: before.sessions + 1,
        devices: before.devices + 1,
      }),
    );
    await waitFor(() =>
      expect(
        (signOutFirefox().closest("li") as HTMLElement).querySelector(
          "[data-error]",
        )?.textContent,
      ).toBe(
        "Couldn't revoke this session — please try again. Request ID: req-7",
      ),
    );
    expect(sessionRows()).toHaveLength(3);
  });

  test.each(UNKNOWN)("retirement, %s", async (_name, answer) => {
    const world = server();
    const retireOtherDevice = vi.fn(async (row: DeviceRow) => {
      world.apply.retire(row.id);
      return answer();
    });
    await mount({ ...world, retireOtherDevice });
    fireEvent.click(retirePhone());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Retire device" }),
    );
    await waitFor(() =>
      expect(dialog.querySelector("[data-refusal]")?.textContent).toBe(
        "Couldn't retire this device — please try again.",
      ),
    );
    // The lists behind the dialog are read again; the dialog stays with its failure.
    await waitFor(() =>
      expect(line("sessions")).toBe("2 of 32 sign-ins in use."),
    );
    await waitFor(() =>
      expect(line("devices")).toBe("1 of 8 places for syncing in use."),
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
  });
});

describe("a definite answer that changed nothing reads nothing again (R1)", () => {
  const refusal = {
    ok: false as const,
    error: "http" as const,
    status: 403,
    atlasError: { code: "forbidden", message: "no", request_id: "req-3" },
  };

  test.each([
    ["a 403 refusal", refusal],
    ["closed", { ok: false as const, error: "closed" as const }],
    ["auth_state", { ok: false as const, error: "auth_state" as const }],
  ])("sign-out, %s", async (_name, answer) => {
    const world = server();
    const revokeOtherSession = vi.fn(async () => answer);
    await mount({ ...world, revokeOtherSession });
    const before = reads(world);
    fireEvent.click(signOutFirefox());
    await waitFor(() =>
      expect(assertive()).toMatch(/^Couldn't sign out Firefox on Windows/),
    );
    await settle();
    expect(reads(world)).toEqual(before);
  });

  test.each([
    [
      "a 409 refusal",
      { ...refusal, status: 409 },
      /^Couldn't retire this device/,
    ],
    [
      "rejected_stale",
      ok("rejected_stale" as const),
      /^Something about that device changed/,
    ],
  ])("retirement, %s", async (_name, answer, message) => {
    const world = server();
    const retireOtherDevice = vi.fn(async () => answer);
    await mount({ ...world, retireOtherDevice });
    const before = reads(world);
    fireEvent.click(retirePhone());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Retire device" }),
    );
    await waitFor(() =>
      expect(dialog.querySelector("[data-refusal]")?.textContent).toMatch(
        message,
      ),
    );
    await settle();
    expect(reads(world)).toEqual(before);
  });
});
