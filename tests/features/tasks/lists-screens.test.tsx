import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import * as copy from "../../../src/features/tasks/copy";
import { DETAIL, LISTS } from "../../../src/features/tasks/lists/copy";
import { installMatchMedia } from "../../helpers/match-media";
import {
  forgetLists,
  listId,
  listRow,
  taskId,
  taskRow,
} from "../../support/tasks/lists";
import { mountTasks } from "../../support/tasks/world";

/**
 * WEB-10b L5/L8/L10/L12 (plan §4.1-4.3, 4.7): the Lists pane and the list detail in the app's router over the PRODUCTION data controller
 * and the IndexedDB double. FIXTURE evidence: nothing here talks to a backend.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetLists();
});
type Mounted = Awaited<ReturnType<typeof mountTasks>>;
/** The queued bodies of `kind`, in queue order. */
const bodyOf = (t: Mounted, kind: string) => {
  const bodies = new Map(
    t.bodies().map((b) => [b.local_id, b.command.command]),
  );
  return t
    .drafts()
    .map((d) => bodies.get(d.local_id))
    .filter((c): c is Record<string, unknown> => c?.kind === kind);
};
const h1 = () =>
  [...document.querySelectorAll("h1[data-page-heading]")].map(
    (h) => h.textContent,
  );
const paneReady = () => document.querySelector("[data-lists-pane]") !== null;
const detailReady = (id: string) => () =>
  document.querySelector(`[data-list-detail="${id}"]`) !== null;

describe("L5: the pane", () => {
  test("routes: /tasks/lists is the Lists pane under the Tasks destination, with its own h1; axe clean", async () => {
    const a = listId();
    const t = await mountTasks({
      path: "/tasks/lists",
      rows: [listRow(a, "Weekly groceries", [])],
    });
    await t.until(paneReady);
    expect(h1()).toEqual(["Lists"]);
    expect(t.router.state.location.pathname).toBe("/tasks/lists");
    expect(screen.getByRole("navigation", { name: "Lists" })).not.toBeNull();
    expect(
      screen.getByRole("link", { name: /Weekly groceries/ }),
    ).not.toBeNull();
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("lists by name on the page, a count per list (unparseable: unknown), the selected list current", async () => {
    const [a, b, c] = [listId(), listId(), listId()];
    const t = await mountTasks({
      path: `/tasks/lists/${b}`,
      rows: [
        listRow(a, "Zebra", [taskId(1), taskId(2)]),
        listRow(b, "apples", [taskId(1)]),
        listRow(c, "Mango", [], { value: { task_ids: "x" } as never }),
      ],
    });
    await t.until(paneReady);
    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>("[data-list-link]"),
    ];
    expect(links.map((l) => l.querySelector(".truncate")?.textContent)).toEqual(
      ["apples", "Mango", "Zebra"],
    );
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    expect(links[2]?.textContent).toContain(LISTS.count(2));
    expect(links[1]?.textContent).toContain(LISTS.countUnknown);
  });

  test("empty: the drawn copy and a centred New list; no database is empty too; the archived filter has its own empty", async () => {
    const t = await mountTasks({ path: "/tasks/lists", rows: [] });
    await t.until(paneReady);
    expect(screen.getByText(LISTS.empty)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: LISTS.newListEmpty }),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: LISTS.archivedFilter }),
    );
    await t.settle();
    expect(screen.getByText(LISTS.emptyArchived)).not.toBeNull();
    t.unmount();
    const none = await mountTasks({ path: "/tasks/lists", database: false });
    await none.until(paneReady);
    expect(screen.getByText(LISTS.empty)).not.toBeNull();
  });

  test("a page that holds only archived lists is not 'No lists yet'", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      rows: [listRow(listId(), "Old", [], { archived: true })],
    });
    await t.until(paneReady);
    expect(screen.queryByText(LISTS.empty)).toBeNull();
    expect(screen.getByText(LISTS.noneHere)).not.toBeNull();
  });

  test("more than 100 lists: a page of 100 by id, More lists and First page", async () => {
    const rows = Array.from({ length: 105 }, (_, i) =>
      listRow(
        `eeeeeeee-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        `List ${String(i + 1).padStart(3, "0")}`,
        [],
      ),
    );
    const t = await mountTasks({ path: "/tasks/lists", rows });
    await t.until(
      () => document.querySelectorAll("[data-list-link]").length === 100,
    );
    fireEvent.click(screen.getByRole("button", { name: LISTS.more }));
    await t.until(
      () => document.querySelectorAll("[data-list-link]").length === 5,
    );
    expect(screen.getByRole("link", { name: /List 105/ })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: LISTS.first }));
    await t.until(
      () => document.querySelectorAll("[data-list-link]").length === 100,
    );
  });

  test("a list created here and not received yet is listed first, marked Not sent yet (first page only)", async () => {
    const cached = listId();
    const t = await mountTasks({
      path: "/tasks/lists",
      rows: [listRow(cached, "Already here", [])],
      env: { online: false },
    });
    await t.until(paneReady);
    const { createList } = await import(
      "../../../src/features/tasks/model/lists"
    );
    const fresh = listId();
    await act(async () => {
      await t.data
        .outbox()
        ?.enqueue(
          createList({ listId: fresh, name: "Zzz made here", defaults: null }),
        );
    });
    await t.until(
      () => document.querySelector(`[data-list-link="${fresh}"]`) !== null,
    );
    const links = [...document.querySelectorAll("[data-list-link]")].map((l) =>
      l.getAttribute("data-list-link"),
    );
    expect(links).toEqual([fresh, cached]);
    expect(
      document.querySelector(`[data-list-link="${fresh}"]`)?.textContent,
    ).toContain(copy.PENDING.queued);
  });

  test("the Tasks pane links to the Lists", async () => {
    const t = await mountTasks({ path: "/tasks", rows: [] });
    await t.until(() => document.querySelector("[data-lists-link]") !== null);
    fireEvent.click(screen.getByRole("link", { name: "Lists" }));
    await t.until(paneReady);
    expect(t.router.state.location.pathname).toBe("/tasks/lists");
  });
});

describe("L8: the detail", () => {
  test("rows by title with links, the archived tag, a withheld row last (no link, Remove kept), the caption; axe clean", async () => {
    const id = listId();
    const [t1, t2, t3] = [taskId(11), taskId(12), taskId(13)];
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [
        listRow(id, "Weekly groceries", [t1, t2, t3]),
        taskRow(t1, "Buy bin bags"),
        taskRow(t2, "Apples", { archived: true }),
      ],
      env: { online: false },
    });
    await t.until(detailReady(id));
    expect(h1()).toEqual(["Weekly groceries"]);
    const rows = [...document.querySelectorAll("[data-list-row]")];
    expect(rows.map((r) => r.getAttribute("data-list-task"))).toEqual([
      t2,
      t1,
      t3,
    ]);
    expect(
      within(rows[0] as HTMLElement).getByText(DETAIL.archivedTask),
    ).not.toBeNull();
    const link = within(rows[1] as HTMLElement).getByRole("link");
    expect(link.getAttribute("href")).toBe(`/tasks/${t1}`);
    const withheld = rows[2] as HTMLElement;
    expect(withheld.getAttribute("data-list-row")).toBe("withheld");
    expect(within(withheld).queryByRole("link")).toBeNull();
    expect(withheld.textContent).toContain(DETAIL.withheld);
    expect(withheld.textContent).not.toContain(t3);
    expect(
      within(withheld).queryByRole("button", { name: DETAIL.removeWithheld }),
      "a withheld row keeps Remove",
    ).not.toBeNull();
    expect(screen.getByText(DETAIL.caption)).not.toBeNull();
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("Remove queues list_item included false at once; the row leaves and is announced", async () => {
    const id = listId();
    const t1 = taskId(21);
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Chores", [t1]), taskRow(t1, "Sweep")],
      env: { online: false },
    });
    await t.until(detailReady(id));
    fireEvent.click(
      screen.getByRole("button", { name: DETAIL.removeLabel("Sweep") }),
    );
    await t.until(() => document.querySelector("[data-list-row]") === null);
    expect(bodyOf(t, "list_item")).toEqual([
      {
        kind: "list_item",
        list_id: id,
        expected_version: 2,
        task_id: t1,
        included: false,
      },
    ]);
    expect(screen.getByText(DETAIL.empty)).not.toBeNull();
  });

  test("a read-only list: Rename, Add and Archive disabled with the reason; no Remove; nothing queued", async () => {
    const id = listId();
    const t1 = taskId(31);
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [
        listRow(id, "Theirs", [t1], { can_edit: false }),
        taskRow(t1, "Their task"),
      ],
    });
    await t.until(detailReady(id));
    for (const name of [DETAIL.rename, DETAIL.add, DETAIL.archive])
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    expect(screen.getAllByText(DETAIL.noEdit).length).toBeGreaterThanOrEqual(3);
    expect(
      screen.queryByRole("button", { name: DETAIL.removeLabel("Their task") }),
    ).toBeNull();
    expect(t.drafts()).toEqual([]);
  });

  test("absent only from a complete read; an unparseable value says so and keeps Rename/Archive", async () => {
    const gone = listId();
    const t = await mountTasks({ path: `/tasks/lists/${gone}`, rows: [] });
    await t.until(
      () => document.querySelector('[data-list-detail="absent"]') !== null,
    );
    expect(screen.getByText(DETAIL.absent)).not.toBeNull();
    t.unmount();
    const bad = listId();
    const u = await mountTasks({
      path: `/tasks/lists/${bad}`,
      rows: [listRow(bad, "Odd", [], { value: { task_ids: [1] } as never })],
    });
    await u.until(detailReady(bad));
    expect(screen.getByText(DETAIL.unreadable)).not.toBeNull();
    expect(screen.queryByRole("button", { name: DETAIL.add })).toBeNull();
    expect(
      (screen.getByRole("button", { name: DETAIL.rename }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: DETAIL.archive,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test("L10: 100 composed (99 cached + a queued add) disables Add with the drawn copy", async () => {
    const id = listId();
    const ids = Array.from({ length: 99 }, (_, i) => taskId(1000 + i));
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [
        listRow(id, "Full", ids),
        ...ids.map((x, i) => taskRow(x, `T${i}`)),
      ],
      env: { online: false },
    });
    await t.until(detailReady(id));
    expect(
      (screen.getByRole("button", { name: DETAIL.add }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("setup");
    const { listItem } = await import(
      "../../../src/features/tasks/model/lists"
    );
    await outbox.enqueue(
      listItem({ listId: id, taskId: taskId(2000), included: true }),
    );
    await t.until(
      () =>
        (
          screen.queryByRole("button", {
            name: DETAIL.add,
          }) as HTMLButtonElement | null
        )?.disabled === true,
    );
    expect(screen.getByText(DETAIL.atLimit)).not.toBeNull();
  });

  test("L12: Archive queues archive on the list; the archived note and Restore show; the pane filter follows", async () => {
    const id = listId();
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Seasonal", [])],
      env: { online: false },
    });
    await t.until(detailReady(id));
    fireEvent.click(screen.getByRole("button", { name: DETAIL.archive }));
    await t.until(
      () => screen.queryByRole("button", { name: DETAIL.restore }) !== null,
    );
    expect(bodyOf(t, "archive")).toEqual([
      { kind: "archive", id, expected_version: 2, archived: true },
    ]);
    expect(screen.getByText(DETAIL.archivedNote)).not.toBeNull();
    // The pane's active filter no longer lists it; the archived filter does.
    expect(document.querySelector(`[data-list-link="${id}"]`)).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: LISTS.archivedFilter }),
    );
    await t.until(
      () => document.querySelector(`[data-list-link="${id}"]`) !== null,
    );
    fireEvent.click(screen.getByRole("button", { name: DETAIL.restore }));
    await t.until(
      () => screen.queryByRole("button", { name: DETAIL.archive }) !== null,
    );
    expect(bodyOf(t, "archive").map((b) => b.archived)).toEqual([true, false]);
    expect(copy.PENDING.queued).toBe("Not sent yet");
  });
});
