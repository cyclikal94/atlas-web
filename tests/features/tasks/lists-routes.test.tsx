import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { StoreFailure } from "../../../src/data/store/port";
import * as copy from "../../../src/features/tasks/copy";
import { DETAIL } from "../../../src/features/tasks/lists/copy";
import { installMatchMedia } from "../../helpers/match-media";
import { forgetLists, listId, listRow } from "../../support/tasks/lists";
import { mountTasks, seededTask } from "../../support/tasks/world";

/**
 * WEB-10b D-10b-1 (plan §5 step 1, R2): the Lists routes are a root-level branch whose static `tasks/lists` segment outranks
 * `/tasks/$taskId`, under the Tasks destination, and their heading is the route's, outside the cache gate and the lazy screens (WEB-10a
 * revision 2): one h1 in every gate state. The task routes are unchanged. FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetLists();
});
const h1 = () =>
  [...document.querySelectorAll("h1[data-page-heading]")].map(
    (h) => h.textContent,
  );
const leaf = (t: Awaited<ReturnType<typeof mountTasks>>) =>
  t.router.state.matches.map((m) => m.routeId);

describe("D-10b-1: the Lists routes", () => {
  test("/tasks/lists and /tasks/lists/<id> match the lists branch; the task routes still match theirs", async () => {
    const id = listId();
    const task = await seededTask({ title: "A task" });
    const cases: Array<[string, string]> = [
      ["/tasks/lists", "/tasks/lists/"],
      [`/tasks/lists/${id}`, "/tasks/lists/$listId"],
      ["/tasks", "/tasks/"],
      ["/tasks/new", "/tasks/new"],
      [`/tasks/${task.taskId}`, "/tasks/$taskId/"],
      [`/tasks/${task.taskId}/edit`, "/tasks/$taskId/edit"],
    ];
    for (const [path, routeId] of cases) {
      const t = await mountTasks({
        path,
        rows: [...task.rows, listRow(id, "L", [])],
      });
      expect(leaf(t), path).toContain(routeId);
      expect(t.router.state.location.pathname).toBe(path);
      t.unmount();
      forgetLists();
    }
  });

  test("one h1 while the gate hides the pane and once it shows; a list's page has its own h1, and the pane's while gated", async () => {
    const id = listId();
    const gated = await mountTasks({
      path: "/tasks/lists",
      cacheStatus: "invalid",
    });
    await gated.settle();
    expect(document.querySelector("[data-cache-gate]")).not.toBeNull();
    expect(h1()).toEqual(["Lists"]);
    gated.unmount();
    const gatedDetail = await mountTasks({
      path: `/tasks/lists/${id}`,
      cacheStatus: "invalid",
    });
    await gatedDetail.settle();
    expect(document.querySelector("[data-cache-gate]")).not.toBeNull();
    expect(h1()).toEqual(["Lists"]);
    gatedDetail.unmount();
    const pane = await mountTasks({
      path: "/tasks/lists",
      rows: [listRow(id, "Groceries", [])],
    });
    await pane.until(
      () => document.querySelector("[data-lists-pane]") !== null,
    );
    expect(h1()).toEqual(["Lists"]);
    pane.unmount();
    const detail = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Groceries", [])],
    });
    await detail.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    expect(h1()).toEqual(["Groceries"]);
  });

  test("R4: one h1 in the detail's absent, loading and failed states; the same element once the list is read", async () => {
    const absent = await mountTasks({
      path: `/tasks/lists/${listId()}`,
      rows: [],
    });
    await absent.until(
      () => document.querySelector('[data-list-detail="absent"]') !== null,
    );
    expect(h1()).toEqual(["Lists"]);
    absent.unmount();
    forgetLists();

    const id = listId();
    const t = await mountTasks({
      path: "/tasks/lists",
      rows: [listRow(id, "Groceries", [])],
    });
    await t.until(() => document.querySelector("[data-lists-pane]") !== null);
    // The detail's first read is held (loading), then failed until Try again (error), then let through.
    let mode: "hold" | "fail" | "pass" = "hold";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = t.data.service()?.store as {
      run: (...args: unknown[]) => Promise<unknown>;
    };
    const original = store.run.bind(store);
    store.run = async (...args: unknown[]) => {
      const [plan, input] = args as [
        { name: string },
        { ids?: string[] } | undefined,
      ];
      if (
        plan.name === "data.readResourcesById" &&
        (input?.ids ?? []).includes(id)
      ) {
        if (mode === "hold") await gate;
        if (mode === "fail") throw new StoreFailure("error");
      }
      return original(...args);
    };
    await act(async () => {
      await t.router.navigate({ to: `/tasks/lists/${id}` } as never);
    });
    await t.until(() => document.querySelector("[data-list-loading]") !== null);
    expect(h1()).toEqual(["Lists"]);
    expect(
      document.querySelector("[data-list-detail]"),
      "no list id while loading",
    ).toBeNull();
    const loading = document.querySelector("h1[data-page-heading]");
    mode = "fail";
    await act(async () => {
      release();
    });
    await t.until(
      () => document.querySelector('[data-list-detail="error"]') !== null,
    );
    expect(h1()).toEqual(["Lists"]);
    expect(
      document.querySelector("h1[data-page-heading]"),
      "the same heading element",
    ).toBe(loading);
    mode = "pass";
    fireEvent.click(
      screen
        .getAllByRole("button", { name: copy.TRY_AGAIN })
        .at(-1) as HTMLElement,
    );
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    expect(h1()).toEqual(["Groceries"]);
    expect(
      document.querySelector("h1[data-page-heading]"),
      "still the same element: a focus given to it stays",
    ).toBe(loading);
  });

  test("the document title and destination are Lists (its own destination in the Final design)", async () => {
    const t = await mountTasks({ path: "/tasks/lists", rows: [] });
    await t.until(() => document.querySelector("[data-lists-pane]") !== null);
    const { destinationFor } = await import(
      "../../../src/app/shell/destinations"
    );
    expect(destinationFor("/tasks/lists")?.label).toBe("Lists");
    expect(destinationFor(`/tasks/lists/${listId()}`)?.label).toBe("Lists");
  });
});

describe("L13: Sharing on a list (WEB-12a's editor, consumed)", () => {
  test("a synced list opens the shared policy editor, which reads THIS list's policy", async () => {
    const id = listId();
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Shared", [])],
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    fireEvent.click(screen.getByRole("button", { name: DETAIL.sharing }));
    await t.until(() => t.sharing.calls.some((c) => c.op === "readPolicy"));
    expect(screen.queryByRole("dialog"), "the sharing editor").not.toBeNull();
    expect(
      t.sharing.calls
        .filter((c) => c.op === "readPolicy")
        .map((c) => c.args[0]),
    ).toEqual([id]);
  });

  test("a list known only through its queued create cannot be shared yet, and says why", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    const { createList } = await import(
      "../../../src/features/tasks/model/lists"
    );
    const { act } = await import("@testing-library/react");
    const fresh = listId();
    await act(async () => {
      await t.data
        .outbox()
        ?.enqueue(
          createList({ listId: fresh, name: "Unsent", defaults: null }),
        );
    });
    await act(async () => {
      await t.router.navigate({ to: `/tasks/lists/${fresh}` } as never);
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${fresh}"]`) !== null,
    );
    const sharing = screen.queryByRole("button", {
      name: DETAIL.sharing,
    }) as HTMLButtonElement | null;
    expect(sharing?.disabled, "Sharing is withheld").toBe(true);
    expect(screen.queryByText(DETAIL.sharingWait)).not.toBeNull();
    expect(t.sharing.calls.some((c) => c.op === "readPolicy")).toBe(false);
  });
});
