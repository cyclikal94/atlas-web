/**
 * WEB-10a revision 4 (R10 `task-journal-snapshot-freshness`, R12 `task-journal-page-retention`; design assessment C3, schedules J1–J5):
 * the open full history is a window of at most three pages (Q9) that follows the stream's committed version, keeps every page reachable,
 * never lets an older answer overwrite a newer one, knows corrections across pages, and keeps an open fix whatever happens to its page.
 * Composed through the production task detail over the IndexedDB double, with a scripted journal endpoint (`after`/`limit` paging by
 * `sequence`, as the contract's).
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
import * as copy from "../../../src/features/tasks/copy";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import {
  HISTORY_COPY,
  MAX_PAGES,
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

/** A journal endpoint over `entries()` (read when asked), paged by sequence like the contract's; every request is recorded. */
function journalApi(entries: () => JournalEntry[]) {
  const asked: number[] = [];
  const holds: Array<{ after: number; release: () => void }> = [];
  let holdNext = false;
  let fail: TasksResult<ProgressJournal> | null = null;
  const api = fakeApi({
    readJournal: async (_id, after) => {
      asked.push(after);
      // A bound on what a defect can ask (a refresh asked again in a loop): past it nothing more is answered, so the case reaches its
      // own assertion on the requests instead of never settling.
      if (asked.length > 20) return new Promise<never>(() => undefined);
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) =>
          holds.push({ after, release: resolve }),
        );
      }
      // The answer is what the journal holds when it is ANSWERED (a held request answers late, with what is there then).
      if (fail !== null) return fail;
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
    },
  });
  return {
    api,
    asked,
    holds,
    holdNext: () => {
      holdNext = true;
    },
    failWith: (result: TasksResult<ProgressJournal> | null) => {
      fail = result;
    },
  };
}

async function mountWith(
  journal: () => JournalEntry[],
  progress: Parameters<typeof seededTask>[0] extends infer O
    ? O extends { progress?: infer P }
      ? P
      : never
    : never = {},
) {
  const task = await seededTask({
    definition: {
      goal: { kind: "numeric", minimum: "100000", maximum: null, unit: "cups" },
    },
    progress,
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
async function click(t: Mounted, name: string) {
  const b = button(name);
  expect(b, `button ${name}`).not.toBeNull();
  await act(async () => {
    fireEvent.click(b as HTMLElement);
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

describe("J1: an open full history follows its stream's committed version", () => {
  test(
    "a correction committed while it is open is read again: the new entry is shown as the journal says (a correction; the old one corrected)",
    SLOW,
    async () => {
      let journal = [entry(1)];
      const { task, t, asked } = await mountWith(() => journal, {
        recent_entries: [recent(entry(1))],
        entry_count: 1,
      });
      await click(t, HISTORY_COPY.full);
      expect(asked).toEqual([0]);
      expect(rendered()).toEqual([entryId(1)]);
      journal = [
        entry(1),
        entry(2, { replaces: entryId(1), logical_order: 1 }),
      ];
      await commitStream(t, task, 2, journal);
      await t.until(() => asked.length === 2);
      // The journal was asked again, after the commit, for the window's own page.
      expect(asked).toEqual([0, 0]);
      const second = history().querySelector(`[data-entry="${entryId(2)}"]`);
      expect(second?.textContent).toContain(HISTORY_COPY.correction);
      const first = history().querySelector(`[data-entry="${entryId(1)}"]`);
      expect(first?.textContent).toContain(HISTORY_COPY.corrected);
      expect(
        within(first as HTMLElement).queryByRole("button", {
          name: HISTORY_COPY.fix,
        }),
      ).toBeNull();
    },
  );

  test(
    "control: a commit that does not change my stream asks nothing",
    SLOW,
    async () => {
      const { task, t, asked } = await mountWith(() => [entry(1)], {
        recent_entries: [recent(entry(1))],
        entry_count: 1,
      });
      await click(t, HISTORY_COPY.full);
      await t.commitSync([
        { ...(task.rows[0] as CacheRow), label: "Renamed", version: 2 },
      ]);
      await t.settle();
      expect(asked).toEqual([0]);
    },
  );

  test(
    "control: the recent entries (journal not opened) follow the commit and ask nothing",
    SLOW,
    async () => {
      const { task, t, asked } = await mountWith(() => [entry(1)], {
        recent_entries: [recent(entry(1))],
        entry_count: 1,
      });
      await commitStream(t, task, 2, [entry(1), entry(2)]);
      await t.until(() => rendered().includes(entryId(2)));
      expect(rendered()).toEqual([entryId(1), entryId(2)]);
      expect(asked).toEqual([]);
    },
  );

  test(
    "offline, a newer version waits; when the connection returns it is read",
    SLOW,
    async () => {
      let journal = [entry(1)];
      const { task, t, asked, api } = await mountWith(() => journal, {
        recent_entries: [recent(entry(1))],
        entry_count: 1,
      });
      await click(t, HISTORY_COPY.full);
      const { tasksEnv } = await import("../../support/tasks/world");
      t.rerender(tasksEnv(api, { online: false }));
      journal = [entry(1), entry(2)];
      await commitStream(t, task, 2, journal);
      await t.settle();
      expect(asked).toEqual([0]);
      t.rerender(tasksEnv(api, { online: true }));
      await t.until(() => asked.length === 2);
      expect(asked).toEqual([0, 0]);
    },
  );
});

describe("J2: answers in order, corrections across pages", () => {
  test(
    "an older answer that arrives after a newer one is not shown",
    SLOW,
    async () => {
      let journal = [entry(1)];
      const { task, t, holds, holdNext, asked } = await mountWith(
        () => journal,
        { recent_entries: [recent(entry(1))], entry_count: 1 },
      );
      await click(t, HISTORY_COPY.full);
      // A commit asks again; that request is held.
      holdNext();
      await commitStream(t, task, 2, [entry(1)]);
      await t.until(() => holds.length === 1);
      // The person goes back to the recent entries and opens the full history again: that request answers first.
      await click(t, HISTORY_COPY.recent);
      journal = [entry(1), entry(2)];
      await click(t, HISTORY_COPY.full);
      expect(asked).toEqual([0, 0, 0]);
      expect(rendered()).toEqual([entryId(1), entryId(2)]);
      // The held, older request answers now with what the journal held before: it is not shown.
      journal = [entry(1)];
      await act(async () => holds[0]?.release());
      await t.settle();
      expect(rendered()).toEqual([entryId(1), entryId(2)]);
    },
  );

  test(
    "outside a window that reaches the end, Fix first checks the rest of the journal: corrected later, it says so and opens nothing",
    SLOW,
    async () => {
      // Page 1 holds my entry 5; a correction of it is on page 2.
      const journal = Array.from({ length: PAGE + 10 }, (_, i) => entry(i + 1));
      journal[PAGE + 4] = entry(PAGE + 5, { replaces: entryId(5) });
      const { t, asked } = await mountWith(() => journal);
      await click(t, HISTORY_COPY.full);
      expect(button(HISTORY_COPY.loadMore)).not.toBeNull();
      const five = () =>
        history().querySelector(`[data-entry="${entryId(5)}"]`) as HTMLElement;
      // Not known from the page alone: no "Corrected" yet, and Fix asks the rest first.
      expect(five().textContent).not.toContain(HISTORY_COPY.corrected);
      await act(async () => {
        fireEvent.click(
          within(five()).getByRole("button", { name: HISTORY_COPY.fix }),
        );
      });
      await t.settle();
      expect(asked).toEqual([0, PAGE]);
      expect(five().textContent).toContain(HISTORY_COPY.corrected);
      expect(document.querySelector("[data-fix-form]")).toBeNull();
      expect(
        within(five()).queryByRole("button", { name: HISTORY_COPY.fix }),
      ).toBeNull();
      // The check retained nothing: the window is still the one page.
      expect(rendered()).toHaveLength(PAGE);
    },
  );

  test(
    "control: not corrected later, the check opens the fix",
    SLOW,
    async () => {
      const journal = Array.from({ length: PAGE + 10 }, (_, i) => entry(i + 1));
      const { t, asked } = await mountWith(() => journal);
      await click(t, HISTORY_COPY.full);
      const five = history().querySelector(
        `[data-entry="${entryId(5)}"]`,
      ) as HTMLElement;
      await act(async () => {
        fireEvent.click(
          within(five).getByRole("button", { name: HISTORY_COPY.fix }),
        );
      });
      await t.settle();
      expect(asked).toEqual([0, PAGE]);
      expect(document.querySelector("[data-fix-form]")).not.toBeNull();
    },
  );

  test(
    "control: a window that reaches the end knows a correction on its other page without asking",
    SLOW,
    async () => {
      const journal = Array.from({ length: PAGE + 10 }, (_, i) => entry(i + 1));
      journal[PAGE + 4] = entry(PAGE + 5, { replaces: entryId(5) });
      const { t, asked } = await mountWith(() => journal);
      await click(t, HISTORY_COPY.full);
      await click(t, HISTORY_COPY.loadMore);
      expect(asked).toEqual([0, PAGE]);
      const five = history().querySelector(
        `[data-entry="${entryId(5)}"]`,
      ) as HTMLElement;
      expect(five.textContent).toContain(HISTORY_COPY.corrected);
      expect(
        within(five).queryByRole("button", { name: HISTORY_COPY.fix }),
      ).toBeNull();
    },
  );
});

describe("J3: at most three pages are retained, and every page stays reachable", () => {
  test(
    "forwards to the fifth page and back to the first: never more than three pages, the exact pages asked",
    SLOW,
    async () => {
      expect(MAX_PAGES).toBe(3);
      const journal = Array.from({ length: PAGE * 5 }, (_, i) => entry(i + 1));
      const { t, asked } = await mountWith(() => journal);
      await click(t, HISTORY_COPY.full);
      const seen: number[] = [rendered().length];
      for (let i = 1; i < 5; i += 1) {
        await click(t, HISTORY_COPY.loadMore);
        seen.push(rendered().length);
      }
      expect(asked).toEqual([0, 200, 400, 600, 800]);
      expect(seen).toEqual([200, 400, 600, 600, 600]);
      // The window is pages 3-5: entries 401..1000.
      expect(rendered()[0]).toBe(entryId(401));
      expect(button(HISTORY_COPY.loadMore)).toBeNull();
      // Back, a page at a time: each earlier page is read again from its own start.
      for (let i = 0; i < 2; i += 1) {
        await click(t, HISTORY_COPY.earlier);
        seen.push(rendered().length);
      }
      expect(asked).toEqual([0, 200, 400, 600, 800, 200, 0]);
      expect(seen.slice(5)).toEqual([600, 600]);
      expect(rendered()[0]).toBe(entryId(1));
      expect(rendered()[599]).toBe(entryId(600));
      expect(button(HISTORY_COPY.earlier)).toBeNull();
      // And forwards again to the end.
      await click(t, HISTORY_COPY.loadMore);
      await click(t, HISTORY_COPY.loadMore);
      expect(rendered()).toHaveLength(600);
      expect(rendered()[599]).toBe(entryId(1000));
    },
  );
});

describe("J4: a refresh that fails, a refusal, another identity", () => {
  test(
    "a failed refresh keeps the pages, marked stale, with Try again; Try again reads them",
    SLOW,
    async () => {
      let journal = [entry(1)];
      const j = await mountWith(() => journal, {
        recent_entries: [recent(entry(1))],
        entry_count: 1,
      });
      await click(j.t, HISTORY_COPY.full);
      j.failWith({ ok: false, kind: "uncertain" });
      journal = [
        entry(1),
        entry(2, { replaces: entryId(1), logical_order: 1 }),
      ];
      await commitStream(j.t, j.task, 2, journal);
      await j.t.until(
        () => history().querySelector("[data-history-stale]") !== null,
      );
      expect(history().querySelector("[data-history-stale]")?.textContent).toBe(
        HISTORY_COPY.stale,
      );
      expect(rendered()).toContain(entryId(1));
      // Not asked again on its own (no loop): once per version.
      await j.t.settle();
      expect(j.asked).toEqual([0, 0]);
      j.failWith(null);
      await click(j.t, copy.TRY_AGAIN);
      expect(j.asked).toEqual([0, 0, 0]);
      expect(history().querySelector("[data-history-stale]")).toBeNull();
      expect(
        history().querySelector(`[data-entry="${entryId(2)}"]`)?.textContent,
      ).toContain(HISTORY_COPY.correction);
    },
  );

  test(
    "a refused refresh drops the pages: they are no longer an answer this person may see",
    SLOW,
    async () => {
      const j = await mountWith(() => [entry(1), entry(2)], {
        recent_entries: [recent(entry(1))],
        entry_count: 1,
      });
      await click(j.t, HISTORY_COPY.full);
      expect(rendered()).toEqual([entryId(1), entryId(2)]);
      j.failWith({ ok: false, kind: "forbidden" });
      // The stream's recent tail (what the recent view shows) does not hold entry 2: only the dropped pages did.
      await commitStream(j.t, j.task, 2, [entry(1), entry(3)]);
      await j.t.until(
        () => history().textContent?.includes(HISTORY_COPY.refused) === true,
      );
      expect(history().querySelector("h2")?.textContent).toBe(
        HISTORY_COPY.heading,
      );
      expect(rendered()).not.toContain(entryId(2));
    },
  );

  test("another identity shown drops the pages", SLOW, async () => {
    const j = await mountWith(() => [entry(1), entry(2)], {
      recent_entries: [recent(entry(1))],
      entry_count: 1,
    });
    await click(j.t, HISTORY_COPY.full);
    expect(rendered()).toContain(entryId(2));
    const { tasksEnv } = await import("../../support/tasks/world");
    j.t.rerender(tasksEnv(j.api, { identity: `${OTHER}:1` }));
    await j.t.settle();
    expect(rendered()).not.toContain(entryId(2));
  });
});

describe("J5: an open fix outlives its page", () => {
  test(
    "evicted, brought back and refreshed: the typed value stays, and the save names the entry fixed",
    SLOW,
    async () => {
      let journal = Array.from({ length: PAGE * 4 }, (_, i) => entry(i + 1));
      const j = await mountWith(() => journal);
      await click(j.t, HISTORY_COPY.full);
      await click(j.t, HISTORY_COPY.loadMore);
      await click(j.t, HISTORY_COPY.loadMore);
      const five = () =>
        history().querySelector(
          `[data-entry="${entryId(5)}"]`,
        ) as HTMLElement | null;
      await act(async () => {
        fireEvent.click(
          within(five() as HTMLElement).getByRole("button", {
            name: HISTORY_COPY.fix,
          }),
        );
      });
      await j.t.settle();
      const value = () =>
        screen.getByLabelText(
          new RegExp(`^${HISTORY_COPY.newValue}`),
        ) as HTMLInputElement;
      fireEvent.change(value(), { target: { value: "7" } });
      // Page 1 is let go: the fix stays open, with 7.
      await click(j.t, HISTORY_COPY.loadMore);
      expect(five()).toBeNull();
      expect(document.querySelector("[data-fix-detached]")).not.toBeNull();
      expect(value().value).toBe("7");
      // Back again, and a refresh: still 7.
      await click(j.t, HISTORY_COPY.earlier);
      expect(five()).not.toBeNull();
      expect(value().value).toBe("7");
      journal = [...journal];
      await click(j.t, HISTORY_COPY.refresh);
      expect(value().value).toBe("7");
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: HISTORY_COPY.fixSave }),
        );
      });
      await j.t.settle();
      const body = j.t
        .bodies()
        .map((b) => b.command.command)
        .find((c) => c.kind === "record");
      expect(body?.replaces).toBe(entryId(5));
      expect(body?.evidence).toEqual({ kind: "quantity", amount: "7" });
    },
  );

  test(
    "a fix whose entry was corrected since (a saved correction) cannot be saved, and says why",
    SLOW,
    async () => {
      let journal = [entry(1)];
      const j = await mountWith(() => journal, {
        recent_entries: [recent(entry(1))],
        entry_count: 1,
      });
      await click(j.t, HISTORY_COPY.full);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fix }));
      });
      journal = [
        entry(1),
        entry(2, { replaces: entryId(1), logical_order: 1 }),
      ];
      await commitStream(j.t, j.task, 2, journal);
      await j.t.until(
        () =>
          document.body.textContent?.includes(HISTORY_COPY.correctedSince) ===
          true,
      );
      const save = screen.getByRole("button", { name: HISTORY_COPY.fixSave });
      expect((save as HTMLButtonElement).disabled).toBe(true);
      expect(document.body.textContent).toContain(HISTORY_COPY.correctedSince);
      await act(async () => {
        fireEvent.click(save);
      });
      await j.t.settle();
      expect(
        j.t.bodies().filter((b) => b.command.command.kind === "record"),
      ).toHaveLength(0);
    },
  );
});

describe("X2: the open window is accessible (jsdom layer; no manual assistive-technology claim)", () => {
  test(
    "Earlier entries, Load more, Refresh and Back to recent entries are buttons in the tab order, with no axe violations",
    SLOW,
    async () => {
      const { axe } = await import("jest-axe");
      const journal = Array.from({ length: PAGE * 5 }, (_, i) => entry(i + 1));
      const { t } = await mountWith(() => journal);
      await click(t, HISTORY_COPY.full);
      for (let i = 0; i < 3; i += 1) await click(t, HISTORY_COPY.loadMore);
      for (const name of [
        HISTORY_COPY.earlier,
        HISTORY_COPY.loadMore,
        HISTORY_COPY.refresh,
        HISTORY_COPY.recent,
      ]) {
        const b = button(name);
        expect(b, name).not.toBeNull();
        expect((b as HTMLButtonElement).tabIndex).toBe(0);
      }
      // The paging controls (axe over the 600 entries' list is too slow for jsdom; the list's markup is the recent view's, covered by the
      // detail page's axe case in task-screens).
      const controls = (button(HISTORY_COPY.recent) as HTMLElement)
        .parentElement as HTMLElement;
      expect((await axe(controls)).violations).toEqual([]);
    },
  );
});
