// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  CAUSE_UNCONFIGURED,
  CHECKING_CHANGES,
  COMPAT_PAUSED,
  NEEDS_CONNECTION,
  NEEDS_DATABASE,
  NEEDS_DECISION,
  NOT_CREATED_REASON,
  NOT_REFRESHED_YET,
  OWNER_ONLY,
  PENDING_OFFLINE,
  PENDING_ONLINE,
  QUEUED,
  REFRESHING_REASON,
  REJECTED,
  SAVING,
  TURNED_OFF,
  TURNED_OFF_REASON,
  VIEW_ONLY_REASON,
  WAITING_CHANGES_FIRST,
  WAITING_LAST_CHANGE,
} from "../../../src/features/calendars/copy";
import {
  type Environment,
  formatInstant,
  headerActions,
  manageActions,
  outstandingState,
  pendingStatus,
  sourceStatus,
} from "../../../src/features/calendars/model/status";
import { sourceAuthority } from "../../../src/features/calendars/model/visibility";

/** The single derivation of every calendar row's status and every enablement (WEB-13a), as a table. */
const ONLINE: Environment = {
  online: true,
  compat: "supported",
  hasOutbox: true,
  calendarLinks: true,
};
const OFFLINE: Environment = { ...ONLINE, online: false };
const merged = (over: Record<string, unknown> = {}) => ({
  value: {
    health: "healthy",
    last_success: 1_790_000_000,
    timezone: "Europe/Vienna",
  },
  archived: false,
  can_edit: true,
  ...over,
});
const none = { total: 0, byStatus: {}, latest: null };

describe("the header's entry points", () => {
  test.each<
    [
      string,
      Environment,
      boolean,
      string | undefined,
      boolean,
      string | undefined,
    ]
  >([
    ["online", ONLINE, true, undefined, true, undefined],
    [
      "offline: Add source still queues; Link needs a connection",
      OFFLINE,
      true,
      undefined,
      false,
      NEEDS_CONNECTION,
    ],
    [
      "no database: Add source waits for the first sync; Link works",
      { ...ONLINE, hasOutbox: false },
      false,
      NEEDS_DATABASE,
      true,
      undefined,
    ],
    [
      "calendar_links false",
      { ...ONLINE, calendarLinks: false },
      true,
      undefined,
      false,
      CAUSE_UNCONFIGURED,
    ],
    [
      "calendar_links unknown pre-disables nothing",
      { ...ONLINE, calendarLinks: null },
      true,
      undefined,
      true,
      undefined,
    ],
    [
      "compat unsupported",
      { ...ONLINE, compat: "unsupported" },
      true,
      undefined,
      false,
      COMPAT_PAUSED,
    ],
    [
      "compat unknown",
      { ...ONLINE, compat: "unknown" },
      true,
      undefined,
      false,
      NEEDS_CONNECTION,
    ],
  ])("%s", (_name, env, add, addReason, link, linkReason) => {
    const actions = headerActions(env);
    expect(actions.add).toEqual(
      add ? { enabled: true } : { enabled: false, reason: addReason },
    );
    expect(actions.link).toEqual(
      link ? { enabled: true } : { enabled: false, reason: linkReason },
    );
  });
});

describe("a cached source", () => {
  test("the health line is history: last success and the timezone", () => {
    const status = sourceStatus({
      merged: merged(),
      outstanding: none,
      env: ONLINE,
      refreshing: false,
    });
    expect(status.lines).toEqual([
      `Last success ${formatInstant(1_790_000_000)} · Europe/Vienna`,
    ]);
    expect(status.refresh).toEqual({ enabled: true });
    expect(status.manage).toEqual({ enabled: true });
  });
  test("a source never refreshed, and a failed health value", () => {
    expect(
      sourceStatus({
        merged: merged({ value: { health: "pending", timezone: "UTC" } }),
        outstanding: none,
        env: ONLINE,
        refreshing: false,
      }).lines,
    ).toEqual([`${NOT_REFRESHED_YET} · UTC`]);
    expect(
      sourceStatus({
        merged: merged({ value: { health: "fetch_failed", timezone: "UTC" } }),
        outstanding: none,
        env: ONLINE,
        refreshing: false,
      }).lines[0],
    ).toMatch(/^Last refresh: /);
  });
  test.each<[string, Parameters<typeof sourceStatus>[0], string | undefined]>([
    [
      "offline",
      { merged: merged(), outstanding: none, env: OFFLINE, refreshing: false },
      NEEDS_CONNECTION,
    ],
    [
      "turned off",
      {
        merged: merged({ archived: true }),
        outstanding: none,
        env: ONLINE,
        refreshing: false,
      },
      TURNED_OFF_REASON,
    ],
    [
      "view only",
      {
        merged: merged({ can_edit: false }),
        outstanding: none,
        env: ONLINE,
        refreshing: false,
      },
      VIEW_ONLY_REASON,
    ],
    [
      "already refreshing",
      { merged: merged(), outstanding: none, env: ONLINE, refreshing: true },
      REFRESHING_REASON,
    ],
    [
      "compat missing",
      {
        merged: merged(),
        outstanding: none,
        env: { ...ONLINE, compat: "missing" },
        refreshing: false,
      },
      COMPAT_PAUSED,
    ],
  ])("Refresh is unavailable %s, and says why", (_name, input, reason) => {
    expect(sourceStatus(input).refresh).toEqual({ enabled: false, reason });
  });
  test("turned off is shown on the row", () => {
    expect(
      sourceStatus({
        merged: merged({ archived: true }),
        outstanding: none,
        env: ONLINE,
        refreshing: false,
      }).lines,
    ).toContain(TURNED_OFF);
  });
  test.each<[string, Record<string, number>, string, string | null]>([
    ["queued", { queued: 1 }, "queued", QUEUED],
    ["in flight", { in_flight: 1 }, "queued", QUEUED],
    [
      "acknowledged, waiting for the next sync",
      { acknowledged: 1 },
      "saving",
      SAVING,
    ],
    [
      "a version conflict",
      { version_conflict: 1, queued: 2 },
      "decision",
      NEEDS_DECISION,
    ],
    ["rejected", { rejected: 1, queued: 1 }, "rejected", REJECTED],
  ])("outstanding drafts: %s", (_name, byStatus, state, line) => {
    const counts = { total: 1, byStatus, latest: null };
    expect(outstandingState(counts)).toBe(state);
    expect(
      sourceStatus({
        merged: merged(),
        outstanding: counts,
        env: ONLINE,
        refreshing: false,
      }).lines,
    ).toContain(line);
  });
  test("D-13a-11: a non-owner's queued settings change refused 403 says only the owner can change them", () => {
    const counts = {
      total: 1,
      byStatus: { rejected: 1 },
      latest: {
        status: "rejected" as const,
        local_id: "d",
        last_error: { status: 403, code: "forbidden", stage: "rejected" },
      },
    };
    expect(
      sourceStatus({
        merged: merged(),
        outstanding: counts,
        env: ONLINE,
        refreshing: false,
      }).lines,
    ).toContain(OWNER_ONLY);
  });
});

describe("a pending create", () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    status: "queued" as const,
    last_error: null,
    held_pending_cache: false,
    ...over,
  });
  test("offline and online wording; Refresh waits for the source to exist; Manage can queue settings behind the create", () => {
    expect(pendingStatus({ draft: draft(), env: OFFLINE }).lines).toEqual([
      PENDING_OFFLINE,
    ]);
    const online = pendingStatus({ draft: draft(), env: ONLINE });
    expect(online.lines).toEqual([PENDING_ONLINE]);
    expect(online.refresh).toEqual({
      enabled: false,
      reason: NOT_CREATED_REASON,
    });
    expect(online.manage).toEqual({ enabled: true });
  });
  test("acknowledged is saving; rejected offers its reason", () => {
    expect(
      pendingStatus({ draft: draft({ status: "acknowledged" }), env: ONLINE })
        .lines,
    ).toEqual([SAVING]);
    expect(
      pendingStatus({ draft: draft({ status: "rejected" }), env: ONLINE })
        .outstanding,
    ).toBe("rejected");
  });
});

describe("Manage (D-13a-8)", () => {
  test("Save queues offline; Replace and Remove need a connection", () => {
    expect(
      manageActions({
        env: OFFLINE,
        cached: true,
        outstandingTotal: 0,
        awaitingSync: false,
      }),
    ).toEqual({
      save: { enabled: true },
      replace: { enabled: false, reason: NEEDS_CONNECTION },
      remove: { enabled: false, reason: NEEDS_CONNECTION },
    });
  });
  test("waiting changes block the connection changes; an online change blocks Save until the cache catches up", () => {
    expect(
      manageActions({
        env: ONLINE,
        cached: true,
        outstandingTotal: 2,
        awaitingSync: false,
      }).replace,
    ).toEqual({
      enabled: false,
      reason: WAITING_CHANGES_FIRST,
    });
    expect(
      manageActions({
        env: ONLINE,
        cached: true,
        outstandingTotal: 0,
        awaitingSync: true,
      }).save,
    ).toEqual({
      enabled: false,
      reason: WAITING_LAST_CHANGE,
    });
  });
  test("a pending source has no connection to change yet; calendar_links false blocks Replace but not Remove", () => {
    expect(
      manageActions({
        env: ONLINE,
        cached: false,
        outstandingTotal: 1,
        awaitingSync: false,
      }).remove,
    ).toEqual({
      enabled: false,
      reason: NOT_CREATED_REASON,
    });
    const unconfigured = manageActions({
      env: { ...ONLINE, calendarLinks: false },
      cached: true,
      outstandingTotal: 0,
      awaitingSync: false,
    });
    expect(unconfigured.replace).toEqual({
      enabled: false,
      reason: CAUSE_UNCONFIGURED,
    });
    expect(unconfigured.remove).toEqual({ enabled: true });
  });
  test("no database: Save explains it", () => {
    expect(
      manageActions({
        env: { ...ONLINE, hasOutbox: false },
        cached: true,
        outstandingTotal: 0,
        awaitingSync: false,
      }).save,
    ).toEqual({
      enabled: false,
      reason: NEEDS_DATABASE,
    });
  });
});

describe("the row shows what was asked for", () => {
  test("the newest queued settings change's values are shown over the merged row; a conflict's are not", async () => {
    const { displayedRow } = await import(
      "../../../src/features/calendars/model/status"
    );
    const row = {
      value: { timezone: "UTC", health: "healthy" },
      archived: false,
    };
    const latest = (status: "queued" | "version_conflict") => ({
      status,
      local_id: "d",
      last_error: null,
      kind: "configure_source",
      command: {
        command: {
          kind: "configure_source",
          timezone: "Asia/Tokyo",
          enabled: false,
        },
      },
    });
    expect(displayedRow(row, latest("queued"))).toEqual({
      value: { timezone: "Asia/Tokyo", health: "healthy" },
      archived: true,
    });
    expect(displayedRow(row, latest("version_conflict"))).toBe(row);
    expect(displayedRow(row, null)).toBe(row);
  });
  test("Replace and Remove wait until the waiting changes have been read", () => {
    expect(
      manageActions({
        env: ONLINE,
        cached: true,
        outstandingTotal: null,
        awaitingSync: false,
      }).remove,
    ).toMatchObject({ enabled: false });
  });
});

describe("revision 1: Save restates what is waiting, so it waits until that has been read (R5)", () => {
  test("Save is unavailable while the waiting changes are unread, with the same words as Replace and Remove; then it is offered", () => {
    const unread = manageActions({
      env: ONLINE,
      cached: true,
      outstandingTotal: null,
      awaitingSync: false,
    });
    expect(unread.save).toEqual({ enabled: false, reason: CHECKING_CHANGES });
    expect(unread.remove).toEqual({ enabled: false, reason: CHECKING_CHANGES });
    for (const total of [0, 2])
      expect(
        manageActions({
          env: OFFLINE,
          cached: total === 0,
          outstandingTotal: total,
          awaitingSync: false,
        }).save,
      ).toEqual({ enabled: true });
  });
});

describe("revision 1: what an open Manage may still show (R2); revision 2: on what authority (R6)", () => {
  const row = (version: number, label = "Family calendar") => ({
    id: "s",
    kind: "calendar_source" as const,
    parent_id: null,
    label,
    value: { timezone: "UTC" },
    version,
    can_edit: true,
    archived: false,
    kind_date: null,
  });
  /** The one read Manage takes of its source (`readResourceView`): its cached row (or none) and this device's create (or none). */
  const ready = (
    base: ReturnType<typeof row> | null,
    create: { label: string; timezone: string } | null = null,
  ) => ({
    status: "ready" as const,
    value: {
      base,
      merged: base,
      outstanding: { total: 0, byStatus: {}, latest: null, latestOfKind: null },
      create:
        create === null
          ? null
          : {
              local_id: "c",
              kind: "create_source",
              command: {
                command: { kind: "create_source", id: "s", ...create },
              },
            },
      observation: { resourceId: "s", token: "t" },
    },
  });
  /** The row a create becomes (the production projection's shape, cut down to what the table compares). */
  const project = (create: { command: unknown }) => {
    const wrapped = (create.command as { command: Record<string, string> })
      .command;
    return {
      ...row(1, wrapped.label),
      value: { timezone: wrapped.timezone },
    };
  };
  const opened = row(3, "Opened with");
  const decide = (
    gate: string,
    view: unknown,
    seenCached: boolean,
    read: boolean,
  ) =>
    sourceAuthority({
      gate: gate as never,
      view: view as never,
      last: opened,
      seenCached,
      read,
      project: project as never,
    });
  const strip = (decision: ReturnType<typeof decide>) =>
    decision.kind === "cached" || decision.kind === "pending"
      ? { kind: decision.kind, row: decision.row }
      : decision;

  test.each([
    [
      "the cache is being brought up to date",
      "refreshing",
      ready(row(4)),
      true,
      { kind: "gone", reason: "refreshing" },
    ],
    [
      "the floor (nothing will refresh it here)",
      "floor",
      ready(row(4)),
      true,
      { kind: "gone", reason: "refreshing" },
    ],
    [
      "the source left the cache",
      "open",
      ready(null),
      true,
      { kind: "gone", reason: "removed" },
    ],
    [
      "the source left the cache, although a create of it is still in the outbox (never back to pending)",
      "open",
      ready(null, { label: "Old", timezone: "Europe/Vienna" }),
      true,
      { kind: "gone", reason: "removed" },
    ],
    [
      "its read failed",
      "open",
      { status: "unavailable" as const, reason: "error" },
      true,
      { kind: "gone", reason: "removed" },
    ],
    [
      "its read started again after an answer",
      "open",
      { status: "loading" as const },
      true,
      { kind: "gone", reason: "refreshing" },
    ],
    [
      "its first read is still loading (the list showed it a moment ago)",
      "open",
      { status: "loading" as const },
      false,
      { kind: "resolving", row: opened },
    ],
    [
      "its first read is still loading, but the gate has closed",
      "refreshing",
      { status: "loading" as const },
      false,
      { kind: "gone", reason: "refreshing" },
    ],
    [
      "it is held: the row as it is now, never the one it was opened with",
      "open",
      ready(row(4)),
      true,
      { kind: "cached", row: row(4) },
    ],
  ] as const)("seen cached, %s", (_case, gate, view, read, expected) => {
    expect(strip(decide(gate, view, true, read))).toEqual(expected);
  });

  test.each([
    [
      "its create is in the outbox: shown from the create AS IT IS NOW, whatever the gate says (drafts are never behind it)",
      ["open", "refreshing", "floor"],
      ready(null, { label: "Edited label", timezone: "Asia/Tokyo" }),
      {
        kind: "pending",
        row: { ...row(1, "Edited label"), value: { timezone: "Asia/Tokyo" } },
      },
    ],
    [
      "its create was published (R6): PROMOTED to the cached source, not the row it was opened with",
      ["open"],
      ready(row(4)),
      { kind: "cached", row: row(4) },
    ],
    [
      "its create was published while the cache is being brought up to date: hidden like any cached source",
      ["refreshing", "floor"],
      ready(row(4)),
      { kind: "gone", reason: "refreshing" },
    ],
    [
      "neither cached nor in the outbox (discarded, superseded, or receipted and never published here)",
      ["open", "refreshing"],
      ready(null),
      { kind: "gone", reason: "removed" },
    ],
    [
      "no read has answered yet: the last row stands in, nothing may act",
      ["open", "refreshing"],
      { status: "loading" as const },
      { kind: "resolving", row: opened },
    ],
    [
      "its read failed: not taken as gone (a pending create is not cache content), nothing may act",
      ["open"],
      { status: "unavailable" as const, reason: "error" },
      { kind: "resolving", row: opened },
    ],
  ] as const)("never seen cached, %s", (_case, gates, view, expected) => {
    for (const gate of gates)
      for (const read of [false, true])
        expect(strip(decide(gate, view, false, read))).toEqual(expected);
  });
});
