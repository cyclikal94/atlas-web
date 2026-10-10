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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createProtectedTree } from "../../src/app/protected-tree";
import { ProtectedProviders } from "../../src/app/providers";
import { createAppRouter } from "../../src/app/router";
import { ShellEnvProvider } from "../../src/app/shell/env";
import { DataEnvProvider } from "../../src/data";
import * as copy from "../../src/features/sync/copy";
import { installMatchMedia } from "../helpers/match-media";
import { sessionDouble } from "../helpers/session-double";
import { draftRow } from "../support/data/rows";
import { type StubEnv, stubEnv } from "../support/data/ui-env";

/**
 * The production wiring of the status model and the `/sync` route (plan 5.7, 6.1), through the REAL protected tree over a session
 * double, and the route and global notices over a hand-built data env. FIXTURE evidence: jsdom has no IndexedDB, so the lazily
 * loaded runtime never opens a database here, which is exactly the production state before a leader exists.
 */
afterEach(cleanup);
beforeEach(() => {
  document.body.innerHTML = "";
});
installMatchMedia({ width: 1440 });

describe("production wiring: no leader, no recovery, no database yet", () => {
  test("the chip reads 'Updates stopped' (never 'Up to date'), counts are zero, and the account slot is empty", async () => {
    render(createProtectedTree(sessionDouble())());
    const chip = await screen.findByRole("button", { name: /Open sync queue/ });
    expect(chip).toHaveTextContent("Updates stopped");
    expect(chip.getAttribute("aria-label")).toMatch(
      /^Updates stopped\. Open sync queue\.$/,
    );
    expect(document.body.textContent).not.toMatch(/Up to date/);
    expect(chip).toHaveAttribute("data-sync-tone", "warn");
  });

  test("the chip opens /sync, the Waiting-to-send panel; where the data layer cannot start (jsdom has no IndexedDB) it says so and never claims an empty queue it could not read", async () => {
    render(createProtectedTree(sessionDouble())());
    fireEvent.click(
      await screen.findByRole("button", { name: /Open sync queue/ }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: copy.PANEL_HEADING,
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText(copy.LOAD_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(copy.EMPTY_WAITING)).toBeNull();
    expect(
      screen.getByRole("button", { name: copy.LOAD_FAILED_ACTION }),
    ).toBeInTheDocument();
    // Updates have stopped: the panel's status line says so about the INBOUND axis only.
    expect(document.querySelector("[data-phase-label]")).toHaveTextContent(
      "Receiving updates: stopped",
    );
  });

  test("offline, the chip says Offline", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
    });
    try {
      render(createProtectedTree(sessionDouble())());
      expect(
        await screen.findByRole("button", { name: /Open sync queue/ }),
      ).toHaveTextContent("Offline");
    } finally {
      Object.defineProperty(window.navigator, "onLine", {
        value: true,
        configurable: true,
      });
    }
  });
});

function mountRoute(env: StubEnv, path = "/sync") {
  const router = createAppRouter({ initialPath: path });
  const view = render(
    <ProtectedProviders>
      <DataEnvProvider env={env}>
        <ShellEnvProvider
          value={{
            syncModel: {
              phase: "interrupted",
              pendingCount: 0,
              conflictCount: 0,
            },
            onOpenSync: () => undefined,
          }}
        >
          <RouterProvider router={router} />
        </ShellEnvProvider>
      </DataEnvProvider>
    </ProtectedProviders>,
  );
  return { router, ...view };
}

describe("the /sync route", () => {
  const drafts = () => [
    draftRow({ local_id: "a", created_seq: 1, status: "queued" }),
    draftRow({ local_id: "c", created_seq: 2, status: "version_conflict" }),
  ];

  test("?tab=queue (the default) shows Waiting to send; ?tab=conflicts shows Needs a decision; an unknown tab is the default", async () => {
    mountRoute(stubEnv({ drafts: drafts() }));
    expect(
      await screen.findByRole("tab", {
        selected: true,
        name: /Waiting to send/,
      }),
    ).toBeInTheDocument();
    cleanup();
    mountRoute(stubEnv({ drafts: drafts() }), "/sync?tab=conflicts");
    expect(
      await screen.findByRole("tab", {
        selected: true,
        name: /Needs a decision/,
      }),
    ).toBeInTheDocument();
    cleanup();
    mountRoute(stubEnv({ drafts: drafts() }), "/sync?tab=nonsense");
    expect(
      await screen.findByRole("tab", {
        selected: true,
        name: /Waiting to send/,
      }),
    ).toBeInTheDocument();
  });

  test("changing tab changes the URL and replaces the history entry", async () => {
    const { router } = mountRoute(stubEnv({ drafts: drafts() }));
    fireEvent.click(
      await screen.findByRole("tab", { name: /Needs a decision/ }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ tab: "conflicts" }),
    );
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Needs a decision",
    );
  });

  test("Close goes back to Today when there is no history to go back to", async () => {
    const { router } = mountRoute(stubEnv({ drafts: drafts() }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/today"));
  });

  test("the blocking notices are shown on every screen EXCEPT /sync, where the panel shows them itself (never twice)", async () => {
    const env = stubEnv({
      inputs: { engine: { kind: "stopped", cause: "local_storage" } },
    });
    mountRoute(env, "/today");
    expect(
      await screen.findByRole("heading", { name: copy.PAGE_NOT_SAVED_TITLE }),
    ).toBeInTheDocument();
    cleanup();
    mountRoute(env, "/sync");
    await screen.findByRole("heading", { level: 1, name: copy.PANEL_HEADING });
    expect(
      screen.getAllByRole("heading", { name: copy.PAGE_NOT_SAVED_TITLE }),
    ).toHaveLength(1);
  });

  test("the queue warning is the panel's alone: it is not drawn on other screens", async () => {
    const many = Array.from({ length: 214 }, (_, i) =>
      draftRow({ local_id: `n${i}`, created_seq: i + 1, status: "queued" }),
    );
    mountRoute(stubEnv({ drafts: many }), "/today");
    await screen.findByRole("main", { hidden: true });
    expect(
      screen.queryByRole("heading", { name: copy.QUEUE_WARNING_TITLE }),
    ).toBeNull();
    cleanup();
    mountRoute(stubEnv({ drafts: many }), "/sync");
    expect(
      await screen.findByRole("heading", { name: copy.QUEUE_WARNING_TITLE }),
    ).toBeInTheDocument();
  });

  test("no data layer mounted (the shell's own tests): the global notices render nothing and nothing throws", async () => {
    const router = createAppRouter({ initialPath: "/today" });
    render(
      <ProtectedProviders>
        <ShellEnvProvider
          value={{
            syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
            onOpenSync: () => undefined,
          }}
        >
          <RouterProvider router={router} />
        </ShellEnvProvider>
      </ProtectedProviders>,
    );
    expect(
      await screen.findByRole("main", { hidden: true }),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-notices]")).toBeNull();
  });

  test("a notice that appears while a screen is open is announced through the existing live regions, not a new one", async () => {
    const env = stubEnv();
    mountRoute(env, "/today");
    await screen.findByRole("main", { hidden: true });
    await act(async () => {
      env.set({ engine: { kind: "stopped", cause: "local_storage" } });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const live = [...document.querySelectorAll("[aria-live]")].map((e) =>
      e.getAttribute("aria-live"),
    );
    expect(live.sort()).toEqual(["assertive", "polite"]);
    const banner = document.querySelector(
      '[data-notice="page_not_saved"]',
    ) as HTMLElement;
    expect(
      within(banner).getByRole("button", { name: copy.PAGE_NOT_SAVED_ACTION }),
    ).toBeInTheDocument();
    expect(banner.closest("[aria-live]")).toBeNull();
  });
});
