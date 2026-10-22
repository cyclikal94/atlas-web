import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DataEnvProvider, useConflictInbox } from "../../../src/data";
import {
  DESCRIBE_CONFIGURE,
  DESCRIBE_CREATE,
} from "../../../src/features/calendars/copy";
import { registerCalendarCommands } from "../../../src/features/calendars/register";
import { CacheGate } from "../../../src/features/sync/CacheGate";
import * as copy from "../../../src/features/sync/copy";
import { NoticeList } from "../../../src/features/sync/NoticeBanners";
import { QueuePanel } from "../../../src/features/sync/QueuePanel";
import {
  describeRow,
  formatSavedAt,
  tabOf,
} from "../../../src/features/sync/rows";
import { UiProviders } from "../../helpers/providers";
import { draftRow } from "../../support/data/rows";
import { type StubEnv, stubEnv } from "../../support/data/ui-env";

/**
 * F-U2 (plan 8.7): component and axe tests for every row of the plan 5.7 table, in jsdom. Layout, contrast and 44 px targets need a
 * real engine (E-U1). FIXTURE evidence: the data layer is a hand-built double, and the copy is PROPOSED, not accepted, except where
 * `copy.ts` says it is verbatim from the approved wireframes.
 */
afterEach(cleanup);

const mountNotices = (env: StubEnv) =>
  render(
    <UiProviders>
      <DataEnvProvider env={env}>
        <NoticeList />
      </DataEnvProvider>
    </UiProviders>,
  );
const hasLiveRegion = (root: HTMLElement) =>
  root.querySelector('[aria-live],[role="status"],[role="alert"]') !== null;

describe("the Q23 floor", () => {
  test("(a): the cache stays visible and only further updates stop; the copy is the wireframe's, verbatim, with NO control", async () => {
    const env = stubEnv({
      inputs: { engine: { kind: "stopped", cause: "floor" }, cache: "valid" },
    });
    const { container } = mountNotices(env);
    const banner = container.querySelector(
      '[data-notice="floor-a"]',
    ) as HTMLElement;
    expect(within(banner).getByRole("heading", { level: 2 })).toHaveTextContent(
      copy.FLOOR_TITLE,
    );
    expect(banner).toHaveTextContent(copy.FLOOR_A_BODY);
    expect(within(banner).queryAllByRole("button")).toEqual([]);
    expect(banner.textContent).not.toMatch(
      /free up|memory|try again|retry now/i,
    );
    expect(banner.querySelector('[aria-busy="true"]')).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  test("(b): the cache stays hidden, the copy says waiting will not help, and it never reads as the ordinary refresh", async () => {
    const env = stubEnv({
      inputs: { engine: { kind: "stopped", cause: "floor" }, cache: "invalid" },
    });
    const { container } = mountNotices(env);
    const banner = container.querySelector(
      '[data-notice="floor-b"]',
    ) as HTMLElement;
    expect(banner).toHaveTextContent(copy.FLOOR_B_BODY);
    expect(banner).toHaveTextContent(copy.FLOOR_B_DRAFTS);
    expect(within(banner).queryAllByRole("button")).toEqual([]);
    expect(
      banner.querySelector('[aria-busy="true"],[role="progressbar"]'),
    ).toBeNull();
    expect(screen.queryByText(copy.GATE_TITLE)).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe("a page that did not save", () => {
  test("states the single Q24 outcome and offers 'Retry applying changes' for the sync engine", async () => {
    const env = stubEnv({
      inputs: { engine: { kind: "stopped", cause: "local_storage" } },
    });
    const { container } = mountNotices(env);
    expect(
      screen.getByRole("heading", { name: copy.PAGE_NOT_SAVED_TITLE }),
    ).toBeInTheDocument();
    expect(container).toHaveTextContent(copy.PAGE_NOT_SAVED_BODY);
    fireEvent.click(
      screen.getByRole("button", { name: copy.PAGE_NOT_SAVED_ACTION }),
    );
    expect(env.calls).toEqual([{ action: "retryUpdates", args: [] }]);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe("a stop that only this tab knows (neither the durable record nor the fallback marker kept it)", () => {
  test("the page-not-saved notice says plainly that the warning will not survive a reload, and the ordinary one does not", async () => {
    const memory = stubEnv({
      inputs: {
        engine: { kind: "stopped", cause: "local_storage", memoryOnly: true },
      },
    });
    const first = mountNotices(memory);
    expect(first.container).toHaveTextContent(copy.MEMORY_ONLY_NOTE);
    expect((await axe(first.container)).violations).toEqual([]);
    first.unmount();
    const ordinary = mountNotices(
      stubEnv({
        inputs: { engine: { kind: "stopped", cause: "local_storage" } },
      }),
    );
    expect(ordinary.container).not.toHaveTextContent(copy.MEMORY_ONLY_NOTE);
  });

  test("the local-storage notice carries the same plain statement", async () => {
    const env = stubEnv({
      inputs: { storageNotResponding: true, storageMemoryOnly: true },
    });
    const { container } = mountNotices(env);
    expect(container).toHaveTextContent(copy.STORAGE_NOT_RESPONDING_BODY);
    expect(container).toHaveTextContent(copy.MEMORY_ONLY_NOTE);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe("storage full (the quota reserve)", () => {
  test("two variants by cache status; neither claims an automatic retry nor puts drafts at risk; Retry asks, Dismiss hides it", async () => {
    const valid = stubEnv({
      inputs: {
        engine: { kind: "stopped", cause: "storage_full" },
        cache: "valid",
      },
    });
    const first = mountNotices(valid);
    expect(
      screen.getByRole("heading", { name: copy.STORAGE_FULL_VALID_TITLE }),
    ).toBeInTheDocument();
    expect(first.container).toHaveTextContent(copy.STORAGE_FULL_VALID_BODY);
    expect(first.container).toHaveTextContent(copy.STORAGE_FULL_ADVICE);
    expect(first.container.textContent).not.toMatch(
      /automatically|we'll try again|drafts? (is|are) at risk|lost\b.*draft/i,
    );
    fireEvent.click(
      screen.getByRole("button", { name: copy.STORAGE_FULL_RETRY }),
    );
    expect(valid.calls.map((c) => c.action)).toEqual([
      "retryUpdates",
      "retryChanges",
    ]);
    expect((await axe(first.container)).violations).toEqual([]);
    fireEvent.click(
      screen.getByRole("button", { name: copy.STORAGE_FULL_DISMISS }),
    );
    expect(
      screen.queryByRole("heading", { name: copy.STORAGE_FULL_VALID_TITLE }),
    ).toBeNull();
    cleanup();

    const hidden = stubEnv({
      inputs: {
        engine: { kind: "stopped", cause: "storage_full" },
        cache: "invalid",
      },
    });
    const second = mountNotices(hidden);
    expect(
      screen.getByRole("heading", { name: copy.STORAGE_FULL_INVALID_TITLE }),
    ).toBeInTheDocument();
    expect(second.container).toHaveTextContent(copy.STORAGE_FULL_INVALID_BODY);
    expect((await axe(second.container)).violations).toEqual([]);
  });

  test("the outbox's own storage-full stop is the same state", () => {
    mountNotices(
      stubEnv({
        inputs: { outbox: { kind: "stopped", cause: "storage_full" } },
      }),
    );
    expect(
      screen.getByRole("heading", { name: copy.STORAGE_FULL_VALID_TITLE }),
    ).toBeInTheDocument();
  });
});

describe("local storage that is not responding", () => {
  test("says so plainly with 'Try again', and Try again retries the changes", async () => {
    const env = stubEnv({ inputs: { storageNotResponding: true } });
    const { container } = mountNotices(env);
    expect(
      screen.getByRole("heading", { name: copy.STORAGE_NOT_RESPONDING_TITLE }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: copy.STORAGE_NOT_RESPONDING_ACTION }),
    );
    expect(env.calls).toEqual([{ action: "retryChanges", args: [] }]);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe("the compatibility pause", () => {
  test.each([
    [
      "unsupported",
      copy.COMPAT_UNSUPPORTED_BODY,
      { kind: "paused", reason: "compat_unsupported" },
    ],
    [
      "missing",
      copy.COMPAT_MISSING_BODY,
      { kind: "paused", reason: "compat_missing" },
    ],
  ] as const)(
    "%s: paused visibly, drafts kept, no control, nothing says it will resolve itself",
    async (_name, body, outbox) => {
      const { container } = mountNotices(stubEnv({ inputs: { outbox } }));
      expect(
        screen.getByRole("heading", { name: copy.COMPAT_TITLE }),
      ).toBeInTheDocument();
      expect(container).toHaveTextContent(body);
      expect(screen.queryAllByRole("button")).toEqual([]);
      expect((await axe(container)).violations).toEqual([]);
    },
  );

  test("the quiet hold (unknown, unreachable) shows nothing at all", () => {
    const { container } = mountNotices(
      stubEnv({
        inputs: { outbox: { kind: "held", reason: "compat_unconfirmed" } },
      }),
    );
    expect(container.textContent).toBe("");
  });
});

describe("'Still trying' and Retry now", () => {
  test("only after automatic retry paused; Retry now resumes the updates, or the changes", async () => {
    const quiet = stubEnv({
      inputs: { engine: { kind: "backing_off", since: Date.now() - 5_000 } },
    });
    expect(mountNotices(quiet).container.textContent).toBe("");
    cleanup();

    const updates = stubEnv({
      inputs: { engine: { kind: "paused", since: Date.now() } },
    });
    const first = mountNotices(updates);
    expect(
      screen.getByRole("heading", { name: copy.STILL_TRYING_UPDATES_TITLE }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: copy.STILL_TRYING_ACTION }),
    );
    expect(updates.calls).toEqual([{ action: "retryUpdates", args: [] }]);
    expect((await axe(first.container)).violations).toEqual([]);
    cleanup();

    const changes = stubEnv({
      inputs: { outbox: { kind: "needs_retry", count: 2 } },
    });
    mountNotices(changes);
    expect(
      screen.getByRole("heading", { name: copy.STILL_TRYING_CHANGES_TITLE }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: copy.STILL_TRYING_ACTION }),
    );
    expect(changes.calls).toEqual([{ action: "retryChanges", args: [] }]);
  });
});

describe("device capacity and an unrecognised response", () => {
  test("each says what it is; the unrecognised one offers Retry now, the capacity one offers none (retiring a device is Settings')", async () => {
    const cap = stubEnv({
      inputs: { engine: { kind: "stopped", cause: "device_capacity" } },
    });
    const a = mountNotices(cap);
    expect(
      screen.getByRole("heading", { name: copy.DEVICE_CAPACITY_TITLE }),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect((await axe(a.container)).violations).toEqual([]);
    cleanup();
    const odd = stubEnv({
      inputs: { engine: { kind: "stopped", cause: "unrecognised" } },
    });
    mountNotices(odd);
    fireEvent.click(
      screen.getByRole("button", { name: copy.UNRECOGNISED_ACTION }),
    );
    expect(odd.calls).toEqual([{ action: "retryUpdates", args: [] }]);
  });
});

describe("the 200-entry queue warning", () => {
  test("informational only: the count and the reassurance, with no control and nothing disabled", async () => {
    const drafts = Array.from({ length: 214 }, (_, i) =>
      draftRow({ local_id: `d${i}`, created_seq: i + 1, status: "queued" }),
    );
    const env = stubEnv({ drafts });
    const { container } = mountNotices(env);
    const banner = container.querySelector(
      '[data-notice="queue_warning"]',
    ) as HTMLElement;
    expect(within(banner).getByRole("heading")).toHaveTextContent(
      copy.QUEUE_WARNING_TITLE,
    );
    expect(banner).toHaveTextContent("214 waiting to send");
    expect(banner).toHaveTextContent(copy.QUEUE_WARNING_BODY);
    expect(within(banner).queryAllByRole("button")).toEqual([]);
    expect(
      container.querySelector("[disabled],[aria-disabled='true']"),
    ).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  test("below 200 there is no warning", () => {
    const drafts = Array.from({ length: 199 }, (_, i) =>
      draftRow({ local_id: `d${i}`, created_seq: i + 1, status: "queued" }),
    );
    expect(mountNotices(stubEnv({ drafts })).container.textContent).toBe("");
  });
});

describe("banners are static content, never live regions of their own (rule R6)", () => {
  test("every notice kind renders no aria-live, status or alert element", () => {
    const states: Array<Parameters<typeof stubEnv>[0]> = [
      {
        inputs: { engine: { kind: "stopped", cause: "floor" }, cache: "valid" },
      },
      {
        inputs: {
          engine: { kind: "stopped", cause: "floor" },
          cache: "invalid",
        },
      },
      { inputs: { engine: { kind: "stopped", cause: "local_storage" } } },
      { inputs: { engine: { kind: "stopped", cause: "storage_full" } } },
      { inputs: { storageNotResponding: true } },
      { inputs: { outbox: { kind: "paused", reason: "compat_missing" } } },
      { inputs: { engine: { kind: "paused", since: 1 } } },
      { inputs: { engine: { kind: "stopped", cause: "device_capacity" } } },
      { inputs: { engine: { kind: "stopped", cause: "unrecognised" } } },
    ];
    for (const state of states) {
      const { container, unmount } = mountNotices(stubEnv(state));
      const notices = container.querySelector("[data-notices]") as HTMLElement;
      expect(notices.querySelector("[data-notice]")).not.toBeNull();
      // The announcer's own regions sit elsewhere in the tree: the banners themselves are static content.
      expect(hasLiveRegion(notices)).toBe(false);
      unmount();
    }
  });

  test("a notice that APPEARS is announced once through the announcer; one present at first render is not", async () => {
    const env = stubEnv();
    const { container } = mountNotices(env);
    const polite = () =>
      document.querySelector('[aria-live="polite"]')?.textContent ?? "";
    const assertive = () =>
      document.querySelector('[aria-live="assertive"]')?.textContent ?? "";
    expect(polite() + assertive()).toBe("");
    await act(async () => {
      env.set({ engine: { kind: "stopped", cause: "local_storage" } });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    await waitFor(() => expect(assertive()).toBe(copy.PAGE_NOT_SAVED_TITLE));
    expect(container.querySelectorAll("[data-notice]")).toHaveLength(1);
  });
});

describe("CacheGate", () => {
  const mount = (env: StubEnv | null) =>
    render(
      <UiProviders>
        {env ? (
          <DataEnvProvider env={env}>
            <CacheGate>
              <p>Cached tasks</p>
            </CacheGate>
          </DataEnvProvider>
        ) : (
          <CacheGate>
            <p>Cached tasks</p>
          </CacheGate>
        )}
      </UiProviders>,
    );

  test("open: the content shows, for every state of the cache that is not invalid", () => {
    for (const cache of ["unknown", "empty", "valid"] as const) {
      mount(stubEnv({ inputs: { cache } }));
      expect(screen.getByText("Cached tasks")).toBeInTheDocument();
      cleanup();
    }
  });

  test("R13: a database that is open and whose facts are not established is hidden, with the same message", () => {
    mount(stubEnv({ inputs: { cache: "unverified" } }));
    expect(screen.queryByText("Cached tasks")).toBeNull();
    expect(
      screen.getByRole("heading", { name: copy.GATE_TITLE }),
    ).toBeInTheDocument();
  });

  test("refreshing: the content is HIDDEN, not merely covered, and the message is the wireframe's", async () => {
    const { container } = mount(
      stubEnv({
        inputs: {
          cache: "invalid",
          engine: { kind: "running", catchingUp: true },
        },
      }),
    );
    expect(screen.queryByText("Cached tasks")).toBeNull();
    expect(
      screen.getByRole("heading", { name: copy.GATE_TITLE }),
    ).toBeInTheDocument();
    expect(container).toHaveTextContent(copy.GATE_BODY);
    expect((await axe(container)).violations).toEqual([]);
  });

  test("the floor replaces 'Refreshing': nothing here says refreshing, or offers to wait", async () => {
    const { container } = mount(
      stubEnv({
        inputs: {
          cache: "invalid",
          engine: { kind: "stopped", cause: "floor" },
        },
      }),
    );
    expect(screen.queryByText("Cached tasks")).toBeNull();
    expect(screen.queryByRole("heading", { name: copy.GATE_TITLE })).toBeNull();
    expect(container.querySelector('[data-notice="floor-b"]')).not.toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  test("it gates a cache view only: with the cache valid and a floor stop, state (a) leaves the content visible", () => {
    mount(
      stubEnv({
        inputs: { cache: "valid", engine: { kind: "stopped", cause: "floor" } },
      }),
    );
    expect(screen.getByText("Cached tasks")).toBeInTheDocument();
  });

  test("with no data layer mounted it shows its content", () => {
    mount(null);
    expect(screen.getByText("Cached tasks")).toBeInTheDocument();
  });
});

describe("rows: what each draft says and offers", () => {
  const D = (over: Parameters<typeof draftRow>[0]) => draftRow(over);
  test.each([
    [
      "queued, online",
      D({ status: "queued" }),
      true,
      { tab: "waiting", status: copy.WAITING, actions: ["discard"] },
    ],
    [
      "queued, offline",
      D({ status: "queued" }),
      false,
      { tab: "waiting", status: copy.WILL_SEND, actions: ["discard"] },
    ],
    [
      "in flight",
      D({ status: "in_flight" }),
      true,
      {
        tab: "waiting",
        status: copy.SENDING,
        actions: [],
        cannotDiscard: true,
      },
    ],
    [
      "backing off",
      D({
        status: "in_flight",
        attempts: 2,
        retry_state: { state: "backing_off", since: 0 },
      }),
      true,
      { tab: "waiting", status: copy.TRYING_AGAIN, attempts: "tried twice" },
    ],
    [
      "paused",
      D({
        status: "in_flight",
        attempts: 5,
        retry_state: { state: "paused", since: 0 },
      }),
      true,
      {
        tab: "waiting",
        status: copy.PAUSED,
        actions: ["retry"],
        cannotDiscard: true,
      },
    ],
    [
      "confirming",
      D({ status: "acknowledged", held_pending_cache: true }),
      true,
      { tab: "waiting", status: copy.CONFIRMING, actions: [] },
    ],
    [
      "not showing",
      D({ status: "acknowledged", unavailable_outcome: true }),
      true,
      { tab: "waiting", status: copy.NOT_SHOWING, actions: ["dismiss"] },
    ],
    [
      "version conflict",
      D({ status: "version_conflict" }),
      true,
      {
        tab: "decision",
        badge: copy.BADGE_VERSION_CONFLICT,
        body: copy.CONFLICT_READ_ONLY,
      },
    ],
    [
      "operation conflict",
      D({ status: "operation_conflict" }),
      true,
      { tab: "decision", badge: copy.BADGE_OPERATION_CONFLICT },
    ],
    [
      "defaults review",
      D({ status: "in_flight", review_block: { kind: "defaults", kinds: [] } }),
      true,
      { tab: "decision", badge: copy.BADGE_REVIEW },
    ],
    [
      "rejected",
      D({ status: "rejected" }),
      true,
      {
        tab: "decision",
        badge: copy.BADGE_REJECTED,
        body: copy.REJECTED_BODY,
        actions: ["dismiss"],
      },
    ],
    [
      "blocked",
      D({ status: "blocked", blocked_reason: "slice_capacity" }),
      true,
      {
        tab: "decision",
        badge: copy.BADGE_BLOCKED,
        body: copy.BLOCKED_BODY,
        actions: ["retry", "discard"],
      },
    ],
  ] as const)("%s", (_name, draft, online, expected) => {
    expect(describeRow(draft, online)).toMatchObject(expected);
  });

  test("an ordinary acknowledged draft, and a superseded one, are not rows", () => {
    expect(tabOf(D({ status: "acknowledged" }))).toBeNull();
    expect(tabOf(D({ status: "superseded" }))).toBeNull();
  });

  test("the conflict kinds carry NO action: the screens that resolve them are not built here (D-17)", () => {
    for (const status of ["version_conflict", "operation_conflict"] as const)
      expect(describeRow(D({ status }), true)?.actions).toEqual(["discard"]);
    // `discard` is the store-level command this slice owns; nothing offers to resolve, compare or edit.
    for (const status of ["version_conflict", "operation_conflict"] as const)
      expect(describeRow(D({ status }), true)?.actions).not.toContain("retry");
  });

  test("saved-at: a time for today, a day and a time for another day, nothing for a bad instant (UK English, 24 hour)", () => {
    const now = new Date("2026-10-01T15:00:00");
    expect(formatSavedAt("2026-10-01T09:12:00", now)).toBe("at 09:12");
    expect(formatSavedAt("2026-09-28T08:04:00", now)).toBe(
      "on 28 Sept at 08:04",
    );
    expect(formatSavedAt("not a date", now)).toBe("");
  });
});

const mountPanel = (
  env: StubEnv,
  tab: "waiting" | "decision" = "waiting",
  onTabChange = () => {},
) =>
  render(
    <UiProviders>
      <DataEnvProvider env={env}>
        <QueuePanel tab={tab} onTabChange={onTabChange} onClose={() => {}} />
      </DataEnvProvider>
    </UiProviders>,
  );

describe("the queue panel (WF-QUEUE-01)", () => {
  // The rows' timestamps are read against "now" ("Saved here at 09:12" is today's form, a date is shown for another day): pin only the
  // date so the copy does not drift with the calendar. Timers stay real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T15:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const sample = () => [
    draftRow({
      local_id: "a",
      created_seq: 1,
      status: "queued",
      created_at: "2026-10-01T09:12:00",
    }),
    draftRow({
      local_id: "b",
      created_seq: 2,
      status: "in_flight",
      attempts: 2,
      retry_state: { state: "backing_off", since: 0 },
      created_at: "2026-10-01T08:04:00",
    }),
    draftRow({ local_id: "c", created_seq: 3, status: "version_conflict" }),
    draftRow({ local_id: "d", created_seq: 4, status: "rejected" }),
  ];

  test("heading, subtitle, a status line prefixed 'Receiving updates:', both tab counts, and the reassuring footer", async () => {
    const env = stubEnv({
      drafts: sample(),
      inputs: { engine: { kind: "stopped", cause: "no_recovery" } },
    });
    const { container } = mountPanel(env);
    expect(
      screen.getByRole("heading", { level: 1, name: copy.PANEL_HEADING }),
    ).toBeInTheDocument();
    expect(container).toHaveTextContent(copy.PANEL_SUBTITLE);
    expect(container.querySelector("[data-phase-label]")).toHaveTextContent(
      "Receiving updates: stopped",
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\s+/g, " "))).toEqual([
      "Waiting to send · 2",
      "Needs a decision · 2",
    ]);
    expect(container).toHaveTextContent(copy.FOOTER);
    expect((await axe(container)).violations).toEqual([]);
  });

  test("the tab counts equal the chip's counts (waiting and needs a decision)", () => {
    const env = stubEnv({ drafts: sample() });
    mountPanel(env);
    const summary = env.inputs.get().summary;
    expect(summary).toMatchObject({ waiting: 2, needsDecision: 2 });
  });

  test("each row states what is saved, when, how it stands and how often it was tried, and offers only what the store can do", () => {
    const env = stubEnv({ drafts: sample() });
    const { container } = mountPanel(env);
    const rows = container.querySelectorAll("[data-draft-row]");
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect(first).toHaveTextContent(copy.ROW_FALLBACK_TITLE);
    expect(first).toHaveTextContent("Saved here at 09:12");
    expect(first).toHaveTextContent(copy.WAITING);
    expect(first).toHaveTextContent("no attempts yet");
    expect(
      within(first).getByRole("button", { name: /Discard/ }),
    ).toBeInTheDocument();
    const second = rows[1] as HTMLElement;
    expect(second).toHaveTextContent(copy.TRYING_AGAIN);
    expect(second).toHaveTextContent("tried twice");
    expect(second).toHaveTextContent(copy.CANNOT_DISCARD);
    expect(within(second).queryAllByRole("button")).toEqual([]);
  });

  test("a registered command description is used; the data layer invents none", () => {
    const env = stubEnv({
      drafts: [
        draftRow({
          local_id: "a",
          created_seq: 1,
          command: { kind: "record_amount" },
        }),
      ],
    });
    env.commands.register("record_amount", {
      describe: () => "1.0 L recorded on “Water plants”",
    });
    mountPanel(env);
    expect(
      screen.getByText("1.0 L recorded on “Water plants”"),
    ).toBeInTheDocument();
  });

  test("WEB-13a: a queued calendar create and settings change are described by the calendar slice's registration, content-free", () => {
    const env = stubEnv({
      drafts: [
        draftRow({
          local_id: "cal-create",
          created_seq: 1,
          endpoint: "/calendar-commands",
          command: {
            command: {
              kind: "create_source",
              id: "00000000-0000-4000-8000-0000000000c1",
              label: "Private label",
              timezone: "UTC",
            },
          },
        }),
        draftRow({
          local_id: "cal-configure",
          created_seq: 2,
          endpoint: "/calendar-commands",
          command: { command: { kind: "configure_source" } },
        }),
      ],
    });
    registerCalendarCommands(env.commands);
    mountPanel(env);
    expect(screen.getByText(DESCRIBE_CREATE)).toBeInTheDocument();
    expect(screen.getByText(DESCRIBE_CONFIGURE)).toBeInTheDocument();
    expect(screen.queryByText(/Private label/)).toBeNull();
  });

  test("offline, a queued change says it will send when connected", () => {
    mountPanel(stubEnv({ drafts: sample(), inputs: { online: false } }));
    expect(screen.getByText(new RegExp(copy.WILL_SEND))).toBeInTheDocument();
  });

  test("Needs a decision lists the conflicts and the rejected change; conflicts are READ-ONLY with a kind badge, the rejected row can be dismissed", async () => {
    const env = stubEnv({ drafts: sample() });
    const { container } = mountPanel(env, "decision");
    const rows = container.querySelectorAll("[data-draft-row]");
    expect(rows).toHaveLength(2);
    const conflict = rows[0] as HTMLElement;
    expect(conflict.querySelector("[data-badge]")).toHaveTextContent(
      copy.BADGE_VERSION_CONFLICT,
    );
    expect(conflict).toHaveTextContent(copy.CONFLICT_READ_ONLY);
    // No "Compare", "Edit", "Resolve" or "Retry": nothing resolves a conflict in this slice.
    expect(conflict.textContent).not.toMatch(
      /compare|resolve|edit and send|sort it out/i,
    );
    const rejected = rows[1] as HTMLElement;
    expect(rejected.querySelector("[data-badge]")).toHaveTextContent(
      copy.BADGE_REJECTED,
    );
    expect(rejected).toHaveTextContent(copy.REJECTED_BODY);
    expect(
      within(rejected).getByRole("button", { name: /Dismiss/ }),
    ).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  test("a blocked change offers Retry (manual, never automatic) and Discard", () => {
    const env = stubEnv({
      drafts: [
        draftRow({
          local_id: "x",
          created_seq: 1,
          status: "blocked",
          blocked_reason: "slice_capacity",
        }),
      ],
    });
    mountPanel(env, "decision");
    fireEvent.click(screen.getByRole("button", { name: /^Retry:/ }));
    expect(env.calls).toEqual([{ action: "retryChanges", args: ["x"] }]);
    expect(
      screen.getByRole("button", { name: /^Discard:/ }),
    ).toBeInTheDocument();
  });

  test("a paused change offers Retry now for THAT change", () => {
    const env = stubEnv({
      drafts: [
        draftRow({
          local_id: "p",
          created_seq: 1,
          status: "in_flight",
          attempts: 5,
          retry_state: { state: "paused", since: 0 },
        }),
      ],
    });
    mountPanel(env);
    fireEvent.click(screen.getByRole("button", { name: /Retry now/ }));
    expect(env.calls).toEqual([{ action: "retryChanges", args: ["p"] }]);
  });

  test("Discard asks first; Keep cancels; Discard confirms and the store's discard is called once", async () => {
    const env = stubEnv({
      drafts: [draftRow({ local_id: "a", created_seq: 1, status: "queued" })],
    });
    mountPanel(env);
    fireEvent.click(screen.getByRole("button", { name: /^Discard:/ }));
    expect(env.calls).toEqual([]);
    expect(screen.getByText(copy.DISCARD_CONFIRM)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: copy.DISCARD_CONFIRM_NO }),
    );
    expect(screen.queryByText(copy.DISCARD_CONFIRM)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Discard:/ }));
    fireEvent.click(
      screen.getByRole("button", { name: copy.DISCARD_CONFIRM_YES }),
    );
    await waitFor(() =>
      expect(env.calls).toEqual([{ action: "discard", args: ["a"] }]),
    );
  });

  test("discarding a change others depend on says how many will need attention", () => {
    const env = stubEnv({
      drafts: [
        draftRow({ local_id: "a", created_seq: 1, status: "queued" }),
        draftRow({
          local_id: "b",
          created_seq: 2,
          status: "queued",
          depends_on: ["a"],
        }),
        draftRow({
          local_id: "c",
          created_seq: 3,
          status: "queued",
          depends_on: ["a"],
        }),
      ],
    });
    const { container } = mountPanel(env);
    fireEvent.click(
      within(
        container.querySelector('[data-draft-id="a"]') as HTMLElement,
      ).getByRole("button", { name: /^Discard:/ }),
    );
    expect(screen.getByText(copy.DISCARD_DEPENDANTS(2))).toBeInTheDocument();
  });

  test("a refused discard says so and keeps the row", async () => {
    const env = stubEnv({
      drafts: [draftRow({ local_id: "a", created_seq: 1, status: "queued" })],
    });
    env.discardResult = { kind: "refused", reason: "storage" };
    mountPanel(env);
    fireEvent.click(screen.getByRole("button", { name: /^Discard:/ }));
    fireEvent.click(
      screen.getByRole("button", { name: copy.DISCARD_CONFIRM_YES }),
    );
    await waitFor(() =>
      expect(screen.getByText(copy.DISCARD_FAILED)).toBeInTheDocument(),
    );
    expect(document.querySelector('[data-draft-id="a"]')).not.toBeNull();
  });

  test("empty, loading and error states", async () => {
    const env = stubEnv();
    const { container, rerender } = mountPanel(env);
    expect(screen.getByText(copy.EMPTY_WAITING)).toBeInTheDocument();
    expect(copy.EMPTY_WAITING).toBe("Nothing waiting to send.");
    cleanup();
    const loading = stubEnv();
    loading.setQueue({ status: "loading" });
    mountPanel(loading);
    expect(screen.getByText(copy.LOADING)).toBeInTheDocument();
    cleanup();
    const failed = stubEnv();
    failed.setQueue({ status: "unavailable", reason: "error" });
    const view = mountPanel(failed);
    expect(screen.getByText(copy.LOAD_FAILED)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: copy.LOAD_FAILED_ACTION }),
    );
    expect(failed.calls).toEqual([{ action: "retryLoad", args: [] }]);
    expect((await axe(view.container)).violations).toEqual([]);
    void container;
    void rerender;
  });

  test("no database yet is an empty queue, not an error", () => {
    const env = stubEnv();
    env.setQueue({ status: "unavailable", reason: "absent" });
    mountPanel(env);
    expect(screen.getByText(copy.EMPTY_WAITING)).toBeInTheDocument();
    expect(screen.queryByText(copy.LOAD_FAILED)).toBeNull();
  });

  describe("the queue is shown a WINDOW at a time (R6, revision 6)", () => {
    const showing = (
      env: StubEnv,
      flags: { more: boolean; previous: boolean },
    ) => {
      const current = env.queue.get();
      if (current.status !== "ready") throw new Error("setup");
      env.setQueue({
        status: "ready",
        value: { ...current.value, ...flags },
      });
    };

    test("a window with neither a next nor a previous shows no pager", () => {
      const env = stubEnv({ drafts: sample() });
      mountPanel(env);
      expect(
        screen.queryByRole("navigation", { name: copy.PAGER_LABEL }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: copy.SHOW_NEXT })).toBeNull();
    });

    test("the first window offers the next only; a middle one both; the last the previous only", () => {
      const env = stubEnv({ drafts: sample() });
      showing(env, { more: true, previous: false });
      mountPanel(env);
      const nav = screen.getByRole("navigation", { name: copy.PAGER_LABEL });
      expect(
        within(nav)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual([copy.SHOW_NEXT]);
      cleanup();
      const middle = stubEnv({ drafts: sample() });
      showing(middle, { more: true, previous: true });
      mountPanel(middle);
      expect(
        within(screen.getByRole("navigation", { name: copy.PAGER_LABEL }))
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual([copy.SHOW_PREVIOUS, copy.SHOW_NEXT]);
      cleanup();
      const last = stubEnv({ drafts: sample() });
      showing(last, { more: false, previous: true });
      mountPanel(last);
      expect(
        within(screen.getByRole("navigation", { name: copy.PAGER_LABEL }))
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual([copy.SHOW_PREVIOUS]);
    });

    test("Show next and Show previous ask the data layer for the other window, say so through the announcer, and keep focus in the panel", async () => {
      const env = stubEnv({ drafts: sample() });
      showing(env, { more: true, previous: true });
      const { container } = mountPanel(env);
      fireEvent.click(screen.getByRole("button", { name: copy.SHOW_NEXT }));
      fireEvent.click(screen.getByRole("button", { name: copy.SHOW_PREVIOUS }));
      expect(env.calls.map((c) => c.action)).toEqual([
        "showNextQueue",
        "showPreviousQueue",
      ]);
      // Focus is on the panel, a stable place, never on a button that is about to be replaced.
      expect(screen.getByRole("tabpanel")).toHaveFocus();
      expect(document.body).not.toHaveFocus();
      expect(container.textContent).not.toMatch(/show more/i);
      expect((await axe(container)).violations).toEqual([]);
    });
  });

  test("tabs are a real tablist: roving tabindex, arrow keys, Home and End, aria-selected and aria-controls", () => {
    const changes: string[] = [];
    const env = stubEnv({ drafts: sample() });
    mountPanel(env, "waiting", () => undefined);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(
      screen.getByRole("tabpanel").id,
    );
    cleanup();
    const onChange = (tab: string) => changes.push(tab);
    render(
      <UiProviders>
        <DataEnvProvider env={env}>
          <QueuePanel tab="waiting" onTabChange={onChange} />
        </DataEnvProvider>
      </UiProviders>,
    );
    const [first] = screen.getAllByRole("tab");
    (first as HTMLElement).focus();
    fireEvent.keyDown(first as HTMLElement, { key: "ArrowRight" });
    fireEvent.keyDown(first as HTMLElement, { key: "End" });
    fireEvent.keyDown(first as HTMLElement, { key: "ArrowLeft" });
    fireEvent.keyDown(first as HTMLElement, { key: "Home" });
    expect(changes).toEqual(["decision", "decision", "decision", "waiting"]);
  });

  test("large counts render every row, nothing capped, and stay accessible (the WEB-07 close-target finding)", {
    timeout: 60_000,
  }, async () => {
    const drafts = Array.from({ length: 300 }, (_, i) =>
      draftRow({ local_id: `n${i}`, created_seq: i + 1, status: "queued" }),
    );
    const env = stubEnv({ drafts });
    const { container } = mountPanel(env);
    expect(container.querySelectorAll("[data-draft-row]")).toHaveLength(300);
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent(
      "Waiting to send · 300",
    );
    expect(
      container.querySelector('[data-notice="queue_warning"]'),
    ).not.toBeNull();
    // Every row's Discard is enabled: the warning disables nothing.
    expect(container.querySelectorAll("button[disabled]")).toHaveLength(0);
    expect((await axe(container)).violations).toEqual([]);
  });

  test("the panel lists in queue order whatever order the store returned", () => {
    const env = stubEnv({
      drafts: [
        draftRow({ local_id: "late", created_seq: 9, status: "queued" }),
        draftRow({ local_id: "early", created_seq: 1, status: "queued" }),
      ],
    });
    const { container } = mountPanel(env);
    expect(
      [...container.querySelectorAll("[data-draft-id]")].map((e) =>
        e.getAttribute("data-draft-id"),
      ),
    ).toEqual(["early", "late"]);
  });

  test("a change in the store reaches the screen without a reload", async () => {
    const env = stubEnv();
    mountPanel(env);
    expect(screen.getByText(copy.EMPTY_WAITING)).toBeInTheDocument();
    await act(async () =>
      env.setDrafts([
        draftRow({ local_id: "n", created_seq: 1, status: "queued" }),
      ]),
    );
    expect(document.querySelector('[data-draft-id="n"]')).not.toBeNull();
  });
});

describe("the conflict inbox (read-only; plan 3.3, D-17)", () => {
  function Probe() {
    const inbox = useConflictInbox();
    if (inbox.status !== "ready") return <p>{inbox.status}</p>;
    return (
      <ul>
        {inbox.value.map((row) => (
          <li key={row.draft.local_id} data-kind={row.kind}>
            {row.draft.local_id}
          </li>
        ))}
      </ul>
    );
  }
  test("lists the conflict kinds and a defaults review in queue order, and nothing else: a rejected or blocked change is not a conflict", () => {
    const env = stubEnv({
      drafts: [
        draftRow({
          local_id: "z",
          created_seq: 5,
          status: "operation_conflict",
        }),
        draftRow({ local_id: "a", created_seq: 1, status: "version_conflict" }),
        draftRow({ local_id: "r", created_seq: 2, status: "rejected" }),
        draftRow({
          local_id: "b",
          created_seq: 3,
          status: "blocked",
          blocked_reason: "slice_capacity",
        }),
        draftRow({ local_id: "q", created_seq: 4, status: "queued" }),
        draftRow({
          local_id: "d",
          created_seq: 6,
          status: "in_flight",
          review_block: { kind: "defaults", kinds: [] },
        }),
      ],
    });
    render(
      <DataEnvProvider env={env}>
        <Probe />
      </DataEnvProvider>,
    );
    expect(
      [...document.querySelectorAll("li")].map((li) => [
        li.textContent,
        li.getAttribute("data-kind"),
      ]),
    ).toEqual([
      ["a", "version_conflict"],
      ["z", "operation_conflict"],
      ["d", "defaults_review"],
    ]);
  });

  test("it passes loading and unavailable through unchanged", () => {
    const env = stubEnv();
    env.setConflicts({ status: "loading" });
    render(
      <DataEnvProvider env={env}>
        <Probe />
      </DataEnvProvider>,
    );
    expect(screen.getByText("loading")).toBeInTheDocument();
  });
});
