// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import { createCommandRegistry } from "../../../src/data/outbox/registries";
import {
  classifyAnswer,
  classifyThrown,
} from "../../../src/features/tasks/api";
import {
  forgetRefusal,
  forgetTaskMemory,
  jointOf,
  noteJoint,
  noteRefusal,
  refusalOf,
} from "../../../src/features/tasks/memory";
import { nextAttempt } from "../../../src/features/tasks/model/attempt";
import {
  parseDefinition,
  parseOccurrencePage,
  parseProgressState,
} from "../../../src/features/tasks/model/contract";
import {
  correctionFrom,
  correctionResult,
} from "../../../src/features/tasks/model/correction";
import {
  fromUnits,
  parseDecimalInput,
  toUnits,
} from "../../../src/features/tasks/model/decimal";
import {
  applicable,
  closesForm,
  emptyForm,
  fromDefinition,
  MESSAGES,
  visibleFields,
} from "../../../src/features/tasks/model/form";
import {
  correctionRecoveryValues,
  restoreCorrection,
  restoreTaskForm,
  taskFormRecoveryValues,
} from "../../../src/features/tasks/model/recovery";
import {
  countRows,
  inFilter,
  jointLine,
  pillOf,
  type RowInputs,
} from "../../../src/features/tasks/model/row-state";
import {
  DESCRIPTIONS,
  projectCreateTask,
  registerTaskCommands,
  taskCommandSpecs,
} from "../../../src/features/tasks/register";
import { StampedRequestError } from "../../../src/session";
import { draftRow } from "../../support/data/rows";

const ME = "00000000-0000-4000-8000-0000000000aa";
const I1 = "00000000-0000-4000-8000-000000000001";
const def = {
  schedule: {
    start_date: "2026-09-08",
    time: null,
    timezone: "Europe/London",
    repeat: null,
  },
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "personal",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: false,
} as const;

afterEach(() => forgetTaskMemory());

describe("TaskDecimal", () => {
  test("micro-unit arithmetic and canonical text, as the server's Decimal", () => {
    expect(toUnits("0.1")).toBe(100_000n);
    expect(fromUnits(300_000n)).toBe("0.3");
    expect(fromUnits(2_000_000n)).toBe("2");
    for (const bad of [
      "-1",
      "NaN",
      "1e3",
      "01",
      "1.",
      "0.1234567",
      "1000000000001",
    ])
      expect(toUnits(bad)).toBeNull();
    expect(parseDecimalInput(" 2.50 ")).toBe("2.5");
    expect(parseDecimalInput("2,5")).toBeNull();
  });
});

describe("strict contract parsing (D-10a-3)", () => {
  test("a definition with an unknown key, a bad bound or pooled-free checks is refused; the default exclusions flag is read", () => {
    expect(parseDefinition({ ...def })?.allow_streak_exclusions).toBe(false);
    const { allow_streak_exclusions: _a, ...noFlag } = def;
    expect(parseDefinition(noFlag)?.allow_streak_exclusions).toBe(false);
    expect(parseDefinition({ ...def, extra: 1 })).toBeNull();
    expect(parseDefinition({ ...def, close_days_after: 0 })).toBeNull();
    expect(
      parseDefinition({
        ...def,
        schedule: { ...def.schedule, time: "07:00:00", start_date: null },
      }),
    ).toBeNull();
    expect(
      parseDefinition({
        ...def,
        goal: { kind: "numeric", minimum: "01", maximum: null, unit: "u" },
      }),
    ).toBeNull();
  });

  test("progress state and an occurrence page", () => {
    const summary = { outcome: "unknown", amount: null, checked: [] };
    const state = {
      subject_account_id: ME,
      recent_entries: [],
      entry_count: 0,
      excluded: false,
      action: summary,
      period: summary,
      aggregate_consent: true,
    };
    expect(parseProgressState(state)).not.toBeNull();
    expect(parseProgressState({ ...state, entry_count: -1 })).toBeNull();
    expect(
      parseOccurrencePage({
        items: [],
        next_after: null,
        revision: 3,
        pending_tasks: [],
      })?.revision,
    ).toBe(3);
    expect(
      parseOccurrencePage({ items: [], next_after: null, revision: 3 }),
    ).toBeNull();
  });
});

const row = (over: Partial<RowInputs>): RowInputs => ({
  data: {
    task_id: I1,
    definition: def as never,
    slot: {
      key: "once",
      date: "2026-09-08",
      intended_time: null,
      timezone: "UTC",
      instant: null,
    },
    opens_at: 0,
    closes_at: 10,
    participants: [ME],
    covered_by: null,
    resolved: false,
  },
  outcome: null,
  periodOutcome: null,
  unavailable: false,
  actionable: false,
  attention: false,
  nowMs: 5000,
  ...over,
});

describe("row state (D-10a-8)", () => {
  test("the first rule wins, and unknown is never counted as done or to do", () => {
    expect(pillOf(row({ attention: true, outcome: "complete" }))).toBe(
      "conflict",
    );
    expect(pillOf(row({ outcome: "excluded" }))).toBe("excluded");
    expect(pillOf(row({ outcome: "complete", periodOutcome: "missed" }))).toBe(
      "done_late",
    );
    expect(pillOf(row({ outcome: "provisional" }))).toBe("on_track");
    expect(pillOf(row({ actionable: true, outcome: "incomplete" }))).toBe(
      "to_do",
    );
    expect(pillOf(row({ unavailable: true }))).toBe("unavailable");
    expect(pillOf(row({}))).toBe("unknown");
    const counts = countRows([
      row({ outcome: "complete" }),
      row({ actionable: true, outcome: "incomplete" }),
      row({ outcome: "unknown" }),
      row({}),
    ]);
    expect(counts).toEqual({ total: 4, done: 1, toDo: 1, notKnown: 2 });
    expect(
      inFilter("missed", row({ periodOutcome: "missed", outcome: "complete" })),
    ).toBe(true);
  });

  test("the joint line is the server's or nothing (Q8): offline with no answer it is 'not available offline'", () => {
    expect(
      jointLine({
        participation: "everyone",
        serverOutcome: null,
        asOf: null,
        online: false,
        othersVisibleWithConsent: [true],
      }),
    ).toEqual({ kind: "offline" });
    expect(
      jointLine({
        participation: "everyone",
        serverOutcome: "unknown",
        asOf: 1,
        online: true,
        othersVisibleWithConsent: [false],
      }),
    ).toEqual({ kind: "withheld" });
    expect(
      jointLine({
        participation: "everyone",
        serverOutcome: "unknown",
        asOf: 1,
        online: true,
        othersVisibleWithConsent: [true],
      }),
    ).toEqual({ kind: "not_known" });
    expect(
      jointLine({
        participation: "anyone",
        serverOutcome: "unknown",
        asOf: 1,
        online: true,
        othersVisibleWithConsent: [],
      }),
    ).toEqual({ kind: "anyone_unknown" });
    expect(
      jointLine({
        participation: "anyone",
        serverOutcome: "complete",
        asOf: 1,
        online: false,
        othersVisibleWithConsent: [],
      }),
    ).toEqual({ kind: "last_checked", outcome: "complete", asOf: 1 });
  });
});

describe("the task form keeps hidden values and sends only visible ones (PRODUCTION-DECISIONS item 2)", () => {
  const base = emptyForm("Europe/London", "2026-09-08");
  test("switching numeric → checkbox keeps the bounds while editing; a save sends no numeric goal", () => {
    const numeric = {
      ...base,
      title: "Water",
      goalKind: "numeric" as const,
      minimum: "2",
      unit: "litres",
    };
    const switched = { ...numeric, goalKind: "checkbox" as const };
    expect(switched.minimum).toBe("2");
    expect(visibleFields(switched).numeric).toBe(false);
    const saved = applicable(switched);
    expect(saved.ok && saved.definition.goal).toEqual({ kind: "checkbox" });
    const back = applicable({ ...switched, goalKind: "numeric" });
    expect(back.ok && back.definition.goal).toEqual({
      kind: "numeric",
      minimum: "2",
      maximum: null,
      unit: "litres",
    });
  });

  test("a goal-kind switch keeps checklist items; a time without a date is kept but not sent", () => {
    const list = {
      ...base,
      title: "Pack",
      goalKind: "checklist" as const,
      checklist: [{ id: I1, label: "Bag" }],
    };
    const away = { ...list, goalKind: "checkbox" as const };
    expect(away.checklist).toHaveLength(1);
    const again = applicable({ ...away, goalKind: "checklist" });
    expect(again.ok && again.definition.goal).toEqual({
      kind: "checklist",
      items: [{ id: I1, label: "Bag" }],
    });
    const undated = applicable({
      ...base,
      title: "Inbox",
      repeat: "none",
      startDate: "",
      time: "07:30",
    });
    expect(undated.ok && undated.definition.schedule).toMatchObject({
      start_date: null,
      time: null,
    });
  });

  test("validation matches the contract bounds, and pooled needs an amount", () => {
    const bad = applicable({
      ...base,
      title: "",
      interval: "0",
      closeDaysAfter: "0",
      participation: "pooled",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.title).toBe(MESSAGES.title);
      expect(bad.errors.interval).toBe(MESSAGES.interval);
      expect(bad.errors.closeDaysAfter).toBe(MESSAGES.closeDaysAfter);
      expect(bad.errors.participation).toBe(MESSAGES.pooled);
    }
    const order = applicable({
      ...base,
      title: "x",
      goalKind: "numeric",
      minimum: "5",
      maximum: "2",
      unit: "u",
    });
    expect(!order.ok && order.errors.maximum).toBe(MESSAGES.order);
    const repeatNoDate = applicable({ ...base, title: "x", startDate: "" });
    expect(!repeatNoDate.ok && repeatNoDate.errors.startDate).toBe(
      MESSAGES.startNeeded,
    );
  });

  test("a preset or a task fills every field; the submission ticket closes the form only without newer edits", () => {
    const filled = fromDefinition(
      "Brush",
      { ...def, schedule: { ...def.schedule, time: "07:30:00" } } as never,
      base,
    );
    expect(filled).toMatchObject({
      title: "Brush",
      repeat: "none",
      time: "07:30",
      goalKind: "checkbox",
    });
    expect(closesForm({ revision: 3 }, 3)).toBe(true);
    expect(closesForm({ revision: 3 }, 4)).toBe(false);
  });

  test("Q4 recovery values round-trip every field, hidden ones included; restore never submits", () => {
    const state = {
      ...base,
      title: "T",
      goalKind: "checkbox" as const,
      minimum: "7",
    };
    expect(restoreTaskForm(taskFormRecoveryValues(state))).toEqual(state);
    expect(restoreTaskForm({ form: "{}" })).toBeNull();
  });
});

describe("the occurrence correction", () => {
  const occurrence = {
    task_id: I1,
    definition: {
      ...def,
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
    } as never,
    slot: {
      key: "2026-09-08Tdate",
      date: "2026-09-08",
      intended_time: null,
      timezone: "Europe/London",
      instant: null,
    },
    opens_at: 0,
    closes_at: 1,
    participants: [ME],
    covered_by: null,
    resolved: false,
  };
  test("participation and goal kind are kept; a narrower maximum is allowed; a time needs a date", () => {
    const state = {
      ...correctionFrom(occurrence),
      maximum: "2",
      time: "09:15",
    };
    const result = correctionResult(occurrence, state);
    expect(result.ok && result.definition.goal).toEqual({
      kind: "numeric",
      minimum: null,
      maximum: "2",
      unit: "cups",
    });
    expect(result.ok && result.definition.participation).toBe("personal");
    expect(result.ok && result.time).toBe("09:15:00");
    const undated = correctionResult(occurrence, { ...state, date: "" });
    expect(undated.ok && [undated.date, undated.time]).toEqual([null, null]);
    expect(
      restoreCorrection(correctionRecoveryValues(state), occurrence),
    ).toEqual(state);
  });
});

describe("one attempt per body (enrol)", () => {
  test("the same key after an uncertain answer for the same body; a new key after any edit", () => {
    let n = 0;
    const key = () => `k${++n}`;
    const first = nextAttempt(null, { a: 1, b: 2 }, key);
    expect(nextAttempt(first, { b: 2, a: 1 }, key)).toBe(first);
    expect(nextAttempt(first, { a: 2, b: 2 }, key).key).toBe("k2");
  });
});

describe("page memory per identity (D-12a-13)", () => {
  test("a refused read is remembered for the identity until Try again; another identity starts clean", () => {
    noteRefusal("a:1", "daily", "forbidden");
    expect(refusalOf("a:1", "daily")).toBe("forbidden");
    forgetRefusal("a:1", "daily");
    expect(refusalOf("a:1", "daily")).toBeNull();
    noteRefusal("a:1", "daily", "forbidden");
    noteJoint("a:1", I1, {
      outcome: "complete",
      periodOutcome: "complete",
      actionable: false,
      at: 1,
    });
    expect(refusalOf("b:1", "daily")).toBeNull();
    expect(jointOf("b:1", I1)).toBeNull();
    expect(jointOf("a:1", I1)).toBeNull();
  });
});

describe("classification of answers", () => {
  test("a refusal needs an Atlas body; a gateway 404 is uncertain; 401 and a stale session close", () => {
    const atlas = {
      code: "conflict",
      message: "m",
      request_id: "11111111-1111-4111-8111-111111111111",
      details: [],
    };
    expect(classifyAnswer(409, "application/json", atlas)).toMatchObject({
      kind: "conflict",
    });
    expect(classifyAnswer(404, "text/html", "<html>")).toMatchObject({
      kind: "uncertain",
    });
    expect(classifyAnswer(401, null, null)).toMatchObject({ kind: "closed" });
    expect(classifyThrown(new TypeError("network"))).toMatchObject({
      kind: "uncertain",
    });
    expect(
      classifyThrown(new StampedRequestError("not_sent" as never)),
    ).toMatchObject({ kind: "not_sent" });
  });
});

describe("registrations (A17)", () => {
  test("every queued kind is described; a second registration into the same registry is a no-op", () => {
    const registry = createCommandRegistry();
    registerTaskCommands(registry);
    registerTaskCommands(registry);
    for (const kind of Object.keys(DESCRIPTIONS))
      expect(registry.describe(draftRow({ kind }))).toBe(DESCRIPTIONS[kind]);
    expect(registry.canRebuild(draftRow({ kind: "record" }))).toBe(true);
    expect(registry.canRebuild(draftRow({ kind: "create_task" }))).toBe(false);
    expect(registry.canRebuild(draftRow({ kind: "revise_occurrence" }))).toBe(
      false,
    );
    expect(Object.keys(taskCommandSpecs()).sort()).toEqual(
      Object.keys(DESCRIPTIONS).sort(),
    );
  });

  test("the create projection returns each resource under its OWN id", () => {
    const [T, E, O, P] = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
    ];
    const draft = draftRow({
      kind: "create_task",
      account_id: ME,
      target_resource_ids: [T, E, O, P],
      command: {
        command: {
          kind: "create_task",
          id: T,
          execution_id: E,
          title: "Brush",
          definition: def,
        },
      },
    });
    expect(projectCreateTask(draft, T)).toMatchObject({
      id: T,
      kind: "task",
      label: "Brush",
    });
    expect(projectCreateTask(draft, E)).toMatchObject({
      id: E,
      kind: "execution",
      parent_id: T,
    });
    expect(projectCreateTask(draft, O)).toMatchObject({
      id: O,
      kind: "occurrence",
      parent_id: E,
      value: { participants: [ME], slot: { key: "once", date: "2026-09-08" } },
    });
    expect(projectCreateTask(draft, P)).toMatchObject({
      id: P,
      kind: "progress",
      parent_id: O,
    });
  });

  test("rebuild: a checkbox record takes the reviewed version and a new entry id; without a current read it is declined", () => {
    const specs = taskCommandSpecs();
    const draft = draftRow({
      kind: "record",
      endpoint: "/task-commands",
      target_resource_ids: ["p", "o"],
      command: {
        command: {
          kind: "record",
          occurrence_id: "o",
          subject_account_id: ME,
          entry_id: "e",
          evidence: { kind: "checkbox", complete: true },
          expected_version: 2,
          happened_at: 9,
        },
      },
    });
    expect(specs.record?.rebuild?.(draft, null)).toBeNull();
    const rebuilt = specs.record?.rebuild?.(draft, {
      id: "p",
      version: 7,
    } as never);
    const command = (
      (rebuilt as NonNullable<typeof rebuilt>).build({}).command as {
        command: Record<string, unknown>;
      }
    ).command;
    expect(command).toMatchObject({ expected_version: 7, happened_at: 9 });
    expect(command.entry_id).not.toBe("e");
  });
});
