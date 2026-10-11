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
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import { type Operations, SessionProvider } from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  deviceRow,
  sessionDouble,
  sessionRow,
} from "../../helpers/session-double";

installMatchMedia({ width: 1440 });

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
});
beforeEach(() => {
  // The rows' fixed timestamps are read against "now"; pin only the date so
  // "Signed in 3 days ago" does not drift with the calendar. Timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#08090A">';
});

async function mount(operations: Partial<Operations> = {}) {
  const session = sessionDouble(operations);
  const router = createAppRouter({ initialPath: "/settings/sessions" });
  const view = render(
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
  await screen.findByRole("heading", { name: "Sessions & devices" });
  return { session, router, ...view };
}

const ok = <T,>(value: T) => ({ ok: true as const, value });
const failed = (requestId?: string) => ({
  ok: false as const,
  error: "http" as const,
  status: 500,
  atlasError: requestId
    ? { code: "internal", message: "boom", request_id: requestId }
    : undefined,
});

const notSent = () => ({ ok: false as const, error: "not_sent" as const });

const twoSessions = () =>
  ok({
    sessions: [
      sessionRow(),
      sessionRow({
        id: "sess-2",
        current: false,
        authentication: "oidc",
        // Relative to the real clock: the row renders "Signed in 3 days ago" whenever the suite runs.
        created_at: new Date(Date.now() - 3.5 * 86_400_000).toISOString(),
      }),
    ],
  });
const twoDevices = () =>
  ok({
    devices: [
      deviceRow(),
      deviceRow({
        id: "dev-2",
        current: false,
        active_sessions: 0,
        last_synced_at: null,
        state_token: "tok-2",
        summary: {
          sessions: 0,
          native_handoffs: 1,
          notification_subscriptions: 0,
          pending_sign_ins: 0,
          sync_registered: false,
        },
      }),
    ],
  });

describe("WF-SETTINGS-02 Sessions & devices (F-SET)", () => {
  test("two sections load independently, each with its own consequence statement", async () => {
    let releaseDevices: (value: ReturnType<typeof twoDevices>) => void =
      () => {};
    await mount({
      listSessions: vi.fn(async () => twoSessions()),
      readDevices: vi.fn(
        () =>
          new Promise<ReturnType<typeof twoDevices>>((resolve) => {
            releaseDevices = resolve;
          }),
      ),
    });
    // The sessions arrived while the devices are still loading.
    expect(await screen.findByText("Another sign-in")).toBeInTheDocument();
    expect(screen.getByText("Loading your devices…")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Ending one of these signs that browser out. It doesn't change syncing.",
      ),
    ).toBeInTheDocument();
    await act(async () => releaseDevices(twoDevices()));
    expect(await screen.findByText("Another device")).toBeInTheDocument();
  });

  // WEB-08d: G-1 to G-3 are superseded (BE-Q25 labels, names and capacities). Their neutral rows remain the FALLBACK for an answer
  // without the BE-Q25 members (a 0.27 server), and that is what this test now pins; the labelled rows are in session-labels.test.tsx.
  test("rows carry neutral labels from real fields only (gaps G-1 to G-3; WEB-08d: the fallback for an answer without BE-Q25 members)", async () => {
    await mount({
      listSessions: vi.fn(async () => twoSessions()),
      readDevices: vi.fn(async () => twoDevices()),
    });
    // Titles, plus the "This browser" tag on the current row (WEB-08d D-8d-05 replaces "Current session").
    const sessions = await screen.findAllByText(
      /^(This browser|Another sign-in)$/,
    );
    expect(sessions).toHaveLength(3);
    expect(
      document.querySelectorAll(
        "[data-session-row=current] [data-current-tag]",
      ),
    ).toHaveLength(1);
    expect(
      screen.getAllByText(/Password · Signed in .* · Expires in/),
    ).toHaveLength(1);
    expect(
      screen.getByText(/Single sign-on · Signed in 3 days ago/),
    ).toBeInTheDocument();
    expect(
      document.querySelector("[data-device-row=current]")?.textContent,
    ).toContain("This device");
    expect(
      document.querySelectorAll("[data-device-row=current] [data-current-tag]"),
    ).toHaveLength(1);
    expect(
      screen.getByText(/2 active sessions · Last synced/),
    ).toBeInTheDocument();
    // A device with no sign-ins is still listed, and retirable.
    expect(
      screen.getByText("0 active sessions · Never synced"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Retire another device, never synced",
      }),
    ).toBeEnabled();
    // Nothing the contract cannot supply is invented: without the members, both capacities are unavailable and naming is not offered.
    expect(document.body.textContent).not.toMatch(
      /room for|of 5|Chrome|macOS|iPhone/,
    );
    expect(
      document.querySelector("[data-capacity=sessions]")?.textContent,
    ).toBe("We can't show how many sign-ins this account can have.");
    expect(document.querySelector("[data-capacity=devices]")?.textContent).toBe(
      "We can't show how many devices can sync.",
    );
    expect(
      screen.queryAllByRole("button", { name: /^(Re)?[Nn]ame / }),
    ).toHaveLength(0);
  });

  test("when only the person's own rows exist, they are the lists", async () => {
    await mount({
      listSessions: vi.fn(async () => ok({ sessions: [sessionRow()] })),
      readDevices: vi.fn(async () => ok({ devices: [deviceRow()] })),
    });
    await screen.findAllByText("This browser");
    expect(document.querySelectorAll("[data-session-row]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-device-row]")).toHaveLength(1);
  });

  test("each section has its own error banner and its own retry", async () => {
    // StrictMode runs the load effect twice, so the answer depends on a flag, not on the call number.
    let failing = true;
    const listSessions = vi.fn(async () =>
      failing ? failed("req-1") : twoSessions(),
    );
    await mount({
      listSessions,
      readDevices: vi.fn(async () => twoDevices()),
    });
    const banner = await screen.findByText(
      "Couldn't load your sign-ins — please try again.",
    );
    expect(screen.getByText("Request ID: req-1")).toBeInTheDocument();
    // The devices did load: the failure did not spill over.
    expect(await screen.findByText("Another device")).toBeInTheDocument();
    failing = false;
    const before = listSessions.mock.calls.length;
    fireEvent.click(
      within(banner.closest("[data-load-error]") as HTMLElement).getByRole(
        "button",
        { name: "Try again" },
      ),
    );
    expect(await screen.findByText("Another sign-in")).toBeInTheDocument();
    expect(listSessions.mock.calls.length).toBe(before + 1);
  });

  test("an offline load says so", async () => {
    await mount({
      listSessions: vi.fn(async () => ({
        ok: false as const,
        error: "offline" as const,
      })),
      readDevices: vi.fn(async () => twoDevices()),
    });
    expect(
      await screen.findByText(
        "You're offline, so we can't load your sign-ins right now.",
      ),
    ).toBeInTheDocument();
  });

  test("a not_sent answer (the hold just after display) is called again quietly: no error banner, then the rows appear", async () => {
    // Found by the WebKit integration run: the resume verification's hold cancelled both list requests before they were sent, and
    // the screen showed an error for a condition that clears in milliseconds. StrictMode loads twice, so the answer is a flag.
    let holding = true;
    const listSessions = vi.fn(async () =>
      holding ? notSent() : twoSessions(),
    );
    const readDevices = vi.fn(async () => (holding ? notSent() : twoDevices()));
    await mount({ listSessions, readDevices });
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector("[data-load-error]")).toBeNull();
    expect(screen.getByText("Loading your sign-ins…")).toBeInTheDocument();
    expect(screen.getByText("Loading your devices…")).toBeInTheDocument();
    holding = false;
    expect(await screen.findByText("Another sign-in")).toBeInTheDocument();
    expect(await screen.findByText("Another device")).toBeInTheDocument();
    expect(document.querySelector("[data-load-error]")).toBeNull();
  });

  test("a revoke that comes back not_sent is called again, and the person sees only its result", async () => {
    const answers: Array<
      ReturnType<typeof notSent> | ReturnType<typeof ok<"revoked">>
    > = [notSent(), ok("revoked" as const)];
    const revokeOtherSession = vi.fn(
      async () => answers.shift() ?? ok("revoked" as const),
    );
    await mount({
      listSessions: vi.fn(async () => twoSessions()),
      revokeOtherSession,
      readDevices: vi.fn(async () => twoDevices()),
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: /^Sign out another sign-in, signed in /,
      }),
    );
    await waitFor(() => expect(revokeOtherSession).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Couldn't revoke this session/)).toBeNull();
  });

  test("signing out ANOTHER sign-in calls the ordinary operation and reloads the list", async () => {
    const revokeOtherSession = vi.fn(async () => ok("revoked" as const));
    const listSessions = vi.fn(async () => twoSessions());
    await mount({
      listSessions,
      revokeOtherSession,
      readDevices: vi.fn(async () => twoDevices()),
    });
    const button = await screen.findByRole("button", {
      name: /^Sign out another sign-in, signed in /,
    });
    // StrictMode loads twice, so count the reload relative to the moment of the click.
    const before = listSessions.mock.calls.length;
    fireEvent.click(button);
    await waitFor(() =>
      expect(revokeOtherSession).toHaveBeenCalledWith("sess-2"),
    );
    await waitFor(() =>
      expect(listSessions.mock.calls.length).toBe(before + 1),
    );
  });

  test("a failed revoke shows the message and a copyable request id, and is not an error banner", async () => {
    await mount({
      listSessions: vi.fn(async () => twoSessions()),
      revokeOtherSession: vi.fn(async () => failed("req-9")),
      readDevices: vi.fn(async () => twoDevices()),
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: /^Sign out another sign-in, signed in /,
      }),
    );
    expect(
      await screen.findByText(
        /Couldn't revoke this session — please try again\. Request ID: req-9/,
      ),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-load-error]")).toBeNull();
  });
});

describe("logout confirmation (F-SET, gap G-12)", () => {
  const open = async (operations: Partial<Operations> = {}) => {
    const mounted = await mount({
      listSessions: vi.fn(async () => twoSessions()),
      readDevices: vi.fn(async () => twoDevices()),
      ...operations,
    });
    await screen.findAllByText("This browser");
    const row = document.querySelector(
      "[data-session-row=current]",
    ) as HTMLElement;
    fireEvent.click(
      within(row).getByRole("button", { name: "Sign out of this browser" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Log out?" });
    return { ...mounted, dialog };
  };

  test("a confirmation is always shown, defaults to 'Stay logged in', and has no unsynced warning when there is nothing unsynced", async () => {
    const { session, dialog } = await open();
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Log out" }),
      ).toBeEnabled(),
    );
    expect(
      within(dialog).getByText(/ends your current session immediately/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Stay logged in" }),
      ).toHaveFocus(),
    );
    expect(session.operations.logout).not.toHaveBeenCalled();
  });

  test("with unsynced changes it names the count and each change, says they are deleted and cannot be recovered", async () => {
    const summary = {
      count: 3,
      items: [
        "Buy new school shoes (created)",
        "Empty the dishwasher (marked done)",
      ],
      digest: "d3",
    };
    const { session, dialog } = await open({
      summariseLocalWork: vi.fn(async () => summary),
    });
    expect(
      await within(dialog).findByText(
        "3 changes haven't finished syncing yet:",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Buy new school shoes (created)"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Logging out now will permanently delete these unsynced changes from this device. They cannot be recovered.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Log out anyway →" }),
    );
    await waitFor(() =>
      expect(session.operations.logout).toHaveBeenCalledWith({
        unsynced: summary,
      }),
    );
  });

  test("'Stay logged in' closes it and nothing is sent; no timer confirms it for the person", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { session, dialog } = await open();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(session.operations.logout).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Stay logged in" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Log out?" })).toBeNull(),
    );
    expect(session.operations.logout).not.toHaveBeenCalled();
  });

  test("a changed recount shows the corrected re-confirmation instead of proceeding, then uses the new count", async () => {
    const first = { count: 3, items: [], digest: "d3" };
    const recount = { count: 4, items: [], digest: "d4" };
    const logout = vi
      .fn()
      .mockResolvedValueOnce({ kind: "reconfirm", unsynced: recount })
      .mockResolvedValue({ kind: "started", operation_id: "op-1" });
    const { dialog } = await open({
      summariseLocalWork: vi.fn(async () => first),
      logout,
    });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Log out anyway →" }),
    );
    expect(
      await within(dialog).findByText("Actually 4 changes — still log out?"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText("3 changes haven't finished syncing yet:"),
    ).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Log out anyway →" }),
    );
    await waitFor(() =>
      expect(logout).toHaveBeenLastCalledWith({ unsynced: recount }),
    );
  });

  test("a refusal says why and changes nothing", async () => {
    const { dialog } = await open({
      logout: vi.fn(async () => ({
        kind: "refused" as const,
        reason: "operation_pending" as const,
      })),
    });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Log out" }),
    );
    expect(
      await within(dialog).findByText(
        "Another sign-out is already in progress.",
      ),
    ).toBeInTheDocument();
  });

  test("if the count cannot be read it cannot be confirmed, and says why", async () => {
    const { dialog } = await open({
      summariseLocalWork: vi.fn(async () => null),
    });
    expect(
      await within(dialog).findByText(
        "We couldn't check for unsynced changes, so we can't continue.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Log out" }),
    ).toBeDisabled();
  });

  test("the dialog renders inside the registered portal container, and axe finds nothing", async () => {
    const { dialog } = await open({
      summariseLocalWork: vi.fn(async () => ({
        count: 1,
        items: ["One change"],
        digest: "d1",
      })),
    });
    await within(dialog).findByText("1 change hasn't finished syncing yet:");
    expect(dialog.closest("[data-portal-root]")).not.toBeNull();
    expect((await axe(document.body)).violations).toEqual([]);
  });
});

describe("device retirement (F-SET)", () => {
  const openCurrent = async (operations: Partial<Operations> = {}) => {
    const mounted = await mount({
      listSessions: vi.fn(async () => twoSessions()),
      readDevices: vi.fn(async () => twoDevices()),
      ...operations,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Retire this device" }),
    );
    return {
      ...mounted,
      dialog: await screen.findByRole("dialog", {
        name: "Retire this device?",
      }),
    };
  };

  test("retiring THIS device shows the device summary and what it does, then sends the read's own row", async () => {
    const { session, dialog } = await openCurrent();
    expect(
      within(dialog).getByText("2 sign-ins on this device"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("1 notification subscription"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("This device syncs with this account"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Retiring this device signs you out here, right now.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Retire this device" }),
    );
    await waitFor(() =>
      expect(session.operations.retireThisDevice).toHaveBeenCalledWith({
        read: expect.objectContaining({
          id: "dev-1",
          state_token: "tok-1",
          current: true,
        }),
        unsynced: { count: 0, items: [], digest: "0" },
      }),
    );
  });

  test("with unsynced changes the confirmation uses 'retire this device' in place of 'log out'", async () => {
    const { dialog } = await openCurrent({
      summariseLocalWork: vi.fn(async () => ({
        count: 2,
        items: [],
        digest: "d2",
      })),
    });
    expect(
      await within(dialog).findByText(
        "2 changes haven't finished syncing yet:",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /Retiring this device now will permanently delete these unsynced changes/,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", {
        name: "Retire this device anyway →",
      }),
    ).toBeInTheDocument();
  });

  test("retiring ANOTHER device confirms, sends the row it was read with, and reloads", async () => {
    const retireOtherDevice = vi.fn(async () =>
      ok("confirmed_applied" as const),
    );
    const readDevices = vi.fn(async () => twoDevices());
    await mount({
      readDevices,
      retireOtherDevice,
      listSessions: vi.fn(async () => twoSessions()),
    });
    const trigger = await screen.findByRole("button", {
      name: "Retire another device, never synced",
    });
    const before = readDevices.mock.calls.length;
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Retire another device?",
    });
    // It touches nothing on this browser, so there is no unsynced-work warning.
    expect(within(dialog).queryByText(/cannot be recovered/)).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Retire device" }),
    );
    await waitFor(() =>
      expect(retireOtherDevice).toHaveBeenCalledWith(
        expect.objectContaining({ id: "dev-2", state_token: "tok-2" }),
      ),
    );
    await waitFor(() => expect(readDevices.mock.calls.length).toBe(before + 1));
  });

  test("retiring another device that comes back not_sent is called again with the same row, then reloads", async () => {
    const answers: Array<
      ReturnType<typeof notSent> | ReturnType<typeof ok<"confirmed_applied">>
    > = [notSent(), ok("confirmed_applied" as const)];
    const retireOtherDevice = vi.fn(
      async (_row: unknown) =>
        answers.shift() ?? ok("confirmed_applied" as const),
    );
    await mount({
      retireOtherDevice,
      readDevices: vi.fn(async () => twoDevices()),
      listSessions: vi.fn(async () => twoSessions()),
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Retire another device, never synced",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Retire device" }),
    );
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(2));
    expect(retireOtherDevice.mock.calls[0]?.[0]).toBe(
      retireOtherDevice.mock.calls[1]?.[0],
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("a stale device is reported, nothing is retried", async () => {
    const retireOtherDevice = vi.fn(async () => ok("rejected_stale" as const));
    await mount({
      retireOtherDevice,
      readDevices: vi.fn(async () => twoDevices()),
      listSessions: vi.fn(async () => twoSessions()),
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Retire another device, never synced",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Retire device" }),
    );
    expect(
      await within(dialog).findByText(/Something about that device changed/),
    ).toBeInTheDocument();
    expect(retireOtherDevice).toHaveBeenCalledTimes(1);
  });

  test("offline the Retire controls are disabled with the reason beside them, and re-enable on reconnect", async () => {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    await mount({
      readDevices: vi.fn(async () => twoDevices()),
      listSessions: vi.fn(async () => twoSessions()),
    });
    const disabled = await screen.findAllByRole("button", {
      name: /^Retire (this device|another device, never synced)$/,
    });
    for (const button of disabled) expect(button).toBeDisabled();
    expect(
      screen.getAllByText("Retiring a device needs a connection.").length,
    ).toBeGreaterThan(0);
    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    for (const button of screen.getAllByRole("button", {
      name: /^Retire (this device|another device, never synced)$/,
    }))
      expect(button).toBeEnabled();
  });
});
