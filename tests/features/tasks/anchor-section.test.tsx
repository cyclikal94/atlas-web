import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type CacheRow,
  type EnqueueRequest,
  readResourceViewNow,
} from "../../../src/data";
import type { Loadable, Watchable } from "../../../src/data/store/port";
import { setAnchorRequest } from "../../../src/features/calendars/anchors";
import * as words from "../../../src/features/calendars/copy-anchor";
import type { CalendarAnchor } from "../../../src/features/calendars/model/anchor";
import {
  createTasksApi,
  type TasksResult,
  untilSentWhile,
} from "../../../src/features/tasks/api";
import { forgetBindings } from "../../../src/features/tasks/detail/anchor-binding";
import { forgetKeptPanels } from "../../../src/features/tasks/detail/anchor-kept";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { StampedRequestError } from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import { cacheRow, draftRow } from "../../support/data/rows";
import { sectionTaskRead } from "../../support/tasks/task-read";
import {
  fakeApi,
  mountTasks,
  type SeededTask,
  seededTask,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * WEB-13b §4.3/§4.4 (cases 1 and 3; Q22 "other calendar commands"): the task's "Calendar anchor": the binding read ONLINE once per visit
 * (a remount, such as the session's re-check of a `403`, reads nothing more), offline "Binding details need a connection." with the rest
 * of the task still shown, and the queued `set_anchor` (set, change, remove), its conflict ("Review", superseding on the new version) and
 * its refusal. In the app's router over the PRODUCTION data controller and the IndexedDB double: FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
/** The control asserted present (an assertion, not a query error, when it is missing), then returned to act on. */
const present = (element: HTMLElement | null): HTMLElement => {
  expect(element).not.toBeNull();
  return element as HTMLElement;
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetTaskMemory();
  forgetAllCorrections();
  forgetBindings();
  forgetKeptPanels();
});

const SOURCE = "00000000-0000-4000-8000-0000000000a1";
const EVENT = "00000000-0000-4000-8000-0000000000e1";
const ANCHOR: CalendarAnchor = {
  reference: { kind: "event_series", source_id: SOURCE, uid: "bin@example" },
  offset: { kind: "calendar_days", days: -1, time: "18:00:00" },
  weekdays: [],
};
const sourceRow = cacheRow({
  id: SOURCE,
  kind: "calendar_source",
  label: "Family calendar",
  value: { timezone: "Europe/London" },
});
const eventRow = (over: Partial<CacheRow> = {}) =>
  cacheRow({
    id: EVENT,
    kind: "event",
    parent_id: SOURCE,
    label: "Bin day",
    value: {
      uid: "bin@example",
      original: "2026-11-02",
      title: "Bin day",
      start: {
        date: "2026-11-02",
        time: "07:00:00",
        timezone: "Europe/London",
        instant: 1793602800,
      },
      end: null,
      status: "present",
      sequence: 0,
    },
    ...over,
  });

type Mounted = Awaited<ReturnType<typeof mountTasks>>;
const section = () =>
  document.querySelector("[data-anchor-section]") as HTMLElement | null;
const anchorDrafts = (t: Mounted) =>
  t.drafts().filter((d) => d.kind === "set_anchor");
const bodyOf = (t: Mounted, id: string) =>
  t.bodies().find((b) => b.local_id === id)?.command.command;
/** The panel the press opened, asserted (revision 13: a panel that never opens fails as an assertion, not a query's timeout). */
async function dialogOpened(t: Mounted): Promise<HTMLElement> {
  await t.until(() => screen.queryByRole("dialog") !== null);
  return present(screen.queryByRole("dialog"));
}
/**
 * Waits until the section's own read of the task (installed before the section mounted again) is ready and shown: a panel opened before
 * it has no read to save on (R11, revision 13), so a test about something else opens its panel after it.
 */
async function taskReadShown(
  t: Mounted,
  taskRead: ReturnType<typeof sectionTaskRead>,
) {
  expect(taskRead.subscriptions()).toBeGreaterThan(0);
  await t.until(() => taskRead.real()?.status === "ready");
  expect(taskRead.real()?.status).toBe("ready");
  await t.settle();
}

async function mounted(
  task: SeededTask,
  options: {
    online?: boolean;
    /** `live`: the section's lifetime, as the production API is given it (R6). */
    binding?: (live?: () => boolean) => Promise<
      TasksResult<{
        binding: {
          anchor: CalendarAnchor;
          version: number;
          active: boolean;
        } | null;
      }>
    >;
    rows?: CacheRow[];
    drafts?: object[];
    effects?: object[];
  } = {},
) {
  const api = fakeApi(
    options.binding
      ? {
          readAnchor: async (_: string, live?: () => boolean) => {
            api.calls.readAnchor = (api.calls.readAnchor ?? 0) + 1;
            return (options.binding as NonNullable<typeof options.binding>)(
              live,
            );
          },
        }
      : {},
  );
  const t = await mountTasks({
    syncModel: { phase: "synced", pendingCount: 1, conflictCount: 0 },
    path: `/tasks/${task.taskId}`,
    rows: [...task.rows, ...(options.rows ?? [])],
    api,
    env: { online: options.online ?? true },
    ...(options.drafts ? { drafts: options.drafts } : {}),
    ...(options.effects ? { effects: options.effects } : {}),
  });
  await t.until(() => section() !== null);
  await t.settle();
  return t;
}

describe("the binding read (case 3, D-13b-9)", () => {
  test("online: read once and shown; a remount of the tree under the same visit reads nothing more", async () => {
    const task = await seededTask();
    const t = await mounted(task, {
      binding: async () => ({
        ok: true,
        value: { binding: { anchor: ANCHOR, version: 2, active: true } },
      }),
      rows: [sourceRow],
    });
    expect(section()?.getAttribute("data-anchor-section")).toBe("anchored");
    expect(section()).toHaveTextContent(
      words.anchoredTo(
        "Family calendar · a calendar event · 1 day before at 18:00",
      ),
    );
    expect(t.api.calls.readAnchor).toBe(1);
    act(() => t.remount());
    await t.until(() => section() !== null);
    await t.settle();
    expect(section()?.getAttribute("data-anchor-section")).toBe("anchored");
    expect(t.api.calls.readAnchor).toBe(1);
  });

  test("an inactive binding says automation is off; none says not anchored (never 'deleted')", async () => {
    const task = await seededTask();
    await mounted(task, {
      binding: async () => ({
        ok: true,
        value: { binding: { anchor: ANCHOR, version: 3, active: false } },
      }),
    });
    expect(section()).toHaveTextContent(words.AUTOMATION_OFF);
    cleanup();
    forgetBindings();
    const other = await seededTask();
    await mounted(other, {
      binding: async () => ({ ok: true, value: { binding: null } }),
    });
    expect(section()).toHaveTextContent(words.NOT_ANCHORED);
  });

  test("offline: 'Binding details need a connection.', nothing is read, and the task's day is still shown from the cache", async () => {
    const task = await seededTask();
    const t = await mounted(task, {
      online: false,
      binding: async () => ({ ok: true, value: { binding: null } }),
    });
    expect(section()?.getAttribute("data-anchor-section")).toBe("offline");
    expect(section()).toHaveTextContent(words.BINDING_OFFLINE);
    expect(t.api.calls.readAnchor ?? 0).toBe(0);
    expect(document.querySelector("[data-detail-day]")).not.toBeNull();
  });

  test("a refusal (403) is recorded when it arrives: a remount does not read again; Try again reads once more", async () => {
    const task = await seededTask();
    const t = await mounted(task, {
      binding: async () => ({ ok: false, kind: "forbidden" }),
    });
    expect(section()).toHaveTextContent(words.BINDING_FAILED);
    expect(t.api.calls.readAnchor).toBe(1);
    act(() => t.remount());
    await t.until(() => section() !== null);
    await t.settle();
    expect(t.api.calls.readAnchor).toBe(1);
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.TRY_AGAIN,
        }),
      ),
    );
    await t.settle();
    expect(t.api.calls.readAnchor).toBe(2);
  });

  test("a read never sent (not_sent) leaves nothing: a later mount of the visit reads", async () => {
    const task = await seededTask();
    let answers = 0;
    const t = await mounted(task, {
      binding: async () => {
        answers += 1;
        return answers === 1
          ? { ok: false, kind: "not_sent" }
          : { ok: true, value: { binding: null } };
      },
    });
    act(() => t.remount());
    await t.until(() => section() !== null);
    await t.settle();
    expect(t.api.calls.readAnchor).toBe(2);
    expect(section()).toHaveTextContent(words.NOT_ANCHORED);
  });

  test("a task that repeats on its own schedule has no anchor section and reads nothing", async () => {
    const task = await seededTask({
      definition: {
        schedule: {
          start_date: "2026-10-01",
          time: null,
          timezone: "UTC",
          repeat: { frequency: "daily", interval: 1 },
        },
      },
    });
    const api = fakeApi();
    const t = await mountTasks({
      syncModel: { phase: "synced", pendingCount: 1, conflictCount: 0 },
      path: `/tasks/${task.taskId}`,
      rows: task.rows,
      api,
    });
    await t.until(() => document.querySelector("[data-task-detail]") !== null);
    await t.settle();
    expect(section()).toBeNull();
    expect(api.calls.readAnchor ?? 0).toBe(0);
  });
});

describe("set_anchor (queued, offline included)", () => {
  async function chooseEvent(t: Mounted, dialog: HTMLElement) {
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.CHANGE_EVENT }),
      ),
    );
    await t.settle();
    const pick = await within(dialog).findByText("Bin day");
    fireEvent.click(pick.closest("button") as HTMLElement);
    await t.settle();
  }

  test("Anchor… → choose an event, an offset → Save anchor queues set_anchor on the TASK's version, offline", async () => {
    const task = await seededTask();
    const t = await mounted(task, {
      online: false,
      rows: [sourceRow, eventRow()],
    });
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.ANCHOR_ACTION,
        }),
      ),
    );
    const dialog = await dialogOpened(t);
    await chooseEvent(t, dialog);
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value: "-1" },
      },
    );
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.TIME_LABEL)),
      {
        target: { value: "18:00" },
      },
    );
    fireEvent.click(
      present(within(dialog).queryByRole("button", { name: "Monday" })),
    );
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    const [draft] = anchorDrafts(t);
    expect(draft).toMatchObject({
      endpoint: "/calendar-commands",
      status: "queued",
      target_resource_ids: [task.taskId],
      expected_version: 1,
    });
    expect(bodyOf(t, draft?.local_id as string)).toEqual({
      kind: "set_anchor",
      id: task.taskId,
      expected_version: 1,
      anchor: { ...ANCHOR, weekdays: [1] },
    });
    expect(section()).toHaveTextContent(words.ANCHOR_QUEUED);
  });

  test("field messages are inline and keep what was typed; seconds need a timed event; a person date hides Title contains and keeps it", async () => {
    const task = await seededTask();
    const t = await mounted(task, {
      online: false,
      rows: [
        sourceRow,
        eventRow({
          value: {
            ...(eventRow().value as Record<string, unknown>),
            start: {
              date: "2026-11-02",
              time: null,
              timezone: "Europe/London",
              instant: null,
            },
          } as never,
        }),
      ],
    });
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.ANCHOR_ACTION,
        }),
      ),
    );
    const dialog = await dialogOpened(t);
    await chooseEvent(t, dialog);
    const seconds = present(
      within(dialog).queryByRole("radio", {
        name: words.OR_SECONDS,
      }),
    );
    expect(seconds).toBeDisabled();
    expect(seconds).toHaveAccessibleDescription(words.NEEDS_TIMED_EVENT);
    const days = present(
      within(dialog).queryByLabelText(words.DAYS_LABEL),
    ) as HTMLInputElement;
    fireEvent.change(days, { target: { value: "one" } });
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.TITLE_CONTAINS)),
      {
        target: { value: "Bin" },
      },
    );
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(
      present(within(dialog).queryByText(words.WHOLE_NUMBER)),
    ).toBeInTheDocument();
    expect(days.value).toBe("one");
    fireEvent.click(
      present(within(dialog).queryByRole("radio", { name: words.PERSON_DATE })),
    );
    expect(within(dialog).queryByLabelText(words.TITLE_CONTAINS)).toBeNull();
    fireEvent.click(
      present(
        within(dialog).queryByRole("radio", { name: words.EVENT_SERIES }),
      ),
    );
    expect(
      (
        present(
          within(dialog).queryByLabelText(words.TITLE_CONTAINS),
        ) as HTMLInputElement
      ).value,
    ).toBe("Bin");
    expect(anchorDrafts(t)).toEqual([]);
  });

  test("Remove anchor queues set_anchor with anchor: null", async () => {
    const task = await seededTask();
    const t = await mounted(task, {
      binding: async () => ({
        ok: true,
        value: { binding: { anchor: ANCHOR, version: 2, active: true } },
      }),
      rows: [sourceRow],
    });
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.CHANGE_ANCHOR,
        }),
      ),
    );
    const dialog = await dialogOpened(t);
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.REMOVE_ANCHOR }),
      ),
    );
    await t.settle();
    const [draft] = anchorDrafts(t);
    expect(bodyOf(t, draft?.local_id as string)).toMatchObject({
      kind: "set_anchor",
      anchor: null,
    });
  });

  test("a conflicted change (409 conflict) says so; Review opens its anchor and Save SUPERSEDES it on the current version", async () => {
    const task = await seededTask();
    const conflicted = draftRow({
      local_id: "00000000-0000-4000-8000-00000000c0f1",
      endpoint: "/calendar-commands",
      status: "version_conflict",
      command: {
        command: {
          kind: "set_anchor",
          id: task.taskId,
          expected_version: 0,
          anchor: ANCHOR,
        },
      } as never,
      target_resource_ids: [task.taskId],
      index_targets: [task.taskId],
      bases: { [task.taskId]: 0 },
      last_error: { status: 409, code: "conflict", stage: "conflict" },
    });
    const t = await mounted(task, {
      online: false,
      rows: [sourceRow, eventRow()],
      drafts: [conflicted],
    });
    expect(section()).toHaveTextContent(words.ANCHOR_CONFLICT);
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.REVIEW_ANCHOR,
        }),
      ),
    );
    const dialog = await dialogOpened(t);
    expect(
      (
        present(
          within(dialog).queryByLabelText(words.TIME_LABEL),
        ) as HTMLInputElement
      ).value,
    ).toBe("18:00");
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    const all = anchorDrafts(t);
    expect(all.find((d) => d.local_id === conflicted.local_id)).toBeUndefined();
    const replacement = all.find((d) => d.status === "queued");
    expect(bodyOf(t, replacement?.local_id as string)).toMatchObject({
      kind: "set_anchor",
      expected_version: 1,
      anchor: ANCHOR,
    });
  });

  test("a refused change shows the reason with Dismiss (the generic discard)", async () => {
    const task = await seededTask();
    const refused = draftRow({
      local_id: "00000000-0000-4000-8000-00000000c0f2",
      endpoint: "/calendar-commands",
      status: "rejected",
      command: {
        command: {
          kind: "set_anchor",
          id: task.taskId,
          expected_version: 1,
          anchor: ANCHOR,
        },
      } as never,
      target_resource_ids: [task.taskId],
      index_targets: [task.taskId],
      last_error: { status: 403, code: "forbidden", stage: "rejected" },
    });
    const t = await mounted(task, { online: false, drafts: [refused] });
    expect(section()).toHaveTextContent(
      words.anchorRejected(words.ANCHOR_REASONS.unavailable as string),
    );
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.DISMISS_ANCHOR,
        }),
      ),
    );
    await t.settle();
    expect(anchorDrafts(t)).toEqual([]);
  });

  test("a receipted change of this task's anchor reads the binding again, once", async () => {
    const task = await seededTask();
    const receipted = draftRow({
      local_id: "00000000-0000-4000-8000-00000000c0f3",
      endpoint: "/calendar-commands",
      status: "acknowledged",
      receipt_revision: 9,
      command: {
        command: {
          kind: "set_anchor",
          id: task.taskId,
          expected_version: 1,
          anchor: ANCHOR,
        },
      } as never,
      target_resource_ids: [task.taskId],
      index_targets: [task.taskId],
    });
    const t = await mounted(task, {
      binding: async () => ({ ok: true, value: { binding: null } }),
      drafts: [receipted],
      // The effect a receipt leaves on the task (no display patch), as the production outbox writes it.
      effects: [
        {
          resource_id: task.taskId,
          local_id: receipted.local_id,
          display: null,
          resource_version: 1,
          receipt_revision: 9,
          submitted_at_page_seq: 0,
          last_mentioned_page_seq: null,
          no_publication_floor: 0,
          resolved: null,
          created_at: "2026-10-01T09:00:00.000Z",
        },
      ],
    });
    expect(section()).toHaveTextContent(words.ANCHOR_SAVING);
    expect(t.api.calls.readAnchor).toBe(2);
    act(() => t.remount());
    await t.until(() => section() !== null);
    await t.settle();
    expect(t.api.calls.readAnchor).toBe(2);
  });

  test("I cannot change the task: Anchor… is unavailable with the reason", async () => {
    const task = await seededTask();
    const rows = task.rows.map((row) =>
      row.kind === "task" ? { ...row, can_edit: false } : row,
    );
    await mounted({ ...task, rows }, { online: false });
    const action = present(
      within(section() as HTMLElement).queryByRole("button", {
        name: words.ANCHOR_ACTION,
      }),
    );
    expect(action).toBeDisabled();
    expect(action).toHaveAccessibleDescription(words.ANCHOR_NOT_SAVED_DENIED);
  });
});

describe("revision 1: each change is its own operation, settled as submitted (R2, R3, R5)", () => {
  const read = (anchor: CalendarAnchor = ANCHOR) => ({
    rows: [sourceRow],
    binding: async () => ({
      ok: true as const,
      value: { binding: { anchor, version: 1, active: true } },
    }),
  });
  async function openChange(t: Mounted) {
    // Asserted present (revision 13): a panel left open hides the section, which must fail as an assertion, not a query error (MU-5064).
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.CHANGE_ANCHOR,
        }),
      ),
    );
    const dialog = await dialogOpened(t);
    await t.settle();
    return dialog;
  }
  async function saveDays(t: Mounted, days: string) {
    const dialog = await openChange(t);
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value: days },
      },
    );
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  const offsets = (t: Mounted) =>
    anchorDrafts(t).map(
      (d) => (bodyOf(t, d.local_id)?.anchor as CalendarAnchor | null)?.offset,
    );
  /** Holds the delivery of the outbox's successful answer (the change IS stored) until released. */
  function holdEnqueue(t: Mounted, method: "enqueue" | "supersede") {
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const original = (
      outbox[method] as (...a: never[]) => Promise<unknown>
    ).bind(outbox);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(outbox, method).mockImplementationOnce((async (
      ...args: never[]
    ) => {
      const outcome = await original(...args);
      await gate;
      return outcome;
    }) as never);
    return release;
  }

  test("R2 control: two different changes queue two commands, in order", async () => {
    const task = await seededTask();
    const t = await mounted(task, read());
    await saveDays(t, "-2");
    await saveDays(t, "-3");
    expect(offsets(t)).toEqual([
      { kind: "calendar_days", days: -2, time: "18:00:00" },
      { kind: "calendar_days", days: -3, time: "18:00:00" },
    ]);
  });

  test("R2: A, B, then A again in one visit queues THREE changes, the last A after B (a stored change's identity is retired)", async () => {
    const task = await seededTask();
    const t = await mounted(task, read());
    await saveDays(t, "-2");
    await saveDays(t, "-3");
    await saveDays(t, "-2");
    const all = anchorDrafts(t);
    expect(new Set(all.map((d) => d.local_id)).size).toBe(3);
    expect(offsets(t)).toEqual([
      { kind: "calendar_days", days: -2, time: "18:00:00" },
      { kind: "calendar_days", days: -3, time: "18:00:00" },
      { kind: "calendar_days", days: -2, time: "18:00:00" },
    ]);
  });

  test("R2: remove, then set the same anchor again, then remove again: three changes", async () => {
    const task = await seededTask();
    const t = await mounted(task, read());
    const remove = async () => {
      const dialog = await openChange(t);
      fireEvent.click(
        present(
          within(dialog).queryByRole("button", { name: words.REMOVE_ANCHOR }),
        ),
      );
      await t.settle();
      expect(screen.queryByRole("dialog")).toBeNull();
    };
    await remove();
    await saveDays(t, "-1");
    await remove();
    expect(
      anchorDrafts(t).map((d) => bodyOf(t, d.local_id)?.anchor ?? null),
    ).toEqual([null, ANCHOR, null]);
  });

  test("R2 retry: the SAME change pressed again after a failure that may have stored it keeps its identity (stored once)", async () => {
    const task = await seededTask();
    const t = await mounted(task, read());
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const original = outbox.enqueue.bind(outbox);
    const enqueue = vi
      .spyOn(outbox, "enqueue")
      .mockImplementationOnce(async (request) => {
        await original(request);
        throw new Error("the completion was lost");
      });
    const dialog = await openChange(t);
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value: "-2" },
      },
    );
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(enqueue).toHaveBeenCalledTimes(2);
    const keys = enqueue.mock.calls.map(([request]) => request.localId);
    expect(keys[0]).toBe(keys[1]);
    expect(anchorDrafts(t)).toHaveLength(1);
  });

  test("R3: a save that completes after a hidden field was edited keeps the panel, the newer input (hidden value included) and saves it next as a new change", async () => {
    const task = await seededTask();
    const t = await mounted(task, read());
    const dialog = await openChange(t);
    const release = holdEnqueue(t, "enqueue");
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(anchorDrafts(t)).toHaveLength(1);
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.TITLE_CONTAINS)),
      {
        target: { value: "newer filter" },
      },
    );
    fireEvent.click(
      present(within(dialog).queryByRole("radio", { name: words.PERSON_DATE })),
    );
    expect(within(dialog).queryByLabelText(words.TITLE_CONTAINS)).toBeNull();
    await act(async () => release());
    await t.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(
      present(within(dialog).queryByText(words.ANCHOR_SAVED_NEWER)),
    ).toBeVisible();
    fireEvent.click(
      present(
        within(dialog).queryByRole("radio", { name: words.EVENT_SERIES }),
      ),
    );
    expect(
      present(within(dialog).queryByLabelText(words.TITLE_CONTAINS)),
    ).toHaveValue("newer filter");
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    const all = anchorDrafts(t);
    expect(all).toHaveLength(2);
    expect(bodyOf(t, all[0]?.local_id as string)?.anchor).toEqual(ANCHOR);
    expect(bodyOf(t, all[1]?.local_id as string)?.anchor).toEqual({
      ...ANCHOR,
      title_contains: "newer filter",
    });
  });

  test("R3: after a superseding Review save that kept newer input, the next save is an ORDINARY change after it (not a second supersession)", async () => {
    const task = await seededTask();
    const conflicted = draftRow({
      local_id: "00000000-0000-4000-8000-00000000c0f1",
      endpoint: "/calendar-commands",
      status: "version_conflict",
      command: {
        command: {
          kind: "set_anchor",
          id: task.taskId,
          expected_version: 0,
          anchor: ANCHOR,
        },
      } as never,
      target_resource_ids: [task.taskId],
      index_targets: [task.taskId],
      bases: { [task.taskId]: 0 },
      last_error: { status: 409, code: "conflict", stage: "conflict" },
    });
    const t = await mounted(task, {
      online: false,
      rows: [sourceRow, eventRow()],
      drafts: [conflicted],
    });
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.REVIEW_ANCHOR,
        }),
      ),
    );
    const dialog = await dialogOpened(t);
    await t.settle();
    const release = holdEnqueue(t, "supersede");
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value: "-4" },
      },
    );
    await act(async () => release());
    await t.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    // The same spy as the held one: only calls from here on count.
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const supersede = vi.spyOn(outbox, "supersede");
    supersede.mockClear();
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(supersede).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Both are queued: the replacement and, after it, an ordinary change (the fixture's seeded draft shares the store's first sequence
    // number, so queue order is not observable here; the outbox's own tests cover it).
    const queued = anchorDrafts(t).filter((d) => d.status === "queued");
    const sent = queued.map((d) =>
      JSON.stringify(
        (bodyOf(t, d.local_id)?.anchor as CalendarAnchor | undefined)?.offset,
      ),
    );
    expect(sent.sort()).toEqual(
      [
        { kind: "calendar_days", days: -1, time: "18:00:00" },
        { kind: "calendar_days", days: -4, time: "18:00:00" },
      ]
        .map((offset) => JSON.stringify(offset))
        .sort(),
    );
  });

  test("R3 control: nothing edited while saving closes the panel", async () => {
    const task = await seededTask();
    const t = await mounted(task, read());
    const dialog = await openChange(t);
    const release = holdEnqueue(t, "enqueue");
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await act(async () => release());
    await t.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test.each(["18:00:00", "18:00:37"])(
    "R5: changing only the days keeps the anchor's own time %s exactly",
    async (time) => {
      const task = await seededTask();
      const t = await mounted(
        task,
        read({ ...ANCHOR, offset: { kind: "calendar_days", days: -1, time } }),
      );
      await saveDays(t, "-2");
      expect(offsets(t)).toEqual([{ kind: "calendar_days", days: -2, time }]);
    },
  );

  test("R5: an edited time is sent as typed, a cleared one not at all, and a reference switched away and back keeps the exact time", async () => {
    const task = await seededTask();
    const t = await mounted(
      task,
      read({
        ...ANCHOR,
        offset: { kind: "calendar_days", days: -1, time: "18:00:37" },
      }),
    );
    let dialog = await openChange(t);
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.TIME_LABEL)),
      {
        target: { value: "19:15" },
      },
    );
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    dialog = await openChange(t);
    fireEvent.click(
      present(within(dialog).queryByRole("button", { name: words.CLEAR_TIME })),
    );
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    dialog = await openChange(t);
    fireEvent.click(
      present(within(dialog).queryByRole("radio", { name: words.PERSON_DATE })),
    );
    fireEvent.click(
      present(
        within(dialog).queryByRole("radio", { name: words.EVENT_SERIES }),
      ),
    );
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    // Edited away and back to the same minute, and cleared then typed again: what was typed (the kept time ended with the edit).
    dialog = await openChange(t);
    const time = () =>
      present(within(dialog).queryByLabelText(words.TIME_LABEL));
    fireEvent.change(time(), { target: { value: "19:15" } });
    fireEvent.change(time(), { target: { value: "18:00" } });
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    dialog = await openChange(t);
    fireEvent.click(
      present(within(dialog).queryByRole("button", { name: words.CLEAR_TIME })),
    );
    fireEvent.change(time(), { target: { value: "18:00" } });
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(offsets(t)).toEqual([
      { kind: "calendar_days", days: -1, time: "19:15:00" },
      { kind: "calendar_days", days: -1 },
      { kind: "calendar_days", days: -1, time: "18:00:37" },
      { kind: "calendar_days", days: -1, time: "18:00:00" },
      { kind: "calendar_days", days: -1, time: "18:00:00" },
    ]);
  });
});

describe("revision 1: every cached calendar can be chosen in the event picker (R4)", () => {
  const sources = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      ...sourceRow,
      id: `00000000-0000-4000-8000-${String(i + 1000).padStart(12, "0")}`,
      label: `Calendar ${String(i).padStart(3, "0")}`,
    }));
  async function picker(t: Mounted) {
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.ANCHOR_ACTION,
        }),
      ),
    );
    const dialog = await dialogOpened(t);
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.CHANGE_EVENT }),
      ),
    );
    await t.settle();
    return dialog;
  }
  const labels = (dialog: HTMLElement) =>
    [
      ...(present(within(dialog).queryByRole("combobox")) as HTMLSelectElement)
        .options,
    ].map((o) => o.textContent);

  test("101 sources: Show next calendars reaches the 101st, its events are listed and one is anchored to; the choice stays while paging back", async () => {
    const task = await seededTask();
    const rows = sources(101);
    const last = rows[100] as CacheRow;
    const t = await mounted(task, {
      online: false,
      rows: [...rows, eventRow({ parent_id: last.id })],
    });
    const dialog = await picker(t);
    expect(labels(dialog)).toHaveLength(100);
    expect(labels(dialog)).not.toContain("Calendar 100");
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", {
          name: words.SHOW_NEXT_CALENDARS,
        }),
      ),
    );
    await t.settle();
    // Paging alone changes nothing: the first source stays chosen (and an option) until another is picked.
    expect(labels(dialog)).toEqual(["Calendar 000", "Calendar 100"]);
    const select = present(
      within(dialog).queryByRole("combobox"),
    ) as HTMLSelectElement;
    expect(select.value).toBe(rows[0]?.id);
    fireEvent.change(select, { target: { value: last.id } });
    await t.settle();
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", {
          name: words.SHOW_PREVIOUS_CALENDARS,
        }),
      ),
    );
    await t.settle();
    expect(select.value).toBe(last.id);
    expect(labels(dialog)).toHaveLength(101);
    fireEvent.click(await within(dialog).findByText("Bin day"));
    await t.settle();
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(
      bodyOf(t, anchorDrafts(t)[0]?.local_id as string)?.anchor,
    ).toMatchObject({
      reference: {
        kind: "event_series",
        source_id: last.id,
        uid: "bin@example",
      },
    });
  });

  test("control: two sources need no paging", async () => {
    const task = await seededTask();
    const t = await mounted(task, { online: false, rows: sources(2) });
    const dialog = await picker(t);
    expect(labels(dialog)).toEqual(["Calendar 000", "Calendar 001"]);
    expect(
      within(dialog).queryByRole("button", { name: words.SHOW_NEXT_CALENDARS }),
    ).toBeNull();
  });
});

describe("revision 1: a binding read is the visit's; never sent after it ends (R6)", () => {
  const ACCOUNT = "11111111-1111-4111-8111-111111111111";
  /** The production task API over a stamped client double whose first GET is held, then refused before sending (`not_sent`). */
  function heldApi() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counter = { calls: 0 };
    const api = createTasksApi(
      {
        api: {
          client: () => ({
            GET: async () => {
              counter.calls += 1;
              if (counter.calls === 1) {
                await gate;
                throw new StampedRequestError("not_sent" as never);
              }
              return {
                response: new Response('{"binding":null}', { status: 200 }),
                data: { binding: null },
              };
            },
          }),
        },
      } as never,
      ACCOUNT as never,
      1 as never,
    );
    return { api, release, counter };
  }

  test.each([
    ["the person stays on the task (control)", false, 2],
    ["the person leaves the task", true, 1],
  ])(
    "a held read answered not_sent while %s: admitted once more only while the visit goes on",
    async (_, leave, admissions) => {
      const task = await seededTask();
      const held = heldApi();
      const t = await mounted(task, {
        binding: (live) => held.api.readAnchor(task.taskId, live),
      });
      expect(held.counter.calls).toBe(1);
      if (leave) {
        await act(async () => {
          await t.router.navigate({ to: "/settings" });
        });
        await t.settle();
        expect(section()).toBeNull();
      }
      // The API's own first not_sent wait (50 ms) is real: no timer is shortened.
      await act(async () => {
        held.release();
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      await t.settle();
      expect(held.counter.calls).toBe(admissions);
    },
  );

  test("away from the task and back in one turn (the section kept mounted): the person is at the task again, so Try again reads (I-CAL-ANC1 regression)", async () => {
    const task = await seededTask();
    let answers = 0;
    const t = await mounted(task, {
      binding: async () => {
        answers += 1;
        return answers === 1
          ? { ok: false, kind: "forbidden" }
          : { ok: true, value: { binding: null } };
      },
    });
    expect(section()).toHaveTextContent(words.BINDING_FAILED);
    const before = section();
    await act(async () => {
      t.router.history.push("/tasks");
      t.router.history.push(`/tasks/${task.taskId}`);
    });
    await t.settle();
    // The same section (React never removed it), now on the screen the person is at again.
    expect(section()).toBe(before);
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.TRY_AGAIN,
        }),
      ),
    );
    await t.settle();
    expect(t.api.calls.readAnchor).toBe(2);
    expect(section()).toHaveTextContent(words.NOT_ANCHORED);
  });

  test.each([
    ["the person stays on the task (control)", false, 2],
    [
      "the person goes away and back in one turn (the section kept mounted)",
      true,
      2,
    ],
  ])(
    "revision 3 (R3c): a held read answered not_sent while %s is admitted again only while it is still the read the section shows",
    async (_, bounce, admissions) => {
      const task = await seededTask();
      const held = heldApi();
      const t = await mounted(task, {
        binding: (live) => held.api.readAnchor(task.taskId, live),
      });
      expect(held.counter.calls).toBe(1);
      if (bounce) {
        const before = section();
        await act(async () => {
          t.router.history.push("/tasks");
          t.router.history.push(`/tasks/${task.taskId}`);
        });
        await t.settle();
        expect(section()).toBe(before);
        // The visit going on there reads for itself (one request).
        expect(held.counter.calls).toBe(2);
      }
      // The API's own first not_sent wait (50 ms) is real: no timer is shortened.
      await act(async () => {
        held.release();
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      await t.settle();
      // Stayed: the held read is sent again. Away and back: the ended visit's read is not sent beside the new visit's.
      expect(held.counter.calls).toBe(admissions);
      expect(section()).toHaveTextContent(words.NOT_ANCHORED);
    },
  );

  test("revision 3: a held read answered not_sent while the person checks the sync screens (the visit goes on there) is not sent from there; back at the task, the visit reads", async () => {
    const task = await seededTask();
    const held = heldApi();
    const t = await mounted(task, {
      binding: (live) => held.api.readAnchor(task.taskId, live),
    });
    expect(held.counter.calls).toBe(1);
    await act(async () => {
      await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
    });
    await t.settle();
    expect(section()).toBeNull();
    // The API's own first not_sent wait (50 ms) is real: no timer is shortened.
    await act(async () => {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await t.settle();
    // The read is the task SCREEN's: the person is not at it, although the visit goes on.
    expect(held.counter.calls).toBe(1);
    await act(async () => {
      t.router.history.back();
    });
    await t.settle();
    await t.until(() => section() !== null);
    await t.until(() => held.counter.calls >= 2);
    await t.settle();
    expect(held.counter.calls).toBe(2);
    expect(section()).toHaveTextContent(words.NOT_ANCHORED);
  });

  test("untilSentWhile asks live and connectivity before EVERY admission, the first included; an answer to a sent request is returned as it is", async () => {
    const notSent = { ok: false as const, kind: "not_sent" as const };
    let calls = 0;
    expect(
      await untilSentWhile(
        async () => {
          calls += 1;
          return notSent;
        },
        () => false,
        () => null,
      ),
    ).toEqual({ ok: false, kind: "closed" });
    expect(calls).toBe(0);
    let offline = false;
    const result = await untilSentWhile(
      async () => {
        calls += 1;
        offline = true;
        return notSent;
      },
      () => true,
      () => (offline ? { ok: false, kind: "offline" } : null),
    );
    expect(result).toEqual({ ok: false, kind: "offline" });
    expect(calls).toBe(1);
    let alive = true;
    const sent = await untilSentWhile(
      async () => {
        alive = false;
        return { ok: true as const, value: 1 };
      },
      () => alive,
      () => null,
    );
    expect(sent).toEqual({ ok: true, value: 1 });
  });
});

describe("revision 1: the in-dialog sync control keeps the panel for the task's visit (ia.md §1.3.3, I1; R3's family)", () => {
  const read = {
    rows: [sourceRow],
    binding: async () => ({
      ok: true as const,
      value: { binding: { anchor: ANCHOR, version: 1, active: true } },
    }),
  };
  async function openChange(t: Mounted) {
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.CHANGE_ANCHOR,
        }),
      ),
    );
    const dialog = await dialogOpened(t);
    await t.settle();
    return dialog;
  }
  /** The dialog's own sync control: the panel is kept, the dialog closes, then the queue opens. */
  async function viaSyncControl(t: Mounted, dialog: HTMLElement) {
    const chip = present(
      within(dialog)
        .queryAllByRole("button")
        .find((b) => b.hasAttribute("data-sync-tone")) ?? null,
    );
    await act(async () => {
      fireEvent.click(chip);
      await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
    });
    await t.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  async function to(t: Mounted, path: string) {
    await act(async () => {
      await t.router.navigate({ to: path, search: {} } as never);
    });
    await t.settle();
  }
  const days = (dialog: HTMLElement) =>
    (
      present(
        within(dialog).queryByLabelText(words.DAYS_LABEL),
      ) as HTMLInputElement
    ).value;
  function edit(dialog: HTMLElement) {
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value: "-5" },
      },
    );
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.TITLE_CONTAINS)),
      {
        target: { value: "kept filter" },
      },
    );
    // Hidden while the person-date reference is chosen: its value is kept too.
    fireEvent.click(
      present(within(dialog).queryByRole("radio", { name: words.PERSON_DATE })),
    );
  }

  test("kept through the sync screens and back: the next panel resumes every field (hidden ones included) and saves them", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const dialog = await openChange(t);
    edit(dialog);
    await viaSyncControl(t, dialog);
    await to(t, `/tasks/${task.taskId}`);
    await t.until(() => section() !== null);
    const again = await openChange(t);
    expect(days(again)).toBe("-5");
    expect(
      present(within(again).queryByRole("radio", { name: words.PERSON_DATE })),
    ).toBeChecked();
    fireEvent.click(
      present(within(again).queryByRole("radio", { name: words.EVENT_SERIES })),
    );
    expect(
      present(within(again).queryByLabelText(words.TITLE_CONTAINS)),
    ).toHaveValue("kept filter");
    fireEvent.click(
      present(within(again).queryByRole("button", { name: words.SAVE_ANCHOR })),
    );
    await t.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bodyOf(t, anchorDrafts(t)[0]?.local_id as string)?.anchor).toEqual({
      ...ANCHOR,
      offset: { kind: "calendar_days", days: -5, time: "18:00:00" },
      title_contains: "kept filter",
    });
  });

  test("an ordinary departure from the sync screens ends the visit: the next panel starts from the binding", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const dialog = await openChange(t);
    edit(dialog);
    await viaSyncControl(t, dialog);
    await to(t, "/tasks");
    await to(t, `/tasks/${task.taskId}`);
    await t.until(() => section() !== null);
    await t.until(
      () => section()?.getAttribute("data-anchor-section") === "anchored",
    );
    const again = await openChange(t);
    expect(days(again)).toBe("-1");
  });

  test("control: Cancel discards — a resumed panel cancelled, the next one starts from the binding", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const dialog = await openChange(t);
    edit(dialog);
    await viaSyncControl(t, dialog);
    await to(t, `/tasks/${task.taskId}`);
    await t.until(() => section() !== null);
    const resumed = await openChange(t);
    expect(days(resumed)).toBe("-5");
    fireEvent.click(
      present(within(resumed).queryByRole("button", { name: "Cancel" })),
    );
    await t.settle();
    const fresh = await openChange(t);
    expect(days(fresh)).toBe("-1");
  });

  test("a save still being made when the panel was kept: nothing newer is dropped (never offered to be saved twice); newer input is resumed and saved as a NEW change", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const hold = () => {
      const original = outbox.enqueue.bind(outbox);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(outbox, "enqueue").mockImplementationOnce(async (request) => {
        const outcome = await original(request);
        await gate;
        return outcome;
      });
      return () => release();
    };
    // Nothing edited after Save: the kept state is what was saved, so it is dropped.
    let release = hold();
    let dialog = await openChange(t);
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value: "-2" },
      },
    );
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    await viaSyncControl(t, dialog);
    await act(async () => release());
    await t.settle();
    await to(t, `/tasks/${task.taskId}`);
    await t.until(() => section() !== null);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-1");
    fireEvent.click(
      present(within(dialog).queryByRole("button", { name: "Cancel" })),
    );
    await t.settle();
    // Edited after Save: the newer input is resumed, and its save is an ordinary new change (not refused as changed by its own).
    release = hold();
    dialog = await openChange(t);
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value: "-3" },
      },
    );
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value: "-4" },
      },
    );
    await viaSyncControl(t, dialog);
    await act(async () => release());
    await t.settle();
    await to(t, `/tasks/${task.taskId}`);
    await t.until(() => section() !== null);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-4");
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
      ),
    );
    await t.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      anchorDrafts(t)
        .map((d) =>
          JSON.stringify(
            (bodyOf(t, d.local_id)?.anchor as CalendarAnchor | undefined)
              ?.offset,
          ),
        )
        .sort(),
    ).toEqual(
      [-2, -3, -4]
        .map((n) =>
          JSON.stringify({ kind: "calendar_days", days: n, time: "18:00:00" }),
        )
        .sort(),
    );
  });
});

describe("revision 2: the panel's editing session owns its save, whichever panel shows it (review 2 R3a/R3b)", () => {
  const read = {
    rows: [sourceRow],
    binding: async () => ({
      ok: true as const,
      value: { binding: { anchor: ANCHOR, version: 1, active: true } },
    }),
  };
  const dialogNow = () => screen.queryByRole("dialog");
  async function openChange(t: Mounted, name: string = words.CHANGE_ANCHOR) {
    fireEvent.click(
      present(within(section() as HTMLElement).queryByRole("button", { name })),
    );
    const dialog = await dialogOpened(t);
    await t.settle();
    return dialog;
  }
  /** The dialog's own sync control: the session is kept, the dialog closes, then the queue opens. */
  async function viaSyncControl(t: Mounted, dialog: HTMLElement) {
    const chip = present(
      within(dialog)
        .queryAllByRole("button")
        .find((b) => b.hasAttribute("data-sync-tone")) ?? null,
    );
    await act(async () => {
      fireEvent.click(chip);
      await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
    });
    await t.settle();
    expect(dialogNow()).toBeNull();
  }
  async function to(t: Mounted, path: string) {
    await act(async () => {
      await t.router.navigate({ to: path, search: {} } as never);
    });
    await t.settle();
  }
  async function backToTask(t: Mounted, task: SeededTask) {
    await to(t, `/tasks/${task.taskId}`);
    await t.until(() => section() !== null);
  }
  const days = (dialog: HTMLElement) =>
    (
      present(
        within(dialog).queryByLabelText(words.DAYS_LABEL),
      ) as HTMLInputElement
    ).value;
  const setDays = (dialog: HTMLElement, value: string) =>
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value },
      },
    );
  const press = (dialog: HTMLElement, name: string) =>
    fireEvent.click(present(within(dialog).queryByRole("button", { name })));
  const saveButton = (dialog: HTMLElement) =>
    present(
      within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
    ) as HTMLButtonElement;
  const offsets = (t: Mounted) =>
    anchorDrafts(t).map((d) =>
      JSON.stringify(
        (bodyOf(t, d.local_id)?.anchor as CalendarAnchor | null | undefined)
          ?.offset ?? null,
      ),
    );
  const dayOffsets = (...list: number[]) =>
    list.map((n) =>
      JSON.stringify({ kind: "calendar_days", days: n, time: "18:00:00" }),
    );
  /** Holds the delivery of the outbox's answer to the NEXT call of `method`; the change itself is written first (it IS stored). */
  function holdStored(t: Mounted, method: "enqueue" | "supersede" = "enqueue") {
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const original = (
      outbox[method] as (...a: never[]) => Promise<unknown>
    ).bind(outbox);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(outbox, method).mockImplementationOnce((async (
      ...args: never[]
    ) => {
      const outcome = await original(...args);
      await gate;
      return outcome;
    }) as never);
    return async () => {
      await act(async () => release());
      await t.settle();
    };
  }
  /**
   * The NEXT enqueue is refused for storage (the outbox's documented refusal; nothing is written) once released; `asked` is the identity
   * the refused press carried.
   */
  function holdRefusal(t: Mounted) {
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    let refuse!: () => void;
    const gate = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    const asked: string[] = [];
    vi.spyOn(outbox, "enqueue").mockImplementationOnce(async (request) => {
      asked.push(String(request.localId));
      await gate;
      return { kind: "refused", reason: "storage" } as never;
    });
    return {
      asked,
      refuse: async () => {
        await act(async () => refuse());
        await t.settle();
      },
    };
  }
  const STORAGE_REFUSAL = "Couldn't save on this device. Try again.";

  test.each([
    ["shown again before the earlier save completes", true],
    ["shown again after it completes (control)", false],
  ])(
    "R3a: newer input kept by the sync control while its earlier save was being made is saved next as a new change, %s",
    async (_, early) => {
      const task = await seededTask();
      const t = await mounted(task, read);
      const release = holdStored(t);
      let dialog = await openChange(t);
      setDays(dialog, "-2");
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      expect(anchorDrafts(t)).toHaveLength(1);
      setDays(dialog, "-3");
      fireEvent.change(
        present(within(dialog).queryByLabelText(words.TITLE_CONTAINS)),
        {
          target: { value: "newer filter" },
        },
      );
      // Hidden while the person-date reference is chosen: kept too.
      fireEvent.click(
        present(
          within(dialog).queryByRole("radio", { name: words.PERSON_DATE }),
        ),
      );
      await viaSyncControl(t, dialog);
      if (!early) await release();
      await backToTask(t, task);
      dialog = await openChange(t);
      expect(days(dialog)).toBe("-3");
      if (early) {
        // The session's save is still being made: shown as such, and no second one can start.
        expect(saveButton(dialog)).toBeDisabled();
        await release();
      }
      expect(dialogNow()).not.toBeNull();
      expect(
        within(dialog).queryByText(words.ANCHOR_SAVED_NEWER),
      ).not.toBeNull();
      expect(saveButton(dialog)).not.toBeDisabled();
      fireEvent.click(
        present(
          within(dialog).queryByRole("radio", { name: words.EVENT_SERIES }),
        ),
      );
      expect(
        present(within(dialog).queryByLabelText(words.TITLE_CONTAINS)),
      ).toHaveValue("newer filter");
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      expect(dialogNow()).toBeNull();
      const all = anchorDrafts(t);
      expect(all).toHaveLength(2);
      expect(new Set(all.map((d) => d.local_id)).size).toBe(2);
      expect(offsets(t).sort()).toEqual(dayOffsets(-2, -3).sort());
      const newer = all.find(
        (d) =>
          JSON.stringify(
            (bodyOf(t, d.local_id)?.anchor as CalendarAnchor | undefined)
              ?.offset,
          ) === dayOffsets(-3)[0],
      );
      expect(bodyOf(t, newer?.local_id as string)?.anchor).toMatchObject({
        title_contains: "newer filter",
      });
    },
  );

  test("an unchanged save shown again before it completes: still being made, no second save by Save or Enter; its completion consumes the session and closes the panel", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const release = holdStored(t);
    let dialog = await openChange(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    await viaSyncControl(t, dialog);
    await backToTask(t, task);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-2");
    expect(saveButton(dialog)).toBeDisabled();
    const enqueue = vi.spyOn(outbox, "enqueue");
    enqueue.mockClear();
    fireEvent.submit(present(dialog.querySelector("form")));
    await t.settle();
    expect(enqueue).not.toHaveBeenCalled();
    await release();
    expect(dialogNow()).toBeNull();
    expect(anchorDrafts(t)).toHaveLength(1);
    // The session is gone: the next panel starts from the binding.
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-1");
  });

  test.each([
    ["before", true],
    ["after (control)", false],
  ])(
    "R3b: a cancelled panel's save completing %s another panel's save is refused never consumes that panel's input; it is retried as the same change",
    async (_, oldFirst) => {
      const task = await seededTask();
      const t = await mounted(task, read);
      const releaseOld = holdStored(t);
      let dialog = await openChange(t);
      setDays(dialog, "-2");
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      press(dialog, "Cancel");
      await t.settle();
      dialog = await openChange(t);
      expect(days(dialog)).toBe("-1");
      const refusal = holdRefusal(t);
      setDays(dialog, "-5");
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      expect(anchorDrafts(t)).toHaveLength(1);
      await viaSyncControl(t, dialog);
      if (oldFirst) await releaseOld();
      await refusal.refuse();
      await backToTask(t, task);
      dialog = await openChange(t);
      if (!oldFirst) await releaseOld();
      expect(days(dialog)).toBe("-5");
      expect(within(dialog).queryByText(STORAGE_REFUSAL)).not.toBeNull();
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      expect(dialogNow()).toBeNull();
      expect(offsets(t).sort()).toEqual(dayOffsets(-2, -5).sort());
      // The refused attempt and its retry are ONE operation (R2): the refused press's identity was kept with the visit.
      expect(refusal.asked).toHaveLength(1);
      expect(anchorDrafts(t).map((d) => d.local_id)).toContain(
        refusal.asked[0],
      );
    },
  );

  test("R3b (pending): a cancelled panel's save never consumes or closes another panel's save still being made; that save settles on its own session", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const releaseOld = holdStored(t);
    let dialog = await openChange(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    press(dialog, "Cancel");
    await t.settle();
    dialog = await openChange(t);
    const releaseNew = holdStored(t);
    setDays(dialog, "-5");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(anchorDrafts(t)).toHaveLength(2);
    await viaSyncControl(t, dialog);
    await releaseOld();
    await backToTask(t, task);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-5");
    expect(saveButton(dialog)).toBeDisabled();
    await releaseNew();
    expect(dialogNow()).toBeNull();
    expect(offsets(t).sort()).toEqual(dayOffsets(-2, -5).sort());
  });

  test("an earlier, cancelled session's completion never closes the newer panel shown (only the session shown closes it)", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const releaseOld = holdStored(t);
    let dialog = await openChange(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    press(dialog, "Cancel");
    await t.settle();
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-1");
    await releaseOld();
    expect(dialogNow()).not.toBeNull();
    expect(days(dialog)).toBe("-1");
    expect(within(dialog).queryByText(words.ANCHOR_SAVED_NEWER)).toBeNull();
  });

  test("kept, shown, kept and shown again: one session and one settlement (its save completing while kept the second time)", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const release = holdStored(t);
    let dialog = await openChange(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    setDays(dialog, "-3");
    await viaSyncControl(t, dialog);
    await backToTask(t, task);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-3");
    expect(saveButton(dialog)).toBeDisabled();
    await viaSyncControl(t, dialog);
    await release();
    await backToTask(t, task);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-3");
    expect(within(dialog).queryByText(words.ANCHOR_SAVED_NEWER)).not.toBeNull();
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(offsets(t).sort()).toEqual(dayOffsets(-2, -3).sort());
  });

  test("Remove anchor still being made, newer input kept and shown again before it completes: the removal is stored once and the newer input saved after it", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const release = holdStored(t);
    let dialog = await openChange(t);
    press(dialog, words.REMOVE_ANCHOR);
    await t.settle();
    setDays(dialog, "-6");
    await viaSyncControl(t, dialog);
    await backToTask(t, task);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-6");
    await release();
    expect(within(dialog).queryByText(words.ANCHOR_SAVED_NEWER)).not.toBeNull();
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(offsets(t).sort()).toEqual(
      [JSON.stringify(null), ...dayOffsets(-6)].sort(),
    );
  });

  test("a superseding Review save still being made, newer input kept and shown again before it completes: the next save is an ordinary change, not a second supersession", async () => {
    const task = await seededTask();
    const conflicted = draftRow({
      local_id: "00000000-0000-4000-8000-00000000c0f2",
      endpoint: "/calendar-commands",
      status: "version_conflict",
      command: {
        command: {
          kind: "set_anchor",
          id: task.taskId,
          expected_version: 0,
          anchor: ANCHOR,
        },
      } as never,
      target_resource_ids: [task.taskId],
      index_targets: [task.taskId],
      bases: { [task.taskId]: 0 },
      last_error: { status: 409, code: "conflict", stage: "conflict" },
    });
    const t = await mounted(task, {
      online: false,
      rows: [sourceRow, eventRow()],
      drafts: [conflicted],
    });
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const release = holdStored(t, "supersede");
    let dialog = await openChange(t, words.REVIEW_ANCHOR);
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    setDays(dialog, "-4");
    await viaSyncControl(t, dialog);
    await backToTask(t, task);
    dialog = await openChange(
      t,
      section()?.querySelector("[data-anchor-conflict]")
        ? words.REVIEW_ANCHOR
        : words.ANCHOR_ACTION,
    );
    expect(days(dialog)).toBe("-4");
    await release();
    const supersede = vi.spyOn(outbox, "supersede");
    supersede.mockClear();
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(supersede).not.toHaveBeenCalled();
    expect(dialogNow()).toBeNull();
    const queued = anchorDrafts(t).filter((d) => d.status === "queued");
    expect(
      queued
        .map((d) =>
          JSON.stringify(
            (bodyOf(t, d.local_id)?.anchor as CalendarAnchor | undefined)
              ?.offset,
          ),
        )
        .sort(),
    ).toEqual(dayOffsets(-1, -4).sort());
  });

  test("a save that may have been stored, kept and shown again by a NEW section mount, is retried as the same operation (stored once)", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const original = outbox.enqueue.bind(outbox);
    const enqueue = vi
      .spyOn(outbox, "enqueue")
      .mockImplementationOnce(async (request) => {
        await original(request);
        throw new Error("the completion was lost");
      });
    let dialog = await openChange(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(anchorDrafts(t)).toHaveLength(1);
    await viaSyncControl(t, dialog);
    await backToTask(t, task);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    const keys = enqueue.mock.calls.map(([request]) => request.localId);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(anchorDrafts(t)).toHaveLength(1);
  });

  test("a panel that left without Cancel while the visit goes on (the screen went to the sync screens without its control) is shown again with its input; one with nothing in it starts again", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    let dialog = await openChange(t);
    setDays(dialog, "-5");
    await act(async () => {
      await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
    });
    await t.settle();
    expect(dialogNow()).toBeNull();
    await backToTask(t, task);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-5");
    press(dialog, "Cancel");
    await t.settle();
    // Control: nothing typed, nothing kept.
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-1");
    await act(async () => {
      await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
    });
    await t.settle();
    await backToTask(t, task);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-1");
  });

  test("an ordinary departure while a save is being made: the next visit's panel starts from the binding, and the late save neither changes nor closes it", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const taskRead = sectionTaskRead(t.data, task.taskId);
    const release = holdStored(t);
    let dialog = await openChange(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    setDays(dialog, "-3");
    await viaSyncControl(t, dialog);
    await to(t, "/tasks");
    await backToTask(t, task);
    await t.until(
      () => section()?.getAttribute("data-anchor-section") === "anchored",
    );
    // ADAPTED (revision 13, R11): the next visit's panel is opened once the new section's read of the task is shown; opened before it, its
    // first press is refused (the R11 tests), which is not what this test is about.
    await taskReadShown(t, taskRead);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-1");
    setDays(dialog, "-7");
    await release();
    expect(dialogNow()).not.toBeNull();
    expect(days(dialog)).toBe("-7");
    expect(within(dialog).queryByText(words.ANCHOR_SAVED_NEWER)).toBeNull();
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(offsets(t).sort()).toEqual(dayOffsets(-2, -7).sort());
  });

  /** Another tab's save of this task's anchor, through the same database (the real outbox): `days` from the binding's anchor. */
  async function otherTabSets(t: Mounted, task: SeededTask, days: number) {
    const outbox = t.data.outbox();
    const row = task.rows.find((r) => r.id === task.taskId);
    if (outbox === null || row === undefined) throw new Error("setup");
    // The other tab saves from its own read of the task (R11: a change of an anchor is never written without one).
    const read = await readResourceViewNow(t.data, task.taskId);
    if (!read.ok) throw new Error("setup: the other tab's read");
    const outcome = await outbox.enqueue(
      setAnchorRequest(
        row,
        {
          ...ANCHOR,
          offset: { kind: "calendar_days", days, time: "18:00:00" },
        },
        read.value.view.observation,
        `00000000-0000-4000-8000-0000000007a${String(Math.abs(days))}`,
      ),
    );
    expect(outcome.kind).toBe("queued");
  }

  test("told that the task changed (another tab saved first), the input stays and saving again is a deliberate save of the task as it is then", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const real = outbox.enqueue.bind(outbox);
    const dialog = await openChange(t);
    setDays(dialog, "-5");
    vi.spyOn(outbox, "enqueue").mockImplementationOnce(async (request) => {
      // The other tab's change commits first, after the panel was opened from what it saw.
      await otherTabSets(t, task, -8);
      return real(request);
    });
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).not.toBeNull();
    expect(
      within(dialog).queryByText(words.ANCHOR_NOT_SAVED_CHANGED),
    ).not.toBeNull();
    expect(days(dialog)).toBe("-5");
    expect(offsets(t)).toEqual(dayOffsets(-8));
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(offsets(t)).toEqual(dayOffsets(-8, -5));
  });

  test("another tab saves between the session's own done save and its next one: the transaction orders them (own, the other tab's, then the newer input)", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const release = holdStored(t);
    const dialog = await openChange(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    setDays(dialog, "-3");
    await release();
    expect(within(dialog).queryByText(words.ANCHOR_SAVED_NEWER)).not.toBeNull();
    await act(async () => otherTabSets(t, task, -9));
    await t.settle();
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    // All three are real enqueues: their queue order is the store's own sequence.
    expect(offsets(t)).toEqual(dayOffsets(-2, -9, -3));
  });
});

describe("revision 3: a panel opened from a section React kept mounted belongs to the visit going on (review 3 R3c)", () => {
  /** The binding as the server shows it; `days` per read, in order (the last repeats). */
  const reads = (...list: number[]) => {
    let n = 0;
    return {
      rows: [sourceRow],
      binding: async () => {
        const days = list[Math.min(n, list.length - 1)] as number;
        n += 1;
        return {
          ok: true as const,
          value: {
            binding: {
              anchor: {
                ...ANCHOR,
                offset: {
                  kind: "calendar_days" as const,
                  days,
                  time: "18:00:00",
                },
              },
              version: 1,
              active: true,
            },
          },
        };
      },
    };
  };
  const dialogNow = () => screen.queryByRole("dialog");
  /** Change anchor…: a panel opens (asserted, so a panel that does not open is an assertion's failure, not a query's). */
  async function openChange(t: Mounted) {
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.CHANGE_ANCHOR,
        }),
      ),
    );
    await t.settle();
    return present(dialogNow());
  }
  async function viaSyncControl(t: Mounted, dialog: HTMLElement) {
    const chip = present(
      within(dialog)
        .queryAllByRole("button")
        .find((b) => b.hasAttribute("data-sync-tone")) ?? null,
    );
    await act(async () => {
      fireEvent.click(chip);
      await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
    });
    await t.settle();
    expect(dialogNow()).toBeNull();
  }
  async function backToTask(t: Mounted, task: SeededTask) {
    await act(async () => {
      await t.router.navigate({
        to: "/tasks/$taskId",
        params: { taskId: task.taskId },
        search: {},
      } as never);
    });
    await t.settle();
    await t.until(() => section() !== null);
  }
  /** Shapes of an ordinary departure and return that React may not unmount the section through. */
  const BOUNCES = {
    "push away, push back": (t: Mounted, task: SeededTask) => {
      t.router.history.push("/tasks");
      t.router.history.push(`/tasks/${task.taskId}`);
    },
    "replace away, push back": (t: Mounted, task: SeededTask) => {
      t.router.history.replace("/tasks");
      t.router.history.push(`/tasks/${task.taskId}`);
    },
    "push away, Back": (t: Mounted) => {
      t.router.history.push("/tasks");
      t.router.history.back();
    },
  } as const;
  type Bounce = keyof typeof BOUNCES;
  /** Away from the task and back in one turn: the departure ends the visit, and the SAME section is still shown (asserted). */
  async function bounce(
    t: Mounted,
    task: SeededTask,
    shape: Bounce = "push away, push back",
  ) {
    const before = section();
    expect(before).not.toBeNull();
    await act(async () => {
      BOUNCES[shape](t, task);
    });
    await t.settle();
    expect(t.router.state.location.pathname).toBe(`/tasks/${task.taskId}`);
    expect(section(), "React kept the section mounted").toBe(before);
  }
  const days = (dialog: HTMLElement) =>
    (
      present(
        within(dialog).queryByLabelText(words.DAYS_LABEL),
      ) as HTMLInputElement
    ).value;
  const setDays = (dialog: HTMLElement, value: string) =>
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value },
      },
    );
  const press = (dialog: HTMLElement, name: string) =>
    fireEvent.click(present(within(dialog).queryByRole("button", { name })));
  const saveButton = (dialog: HTMLElement) =>
    present(
      within(dialog).queryByRole("button", { name: words.SAVE_ANCHOR }),
    ) as HTMLButtonElement;
  const offsets = (t: Mounted) =>
    anchorDrafts(t).map((d) =>
      JSON.stringify(
        (bodyOf(t, d.local_id)?.anchor as CalendarAnchor | null | undefined)
          ?.offset ?? null,
      ),
    );
  const dayOffsets = (...list: number[]) =>
    list.map((n) =>
      JSON.stringify({ kind: "calendar_days", days: n, time: "18:00:00" }),
    );
  /** Holds the delivery of the outbox's answer to the NEXT enqueue; the change itself is written first (it IS stored). */
  function holdStored(t: Mounted) {
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const original = outbox.enqueue.bind(outbox);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(outbox, "enqueue").mockImplementationOnce(async (request) => {
      const outcome = await original(request);
      await gate;
      return outcome;
    });
    return async () => {
      await act(async () => release());
      await t.settle();
    };
  }
  /** Types newer input with a hidden value: −`n` days, a title filter, then the person-date reference (which hides that filter). */
  function editWithHidden(dialog: HTMLElement, n: number, filter: string) {
    setDays(dialog, `-${n}`);
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.TITLE_CONTAINS)),
      {
        target: { value: filter },
      },
    );
    fireEvent.click(
      present(within(dialog).queryByRole("radio", { name: words.PERSON_DATE })),
    );
  }

  test.each([
    ["no departure (control)", "none"],
    ["away and back in one turn, the section kept mounted", "bounce"],
    [
      "a completed departure and return, the section mounted again (control)",
      "remount",
    ],
  ] as const)(
    "input typed in a panel opened after %s is kept through the sync screens, resumed whole and saved once",
    async (_, before) => {
      const task = await seededTask();
      const t = await mounted(task, reads(-1));
      const taskRead = sectionTaskRead(t.data, task.taskId);
      const first = section();
      if (before === "bounce") await bounce(t, task);
      if (before === "remount") {
        await act(async () => {
          await t.router.navigate({ to: "/tasks" });
        });
        await t.settle();
        expect(section()).toBeNull();
        await backToTask(t, task);
        expect(section()).not.toBe(first);
        // ADAPTED (revision 13, R11): the panel is opened once the new section's read of the task is shown (see `taskReadShown`).
        await taskReadShown(t, taskRead);
      }
      // The input is typed only now, after any departure: nothing earlier is asked to survive it.
      let dialog = await openChange(t);
      expect(days(dialog)).toBe("-1");
      editWithHidden(dialog, 7, "kept filter");
      await viaSyncControl(t, dialog);
      await backToTask(t, task);
      dialog = await openChange(t);
      expect(days(dialog), "the input typed after the return").toBe("-7");
      expect(
        present(
          within(dialog).queryByRole("radio", { name: words.PERSON_DATE }),
        ),
      ).toBeChecked();
      fireEvent.click(
        present(
          within(dialog).queryByRole("radio", { name: words.EVENT_SERIES }),
        ),
      );
      expect(
        present(within(dialog).queryByLabelText(words.TITLE_CONTAINS)),
      ).toHaveValue("kept filter");
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      expect(dialogNow()).toBeNull();
      expect(anchorDrafts(t)).toHaveLength(1);
      expect(bodyOf(t, anchorDrafts(t)[0]?.local_id as string)?.anchor).toEqual(
        {
          ...ANCHOR,
          offset: { kind: "calendar_days", days: -7, time: "18:00:00" },
          title_contains: "kept filter",
        },
      );
    },
  );

  test.each(Object.keys(BOUNCES) as Bounce[])(
    "away and back in one turn by %s: a panel opened afterwards is kept by the sync control",
    async (shape) => {
      const task = await seededTask();
      const t = await mounted(task, reads(-1));
      await bounce(t, task, shape);
      let dialog = await openChange(t);
      setDays(dialog, "-6");
      await viaSyncControl(t, dialog);
      await backToTask(t, task);
      dialog = await openChange(t);
      expect(days(dialog)).toBe("-6");
    },
  );

  test("the section shows the binding as the visit going on read it: away and back in one turn reads it again, once", async () => {
    const task = await seededTask();
    const t = await mounted(task, reads(-1, -4));
    expect(t.api.calls.readAnchor).toBe(1);
    await bounce(t, task);
    await t.until(() => (t.api.calls.readAnchor ?? 0) >= 2);
    await t.settle();
    expect(t.api.calls.readAnchor).toBe(2);
    const dialog = await openChange(t);
    expect(days(dialog), "the new visit's read").toBe("-4");
    // Control: the same visit (a remount of the protected tree) reads nothing more.
    press(dialog, "Cancel");
    await t.settle();
    await act(async () => t.remount());
    await t.settle();
    await t.until(() => section() !== null);
    expect(t.api.calls.readAnchor).toBe(2);
  });

  test("an answer the ended visit's read receives after the new visit read never replaces what the section shows", async () => {
    const task = await seededTask();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const t = await mounted(task, {
      rows: [sourceRow],
      binding: async () => {
        n += 1;
        const days = n === 1 ? -3 : -4;
        if (n === 1) await gate;
        return {
          ok: true as const,
          value: {
            binding: {
              anchor: {
                ...ANCHOR,
                offset: {
                  kind: "calendar_days" as const,
                  days,
                  time: "18:00:00",
                },
              },
              version: 1,
              active: true,
            },
          },
        };
      },
    });
    expect(section()?.getAttribute("data-anchor-section")).toBe("reading");
    await bounce(t, task);
    await t.until(
      () => section()?.getAttribute("data-anchor-section") === "anchored",
    );
    await act(async () => release());
    await t.settle();
    expect(n).toBe(2);
    const dialog = await openChange(t);
    expect(days(dialog)).toBe("-4");
  });

  test.each([
    ["with nothing being saved", false],
    ["with its save still being made", true],
  ])(
    "a panel open when the person goes away and back in one turn (%s) closes; the next panel starts from the binding and is the new visit's",
    async (_, saving) => {
      const task = await seededTask();
      const t = await mounted(task, reads(-1));
      const release = saving ? holdStored(t) : null;
      let dialog = await openChange(t);
      setDays(dialog, "-2");
      if (saving) {
        press(dialog, words.SAVE_ANCHOR);
        await t.settle();
        expect(anchorDrafts(t)).toHaveLength(1);
        setDays(dialog, "-3");
      }
      await bounce(t, task);
      // Its session ended with its visit: never left showing input it can no longer save.
      expect(dialogNow()).toBeNull();
      await t.until(
        () => section()?.getAttribute("data-anchor-section") === "anchored",
      );
      dialog = await openChange(t);
      expect(days(dialog)).toBe("-1");
      setDays(dialog, "-7");
      if (release !== null) await release();
      // The ended session's late completion neither changes nor closes the new panel.
      expect(dialogNow()).not.toBeNull();
      expect(days(dialog)).toBe("-7");
      expect(within(dialog).queryByText(words.ANCHOR_SAVED_NEWER)).toBeNull();
      await viaSyncControl(t, dialog);
      await backToTask(t, task);
      dialog = await openChange(t);
      expect(days(dialog)).toBe("-7");
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      expect(dialogNow()).toBeNull();
      expect(offsets(t)).toEqual(saving ? dayOffsets(-2, -7) : dayOffsets(-7));
    },
  );

  test("a panel open when another identity is shown closes; back to the first identity, the next panel starts from the binding", async () => {
    const task = await seededTask();
    const t = await mounted(task, reads(-1));
    const dialog = await openChange(t);
    setDays(dialog, "-5");
    await act(async () =>
      t.rerender(
        tasksEnv(t.api, {
          identity: "22222222-2222-4222-8222-222222222222:1",
        }),
      ),
    );
    await t.settle();
    expect(dialogNow()).toBeNull();
    await act(async () => t.rerender(tasksEnv(t.api)));
    await t.settle();
    await t.until(
      () => section()?.getAttribute("data-anchor-section") === "anchored",
    );
    const again = await openChange(t);
    expect(days(again)).toBe("-1");
  });

  test("a change of only the query keeps the visit: the open panel goes on and its save is the visit's", async () => {
    const task = await seededTask();
    const t = await mounted(task, reads(-1));
    const first = section();
    let dialog = await openChange(t);
    setDays(dialog, "-5");
    await act(async () => {
      t.router.history.push(`/tasks/${task.taskId}?from=today`);
    });
    await t.settle();
    expect(section()).toBe(first);
    expect(dialogNow()).not.toBeNull();
    expect(days(dialog)).toBe("-5");
    setDays(dialog, "-6");
    await viaSyncControl(t, dialog);
    await backToTask(t, task);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-6");
    expect(t.api.calls.readAnchor).toBe(1);
  });

  test.each([
    ["shown again before the earlier save completes", true],
    ["shown again after it completes (control)", false],
  ])(
    "R3a after away and back in one turn: newer input kept while the earlier save was being made is saved next as a new change, %s",
    async (_, early) => {
      const task = await seededTask();
      const t = await mounted(task, reads(-1));
      await bounce(t, task);
      const release = holdStored(t);
      let dialog = await openChange(t);
      setDays(dialog, "-2");
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      expect(anchorDrafts(t)).toHaveLength(1);
      editWithHidden(dialog, 3, "newer filter");
      await viaSyncControl(t, dialog);
      if (!early) await release();
      await backToTask(t, task);
      dialog = await openChange(t);
      expect(days(dialog)).toBe("-3");
      if (early) {
        expect(saveButton(dialog)).toBeDisabled();
        await release();
      }
      expect(
        within(dialog).queryByText(words.ANCHOR_SAVED_NEWER),
      ).not.toBeNull();
      fireEvent.click(
        present(
          within(dialog).queryByRole("radio", { name: words.EVENT_SERIES }),
        ),
      );
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      expect(dialogNow()).toBeNull();
      const all = anchorDrafts(t);
      expect(new Set(all.map((d) => d.local_id)).size).toBe(2);
      expect(offsets(t)).toEqual(dayOffsets(-2, -3));
      expect(bodyOf(t, all[1]?.local_id as string)?.anchor).toMatchObject({
        title_contains: "newer filter",
      });
    },
  );

  test("R3b after away and back in one turn: a cancelled panel's success never settles the next panel's refused save, which is kept and retried as the same change", async () => {
    const task = await seededTask();
    const t = await mounted(task, reads(-1));
    await bounce(t, task);
    const releaseA = holdStored(t);
    let dialog = await openChange(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    press(dialog, "Cancel");
    await t.settle();
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    let refuse!: () => void;
    const gate = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    const asked: string[] = [];
    vi.spyOn(outbox, "enqueue").mockImplementationOnce(async (request) => {
      asked.push(String(request.localId));
      await gate;
      return { kind: "refused", reason: "storage" } as never;
    });
    dialog = await openChange(t);
    setDays(dialog, "-5");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    await viaSyncControl(t, dialog);
    await act(async () => refuse());
    await t.settle();
    await releaseA();
    await backToTask(t, task);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-5");
    expect(
      within(dialog).queryByText("Couldn't save on this device. Try again."),
    ).not.toBeNull();
    // The same spy (its history kept): only the retry's own call is read.
    const enqueue = vi.spyOn(outbox, "enqueue");
    const earlier = enqueue.mock.calls.length;
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(
      enqueue.mock.calls.slice(earlier).map(([r]) => String(r.localId)),
    ).toEqual(asked);
    expect(offsets(t)).toEqual(dayOffsets(-2, -5));
  });

  test("after away and back in one turn, a save that may have been stored is retried by a NEW section mount of the visit as the same operation (stored once)", async () => {
    const task = await seededTask();
    const t = await mounted(task, reads(-1));
    await bounce(t, task);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const original = outbox.enqueue.bind(outbox);
    const enqueue = vi
      .spyOn(outbox, "enqueue")
      .mockImplementationOnce(async (request) => {
        await original(request);
        throw new Error("the completion was lost");
      });
    const first = section();
    let dialog = await openChange(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(anchorDrafts(t)).toHaveLength(1);
    await viaSyncControl(t, dialog);
    await backToTask(t, task);
    expect(section()).not.toBe(first);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    const keys = enqueue.mock.calls.map(([request]) => request.localId);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(anchorDrafts(t)).toHaveLength(1);
  });

  test("a save that may have been stored, then Cancel: the same change pressed in a NEW panel of a NEW section mount of the visit is the same operation (stored once)", async () => {
    const task = await seededTask();
    const t = await mounted(task, reads(-1));
    const taskRead = sectionTaskRead(t.data, task.taskId);
    await bounce(t, task);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const original = outbox.enqueue.bind(outbox);
    const enqueue = vi
      .spyOn(outbox, "enqueue")
      .mockImplementationOnce(async (request) => {
        await original(request);
        throw new Error("the completion was lost");
      });
    let dialog = await openChange(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(anchorDrafts(t)).toHaveLength(1);
    press(dialog, "Cancel");
    await t.settle();
    expect(dialogNow()).toBeNull();
    // A remount of the protected tree: the same visit, a new section.
    const first = section();
    await act(async () => t.remount());
    await t.settle();
    await t.until(
      () => section()?.getAttribute("data-anchor-section") === "anchored",
    );
    expect(section()).not.toBe(first);
    // ADAPTED (revision 13, R11): the new panel is opened once the new section's read of the task is shown (see `taskReadShown`).
    await taskReadShown(t, taskRead);
    dialog = await openChange(t);
    expect(days(dialog), "a new panel starts from the binding").toBe("-1");
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    const keys = enqueue.mock.calls.map(([request]) => request.localId);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(anchorDrafts(t)).toHaveLength(1);
  });

  test("after away and back in one turn: A, B, then A again queues three changes (a stored change's identity is retired)", async () => {
    const task = await seededTask();
    const t = await mounted(task, reads(-1));
    await bounce(t, task);
    for (const n of ["-2", "-3", "-2"]) {
      const dialog = await openChange(t);
      setDays(dialog, n);
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      expect(dialogNow()).toBeNull();
    }
    const all = anchorDrafts(t);
    expect(new Set(all.map((d) => d.local_id)).size).toBe(3);
    expect(offsets(t)).toEqual(dayOffsets(-2, -3, -2));
  });
});

describe("revision 13: an anchor change is written only against a read of the task (review 14 R11)", () => {
  /**
   * R11 (family calendar-anchor-observation-admission; design assessment M26–M32, M35): a panel opened before the section's read of the
   * task arrived captured no read, and its Save/Remove was written against whatever version the writing transaction found (one nobody
   * saw). Now nothing is written without a read: that press is refused with its reason, the input (and any conflict being replaced)
   * stays, and the next press is a deliberate save of the task as the section shows it then, checked again when it is written. The
   * section's read is held on the ACTUAL subscribed watch (`sectionTaskRead`), never invented; another device's change is a real
   * sync page (`commitNow`, the cache writer), committed between the press and the writing transaction.
   */
  const read = {
    rows: [sourceRow],
    binding: async () => ({
      ok: true as const,
      value: { binding: { anchor: ANCHOR, version: 1, active: true } },
    }),
  };
  const dialogNow = () => screen.queryByRole("dialog");
  const days = (dialog: HTMLElement) =>
    (
      present(
        within(dialog).queryByLabelText(words.DAYS_LABEL),
      ) as HTMLInputElement
    ).value;
  const setDays = (dialog: HTMLElement, value: string) =>
    fireEvent.change(
      present(within(dialog).queryByLabelText(words.DAYS_LABEL)),
      {
        target: { value },
      },
    );
  const press = (dialog: HTMLElement, name: string) =>
    fireEvent.click(present(within(dialog).queryByRole("button", { name })));
  const note = (dialog: HTMLElement, text: string) =>
    within(dialog).queryByText(text);
  async function open(t: Mounted, name: string = words.CHANGE_ANCHOR) {
    const button = () =>
      within(section() as HTMLElement).queryByRole("button", { name });
    await t.until(() => button() !== null);
    fireEvent.click(present(button()));
    await t.settle();
    return present(dialogNow());
  }
  /** The section mounted again over the same visit, its task read seen through `sectionTaskRead` (held as `held`, if given). */
  async function sectionWithRead(
    t: Mounted,
    task: SeededTask,
    held?: Loadable<never>,
    shownAs = "anchored",
  ) {
    const taskRead = sectionTaskRead(
      t.data,
      task.taskId,
      held === undefined ? {} : { held },
    );
    await act(async () => t.remount());
    await t.until(
      () => section()?.getAttribute("data-anchor-section") === shownAs,
    );
    expect(section()?.getAttribute("data-anchor-section")).toBe(shownAs);
    expect(taskRead.subscriptions()).toBeGreaterThan(0);
    return taskRead;
  }
  /** The real read is ready, of `version` (the hold hides it; it never makes one up). */
  async function realReady(
    t: Mounted,
    taskRead: ReturnType<typeof sectionTaskRead>,
    version: number,
  ) {
    await t.until(() => taskRead.real()?.status === "ready");
    const real = taskRead.real();
    expect(real?.status).toBe("ready");
    if (real?.status !== "ready") throw new Error("unreachable");
    expect(real.value.base?.version).toBe(version);
    return real.value.observation;
  }
  /** Another device's change of the task (version 2), published by a real sync page. */
  async function changedElsewhere(t: Mounted, task: SeededTask, version = 2) {
    const row = task.rows.find((r) => r.id === task.taskId);
    if (row === undefined) throw new Error("setup");
    expect(
      await t.commitNow([
        { ...row, version, label: `Changed on another device (${version})` },
      ]),
    ).toBe(true);
  }
  /**
   * Every enqueue/supersede asked of the page's outbox, passed through (installed once per test); `next` runs inside the NEXT one before
   * it is written, `holdAnswer` holds the delivery of the NEXT one's answer after it is written (until the returned release).
   */
  function outboxCalls(t: Mounted) {
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const enqueue = outbox.enqueue.bind(outbox);
    const supersede = outbox.supersede.bind(outbox);
    const asked: { method: string; request: EnqueueRequest }[] = [];
    let between: (() => Promise<void>) | null = null;
    let answer: Promise<void> | null = null;
    const around = async <T,>(write: () => Promise<T>): Promise<T> => {
      const step = between;
      between = null;
      if (step !== null) await step();
      const held = answer;
      answer = null;
      const outcome = await write();
      if (held !== null) await held;
      return outcome;
    };
    vi.spyOn(outbox, "enqueue").mockImplementation(async (request) => {
      asked.push({ method: "enqueue", request });
      return around(() => enqueue(request));
    });
    vi.spyOn(outbox, "supersede").mockImplementation(async (id, request) => {
      asked.push({ method: "supersede", request });
      return around(() => supersede(id, request));
    });
    return {
      asked,
      next: (step: () => Promise<void>) => {
        between = step;
      },
      holdAnswer: () => {
        let release!: () => void;
        answer = new Promise<void>((resolve) => {
          release = resolve;
        });
        return async () => {
          await act(async () => release());
          await t.settle();
        };
      },
    };
  }
  const queuedAnchors = (t: Mounted) =>
    anchorDrafts(t).map((d) => ({
      status: d.status,
      expected: d.expected_version,
      body: bodyOf(t, d.local_id),
    }));

  for (const action of ["save", "remove"] as const) {
    test(`R11 ${action} (ADAPTED from Review 14's probe): opened before the task's read arrived, released before the press, changed elsewhere before the write: nothing is written on a version nobody saw`, async () => {
      const task = await seededTask();
      const t = await mounted(task, read);
      const taskRead = await sectionWithRead(t, task, { status: "loading" });
      const dialog = await open(t);
      expect(
        taskRead.hidden(),
        "the hold hid the section's read",
      ).toBeGreaterThan(0);
      const seen = await realReady(t, taskRead, 1);
      // Delivered before the press (the strengthened probe's schedule).
      await taskRead.release();
      await t.settle();
      expect(await realReady(t, taskRead, 1)).toEqual(seen);
      if (action === "save") setDays(dialog, "-5");
      const button =
        action === "save" ? words.SAVE_ANCHOR : words.REMOVE_ANCHOR;
      const calls = outboxCalls(t);
      calls.next(() => changedElsewhere(t, task));
      press(dialog, button);
      await t.settle();
      // The adaptation: Review 14's probe interposed the other device's change INSIDE this press's enqueue; the press is now refused
      // before any enqueue, so nothing is written at all. The probe's oracle (no change on version 2 that nobody saw) is asserted here and
      // at the next deliberate press, which reaches the interposition.
      expect(calls.asked, "no request without a read of the task").toEqual([]);
      expect(queuedAnchors(t)).toEqual([]);
      expect(dialogNow()).not.toBeNull();
      expect(note(dialog, words.ANCHOR_NOT_SAVED_UNCHECKED)).not.toBeNull();
      if (action === "save") expect(days(dialog)).toBe("-5");
      // The next press is a deliberate save of the task as the section shows it now (version 1): the change elsewhere, committed between
      // that press and its write, is caught and refused as changed.
      press(dialog, button);
      await t.settle();
      expect(calls.asked).toHaveLength(1);
      expect(calls.asked[0]?.request.observed).toEqual(seen);
      expect(queuedAnchors(t)).toEqual([]);
      expect(note(dialog, words.ANCHOR_NOT_SAVED_CHANGED)).not.toBeNull();
      if (action === "save") expect(days(dialog)).toBe("-5");
      // Pressed again once the change is shown: written once, on version 2.
      const now = await realReady(t, taskRead, 2);
      press(dialog, button);
      await t.settle();
      expect(dialogNow()).toBeNull();
      expect(calls.asked).toHaveLength(2);
      expect(calls.asked[1]?.request.observed).toEqual(now);
      expect(queuedAnchors(t)).toEqual([
        {
          status: "queued",
          expected: 2,
          body: {
            kind: "set_anchor",
            id: task.taskId,
            expected_version: 2,
            anchor:
              action === "save"
                ? {
                    ...ANCHOR,
                    offset: {
                      kind: "calendar_days",
                      days: -5,
                      time: "18:00:00",
                    },
                  }
                : null,
          },
        },
      ]);
    });
  }

  test.each([
    ["loading", { status: "loading" } as const],
    ["unavailable", { status: "unavailable", reason: "error" } as const],
  ])(
    "R11: the task's read still %s at the press: refused (again on a second press), the input kept; once shown, saved once on what was shown",
    async (_, held) => {
      const task = await seededTask();
      const t = await mounted(task, read);
      const taskRead = await sectionWithRead(t, task, held);
      const dialog = await open(t);
      setDays(dialog, "-4");
      const calls = outboxCalls(t);
      for (const _press of [1, 2]) {
        press(dialog, words.SAVE_ANCHOR);
        await t.settle();
        expect(calls.asked).toEqual([]);
        expect(note(dialog, words.ANCHOR_NOT_SAVED_UNCHECKED)).not.toBeNull();
        expect(days(dialog)).toBe("-4");
      }
      expect(taskRead.hidden()).toBeGreaterThan(0);
      const seen = await realReady(t, taskRead, 1);
      // The read arriving saves nothing by itself.
      await taskRead.release();
      await t.settle();
      expect(calls.asked).toEqual([]);
      expect(queuedAnchors(t)).toEqual([]);
      press(dialog, words.SAVE_ANCHOR);
      await t.settle();
      expect(dialogNow()).toBeNull();
      expect(calls.asked.map((c) => c.request.observed)).toEqual([seen]);
      expect(queuedAnchors(t)).toMatchObject([
        { status: "queued", expected: 1 },
      ]);
    },
  );

  test("R11 controls: opened on a ready read, the first press is written on it; changed elsewhere before the write, it is refused as changed", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const taskRead = await sectionWithRead(t, task);
    const seen = await realReady(t, taskRead, 1);
    let dialog = await open(t);
    setDays(dialog, "-5");
    const calls = outboxCalls(t);
    calls.next(() => changedElsewhere(t, task));
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(calls.asked.map((c) => c.request.observed)).toEqual([seen]);
    expect(queuedAnchors(t)).toEqual([]);
    expect(note(dialog, words.ANCHOR_NOT_SAVED_CHANGED)).not.toBeNull();
    press(dialog, "Cancel");
    await t.settle();
    // Unchanged since the panel opened: one press, written.
    const now = await realReady(t, taskRead, 2);
    dialog = await open(t);
    setDays(dialog, "-6");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(calls.asked.map((c) => c.request.observed)).toEqual([seen, now]);
    expect(queuedAnchors(t)).toMatchObject([{ status: "queued", expected: 2 }]);
    expect(taskRead.hidden()).toBe(0);
  });

  test("R11 control: a change of the task shown after the panel opened, before its press, is refused as changed (the session's own read, never the latest)", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const taskRead = await sectionWithRead(t, task);
    const seen = await realReady(t, taskRead, 1);
    const dialog = await open(t);
    setDays(dialog, "-5");
    await act(async () => {
      await changedElsewhere(t, task);
    });
    await t.settle();
    const now = await realReady(t, taskRead, 2);
    const calls = outboxCalls(t);
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(calls.asked.map((c) => c.request.observed)).toEqual([seen]);
    expect(queuedAnchors(t)).toEqual([]);
    expect(note(dialog, words.ANCHOR_NOT_SAVED_CHANGED)).not.toBeNull();
    expect(days(dialog)).toBe("-5");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(calls.asked.map((c) => c.request.observed)).toEqual([seen, now]);
    expect(queuedAnchors(t)).toMatchObject([{ status: "queued", expected: 2 }]);
  });

  test("R11 Review of a conflicted change, opened before the task's read: no blind replacement (the conflict and its body stay); then one deliberate replacement, checked when written", async () => {
    const task = await seededTask();
    const conflicted = draftRow({
      local_id: "00000000-0000-4000-8000-00000000c0f2",
      endpoint: "/calendar-commands",
      status: "version_conflict",
      command: {
        command: {
          kind: "set_anchor",
          id: task.taskId,
          expected_version: 0,
          anchor: ANCHOR,
        },
      } as never,
      target_resource_ids: [task.taskId],
      index_targets: [task.taskId],
      bases: { [task.taskId]: 0 },
      last_error: { status: 409, code: "conflict", stage: "conflict" },
    });
    const t = await mounted(task, {
      online: false,
      rows: [sourceRow, eventRow()],
      drafts: [conflicted],
    });
    const taskRead = await sectionWithRead(
      t,
      task,
      { status: "loading" },
      "offline",
    );
    const dialog = await open(t, words.REVIEW_ANCHOR);
    const calls = outboxCalls(t);
    const before = {
      draft: anchorDrafts(t),
      body: bodyOf(t, conflicted.local_id),
    };
    expect(before.draft.map((d) => d.status)).toEqual(["version_conflict"]);
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(calls.asked).toEqual([]);
    expect(note(dialog, words.ANCHOR_NOT_SAVED_UNCHECKED)).not.toBeNull();
    expect(anchorDrafts(t)).toEqual(before.draft);
    expect(bodyOf(t, conflicted.local_id)).toEqual(before.body);
    const seen = await realReady(t, taskRead, 1);
    await taskRead.release();
    await t.settle();
    // Changed elsewhere between the deliberate press and its write: refused; the conflict still stands.
    calls.next(() => changedElsewhere(t, task));
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(calls.asked.map((c) => [c.method, c.request.observed])).toEqual([
      ["supersede", seen],
    ]);
    expect(note(dialog, words.ANCHOR_NOT_SAVED_CHANGED)).not.toBeNull();
    expect(anchorDrafts(t)).toEqual(before.draft);
    expect(bodyOf(t, conflicted.local_id)).toEqual(before.body);
    const now = await realReady(t, taskRead, 2);
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(calls.asked.map((c) => [c.method, c.request.observed])).toEqual([
      ["supersede", seen],
      ["supersede", now],
    ]);
    expect(
      anchorDrafts(t).find((d) => d.local_id === conflicted.local_id),
    ).toBeUndefined();
    expect(queuedAnchors(t)).toEqual([
      {
        status: "queued",
        expected: 2,
        body: {
          kind: "set_anchor",
          id: task.taskId,
          expected_version: 2,
          anchor: ANCHOR,
        },
      },
    ]);
  });

  test("R11 after a done save that kept newer input: the next save waits for the task's read (refused while it is not shown), then is written once on it", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const taskRead = await sectionWithRead(t, task);
    const first = await realReady(t, taskRead, 1);
    const calls = outboxCalls(t);
    const release = calls.holdAnswer();
    const dialog = await open(t);
    setDays(dialog, "-2");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    setDays(dialog, "-3");
    // The task's read is not available when the done save renews the session.
    await taskRead.hold({ status: "unavailable", reason: "error" });
    await release();
    expect(note(dialog, words.ANCHOR_SAVED_NEWER)).not.toBeNull();
    expect(anchorDrafts(t)).toHaveLength(1);
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(calls.asked.map((c) => c.request.observed)).toEqual([first]);
    expect(note(dialog, words.ANCHOR_NOT_SAVED_UNCHECKED)).not.toBeNull();
    expect(days(dialog)).toBe("-3");
    expect(anchorDrafts(t)).toHaveLength(1);
    await taskRead.release();
    await t.settle();
    const now = taskRead.real();
    expect(now?.status).toBe("ready");
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(calls.asked.map((c) => c.request.observed)).toEqual([
      first,
      now?.status === "ready" ? now.value.observation : "unreachable",
    ]);
    expect(
      queuedAnchors(t).map(
        (q) => (q.body?.anchor as CalendarAnchor | undefined)?.offset,
      ),
    ).toEqual([
      { kind: "calendar_days", days: -2, time: "18:00:00" },
      { kind: "calendar_days", days: -3, time: "18:00:00" },
    ]);
  });

  test("R11 after a changed refusal: while the task's read is not shown nothing is written and the change keeps its identity; each deliberate press is checked when written", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const taskRead = await sectionWithRead(t, task);
    const seen = await realReady(t, taskRead, 1);
    const dialog = await open(t);
    setDays(dialog, "-5");
    const calls = outboxCalls(t);
    calls.next(() => changedElsewhere(t, task, 2));
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(note(dialog, words.ANCHOR_NOT_SAVED_CHANGED)).not.toBeNull();
    const key = calls.asked[0]?.request.localId;
    expect(key).toBeDefined();
    await realReady(t, taskRead, 2);
    await taskRead.hold();
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(calls.asked).toHaveLength(1);
    expect(note(dialog, words.ANCHOR_NOT_SAVED_UNCHECKED)).not.toBeNull();
    expect(taskRead.hidden()).toBeGreaterThan(0);
    await taskRead.release();
    await t.settle();
    const second = await realReady(t, taskRead, 2);
    // Changed elsewhere AGAIN between this press and its write.
    calls.next(() => changedElsewhere(t, task, 3));
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(note(dialog, words.ANCHOR_NOT_SAVED_CHANGED)).not.toBeNull();
    expect(queuedAnchors(t)).toEqual([]);
    const third = await realReady(t, taskRead, 3);
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(calls.asked.map((c) => c.request.observed)).toEqual([
      seen,
      second,
      third,
    ]);
    // One change, one identity throughout: waiting for the read neither retired nor replaced it.
    expect(new Set(calls.asked.map((c) => c.request.localId))).toEqual(
      new Set([key]),
    );
    expect(anchorDrafts(t).map((d) => d.local_id)).toEqual([key]);
    expect(queuedAnchors(t)).toMatchObject([{ status: "queued", expected: 3 }]);
  });

  test("R11 retained: a session opened before the task's read and left holding input is shown again by a NEW section mount with the read ready; it is not silently given that read (the press is refused once), then saved", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const taskRead = await sectionWithRead(t, task, { status: "loading" });
    let dialog = await open(t);
    setDays(dialog, "-8");
    // The protected tree mounts again (the same visit): the panel leaves without Cancel, holding its input.
    await taskRead.release();
    await act(async () => t.remount());
    await t.until(
      () => section()?.getAttribute("data-anchor-section") === "anchored",
    );
    const seen = await realReady(t, taskRead, 1);
    dialog = await open(t);
    expect(days(dialog), "the session shown again").toBe("-8");
    const calls = outboxCalls(t);
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(calls.asked).toEqual([]);
    expect(note(dialog, words.ANCHOR_NOT_SAVED_UNCHECKED)).not.toBeNull();
    press(dialog, words.SAVE_ANCHOR);
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(calls.asked.map((c) => c.request.observed)).toEqual([seen]);
    expect(queuedAnchors(t)).toMatchObject([{ status: "queued", expected: 1 }]);
  });

  test("R11 Enter in the panel (the form's own submission) takes the same check: refused before the read, written after", async () => {
    const task = await seededTask();
    const t = await mounted(task, read);
    const taskRead = await sectionWithRead(t, task, { status: "loading" });
    const dialog = await open(t);
    setDays(dialog, "-9");
    const calls = outboxCalls(t);
    const field = present(within(dialog).queryByLabelText(words.DAYS_LABEL));
    fireEvent.submit(present(field.closest("form")));
    await t.settle();
    expect(calls.asked).toEqual([]);
    expect(note(dialog, words.ANCHOR_NOT_SAVED_UNCHECKED)).not.toBeNull();
    const seen = await realReady(t, taskRead, 1);
    await taskRead.release();
    await t.settle();
    fireEvent.submit(present(field.closest("form")));
    await t.settle();
    expect(dialogNow()).toBeNull();
    expect(calls.asked.map((c) => c.request.observed)).toEqual([seen]);
    expect(queuedAnchors(t)).toMatchObject([{ status: "queued", expected: 1 }]);
  });
});

describe("revision 22: a refused change is explained only by what its refusal recorded (review 26 F26-1)", () => {
  // The rejected change (`set_anchor`) is a durable draft with the server's status and Atlas code. A `422 invalid_value` names no rule
  // (the pinned backend's `set_task_anchor` rejects, among others, a person-date field that is no longer a date, keeping the OLD
  // binding). So the binding read separately, the refused body and the task as it is now are not evidence of the cause: every `422` is
  // explained generically, the same whatever else the page has read, and a `403`/`404` says only that something the change needs is not
  // available. Each test checks the WHOLE message, the draft kept as it was (body, key, status, error) and that rendering reads nothing.
  const FIELD = "00000000-0000-4000-8000-0000000000f1";
  const EVENT_DAYS: CalendarAnchor = ANCHOR;
  const EVENT_SECONDS: CalendarAnchor = {
    reference: ANCHOR.reference,
    offset: { kind: "elapsed_seconds", seconds: -3600 },
    weekdays: [],
  };
  const PERSON_DAYS: CalendarAnchor = {
    reference: { kind: "person_date", field_id: FIELD, annual: true },
    offset: { kind: "calendar_days", days: 0 },
    weekdays: [],
  };
  const dateField = cacheRow({
    id: FIELD,
    kind: "field",
    label: "Birthday",
    value: { kind: "date", month: 3, day: 14 },
  });
  const GENERIC = words.anchorRejected(words.ANCHOR_REASONS.other as string);
  const UNAVAILABLE = words.anchorRejected(
    words.ANCHOR_REASONS.unavailable as string,
  );
  const UNPROVEN = [
    "seconds offsets need a timed event",
    "it repeats on its own schedule",
  ];
  const REFUSED = "00000000-0000-4000-8000-00000000c2f1";
  const refusedDraft = (
    task: SeededTask,
    anchor: CalendarAnchor | null,
    lastError: { status?: number; code?: string; stage: string } | null,
    over: Record<string, unknown> = {},
  ) =>
    draftRow({
      local_id: REFUSED,
      endpoint: "/calendar-commands",
      status: "rejected",
      command: {
        command: {
          kind: "set_anchor",
          id: task.taskId,
          expected_version: 1,
          anchor,
        },
      } as never,
      target_resource_ids: [task.taskId],
      index_targets: [task.taskId],
      last_error: lastError,
      ...over,
    });
  const bindingOf = (anchor: CalendarAnchor | null) => async () =>
    ({
      ok: true,
      value: {
        binding: anchor === null ? null : { anchor, version: 1, active: true },
      },
    }) as const;
  /** The refusal's own line (the message, without its Dismiss button), or null when none is shown. */
  const refusal = () =>
    section()?.querySelector("[data-anchor-rejected] > span")?.textContent ??
    null;
  /** The refused draft exactly as seeded: nothing about showing it resends, replaces, re-keys or dismisses it. */
  const keptAsSeeded = (
    t: Mounted,
    seeded: ReturnType<typeof refusedDraft>,
  ) => {
    const now = anchorDrafts(t).find((d) => d.local_id === seeded.local_id);
    expect(now?.status).toBe("rejected");
    expect(now?.last_error).toEqual(seeded.last_error);
    expect(now?.attempts).toBe(seeded.attempts);
    expect(bodyOf(t, seeded.local_id)).toEqual(
      (seeded.command as { command: object }).command,
    );
  };
  const rows = [sourceRow, eventRow(), dateField];

  for (const [name, old] of [
    ["calendar days", EVENT_DAYS],
    ["seconds on a timed event", EVENT_SECONDS],
  ] as const) {
    test(`F26-1 old binding (${name}): the same refused person-date change and the same 422 give the same generic reason`, async () => {
      const task = await seededTask();
      const seeded = refusedDraft(task, PERSON_DAYS, {
        status: 422,
        code: "invalid_value",
        stage: "rejected",
      });
      const t = await mounted(task, {
        binding: bindingOf(old),
        rows: [
          sourceRow,
          eventRow(),
          cacheRow({
            id: FIELD,
            kind: "field",
            value: { kind: "text", text: "changed from a date" },
          }),
        ],
        drafts: [seeded],
      });
      await t.until(
        () => section()?.getAttribute("data-anchor-section") === "anchored",
      );
      expect(section()?.getAttribute("data-anchor-section")).toBe("anchored");
      expect(refusal()).toBe(GENERIC);
      for (const phrase of UNPROVEN) expect(refusal()).not.toContain(phrase);
      expect(anchorDrafts(t)).toHaveLength(1);
      keptAsSeeded(t, seeded);
      expect(t.api.calls.readAnchor).toBe(1);
    });
  }

  // Reference and offset kinds changed (or not) between the old binding and the refused change, and 422 codes other than invalid_value:
  // none of them, the refused change's own seconds offset included, establishes a cause.
  const transitions: Array<
    [string, CalendarAnchor | null, CalendarAnchor | null, string]
  > = [
    ["event series → person date", EVENT_SECONDS, PERSON_DAYS, "invalid_value"],
    [
      "person date → event series in seconds",
      PERSON_DAYS,
      EVENT_SECONDS,
      "invalid_value",
    ],
    ["days → seconds, same event", EVENT_DAYS, EVENT_SECONDS, "invalid_value"],
    ["seconds → days, same event", EVENT_SECONDS, EVENT_DAYS, "invalid_value"],
    [
      "seconds → other seconds (calendar_limit)",
      EVENT_SECONDS,
      { ...EVENT_SECONDS, offset: { kind: "elapsed_seconds", seconds: 60 } },
      "calendar_limit",
    ],
    ["removal (anchor: null)", EVENT_SECONDS, null, "invalid_value"],
    ["no binding → event in seconds", null, EVENT_SECONDS, "invalid_value"],
  ];
  for (const [name, old, submitted, code] of transitions) {
    test(`F26-1 transitions: ${name}, 422 ${code} → the generic reason`, async () => {
      const task = await seededTask();
      const seeded = refusedDraft(task, submitted, {
        status: 422,
        code,
        stage: "rejected",
      });
      const t = await mounted(task, {
        binding: bindingOf(old),
        rows,
        drafts: [seeded],
      });
      const shown = old === null ? "none" : "anchored";
      await t.until(
        () => section()?.getAttribute("data-anchor-section") === shown,
      );
      expect(section()?.getAttribute("data-anchor-section")).toBe(shown);
      expect(refusal()).toBe(GENERIC);
      keptAsSeeded(t, seeded);
      expect(t.api.calls.readAnchor).toBe(1);
    });
  }

  test("F26-1 binding states: offline, refused, uncertain and pending reads give the same reason as a read one, and a late answer changes nothing", async () => {
    const seen: Array<string | null> = [];
    for (const how of ["offline", "refused", "uncertain"] as const) {
      const task = await seededTask();
      const seeded = refusedDraft(task, EVENT_SECONDS, {
        status: 422,
        code: "invalid_value",
        stage: "rejected",
      });
      const t = await mounted(task, {
        online: how !== "offline",
        binding: async () =>
          how === "refused"
            ? { ok: false, kind: "forbidden" }
            : { ok: false, kind: "uncertain" },
        rows,
        drafts: [seeded],
      });
      await t.settle();
      expect(section()?.getAttribute("data-anchor-section")).toBe(
        how === "offline" ? "offline" : "failed",
      );
      seen.push(refusal());
      keptAsSeeded(t, seeded);
      expect(t.api.calls.readAnchor ?? 0).toBe(how === "offline" ? 0 : 1);
      cleanup();
      forgetBindings();
      forgetTaskMemory();
    }
    // Pending, then answered with an old timed seconds binding while the refusal is shown.
    const task = await seededTask();
    const seeded = refusedDraft(task, EVENT_SECONDS, {
      status: 422,
      code: "invalid_value",
      stage: "rejected",
    });
    let answer: (
      value: Awaited<ReturnType<ReturnType<typeof bindingOf>>>,
    ) => void = () => undefined;
    const t = await mounted(task, {
      binding: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      rows,
      drafts: [seeded],
    });
    expect(section()?.getAttribute("data-anchor-section")).toBe("reading");
    seen.push(refusal());
    await act(async () => answer(await bindingOf(EVENT_SECONDS)()));
    await t.until(
      () => section()?.getAttribute("data-anchor-section") === "anchored",
    );
    expect(section()?.getAttribute("data-anchor-section")).toBe("anchored");
    seen.push(refusal());
    expect(seen).toEqual([GENERIC, GENERIC, GENERIC, GENERIC, GENERIC]);
    keptAsSeeded(t, seeded);
    expect(t.api.calls.readAnchor).toBe(1);
  });

  test("F26-1 reload and remount: the reason is the durable refusal's, the same after a tree remount and on a new page whose binding is never read", async () => {
    const task = await seededTask();
    const seeded = refusedDraft(task, EVENT_DAYS, {
      status: 422,
      code: "invalid_value",
      stage: "rejected",
    });
    const t = await mounted(task, {
      binding: bindingOf(EVENT_SECONDS),
      rows,
      drafts: [seeded],
    });
    await t.until(
      () => section()?.getAttribute("data-anchor-section") === "anchored",
    );
    expect(refusal()).toBe(GENERIC);
    act(() => t.remount());
    await t.until(() => refusal() !== null);
    await t.settle();
    expect(refusal()).toBe(GENERIC);
    expect(t.api.calls.readAnchor).toBe(1);
    // A new page (page memory and its binding reads gone; the outbox's rows are what is durable): offline, nothing is read.
    t.unmount();
    cleanup();
    forgetBindings();
    forgetTaskMemory();
    forgetKeptPanels();
    const again = await mounted(task, {
      online: false,
      rows,
      drafts: [seeded],
    });
    expect(section()?.getAttribute("data-anchor-section")).toBe("offline");
    expect(refusal()).toBe(GENERIC);
    keptAsSeeded(again, seeded);
    expect(again.api.calls.readAnchor ?? 0).toBe(0);
  });

  test("F26-1 several changes: the reason is the refused change's; a later queued change is untouched and Dismiss removes only the refused one", async () => {
    const task = await seededTask();
    const seeded = refusedDraft(task, EVENT_SECONDS, {
      status: 422,
      code: "invalid_value",
      stage: "rejected",
    });
    const later = draftRow({
      local_id: "00000000-0000-4000-8000-00000000c2f2",
      endpoint: "/calendar-commands",
      status: "queued",
      command: {
        command: {
          kind: "set_anchor",
          id: task.taskId,
          expected_version: 1,
          anchor: PERSON_DAYS,
        },
      } as never,
      target_resource_ids: [task.taskId],
      index_targets: [task.taskId],
    });
    const t = await mounted(task, {
      online: false,
      rows,
      drafts: [seeded, later],
    });
    expect(
      section()
        ?.querySelector("[data-anchor-rejected]")
        ?.getAttribute("data-anchor-rejected"),
    ).toBe(REFUSED);
    expect(section()?.querySelectorAll("[data-anchor-rejected]")).toHaveLength(
      1,
    );
    expect(refusal()).toBe(GENERIC);
    keptAsSeeded(t, seeded);
    expect(section()).toHaveTextContent(words.ANCHOR_QUEUED);
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.DISMISS_ANCHOR,
        }),
      ),
    );
    await t.settle();
    expect(refusal()).toBeNull();
    expect(anchorDrafts(t).map((d) => [d.local_id, d.status])).toEqual([
      [later.local_id, "queued"],
    ]);
    expect(bodyOf(t, later.local_id)).toEqual({
      kind: "set_anchor",
      id: task.taskId,
      expected_version: 1,
      anchor: PERSON_DAYS,
    });
  });

  for (const [name, lastError, over] of [
    [
      "a dependency's refusal (no status of its own)",
      { stage: "dependency_rejected" },
      {},
    ],
    ["no recorded error", null, {}],
  ] as const) {
    test(`F26-1 ${name}: the generic reason`, async () => {
      const task = await seededTask();
      const seeded = refusedDraft(task, EVENT_SECONDS, lastError, over);
      const t = await mounted(task, {
        binding: bindingOf(EVENT_SECONDS),
        rows,
        drafts: [seeded],
      });
      await t.until(
        () => section()?.getAttribute("data-anchor-section") === "anchored",
      );
      expect(refusal()).toBe(GENERIC);
      keptAsSeeded(t, seeded);
    });
  }

  // `403`/`404`: something the change needs is not available, which may be the task itself (the backend checks the task before the
  // reference), so a refused REMOVAL says the same. The same whatever the binding read.
  for (const [status, code] of [
    [403, "forbidden"],
    [404, "not_found"],
  ] as const) {
    for (const submitted of [EVENT_SECONDS, null]) {
      test(`F26-1 supported reason: ${status} on ${submitted === null ? "a removal" : "a change"} → unavailable, with any binding`, async () => {
        const shown: Array<string | null> = [];
        for (const old of [EVENT_SECONDS, null]) {
          const task = await seededTask();
          const seeded = refusedDraft(task, submitted, {
            status,
            code,
            stage: "rejected",
          });
          const t = await mounted(task, {
            binding: bindingOf(old),
            rows,
            drafts: [seeded],
          });
          const state = old === null ? "none" : "anchored";
          await t.until(
            () => section()?.getAttribute("data-anchor-section") === state,
          );
          shown.push(refusal());
          keptAsSeeded(t, seeded);
          cleanup();
          forgetBindings();
          forgetTaskMemory();
        }
        expect(shown).toEqual([UNAVAILABLE, UNAVAILABLE]);
      });
    }
  }

  test("F26-1 the refusal reasons are only those a recorded refusal can support (no recurrence or seconds diagnosis)", () => {
    expect(Object.keys(words.ANCHOR_REASONS).sort()).toEqual([
      "other",
      "unavailable",
    ]);
    for (const reason of Object.values(words.ANCHOR_REASONS))
      for (const unproven of UNPROVEN) expect(reason).not.toContain(unproven);
  });
});

describe("revision 33: a picker whose page is not read yet claims nothing (review 40 F40-2)", () => {
  /**
   * The pickers' OWN list read (`useResourceList` → `data.readResourceList` of `kind`), through the page's real store: while held, the
   * picker is shown one CONSTANT `loading` (or the `unavailable` given) whatever the read underneath publishes; released, it is shown the
   * read as it is. `when` narrows which reads are held (a later page only, for "Show next"). Installed before the picker mounts.
   */
  function holdList(
    t: Mounted,
    kind: "event" | "field",
    when: (input: { after?: string | null }) => boolean = () => true,
  ) {
    const service = t.data.service();
    if (service === null) throw new Error("setup: no open service");
    const store = service.store as unknown as {
      watch(plan: { name: string }, input: unknown): Watchable<unknown>;
    };
    const watch = store.watch.bind(store);
    const LOADING: Loadable<never> = { status: "loading" };
    let shown: Loadable<never> | null = LOADING;
    let held = 0;
    let subscribed = 0;
    const listeners = new Set<() => void>();
    vi.spyOn(store, "watch").mockImplementation(((
      plan: { name: string },
      input: { kind?: string; after?: string | null },
    ) => {
      const source = watch(plan, input);
      if (
        plan.name !== "data.readResourceList" ||
        input.kind !== kind ||
        !when(input)
      )
        return source;
      return {
        get: () => {
          if (shown === null) return source.get();
          held += 1;
          return shown;
        },
        subscribe: (listener: () => void) => {
          subscribed += 1;
          listeners.add(listener);
          const off = source.subscribe(() => {
            if (shown === null) listener();
          });
          return () => {
            listeners.delete(listener);
            off();
          };
        },
      } satisfies Watchable<unknown>;
    }) as never);
    const tell = () => {
      for (const listener of [...listeners]) listener();
    };
    return {
      hold: (as: Loadable<never> = LOADING) =>
        act(() => {
          shown = as;
          tell();
        }),
      release: () =>
        act(() => {
          shown = null;
          tell();
        }),
      /** How often a held read was shown held (a hold that hid nothing proves nothing). */
      held: () => held,
      subscriptions: () => subscribed,
    };
  }
  const UNAVAILABLE: Loadable<never> = {
    status: "unavailable",
    reason: "error",
  };
  const pickerOf = (dialog: HTMLElement, kind: "event" | "field") =>
    present(dialog.querySelector(`[data-anchor-picker="${kind}"]`));
  /** What the picker's list area claims: its state element, and whether any empty or no-match sentence is shown. */
  const claims = (picker: HTMLElement) => ({
    state: picker
      .querySelector("[data-picker-state]")
      ?.getAttribute("data-picker-state"),
    busy: picker
      .querySelector("[data-picker-state]")
      ?.getAttribute("aria-busy"),
    text: picker.textContent ?? "",
  });
  async function openAnchorPanel(t: Mounted) {
    fireEvent.click(
      present(
        within(section() as HTMLElement).queryByRole("button", {
          name: words.ANCHOR_ACTION,
        }),
      ),
    );
    return dialogOpened(t);
  }
  async function openPicker(t: Mounted, dialog: HTMLElement, name: string) {
    fireEvent.click(present(within(dialog).queryByRole("button", { name })));
    await t.settle();
  }
  const events = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      eventRow({
        id: `00000000-0000-4000-8000-${String(i + 5000).padStart(12, "0")}`,
        label: `Event ${String(i).padStart(3, "0")}`,
        value: {
          uid: `event-${i}@example`,
          original: "2026-11-02",
          title: `Event ${String(i).padStart(3, "0")}`,
          start: {
            date: "2026-11-02",
            time: "07:00:00",
            timezone: "Europe/London",
            instant: 1793602800,
          },
          end: null,
          status: "present",
          sequence: 0,
        },
      }),
    );

  test("Q3 event picker: loading while held (busy, no 'No events yet'), the events once ready, 'can't be shown' when unavailable", async () => {
    const task = await seededTask();
    const t = await mounted(task, {
      online: false,
      rows: [sourceRow, eventRow()],
    });
    const dialog = await openAnchorPanel(t);
    const list = holdList(t, "event");
    await openPicker(t, dialog, words.CHANGE_EVENT);
    const picker = pickerOf(dialog, "event");
    expect(list.subscriptions()).toBeGreaterThan(0);
    expect(list.held()).toBeGreaterThan(0);
    expect(claims(picker)).toMatchObject({ state: "loading", busy: "true" });
    expect(claims(picker).text).toContain(words.EVENTS_LOADING);
    expect(claims(picker).text).not.toContain(words.NO_EVENTS_YET);
    expect(claims(picker).text).not.toContain(words.NO_MATCHES);
    // Q8: the busy loading state adds no accessibility violation to the panel.
    expect((await axe(document.body)).violations).toEqual([]);
    await list.release();
    await t.settle();
    expect(claims(picker).state).toBeUndefined();
    expect(within(picker).queryByText("Bin day")).not.toBeNull();
    await list.hold(UNAVAILABLE);
    expect(claims(picker).state).toBe("unavailable");
    expect(claims(picker).text).toContain(words.PICKER_UNREADABLE);
    expect(claims(picker).text).not.toContain(words.NO_EVENTS_YET);
    expect(within(picker).queryByText("Bin day")).toBeNull();
  });

  test("Q3 control: a ready page with no events says 'No events yet' (and nothing loading)", async () => {
    const task = await seededTask();
    const t = await mounted(task, { online: false, rows: [sourceRow] });
    const dialog = await openAnchorPanel(t);
    const list = holdList(t, "event");
    await openPicker(t, dialog, words.CHANGE_EVENT);
    const picker = pickerOf(dialog, "event");
    expect(claims(picker).state).toBe("loading");
    await list.release();
    await t.settle();
    expect(claims(picker).state).toBeUndefined();
    expect(claims(picker).text).toContain(words.NO_EVENTS_YET);
    expect(claims(picker).text).not.toContain(words.EVENTS_LOADING);
  });

  test("Q4 field picker: loading while held (no 'No date fields'), the fields once ready, 'can't be shown' when unavailable; ready-empty control", async () => {
    const FIELD = "00000000-0000-4000-8000-00000000f401";
    const task = await seededTask();
    const t = await mounted(task, {
      online: false,
      rows: [
        cacheRow({
          id: FIELD,
          kind: "field",
          label: "Birthday",
          value: { kind: "date", month: 3, day: 14 },
        }),
      ],
    });
    const dialog = await openAnchorPanel(t);
    const list = holdList(t, "field");
    await openPicker(t, dialog, words.CHOOSE_FIELD);
    const picker = pickerOf(dialog, "field");
    expect(list.held()).toBeGreaterThan(0);
    expect(claims(picker)).toMatchObject({ state: "loading", busy: "true" });
    expect(claims(picker).text).toContain(words.FIELDS_LOADING);
    expect(claims(picker).text).not.toContain(words.NO_DATE_FIELDS);
    expect(claims(picker).text).not.toContain(words.NO_MATCHES);
    await list.release();
    await t.settle();
    expect(claims(picker).state).toBeUndefined();
    expect(within(picker).queryByText("Birthday")).not.toBeNull();
    await list.hold(UNAVAILABLE);
    expect(claims(picker).state).toBe("unavailable");
    expect(claims(picker).text).toContain(words.PICKER_UNREADABLE);
    expect(claims(picker).text).not.toContain(words.NO_DATE_FIELDS);
  });

  test("Q4 control: no date field cached: 'No date fields on this device yet' once the page is ready", async () => {
    const task = await seededTask();
    const t = await mounted(task, { online: false });
    const dialog = await openAnchorPanel(t);
    const list = holdList(t, "field");
    await openPicker(t, dialog, words.CHOOSE_FIELD);
    const picker = pickerOf(dialog, "field");
    expect(claims(picker).state).toBe("loading");
    await list.release();
    await t.settle();
    expect(claims(picker).state).toBeUndefined();
    expect(claims(picker).text).toContain(words.NO_DATE_FIELDS);
  });

  test("Q5/Q6 Show next events: the next page loading claims nothing, Show previous stays, a search while loading claims no match; the 101st once ready", async () => {
    const task = await seededTask();
    const t = await mounted(task, {
      online: false,
      rows: [sourceRow, ...events(101)],
    });
    const dialog = await openAnchorPanel(t);
    // Only the later page's read is held: the first page is read as it is.
    const list = holdList(
      t,
      "event",
      (input) => (input.after ?? null) !== null,
    );
    await list.release();
    await list.hold();
    await openPicker(t, dialog, words.CHANGE_EVENT);
    const picker = pickerOf(dialog, "event");
    expect(within(picker).queryByText("Event 000")).not.toBeNull();
    expect(within(picker).queryByText("Event 100")).toBeNull();
    fireEvent.click(
      present(
        within(picker).queryByRole("button", { name: words.SHOW_NEXT_EVENTS }),
      ),
    );
    await t.settle();
    expect(list.held()).toBeGreaterThan(0);
    expect(claims(picker)).toMatchObject({ state: "loading", busy: "true" });
    expect(claims(picker).text).not.toContain(words.NO_EVENTS_YET);
    expect(within(picker).queryByText("Event 000")).toBeNull();
    expect(
      within(picker).queryByRole("button", {
        name: words.SHOW_PREVIOUS_EVENTS,
      }),
    ).not.toBeNull();
    // Q6: a search typed while the page is loading claims no match either.
    fireEvent.change(
      present(within(picker).queryByLabelText(words.SEARCH_TITLES)),
      { target: { value: "Event 100" } },
    );
    expect(claims(picker).state).toBe("loading");
    expect(claims(picker).text).not.toContain(words.NO_MATCHES);
    await list.release();
    await t.settle();
    expect(claims(picker).state).toBeUndefined();
    expect(within(picker).queryByText("Event 100")).not.toBeNull();
  });

  test("Q7 panel ↔ picker: every opening of the picker shows loading until its read is ready, never a stale empty claim", async () => {
    const task = await seededTask();
    const t = await mounted(task, {
      online: false,
      rows: [sourceRow, eventRow()],
    });
    const dialog = await openAnchorPanel(t);
    const list = holdList(t, "event");
    for (const round of [1, 2]) {
      await list.hold();
      await openPicker(t, dialog, words.CHANGE_EVENT);
      const picker = pickerOf(dialog, "event");
      expect(claims(picker).state, `round ${round}`).toBe("loading");
      expect(claims(picker).text).not.toContain(words.NO_EVENTS_YET);
      await list.release();
      await t.settle();
      expect(within(picker).queryByText("Bin day")).not.toBeNull();
      fireEvent.click(
        present(within(picker).queryByRole("button", { name: words.BACK })),
      );
      await t.settle();
      expect(dialog.querySelector('[data-anchor-picker="event"]')).toBeNull();
    }
  });
});
