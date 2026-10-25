import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import * as words from "../../../src/features/calendars/copy-anchor";
import { FROM_REVIEW } from "../../../src/features/calendars/copy-review";
import { forgetBindings } from "../../../src/features/tasks/detail/anchor-binding";
import {
  CORRECTION_COPY,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import { PRESET_COPY } from "../../../src/features/tasks/form/PresetPicker";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import { cacheRow } from "../../support/data/rows";
import { mountTasks, seededTask } from "../../support/tasks/world";

/**
 * WEB-13b §4.3 and §4.5: the new-task form's "Anchor to a calendar event" (shown while the task does not repeat; the anchor kept while
 * Repeats hides it and omitted, without a warning, from a repeating save: PRODUCT-DECISIONS-20261011), `create_task` with an anchor (no
 * projected first occurrence, R15), and "Review this move…"'s seeded one-day correction (`?move=`, consumed once). FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
  forgetBindings();
});

const SOURCE = "00000000-0000-4000-8000-0000000000a1";
const rows = [
  cacheRow({
    id: SOURCE,
    kind: "calendar_source",
    label: "Family calendar",
    value: { timezone: "Europe/London" },
  }),
  cacheRow({
    id: "00000000-0000-4000-8000-0000000000e1",
    kind: "event",
    parent_id: SOURCE,
    label: "Bin day",
    value: {
      uid: "bin@example",
      original: "2026-11-02",
      title: "Bin day",
      start: {
        date: "2026-11-02",
        time: null,
        timezone: "Europe/London",
        instant: null,
      },
      end: null,
      status: "present",
      sequence: 0,
    },
  }),
];

type Mounted = Awaited<ReturnType<typeof mountTasks>>;
const command = (t: Mounted) =>
  t.bodies().find((b) => b.command.command.kind === "create_task")?.command
    .command;

async function newForm() {
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
  fireEvent.change(screen.getByLabelText(FORM_COPY.name), {
    target: { value: "Put the bins out" },
  });
  fireEvent.click(screen.getByRole("radio", { name: FORM_COPY.sharingOnlyMe }));
  return t;
}
const repeats = (value: string) =>
  fireEvent.change(screen.getByLabelText(FORM_COPY.repeats), {
    target: { value },
  });
const anchorSection = () =>
  document.querySelector("[data-task-form-anchor]") as HTMLElement | null;

async function anchorIt(t: Mounted) {
  fireEvent.click(
    within(anchorSection() as HTMLElement).getByRole("button", {
      name: words.FORM_ANCHOR,
    }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: words.CHANGE_EVENT }),
  );
  await t.settle();
  fireEvent.click(
    (await within(dialog).findByText("Bin day")).closest(
      "button",
    ) as HTMLElement,
  );
  await t.settle();
  fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
    target: { value: "-1" },
  });
  fireEvent.change(within(dialog).getByLabelText(words.TIME_LABEL), {
    target: { value: "18:00" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
  );
  await t.settle();
  expect(screen.queryByRole("dialog")).toBeNull();
  // The panel's own submission never submits the task form around it (React events bubble through the portal): nothing is stored yet.
  expect(t.drafts()).toEqual([]);
}

describe("the new-task form's anchor", () => {
  test("shown only while the task does not repeat; an anchored create carries it and makes no first occurrence", async () => {
    const t = await newForm();
    expect(anchorSection()).toBeNull();
    repeats("none");
    expect(anchorSection()).toHaveTextContent(words.FORM_NONE);
    await anchorIt(t);
    expect(anchorSection()).toHaveTextContent(
      "Family calendar · Bin day · 1 day before at 18:00",
    );
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
    await t.settle();
    const [draft] = t.drafts();
    expect(draft?.kind).toBe("create_task");
    // The task and its details only: an anchored task's occurrences come from its reference (R15).
    expect(draft?.target_resource_ids).toHaveLength(2);
    expect(command(t)?.anchor).toEqual({
      reference: {
        kind: "event_series",
        source_id: SOURCE,
        uid: "bin@example",
      },
      offset: { kind: "calendar_days", days: -1, time: "18:00:00" },
      weekdays: [],
    });
  });

  test("Repeats hides it and KEEPS it; showing it again brings it back; a repeating save omits it with no warning", async () => {
    const t = await newForm();
    repeats("none");
    await anchorIt(t);
    repeats("weekly");
    expect(anchorSection()).toBeNull();
    repeats("none");
    expect(anchorSection()).toHaveTextContent("Bin day");
    repeats("weekly");
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
    await t.settle();
    const body = command(t);
    expect(body?.kind).toBe("create_task");
    expect("anchor" in (body ?? {})).toBe(false);
    expect(t.drafts()[0]?.target_resource_ids).toHaveLength(4);
    expect(document.body.textContent).not.toMatch(/anchor .*(lost|removed)/i);
  });

  test("Remove takes it away before saving", async () => {
    const t = await newForm();
    repeats("none");
    await anchorIt(t);
    fireEvent.click(
      within(anchorSection() as HTMLElement).getByRole("button", {
        name: words.FORM_REMOVE,
      }),
    );
    expect(anchorSection()).toHaveTextContent(words.FORM_NONE);
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
    await t.settle();
    expect("anchor" in (command(t) ?? {})).toBe(false);
  });
});

describe("the new task's detail before it has synced", () => {
  test("online: the binding is not read while the task is only this device's pending create; the section says it will show once synced", async () => {
    const t = await mountTasks({
      path: "/tasks/new",
      rows,
      env: { online: true },
    });
    await t.until(
      () =>
        screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null,
    );
    fireEvent.click(screen.getByRole("button", { name: PRESET_COPY.scratch }));
    await t.until(() => document.querySelector("[data-task-form]") !== null);
    fireEvent.change(screen.getByLabelText(FORM_COPY.name), {
      target: { value: "Put the bins out" },
    });
    fireEvent.click(
      screen.getByRole("radio", { name: FORM_COPY.sharingOnlyMe }),
    );
    repeats("none");
    await anchorIt(t);
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
    await t.until(
      () => document.querySelector("[data-anchor-section]") !== null,
    );
    await t.settle();
    const section = document.querySelector(
      "[data-anchor-section]",
    ) as HTMLElement;
    expect(section.getAttribute("data-anchor-section")).toBe("unsynced");
    expect(section).toHaveTextContent(words.BINDING_UNSYNCED);
    expect(t.api.calls.readAnchor ?? 0).toBe(0);
  });
});

describe("Review this move… (the seeded correction)", () => {
  test("?move= opens the day's correction with the proposed date and time, once, and leaves the address", async () => {
    const task = await seededTask();
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}&move=2026-11-03T18:30:00`,
      rows: task.rows,
      env: { online: false },
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(FROM_REVIEW)).toBeInTheDocument();
    expect(
      (within(dialog).getByLabelText(CORRECTION_COPY.date) as HTMLInputElement)
        .value,
    ).toBe("2026-11-03");
    expect(
      (within(dialog).getByLabelText(CORRECTION_COPY.time) as HTMLInputElement)
        .value,
    ).toBe("18:30");
    await t.settle();
    expect(
      (t.router.state.location.search as Record<string, unknown>).move,
    ).toBeUndefined();
    // Nothing is resolved or saved by opening it.
    expect(t.drafts()).toEqual([]);
  });

  test("an invalid move is ignored (and removed): no correction opens", async () => {
    const task = await seededTask();
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}&move=tomorrow`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => document.querySelector("[data-task-detail]") !== null);
    await t.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      (t.router.state.location.search as Record<string, unknown>).move,
    ).toBeUndefined();
  });

  test("a correction session already holding input is resumed unchanged: the seed fills only a NEW session", async () => {
    const task = await seededTask();
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => document.querySelector("[data-task-detail]") !== null);
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    const first = await screen.findByRole("dialog");
    fireEvent.change(within(first).getByLabelText(CORRECTION_COPY.date), {
      target: { value: "2026-12-24" },
    });
    // The tree remounts (the session's re-check of a 403): the dialog's session is retained with what was typed.
    act(() => t.remount());
    await t.until(() => document.querySelector("[data-task-detail]") !== null);
    await act(async () => {
      await t.router.navigate({
        to: "/tasks/$taskId",
        params: { taskId: task.taskId },
        search: { occurrence: task.occurrenceId, move: "2026-11-03" } as never,
        replace: true,
      });
    });
    await t.settle();
    const dialog = await screen.findByRole("dialog");
    expect(
      (within(dialog).getByLabelText(CORRECTION_COPY.date) as HTMLInputElement)
        .value,
    ).toBe("2026-12-24");
  });
});
