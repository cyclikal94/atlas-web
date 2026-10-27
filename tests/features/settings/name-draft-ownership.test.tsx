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
 * WEB-08d review R6 (revision 8): a naming request owns only the draft it submitted. An edit accepted while the request is pending is
 * a later draft: the request's completion may update both lists, but it must not close the dialog over that edit, clear it, or send
 * it. Each answer is held at a deferred point, so the later edit is certainly accepted before the answer arrives.
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
const capacity = (used: number) => ({
  limit: 8,
  used,
  remaining: 8 - used,
});
const sessions = () =>
  ok({
    sessions: [sessionRow({ device_name: null })],
    session_capacity: capacity(1),
  });
const devices = () =>
  ok({
    devices: [
      deviceRow({ name: null }),
      deviceRow({
        id: "dev-2",
        current: false,
        client: { channel: "native", browser: null, platform: "ios" },
        name: "Kieran's phone",
        state_token: "tok-2",
        last_synced_at: "2026-09-30T09:00:00.000Z",
      }),
      deviceRow({
        id: "dev-3",
        current: false,
        client: { channel: "browser", browser: "firefox", platform: "windows" },
        name: null,
        state_token: "tok-3",
        active_sessions: 0,
        last_synced_at: null,
      }),
    ],
    sync_capacity: capacity(3),
  });

type Answer = Result<"named" | "cleared" | "gone">;
/** A naming operation whose answers are released one at a time, in order. */
function heldNaming() {
  const pending: Array<(answer: Answer) => void> = [];
  const nameDevice = vi.fn(
    () =>
      new Promise<Answer>((resolve) => {
        pending.push(resolve);
      }),
  );
  const release = async (answer: Answer) => {
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const next = pending.shift() as (answer: Answer) => void;
    await act(async () => next(answer));
  };
  return {
    nameDevice: nameDevice as unknown as Operations["nameDevice"],
    calls: nameDevice.mock.calls as unknown as Array<[string, string | null]>,
    release,
  };
}

const FIREFOX = "Name Firefox on Windows, never synced";
const PHONE = `Rename ${isolate("Kieran's phone")}, last synced 3 hours ago`;
const SAVED_KEPT =
  "The earlier name was saved. What you've typed since hasn't been saved yet.";
const REMOVED_KEPT =
  "The name was removed. What you've typed since hasn't been saved yet.";

async function open(nameDevice: Operations["nameDevice"], button = FIREFOX) {
  const listSessions = vi.fn(async () => sessions());
  const readDevices = vi.fn(async () => devices());
  const session = sessionDouble({ listSessions, readDevices, nameDevice });
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
  fireEvent.click(await screen.findByRole("button", { name: button }));
  const dialog = await screen.findByRole("dialog");
  const input = within(dialog).getByLabelText(
    "Device name",
  ) as HTMLInputElement;
  return {
    dialog,
    input,
    reads: () => ({
      devices: readDevices.mock.calls.length,
      sessions: listSessions.mock.calls.length,
    }),
  };
}

const type = (input: HTMLInputElement, value: string) =>
  fireEvent.change(input, { target: { value } });
const save = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
const polite = () =>
  document.querySelector("[aria-live=polite]")?.textContent ?? "";
const assertive = () =>
  document.querySelector("[aria-live=assertive]")?.textContent ?? "";
const busy = (dialog: HTMLElement) =>
  waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Save name" }),
    ).toBeDisabled(),
  );

describe("R6: a completed naming request owns only the draft it submitted", () => {
  test("control: an unchanged draft closes when its save completes, and both lists are read again", async () => {
    const naming = heldNaming();
    const { dialog, input, reads } = await open(naming.nameDevice);
    type(input, "Submitted name");
    save(dialog);
    await busy(dialog);
    const before = reads();
    await naming.release(ok("named"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(polite()).toBe("Name saved."));
    expect(naming.calls).toEqual([["dev-3", "Submitted name", WITHDRAW]]);
    await waitFor(() =>
      expect(reads()).toEqual({
        devices: before.devices + 1,
        sessions: before.sessions + 1,
      }),
    );
  });

  test("control: an unchanged Remove name closes when it completes", async () => {
    const naming = heldNaming();
    const { dialog } = await open(naming.nameDevice, PHONE);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove name" }),
    );
    await busy(dialog);
    await naming.release(ok("cleared"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(polite()).toBe("Name removed."));
    expect(naming.calls).toEqual([["dev-2", null, WITHDRAW]]);
  });

  test("a save that completes after a later edit keeps the dialog, the newer text and its focus; both lists are still read again", async () => {
    const naming = heldNaming();
    const { dialog, input, reads } = await open(naming.nameDevice);
    type(input, "Submitted name");
    save(dialog);
    await busy(dialog);
    input.focus();
    type(input, "Newer unsaved name");
    expect(input).toHaveValue("Newer unsaved name");
    const before = reads();
    await naming.release(ok("named"));
    // The earlier request's effect still reaches both lists.
    await waitFor(() =>
      expect(reads()).toEqual({
        devices: before.devices + 1,
        sessions: before.sessions + 1,
      }),
    );
    await waitFor(() => expect(polite()).toBe(SAVED_KEPT));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(input).toHaveValue("Newer unsaved name");
    expect(document.activeElement).toBe(input);
    expect(dialog.querySelector("[data-name-kept]")?.textContent).toBe(
      SAVED_KEPT,
    );
    expect(dialog.querySelector("[data-refusal]")).toBeNull();
    expect(assertive()).toBe("");
    // Only the submitted text was sent; the newer one waits for the person.
    expect(naming.calls).toEqual([["dev-3", "Submitted name", WITHDRAW]]);
    expect(
      within(dialog).getByRole("button", { name: "Save name" }),
    ).toBeEnabled();
    expect((await axe(document.body)).violations).toEqual([]);
    // A deliberate second save sends the newer text and, unchanged since, closes.
    save(dialog);
    await busy(dialog);
    await naming.release(ok("named"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(naming.calls).toEqual([
      ["dev-3", "Submitted name", WITHDRAW],
      ["dev-3", "Newer unsaved name", WITHDRAW],
    ]);
    await waitFor(() => expect(polite()).toBe("Name saved."));
  });

  test("an edit away and back is still a later draft: equal text is not proof that nothing was typed", async () => {
    const naming = heldNaming();
    const { dialog, input } = await open(naming.nameDevice);
    type(input, "Den");
    save(dialog);
    await busy(dialog);
    type(input, "Den PC");
    type(input, "Den");
    await naming.release(ok("named"));
    await waitFor(() => expect(polite()).toBe(SAVED_KEPT));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(input).toHaveValue("Den");
    expect(naming.calls).toHaveLength(1);
  });

  test("Remove name that completes after a later edit keeps the dialog and the typed text", async () => {
    const naming = heldNaming();
    const { dialog, input, reads } = await open(naming.nameDevice, PHONE);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove name" }),
    );
    await busy(dialog);
    input.focus();
    type(input, "Work phone");
    const before = reads();
    await naming.release(ok("cleared"));
    await waitFor(() =>
      expect(reads()).toEqual({
        devices: before.devices + 1,
        sessions: before.sessions + 1,
      }),
    );
    await waitFor(() => expect(polite()).toBe(REMOVED_KEPT));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(input).toHaveValue("Work phone");
    expect(document.activeElement).toBe(input);
    expect(naming.calls).toEqual([["dev-2", null, WITHDRAW]]);
  });

  test("a not_sent retry keeps the submitted payload although the field changed meanwhile, and the newer text stays", async () => {
    const naming = heldNaming();
    const { dialog, input } = await open(naming.nameDevice);
    type(input, "Submitted name");
    save(dialog);
    await busy(dialog);
    type(input, "Newer unsaved name");
    await naming.release({ ok: false, error: "not_sent" });
    await naming.release(ok("named"));
    await waitFor(() => expect(polite()).toBe(SAVED_KEPT));
    expect(naming.calls).toEqual([
      ["dev-3", "Submitted name", WITHDRAW],
      ["dev-3", "Submitted name", WITHDRAW],
    ]);
    expect(input).toHaveValue("Newer unsaved name");
  });

  test.each([
    [
      "a 422 refusal",
      {
        ok: false as const,
        error: "http" as const,
        status: 422,
      },
      "Atlas didn't accept that name. Check it and try again.",
    ],
    [
      "an unknown outcome",
      { ok: false as const, error: "offline" as const },
      "We couldn't confirm the change. The list has been refreshed — check it, and try again if needed.",
    ],
  ])(
    "%s after a later edit keeps the newer text with the existing message",
    async (_name, answer, text) => {
      const naming = heldNaming();
      const { dialog, input } = await open(naming.nameDevice);
      type(input, "Submitted name");
      save(dialog);
      await busy(dialog);
      type(input, "Newer unsaved name");
      await naming.release(answer);
      await waitFor(() =>
        expect(dialog.querySelector("[data-refusal]")?.textContent).toBe(text),
      );
      expect(input).toHaveValue("Newer unsaved name");
      expect(screen.getByRole("dialog")).toBe(dialog);
    },
  );

  test("gone after a later edit keeps the existing unavailable state", async () => {
    const naming = heldNaming();
    const { dialog, input } = await open(naming.nameDevice);
    type(input, "Submitted name");
    save(dialog);
    await busy(dialog);
    type(input, "Newer unsaved name");
    await naming.release(ok("gone"));
    expect(
      await within(dialog).findByText(
        "That device isn't listed any more, so its name wasn't changed.",
      ),
    ).toBeInTheDocument();
    expect(input).toHaveValue("Newer unsaved name");
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
  });

  test("dismissed after a later edit: nothing is said, and both lists are still read again", async () => {
    const naming = heldNaming();
    const { dialog, input, reads } = await open(naming.nameDevice);
    type(input, "Submitted name");
    save(dialog);
    await busy(dialog);
    type(input, "Newer unsaved name");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const before = reads();
    await naming.release(ok("named"));
    await waitFor(() =>
      expect(reads()).toEqual({
        devices: before.devices + 1,
        sessions: before.sessions + 1,
      }),
    );
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(polite()).toBe("");
    expect(assertive()).toBe("");
    expect(naming.calls).toHaveLength(1);
  });

  test.each(["auth_state", "closed"] as const)(
    "%s after a later edit: the identity moved on, nothing is said and the newer text is not touched",
    async (error) => {
      const naming = heldNaming();
      const { dialog, input } = await open(naming.nameDevice);
      type(input, "Submitted name");
      save(dialog);
      await busy(dialog);
      type(input, "Newer unsaved name");
      await naming.release({ ok: false, error });
      await waitFor(() =>
        expect(
          within(dialog).getByRole("button", { name: "Save name" }),
        ).toBeEnabled(),
      );
      expect(input).toHaveValue("Newer unsaved name");
      expect(polite()).toBe("");
      expect(assertive()).toBe("");
      expect(naming.calls).toHaveLength(1);
    },
  );
});
