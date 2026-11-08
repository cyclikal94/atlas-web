import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { CARRY } from "../../../src/features/tasks/copy";
import {
  CORRECTION_COPY,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import { DEPENDENCY_COPY } from "../../../src/features/tasks/detail/Dependencies";
import { EDITOR_COPY } from "../../../src/features/tasks/detail/FactEditors";
import { DETAIL_COPY } from "../../../src/features/tasks/detail/TaskDetail";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { addDays } from "../../../src/features/tasks/model/time";
import { installMatchMedia } from "../../helpers/match-media";
import { mountTasks, seededTask, TODAY } from "../../support/tasks/world";

/**
 * The facts strip's short editors (the Final design, FD_EditPopover): a short choice opens as a popover under the cell that was pressed,
 * saves on choice through the day's correction or the task's revision, and closes; Escape and a click outside close it without a save.
 * The action row's Tomorrow and Skip, and the Follows cell, are the same contracts in one press.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

type Mounted = Awaited<ReturnType<typeof mountTasks>>;
type Options = Parameters<typeof seededTask>[0];
const TOMORROW = addDays(TODAY, 1);
const cell = (fact: string) =>
  document.querySelector<HTMLElement>(`[data-fact="${fact}"]`);
const editor = (fact: string) =>
  document.querySelector<HTMLElement>(`[data-fact-editor="${fact}"]`);
const commands = (t: Mounted, kind: string) =>
  t
    .bodies()
    .map((b) => b.command.command)
    .filter((c) => c.kind === kind);
const WEEKLY = {
  start_date: TODAY,
  time: null,
  timezone: "UTC",
  repeat: { frequency: "weekly" as const, interval: 1 },
};

async function open(options: Options = {}) {
  const task = await seededTask(options);
  const t = await mountTasks({
    path: `/tasks/${task.taskId}`,
    rows: task.rows,
    env: { online: false },
  });
  await t.until(() => cell("day") !== null);
  return { t, task };
}

describe("the day's editor", () => {
  test("the Day cell opens a popover under it; Tomorrow corrects this day alone and the popover closes onto the cell", async () => {
    const { t } = await open();
    const day = cell("day") as HTMLButtonElement;
    expect(day.tagName, "the day is a button").toBe("BUTTON");
    expect(editor("day")).toBeNull();
    fireEvent.click(day);
    const popover = editor("day") as HTMLElement;
    expect(popover, "the popover opened").not.toBeNull();
    expect(popover.getAttribute("role")).toBe("dialog");
    expect(popover.getAttribute("aria-label")).toBe(EDITOR_COPY.day.title);
    expect(day.getAttribute("aria-expanded"), "the cell is pressed").toBe(
      "true",
    );
    // Today is the current choice; the grid shows this month.
    expect(
      within(popover)
        .getByRole("button", { name: EDITOR_COPY.day.today })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      popover
        .querySelector("[data-month-grid]")
        ?.getAttribute("data-month-grid"),
    ).toBe(TODAY.slice(0, 7));
    fireEvent.click(
      within(popover).getByRole("button", { name: EDITOR_COPY.day.tomorrow }),
    );
    await t.until(() => commands(t, "revise_occurrence").length === 1);
    const [body] = commands(t, "revise_occurrence");
    expect(body?.date).toBe(TOMORROW);
    expect(body?.time).toBeNull();
    await t.until(() => editor("day") === null);
    expect(
      editor("day"),
      "the popover closed once the save was queued",
    ).toBeNull();
    expect(document.activeElement, "focus returned to the cell").toBe(
      cell("day"),
    );
    expect(cell("day")?.getAttribute("aria-expanded")).toBe("false");
  });

  test("a quick time keeps the day; another typed time saves on change", async () => {
    const { t } = await open();
    fireEvent.click(cell("day") as HTMLElement);
    const popover = editor("day") as HTMLElement;
    fireEvent.click(within(popover).getByRole("button", { name: "09:00" }));
    await t.until(() => commands(t, "revise_occurrence").length === 1);
    expect(commands(t, "revise_occurrence")[0]).toMatchObject({
      date: TODAY,
      time: "09:00:00",
    });
  });

  test("Escape closes the popover without a save", async () => {
    const { t } = await open();
    fireEvent.click(cell("day") as HTMLElement);
    const popover = editor("day") as HTMLElement;
    fireEvent.keyDown(popover, { key: "Escape" });
    await t.until(() => editor("day") === null);
    expect(editor("day")).toBeNull();
    expect(t.drafts()).toHaveLength(0);
    expect(document.activeElement).toBe(cell("day"));
  });

  test("a click outside closes it; the correction link opens the full dialog", async () => {
    const { t } = await open();
    fireEvent.click(cell("day") as HTMLElement);
    expect(editor("day")).not.toBeNull();
    fireEvent.pointerDown(document.body);
    await t.until(() => editor("day") === null);
    expect(editor("day")).toBeNull();
    fireEvent.click(cell("day") as HTMLElement);
    fireEvent.click(
      within(editor("day") as HTMLElement).getByRole("button", {
        name: EDITOR_COPY.day.more,
      }),
    );
    await t.until(
      () =>
        screen.queryByRole("dialog", {
          name: new RegExp(CORRECTION_COPY.title("").trim()),
        }) !== null,
    );
    expect(editor("day"), "the popover gave way to the dialog").toBeNull();
  });

  test("a day that can't be corrected keeps a plain Day cell and no quick acts", async () => {
    await open({ canEdit: false });
    expect(cell("day")?.tagName).toBe("DIV");
    expect(document.querySelector("[data-day-tomorrow]")).toBeNull();
    expect(document.querySelector("[data-day-skip]")).toBeNull();
  });
});

describe("the task's editors", () => {
  test("Repeats offers the family's cadences and revises the task on the cached policy version", async () => {
    const { t, task } = await open({ definition: { schedule: WEEKLY } });
    const repeat = cell("repeat") as HTMLButtonElement;
    expect(repeat.tagName).toBe("BUTTON");
    fireEvent.click(repeat);
    const popover = editor("repeat") as HTMLElement;
    expect(popover).not.toBeNull();
    expect(
      within(popover)
        .getByRole("button", { name: EDITOR_COPY.repeat.frequency.weekly })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(
      within(popover).getByRole("button", {
        name: EDITOR_COPY.repeat.frequency.monthly,
      }),
    );
    await t.until(() => commands(t, "revise_task").length === 1);
    const [body] = commands(t, "revise_task");
    expect(body).toMatchObject({
      id: task.taskId,
      expected_policy_version: 1,
      title: "Brush your teeth",
    });
    expect(
      (body as { definition: { schedule: { repeat: unknown } } }).definition
        .schedule.repeat,
    ).toEqual({ frequency: "monthly", interval: 1 });
    await t.until(() => editor("repeat") === null);
  });

  test("the interval is a choice too", async () => {
    const { t } = await open({ definition: { schedule: WEEKLY } });
    fireEvent.click(cell("repeat") as HTMLElement);
    fireEvent.click(
      within(editor("repeat") as HTMLElement).getByRole("button", {
        name: "2",
      }),
    );
    await t.until(() => commands(t, "revise_task").length === 1);
    expect(
      (
        commands(t, "revise_task")[0] as {
          definition: { schedule: { repeat: unknown } };
        }
      ).definition.schedule.repeat,
    ).toEqual({ frequency: "weekly", interval: 2 });
  });

  test("a one-off shows what it follows (its calendar anchor) where a repeating task shows how it repeats", async () => {
    const { t } = await open();
    await t.until(() => cell("anchor") !== null);
    expect(cell("repeat")).toBeNull();
    expect(cell("anchor")?.tagName).toBe("BUTTON");
  });

  test("If missed revises the carry and says what the choice means", async () => {
    const { t } = await open();
    fireEvent.click(cell("carry") as HTMLElement);
    const popover = editor("carry") as HTMLElement;
    expect(popover.textContent).toContain(CARRY.close_incomplete.line);
    fireEvent.click(
      within(popover).getByRole("button", { name: CARRY.retain_one.label }),
    );
    await t.until(() => commands(t, "revise_task").length === 1);
    expect(
      (commands(t, "revise_task")[0] as { definition: { carry: string } })
        .definition.carry,
    ).toBe("retain_one");
  });
});

describe("the action row and the Follows cell", () => {
  test("Tomorrow moves the day on by one; Skip closes it without completing", async () => {
    const { t } = await open();
    fireEvent.click(document.querySelector("[data-day-tomorrow]") as Element);
    await t.until(() => commands(t, "revise_occurrence").length === 1);
    expect(commands(t, "revise_occurrence")[0]?.date).toBe(TOMORROW);
    fireEvent.click(document.querySelector("[data-day-skip]") as Element);
    await t.until(() => t.drafts().some((d) => d.kind === "resolve"));
    expect(t.drafts().filter((d) => d.kind === "resolve")).toHaveLength(1);
  });

  test("Follows says what the day waits for and opens what needs doing first", async () => {
    const { t } = await open();
    const follows = cell("follows") as HTMLButtonElement;
    expect(follows.tagName).toBe("BUTTON");
    await t.until(() => follows.getAttribute("data-follows") !== "loading");
    expect(follows.textContent).toContain(DETAIL_COPY.follows.offline);
    fireEvent.click(follows);
    await t.until(
      () =>
        screen.queryByRole("dialog", { name: DEPENDENCY_COPY.heading }) !==
        null,
    );
  });
});
