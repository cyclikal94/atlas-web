/**
 * WEB-10a revision 5 (R13 `task-journal-correction-request-ownership`, R14 `task-journal-snapshot-freshness`; design assessment C1–C3,
 * schedules Q1–Q9, Q13–Q15): the open full history has ONE owner of its journal state. Only the latest Fix intent can open an editor (an
 * older check of the rest of the journal never replaces a newer editor or its typed value); a refusal of ANY read of the current authority
 * — a page or a check, current or superseded — drops the full history and anything certified by it, and no older success restores it;
 * a full-history fix closes with its authority (its typed value kept in memory, never sent); at most two journal requests are in flight
 * per view and a refresh replaces the window's pages in place (never a second window). Composed through the production task detail over
 * the IndexedDB double, with a scripted journal endpoint (`after`/`limit` paging by `sequence`, as the contract's). Every held request is
 * released inside `act` and the screen settled before asserting, so each case asserts on the CONSUMED answer, never on a request still
 * held.
 */
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import type { TasksResult } from "../../../src/features/tasks/api";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import {
  HISTORY_COPY,
  IN_FLIGHT,
} from "../../../src/features/tasks/detail/EntryHistory";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  JournalEntry,
  ProgressJournal,
} from "../../../src/features/tasks/model/contract";
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

installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const SLOW = { timeout: 30_000 };
const PAGE = 200;
const NOW = Math.floor(Date.now() / 1000);
const entryId = (n: number) =>
  `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry = (n: number, over: Partial<JournalEntry> = {}): JournalEntry => ({
  id: entryId(n),
  sequence: n,
  logical_order: n,
  replaces: null,
  evidence: { kind: "quantity", amount: String(n) },
  happened_at: NOW,
  recorded_by: ME,
  ...over,
});
const recent = (e: JournalEntry) => ({
  id: e.id,
  evidence: e.evidence,
  happened_at: e.happened_at,
  recorded_by: e.recorded_by,
});
const journalOf = (n: number) =>
  Array.from({ length: n }, (_, i) => entry(i + 1));

type Answer = TasksResult<ProgressJournal>;
interface Held {
  after: number;
  release(answer?: Answer): void;
}

/**
 * A journal endpoint over `entries()` (read when ANSWERED). `hold(match)` holds the requests it matches until released (optionally with
 * another answer); `answer(fn)` replaces the answer to the requests it matches. Records every request and the most ever in flight.
 */
function journalApi(entries: () => JournalEntry[]) {
  const asked: number[] = [];
  const holds: Held[] = [];
  let holdIf: ((after: number) => boolean) | null = null;
  let answerIf: ((after: number) => Answer | null) | null = null;
  let inFlight = 0;
  let most = 0;
  const pageAt = (after: number): Answer => {
    const page = entries()
      .filter((e) => e.sequence > after)
      .sort((a, b) => a.sequence - b.sequence);
    const items = page.slice(0, PAGE);
    return {
      ok: true,
      value: {
        entries: items,
        next_after:
          page.length > PAGE
            ? (items[items.length - 1]?.sequence ?? null)
            : null,
      },
    };
  };
  const api = fakeApi({
    readJournal: async (_id, after) => {
      asked.push(after);
      // A bound on what a defect can ask (a walk or refresh in a loop): past it nothing more is answered, so the case reaches its own
      // assertion on the requests instead of never settling.
      if (asked.length > 30) return new Promise<never>(() => undefined);
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        let replaced: Answer | undefined;
        if (holdIf?.(after) === true)
          await new Promise<void>((resolve) =>
            holds.push({
              after,
              release: (answer) => {
                replaced = answer;
                resolve();
              },
            }),
          );
        return replaced ?? answerIf?.(after) ?? pageAt(after);
      } finally {
        inFlight -= 1;
      }
    },
  });
  return {
    api,
    asked,
    holds,
    most: () => most,
    inFlight: () => inFlight,
    hold: (match: ((after: number) => boolean) | null) => {
      holdIf = match;
    },
    answer: (match: ((after: number) => Answer | null) | null) => {
      answerIf = match;
    },
  };
}

async function mountWith(
  journal: () => JournalEntry[],
  recentOf: JournalEntry[],
) {
  const task = await seededTask({
    definition: {
      goal: { kind: "numeric", minimum: "100000", maximum: null, unit: "cups" },
    },
    progress: {
      recent_entries: recentOf.map(recent),
      entry_count: journal().length,
    },
  });
  const j = journalApi(journal);
  const t = await mountTasks({
    path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
    rows: task.rows,
    api: j.api,
  });
  await t.until(() => document.querySelector("[data-entry-history]") !== null);
  return { task, t, ...j };
}

const history = () =>
  document.querySelector("[data-entry-history]") as HTMLElement;
const rendered = () =>
  [...history().querySelectorAll("[data-entry]")].map((e) =>
    e.getAttribute("data-entry"),
  );
const button = (name: string) =>
  within(history()).queryByRole("button", { name });
const row = (n: number) =>
  history().querySelector(`[data-entry="${entryId(n)}"]`) as HTMLElement | null;
const fixButton = (n: number) => {
  const li = row(n);
  return li === null
    ? null
    : within(li).queryByRole("button", { name: HISTORY_COPY.fix });
};
const forms = () => [...document.querySelectorAll("[data-fix-form]")];
const valueInput = () =>
  screen.queryByLabelText(
    new RegExp(`^${HISTORY_COPY.newValue}`),
  ) as HTMLInputElement | null;
/** The entry whose row holds the open fix form (null when the form is detached or absent). */
const fixedEntry = () =>
  forms()[0]?.closest("[data-entry]")?.getAttribute("data-entry") ?? null;
const records = (t: Mounted) =>
  t.bodies().filter((b) => b.command.command.kind === "record");

async function click(t: Mounted, name: string) {
  const b = button(name);
  expect(b, `button ${name}`).not.toBeNull();
  await act(async () => {
    fireEvent.click(b as HTMLElement);
  });
  await t.settle();
}
async function fix(t: Mounted, n: number) {
  const b = fixButton(n);
  expect(b, `Fix of entry ${n}`).not.toBeNull();
  await act(async () => {
    fireEvent.click(b as HTMLElement);
  });
  await t.settle();
}
async function type(t: Mounted, value: string) {
  const input = valueInput();
  expect(input, "the open fix's value field").not.toBeNull();
  await act(async () => {
    fireEvent.change(input as HTMLInputElement, { target: { value } });
  });
  await t.settle();
}
async function release(t: Mounted, held: Held | undefined, answer?: Answer) {
  expect(held, "a held journal request").toBeDefined();
  await act(async () => held?.release(answer));
  await t.settle();
}
async function cancel(t: Mounted) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.cancel }));
  });
  await t.settle();
}
/** Commits my stream at a new version through the production sync page, with `entries` as its recent tail. */
async function commitStream(
  t: Mounted,
  task: SeededTask,
  version: number,
  entries: JournalEntry[],
) {
  const progress = task.rows.find((r) => r.kind === "progress") as CacheRow;
  await t.commitSync([
    {
      ...progress,
      version,
      value: {
        ...(progress.value as object),
        recent_entries: entries.slice(-8).map(recent),
        entry_count: entries.length,
      } as never,
    },
  ]);
}
const REFUSED = { ok: false, kind: "not_found" } as const;
const FORBIDDEN = { ok: false, kind: "forbidden" } as const;

describe("Q1: an older correction lookup never replaces a newer editor or its input", () => {
  for (const held of [false, true])
    test(
      held
        ? "entry 1's check is held, entry 2's completes and 987 is typed; entry 1's answer then opens nothing"
        : "control (ordered): entry 1's check completes, then entry 2's; 987 stays",
      SLOW,
      async () => {
        const j = await mountWith(() => journalOf(210), []);
        await click(j.t, HISTORY_COPY.full);
        if (held) j.hold((after) => after === PAGE && j.holds.length === 0);
        await fix(j.t, 1);
        expect(j.holds.length).toBe(held ? 1 : 0);
        if (!held) expect(fixedEntry()).toBe(entryId(1));
        await fix(j.t, 2);
        expect(fixedEntry()).toBe(entryId(2));
        expect(valueInput()?.value).toBe("2");
        await type(j.t, "987");
        if (held) await release(j.t, j.holds[0]);
        expect(j.asked).toEqual([0, PAGE, PAGE]);
        expect(forms()).toHaveLength(1);
        expect(fixedEntry()).toBe(entryId(2));
        expect(valueInput()?.value).toBe("987");
        expect(records(j.t)).toHaveLength(0);
      },
    );

  test(
    "the newer selection opened at once (the window reaches the end): the held older check still opens nothing",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await fix(j.t, 1);
      expect(j.holds).toHaveLength(1);
      // Load more brings the last page: the window reaches the end, so entry 2's fix opens without a check.
      await click(j.t, HISTORY_COPY.loadMore);
      expect(button(HISTORY_COPY.loadMore)).toBeNull();
      await fix(j.t, 2);
      expect(fixedEntry()).toBe(entryId(2));
      await type(j.t, "987");
      await release(j.t, j.holds[0]);
      expect(fixedEntry()).toBe(entryId(2));
      expect(valueInput()?.value).toBe("987");
    },
  );

  test(
    "the same entry chosen again: the older check of it opens no second session over the newer value",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await fix(j.t, 1);
      await fix(j.t, 2);
      await cancel(j.t);
      await fix(j.t, 1);
      expect(fixedEntry()).toBe(entryId(1));
      await type(j.t, "55");
      await release(j.t, j.holds[0]);
      expect(forms()).toHaveLength(1);
      expect(valueInput()?.value).toBe("55");
    },
  );
});

describe("Q2/Q3: Cancel and Back to recent end a pending lookup", () => {
  test(
    "a newer selection then Cancel: the older answer reopens nothing",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await fix(j.t, 1);
      await fix(j.t, 2);
      await cancel(j.t);
      expect(forms()).toHaveLength(0);
      await release(j.t, j.holds[0]);
      expect(forms()).toHaveLength(0);
    },
  );

  test(
    "Cancel of the open fix also ends a lookup asked after it: its answer opens nothing",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), [entry(210)]);
      await click(j.t, HISTORY_COPY.full);
      // Page 1 does not hold the recent entry 210; open its fix from the recent entries, then open the full history.
      await click(j.t, HISTORY_COPY.recent);
      await fix(j.t, 210);
      await click(j.t, HISTORY_COPY.full);
      expect(forms()).toHaveLength(1);
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await fix(j.t, 1);
      expect(j.holds).toHaveLength(1);
      await cancel(j.t);
      expect(forms()).toHaveLength(0);
      await release(j.t, j.holds[0]);
      expect(forms()).toHaveLength(0);
    },
  );

  test(
    "control: an unheld lookup opens its fix, and Cancel closes it",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      await fix(j.t, 1);
      expect(fixedEntry()).toBe(entryId(1));
      await cancel(j.t);
      expect(forms()).toHaveLength(0);
    },
  );

  test(
    "Back to recent and the full history opened again: the earlier lookup attaches nothing; a fresh Fix opens",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await fix(j.t, 1);
      await click(j.t, HISTORY_COPY.recent);
      await click(j.t, HISTORY_COPY.full);
      await release(j.t, j.holds[0]);
      expect(forms()).toHaveLength(0);
      // No "checking" and no check fact of the old lookup: entry 1's Fix is an ordinary, enabled button.
      expect((fixButton(1) as HTMLButtonElement | null)?.disabled).toBe(false);
      expect(history().textContent).not.toContain(HISTORY_COPY.checkFailed);
      j.hold(null);
      await fix(j.t, 1);
      expect(fixedEntry()).toBe(entryId(1));
    },
  );
});

describe("Q4/Q5: page moves keep compatible facts; a newer version makes a lookup obsolete", () => {
  test(
    "a check fact found while Load more was pending survives Load more's answer",
    SLOW,
    async () => {
      // Entry 5 is corrected on page 3: the check from page 1's end finds it.
      const journal = journalOf(PAGE * 2 + 10);
      journal[PAGE * 2 + 4] = entry(PAGE * 2 + 5, { replaces: entryId(5) });
      const j = await mountWith(() => journal, []);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await click(j.t, HISTORY_COPY.loadMore);
      expect(j.holds).toHaveLength(1);
      await fix(j.t, 5);
      expect(row(5)?.textContent).toContain(HISTORY_COPY.corrected);
      await release(j.t, j.holds[0]);
      expect(rendered()).toHaveLength(PAGE * 2);
      expect(row(5)?.textContent).toContain(HISTORY_COPY.corrected);
      expect(fixButton(5)).toBeNull();
      expect(forms()).toHaveLength(0);
    },
  );

  for (const moved of [false, true])
    test(
      moved
        ? "the stream's committed version moves while the lookup is held: its answer opens nothing, and the correction it missed blocks the entry"
        : "control: the version does not move while the lookup is held: its answer opens the fix",
      SLOW,
      async () => {
        let journal = journalOf(210);
        const j = await mountWith(() => journal, []);
        await click(j.t, HISTORY_COPY.full);
        j.hold((after) => after === PAGE && j.holds.length === 0);
        await fix(j.t, 1);
        if (moved) {
          journal = [...journalOf(210), entry(211, { replaces: entryId(1) })];
          await commitStream(j.t, j.task, 2, journal);
          await j.t.until(() => j.asked.length === 3);
          expect(j.asked).toEqual([0, PAGE, 0]);
        }
        // The held check answers with the journal as it was when it was ASKED (no correction yet): "not corrected".
        await release(j.t, j.holds[0], {
          ok: true,
          value: { entries: journalOf(210).slice(PAGE), next_after: null },
        });
        if (!moved) {
          expect(fixedEntry()).toBe(entryId(1));
          return;
        }
        expect(forms()).toHaveLength(0);
        j.hold(null);
        await fix(j.t, 1);
        expect(row(1)?.textContent).toContain(HISTORY_COPY.corrected);
        expect(forms()).toHaveLength(0);
      },
    );

  test(
    "while a refresh for a newer version is held, an entry known only from the full history offers no Fix (the window is not current)",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(20), [entry(20)]);
      await click(j.t, HISTORY_COPY.full);
      expect(fixButton(5)).not.toBeNull();
      j.hold((after) => after === 0 && j.holds.length === 0);
      await commitStream(j.t, j.task, 2, journalOf(20));
      await j.t.until(() => j.holds.length === 1);
      expect(fixButton(5)).toBeNull();
      // A recent entry keeps its own authority.
      expect(fixButton(20)).not.toBeNull();
      await release(j.t, j.holds[0]);
      expect(fixButton(5)).not.toBeNull();
    },
  );
});

describe("Q6: a refusal of any journal read drops the full history", () => {
  const cases: Array<{
    name: string;
    total: number;
    before: (j: Awaited<ReturnType<typeof mountWith>>) => Promise<void>;
    act: (j: Awaited<ReturnType<typeof mountWith>>) => Promise<void>;
  }> = [
    {
      name: "the first page (open)",
      total: 20,
      before: async () => undefined,
      act: async (j) => click(j.t, HISTORY_COPY.full),
    },
    {
      name: "Refresh",
      total: 20,
      before: async (j) => click(j.t, HISTORY_COPY.full),
      act: async (j) => click(j.t, HISTORY_COPY.refresh),
    },
    {
      name: "Load more",
      total: PAGE * 2,
      before: async (j) => click(j.t, HISTORY_COPY.full),
      act: async (j) => click(j.t, HISTORY_COPY.loadMore),
    },
    {
      name: "Earlier entries",
      total: PAGE * 4,
      before: async (j) => {
        await click(j.t, HISTORY_COPY.full);
        for (let i = 0; i < 3; i += 1) await click(j.t, HISTORY_COPY.loadMore);
        expect(button(HISTORY_COPY.earlier)).not.toBeNull();
      },
      act: async (j) => click(j.t, HISTORY_COPY.earlier),
    },
    {
      name: "the check of the rest of the journal (Fix)",
      total: PAGE + 10,
      before: async (j) => click(j.t, HISTORY_COPY.full),
      act: async (j) => fix(j.t, 5),
    },
  ];
  for (const c of cases)
    for (const refusal of [REFUSED, FORBIDDEN, null])
      test(
        refusal === null
          ? `control: ${c.name} answered keeps the full history`
          : `${c.name} refused (${refusal.kind}): the full history and its facts are gone, the refusal is said, and Full history is offered again`,
        SLOW,
        async () => {
          const j = await mountWith(() => journalOf(c.total), [entry(c.total)]);
          await c.before(j);
          if (refusal !== null) j.answer(() => refusal);
          await c.act(j);
          if (refusal === null) {
            expect(rendered().length).toBeGreaterThan(1);
            expect(history().textContent).not.toContain(HISTORY_COPY.refused);
            return;
          }
          // Only the stream's recent entry (its own authority) is shown.
          expect(rendered()).toEqual([entryId(c.total)]);
          expect(history().textContent).toContain(HISTORY_COPY.refused);
          expect(history().querySelector("h2")?.textContent).toBe(
            HISTORY_COPY.heading,
          );
          expect(button(HISTORY_COPY.full)).not.toBeNull();
          expect(forms()).toHaveLength(0);
          // Nothing asks again on its own.
          const asked = j.asked.length;
          await j.t.settle();
          expect(j.asked).toHaveLength(asked);
        },
      );
});

describe("Q7: a refusal belongs to the authority, not to the request that met it", () => {
  test(
    "the superseded lookup is refused after the newer one was asked: the authority ends; the newer success restores nothing",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), [entry(210)]);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE);
      await fix(j.t, 1);
      await fix(j.t, 2);
      expect(j.holds).toHaveLength(2);
      await release(j.t, j.holds[0], REFUSED);
      expect(rendered()).toEqual([entryId(210)]);
      expect(history().textContent).toContain(HISTORY_COPY.refused);
      await release(j.t, j.holds[1]);
      expect(rendered()).toEqual([entryId(210)]);
      expect(forms()).toHaveLength(0);
    },
  );

  test(
    "the reverse: the newer lookup is refused first; the older one's late success opens nothing and restores nothing",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), [entry(210)]);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await fix(j.t, 1);
      j.hold(null);
      j.answer((after) => (after === PAGE ? REFUSED : null));
      await fix(j.t, 2);
      expect(history().textContent).toContain(HISTORY_COPY.refused);
      j.answer(null);
      await release(j.t, j.holds[0]);
      expect(rendered()).toEqual([entryId(210)]);
      expect(forms()).toHaveLength(0);
    },
  );

  test(
    "a page request answered after a refusal of the same authority restores nothing",
    SLOW,
    async () => {
      const j = await mountWith(
        () => journalOf(PAGE * 2 + 10),
        [entry(PAGE * 2 + 10)],
      );
      await click(j.t, HISTORY_COPY.full);
      // Load more is held; a lookup from page 1's end is refused.
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await click(j.t, HISTORY_COPY.loadMore);
      j.answer((after) => (after === PAGE ? REFUSED : null));
      await fix(j.t, 5);
      expect(history().textContent).toContain(HISTORY_COPY.refused);
      j.answer(null);
      await release(j.t, j.holds[0]);
      expect(rendered()).toEqual([entryId(PAGE * 2 + 10)]);
    },
  );

  test(
    "after a refusal, Full history begins a new authority; a refusal from the old one then changes nothing",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), [entry(210)]);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await fix(j.t, 1);
      j.hold(null);
      j.answer((after) => (after === PAGE ? REFUSED : null));
      await fix(j.t, 2);
      expect(history().textContent).toContain(HISTORY_COPY.refused);
      j.answer(null);
      await click(j.t, HISTORY_COPY.full);
      expect(rendered()).toHaveLength(PAGE);
      await release(j.t, j.holds[0], REFUSED);
      expect(rendered()).toHaveLength(PAGE);
      expect(history().textContent).not.toContain(HISTORY_COPY.refused);
    },
  );
});

describe("Q8: a fix known only from the full history closes with its authority", () => {
  test(
    "refused while it is open with a typed value: the fix closes and nothing is saved; reopened under a new authority it has the value",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(20), [entry(20)]);
      await click(j.t, HISTORY_COPY.full);
      await fix(j.t, 5);
      await type(j.t, "77");
      j.answer(() => FORBIDDEN);
      await click(j.t, HISTORY_COPY.refresh);
      expect(forms()).toHaveLength(0);
      expect(screen.queryByRole("button", { name: HISTORY_COPY.fixSave })).toBe(
        null,
      );
      expect(records(j.t)).toHaveLength(0);
      j.answer(null);
      await click(j.t, HISTORY_COPY.full);
      await fix(j.t, 5);
      expect(valueInput()?.value).toBe("77");
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: HISTORY_COPY.fixSave }),
        );
      });
      await j.t.settle();
      expect(records(j.t)).toHaveLength(1);
      expect(records(j.t)[0]?.command.command.replaces).toBe(entryId(5));
      expect(records(j.t)[0]?.command.command.evidence).toEqual({
        kind: "quantity",
        amount: "77",
      });
    },
  );

  test(
    "control: a fix of a recent entry keeps its own authority through the refusal and can be saved",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(20), [entry(20)]);
      await click(j.t, HISTORY_COPY.full);
      await fix(j.t, 20);
      await type(j.t, "88");
      j.answer(() => FORBIDDEN);
      await click(j.t, HISTORY_COPY.refresh);
      expect(history().textContent).toContain(HISTORY_COPY.refused);
      expect(valueInput()?.value).toBe("88");
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: HISTORY_COPY.fixSave }),
        );
      });
      await j.t.settle();
      expect(records(j.t)).toHaveLength(1);
    },
  );

  test(
    "Back to recent closes a full-history fix (nothing saved); opening it again restores what was typed",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(20), [entry(20)]);
      await click(j.t, HISTORY_COPY.full);
      await fix(j.t, 5);
      await type(j.t, "66");
      await click(j.t, HISTORY_COPY.recent);
      expect(forms()).toHaveLength(0);
      expect(records(j.t)).toHaveLength(0);
      await click(j.t, HISTORY_COPY.full);
      await fix(j.t, 5);
      expect(valueInput()?.value).toBe("66");
    },
  );
});

describe("Q9: a failure certifies nothing and does not loop", () => {
  test(
    "the check fails (uncertain): the pages stay, it says so, nothing opens; Fix again asks again and opens",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      j.answer((after) =>
        after === PAGE ? { ok: false, kind: "uncertain" } : null,
      );
      await fix(j.t, 5);
      expect(history().textContent).toContain(HISTORY_COPY.checkFailed);
      expect(rendered()).toHaveLength(PAGE);
      expect(forms()).toHaveLength(0);
      expect(history().textContent).not.toContain(HISTORY_COPY.refused);
      j.answer(null);
      await fix(j.t, 5);
      expect(fixedEntry()).toBe(entryId(5));
      expect(j.asked).toEqual([0, PAGE, PAGE]);
    },
  );

  test(
    "a page that does not move past where it was asked is a failed check, not a walk without end",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      j.answer((after) =>
        after === PAGE
          ? { ok: true, value: { entries: [], next_after: PAGE } }
          : null,
      );
      await fix(j.t, 5);
      expect(j.asked).toEqual([0, PAGE]);
      expect(history().textContent).toContain(HISTORY_COPY.checkFailed);
      expect(forms()).toHaveLength(0);
    },
  );

  test(
    "a first page that does not move is a failed read (Full history again, no loop)",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(20), [entry(20)]);
      j.answer(() => ({ ok: true, value: { entries: [], next_after: 0 } }));
      await click(j.t, HISTORY_COPY.full);
      expect(j.asked).toEqual([0]);
      expect(history().textContent).toContain(HISTORY_COPY.failed);
      expect(rendered()).toEqual([entryId(20)]);
    },
  );

  test(
    "the session closes the check's request: nothing opens, nothing is said, Fix is offered again",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      j.answer((after) =>
        after === PAGE ? { ok: false, kind: "closed" } : null,
      );
      await fix(j.t, 5);
      expect(forms()).toHaveLength(0);
      expect(history().textContent).not.toContain(HISTORY_COPY.checkFailed);
      expect((fixButton(5) as HTMLButtonElement | null)?.disabled).toBe(false);
      expect(rendered()).toHaveLength(PAGE);
    },
  );
});

describe("Q13: another identity or an unmounted history", () => {
  test(
    "another identity shown while a lookup is held: its answer opens nothing",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await fix(j.t, 1);
      j.t.rerender(tasksEnv(j.api, { identity: `${OTHER}:1` }));
      await j.t.settle();
      await release(j.t, j.holds[0]);
      expect(forms()).toHaveLength(0);
    },
  );

  test(
    "the history unmounted while a lookup is held: its answer changes nothing and nothing more is asked",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(PAGE * 3), []);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE && j.holds.length === 0);
      await fix(j.t, 1);
      j.t.unmount();
      await act(async () => j.holds[0]?.release());
      // The walk would have gone on to the third page.
      expect(j.asked).toEqual([0, PAGE]);
    },
  );
});

describe("Q14: bounded acquisition", () => {
  test(
    `at most ${IN_FLIGHT} journal requests are in flight; a third Fix waits, and only the latest selection's walk goes on`,
    SLOW,
    async () => {
      expect(IN_FLIGHT).toBe(2);
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE);
      await fix(j.t, 1);
      await fix(j.t, 2);
      await fix(j.t, 3);
      // The third check is not sent while two are in flight.
      expect(j.asked).toEqual([0, PAGE, PAGE]);
      expect(j.most()).toBe(2);
      await release(j.t, j.holds[0]);
      // Its turn came: it is still the current selection, so it is sent now.
      expect(j.asked).toEqual([0, PAGE, PAGE, PAGE]);
      await release(j.t, j.holds[1]);
      await release(j.t, j.holds[2]);
      expect(j.most()).toBe(2);
      expect(fixedEntry()).toBe(entryId(3));
      expect(forms()).toHaveLength(1);
    },
  );

  test(
    "a waiting check that is no longer wanted when its turn comes is never sent",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(210), []);
      await click(j.t, HISTORY_COPY.full);
      j.hold((after) => after === PAGE);
      await fix(j.t, 1);
      await fix(j.t, 2);
      await fix(j.t, 3);
      await click(j.t, HISTORY_COPY.recent);
      await release(j.t, j.holds[0]);
      await release(j.t, j.holds[1]);
      expect(j.asked).toEqual([0, PAGE, PAGE]);
      expect(forms()).toHaveLength(0);
    },
  );

  test(
    "a refresh of a three-page window replaces its pages in place: never more than 600 entries shown, one request at a time, exact cursors",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(PAGE * 4), []);
      await click(j.t, HISTORY_COPY.full);
      await click(j.t, HISTORY_COPY.loadMore);
      await click(j.t, HISTORY_COPY.loadMore);
      expect(rendered()).toHaveLength(600);
      j.asked.length = 0;
      // The refreshed first page is told apart from the copy shown before it (entry 1 reads 1001): it replaces that copy the moment it
      // arrives, while the second page is still held — no second window is assembled behind the first.
      j.answer((after) =>
        after === 0
          ? {
              ok: true,
              value: {
                entries: [
                  entry(1, { evidence: { kind: "quantity", amount: "1001" } }),
                  ...journalOf(PAGE).slice(1),
                ],
                next_after: PAGE,
              },
            }
          : null,
      );
      j.hold(() => true);
      await act(async () => {
        fireEvent.click(button(HISTORY_COPY.refresh) as HTMLElement);
      });
      await j.t.settle();
      const sizes: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        expect(j.inFlight()).toBe(1);
        sizes.push(rendered().length);
        await release(j.t, j.holds[i]);
        if (i === 0) expect(row(1)?.textContent).toContain("1001 cups");
      }
      sizes.push(rendered().length);
      expect(j.asked).toEqual([0, PAGE, PAGE * 2]);
      expect(sizes.every((n) => n <= 600)).toBe(true);
      expect(rendered()).toHaveLength(600);
      expect(rendered()[0]).toBe(entryId(1));
      // The window still continues where it did.
      j.hold(null);
      await click(j.t, HISTORY_COPY.loadMore);
      expect(j.asked).toEqual([0, PAGE, PAGE * 2, PAGE * 3]);
      expect(rendered()[599]).toBe(entryId(800));
    },
  );
});

describe("Q15: offline, only the recent entries can be fixed", () => {
  for (const online of [true, false])
    test(
      online
        ? "control: online, an entry known only from the full history offers Fix"
        : "offline with the full history open: an entry known only from it offers no Fix; a recent entry does",
      SLOW,
      async () => {
        const j = await mountWith(() => journalOf(20), [entry(20)]);
        await click(j.t, HISTORY_COPY.full);
        if (!online) {
          j.t.rerender(tasksEnv(j.api, { online: false }));
          await j.t.settle();
        }
        expect(rendered()).toHaveLength(20);
        expect(fixButton(5) === null).toBe(!online);
        expect(fixButton(20)).not.toBeNull();
      },
    );
});
