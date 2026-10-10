// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { DispatcherState } from "../../src/data/engine/outbox-dispatcher";
import type { EngineState } from "../../src/data/engine/sync-engine";
import { DATA_CONFIG } from "../../src/data/model/config";
import { EMPTY_SUMMARY } from "../../src/data/model/queue-summary";
import {
  cacheHidden,
  deriveGate,
  deriveNotices,
  derivePhase,
  deriveSyncStatus,
  type StatusInputs,
} from "../../src/data/model/status";
import { describeSyncChip } from "../../src/lib/sync-chip";

/**
 * F-U1 (plan 8.7): `deriveSyncStatus` is table-driven over every engine state x online x recovery x compat x queue combination.
 * "Up to date" appears only after a completed sync; the production wiring (no engine, no recovery) yields `interrupted`.
 */
const NOW = 1_000_000;
const base = (over: Partial<StatusInputs> = {}): StatusInputs => ({
  online: true,
  engine: null,
  recovery: { registered: false, active: false },
  cache: "unknown",
  lastSyncedAt: null,
  summary: null,
  outbox: null,
  storageNotResponding: false,
  ...over,
});

const ENGINE_STATES: Array<[string, EngineState]> = [
  ["not_started", { kind: "not_started" }],
  ["waiting/cache_not_valid", { kind: "waiting", reason: "cache_not_valid" }],
  [
    "waiting/paused_by_session",
    { kind: "waiting", reason: "paused_by_session" },
  ],
  ["waiting/offline", { kind: "waiting", reason: "offline" }],
  ["running (catching up)", { kind: "running", catchingUp: true }],
  ["running (live edge)", { kind: "running", catchingUp: false }],
  ["idle", { kind: "idle", lastSyncedAt: "2026-10-01T09:00:00.000Z" }],
  ["backing_off (short)", { kind: "backing_off", since: NOW - 1_000 }],
  [
    "backing_off (sustained)",
    { kind: "backing_off", since: NOW - DATA_CONFIG.retrySustainedMs },
  ],
  ["paused", { kind: "paused", since: NOW - 1 }],
  ["stopped/floor", { kind: "stopped", cause: "floor" }],
  ["stopped/storage_full", { kind: "stopped", cause: "storage_full" }],
  ["stopped/local_storage", { kind: "stopped", cause: "local_storage" }],
  ["stopped/device_capacity", { kind: "stopped", cause: "device_capacity" }],
  ["stopped/unrecognised", { kind: "stopped", cause: "unrecognised" }],
  ["stopped/no_recovery", { kind: "stopped", cause: "no_recovery" }],
];

describe("the inbound phase", () => {
  test("production wiring (no engine, no recovery): interrupted, whatever the queue holds", () => {
    expect(derivePhase(base(), NOW)).toBe("interrupted");
    expect(
      deriveSyncStatus(
        base({ summary: { ...EMPTY_SUMMARY, waiting: 3, total: 3 } }),
        NOW,
      ),
    ).toEqual({
      phase: "interrupted",
      pendingCount: 3,
      conflictCount: 0,
    });
  });

  test("offline wins over every engine state and over recovery", () => {
    for (const [, engine] of ENGINE_STATES)
      expect(
        derivePhase(
          base({
            online: false,
            engine,
            recovery: { registered: true, active: true },
          }),
          NOW,
        ),
      ).toBe("offline");
  });

  test.each([
    ["not_started", "interrupted"],
    ["waiting/cache_not_valid", "interrupted"],
    ["waiting/paused_by_session", "interrupted"],
    ["waiting/offline", "offline"],
    ["running (catching up)", "resyncing"],
    ["idle", "synced"],
    ["paused", "interrupted"],
    ["stopped/floor", "interrupted"],
    ["stopped/storage_full", "interrupted"],
    ["stopped/local_storage", "interrupted"],
    ["stopped/device_capacity", "interrupted"],
    ["stopped/unrecognised", "interrupted"],
    ["stopped/no_recovery", "interrupted"],
  ] as const)("with no recovery job, %s reads %s", (name, expected) => {
    const engine = ENGINE_STATES.find(([n]) => n === name)?.[1] as EngineState;
    expect(derivePhase(base({ engine }), NOW)).toBe(expected);
  });

  test("a registered recovery job: waiting for a valid cache reads Resyncing, and so does an ACTIVE job whatever the engine says (Q24: from the instant a 410 arrives)", () => {
    const waiting: EngineState = { kind: "waiting", reason: "cache_not_valid" };
    expect(
      derivePhase(
        base({
          engine: waiting,
          recovery: { registered: true, active: false },
        }),
        NOW,
      ),
    ).toBe("resyncing");
    for (const [, engine] of ENGINE_STATES.filter(
      ([, e]) => e.kind !== "waiting",
    ))
      expect(
        derivePhase(
          base({ engine, recovery: { registered: true, active: true } }),
          NOW,
        ),
      ).toBe("resyncing");
  });

  test("a transient back-off keeps the previous phase; a SUSTAINED one reads interrupted", () => {
    const short: EngineState = { kind: "backing_off", since: NOW - 1_000 };
    const sustained: EngineState = {
      kind: "backing_off",
      since: NOW - DATA_CONFIG.retrySustainedMs,
    };
    for (const previous of ["synced", "resyncing"] as const)
      expect(derivePhase(base({ engine: short, previous }), NOW)).toBe(
        previous,
      );
    expect(derivePhase(base({ engine: short }), NOW)).toBe("interrupted");
    expect(
      derivePhase(base({ engine: sustained, previous: "synced" }), NOW),
    ).toBe("interrupted");
  });

  test("the live-edge poll is not 'catching up': the chip keeps the phase it had", () => {
    const poll: EngineState = { kind: "running", catchingUp: false };
    expect(derivePhase(base({ engine: poll, previous: "synced" }), NOW)).toBe(
      "synced",
    );
  });

  test("'Up to date' appears ONLY after a completed sync: no other engine state, queue, cache or compat state ever yields synced", () => {
    const synced = ENGINE_STATES.filter(([n]) => ["idle"].includes(n));
    for (const [name, engine] of ENGINE_STATES) {
      for (const cache of [
        "unknown",
        "unverified",
        "empty",
        "valid",
        "invalid",
      ] as const)
        for (const summary of [
          null,
          EMPTY_SUMMARY,
          { ...EMPTY_SUMMARY, waiting: 5, total: 5 },
        ])
          for (const outbox of [
            null,
            { kind: "idle" },
            { kind: "paused", reason: "compat_missing" },
          ] as DispatcherState[]) {
            const phase = derivePhase(
              base({ engine, cache, summary, outbox }),
              NOW,
            );
            if (phase === "synced")
              expect(
                synced.map(([n]) => n),
                name,
              ).toContain(name);
          }
    }
  });

  test("the chip's own copy follows: the production model reads 'Updates stopped', and a completed sync reads 'Up to date'", () => {
    expect(describeSyncChip(deriveSyncStatus(base(), NOW)).label).toBe(
      "Updates stopped",
    );
    const idle: EngineState = { kind: "idle", lastSyncedAt: "x" };
    expect(
      describeSyncChip(
        deriveSyncStatus(
          base({ engine: idle, lastSyncedAt: "2026-10-01T09:00:00.000Z" }),
          NOW,
        ),
      ).label,
    ).toBe("Up to date");
  });

  test("counts are the queue summary's: waiting and needs a decision; lastSyncedAt is passed through only when known", () => {
    const model = deriveSyncStatus(
      base({
        summary: {
          waiting: 4,
          needsDecision: 2,
          held: 1,
          total: 7,
          warn: false,
        },
        lastSyncedAt: "2026-10-01T09:00:00.000Z",
      }),
      NOW,
    );
    expect(model).toMatchObject({
      pendingCount: 4,
      conflictCount: 2,
      lastSyncedAt: "2026-10-01T09:00:00.000Z",
    });
    expect("lastSyncedAt" in deriveSyncStatus(base(), NOW)).toBe(false);
  });
});

describe("the banners and terminal states (plan 5.7)", () => {
  const notices = (over: Partial<StatusInputs>) => deriveNotices(base(over));

  test("nothing is shown when nothing is wrong", () => {
    expect(notices({})).toEqual([]);
    expect(
      notices({
        engine: { kind: "idle", lastSyncedAt: null },
        summary: EMPTY_SUMMARY,
        outbox: { kind: "idle" },
      }),
    ).toEqual([]);
  });

  test("floor: (a) while the cache is visible, (b) while it is hidden", () => {
    const engine: EngineState = { kind: "stopped", cause: "floor" };
    expect(notices({ engine, cache: "valid" })).toEqual([
      { kind: "floor", variant: "a" },
    ]);
    expect(notices({ engine, cache: "invalid" })).toEqual([
      { kind: "floor", variant: "b" },
    ]);
  });

  test("storage full has two variants by cache_status, from the page's engine OR the outbox", () => {
    const engine: EngineState = { kind: "stopped", cause: "storage_full" };
    expect(notices({ engine, cache: "valid" })).toEqual([
      { kind: "storage_full", cache: "valid" },
    ]);
    expect(notices({ engine, cache: "invalid" })).toEqual([
      { kind: "storage_full", cache: "invalid" },
    ]);
    expect(
      notices({ outbox: { kind: "stopped", cause: "storage_full" } }),
    ).toEqual([{ kind: "storage_full", cache: "valid" }]);
  });

  test("a page that could not be saved, and local storage that is not responding, are different states", () => {
    expect(
      notices({ engine: { kind: "stopped", cause: "local_storage" } }),
    ).toEqual([{ kind: "page_not_saved", memoryOnly: false }]);
    expect(notices({ storageNotResponding: true })).toEqual([
      { kind: "storage_not_responding", memoryOnly: false },
    ]);
    expect(
      notices({ outbox: { kind: "stopped", cause: "local_storage" } }),
    ).toEqual([{ kind: "storage_not_responding", memoryOnly: false }]);
    // A stop that neither the durable record nor the fallback marker could keep says it will not survive a reload.
    expect(
      notices({
        engine: { kind: "stopped", cause: "local_storage", memoryOnly: true },
      }),
    ).toEqual([{ kind: "page_not_saved", memoryOnly: true }]);
    expect(
      notices({ storageNotResponding: true, storageMemoryOnly: true }),
    ).toEqual([{ kind: "storage_not_responding", memoryOnly: true }]);
    expect(
      notices({
        outbox: { kind: "stopped", cause: "local_storage", memoryOnly: true },
      }),
    ).toEqual([{ kind: "storage_not_responding", memoryOnly: true }]);
  });

  test("the compatibility pause is shown for unsupported and missing, never for the quiet hold", () => {
    expect(
      notices({ outbox: { kind: "paused", reason: "compat_unsupported" } }),
    ).toEqual([{ kind: "compat_paused", reason: "unsupported" }]);
    expect(
      notices({ outbox: { kind: "paused", reason: "compat_missing" } }),
    ).toEqual([{ kind: "compat_paused", reason: "missing" }]);
    expect(
      notices({ outbox: { kind: "held", reason: "compat_unconfirmed" } }),
    ).toEqual([]);
  });

  test("'Still trying' with Retry now appears only once automatic retry has PAUSED, for the updates and for the changes", () => {
    expect(
      notices({ engine: { kind: "backing_off", since: NOW - 5_000 } }),
    ).toEqual([]);
    expect(notices({ outbox: { kind: "backing_off" } })).toEqual([]);
    expect(notices({ engine: { kind: "paused", since: NOW } })).toEqual([
      { kind: "still_trying", scope: "updates", count: 1 },
    ]);
    expect(notices({ outbox: { kind: "needs_retry", count: 2 } })).toEqual([
      { kind: "still_trying", scope: "changes", count: 2 },
    ]);
  });

  test("the queue warning is informational and carries only the count", () => {
    expect(
      notices({
        summary: {
          waiting: 214,
          needsDecision: 0,
          held: 0,
          total: 214,
          warn: true,
        },
      }),
    ).toEqual([{ kind: "queue_warning", total: 214 }]);
    expect(
      notices({
        summary: {
          waiting: 199,
          needsDecision: 0,
          held: 0,
          total: 199,
          warn: false,
        },
      }),
    ).toEqual([]);
  });

  test("several problems are listed in a fixed priority", () => {
    const out = notices({
      engine: { kind: "stopped", cause: "storage_full" },
      outbox: { kind: "paused", reason: "compat_missing" },
      summary: {
        waiting: 214,
        needsDecision: 0,
        held: 0,
        total: 214,
        warn: true,
      },
      storageNotResponding: true,
    });
    expect(out.map((n) => n.kind)).toEqual([
      "storage_full",
      "storage_not_responding",
      "compat_paused",
      "queue_warning",
    ]);
  });
});

describe("the cache gate", () => {
  test("open unless the cache is invalid; refreshing while it is; the floor replaces 'Refreshing' when nothing will refresh it", () => {
    for (const cache of ["unknown", "empty", "valid"] as const)
      expect(deriveGate(base({ cache }))).toBe("open");
    expect(deriveGate(base({ cache: "invalid" }))).toBe("refreshing");
    expect(
      deriveGate(
        base({
          cache: "invalid",
          engine: { kind: "running", catchingUp: true },
        }),
      ),
    ).toBe("refreshing");
    // R13: a database that is open and whose facts are not established is hidden like an invalid one; only "no open database" and a
    // state a read established show content.
    expect(deriveGate(base({ cache: "unverified" }))).toBe("refreshing");
    expect(cacheHidden(base({ cache: "unverified" }))).toBe(true);
    expect(
      deriveGate(
        base({
          cache: "unverified",
          engine: { kind: "stopped", cause: "floor" },
        }),
      ),
    ).toBe("floor");
    for (const engine of [
      null,
      ...ENGINE_STATES.map(([, state]) => state),
    ] as Array<EngineState | null>)
      expect(
        deriveGate(base({ cache: "unverified", engine })),
        JSON.stringify(engine),
      ).not.toBe("open");
    expect(
      deriveGate(
        base({ cache: "invalid", engine: { kind: "stopped", cause: "floor" } }),
      ),
    ).toBe("floor");
    // A floor stop while the cache is still VISIBLE gates nothing: only further updates stop (state (a)).
    expect(
      deriveGate(
        base({ cache: "valid", engine: { kind: "stopped", cause: "floor" } }),
      ),
    ).toBe("open");
  });

  test("R10: a stop on the write of an invalidation the server admitted hides the cache although the database still says valid; any other stop does not", () => {
    for (const cause of ["local_storage", "storage_full"] as const) {
      const hidden = base({
        cache: "valid",
        engine: { kind: "stopped", cause, invalidating: true },
      });
      expect(deriveGate(hidden)).toBe("refreshing");
      expect(
        deriveGate(
          base({ cache: "valid", engine: { kind: "stopped", cause } }),
        ),
      ).toBe("open");
    }
    // An engine state that does not say it holds an invalidation reads the database (and the controller's own reading of the failure).
    expect(
      deriveGate(
        base({
          cache: "valid",
          engine: { kind: "waiting", reason: "offline" },
        }),
      ),
    ).toBe("open");
  });

  test("R10 (revision 9): the hold hides the cache in EVERY state the engine shows, not only the stop: an offline wake, a retry in flight, a paced wait", () => {
    for (const [name, state] of ENGINE_STATES) {
      // `not_started` is no engine: it reports nothing (the controller reads what the tab held through the engine's own store).
      if (state.kind === "not_started") continue;
      const holding = base({
        cache: "valid",
        engine: { ...state, invalidating: true },
      });
      expect(deriveGate(holding), name).toBe(
        state.kind === "stopped" && state.cause === "floor"
          ? "floor"
          : "refreshing",
      );
      // The control: the same state without the hold reads the database, which says valid.
      expect(deriveGate(base({ cache: "valid", engine: state })), name).toBe(
        "open",
      );
    }
    // And the database's own word is never overridden by the absence of a hold.
    expect(
      deriveGate(
        base({
          cache: "invalid",
          engine: { kind: "waiting", reason: "offline" },
        }),
      ),
    ).toBe("refreshing");
  });

  test("R10: the notices of such a stop name the cache as hidden (the quota notice is the 'refreshing' one), and a page's stop does not", () => {
    expect(
      deriveNotices(
        base({
          cache: "valid",
          engine: {
            kind: "stopped",
            cause: "storage_full",
            invalidating: true,
          },
        }),
      ),
    ).toEqual([{ kind: "storage_full", cache: "invalid" }]);
    expect(
      deriveNotices(
        base({
          cache: "valid",
          engine: { kind: "stopped", cause: "storage_full" },
        }),
      ),
    ).toEqual([{ kind: "storage_full", cache: "valid" }]);
    expect(
      deriveNotices(
        base({
          cache: "valid",
          engine: {
            kind: "stopped",
            cause: "local_storage",
            invalidating: true,
          },
        }),
      ),
    ).toEqual([{ kind: "page_not_saved", memoryOnly: false }]);
  });
});
