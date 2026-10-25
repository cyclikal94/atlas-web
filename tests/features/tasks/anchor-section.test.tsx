import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import * as words from "../../../src/features/calendars/copy-anchor";
import type { CalendarAnchor } from "../../../src/features/calendars/model/anchor";
import type { TasksResult } from "../../../src/features/tasks/api";
import { forgetBindings } from "../../../src/features/tasks/detail/anchor-binding";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import { cacheRow, draftRow } from "../../support/data/rows";
import {
  fakeApi,
  mountTasks,
  type SeededTask,
  seededTask,
} from "../../support/tasks/world";

/**
 * WEB-13b §4.3/§4.4 (cases 1 and 3; Q22 "other calendar commands"): the task's "Calendar anchor": the binding read ONLINE once per visit
 * (a remount, such as the session's re-check of a `403`, reads nothing more), offline "Binding details need a connection." with the rest
 * of the task still shown, and the queued `set_anchor` (set, change, remove), its conflict ("Review", superseding on the new version) and
 * its refusal. In the app's router over the PRODUCTION data controller and the IndexedDB double: FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
  forgetBindings();
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
    binding?: () => Promise<
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
          readAnchor: async () => {
            api.calls.readAnchor = (api.calls.readAnchor ?? 0) + 1;
            return (options.binding as NonNullable<typeof options.binding>)();
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
