import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import * as copy from "../../../src/features/tasks/copy";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  OccurrencePage,
  OccurrenceView,
} from "../../../src/features/tasks/model/contract";
import { installMatchMedia } from "../../helpers/match-media";
import {
  fakeApi,
  ME,
  mountTasks,
  seededTask,
  TODAY,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * WF-TODAY-01 (A1, A2, A20) in the app's router over the PRODUCTION data controller and the IndexedDB double, with a scripted `/daily`.
 * FIXTURE evidence: a stubbed answer is the stub's.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});
const PATH = `/today?day=${TODAY}&tz=UTC`;
const view = (
  task: Awaited<ReturnType<typeof seededTask>>,
  over: Partial<OccurrenceView> = {},
): OccurrenceView => ({
  id: task.occurrenceId,
  version: 1,
  can_edit: true,
  data: task.data,
  outcome: "incomplete",
  period_outcome: "incomplete",
  actionable: true,
  ...over,
});
const page = (items: OccurrenceView[], over: Partial<OccurrencePage> = {}) => ({
  ok: true as const,
  value: { items, next_after: null, revision: 5, pending_tasks: [], ...over },
});
const row = (id: string) =>
  document.querySelector(`[data-today-row="${id}"]`) as HTMLElement | null;

describe("offline: the day from the cache", () => {
  test("a cached task shows with its state; Mark done saves a record draft and the row says so, provisional and not sent", async () => {
    const task = await seededTask({ title: "Brush your teeth" });
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId) !== null);
    expect(t.api.calls.readDaily).toBeUndefined();
    const r = row(task.occurrenceId);
    expect(r).not.toBeNull();
    expect(
      within(r as HTMLElement).getByRole("link", { name: "Brush your teeth" }),
    ).toBeInTheDocument();
    expect(r?.dataset.pill).toBe("to_do");
    expect(screen.getByText(copy.SUMMARY(0, 1, 1, 0))).toBeInTheDocument();
    fireEvent.click(
      within(r as HTMLElement).getByRole("button", { name: copy.MARK_DONE }),
    );
    await t.settle();
    const [draft] = t.drafts();
    expect(draft?.kind).toBe("record");
    expect(draft?.expected_version).toBe(1);
    const after = row(task.occurrenceId) as HTMLElement;
    expect(after.dataset.pill).toBe("done");
    expect(
      within(after).getByText(`${copy.PILL.done} (${copy.PROVISIONAL})`),
    ).toBeInTheDocument();
    expect(after.querySelector("[data-pending-mark]")?.textContent).toBe(
      copy.PENDING.queued,
    );
  });

  test("an archived task is not in the offline day; an undated actionable task is", async () => {
    const archived = await seededTask({ title: "Old", archived: true });
    const inbox = await seededTask({ title: "Inbox item", date: null });
    const t = await mountTasks({
      path: PATH,
      rows: [...archived.rows, ...inbox.rows],
      env: { online: false },
    });
    await t.until(() => row(inbox.occurrenceId) !== null);
    expect(row(archived.occurrenceId)).toBeNull();
    expect(row(inbox.occurrenceId)).not.toBeNull();
  });

  test("a stream that is absent is never counted as zero: the summary says it is not known", async () => {
    const task = await seededTask({ stream: false });
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId)?.dataset.pill === "unavailable");
    expect(row(task.occurrenceId)?.dataset.pill).toBe("unavailable");
    // Not actionable here (no stream of mine), not done, state unknown: "not known", never zero.
    expect(screen.getByText(copy.SUMMARY(0, 1, 0, 1))).toBeInTheDocument();
  });
});

describe("online: /daily", () => {
  test("both scopes are read; the server's derived fields win for a row with no outstanding draft; filters and the pending-tasks notice", async () => {
    const a = await seededTask({ title: "A" });
    const b = await seededTask({ title: "B" });
    const api = fakeApi();
    const done = view(a, {
      outcome: "complete",
      period_outcome: "complete",
      actionable: false,
    });
    api.respond = (q) =>
      q.scope === "joint"
        ? page([done, view(b)], { pending_tasks: [a.taskId] })
        : page([done, view(b)]);
    const t = await mountTasks({
      path: PATH,
      rows: [...a.rows, ...b.rows],
      api,
    });
    await t.until(() => row(a.occurrenceId)?.dataset.source === "server");
    expect(new Set(api.queries.map((q) => q.scope))).toEqual(
      new Set(["joint", "personal"]),
    );
    expect(row(a.occurrenceId)?.dataset.pill).toBe("done");
    expect(row(a.occurrenceId)?.dataset.source).toBe("server");
    expect(screen.getByText(copy.SUMMARY(1, 2, 1, 0))).toBeInTheDocument();
    expect(document.querySelector("[data-pending-tasks]")).toHaveTextContent(
      copy.PENDING_TASKS,
    );
    fireEvent.click(
      screen.getByRole("radio", { name: copy.FILTER_LABEL.done }),
    );
    expect(row(a.occurrenceId)).not.toBeNull();
    expect(row(b.occurrenceId)).toBeNull();
  });

  test("TASK-7: a 409 on a continuation restarts the scope from the first page; no page of the old revision is kept", {
    timeout: 20_000,
  }, async () => {
    const a = await seededTask({ title: "A" });
    const b = await seededTask({ title: "B" });
    const api = fakeApi();
    // Strengthened in revision 1 (the assertions are unchanged): the scenario is played in ONE read chain. While the screen settles
    // (StrictMode and the protected tree may start more than one chain) every read gets an empty day; then a committed sync page starts
    // exactly one new chain, and only that chain meets the 409. With a flag shared by several chains, a second chain that began after the
    // 409 reached the right state on its own and hid a chain that did not restart (MU-2023 survived the revision-1 qualification).
    let scenario = false;
    let conflicted = false;
    api.respond = (q) => {
      if (!scenario) return page([]);
      if (q.scope === "personal") return page([view(b)], { revision: 6 });
      if (q.revision === 5) {
        conflicted = true;
        return { ok: false, kind: "conflict" };
      }
      return conflicted
        ? page([view(b)], { revision: 6 })
        : page([view(a)], { next_after: a.occurrenceId, revision: 5 });
    };
    const t = await mountTasks({
      path: PATH,
      rows: [...a.rows, ...b.rows],
      api,
    });
    await t.until(() => row(a.occurrenceId) !== null);
    scenario = true;
    const from = api.queries.length;
    await t.commitSync([a.rows[0] as never]);
    for (let i = 0; i < 5; i += 1)
      await t.until(
        () =>
          row(b.occurrenceId)?.dataset.source === "server" &&
          row(a.occurrenceId) !== null,
      );
    // The continuation carried the first page's revision; after the 409 the next read is a FIRST page again (no revision).
    const joint = api.queries.slice(from).filter((q) => q.scope === "joint");
    const at = joint.findIndex((q) => q.revision === 5);
    expect(joint[at]).toEqual({
      scope: "joint",
      after: a.occurrenceId,
      revision: 5,
    });
    expect(joint[at + 1]).toEqual({ scope: "joint" });
    // A is in the cache and in the day, so it still shows, but derived locally: the discarded page's answer is not used.
    expect(row(a.occurrenceId)?.dataset.source).toBe("local");
    expect(row(b.occurrenceId)?.dataset.source).toBe("server");
  });

  test("three restarts in a row end in the error state with Try again", async () => {
    const a = await seededTask();
    const api = fakeApi();
    api.respond = (q) =>
      q.revision === undefined
        ? page([view(a)], { next_after: a.occurrenceId })
        : { ok: false, kind: "conflict" };
    const t = await mountTasks({ path: PATH, rows: a.rows, api });
    await t.until(() => document.querySelector("[data-today-error]") !== null);
    expect(
      document
        .querySelector("[data-today-error]")
        ?.getAttribute("data-today-error"),
    ).toBe("kept_changing");
    expect(screen.getByText(copy.KEPT_CHANGING)).toBeInTheDocument();
  });

  test("a 403 is remembered for the identity: a remount does not ask again; Try again does", async () => {
    const api = fakeApi();
    api.daily.joint.push({ ok: false, kind: "forbidden" });
    const t = await mountTasks({ path: PATH, api });
    const asked = api.calls.readDaily;
    expect(document.querySelector("[data-today-error]")).not.toBeNull();
    t.unmount();
    const again = await mountTasks({ path: PATH, api });
    expect(api.calls.readDaily).toBe(asked);
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await again.settle();
    expect(api.calls.readDaily).toBeGreaterThan(asked as number);
  });

  test("a 403 that arrives AFTER the view unmounted (the session remounts the tree on a 403) is still remembered: the remount asks nothing", async () => {
    let release: (v: unknown) => void = () => undefined;
    const held = new Promise((r) => {
      release = r;
    });
    const api = fakeApi();
    api.respond = () => undefined;
    const forbidden = async () => {
      await held;
      return { ok: false as const, kind: "forbidden" as const };
    };
    api.daily.joint.push(forbidden, forbidden);
    api.daily.personal.push(forbidden, forbidden);
    const t = await mountTasks({ path: PATH, api });
    const asked = api.calls.readDaily ?? 0;
    expect(asked).toBeGreaterThan(0);
    t.unmount();
    await act(async () => release(null));
    await t.settle();
    const again = await mountTasks({ path: PATH, api });
    await again.until(
      () => document.querySelector("[data-today-error]") !== null,
    );
    expect(document.querySelector("[data-today-error]")).not.toBeNull();
    expect(api.calls.readDaily).toBe(asked);
  });

  test("a late answer for a previous identity is never shown under the new one", async () => {
    const a = await seededTask({ title: "Theirs" });
    // Strengthened in revision 1 (the assertion is unchanged): EVERY read made under the first identity is held, whichever mount makes it.
    // The screens mount twice while the cache facts load (CacheGate), and a scripted queue of two held answers was used up by whichever
    // mount read first: when that was the discarded one, no late answer could ever reach the view, and the three-layer mutant MU-2025
    // survived a managed run. The reads of the second identity answer at once with an empty day.
    const held: Array<() => void> = [];
    const api = fakeApi();
    api.readDaily = () =>
      new Promise((resolve) => {
        held.push(() =>
          resolve(
            page([
              view(a, {
                outcome: "complete",
                period_outcome: "complete",
                actionable: false,
              }),
            ]),
          ),
        );
      });
    const t = await mountTasks({ path: PATH, api });
    expect(held.length).toBeGreaterThanOrEqual(2);
    const next = fakeApi();
    t.rerender(tasksEnv(next, { identity: `${ME}:2` }));
    await t.settle();
    await act(async () => {
      for (const release of held.splice(0)) release();
    });
    // A late answer that WERE applied needs several turns to be composed (the related rows are read after it), so the test waits, bounded,
    // for the row to appear before asserting that it never does.
    await t.until(() => row(a.occurrenceId) !== null);
    expect(row(a.occurrenceId)).toBeNull();
  });
});

describe("accessibility (jsdom layer)", () => {
  test("no axe violations with rows, offline", async () => {
    const task = await seededTask();
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId) !== null);
    // Revision 9 (review 9 R21): `until` gives up silently after its rounds, and axe passes a page whose row never appeared (shown by
    // the diagnostic that mounts no rows); the row is the page this case judges, so its readiness is asserted first.
    expect(
      row(task.occurrenceId),
      "readiness: the cached row did not appear within the bounded settling",
    ).not.toBeNull();
    expect((await axe(document.body)).violations).toEqual([]);
  });
});
