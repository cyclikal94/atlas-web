import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CacheRow, DraftRow } from "../../../src/data";
import { accountDatabaseName } from "../../../src/data/model/schema";
import { refusalMessage } from "../../../src/features/tasks/copy";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import {
  ME,
  mountTasks,
  OTHER,
  type SeededTask,
  seededTask,
} from "../../support/tasks/world";

/**
 * DA-A2 and S6 (WEB-10a revision 16, family `task-edit-permission-admission`): the edit form's permission is a fact of its render, so the
 * transaction that writes a revision checks it again. A denial of the task or its details that another tab committed after the form
 * offered Save refuses the save (`denied`) and an edit of the queued revision alike: nothing is queued or overwritten and what was typed
 * stays, with the reason. An edit of the queued revision is made only to the queued change the form was shown: another tab's edit of it
 * committed in between is never overwritten from the older view (`draft_changed`), and the form says so. Over the PRODUCTION data
 * controller and the IndexedDB double: FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});

const NAME = accountDatabaseName(ME);
const sharedTask = () =>
  seededTask({
    title: "Original name",
    definition: { participation: "everyone" },
    participants: [OTHER, ME],
  });
const form = () =>
  document.querySelector('[data-task-form="edit"]') as HTMLFormElement | null;
const detail = () => document.querySelector("[data-task-detail]") !== null;
const name = () => screen.getByLabelText(FORM_COPY.name) as HTMLInputElement;
const save = () =>
  screen.getByRole("button", { name: FORM_COPY.save }) as HTMLButtonElement;
type Mounted = Awaited<ReturnType<typeof mountTasks>>;
const revisions = (t: Mounted) =>
  t.drafts().filter((d) => d.kind === "revise_task");
const durable = (t: Mounted) =>
  JSON.stringify({ drafts: t.drafts(), bodies: t.bodies() });
const rowOf = (task: SeededTask, kind: "task" | "execution") =>
  task.rows.find((r) => r.kind === kind) as CacheRow;

async function editing(task: SeededTask) {
  const t = await mountTasks({
    path: `/tasks/${task.taskId}/edit`,
    rows: task.rows,
    env: { online: false },
  });
  await t.until(() => form() !== null);
  return t;
}

/** A queued revision saved by this form, then the form opened again on it. */
async function queuedThenReopened(task: SeededTask) {
  const t = await editing(task);
  fireEvent.change(name(), { target: { value: "First" } });
  fireEvent.click(save());
  await t.until(detail);
  expect(revisions(t)).toHaveLength(1);
  await t.router.navigate({
    to: "/tasks/$taskId/edit",
    params: { taskId: task.taskId },
  });
  await t.until(() => form() !== null);
  return t;
}

describe("a denial committed by another tab after the form offered Save (DA-A2)", () => {
  for (const lost of ["task", "execution"] as const)
    test(`the ${lost} denied: no revision is queued, the name typed stays and the reason is shown`, async () => {
      const task = await sharedTask();
      const t = await editing(task);
      fireEvent.change(name(), { target: { value: "Typed" } });
      t.world.idb.seed(NAME, "cache", [
        { ...rowOf(task, lost), can_edit: false },
      ]);
      expect(save()).toBeEnabled();
      fireEvent.click(save());
      await t.settle();
      expect(revisions(t)).toEqual([]);
      expect(name().value).toBe("Typed");
      expect(t.router.state.location.pathname).toBe(
        `/tasks/${task.taskId}/edit`,
      );
      // The form's own notice (the announcer says it too).
      expect(form()?.textContent).toContain(refusalMessage("denied") as string);
    });

  for (const lost of ["task", "execution"] as const)
    test(`the ${lost} denied before an edit of the queued revision: its body is not changed, the name typed stays`, async () => {
      const task = await sharedTask();
      const t = await queuedThenReopened(task);
      const before = durable(t);
      t.world.idb.seed(NAME, "cache", [
        { ...rowOf(task, lost), can_edit: false },
      ]);
      fireEvent.change(name(), { target: { value: "Second" } });
      fireEvent.click(save());
      await t.settle();
      expect(durable(t)).toBe(before);
      expect(name().value).toBe("Second");
      expect(screen.getByText(FORM_COPY.denied)).toBeInTheDocument();
    });
});

describe("the queued revision edited by another tab while this form showed it (S6)", () => {
  test("control: with nothing in between, the queued revision is edited in place once", async () => {
    const task = await sharedTask();
    const t = await queuedThenReopened(task);
    const [queued] = revisions(t);
    fireEvent.change(name(), { target: { value: "Second" } });
    fireEvent.click(save());
    await t.until(detail);
    expect(revisions(t).map((d) => d.local_id)).toEqual([queued?.local_id]);
    expect(
      t.bodies().find((b) => b.local_id === queued?.local_id)?.command.command
        .title,
    ).toBe("Second");
  });

  test("another tab's edit is not overwritten from the older view; the name typed stays and the form says so", async () => {
    const task = await sharedTask();
    const t = await queuedThenReopened(task);
    const [queued] = revisions(t) as [DraftRow];
    // Another tab edited the queued body (its digest changed); this page is not told.
    const body = t.bodies().find((b) => b.local_id === queued.local_id);
    if (body === undefined) throw new Error("setup");
    t.world.idb.seed(NAME, "drafts", [
      { ...queued, command_digest: "edited-elsewhere" },
    ] as never);
    t.world.idb.seed(NAME, "draft_commands", [
      {
        local_id: queued.local_id,
        command: {
          command: { ...body.command.command, title: "Other tab" },
        },
      },
    ] as never);
    const before = durable(t);
    fireEvent.change(name(), { target: { value: "Mine, from the old view" } });
    fireEvent.click(save());
    await t.settle();
    expect(durable(t)).toBe(before);
    expect(name().value).toBe("Mine, from the old view");
    expect(screen.getByText(FORM_COPY.changedElsewhere)).toBeInTheDocument();
  });
});

describe("the form's own admission attempts no write under a known denial (R29; revision 16)", () => {
  // The writing transaction now refuses such a write too (`denied`), so "nothing is queued" alone no longer shows that the FORM withheld
  // it: these cases observe that no write is even attempted (the outbox is never asked), whatever started the save.
  function watch(t: Mounted) {
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("setup: no outbox");
    return {
      enqueue: vi.spyOn(outbox, "enqueue"),
      editQueued: vi.spyOn(outbox, "editQueued"),
    };
  }
  const denyBy = (task: SeededTask, lost: "task" | "execution") =>
    task.rows.map((r) => (r.kind === lost ? { ...r, can_edit: false } : r));

  for (const lost of ["task", "execution"] as const)
    test(`the ${lost} known denied, direct route: Enter's submission asks the outbox for nothing`, async () => {
      const task = await sharedTask();
      const t = await mountTasks({
        path: `/tasks/${task.taskId}/edit`,
        rows: denyBy(task, lost),
        env: { online: false },
      });
      await t.until(() => form() !== null);
      const spies = watch(t);
      fireEvent.change(name(), { target: { value: "Typed" } });
      fireEvent.submit(form() as HTMLFormElement);
      await t.settle();
      expect(spies.enqueue).not.toHaveBeenCalled();
      expect(spies.editQueued).not.toHaveBeenCalled();
      expect(form()?.textContent).not.toContain(
        refusalMessage("denied") as string,
      );
    });

  test("the permission lost while the form is open, then a queued revision: no edit of it is asked for", async () => {
    const task = await sharedTask();
    const t = await queuedThenReopened(task);
    const taskRow = rowOf(task, "task");
    await t.commitSync([
      { ...taskRow, can_edit: false, version: taskRow.version + 1 },
    ]);
    await t.until(() => save().disabled);
    const spies = watch(t);
    fireEvent.change(name(), { target: { value: "Second" } });
    fireEvent.submit(form() as HTMLFormElement);
    await t.settle();
    expect(spies.enqueue).not.toHaveBeenCalled();
    expect(spies.editQueued).not.toHaveBeenCalled();
  });

  test("control: an editor's submission asks the outbox once", async () => {
    const task = await sharedTask();
    const t = await editing(task);
    const spies = watch(t);
    fireEvent.change(name(), { target: { value: "Renamed" } });
    fireEvent.submit(form() as HTMLFormElement);
    await t.until(detail);
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
  });
});
