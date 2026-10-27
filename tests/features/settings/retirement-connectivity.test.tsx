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
import { RETIRE_OFFLINE_REASON } from "../../../src/features/settings/sessions-devices/label-copy";
import {
  type LocalWorkSummary,
  type OperationStart,
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
 * WEB-08d revision 26 (review r25 R25-N2; design assessment 26f1a626 I7-I11, P1-P6, P11, Q6): retirement is online-only
 * (WF-SETTINGS-02; approved IA: disabled with the reason). Both retirement confirmations follow the browser's connectivity, and every
 * retirement opener and confirmation asks the browser at the moment of use, because the `offline` event can render after a click that
 * was already queued. The browser's value and its event are changed separately here, so a stale render is told apart from a completed
 * offline render. Logging out stays possible offline. A confirmation already admitted keeps its working state and its own fate. The
 * session is the public double: these prove what the screen does with each answer, nothing about the server.
 */
installMatchMedia({ width: 1440 });

/** The browser's belief, changed apart from its event: `notify` delivers the event (and so the render). */
const setOnline = async (value: boolean, notify = true) => {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
  if (notify)
    await act(async () => {
      window.dispatchEvent(new Event(value ? "online" : "offline"));
    });
};

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
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#08090A">';
});

const ok = <T,>(value: T) => ({ ok: true as const, value });
const devices = () =>
  ok({
    devices: [
      deviceRow(),
      deviceRow({
        id: "dev-2",
        current: false,
        active_sessions: 0,
        last_synced_at: null,
        state_token: "tok-2",
      }),
    ],
  });

/** A promise the test settles itself: an operation held at a known point. */
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function mount(
  operations: Partial<Operations> = {},
  initialPath = "/settings/sessions",
) {
  const session = sessionDouble({
    readDevices: vi.fn(async () => devices()),
    listSessions: vi.fn(async () => ok({ sessions: [sessionRow()] })),
    ...operations,
  });
  const router = createAppRouter({ initialPath });
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
  return session;
}

const KINDS = [
  {
    kind: "current",
    opener: "Retire this device",
    dialog: "Retire this device?",
    confirm: "Retire this device",
    operation: "retireThisDevice",
  },
  {
    kind: "other",
    opener: "Retire another device, never synced",
    dialog: /^Retire /,
    confirm: "Retire device",
    operation: "retireOtherDevice",
  },
] as const;

/** Opens a retirement dialog while online and returns it with its confirmation, once that can be used (the summary is read). */
async function open(k: (typeof KINDS)[number], session = mount()) {
  const s = await session;
  fireEvent.click(await screen.findByRole("button", { name: k.opener }));
  const dialog = await screen.findByRole("dialog", { name: k.dialog });
  const confirm = await within(dialog).findByRole("button", {
    name: k.confirm,
  });
  await waitFor(() => expect(confirm).toBeEnabled());
  return { session: s, dialog };
}
const confirmOf = (dialog: HTMLElement, k: (typeof KINDS)[number]) =>
  within(dialog).getByRole("button", { name: k.confirm });
/** The text a disabled control is described by, read through its `aria-describedby` (the Button's reason comes first). */
const describedBy = (button: HTMLElement) =>
  (button.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

describe("retirement admission follows connectivity (review r25 R25-N2)", () => {
  for (const k of KINDS) {
    describe(`${k.kind} device`, () => {
      test(`RC1 control: online, the confirmation invokes ${k.operation} once`, async () => {
        const { session, dialog } = await open(k);
        fireEvent.click(confirmOf(dialog, k));
        await waitFor(() =>
          expect(session.operations[k.operation]).toHaveBeenCalledTimes(1),
        );
      });

      test("RC2 opener race: the browser is offline before its event has rendered, so Retire… opens nothing; the event then disables it with the reason", async () => {
        await mount();
        const opener = await screen.findByRole("button", { name: k.opener });
        await setOnline(false, false);
        expect(opener).toBeEnabled();
        fireEvent.click(opener);
        await act(async () => {});
        expect(screen.queryByRole("dialog")).toBeNull();
        await setOnline(false);
        const disabled = screen.getByRole("button", { name: k.opener });
        expect(disabled).toBeDisabled();
        expect(describedBy(disabled)).toBe(RETIRE_OFFLINE_REASON);
      });

      test("RC3 open dialog, offline before its event: the confirmation's handler refuses to begin", async () => {
        const { session, dialog } = await open(k);
        await setOnline(false, false);
        const confirm = confirmOf(dialog, k);
        expect(confirm).toBeEnabled();
        fireEvent.click(confirm);
        await act(async () => {});
        expect(session.operations[k.operation]).not.toHaveBeenCalled();
      });

      test("RC4 open dialog, offline event: the confirmation is disabled and described by the reason; clicking does nothing", async () => {
        const { session, dialog } = await open(k);
        await setOnline(false);
        const confirm = confirmOf(dialog, k);
        expect(confirm).toBeDisabled();
        expect(describedBy(confirm)).toBe(RETIRE_OFFLINE_REASON);
        expect(within(dialog).getByText(RETIRE_OFFLINE_REASON)).toBeVisible();
        fireEvent.click(confirm);
        await act(async () => {});
        expect(session.operations[k.operation]).not.toHaveBeenCalled();
      });

      test("RC5 reconnect re-enables an idle confirmation without confirming it; a deliberate click then invokes once", async () => {
        const { session, dialog } = await open(k);
        await setOnline(false);
        await setOnline(true);
        const confirm = confirmOf(dialog, k);
        expect(confirm).toBeEnabled();
        expect(confirm.getAttribute("aria-describedby")).toBeNull();
        await act(async () => {
          await new Promise((r) => setTimeout(r, 20));
        });
        expect(session.operations[k.operation]).not.toHaveBeenCalled();
        fireEvent.click(confirm);
        await waitFor(() =>
          expect(session.operations[k.operation]).toHaveBeenCalledTimes(1),
        );
      });

      test("RC6 a confirmation already admitted keeps working through an offline event, a second click begins nothing, and its answer is used", async () => {
        const held =
          k.kind === "current"
            ? barrier<OperationStart>()
            : barrier<Result<"confirmed_applied">>();
        const operation = vi.fn(() => held.promise);
        const { session, dialog } = await open(
          k,
          mount({ [k.operation]: operation } as Partial<Operations>),
        );
        const confirm = confirmOf(dialog, k);
        await act(async () => {
          fireEvent.click(confirm);
          fireEvent.click(confirm);
        });
        expect(operation).toHaveBeenCalledTimes(1);
        await setOnline(false);
        const working = confirmOf(dialog, k);
        expect(working).toBeDisabled();
        expect(describedBy(working)).toBe("Working…");
        fireEvent.click(working);
        expect(operation).toHaveBeenCalledTimes(1);
        const reads = vi.mocked(session.operations.readDevices).mock.calls
          .length;
        await act(async () => {
          held.resolve(
            (k.kind === "current"
              ? { kind: "started", operation_id: "op-1" }
              : ok("confirmed_applied")) as never,
          );
        });
        // Started (the kernel's now) or applied: the dialog closes; an applied retirement of another device reads the lists again.
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        if (k.kind === "other")
          await waitFor(() =>
            expect(
              vi.mocked(session.operations.readDevices).mock.calls.length,
            ).toBeGreaterThan(reads),
          );
      });
    });
  }

  test("RC7 another device: a request issued before the connection was lost and then dismissed is not cancelled by the screen; its applied answer reads the lists again", async () => {
    const held = barrier<Result<"confirmed_applied">>();
    let signal: AbortSignal | undefined;
    const retireOtherDevice = vi.fn(
      (_row: unknown, options?: { withdraw?: AbortSignal }) => {
        signal = options?.withdraw;
        return held.promise;
      },
    );
    const k = KINDS[1];
    const { session, dialog } = await open(k, mount({ retireOtherDevice }));
    fireEvent.click(confirmOf(dialog, k));
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(1));
    await setOnline(false);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep this device" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Dismissal withdraws what was not yet issued (the session decides that); the connectivity change itself withdrew nothing.
    expect(signal?.aborted).toBe(true);
    const reads = vi.mocked(session.operations.readDevices).mock.calls.length;
    await act(async () => {
      held.resolve(ok("confirmed_applied"));
    });
    await waitFor(() =>
      expect(
        vi.mocked(session.operations.readDevices).mock.calls.length,
      ).toBeGreaterThan(reads),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(retireOtherDevice).toHaveBeenCalledTimes(1);
  });

  test("RC8 another device: an admitted retirement answered not_sent is called again as before, even after an offline event (the screen gates a NEW confirmation only)", async () => {
    const retireOtherDevice = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "not_sent" })
      .mockResolvedValue(ok("confirmed_applied"));
    const k = KINDS[1];
    const { dialog } = await open(k, mount({ retireOtherDevice }));
    fireEvent.click(confirmOf(dialog, k));
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(1));
    await setOnline(false);
    await waitFor(() => expect(retireOtherDevice).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("RC9 this device: while the unsynced count is still being read the reason is the count, then the connection; reconnecting enables it", async () => {
    const summary = barrier<LocalWorkSummary>();
    await mount({ summariseLocalWork: vi.fn(() => summary.promise) });
    fireEvent.click(
      await screen.findByRole("button", { name: "Retire this device" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Retire this device?",
    });
    await setOnline(false);
    const k = KINDS[0];
    expect(describedBy(confirmOf(dialog, k))).toBe(
      "Checking for unsynced changes…",
    );
    await act(async () => {
      summary.resolve({ count: 0, items: [], digest: "0" });
    });
    expect(describedBy(confirmOf(dialog, k))).toBe(RETIRE_OFFLINE_REASON);
    await setOnline(true);
    expect(confirmOf(dialog, k)).toBeEnabled();
  });

  test("RC10 this device: a count that cannot be read still cannot be confirmed after reconnecting, and says so (connectivity never bypasses it)", async () => {
    const retireThisDevice = vi.fn();
    await mount({
      summariseLocalWork: vi.fn(async () => {
        throw new Error("storage");
      }),
      retireThisDevice,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Retire this device" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Retire this device?",
    });
    const k = KINDS[0];
    const cannot =
      "We couldn't check for unsynced changes, so we can't continue.";
    await waitFor(() => expect(describedBy(confirmOf(dialog, k))).toBe(cannot));
    await setOnline(false);
    expect(describedBy(confirmOf(dialog, k))).toBe(cannot);
    await setOnline(true);
    expect(confirmOf(dialog, k)).toBeDisabled();
    expect(describedBy(confirmOf(dialog, k))).toBe(cannot);
    expect(retireThisDevice).not.toHaveBeenCalled();
  });

  test("RC11 this device: a corrected recount, then offline, cannot be confirmed; reconnecting confirms nothing by itself, and the deliberate click sends the new count", async () => {
    const recount = { count: 1, items: [], digest: "1" } as LocalWorkSummary;
    const retireThisDevice = vi
      .fn()
      .mockResolvedValueOnce({ kind: "reconfirm", unsynced: recount })
      .mockResolvedValue({ kind: "started", operation_id: "op-1" });
    const k = KINDS[0];
    const { dialog } = await open(k, mount({ retireThisDevice }));
    fireEvent.click(confirmOf(dialog, k));
    const corrected = await within(dialog).findByRole("button", {
      name: "Retire this device anyway →",
    });
    await setOnline(false);
    expect(
      within(dialog).getByRole("button", {
        name: "Retire this device anyway →",
      }),
    ).toBeDisabled();
    expect(corrected).not.toBeInTheDocument();
    await setOnline(true);
    expect(retireThisDevice).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Retire this device anyway →",
      }),
    );
    await waitFor(() => expect(retireThisDevice).toHaveBeenCalledTimes(2));
    expect(retireThisDevice).toHaveBeenLastCalledWith(
      expect.objectContaining({ unsynced: recount }),
    );
  });
});

describe("logging out stays possible offline (review r25 R25-N2: the online rule is retirement's only)", () => {
  test("RC12 Sessions & devices: offline, Log out is enabled and confirming it starts the logout", async () => {
    const session = await mount();
    await setOnline(false);
    const row = (await waitFor(() => {
      const r = document.querySelector("[data-session-row=current]");
      expect(r).not.toBeNull();
      return r;
    })) as HTMLElement;
    fireEvent.click(
      within(row).getByRole("button", { name: "Sign out of this browser" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Log out?" });
    const confirm = await within(dialog).findByRole("button", {
      name: "Log out",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(session.operations.logout).toHaveBeenCalledTimes(1),
    );
  });

  test("RC13 the account card: offline, Sign out's Log out is enabled and confirming it starts the logout", async () => {
    const session = await mount({}, "/settings");
    await setOnline(false);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    const dialog = await screen.findByRole("dialog", { name: "Log out?" });
    const confirm = await within(dialog).findByRole("button", {
      name: "Log out",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(session.operations.logout).toHaveBeenCalledTimes(1),
    );
  });
});
