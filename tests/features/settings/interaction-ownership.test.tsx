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
import { NOT_SENT_DELAYS_MS } from "../../../src/features/settings/sessions-devices/until-sent";
import { LinkedIdentities } from "../../../src/features/settings/signing-in/LinkedIdentities";
import {
  type DeviceRow,
  type Identity,
  type Operations,
  type Result,
  type SendOptions,
  type Session,
  SessionProvider,
  type Store,
} from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  deviceRow,
  sessionDouble,
  sessionRow,
} from "../../helpers/session-double";

/**
 * WEB-08d review R1 and R3 (revision 2), and the design assessment's qualification groups Q1, Q2, Q4 to Q7 and Q9. Three lifetimes
 * are kept apart: the INTERACTION (one opening of a dialog, one press of a row's action) alone may retry or show its outcome; what an
 * ISSUED request may have changed reaches every list on screen for the same identity, whichever interaction made it and whether or not
 * it is still open; and a list reads again whenever it is told. Through the composed Settings route (real router and providers) over a
 * double of the PUBLIC session interface whose answers follow a small model of the server: a held answer is one the server has
 * already applied ("committed, answer in flight") unless a test says otherwise. A `not_sent` answer is synthetic here: the kernel's
 * own admission boundary is `operations-withdraw.test.ts`.
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
const NOT_SENT = { ok: false as const, error: "not_sent" as const };
const chrome = { channel: "browser", browser: "chrome", platform: "macos" };
const firefox = { channel: "browser", browser: "firefox", platform: "windows" };
const iosApp = { channel: "native", browser: null, platform: "ios" };
const capacity = (used: number, limit: number) => ({
  limit,
  used,
  remaining: Math.max(limit - used, 0),
});

/** An answer the test releases. */
function later<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release: (value: T) => act(async () => release(value)) };
}

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
        summary: {
          sessions: 1,
          native_handoffs: 0,
          notification_subscriptions: 0,
          pending_sign_ins: 0,
          sync_registered: false,
        },
      }),
    ];
  const nameOf = (id: string) =>
    devices.find((device) => device.id === id)?.name ?? null;
  const count = (id: string) =>
    sessions.filter((row) => row.device_id === id).length;
  const apply = {
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
  const reads = () => ({
    sessions: listSessions.mock.calls.length,
    devices: readDevices.mock.calls.length,
  });
  return { apply, listSessions, readDevices, reads };
}
type World = ReturnType<typeof server>;

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

async function mount(
  operations: Partial<Operations>,
  overrides: Partial<Session> = {},
) {
  const session = sessionDouble(operations, overrides);
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
  return { session, router };
}

const polite = () =>
  document.querySelector("[aria-live=polite]")?.textContent ?? "";
const assertive = () =>
  document.querySelector("[aria-live=assertive]")?.textContent ?? "";
const sessionRows = () => document.querySelectorAll("[data-session-row]");
const deviceRows = () => document.querySelectorAll("[data-device-row]");
const line = (kind: "sessions" | "devices") =>
  document.querySelector(`[data-capacity=${kind}]`)?.textContent ?? null;
const deviceRowOf = (id: "dev-1" | "dev-2" | "dev-3") =>
  [...deviceRows()][["dev-1", "dev-2", "dev-3"].indexOf(id)] as
    | HTMLElement
    | undefined;
/** The device names on screen, in both lists. */
const names = () => ({
  devices: [...document.querySelectorAll("bdi[data-device-name]")].map(
    (node) => node.textContent,
  ),
  sessions: [...document.querySelectorAll("[data-device-name] bdi")].map(
    (node) => node.textContent,
  ),
});
const settle = () =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

const NAME_FIREFOX = "Name Firefox on Windows, never synced";
const NAME_THIS = "Name this device, Chrome on macOS";
const RENAME_PHONE = `Rename ${isolate("Kieran's phone")}, last synced 3 hours ago`;
const RETIRE_PHONE = `Retire ${isolate("Kieran's phone")}, last synced 3 hours ago`;
const RETIRE_FIREFOX = "Retire Firefox on Windows, never synced";
const RETIRE_THIS = "Retire this device, Chrome on macOS";

/** The three ways to dismiss a dialog without its own action button. */
const DISMISS: Array<[string, (dialog: HTMLElement) => void]> = [
  [
    "Cancel/Keep",
    (dialog) =>
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: /^(Cancel|Keep this device)$/,
        }),
      ),
  ],
  ["Escape", (dialog) => fireEvent.keyDown(dialog, { key: "Escape" })],
  [
    "Close",
    (dialog) =>
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" })),
  ],
];

async function openDialog(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("dialog");
}
const typeName = (dialog: HTMLElement, value: string) =>
  fireEvent.change(within(dialog).getByLabelText("Device name"), {
    target: { value },
  });
const clickIn = (dialog: HTMLElement, name: string) =>
  fireEvent.click(within(dialog).getByRole("button", { name }));

/** nameDevice whose answers the test releases; the server applies the change when the request arrives (committed, answer held). */
function heldNaming(world: World, commit = true) {
  type Named = Result<"named" | "cleared" | "gone">;
  const answers: Array<ReturnType<typeof later<Named>>> = [];
  const nameDevice = vi.fn((id: string, name: string | null) => {
    if (commit) world.apply.name(id, name);
    const answer = later<Named>();
    answers.push(answer);
    return answer.promise;
  });
  return { nameDevice, answers };
}

describe("Q1: a naming request already sent still reaches both lists after its dialog is dismissed (R1)", () => {
  test.each(DISMISS)(
    "save, then %s, then the success: both lists show the name; nothing is said",
    async (_how, dismiss) => {
      const world = server();
      const { nameDevice, answers } = heldNaming(world);
      await mount({ ...world, nameDevice });
      const dialog = await openDialog(NAME_FIREFOX);
      typeName(dialog, "Den");
      clickIn(dialog, "Save name");
      await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
      dismiss(dialog);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const before = world.reads();
      await answers[0]?.release(ok("named"));
      await waitFor(() =>
        expect(names()).toEqual({
          devices: ["Kieran's phone", "Den"],
          sessions: ["Kieran's phone", "Den"],
        }),
      );
      expect(world.reads()).toEqual({
        sessions: before.sessions + 1,
        devices: before.devices + 1,
      });
      await settle();
      expect(polite()).toBe("");
      expect(assertive()).toBe("");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(nameDevice).toHaveBeenCalledTimes(1);
    },
  );

  test.each(DISMISS)(
    "clear, then %s, then `cleared`: the name leaves both lists; nothing is said",
    async (_how, dismiss) => {
      const world = server();
      const { nameDevice, answers } = heldNaming(world);
      await mount({ ...world, nameDevice });
      const dialog = await openDialog(RENAME_PHONE);
      clickIn(dialog, "Remove name");
      await waitFor(() =>
        expect(nameDevice).toHaveBeenCalledWith(
          "dev-2",
          null,
          expect.anything(),
        ),
      );
      dismiss(dialog);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await answers[0]?.release(ok("cleared"));
      await waitFor(() =>
        expect(names()).toEqual({ devices: [], sessions: [] }),
      );
      await settle();
      expect(polite()).toBe("");
      expect(assertive()).toBe("");
    },
  );

  test("this device, dismissed: the same", async () => {
    const world = server();
    const { nameDevice, answers } = heldNaming(world);
    await mount({ ...world, nameDevice });
    const dialog = await openDialog(NAME_THIS);
    typeName(dialog, "Desk");
    clickIn(dialog, "Save name");
    await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
    clickIn(dialog, "Cancel");
    await answers[0]?.release(ok("named"));
    await waitFor(() =>
      expect(names().sessions).toEqual(["Desk", "Kieran's phone"]),
    );
    expect(polite()).toBe("");
  });

  test.each([
    ["gone", ok("gone")],
    [
      "an outcome nobody can confirm (offline)",
      { ok: false, error: "offline" },
    ],
    ["a 503", { ok: false, error: "http", status: 503 }],
  ] as const)(
    "dismissed, then %s: both lists are read again; nothing is said",
    async (_name, answer) => {
      const world = server();
      const { nameDevice, answers } = heldNaming(world);
      await mount({ ...world, nameDevice });
      const dialog = await openDialog(NAME_FIREFOX);
      typeName(dialog, "Den");
      clickIn(dialog, "Save name");
      await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
      clickIn(dialog, "Cancel");
      const before = world.reads();
      await answers[0]?.release(answer as Result<never>);
      await waitFor(() =>
        expect(world.reads()).toEqual({
          sessions: before.sessions + 1,
          devices: before.devices + 1,
        }),
      );
      await settle();
      expect(polite()).toBe("");
      expect(assertive()).toBe("");
    },
  );

  test.each([
    ["a 422 refusal", { ok: false, error: "http", status: 422 }],
    ["closed", { ok: false, error: "closed" }],
    ["auth_state", { ok: false, error: "auth_state" }],
  ] as const)(
    "dismissed, then %s: nothing changed, nothing is read again or said",
    async (_name, answer) => {
      const world = server();
      const { nameDevice, answers } = heldNaming(world, false);
      await mount({ ...world, nameDevice });
      const dialog = await openDialog(NAME_FIREFOX);
      typeName(dialog, "Den");
      clickIn(dialog, "Save name");
      await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
      clickIn(dialog, "Cancel");
      const before = world.reads();
      await answers[0]?.release(answer as Result<never>);
      await settle();
      expect(world.reads()).toEqual(before);
      expect(polite()).toBe("");
      expect(assertive()).toBe("");
    },
  );

  test.each([
    ["the same device", NAME_FIREFOX],
    ["another device", RENAME_PHONE],
  ])(
    "dismissed, then %s opened with a draft, then the old success: the lists behind refresh; the new dialog, its draft and focus stay",
    async (_name, reopen) => {
      const world = server();
      const { nameDevice, answers } = heldNaming(world);
      await mount({ ...world, nameDevice });
      const first = await openDialog(NAME_FIREFOX);
      typeName(first, "Den");
      clickIn(first, "Save name");
      await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
      clickIn(first, "Cancel");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const second = await openDialog(reopen);
      expect(second).not.toBe(first);
      const field = within(second).getByLabelText("Device name");
      typeName(second, "My draft");
      field.focus();
      await answers[0]?.release(ok("named"));
      await waitFor(() =>
        expect(names().sessions).toEqual(["Kieran's phone", "Den"]),
      );
      await settle();
      expect(screen.queryAllByRole("dialog")).toEqual([second]);
      expect(field).toHaveValue("My draft");
      expect(document.activeElement).toBe(field);
      expect(second.querySelector("[data-refusal]")).toBeNull();
      expect(
        within(second).getByRole("button", { name: "Save name" }),
      ).toBeEnabled();
      expect(polite()).toBe("");
      expect(assertive()).toBe("");
    },
  );

  test("refused before sending, then dismissed: the name is not tried again", async () => {
    const world = server();
    const { nameDevice, answers } = heldNaming(world, false);
    await mount({ ...world, nameDevice });
    const dialog = await openDialog(NAME_FIREFOX);
    typeName(dialog, "Den");
    clickIn(dialog, "Save name");
    await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
    clickIn(dialog, "Cancel");
    const timers = vi.spyOn(globalThis, "setTimeout");
    await answers[0]?.release(NOT_SENT);
    await settle();
    expect(
      timers.mock.calls.filter(([, ms]) =>
        NOT_SENT_DELAYS_MS.includes(ms as number),
      ),
    ).toEqual([]);
    expect(nameDevice).toHaveBeenCalledTimes(1);
    expect(names().sessions).toEqual(["Kieran's phone"]);
  });

  test("control: a dialog left open is told the outcome and closes itself, and both lists are read once", async () => {
    const world = server();
    const { nameDevice, answers } = heldNaming(world);
    await mount({ ...world, nameDevice });
    const dialog = await openDialog(NAME_FIREFOX);
    typeName(dialog, "Den");
    clickIn(dialog, "Save name");
    await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
    const before = world.reads();
    await answers[0]?.release(ok("named"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(polite()).toBe("Name saved."));
    await waitFor(() =>
      expect(names().sessions).toEqual(["Kieran's phone", "Den"]),
    );
    expect(world.reads()).toEqual({
      sessions: before.sessions + 1,
      devices: before.devices + 1,
    });
  });
});

/** retireOtherDevice whose answers the test scripts: each call takes the next entry; "hold" entries are released by the test. */
function scriptedRetirement(world: World) {
  const held: Array<ReturnType<typeof later<Result<never>>>> = [];
  const withdraws: AbortSignal[] = [];
  const retireOtherDevice = vi.fn(
    (row: DeviceRow, send?: SendOptions): Promise<Result<never>> => {
      if (send?.withdraw) withdraws.push(send.withdraw);
      const answer = later<Result<never>>();
      held.push(answer);
      return answer.promise.then((value) => {
        if (value.ok) world.apply.retire(row.id);
        return value;
      });
    },
  ) as unknown as Operations["retireOtherDevice"] & ReturnType<typeof vi.fn>;
  return { retireOtherDevice, held, withdraws };
}

describe("Q2: a retirement refused before it was sent is not tried again once its dialog has gone (R3)", () => {
  test.each(DISMISS)(
    "not_sent held, %s, then released: one call, no retry is even scheduled, the device stays",
    async (_how, dismiss) => {
      const world = server();
      const { retireOtherDevice, held, withdraws } = scriptedRetirement(world);
      await mount({ ...world, retireOtherDevice });
      const dialog = await openDialog(RETIRE_PHONE);
      clickIn(dialog, "Retire device");
      await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(1));
      expect(withdraws[0]?.aborted).toBe(false);
      dismiss(dialog);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // Dismissal withdraws it at once: the kernel will not issue a request still waiting for admission.
      expect(withdraws[0]?.aborted).toBe(true);
      const timers = vi.spyOn(globalThis, "setTimeout");
      const before = world.reads();
      await held[0]?.release(NOT_SENT);
      await settle();
      // Complete drain: no retry delay was scheduled at all (not merely "none fired within a window").
      expect(
        timers.mock.calls.filter(([, ms]) =>
          NOT_SENT_DELAYS_MS.includes(ms as number),
        ),
      ).toEqual([]);
      expect(retireOtherDevice).toHaveBeenCalledTimes(1);
      expect(world.reads()).toEqual(before);
      expect(deviceRows()).toHaveLength(3);
      expect(assertive()).toBe("");
    },
  );

  test("ended during the first retry delay: the retry after it is never made", async () => {
    const world = server();
    const { retireOtherDevice, held } = scriptedRetirement(world);
    await mount({ ...world, retireOtherDevice });
    const dialog = await openDialog(RETIRE_PHONE);
    const timers = vi.spyOn(globalThis, "setTimeout");
    clickIn(dialog, "Retire device");
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(1));
    await held[0]?.release(NOT_SENT);
    // The first delay is now running (the helper's own sleep).
    await waitFor(() =>
      expect(
        timers.mock.calls.some(([, ms]) => ms === NOT_SENT_DELAYS_MS[0]),
      ).toBe(true),
    );
    clickIn(dialog, "Keep this device");
    await act(
      async () =>
        new Promise((resolve) =>
          setTimeout(resolve, (NOT_SENT_DELAYS_MS[0] ?? 0) * 4),
        ),
    );
    expect(retireOtherDevice).toHaveBeenCalledTimes(1);
    expect(deviceRows()).toHaveLength(3);
  });

  test("control: left open, the retry is made once with the same approved row, and it applies", async () => {
    const world = server();
    const { retireOtherDevice, held } = scriptedRetirement(world);
    await mount({ ...world, retireOtherDevice });
    const dialog = await openDialog(RETIRE_PHONE);
    clickIn(dialog, "Retire device");
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(1));
    await held[0]?.release(NOT_SENT);
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(2));
    expect(retireOtherDevice.mock.calls[1]?.[0]).toBe(
      retireOtherDevice.mock.calls[0]?.[0],
    );
    await held[1]?.release(ok("confirmed_applied") as never);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(deviceRows()).toHaveLength(2));
    await waitFor(() => expect(sessionRows()).toHaveLength(2));
  });

  test("a second press before the busy state renders sends nothing more", async () => {
    const world = server();
    const { retireOtherDevice } = scriptedRetirement(world);
    await mount({ ...world, retireOtherDevice });
    const dialog = await openDialog(RETIRE_PHONE);
    const button = within(dialog).getByRole("button", {
      name: "Retire device",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await settle();
    expect(retireOtherDevice).toHaveBeenCalledTimes(1);
  });
});

describe("Q4: a late retirement answer reaches the lists but never a newer dialog (R3)", () => {
  test.each([
    [
      "this device's retirement",
      RETIRE_THIS,
      (dialog: HTMLElement) =>
        expect(
          within(dialog).getByRole("button", { name: /^Stay/ }),
        ).toBeInTheDocument(),
    ],
    [
      "another device's retirement",
      RETIRE_FIREFOX,
      (dialog: HTMLElement) =>
        expect(dialog).toHaveAccessibleName("Retire Firefox on Windows?"),
    ],
    [
      "the same device's retirement, reopened",
      RETIRE_PHONE,
      (dialog: HTMLElement) =>
        expect(dialog).toHaveAccessibleName(
          `Retire ${isolate("Kieran's phone")}?`,
        ),
    ],
    [
      "a naming dialog",
      NAME_FIREFOX,
      (dialog: HTMLElement) =>
        expect(dialog).toHaveAccessibleName("Name a device"),
    ],
  ])(
    "applied, Keep, then %s opened: the old answer reads both lists and leaves the new dialog open and untouched",
    async (_name, reopen, isTheNewOne) => {
      const world = server();
      const { retireOtherDevice, held } = scriptedRetirement(world);
      const retireThisDevice = vi.fn();
      await mount({ ...world, retireOtherDevice, retireThisDevice });
      const first = await openDialog(RETIRE_PHONE);
      clickIn(first, "Retire device");
      await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(1));
      clickIn(first, "Keep this device");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const second = await openDialog(reopen);
      isTheNewOne(second);
      await held[0]?.release(ok("confirmed_applied") as never);
      await waitFor(() =>
        expect(line("sessions")).toBe("2 of 32 sign-ins in use."),
      );
      await waitFor(() =>
        expect(line("devices")).toBe("1 of 8 places for syncing in use."),
      );
      await settle();
      expect(screen.queryAllByRole("dialog")).toEqual([second]);
      isTheNewOne(second);
      expect(second.querySelector("[data-refusal]")).toBeNull();
      expect(retireThisDevice).not.toHaveBeenCalled();
      expect(retireOtherDevice).toHaveBeenCalledTimes(1);
      expect(assertive()).toBe("");
    },
  );

  test("an outcome nobody can confirm, after Keep: both lists are read again and the newer dialog shows no failure", async () => {
    const world = server();
    const { retireOtherDevice, held } = scriptedRetirement(world);
    await mount({ ...world, retireOtherDevice });
    const first = await openDialog(RETIRE_PHONE);
    clickIn(first, "Retire device");
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(1));
    clickIn(first, "Keep this device");
    const second = await openDialog(RETIRE_FIREFOX);
    const before = world.reads();
    await held[0]?.release({ ok: false, error: "http", status: 503 });
    await waitFor(() =>
      expect(world.reads()).toEqual({
        sessions: before.sessions + 1,
        devices: before.devices + 1,
      }),
    );
    await settle();
    expect(screen.queryAllByRole("dialog")).toEqual([second]);
    expect(second.querySelector("[data-refusal]")).toBeNull();
  });

  test("rejected_stale after Keep: nothing changed, nothing is read again or shown", async () => {
    const world = server();
    const { retireOtherDevice, held } = scriptedRetirement(world);
    await mount({ ...world, retireOtherDevice });
    const first = await openDialog(RETIRE_PHONE);
    clickIn(first, "Retire device");
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(1));
    clickIn(first, "Keep this device");
    const before = world.reads();
    await held[0]?.release(ok("rejected_stale") as never);
    await settle();
    expect(world.reads()).toEqual(before);
    expect(retireOtherDevice).toHaveBeenCalledTimes(1);
  });

  test("control: a dialog left open shows its own outcome and closes itself", async () => {
    const world = server();
    const { retireOtherDevice, held } = scriptedRetirement(world);
    await mount({ ...world, retireOtherDevice });
    const dialog = await openDialog(RETIRE_PHONE);
    clickIn(dialog, "Retire device");
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(1));
    await held[0]?.release({ ok: false, error: "http", status: 503 });
    await waitFor(() =>
      expect(dialog.querySelector("[data-refusal]")?.textContent).toBe(
        "Couldn't retire this device — please try again.",
      ),
    );
  });
});

/** revokeOtherSession whose answers the test releases, per session. */
function heldRevoke(world: World) {
  const answers = new Map<string, ReturnType<typeof later<Result<never>>>>();
  const revokeOtherSession = vi.fn((id: string) => {
    const answer = later<Result<never>>();
    answers.set(id, answer);
    return answer.promise.then((value) => {
      if (value.ok) world.apply.revoke(id);
      return value;
    }) as Promise<Result<"revoked" | "gone">>;
  });
  return { revokeOtherSession, answers };
}
const signOut = (name: RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const PHONE = /^Sign out Atlas app on iOS/;
const FIREFOX = /^Sign out Firefox on Windows/;
const rowOf = (name: RegExp) =>
  screen.getByRole("button", { name }).closest("li") as HTMLElement;

describe("Q9: the warning before a wipe closes only itself", () => {
  test.each([
    ["this device's retirement", RETIRE_THIS, "Retire this device?"],
    ["logging out", "Sign out of this browser, Chrome on macOS", "Log out?"],
  ])(
    "%s: confirmed, Stay, opened again, then the first start arrives late: the newer warning stays open",
    async (_name, opener, title) => {
      const world = server();
      const started = later<{ kind: "started"; operation_id: string }>();
      const retireThisDevice = vi.fn(() => started.promise);
      const logout = vi.fn(() => started.promise);
      await mount({ ...world, retireThisDevice, logout });
      const first = await openDialog(opener);
      expect(first).toHaveAccessibleName(title);
      const confirm = await within(first).findByRole("button", {
        name: title.replace("?", ""),
      });
      await waitFor(() => expect(confirm).toBeEnabled());
      fireEvent.click(confirm);
      await waitFor(() =>
        expect(
          retireThisDevice.mock.calls.length + logout.mock.calls.length,
        ).toBe(1),
      );
      clickIn(first, "Stay logged in");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const second = await openDialog(opener);
      await started.release({ kind: "started", operation_id: "op-1" });
      await settle();
      expect(screen.queryAllByRole("dialog")).toEqual([second]);
      expect(second).toHaveAccessibleName(title);
    },
  );
});

test("the account card's logout warning: a late start of an older one never closes the newer (Q9)", async () => {
  const started = later<{ kind: "started"; operation_id: string }>();
  const logout = vi.fn(() => started.promise);
  const session = sessionDouble({ ...server(), logout });
  const router = createAppRouter({ initialPath: "/settings" });
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
  const opener = await screen.findByRole("button", { name: "Sign out" });
  fireEvent.click(opener);
  const first = await screen.findByRole("dialog", { name: "Log out?" });
  const confirm = await within(first).findByRole("button", { name: "Log out" });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  clickIn(first, "Stay logged in");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  const second = await screen.findByRole("dialog", { name: "Log out?" });
  await started.release({ kind: "started", operation_id: "op-1" });
  await settle();
  expect(screen.queryAllByRole("dialog")).toEqual([second]);
});

describe("Q5: each row's sign-out is its own (assessment A2)", () => {
  test.each([
    ["the first finishes first", ["sess-2", "sess-3"]],
    ["the second finishes first", ["sess-3", "sess-2"]],
  ] as const)(
    "two rows pending, %s: one row's answer never clears or overwrites the other's",
    async (_name, order) => {
      const world = server();
      const { revokeOtherSession, answers } = heldRevoke(world);
      await mount({ ...world, revokeOtherSession });
      signOut(PHONE);
      signOut(FIREFOX);
      await waitFor(() => expect(revokeOtherSession).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("button", { name: PHONE })).toBeDisabled();
      expect(screen.getByRole("button", { name: FIREFOX })).toBeDisabled();
      const [succeeds, fails] = order;
      const failing = fails === "sess-2" ? PHONE : FIREFOX;
      const leaving = succeeds === "sess-2" ? PHONE : FIREFOX;
      await answers.get(succeeds)?.release(ok("revoked") as never);
      await waitFor(() =>
        expect(screen.queryAllByRole("button", { name: leaving })).toHaveLength(
          0,
        ),
      );
      // The other row is still busy: the first answer did not release it.
      expect(screen.getByRole("button", { name: failing })).toBeDisabled();
      await answers.get(fails)?.release({
        ok: false,
        error: "http",
        status: 403,
        atlasError: { code: "forbidden", message: "no", request_id: "req-9" },
      } as never);
      await waitFor(() =>
        expect(rowOf(failing).querySelector("[data-error]")?.textContent).toBe(
          "Couldn't revoke this session — please try again. Request ID: req-9",
        ),
      );
      expect(screen.getByRole("button", { name: failing })).toBeEnabled();
      expect(revokeOtherSession).toHaveBeenCalledTimes(2);
      expect(sessionRows()).toHaveLength(2);
    },
  );

  test("a row's failure stays when another row is signed out", async () => {
    const world = server();
    const { revokeOtherSession, answers } = heldRevoke(world);
    await mount({ ...world, revokeOtherSession });
    signOut(PHONE);
    await waitFor(() => expect(revokeOtherSession).toHaveBeenCalledTimes(1));
    await answers.get("sess-2")?.release({
      ok: false,
      error: "http",
      status: 403,
    } as never);
    await waitFor(() =>
      expect(rowOf(PHONE).querySelector("[data-error]")).not.toBeNull(),
    );
    signOut(FIREFOX);
    await waitFor(() => expect(revokeOtherSession).toHaveBeenCalledTimes(2));
    expect(rowOf(PHONE).querySelector("[data-error]")).not.toBeNull();
  });

  test("a second press on the same row before it renders busy sends nothing more", async () => {
    const world = server();
    const { revokeOtherSession } = heldRevoke(world);
    await mount({ ...world, revokeOtherSession });
    const button = screen.getByRole("button", { name: PHONE });
    fireEvent.click(button);
    fireEvent.click(button);
    await settle();
    expect(revokeOtherSession).toHaveBeenCalledTimes(1);
  });
});

describe("Q6: a change completes after the screen was left and returned to (assessment A3)", () => {
  // The page behind an open dialog is inert, so the screen is left the way the router leaves it (as a sync-chip or tab change does).
  const leave = (router: { navigate(o: { to: string }): unknown }) =>
    act(async () => {
      await router.navigate({ to: "/settings" });
    });
  const back = async (router: { navigate(o: { to: string }): unknown }) => {
    await act(async () => {
      await router.navigate({ to: "/settings/sessions" });
    });
    await screen.findByText("3 of 32 sign-ins in use.");
  };

  test("naming sent, screen left and returned to before the answer: the new screen shows the name when it arrives", async () => {
    const world = server();
    const { nameDevice, answers } = heldNaming(world, false);
    const { router } = await mount({ ...world, nameDevice });
    const dialog = await openDialog(NAME_FIREFOX);
    typeName(dialog, "Den");
    clickIn(dialog, "Save name");
    await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
    await leave(router);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await back(router);
    expect(names().sessions).toEqual(["Kieran's phone"]);
    // The server commits now, after the new screen's own read; then the answer arrives.
    world.apply.name("dev-3", "Den");
    await answers[0]?.release(ok("named"));
    await waitFor(() =>
      expect(names().sessions).toEqual(["Kieran's phone", "Den"]),
    );
    await settle();
    expect(polite()).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("returned to after the answer: the new screen reads for itself", async () => {
    const world = server();
    const { nameDevice, answers } = heldNaming(world);
    const { router } = await mount({ ...world, nameDevice });
    const dialog = await openDialog(NAME_FIREFOX);
    typeName(dialog, "Den");
    clickIn(dialog, "Save name");
    await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
    await leave(router);
    await answers[0]?.release(ok("named"));
    await back(router);
    await waitFor(() =>
      expect(names().sessions).toEqual(["Kieran's phone", "Den"]),
    );
    expect(polite()).toBe("");
  });

  test("a sign-out refused before sending, then the screen left: not tried again", async () => {
    const world = server();
    const { revokeOtherSession, answers } = heldRevoke(world);
    const { router } = await mount({ ...world, revokeOtherSession });
    signOut(FIREFOX);
    await waitFor(() => expect(revokeOtherSession).toHaveBeenCalledTimes(1));
    await leave(router);
    await waitFor(() =>
      expect(screen.queryByText("3 of 32 sign-ins in use.")).toBeNull(),
    );
    const timers = vi.spyOn(globalThis, "setTimeout");
    await answers.get("sess-3")?.release(NOT_SENT as never);
    await settle();
    expect(
      timers.mock.calls.filter(([, ms]) =>
        NOT_SENT_DELAYS_MS.includes(ms as number),
      ),
    ).toEqual([]);
    expect(revokeOtherSession).toHaveBeenCalledTimes(1);
  });

  test("an older list read answered after a newer one never replaces it (useLoad generations)", async () => {
    const world = server();
    const first = later<Awaited<ReturnType<World["readDevices"]>>>();
    let holdNext = false;
    const readDevices = vi.fn(() => {
      // The first read after the change is held: a newer one (after a second change) answers first.
      if (!holdNext) return world.readDevices();
      holdNext = false;
      return first.promise;
    });
    const nameDevice = vi.fn(async (id: string, name: string | null) => {
      world.apply.name(id, name);
      return ok("named" as const);
    });
    const revokeOtherSession = vi.fn(async (id: string) => {
      world.apply.revoke(id);
      return ok("revoked" as const);
    });
    await mount({ ...world, readDevices, nameDevice, revokeOtherSession });
    const stale = await world.readDevices();
    const reads = readDevices.mock.calls.length;
    holdNext = true;
    const dialog = await openDialog(NAME_FIREFOX);
    typeName(dialog, "Den");
    clickIn(dialog, "Save name");
    await waitFor(() => expect(readDevices).toHaveBeenCalledTimes(reads + 1));
    signOut(PHONE);
    await waitFor(() => expect(readDevices).toHaveBeenCalledTimes(reads + 2));
    await waitFor(() =>
      expect(deviceRowOf("dev-2")?.textContent).toContain("0 active sessions"),
    );
    await first.release(stale);
    await settle();
    expect(deviceRowOf("dev-2")?.textContent).toContain("0 active sessions");
    expect(names().devices).toEqual(["Kieran's phone", "Den"]);
  });
});

describe("Q7: an identity change ends every interaction of the old one", () => {
  const A = { account_id: "acct", epoch: 1, session_id: "sess-1" };

  test.each([
    ["another account", { account_id: "other", epoch: 1, session_id: "s-b" }],
    ["the same account, a new epoch", { ...A, epoch: 2 }],
  ])(
    "%s settles while a naming answer is held: no list is read for it and nothing is said",
    async (_name, next) => {
      const world = server();
      const identity = identityStore(A);
      const { nameDevice, answers } = heldNaming(world);
      await mount({ ...world, nameDevice }, { identity });
      const dialog = await openDialog(NAME_FIREFOX);
      typeName(dialog, "Den");
      clickIn(dialog, "Save name");
      await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
      const before = world.reads();
      act(() => identity.set(next));
      await answers[0]?.release(ok("named"));
      await settle();
      expect(world.reads()).toEqual(before);
      expect(polite()).toBe("");
      expect(screen.queryAllByRole("dialog")).toEqual([dialog]);
    },
  );

  test("a retry of the old identity is never made under the new one", async () => {
    const world = server();
    const identity = identityStore(A);
    const { retireOtherDevice, held } = scriptedRetirement(world);
    await mount({ ...world, retireOtherDevice }, { identity });
    const dialog = await openDialog(RETIRE_PHONE);
    clickIn(dialog, "Retire device");
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(1));
    act(() => identity.set({ ...A, account_id: "other" }));
    await held[0]?.release(NOT_SENT);
    await act(
      async () =>
        new Promise((resolve) =>
          setTimeout(resolve, (NOT_SENT_DELAYS_MS[0] ?? 0) * 4),
        ),
    );
    expect(retireOtherDevice).toHaveBeenCalledTimes(1);
  });

  test("control: the same identity throughout, the answer is shown and the lists read", async () => {
    const world = server();
    const identity = identityStore(A);
    const { nameDevice, answers } = heldNaming(world);
    await mount({ ...world, nameDevice }, { identity });
    const dialog = await openDialog(NAME_FIREFOX);
    typeName(dialog, "Den");
    clickIn(dialog, "Save name");
    await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
    act(() => identity.set({ ...A }));
    await answers[0]?.release(ok("named"));
    await waitFor(() => expect(polite()).toBe("Name saved."));
  });
});

describe("Q9: the other ordinary change requests are owned too", () => {
  async function signingIn(operations: Partial<Operations>) {
    const session = sessionDouble({
      readAccount: vi.fn(async () =>
        ok({
          id: "acct-1",
          username: "kieran",
          has_password: true,
          oidc_issuers: [],
        }),
      ),
      listSessions: vi.fn(async () =>
        ok({
          sessions: [
            sessionRow({
              created_at: new Date(Date.now() - 60_000).toISOString(),
            }),
          ],
        }),
      ),
      ...operations,
    });
    const router = createAppRouter({ initialPath: "/settings/signing-in" });
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
    return screen.findByRole("dialog", { name: "Signing in" });
  }

  test.each([
    ["closed", true],
    ["control: left open", false],
  ])(
    "a password change refused before sending, its dialog %s",
    async (_name, close) => {
      const first = later<Result<"changed">>();
      let calls = 0;
      const changePassword = vi.fn(() => {
        calls += 1;
        return calls === 1
          ? first.promise
          : Promise.resolve(ok("changed" as const));
      });
      const dialog = await signingIn({ changePassword });
      fireEvent.change(
        await within(dialog).findByLabelText("Current password"),
        {
          target: { value: "old-password" },
        },
      );
      fireEvent.change(within(dialog).getByLabelText("New password"), {
        target: { value: "brand-new-password" },
      });
      clickIn(dialog, "Change password");
      await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
      if (close) {
        clickIn(dialog, "Close");
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      }
      await first.release(NOT_SENT);
      if (close) {
        await act(
          async () =>
            new Promise((resolve) =>
              setTimeout(resolve, (NOT_SENT_DELAYS_MS[0] ?? 0) * 4),
            ),
        );
        expect(changePassword).toHaveBeenCalledTimes(1);
      } else {
        await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(2));
      }
    },
  );

  test.each([
    ["unmounted", true],
    ["control: still mounted", false],
  ])(
    "an identity removal refused before sending, the screen %s",
    async (_name, unmountIt) => {
      const first = later<Result<"unlinked">>();
      let calls = 0;
      const unlinkOidc = vi.fn(() => {
        calls += 1;
        return calls === 1
          ? first.promise
          : Promise.resolve(ok("unlinked" as const));
      });
      const session = sessionDouble({ unlinkOidc });
      const view = render(
        <SessionProvider session={session}>
          <ProtectedProviders>
            <LinkedIdentities
              account={{
                id: "acct-1",
                username: "kieran",
                has_password: true,
                oidc_issuers: ["https://idp.example.test"],
              }}
              currentSessionStartedAt={new Date(
                Date.now() - 60_000,
              ).toISOString()}
              navigate={vi.fn()}
            />
          </ProtectedProviders>
        </SessionProvider>,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Remove idp.example.test" }),
      );
      await waitFor(() => expect(unlinkOidc).toHaveBeenCalledTimes(1));
      if (unmountIt) view.unmount();
      await first.release(NOT_SENT);
      if (unmountIt) {
        await act(
          async () =>
            new Promise((resolve) =>
              setTimeout(resolve, (NOT_SENT_DELAYS_MS[0] ?? 0) * 4),
            ),
        );
        expect(unlinkOidc).toHaveBeenCalledTimes(1);
      } else {
        await waitFor(() => expect(unlinkOidc).toHaveBeenCalledTimes(2));
      }
    },
  );
});
