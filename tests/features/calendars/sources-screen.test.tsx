import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DraftRow } from "../../../src/data";
import * as copy from "../../../src/features/calendars/copy";
import { installMatchMedia } from "../../helpers/match-media";
import {
  ACCOUNT,
  atlasBody,
  calendarWorld,
  sourceRow,
} from "../../support/calendars";
import { draftRow } from "../../support/data/rows";

/**
 * The Calendars screen (WEB-13a; `wireframes/q21/calendar-journeys.html`) through the PRODUCTION controller, plans and outbox facade
 * over the double of IndexedDB, with a recorded typed client: states, enablement and its reasons, the queued Add source and settings,
 * the online-only refresh, conflicts and rejections, and axe. FIXTURE evidence (jsdom); layout, contrast and 44 px targets are the
 * native spec's (E-CAL5).
 */
installMatchMedia({ width: 1440 });
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const SOURCE = "00000000-0000-4000-8000-0000000000a1";
const drafts = (w: Awaited<ReturnType<typeof calendarWorld>>) =>
  w.rows("drafts") as DraftRow[];
const bodyOf = (w: Awaited<ReturnType<typeof calendarWorld>>, id: string) =>
  (
    w.rows("draft_commands") as Array<{ local_id: string; command: unknown }>
  ).find((row) => row.local_id === id)?.command;
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const reasonOf = (element: HTMLElement) =>
  document.getElementById(element.getAttribute("aria-describedby") ?? "")
    ?.textContent;

describe("the screen's states", () => {
  test("no database on this device: Add source waits for the first sync, Link works online, and nothing is created", async () => {
    const w = await calendarWorld({ database: false });
    expect(screen.getByText(copy.NO_DATABASE)).toBeInTheDocument();
    const add = button(copy.ADD_SOURCE);
    expect(add).toBeDisabled();
    expect(reasonOf(add)).toBe(copy.NEEDS_DATABASE);
    expect(button(copy.LINK_CALENDAR)).toBeEnabled();
    expect(w.world.idb.has(`atlas-data-${ACCOUNT}`)).toBe(false);
    expect(w.snapshot()).toBeNull();
  });

  test("an empty list says so; the wireframe's labels name each entry point's class", async () => {
    const w = await calendarWorld();
    expect(await screen.findByText(copy.EMPTY)).toBeInTheDocument();
    expect(screen.getByText(copy.ADD_SOURCE_CLASS)).toBeInTheDocument();
    expect(screen.getByText(copy.ONLINE_ONLY)).toBeInTheDocument();
    expect(screen.getByText(copy.SCREEN_EYEBROW)).toBeInTheDocument();
    expect((await axe(document.body)).violations).toEqual([]);
    void w;
  });

  test("a cached source shows its label, its last success as history, its timezone, Refresh and Manage", async () => {
    await calendarWorld({ cache: [sourceRow()] });
    const row = await screen.findByText("Family calendar");
    const item = row.closest("li") as HTMLElement;
    expect(item).toHaveTextContent(
      /Last success \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Europe\/Vienna/,
    );
    expect(
      within(item).getByRole("button", { name: "Refresh Family calendar" }),
    ).toBeEnabled();
    expect(
      within(item).getByRole("button", { name: "Manage Family calendar" }),
    ).toBeEnabled();
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("offline (the O card): Link, Refresh and the connection changes need a connection; Add source and settings still queue", async () => {
    const w = await calendarWorld({ online: false, cache: [sourceRow()] });
    await screen.findByText("Family calendar");
    expect(button(copy.ADD_SOURCE)).toBeEnabled();
    const link = button(copy.LINK_CALENDAR);
    expect(link).toBeDisabled();
    expect(reasonOf(link)).toBe(copy.NEEDS_CONNECTION);
    const refresh = button("Refresh Family calendar");
    expect(refresh).toBeDisabled();
    expect(reasonOf(refresh)).toBe(copy.NEEDS_CONNECTION);
    fireEvent.click(button("Manage Family calendar"));
    const dialog = await screen.findByRole("dialog");
    // Adapted (WEB-13a revision 1, R5): Save waits until the source's waiting changes have been read (it restates the newest one), so
    // the dialog is settled before Save is pressed; the assertions are unchanged.
    await w.settle();
    expect(
      within(dialog).getByRole("button", { name: copy.REPLACE }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: copy.REMOVE }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: copy.SAVE }),
    ).toBeEnabled();
  });

  test("a turned-off source says so and cannot be refreshed; a view-only source cannot be managed", async () => {
    await calendarWorld({
      cache: [
        sourceRow({ archived: true }),
        sourceRow({
          id: "00000000-0000-4000-8000-0000000000a2",
          label: "Shared rota",
          can_edit: false,
        }),
      ],
    });
    const off = (await screen.findByText("Family calendar")).closest(
      "li",
    ) as HTMLElement;
    expect(off).toHaveTextContent(copy.TURNED_OFF);
    expect(reasonOf(within(off).getByRole("button", { name: /Refresh/ }))).toBe(
      copy.TURNED_OFF_REASON,
    );
    const shared = screen.getByText("Shared rota").closest("li") as HTMLElement;
    expect(
      reasonOf(within(shared).getByRole("button", { name: /Manage/ })),
    ).toBe(copy.VIEW_ONLY_REASON);
  });

  test("calendar_links false (D-13a-10): Link is unavailable with the cause 3 words; an unknown capability pre-disables nothing", async () => {
    await calendarWorld({ calendarLinks: false });
    await waitFor(() => expect(button(copy.LINK_CALENDAR)).toBeDisabled());
    expect(reasonOf(button(copy.LINK_CALENDAR))).toBe(copy.CAUSE_UNCONFIGURED);
  });

  test("compat unsupported (B2): the direct actions are paused; Add source still queues", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    await act(async () =>
      w.compat.set({
        status: "unsupported",
        version: "0.26.0",
        supported: ">=0.27.0 <0.28.0",
      }),
    );
    expect(reasonOf(button(copy.LINK_CALENDAR))).toBe(copy.COMPAT_PAUSED);
    expect(reasonOf(button("Refresh Family calendar"))).toBe(
      copy.COMPAT_PAUSED,
    );
    expect(button(copy.ADD_SOURCE)).toBeEnabled();
  });
});

describe("Add source (queued, credential-free)", () => {
  test("validates in place, then queues ONE create on /calendar-commands with no secret, and shows it as pending until the server has it", async () => {
    const w = await calendarWorld({ online: false });
    fireEvent.click(button(copy.ADD_SOURCE));
    const dialog = await screen.findByRole("dialog", { name: copy.ADD_TITLE });
    expect(within(dialog).getByText(copy.ADD_HELP)).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: copy.CREATE_SOURCE }),
    );
    expect(
      await within(dialog).findByText(copy.LABEL_REQUIRED),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(copy.TIMEZONE), {
      target: { value: "Mars/Base" },
    });
    fireEvent.change(within(dialog).getByLabelText(copy.LABEL), {
      target: { value: "Weekend chores" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: copy.CREATE_SOURCE }),
    );
    expect(
      await within(dialog).findByText(copy.TIMEZONE_INVALID),
    ).toBeInTheDocument();
    // The entered text is kept.
    expect(within(dialog).getByLabelText(copy.LABEL)).toHaveValue(
      "Weekend chores",
    );
    fireEvent.change(within(dialog).getByLabelText(copy.TIMEZONE), {
      target: { value: "Europe/London" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: copy.CREATE_SOURCE }),
    );
    await w.settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const stored = drafts(w);
    expect(stored).toHaveLength(1);
    const draft = stored[0] as DraftRow;
    expect(draft).toMatchObject({
      endpoint: "/calendar-commands",
      kind: "create_source",
      status: "queued",
      target_id: null,
    });
    const body = bodyOf(w, draft.local_id) as {
      command: Record<string, unknown>;
    };
    expect(body).toEqual({
      command: {
        kind: "create_source",
        id: draft.target_resource_ids[0],
        label: "Weekend chores",
        timezone: "Europe/London",
      },
    });
    // Nothing was sent: queued drafts are the dispatcher's (a leader), never this screen's.
    expect(w.calls.filter((c) => c.method === "POST")).toEqual([]);
    await w.settle();
    const pending = await screen.findByText("Weekend chores");
    expect(pending.closest("li")).toHaveTextContent(copy.PENDING_OFFLINE);
    expect(screen.getByText(copy.WAITING_GROUP)).toBeInTheDocument();
    const refresh = within(pending.closest("li") as HTMLElement).getByRole(
      "button",
      { name: /Refresh/ },
    );
    expect(reasonOf(refresh)).toBe(copy.NOT_CREATED_REASON);
  });

  test("online, the pending row says it is sending; a create whose source the cache now holds is listed once, from the cache", async () => {
    const create = draftRow({
      local_id: "create-1",
      created_seq: 1,
      endpoint: "/calendar-commands",
      command: {
        command: {
          kind: "create_source",
          id: SOURCE,
          label: "Family calendar",
          timezone: "UTC",
        },
      },
      target_resource_ids: [SOURCE],
      index_targets: [SOURCE],
      status: "acknowledged",
      held_pending_cache: true,
    });
    const other = draftRow({
      local_id: "create-2",
      created_seq: 2,
      endpoint: "/calendar-commands",
      command: {
        command: {
          kind: "create_source",
          id: "00000000-0000-4000-8000-0000000000b2",
          label: "Gym",
          timezone: "UTC",
        },
      },
      target_resource_ids: ["00000000-0000-4000-8000-0000000000b2"],
      index_targets: ["00000000-0000-4000-8000-0000000000b2"],
    });
    await calendarWorld({ cache: [sourceRow()], drafts: [create, other] });
    await screen.findByText("Gym");
    expect(screen.getAllByText("Family calendar")).toHaveLength(1);
    expect(screen.getByText("Gym").closest("li")).toHaveTextContent(
      copy.PENDING_ONLINE,
    );
  });
});

describe("Manage: queued settings (D-13a-8, D-13a-12)", () => {
  test("Save queues a configure built on the outbox's base, with timezone and enabled only; the row then says it is queued", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage Family calendar" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: copy.manageTitle("Family calendar"),
    });
    // Adapted (WEB-13a revision 1, R5): Save waits until the source's waiting changes have been read (it restates the newest one), so
    // the dialog is settled before Save is pressed; the assertions are unchanged.
    await w.settle();
    expect(within(dialog).getByText(copy.LABEL_READ_ONLY)).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("textbox", { name: copy.LABEL }),
    ).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(copy.TIMEZONE), {
      target: { value: "Europe/London" },
    });
    fireEvent.click(within(dialog).getByLabelText(copy.ENABLED));
    fireEvent.click(within(dialog).getByRole("button", { name: copy.SAVE }));
    await w.settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [draft] = drafts(w);
    expect(draft).toMatchObject({
      kind: "configure_source",
      expected_version: 3,
      status: "queued",
    });
    expect(bodyOf(w, (draft as DraftRow).local_id)).toEqual({
      command: {
        kind: "configure_source",
        id: SOURCE,
        expected_version: 3,
        timezone: "Europe/London",
        enabled: false,
      },
    });
    await w.settle();
    const item = screen
      .getByText("Family calendar")
      .closest("li") as HTMLElement;
    expect(item).toHaveTextContent(copy.QUEUED);
    // The overlay shows the change at once: turned off.
    expect(item).toHaveTextContent(copy.TURNED_OFF);
    // A queued change blocks the online connection changes until it is sent or discarded.
    fireEvent.click(within(item).getByRole("button", { name: /Manage/ }));
    const again = await screen.findByRole("dialog");
    await w.settle();
    expect(
      reasonOf(within(again).getByRole("button", { name: copy.REPLACE })),
    ).toBe(copy.WAITING_CHANGES_FIRST);
  });

  test("a version conflict offers Review, and Save there REPLACES the conflicted draft (supersede), never adds another", async () => {
    const conflicted = draftRow({
      local_id: "conflicted",
      created_seq: 1,
      endpoint: "/calendar-commands",
      command: {
        command: {
          kind: "configure_source",
          id: SOURCE,
          expected_version: 2,
          timezone: "UTC",
          enabled: true,
        },
      },
      target_resource_ids: [SOURCE],
      index_targets: [SOURCE],
      bases: { [SOURCE]: 2 },
      bumped: [SOURCE],
      expected_version: 2,
      status: "version_conflict",
    });
    const w = await calendarWorld({
      cache: [sourceRow()],
      drafts: [conflicted],
    });
    const item = (await screen.findByText("Family calendar")).closest(
      "li",
    ) as HTMLElement;
    await waitFor(() => expect(item).toHaveTextContent(copy.NEEDS_DECISION));
    fireEvent.click(within(item).getByRole("button", { name: copy.REVIEW }));
    const dialog = await screen.findByRole("dialog");
    // Adapted (WEB-13a revision 1, R5): Save waits until the source's waiting changes have been read (it restates the newest one), so
    // the dialog is settled before Save is pressed; the assertions are unchanged.
    await w.settle();
    fireEvent.change(within(dialog).getByLabelText(copy.TIMEZONE), {
      target: { value: "Asia/Tokyo" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: copy.SAVE }));
    await w.settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const rows = drafts(w);
    expect(rows.find((d) => d.local_id === "conflicted")).toBeUndefined();
    expect(rows.filter((d) => d.kind === "configure_source")).toHaveLength(1);
  });

  test("a refused save offers Discard (D-13a-12); a 403 refusal says only the owner can change the settings (D-13a-11)", async () => {
    const rejected = draftRow({
      local_id: "rejected",
      created_seq: 1,
      endpoint: "/calendar-commands",
      command: {
        command: {
          kind: "configure_source",
          id: SOURCE,
          expected_version: 3,
          timezone: "UTC",
          enabled: true,
        },
      },
      target_resource_ids: [SOURCE],
      index_targets: [SOURCE],
      status: "rejected",
      last_error: { status: 403, code: "forbidden", stage: "rejected" },
    });
    const w = await calendarWorld({ cache: [sourceRow()], drafts: [rejected] });
    const item = (await screen.findByText("Family calendar")).closest(
      "li",
    ) as HTMLElement;
    await waitFor(() => expect(item).toHaveTextContent(copy.OWNER_ONLY));
    fireEvent.click(within(item).getByRole("button", { name: copy.DISCARD }));
    await w.settle();
    await waitFor(() =>
      expect(
        drafts(w).find((d) => d.local_id === "rejected")?.status ?? "gone",
      ).not.toBe("rejected"),
    );
  });
});

describe("Refresh (online-only, never queued)", () => {
  test("a press sends POST /calendar-sources/{id}/refresh with a fresh key and stores nothing; success says new events follow the next sync", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const before = JSON.stringify(w.snapshot());
    fireEvent.click(
      await screen.findByRole("button", { name: "Refresh Family calendar" }),
    );
    await w.settle();
    const refreshes = w.calls.filter(
      (c) => c.path === "/calendar-sources/{id}/refresh",
    );
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({
      method: "POST",
      id: SOURCE,
      body: undefined,
    });
    expect(refreshes[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(copy.REFRESHED)).toBeInTheDocument();
    expect(JSON.stringify(w.snapshot())).toBe(before);
  });

  test.each([
    [
      422,
      "connection_unavailable",
      copy.CAUSE_CONNECTION,
      copy.UPDATE_CONNECTION,
    ],
    [503, "integration_unconfigured", copy.CAUSE_UNCONFIGURED, null],
    [422, "invalid_value", copy.CAUSE_TURNED_OFF, copy.TURN_ON],
    [404, "not_found", copy.CAUSE_UNAVAILABLE, null],
  ])(
    "%s %s: the cause's words and action, with no automatic retry",
    async (status, code, words, action) => {
      const w = await calendarWorld({ cache: [sourceRow()] });
      w.replies.set("/calendar-sources/{id}/refresh", [
        { status, json: atlasBody(code) },
      ]);
      fireEvent.click(
        await screen.findByRole("button", { name: "Refresh Family calendar" }),
      );
      await w.settle();
      expect(await screen.findByText(words)).toBeInTheDocument();
      if (action) expect(button(action)).toBeInTheDocument();
      expect(
        w.calls.filter((c) => c.path === "/calendar-sources/{id}/refresh"),
      ).toHaveLength(1);
    },
  );

  test("cause 1's 'Update connection' opens Manage with Replace… open and its fields EMPTY", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    w.replies.set("/calendar-sources/{id}/refresh", [
      { status: 422, json: atlasBody("connection_unavailable") },
    ]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Refresh Family calendar" }),
    );
    await w.settle();
    fireEvent.click(
      await screen.findByRole("button", { name: copy.UPDATE_CONNECTION }),
    );
    const dialog = await screen.findByRole("dialog");
    const url = within(dialog).getByLabelText(copy.URL_LABEL);
    expect(url).toHaveValue("");
    expect(within(dialog).getByLabelText(copy.BEARER_LABEL)).toHaveValue("");
  });

  test("going offline mid-retry stops the run and nothing is sent when the page comes back online", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const w = await calendarWorld({ cache: [sourceRow()] });
      w.replies.set("/calendar-sources/{id}/refresh", [
        { status: 502, json: atlasBody("fetch_failed") },
      ]);
      fireEvent.click(
        await screen.findByRole("button", { name: "Refresh Family calendar" }),
      );
      await w.settle();
      await act(async () => w.online.set(false));
      expect(
        await screen.findAllByText(copy.NEEDS_CONNECTION),
      ).not.toHaveLength(0);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await act(async () => w.online.set(true));
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await w.settle();
      expect(
        w.calls.filter((c) => c.path === "/calendar-sources/{id}/refresh"),
      ).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

describe("the queue's descriptions (/sync)", () => {
  test("the registered descriptions are content-free", async () => {
    const w = await calendarWorld();
    const describe = (command: unknown) =>
      w.env.commands.describe(
        draftRow({ endpoint: "/calendar-commands", command: command as never }),
      );
    expect(
      describe({
        command: {
          kind: "create_source",
          id: SOURCE,
          label: "Private",
          timezone: "UTC",
        },
      }),
    ).toBe(copy.DESCRIBE_CREATE);
    expect(
      describe({ command: { kind: "configure_source", id: SOURCE } }),
    ).toBe(copy.DESCRIBE_CONFIGURE);
  });
});

describe("identity (C8)", () => {
  test("another account displayed: A's sources leave the screen, A's refresh retry is never sent, and nothing is sent under B for A", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const w = await calendarWorld({ cache: [sourceRow()] });
      w.replies.set("/calendar-sources/{id}/refresh", [
        { status: 409, json: atlasBody("refresh_in_progress") },
      ]);
      fireEvent.click(
        await screen.findByRole("button", { name: "Refresh Family calendar" }),
      );
      await w.settle();
      expect(
        w.calls.filter((c) => c.path === "/calendar-sources/{id}/refresh"),
      ).toHaveLength(1);
      await act(async () =>
        w.identity.set({
          account_id: "22222222-2222-4222-8222-222222222222",
          epoch: 1,
          session_id: "s2",
        }),
      );
      await w.settle();
      await waitFor(() =>
        expect(screen.queryByText("Family calendar")).toBeNull(),
      );
      await act(async () => {
        vi.advanceTimersByTime(70_000);
      });
      await w.settle();
      expect(
        w.calls.filter((c) => c.path === "/calendar-sources/{id}/refresh"),
      ).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

const polite = () =>
  document.querySelector('[aria-live="polite"]')?.textContent ?? "";
async function openManage(w: Awaited<ReturnType<typeof calendarWorld>>) {
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage Family calendar" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: copy.manageTitle("Family calendar"),
  });
  await w.settle();
  return dialog;
}
const syncState = (w: Awaited<ReturnType<typeof calendarWorld>>) =>
  (w.snapshot()?.sync_state?.[0] ?? {}) as Record<string, unknown>;

/**
 * Revision 1 (R2): an open Manage is cache content like the row it was opened from. It is shown only while the list could show it:
 * when the cache is being brought up to date, or the source leaves the cache, Manage closes (with the connection panel inside it) and
 * says why, and nothing it showed stays on screen. Offline with a valid cache it stays, and it follows a newer version of its source.
 */
describe("an open Manage shows only what the list could show (revision 1, R2)", () => {
  test.each([
    ["invalid", 1],
    ["unverified", 0],
  ])(
    "the cache becomes %s: Manage closes (an open Remove… with it), says why, and its source is nowhere on screen until the cache is valid",
    async (status, generation) => {
      const w = await calendarWorld({ cache: [sourceRow()] });
      const dialog = await openManage(w);
      fireEvent.click(
        within(dialog).getByRole("button", { name: copy.REMOVE }),
      );
      expect(within(dialog).getByText(copy.REMOVE_CONFIRM)).toBeVisible();
      const valid = syncState(w);
      await w.commit({
        put: {
          store: "sync_state",
          rows: [
            {
              ...valid,
              cache_status: status,
              recovery_generation:
                Number(valid.recovery_generation ?? 0) + generation,
            },
          ],
        },
      });
      expect(
        document.querySelector('[data-cache-gate="refreshing"]'),
      ).not.toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText("Family calendar")).toBeNull();
      expect(document.body.textContent).not.toContain("Europe/Vienna");
      await waitFor(() => expect(polite()).toBe(copy.MANAGE_CLOSED_REFRESHING));
      expect(w.calls.filter((c) => c.path === "/calendar-commands")).toEqual(
        [],
      );
      // The cache is valid again: the list shows the source; Manage stays closed until it is opened again.
      await w.commit({ put: { store: "sync_state", rows: [valid] } });
      expect(await screen.findByText("Family calendar")).toBeVisible();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  test("the source leaves the cache (removed, or access to it was): Manage closes and does not fall back to the row it was opened with", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    await openManage(w);
    await w.commit({ remove: [SOURCE] });
    expect(document.querySelector("[data-source-row]")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Family calendar")).toBeNull();
    await waitFor(() => expect(polite()).toBe(copy.MANAGE_CLOSED_GONE));
  });

  test("controls: offline with a valid cache Manage stays open and can save; a newer version of the source keeps it open with the new values", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await openManage(w);
    act(() => w.online.set(false));
    await w.settle();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByText("Family calendar")).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: copy.SAVE }),
    ).toBeEnabled();
    await w.commit({
      put: {
        store: "cache",
        rows: [
          sourceRow({
            version: 4,
            value: { ...sourceRow().value, timezone: "UTC" },
          }),
        ],
      },
    });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByLabelText(copy.TIMEZONE)).toHaveValue("UTC");
  });
});

/**
 * Revision 1 (R3): "Check again" starts a request exactly as Refresh does, so it is offered exactly when Refresh would be, with the
 * same reason beside it when it is not, and it keeps the run's key. The production schedule runs in full (5 + 10 + 20 + 30 s), on fake
 * timers.
 */
describe("Check again (revision 1, R3)", () => {
  const refreshes = (w: Awaited<ReturnType<typeof calendarWorld>>) =>
    w.calls.filter((c) => c.path === "/calendar-sources/{id}/refresh");

  async function stillRefreshing(w: Awaited<ReturnType<typeof calendarWorld>>) {
    w.replies.set(
      "/calendar-sources/{id}/refresh",
      Array.from({ length: 5 }, () => ({
        status: 409,
        json: atlasBody("refresh_in_progress"),
      })),
    );
    // Only the refresh schedule's timers are faked: the database double is driven by `setImmediate`, which stays real (a faked one
    // that was still pending when the real timers returned would be dropped, and the double would never be driven again).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(button("Refresh Family calendar"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(65_000);
      });
    } finally {
      vi.useRealTimers();
    }
    await w.settle();
    expect(refreshes(w)).toHaveLength(5);
    return screen.getByRole("button", { name: copy.CHECK_AGAIN });
  }

  test("offline: unavailable with Refresh's reason and nothing is sent; online again, it resends under the run's key", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    expect(await stillRefreshing(w)).toBeEnabled();
    act(() => w.online.set(false));
    await w.settle();
    const offline = button(copy.CHECK_AGAIN);
    expect(offline).toBeDisabled();
    expect(reasonOf(offline)).toBe(copy.NEEDS_CONNECTION);
    fireEvent.click(offline);
    await w.settle();
    expect(refreshes(w)).toHaveLength(5);
    act(() => w.online.set(true));
    await w.settle();
    expect(refreshes(w)).toHaveLength(5);
    fireEvent.click(button(copy.CHECK_AGAIN));
    await w.settle();
    expect(refreshes(w)).toHaveLength(6);
    expect(new Set(refreshes(w).map((c) => c.key)).size).toBe(1);
  });

  test.each([
    ["turned off", { archived: true }, copy.TURNED_OFF_REASON],
    ["made view-only", { can_edit: false }, copy.VIEW_ONLY_REASON],
  ])(
    "the source is %s meanwhile: unavailable with that reason, and nothing is sent",
    async (_case, change, reason) => {
      const w = await calendarWorld({ cache: [sourceRow()] });
      await stillRefreshing(w);
      await w.commit({
        put: { store: "cache", rows: [sourceRow({ version: 4, ...change })] },
      });
      const check = button(copy.CHECK_AGAIN);
      expect(check).toBeDisabled();
      expect(reasonOf(check)).toBe(reason);
      fireEvent.click(check);
      await w.settle();
      expect(refreshes(w)).toHaveLength(5);
    },
  );
});

/**
 * Revision 1 (R5, found while correcting R2): Manage starts from the values the person last asked for, the newest waiting settings
 * change over the cached row (as the row shows them). A second change made before the first is sent restates the first's values instead
 * of reverting them, and saving the waiting values again changes nothing.
 */
describe("a second settings change keeps the first one's values (revision 1, R5)", () => {
  const configureBodies = (w: Awaited<ReturnType<typeof calendarWorld>>) =>
    [...drafts(w)]
      .sort((a, b) => a.created_seq - b.created_seq)
      .map(
        (d) =>
          (bodyOf(w, d.local_id) as { command: Record<string, unknown> })
            .command,
      );

  test("offline: a timezone change waits; Manage opens with it; turning the source off then keeps that timezone", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    let dialog = await openManage(w);
    expect(within(dialog).getByLabelText(copy.TIMEZONE)).toHaveValue(
      "Europe/Vienna",
    );
    fireEvent.change(within(dialog).getByLabelText(copy.TIMEZONE), {
      target: { value: "UTC" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: copy.SAVE }));
    await w.settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    dialog = await openManage(w);
    expect(within(dialog).getByLabelText(copy.TIMEZONE)).toHaveValue("UTC");
    expect(within(dialog).getByLabelText(copy.ENABLED)).toBeChecked();
    fireEvent.click(within(dialog).getByLabelText(copy.ENABLED));
    fireEvent.click(within(dialog).getByRole("button", { name: copy.SAVE }));
    await w.settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(configureBodies(w)).toEqual([
      expect.objectContaining({ timezone: "UTC", enabled: true }),
      expect.objectContaining({ timezone: "UTC", enabled: false }),
    ]);
  });

  test("saving the values that are already waiting is Nothing to save, and queues nothing", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    let dialog = await openManage(w);
    fireEvent.change(within(dialog).getByLabelText(copy.TIMEZONE), {
      target: { value: "UTC" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: copy.SAVE }));
    await w.settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    dialog = await openManage(w);
    fireEvent.click(within(dialog).getByRole("button", { name: copy.SAVE }));
    await w.settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(polite()).toBe(copy.NOTHING_CHANGED));
    expect(drafts(w)).toHaveLength(1);
  });
});
