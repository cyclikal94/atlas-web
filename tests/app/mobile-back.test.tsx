import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ProtectedProviders } from "../../src/app/providers";
import { AppShell } from "../../src/app/shell/AppShell";
import { installMatchMedia } from "../helpers/match-media";

afterEach(cleanup);
const media = installMatchMedia({ width: 390 });

/** Detail screens hide the tab bar and show a back affordance on mobile (WEB-07 AppShell contract). */
async function mount(mobileBack?: { label: string; to: string }) {
  const root = createRootRoute({
    component: () => (
      <AppShell
        syncModel={{ phase: "synced", pendingCount: 0, conflictCount: 0 }}
        onOpenSync={() => {}}
        mobileBack={mobileBack}
      >
        <h1 data-page-heading="">Detail</h1>
      </AppShell>
    ),
  });
  const index = createRoute({ getParentRoute: () => root, path: "/" });
  const list = createRoute({ getParentRoute: () => root, path: "list" });
  const router = createRouter({
    routeTree: root.addChildren([index, list]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <ProtectedProviders>
      <RouterProvider router={router} />
    </ProtectedProviders>,
  );
  await screen.findByRole("main");
}

describe("AppShell mobileBack", () => {
  test("without it the tab bar is present and there is no back link", async () => {
    await mount();
    expect(
      screen.getByRole("navigation", { name: "Primary" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Back to list/ })).toBeNull();
  });

  test("with it the tab bar is hidden and the top bar offers the back link and the sync chip", async () => {
    media.set({ width: 390 });
    await mount({ label: "Back to list", to: "/list" });
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    const banner = screen.getByRole("banner");
    expect(
      within(banner).getByRole("link", { name: "Back to list" }),
    ).toHaveAttribute("href", "/list");
    expect(
      within(banner).getByRole("button", { name: /Open sync queue/ }),
    ).toBeInTheDocument();
  });

  test("on desktop the back affordance is not used: the rail is always there", async () => {
    media.set({ width: 1440 });
    await mount({ label: "Back to list", to: "/list" });
    expect(
      screen.getByRole("navigation", { name: "Primary" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Back to list" })).toBeNull();
  });
});
