import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import type {
  RotaConsentCommand,
  SetRotaCommand,
  TasksResult,
} from "../../../src/features/tasks/api";
import { ROTA_COPY, useRota } from "../../../src/features/tasks/detail/Rota";
import { TasksEnvProvider } from "../../../src/features/tasks/env";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  RotaState,
  TaskDefinition,
  TaskResult,
} from "../../../src/features/tasks/model/contract";
import { parseRotaState } from "../../../src/features/tasks/model/contract";
import {
  addTo,
  MAX_ROSTER,
  move,
  nextDates,
  nextOrdinal,
  project,
  removeFrom,
} from "../../../src/features/tasks/model/rota";
import { installMatchMedia } from "../../helpers/match-media";
import {
  fakeApi,
  ME,
  mountTasks,
  OTHER,
  type SeededTask,
  seededTask,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * Rotas (A17; CM-356; TASK-15, 29, 32; WF-TASK-05; D-10c-9/11): the roster's operations and projection (pure), and the panel and dialog
 * over the production screens: online-only access commands with one attempt per body, never queued; consent needs my enrolment; the
 * order dialog's projection, refusals and conflict. FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});

const THIRD = "33333333-3333-4333-8333-333333333333";
const daily: TaskDefinition = {
  schedule: {
    start_date: "2026-10-01",
    time: null,
    timezone: "UTC",
    repeat: { frequency: "daily", interval: 1 },
  },
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "anyone",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: false,
};

describe("the model (pure)", () => {
  test("roster operations: unique, at most 8, moves stop at the ends", () => {
    let order: string[] = [];
    for (let i = 0; i < MAX_ROSTER + 2; i += 1)
      order = addTo(
        order,
        `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
    expect(order).toHaveLength(MAX_ROSTER);
    expect(addTo([ME], ME)).toEqual([ME]);
    expect(move([ME, OTHER], ME, -1)).toEqual([ME, OTHER]);
    expect(move([ME, OTHER], ME, 1)).toEqual([OTHER, ME]);
    expect(removeFrom([ME, OTHER], ME)).toEqual([OTHER]);
  });

  test("MU-10C-27: an unsaved order projects from the first place (saving resets the next turn); the saved one from the next ordinal", () => {
    expect(
      project({
        order: [ME, OTHER],
        saved: false,
        ordinal: 1,
        count: 3,
        eligible: null,
      }).map((p) => (p.kind === "none" ? null : p.accountId)),
    ).toEqual([ME, OTHER, ME]);
    expect(
      project({
        order: [ME, OTHER],
        saved: true,
        ordinal: 1,
        count: 3,
        eligible: null,
      }).map((p) => (p.kind === "none" ? null : p.accountId)),
    ).toEqual([OTHER, ME, OTHER]);
    // Someone not agreed (known to an editor) is left open, never handed to another.
    expect(
      project({
        order: [ME, OTHER],
        saved: true,
        ordinal: 0,
        count: 2,
        eligible: [ME],
      })[1],
    ).toEqual({
      kind: "open",
      accountId: OTHER,
    });
    // TASK-29: an empty order sets no turns.
    expect(
      project({ order: [], saved: true, ordinal: 0, count: 1, eligible: null }),
    ).toEqual([{ kind: "none" }]);
  });

  test("the next ordinal follows the latest turn set under the CURRENT roster version, else 0", () => {
    const turns = [
      {
        occurrenceId: "b",
        date: "2026-10-03",
        accountId: OTHER,
        revision: 2,
        ordinal: 5,
      },
      {
        occurrenceId: "a",
        date: "2026-10-02",
        accountId: ME,
        revision: 2,
        ordinal: 4,
      },
    ];
    expect(nextOrdinal(turns, { version: 2 })).toBe(6);
    expect(nextOrdinal(turns, { version: 3 })).toBe(0);
  });

  // Revision 1 (review R5): the dates are the server's (`schedule.rs` `slots`): each from the schedule's OWN start, a missing day skipped.
  // The oracle is the backend's own test `date_only_month_end_leap_day_and_bounded_pagination` (`crates/core/tests/cases/tasks/domain.rs`
  // at the pinned 4396c99): monthly from 31 January gives 31 March and 31 May; yearly from 29 February 2024 gives 29 February 2028. The
  // earlier assertion here (28 February, then 28 March) encoded the defect: a clamped date taken as the next anchor drifts.
  const cadence = (
    start: string,
    frequency: "daily" | "weekly" | "monthly" | "yearly",
    interval = 1,
  ): TaskDefinition => ({
    ...daily,
    schedule: {
      ...daily.schedule,
      start_date: start,
      repeat: { frequency, interval },
    },
  });
  test("next dates are the server's: from the schedule's own start, a day that does not exist skipped, never clamped", () => {
    expect(nextDates(daily, "2026-10-30", 3)).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(
      nextDates(cadence("2026-01-31", "monthly"), "2026-01-31", 3),
    ).toEqual(["2026-03-31", "2026-05-31", "2026-07-31"]);
    // A later known day keeps the anchor's day of the month (no drift after a short month).
    expect(
      nextDates(cadence("2026-01-31", "monthly"), "2026-05-31", 2),
    ).toEqual(["2026-07-31", "2026-08-31"]);
    expect(nextDates(cadence("2024-02-29", "yearly"), "2024-02-29", 2)).toEqual(
      ["2028-02-29", "2032-02-29"],
    );
    expect(
      nextDates(cadence("2026-01-31", "monthly", 2), "2026-01-31", 2),
    ).toEqual(["2026-03-31", "2026-05-31"]);
  });

  test("next dates stay on the schedule's grid whatever the known day (interval > 1, weekly)", () => {
    // Every other day from 1 October: after 2 October the server's next are 3 and 5 October (never 4 and 6).
    expect(
      nextDates(cadence("2026-10-01", "daily", 2), "2026-10-02", 2),
    ).toEqual(["2026-10-03", "2026-10-05"]);
    expect(nextDates(cadence("2026-10-01", "weekly"), "2026-10-09", 2)).toEqual(
      ["2026-10-15", "2026-10-22"],
    );
    // Before the start, the start itself comes first; no repeat or no start date gives none.
    expect(nextDates(cadence("2026-10-01", "daily"), "2026-09-20", 1)).toEqual([
      "2026-10-01",
    ]);
    expect(
      nextDates(
        { ...daily, schedule: { ...daily.schedule, repeat: null } },
        "2026-10-01",
        2,
      ),
    ).toEqual([]);
  });

  test("the rota state parses exactly: at most 8 unique participants, versions at least 0", () => {
    const ok = {
      version: 0,
      participants: [ME],
      consent_version: 1,
      accepted: true,
      eligible_participants: [],
    };
    expect(parseRotaState(ok)).toEqual(ok);
    expect(parseRotaState({ ...ok, participants: [ME, ME] })).toBeNull();
    expect(parseRotaState({ ...ok, version: -1 })).toBeNull();
    expect(parseRotaState({ ...ok, extra: true })).toBeNull();
  });
});

const rota = (over: Partial<RotaState> = {}): TasksResult<RotaState> => ({
  ok: true,
  value: {
    version: 2,
    participants: [ME],
    consent_version: 3,
    accepted: false,
    eligible_participants: [],
    ...over,
  },
});
const enrolled = (active: boolean) =>
  ({
    ok: true,
    value: {
      version: 1,
      active,
      aggregate_consent: true,
      policy: { grants: [], exclude_accounts: [] },
    },
  }) as const;
const path = (task: SeededTask) =>
  `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
const panel = () =>
  document.querySelector("[data-rota-panel]") as HTMLElement | null;

async function anyone(over: Parameters<typeof seededTask>[0] = {}) {
  return seededTask({
    title: "Take the bins out",
    definition: {
      participation: "anyone",
      // seededTask keeps the start date it chose; only the cadence is added.
      schedule: {
        repeat: { frequency: "daily", interval: 1 },
      } as TaskDefinition["schedule"],
    },
    occurrence: { rota: { revision: 2, ordinal: 0, account_id: OTHER } },
    ...over,
  });
}

describe("the panel (A17)", () => {
  test("MU-10C-28: a task that is not Anyone offers no rota at all", async () => {
    const task = await seededTask({ title: "Brush your teeth" });
    const t = await mountTasks({ path: path(task), rows: task.rows });
    await t.until(() => document.querySelector("[data-record-card]") !== null);
    expect(panel()).toBeNull();
  });

  test("the turn of the day; consent is sent online with one key per body, the same key on Try again, and is never queued (MU-10C-25/26)", async () => {
    const task = await anyone();
    const sent: Array<{
      command: RotaConsentCommand | SetRotaCommand;
      key: string;
    }> = [];
    const answers: Array<TasksResult<TaskResult>> = [
      { ok: false, kind: "uncertain" },
      { ok: true, value: { revision: 9 } },
    ];
    const api = fakeApi({
      readRota: async () => rota(),
      readEnrolment: async () => enrolled(true) as never,
      access: async (command, key) => {
        sent.push({ command: command as never, key });
        return answers.shift() ?? { ok: true, value: { revision: 9 } };
      },
    });
    const t = await mountTasks({ path: path(task), rows: task.rows, api });
    await t.until(
      () =>
        panel()?.dataset.rotaPanel === "ready" &&
        !(screen.getByLabelText(ROTA_COPY.takeTurns) as HTMLInputElement)
          .disabled,
    );
    expect(panel()?.querySelector("[data-rota-turn]")).toHaveTextContent(
      ROTA_COPY.thisTurn("Someone (2222…)"),
    );
    expect((await axe(panel() as HTMLElement)).violations).toEqual([]);
    fireEvent.click(screen.getByLabelText(ROTA_COPY.takeTurns));
    await t.until(
      () =>
        sent.length === 1 &&
        screen.queryByRole("button", { name: "Try again" }) !== null,
    );
    expect(sent[0]?.command).toEqual({
      kind: "rota_consent",
      task_id: task.taskId,
      expected_version: 3,
      accepted: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await t.until(() => sent.length === 2);
    expect(sent[1]?.key).toBe(sent[0]?.key);
    expect(sent[1]?.command).toEqual(sent[0]?.command);
    expect(t.drafts()).toEqual([]);
  });

  test("offline the consent is disabled with its reason; not enrolled: 'Join this task first'", async () => {
    const task = await anyone();
    const offline = await mountTasks({
      path: path(task),
      rows: task.rows,
      env: { online: false },
    });
    await offline.until(() => panel() !== null);
    expect(screen.getByLabelText(ROTA_COPY.takeTurns)).toBeDisabled();
    expect(panel()).toHaveTextContent(ROTA_COPY.offline);
    cleanup();
    const api = fakeApi({
      readRota: async () => rota(),
      readEnrolment: async () => enrolled(false) as never,
    });
    const t = await mountTasks({ path: path(task), rows: task.rows, api });
    await t.until(() => (panel()?.textContent ?? "").includes(ROTA_COPY.join));
    expect(screen.getByLabelText(ROTA_COPY.takeTurns)).toBeDisabled();
  });
});

describe("the turn order dialog (A17)", () => {
  async function editor(
    state: Partial<RotaState>,
    access: (c: SetRotaCommand, key: string) => TasksResult<TaskResult>,
  ) {
    const task = await anyone();
    const sent: Array<{ command: SetRotaCommand; key: string }> = [];
    const api = fakeApi({
      readRota: async () => rota(state),
      readEnrolment: async () => enrolled(true) as never,
      access: async (command, key) => {
        sent.push({ command: command as SetRotaCommand, key });
        return access(command as SetRotaCommand, key);
      },
    });
    const t = await mountTasks({ path: path(task), rows: task.rows, api });
    await t.until(
      () =>
        screen.queryByRole("button", { name: ROTA_COPY.order }) !== null &&
        !(
          screen.getByRole("button", {
            name: ROTA_COPY.order,
          }) as HTMLButtonElement
        ).disabled,
    );
    fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.order }));
    await t.until(() => document.querySelector("[data-rota-dialog]") !== null);
    return { t, task, sent };
  }

  test("the order, who could be added, what it gives, and Save sends set_rota at the roster's version", async () => {
    const { t, task, sent } = await editor(
      { participants: [ME], eligible_participants: [ME, OTHER] },
      () => ({ ok: true, value: { revision: 4 } }),
    );
    const dialog = document.querySelector("[data-rota-dialog]") as HTMLElement;
    expect(
      within(dialog).getByText(ROTA_COPY.couldAddNote),
    ).toBeInTheDocument();
    expect(dialog.querySelector("[data-rota-set]")).not.toBeNull();
    expect(
      dialog.querySelectorAll("[data-rota-projected]").length,
    ).toBeGreaterThan(0);
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: `${ROTA_COPY.add}: Someone (2222…)`,
      }),
    );
    expect(dialog.querySelector("[data-rota-count]")).toHaveTextContent(
      ROTA_COPY.count(2),
    );
    fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.save }));
    await t.until(() => sent.length === 1);
    expect(sent[0]?.command).toEqual({
      kind: "set_rota",
      task_id: task.taskId,
      expected_version: 2,
      participants: [ME, OTHER],
    });
    expect(t.drafts()).toEqual([]);
  });

  test("no one eligible: says why there is no order to set", async () => {
    await editor({ participants: [], eligible_participants: [] }, () => ({
      ok: true,
      value: { revision: 1 },
    }));
    expect(
      document.querySelector("[data-rota-none-eligible]"),
    ).toHaveTextContent(ROTA_COPY.noneEligible);
  });

  test("someone changed the order meanwhile: said, the edit kept, never merged", async () => {
    const { t } = await editor(
      {
        participants: [ME, OTHER, THIRD],
        eligible_participants: [ME, OTHER, THIRD],
      },
      () => ({ ok: false, kind: "conflict" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: `${ROTA_COPY.remove}: Someone (3333…)`,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.save }));
    await t.until(
      () => document.querySelector("[data-rota-conflict]") !== null,
    );
    expect(document.querySelector("[data-rota-conflict]")).toHaveTextContent(
      ROTA_COPY.conflict,
    );
    expect(document.querySelector("[data-rota-count]")).toHaveTextContent(
      ROTA_COPY.count(2),
    );
  });
});

/**
 * Revision 1 (review R7): for the person who may set the order (an execution editor) the server FILLS `eligible_participants`, so an empty
 * list is a known answer: nobody has joined and agreed now, and every projected turn is left open (the server leaves it unassigned). Turns
 * already set keep their person. The list is withheld (empty) only for other readers, who are never shown the order dialog.
 */
describe("R7: an empty eligibility list is known, not unknown", () => {
  async function dialogWith(state: Partial<RotaState>) {
    const task = await anyone();
    const api = fakeApi({
      readRota: async () => rota(state),
      readEnrolment: async () => enrolled(true) as never,
    });
    const t = await mountTasks({ path: path(task), rows: task.rows, api });
    await t.until(
      () =>
        screen.queryByRole("button", { name: ROTA_COPY.order }) !== null &&
        !(
          screen.getByRole("button", {
            name: ROTA_COPY.order,
          }) as HTMLButtonElement
        ).disabled,
    );
    fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.order }));
    await t.until(() => document.querySelector("[data-rota-dialog]") !== null);
    return [...document.querySelectorAll("[data-rota-projected]")];
  }

  test("a saved roster and NO ONE eligible now: every projected turn is left open, none names a person", async () => {
    const rows = await dialogWith({
      participants: [ME],
      eligible_participants: [],
    });
    expect(rows.length).toBeGreaterThan(0);
    // "Left open", naming whose place it is; never the turn given to them.
    for (const row of rows)
      expect(row.querySelectorAll("td")[1]?.textContent).toBe(
        `${ROTA_COPY.projected}: ${ROTA_COPY.leftOpen} (${ROTA_COPY.you})`,
      );
    // Turns already set keep their person (from the days this device holds).
    expect(document.querySelector("[data-rota-set]")).not.toBeNull();
  });

  test("control: the same roster with me eligible projects my turns", async () => {
    const rows = await dialogWith({
      participants: [ME],
      eligible_participants: [ME],
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      expect(row.querySelectorAll("td")[1]?.textContent).toBe(
        `${ROTA_COPY.projected}: ${ROTA_COPY.you}`,
      );
  });
});

/**
 * A18 (CM-384; review R9): a rota answer asked under one identity is never shown under another. The first identity's read is answered
 * AFTER the displayed identity changed (same tree, same reader); the turn order it carried, and its consent, are not shown.
 */
describe("A18: a late rota answer across an identity change", () => {
  test("the previous identity's answer, delivered after the change, is dropped; the new identity's own answer is shown", async () => {
    const task = await anyone();
    let release: (r: TasksResult<RotaState>) => void = () => undefined;
    let asked = 0;
    const api = fakeApi({
      readRota: () => {
        asked += 1;
        return asked === 1
          ? new Promise((resolve) => (release = resolve))
          : Promise.resolve(rota({ accepted: false, participants: [] }));
      },
      readEnrolment: async () => enrolled(true) as never,
    });
    const t = await mountTasks({ path: path(task), rows: task.rows, api });
    await t.until(() => asked >= 1);
    t.rerender(tasksEnv(api, { identity: `${ME}:2` }));
    await t.until(() => asked >= 2);
    await t.settle();
    release(rota({ accepted: true, participants: [ME, OTHER] }));
    await t.settle();
    await t.settle();
    const consent = screen.getByLabelText(
      ROTA_COPY.takeTurns,
    ) as HTMLInputElement;
    expect(consent.checked, "the earlier identity's consent is not shown").toBe(
      false,
    );
    // The new identity's own answer is still the one shown (the late answer neither shows nor replaces it).
    expect(consent.disabled, "the new identity's rota is ready").toBe(false);
    // Control: the new identity's read was made and answered.
    expect(asked).toBeGreaterThanOrEqual(2);
  });
});

describe("A18 (hook): one reader across an identity change", () => {
  test("the previous identity's rota, answered after the change under the SAME reader, is never applied; the new identity's is", async () => {
    // The screens remount on another identity, so only the hook's own rule stands between a late answer and the screen here.
    let release: (r: TasksResult<RotaState>) => void = () => undefined;
    let calls = 0;
    const api = fakeApi({
      readRota: () => {
        calls += 1;
        return calls === 1
          ? new Promise((resolve) => (release = resolve))
          : Promise.resolve(rota({ accepted: false, participants: [] }));
      },
      readEnrolment: async () => enrolled(true) as never,
    });
    let env = tasksEnv(api);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TasksEnvProvider value={env}>{children}</TasksEnvProvider>
    );
    const { result, rerender } = renderHook(() => useRota("t-1"), {
      wrapper,
    });
    await act(async () => undefined);
    expect(calls).toBe(1);
    env = tasksEnv(api, { identity: `${ME}:2` });
    rerender();
    await act(async () => undefined);
    expect(calls).toBe(2);
    await act(async () => {
      release(rota({ accepted: true, participants: [ME, OTHER] }));
    });
    expect(result.current.rota.kind).toBe("ready");
    expect(
      result.current.rota.kind === "ready" &&
        result.current.rota.value.accepted,
      "the earlier identity's answer is not applied",
    ).toBe(false);
  });
});
