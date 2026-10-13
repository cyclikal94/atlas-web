import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import type { TasksResult } from "../../../src/features/tasks/api";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  OccurrencePage,
  OccurrenceView,
} from "../../../src/features/tasks/model/contract";
import { readWholeDay } from "../../../src/features/tasks/today/useTodayView";
import {
  type AnswerBasis,
  composeRow,
  structureOf,
} from "../../../src/features/tasks/view";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  fakeApi,
  ME,
  mountTasks,
  seededTask,
  TODAY,
} from "../../support/tasks/world";

/**
 * R2 of the review of 13 October 2026 (revision 2; family `task-personal-answer-freshness`, design assessment C1/C2, schedules F1–F4, F6):
 * a row's STRUCTURE and its DERIVED fields have their own provenance. A `/daily` answer is dated by when it was DISPATCHED (delivery does
 * not renew it), belongs to the cache position it was dispatched at, and supplies structure only when it is ahead of the committed cache.
 * Real windows a few seconds ahead of the real clock; no production timer is shortened. Held answers fix the order of events.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});
const PATH = `/today?day=${TODAY}&tz=UTC`;
const row = (id: string) =>
  document.querySelector(`[data-today-row="${id}"]`) as HTMLElement | null;
const pageOf = (items: OccurrenceView[]): TasksResult<OccurrencePage> => ({
  ok: true,
  value: { items, next_after: null, revision: 5, pending_tasks: [] },
});
const waitReal = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  });
const untilLong = async (
  t: Awaited<ReturnType<typeof mountTasks>>,
  ready: () => boolean,
) => {
  for (let i = 0; i < 5 && !ready(); i += 1) await t.until(ready);
};
const SLOW = { timeout: 30_000 };

/** A numeric maximum of five with two recorded: provisional while open, complete once the window closes in `closesIn` seconds. */
async function provisionalTask(closesIn: number) {
  const summary = { outcome: "provisional" as const, amount: "2", checked: [] };
  const closes = Math.floor(Date.now() / 1000) + closesIn;
  const task = await seededTask({
    definition: {
      goal: { kind: "numeric", minimum: null, maximum: "5", unit: "cups" },
    },
    progress: { action: summary, period: summary },
    occurrence: { closes_at: closes },
  });
  const answer = (over: Partial<OccurrenceView> = {}): OccurrenceView => ({
    id: task.occurrenceId,
    version: 1,
    can_edit: true,
    data: task.data,
    outcome: "provisional",
    period_outcome: "provisional",
    actionable: true,
    ...over,
  });
  return { task, closes, answer };
}

/** `/daily` reads that wait until released, by scope, in the order they were dispatched. */
function holdingApi() {
  const api = fakeApi();
  const held: Array<{
    scope: string;
    at: number;
    resolve: (v: TasksResult<OccurrencePage>) => void;
  }> = [];
  let answer: ((scope: string) => TasksResult<OccurrencePage>) | null = null;
  api.readDaily = (q) => {
    api.calls.readDaily = (api.calls.readDaily ?? 0) + 1;
    if (answer !== null) return Promise.resolve(answer(q.scope));
    return new Promise((resolve) =>
      held.push({ scope: q.scope, at: Date.now(), resolve }),
    );
  };
  return {
    api,
    held,
    /** Answers every read from now on at once. */
    answerWith(fn: ((scope: string) => TasksResult<OccurrencePage>) | null) {
      answer = fn;
    },
  };
}

const cachedRow = (over: Partial<CacheRow>): CacheRow => ({
  id: "x",
  kind: "occurrence",
  parent_id: "p",
  label: "Occurrence",
  value: null,
  version: 1,
  can_edit: true,
  archived: false,
  kind_date: null,
  ...over,
});
const item = (over: Partial<OccurrenceView>): OccurrenceView => ({
  id: "x",
  version: 1,
  can_edit: true,
  data: {} as OccurrenceView["data"],
  outcome: "provisional",
  period_outcome: "provisional",
  actionable: true,
  ...over,
});
const basis = (over: Partial<AnswerBasis> = {}): AnswerBasis => ({
  requestedAt: 1_000,
  current: true,
  neverCached: false,
  ...over,
});

describe("structureOf: a row's structure is the daily item's only when it is ahead of the committed cache (C1)", () => {
  test("a newer daily version is ahead; an older one never is", () => {
    expect(
      structureOf(cachedRow({ version: 1 }), item({ version: 2 }), basis())
        .from,
    ).toBe("daily");
    expect(
      structureOf(cachedRow({ version: 3 }), item({ version: 2 }), basis())
        .from,
    ).toBe("cache");
    expect(
      structureOf(
        cachedRow({ version: 3 }),
        item({ version: 2 }),
        basis({ current: false, neverCached: true }),
      ).from,
    ).toBe("cache");
  });

  test("at the same version, the daily item is ahead only when no cache page was committed since its read was dispatched", () => {
    const cached = cachedRow({ version: 2, can_edit: false });
    const daily = item({ version: 2, can_edit: true });
    expect(structureOf(cached, daily, basis()).row?.can_edit).toBe(true);
    expect(
      structureOf(cached, daily, basis({ current: false })).row?.can_edit,
    ).toBe(false);
  });

  test("a daily item the cache lacks: ahead of the delta when current or never held here; never brought back once the cache held it", () => {
    expect(structureOf(null, item({}), basis()).from).toBe("daily");
    expect(
      structureOf(null, item({}), basis({ current: false, neverCached: true }))
        .from,
    ).toBe("daily");
    expect(
      structureOf(null, item({}), basis({ current: false, neverCached: false }))
        .row,
    ).toBeNull();
  });

  test("without an answer the cache is the structure", () => {
    const cached = cachedRow({});
    expect(structureOf(cached, item({ version: 9 }), null)).toEqual({
      row: cached,
      from: "cache",
    });
  });
});

describe("composeRow: the server's personal fields need a current, covering answer of the same version (C1)", () => {
  test("an answer dispatched before the close and composed after it is not my result, however late it was delivered", async () => {
    const { task, closes, answer } = await provisionalTask(-1);
    const sources = {
      occurrenceId: task.occurrenceId,
      progressId: task.progressId,
      occurrence: task.rows[2] ?? null,
      task: task.rows[0] ?? null,
      progress: task.rows[3] ?? null,
      joint: answer(),
      personal: answer(),
    };
    const at = (requestedAt: number) =>
      composeRow(
        { ...sources, answer: basis({ requestedAt }) },
        { drafts: [], attention: [] },
        ME,
        closes * 1000 + 500,
      );
    const before = at(closes * 1000 - 1_000);
    const after = at(closes * 1000 + 100);
    if (before.kind !== "row" || after.kind !== "row") throw new Error("setup");
    expect(before.row.source).toBe("local");
    expect(before.row.outcome).toBe("complete");
    // Control: dispatched after the close, the server's answer is current.
    expect(after.row.source).toBe("server");
  });

  test("a personal item of another version than the structure is not used", async () => {
    const { task, answer } = await provisionalTask(600);
    const composed = (version: number) =>
      composeRow(
        {
          occurrenceId: task.occurrenceId,
          progressId: task.progressId,
          occurrence: { ...(task.rows[2] as CacheRow), version: 2 },
          task: task.rows[0] ?? null,
          progress: task.rows[3] ?? null,
          joint: answer({ version }),
          personal: answer({ version, outcome: "complete" }),
          answer: basis({ requestedAt: Date.now() }),
        },
        { drafts: [], attention: [] },
        ME,
        Date.now(),
      );
    const older = composed(1);
    const same = composed(2);
    if (older.kind !== "row" || same.kind !== "row") throw new Error("setup");
    expect(older.row.source).toBe("local");
    expect(older.row.version).toBe(2);
    expect(same.row.source).toBe("server");
  });

  test("F4: an entry the synced stream already lists is not counted again while the overlay still holds its draft", async () => {
    const entryId = "eeeeeeee-0000-4000-8000-000000000001";
    const task = await seededTask({
      definition: {
        goal: { kind: "numeric", minimum: "5", maximum: null, unit: "cups" },
      },
      progress: {
        action: { outcome: "incomplete", amount: "3", checked: [] },
        period: { outcome: "incomplete", amount: "3", checked: [] },
        recent_entries: [
          {
            id: entryId,
            evidence: { kind: "quantity", amount: "3" },
            happened_at: Math.floor(Date.now() / 1000) - 5,
            recorded_by: ME,
          } as never,
        ],
        entry_count: 1,
      },
    });
    const draft = (id: string) =>
      draftRow({
        local_id: "cccccccc-0000-4000-8000-000000000001",
        created_seq: 1,
        kind: "record",
        endpoint: "/task-commands",
        account_id: ME,
        status: "acknowledged",
        target_resource_ids: [task.progressId, task.occurrenceId],
        index_targets: [task.progressId, task.occurrenceId],
        command: {
          command: {
            kind: "record",
            occurrence_id: task.occurrenceId,
            subject_account_id: ME,
            entry_id: id,
            evidence: { kind: "quantity", amount: "3" },
            happened_at: Math.floor(Date.now() / 1000) - 5,
          },
        },
      });
    const amountWith = (id: string) => {
      const r = composeRow(
        {
          occurrenceId: task.occurrenceId,
          progressId: task.progressId,
          occurrence: task.rows[2] ?? null,
          task: task.rows[0] ?? null,
          progress: task.rows[3] ?? null,
          joint: null,
          personal: null,
        },
        { drafts: [draft(id)], attention: [] },
        ME,
        Date.now(),
      );
      if (r.kind !== "row" || r.row.personal.kind !== "result")
        throw new Error("setup");
      return r.row.personal.action.amount;
    };
    expect(amountWith(entryId)).toBe("3");
    // Control: an entry that has NOT landed is layered on.
    expect(amountWith("eeeeeeee-0000-4000-8000-000000000002")).toBe("6");
  });

  test("a queued change on a row only the daily answer lists composes over the daily structure (never 'unreadable')", async () => {
    const { task, answer } = await provisionalTask(600);
    const r = composeRow(
      {
        occurrenceId: task.occurrenceId,
        progressId: task.progressId,
        occurrence: null,
        task: task.rows[0] ?? null,
        progress: task.rows[3] ?? null,
        joint: answer(),
        personal: answer(),
        answer: basis({ requestedAt: Date.now(), neverCached: true }),
      },
      {
        drafts: [
          draftRow({
            kind: "record",
            endpoint: "/task-commands",
            account_id: ME,
            target_resource_ids: [task.progressId, task.occurrenceId],
            index_targets: [task.progressId, task.occurrenceId],
            command: {
              command: {
                kind: "record",
                occurrence_id: task.occurrenceId,
                subject_account_id: ME,
                entry_id: crypto.randomUUID(),
                evidence: { kind: "quantity", amount: "1" },
                happened_at: Math.floor(Date.now() / 1000),
              },
            },
          }),
        ],
        attention: [],
      },
      ME,
      Date.now(),
    );
    expect(r.kind).toBe("row");
    if (r.kind !== "row") return;
    expect(r.row.structureFrom).toBe("daily");
    expect(r.row.pending).toBe("queued");
  });
});

describe("readWholeDay: a scope's provenance (F3)", () => {
  test("the accepted chain is dated by its dispatch; a 409 restart discards the earlier pages AND their time", async () => {
    const api = fakeApi();
    let clock = 1_000;
    const pages: Array<TasksResult<OccurrencePage>> = [
      {
        ok: true,
        value: { items: [], next_after: "a", revision: 7, pending_tasks: [] },
      },
      { ok: false, kind: "conflict" } as TasksResult<OccurrencePage>,
      {
        ok: true,
        value: { items: [], next_after: "a", revision: 8, pending_tasks: [] },
      },
      {
        ok: true,
        value: { items: [], next_after: null, revision: 8, pending_tasks: [] },
      },
    ];
    api.readDaily = async () => {
      clock += 1_000;
      return pages.shift() as TasksResult<OccurrencePage>;
    };
    const result = await readWholeDay(
      api,
      { day: TODAY, zone: "UTC", scope: "joint", limit: 1 },
      () => true,
      () => undefined,
      () => clock,
    );
    expect(result).toMatchObject({ ok: true, revision: 8, startedAt: 3_000 });
  });

  test("control: an unbroken multi-page chain keeps its first page's dispatch time", async () => {
    const api = fakeApi();
    let clock = 1_000;
    const pages: Array<TasksResult<OccurrencePage>> = [
      {
        ok: true,
        value: { items: [], next_after: "a", revision: 4, pending_tasks: [] },
      },
      {
        ok: true,
        value: { items: [], next_after: null, revision: 4, pending_tasks: [] },
      },
    ];
    api.readDaily = async () => {
      clock += 1_000;
      return pages.shift() as TasksResult<OccurrencePage>;
    };
    const result = await readWholeDay(
      api,
      { day: TODAY, zone: "UTC", scope: "personal", limit: 1 },
      () => true,
      () => undefined,
      () => clock,
    );
    expect(result).toMatchObject({ ok: true, revision: 4, startedAt: 1_000 });
  });
});

describe("Today: an answer dispatched before the close and delivered after it (F1)", () => {
  for (const first of ["joint", "personal"] as const)
    test(
      `delivered ${first} first: finalised from my saved summary, never the provisional server answer`,
      SLOW,
      async () => {
        const { task, closes, answer } = await provisionalTask(3);
        const daily = holdingApi();
        // The daily read is ahead of the occurrence's delta: the cache holds the task and my progress only.
        const t = await mountTasks({
          path: PATH,
          rows: task.rows.filter((r) => r.kind !== "occurrence"),
          api: daily.api,
        });
        expect(daily.held.map((h) => h.scope)).toEqual(
          expect.arrayContaining(["joint", "personal"]),
        );
        expect(daily.held.every((h) => h.at < closes * 1000)).toBe(true);
        await waitReal(closes * 1000 - Date.now() + 300);
        const second = first === "joint" ? "personal" : "joint";
        for (const scope of [first, second]) {
          for (const h of daily.held.filter((x) => x.scope === scope))
            h.resolve(pageOf([answer()]));
          await t.settle();
        }
        await untilLong(
          t,
          () => row(task.occurrenceId)?.dataset.pill === "done",
        );
        expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
        expect(row(task.occurrenceId)?.dataset.source).toBe("local");
        expect(row(task.occurrenceId)?.dataset.structure).toBe("daily");
      },
    );

  test(
    "control: delivered before the close it is the server's, finalised at the close; an answer dispatched after the close is the server's again",
    SLOW,
    async () => {
      const { task, closes, answer } = await provisionalTask(3);
      const daily = holdingApi();
      daily.answerWith(() => pageOf([answer()]));
      const t = await mountTasks({
        path: PATH,
        rows: task.rows.filter((r) => r.kind !== "occurrence"),
        api: daily.api,
      });
      await untilLong(
        t,
        () => row(task.occurrenceId)?.dataset.source === "server",
      );
      expect(row(task.occurrenceId)?.dataset.pill).toBe("on_track");
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      daily.answerWith(null);
      await waitReal(closes * 1000 - Date.now() + 300);
      await untilLong(t, () => row(task.occurrenceId)?.dataset.pill === "done");
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
      // The re-read the boundary caused was dispatched after the close: its answer is current.
      await untilLong(
        t,
        () => daily.held.filter((h) => h.at >= closes * 1000).length >= 2,
      );
      const after = daily.held.filter((h) => h.at >= closes * 1000);
      expect(after.length).toBeGreaterThanOrEqual(2);
      for (const h of after)
        h.resolve(
          pageOf([
            answer({
              outcome: "complete",
              period_outcome: "complete",
              actionable: false,
            }),
          ]),
        );
      await untilLong(
        t,
        () => row(task.occurrenceId)?.dataset.source === "server",
      );
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
    },
  );

  test(
    "an answer already stale when it arrives (the clock was read after the close first) is asked for again, after the boundary",
    SLOW,
    async () => {
      const { task, closes, answer } = await provisionalTask(3);
      const daily = holdingApi();
      const t = await mountTasks({
        path: PATH,
        rows: task.rows.filter((r) => r.kind !== "occurrence"),
        api: daily.api,
      });
      expect(daily.held.length).toBeGreaterThanOrEqual(2);
      await waitReal(closes * 1000 - Date.now() + 300);
      // The page is focused after the close: its clock is read again with nothing listed yet, so no later reading crosses the boundary.
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      for (const h of daily.held.splice(0)) h.resolve(pageOf([answer()]));
      await t.settle();
      await untilLong(t, () => daily.held.some((h) => h.at >= closes * 1000));
      expect(
        daily.held.filter((h) => h.at >= closes * 1000).length,
      ).toBeGreaterThanOrEqual(2);
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
    },
  );
});

describe("Today: a committed occurrence defeats an older daily answer (F2)", () => {
  test(
    "cache first: a committed version 2 whose corrected window has closed wins over the version-1 answer while the re-read is held",
    SLOW,
    async () => {
      const { task, answer } = await provisionalTask(600);
      const daily = holdingApi();
      daily.answerWith(() => pageOf([answer()]));
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        api: daily.api,
      });
      await untilLong(
        t,
        () => row(task.occurrenceId)?.dataset.source === "server",
      );
      expect(row(task.occurrenceId)?.dataset.pill).toBe("on_track");
      daily.answerWith(null);
      const occurrence = task.rows[2] as CacheRow;
      await t.commitSync([
        {
          ...occurrence,
          version: 2,
          value: {
            ...occurrence.value,
            closes_at: Math.floor(Date.now() / 1000) - 1,
          },
        },
      ]);
      await waitReal(1_200);
      await untilLong(t, () => row(task.occurrenceId)?.dataset.version === "2");
      expect(row(task.occurrenceId)?.dataset.version).toBe("2");
      expect(row(task.occurrenceId)?.dataset.structure).toBe("cache");
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
    },
  );

  test("daily first: a version-2 item ahead of the cached version 1 is the structure, and its personal answer is current", async () => {
    const { task, answer } = await provisionalTask(600);
    const closed = Math.floor(Date.now() / 1000) - 5;
    const daily = holdingApi();
    daily.answerWith(() =>
      pageOf([
        answer({
          version: 2,
          data: { ...task.data, closes_at: closed },
          outcome: "complete",
          period_outcome: "complete",
          actionable: false,
        }),
      ]),
    );
    const t = await mountTasks({ path: PATH, rows: task.rows, api: daily.api });
    await untilLong(t, () => row(task.occurrenceId)?.dataset.version === "2");
    expect(row(task.occurrenceId)?.dataset.version).toBe("2");
    expect(row(task.occurrenceId)?.dataset.structure).toBe("daily");
    expect(row(task.occurrenceId)?.dataset.source).toBe("server");
    expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
  });

  test(
    "a permission the cache committed after the read began (same version) defeats the answer's can_edit",
    SLOW,
    async () => {
      const task = await seededTask({
        stream: false,
        participants: [],
        definition: { participation: "anyone" },
      });
      const listed: OccurrenceView = {
        id: task.occurrenceId,
        version: 1,
        can_edit: true,
        data: task.data,
        outcome: "unknown",
        period_outcome: "unknown",
        actionable: true,
      };
      const daily = holdingApi();
      daily.answerWith(() => pageOf([listed]));
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        api: daily.api,
      });
      await untilLong(
        t,
        () => row(task.occurrenceId)?.dataset.source === "server",
      );
      expect(row(task.occurrenceId)?.dataset.canEdit).toBe("true");
      daily.answerWith(null);
      await t.commitSync([{ ...(task.rows[2] as CacheRow), can_edit: false }]);
      await waitReal(1_200);
      await untilLong(
        t,
        () => row(task.occurrenceId)?.dataset.canEdit === "false",
      );
      expect(row(task.occurrenceId)?.dataset.canEdit).toBe("false");
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
    },
  );

  test(
    "control: after an unrelated committed page, the re-read's answer is the server's again",
    SLOW,
    async () => {
      const { task, answer } = await provisionalTask(600);
      const other = await seededTask({ title: "Other" });
      const daily = holdingApi();
      daily.answerWith(() => pageOf([answer()]));
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        api: daily.api,
      });
      await untilLong(
        t,
        () => row(task.occurrenceId)?.dataset.source === "server",
      );
      const before = daily.api.calls.readDaily ?? 0;
      await t.commitSync([other.rows[0] as CacheRow]);
      await waitReal(1_200);
      await untilLong(
        t,
        () =>
          (daily.api.calls.readDaily ?? 0) > before &&
          row(task.occurrenceId)?.dataset.source === "server",
      );
      expect((daily.api.calls.readDaily ?? 0) > before).toBe(true);
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      expect(row(task.occurrenceId)?.dataset.version).toBe("1");
    },
  );
});

describe("Today: only committed CONTENT asks /daily again (the E-C13 loop)", () => {
  test(
    "an empty delta page (page_seq and cursor move, no row and no revision) asks nothing; a page with content asks again",
    SLOW,
    async () => {
      const { task, answer } = await provisionalTask(600);
      const other = await seededTask({ title: "Other" });
      const daily = holdingApi();
      daily.answerWith(() => pageOf([answer()]));
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        api: daily.api,
      });
      await untilLong(
        t,
        () => row(task.occurrenceId)?.dataset.source === "server",
      );
      await waitReal(1_000);
      const settled = daily.api.calls.readDaily ?? 0;
      // An empty page: in production the engine's own wake (a stamped read changes the session's view) fetches one after every read.
      await t.commitSync([], [], { empty: true });
      await waitReal(1_500);
      await t.settle();
      expect(daily.api.calls.readDaily ?? 0).toBe(settled);
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      // Control: content committed is asked about again.
      await t.commitSync([other.rows[0] as CacheRow]);
      await waitReal(1_500);
      await untilLong(t, () => (daily.api.calls.readDaily ?? 0) > settled);
      expect(daily.api.calls.readDaily ?? 0).toBeGreaterThan(settled);
    },
  );
});

describe("Today: an old answer never brings back a row the cache removed (F6)", () => {
  test(
    "a listed occurrence removed by a committed page leaves the day while the re-read is held",
    SLOW,
    async () => {
      const { task, answer } = await provisionalTask(600);
      const daily = holdingApi();
      daily.answerWith(() => pageOf([answer()]));
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        api: daily.api,
      });
      await untilLong(
        t,
        () => row(task.occurrenceId)?.dataset.source === "server",
      );
      daily.answerWith(null);
      await t.commitSync([], [task.occurrenceId]);
      await waitReal(1_200);
      await untilLong(t, () => row(task.occurrenceId) === null);
      expect(row(task.occurrenceId)).toBeNull();
    },
  );

  test(
    "control: a listed occurrence the delta has not delivered yet stays across an unrelated committed page",
    SLOW,
    async () => {
      const { task, answer } = await provisionalTask(600);
      const other = await seededTask({ title: "Other" });
      const daily = holdingApi();
      daily.answerWith(() => pageOf([answer()]));
      const t = await mountTasks({
        path: PATH,
        rows: task.rows.filter((r) => r.kind !== "occurrence"),
        api: daily.api,
      });
      await untilLong(
        t,
        () => row(task.occurrenceId)?.dataset.source === "server",
      );
      daily.answerWith(null);
      await t.commitSync([other.rows[0] as CacheRow]);
      await waitReal(1_200);
      await t.settle();
      expect(row(task.occurrenceId)).not.toBeNull();
      expect(row(task.occurrenceId)?.dataset.structure).toBe("daily");
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
    },
  );
});
