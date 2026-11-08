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
import { StrictMode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { ProtectedProviders } from "../../src/app/providers";
import { createAppRouter } from "../../src/app/router";
import { ShellEnvProvider } from "../../src/app/shell/env";
import { FLUSH_START_GRACE_MS } from "../../src/lib/pwa/coordinator";
import { onNavigation } from "../../src/lib/pwa/navigation";
import { appUpdates } from "../../src/lib/pwa/store";
import { AVAILABLE_TEXT, ELSEWHERE_TEXT } from "../../src/lib/pwa/UpdateBanner";
import { SessionProvider } from "../../src/session";
import { installMatchMedia } from "../helpers/match-media";
import { sessionDouble } from "../helpers/session-double";
import { FakeOrigin, type Tab } from "../pwa/coordinator-world";

/**
 * Revision 17 (R24; WEB-04 wireframe 6): a dismissed update banner reappears on the next natural navigation. The production composition:
 * the app's router (`createAppRouter`, its root layout and `NavigationSignal`), the page's navigation signal, the real coordinator (over
 * the registration double) and the shell's banner through the update store. Each test counts the signals the router raised, so a
 * negative control fails on an unwanted signal and not only on what the banner shows.
 */
installMatchMedia({ width: 1440 });

let tabs: Tab[] = [];
afterEach(() => {
  cleanup();
  for (const tab of tabs) tab.coordinator?.dispose();
  tabs = [];
  appUpdates.set({ kind: "none" });
});

const signals = (): { count: number; stop: () => void } => {
  const counter = { count: 0, stop: () => {} };
  counter.stop = onNavigation(() => {
    counter.count += 1;
  });
  return counter;
};

async function mount(path = "/today", strict = false) {
  const router = createAppRouter({ initialPath: path });
  const tree = (
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
    </SessionProvider>
  );
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  await screen.findByRole("main", { hidden: true });
  return { router, ...view };
}

/** The page's coordinator, composed as `start.ts` does: the real navigation signal and the real store. */
async function coordinator(origin = new FakeOrigin()): Promise<Tab> {
  const tab = origin.tab();
  tabs.push(tab);
  await act(async () => {
    await tab.start({
      onNavigation,
      publish: (state, actions) => appUpdates.set(state, actions),
    });
  });
  return tab;
}

/** The banner showing `text` (not the announcement of it), or null; behind a dialog route's modal too (it hides the rest from AT). */
const banner = (text: string): HTMLElement | null => {
  const region = screen.queryByRole("region", { name: "Update", hidden: true });
  return region && within(region).queryByText(text) ? region : null;
};
const shown = (text: string, name?: string) =>
  waitFor(() => expect(banner(text), name).not.toBeNull());

async function available(): Promise<{ origin: FakeOrigin; tab: Tab }> {
  const origin = new FakeOrigin();
  const tab = await coordinator(origin);
  await act(async () => {
    await origin.installNew(2);
  });
  await shown(AVAILABLE_TEXT);
  return { origin, tab };
}

async function dismiss(text = AVAILABLE_TEXT): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(banner(text)).toBeNull());
}

const primary = () => screen.getByRole("navigation", { name: "Primary" });

describe("a dismissed update banner comes back on the next in-app navigation (R24)", () => {
  test("a link: the destination renders and the banner is back; without a navigation it stays dismissed", async () => {
    const counter = signals();
    const { router } = await mount("/today");
    expect(counter.count).toBe(0);
    const { tab } = await available();
    await dismiss();
    // The negative controls: a rerender of the shell, a reload of the same location and the update store's other news restore nothing.
    await act(async () => {
      await router.invalidate();
    });
    await act(async () => {
      await router.navigate({ to: "/today" });
    });
    expect(counter.count).toBe(0);
    expect(banner(AVAILABLE_TEXT)).toBeNull();
    expect(tab.state).toEqual({ kind: "available", dismissed: true });
    fireEvent.click(within(primary()).getByRole("link", { name: "Tasks" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Tasks" }),
    ).toBeInTheDocument();
    await shown(AVAILABLE_TEXT);
    expect(counter.count).toBe(1);
    expect(tab.reloads).toBe(0);
    counter.stop();
  });

  test("a programmatic navigation, a history step, a search or hash change and a dialog route all count", async () => {
    const counter = signals();
    const { router } = await mount("/settings");
    await available();
    const steps: Array<[string, () => Promise<unknown>, string]> = [
      ["programmatic", () => router.navigate({ to: "/people" }), "/people"],
      ["back", async () => router.history.back(), "/settings"],
      ["forward", async () => router.history.forward(), "/people"],
      [
        "search",
        async () => router.history.push("/people?view=all"),
        "/people",
      ],
      [
        "hash",
        async () => router.history.push("/people?view=all#top"),
        "/people",
      ],
      [
        // A dialog route below Settings (built outside the typed tree, so reached through the router's history).
        "dialog route",
        async () => router.history.push("/settings/appearance"),
        "/settings/appearance",
      ],
    ];
    let expected = 0;
    for (const [name, step, path] of steps) {
      await dismiss();
      await act(async () => {
        await step();
      });
      expected += 1;
      await waitFor(() => expect(router.state.location.pathname).toBe(path));
      await waitFor(() => expect(counter.count, name).toBe(expected));
      await shown(AVAILABLE_TEXT, name);
    }
    counter.stop();
  });

  test("updated in another tab: this tab's navigation brings it back, and this tab does not reload", async () => {
    await mount("/today");
    const origin = new FakeOrigin();
    const acting = origin.tab();
    await acting.start();
    const tab = await coordinator(origin);
    let waiting = null as Awaited<ReturnType<FakeOrigin["installNew"]>> | null;
    await act(async () => {
      waiting = await origin.installNew(2);
      acting.actions?.accept();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
      if (waiting) await origin.activate(waiting);
    });
    expect(acting.reloads).toBe(1);
    await shown(ELSEWHERE_TEXT);
    await dismiss(ELSEWHERE_TEXT);
    // The other tab's navigation is not this one's.
    act(() => acting.navigate());
    expect(banner(ELSEWHERE_TEXT)).toBeNull();
    fireEvent.click(within(primary()).getByRole("link", { name: "People" }));
    await shown(ELSEWHERE_TEXT);
    expect(tab.reloads).toBe(0);
  });

  test("a dismissal after the destination rendered stands until the next navigation", async () => {
    const counter = signals();
    const { router } = await mount("/today");
    await available();
    await act(async () => {
      await router.navigate({ to: "/tasks" });
    });
    expect(counter.count).toBe(1);
    await dismiss();
    expect(counter.count).toBe(1);
    expect(banner(AVAILABLE_TEXT)).toBeNull();
    await act(async () => {
      await router.navigate({ to: "/people" });
    });
    await shown(AVAILABLE_TEXT);
    counter.stop();
  });

  test("a navigation replaced before it rendered is not told; the one that rendered is, once", async () => {
    const counter = signals();
    const { router } = await mount("/today");
    await act(async () => {
      void router.navigate({ to: "/people" });
      await router.navigate({ to: "/tasks" });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/tasks"));
    expect(counter.count).toBe(1);
    counter.stop();
  });

  test("StrictMode and a new tree: one signal per navigation, none for a first load", async () => {
    const counter = signals();
    const first = await mount("/today", true);
    expect(counter.count).toBe(0);
    await act(async () => {
      await first.router.navigate({ to: "/tasks" });
    });
    expect(counter.count).toBe(1);
    // An account change mounts a new tree with a new router: its first load is not a navigation, and the old router is unheard.
    first.unmount();
    const second = await mount("/people");
    expect(counter.count).toBe(1);
    await act(async () => {
      await second.router.navigate({ to: "/today" });
    });
    expect(counter.count).toBe(2);
    counter.stop();
  });
});
