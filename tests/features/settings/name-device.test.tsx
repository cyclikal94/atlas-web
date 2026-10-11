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
import { isolate } from "../../../src/features/settings/sessions-devices/labels";
import {
  type Operations,
  type Result,
  SessionProvider,
} from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  deviceRow,
  sessionDouble,
  sessionRow,
  WITHDRAW,
} from "../../helpers/session-double";

/**
 * WEB-08d: recognisable rows, both capacities, naming and the named confirmations, through the real Settings route over a double of
 * the PUBLIC session interface (what the screen does with each answer; the protocol is the fake-world suites' job).
 */
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
const chrome = { channel: "browser", browser: "chrome", platform: "macos" };
const firefox = { channel: "browser", browser: "firefox", platform: "windows" };
const iosApp = { channel: "native", browser: null, platform: "ios" };
const capacity = (used: number, limit: number | null = 8) => ({
  limit,
  used,
  remaining: limit === null ? null : Math.max(limit - used, 0),
});

const labelledSessions = (over: Record<string, unknown> = {}) =>
  ok({
    sessions: [
      sessionRow({ client: chrome, device_name: null }),
      sessionRow({
        id: "sess-2",
        device_id: "dev-2",
        current: false,
        authentication: "oidc",
        client: iosApp,
        device_name: "Kieran's phone",
        created_at: "2026-09-27T12:00:00.000Z",
      }),
    ],
    session_capacity: capacity(2),
    ...over,
  });
const labelledDevices = (
  over: Record<string, unknown> = {},
  rows?: ReturnType<typeof deviceRow>[],
) =>
  ok({
    devices: rows ?? [
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
        active_sessions: 0,
        last_synced_at: null,
      }),
    ],
    sync_capacity: capacity(2),
    ...over,
  });
const polite = () =>
  document.querySelector("[aria-live=polite]")?.textContent ?? "";
const assertive = () =>
  document.querySelector("[aria-live=assertive]")?.textContent ?? "";
const devicesSection = () =>
  screen
    .getByRole("heading", { name: "Devices that sync" })
    .closest("section") as HTMLElement;

describe("recognisable rows (D-8d-03 to D-8d-06)", () => {
  test("sessions and devices are titled by label and name, each current row has exactly one indicator, and no identifier is shown", async () => {
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => labelledDevices()),
    });
    await screen.findByText("Atlas app on iOS", {
      selector: "[data-device-label]",
    });
    const current = document.querySelector(
      "[data-session-row=current]",
    ) as HTMLElement;
    expect(current.textContent).toContain("Chrome on macOS");
    expect(current.querySelectorAll("[data-current-tag]")).toHaveLength(1);
    expect(within(current).getByText("This browser")).toHaveAttribute(
      "data-current-tag",
    );
    const other = document.querySelector(
      "[data-session-row=other]",
    ) as HTMLElement;
    expect(other.textContent).toContain("Atlas app on iOS");
    expect(other.querySelector("[data-device-name] bdi")?.textContent).toBe(
      "Kieran's phone",
    );
    expect(other.querySelectorAll("[data-current-tag]")).toHaveLength(0);
    // Devices: a name is the title (in <bdi>) and its label moves to the metadata; the current device is tagged once.
    const rows = [...document.querySelectorAll("[data-device-row]")];
    expect(rows.map((row) => row.getAttribute("data-device-row"))).toEqual([
      "current",
      "other",
      "other",
    ]);
    expect(rows[0]?.querySelectorAll("[data-current-tag]")).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Chrome on macOS");
    expect(rows[1]?.querySelector("bdi[data-device-name]")?.textContent).toBe(
      "Kieran's phone",
    );
    expect(rows[1]?.querySelector("[data-device-label]")?.textContent).toBe(
      "Atlas app on iOS",
    );
    expect(rows[2]?.textContent).toContain("Firefox on Windows");
    expect(
      document.querySelectorAll("[data-device-row=other] [data-current-tag]"),
    ).toHaveLength(0);
    // Identifiers and tokens are never shown.
    expect(document.body.textContent).not.toMatch(/sess-|dev-\d|tok-/);
    // Timestamps are kept.
    expect(other.textContent).toMatch(/Single sign-on · Signed in 3 days ago/);
  });

  test("every row action is named by its row: title, device name and the row's own time; a name is bidi-isolated", async () => {
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => labelledDevices()),
    });
    expect(
      await screen.findByRole("button", {
        name: "Sign out of this browser, Chrome on macOS",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `Sign out Atlas app on iOS (${isolate("Kieran's phone")}), signed in 3 days ago`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Retire this device, Chrome on macOS",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `Retire ${isolate("Kieran's phone")}, last synced 3 hours ago`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `Rename ${isolate("Kieran's phone")}, last synced 3 hours ago`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Name Firefox on Windows, never synced",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Name this device, Chrome on macOS" }),
    ).toBeInTheDocument();
  });

  test("two devices that look the same get one hint, and their actions still differ by their own metadata", async () => {
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () =>
        labelledDevices({}, [
          deviceRow({ client: chrome }),
          deviceRow({
            id: "dev-2",
            current: false,
            client: firefox,
            last_synced_at: "2026-09-30T09:00:00.000Z",
          }),
          deviceRow({
            id: "dev-3",
            current: false,
            client: firefox,
            last_synced_at: null,
          }),
        ]),
      ),
    });
    await waitFor(() =>
      expect(document.querySelectorAll("[data-device-row]")).toHaveLength(3),
    );
    // Asserted with expect (not a Testing Library lookup), so a missing hint fails an ASSERTION.
    expect(document.querySelectorAll("[data-duplicate-hint]")).toHaveLength(1);
    expect(document.querySelector("[data-duplicate-hint]")?.textContent).toBe(
      "Some devices look the same here. Give them names to tell them apart.",
    );
    const names = screen
      .getAllByRole("button", { name: /^Retire Firefox on Windows/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([
      "Retire Firefox on Windows, last synced 3 hours ago",
      "Retire Firefox on Windows, never synced",
    ]);
  });

  test("no hint when the titles differ", async () => {
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => labelledDevices()),
    });
    await screen.findByText("Firefox on Windows");
    expect(document.querySelector("[data-duplicate-hint]")).toBeNull();
  });

  test("hostile metadata is text: markup in a name creates no element, an RTL name is isolated, and an invalid name falls back", async () => {
    const markup = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () =>
        labelledDevices({}, [
          deviceRow({ client: chrome, name: "בית" }),
          deviceRow({
            id: "dev-2",
            current: false,
            client: iosApp,
            name: markup,
          }),
          deviceRow({
            id: "dev-3",
            current: false,
            client: firefox,
            name: "evil\u202Etxt.exe",
          }),
        ]),
      ),
    });
    await screen.findByText(markup);
    const section = devicesSection();
    expect(section.querySelector("img, script")).toBeNull();
    expect(
      [...section.querySelectorAll("bdi")].map((node) => node.textContent),
    ).toEqual(["בית", markup]);
    // The override is never shown; the row falls back to its label.
    expect(section.textContent).not.toContain("\u202E");
    expect(
      (document.querySelectorAll("[data-device-row]")[2] as HTMLElement)
        .textContent,
    ).toContain("Firefox on Windows");
    expect(
      screen.getByRole("button", {
        name: `Retire this device, ${isolate("בית")}`,
      }),
    ).toBeInTheDocument();
  });
});

describe("capacity (D-8d-11)", () => {
  test("both lines come from their own answers: sessions from session_capacity, devices from sync_capacity, never the number of rows", async () => {
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () =>
        labelledDevices({ sync_capacity: capacity(1, 6) }),
      ),
    });
    expect(
      (await screen.findByText("2 of 8 sign-ins in use.")).getAttribute(
        "data-capacity",
      ),
    ).toBe("sessions");
    // Three devices are listed; one holds a place for syncing.
    await waitFor(() =>
      expect(
        document.querySelector("[data-capacity=devices]")?.textContent,
      ).toBe("1 of 6 places for syncing in use."),
    );
  });

  test("full, unlimited and inconsistent readings", async () => {
    await mount({
      listSessions: vi.fn(async () =>
        labelledSessions({ session_capacity: capacity(3, 3) }),
      ),
      readDevices: vi.fn(async () =>
        labelledDevices({ sync_capacity: { limit: 8, used: 2, remaining: 5 } }),
      ),
    });
    expect(
      await screen.findByText(
        "3 of 3 sign-ins in use. A new sign-in won't work until you sign one out.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("We can't show how many devices can sync."),
    ).toBeInTheDocument();
    cleanup();
    await mount({
      listSessions: vi.fn(async () =>
        labelledSessions({ session_capacity: capacity(2, null) }),
      ),
      readDevices: vi.fn(async () =>
        labelledDevices({ sync_capacity: capacity(1, null) }),
      ),
    });
    expect(
      await screen.findByText("2 sign-ins in use. This server sets no limit."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 place for syncing in use. This server sets no limit.",
      ),
    ).toBeInTheDocument();
  });

  test("no capacity line while a list reloads or after it fails: an earlier reading is never left standing", async () => {
    let answer: "ready" | "hold" | "fail" = "ready";
    let release: (value: Result<unknown>) => void = () => {};
    const readDevices = vi.fn(() => {
      if (answer === "ready") return Promise.resolve(labelledDevices());
      if (answer === "fail")
        return Promise.resolve({
          ok: false as const,
          error: "http" as const,
          status: 500,
        });
      return new Promise<Result<unknown>>((resolve) => {
        release = resolve;
      });
    }) as unknown as Operations["readDevices"];
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices,
    });
    await screen.findByText("2 of 8 places for syncing in use.");
    answer = "hold";
    // A naming change reloads the list.
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
    await waitFor(() =>
      expect(document.querySelector("[data-capacity=devices]")).toBeNull(),
    );
    expect(screen.getByText("Loading your devices…")).toBeInTheDocument();
    answer = "fail";
    await act(async () => release({ ok: false, error: "http", status: 500 }));
    await screen.findByText("Couldn't load your devices — please try again.");
    expect(document.querySelector("[data-capacity=devices]")).toBeNull();
  });
});

describe("naming (D-8d-09, D-8d-10)", () => {
  const open = async (
    operations: Partial<Operations> = {},
    button = "Name Firefox on Windows, never synced",
  ) => {
    const mounted = await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => labelledDevices()),
      ...operations,
    });
    fireEvent.click(await screen.findByRole("button", { name: button }));
    const dialog = await screen.findByRole("dialog");
    return { ...mounted, dialog };
  };
  const type = (dialog: HTMLElement, value: string) =>
    fireEvent.change(within(dialog).getByLabelText("Device name"), {
      target: { value },
    });
  const save = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));

  test("naming is offered only when the server supports it (the devices answer carries sync_capacity)", async () => {
    const { sync_capacity: _omit, ...rest } = labelledDevices().value;
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => ok(rest)),
    });
    await screen.findByText("Firefox on Windows");
    expect(
      screen.queryAllByRole("button", { name: /^(Re)?[Nn]ame / }),
    ).toHaveLength(0);
    expect(
      screen.getByText("We can't show how many devices can sync."),
    ).toBeInTheDocument();
  });

  test("the exact typed value is sent (inner spaces, ZWJ), the person hears it was saved, and BOTH lists are read again", async () => {
    const listSessions = vi.fn(async () => labelledSessions());
    const readDevices = vi.fn(async () => labelledDevices());
    const { session, dialog } = await open({ listSessions, readDevices });
    expect(dialog).toHaveAccessibleName("Name a device");
    const [sessionsBefore, devicesBefore] = [
      listSessions.mock.calls.length,
      readDevices.mock.calls.length,
    ];
    const value = "Den  PC \u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    type(dialog, value);
    save(dialog);
    await waitFor(() =>
      expect(session.operations.nameDevice).toHaveBeenCalledWith(
        "dev-3",
        value,
        WITHDRAW,
      ),
    );
    await waitFor(() => expect(polite()).toBe("Name saved."));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(readDevices.mock.calls.length).toBe(devicesBefore + 1);
    expect(listSessions.mock.calls.length).toBe(sessionsBefore + 1);
  });

  test.each([
    ["", "Enter a name, or choose Remove name."],
    [" Den", "Remove the space at the start or end."],
    ["Den\u00A0", "Remove the space at the start or end."],
    ["x".repeat(65), "Use 64 characters or fewer."],
    ["Den\u202E", "Remove the hidden or control characters from the name."],
    ["Den\u200B", "Remove the hidden or control characters from the name."],
  ])("%j is refused before sending: %s", async (value, message) => {
    const { session, dialog } = await open();
    type(dialog, value);
    save(dialog);
    await waitFor(() =>
      expect(dialog.querySelector("[data-name-problem]")?.textContent).toBe(
        message,
      ),
    );
    const problem = dialog.querySelector("[data-name-problem]") as HTMLElement;
    const input = within(dialog).getByLabelText("Device name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain(problem.id);
    expect(input).toHaveValue(value);
    expect(session.operations.nameDevice).not.toHaveBeenCalled();
  });

  test("a named device opens as Rename with its name, and Remove name sends null", async () => {
    const { session, dialog } = await open(
      {},
      `Rename ${isolate("Kieran's phone")}, last synced 3 hours ago`,
    );
    expect(dialog).toHaveAccessibleName(`Rename ${isolate("Kieran's phone")}`);
    expect(within(dialog).getByLabelText("Device name")).toHaveValue(
      "Kieran's phone",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove name" }),
    );
    await waitFor(() =>
      expect(session.operations.nameDevice).toHaveBeenCalledWith(
        "dev-2",
        null,
        WITHDRAW,
      ),
    );
    await waitFor(() => expect(polite()).toBe("Name removed."));
  });

  test("gone: the device is no longer listed; it says so, nothing was named, and the list is read again", async () => {
    const readDevices = vi.fn(async () => labelledDevices());
    const { dialog } = await open({
      readDevices,
      nameDevice: vi.fn(async () => ok("gone" as const)),
    });
    const before = readDevices.mock.calls.length;
    type(dialog, "Den");
    save(dialog);
    expect(
      await within(dialog).findByText(
        "That device isn't listed any more, so its name wasn't changed.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(readDevices.mock.calls.length).toBe(before + 1));
    expect(
      within(dialog).queryByRole("button", { name: "Save name" }),
    ).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
  });

  test("422: Atlas didn't accept it, with the request ID; the typed value is kept and nothing is reloaded", async () => {
    const readDevices = vi.fn(async () => labelledDevices());
    const { dialog } = await open({
      readDevices,
      nameDevice: vi.fn(async () => ({
        ok: false as const,
        error: "http" as const,
        status: 422,
        atlasError: {
          code: "invalid_value",
          message: "x",
          request_id: "req-422",
        },
      })),
    });
    const before = readDevices.mock.calls.length;
    type(dialog, "Den");
    save(dialog);
    expect(
      await within(dialog).findByText(
        "Atlas didn't accept that name. Check it and try again. Request ID: req-422",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Device name")).toHaveValue("Den");
    expect(readDevices.mock.calls.length).toBe(before);
  });

  test.each([
    ["a 503", { ok: false as const, error: "http" as const, status: 503 }],
    ["a lost answer", { ok: false as const, error: "offline" as const }],
  ])(
    "%s: the outcome is unknown, it says so (not 'not saved'), and the list is read again",
    async (_name, answer) => {
      const readDevices = vi.fn(async () => labelledDevices());
      const { dialog } = await open({
        readDevices,
        nameDevice: vi.fn(async () => answer),
      });
      const before = readDevices.mock.calls.length;
      type(dialog, "Den");
      save(dialog);
      await waitFor(() =>
        expect(dialog.querySelector("[data-refusal]")?.textContent).toBe(
          "We couldn't confirm the change. The list has been refreshed — check it, and try again if needed.",
        ),
      );
      await waitFor(() =>
        expect(readDevices.mock.calls.length).toBe(before + 1),
      );
      expect(
        within(dialog).getByRole("button", { name: "Save name" }),
      ).toBeEnabled();
      expect(document.body.textContent).not.toMatch(/not saved|wasn't saved/);
    },
  );

  test("not_sent is called again quietly, and the person sees only the result", async () => {
    const answers: Array<Result<"named">> = [
      { ok: false, error: "not_sent" },
      ok("named" as const),
    ];
    const nameDevice = vi.fn(
      async () => answers.shift() ?? ok("named" as const),
    );
    const { dialog } = await open({ nameDevice });
    type(dialog, "Den");
    save(dialog);
    await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(polite()).toBe("Name saved."));
    expect(assertive()).toBe("");
  });

  test.each(["auth_state", "closed"] as const)(
    "%s: the session moved on; nothing is said, nothing is announced and the list is not read again",
    async (error) => {
      const readDevices = vi.fn(async () => labelledDevices());
      const nameDevice = vi.fn(async () => ({ ok: false as const, error }));
      const { dialog } = await open({ readDevices, nameDevice });
      const before = readDevices.mock.calls.length;
      type(dialog, "Den");
      save(dialog);
      await waitFor(() => expect(nameDevice).toHaveBeenCalledTimes(1));
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      expect(
        within(dialog).queryByText(/Name saved|couldn't|didn't|Atlas/),
      ).toBeNull();
      expect(polite()).toBe("");
      expect(assertive()).toBe("");
      expect(readDevices.mock.calls.length).toBe(before);
      expect(
        within(dialog).getByRole("button", { name: "Save name" }),
      ).toBeEnabled();
    },
  );

  // Adapted, labelled (WEB-08d review R1, revision 2): this case used to require that NO list was read after the dialog closed (the
  // plan's D-8d-10 "changes nothing"). Review R1 showed that leaves both lists stale after a change the server made: dismissing the
  // dialog does not undo a request already sent. Its no-announcement intent is kept; the lists must now be read again.
  test("a result that arrives after the dialog was closed says nothing, but both lists are read again", async () => {
    let release: (value: Result<"named">) => void = () => {};
    const readDevices = vi.fn(async () => labelledDevices());
    const listSessions = vi.fn(async () => labelledSessions());
    const { dialog } = await open({
      readDevices,
      listSessions,
      nameDevice: vi.fn(
        () =>
          new Promise<Result<"named">>((resolve) => {
            release = resolve;
          }),
      ) as unknown as Operations["nameDevice"],
    });
    const before = readDevices.mock.calls.length;
    const beforeSessions = listSessions.mock.calls.length;
    type(dialog, "Den");
    save(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => release(ok("named" as const)));
    await waitFor(() => expect(readDevices.mock.calls.length).toBe(before + 1));
    await waitFor(() =>
      expect(listSessions.mock.calls.length).toBe(beforeSessions + 1),
    );
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(polite()).toBe("");
    expect(assertive()).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("offline: Name and Rename are disabled with the reason beside them, and nothing can be sent", async () => {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    const { session } = await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => labelledDevices()),
    });
    const buttons = await screen.findAllByRole("button", {
      name: /^(Re)?[Nn]ame /,
    });
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button).toBeDisabled();
    expect(
      screen.getAllByText("Naming a device needs a connection.").length,
    ).toBe(3);
    expect(session.operations.nameDevice).not.toHaveBeenCalled();
  });

  test("going offline with the dialog open disables Save with the reason; the handler re-checks the browser", async () => {
    const { session, dialog } = await open();
    type(dialog, "Den");
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    // The browser says offline before the hook has heard the event: the handler's own check refuses to send.
    save(dialog);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(session.operations.nameDevice).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(
      within(dialog).getByRole("button", { name: "Save name" }),
    ).toBeDisabled();
    expect(
      within(dialog).getAllByText("Naming a device needs a connection.").length,
    ).toBeGreaterThan(0);
  });

  test("the dialog renders in the portal container and axe finds nothing", async () => {
    const { dialog } = await open();
    type(dialog, " Den");
    save(dialog);
    await within(dialog).findByText("Remove the space at the start or end.");
    expect(dialog.closest("[data-portal-root]")).not.toBeNull();
    expect((await axe(document.body)).violations).toEqual([]);
  });
});

describe("confirmations name the selected item (D-8d-12)", () => {
  test("retiring another device: the title names it (a name isolated), and the token sent is the one from the read", async () => {
    const retireOtherDevice = vi.fn(async () =>
      ok("confirmed_applied" as const),
    );
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => labelledDevices()),
      retireOtherDevice,
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: `Retire ${isolate("Kieran's phone")}, last synced 3 hours ago`,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(`Retire ${isolate("Kieran's phone")}?`);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Retire device" }),
    );
    await waitFor(() =>
      expect(retireOtherDevice).toHaveBeenCalledWith(
        expect.objectContaining({ id: "dev-2", state_token: "tok-2" }),
        WITHDRAW,
      ),
    );
  });

  test("retiring this device: one identifying line above the unchanged WEB-04 warning", async () => {
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => labelledDevices()),
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Retire this device, Chrome on macOS",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Retire this device?",
    });
    expect(
      within(dialog).getByText("This device: Chrome on macOS"),
    ).toHaveAttribute("data-identity");
    expect(
      within(dialog).getByText(
        "Retiring this device signs you out here, right now.",
      ),
    ).toBeInTheDocument();
  });

  test("logging out: the warning names this browser; a NAMED current device is isolated in <bdi>", async () => {
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () =>
        labelledDevices({}, [deviceRow({ client: chrome, name: "Den" })]),
      ),
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Sign out of this browser, Chrome on macOS",
      }),
    );
    const logout = await screen.findByRole("dialog", { name: "Log out?" });
    expect(logout.querySelector("[data-identity]")?.textContent).toBe(
      "This browser: Chrome on macOS",
    );
    fireEvent.click(
      within(logout).getByRole("button", { name: "Stay logged in" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(
      screen.getByRole("button", {
        name: `Retire this device, ${isolate("Den")}`,
      }),
    );
    const retire = await screen.findByRole("dialog", {
      name: "Retire this device?",
    });
    const line = retire.querySelector("[data-identity]") as HTMLElement;
    expect(line.textContent).toBe("This device: Den");
    expect(line.querySelector("bdi")?.textContent).toBe("Den");
  });

  test("signing out another session names it in the announcement (no dialog: WF-SETTINGS-02 draws none)", async () => {
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => labelledDevices()),
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: `Sign out Atlas app on iOS (${isolate("Kieran's phone")}), signed in 3 days ago`,
      }),
    );
    await waitFor(() =>
      expect(polite()).toBe(
        `Atlas app on iOS (${isolate("Kieran's phone")}) was signed out.`,
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a failed sign-out of another session names it in the assertive announcement; the row keeps WEB-08a's line", async () => {
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => labelledDevices()),
      revokeOtherSession: vi.fn(async () => ({
        ok: false as const,
        error: "http" as const,
        status: 500,
      })),
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: /^Sign out Atlas app on iOS/,
      }),
    );
    await waitFor(() =>
      expect(assertive()).toBe(
        `Couldn't sign out Atlas app on iOS (${isolate("Kieran's phone")}) — please try again.`,
      ),
    );
    expect(
      screen.getByText("Couldn't revoke this session — please try again."),
    ).toBeInTheDocument();
  });

  test("labelled Settings pass axe, rows and dialogs included", async () => {
    await mount({
      listSessions: vi.fn(async () => labelledSessions()),
      readDevices: vi.fn(async () => labelledDevices()),
    });
    await screen.findByText("Firefox on Windows");
    expect((await axe(document.body)).violations).toEqual([]);
  });
});
