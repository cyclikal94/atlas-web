import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  CORRECTION_COPY,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { reviseOccurrence } from "../../../src/features/tasks/model/commands";
import type {
  OccurrenceData,
  TaskDefinition,
} from "../../../src/features/tasks/model/contract";
import {
  type CorrectionState,
  correctionFrom,
  correctionResult,
} from "../../../src/features/tasks/model/correction";
import {
  applicable,
  emptyForm,
  fromDefinition,
  MESSAGES,
  type TaskFormState,
} from "../../../src/features/tasks/model/form";
import {
  correctionRecoveryValues,
  restoreCorrection,
  restoreTaskForm,
  taskFormRecoveryValues,
} from "../../../src/features/tasks/model/recovery";
import { resolveWallTime } from "../../../src/features/tasks/model/time";
import { installMatchMedia } from "../../helpers/match-media";
import {
  definition as baseDefinition,
  mountTasks,
  seededTask,
  TODAY,
} from "../../support/tasks/world";

/**
 * R31 (WEB-10a revision 16, family `task-time-precision-loss`): opening a task, a preset or an occurrence whose time is a valid `HH:MM:SS`
 * and changing ANOTHER field sends the whole time, seconds included (the task's future schedule and a corrected occurrence's intended
 * instant stay as they were; the occurrence's key is never changed). Only the person's own edit of the time field selects a new time,
 * sent as the chosen minute with `:00`; clearing it sends none; a time hidden by a removed date is sent with the date again. The correction
 * is seeded from the occurrence's slot, never the task definition. Recovery values carry the precision, and one saved before it existed
 * keeps its visible time but waits for the person to confirm it (never a guess). Pure tables, then the real form and dialog over the
 * PRODUCTION data controller and the IndexedDB double (FIXTURE evidence).
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const SECONDS = ["00", "01", "45", "59"] as const;
const withTime = (time: string | null): TaskDefinition =>
  baseDefinition({
    schedule: {
      start_date: "2026-10-21",
      time,
      timezone: "Europe/London",
      repeat: { frequency: "daily", interval: 1 },
    },
  });
const loaded = (time: string | null) =>
  fromDefinition("Walk", withTime(time), emptyForm("Europe/London", TODAY));
const sentTime = (state: TaskFormState) => {
  const result = applicable(state);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.definition.schedule.time;
};
/** The person's own edit of the time field, as the form's input makes it. */
const typedTime = (state: TaskFormState, time: string): TaskFormState => ({
  ...state,
  time,
  keptTime: null,
  timeUnconfirmed: false,
});

describe("the task form keeps an untouched time whole (pure)", () => {
  for (const ss of SECONDS)
    test(`07:30:${ss}: a change of the name alone sends 07:30:${ss}`, () => {
      const state = { ...loaded(`07:30:${ss}`), title: "Walk the dog" };
      expect(state.time).toBe("07:30");
      expect(sentTime(state)).toBe(`07:30:${ss}`);
    });

  test("a change of the window, the goal or the zone alone keeps the seconds", () => {
    const state = loaded("07:30:45");
    expect(sentTime({ ...state, closeDaysAfter: "3" })).toBe("07:30:45");
    expect(sentTime({ ...state, timezone: "UTC" })).toBe("07:30:45");
    expect(sentTime({ ...state, startDate: "2026-10-30" })).toBe("07:30:45");
  });

  test("the person's own time edit selects the chosen minute, even back to the same minute", () => {
    const state = loaded("07:30:45");
    expect(sentTime(typedTime(state, "08:15"))).toBe("08:15:00");
    expect(sentTime(typedTime(typedTime(state, "08:15"), "07:30"))).toBe(
      "07:30:00",
    );
  });

  test("cleared, the time is none; hidden by a removed date it is not sent, and comes back whole with the date", () => {
    const state = loaded("07:30:45");
    expect(sentTime(typedTime(state, ""))).toBeNull();
    const undated = { ...state, repeat: "none" as const, startDate: "" };
    const result = applicable(undated);
    if (!result.ok) throw new Error("setup");
    expect(result.definition.schedule).toMatchObject({
      start_date: null,
      time: null,
    });
    expect(sentTime({ ...undated, startDate: "2026-10-22" })).toBe("07:30:45");
  });

  test("controls: a task with no time sends none; a minute typed into a new form sends :00", () => {
    expect(sentTime({ ...loaded(null), title: "x" })).toBeNull();
    const scratch = typedTime(
      { ...emptyForm("UTC", "2026-10-21"), title: "New" },
      "07:30",
    );
    expect(sentTime(scratch)).toBe("07:30:00");
  });

  test("a preset with seconds is created with them", () => {
    const preset = fromDefinition(
      "Preset",
      withTime("06:05:09"),
      emptyForm("UTC", TODAY),
    );
    expect(sentTime(preset)).toBe("06:05:09");
  });
});

const occurrence = (
  intended: string | null,
  definitionTime: string | null = intended,
): OccurrenceData => {
  const definition = withTime(definitionTime);
  return {
    task_id: "t",
    definition,
    slot: {
      key: `2026-10-21T${intended ?? "00:00:00"}`,
      date: intended === null ? null : "2026-10-21",
      intended_time: intended,
      timezone: "Europe/London",
      instant:
        intended === null
          ? null
          : resolveWallTime("Europe/London", "2026-10-21", intended),
    },
    opens_at: 0,
    closes_at: 1,
    participants: [],
    covered_by: null,
    resolved: false,
  };
};
const corrected = (data: OccurrenceData, state: CorrectionState) => {
  const result = correctionResult(data, state);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
};

describe("the correction keeps the occurrence's untouched time whole (pure)", () => {
  for (const ss of SECONDS)
    test(`07:30:${ss}: a change of the window alone sends 07:30:${ss}`, () => {
      const data = occurrence(`07:30:${ss}`);
      const state = { ...correctionFrom(data), closeDaysAfter: "3" };
      expect(state.time).toBe("07:30");
      expect(corrected(data, state).time).toBe(`07:30:${ss}`);
    });

  test("seeded from the occurrence's slot, never the task definition's time", () => {
    const data = occurrence("09:10:05", "07:30:45");
    const state = correctionFrom(data);
    expect(state.keptTime).toBe("09:10:05");
    expect(corrected(data, { ...state, closeDaysAfter: "2" }).time).toBe(
      "09:10:05",
    );
  });

  test("another date keeps the seconds; a cleared date sends no time; the person's own edit sends :00", () => {
    const data = occurrence("07:30:45");
    const state = correctionFrom(data);
    expect(corrected(data, { ...state, date: "2026-10-23" }).time).toBe(
      "07:30:45",
    );
    expect(corrected(data, { ...state, date: "" })).toMatchObject({
      date: null,
      time: null,
    });
    expect(
      corrected(data, {
        ...state,
        time: "08:15",
        keptTime: null,
        timeUnconfirmed: false,
      }).time,
    ).toBe("08:15:00");
  });

  test("the queued correction's slot keeps its key and the 45 seconds of its intended instant", () => {
    const data = occurrence("07:30:45");
    const result = corrected(data, {
      ...correctionFrom(data),
      closeDaysAfter: "3",
    });
    const request = reviseOccurrence(
      {
        occurrenceId: "o",
        current: data,
        definition: result.definition,
        date: result.date,
        time: result.time,
        progressIds: [],
      },
      resolveWallTime,
    );
    const built = request.build({ o: 1 });
    expect((built.command as { command: { time: string } }).command.time).toBe(
      "07:30:45",
    );
    const patched = built.displayPatch?.o?.value as
      | { slot: { key: string; intended_time: string; instant: number } }
      | undefined;
    if (patched === undefined) throw new Error("no display patch");
    const slot = patched.slot;
    expect(slot.key).toBe(data.slot.key);
    expect(slot.intended_time).toBe("07:30:45");
    expect(slot.instant).toBe(data.slot.instant);
    expect(
      slot.instant - resolveWallTime("Europe/London", "2026-10-21", "07:30:00"),
    ).toBe(45);
  });

  test("controls: an occurrence with no time sends none; a minute-aligned one sends :00", () => {
    const anyTime = {
      ...occurrence("07:30:00"),
      slot: {
        ...occurrence("07:30:00").slot,
        intended_time: null,
        instant: null,
      },
    };
    expect(
      corrected(anyTime, { ...correctionFrom(anyTime), closeDaysAfter: "2" })
        .time,
    ).toBeNull();
    const aligned = occurrence("07:30:00");
    expect(
      corrected(aligned, { ...correctionFrom(aligned), closeDaysAfter: "2" })
        .time,
    ).toBe("07:30:00");
  });

  test("the zone's folds and gaps resolve a time with seconds by the existing rule (S18)", () => {
    // 2026-10-25 01:30 occurs twice in London (the earlier is taken); 2026-03-29 01:30 does not occur (moved by the gap).
    for (const [date, wall] of [
      ["2026-10-25", "01:30"],
      ["2026-03-29", "01:30"],
    ] as const)
      expect(
        resolveWallTime("Europe/London", date, `${wall}:45`) -
          resolveWallTime("Europe/London", date, `${wall}:00`),
      ).toBe(45);
  });
});

describe("recovery values carry the precision (C5)", () => {
  test("a form's kept time round-trips; a malformed one restores nothing", () => {
    const state = { ...loaded("07:30:45"), title: "Edited" };
    const restored = restoreTaskForm(taskFormRecoveryValues(state));
    expect(restored).toEqual(state);
    expect(sentTime(restored as TaskFormState)).toBe("07:30:45");
    const bad = JSON.parse(taskFormRecoveryValues(state).form as string);
    expect(
      restoreTaskForm({ form: JSON.stringify({ ...bad, keptTime: "07:30" }) }),
    ).toBeNull();
  });

  test("a value saved before the precision existed keeps its time but waits for the person to confirm it", () => {
    const state = loaded("07:30:45");
    const {
      keptTime: _k,
      timeUnconfirmed: _u,
      ...legacy
    } = state as TaskFormState;
    const restored = restoreTaskForm({ form: JSON.stringify(legacy) });
    if (restored === null) throw new Error("restored nothing");
    expect(restored.time).toBe("07:30");
    expect(restored.timeUnconfirmed).toBe(true);
    const refused = applicable(restored);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.time).toBe(MESSAGES.timeUnconfirmed);
    expect(sentTime(typedTime(restored, "07:30"))).toBe("07:30:00");
    // A legacy value with no time shown has nothing to confirm.
    const none = restoreTaskForm({
      form: JSON.stringify({ ...legacy, time: "" }),
    });
    expect(none?.timeUnconfirmed).toBe(false);
  });

  test("a correction restores its OWN kept time, never the newer row's; a legacy one waits for confirmation", () => {
    const old = occurrence("07:30:45");
    const state = { ...correctionFrom(old), closeDaysAfter: "3" };
    const newer = occurrence("07:30:59");
    const restored = restoreCorrection(correctionRecoveryValues(state), newer);
    expect(restored?.keptTime).toBe("07:30:45");
    const {
      keptTime: _k,
      timeUnconfirmed: _u,
      ...legacy
    } = state as CorrectionState;
    const fromLegacy = restoreCorrection(
      { correction: JSON.stringify(legacy) },
      newer,
    );
    expect(fromLegacy?.keptTime).toBeNull();
    expect(fromLegacy?.timeUnconfirmed).toBe(true);
    expect(correctionResult(newer, fromLegacy as CorrectionState).ok).toBe(
      false,
    );
  });
});

describe("the real form and dialog (S13)", () => {
  const timed = (time: string) =>
    seededTask({
      definition: {
        schedule: {
          start_date: TODAY,
          time,
          timezone: "UTC",
          repeat: { frequency: "daily", interval: 1 },
        },
      },
    });

  for (const time of ["07:30:45", "07:30:00"])
    test(`a task at ${time}: a change of the name alone queues schedule.time ${time}`, async () => {
      const task = await timed(time);
      const t = await mountTasks({
        path: `/tasks/${task.taskId}/edit`,
        rows: task.rows,
        env: { online: false },
      });
      await t.until(
        () => document.querySelector('[data-task-form="edit"]') !== null,
      );
      fireEvent.change(screen.getByLabelText(FORM_COPY.name), {
        target: { value: "Renamed" },
      });
      fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
      await t.until(
        () => document.querySelector("[data-task-detail]") !== null,
      );
      const body = t.bodies()[0]?.command.command as {
        kind: string;
        definition: TaskDefinition;
      };
      expect(body.kind).toBe("revise_task");
      expect(body.definition.schedule.time).toBe(time);
    });

  test("a task at 07:30:45 whose time the person changes queues the chosen minute", async () => {
    const task = await timed("07:30:45");
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/edit`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(
      () => document.querySelector('[data-task-form="edit"]') !== null,
    );
    fireEvent.change(screen.getByLabelText(FORM_COPY.time), {
      target: { value: "08:15" },
    });
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
    await t.until(() => document.querySelector("[data-task-detail]") !== null);
    const body = t.bodies()[0]?.command.command as {
      definition: TaskDefinition;
    };
    expect(body.definition.schedule.time).toBe("08:15:00");
  });

  for (const time of ["07:30:45", "07:30:00"])
    test(`an occurrence at ${time}: a change of the window alone queues time ${time} and keeps its key`, async () => {
      const task = await timed(time);
      const t = await mountTasks({
        path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: task.rows,
        env: { online: false },
      });
      await t.until(
        () => document.querySelector("[data-task-detail]") !== null,
      );
      fireEvent.click(
        screen.getByRole("button", { name: CORRECTION_COPY.open }),
      );
      const dialog = screen.getByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText(CORRECTION_COPY.close), {
        target: { value: "3" },
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: CORRECTION_COPY.save }),
      );
      await t.until(() => screen.queryByRole("dialog") === null);
      const draft = t.drafts().find((d) => d.kind === "revise_occurrence");
      const body = t.bodies().find((b) => b.local_id === draft?.local_id)
        ?.command.command as { time: string | null };
      expect(body.time).toBe(time);
      const patch = draft?.display_patch?.[task.occurrenceId]?.value as {
        slot: { key: string; intended_time: string };
      };
      expect(patch.slot.key).toBe(task.data.slot.key);
      expect(patch.slot.intended_time).toBe(time);
    });

  test("an occurrence at 07:30:45 whose time the person changes queues the chosen minute", async () => {
    const task = await timed("07:30:45");
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => document.querySelector("[data-task-detail]") !== null);
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(CORRECTION_COPY.time), {
      target: { value: "08:15" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: CORRECTION_COPY.save }),
    );
    await t.until(() => screen.queryByRole("dialog") === null);
    const body = t.bodies()[0]?.command.command as { time: string | null };
    expect(body.time).toBe("08:15:00");
  });
});
