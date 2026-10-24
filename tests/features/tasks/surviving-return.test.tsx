import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import {
  forgetKeptFixes,
  HISTORY_COPY,
} from "../../../src/features/tasks/detail/EntryHistory";
import { RECORD_COPY } from "../../../src/features/tasks/detail/RecordCard";
import { DETAIL_COPY } from "../../../src/features/tasks/detail/TaskDetail";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { progressId } from "../../../src/features/tasks/model/ids";
import { addDays, windows } from "../../../src/features/tasks/model/time";
import { type TaskVisit, visitHere } from "../../../src/features/tasks/visit";
import { installMatchMedia } from "../../helpers/match-media";
import * as journal from "../../support/tasks/journal";
import {
  ME,
  mountTasks,
  OTHER,
  type SeededTask,
  seededTask,
  TODAY,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * Revision 25 (Review 25 R37, `incomplete_fix` in the family `task-sync-navigation-draft-loss`; design assessment after Review 25, P1-P3,
 * Q1-Q5, Q7). FIXTURE evidence: the app's router (memory history, observed by the task visits) over the PRODUCTION data controller and the
 * IndexedDB double.
 *
 * A task detail React never removed (the person went to the task list and came back before it re-rendered: the old visit ENDED, the same
 * instance is shown again) is the screen the person is at again. Input made there after the return belongs to the visit going on, so a
 * later visit to the sync screens keeps it (WEB-02 ia.md §1.3.3) for every owner: the entry history's open and parked fixes (R37), and the
 * detail's record of the day it shows, which lets go of a day's input when another day is shown in its place (P3). A fix the surviving
 * history still holds from before the departure is shown and kept the same way; nothing an ended visit kept unheld comes back.
 *
 * Every schedule asserts its barriers before its values: the history path, that the old visit ended (or not, at the sync screens), and
 * that it is the SAME DOM instance the person returns to. Durable writes are read from the outbox, and navigation writes nothing.
 */
installMatchMedia({ width: 1440 });
const forgetAll = () => {
  forgetKept();
  forgetTaskMemory();
  forgetKeptFixes();
  forgetAllCorrections();
};
afterEach(() => {
  cleanup();
  forgetAll();
});

type Mounted = Awaited<ReturnType<typeof mountTasks>>;
type Schedule =
  | "stay"
  | "full-unmount-tasks"
  | "same-instance-sync"
  | "same-instance-tasks";

const IDENTITY = `${ME}:1`;
const SYNC = { to: "/sync", search: { tab: "queue" } } as const;
const ENTRY = "80000000-0000-4000-8000-0000000000e1";
const newValue = `${HISTORY_COPY.newValue} (cups)`;
const amount = `${RECORD_COPY.amount} (cups)`;
const historyNode = () =>
  document.querySelector("[data-entry-history]") as HTMLElement | null;
const detailShown = () => document.querySelector("[data-task-detail]") !== null;
const recordCard = () => document.querySelector("[data-record-card]");
const daySelect = () =>
  document.querySelector(
    "[data-day-picker] select",
  ) as HTMLSelectElement | null;
function field(label: string): HTMLInputElement {
  const found = screen.queryByLabelText(label, { exact: true });
  expect(found, `the field "${label}"`).not.toBeNull();
  return found as HTMLInputElement;
}
function press(name: string) {
  const found = screen.queryByRole("button", { name });
  expect(found, `the button "${name}"`).not.toBeNull();
  fireEvent.click(found as HTMLElement);
}
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });
const records = (t: Mounted) =>
  t
    .bodies()
    .map((b) => b.command.command)
    .filter((c) => c.kind === "record");

async function toSync(t: Mounted) {
  await act(async () => {
    await t.router.navigate(SYNC);
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe("/sync");
}
async function to(t: Mounted, path: string, search: object = {}) {
  await act(async () => {
    await t.router.navigate({ to: path, search } as never);
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe(path);
}
async function back(t: Mounted, expected: string) {
  await act(async () => {
    t.router.history.back();
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe(expected);
}

/**
 * Away and back IN ONE REACT TURN: the screen's DOM is never removed. `/tasks` ends the old visit; `/sync` continues it. Asserts the history
 * path, the visit's end and the surviving instance (the entry history's node) before returning.
 */
async function sameInstance(
  t: Mounted,
  where: "/tasks" | "/sync",
  path: string,
  search: object = {},
) {
  const original = historyNode();
  expect(original, "precondition: a history is shown").not.toBeNull();
  const prior: TaskVisit = visitHere(IDENTITY, path);
  await act(async () => {
    void t.router.navigate(
      (where === "/sync" ? SYNC : { to: where, search: {} }) as never,
    );
    expect(t.router.history.location.pathname).toBe(where);
    expect(
      document.contains(original),
      "still mounted after the departure",
    ).toBe(true);
    expect(prior.ended(), "only an ordinary departure ends the visit").toBe(
      where === "/tasks",
    );
    void t.router.navigate({ to: path, search } as never);
  });
  await t.settle();
  expect(t.router.history.location.pathname).toBe(path);
  expect(historyNode(), "the same history instance is returned to").toBe(
    original,
  );
  return prior;
}

/** A numeric task with one own recent entry of 1 cup (offline: a recent entry is fixable), at its plain address. */
async function detail() {
  const task = await seededTask({
    definition: {
      goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
    },
    progress: {
      recent_entries: [
        {
          id: ENTRY,
          evidence: { kind: "quantity", amount: "1" },
          happened_at: Math.floor(Date.now() / 1000),
          recorded_by: ME,
        },
      ] as never,
      entry_count: 1,
      action: { outcome: "incomplete", amount: "1", checked: [] },
    },
  });
  const path = `/tasks/${task.taskId}`;
  const t = await mountTasks({ path, rows: task.rows, env: { online: false } });
  await t.until(
    () => screen.queryByRole("button", { name: HISTORY_COPY.fix }) !== null,
  );
  return { t, task, path };
}

/** The schedule before any input: stays, a full unmount and new visit, or the same instance back from the sync screens or the task list. */
async function arrive(t: Mounted, path: string, schedule: Schedule) {
  if (schedule === "full-unmount-tasks") {
    const original = historyNode();
    await to(t, "/tasks");
    expect(document.contains(original), "the history was removed").toBe(false);
    await to(t, path);
    await t.until(
      () => screen.queryByRole("button", { name: HISTORY_COPY.fix }) !== null,
    );
  } else if (schedule === "same-instance-sync")
    await sameInstance(t, "/sync", path);
  else if (schedule === "same-instance-tasks")
    await sameInstance(t, "/tasks", path);
  expect(t.bodies(), "navigation writes nothing").toEqual([]);
}

/** The subsequent full visit to the sync screens and Back: the history is removed and mounted again; navigation writes nothing. */
async function syncAndBack(t: Mounted, path: string) {
  const before = historyNode();
  const written = t.bodies();
  await toSync(t);
  expect(document.contains(before), "the history was removed").toBe(false);
  await back(t, path);
  await t.until(() => historyNode() !== null);
  expect(t.bodies(), "navigation writes nothing").toEqual(written);
}

const savedFix = (task: SeededTask, value: string) =>
  expect.objectContaining({
    kind: "record",
    occurrence_id: task.occurrenceId,
    subject_account_id: ME,
    replaces: ENTRY,
    evidence: { kind: "quantity", amount: value },
  });

describe("R37 Q1: an entry fix opened after the return is kept through a later sync visit", () => {
  for (const schedule of [
    "stay",
    "full-unmount-tasks",
    "same-instance-sync",
    "same-instance-tasks",
  ] as const)
    test(`${schedule}: 7.125 typed after it is open again after Sync and Back; one explicit save replaces the entry`, async () => {
      const { t, task, path } = await detail();
      await arrive(t, path, schedule);
      press(HISTORY_COPY.fix);
      type(newValue, "7.125");
      await syncAndBack(t, path);
      const restored = screen.queryByLabelText(newValue, { exact: true });
      expect(restored, "the fix is open again").not.toBeNull();
      expect((restored as HTMLInputElement).value).toBe("7.125");
      press(HISTORY_COPY.fixSave);
      await t.settle();
      expect(records(t)).toEqual([savedFix(task, "7.125")]);
    });

  test("same-instance-tasks: the closed state is not the loss (reopening shows 7.125, not the entry's 1)", async () => {
    const { t, path } = await detail();
    await arrive(t, path, "same-instance-tasks");
    press(HISTORY_COPY.fix);
    type(newValue, "7.125");
    await syncAndBack(t, path);
    if (screen.queryByLabelText(newValue, { exact: true }) === null)
      press(HISTORY_COPY.fix);
    expect(field(newValue).value).toBe("7.125");
  });

  test("same-instance-tasks: two sync visits in a row keep it; the visit after the return goes on at the sync screens", async () => {
    const { t, task, path } = await detail();
    await arrive(t, path, "same-instance-tasks");
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    await syncAndBack(t, path);
    type(newValue, "8");
    await syncAndBack(t, path);
    expect(field(newValue).value).toBe("8");
    press(HISTORY_COPY.fixSave);
    await t.settle();
    expect(records(t)).toEqual([savedFix(task, "8")]);
  });

  test("same-instance-tasks twice: the second return's visit owns it", async () => {
    const { t, path } = await detail();
    await arrive(t, path, "same-instance-tasks");
    await sameInstance(t, "/tasks", path);
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    await syncAndBack(t, path);
    expect(field(newValue).value).toBe("7");
  });

  test("control: Cancel after the return discards it; Sync and Back bring nothing; Fix starts from 1", async () => {
    const { t, path } = await detail();
    await arrive(t, path, "same-instance-tasks");
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    press(HISTORY_COPY.cancel);
    await syncAndBack(t, path);
    expect(screen.queryByLabelText(newValue, { exact: true })).toBeNull();
    press(HISTORY_COPY.fix);
    expect(field(newValue).value).toBe("1");
  });

  test("control: after the return, an ordinary departure that removes the history ends it: back, no fix open, Fix starts from 1", async () => {
    const { t, path } = await detail();
    await arrive(t, path, "same-instance-tasks");
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    await to(t, "/today");
    await back(t, path);
    await t.until(() => historyNode() !== null);
    expect(screen.queryByLabelText(newValue, { exact: true })).toBeNull();
    press(HISTORY_COPY.fix);
    expect(field(newValue).value).toBe("1");
    expect(t.bodies()).toEqual([]);
  });

  test("control: an ordinary departure that never comes back to the address does not renew it (Sync from the task list, Back twice)", async () => {
    const { t, path } = await detail();
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    // An ordinary navigation removes the history and ends its visit; the sync screens visited from elsewhere renew nothing.
    await to(t, "/tasks");
    await toSync(t);
    await back(t, "/tasks");
    await back(t, path);
    await t.until(() => historyNode() !== null);
    expect(screen.queryByLabelText(newValue, { exact: true })).toBeNull();
    expect(t.bodies()).toEqual([]);
  });

  test("identity: the fix kept after the return is the displayed identity's; another identity's history forgets it", async () => {
    const { t, path } = await detail();
    await arrive(t, path, "same-instance-tasks");
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    await toSync(t);
    t.rerender(tasksEnv(t.api, { online: false, identity: `${OTHER}:1` }));
    await t.settle();
    await back(t, path);
    await t.until(detailShown);
    expect(screen.queryByLabelText(newValue, { exact: true })).toBeNull();
    expect(t.bodies()).toEqual([]);
  });
});

describe("R37 Q1: a fix the surviving history holds from BEFORE the departure", () => {
  test("typed before, still shown after the same-instance return: kept by the visit going on through Sync and Back", async () => {
    const { t, task, path } = await detail();
    press(HISTORY_COPY.fix);
    type(newValue, "6");
    const prior = await sameInstance(t, "/tasks", path);
    expect(prior.ended()).toBe(true);
    expect(field(newValue).value, "shown on the surviving history").toBe("6");
    await syncAndBack(t, path);
    expect(field(newValue).value).toBe("6");
    press(HISTORY_COPY.fixSave);
    await t.settle();
    expect(records(t)).toEqual([savedFix(task, "6")]);
  });

  test("control: typed before, the history removed by the departure: nothing comes back (the ended visit's input)", async () => {
    const { t, path } = await detail();
    press(HISTORY_COPY.fix);
    type(newValue, "6");
    await arrive(t, path, "full-unmount-tasks");
    expect(screen.queryByLabelText(newValue, { exact: true })).toBeNull();
    await syncAndBack(t, path);
    expect(screen.queryByLabelText(newValue, { exact: true })).toBeNull();
  });
});

describe("R37 Q3: a fix save around the surviving return", () => {
  /** Holds the next enqueue's acknowledgement until `release()`; the write commits first unless `refuse`. */
  function holdNext(t: Mounted, refuse = false) {
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("setup: no outbox");
    const real = outbox.enqueue.bind(outbox);
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const state = { committed: false };
    let used = false;
    outbox.enqueue = async (request) => {
      if (used) return real(request);
      used = true;
      if (refuse) {
        await gate;
        return { kind: "refused", reason: "quota" } as never;
      }
      const result = await real(request);
      state.committed = true;
      await gate;
      return result;
    };
    return { state, release: () => open() };
  }

  for (const newer of [null, "9"])
    test(`saved after the return, pending through Sync, acknowledged there${newer ? `, ${newer} typed meanwhile` : ""}: ${newer ? "the newer value stays" : "closed"}; one record`, async () => {
      const { t, task, path } = await detail();
      await arrive(t, path, "same-instance-tasks");
      const gate = holdNext(t);
      press(HISTORY_COPY.fix);
      type(newValue, "7");
      press(HISTORY_COPY.fixSave);
      await t.until(() => gate.state.committed);
      if (newer !== null) type(newValue, newer);
      await toSync(t);
      await act(async () => gate.release());
      await t.settle();
      await back(t, path);
      await t.until(() => historyNode() !== null);
      if (newer === null)
        expect(screen.queryByLabelText(newValue, { exact: true })).toBeNull();
      else expect(field(newValue).value).toBe(newer);
      expect(records(t)).toEqual([savedFix(task, "7")]);
    });

  test("refused while the person is at the sync screens: 7 is kept after Back; Save again writes it once", async () => {
    const { t, task, path } = await detail();
    await arrive(t, path, "same-instance-tasks");
    const gate = holdNext(t, true);
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    press(HISTORY_COPY.fixSave);
    await t.settle();
    await toSync(t);
    await act(async () => gate.release());
    await t.settle();
    await back(t, path);
    await t.until(() => historyNode() !== null);
    expect(field(newValue).value).toBe("7");
    expect(records(t)).toEqual([]);
    press(HISTORY_COPY.fixSave);
    await t.settle();
    expect(records(t)).toEqual([savedFix(task, "7")]);
  });

  test("saved before the departure, acknowledged on the surviving history after the return: closed; the next fix typed is kept through Sync", async () => {
    const { t, task, path } = await detail();
    const gate = holdNext(t);
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    press(HISTORY_COPY.fixSave);
    await t.until(() => gate.state.committed);
    await sameInstance(t, "/tasks", path);
    await act(async () => gate.release());
    await t.settle();
    expect(screen.queryByLabelText(newValue, { exact: true })).toBeNull();
    expect(records(t)).toEqual([savedFix(task, "7")]);
    // The fixed entry is corrected now (its own pending replacement): fixes of it are not offered; nothing more to keep from it.
    expect(screen.queryByRole("button", { name: HISTORY_COPY.fix })).toBeNull();
    await syncAndBack(t, path);
    expect(records(t)).toHaveLength(1);
  });
});

describe("R37 Q2: a full-history fix parked after the surviving return", () => {
  const mounted = () =>
    journal.mountWith(() => journal.journalOf(20), [journal.entry(20)]);
  const at = (j: journal.Journaled) =>
    `/tasks/${j.task.taskId}?occurrence=${j.task.occurrenceId}`;
  /** The same-instance return to the journal's address (its day in the address). */
  const survive = (j: journal.Journaled) =>
    sameInstance(j.t, "/tasks", `/tasks/${j.task.taskId}`, {
      occurrence: j.task.occurrenceId,
    });
  async function syncBack(j: journal.Journaled) {
    await toSync(j.t);
    await back(j.t, `/tasks/${j.task.taskId}`);
    await j.t.until(() => historyNode() !== null);
    expect(j.t.router.state.location.href).toContain(at(j).split("?")[1]);
    expect(journal.records(j.t)).toHaveLength(0);
  }

  test(
    "opened, typed and parked (Back to recent) after the return: after Sync and Back the entry's next Fix has 987; Save replaces entry 5 once",
    journal.SLOW,
    async () => {
      const j = await mounted();
      await survive(j);
      await journal.click(j.t, HISTORY_COPY.full);
      await journal.fix(j.t, 5);
      await journal.type(j.t, "987");
      await journal.click(j.t, HISTORY_COPY.recent);
      expect(journal.forms()).toHaveLength(0);
      await syncBack(j);
      await journal.click(j.t, HISTORY_COPY.full);
      await journal.fix(j.t, 5);
      expect(journal.valueInput()?.value).toBe("987");
      await journal.save(j.t);
      const saved = journal.records(j.t).map((b) => b.command.command);
      expect(saved).toEqual([
        expect.objectContaining({
          replaces: journal.entryId(5),
          evidence: { kind: "quantity", amount: "987" },
        }),
      ]);
    },
  );

  test(
    "parked BEFORE the departure and held by the surviving history: kept through Sync after the return",
    journal.SLOW,
    async () => {
      const j = await mounted();
      await journal.click(j.t, HISTORY_COPY.full);
      await journal.fix(j.t, 5);
      await journal.type(j.t, "987");
      await journal.click(j.t, HISTORY_COPY.recent);
      await survive(j);
      await syncBack(j);
      await journal.click(j.t, HISTORY_COPY.full);
      await journal.fix(j.t, 5);
      expect(journal.valueInput()?.value).toBe("987");
    },
  );

  test(
    "control: parked, then an ordinary departure that removes the history: a later visit's Fix shows the entry's 5",
    journal.SLOW,
    async () => {
      const j = await mounted();
      await journal.click(j.t, HISTORY_COPY.full);
      await journal.fix(j.t, 5);
      await journal.type(j.t, "987");
      await journal.click(j.t, HISTORY_COPY.recent);
      await to(j.t, "/tasks");
      await to(j.t, `/tasks/${j.task.taskId}`, {
        occurrence: j.task.occurrenceId,
      });
      await j.t.until(() => historyNode() !== null);
      await syncBack(j);
      await journal.click(j.t, HISTORY_COPY.full);
      await journal.fix(j.t, 5);
      expect(journal.valueInput()?.value).toBe("5");
    },
  );

  test(
    "control: parked after the return and then cancelled when reopened: Sync and Back bring nothing back",
    journal.SLOW,
    async () => {
      const j = await mounted();
      await survive(j);
      await journal.click(j.t, HISTORY_COPY.full);
      await journal.fix(j.t, 5);
      await journal.type(j.t, "987");
      await journal.click(j.t, HISTORY_COPY.recent);
      await journal.click(j.t, HISTORY_COPY.full);
      await journal.fix(j.t, 5);
      await journal.cancel(j.t);
      await syncBack(j);
      await journal.click(j.t, HISTORY_COPY.full);
      await journal.fix(j.t, 5);
      expect(journal.valueInput()?.value).toBe("5");
    },
  );
});

/** A daily task counting cups from `start`, its first day saved with my stream (one recent entry of 1 cup), open for five days after. */
function dailyCups(start: string): Promise<SeededTask> {
  return seededTask({
    date: start,
    definition: {
      schedule: {
        start_date: start,
        time: null,
        timezone: "UTC",
        repeat: { frequency: "daily", interval: 1 },
      } as never,
      goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
      close_days_after: 5,
    },
    progress: {
      recent_entries: [
        {
          id: ENTRY,
          evidence: { kind: "quantity", amount: "1" },
          happened_at: Math.floor(Date.now() / 1000),
          recorded_by: ME,
        },
      ] as never,
      entry_count: 1,
      action: { outcome: "incomplete", amount: "1", checked: [] },
    },
  });
}
/** Another saved day of the task (`id`, dated `date`), with my empty stream there. */
async function anotherDay(
  task: SeededTask,
  id: string,
  date: string,
): Promise<CacheRow[]> {
  const slot = { ...task.data.slot, key: `day-${date}`, date };
  const w = windows(slot, task.data.definition);
  return [
    {
      ...(task.rows[2] as CacheRow),
      id,
      value: {
        ...task.data,
        slot,
        opens_at: w.opens_at,
        closes_at: w.closes_at,
      } as never,
    },
    {
      ...(task.rows[3] as CacheRow),
      id: await progressId(id, ME),
      parent_id: id,
      value: {
        ...((task.rows[3] as CacheRow).value as object),
        recent_entries: [],
        entry_count: 0,
        action: { outcome: "unknown", amount: null, checked: [] },
      } as never,
    },
  ];
}

describe("P3 / Q5: the detail's record of the day it shows, after the surviving return", () => {
  const EARLIER = "eeeeeeee-0000-4000-8000-0000000000c5";
  /**
   * Day A (two days ago, the default: the latest saved day) and day B (three days ago, EARLIER). The detail is opened at B's address. In the
   * schedule, after the return: an amount typed on B; the sync screens; then the task's plain address (the default, A, shown in B's place,
   * so B's input is let go as any day shown in place is); then B picked again from the picker: B must start blank.
   */
  async function run(schedule: "full-unmount-tasks" | "same-instance-tasks") {
    const task = await dailyCups(addDays(TODAY, -2));
    const path = `/tasks/${task.taskId}`;
    const atB = { occurrence: EARLIER };
    const t = await mountTasks({
      path: `${path}?occurrence=${EARLIER}`,
      rows: [
        ...task.rows,
        ...(await anotherDay(task, EARLIER, addDays(TODAY, -3))),
      ],
      env: { online: false },
    });
    await t.until(
      () => recordCard() !== null && daySelect()?.value === EARLIER,
    );
    if (schedule === "same-instance-tasks")
      await sameInstance(t, "/tasks", path, atB);
    else {
      await to(t, "/tasks");
      await to(t, path, atB);
    }
    await t.until(
      () => recordCard() !== null && daySelect()?.value === EARLIER,
    );
    type(amount, "7.125");
    await toSync(t);
    await to(t, path);
    await t.until(
      () => recordCard() !== null && daySelect()?.value === task.occurrenceId,
    );
    expect(field(amount).value, "day A is blank").toBe("");
    await act(async () => {
      fireEvent.change(daySelect() as HTMLSelectElement, {
        target: { value: EARLIER },
      });
    });
    await t.settle();
    await t.until(
      () => recordCard() !== null && daySelect()?.value === EARLIER,
    );
    return t;
  }

  test("control (a new visit after a full unmount): B is blank when picked again; nothing written", async () => {
    const t = await run("full-unmount-tasks");
    expect(field(amount).value).toBe("");
    expect(t.bodies()).toEqual([]);
  });

  test("the same instance returned to: B is blank when picked again (B was let go when A was shown in its place); nothing written", async () => {
    const t = await run("same-instance-tasks");
    expect(field(amount).value).toBe("");
    expect(t.bodies()).toEqual([]);
  });

  test("control: an amount typed on B after the return and the sync screens' Back to B: still there", async () => {
    const task = await dailyCups(addDays(TODAY, -2));
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path: `${path}?occurrence=${EARLIER}`,
      rows: [
        ...task.rows,
        ...(await anotherDay(task, EARLIER, addDays(TODAY, -3))),
      ],
      env: { online: false },
    });
    await t.until(
      () => recordCard() !== null && daySelect()?.value === EARLIER,
    );
    await sameInstance(t, "/tasks", path, { occurrence: EARLIER });
    type(amount, "7.125");
    await toSync(t);
    await back(t, path);
    await t.until(
      () => recordCard() !== null && daySelect()?.value === EARLIER,
    );
    expect(field(amount).value).toBe("7.125");
    expect(t.bodies()).toEqual([]);
  });

  /**
   * Day A (the default) shown at the plain address. After the return: an amount typed on A, A removed by a committed page (unavailable,
   * input held), "Show this task's days" PARKS A and shows B in its place; the sync screens and Back; A restored and picked again: A's
   * amount is there (a parked day stays the visit's until it ends). The renewed screen must park A on the visit going on, not the ended one.
   */
  for (const schedule of ["full-unmount-tasks", "same-instance-tasks"] as const)
    test(`${schedule === "full-unmount-tasks" ? "control (a new visit after a full unmount)" : "the same instance returned to"}: A parked after the return keeps its amount through Sync and Back`, async () => {
      const task = await dailyCups(addDays(TODAY, -2));
      const path = `/tasks/${task.taskId}`;
      const t = await mountTasks({
        path,
        rows: [
          ...task.rows,
          ...(await anotherDay(task, EARLIER, addDays(TODAY, -3))),
        ],
        env: { online: false },
      });
      const onA = () =>
        recordCard() !== null && daySelect()?.value === task.occurrenceId;
      await t.until(onA);
      if (schedule === "same-instance-tasks")
        await sameInstance(t, "/tasks", path);
      else {
        await to(t, "/tasks");
        await to(t, path);
      }
      await t.until(onA);
      type(amount, "7.125");
      await t.commitSync([], [task.occurrenceId]);
      await t.settle();
      press(DETAIL_COPY.showDays);
      // One saved day left: no picker, the card is B's.
      await t.until(() => recordCard() !== null);
      expect(daySelect()?.value ?? EARLIER).toBe(EARLIER);
      await toSync(t);
      await back(t, path);
      await t.until(() => detailShown() && recordCard() !== null);
      await t.commitSync([task.rows[2] as CacheRow]);
      await t.settle();
      await t.until(() => daySelect() !== null);
      await act(async () => {
        fireEvent.change(daySelect() as HTMLSelectElement, {
          target: { value: task.occurrenceId },
        });
      });
      await t.settle();
      await t.until(onA);
      expect(field(amount).value).toBe("7.125");
      expect(t.bodies()).toEqual([]);
    });
});
