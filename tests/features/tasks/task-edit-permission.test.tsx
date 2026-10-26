import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import { DETAIL_COPY } from "../../../src/features/tasks/detail/TaskDetail";
import { PRESET_COPY } from "../../../src/features/tasks/form/PresetPicker";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { editable } from "../../../src/features/tasks/reasons";
import { installMatchMedia } from "../../helpers/match-media";
import {
  mountTasks,
  OTHER,
  type SeededTask,
  seededTask,
} from "../../support/tasks/world";

/**
 * R29 (WEB-10a revision 15, family `task-edit-permission-admission`): `revise_task` writes the task AND its details, so a known denial of
 * either (`can_edit: false` as this device last read it) withholds the Edit affordance and every save of the form, on the direct route
 * too and when the permission is lost while the form is open; what was typed is kept and nothing is queued or coalesced. A permitted
 * editor still queues exactly one revision, offline. In the app's router over the PRODUCTION data controller and the IndexedDB double:
 * FIXTURE evidence (the server still decides when a change is sent).
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});

type Denied = "task" | "execution" | "both" | "none";
const DENIALS: readonly Exclude<Denied, "none">[] = [
  "task",
  "execution",
  "both",
];

function deny(task: SeededTask, denied: Denied): CacheRow[] {
  return task.rows.map((r) =>
    (r.kind === "task" && (denied === "task" || denied === "both")) ||
    (r.kind === "execution" && (denied === "execution" || denied === "both"))
      ? { ...r, can_edit: false }
      : r,
  );
}
async function sharedTask() {
  return seededTask({
    title: "Original name",
    definition: { participation: "everyone" },
    participants: [OTHER],
    stream: false,
    canEdit: false,
  });
}
const form = () =>
  document.querySelector('[data-task-form="edit"]') as HTMLFormElement | null;
const detail = () => document.querySelector("[data-task-detail]") !== null;
const name = () => screen.getByLabelText(FORM_COPY.name) as HTMLInputElement;
const save = () =>
  screen.getByRole("button", { name: FORM_COPY.save }) as HTMLButtonElement;
type Mounted = Awaited<ReturnType<typeof mountTasks>>;
const revisions = (t: Mounted) =>
  t.drafts().filter((d) => d.kind === "revise_task");
const titleOf = (t: Mounted) =>
  t.bodies().find((b) => b.command.command.kind === "revise_task")?.command
    .command.title;

describe("the rule (pure)", () => {
  test("both resources must be editable; unknown details are not a denial", () => {
    expect(editable({ can_edit: true }, { can_edit: true })).toBe(true);
    expect(editable({ can_edit: false }, { can_edit: true })).toBe(false);
    expect(editable({ can_edit: true }, { can_edit: false })).toBe(false);
    expect(editable({ can_edit: false }, { can_edit: false })).toBe(false);
    expect(editable({ can_edit: true }, null)).toBe(true);
  });
});

describe("the task's Edit affordance (R29)", () => {
  for (const denied of DENIALS)
    test(`denied ${denied}: Edit task is not offered and says why`, async () => {
      const task = await sharedTask();
      const t = await mountTasks({
        path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: deny(task, denied),
        env: { online: false },
      });
      await t.until(detail);
      expect(screen.queryByRole("link", { name: DETAIL_COPY.edit })).toBeNull();
      const edit = screen.getByRole("button", { name: DETAIL_COPY.edit });
      expect(edit).toBeDisabled();
      expect(edit).toHaveAccessibleDescription(DETAIL_COPY.editDenied);
    });

  test("control: an editor of both is offered Edit task", async () => {
    const task = await sharedTask();
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
      rows: deny(task, "none"),
      env: { online: false },
    });
    await t.until(detail);
    expect(
      screen.getByRole("link", { name: DETAIL_COPY.edit }),
    ).toBeInTheDocument();
  });
});

describe("the edit form admits no revision under a known denial (R29)", () => {
  for (const denied of DENIALS)
    test(`denied ${denied}, direct route: Save is withheld with the reason, Enter queues nothing, the name typed stays`, async () => {
      const task = await sharedTask();
      const t = await mountTasks({
        path: `/tasks/${task.taskId}/edit`,
        rows: deny(task, denied),
        env: { online: false },
      });
      await t.until(() => form() !== null);
      fireEvent.change(name(), { target: { value: "Renamed by viewer" } });
      expect(save()).toBeDisabled();
      expect(save()).toHaveAccessibleDescription(FORM_COPY.denied);
      // Implicit submission (Enter in a field) reaches the same save: it is admitted there too.
      fireEvent.submit(form() as HTMLFormElement);
      await t.settle();
      expect(t.drafts()).toEqual([]);
      expect(name().value).toBe("Renamed by viewer");
      expect(t.router.state.location.pathname).toBe(
        `/tasks/${task.taskId}/edit`,
      );
    });

  test("control: an editor of both queues exactly one revision offline and goes to the task", async () => {
    const task = await sharedTask();
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/edit`,
      rows: deny(task, "none"),
      env: { online: false },
    });
    await t.until(() => form() !== null);
    fireEvent.change(name(), { target: { value: "Renamed by editor" } });
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await t.until(detail);
    expect(revisions(t)).toHaveLength(1);
    expect(titleOf(t)).toBe("Renamed by editor");
  });

  for (const lost of ["task", "execution"] as const)
    test(`the ${lost} permission lost while the form is open withholds Save; the typed name is kept, nothing queued`, async () => {
      const task = await sharedTask();
      const t = await mountTasks({
        path: `/tasks/${task.taskId}/edit`,
        rows: deny(task, "none"),
        env: { online: false },
      });
      await t.until(() => form() !== null);
      fireEvent.change(name(), { target: { value: "Typed before the loss" } });
      expect(save()).toBeEnabled();
      const row = task.rows.find((r) => r.kind === lost) as CacheRow;
      await t.commitSync([
        { ...row, can_edit: false, version: row.version + 1 },
      ]);
      await t.until(() => save().disabled);
      expect(save()).toHaveAccessibleDescription(FORM_COPY.denied);
      fireEvent.submit(form() as HTMLFormElement);
      await t.settle();
      expect(t.drafts()).toEqual([]);
      expect(name().value).toBe("Typed before the loss");
    });

  test("a queued revision is not edited (coalesced) once the permission is lost", async () => {
    const task = await sharedTask();
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/edit`,
      rows: deny(task, "none"),
      env: { online: false },
    });
    await t.until(() => form() !== null);
    fireEvent.change(name(), { target: { value: "First, allowed" } });
    fireEvent.click(save());
    await t.until(detail);
    expect(revisions(t)).toHaveLength(1);
    const before = JSON.stringify(t.bodies());
    await t.router.navigate({
      to: "/tasks/$taskId/edit",
      params: { taskId: task.taskId },
    });
    await t.until(() => form() !== null);
    const taskRow = task.rows.find((r) => r.kind === "task") as CacheRow;
    await t.commitSync([
      { ...taskRow, can_edit: false, version: taskRow.version + 1 },
    ]);
    await t.until(() => save().disabled);
    fireEvent.change(name(), { target: { value: "Second, denied" } });
    fireEvent.submit(form() as HTMLFormElement);
    await t.settle();
    expect(revisions(t)).toHaveLength(1);
    expect(JSON.stringify(t.bodies())).toBe(before);
    expect(titleOf(t)).toBe("First, allowed");
    expect(name().value).toBe("Second, denied");
  });

  test("a task created on this device and not sent yet is its creator's: its queued create is still edited in place", async () => {
    const t = await mountTasks({ path: "/tasks/new", env: { online: false } });
    await t.until(
      () =>
        screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null,
    );
    fireEvent.click(screen.getByRole("button", { name: PRESET_COPY.scratch }));
    await t.until(() => document.querySelector("[data-task-form]") !== null);
    fireEvent.change(name(), { target: { value: "Created here" } });
    fireEvent.click(save());
    await t.settle();
    const [created] = t.drafts();
    const taskId = created?.target_resource_ids[0] as string;
    await t.router.navigate({ to: "/tasks/$taskId/edit", params: { taskId } });
    await t.until(() => form() !== null);
    fireEvent.change(name(), { target: { value: "Renamed here" } });
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await t.settle();
    expect(t.drafts().map((d) => d.local_id)).toEqual([created?.local_id]);
    expect(
      t.bodies().find((b) => b.command.command.kind === "create_task")?.command
        .command.title,
    ).toBe("Renamed here");
  });
});
