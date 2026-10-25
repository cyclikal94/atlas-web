import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { StoreFailure } from "../../../src/data/store/port";
import * as copy from "../../../src/features/tasks/copy";
import { DETAIL, LISTS, PICKER } from "../../../src/features/tasks/lists/copy";
import { installMatchMedia } from "../../helpers/match-media";
import {
  forgetLists,
  listId,
  listRow,
  taskId,
  taskRow,
} from "../../support/tasks/lists";
import { type Mounted, mountTasks } from "../../support/tasks/world";

/**
 * WEB-10b L3/L5/L8/L18 (plan §3.3): the Lists screens read ONE certified composition of this device's data. A page committed between
 * two stages of a read is never shown mixed (the read is made again); a read that failed is never "none" or "not on this device"; a later
 * failure keeps the last complete read, marked stale. Placed by intercepting the store's own plans. FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetLists();
});

type Run = NonNullable<ReturnType<Mounted["data"]["service"]>>["store"]["run"];
/** Intercepts the store's plans: `around` may act before a plan runs, or fail it. */
function intercept(
  t: Mounted,
  around: (
    plan: string,
    input: Record<string, unknown>,
  ) => Promise<"fail" | undefined> | "fail" | undefined,
) {
  const service = t.data.service();
  if (service === null) throw new Error("no service");
  const store = service.store as { run: Run };
  const original = store.run.bind(service.store);
  store.run = (async (plan, input, options) => {
    if ((await around(plan.name, input as Record<string, unknown>)) === "fail")
      throw new StoreFailure("error");
    return original(plan, input, options);
  }) as Run;
  return () => {
    store.run = original;
  };
}
const ids = (input: Record<string, unknown>) =>
  (input.ids as string[] | undefined) ?? [];

describe("L3: the certificate", () => {
  test("a page committed between the list's read and its tasks' read is never shown mixed", async () => {
    const id = listId();
    const [t1, t2] = [taskId(301), taskId(302)];
    const t = await mountTasks({
      path: "/tasks/lists",
      rows: [listRow(id, "Mixed", [t1]), taskRow(t1, "Old member")],
    });
    await t.until(() => document.querySelector("[data-lists-pane]") !== null);
    // "before": reads pass; "committing": the commit's own store work passes; "held": the local basis and a new read of the list wait.
    let phase: "before" | "committing" | "held" = "before";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    intercept(t, async (plan, input) => {
      if (
        phase === "held" &&
        (plan === "data.readLocalBasis" ||
          (plan === "data.readResourcesById" && ids(input).includes(id)))
      ) {
        // The read that spanned the commit may finish its own stages, but neither its certificate nor a new read can: what the screen
        // shows meanwhile is whatever that read was allowed to make of the commit.
        await gate;
        return undefined;
      }
      // The detail's third stage: its members' rows. The list moved to t2 and t1 was removed, in ONE page, before it runs.
      if (
        phase === "before" &&
        plan === "data.readResourcesById" &&
        ids(input).includes(t1)
      ) {
        phase = "committing";
        const done = await t.commitNow(
          [
            listRow(id, "Mixed", [t2], { version: 3 }),
            taskRow(t2, "New member"),
          ],
          [t1],
        );
        expect(done, "the page was committed").toBe(true);
        phase = "held";
      }
      return undefined;
    });
    await act(async () => {
      await t.router.navigate({ to: `/tasks/lists/${id}` } as never);
    });
    await t.settle();
    await t.settle();
    expect(phase, "the commit was placed between the stages").toBe("held");
    // Uncertified, the read that spanned the commit would be shown: t1 named by the old list, its row gone, so a WITHHELD row.
    expect(document.querySelector('[data-list-row="withheld"]')).toBeNull();
    expect(document.querySelector(`[data-list-task="${t1}"]`)).toBeNull();
    await act(async () => {
      release();
    });
    await t.until(
      () => document.querySelector(`[data-list-task="${t2}"]`) !== null,
    );
    expect(screen.getByRole("link", { name: /New member/ })).not.toBeNull();
    expect(document.querySelector('[data-list-row="withheld"]')).toBeNull();
  });
});

describe("L8/L5: failed reads are not absence", () => {
  test("the detail: a failed first read is an error with Try again, never 'not on this device'; Try again reads again", async () => {
    const id = listId();
    const t = await mountTasks({
      path: "/tasks/lists",
      rows: [listRow(id, "Here", [])],
    });
    await t.until(() => document.querySelector("[data-lists-pane]") !== null);
    const restore = intercept(t, (plan, input) =>
      plan === "data.readResourcesById" && ids(input).includes(id)
        ? "fail"
        : undefined,
    );
    await act(async () => {
      await t.router.navigate({ to: `/tasks/lists/${id}` } as never);
    });
    await t.until(
      () => document.querySelector('[data-list-detail="error"]') !== null,
    );
    expect(screen.queryByText(DETAIL.absent)).toBeNull();
    expect(screen.getAllByText(copy.LOCAL_FAILED).length).toBeGreaterThan(0);
    restore();
    fireEvent.click(
      screen
        .getAllByRole("button", { name: copy.TRY_AGAIN })
        .at(-1) as HTMLElement,
    );
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
  });

  test("the detail: a later failure keeps the last complete read, marked stale", async () => {
    const id = listId();
    const t1 = taskId(311);
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Kept", [t1]), taskRow(t1, "Still shown")],
    });
    await t.until(
      () => document.querySelector(`[data-list-task="${t1}"]`) !== null,
    );
    intercept(t, (plan, input) =>
      plan === "data.readResourcesById" && ids(input).includes(id)
        ? "fail"
        : undefined,
    );
    await t.commitSync([taskRow(taskId(399), "Unrelated")]);
    await t.until(() => document.querySelector("[data-list-stale]") !== null);
    expect(screen.getByRole("link", { name: /Still shown/ })).not.toBeNull();
    expect(
      screen.getAllByText(new RegExp(copy.SHOWING_LAST_READ)).length,
    ).toBeGreaterThan(0);
  });

  test("the pane: a failed read is never 'No lists yet'", async () => {
    const t = await mountTasks({ path: "/tasks", rows: [] });
    await t.until(() => document.querySelector("[data-task-list]") !== null);
    intercept(t, (plan, input) =>
      plan === "data.readResourceList" && input.kind === "list"
        ? "fail"
        : undefined,
    );
    await act(async () => {
      await t.router.navigate({ to: "/tasks/lists" } as never);
    });
    await t.until(() => document.querySelector("[data-list-error]") !== null);
    expect(screen.queryByText(LISTS.empty)).toBeNull();
  });

  test("the picker: a failed read is not 'No tasks to add'", async () => {
    const id = listId();
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Pick", []), taskRow(taskId(321), "A task")],
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    intercept(t, (plan, input) =>
      plan === "data.readResourceList" && input.kind === "task"
        ? "fail"
        : undefined,
    );
    fireEvent.click(screen.getByRole("button", { name: DETAIL.add }));
    await t.until(
      () =>
        document.querySelector("[data-task-picker] [data-list-error]") !== null,
    );
    expect(screen.queryByText(PICKER.none)).toBeNull();
  });
});

describe("L18: identity", () => {
  test("another identity's screen reads afresh; nothing of the previous identity's composition is shown", async () => {
    const id = listId();
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Mine", [])],
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    const { tasksEnv } = await import("../../support/tasks/world");
    const restore = intercept(t, () => "fail");
    t.rerender(tasksEnv(t.api, { identity: "someone-else:1" }));
    await t.settle();
    expect(
      screen.queryByRole("heading", { level: 1, name: "Mine" }),
    ).toBeNull();
    restore();
  });
});
