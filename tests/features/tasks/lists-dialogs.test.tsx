import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type {
  DraftRow,
  DraftWithCommand,
  EnqueueRequest,
} from "../../../src/data";
import {
  CREATE,
  DETAIL,
  NAME_PROBLEM,
  PICKER,
  RENAME,
} from "../../../src/features/tasks/lists/copy";
import { createTask } from "../../../src/features/tasks/model/commands";
import { createList, listItem } from "../../../src/features/tasks/model/lists";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  forgetLists,
  listId,
  listRow,
  taskId,
  taskRow,
} from "../../support/tasks/lists";
import {
  definition,
  ME,
  mountTasks,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * WEB-10b L6/L7/L9/L10/L16/L18 (plan §4.4-4.6): the create and rename dialogs and the task picker, in the app's router over the
 * PRODUCTION data controller, outbox and the IndexedDB double. A commit "in another tab" is made through the same store, placed by
 * intercepting the screen's own act. FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetLists();
});
type Mounted = Awaited<ReturnType<typeof mountTasks>>;

const bodies = (t: Mounted, kind?: string) => {
  const byId = new Map(t.bodies().map((b) => [b.local_id, b.command]));
  return t
    .drafts()
    .map((d) => ({
      draft: d,
      body: byId.get(d.local_id) as { command: Record<string, unknown> },
    }))
    .filter((x) => kind === undefined || x.body?.command.kind === kind);
};
function press(name: string, root: HTMLElement | Document = document) {
  const found = within(root as HTMLElement).queryAllByRole("button", {
    name,
  })[0];
  expect(found, `the button "${name}"`).toBeDefined();
  fireEvent.click(found as HTMLElement);
}
const dialog = () => screen.queryByRole("dialog") as HTMLElement | null;
const nameField = () =>
  within(dialog() as HTMLElement).getByLabelText(
    CREATE.name,
  ) as HTMLInputElement;
const typeName = (value: string) =>
  fireEvent.change(nameField(), { target: { value } });
async function toSyncByChip(t: Mounted) {
  const chip = within(dialog() as HTMLElement)
    .getAllByRole("button")
    .find((b) => b.hasAttribute("data-sync-tone"));
  expect(chip, "the in-dialog sync control").toBeDefined();
  await act(async () => {
    fireEvent.click(chip as HTMLElement);
    await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe("/sync");
}
async function back(t: Mounted, expected: string) {
  await act(async () => {
    t.router.history.back();
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe(expected);
}
function held<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
/** Wraps the outbox's enqueue: `before` runs first (another tab's commit, a hold), then the real enqueue unless it answers itself. */
function aroundEnqueue(
  t: Mounted,
  before: (request: EnqueueRequest, n: number) => Promise<unknown> | unknown,
) {
  const outbox = t.data.outbox();
  if (outbox === null) throw new Error("no outbox");
  const real = outbox.enqueue.bind(outbox);
  let n = 0;
  outbox.enqueue = async (request) => {
    n += 1;
    const answer = await before(request, n);
    if (answer !== undefined) return answer as Awaited<ReturnType<typeof real>>;
    return real(request);
  };
  return real;
}
const detailReady = (id: string) => () =>
  document.querySelector(`[data-list-detail="${id}"]`) !== null;

describe("L6: create", () => {
  test("offline, defaults never fetched: create_list queued for review, the app goes to the projected list, Sharing waits", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    await t.until(() => document.querySelector("[data-new-list]") !== null);
    press("+ New list");
    await t.settle();
    expect(nameField().getAttribute("placeholder")).toBe(CREATE.placeholder);
    expect(screen.getByText(CREATE.caption)).not.toBeNull();
    typeName("Weekend groceries");
    press(CREATE.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    const [created] = bodies(t, "create_list");
    const id = created?.body.command.id as string;
    expect(created?.body).toEqual({
      command: { kind: "create_list", id, name: "Weekend groceries" },
    });
    expect(created?.draft.review_block).toEqual({
      kind: "defaults",
      kinds: ["list"],
    });
    expect(t.router.state.location.pathname).toBe(`/tasks/lists/${id}`);
    await t.until(detailReady(id));
    expect(document.querySelector("[data-list-projected]")).not.toBeNull();
    expect(screen.getAllByText(/Not sent yet/).length).toBeGreaterThan(0);
    expect(screen.getByText(DETAIL.sharingWait)).not.toBeNull();
  });

  test("validation is the server's: blank and 301 code points are refused inline, the input kept, nothing queued", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    await t.until(() => document.querySelector("[data-new-list]") !== null);
    press("+ New list");
    await t.settle();
    typeName("\u0085 ");
    press(CREATE.submit, dialog() as HTMLElement);
    await t.settle();
    expect(screen.getByText(NAME_PROBLEM.blank)).not.toBeNull();
    typeName("😀".repeat(301));
    press(CREATE.submit, dialog() as HTMLElement);
    await t.settle();
    expect(screen.getByText(NAME_PROBLEM.too_long)).not.toBeNull();
    expect(nameField().value).toBe("😀".repeat(301));
    expect(t.drafts()).toEqual([]);
  });

  test("a save whose answer was lost is retried with the SAME list id and local id: one list", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    await t.until(() => document.querySelector("[data-new-list]") !== null);
    const asked: EnqueueRequest[] = [];
    const real = aroundEnqueue(t, async (request, n) => {
      asked.push(request);
      if (n === 1) {
        // The commit happened; the answer did not arrive.
        await real(request);
        throw new Error("lost");
      }
      return undefined;
    });
    press("+ New list");
    await t.settle();
    typeName("Chores");
    press(CREATE.submit, dialog() as HTMLElement);
    await t.settle();
    expect(dialog()).not.toBeNull();
    press(CREATE.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(asked).toHaveLength(2);
    expect(asked[1]?.localId).toBe(asked[0]?.localId);
    expect(bodies(t, "create_list")).toHaveLength(1);
  });

  test("kept through the in-dialog sync control and Back (raw); Escape discards; a reload-like forget drops it", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    await t.until(() => document.querySelector("[data-new-list]") !== null);
    press("+ New list");
    await t.settle();
    typeName("  half typed ");
    await toSyncByChip(t);
    await back(t, "/tasks/lists");
    await t.until(() => dialog() !== null);
    expect(
      dialog(),
      "the dialog is shown again with what was typed",
    ).not.toBeNull();
    expect(nameField().value).toBe("  half typed ");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await t.settle();
    expect(dialog()).toBeNull();
    press("+ New list");
    await t.settle();
    expect(nameField().value).toBe("");
    expect(t.drafts()).toEqual([]);
  });

  test("a save answered while the person is at the sync screens does not navigate; the session is consumed", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    await t.until(() => document.querySelector("[data-new-list]") !== null);
    const gate = held();
    aroundEnqueue(t, () => gate.promise);
    press("+ New list");
    await t.settle();
    typeName("Later");
    press(CREATE.submit, dialog() as HTMLElement);
    await t.settle();
    await toSyncByChip(t);
    await act(async () => {
      gate.resolve();
    });
    await t.settle();
    expect(t.router.state.location.pathname).toBe("/sync");
    expect(bodies(t, "create_list")).toHaveLength(1);
    await back(t, "/tasks/lists");
    expect(dialog()).toBeNull();
  });

  test("L18: another identity never sees the kept input", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    await t.until(() => document.querySelector("[data-new-list]") !== null);
    press("+ New list");
    await t.settle();
    typeName("Mine");
    await toSyncByChip(t);
    t.rerender(tasksEnv(t.api, { identity: `${ME}:2`, online: false }));
    await back(t, "/tasks/lists");
    expect(dialog()).toBeNull();
    press("+ New list");
    await t.settle();
    expect(nameField().value).toBe("");
  });
});

describe("L7: rename", () => {
  test("a cached list: edit_list with its policy version; Save only when the name changed", async () => {
    const id = listId();
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [
        listRow(id, "Weekly groceries", [], { policy_version: 4, version: 7 }),
      ],
      env: { online: false },
    });
    await t.until(detailReady(id));
    press(DETAIL.rename);
    await t.settle();
    expect(nameField().value).toBe("Weekly groceries");
    expect(screen.getByText(RENAME.unchanged)).not.toBeNull();
    typeName("Groceries");
    press(RENAME.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(bodies(t, "edit_list").map((x) => x.body.command)).toEqual([
      {
        kind: "edit_list",
        id,
        expected_version: 7,
        expected_policy_version: 4,
        name: "Groceries",
      },
    ]);
    await t.until(
      () =>
        screen.queryByRole("heading", { level: 1, name: "Groceries" }) !== null,
    );
  });

  test("a list whose create is still queued: the create is edited in place (one body, no edit_list)", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    const outbox = t.data.outbox();
    const id = listId();
    await act(async () => {
      await outbox?.enqueue(
        createList({ listId: id, name: "Old", defaults: null }),
      );
    });
    await act(async () => {
      await t.router.navigate({ to: `/tasks/lists/${id}` } as never);
    });
    await t.until(detailReady(id));
    press(DETAIL.rename);
    await t.settle();
    typeName("New");
    press(RENAME.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(bodies(t).map((x) => x.body.command)).toEqual([
      { kind: "create_list", id, name: "New" },
    ]);
    expect(t.drafts()[0]?.review_block).toEqual({
      kind: "defaults",
      kinds: ["list"],
    });
  });

  test("another tab edited the queued create since this dialog read it: draft_changed, the input kept, nothing overwritten", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("setup");
    const id = listId();
    await act(async () => {
      await outbox.enqueue(
        createList({ listId: id, name: "Old", defaults: null }),
      );
    });
    await act(async () => {
      await t.router.navigate({ to: `/tasks/lists/${id}` } as never);
    });
    await t.until(detailReady(id));
    const realEdit = outbox.editQueued.bind(outbox);
    outbox.editQueued = async (localId, request) => {
      // Another tab's rename lands first, in its own transaction.
      const { renameQueuedCreate } = await import(
        "../../../src/features/tasks/model/lists"
      );
      const header = t.drafts()[0];
      const body = t.bodies()[0];
      const other = renameQueuedCreate(
        { ...(header as DraftRow), command: body?.command } as DraftWithCommand,
        "Theirs",
      );
      if (other !== null) await realEdit(localId, other);
      return realEdit(localId, request);
    };
    press(DETAIL.rename);
    await t.settle();
    typeName("Mine");
    press(RENAME.submit, dialog() as HTMLElement);
    await t.settle();
    expect(
      within(dialog() as HTMLElement).getByText(RENAME.changedElsewhere),
    ).not.toBeNull();
    expect(nameField().value).toBe("Mine");
    expect(bodies(t).map((x) => x.body.command)).toEqual([
      { kind: "create_list", id, name: "Theirs" },
    ]);
  });

  test("another tab's edit of the queued create, already shown here before Save, is still not overwritten: refused once, input kept", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("setup");
    const id = listId();
    await act(async () => {
      await outbox.enqueue(
        createList({ listId: id, name: "Old", defaults: null }),
      );
    });
    await act(async () => {
      await t.router.navigate({ to: `/tasks/lists/${id}` } as never);
    });
    await t.until(detailReady(id));
    press(DETAIL.rename);
    await t.settle();
    typeName("Mine");
    const { renameQueuedCreate } = await import(
      "../../../src/features/tasks/model/lists"
    );
    const other = renameQueuedCreate(
      {
        ...(t.drafts()[0] as DraftRow),
        command: t.bodies()[0]?.command,
      } as DraftWithCommand,
      "Theirs",
    );
    await act(async () => {
      if (other !== null)
        await outbox.editQueued(t.drafts()[0]?.local_id as string, other);
    });
    await t.until(
      () =>
        screen.queryByRole("heading", { level: 1, name: "Theirs" }) !== null,
    );
    press(RENAME.submit, dialog() as HTMLElement);
    await t.settle();
    expect(
      within(dialog() as HTMLElement).getByText(RENAME.changedElsewhere),
    ).not.toBeNull();
    expect(nameField().value).toBe("Mine");
    expect(bodies(t).map((x) => x.body.command)).toEqual([
      { kind: "create_list", id, name: "Theirs" },
    ]);
    // Having been told, the person saves again: now it is their decision on what is there.
    press(RENAME.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(bodies(t).map((x) => x.body.command)).toEqual([
      { kind: "create_list", id, name: "Mine" },
    ]);
  });

  test("D-10b-8: a create already sent and the list not received: no policy version, Save says why", async () => {
    const id = listId();
    const command = createList({
      listId: id,
      name: "Sent",
      defaults: null,
    }).build({}).command;
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      env: { online: false },
      drafts: [
        draftRow({
          local_id: "f0000000-0000-4000-8000-000000000001",
          created_seq: 1,
          kind: "create_list",
          endpoint: "/task-commands",
          account_id: ME,
          status: "in_flight",
          attempts: 1,
          target_resource_ids: [id],
          index_targets: [id],
          bases: {},
          command: command as never,
        }),
      ],
    });
    await t.until(detailReady(id));
    press(DETAIL.rename);
    await t.settle();
    typeName("Too early");
    expect(
      within(dialog() as HTMLElement).getByText(RENAME.waitSync),
    ).not.toBeNull();
    expect(
      (
        within(dialog() as HTMLElement).getByRole("button", {
          name: RENAME.submit,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("a denial committed by another tab after the dialog was drawn is refused by the writing transaction; input kept", async () => {
    const id = listId();
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Shared", [])],
      env: { online: false },
    });
    await t.until(detailReady(id));
    aroundEnqueue(t, async () => {
      await t.commitNow([
        listRow(id, "Shared", [], { can_edit: false, version: 3 }),
      ]);
    });
    press(DETAIL.rename);
    await t.settle();
    typeName("Renamed");
    press(RENAME.submit, dialog() as HTMLElement);
    await t.settle();
    expect(t.drafts()).toEqual([]);
    expect(dialog()).not.toBeNull();
    expect(nameField().value).toBe("Renamed");
  });

  test("ticket acknowledgement: input typed after Save stays, with the note; the submitted name was queued", async () => {
    const id = listId();
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "A", [])],
      env: { online: false },
    });
    await t.until(detailReady(id));
    const gate = held();
    aroundEnqueue(t, () => gate.promise);
    press(DETAIL.rename);
    await t.settle();
    typeName("B");
    press(RENAME.submit, dialog() as HTMLElement);
    await t.settle();
    // The fieldset is disabled while saving; the session takes newer input through its editor.
    fireEvent.change(nameField(), { target: { value: "BC" } });
    await act(async () => {
      gate.resolve();
    });
    await t.settle();
    expect(bodies(t, "edit_list").map((x) => x.body.command.name)).toEqual([
      "B",
    ]);
    expect(dialog()).not.toBeNull();
    expect(nameField().value).toBe("BC");
    expect(
      within(dialog() as HTMLElement).getByText(RENAME.newer),
    ).not.toBeNull();
  });

  test("a list removed while the dialog is open: what was typed stays, nothing is saved", async () => {
    const id = listId();
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Gone soon", [])],
      env: { online: false },
    });
    await t.until(detailReady(id));
    press(DETAIL.rename);
    await t.settle();
    typeName("Still mine");
    await t.commitSync([], [id]);
    expect(dialog()).not.toBeNull();
    expect(nameField().value).toBe("Still mine");
    expect(
      within(dialog() as HTMLElement).getByText(RENAME.gone),
    ).not.toBeNull();
    expect(t.drafts()).toEqual([]);
  });
});

describe("L9: the picker", () => {
  async function pickerWorld(
    members: string[] = [],
    extra: ReturnType<typeof taskRow>[] = [],
  ) {
    const id = listId();
    const rows = [
      listRow(id, "Errands", members),
      taskRow(taskId(1), "Éclair shop"),
      taskRow(taskId(2), "Post office"),
      taskRow(taskId(3), "Old errand", { archived: true }),
      taskRow(taskId(4), "Bank"),
      ...extra,
    ];
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows,
      env: { online: false },
    });
    await t.until(detailReady(id));
    return { t, id };
  }
  const offered = () =>
    [...document.querySelectorAll("[data-picker-task]")].map((e) =>
      e.getAttribute("data-picker-task"),
    );
  const box = (id: string) =>
    document.querySelector(
      `[data-picker-task="${id}"] input`,
    ) as HTMLInputElement;

  test("source: cached tasks not archived, not members; a task not sent yet, marked; accent-insensitive search; the caption", async () => {
    const { t } = await pickerWorld([taskId(4)]);
    const outbox = t.data.outbox();
    await act(async () => {
      await outbox?.enqueue(
        createTask({
          taskId: taskId(9),
          executionId: taskId(90),
          occurrenceId: null,
          progressId: null,
          title: "Brand new",
          definition: definition({
            schedule: {
              start_date: "2999-01-01",
              time: null,
              timezone: "UTC",
              repeat: null,
            },
          }),
          sharing: "only_me",
          defaults: null,
        }),
      );
    });
    press(DETAIL.add);
    await t.until(() => offered().length > 0);
    expect(new Set(offered())).toEqual(
      new Set([taskId(9), taskId(1), taskId(2)]),
    );
    expect(
      within(
        document.querySelector(
          `[data-picker-task="${taskId(9)}"]`,
        ) as HTMLElement,
      ).getByText(PICKER.notSent),
    ).not.toBeNull();
    expect(screen.getByText(PICKER.caption)).not.toBeNull();
    fireEvent.change(screen.getByLabelText(PICKER.searchLabel), {
      target: { value: "ECLAIR" },
    });
    await t.until(() => offered().length === 1);
    expect(offered()).toEqual([taskId(1)]);
  });

  test("Add selected: one list_item per task, in the order selected, chained; the projected task's add waits for its create", async () => {
    const { t, id } = await pickerWorld();
    const outbox = t.data.outbox();
    let createLocal = "";
    await act(async () => {
      const out = await outbox?.enqueue(
        createTask({
          taskId: taskId(9),
          executionId: taskId(90),
          occurrenceId: null,
          progressId: null,
          title: "Brand new",
          definition: definition({
            schedule: {
              start_date: "2999-01-01",
              time: null,
              timezone: "UTC",
              repeat: null,
            },
          }),
          sharing: "only_me",
          defaults: null,
        }),
      );
      if (out?.kind === "queued") createLocal = out.localId;
    });
    press(DETAIL.add);
    await t.until(() => offered().length > 0);
    fireEvent.click(box(taskId(2)));
    fireEvent.click(box(taskId(9)));
    fireEvent.click(box(taskId(1)));
    expect(screen.getByText(PICKER.selected(3))).not.toBeNull();
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    const items = bodies(t, "list_item");
    expect(
      items.map((x) => [
        x.body.command.task_id,
        x.body.command.expected_version,
      ]),
    ).toEqual([
      [taskId(2), 2],
      [taskId(9), 3],
      [taskId(1), 4],
    ]);
    expect(items[1]?.draft.depends_on).toContain(createLocal);
    expect(items[1]?.draft.depends_on).toContain(items[0]?.draft.local_id);
    expect(items[0]?.draft.depends_on).not.toContain(createLocal);
    expect(items.every((x) => x.body.command.list_id === id)).toBe(true);
  });

  test("selection is capped by the room left; a selection hidden by the search stays selected and counted", async () => {
    const members = Array.from({ length: 98 }, (_, i) => taskId(500 + i));
    const { t } = await pickerWorld(
      members,
      members.map((m, i) => taskRow(m, `Member ${i}`)),
    );
    press(DETAIL.add);
    await t.until(() => offered().length > 0);
    expect(screen.getByText(PICKER.room(2))).not.toBeNull();
    fireEvent.click(box(taskId(1)));
    fireEvent.click(box(taskId(2)));
    expect(box(taskId(4)).disabled).toBe(true);
    expect(screen.getByText(PICKER.room(0))).not.toBeNull();
    fireEvent.change(screen.getByLabelText(PICKER.searchLabel), {
      target: { value: "bank" },
    });
    await t.until(() => offered().length === 1);
    expect(screen.getByText(PICKER.selected(2))).not.toBeNull();
  });

  test("the room is checked again at the act: another tab's add since leaves too little room; nothing is queued", async () => {
    const members = Array.from({ length: 98 }, (_, i) => taskId(500 + i));
    const { t, id } = await pickerWorld(
      members,
      members.map((m, i) => taskRow(m, `Member ${i}`)),
    );
    press(DETAIL.add);
    await t.until(() => offered().length > 0);
    fireEvent.click(box(taskId(1)));
    fireEvent.click(box(taskId(2)));
    const outbox = t.data.outbox();
    await act(async () => {
      await outbox?.enqueue(
        listItem({ listId: id, taskId: taskId(4), included: true }),
      );
    });
    await t.settle();
    press(PICKER.submit, dialog() as HTMLElement);
    await t.settle();
    expect(screen.getByText(PICKER.short(1))).not.toBeNull();
    expect(bodies(t, "list_item")).toHaveLength(1);
  });

  test("a partial save keeps the rest selected, with what happened; the retry reuses each task's local id", async () => {
    const { t } = await pickerWorld();
    const asked: Array<string | undefined> = [];
    aroundEnqueue(t, (request, n) => {
      asked.push(request.localId);
      return n === 2 ? { kind: "refused", reason: "quota" } : undefined;
    });
    press(DETAIL.add);
    await t.until(() => offered().length > 0);
    fireEvent.click(box(taskId(1)));
    fireEvent.click(box(taskId(2)));
    press(PICKER.submit, dialog() as HTMLElement);
    await t.settle();
    expect(dialog()).not.toBeNull();
    expect(
      screen.getByText(/Added 1 of 2\. The others weren't saved:/),
    ).not.toBeNull();
    expect(
      document
        .querySelector("[data-picker-selected]")
        ?.getAttribute("data-picker-selected"),
      "the task not saved stays selected (1 selected)",
    ).toBe("1");
    expect(bodies(t, "list_item")).toHaveLength(1);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(asked[2]).toBe(asked[1]);
    expect(bodies(t, "list_item")).toHaveLength(2);
  });

  test("kept through the in-dialog sync control: query and selection come back; Escape discards", async () => {
    const { t, id } = await pickerWorld();
    press(DETAIL.add);
    await t.until(() => offered().length > 0);
    fireEvent.click(box(taskId(2)));
    fireEvent.change(screen.getByLabelText(PICKER.searchLabel), {
      target: { value: "post" },
    });
    await toSyncByChip(t);
    await back(t, `/tasks/lists/${id}`);
    await t.until(() => dialog() !== null && offered().length > 0);
    expect(
      (screen.getByLabelText(PICKER.searchLabel) as HTMLInputElement).value,
    ).toBe("post");
    expect(box(taskId(2)).checked).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await t.settle();
    press(DETAIL.add);
    await t.until(() => offered().length > 0);
    expect(screen.getByText(PICKER.selected(0))).not.toBeNull();
  });
});

describe("L10: a capacity refusal", () => {
  test("a blocked add is not applied; the notice names the task and says the list's later changes wait", async () => {
    const id = listId();
    const command = listItem({
      listId: id,
      taskId: taskId(7),
      included: true,
    }).build({ [id]: 2 }).command;
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Full", []), taskRow(taskId(7), "Seventh")],
      drafts: [
        draftRow({
          local_id: "f0000000-0000-4000-8000-000000000002",
          created_seq: 1,
          kind: "list_item",
          endpoint: "/task-commands",
          account_id: ME,
          status: "blocked",
          blocked_reason: "slice_capacity",
          attempts: 1,
          target_resource_ids: [id],
          index_targets: [id],
          bases: { [id]: 2 },
          command: command as never,
        }),
      ],
    });
    await t.until(detailReady(id));
    expect(document.querySelector("[data-list-row]")).toBeNull();
    expect(screen.getByText(DETAIL.refused("Seventh"))).not.toBeNull();
    expect(
      within(document.querySelector("[data-list-refused]") as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("/sync?tab=conflicts");
  });
});
