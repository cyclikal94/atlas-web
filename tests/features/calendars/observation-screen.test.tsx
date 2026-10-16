import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as copy from "../../../src/features/calendars/copy";
import {
  OBSERVE_LIMIT_MS,
  OBSERVE_POLL_MS,
} from "../../../src/features/calendars/model/observation";
import { installMatchMedia } from "../../helpers/match-media";
import {
  atlasBody,
  calendarWorld,
  sourceRow,
  type WireReply,
} from "../../support/calendars";
import { draftRow } from "../../support/data/rows";

/**
 * Revision 4 (R10, D-13a-13): when the Calendars screen opens (a reload, another tab, a return to the screen), it reads the live list
 * for the sources it shows and says "Refreshing…" while a refresh holds a source's lease, then shows the synced history again. Through
 * the PRODUCTION screen, controllers and status over the double of IndexedDB, with a recorded typed client. What is asserted beyond the
 * row: every request (an observation makes only `GET /calendar-sources`, never a refresh, a command or a key), the stored data (nothing
 * written), the enablement of Refresh and its reason, "Check again" (never offered for an observation) and the announcements.
 *
 * The 5 s pace and the 75 s limit are the production ones, on fake timers (`setTimeout` and the monotonic clock only; the database
 * double is driven by `setImmediate`, which stays real).
 */
installMatchMedia({ width: 1440 });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

type World = Awaited<ReturnType<typeof calendarWorld>>;
const SOURCE = "00000000-0000-4000-8000-0000000000a1";
const live = (
  flag: boolean,
  over: Record<string, unknown> = {},
): WireReply => ({
  status: 200,
  json: {
    items: [
      {
        id: SOURCE,
        kind: "calendar_source",
        parent_id: null,
        label: "Family calendar",
        value: {
          health: "healthy",
          last_success: 1_790_000_000,
          timezone: "Europe/Vienna",
          refresh_in_progress: flag,
        },
        version: 3,
        can_edit: true,
        archived: false,
        ...over,
      },
    ],
    next_after: null,
  },
});
const reads = (w: World) =>
  w.calls.filter((c) => c.method === "GET" && c.path === "/calendar-sources");
const sends = (w: World) => w.calls.filter((c) => c.method === "POST");
const row = () =>
  document.querySelector(`[data-source-row="${SOURCE}"]`) as HTMLElement;
const observed = () => row().querySelector("[data-observed]");
const refreshButton = () =>
  within(row()).getByRole("button", { name: "Refresh Family calendar" });
const reasonOf = (element: HTMLElement) =>
  document.getElementById(element.getAttribute("aria-describedby") ?? "")
    ?.textContent;
const polite = () =>
  document.querySelector('[aria-live="polite"]')?.textContent ?? "";
const fake = () =>
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setTimeout", "clearTimeout"],
  });
const elapse = async (w: World, ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await w.settle();
};
/** A reply held until the test releases it. */
function held() {
  let release: (reply: WireReply) => void = () => undefined;
  const wait = new Promise<WireReply>((resolve) => {
    release = resolve;
  });
  return { reply: { wait } as WireReply, release };
}

describe("a refresh running when the screen opens (S1, S2, S3)", () => {
  test("it says Refreshing… and holds Refresh back, with no Check again; once a read shows it idle the history returns: no success claimed, nothing sent or stored", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [live(true), live(true), live(false)]]],
    });
    const before = JSON.stringify(w.snapshot());
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(observed()).toHaveTextContent(copy.REFRESHING);
    expect(refreshButton()).toBeDisabled();
    expect(reasonOf(refreshButton())).toBe(copy.REFRESHING_REASON);
    expect(
      within(row()).queryByRole("button", { name: copy.CHECK_AGAIN }),
    ).toBeNull();
    await waitFor(() =>
      expect(polite()).toBe(`Family calendar: ${copy.REFRESHING}`),
    );
    // History stays: the row's synced health is still shown.
    expect(row()).toHaveTextContent(/Last success/);
    expect(reads(w)).toHaveLength(1);
    await elapse(w, OBSERVE_POLL_MS);
    expect(reads(w)).toHaveLength(2);
    expect(row().dataset.observation).toBe("busy");
    await elapse(w, OBSERVE_POLL_MS);
    expect(reads(w)).toHaveLength(3);
    await waitFor(() => expect(row().dataset.observation).toBe("idle"));
    expect(observed()).toBeNull();
    expect(refreshButton()).toBeEnabled();
    expect(row()).not.toHaveTextContent(copy.REFRESHED);
    expect(row()).toHaveTextContent(/Last success/);
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(3);
    expect(sends(w)).toEqual([]);
    // Every read was a plain list read: no key, no body.
    expect(reads(w).every((c) => c.key === undefined)).toBe(true);
    expect(JSON.stringify(w.snapshot())).toBe(before);
  });

  test("S4 control: idle when the screen opens: one read, nothing said or announced, Refresh available", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [live(false)]]],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("idle"));
    expect(observed()).toBeNull();
    expect(refreshButton()).toBeEnabled();
    expect(polite()).not.toContain(copy.REFRESHING);
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(1);
    expect(sends(w)).toEqual([]);
  });

  test("S5: a list without the source: unknown, nothing said, Refresh available, nothing more read", async () => {
    fake();
    const w = await calendarWorld({ cache: [sourceRow()] });
    await waitFor(() => expect(row().dataset.observation).toBe("unknown"));
    expect(observed()).toBeNull();
    expect(refreshButton()).toBeEnabled();
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(1);
  });

  test("S6/S14: seen running, then a failed read: it says it could not check (no Check again), Refresh is available again, nothing is retried", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [
        [
          "/calendar-sources",
          [live(true), { status: 503, json: atlasBody("unavailable") }],
        ],
      ],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    await elapse(w, OBSERVE_POLL_MS);
    await waitFor(() => expect(row().dataset.observation).toBe("unconfirmed"));
    expect(observed()).toHaveTextContent(copy.OBSERVED_UNCONFIRMED);
    expect(row()).not.toHaveTextContent(copy.REFRESHING);
    expect(refreshButton()).toBeEnabled();
    expect(
      within(row()).queryByRole("button", { name: copy.CHECK_AGAIN }),
    ).toBeNull();
    await waitFor(() =>
      expect(polite()).toBe(`Family calendar: ${copy.OBSERVED_UNCONFIRMED}`),
    );
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(2);
    expect(sends(w)).toEqual([]);
  });

  test("S13: still running at the 75 s limit: it stops reading and says it could not check; Refresh is available again", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [
        ["/calendar-sources", Array.from({ length: 30 }, () => live(true))],
      ],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    for (let t = 0; t < OBSERVE_LIMIT_MS; t += OBSERVE_POLL_MS)
      await elapse(w, OBSERVE_POLL_MS);
    await waitFor(() => expect(row().dataset.observation).toBe("unconfirmed"));
    const count = reads(w).length;
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThanOrEqual(16);
    expect(refreshButton()).toBeEnabled();
    await elapse(w, 2 * OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(count);
    expect(sends(w)).toEqual([]);
  }, 60_000);

  test("S17: a view-only source is observed too (reading is not acting); Refresh stays unavailable for its own reason", async () => {
    fake();
    await calendarWorld({
      cache: [sourceRow({ can_edit: false })],
      replies: [["/calendar-sources", [live(true, { can_edit: false })]]],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(observed()).toHaveTextContent(copy.REFRESHING);
    expect(reasonOf(refreshButton())).toBe(copy.VIEW_ONLY_REASON);
  });
});

describe("a press on this screen while a read is out (S9)", () => {
  test("the press's own outcome is shown; the earlier read, answered busy afterwards, changes nothing; one POST in all", async () => {
    fake();
    const hold = held();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [hold.reply]]],
    });
    expect(row().dataset.observation).toBe("checking");
    expect(refreshButton()).toBeEnabled();
    fireEvent.click(refreshButton());
    await w.settle();
    expect(await screen.findByText(copy.REFRESHED)).toBeInTheDocument();
    expect(row().dataset.observation).toBe("none");
    hold.release(live(true) as never);
    await w.settle();
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(row().dataset.observation).toBe("none");
    expect(observed()).toBeNull();
    expect(row()).toHaveTextContent(copy.REFRESHED);
    expect(refreshButton()).toBeEnabled();
    expect(sends(w)).toHaveLength(1);
    expect(reads(w)).toHaveLength(1);
  });

  test("control: the same held read, no press: its busy answer is shown", async () => {
    fake();
    const hold = held();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [hold.reply, live(false)]]],
    });
    hold.release(live(true) as never);
    await w.settle();
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(observed()).toHaveTextContent(copy.REFRESHING);
  });
});

describe("Link's Check beside the observation (S15)", () => {
  test("the screen's read held while Link's Check reads the list: each consumer gets its own answer; neither ends or takes the other's", async () => {
    fake();
    const hold = held();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [
        ["/calendar-sources", [hold.reply]],
        ["/calendar-commands", [{ throws: new TypeError("Failed to fetch") }]],
      ],
    });
    expect(row().dataset.observation).toBe("checking");
    fireEvent.click(screen.getByRole("button", { name: copy.LINK_CALENDAR }));
    const dialog = await screen.findByRole("dialog", { name: copy.LINK_TITLE });
    const field = (label: string) => within(dialog).getByLabelText(label);
    fireEvent.change(field(copy.LABEL), { target: { value: "Work rota" } });
    fireEvent.change(field(copy.TIMEZONE), { target: { value: "UTC" } });
    fireEvent.change(field(copy.URL_LABEL), {
      target: { value: "https://calendar.example/feed.ics" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: copy.CONNECT }));
    await w.settle();
    expect(within(dialog).queryByText(copy.SAVE_FAILED)).not.toBeNull();
    const sent = (
      w.calls.find((c) => c.path === "/calendar-commands")?.body as {
        command?: { id?: string };
      }
    )?.command?.id;
    w.replies.get("/calendar-sources")?.push({
      status: 200,
      json: {
        items: [
          {
            id: sent,
            kind: "calendar_source",
            value: { health: "pending", refresh_in_progress: false },
          },
        ],
        next_after: null,
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: copy.CHECK }));
    await w.settle();
    // Link's Check found its source: the Link closes as linked, while the screen's own read is still out.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(row().dataset.observation).toBe("checking");
    hold.release(live(true) as never);
    await w.settle();
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(reads(w)).toHaveLength(2);
    expect(w.calls.filter((c) => c.path === "/calendar-commands")).toHaveLength(
      1,
    );
    expect(
      w.calls.filter((c) => c.path === "/calendar-sources/{id}/refresh"),
    ).toEqual([]);
  });
});

describe("offline, compatibility, identity, the cache and the list (S10, S11, S12, S17)", () => {
  test("S11: offline when the screen opens: nothing is read, then or after coming back online", async () => {
    fake();
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    expect(row().dataset.observation).toBe("ended");
    act(() => w.online.set(true));
    await w.settle();
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toEqual([]);
    expect(row().dataset.observation).toBe("ended");
    expect(sends(w)).toEqual([]);
  });

  test("S11: offline while running is observed: Refreshing… goes, the read out is dropped, and coming back online reads nothing", async () => {
    fake();
    const hold = held();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [live(true), hold.reply]]],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    await elapse(w, OBSERVE_POLL_MS);
    expect(reads(w)).toHaveLength(2);
    act(() => w.online.set(false));
    await w.settle();
    expect(row().dataset.observation).toBe("ended");
    expect(observed()).toBeNull();
    hold.release(live(true) as never);
    act(() => w.online.set(true));
    await w.settle();
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(2);
    expect(observed()).toBeNull();
    expect(sends(w)).toEqual([]);
  });

  test("S17: the server not yet known compatible: nothing is read until it is", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      compat: { status: "unknown" },
      replies: [["/calendar-sources", [live(true)]]],
    });
    expect(reads(w)).toEqual([]);
    expect(row().dataset.observation).toBe("checking");
    act(() => w.compat.set({ status: "supported", version: "0.27.0" }));
    await w.settle();
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(reads(w)).toHaveLength(1);
  });

  test("S12: another identity while a read is out: nothing is shown for the old sources, nothing is read for them again", async () => {
    fake();
    const hold = held();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [hold.reply]]],
    });
    await act(async () =>
      w.identity.set({
        account_id: "22222222-2222-4222-8222-222222222222",
        epoch: 1,
        session_id: "s2",
      }),
    );
    await w.settle();
    hold.release(live(true) as never);
    await w.settle();
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(screen.queryByText(copy.REFRESHING)).toBeNull();
    expect(reads(w)).toHaveLength(1);
    expect(sends(w)).toEqual([]);
  });

  test("the cache gate closes: the observation goes with the row; valid again, the source is read afresh (never a replay: no POST)", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [live(true), live(true)]]],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    const valid = (w.snapshot()?.sync_state?.[0] ?? {}) as Record<
      string,
      unknown
    >;
    await w.commit({
      put: {
        store: "sync_state",
        rows: [
          {
            ...valid,
            cache_status: "invalid",
            recovery_generation: Number(valid.recovery_generation ?? 0) + 1,
          },
        ],
      },
    });
    expect(document.querySelector("[data-source-row]")).toBeNull();
    expect(screen.queryByText(copy.REFRESHING)).toBeNull();
    await w.commit({ put: { store: "sync_state", rows: [valid] } });
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(reads(w)).toHaveLength(2);
    expect(sends(w)).toEqual([]);
  });

  test("S10: two sources in ONE read; a pending create reads nothing; a source the cache then lists is read with the next walk", async () => {
    fake();
    const second = "00000000-0000-4000-8000-0000000000b2";
    const both: WireReply = {
      status: 200,
      json: {
        items: [
          {
            ...(live(true) as { json: { items: object[] } }).json.items[0],
          },
          {
            id: second,
            kind: "calendar_source",
            value: { health: "pending", refresh_in_progress: false },
          },
        ],
        next_after: null,
      },
    };
    const w = await calendarWorld({
      cache: [sourceRow(), sourceRow({ id: second, label: "Second" })],
      replies: [["/calendar-sources", [both]]],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(
      (document.querySelector(`[data-source-row="${second}"]`) as HTMLElement)
        .dataset.observation,
    ).toBe("idle");
    expect(reads(w)).toHaveLength(1);
  });

  test("S10: only a pending create (not in the cache): it is listed as pending and nothing is read", async () => {
    fake();
    const gym = "00000000-0000-4000-8000-0000000000b2";
    const w = await calendarWorld({
      drafts: [
        draftRow({
          local_id: "create-1",
          created_seq: 1,
          endpoint: "/calendar-commands",
          command: {
            command: {
              kind: "create_source",
              id: gym,
              label: "Gym",
              timezone: "UTC",
            },
          },
          target_resource_ids: [gym],
          index_targets: [gym],
        }),
      ],
    });
    await screen.findByText("Gym");
    await elapse(w, OBSERVE_POLL_MS);
    expect(reads(w)).toEqual([]);
    expect(screen.getByText("Gym").closest("li")).not.toHaveTextContent(
      copy.REFRESHING,
    );
  });

  test("no database on this device: nothing is listed and nothing is read", async () => {
    fake();
    const w = await calendarWorld({ database: false });
    await elapse(w, OBSERVE_POLL_MS);
    expect(reads(w)).toEqual([]);
  });
});
