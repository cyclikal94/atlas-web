import { describe, expect, test } from "vitest";
import {
  accessibleNameFor,
  describeSyncChip,
  formatSyncedAgo,
  type SyncStatusModel,
} from "../../src/lib/sync-chip";

const model = (overrides: Partial<SyncStatusModel> = {}): SyncStatusModel => ({
  phase: "synced",
  pendingCount: 0,
  conflictCount: 0,
  ...overrides,
});
const NOW = new Date("2026-09-28T12:00:00Z");

/** The acceptance source is ia.md 1.3.1: sync status and destination are independent. */
describe("describeSyncChip: destination priority (independent of phase)", () => {
  test.each([
    [{ conflictCount: 1 }, "conflicts"],
    [{ conflictCount: 1, pendingCount: 4 }, "conflicts"],
    [{ conflictCount: 1, phase: "offline" as const }, "conflicts"],
    [{ conflictCount: 1, phase: "interrupted" as const }, "conflicts"],
    [{ pendingCount: 3 }, "queue"],
    [{ pendingCount: 3, phase: "offline" as const }, "queue"],
    [{}, "queue"],
    [{ phase: "resyncing" as const }, "queue"],
  ])("%j opens %s", (overrides, destination) => {
    expect(describeSyncChip(model(overrides), NOW).destination).toBe(
      destination,
    );
  });
});

describe("describeSyncChip: phase and tone", () => {
  test.each([
    ["synced", 0, 0, "ok", "Up to date", "Receiving updates: up to date"],
    [
      "synced",
      2,
      0,
      "busy",
      "2 waiting to send",
      "Receiving updates: up to date",
    ],
    [
      "resyncing",
      0,
      0,
      "busy",
      "Catching up",
      "Receiving updates: catching up",
    ],
    [
      "interrupted",
      0,
      0,
      "warn",
      "Updates stopped",
      "Receiving updates: stopped",
    ],
    ["offline", 0, 0, "muted", "Offline", "Receiving updates: offline"],
    [
      "offline",
      3,
      0,
      "muted",
      "3 waiting to send",
      "Receiving updates: offline",
    ],
    [
      "synced",
      0,
      1,
      "error",
      "1 needs a decision",
      "Receiving updates: up to date",
    ],
    [
      "offline",
      2,
      1,
      "error",
      "1 needs a decision",
      "Receiving updates: offline",
    ],
    [
      "interrupted",
      0,
      2,
      "error",
      "2 needs a decision",
      "Receiving updates: stopped",
    ],
    [
      "resyncing",
      5,
      0,
      "busy",
      "5 waiting to send",
      "Receiving updates: catching up",
    ],
  ] as const)(
    "%s, pending %i, conflicts %i -> %s, %s",
    (phase, pendingCount, conflictCount, tone, label, phaseLabel) => {
      const view = describeSyncChip(
        model({ phase, pendingCount, conflictCount }),
        NOW,
      );
      expect(view.tone).toBe(tone);
      expect(view.label).toBe(label);
      expect(view.phaseLabel).toBe(phaseLabel);
    },
  );

  test("conflicts win over pending in the primary line, and pending is not lost", () => {
    const view = describeSyncChip(
      model({ conflictCount: 1, pendingCount: 2 }),
      NOW,
    );
    expect(view.label).toBe("1 needs a decision");
    expect(view.detail).toBe(
      "2 waiting to send · Receiving updates: up to date",
    );
  });

  test("the inbound axis is never collapsed into the count", () => {
    const view = describeSyncChip(
      model({ phase: "resyncing", pendingCount: 2 }),
      NOW,
    );
    expect(view.detail).toContain("Receiving updates: catching up");
  });
});

describe("describeSyncChip: counts", () => {
  test.each([
    [0, "Up to date"],
    [1, "1 waiting to send"],
    [99, "99 waiting to send"],
    [1000, "1000 waiting to send"],
    [-3, "Up to date"],
    [Number.NaN, "Up to date"],
    [2.9, "2 waiting to send"],
  ])("pending %s -> %s", (pendingCount, label) => {
    expect(describeSyncChip(model({ pendingCount }), NOW).label).toBe(label);
  });
});

describe("describeSyncChip: accessible name", () => {
  test("states both the status and the action", () => {
    const view = describeSyncChip(model({ pendingCount: 2 }), NOW);
    expect(view.accessibleName).toBe(
      "2 waiting to send, Receiving updates: up to date. Open sync queue.",
    );
  });

  test("names the conflicts destination when a conflict is open", () => {
    expect(
      describeSyncChip(model({ conflictCount: 1 }), NOW).accessibleName,
    ).toMatch(/Open conflicts\.$/);
  });

  test("the compact form contains exactly the visible text", () => {
    const view = describeSyncChip(
      model({ phase: "offline", conflictCount: 1 }),
      NOW,
    );
    expect(view.compactLabel).toBe("Offline · 1 needs a decision");
    expect(accessibleNameFor(view, "dialog")).toBe(
      "Offline · 1 needs a decision. Open conflicts.",
    );
    expect(accessibleNameFor(view, "topbar")).toContain(view.compactLabel);
  });

  test("the compact form of a healthy chip is Up to date", () => {
    expect(describeSyncChip(model(), NOW).compactLabel).toBe("Up to date");
  });
});

describe("formatSyncedAgo", () => {
  test.each([
    ["2026-09-28T11:59:40Z", "synced just now"],
    ["2026-09-28T11:58:00Z", "synced 2m ago"],
    ["2026-09-28T09:00:00Z", "synced 3h ago"],
    ["2026-09-25T12:00:00Z", "synced 3d ago"],
    [undefined, undefined],
    ["not a date", undefined],
    ["2027-01-01T00:00:00Z", undefined],
  ])("%s -> %s", (lastSyncedAt, expected) => {
    expect(formatSyncedAgo(lastSyncedAt, NOW)).toBe(expected);
  });

  test("a healthy chip carries the relative time as its detail; an unknown time carries none", () => {
    expect(
      describeSyncChip(model({ lastSyncedAt: "2026-09-28T11:58:00Z" }), NOW)
        .detail,
    ).toBe("synced 2m ago");
    expect(describeSyncChip(model(), NOW).detail).toBeUndefined();
    expect(
      describeSyncChip(model({ lastSyncedAt: "nonsense" }), NOW).detail,
    ).toBeUndefined();
  });
});

describe("describeSyncChip is pure and deterministic", () => {
  test("the same input gives the same output", () => {
    const input = model({
      phase: "resyncing",
      pendingCount: 7,
      conflictCount: 2,
    });
    expect(describeSyncChip(input, NOW)).toEqual(describeSyncChip(input, NOW));
  });
});
