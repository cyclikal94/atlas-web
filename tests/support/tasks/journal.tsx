/**
 * The open full history composed through the production task detail over the IndexedDB double, with a scripted journal endpoint
 * (`after`/`limit` paging by `sequence`, as the contract's). Revision 6 (R16, R17): the helpers of `journal-ownership.test.tsx` (kept
 * unchanged there), plus what a draft's and a save's schedules need: a gate on the local save, a gate on the detail's local read, and the
 * React handler of a Save button taken while it was enabled (a stale callback or programmatic activation the disabled control cannot stop).
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { expect } from "vitest";
import type { CacheRow } from "../../../src/data";
import { StoreFailure } from "../../../src/data/store/port";
import type { TasksResult } from "../../../src/features/tasks/api";
import { HISTORY_COPY } from "../../../src/features/tasks/detail/EntryHistory";
import type { TasksEnv } from "../../../src/features/tasks/env";
import type {
  JournalEntry,
  ProgressJournal,
} from "../../../src/features/tasks/model/contract";
import {
  fakeApi,
  ME,
  type Mounted,
  mountTasks,
  type SeededTask,
  seededTask,
} from "./world";

export const SLOW = { timeout: 30_000 };
export const PAGE = 200;
const NOW = Math.floor(Date.now() / 1000);
export const entryId = (n: number) =>
  `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const entry = (
  n: number,
  over: Partial<JournalEntry> = {},
): JournalEntry => ({
  id: entryId(n),
  sequence: n,
  logical_order: n,
  replaces: null,
  evidence: { kind: "quantity", amount: String(n) },
  happened_at: NOW,
  recorded_by: ME,
  ...over,
});
export const recent = (e: JournalEntry) => ({
  id: e.id,
  evidence: e.evidence,
  happened_at: e.happened_at,
  recorded_by: e.recorded_by,
});
export const journalOf = (n: number) =>
  Array.from({ length: n }, (_, i) => entry(i + 1));

export type Answer = TasksResult<ProgressJournal>;
export interface Held {
  after: number;
  release(answer?: Answer): void;
}

/**
 * A journal endpoint over `entries()` (read when ASKED, so a held request answers with the journal as it was when it was dispatched).
 * `hold(match)` holds the requests it matches until released (optionally with another answer); `answer(fn)` replaces the answer to the
 * requests it matches. Records every request and the most ever in flight.
 */
export function journalApi(entries: () => JournalEntry[]) {
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
      const dispatched = answerIf?.(after) ?? pageAt(after);
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
        return replaced ?? dispatched;
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

export type Journaled = Awaited<ReturnType<typeof mountWith>>;

export async function mountWith(
  journal: () => JournalEntry[],
  recentOf: JournalEntry[],
  env: Partial<TasksEnv> = {},
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
    env,
  });
  await t.until(() => document.querySelector("[data-entry-history]") !== null);
  return { task, t, ...j };
}

export const history = () =>
  document.querySelector("[data-entry-history]") as HTMLElement;
export const rendered = () =>
  [...history().querySelectorAll("[data-entry]")].map((e) =>
    e.getAttribute("data-entry"),
  );
export const button = (name: string) =>
  within(history()).queryByRole("button", { name });
export const row = (n: number) =>
  history().querySelector(`[data-entry="${entryId(n)}"]`) as HTMLElement | null;
export const fixButton = (n: number) => {
  const li = row(n);
  return li === null
    ? null
    : within(li).queryByRole("button", { name: HISTORY_COPY.fix });
};
export const forms = () => [...document.querySelectorAll("[data-fix-form]")];
export const valueInput = () =>
  screen.queryByLabelText(
    new RegExp(`^${HISTORY_COPY.newValue}`),
  ) as HTMLInputElement | null;
/** The entry whose row holds the open fix form (null when the form is detached or absent). */
export const fixedEntry = () =>
  forms()[0]?.closest("[data-entry]")?.getAttribute("data-entry") ?? null;
export const records = (t: Mounted) =>
  t.bodies().filter((b) => b.command.command.kind === "record");
/** The open fix's Save button, enabled or not (null when no fix is open). */
export const saveButton = () =>
  (forms()[0]?.querySelector("button") ?? null) as HTMLButtonElement | null;
/** The reason the open fix's Save is disabled, or null when it is enabled (or no fix is open). */
export const saveReason = (): string | null => {
  const save = saveButton();
  if (save === null || !save.disabled) return null;
  const id = save.getAttribute("aria-describedby")?.split(" ")[0];
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
};

export async function click(t: Mounted, name: string) {
  const b = button(name);
  expect(b, `button ${name}`).not.toBeNull();
  await act(async () => {
    fireEvent.click(b as HTMLElement);
  });
  await t.settle();
}
export async function fix(t: Mounted, n: number) {
  const b = fixButton(n);
  expect(b, `Fix of entry ${n}`).not.toBeNull();
  await act(async () => {
    fireEvent.click(b as HTMLElement);
  });
  await t.settle();
}
export async function type(t: Mounted, value: string) {
  const input = valueInput();
  expect(input, "the open fix's value field").not.toBeNull();
  await act(async () => {
    fireEvent.change(input as HTMLInputElement, { target: { value } });
  });
  await t.settle();
}
export async function release(
  t: Mounted,
  held: Held | undefined,
  answer?: Answer,
) {
  expect(held, "a held journal request").toBeDefined();
  await act(async () => held?.release(answer));
  await t.settle();
}
export async function cancel(t: Mounted) {
  const b = screen.queryByRole("button", { name: HISTORY_COPY.cancel });
  expect(b, "Cancel of the open fix").not.toBeNull();
  await act(async () => {
    fireEvent.click(b as HTMLElement);
  });
  await t.settle();
}
/** Presses the open fix's Save through the page (a disabled Save dispatches nothing). */
export async function save(t: Mounted) {
  const b = saveButton();
  expect(b, "the open fix's Save").not.toBeNull();
  await act(async () => {
    fireEvent.click(b as HTMLElement);
  });
  await t.settle();
}

/**
 * The React click handler of the open fix's Save, taken NOW (while it is enabled): calling it later is a stale callback or a programmatic
 * activation, which the disabled control of a later render cannot stop. Only the save decision taken when it runs can.
 */
export function takeSaveHandler(): () => void {
  const b = saveButton();
  expect(b?.disabled, "Save is enabled when its handler is taken").toBe(false);
  const key = Object.keys(b as object).find((k) =>
    k.startsWith("__reactProps$"),
  );
  const props = (b as unknown as Record<string, { onClick?: () => void }>)[
    key ?? ""
  ];
  const onClick = props?.onClick;
  expect(typeof onClick, "the Save handler").toBe("function");
  return onClick as () => void;
}
export async function call(t: Mounted, handler: () => void) {
  await act(async () => {
    handler();
  });
  await t.settle();
}

/** Commits my stream at a new version through the production sync page, with `entries` as its recent tail. */
export async function commitStream(
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

export const REFUSED = { ok: false, kind: "not_found" } as const;
export const FORBIDDEN = { ok: false, kind: "forbidden" } as const;

/**
 * A gate on the local save of a record (the outbox's `enqueue`, as the task actions call it): `hold()` makes the next enqueue wait until
 * `answer(ok)` (true: it is saved; false: it fails like a store failure, nothing saved). Counts every enqueue reaching the store.
 */
export function saveGate(t: Mounted) {
  const real = t.data.outbox.bind(t.data);
  let holding = false;
  let waiting: Array<(ok: boolean) => void> = [];
  let calls = 0;
  (t.data as { outbox: typeof t.data.outbox }).outbox = () => {
    const outbox = real();
    if (outbox === null) return null;
    return new Proxy(outbox, {
      get(target, key, receiver) {
        if (key !== "enqueue") return Reflect.get(target, key, receiver);
        return async (request: Parameters<typeof target.enqueue>[0]) => {
          calls += 1;
          if (holding) {
            holding = false;
            const ok = await new Promise<boolean>((resolve) =>
              waiting.push(resolve),
            );
            if (!ok) throw new Error("storage (test)");
          }
          return target.enqueue(request);
        };
      },
    });
  };
  return {
    hold: () => {
      holding = true;
    },
    held: () => waiting.length,
    calls: () => calls,
    answer: async (ok: boolean) => {
      const next = waiting.shift();
      expect(next, "a held save").toBeDefined();
      await act(async () => next?.(ok));
      await t.settle();
    },
    restore: () => {
      (t.data as { outbox: typeof t.data.outbox }).outbox = real;
      waiting = [];
    },
  };
}

/**
 * A gate on the detail's local read (its read of the displayed day's rows by id, which includes my progress stream): while armed, that read
 * waits until `release(fail)`; `fail` makes it fail like a store error. Installed over the open service's store.
 */
export function detailReadGate(t: Mounted, progressId: string) {
  const service = t.data.service();
  if (service === null) throw new Error("no service");
  const store = service.store as { run: typeof service.store.run };
  const original = store.run.bind(service.store);
  let armed = false;
  let waiting: Array<(fail: boolean) => void> = [];
  store.run = (async (plan, input, options) => {
    const ids = ((input as { ids?: string[] }).ids ?? []) as string[];
    if (
      armed &&
      plan.name === "data.readResourcesById" &&
      ids.includes(progressId)
    ) {
      armed = false;
      const fail = await new Promise<boolean>((resolve) =>
        waiting.push(resolve),
      );
      if (fail) throw new StoreFailure("error");
    }
    return original(plan, input, options);
  }) as typeof service.store.run;
  return {
    arm: () => {
      armed = true;
    },
    held: () => waiting.length,
    release: async (fail = false) => {
      const next = waiting.shift();
      expect(next, "a held detail read").toBeDefined();
      await act(async () => next?.(fail));
      await t.settle();
    },
    restore: () => {
      store.run = original;
      waiting = [];
    },
  };
}
