import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  forgetTaskVisits,
  observeTaskRoutes,
  useTaskRouteMoved,
  useTaskScreenAt,
} from "../../../src/features/tasks/visit";
import { createRouteChanges } from "../../../src/lib/route-changes";

/**
 * Revision 24 (R36): an editor React never removed asks, as the person moves, whether they are at its address again by its router, its
 * history and the document (`useTaskScreenAt`), and is told to ask by `useTaskRouteMoved`. Over a real TanStack router with a BROWSER
 * history in jsdom and the document's own route record (`createRouteChanges` over `window`), as production composes them: a push tells the
 * router's listeners before the document's address is written (a microtask later), Back is recorded by the document before the router hears
 * it. Whichever comes last, the editor must be told at a moment when all three are at its address; while the person is elsewhere, never.
 */
afterEach(() => {
  cleanup();
  destroy?.();
  destroy = null;
  forgetTaskVisits();
  window.history.replaceState(null, "", "/");
});

let destroy: (() => void) | null = null;

async function mount() {
  window.history.replaceState(null, "", "/a");
  const changes = createRouteChanges(window);
  destroy = changes.destroy;
  observeTaskRoutes(changes);
  // Every time the editor is told, whether the person was at its address then.
  const told: boolean[] = [];
  function Editor() {
    const onMoved = useTaskRouteMoved();
    const shownAt = useTaskScreenAt();
    // biome-ignore lint/correctness/useExhaustiveDependencies: subscribed once as the editor opens
    useEffect(() => onMoved(() => told.push(shownAt("/a"))), []);
    return <p data-editor="">editor</p>;
  }
  // The editor stays mounted whatever the address (React never removed it): it is the root's.
  const root = createRootRoute({
    component: () => (
      <>
        <Editor />
        <Outlet />
      </>
    ),
  });
  const routeTree = root.addChildren(
    ["/a", "/b", "/sync"].map((path) =>
      createRoute({ getParentRoute: () => root, path, component: () => null }),
    ),
  );
  const router = createRouter({ routeTree, history: createBrowserHistory() });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  await act(async () => {
    await router.load();
  });
  return { router, told };
}

async function settled(ready: () => boolean) {
  for (let i = 0; i < 50 && !ready(); i += 1)
    await act(async () => new Promise((r) => setTimeout(r, 0)));
  expect(ready(), "the move completed").toBe(true);
}

describe("R36: an editor is told when the person is at its address again", () => {
  for (const away of ["/b", "/sync"] as const)
    test(`a push to ${away} (never at the address), then a push back: told at a moment all three are there`, async () => {
      const { router, told } = await mount();
      await act(async () => {
        await router.navigate({ to: away } as never);
      });
      await settled(() => window.location.pathname === away);
      expect(told.length, "told of the departure").toBeGreaterThan(0);
      expect(told.some(Boolean), "never at the address while away").toBe(false);
      told.length = 0;
      await act(async () => {
        await router.navigate({ to: "/a" } as never);
      });
      await settled(() => window.location.pathname === "/a");
      expect(told.some(Boolean), "told once the person is there").toBe(true);
    });

  test("a push to /b, then Back: told at a moment all three are there", async () => {
    const { router, told } = await mount();
    await act(async () => {
      await router.navigate({ to: "/b" } as never);
    });
    await settled(() => window.location.pathname === "/b");
    told.length = 0;
    await act(async () => {
      window.history.back();
    });
    await settled(
      () =>
        window.location.pathname === "/a" &&
        router.history.location.pathname === "/a" &&
        router.latestLocation.pathname === "/a",
    );
    expect(told.some(Boolean), "told once the person is there").toBe(true);
  });
});
