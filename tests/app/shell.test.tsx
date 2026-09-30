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
import type { SyncStatusModel } from "../../src/lib/sync-chip";
import { installMatchMedia } from "../helpers/match-media";

afterEach(cleanup);

const model: SyncStatusModel = {
  phase: "synced",
  pendingCount: 2,
  conflictCount: 0,
};
const media = installMatchMedia({ width: 1440 });

async function mount(
  path = "/today",
  sync: SyncStatusModel = model,
  onOpenSync = vi.fn(),
) {
  const router = createAppRouter({ initialPath: path });
  const view = render(
    <ProtectedProviders>
      <ShellEnvProvider
        value={{
          syncModel: sync,
          onOpenSync,
          accountSlot: <span>Fixture account</span>,
        }}
      >
        <RouterProvider router={router} />
      </ShellEnvProvider>
    </ProtectedProviders>,
  );
  await screen.findByRole("main", { hidden: true });
  return { router, onOpenSync, ...view };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("layout modes render exactly one primary navigation", () => {
  test.each([
    [1440, "desktop"],
    [1280, "desktop"],
    [1279, "tablet"],
    [1180, "tablet"],
    [834, "tablet"],
    [768, "tablet"],
    [767, "mobile"],
    [390, "mobile"],
    [320, "mobile"],
  ])("%ipx is %s", async (width, _mode) => {
    media.set({ width });
    await mount();
    expect(screen.getAllByRole("navigation", { name: "Primary" })).toHaveLength(
      1,
    );
  });

  test("desktop shows the 236px rail with text labels in two groups", async () => {
    await mount();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const label of ["Today", "Tasks", "People", "Sharing", "Settings"]) {
      expect(within(nav).getByRole("link", { name: label })).toHaveTextContent(
        label,
      );
    }
    expect(nav.parentElement?.className).toContain("w-[236px]");
  });

  test("tablet shows the 64px icon rail: icon-only links with names and 44px targets", async () => {
    media.set({ width: 834 });
    await mount();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.parentElement?.className).toContain("w-16");
    for (const label of ["Today", "Tasks", "People", "Sharing", "Settings"]) {
      const link = within(nav).getByRole("link", { name: label });
      expect(link.textContent).toBe("");
      expect(link.className).toContain("size-11");
    }
  });

  test("mobile shows four bottom tabs (Today, Tasks, People, More) and the sync chip in the top bar", async () => {
    media.set({ width: 390 });
    await mount();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Today", "Tasks", "People"]);
    expect(within(nav).getByRole("button", { name: "More" })).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );
    expect(
      within(screen.getByRole("banner")).getByRole("button", {
        name: /Open sync queue/,
      }),
    ).toBeInTheDocument();
  });

  test("the layout follows the viewport when it changes, keeping the current route", async () => {
    await mount("/tasks");
    expect(
      screen.getByRole("heading", { level: 1, name: "Tasks" }),
    ).toBeInTheDocument();
    act(() => media.set({ width: 390 }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("navigation", { name: "Primary" })).queryByRole(
          "link",
          { name: "Sharing" },
        ),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Tasks" }),
    ).toBeInTheDocument();
  });
});

describe("navigation state is not colour alone (finding F6)", () => {
  test("the active destination carries aria-current, and the others do not", async () => {
    await mount("/tasks");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Tasks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(nav).getByRole("link", { name: "Today" }),
    ).not.toHaveAttribute("aria-current");
  });

  test("the active item has heavier weight and an accent bar", async () => {
    await mount("/tasks");
    const link = within(
      screen.getByRole("navigation", { name: "Primary" }),
    ).getByRole("link", { name: "Tasks" });
    expect(link.className).toContain("data-[status=active]:font-semibold");
    expect(link.querySelector(".bg-action-ink")).not.toBeNull();
  });

  test("a nested route keeps its parent destination active", async () => {
    await mount("/settings/appearance");
    // The dialog is open, so the page behind it is aria-hidden (as it should be).
    const nav = screen.getByRole("navigation", {
      name: "Primary",
      hidden: true,
    });
    expect(
      within(nav).getByRole("link", { name: "Settings", hidden: true }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("on mobile, More is marked active while a More destination is open", async () => {
    media.set({ width: 390 });
    await mount("/sharing");
    expect(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
        "button",
        { name: "More" },
      ),
    ).toHaveAttribute("data-active");
  });
});

describe("skip link, landmarks and focus", () => {
  test("the skip link is the first focusable element and moves focus to main", async () => {
    await mount();
    const first = document.body.querySelector<HTMLElement>(
      'a[href], button, [tabindex="0"]',
    );
    expect(first).toHaveTextContent("Skip to main content");
    fireEvent.click(screen.getByRole("link", { name: "Skip to main content" }));
    expect(screen.getByRole("main")).toHaveFocus();
  });

  test("main is the landmark and every page has exactly one h1", async () => {
    await mount("/people");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  test("an in-app navigation moves focus to the page heading, never to body", async () => {
    await mount();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
        "link",
        { name: "People" },
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "People" }),
      ).toHaveFocus(),
    );
  });

  test("the initial load does not steal focus", async () => {
    await mount();
    await act(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(undefined)),
      );
    });
    expect(document.body).toHaveFocus();
  });

  test("an unknown path renders the neutral not-found page inside the shell", async () => {
    await mount("/no/such/place");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Welcome to Atlas.")).toBeNull();
  });

  test("/ redirects to /today", async () => {
    const { router } = await mount("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/today"));
  });
});

describe("More sheet (mobile)", () => {
  test("opens a dialog listing Sharing, Settings and the offline queue, and Escape closes it", async () => {
    media.set({ width: 390 });
    const { onOpenSync } = await mount();
    const more = screen.getByRole("button", { name: "More" });
    fireEvent.click(more);
    const dialog = await screen.findByRole("dialog", { name: "More" });
    expect(
      within(dialog).getByRole("link", { name: "Sharing" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Fixture account")).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Offline queue" }),
    );
    expect(onOpenSync).toHaveBeenCalledWith("queue");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("Escape closes the sheet", async () => {
    media.set({ width: 390 });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const dialog = await screen.findByRole("dialog", { name: "More" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("choosing a destination navigates and closes the sheet", async () => {
    media.set({ width: 390 });
    const { router } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const dialog = await screen.findByRole("dialog", { name: "More" });
    fireEvent.click(within(dialog).getByRole("link", { name: "Sharing" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/sharing"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("the shell shows no account data", () => {
  test("placeholder destinations render only a heading and a neutral line", async () => {
    await mount("/today");
    const main = screen.getByRole("main");
    expect(main.textContent).toBe("TodayThis area arrives in a later release.");
  });
});

describe("accessibility (jsdom layer)", () => {
  test.each([
    [1440, "/today"],
    [834, "/today"],
    [390, "/today"],
    [1440, "/settings"],
    [1440, "/no/such/place"],
  ])("no axe violations at %ipx on %s", async (width, path) => {
    media.set({ width });
    const { container } = await mount(path);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe("shell slots", () => {
  async function mountWithSlot(
    slot: (state: { collapsed: boolean }) => React.ReactNode,
  ) {
    const router = createAppRouter({ initialPath: "/today" });
    render(
      <ProtectedProviders>
        <ShellEnvProvider
          value={{ syncModel: model, onOpenSync: vi.fn(), accountSlot: slot }}
        >
          <RouterProvider router={router} />
        </ShellEnvProvider>
      </ProtectedProviders>,
    );
    await screen.findByRole("main", { hidden: true });
  }
  const slot = ({ collapsed }: { collapsed: boolean }) =>
    collapsed ? (
      <span aria-label="Account (compact)" role="img">
        A
      </span>
    ) : (
      <span>Account (full)</span>
    );

  test("a function slot gets collapsed=false on the desktop rail", async () => {
    media.set({ width: 1440 });
    await mountWithSlot(slot);
    expect(screen.getByText("Account (full)")).toBeInTheDocument();
  });

  test("a function slot gets collapsed=true on the tablet icon rail, so it can render one compact control", async () => {
    media.set({ width: 834 });
    await mountWithSlot(slot);
    expect(
      screen.getByRole("img", { name: "Account (compact)" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Account (full)")).toBeNull();
  });

  test("the More sheet shows the full form", async () => {
    media.set({ width: 390 });
    await mountWithSlot(slot);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const dialog = await screen.findByRole("dialog", { name: "More" });
    expect(within(dialog).getByText("Account (full)")).toBeInTheDocument();
  });
});
