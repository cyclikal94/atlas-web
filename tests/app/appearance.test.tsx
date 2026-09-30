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
import { ProtectedProviders } from "../../src/app/providers";
import { createAppRouter } from "../../src/app/router";
import { ShellEnvProvider } from "../../src/app/shell/env";
import { APPEARANCE_STORAGE_KEY } from "../../src/design/theme";
import { installMatchMedia } from "../helpers/match-media";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  // Radix returns focus from a timer after a dialog unmounts. Let it run against the old DOM, not the next test's.
  await new Promise((resolve) => setTimeout(resolve, 0));
});
const media = installMatchMedia({ width: 1440 });

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = '<meta name="theme-color" content="#08090A">';
});

async function mount(path: string) {
  const router = createAppRouter({ initialPath: path });
  render(
    <ProtectedProviders>
      <ShellEnvProvider
        value={{
          syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
          onOpenSync: () => {},
        }}
      >
        <RouterProvider router={router} />
      </ShellEnvProvider>
    </ProtectedProviders>,
  );
  await screen.findByRole("main", { hidden: true });
  return router;
}

async function open(path = "/settings/appearance") {
  const router = await mount(path);
  return {
    router,
    dialog: await screen.findByRole("dialog", { name: "Appearance" }),
  };
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("WF-SETTINGS-05 Appearance", () => {
  test("opens over Settings with Match system selected by default", async () => {
    await open();
    expect(radio("Match system")).toBeChecked();
    expect(radio("Dark")).not.toBeChecked();
    expect(radio("Light")).not.toBeChecked();
    expect(
      screen.getByRole("radiogroup", { name: "Theme" }),
    ).toBeInTheDocument();
  });

  test("focus starts on the selected choice, not on the header chrome", async () => {
    await open();
    await waitFor(() => expect(radio("Match system")).toHaveFocus());
  });

  test("choosing Light applies immediately and persists on this device", async () => {
    await open();
    fireEvent.click(radio("Light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(
      document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute("content"),
    ).toBe("#F7F8F9");
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(radio("Light")).toBeChecked();
  });

  test("choosing Dark overrides a light device", async () => {
    media.set({ prefersLight: true });
    await open();
    fireEvent.click(radio("Dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
  });

  test("choosing Match system clears the override and follows the device again", async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, "dark");
    await open();
    expect(radio("Dark")).toBeChecked();
    fireEvent.click(radio("Match system"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
  });

  test("Auto follows a change of the device preference while the dialog is open", async () => {
    await open();
    act(() => media.set({ prefersLight: true }));
    await waitFor(() =>
      expect(
        document
          .querySelector('meta[name="theme-color"]')
          ?.getAttribute("content"),
      ).toBe("#F7F8F9"),
    );
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("another tab changing the choice is picked up", async () => {
    await open();
    localStorage.setItem(APPEARANCE_STORAGE_KEY, "light");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: APPEARANCE_STORAGE_KEY,
          newValue: "light",
        }),
      );
    });
    await waitFor(() => expect(radio("Light")).toBeChecked());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  test("when storage is unavailable the choice still applies, and the dialog says it will not last", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    await open();
    expect(screen.queryByText(/can't save your choice/)).toBeNull();
    fireEvent.click(radio("Light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(
      await screen.findByText(
        "This browser can't save your choice, so it will reset when you reload.",
      ),
    ).toBeInTheDocument();
  });

  test("uses the accepted copy and not the designer's annotation (finding F7)", async () => {
    const { dialog } = await open();
    expect(
      within(dialog).getByText(
        "Saved for this browser only, so a shared computer doesn't inherit your choice.",
      ),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(
      /replaces the|dark mode is deferred|variable swap/i,
    );
  });

  test("Escape closes to /settings", async () => {
    const { router, dialog } = await open();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("the in-dialog sync control and the close icon are inside the dialog", async () => {
    const { dialog } = await open();
    expect(
      within(dialog).getByRole("button", { name: /Open sync queue/ }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
  });

  test("closing after opening from the Settings link returns focus to that link", async () => {
    const router = await mount("/settings");
    fireEvent.click(screen.getByRole("link", { name: "Appearance" }));
    const dialog = await screen.findByRole("dialog", { name: "Appearance" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings"),
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Appearance" })).toHaveFocus(),
    );
  });

  test("closing after a cold load of the deep link, with no opener, focuses the page heading", async () => {
    const { router, dialog } = await open("/settings/appearance");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Settings" }),
      ).toHaveFocus(),
    );
  });

  test("has no axe violations, dark and light", async () => {
    await open();
    expect((await axe(document.body)).violations).toEqual([]);
    fireEvent.click(radio("Light"));
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("Settings home lists only Appearance and does not pull in account or calendar settings", async () => {
    await mount("/settings");
    const main = screen.getByRole("main");
    expect(within(main).getAllByRole("link")).toHaveLength(1);
    expect(main.textContent).not.toMatch(/export|calendar|account/i);
  });
});
