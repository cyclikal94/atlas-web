// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  A,
  enumerate,
  expectsStale,
  type Params,
  runScenario,
} from "../support/data/stamp-world";

/**
 * F-S1 to F-S5, F-S8 (plan 8.2): the commit guard over the fake world. The scenarios are the PRODUCT of transition kind x
 * position x hints x commit completion (normal, late, unfinished) x database state, counted and asserted.
 *
 * REVISION (R2): the product commits behind the PERSISTENCE HOLD (a shared `atlas-auth` lock plus the verdict at the durable
 * record, kept until the data transaction completes), and every transition of the runner is settled under the exclusive lock, as
 * every settlement of the real record is. The properties below are checked with the hold, where NO stale commit is applied in any
 * cell, including every cell in which this page is never told of the transition. The same matrix is also run WITHOUT the hold, as
 * the contrast that keeps the residual window of plan 5.2.3 visible: that window is exactly what the hold closes.
 */
const ALL = enumerate();

describe("F-S5: the schedule product is enumerated", () => {
  test("the matrix runner counts its scenarios", () => {
    // 8 transitions x 4 positions x (hints: 3 for the three `other_*`, else 1) x 3 completions, on an open database,
    // plus 4 other database states x 4 positions x 3 completions with no transition.
    const hintsCount = 3 * 3 + 5 * 1;
    expect(ALL.filter((p) => p.db === "open")).toHaveLength(4 * hintsCount * 3);
    expect(ALL.filter((p) => p.db !== "open")).toHaveLength(4 * 4 * 3);
    expect(ALL).toHaveLength(4 * hintsCount * 3 + 4 * 4 * 3);
    expect(new Set(ALL.map((p) => JSON.stringify(p))).size).toBe(ALL.length);
  });
});

describe("F-S1, F-S2, F-S3, F-S8: every scenario satisfies the properties", () => {
  const outcomes = new Map<string, Awaited<ReturnType<typeof runScenario>>>();
  test("no scenario violates C1, C2, C3 or the dropped-writes-nothing rule", async () => {
    const bad: string[] = [];
    for (const params of ALL) {
      const outcome = await runScenario(params);
      outcomes.set(JSON.stringify(params), outcome);
      for (const violation of outcome.violations)
        bad.push(`${JSON.stringify(params)}: ${violation}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  test("F-S3: with notices delivered promptly there is NO stale commit, in any position or kind", () => {
    const stale = [...outcomes.values()].filter(
      (o) => o.params.hint === "delivered" && o.staleApplied,
    );
    expect(stale.map((o) => o.params)).toEqual([]);
  });

  test("F-S3 (revised, R2): another page's re-authentication, never told to this page, drops the response at the verdict of the record (the epoch mirror still stands behind it, below)", () => {
    const reauth = [...outcomes.values()].filter(
      (o) =>
        o.params.transition === "other_reauth" &&
        o.params.position === "before_g2" &&
        o.params.hint !== "delivered" &&
        o.params.completion === "normal",
    );
    expect(reauth).toHaveLength(2);
    for (const o of reauth) {
      expect(o.result).toBe("dropped");
      expect(o.reason).toBe("identity_changed");
      expect(o.keyWrittenInA).toBe(false);
    }
  });

  test("F-S4 (revised, R2): with the persistence hold NO commit is applied after a transition that was settled before it, in ANY cell, including every cell in which this page is never told", () => {
    expect(
      [...outcomes.values()].filter((o) => o.staleApplied).map((o) => o.params),
    ).toEqual([]);
    // The cells that used to be the window: another page's transition, no notice (absent or delayed), the commit not yet created or
    // queued behind the settlement. Every one is dropped or ordered before the transition.
    const formerWindow = [...outcomes.values()].filter(
      (o) =>
        o.params.db === "open" &&
        o.params.transition.startsWith("other_") &&
        o.params.hint !== "delivered" &&
        (o.params.position === "before_g2" || o.params.position === "queued"),
    );
    expect(formerWindow.length).toBeGreaterThan(0);
    for (const o of formerWindow) expect(o.staleApplied).toBe(false);
  });

  test("R2: the reviewer's reproduction (another page signs out, this page is never told, the commit starts afterwards) is DROPPED", async () => {
    const o = await runScenario({
      transition: "other_signout",
      position: "before_g2",
      hint: "absent",
      completion: "normal",
      db: "open",
    });
    expect(o.result).toBe("dropped");
    expect(o.reason).toBe("identity_changed");
    expect(o.keyWrittenInA).toBe(false);
    expect(o.violations).toEqual([]);
  });

  test("R2: a commit that is queued or executing when another page's transition is requested persists FIRST: the transition waits for the hold", async () => {
    for (const transition of [
      "other_switch",
      "other_reauth",
      "other_signout",
    ] as const)
      for (const position of ["queued", "executed"] as const) {
        const o = await runScenario({
          transition,
          position,
          hint: "absent",
          completion: "normal",
          db: "open",
        });
        expect(o.staleApplied, `${transition} ${position}`).toBe(false);
        // Ordered before the transition: A's own key landed, in A's own database.
        expect(o.keyWrittenInA, `${transition} ${position}`).toBe(true);
        expect(o.foreignWrites).toEqual([]);
        expect(o.violations).toEqual([]);
      }
  });

  test("R2 (revision 7): a commit that is still outstanding after the hold's bound AND the stall report keeps the lock, whether its data is durable (the completion is late) or not yet (the engine is still committing): no transition is ordered ahead of it, in any kind or position", async () => {
    for (const completion of ["late", "unfinished"] as const)
      for (const transition of [
        "self_switch",
        "self_reauth",
        "self_signout",
        "other_switch",
        "other_reauth",
        "other_signout",
        "wipe",
      ] as const)
        for (const position of ["queued", "executed", "completed"] as const) {
          const o = await runScenario({
            transition,
            position,
            hint: "absent",
            completion,
            db: "open",
          });
          const cell = `${completion} ${transition} ${position}`;
          expect(o.staleApplied, cell).toBe(false);
          // Ordered before the transition: the commit landed in A's own database.
          if (transition !== "wipe") expect(o.keyWrittenInA, cell).toBe(true);
          expect(o.violations, cell).toEqual([]);
        }
  });

  test("R2 (revision 7): the unfinished commit is the cell the earlier revision got wrong: its data lands AFTER the bound and the stall report, and it must still land before the transition", async () => {
    const o = await runScenario({
      transition: "other_signout",
      position: "queued",
      hint: "absent",
      completion: "unfinished",
      db: "open",
    });
    expect(o.result).toBe("applied");
    expect(o.keyWrittenInA).toBe(true);
    expect(o.staleApplied).toBe(false);
    expect(o.violations).toEqual([]);
  });

  test("F-S2: nothing re-creates a deleted database, or lands in another incarnation", () => {
    for (const o of outcomes.values()) {
      if (o.params.db === "deleted" || o.params.transition === "wipe")
        expect(o.aExists, JSON.stringify(o.params)).toBe(false);
      if (o.params.db === "recreated") {
        expect(o.keyWrittenInA, JSON.stringify(o.params)).toBe(false);
        expect(o.incarnation.final).not.toBe(o.incarnation.captured);
      }
    }
  });

  test("F-S1: a commit never lands in the other account's database", () => {
    for (const o of outcomes.values())
      expect(o.foreignWrites, JSON.stringify(o.params)).toEqual([]);
  });

  test("F-S8: the typed reason of a dropped commit is a member of the closed set", () => {
    const allowed = new Set([
      "identity_changed",
      "incarnation",
      "closing",
      "position",
      "generation",
      "owner",
      "epoch_superseded",
      "closed",
      "unverified",
    ]);
    for (const o of outcomes.values())
      if (o.result === "dropped")
        expect(allowed.has(o.reason ?? ""), JSON.stringify(o.params)).toBe(
          true,
        );
  });
});

describe("the contrast: the same matrix WITHOUT the persistence hold (the residual window of plan 5.2.3)", () => {
  test("it is CHARACTERISED, not claimed away: it happens exactly in the stated window and writes exactly A's own page into A's own database", async () => {
    const outcomes = [];
    // An unfinished commit lands after a transition that nothing ordered ahead of it: that is the very thing the hold is for, and
    // `expectsStale` states the plan's window for commits whose data is durable when they are outstanding.
    for (const params of ALL.filter((p) => p.completion !== "unfinished"))
      outcomes.push(
        await runScenario(params, undefined, undefined, { persistence: false }),
      );
    const stale = outcomes.filter((o) => o.staleApplied);
    expect(stale.length).toBeGreaterThan(0);
    for (const o of stale) {
      expect(expectsStale(o.params, { persistence: false })).toBe(true);
      expect(o.foreignWrites).toEqual([]);
      expect(o.aExists).toBe(true);
      expect(o.incarnation.final).toBe(o.incarnation.captured);
    }
    // And it is exactly the set the plan says (nothing else is stale; nothing the plan says is stale is missed).
    expect(
      outcomes.filter(
        (o) =>
          expectsStale(o.params, { persistence: false }) !== o.staleApplied,
      ),
    ).toEqual([]);
    expect(outcomes.flatMap((o) => o.violations)).toEqual([]);
  }, 120_000);
});

describe("named scenarios (each a distinct reason)", () => {
  const base: Params = {
    transition: "none",
    position: "before_g2",
    hint: "delivered",
    completion: "normal",
    db: "open",
  };
  test("a commit with no transition is applied", async () => {
    const o = await runScenario(base);
    expect(o.result).toBe("applied");
    expect(o.keyWrittenInA).toBe(true);
  });
  test("a same-page sign-in as B is dropped at G2 (identity_changed) and nothing reaches B", async () => {
    const o = await runScenario({ ...base, transition: "self_switch" });
    expect([o.result, o.reason, o.keyWrittenInA, o.foreignWrites]).toEqual([
      "dropped",
      "identity_changed",
      false,
      [],
    ]);
  });
  test("a same-account re-authentication on this page is dropped at G2", async () => {
    const o = await runScenario({ ...base, transition: "self_reauth" });
    expect([o.result, o.reason]).toEqual(["dropped", "identity_changed"]);
  });
  test("a commit queued behind another transaction when this page's own sign-in as B is requested persists FIRST (the settlement waits for the hold), and nothing reaches B", async () => {
    const o = await runScenario({
      ...base,
      transition: "self_switch",
      position: "queued",
    });
    expect([
      o.result,
      o.keyWrittenInA,
      o.staleApplied,
      o.foreignWrites,
    ]).toEqual(["applied", true, false, []]);
  });
  test("WITHOUT the hold the same cell is dropped by the latch inside the transaction (the layered guard of plan 5.2.2)", async () => {
    const o = await runScenario(
      { ...base, transition: "self_switch", position: "queued" },
      undefined,
      undefined,
      { persistence: false },
    );
    expect([o.result, o.reason, o.keyWrittenInA]).toEqual([
      "dropped",
      "closed",
      false,
    ]);
  });
  test("WITHOUT the hold, another page's re-authentication is still learnt through the published epoch mirror (defence in depth)", async () => {
    const o = await runScenario(
      {
        ...base,
        transition: "other_reauth",
        hint: "absent",
      },
      undefined,
      undefined,
      { persistence: false },
    );
    expect([o.result, o.reason, o.keyWrittenInA]).toEqual([
      "dropped",
      "epoch_superseded",
      false,
    ]);
  });
  test("a recreated database (a new incarnation) refuses a response captured under the old one", async () => {
    const o = await runScenario({ ...base, db: "recreated" });
    expect([o.result, o.reason, o.keyWrittenInA]).toEqual([
      "dropped",
      "incarnation",
      false,
    ]);
  });
  test("a closing database refuses it", async () => {
    const o = await runScenario({ ...base, db: "closing" });
    expect([o.result, o.reason]).toEqual(["dropped", "closing"]);
  });
  test("a deleted database is not re-created by the late commit", async () => {
    const o = await runScenario({ ...base, db: "deleted" });
    expect([o.result, o.reason, o.aExists]).toEqual([
      "dropped",
      "closed",
      false,
    ]);
  });
  test("WITHOUT the hold (a deployment that did not supply it): the residual window of plan 5.2.3 is what remains: another page signs out, this page is not told, the commit is applied to A's own database", async () => {
    const o = await runScenario(
      { ...base, transition: "other_signout", hint: "absent" },
      undefined,
      undefined,
      { persistence: false },
    );
    expect([o.result, o.staleApplied, o.foreignWrites, o.aExists]).toEqual([
      "applied",
      true,
      [],
      true,
    ]);
  });
  test("WITH the hold the same cell is dropped, and writes nothing", async () => {
    const o = await runScenario({
      ...base,
      transition: "other_signout",
      hint: "absent",
    });
    expect([o.result, o.reason, o.keyWrittenInA, o.foreignWrites]).toEqual([
      "dropped",
      "identity_changed",
      false,
      [],
    ]);
  });
  test("a confirmed wipe by another page closes this page's connections: the late commit is dropped and nothing is re-created", async () => {
    const o = await runScenario({
      ...base,
      transition: "wipe",
      position: "queued",
    });
    expect([o.result, o.reason, o.aExists]).toEqual([
      "dropped",
      "closed",
      false,
    ]);
  });
  test("the account is A in the fixtures", () => {
    expect(A).toMatch(/^aaaaaaaa/);
  });
});
