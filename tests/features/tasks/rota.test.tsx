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
import {
  forgetTaskMemory,
  type RotaHold,
  rotaHoldOf,
  rotaReadsOf,
  settleRota,
  startRota,
  subscribeRota,
} from "../../../src/features/tasks/memory";
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
  type Mounted,
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

/**
 * Revision 3 (review R18, family `rota-read-generation-ownership`): one READ owns what the rota shows, not merely its identity and task.
 * REVIEW3 R4, ported (the hook): an earlier read held, a later reload answered (version 3, consent version 4, declined, nobody), then the
 * earlier answer (version 2, consent version 3, accepted, two people) released: the later one stays. The control asks no later read: the
 * held answer is shown. REVIEW3 R4-P, ported (the stable task screen, two reconnects): consent stays declined after the earlier answer.
 */
describe("R18: one read owns what the rota shows", () => {
  test.each([false, true])(
    "REVIEW3 R4 (ported): a later read was answered first = %s",
    async (newer) => {
      let release: (r: TasksResult<RotaState>) => void = () => undefined;
      let calls = 0;
      const old = rota({
        version: 2,
        consent_version: 3,
        accepted: true,
        participants: [ME, OTHER],
      });
      const current = rota({
        version: 3,
        consent_version: 4,
        accepted: false,
        participants: [],
      });
      expect(old.ok && parseRotaState(old.value)).not.toBeNull();
      expect(current.ok && parseRotaState(current.value)).not.toBeNull();
      const api = fakeApi({
        readRota: () =>
          ++calls === 1
            ? new Promise((r) => {
                release = r;
              })
            : Promise.resolve(current),
        readEnrolment: async () => enrolled(true) as never,
      });
      const env = tasksEnv(api);
      const wrapper = ({ children }: { children: ReactNode }) => (
        <TasksEnvProvider value={env}>{children}</TasksEnvProvider>
      );
      const { result } = renderHook(() => useRota("t-1"), { wrapper });
      await act(async () => undefined);
      expect(calls).toBe(1);
      if (newer) {
        await act(async () => result.current.reload());
        expect(calls).toBe(2);
        expect(result.current.rota).toEqual({
          kind: "ready",
          value: current.ok && current.value,
        });
      }
      await act(async () => release(old));
      expect(result.current.rota).toEqual({
        kind: "ready",
        value: newer ? current.ok && current.value : old.ok && old.value,
      });
    },
  );

  test.each([false, true])(
    "REVIEW3 R4-P (ported): on a stable task screen, a later reconnect's read was answered first = %s",
    async (newer) => {
      const task = await anyone();
      let release: ((r: TasksResult<RotaState>) => void) | null = null;
      let gate = false;
      let currentReads = 0;
      const old = rota({
        version: 2,
        consent_version: 3,
        accepted: true,
        participants: [ME, OTHER],
      });
      const current = rota({
        version: 3,
        consent_version: 4,
        accepted: false,
        participants: [],
      });
      const api = fakeApi({
        readRota: () => {
          if (gate) {
            gate = false;
            return new Promise((r) => {
              release = r;
            });
          }
          currentReads += 1;
          return Promise.resolve(current);
        },
        readEnrolment: async () => enrolled(true) as never,
      });
      const t = await mountTasks({ path: path(task), rows: task.rows, api });
      await t.until(
        () => !!document.querySelector("[data-rota-consent]:not(:disabled)"),
      );
      expect(
        (screen.getByLabelText(ROTA_COPY.takeTurns) as HTMLInputElement)
          .checked,
      ).toBe(false);
      t.rerender(tasksEnv(api, { online: false }));
      await t.settle();
      gate = true;
      t.rerender(tasksEnv(api, { online: true }));
      await t.settle();
      expect(release).not.toBeNull();
      if (newer) {
        const before = currentReads;
        t.rerender(tasksEnv(api, { online: false }));
        await t.settle();
        t.rerender(tasksEnv(api, { online: true }));
        await t.settle();
        expect(currentReads).toBe(before + 1);
        expect(
          (screen.getByLabelText(ROTA_COPY.takeTurns) as HTMLInputElement)
            .checked,
        ).toBe(false);
      }
      (release as unknown as (r: TasksResult<RotaState>) => void)(old);
      await t.settle();
      const input = screen.getByLabelText(
        ROTA_COPY.takeTurns,
      ) as HTMLInputElement;
      expect(input.disabled).toBe(false);
      expect(input.checked).toBe(!newer);
    },
  );
});

describe("R18: the other schedules of one read's ownership", () => {
  const old = rota({
    version: 2,
    consent_version: 3,
    accepted: true,
    participants: [ME, OTHER],
  });
  const current = rota({
    version: 3,
    consent_version: 4,
    accepted: false,
    participants: [],
  });
  function hook(api: ReturnType<typeof fakeApi>) {
    let env = tasksEnv(api);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TasksEnvProvider value={env}>{children}</TasksEnvProvider>
    );
    const out = renderHook(() => useRota("t-1"), { wrapper });
    return {
      ...out,
      setOnline: (online: boolean) => {
        env = tasksEnv(api, { online });
        out.rerender();
      },
    };
  }

  test("going offline invalidates the pair on its way: its later answer shows nothing; online again, the new read is shown", async () => {
    let release: (r: TasksResult<RotaState>) => void = () => undefined;
    let calls = 0;
    const api = fakeApi({
      readRota: () =>
        ++calls === 1
          ? new Promise((r) => {
              release = r;
            })
          : Promise.resolve(current),
      readEnrolment: async () => enrolled(true) as never,
    });
    const { result, setOnline } = hook(api);
    await act(async () => undefined);
    await act(async () => setOnline(false));
    expect(result.current.rota).toEqual({ kind: "offline" });
    await act(async () => release(old));
    expect(result.current.rota).toEqual({ kind: "offline" });
    await act(async () => setOnline(true));
    expect(calls).toBe(2);
    expect(result.current.rota).toEqual({
      kind: "ready",
      value: current.ok && current.value,
    });
  });

  test.each([false, true])(
    "an earlier read that FAILS after a later one answered changes nothing; control (no later read): its failure is shown = %s",
    async (newer) => {
      let release: (r: TasksResult<RotaState>) => void = () => undefined;
      let calls = 0;
      const api = fakeApi({
        readRota: () =>
          ++calls === 1
            ? new Promise((r) => {
                release = r;
              })
            : Promise.resolve(current),
        readEnrolment: async () => enrolled(true) as never,
      });
      const { result } = hook(api);
      await act(async () => undefined);
      if (newer) await act(async () => result.current.reload());
      await act(async () => release({ ok: false, kind: "uncertain" } as never));
      expect(result.current.rota).toEqual(
        newer
          ? { kind: "ready", value: current.ok && current.value }
          : { kind: "error" },
      );
    },
  );

  test("the enrolment is the same pair's: an earlier enrolment answer held past a later pair never replaces it", async () => {
    let release: (r: unknown) => void = () => undefined;
    let enrolments = 0;
    const api = fakeApi({
      readRota: async () => current,
      readEnrolment: () =>
        ++enrolments === 1
          ? (new Promise((r) => {
              release = r;
            }) as never)
          : (Promise.resolve(enrolled(false)) as never),
    });
    const { result } = hook(api);
    await act(async () => undefined);
    await act(async () => result.current.reload());
    expect(result.current.enrolled).toBe(false);
    await act(async () => release(enrolled(true)));
    expect(result.current.enrolled).toBe(false);
  });
});

/**
 * Revision 8 (review 8 R33, family `rota-write-attempt-response-ownership`; design assessment Q-R1..Q-R5): an answer settles only the rota
 * attempt it answers. REVIEW8 T13/T15, ported: change A is held, the person goes to Tasks and comes back (the same identity and service),
 * the rota is read at a newer version and a different change B answers uncertain; A's late answer (success, conflict, refusal, uncertain,
 * or none) never takes B's place, so Try again resends B's body AND key. Added: the order's conflict, refusal and uncertain answers; the
 * screen now showing the task is told of an answer to a change another mount sent; the same change asked again while it is pending joins
 * it (one flight, one key); a save the person edited past while it was pending saves but does not close the dialog on the newer edit;
 * Try again sends nothing while the page cannot write; and the owner's own transitions (attempt, not body; identity lifetime; command).
 */
describe("R33: a rota answer settles only its own attempt", () => {
  type Sent = { command: Record<string, unknown>; key: string };
  type Old = "pending" | "uncertain" | "success" | "conflict" | "refused";
  const answerOf = (old: Old): TasksResult<TaskResult> =>
    old === "success"
      ? { ok: true, value: { revision: 9 } }
      : ({
          ok: false,
          kind:
            old === "uncertain"
              ? "uncertain"
              : old === "conflict"
                ? "conflict"
                : "forbidden",
        } as never);

  /** The task screen with a rota whose read follows `state`; the first access call is held until `release`, later ones answer `later`. */
  async function world(
    state: { current: Partial<RotaState> },
    later: () => TasksResult<TaskResult> = () => ({
      ok: false,
      kind: "uncertain",
    }),
  ) {
    const task = await anyone();
    const sent: Sent[] = [];
    let reads = 0;
    let release: (r: TasksResult<TaskResult>) => void = () => undefined;
    const api = fakeApi({
      readRota: async () => {
        reads += 1;
        return rota(state.current);
      },
      readEnrolment: async () => enrolled(true) as never,
      access: async (command, key) => {
        sent.push({ command: command as never, key });
        if (sent.length === 1)
          return new Promise<TasksResult<TaskResult>>((resolve) => {
            release = resolve;
          });
        return later();
      },
    });
    const t = await mountTasks({ path: path(task), rows: task.rows, api });
    const ready = () =>
      panel()?.dataset.rotaPanel === "ready" &&
      !(screen.getByLabelText(ROTA_COPY.takeTurns) as HTMLInputElement)
        .disabled;
    await t.until(ready);
    expect(ready(), "the rota is ready to change").toBe(true);
    const incarnation = t.data.service()?.incarnationId;
    return {
      t,
      task,
      sent,
      reads: () => reads,
      release: (r: TasksResult<TaskResult>) => release(r),
      ready,
      /** Tasks and back, the same identity and service (an ordinary navigation, not a reload). */
      async away() {
        await act(async () => {
          await t.router.navigate({ to: "/tasks" });
        });
        await t.settle();
        expect(panel(), "the task screen was left").toBeNull();
        await act(async () => {
          await t.router.navigate({
            to: `/tasks/${task.taskId}`,
            search: { occurrence: task.occurrenceId },
          } as never);
        });
        await t.until(ready);
        expect(ready(), "back on the task, its rota ready").toBe(true);
        expect(t.data.service()?.incarnationId).toBe(incarnation);
      },
    };
  }
  const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
  async function openOrder(t: Mounted) {
    const opener = screen.queryByRole("button", { name: ROTA_COPY.order });
    expect(opener, "the turn order can be opened").not.toBeNull();
    fireEvent.click(opener as HTMLElement);
    await t.until(() => document.querySelector("[data-rota-dialog]") !== null);
    expect(document.querySelector("[data-rota-dialog]")).not.toBeNull();
  }
  function press(name: string) {
    const button = screen.queryByRole("button", { name });
    expect(button, `"${name}" is offered`).not.toBeNull();
    fireEvent.click(button as HTMLElement);
  }

  test.each<Old>(["pending", "uncertain", "success", "conflict", "refused"])(
    "REVIEW8 T13 (ported): consent B, sent after a return while A was on its way, keeps its key when A answers late = %s",
    async (old) => {
      const state = {
        current: { consent_version: 3, accepted: false } as Partial<RotaState>,
      };
      const w = await world(state);
      fireEvent.click(screen.getByLabelText(ROTA_COPY.takeTurns));
      await w.t.until(() => w.sent.length === 1);
      expect(w.sent.length).toBe(1);
      state.current = { consent_version: 4, accepted: true };
      await w.away();
      expect(screen.getByLabelText(ROTA_COPY.takeTurns)).toBeChecked();
      fireEvent.click(screen.getByLabelText(ROTA_COPY.takeTurns));
      await w.t.until(() => w.sent.length === 2 && tryAgain() !== null);
      expect(w.sent[1]?.command).toEqual({
        kind: "rota_consent",
        task_id: w.task.taskId,
        expected_version: 4,
        accepted: false,
      });
      expect(w.sent[1]?.key).not.toBe(w.sent[0]?.key);
      if (old !== "pending") {
        w.release(answerOf(old));
        await w.t.settle();
      }
      press("Try again");
      await w.t.until(() => w.sent.length === 3);
      expect(w.sent.length).toBe(3);
      expect(w.sent[2]?.command).toEqual(w.sent[1]?.command);
      expect(w.sent[2]?.key, "B's own key, whatever A answered").toBe(
        w.sent[1]?.key,
      );
      expect(w.t.drafts()).toEqual([]);
      if (old === "pending") w.release(answerOf("uncertain"));
    },
  );

  test.each<Old>(["pending", "uncertain", "success", "conflict", "refused"])(
    "REVIEW8 T15 (ported, conflict/refused/uncertain added): order B, saved after a return while A was on its way, keeps its key when A answers late = %s",
    async (old) => {
      const state = {
        current: {
          version: 2,
          participants: [ME],
          eligible_participants: [ME, OTHER],
        } as Partial<RotaState>,
      };
      const w = await world(state);
      await openOrder(w.t);
      press(`${ROTA_COPY.add}: Someone (2222…)`);
      press(ROTA_COPY.save);
      await w.t.until(() => w.sent.length === 1);
      expect(w.sent.length).toBe(1);
      state.current = {
        version: 3,
        participants: [ME, OTHER],
        eligible_participants: [ME, OTHER],
      };
      await w.away();
      await openOrder(w.t);
      press(`${ROTA_COPY.remove}: Someone (2222…)`);
      press(ROTA_COPY.save);
      await w.t.until(() => w.sent.length === 2 && tryAgain() !== null);
      expect(w.sent[1]?.command).toEqual({
        kind: "set_rota",
        task_id: w.task.taskId,
        expected_version: 3,
        participants: [ME],
      });
      expect(w.sent[1]?.key).not.toBe(w.sent[0]?.key);
      if (old !== "pending") {
        w.release(answerOf(old));
        await w.t.settle();
      }
      // A's late answer, a success included, neither closes B's dialog nor puts away its uncertain outcome.
      expect(document.querySelector("[data-rota-dialog]")).not.toBeNull();
      press("Try again");
      await w.t.until(() => w.sent.length === 3);
      expect(w.sent.length).toBe(3);
      expect(w.sent[2]?.command).toEqual(w.sent[1]?.command);
      expect(w.sent[2]?.key, "B's own key, whatever A answered").toBe(
        w.sent[1]?.key,
      );
      expect(w.t.drafts()).toEqual([]);
      if (old === "pending") w.release(answerOf("uncertain"));
    },
  );

  test.each(["uncertain", "success"] as const)(
    "the screen showing the task NOW is told how a change another mount sent was answered = %s",
    async (old) => {
      const state = {
        current: { consent_version: 3, accepted: false } as Partial<RotaState>,
      };
      const w = await world(state);
      fireEvent.click(screen.getByLabelText(ROTA_COPY.takeTurns));
      await w.t.until(() => w.sent.length === 1);
      expect(w.sent.length).toBe(1);
      await w.away();
      const readsBefore = w.reads();
      expect(tryAgain(), "nothing answered yet").toBeNull();
      w.release(answerOf(old));
      if (old === "uncertain") {
        await w.t.until(() => tryAgain() !== null);
        expect(
          tryAgain(),
          "the answer is shown where the person is",
        ).not.toBeNull();
        expect(panel()?.querySelector("[data-rota-note]")).toHaveTextContent(
          ROTA_COPY.uncertain,
        );
        press("Try again");
        await w.t.until(() => w.sent.length === 2);
        expect(w.sent[1]?.command).toEqual(w.sent[0]?.command);
        expect(w.sent[1]?.key, "A's own key").toBe(w.sent[0]?.key);
      } else {
        // Control: a success is read again by the panel now showing the task, and offers nothing to retry.
        await w.t.until(() => w.reads() > readsBefore);
        expect(w.reads()).toBeGreaterThan(readsBefore);
        expect(tryAgain()).toBeNull();
        expect(w.sent.length).toBe(1);
      }
    },
  );

  test("an answer given before the screen mounted is not said again there; its uncertain change still keeps its key for the same body", async () => {
    const state = {
      current: { consent_version: 3, accepted: false } as Partial<RotaState>,
    };
    const w = await world(state);
    fireEvent.click(screen.getByLabelText(ROTA_COPY.takeTurns));
    await w.t.until(() => w.sent.length === 1);
    w.release(answerOf("uncertain"));
    await w.t.until(() => tryAgain() !== null);
    expect(tryAgain(), "said where it was answered").not.toBeNull();
    await w.away();
    expect(tryAgain(), "not said again after a return").toBeNull();
    expect(panel()?.querySelector("[data-rota-note]")).toBeNull();
    fireEvent.click(screen.getByLabelText(ROTA_COPY.takeTurns));
    await w.t.until(() => w.sent.length === 2);
    expect(w.sent[1]?.command).toEqual(w.sent[0]?.command);
    expect(w.sent[1]?.key, "the same body is the same attempt").toBe(
      w.sent[0]?.key,
    );
  });

  test("the same change asked again while it is pending is that change: nothing more is sent, and its answer is the one shown", async () => {
    const state = {
      current: { consent_version: 3, accepted: false } as Partial<RotaState>,
    };
    const w = await world(state);
    fireEvent.click(screen.getByLabelText(ROTA_COPY.takeTurns));
    await w.t.until(() => w.sent.length === 1);
    await w.away();
    // The rota still reads as before A (it is on its way): ticking again is the same body as A.
    fireEvent.click(screen.getByLabelText(ROTA_COPY.takeTurns));
    await w.t.settle();
    expect(w.sent.length, "never a second flight of one change").toBe(1);
    w.release(answerOf("uncertain"));
    await w.t.until(() => tryAgain() !== null);
    press("Try again");
    await w.t.until(() => w.sent.length === 2);
    expect(w.sent[1]?.command).toEqual(w.sent[0]?.command);
    expect(w.sent[1]?.key).toBe(w.sent[0]?.key);
  });

  test.each([true, false])(
    "a save edited past while it was pending saves but keeps the newer edit open; control (not edited) closes the dialog = %s",
    async (edited) => {
      const state = {
        current: {
          version: 2,
          participants: [ME, OTHER],
          eligible_participants: [ME, OTHER, THIRD],
        } as Partial<RotaState>,
      };
      const w = await world(state);
      await openOrder(w.t);
      press(`${ROTA_COPY.add}: Someone (3333…)`);
      press(ROTA_COPY.save);
      await w.t.until(() => w.sent.length === 1);
      if (edited) press(`${ROTA_COPY.remove}: Someone (2222…)`);
      const readsBefore = w.reads();
      state.current = {
        version: 3,
        participants: [ME, OTHER, THIRD],
        eligible_participants: [ME, OTHER, THIRD],
      };
      w.release(answerOf("success"));
      await w.t.until(() => w.reads() > readsBefore);
      await w.t.settle();
      expect(w.reads(), "the rota is read again after the success").toBe(
        readsBefore + 1,
      );
      if (edited) {
        expect(document.querySelector("[data-rota-dialog]")).not.toBeNull();
        const people = [
          ...document.querySelectorAll("[data-rota-order] [data-rota-person]"),
        ].map((li) => li.getAttribute("data-rota-person"));
        expect(people, "the newer edit is still there").toEqual([ME, THIRD]);
      } else expect(document.querySelector("[data-rota-dialog]")).toBeNull();
      expect(w.sent.length).toBe(1);
    },
  );

  test("Try again sends nothing while the page cannot write (its reason said); writable again, it resends the change held", async () => {
    const state = {
      current: { consent_version: 3, accepted: false } as Partial<RotaState>,
    };
    const w = await world(state, () => ({ ok: true, value: { revision: 9 } }));
    fireEvent.click(screen.getByLabelText(ROTA_COPY.takeTurns));
    await w.t.until(() => w.sent.length === 1);
    w.release(answerOf("uncertain"));
    await w.t.until(() => tryAgain() !== null);
    w.t.rerender(tasksEnv(w.t.api, { writable: false }));
    await w.t.settle();
    const blocked = tryAgain() as HTMLButtonElement | null;
    expect(blocked, "Try again is still shown").not.toBeNull();
    expect(blocked?.disabled, "but not while the page cannot write").toBe(true);
    fireEvent.click(blocked as HTMLElement);
    await w.t.settle();
    expect(w.sent.length).toBe(1);
    w.t.rerender(tasksEnv(w.t.api));
    await w.t.settle();
    press("Try again");
    await w.t.until(() => w.sent.length === 2);
    expect(w.sent[1]?.key).toBe(w.sent[0]?.key);
  });

  describe("the owner (`memory.ts`)", () => {
    const I = `${ME}:1`;
    const J = `${OTHER}:1`;
    const body = (accepted: boolean) => ({
      kind: "rota_consent",
      task_id: "t-1",
      expected_version: 3,
      accepted,
    });
    let n = 0;
    const key = () => `k-${++n}`;

    test("an answer settles its attempt, not a body: a later attempt of the same body (a new key) is not settled by the earlier one", () => {
      const a = startRota(I, "t-1:consent", body(true), key).attempt;
      expect(settleRota(I, "t-1:consent", a, { kind: "saved" }, null)).toBe(
        true,
      );
      const c = startRota(I, "t-1:consent", body(true), key);
      expect(c.joined).toBe(false);
      expect(c.attempt.key, "a definite answer ended A's key").not.toBe(a.key);
      expect(settleRota(I, "t-1:consent", a, { kind: "saved" }, null)).toBe(
        false,
      );
      expect(
        settleRota(I, "t-1:consent", a, { kind: "uncertain" }, null),
        "a late uncertain answer never downgrades",
      ).toBe(false);
      expect(rotaHoldOf(I, "t-1:consent").attempt).toBe(c.attempt);
      // Control: C's own answer settles it.
      expect(
        settleRota(I, "t-1:consent", c.attempt, { kind: "uncertain" }, null),
      ).toBe(true);
      expect(rotaHoldOf(I, "t-1:consent").attempt).toMatchObject({
        key: c.attempt.key,
        phase: "uncertain",
      });
    });

    test("an earlier identity's answer neither reaches nor clears another identity's attempt, nor a later activation of its own", () => {
      const a = startRota(I, "t-1:consent", body(true), key).attempt;
      const b = startRota(J, "t-1:consent", body(true), key).attempt;
      expect(settleRota(I, "t-1:consent", a, { kind: "saved" }, "t-1")).toBe(
        false,
      );
      expect(rotaHoldOf(J, "t-1:consent").attempt, "J's attempt stays").toBe(b);
      expect(rotaReadsOf(J, "t-1")).toBe(0);
      // I shown again: a new memory; A's answer reaches nothing there either.
      expect(rotaHoldOf(I, "t-1:consent").attempt).toBeNull();
      expect(settleRota(I, "t-1:consent", a, { kind: "uncertain" }, null)).toBe(
        false,
      );
      expect(rotaHoldOf(I, "t-1:consent").attempt).toBeNull();
    });

    test("a settlement is told once, after it is held: every screen sees the settled hold (no screen is left showing the pending one)", () => {
      const a = startRota(I, "t-1:consent", body(true), key).attempt;
      const seen: Array<RotaHold> = [];
      const stop = subscribeRota(() => seen.push(rotaHoldOf(I, "t-1:consent")));
      expect(settleRota(I, "t-1:consent", a, { kind: "uncertain" }, null)).toBe(
        true,
      );
      expect(seen.length).toBe(1);
      expect(seen[0]?.attempt).toMatchObject({
        key: a.key,
        phase: "uncertain",
      });
      expect(seen[0]?.outcome?.kind).toBe("uncertain");
      // Control: an answer that settles nothing tells nothing.
      expect(settleRota(I, "t-1:consent", a, { kind: "saved" }, null)).toBe(
        false,
      );
      expect(seen.length).toBe(1);
      stop();
    });

    test("a settled change that asks for the rota again is read again by the hook showing it (told, not polled); control: one asking nothing is not", async () => {
      let calls = 0;
      const api = fakeApi({
        readRota: async () => {
          calls += 1;
          return rota();
        },
        readEnrolment: async () => enrolled(true) as never,
      });
      const env = tasksEnv(api);
      const wrapper = ({ children }: { children: ReactNode }) => (
        <TasksEnvProvider value={env}>{children}</TasksEnvProvider>
      );
      renderHook(() => useRota("t-1"), { wrapper });
      await act(async () => undefined);
      expect(calls).toBe(1);
      const a = startRota(env.identity, "t-1:consent", body(true), key).attempt;
      await act(async () => undefined);
      expect(calls, "taking an attempt asks nothing").toBe(1);
      await act(async () => {
        settleRota(env.identity, "t-1:consent", a, { kind: "saved" }, "t-1");
      });
      expect(calls).toBe(2);
      const b = startRota(
        env.identity,
        "t-1:consent",
        body(false),
        key,
      ).attempt;
      await act(async () => {
        settleRota(env.identity, "t-1:consent", b, { kind: "refused" }, null);
      });
      expect(calls).toBe(2);
    });

    test("one command's answer leaves the task's other command alone; the uncertain one keeps its key for the same body", () => {
      const consent = startRota(I, "t-1:consent", body(true), key).attempt;
      const order = startRota(
        I,
        "t-1:order",
        {
          kind: "set_rota",
          task_id: "t-1",
          expected_version: 2,
          participants: [],
        },
        key,
      ).attempt;
      expect(
        settleRota(I, "t-1:consent", consent, { kind: "uncertain" }, null),
      ).toBe(true);
      expect(rotaHoldOf(I, "t-1:order").attempt).toBe(order);
      const again = startRota(I, "t-1:consent", body(true), key);
      expect(again.attempt.key).toBe(consent.key);
      expect(again.attempt.phase).toBe("pending");
      const other = startRota(I, "t-1:consent", body(false), key);
      expect(other.attempt.key, "another body, another key").not.toBe(
        consent.key,
      );
    });
  });
});
