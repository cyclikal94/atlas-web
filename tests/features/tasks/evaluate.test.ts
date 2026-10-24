// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  Evidence,
  Goal,
  OccurrenceData,
  ProgressState,
  TaskDefinition,
} from "../../../src/features/tasks/model/contract";
import {
  actionable,
  aggregate,
  eligible,
  evaluate,
  finalise,
  inDayView,
  layer,
  personalResult,
  scheduledOn,
} from "../../../src/features/tasks/model/evaluate";

/**
 * The evaluation mirror (A3/A4; TASK-20/21, TASK-31). The first describe transcribes the server's own unit vectors
 * (`crates/core/tests/cases/tasks/domain.rs` at v0.28.0-rc.1), cited per case; the rest pins the offline reapplication of ARCH §3.3c.
 */
const ME = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const I1 = "00000000-0000-4000-8000-000000000001";
const I2 = "00000000-0000-4000-8000-000000000002";
const q = (amount: string): Evidence => ({ kind: "quantity", amount });
const tick = (complete: boolean): Evidence => ({ kind: "checkbox", complete });
const atLeast = (minimum: string, unit = "u"): Goal => ({
  kind: "numeric",
  minimum,
  maximum: null,
  unit,
});
const atMost = (maximum: string, unit = "u"): Goal => ({
  kind: "numeric",
  minimum: null,
  maximum,
  unit,
});
const checklist: Goal = {
  kind: "checklist",
  items: [
    { id: I1, label: "First" },
    { id: I2, label: "Second" },
  ],
};

describe("server vectors (domain.rs)", () => {
  test("exact_quantities_and_explicit_observation", () => {
    expect(evaluate(atLeast("0.3"), [q("0.1"), q("0.2")], false)).toEqual({
      outcome: "complete",
      amount: "0.3",
      checked: [],
    });
    expect(evaluate(atMost("2"), [], true)?.outcome).toBe("unknown");
    expect(evaluate(atMost("2"), [{ kind: "observe" }], false)?.outcome).toBe(
      "provisional",
    );
    expect(evaluate(atMost("2"), [{ kind: "observe" }], true)?.outcome).toBe(
      "complete",
    );
    expect(evaluate(atMost("2"), [q("3")], true)?.outcome).toBe("missed");
  });

  test("checklist_corrections_and_goal_snapshots", () => {
    const entries: Evidence[] = [
      { kind: "checklist", item_id: I1, complete: true },
      { kind: "checklist", item_id: I2, complete: true },
    ];
    expect(evaluate(checklist, entries, false)?.outcome).toBe("complete");
    expect(
      evaluate(
        checklist,
        [...entries, { kind: "checklist", item_id: I1, complete: false }],
        false,
      )?.outcome,
    ).toBe("incomplete");
    expect(evaluate(checklist, [q("1")], false)).toBeNull();
    expect(evaluate(atLeast("3"), [q("3")], true)?.outcome).toBe("complete");
    expect(evaluate(atLeast("5"), [q("3")], true)?.outcome).toBe("missed");
  });

  test("joint_progress_is_unknown_when_a_stream_is_hidden (aggregate: documentation only, never shown)", () => {
    expect(
      aggregate({ kind: "checkbox" }, "everyone", [[tick(true)], null], true),
    ).toBe("unknown");
    expect(
      aggregate({ kind: "checkbox" }, "anyone", [[tick(true)], null], true),
    ).toBe("complete");
    expect(
      aggregate(
        { kind: "checkbox" },
        "everyone",
        [[tick(true)], [tick(true)]],
        true,
      ),
    ).toBe("complete");
    expect(aggregate(atLeast("3"), "pooled", [[q("1")], [q("2")]], true)).toBe(
      "complete",
    );
    expect(aggregate(atLeast("3"), "pooled", [[q("3")], []], true)).toBe(
      "unknown",
    );
  });

  test("an unobserved closed window: missed for checkbox, checklist and minimum-only; unknown for a maximum", () => {
    expect(evaluate({ kind: "checkbox" }, [], true)?.outcome).toBe("missed");
    expect(evaluate(checklist, [], true)?.outcome).toBe("missed");
    expect(evaluate(atLeast("1"), [], true)?.outcome).toBe("missed");
    expect(evaluate(atMost("1"), [], true)?.amount).toBeNull();
    expect(
      evaluate(
        { kind: "numeric", minimum: "1", maximum: "3", unit: "u" },
        [],
        true,
      )?.outcome,
    ).toBe("unknown");
  });

  test("zero quantity and observe are observations; the last checkbox value wins; overflow is refused", () => {
    expect(evaluate(atMost("2"), [q("0")], false)).toEqual({
      outcome: "provisional",
      amount: "0",
      checked: [],
    });
    expect(
      evaluate({ kind: "checkbox" }, [tick(true), tick(false)], false)?.outcome,
    ).toBe("incomplete");
    expect(
      evaluate(atLeast("1"), [q("1000000000000"), q("1")], false),
    ).toBeNull();
  });
});

describe("offline finalisation maps the STORED outcome (TASK-31 #1)", () => {
  const goals: Goal[] = [
    { kind: "checkbox" },
    checklist,
    atLeast("2"),
    atMost("2"),
    { kind: "numeric", minimum: "1", maximum: "3", unit: "u" },
  ];
  const sequences: Evidence[][] = [
    [],
    [q("1")],
    [q("2")],
    [q("4")],
    [{ kind: "observe" }],
    [tick(true)],
    [tick(false)],
    [{ kind: "checklist", item_id: I1, complete: true }],
  ];
  test("finalise(evaluate(open)) equals evaluate(closed) for every goal and every fitting sequence", () => {
    for (const goal of goals)
      for (const entries of sequences) {
        const open = evaluate(goal, entries, false);
        if (open === null) continue;
        expect(
          finalise(open.outcome, goal, true),
          JSON.stringify({ goal, entries }),
        ).toBe(evaluate(goal, entries, true)?.outcome);
        expect(finalise(open.outcome, goal, false)).toBe(open.outcome);
      }
  });

  test("the nine-against-eight counterexample: recent_entries cannot be re-evaluated, the stored outcome can (TASK-31 #2)", () => {
    const goal = atMost("8");
    const nine = Array.from({ length: 9 }, () => q("1"));
    const stored = evaluate(goal, nine, false);
    expect(stored?.outcome).toBe("incomplete");
    // What the eight synced recent entries alone would say, which is wrong:
    expect(evaluate(goal, nine.slice(1), true)?.outcome).toBe("complete");
    expect(finalise(stored?.outcome ?? "unknown", goal, true)).toBe("missed");
    expect(
      finalise(
        evaluate(goal, nine.slice(0, 3), false)?.outcome ?? "unknown",
        goal,
        true,
      ),
    ).toBe("complete");
  });
});

const definition = (over: Partial<TaskDefinition> = {}): TaskDefinition => ({
  schedule: {
    start_date: "2026-09-08",
    time: null,
    timezone: "Europe/London",
    repeat: null,
  },
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "personal",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: false,
  ...over,
});
const T0 = Date.parse("2026-09-08T00:00:00+01:00") / 1000;
const occ = (
  over: Partial<OccurrenceData> = {},
  def: Partial<TaskDefinition> = {},
): OccurrenceData => ({
  task_id: "00000000-0000-4000-8000-000000000010",
  definition: definition(def),
  slot: {
    key: "once",
    date: "2026-09-08",
    intended_time: null,
    timezone: "Europe/London",
    instant: null,
  },
  opens_at: T0,
  closes_at: T0 + 86_400,
  participants: [ME],
  covered_by: null,
  resolved: false,
  ...over,
});
const stream = (
  summary: ProgressState["action"],
  over: Partial<ProgressState> = {},
): ProgressState => ({
  subject_account_id: ME,
  recent_entries: [],
  entry_count: 0,
  excluded: false,
  action: summary,
  period: summary,
  aggregate_consent: true,
  ...over,
});
const unknown = { outcome: "unknown" as const, amount: null, checked: [] };

describe("my personal result (ARCH §3.3c, in order)", () => {
  const during = (T0 + 3_600) * 1000;
  const after = (T0 + 2 * 86_400) * 1000;

  test("covered comes BEFORE excluded (a covered participant is incomplete, then missed)", () => {
    const data = occ(
      { covered_by: "00000000-0000-4000-8000-000000000099" },
      { allow_streak_exclusions: true },
    );
    const excluded = stream(unknown, { excluded: true });
    expect(
      personalResult({
        occurrence: data,
        stream: excluded,
        pending: [],
        streamPending: false,
        me: ME,
        nowMs: during,
      }),
    ).toMatchObject({ outcome: "incomplete" });
    expect(
      personalResult({
        occurrence: data,
        stream: excluded,
        pending: [],
        streamPending: false,
        me: ME,
        nowMs: after,
      }),
    ).toMatchObject({ outcome: "missed" });
  });

  test("excluded only with the policy on", () => {
    const s = stream(unknown, { excluded: true });
    expect(
      personalResult({
        occurrence: occ({}, { allow_streak_exclusions: true }),
        stream: s,
        pending: [],
        streamPending: false,
        me: ME,
        nowMs: during,
      }),
    ).toMatchObject({ outcome: "excluded" });
    expect(
      personalResult({
        occurrence: occ(),
        stream: s,
        pending: [],
        streamPending: false,
        me: ME,
        nowMs: during,
      }),
    ).toMatchObject({ outcome: "unknown" });
  });

  test("an absent stream is never a confident absence: listed or Anyone → unavailable; not listed → none", () => {
    expect(
      personalResult({
        occurrence: occ(),
        stream: null,
        pending: [],
        streamPending: false,
        me: ME,
        nowMs: during,
      }).kind,
    ).toBe("unavailable");
    expect(
      personalResult({
        occurrence: occ({ participants: [OTHER] }),
        stream: null,
        pending: [],
        streamPending: false,
        me: ME,
        nowMs: during,
      }).kind,
    ).toBe("none");
    expect(
      personalResult({
        occurrence: occ({ participants: [OTHER] }, { participation: "anyone" }),
        stream: null,
        pending: [],
        streamPending: false,
        me: ME,
        nowMs: during,
      }).kind,
    ).toBe("unavailable");
  });

  test("a late completion: provisional finalises to complete, incomplete to missed, once the window closes (lifecycle.rs late fixture)", () => {
    const goal = atMost("2");
    const done = stream({ outcome: "provisional", amount: "1", checked: [] });
    expect(
      personalResult({
        occurrence: occ({}, { goal }),
        stream: done,
        pending: [],
        streamPending: false,
        me: ME,
        nowMs: after,
      }),
    ).toMatchObject({ outcome: "complete" });
    const part = stream({ outcome: "incomplete", amount: "0", checked: [] });
    expect(
      personalResult({
        occurrence: occ({}, { goal: atLeast("2") }),
        stream: part,
        pending: [],
        streamPending: false,
        me: ME,
        nowMs: after,
      }),
    ).toMatchObject({ outcome: "missed" });
  });

  test("pending evidence is layered onto the summary and marked provisional", () => {
    const r = personalResult({
      occurrence: occ(),
      stream: stream(unknown),
      pending: [
        {
          entryId: I1,
          evidence: tick(true),
          happenedAt: T0 + 60,
          replaces: null,
        },
      ],
      streamPending: false,
      me: ME,
      nowMs: during,
    });
    expect(r).toMatchObject({
      kind: "result",
      outcome: "complete",
      provisional: true,
      stale: false,
    });
  });
});

describe("layering pending evidence (point 5)", () => {
  const window = { opensAt: T0, closesAt: T0 + 86_400 };
  test("quantities add in micro-units; only in-window entries count towards the period", () => {
    const base = {
      action: { outcome: "incomplete" as const, amount: "0.1", checked: [] },
      period: { outcome: "incomplete" as const, amount: "0.1", checked: [] },
      recent_entries: [],
      entry_count: 1,
    };
    const out = layer(
      base,
      atLeast("0.3"),
      [
        {
          entryId: I1,
          evidence: q("0.2"),
          happenedAt: T0 + 10,
          replaces: null,
        },
        {
          entryId: I2,
          evidence: q("5"),
          happenedAt: T0 + 90_000,
          replaces: null,
        },
      ],
      window,
    );
    expect(out.action).toMatchObject({ outcome: "complete", amount: "5.3" });
    expect(out.period).toMatchObject({ outcome: "complete", amount: "0.3" });
    expect(out.exact).toBe(true);
  });

  test("a checklist item set and cleared", () => {
    const out = layer(
      null,
      checklist,
      [
        {
          entryId: I1,
          evidence: { kind: "checklist", item_id: I1, complete: true },
          happenedAt: T0 + 1,
          replaces: null,
        },
        {
          entryId: I2,
          evidence: { kind: "checklist", item_id: I2, complete: true },
          happenedAt: T0 + 2,
          replaces: null,
        },
        {
          entryId: "e3",
          evidence: { kind: "checklist", item_id: I1, complete: false },
          happenedAt: T0 + 3,
          replaces: null,
        },
      ],
      window,
    );
    expect(out.action).toMatchObject({ outcome: "incomplete", checked: [I2] });
  });

  test("a correction is exact only when the whole stream is known (≤ 8 entries); otherwise stale", () => {
    const entries = [
      { id: "e1", evidence: q("5"), happened_at: T0 + 1, recorded_by: ME },
    ];
    const known = {
      action: { outcome: "incomplete" as const, amount: "5", checked: [] },
      period: { outcome: "incomplete" as const, amount: "5", checked: [] },
      recent_entries: entries,
      entry_count: 1,
    };
    const fixed = layer(
      known,
      atMost("2"),
      [{ entryId: "e2", evidence: q("1"), happenedAt: T0 + 2, replaces: "e1" }],
      window,
    );
    expect(fixed).toMatchObject({
      exact: true,
      action: { outcome: "provisional", amount: "1" },
    });
    const long = { ...known, entry_count: 9 };
    expect(
      layer(
        long,
        atMost("2"),
        [
          {
            entryId: "e2",
            evidence: q("1"),
            happenedAt: T0 + 2,
            replaces: "e1",
          },
        ],
        window,
      ).exact,
    ).toBe(false);
  });
});

describe("actionable, eligibility and day membership", () => {
  const now = (T0 + 60) * 1000;
  test("close_incomplete is not actionable after closes_at; the other carries stay actionable", () => {
    const late = (T0 + 2 * 86_400) * 1000;
    expect(
      actionable(occ(), { eligible: true, outcome: "incomplete", nowMs: late }),
    ).toBe(false);
    expect(
      actionable(occ({}, { carry: "retain_one" }), {
        eligible: true,
        outcome: "incomplete",
        nowMs: late,
      }),
    ).toBe(true);
    expect(
      actionable(occ(), { eligible: true, outcome: "complete", nowMs: now }),
    ).toBe(false);
    expect(
      actionable(occ({ resolved: true }), {
        eligible: true,
        outcome: null,
        nowMs: now,
      }),
    ).toBe(false);
    expect(
      actionable(occ({ opens_at: T0 + 3_600 }), {
        eligible: true,
        outcome: null,
        nowMs: now,
      }),
    ).toBe(false);
  });

  test("Anyone with occurrence can_edit is eligible without a stream; a fixed roster is not", () => {
    expect(
      eligible(occ({}, { participation: "anyone" }), {
        streamPresent: false,
        canEdit: true,
      }),
    ).toBe(true);
    expect(
      eligible(occ({}, { participation: "everyone" }), {
        streamPresent: false,
        canEdit: true,
      }),
    ).toBe(false);
    expect(
      eligible(occ({}, { participation: "anyone" }), {
        streamPresent: false,
        canEdit: false,
      }),
    ).toBe(false);
  });

  test("a timed slot belongs to the day of its INSTANT in the display zone, not to slot.date", () => {
    const instant = Date.parse("2026-09-08T23:30:00Z") / 1000;
    const timed = occ({
      slot: {
        key: "2026-09-08T23:30:00",
        date: "2026-09-08",
        intended_time: "23:30:00",
        timezone: "UTC",
        instant,
      },
    });
    expect(scheduledOn(timed, "2026-09-09", "Europe/London")).toBe(true);
    expect(scheduledOn(timed, "2026-09-08", "Europe/London")).toBe(false);
    expect(
      scheduledOn(
        occ({
          slot: {
            key: "once",
            date: null,
            intended_time: null,
            timezone: "UTC",
            instant: null,
          },
        }),
        "2026-09-08",
        "UTC",
      ),
    ).toBe(false);
    expect(
      inDayView(
        occ({
          opens_at: null,
          closes_at: null,
          slot: {
            key: "once",
            date: null,
            intended_time: null,
            timezone: "UTC",
            instant: null,
          },
        }),
        "2026-09-08",
        "UTC",
        true,
      ),
    ).toBe(true);
  });
});
