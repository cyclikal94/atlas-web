import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import type {
  RotaConsentCommand,
  SetRotaCommand,
  TasksResult,
} from "../../../src/features/tasks/api";
import { ROTA_COPY } from "../../../src/features/tasks/detail/Rota";
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

  test("next dates by cadence, the month's end kept", () => {
    expect(nextDates(daily, "2026-10-30", 3)).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(
      nextDates(
        {
          ...daily,
          schedule: {
            ...daily.schedule,
            repeat: { frequency: "monthly", interval: 1 },
          },
        },
        "2026-01-31",
        2,
      ),
    ).toEqual(["2026-02-28", "2026-03-28"]);
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
