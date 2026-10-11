import { RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import { settingsSections } from "../../../src/features/settings/sections";
import { yourDataSlots } from "../../../src/features/settings/your-data/slots";
import { SessionProvider } from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import { sessionDouble } from "../../helpers/session-double";

installMatchMedia({ width: 1440 });
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

async function mount(path: string, pendingCount = 0) {
  const session = sessionDouble();
  const router = createAppRouter({ initialPath: path });
  render(
    <SessionProvider session={session}>
      <ProtectedProviders>
        <ShellEnvProvider
          value={{
            syncModel: { phase: "synced", pendingCount, conflictCount: 0 },
            onOpenSync: () => {},
          }}
        >
          <RouterProvider router={router} />
        </ShellEnvProvider>
      </ProtectedProviders>
    </SessionProvider>,
  );
  await screen.findByRole("main", { hidden: true });
  return { session, router };
}

describe("WF-SETTINGS-06 Your data (F-DATA)", () => {
  test("the copy is the wireframe's, word for word, and no ownership tag is rendered", async () => {
    await mount("/settings/data", 2);
    const main = screen.getByRole("main");
    expect(
      await within(main).findByRole("heading", { level: 1, name: "Your data" }),
    ).toBeInTheDocument();
    for (const text of [
      "What this device is holding",
      "A copy of what you can see",
      "So Atlas works without a connection",
      "Anything waiting to send",
      "2 items right now",
      "Your appearance choice",
      "This browser only",
      "Two things worth knowing",
      "If someone stops sharing something with you, this device clears it the next time it connects — not the moment they change it.",
      "Something you recorded and haven't sent yet is never removed by that. Your own work is yours.",
      "Things Atlas can't do yet",
      "There's no download-my-data button in this release — exports are run by an administrator for the whole system. There's no clear-local-data button either; retiring this device in Sessions & devices is the nearest thing.",
      "If you connect a calendar, its address and password stay with you — they're never shared or synced to other devices.",
    ])
      expect(within(main).getByText(text)).toBeInTheDocument();
    expect(main.textContent).not.toMatch(/owner:|WEB-0|WEB-1/);
  });

  test("the pending count is the shell's, in the singular for one", async () => {
    await mount("/settings/data", 1);
    expect(await screen.findByText("1 item right now")).toBeInTheDocument();
  });

  test("the calendar line is a named slot that another slice replaces", async () => {
    const original = yourDataSlots.calendarLine;
    yourDataSlots.calendarLine = "A different line.";
    try {
      await mount("/settings/data");
      const slot = await screen.findByText("A different line.");
      expect(slot).toHaveAttribute("data-slot", "calendarLine");
    } finally {
      yourDataSlots.calendarLine = original;
    }
  });

  test("it makes no request", async () => {
    const { session } = await mount("/settings/data");
    await screen.findByRole("heading", { level: 1, name: "Your data" });
    for (const fn of Object.values(session.operations))
      if (typeof fn === "function" && "mock" in fn)
        expect((fn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  test("axe finds nothing", async () => {
    await mount("/settings/data", 3);
    await screen.findByRole("heading", { level: 1, name: "Your data" });
    expect((await axe(document.body)).violations).toEqual([]);
  });
});

describe("the Settings registry (F-REG)", () => {
  test("Signing in, Sessions & devices and Your data are registered by WEB-08, Appearance by WEB-07, in order", () => {
    expect(
      settingsSections().map((s) => [s.id, s.label, s.owner, s.route]),
    ).toEqual([
      ["signing-in", "Signing in", "WEB-08", "signing-in"],
      ["sessions", "Sessions & devices", "WEB-08", "sessions"],
      ["appearance", "Appearance", "WEB-07", "appearance"],
      ["data", "Your data", "WEB-08", "data"],
    ]);
    const orders = settingsSections().map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    // A calendar section (WEB-13a) sorts between Sessions and Appearance or after Your data without editing the list.
    expect(new Set(orders).size).toBe(orders.length);
  });

  test("the home list renders exactly the registry, each link named by its label alone", async () => {
    await mount("/settings");
    const main = await screen.findByRole("main");
    const links = within(main).getAllByRole("link");
    expect(
      links.map((link) => link.getAttribute("data-settings-link")),
    ).toEqual(settingsSections().map((s) => s.id));
    for (const section of settingsSections())
      expect(
        within(main).getByRole("link", { name: section.label }),
      ).toHaveAccessibleDescription(section.description);
  });

  test("every registered section has a working route", async () => {
    for (const section of settingsSections()) {
      cleanup();
      await mount(`/settings/${section.route}`);
      if (section.id === "appearance" || section.id === "signing-in")
        expect(
          await screen.findByRole("dialog", { name: section.label }),
        ).toBeInTheDocument();
      else
        expect(
          await screen.findByRole("heading", {
            level: 1,
            name: section.label,
          }),
        ).toBeInTheDocument();
    }
  });

  test("the home list is not drawn beside a page section, and is drawn behind a dialog section", async () => {
    await mount("/settings/data");
    await screen.findByRole("heading", { level: 1, name: "Your data" });
    expect(screen.queryByRole("link", { name: "Appearance" })).toBeNull();
    cleanup();
    await mount("/settings/appearance");
    await screen.findByRole("dialog", { name: "Appearance" });
    expect(document.querySelectorAll("[data-settings-link]")).toHaveLength(
      settingsSections().length,
    );
  });
});
