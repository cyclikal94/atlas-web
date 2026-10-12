import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import * as copy from "../../../src/features/tasks/copy";
import { CONTROLS_COPY } from "../../../src/features/tasks/detail/Controls";
import {
  CORRECTION_COPY,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import { RECORD_COPY } from "../../../src/features/tasks/detail/RecordCard";
import { PRESET_COPY } from "../../../src/features/tasks/form/PresetPicker";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import {
  definition,
  fakeApi,
  mountTasks,
  seededTask,
} from "../../support/tasks/world";

/**
 * WF-TASK-01/02/03 and the Q21 controls (A10-A15, A19) in the app's router over the PRODUCTION data controller and the IndexedDB double.
 * FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const detailPath = (task: { taskId: string; occurrenceId: string }) =>
  `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
const ready = () => document.querySelector("[data-record-card]") !== null;
type Mounted = Awaited<ReturnType<typeof mountTasks>>;
const command = (t: Mounted, kind: string) =>
  t.bodies().find((b) => b.command.command.kind === kind)?.command.command;

describe("closure and streak exclusion (TASK-23 #1-#2; Q21)", () => {
  test("Exclude is hidden entirely when the policy is off; Close queues a resolve", async () => {
    const task = await seededTask();
    const t = await mountTasks({
      path: detailPath(task),
      rows: task.rows,
      env: { online: false },
    });
    await t.until(ready);
    expect(
      screen.queryByRole("button", { name: CONTROLS_COPY.exclude }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: CONTROLS_COPY.close }));
    await t.settle();
    expect(command(t, "resolve")).toMatchObject({
      occurrence_id: task.occurrenceId,
      resolved: true,
      expected_version: 1,
    });
  });

  test("with the policy on and my stream present, Exclude queues an exclude against my progress", async () => {
    const task = await seededTask({
      definition: { allow_streak_exclusions: true },
    });
    const t = await mountTasks({
      path: detailPath(task),
      rows: task.rows,
      env: { online: false },
    });
    await t.until(ready);
    fireEvent.click(
      screen.getByRole("button", { name: CONTROLS_COPY.exclude }),
    );
    await t.settle();
    expect(command(t, "exclude")).toMatchObject({
      occurrence_id: task.occurrenceId,
      excluded: true,
      expected_version: 1,
    });
    await t.until(
      () =>
        screen.queryByRole("button", { name: CONTROLS_COPY.undoExclude }) !==
        null,
    );
    expect(
      screen.getByRole("button", { name: CONTROLS_COPY.undoExclude }),
    ).toBeInTheDocument();
  });
});

describe("the Record progress card (A8)", () => {
  test("an amount records a quantity with no expected version; 'Just checked on it' records an observation", async () => {
    const task = await seededTask({
      definition: {
        goal: { kind: "numeric", minimum: "8", maximum: null, unit: "glasses" },
      },
    });
    const t = await mountTasks({
      path: detailPath(task),
      rows: task.rows,
      env: { online: false },
    });
    await t.until(ready);
    fireEvent.change(screen.getByLabelText(`${RECORD_COPY.amount} (glasses)`), {
      target: { value: "2.5" },
    });
    fireEvent.click(
      within(
        document.querySelector("[data-record-card]") as HTMLElement,
      ).getByRole("button", { name: copy.RECORD }),
    );
    await t.settle();
    const q = command(t, "record");
    expect(q).toMatchObject({ evidence: { kind: "quantity", amount: "2.5" } });
    expect(q?.expected_version).toBeUndefined();
    await t.until(
      () =>
        document.querySelector("[data-record-progress]")?.textContent ===
        RECORD_COPY.progress("2.5", "8", "glasses"),
    );
    fireEvent.click(screen.getByRole("radio", { name: RECORD_COPY.checkedOn }));
    fireEvent.click(
      within(
        document.querySelector("[data-record-card]") as HTMLElement,
      ).getByRole("button", { name: copy.RECORD }),
    );
    await t.settle();
    expect(
      t
        .bodies()
        .some(
          (b) =>
            (b.command.command.evidence as { kind: string } | undefined)
              ?.kind === "observe",
        ),
    ).toBe(true);
  });

  test("a closed close_incomplete day disables recording and says why", async () => {
    const past = new Date(Date.now() - 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const task = await seededTask({ date: past });
    const t = await mountTasks({
      path: detailPath(task),
      rows: task.rows,
      env: { online: false },
    });
    await t.until(ready);
    const card = document.querySelector("[data-record-card]") as HTMLElement;
    expect(
      within(card).getByRole("button", { name: copy.MARK_DONE }),
    ).toBeDisabled();
    expect(within(card).getByText(copy.DAY_CLOSED)).toBeInTheDocument();
  });
});

describe("archive and restore (A13)", () => {
  test("Archive queues an archive of the task and shows Restore at once", async () => {
    const task = await seededTask();
    const t = await mountTasks({
      path: detailPath(task),
      rows: task.rows,
      env: { online: false },
    });
    await t.until(ready);
    fireEvent.click(
      screen.getByRole("button", { name: CONTROLS_COPY.archive }),
    );
    await t.settle();
    expect(command(t, "archive")).toMatchObject({
      id: task.taskId,
      archived: true,
      expected_version: 1,
    });
    await t.until(
      () =>
        screen.queryByRole("button", { name: CONTROLS_COPY.restore }) !== null,
    );
  });
});

describe("the correction dialog (WF-TASK-03; A14)", () => {
  test("Save correction queues a revise_occurrence with the full definition and participation unchanged", async () => {
    const task = await seededTask({
      definition: {
        goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
      },
    });
    const t = await mountTasks({
      path: detailPath(task),
      rows: task.rows,
      env: { online: false },
    });
    await t.until(ready);
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(CORRECTION_COPY.maximum), {
      target: { value: "2" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: CORRECTION_COPY.save }),
    );
    await t.settle();
    const c = command(t, "revise_occurrence");
    expect(c).toMatchObject({
      id: task.occurrenceId,
      expected_version: 1,
      date: task.data.slot.date,
    });
    expect(
      ((c ?? {}).definition as { goal: unknown; participation: string }).goal,
    ).toEqual({ kind: "numeric", minimum: null, maximum: "2", unit: "cups" });
    expect(
      ((c ?? {}).definition as { participation: string }).participation,
    ).toBe("personal");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Cancel discards the edit: reopening shows the saved values", async () => {
    const task = await seededTask({
      definition: {
        goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
      },
    });
    const t = await mountTasks({
      path: detailPath(task),
      rows: task.rows,
      env: { online: false },
    });
    await t.until(ready);
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(CORRECTION_COPY.maximum), {
      target: { value: "3" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: CORRECTION_COPY.cancel }),
    );
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    dialog = await screen.findByRole("dialog");
    expect(
      (
        within(dialog).getByLabelText(
          CORRECTION_COPY.maximum,
        ) as HTMLInputElement
      ).value,
    ).toBe("8");
    expect(t.drafts()).toHaveLength(0);
  });
});

describe("the task form (WF-TASK-02; A10)", () => {
  test("from scratch: a create with deterministic first-occurrence and progress ids, then the task's detail", async () => {
    const t = await mountTasks({ path: "/tasks/new", env: { online: false } });
    await t.until(
      () =>
        screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null,
    );
    expect(screen.getByText(PRESET_COPY.offline)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: PRESET_COPY.scratch }));
    await t.until(() => document.querySelector("[data-task-form]") !== null);
    fireEvent.change(screen.getByLabelText(FORM_COPY.name), {
      target: { value: "Water the plants" },
    });
    fireEvent.click(
      screen.getByRole("radio", { name: FORM_COPY.sharingOnlyMe }),
    );
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
    await t.settle();
    const [draft] = t.drafts();
    expect(draft?.kind).toBe("create_task");
    expect(draft?.target_resource_ids).toHaveLength(4);
    const c = command(t, "create_task");
    expect(c).toMatchObject({
      title: "Water the plants",
      initial_policy: { grants: [], exclude_accounts: [] },
    });
    await t.until(() => t.router.state.location.pathname === `/tasks/${c?.id}`);
    expect(t.router.state.location.pathname).toBe(`/tasks/${c?.id}`);
  });

  test("a refused save keeps every value and says why; nothing is shown as saved", async () => {
    const t = await mountTasks({ path: "/tasks/new", env: { online: false } });
    await t.until(
      () =>
        screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null,
    );
    fireEvent.click(screen.getByRole("button", { name: PRESET_COPY.scratch }));
    await t.until(() => document.querySelector("[data-task-form]") !== null);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    outbox.enqueue = async () => ({ kind: "refused", reason: "quota" });
    fireEvent.change(screen.getByLabelText(FORM_COPY.name), {
      target: { value: "Keep me" },
    });
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
    await t.settle();
    expect(
      screen.getByText(copy.refusalMessage("quota") as string, {
        selector: "[data-form-notice]",
      }),
    ).toBeInTheDocument();
    expect(
      (screen.getByLabelText(FORM_COPY.name) as HTMLInputElement).value,
    ).toBe("Keep me");
    expect(t.router.state.location.pathname).toBe("/tasks/new");
  });

  test("a preset from the API fills the form; every field stays editable (TASK-29)", async () => {
    const api = fakeApi({
      readPresets: async () => ({
        ok: true,
        value: [
          {
            id: "chore",
            title: "Shared persistent chore",
            definition: definition({
              participation: "everyone",
              carry: "retain_one",
            }),
          },
        ],
      }),
    });
    const t = await mountTasks({ path: "/tasks/new", api });
    await t.until(
      () =>
        screen.queryByRole("radio", { name: /Shared persistent chore/ }) !==
        null,
    );
    fireEvent.click(screen.getByRole("button", { name: PRESET_COPY.use }));
    await t.until(() => document.querySelector("[data-task-form]") !== null);
    expect(
      (screen.getByLabelText(FORM_COPY.name) as HTMLInputElement).value,
    ).toBe("Shared persistent chore");
    // Each choice is named by its label and its consequence line.
    expect(
      screen.getByRole("radio", {
        name: `${copy.PARTICIPATION.everyone} ${copy.PARTICIPATION_LINE.everyone}`,
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("radio", {
        name: `${copy.CARRY.retain_one.label} ${copy.CARRY.retain_one.line}`,
      }),
    ).toBeChecked();
  });
});

describe("accessibility (jsdom layer)", () => {
  test("the detail page has no axe violations", async () => {
    const task = await seededTask({
      definition: { allow_streak_exclusions: true, participation: "everyone" },
    });
    const t = await mountTasks({
      path: detailPath(task),
      rows: task.rows,
      env: { online: false },
    });
    await t.until(ready);
    expect((await axe(document.body)).violations).toEqual([]);
  });
});
