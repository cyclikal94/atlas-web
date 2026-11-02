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
import { afterEach, describe, expect, test } from "vitest";
import { ProtectedProviders } from "../../src/app/providers";
import { createAppRouter } from "../../src/app/router";
import { ShellEnvProvider } from "../../src/app/shell/env";
import { pageFormRegistry } from "../../src/lib/form-recovery/registry";
import { onNavigation } from "../../src/lib/pwa/navigation";
import { appUpdates } from "../../src/lib/pwa/store";
import { AVAILABLE_TEXT } from "../../src/lib/pwa/UpdateBanner";
import { SessionProvider } from "../../src/session";
import { installMatchMedia } from "../helpers/match-media";
import { sessionDouble } from "../helpers/session-double";
import { FakeOrigin, type Tab } from "../pwa/coordinator-world";

/**
 * WEB-14a revision 19, R26/R27 at the production composition (design assessment C3, I1/I2/I4, Q3/Q9, S10): the app's router, its root
 * layout (`RouteFocus`, `NavigationSignal`), the real coordinator over the registration double and the shell's banner. After an in-app
 * navigation RouteFocus focuses the destination's heading in the next frame as a FALLBACK: a state-1 prompt that the navigation brings
 * back (a recoverable form is open) keeps its "Save and reload" focus, a field focused before the frame keeps it, and a dialog route
 * entered before the frame keeps its own focus. A plain notice brought back leaves the route's heading focus alone (R24 unchanged).
 */
installMatchMedia({ width: 1440 });

let tabs: Tab[] = [];
let offForm: (() => void) | null = null;
afterEach(() => {
  cleanup();
  for (const tab of tabs) tab.coordinator?.dispose();
  tabs = [];
  offForm?.();
  offForm = null;
  appUpdates.set({ kind: "none" });
});

async function mount(path = "/today") {
  const router = createAppRouter({ initialPath: path });
  const view = render(
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
  return { router, ...view };
}

async function available(): Promise<Tab> {
  const origin = new FakeOrigin();
  const tab = origin.tab();
  tabs.push(tab);
  await act(async () => {
    await tab.start({
      onNavigation,
      publish: (state, actions) => appUpdates.set(state, actions),
    });
    await origin.installNew(2);
  });
  return tab;
}

/** Two animation frames: RouteFocus's frame has run. */
const frames = () =>
  act(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

const region = () =>
  screen.queryByRole("region", { name: "Update", hidden: true });
const heading = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const primary = () => screen.getByRole("navigation", { name: "Primary" });

describe("R26/R27: RouteFocus is a fallback after a navigation", () => {
  test("control: with nothing else placing focus, the destination's heading is focused", async () => {
    await mount("/today");
    fireEvent.click(within(primary()).getByRole("link", { name: "Tasks" }));
    const tasks = await heading("Tasks");
    await frames();
    expect(tasks).toHaveFocus();
  });

  test("a form is open: the navigation brings the dismissed state-1 prompt back and 'Save and reload' keeps focus over the route's heading", async () => {
    offForm = pageFormRegistry.register({
      formContext: "SENTINEL-CONTEXT",
      isDirty: () => true,
      flush: async () => "saved",
    });
    await mount("/today");
    const tab = await available();
    await waitFor(() => expect(region()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(region()).toBeNull());
    fireEvent.click(within(primary()).getByRole("link", { name: "Tasks" }));
    await heading("Tasks");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save and reload" }),
      ).toBeInTheDocument(),
    );
    await frames();
    expect(
      screen.getByRole("button", { name: "Save and reload" }),
      "Approved Q4 state 1 primary action focus when the prompt appears again",
    ).toHaveFocus();
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "available", dismissed: false });
  });

  test("control: no form open, the plain notice comes back and the destination's heading still gets focus", async () => {
    await mount("/today");
    await available();
    await waitFor(() =>
      expect(
        within(region() as HTMLElement).getByText(AVAILABLE_TEXT),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(region()).toBeNull());
    fireEvent.click(within(primary()).getByRole("link", { name: "People" }));
    const people = await heading("People");
    await waitFor(() => expect(region()).not.toBeNull());
    await frames();
    expect(people).toHaveFocus();
  });

  test("a field focused after the navigation resolved and before the frame keeps focus", async () => {
    const { router } = await mount("/today");
    const field = document.body.appendChild(document.createElement("input"));
    await act(async () => {
      await router.navigate({ to: "/tasks" });
    });
    field.focus();
    await frames();
    expect(field).toHaveFocus();
    field.remove();
  });

  test("a dialog route entered before the previous navigation's frame keeps its own focus", async () => {
    const { router } = await mount("/today");
    await act(async () => {
      await router.navigate({ to: "/settings" });
      router.history.push("/settings/appearance");
    });
    const dialog = await screen.findByRole("dialog");
    await frames();
    await frames();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
