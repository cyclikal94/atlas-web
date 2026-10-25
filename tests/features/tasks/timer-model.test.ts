// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  AccountTimerSession,
  TimerSession,
} from "../../../src/features/tasks/model/contract";
import { runningOn } from "../../../src/features/tasks/model/timers";
import { draftRow } from "../../support/data/rows";

/**
 * Which source says a timer is running (review R2; D-10c-4, B6). A COMPLETE read of the day's sessions lists every session the server
 * still has and omits a cancelled one, so it supersedes a copy taken BEFORE it was issued; a copy taken after it, a partial or absent read,
 * or unknown times leave the copy standing (offline fallback); this device's unsettled start stays until its draft settles.
 */
const OCC = "aaaaaaaa-0000-4000-8000-0000000000e1";
const OTHER_DAY = "aaaaaaaa-0000-4000-8000-0000000000e2";
const COPIED = "cccccccc-0000-4000-8000-0000000000e3";
const T0 = 1_800_000_000_000;

const copied = (over: Partial<AccountTimerSession> = {}): AccountTimerSession =>
  ({
    access: "available",
    id: COPIED,
    occurrence_id: OCC,
    task_id: "aaaaaaaa-0000-4000-8000-0000000000e4",
    task_title: "Practise piano",
    slot_date: "2026-10-25",
    started_at: T0 / 1000 - 600,
    stopped_at: null,
    version: 3,
    can_modify: true,
    ...over,
  }) as AccountTimerSession;
const session = (over: Partial<TimerSession> = {}): TimerSession =>
  ({
    id: COPIED,
    occurrence_id: OCC,
    started_at: T0 / 1000 - 600,
    stopped_at: null,
    version: 3,
    ...over,
  }) as TimerSession;
const ids = (input: Parameters<typeof runningOn>[1]) =>
  runningOn(OCC, input).map((s) => [s.id, s.source]);

describe("R2: a complete read and the copy", () => {
  test("a complete read issued after the copy, not listing the copied session (cancelled), says it is not running", () => {
    expect(
      ids({
        drafts: [],
        read: [],
        copy: [copied()],
        readAt: T0,
        copyAt: T0 - 60_000,
      }),
    ).toEqual([]);
    // Issued at the same moment: the read is as new as the copy.
    expect(
      ids({ drafts: [], read: [], copy: [copied()], readAt: T0, copyAt: T0 }),
    ).toEqual([]);
  });

  test("control: a read that lists it running keeps it (from the read, with its version); a stopped one ends it", () => {
    expect(
      ids({
        drafts: [],
        read: [session()],
        copy: [copied()],
        readAt: T0,
        copyAt: T0 - 60_000,
      }),
    ).toEqual([[COPIED, "read"]]);
    expect(
      ids({
        drafts: [],
        read: [session({ stopped_at: T0 / 1000 - 10 })],
        copy: [copied()],
        readAt: T0 - 120_000,
        copyAt: T0,
      }),
    ).toEqual([]);
  });

  test("a copy taken after the read may know a session the read could not: it stays", () => {
    expect(
      ids({
        drafts: [],
        read: [],
        copy: [copied()],
        readAt: T0 - 60_000,
        copyAt: T0,
      }),
    ).toEqual([[COPIED, "copy"]]);
  });

  test("a partial or absent read, or times not known, decides nothing: the copy stands (offline fallback)", () => {
    expect(
      ids({
        drafts: [],
        read: null,
        copy: [copied()],
        readAt: T0,
        copyAt: T0 - 60_000,
      }),
    ).toEqual([[COPIED, "copy"]]);
    expect(ids({ drafts: [], read: [], copy: [copied()] })).toEqual([
      [COPIED, "copy"],
    ]);
    expect(
      ids({ drafts: [], read: [], copy: [copied()], readAt: null, copyAt: T0 }),
    ).toEqual([[COPIED, "copy"]]);
  });

  test("another day's read says nothing about this day's copied session; a restricted copy row is never running here", () => {
    expect(
      runningOn(OTHER_DAY, {
        drafts: [],
        read: [],
        copy: [copied()],
        readAt: T0,
        copyAt: T0 - 60_000,
      }),
    ).toEqual([]);
    expect(
      ids({
        drafts: [],
        read: null,
        copy: [copied({ access: "restricted" } as never)],
        readAt: null,
        copyAt: T0,
      }),
    ).toEqual([]);
  });

  test("this device's unsettled start stays running whatever a newer read omits (it may predate the server's start)", () => {
    const start = draftRow({
      local_id: "dddddddd-0000-4000-8000-0000000000e5",
      kind: "start_timer",
      status: "acknowledged",
      command: {
        command: {
          kind: "start_timer",
          occurrence_id: OCC,
          session_id: "dddddddd-0000-4000-8000-0000000000e6",
          started_at: T0 / 1000 - 5,
        },
      },
    });
    expect(
      ids({
        drafts: [start as never],
        read: [],
        copy: [copied()],
        readAt: T0,
        copyAt: T0 - 60_000,
      }),
    ).toEqual([["dddddddd-0000-4000-8000-0000000000e6", "draft"]]);
  });
});
