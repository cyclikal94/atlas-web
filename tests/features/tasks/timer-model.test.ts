// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  AccountTimerSession,
  TimerSession,
} from "../../../src/features/tasks/model/contract";
import {
  copyCorrection,
  keptStands,
  runningOn,
  stillRunning,
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

/**
 * Revision 3 (review R14, design assessment DA-T3): the same rule in the other direction and across pages. A COMPLETE account list (the
 * copy, every row read) or a complete read of the day in any page (its scope) at a LATER order retires a session an earlier read of the
 * day saw running and that it does not list; a finished session in the day's scope is never running; a day's read below the floor is not
 * trusted for what it saw running.
 */
describe("R14 and DA-T3: later complete observations retire what an earlier read of the day saw", () => {
  const read = [session()];
  test("REVIEW3 T4's rule: a later complete copy not listing it retires the earlier read's session; listing it keeps it", () => {
    const base = { drafts: [], read, complete: true, readOrder: 3 };
    expect(
      ids({ ...base, copy: [], copyOrder: 4, copyComplete: true }),
    ).toEqual([]);
    expect(
      ids({ ...base, copy: [copied()], copyOrder: 4, copyComplete: true }),
    ).toEqual([[COPIED, "read"]]);
  });

  test("a partial copy, an equal or earlier copy, an unknown order or a copy whose rows did not all read retire nothing", () => {
    const base = { drafts: [], read, complete: false, readOrder: 3 };
    // A partial account list (or one that lost a row to the parser) proves no absence.
    expect(
      ids({ ...base, copy: [], copyOrder: 4, copyComplete: false }),
    ).toEqual([[COPIED, "read"]]);
    // Same order (no tie decides), an earlier copy, either order unknown.
    for (const [readOrder, copyOrder] of [
      [4, 4],
      [5, 4],
      [null, 4],
      [3, null],
    ] as const)
      expect(
        ids({
          ...base,
          readOrder,
          copy: [],
          copyOrder,
          copyComplete: true,
        }),
      ).toEqual([[COPIED, "read"]]);
  });

  test("a restricted row of the later copy still lists the session (it stays, from the read); it never offers it from the copy", () => {
    expect(
      ids({
        drafts: [],
        read,
        complete: true,
        readOrder: 3,
        copy: [
          {
            access: "restricted",
            id: COPIED,
            started_at: T0 / 1000 - 600,
            stopped_at: null,
            version: 3,
          } as AccountTimerSession,
        ],
        copyOrder: 4,
        copyComplete: true,
      }),
    ).toEqual([[COPIED, "read"]]);
  });

  test("this device's unsettled start stays whatever a later complete copy omits; a stop on its way still takes a session out", () => {
    const start = draftRow({
      local_id: "70000000-0000-4000-8000-0000000000e1",
      kind: "start_timer",
      status: "queued",
      command: {
        command: {
          kind: "start_timer",
          occurrence_id: OCC,
          session_id: COPIED,
          started_at: T0 / 1000 - 60,
        },
      } as never,
    });
    expect(
      ids({
        drafts: [start],
        read: null,
        copy: [],
        copyOrder: 9,
        copyComplete: true,
      }),
    ).toEqual([[COPIED, "draft"]]);
  });

  test("DA-T3: a later complete read of the day in any page retires it; listing it keeps it; an earlier one decides nothing", () => {
    const base = { drafts: [], read, complete: true, readOrder: 5, copy: null };
    expect(
      ids({ ...base, scope: { order: 6, running: [], ended: [] } }),
    ).toEqual([]);
    expect(
      ids({ ...base, scope: { order: 6, running: [COPIED], ended: [] } }),
    ).toEqual([[COPIED, "read"]]);
    expect(
      ids({ ...base, scope: { order: 5, running: [], ended: [] } }),
    ).toEqual([[COPIED, "read"]]);
    // A copied session the day's later scope does not list is retired too (the copy was earlier).
    expect(
      ids({
        drafts: [],
        read: null,
        copy: [copied()],
        copyOrder: 2,
        scope: { order: 6, running: [], ended: [] },
      }),
    ).toEqual([]);
  });

  test("DA-T3: a session the day's scope lists finished is never running, whatever the orders", () => {
    expect(
      ids({
        drafts: [],
        read,
        complete: false,
        readOrder: 9,
        copy: [copied()],
        copyOrder: 9,
        scope: { order: 0, running: [], ended: [COPIED] },
      }),
    ).toEqual([]);
  });

  test("the floor: a day's read issued before it is not trusted for a running session; at or after it, or unordered, it is", () => {
    const base = { drafts: [], read, complete: false, copy: null };
    expect(ids({ ...base, readOrder: 3, floor: 4 })).toEqual([]);
    expect(ids({ ...base, readOrder: 4, floor: 4 })).toEqual([
      [COPIED, "read"],
    ]);
    expect(ids({ ...base, readOrder: null, floor: 4 })).toEqual([
      [COPIED, "read"],
    ]);
    // Revision 4 (review R19, T6): the floor is loss information about EVERY source. Revision 3 asserted here that it was not the copy's
    // rule ("the copy is corrected where it is written"), which a refused scope behind another day's fence showed false: below the
    // floor the copy is not trusted either; at or after it, it is.
    const copyOnly = { drafts: [], read: null, copy: [copied()] };
    expect(ids({ ...copyOnly, copyOrder: 1, floor: 4 })).toEqual([]);
    expect(ids({ ...copyOnly, copyOrder: 4, floor: 4 })).toEqual([
      [COPIED, "copy"],
    ]);
    expect(ids({ ...copyOnly, copyOrder: null, floor: 4 })).toEqual([
      [COPIED, "copy"],
    ]);
  });
});

describe("DA-T3: a kept read belongs to the database it was ordered in", () => {
  test("another incarnation bound: it does not stand; the same one, none known or none bound: it does; none kept: nothing", () => {
    expect(keptStands({ incarnation: "a" }, "b")).toBe(false);
    expect(keptStands({ incarnation: "a" }, "a")).toBe(true);
    expect(keptStands({ incarnation: null }, "b")).toBe(true);
    expect(keptStands({ incarnation: "a" }, null)).toBe(true);
    expect(keptStands(null, "a")).toBe(false);
  });
});

/**
 * Revision 4 (review R19): the rule every consumer applies to a server-derived running session (the copy, the account's live list, a day's
 * read), against ONE snapshot of every day's scope and the floor.
 */
describe("R19: stillRunning, one rule for every source", () => {
  const A = "dddddddd-0000-4000-8000-0000000000a1";
  const B = "dddddddd-0000-4000-8000-0000000000b1";
  const S = "cccccccc-0000-4000-8000-0000000000f1";
  const of = (
    scopes: Record<
      string,
      { order: number; running: string[]; ended: string[] }
    >,
    floor = 0,
  ) => ({ scopes, floor });
  test.each([
    ["no scope, no floor", of({}), A, 3, true],
    [
      "its day's later complete read omits it",
      of({ [A]: { order: 4, running: [], ended: [] } }),
      A,
      3,
      false,
    ],
    [
      "its day's later complete read lists it",
      of({ [A]: { order: 4, running: [S], ended: [] } }),
      A,
      3,
      true,
    ],
    [
      "its day's read is not later (equal)",
      of({ [A]: { order: 3, running: [], ended: [] } }),
      A,
      3,
      true,
    ],
    [
      "ANOTHER day's later read (T5)",
      of({ [B]: { order: 9, running: [], ended: [] } }),
      A,
      3,
      true,
    ],
    [
      "listed finished, whatever the orders",
      of({ [A]: { order: 0, running: [], ended: [S] } }),
      A,
      9,
      false,
    ],
    ["seen below the floor (T6)", of({}, 4), A, 3, false],
    ["seen at the floor", of({}, 4), A, 4, true],
    [
      "order unknown: only a finished listing retires it",
      of({ [A]: { order: 9, running: [], ended: [] } }, 99),
      A,
      null,
      true,
    ],
    [
      "order unknown, listed finished",
      of({ [A]: { order: 0, running: [], ended: [S] } }),
      A,
      null,
      false,
    ],
    [
      "restricted (day unknown): the floor alone",
      of({ [A]: { order: 9, running: [], ended: [S] } }, 2),
      null,
      3,
      true,
    ],
    ["restricted below the floor", of({}, 4), null, 3, false],
  ] as const)("%s", (_, authority, day, order, expected) => {
    expect(stillRunning(authority, day, S, order)).toBe(expected);
  });
  test("authority not read yet (loading, or the store failed): no ordered positive is trusted; an unordered one stands", () => {
    expect(stillRunning(null, A, S, 3)).toBe(false);
    expect(stillRunning(null, A, S, null)).toBe(true);
  });
});
