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
import { SessionProvider } from "../../src/session";
import { installMatchMedia } from "../helpers/match-media";
import { sessionDouble } from "../helpers/session-double";

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
  document.head.innerHTML = '<meta name="theme-color" content="#0C0C10">';
});

async function mount(path: string) {
  const router = createAppRouter({ initialPath: path });
  render(
    <SessionProvider session={sessionDouble()}>
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
  await screen.findByRole("main", { hidden: true });
  return router;
}

// Appearance is a page of its own (8 November 2026: every Settings section opens the same way), not a dialog over the home.
async function open(path = "/settings/appearance") {
  const router = await mount(path);
  await screen.findByRole("heading", { level: 1, name: "Appearance" });
  return { router, page: screen.getByRole("main") };
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("WF-SETTINGS-05 Appearance", () => {
  test("opens as a page with Match system selected by default", async () => {
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
    ).toBe("#F7F7FA");
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

  test("Auto follows a change of the device preference while the page is open", async () => {
    await open();
    act(() => media.set({ prefersLight: true }));
    await waitFor(() =>
      expect(
        document
          .querySelector('meta[name="theme-color"]')
          ?.getAttribute("content"),
      ).toBe("#F7F7FA"),
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

  test("when storage is unavailable the choice still applies, and the page says it will not last", async () => {
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
    const { page } = await open();
    expect(
      within(page).getByText(
        "Saved for this browser only, so a shared computer doesn't inherit your choice.",
      ),
    ).toBeInTheDocument();
    expect(page.textContent).not.toMatch(
      /replaces the|dark mode is deferred|variable swap/i,
    );
  });

  test("the Settings link leads back to the home, where the Appearance row is", async () => {
    const { router, page } = await open();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(page).getByRole("link", { name: "Settings" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings"),
    );
    expect(
      await screen.findByRole("link", { name: "Appearance" }),
    ).toBeInTheDocument();
  });

  test("from the Settings home the Appearance row opens the page, which is a page like the other sections", async () => {
    const router = await mount("/settings");
    fireEvent.click(screen.getByRole("link", { name: "Appearance" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/appearance"),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Appearance" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The home list has given way to the page (as Layout and Sessions do), not stayed behind it.
    expect(screen.queryByRole("link", { name: "Layout" })).toBeNull();
  });

  test("has no axe violations, dark and light", async () => {
    await open();
    expect((await axe(document.body)).violations).toEqual([]);
    fireEvent.click(radio("Light"));
    expect((await axe(document.body)).violations).toEqual([]);
  });

  // WEB-08a: the home list is the registry (src/features/settings/sections.ts). WEB-07's placeholder listed Appearance
  // alone; WEB-08a adds Sessions & devices and Your data, and still no calendar (WEB-13a's entry) or export.
  // ADAPTED BY WEB-13a (labelled for the reviewer): the original asserted three links and no "calendar" anywhere, because the
  // calendar entry was WEB-13a's to add. WEB-13a appends exactly that ONE registry entry ("Calendars", owner WEB-13), so the same
  // Combined with WEB-11a (and Settings · Layout, the Final design): seven links, calendar settings reached ONLY through that entry,
  // and still no export settings.
  test("Settings home lists the registered sections and does not pull in calendar or export settings", async () => {
    await mount("/settings");
    const main = screen.getByRole("main");
    expect(
      within(main)
        .getAllByRole("link")
        .map((link) => link.textContent?.split(/(?<=[a-z])(?=[A-Z])/)[0]),
    ).toHaveLength(7); // Signing in, Sessions & devices, Appearance, Layout, Calendars, Your data, Archived items.
    expect(
      within(main).getByRole("link", { name: "Appearance" }),
    ).toBeInTheDocument();
    const calendars = within(main).getByRole("link", { name: "Calendars" });
    expect(calendars).toHaveAttribute("data-settings-link", "calendars");
    expect(main.textContent).not.toMatch(/export/i);
    expect(
      (main.textContent ?? "").replace(calendars.textContent ?? "", ""),
    ).not.toMatch(/calendar/i);
  });
});
