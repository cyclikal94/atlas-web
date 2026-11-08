import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { PRESET_COPY } from "../../../src/features/tasks/form/PresetPicker";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { addDays } from "../../../src/features/tasks/model/time";
import { installMatchMedia } from "../../helpers/match-media";
import { mountTasks, seededTask, TODAY } from "../../support/tasks/world";

/**
 * The create form on the Final design (FD_Create): the name is read for dates, times and "every …" (chips under it that set the fields,
 * each dismissible), the facts are buttons whose popovers open under them, the save row offers Add task and Add and another, and a
 * cached task with the same name is offered to open instead.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetKept();
});

type Mounted = Awaited<ReturnType<typeof mountTasks>>;
const name = () => screen.getByLabelText(FORM_COPY.name) as HTMLInputElement;
const field = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement;
const chips = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-title-chip]"));
const commands = (t: Mounted) =>
  t.bodies().map((b) => b.command.command as Record<string, unknown>);
const type = (value: string) => fireEvent.change(name(), { target: { value } });

async function openForm(rows: Parameters<typeof mountTasks>[0]["rows"] = []) {
  const t = await mountTasks({
    path: "/tasks/new",
    rows,
    env: { online: false },
  });
  await t.until(
    () => screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null,
  );
  fireEvent.click(screen.getByRole("button", { name: PRESET_COPY.scratch }));
  await t.until(() => document.querySelector("[data-task-form]") !== null);
  return t;
}

describe("the name's chips", () => {
  test("a date, a time and a cadence typed become chips and set their fields; the saved name is the words that remain", async () => {
    const t = await openForm();
    type("Water the plants tomorrow at 14:00 every week");
    await t.until(() => chips().length === 3);
    expect(chips().map((c) => c.dataset.titleChip)).toEqual([
      "date",
      "time",
      "repeat",
    ]);
    expect(field(FORM_COPY.starting).value).toBe(addDays(TODAY, 1));
    expect(field(FORM_COPY.time).value).toBe("14:00");
    expect(
      (screen.getByLabelText(FORM_COPY.repeats) as HTMLSelectElement).value,
    ).toBe("weekly");
    // The name field keeps the words while typing; the save strips them.
    expect(name().value).toBe("Water the plants tomorrow at 14:00 every week");
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.add }));
    await t.until(() => commands(t).length === 1);
    expect(commands(t)[0]).toMatchObject({
      kind: "create_task",
      title: "Water the plants",
    });
    expect(
      (commands(t)[0] as { definition: { schedule: Record<string, unknown> } })
        .definition.schedule,
    ).toMatchObject({
      start_date: addDays(TODAY, 1),
      time: "14:00:00",
      repeat: { frequency: "weekly", interval: 1 },
    });
  });

  test("a chip dismissed keeps its words in the name and no longer sets the field; a field changed by hand stays", async () => {
    const t = await openForm();
    type("Call Nan on Friday");
    await t.until(() => chips().length === 1);
    const friday = field(FORM_COPY.starting).value;
    expect(friday).not.toBe("");
    // By hand: the date moves on; the chip's reading is unchanged, so it does not pull it back.
    fireEvent.change(field(FORM_COPY.starting), { target: { value: TODAY } });
    type("Call Nan on Friday!");
    await t.until(() => name().value.endsWith("!"));
    expect(field(FORM_COPY.starting).value).toBe(TODAY);
    fireEvent.click(
      screen.getByRole("button", {
        name: FORM_COPY.keepWords("on Friday"),
      }),
    );
    await t.until(() => chips().length === 0);
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.add }));
    await t.until(() => commands(t).length === 1);
    expect(commands(t)[0]?.title).toBe("Call Nan on Friday!");
  });
});

describe("the name's chips, continued", () => {
  test("a chip whose words are deleted hands its field back to what the form began with", async () => {
    const t = await openForm();
    type("Bins tomorrow at 18:30");
    await t.until(() => chips().length === 2);
    expect(field(FORM_COPY.starting).value).toBe(addDays(TODAY, 1));
    type("Bins");
    await t.until(() => chips().length === 0);
    expect(field(FORM_COPY.starting).value).toBe(TODAY);
    expect(field(FORM_COPY.time).value).toBe("");
  });
});

describe("the facts' popovers", () => {
  test("When opens under its cell; Tomorrow and a time set the fields; Escape closes it back onto the cell", async () => {
    const t = await openForm();
    const cell = document.querySelector(
      '[data-fact="when"]',
    ) as HTMLButtonElement;
    fireEvent.click(cell);
    const popover = document.querySelector(
      '[data-form-editor="when"]',
    ) as HTMLElement;
    expect(popover).not.toBeNull();
    expect(cell.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(
      within(popover).getByRole("button", {
        name: FORM_COPY.quickDate.tomorrow,
      }),
    );
    fireEvent.click(within(popover).getByRole("button", { name: "18:00" }));
    expect(field(FORM_COPY.starting).value).toBe(addDays(TODAY, 1));
    expect(field(FORM_COPY.time).value).toBe("18:00");
    fireEvent.keyDown(popover, { key: "Escape" });
    await t.until(
      () => document.querySelector('[data-form-editor="when"]') === null,
    );
    expect(document.activeElement).toBe(cell);
  });

  test("Repeats, Done when and If missed are choices too", async () => {
    await openForm();
    fireEvent.click(document.querySelector('[data-fact="repeats"]') as Element);
    fireEvent.click(
      within(
        document.querySelector('[data-form-editor="repeats"]') as HTMLElement,
      ).getByRole("button", { name: FORM_COPY.repeat.daily }),
    );
    expect(
      (
        screen.getByRole("combobox", {
          name: FORM_COPY.repeats,
        }) as HTMLSelectElement
      ).value,
    ).toBe("daily");
    fireEvent.click(document.querySelector('[data-fact="goal"]') as Element);
    fireEvent.click(
      within(
        document.querySelector('[data-form-editor="goal"]') as HTMLElement,
      ).getByRole("button", { name: FORM_COPY.goal.checklist }),
    );
    expect(document.querySelector("[data-checklist-items]")).not.toBeNull();
  });
});

describe("the save row", () => {
  test("Add and another queues the task and keeps the form, empty, with the name focused", async () => {
    const t = await openForm();
    type("First one");
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.addAnother }));
    await t.until(() => commands(t).length === 1);
    await t.until(() => name().value === "");
    expect(t.router.state.location.pathname).toBe("/tasks/new");
    expect(document.querySelector("[data-task-form]")).not.toBeNull();
    await t.until(() => document.activeElement === name());
    type("Second one");
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.add }));
    await t.until(() => commands(t).length === 2);
    expect(
      commands(t)
        .map((c) => c.title)
        .sort(),
    ).toEqual(["First one", "Second one"]);
  });

  test("a cached task with the same name is offered to open instead", async () => {
    const task = await seededTask({ title: "Pay the water bill" });
    const t = await openForm(task.rows);
    type("pay the water bill");
    await t.until(() => document.querySelector("[data-form-exists]") !== null);
    expect(
      document
        .querySelector("[data-form-exists]")
        ?.getAttribute("data-form-exists"),
    ).toBe(task.taskId);
    expect(
      screen.getByRole("link", { name: FORM_COPY.openExisting }),
    ).toHaveAttribute("href", `/tasks/${task.taskId}`);
  });
});
