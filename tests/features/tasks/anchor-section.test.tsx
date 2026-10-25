import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CacheRow } from "../../../src/data";
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
      within(section() as HTMLElement).getByRole("button", {
        name: words.TRY_AGAIN,
      }),
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
      within(dialog).getByRole("button", { name: words.CHANGE_EVENT }),
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
      within(section() as HTMLElement).getByRole("button", {
        name: words.ANCHOR_ACTION,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await chooseEvent(t, dialog);
    fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
      target: { value: "-1" },
    });
    fireEvent.change(within(dialog).getByLabelText(words.TIME_LABEL), {
      target: { value: "18:00" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Monday" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
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
      within(section() as HTMLElement).getByRole("button", {
        name: words.ANCHOR_ACTION,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await chooseEvent(t, dialog);
    const seconds = within(dialog).getByRole("radio", {
      name: words.OR_SECONDS,
    });
    expect(seconds).toBeDisabled();
    expect(seconds).toHaveAccessibleDescription(words.NEEDS_TIMED_EVENT);
    const days = within(dialog).getByLabelText(
      words.DAYS_LABEL,
    ) as HTMLInputElement;
    fireEvent.change(days, { target: { value: "one" } });
    fireEvent.change(within(dialog).getByLabelText(words.TITLE_CONTAINS), {
      target: { value: "Bin" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
    );
    await t.settle();
    expect(within(dialog).getByText(words.WHOLE_NUMBER)).toBeInTheDocument();
    expect(days.value).toBe("one");
    fireEvent.click(
      within(dialog).getByRole("radio", { name: words.PERSON_DATE }),
    );
    expect(within(dialog).queryByLabelText(words.TITLE_CONTAINS)).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("radio", { name: words.EVENT_SERIES }),
    );
    expect(
      (within(dialog).getByLabelText(words.TITLE_CONTAINS) as HTMLInputElement)
        .value,
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
      within(section() as HTMLElement).getByRole("button", {
        name: words.CHANGE_ANCHOR,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.REMOVE_ANCHOR }),
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
      within(section() as HTMLElement).getByRole("button", {
        name: words.REVIEW_ANCHOR,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      (within(dialog).getByLabelText(words.TIME_LABEL) as HTMLInputElement)
        .value,
    ).toBe("18:00");
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
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
      within(section() as HTMLElement).getByRole("button", {
        name: words.DISMISS_ANCHOR,
      }),
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
    const action = within(section() as HTMLElement).getByRole("button", {
      name: words.ANCHOR_ACTION,
    });
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
    fireEvent.click(
      within(section() as HTMLElement).getByRole("button", {
        name: words.CHANGE_ANCHOR,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await t.settle();
    return dialog;
  }
  async function saveDays(t: Mounted, days: string) {
    const dialog = await openChange(t);
    fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
      target: { value: days },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
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
        within(dialog).getByRole("button", { name: words.REMOVE_ANCHOR }),
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
    fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
      target: { value: "-2" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
    );
    await t.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
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
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
    );
    await t.settle();
    expect(anchorDrafts(t)).toHaveLength(1);
    fireEvent.change(within(dialog).getByLabelText(words.TITLE_CONTAINS), {
      target: { value: "newer filter" },
    });
    fireEvent.click(
      within(dialog).getByRole("radio", { name: words.PERSON_DATE }),
    );
    expect(within(dialog).queryByLabelText(words.TITLE_CONTAINS)).toBeNull();
    await act(async () => release());
    await t.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(within(dialog).getByText(words.ANCHOR_SAVED_NEWER)).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("radio", { name: words.EVENT_SERIES }),
    );
    expect(within(dialog).getByLabelText(words.TITLE_CONTAINS)).toHaveValue(
      "newer filter",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
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
      within(section() as HTMLElement).getByRole("button", {
        name: words.REVIEW_ANCHOR,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await t.settle();
    const release = holdEnqueue(t, "supersede");
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
    );
    await t.settle();
    fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
      target: { value: "-4" },
    });
    await act(async () => release());
    await t.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    // The same spy as the held one: only calls from here on count.
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const supersede = vi.spyOn(outbox, "supersede");
    supersede.mockClear();
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
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
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
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
    fireEvent.change(within(dialog).getByLabelText(words.TIME_LABEL), {
      target: { value: "19:15" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
    );
    await t.settle();
    dialog = await openChange(t);
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.CLEAR_TIME }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
    );
    await t.settle();
    dialog = await openChange(t);
    fireEvent.click(
      within(dialog).getByRole("radio", { name: words.PERSON_DATE }),
    );
    fireEvent.click(
      within(dialog).getByRole("radio", { name: words.EVENT_SERIES }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
    );
    await t.settle();
    // Edited away and back to the same minute, and cleared then typed again: what was typed (the kept time ended with the edit).
    dialog = await openChange(t);
    const time = () => within(dialog).getByLabelText(words.TIME_LABEL);
    fireEvent.change(time(), { target: { value: "19:15" } });
    fireEvent.change(time(), { target: { value: "18:00" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
    );
    await t.settle();
    dialog = await openChange(t);
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.CLEAR_TIME }),
    );
    fireEvent.change(time(), { target: { value: "18:00" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
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
      within(section() as HTMLElement).getByRole("button", {
        name: words.ANCHOR_ACTION,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.CHANGE_EVENT }),
    );
    await t.settle();
    return dialog;
  }
  const labels = (dialog: HTMLElement) =>
    [
      ...(within(dialog).getByRole("combobox") as HTMLSelectElement).options,
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
    const select = within(dialog).getByRole("combobox") as HTMLSelectElement;
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
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
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
    const dialog = await screen.findByRole("dialog");
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
    (within(dialog).getByLabelText(words.DAYS_LABEL) as HTMLInputElement).value;
  function edit(dialog: HTMLElement) {
    fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
      target: { value: "-5" },
    });
    fireEvent.change(within(dialog).getByLabelText(words.TITLE_CONTAINS), {
      target: { value: "kept filter" },
    });
    // Hidden while the person-date reference is chosen: its value is kept too.
    fireEvent.click(
      within(dialog).getByRole("radio", { name: words.PERSON_DATE }),
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
      within(again).getByRole("radio", { name: words.PERSON_DATE }),
    ).toBeChecked();
    fireEvent.click(
      within(again).getByRole("radio", { name: words.EVENT_SERIES }),
    );
    expect(within(again).getByLabelText(words.TITLE_CONTAINS)).toHaveValue(
      "kept filter",
    );
    fireEvent.click(
      within(again).getByRole("button", { name: words.SAVE_ANCHOR }),
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
    fireEvent.click(within(resumed).getByRole("button", { name: "Cancel" }));
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
    fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
      target: { value: "-2" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
    );
    await t.settle();
    await viaSyncControl(t, dialog);
    await act(async () => release());
    await t.settle();
    await to(t, `/tasks/${task.taskId}`);
    await t.until(() => section() !== null);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await t.settle();
    // Edited after Save: the newer input is resumed, and its save is an ordinary new change (not refused as changed by its own).
    release = hold();
    dialog = await openChange(t);
    fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
      target: { value: "-3" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
    );
    await t.settle();
    fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
      target: { value: "-4" },
    });
    await viaSyncControl(t, dialog);
    await act(async () => release());
    await t.settle();
    await to(t, `/tasks/${task.taskId}`);
    await t.until(() => section() !== null);
    dialog = await openChange(t);
    expect(days(dialog)).toBe("-4");
    fireEvent.click(
      within(dialog).getByRole("button", { name: words.SAVE_ANCHOR }),
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
    const dialog = await screen.findByRole("dialog");
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
    (within(dialog).getByLabelText(words.DAYS_LABEL) as HTMLInputElement).value;
  const setDays = (dialog: HTMLElement, value: string) =>
    fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
      target: { value },
    });
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
      fireEvent.change(within(dialog).getByLabelText(words.TITLE_CONTAINS), {
        target: { value: "newer filter" },
      });
      // Hidden while the person-date reference is chosen: kept too.
      fireEvent.click(
        within(dialog).getByRole("radio", { name: words.PERSON_DATE }),
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
        within(dialog).getByRole("radio", { name: words.EVENT_SERIES }),
      );
      expect(within(dialog).getByLabelText(words.TITLE_CONTAINS)).toHaveValue(
        "newer filter",
      );
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
    const outcome = await outbox.enqueue(
      setAnchorRequest(
        row,
        {
          ...ANCHOR,
          offset: { kind: "calendar_days", days, time: "18:00:00" },
        },
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
    (within(dialog).getByLabelText(words.DAYS_LABEL) as HTMLInputElement).value;
  const setDays = (dialog: HTMLElement, value: string) =>
    fireEvent.change(within(dialog).getByLabelText(words.DAYS_LABEL), {
      target: { value },
    });
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
    fireEvent.change(within(dialog).getByLabelText(words.TITLE_CONTAINS), {
      target: { value: filter },
    });
    fireEvent.click(
      within(dialog).getByRole("radio", { name: words.PERSON_DATE }),
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
        within(dialog).getByRole("radio", { name: words.PERSON_DATE }),
      ).toBeChecked();
      fireEvent.click(
        within(dialog).getByRole("radio", { name: words.EVENT_SERIES }),
      );
      expect(within(dialog).getByLabelText(words.TITLE_CONTAINS)).toHaveValue(
        "kept filter",
      );
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
        within(dialog).getByRole("radio", { name: words.EVENT_SERIES }),
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
