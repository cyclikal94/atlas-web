import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { EnqueueRequest } from "../../../src/data";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import {
  CREATE,
  DETAIL,
  PICKER,
  RENAME,
} from "../../../src/features/tasks/lists/copy";
import {
  listFormContext,
  listPickerContext,
  newListFormContext,
} from "../../../src/features/tasks/model/lists";
import { RESTORED_TEXT } from "../../../src/lib/form-recovery/RecoveryBanner";
import {
  flushDirty,
  pageFormRegistry,
} from "../../../src/lib/form-recovery/registry";
import { installMatchMedia } from "../../helpers/match-media";
import {
  contextsOf,
  forgetRecoveryWorld,
  installRecoveryLocks,
} from "../../support/recovery-editors";
import { SLOW } from "../../support/tasks/journal";
import {
  forgetLists,
  listId,
  listRow,
  taskId,
  taskRow,
} from "../../support/tasks/lists";
import { mountTasks } from "../../support/tasks/world";

/**
 * WEB-14a revision 38 (design assessment DA-R40-D, `incomplete_fix` of R40; C5, I1, I2, I7, I10, I11; Q5/Q6): the merged Lists dialogs
 * (WEB-10b) take part in app-update recovery. Over the app's router, the PRODUCTION data controller and form-recovery port (IndexedDB
 * double) and the page's real registry: typed input makes each dialog a dirty registered form; the update's save writes only the raw
 * input (no ids, no attempt); after a reload the SCREEN (the Lists pane, the list's detail) finds the copy and opens its dialog on it,
 * restored and never saved; a later explicit Save is a new save with the ids and admission of now. A partial add settles the remaining
 * selection into the recoverable model in the same transition. Cancel discards the copies. FIXTURE evidence (jsdom).
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
afterEach(() => {
  forgetRecoveryWorld();
  forgetLists();
});
type Mounted = Awaited<ReturnType<typeof mountTasks>>;

const dialog = () => screen.queryByRole("dialog") as HTMLElement | null;
const nameField = () =>
  within(dialog() as HTMLElement).getByLabelText(
    CREATE.name,
  ) as HTMLInputElement;
function press(name: string, root: HTMLElement | Document = document) {
  const found = within(root as HTMLElement).queryAllByRole("button", {
    name,
  })[0];
  expect(found, `the button "${name}"`).toBeDefined();
  fireEvent.click(found as HTMLElement);
}
const bodies = (t: Mounted, kind: string) => {
  const byId = new Map(t.bodies().map((b) => [b.local_id, b.command]));
  return t
    .drafts()
    .map((d) => byId.get(d.local_id) as { command: Record<string, unknown> })
    .filter((body) => body?.command.kind === kind)
    .map((body) => body.command);
};
async function copies(t: Mounted, context: string): Promise<unknown[]> {
  return (await t.data.formRecovery.list(context)).map((copy) =>
    JSON.parse(copy.values.model ?? "null"),
  );
}
/** The page reloads onto the update: page memory (sessions, models) is gone; the tree mounts again where it was. */
async function reload(t: Mounted): Promise<void> {
  act(() => forgetKept());
  t.remount();
  await t.settle();
}
const detailReady = (id: string) => () =>
  document.querySelector(`[data-list-detail="${id}"]`) !== null;

describe("create (CreateListDialog, opened again by the Lists pane)", () => {
  const CONTEXT = newListFormContext("dialog");

  test(
    "typed name: a dirty registered form; the update saves the raw name only; after the reload the pane opens the dialog on it, never saved",
    SLOW,
    async () => {
      const t = await mountTasks({ path: "/tasks/lists" });
      await t.until(() => document.querySelector("[data-new-list]") !== null);
      press("+ New list");
      await t.settle();
      expect(contextsOf(pageFormRegistry.all())).toContain(CONTEXT);
      expect(contextsOf(pageFormRegistry.dirty())).not.toContain(CONTEXT);
      fireEvent.change(nameField(), { target: { value: "Weekend groceries" } });
      expect(contextsOf(pageFormRegistry.dirty())).toContain(CONTEXT);
      expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
      expect(await copies(t, CONTEXT)).toEqual([{ name: "Weekend groceries" }]);
      await reload(t);
      await t.until(() => dialog() !== null);
      expect(dialog(), "the dialog opened on the copy").not.toBeNull();
      expect(nameField().value).toBe("Weekend groceries");
      expect(
        within(dialog() as HTMLElement).getByText(RESTORED_TEXT),
      ).not.toBeNull();
      expect(bodies(t, "create_list")).toEqual([]);
      // Saving it is the person's act: one new create, its own ids.
      press(CREATE.submit, dialog() as HTMLElement);
      await t.until(() => dialog() === null);
      const [created] = bodies(t, "create_list");
      expect(created).toEqual({
        kind: "create_list",
        id: expect.any(String),
        name: "Weekend groceries",
      });
    },
  );

  test(
    "CONTROL: Cancel discards the name and its copies; the pane opens nothing after a reload",
    SLOW,
    async () => {
      const t = await mountTasks({ path: "/tasks/lists" });
      await t.until(() => document.querySelector("[data-new-list]") !== null);
      press("+ New list");
      await t.settle();
      fireEvent.change(nameField(), { target: { value: "Weekend groceries" } });
      await flushDirty(pageFormRegistry);
      press(CREATE.cancel, dialog() as HTMLElement);
      await t.settle();
      expect(await copies(t, CONTEXT)).toEqual([]);
      await reload(t);
      expect(dialog()).toBeNull();
    },
  );
});

describe("rename (RenameListDialog, opened again by the list's detail)", () => {
  test(
    "typed name: saved raw; after the reload the detail opens Rename on it; Save renames with the policy version of now",
    SLOW,
    async () => {
      const id = listId();
      const t = await mountTasks({
        path: `/tasks/lists/${id}`,
        rows: [
          listRow(id, "Weekly groceries", [], {
            policy_version: 4,
            version: 7,
          }),
        ],
        env: { online: false },
      });
      await t.until(detailReady(id));
      press(DETAIL.rename);
      await t.settle();
      fireEvent.change(nameField(), { target: { value: "Groceries" } });
      expect(contextsOf(pageFormRegistry.dirty())).toContain(
        listFormContext(id),
      );
      expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
      expect(await copies(t, listFormContext(id))).toEqual([
        { name: "Groceries" },
      ]);
      await reload(t);
      await t.until(() => dialog() !== null);
      expect(dialog(), "the dialog opened on the copy").not.toBeNull();
      expect(nameField().value).toBe("Groceries");
      expect(bodies(t, "edit_list")).toEqual([]);
      press(RENAME.submit, dialog() as HTMLElement);
      await t.until(() => dialog() === null);
      expect(bodies(t, "edit_list")).toEqual([
        {
          kind: "edit_list",
          id,
          expected_version: 7,
          expected_policy_version: 4,
          name: "Groceries",
        },
      ]);
    },
  );
});

describe("the task picker (TaskPicker, opened again by the list's detail)", () => {
  async function pickerWorld() {
    const id = listId();
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [
        listRow(id, "Errands", []),
        taskRow(taskId(1), "Éclair shop"),
        taskRow(taskId(2), "Post office"),
        taskRow(taskId(4), "Bank"),
      ],
      env: { online: false },
    });
    await t.until(detailReady(id));
    press(DETAIL.add);
    await t.settle();
    return { t, id };
  }
  const box = (task: string) =>
    document.querySelector(
      `[data-picker-task="${task}"] input`,
    ) as HTMLInputElement;
  const selectedCount = () =>
    document
      .querySelector("[data-picker-selected]")
      ?.getAttribute("data-picker-selected");

  test(
    "search and selection: saved raw (tasks and their titles, no add ids); after the reload the detail opens the picker on them; nothing is added",
    SLOW,
    async () => {
      const { t, id } = await pickerWorld();
      fireEvent.click(box(taskId(4)));
      fireEvent.click(box(taskId(2)));
      fireEvent.change(screen.getByLabelText(PICKER.searchLabel), {
        target: { value: "o" },
      });
      expect(contextsOf(pageFormRegistry.dirty())).toContain(
        listPickerContext(id),
      );
      expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
      expect(await copies(t, listPickerContext(id))).toEqual([
        {
          v: 1,
          query: "o",
          selected: [
            { task: taskId(4), title: "Bank" },
            { task: taskId(2), title: "Post office" },
          ],
        },
      ]);
      await reload(t);
      await t.until(() => dialog() !== null);
      expect(dialog(), "the dialog opened on the copy").not.toBeNull();
      expect(
        (screen.getByLabelText(PICKER.searchLabel) as HTMLInputElement).value,
      ).toBe("o");
      expect(selectedCount()).toBe("2");
      expect(bodies(t, "list_item")).toEqual([]);
    },
  );

  test(
    "C5: a partial add settles the remaining selection into the recoverable model in the same transition",
    SLOW,
    async () => {
      const { t, id } = await pickerWorld();
      fireEvent.click(box(taskId(4)));
      fireEvent.click(box(taskId(2)));
      const outbox = t.data.outbox();
      if (outbox === null) throw new Error("no outbox");
      const real = outbox.enqueue.bind(outbox);
      let n = 0;
      outbox.enqueue = async (request: EnqueueRequest) => {
        n += 1;
        // The second add is refused definitely: the first stays added, the second stays selected.
        if (n === 2)
          return { kind: "refused", reason: "storage" } as Awaited<
            ReturnType<typeof real>
          >;
        return real(request);
      };
      press(PICKER.submit, dialog() as HTMLElement);
      await t.settle();
      expect(bodies(t, "list_item")).toHaveLength(1);
      expect(selectedCount()).toBe("1");
      expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
      expect(await copies(t, listPickerContext(id))).toEqual([
        {
          v: 1,
          query: "",
          selected: [{ task: taskId(2), title: "Post office" }],
        },
      ]);
    },
  );
});
