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
  type TaskAttachment,
  useTaskAttachment,
  useTaskVisit,
} from "../../../src/features/tasks/visit";
import { createRouteChanges } from "../../../src/lib/route-changes";

/**
 * Revision 23 (Review 23 R35 and design assessment DA23; `task-sync-navigation-draft-loss`): an editor's ATTACHMENT to its visit, what may
 * act on the screen, over a real TanStack router with a BROWSER history in jsdom and the document's own route record (`createRouteChanges`
 * over `window`), as production composes them. A browser history moves the router at once and writes the document's address a microtask
 * later: an acknowledgement in between (N < A < D) must already find the attachment not presenting. A departure to the sync screens keeps
 * the visit but revokes the attachment for good: Back to the same address does not restore it (a new editor mounts a new one).
 */
afterEach(() => {
  cleanup();
  destroy?.();
  destroy = null;
  forgetTaskVisits();
  window.history.replaceState(null, "", "/");
});

let destroy: (() => void) | null = null;

async function mount(start: string) {
  window.history.replaceState(null, "", start);
  const changes = createRouteChanges(window);
  destroy = changes.destroy;
  observeTaskRoutes(changes);
  const attachments: TaskAttachment[] = [];
  /** Attaches as the mounted editor would, without its cleanup: an editor still mounted while the person goes away and back. */
  const lingering: { attach: (() => TaskAttachment | null) | null } = {
    attach: null,
  };
  function Editor() {
    const visitOf = useTaskVisit();
    const attachTo = useTaskAttachment();
    lingering.attach = () => attachTo(visitOf("person:1"));
    // biome-ignore lint/correctness/useExhaustiveDependencies: attached once as the editor opens
    useEffect(() => {
      const here = attachTo(visitOf("person:1"));
      if (here !== null) attachments.push(here);
      return () => here?.detach();
    }, []);
    return <p data-editor="">editor</p>;
  }
  const root = createRootRoute({ component: () => <Outlet /> });
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/a", component: Editor }),
    createRoute({
      getParentRoute: () => root,
      path: "/b",
      component: () => null,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/sync",
      component: () => null,
    }),
  ]);
  const router = createRouter({ routeTree, history: createBrowserHistory() });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  await act(async () => {
    await router.load();
  });
  expect(attachments, "the editor attached once").toHaveLength(1);
  return { router, attachments, lingering };
}

describe("an editor's attachment to its visit (what may act on the screen)", () => {
  test("presents at its own address, and through a change of only the query", async () => {
    const { router, attachments } = await mount("/a");
    const [here] = attachments as [TaskAttachment];
    expect(here.presents()).toBe(true);
    await act(async () => {
      await router.navigate({ to: "/a", search: { x: "1" } } as never);
    });
    expect(window.location.pathname).toBe("/a");
    expect(window.location.search, "the query changed").toContain("x=");
    expect(here.presents()).toBe(true);
  });

  for (const to of ["/b", "/sync"] as const)
    test(`a navigation to ${to}: not presenting from the moment the router moves, before the document's address is written`, async () => {
      const { router, attachments } = await mount("/a");
      const [here] = attachments as [TaskAttachment];
      let between: {
        router: string;
        document: string;
        presents: boolean;
      } | null = null;
      await act(async () => {
        void router.navigate({ to } as never);
        between = {
          router: router.history.location.pathname,
          document: window.location.pathname,
          presents: here.presents(),
        };
      });
      // The precondition: the router moved and the document had not yet (the browser history's queued write).
      expect(between).toEqual({ router: to, document: "/a", presents: false });
      expect(window.location.pathname).toBe(to);
      expect(here.presents()).toBe(false);
    });

  test("the sync screens and Back to the same address: the visit goes on, the old attachment never presents again", async () => {
    const { router, attachments, lingering } = await mount("/a");
    // An attachment whose editor's cleanup has not run (React had not removed it when the person came back).
    const old = lingering.attach?.() ?? null;
    expect(old?.presents(), "presents before the departure").toBe(true);
    await act(async () => {
      await router.navigate({ to: "/sync" } as never);
    });
    await act(async () => {
      router.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      await router.load();
    });
    expect(router.history.location.pathname).toBe("/a");
    expect(window.location.pathname).toBe("/a");
    expect(old?.presents(), "revoked by the departure").toBe(false);
    // Control: the editor mounted again on the same visit attaches anew, and that attachment presents.
    expect(attachments.length).toBeGreaterThanOrEqual(2);
    expect(attachments[attachments.length - 1]?.presents()).toBe(true);
    old?.detach();
  });

  test("detached (the editor leaves the screen): never presents again", async () => {
    const { attachments } = await mount("/a");
    const [here] = attachments as [TaskAttachment];
    here.detach();
    expect(here.presents()).toBe(false);
  });
});
