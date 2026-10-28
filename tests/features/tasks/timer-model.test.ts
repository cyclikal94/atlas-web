// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { TimerSeen } from "../../../src/data";
import {
  cancelTimer,
  startTimer,
  stopTimer,
} from "../../../src/features/tasks/model/commands";
import type {
  AccountTimerSession,
  TimerSession,
} from "../../../src/features/tasks/model/contract";
import {
  copyCorrection,
  endStands,
  keptStands,
  positiveTrusted,
  runningOn,
  stillRunning,
  type TimerAuthority,
} from "../../../src/features/tasks/model/timers";
import { withEndExpectation } from "../../../src/features/tasks/timers/copy";
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

/**
 * Revision 5 (review 5 R23): the account's latest complete observation and the finished sessions decide in `stillRunning` (the account's
 * list) and in `runningOn` (the detail) alike, for every source.
 */
describe("R23: the account's observation and finished sessions, one rule", () => {
  const S = COPIED;
  const base = { scopes: {}, floor: 0 };
  test.each([
    [
      "the account's later complete observation omits it",
      { account: { order: 4, running: [] } },
      3,
      false,
    ],
    [
      "the account's later complete observation lists it",
      { account: { order: 4, running: [S] } },
      3,
      true,
    ],
    [
      "the account's observation is not later (equal)",
      { account: { order: 3, running: [] } },
      3,
      true,
    ],
    [
      "listed finished by any read, whatever its order",
      { ended: new Set([S]) },
      9,
      false,
    ],
    ["listed finished, order unknown", { ended: new Set([S]) }, null, false],
    [
      "order unknown, a finished session lost: not trusted",
      { endedLost: true },
      null,
      false,
    ],
    ["order unknown, nothing lost", { endedLost: false }, null, true],
    [
      "ordered, a finished session lost: the floor decides",
      { endedLost: true },
      3,
      true,
    ],
  ] as const)("%s", (_, extra, order, expected) => {
    const authority = { ...base, ...extra };
    expect(stillRunning(authority, OCC, S, order)).toBe(expected);
    // Restricted (day unknown): the account's evidence decides alike.
    expect(stillRunning(authority, null, S, order)).toBe(expected);
    // The detail: its day's read listing the session running at that order, and the copy listing it, judged by the same evidence.
    const shown = (source: "read" | "copy") =>
      runningOn(OCC, {
        drafts: [],
        read: source === "read" ? [session()] : null,
        complete: false,
        copy: source === "copy" ? [copied()] : null,
        readOrder: source === "read" ? order : null,
        copyOrder: source === "copy" ? order : null,
        copyComplete: false,
        scope: null,
        floor: 0,
        account: "account" in extra ? extra.account : null,
        ended: "ended" in extra ? extra.ended : new Set(),
        endedLost: "endedLost" in extra ? extra.endedLost : false,
      }).map((s) => s.id);
    expect(shown("read")).toEqual(expected ? [S] : []);
    if (order !== null) expect(shown("copy")).toEqual(expected ? [S] : []);
  });
  test("this device's unsettled start stays though a finished listing names another session", () => {
    const start = draftRow({
      kind: "start_timer",
      status: "queued",
      command: {
        command: {
          kind: "start_timer",
          occurrence_id: OCC,
          session_id: "cccccccc-0000-4000-8000-0000000000f9",
          started_at: T0 / 1000 - 5,
        },
      } as never,
    });
    expect(
      runningOn(OCC, {
        drafts: [start as never],
        read: null,
        copy: null,
        ended: new Set([S]),
        endedLost: true,
      }).map((s) => s.source),
    ).toEqual(["draft"]);
  });
});

/**
 * Revision 6 (review 6 R27): the two kinds of loss at their boundaries, for both resolvers and every source. A lost finished session
 * distrusts every positive up to AND INCLUDING its bound (`endedThrough`); a lost complete observation only those strictly below it (the
 * floor); a complete observation's absence at an equal order retires nothing; an exact finished session retires its session at any order;
 * a truly later positive stands; 0 is "nothing lost" (a copy written before the order existed has order 0).
 */
describe("R27: terminal loss is inclusive, absence loss exclusive", () => {
  const S = COPIED;
  test.each([
    [
      "terminal loss n−1, positive n: later, trusted",
      { endedThrough: 4 },
      5,
      true,
    ],
    [
      "terminal loss n, positive n: at the bound, NOT trusted",
      { endedThrough: 5 },
      5,
      false,
    ],
    [
      "terminal loss n+1, positive n: not trusted",
      { endedThrough: 6 },
      5,
      false,
    ],
    ["nothing lost (0), positive 0: trusted", { endedThrough: 0 }, 0, true],
    ["absence lost at n (floor), positive n: trusted", { floor: 5 }, 5, true],
    [
      "absence lost at n+1 (floor), positive n: not trusted",
      { floor: 6 },
      5,
      false,
    ],
    [
      "complete account observation at n omits it, positive n: stands",
      { account: { order: 5, running: [] } },
      5,
      true,
    ],
    [
      "complete account observation at n+1 omits it: retired",
      { account: { order: 6, running: [] } },
      5,
      false,
    ],
    [
      "finished exactly, a later positive: retired",
      { ended: new Set([S]) },
      9,
      false,
    ],
    [
      "terminal loss, order unknown: not trusted",
      { endedLost: true, endedThrough: 3 },
      null,
      false,
    ],
  ] as const)("%s", (_, extra, order, expected) => {
    const authority = { scopes: {}, floor: 0, ...extra };
    // The loss rule alone (no observation or finished listing in the row): it decides exactly.
    if (!("account" in extra) && !("ended" in extra))
      expect(positiveTrusted(authority, order)).toBe(expected);
    expect(stillRunning(authority, OCC, S, order)).toBe(expected);
    expect(stillRunning(authority, null, S, order)).toBe(expected);
    const shown = (source: "read" | "copy") =>
      runningOn(OCC, {
        drafts: [],
        read: source === "read" ? [session()] : null,
        complete: false,
        copy: source === "copy" ? [copied()] : null,
        readOrder: source === "read" ? order : null,
        copyOrder: source === "copy" ? order : null,
        copyComplete: false,
        scope: null,
        floor: "floor" in extra ? extra.floor : 0,
        account: "account" in extra ? extra.account : null,
        ended: "ended" in extra ? extra.ended : new Set(),
        endedLost: "endedLost" in extra ? extra.endedLost : false,
        endedThrough: "endedThrough" in extra ? extra.endedThrough : 0,
      }).map((s) => s.id);
    expect(shown("read")).toEqual(expected ? [S] : []);
    if (order !== null) expect(shown("copy")).toEqual(expected ? [S] : []);
  });

  test("a terminal loss does not hide this device's unsettled start (its draft stands until it settles)", () => {
    const start = draftRow({
      kind: "start_timer",
      status: "queued",
      command: {
        command: {
          kind: "start_timer",
          occurrence_id: OCC,
          session_id: "cccccccc-0000-4000-8000-0000000000f8",
          started_at: T0 / 1000 - 5,
        },
      } as never,
    });
    expect(
      runningOn(OCC, {
        drafts: [start as never],
        read: null,
        copy: null,
        endedLost: true,
        endedThrough: 99,
      }).map((s) => s.source),
    ).toEqual(["draft"]);
  });
});

/**
 * Revision 7 (review 7 R32): what an end of a timer is admitted against, inside the writing transaction (`EnqueueRequest.expectTimer`).
 * The session shown carries the order of the observation it was shown from (`RunningSession.order`); `endStands` judges that against the
 * evidence and the session's drafts as stored then, by the same rules as every screen (`stillRunning`), with this device's own unsettled
 * start standing by itself and an end already on its way refusing another.
 */
describe("R32: an end is admitted against what is stored when it is written", () => {
  const S = COPIED;
  const authority = (extra: Partial<TimerAuthority> = {}): TimerAuthority => ({
    scopes: {},
    floor: 0,
    ...extra,
  });
  const witness = (order: number | null) => ({
    occurrenceId: OCC,
    sessionId: S,
    order,
  });

  test("RunningSession.order is the order of the observation each source was shown from (null for this device's start alone)", () => {
    const start = draftRow({
      kind: "start_timer",
      status: "queued",
      command: {
        command: {
          kind: "start_timer",
          occurrence_id: OCC,
          session_id: "cccccccc-0000-4000-8000-0000000000f9",
          started_at: T0 / 1000 - 5,
        },
      } as never,
    });
    const shown = runningOn(OCC, {
      drafts: [start as never],
      read: [
        {
          id: "cccccccc-0000-4000-8000-0000000000fa",
          occurrence_id: OCC,
          started_at: T0 / 1000 - 60,
          stopped_at: null,
          version: 2,
        },
      ],
      copy: [copied()],
      readOrder: 6,
      copyOrder: 4,
    });
    expect(
      Object.fromEntries(shown.map((s) => [s.id, [s.source, s.order]])),
    ).toEqual({
      [COPIED]: ["copy", 4],
      "cccccccc-0000-4000-8000-0000000000fa": ["read", 6],
      "cccccccc-0000-4000-8000-0000000000f9": ["draft", null],
    });
    // A read with no order is shown with none (never borrowed from another source).
    expect(
      runningOn(OCC, {
        drafts: [],
        read: [
          {
            id: S,
            occurrence_id: OCC,
            started_at: T0 / 1000 - 60,
            stopped_at: null,
            version: 2,
          },
        ],
        copy: [copied()],
        readOrder: null,
        copyOrder: 4,
      }).map((s) => [s.source, s.order]),
    ).toEqual([["read", null]]);
  });

  test.each([
    ["nothing retired it", {}, 5, true],
    ["listed finished", { ended: new Set([S]) }, 5, false],
    [
      "listed finished by its day's scope",
      { scopes: { [OCC]: { order: 1, running: [], ended: [S] } } },
      5,
      false,
    ],
    [
      "a later complete account observation omits it (n+1)",
      { account: { order: 6, running: [] } },
      5,
      false,
    ],
    [
      "an account observation at its own order (n)",
      { account: { order: 5, running: [] } },
      5,
      true,
    ],
    [
      "a later complete day observation omits it",
      { scopes: { [OCC]: { order: 6, running: [], ended: [] } } },
      5,
      false,
    ],
    [
      "another day's observation (unrelated)",
      { scopes: { [OTHER_DAY]: { order: 9, running: [], ended: [] } } },
      5,
      true,
    ],
    ["floor above it (n+1)", { floor: 6 }, 5, false],
    ["floor at it (exclusive)", { floor: 5 }, 5, true],
    ["terminal loss through it (inclusive)", { endedThrough: 5 }, 5, false],
    ["terminal loss below it (n−1)", { endedThrough: 4 }, 5, true],
    ["order unknown, nothing lost", {}, null, true],
    [
      "order unknown, a finished session lost",
      { endedLost: true },
      null,
      false,
    ],
  ] as const)("%s", (_, extra, order, expected) => {
    expect(
      endStands(
        authority(extra as Partial<TimerAuthority>),
        [],
        witness(order),
      ),
    ).toBe(expected);
  });

  test("an end already on its way refuses another (any unsettled stop or discard of the session); a settled one does not", () => {
    for (const kind of ["stop_timer", "cancel_timer"])
      for (const status of ["queued", "in_flight", "blocked", "acknowledged"])
        expect(
          endStands(authority(), [{ kind, status }], witness(5)),
          `${kind} ${status}`,
        ).toBe(false);
    for (const status of ["rejected", "version_conflict"])
      expect(
        endStands(authority(), [{ kind: "stop_timer", status }], witness(5)),
      ).toBe(true);
  });

  test("this device's unsettled start stands by itself against absence and loss (as on screen), never against a finished listing", () => {
    const starting = [{ kind: "start_timer", status: "queued" }];
    for (const extra of [
      { account: { order: 9, running: [] } },
      { floor: 9 },
      { endedThrough: 9, endedLost: true },
    ]) {
      expect(endStands(authority(extra), starting, witness(null))).toBe(true);
      expect(endStands(authority(extra), [], witness(null))).toBe(
        !("endedLost" in extra),
      );
    }
    expect(
      endStands(authority({ ended: new Set([S]) }), starting, witness(null)),
    ).toBe(false);
    // A start that settled (rejected) is no longer this device's own: the server observation decides.
    expect(
      endStands(
        authority({ account: { order: 9, running: [] } }),
        [{ kind: "start_timer", status: "rejected" }],
        witness(5),
      ),
    ).toBe(false);
  });
});

/**
 * Revision 7 (review 7 R32): the end request's precondition, built by the task slice for the writing transaction. The session is the
 * request's OWN version-checked `timer_session` target, so it never names another resource; the transaction's incarnation must be the one
 * the acted-on observation was ordered in; then `endStands` decides on the singleton as stored (decoded by the one decoder).
 */
describe("R32: withEndExpectation", () => {
  const S = COPIED;
  const witness = { occurrenceId: OCC, sessionId: S, order: 5 };
  const input = {
    occurrenceId: OCC,
    sessionId: S,
    progressId: "aaaaaaaa-0000-4000-8000-0000000000e9",
    streamKnown: false,
    knownVersion: 3,
  };
  const seen = (over: Partial<TimerSeen> = {}): TimerSeen => ({
    incarnationId: "inc-1",
    sync: {} as TimerSeen["sync"],
    drafts: [],
    ...over,
  });

  test("Stop, Discard and a 7-day stop carry it, naming their own session; it admits in the incarnation it was shown in only", () => {
    for (const request of [
      stopTimer({ ...input, stoppedAt: T0 / 1000 }),
      cancelTimer(input),
    ]) {
      const built = withEndExpectation(request, witness, "inc-1");
      expect(built.targets).toBe(request.targets);
      expect(built.expectTimer?.session).toBe(S);
      expect(built.expectTimer?.admit(seen())).toBe(true);
      expect(built.expectTimer?.admit(seen({ incarnationId: "inc-2" }))).toBe(
        false,
      );
    }
  });

  test("decided on the singleton as stored: a finished listing refuses; another order's loss decides as on screen", () => {
    const built = withEndExpectation(cancelTimer(input), witness, "inc-1");
    expect(
      built.expectTimer?.admit(
        seen({
          sync: {
            timer_order: 6,
            timer_ended: { lost: false, ids: [[S, 6]], through: 0 },
          } as never,
        }),
      ),
    ).toBe(false);
    expect(
      built.expectTimer?.admit(
        seen({
          sync: {
            timer_order: 6,
            timer_ended: { lost: true, ids: [], through: 4 },
          } as never,
        }),
      ),
    ).toBe(true);
    expect(
      built.expectTimer?.admit(
        seen({
          sync: {
            timer_order: 6,
            timer_ended: { lost: true, ids: [], through: 5 },
          } as never,
        }),
      ),
    ).toBe(false);
  });

  test("never another resource: a request ending another session, or one with no version-checked session (a start), admits nothing", () => {
    const other = withEndExpectation(
      cancelTimer({
        ...input,
        sessionId: "cccccccc-0000-4000-8000-0000000000fb",
      }),
      witness,
      "inc-1",
    );
    expect(other.expectTimer?.admit(seen())).toBe(false);
    const start = withEndExpectation(
      startTimer({
        occurrenceId: OCC,
        sessionId: S,
        progressId: input.progressId,
        startedAt: T0 / 1000,
        firstAnyoneStream: false,
        defaults: null,
      }),
      witness,
      "inc-1",
    );
    expect(start.expectTimer?.admit(seen())).toBe(false);
  });
});
