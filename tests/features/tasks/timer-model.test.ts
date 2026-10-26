// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  AccountTimerSession,
  TimerSession,
} from "../../../src/features/tasks/model/contract";
import {
  copyCorrection,
  runningOn,
} from "../../../src/features/tasks/model/timers";
import { draftRow } from "../../support/data/rows";

/**
 * Which source says a timer is running (review R2, revised by review R11 and design assessment DA-T2; D-10c-4, B6). What a read of the
 * day's sessions LISTS always counts, on a partial page too (R11). What it OMITS counts only for a COMPLETE read issued after the copy in
 * the database's observation order (`readOrder` > `copyOrder`, W28; never the clock): it supersedes the copy; a copy taken after it, an
 * unknown order or a partial read leave the copy standing (offline fallback); this device's unsettled start stays until its draft settles.
 *
 * Adaptation (revision 2): the revision-1 cases compared issue times in ms (`readAt` ≥ `copyAt`); each is kept with the same intent over
 * the observation order, and the "same millisecond" case now says that a tie of clocks is no order at all (DA-T2).
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
        complete: true,
        copy: [copied()],
        readOrder: 5,
        copyOrder: 4,
      }),
    ).toEqual([]);
    // Against a copy written before the order existed (format 1, order 0), any ordered complete read is the later one.
    expect(
      ids({
        drafts: [],
        read: [],
        complete: true,
        copy: [copied()],
        readOrder: 1,
        copyOrder: 0,
      }),
    ).toEqual([]);
  });

  test("control: a read that lists it running keeps it (from the read, with its version); a stopped one ends it", () => {
    expect(
      ids({
        drafts: [],
        read: [session()],
        complete: true,
        copy: [copied()],
        readOrder: 5,
        copyOrder: 4,
      }),
    ).toEqual([[COPIED, "read"]]);
    expect(
      ids({
        drafts: [],
        read: [session({ stopped_at: T0 / 1000 - 10 })],
        complete: true,
        copy: [copied()],
        readOrder: 3,
        copyOrder: 4,
      }),
    ).toEqual([]);
  });

  test("a copy taken after the read may know a session the read could not: it stays; so does one of the read's own order (no tie decides)", () => {
    expect(
      ids({
        drafts: [],
        read: [],
        complete: true,
        copy: [copied()],
        readOrder: 4,
        copyOrder: 5,
      }),
    ).toEqual([[COPIED, "copy"]]);
    expect(
      ids({
        drafts: [],
        read: [],
        complete: true,
        copy: [copied()],
        readOrder: 5,
        copyOrder: 5,
      }),
    ).toEqual([[COPIED, "copy"]]);
  });

  test("an absent or partial read, or an order not known, decides nothing by absence: the copy stands (offline fallback)", () => {
    expect(
      ids({
        drafts: [],
        read: null,
        copy: [copied()],
        readOrder: 5,
        copyOrder: 4,
      }),
    ).toEqual([[COPIED, "copy"]]);
    expect(
      ids({
        drafts: [],
        read: [],
        complete: false,
        copy: [copied()],
        readOrder: 5,
        copyOrder: 4,
      }),
    ).toEqual([[COPIED, "copy"]]);
    expect(
      ids({ drafts: [], read: [], complete: true, copy: [copied()] }),
    ).toEqual([[COPIED, "copy"]]);
    expect(
      ids({
        drafts: [],
        read: [],
        complete: true,
        copy: [copied()],
        readOrder: null,
        copyOrder: 4,
      }),
    ).toEqual([[COPIED, "copy"]]);
  });

  test("another day's read says nothing about this day's copied session; a restricted copy row is never running here", () => {
    expect(
      runningOn(OTHER_DAY, {
        drafts: [],
        read: [],
        complete: true,
        copy: [copied()],
        readOrder: 5,
        copyOrder: 4,
      }),
    ).toEqual([]);
    expect(
      ids({
        drafts: [],
        read: null,
        copy: [copied({ access: "restricted" } as never)],
        readOrder: null,
        copyOrder: 4,
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
        complete: true,
        copy: [copied()],
        readOrder: 5,
        copyOrder: 4,
      }),
    ).toEqual([["dddddddd-0000-4000-8000-0000000000e6", "draft"]]);
  });
});

describe("R11: what a partial read lists is known", () => {
  const OTHER = "cccccccc-0000-4000-8000-0000000000e7";
  test("a running session on a page that is not the last is running (Start withheld for this day); no copy needed", () => {
    expect(
      ids({ drafts: [], read: [session()], complete: false, copy: null }),
    ).toEqual([[COPIED, "read"]]);
  });

  test("a partial page that lists the copied session stopped ends it at once; a copied session it does not list stays", () => {
    expect(
      ids({
        drafts: [],
        read: [session({ stopped_at: T0 / 1000 - 10 })],
        complete: false,
        copy: [copied(), copied({ id: OTHER })],
        readOrder: 5,
        copyOrder: 4,
      }),
    ).toEqual([[OTHER, "copy"]]);
  });

  test("control: the same rows on a complete read later than the copy also retire the unlisted copied session", () => {
    expect(
      ids({
        drafts: [],
        read: [session({ stopped_at: T0 / 1000 - 10 })],
        complete: true,
        copy: [copied(), copied({ id: OTHER })],
        readOrder: 5,
        copyOrder: 4,
      }),
    ).toEqual([]);
  });
});

describe("DA-T1: the copy's correction by a read of one day", () => {
  const row = (id: string, occurrence = OCC) => ({
    access: "available",
    id,
    occurrence_id: occurrence,
  });
  const OTHER = "cccccccc-0000-4000-8000-0000000000e8";
  test("a listed finished session is retired whatever the order; an unlisted one only by a complete, newer read; other days never", () => {
    const partial = copyCorrection(
      OCC,
      [session({ stopped_at: T0 / 1000 - 10 })],
      false,
    );
    expect(partial(row(COPIED), false)).toBe(true);
    expect(partial(row(OTHER), true)).toBe(false);
    const complete = copyCorrection(OCC, [], true);
    expect(complete(row(OTHER), true)).toBe(true);
    expect(complete(row(OTHER), false)).toBe(false);
    expect(complete(row(OTHER, OTHER_DAY), true)).toBe(false);
    expect(complete({ access: "restricted", id: OTHER }, true)).toBe(false);
    // Control: a complete newer read that lists it running keeps it.
    expect(copyCorrection(OCC, [session()], true)(row(COPIED), true)).toBe(
      false,
    );
  });
});
