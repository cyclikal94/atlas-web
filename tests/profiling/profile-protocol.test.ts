import { describe, expect, it } from "vitest";
import type { ProfileRun } from "../../src/fixture/data-harness/profile-page";
import {
  admission,
  type Collections,
  captureDecision,
  compareAndSet,
  complete,
  decide,
  type Envelope,
  exportDiagnostic,
  exportResults,
  type KeyValue,
  MANUAL_KEY,
  mayClear,
  newEnvelope,
  nextUnusedRun,
  type Permit,
  PROTOCOL_KEY,
  permitProblem,
  readEnvelope,
  recoverAbandoned,
  recoverInterrupted,
  recoveryTarget,
  reserve,
  tabToken,
  takeOver,
} from "../../src/fixture/data-harness/profile-protocol";

/**
 * The device page's protocol state (WEB-09c revision 2, design assessment DA-1; qualification Q10 to Q12): every persistence boundary,
 * a second tab, a refused or failed write, an unreadable envelope and the explicit take-over. Storage is a test double that can refuse a
 * write and that is "reloaded" by reading it again: a page that dies between two writes leaves exactly what the first one stored.
 */
function store(): KeyValue & { refuse: boolean; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    refuse: false,
    getItem: (k) => map.get(k) ?? null,
    setItem(k, v) {
      if (this.refuse) throw new DOMException("quota", "QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}
const PLAN = [
  { name: "W1", run: 1 },
  { name: "W2", run: 1 },
  { name: "W7-truncated", run: 1 },
];
// An OWNERSHIP-ONLY fixture (revision 12, design assessment DA-H1): these cases test the envelope's reservation, persistence and recovery,
// never whether an outcome is evidence; the semantic admission of a run is tested in validator.test.ts and profile-device-run.test.ts.
const result = (name: string, run: number, outcome = "admitted"): ProfileRun =>
  ({ workload: name, run, outcome }) as unknown as ProfileRun;
const killed = (name: string, run: number) => result(name, run, "killed");
const start = (s: KeyValue, owner = "tab-a") =>
  compareAndSet(
    s,
    PROTOCOL_KEY,
    null,
    newEnvelope({
      kind: "protocol",
      protocolId: "p-1",
      owner,
      workloadVersion: 1,
      w2sha256: "a".repeat(64),
      plan: PLAN,
      machine: {},
      now: "t0",
    }),
  );
const read = (s: KeyValue) => readEnvelope(s, PROTOCOL_KEY);
// Revision 3: an unexpected state is an assertion failure of the case (never a thrown error that hides which expectation failed).
const present = (s: KeyValue) => {
  const r = read(s);
  expect(r.state, JSON.stringify(r).slice(0, 200)).toBe("present");
  return r as Extract<ReturnType<typeof read>, { state: "present" }>;
};
/** One attempt as the page drives it: reserve (one write), run, store (one write). `dieAfter` stops after a write. */
function attempt(
  s: KeyValue,
  owner: string,
  dieAfter?: "reserve",
): "reserved" | "stored" | "refused" {
  const r = present(s);
  const d = decide(r, owner);
  if (d.action !== "ready") return "refused";
  const e = d.envelope;
  const next = e.plan[e.next];
  if (!next) return "refused";
  const reserved = compareAndSet(
    s,
    PROTOCOL_KEY,
    r.raw,
    reserve(e, e.next, next, "page", "t1"),
  );
  if (!reserved.ok) return "refused";
  if (dieAfter === "reserve") return "reserved";
  const before = present(s);
  const stored = compareAndSet(
    s,
    PROTOCOL_KEY,
    before.raw,
    complete(before.envelope, result(next.name, next.run), "t2"),
  );
  return stored.ok ? "stored" : "refused";
}
/** The owner's next load: an interrupted reservation is recorded as killed, once. */
function recover(s: KeyValue, owner: string): boolean {
  const r = present(s);
  const d = decide(r, owner);
  if (d.action !== "recover" || !d.envelope.reserved) return false;
  const { name, run } = d.envelope.reserved;
  return compareAndSet(
    s,
    PROTOCOL_KEY,
    r.raw,
    recoverInterrupted(d.envelope, killed(name, run), "t3"),
  ).ok;
}

describe("the device page's protocol state", () => {
  it("control: three attempts, one write to reserve and one to store each, end complete with every run of one protocol", () => {
    const s = store();
    expect(start(s).ok).toBe(true);
    for (let i = 0; i < 3; i += 1) expect(attempt(s, "tab-a")).toBe("stored");
    const e = present(s).envelope;
    expect(e.terminal).toBe("complete");
    expect(e.runs.map((r) => [r.workload, r.outcome, r.protocol_id])).toEqual([
      ["W1", "admitted", "p-1"],
      ["W2", "admitted", "p-1"],
      ["W7-truncated", "admitted", "p-1"],
    ]);
    expect(decide(read(s), "tab-a").action).toBe("terminal");
    expect(exportResults(e)).toMatchObject({
      schema: 4,
      protocol_id: "p-1",
      planned_runs: 3,
    });
  });

  it("case: a reload at every boundary (after the reservation, after the result) records each attempt exactly once and skips none", () => {
    for (let dies = 0; dies < PLAN.length; dies += 1) {
      const s = store();
      start(s);
      for (let i = 0; i < PLAN.length; i += 1) {
        if (i === dies) {
          expect(attempt(s, "tab-a", "reserve")).toBe("reserved");
          // The page died: the next load of the owner finds the reservation.
          expect(decide(read(s), "tab-a").action).toBe("recover");
          expect(recover(s, "tab-a")).toBe(true);
          // Recovering again is not possible: it was one write, and there is no reservation left.
          expect(recover(s, "tab-a")).toBe(false);
        } else expect(attempt(s, "tab-a")).toBe("stored");
      }
      const e = present(s).envelope;
      expect(e.terminal).toBe("complete");
      expect(e.runs.map((r) => r.workload)).toEqual(PLAN.map((p) => p.name));
      expect(e.runs.map((r) => r.outcome)).toEqual(
        PLAN.map((_, i) => (i === dies ? "killed" : "admitted")),
      );
    }
  });

  it("case: the LAST attempt interrupted is recovered and the protocol still completes", () => {
    const s = store();
    start(s);
    attempt(s, "tab-a");
    attempt(s, "tab-a");
    attempt(s, "tab-a", "reserve");
    expect(recover(s, "tab-a")).toBe(true);
    expect(present(s).envelope.terminal).toBe("complete");
    expect(present(s).envelope.runs).toHaveLength(3);
  });

  it("case: a second tab (another owner token), a plain menu page included, can neither run, recover, clear nor delete", () => {
    const s = store();
    start(s, "tab-a");
    attempt(s, "tab-a", "reserve");
    const before = s.getItem(PROTOCOL_KEY);
    expect(decide(read(s), "tab-b").action).toBe("foreign");
    expect(attempt(s, "tab-b")).toBe("refused");
    expect(recover(s, "tab-b")).toBe(false);
    expect(mayClear(read(s), "tab-b")).toMatchObject({ ok: false });
    expect(mayClear(read(s), "tab-a")).toMatchObject({
      ok: false,
      why: expect.stringContaining("in progress"),
    });
    expect(s.getItem(PROTOCOL_KEY)).toBe(before);
  });

  it("case: a write over a collection that changed since it was read (another writer, a clear, a take-over) is refused, nothing written", () => {
    const s = store();
    start(s);
    const stale = present(s);
    expect(attempt(s, "tab-a")).toBe("stored");
    const now = s.getItem(PROTOCOL_KEY);
    const late = compareAndSet(
      s,
      PROTOCOL_KEY,
      stale.raw,
      reserve(
        stale.envelope,
        0,
        PLAN[0] as { name: string; run: number },
        "late",
        "t9",
      ),
    );
    expect(late).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed since this page read it"),
    });
    expect(s.getItem(PROTOCOL_KEY)).toBe(now);
    const cleared = store();
    start(cleared);
    const held = present(cleared);
    cleared.removeItem(PROTOCOL_KEY);
    expect(
      compareAndSet(cleared, PROTOCOL_KEY, held.raw, held.envelope).ok,
    ).toBe(false);
    expect(cleared.getItem(PROTOCOL_KEY)).toBeNull();
  });

  it("case: a refused write (quota, denied) stops the protocol with its error and leaves the stored evidence as it was", () => {
    const s = store();
    start(s);
    attempt(s, "tab-a");
    const before = s.getItem(PROTOCOL_KEY);
    s.refuse = true;
    const r = present(s);
    const written = compareAndSet(
      s,
      PROTOCOL_KEY,
      r.raw,
      reserve(
        r.envelope,
        1,
        PLAN[1] as { name: string; run: number },
        "p",
        "t",
      ),
    );
    expect(written).toMatchObject({
      ok: false,
      error: expect.stringContaining("storage refused the write"),
    });
    expect(s.getItem(PROTOCOL_KEY)).toBe(before);
  });

  it("case: an unreadable or foreign-schema envelope is corrupt: nothing runs, nothing is started over it", () => {
    const s = store();
    s.setItem(PROTOCOL_KEY, "{not json");
    expect(decide(read(s), "tab-a").action).toBe("corrupt");
    expect(start(s).ok).toBe(false);
    expect(s.getItem(PROTOCOL_KEY)).toBe("{not json");
    s.setItem(PROTOCOL_KEY, JSON.stringify({ schema: 1, runs: [] }));
    expect(read(s)).toMatchObject({
      state: "corrupt",
      error: "not a schema-4 protocol envelope",
    });
    // Revision 10: a whole schema-2 envelope (stored before first commits were recorded) is history: unusable, left byte for byte.
    // Revision 12: so is a whole schema-3 one (stored before observations and effects); its attempts are never spliced into schema 4.
    for (const schema of [2, 3]) {
      const started = store();
      start(started);
      const old = JSON.stringify({
        ...JSON.parse(started.getItem(PROTOCOL_KEY) as string),
        schema,
      });
      s.setItem(PROTOCOL_KEY, old);
      expect(read(s)).toMatchObject({
        state: "corrupt",
        error: "not a schema-4 protocol envelope",
      });
      expect(decide(read(s), "tab-a").action).toBe("corrupt");
      expect(start(s).ok).toBe(false);
      expect(s.getItem(PROTOCOL_KEY)).toBe(old);
    }
  });

  it("case: a completed collection is never started over; only an explicit clear (allowed then) makes room", () => {
    const s = store();
    start(s);
    for (let i = 0; i < 3; i += 1) attempt(s, "tab-a");
    expect(start(s).ok).toBe(false);
    expect(mayClear(read(s), "tab-b")).toMatchObject({ ok: true });
  });

  it("case: the explicit take-over moves ownership once and is recorded; the old owner is then foreign", () => {
    const s = store();
    start(s, "tab-a");
    attempt(s, "tab-a", "reserve");
    const r = present(s);
    expect(
      compareAndSet(s, PROTOCOL_KEY, r.raw, takeOver(r.envelope, "tab-b", "t5"))
        .ok,
    ).toBe(true);
    expect(decide(read(s), "tab-a").action).toBe("foreign");
    expect(decide(read(s), "tab-b").action).toBe("recover");
    expect(recover(s, "tab-b")).toBe(true);
    const e: Envelope = present(s).envelope;
    expect(e.takeovers).toEqual([{ at: "t5", from: "tab-a", to: "tab-b" }]);
    expect(e.runs.map((x) => x.outcome)).toEqual(["killed"]);
  });

  // ---- revision 3 (review 3 R5; design assessment B1-B4, D1, D4, D9) --------------------------------------------------------------
  it("case: an active protocol refuses every manual run, a reserved manual attempt refuses a protocol start, and an unreadable envelope blocks both", () => {
    const s = store();
    const manualRead = () => readEnvelope(s, MANUAL_KEY);
    expect(admission("manual", read(s), manualRead())).toEqual({ ok: true });
    expect(admission("protocol", read(s), manualRead())).toEqual({
      ok: true,
    });
    start(s, "tab-a");
    // Whoever asks (the owner's own tab, or a copy of its token): an active protocol admits no manual run.
    expect(admission("manual", read(s), manualRead())).toMatchObject({
      ok: false,
      why: expect.stringContaining("p-1 is active on this origin"),
    });
    // A finished protocol does not block a manual run.
    for (let i = 0; i < 3; i += 1) attempt(s, "tab-a");
    expect(admission("manual", read(s), manualRead())).toEqual({ ok: true });
    // A manual attempt still reserved (running, or interrupted and not yet recorded) refuses a protocol start; an idle history does not.
    const m = store();
    const manual = newEnvelope({
      kind: "manual",
      protocolId: "manual-1",
      owner: "tab-a",
      workloadVersion: 1,
      w2sha256: null,
      plan: [],
      machine: {},
      now: "t0",
    });
    m.setItem(MANUAL_KEY, JSON.stringify(manual));
    expect(admission("protocol", read(m), readEnvelope(m, MANUAL_KEY))).toEqual(
      { ok: true },
    );
    m.setItem(
      MANUAL_KEY,
      JSON.stringify(reserve(manual, 0, { name: "W3", run: 1 }, "p", "t1")),
    );
    expect(
      admission("protocol", read(m), readEnvelope(m, MANUAL_KEY)),
    ).toMatchObject({
      ok: false,
      why: expect.stringContaining("manual attempt (W3 run 1) is reserved"),
    });
    // An unreadable envelope of either kind blocks both routes until it is cleared explicitly.
    const c = store();
    c.setItem(MANUAL_KEY, "{torn");
    for (const route of ["protocol", "manual"] as const)
      expect(
        admission(route, read(c), readEnvelope(c, MANUAL_KEY)),
      ).toMatchObject({
        ok: false,
        why: expect.stringContaining("manual collection is unreadable"),
      });
  });

  it("case: a result is stored only into the very reservation its page made: a clear, a re-creation, a take-over or another reservation in between leaves it unstored", () => {
    const reserved = () => {
      const s = store();
      start(s, "tab-a");
      const r = present(s);
      const e = reserve(
        r.envelope,
        0,
        PLAN[0] as { name: string; run: number },
        "page-1",
        "t1",
      );
      expect(compareAndSet(s, PROTOCOL_KEY, r.raw, e).ok).toBe(true);
      const permit: Permit = {
        protocol_id: e.protocol_id,
        owner: "tab-a",
        reservation: e.reserved as NonNullable<Envelope["reserved"]>,
      };
      return { s, permit };
    };
    // Control: nothing changed in between, so the permit holds and the result is stored once.
    const ok = reserved();
    expect(permitProblem(read(ok.s), ok.permit)).toBeNull();
    // Cleared.
    const cleared = reserved();
    cleared.s.removeItem(PROTOCOL_KEY);
    expect(permitProblem(read(cleared.s), cleared.permit) ?? "").toMatch(
      /cleared/,
    );
    // Cleared and created again (another collection in its place).
    const again = reserved();
    again.s.removeItem(PROTOCOL_KEY);
    start(again.s, "tab-a");
    const other = present(again.s);
    again.s.setItem(
      PROTOCOL_KEY,
      JSON.stringify({ ...other.envelope, protocol_id: "p-2" }),
    );
    expect(permitProblem(read(again.s), again.permit) ?? "").toMatch(
      /another collection/,
    );
    // Taken over (the reservation itself is unchanged, the owner is not).
    const taken = reserved();
    const t = present(taken.s);
    taken.s.setItem(
      PROTOCOL_KEY,
      JSON.stringify(takeOver(t.envelope, "tab-b", "t5")),
    );
    expect(permitProblem(read(taken.s), taken.permit) ?? "").toMatch(
      /owner changed/,
    );
    // The reservation recovered by another load and the same attempt reserved again by another page.
    const moved = reserved();
    const mv = present(moved.s);
    moved.s.setItem(
      PROTOCOL_KEY,
      JSON.stringify({
        ...mv.envelope,
        reserved: { ...mv.envelope.reserved, page: "page-2", at: "t2" },
      }),
    );
    expect(permitProblem(read(moved.s), moved.permit) ?? "").toMatch(
      /no longer holds the reservation/,
    );
  });

  it("case: a result is never appended to a collection that holds no reservation (no unreserved fallback)", () => {
    const s = store();
    start(s);
    const e = present(s).envelope;
    expect(() => complete(e, result("W1", 1), "t2")).toThrow(
      /no reserved attempt/,
    );
  });

  it("case: a structurally inconsistent schema-4 envelope is corrupt: nothing runs, nothing is started over it", () => {
    const s = store();
    start(s);
    attempt(s, "tab-a");
    const good = present(s).envelope;
    const variants: Array<[string, Partial<Envelope>]> = [
      ["next past its results", { next: 2 }],
      [
        "a result that is not the planned attempt",
        {
          runs: [result("W7-truncated", 1)],
        },
      ],
      [
        "a result stored twice",
        {
          runs: [result("W1", 1), result("W1", 1)],
          next: 2,
        },
      ],
      [
        "a reservation that is not the next attempt",
        {
          reserved: { name: "W1", run: 1, index: 0, at: "t", page: "p" },
        },
      ],
      ["a finished protocol with attempts left", { terminal: "complete" }],
      [
        "an unfinished protocol with none left",
        {
          plan: [{ name: "W1", run: 1 }],
        },
      ],
      [
        "a malformed take-over record",
        {
          takeovers: [{ at: "t" } as never],
        },
      ],
      ["a capture that is not a SHA-256", { w2sha256: "abc" }],
    ];
    for (const [what, patch] of variants) {
      s.setItem(PROTOCOL_KEY, JSON.stringify({ ...good, ...patch }));
      const r = read(s);
      expect(r, what).toMatchObject({
        state: "corrupt",
        error: expect.stringContaining("inconsistent schema-4 envelope"),
      });
      expect(decide(r, "tab-a").action, what).toBe("corrupt");
    }
  });

  it("the owner token is the tab's own: kept across its reloads, never another tab's", () => {
    const tabA = store();
    const tabB = store();
    let n = 0;
    const make = () => `token-${++n}`;
    expect(tabToken(tabA, make)).toBe("token-1");
    expect(tabToken(tabA, make)).toBe("token-1");
    expect(tabToken(tabB, make)).toBe("token-2");
  });

  // ---- Revision 4 (review 4 R5, design assessment B1-B6; Q-M1-Q-M5, Q-F1) ------------------------------------------------------------
  const manualEnvelope = (owner: string, w2: string | null = null) =>
    newEnvelope({
      kind: "manual",
      protocolId: "manual-1",
      owner,
      workloadVersion: 1,
      w2sha256: w2,
      plan: [],
      machine: {},
      now: "t0",
    });
  const startManual = (s: KeyValue, owner: string, w2: string | null = null) =>
    compareAndSet(s, MANUAL_KEY, null, manualEnvelope(owner, w2));
  const both = (s: KeyValue): Collections => ({
    protocol: readEnvelope(s, PROTOCOL_KEY),
    manual: readEnvelope(s, MANUAL_KEY),
  });
  const kill = (r: { name: string; run: number }) => killed(r.name, r.run);
  /** A decision's reason, or what it did instead (always a string, so a wrong action fails the assertion, never a TypeError). */
  const whyOf = (d: ReturnType<typeof captureDecision>) =>
    d.action === "refuse" ? d.why : `(${d.action})`;
  const presentAt = (s: KeyValue, key: string) => {
    const r = readEnvelope(s, key);
    expect(r.state, JSON.stringify(r).slice(0, 200)).toBe("present");
    return r as Extract<ReturnType<typeof read>, { state: "present" }>;
  };

  it("case (B3): a write of an inconsistent envelope - a duplicate result, a result beside its reservation - is refused and nothing is written", () => {
    const s = store();
    expect(startManual(s, "tab-a").ok).toBe(true);
    const r0 = presentAt(s, MANUAL_KEY);
    const one = complete(
      reserve(r0.envelope, 0, { name: "W3", run: 1 }, "page", "t1"),
      result("W3", 1),
      "t2",
    );
    expect(compareAndSet(s, MANUAL_KEY, r0.raw, one).ok).toBe(true);
    const r1 = presentAt(s, MANUAL_KEY);
    // The R5a schedule: the same identity reserved and stored again after its interrupted attempt was recorded.
    const again = complete(
      reserve(r1.envelope, 1, { name: "W3", run: 1 }, "page", "t3"),
      result("W3", 1),
      "t4",
    );
    const refused = compareAndSet(s, MANUAL_KEY, r1.raw, again);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error).toMatch(
      /inconsistent \(the result W3#1 is stored twice\): nothing was written/,
    );
    expect(s.map.get(MANUAL_KEY)).toBe(r1.raw);
  });

  it("case (B3): the next unused manual run skips every recorded and reserved run of that workload, gaps included", () => {
    expect(nextUnusedRun(null, "W3")).toBe(1);
    const e = {
      ...manualEnvelope("tab-a"),
      runs: [result("W3", 1), result("W3", 3), result("W4", 2)],
      next: 3,
      reserved: { name: "W3", run: 2, index: 3, at: "t", page: "p" },
    } as Envelope;
    expect(nextUnusedRun(e, "W3")).toBe(4);
    expect(nextUnusedRun(e, "W4")).toBe(1);
  });

  it("case (B2): recovering a gone tab's manual collection moves it once, records its reserved attempt as ONE killed result in the same write, and keeps its id, results and pin", () => {
    const s = store();
    expect(startManual(s, "tab-a", "b".repeat(64)).ok).toBe(true);
    const r0 = presentAt(s, MANUAL_KEY);
    const ran = complete(
      reserve(r0.envelope, 0, { name: "W3", run: 1 }, "page-a", "t1"),
      result("W3", 1),
      "t2",
    );
    expect(compareAndSet(s, MANUAL_KEY, r0.raw, ran).ok).toBe(true);
    const r1 = presentAt(s, MANUAL_KEY);
    const held = reserve(
      r1.envelope,
      1,
      { name: "W2", run: 1 },
      "page-a",
      "t3",
    );
    expect(compareAndSet(s, MANUAL_KEY, r1.raw, held).ok).toBe(true);
    const before = presentAt(s, MANUAL_KEY);
    // Tab B: the target is the manual collection (the only one that needs it), never "nothing is active".
    const t = recoveryTarget(both(s), "tab-b", "auto");
    expect(t.ok && t.kind).toBe("manual");
    const writes: string[] = [];
    const counting = {
      ...s,
      setItem: (k: string, v: string) => {
        writes.push(k);
        s.setItem(k, v);
      },
    };
    const moved = compareAndSet(
      counting,
      MANUAL_KEY,
      before.raw,
      recoverAbandoned(before.envelope, "tab-b", "t4", kill),
    );
    expect(moved.ok).toBe(true);
    expect(writes).toEqual([MANUAL_KEY]);
    const after = presentAt(s, MANUAL_KEY).envelope;
    expect(after.protocol_id).toBe("manual-1");
    expect(after.w2sha256).toBe("b".repeat(64));
    expect(after.owner).toBe("tab-b");
    expect(after.reserved).toBeNull();
    expect(after.runs.map((r) => [r.workload, r.run, r.outcome])).toEqual([
      ["W3", 1, "admitted"],
      ["W2", 1, "killed"],
    ]);
    expect(after.takeovers).toEqual([{ at: "t4", from: "tab-a", to: "tab-b" }]);
    // Nothing left to recover: a second recovery cannot add a second killed result.
    const t2 = recoveryTarget(both(s), "tab-b", "auto");
    expect(t2.ok).toBe(false);
    expect(t2.ok ? "" : t2.why).toMatch(/nothing to take over or recover/);
    expect(recoverAbandoned(after, "tab-b", "t5", kill).runs.length).toBe(2);
  });

  it("case (B2): the owner's own interrupted attempt is recorded as killed without a take-over; an idle gone tab's collection only moves", () => {
    const s = store();
    expect(startManual(s, "tab-a").ok).toBe(true);
    const r0 = presentAt(s, MANUAL_KEY);
    const held = reserve(r0.envelope, 0, { name: "W3", run: 1 }, "p", "t1");
    const own = recoverAbandoned(held, "tab-a", "t2", kill);
    expect(own.takeovers).toEqual([]);
    expect(own.runs.map((r) => r.outcome)).toEqual(["killed"]);
    const idle = recoverAbandoned(r0.envelope, "tab-b", "t3", kill);
    expect(idle.runs).toEqual([]);
    expect(idle.takeovers).toEqual([{ at: "t3", from: "tab-a", to: "tab-b" }]);
  });

  it("case (B1): the recovery target is the named collection, or the ONLY one that needs it; two need a choice, an unreadable one is never guessed past", () => {
    const s = store();
    expect(start(s, "tab-a").ok).toBe(true);
    expect(startManual(s, "tab-a").ok).toBe(true);
    const two = recoveryTarget(both(s), "tab-b", "auto");
    expect(two.ok).toBe(false);
    expect(two.ok ? "" : two.why).toMatch(
      /two collections can be taken over \(protocol p-1, manual manual-1\): choose one/,
    );
    const named = recoveryTarget(both(s), "tab-b", "manual");
    expect(named.ok && named.key).toBe(MANUAL_KEY);
    const mine = recoveryTarget(both(s), "tab-a", "protocol");
    expect(mine.ok ? "" : mine.why).toMatch(
      /already owns protocol collection p-1/,
    );
    expect(recoveryTarget(both(s), "tab-a", "auto").ok).toBe(false);
    s.map.set(MANUAL_KEY, "{torn");
    const torn = recoveryTarget(both(s), "tab-b", "auto");
    expect(torn.ok ? "" : torn.why).toMatch(/manual collection is unreadable/);
    s.map.delete(MANUAL_KEY);
    const finished = presentAt(s, PROTOCOL_KEY);
    s.map.set(
      PROTOCOL_KEY,
      JSON.stringify({ ...finished.envelope, terminal: "error", error: "x" }),
    );
    const done = recoveryTarget(both(s), "tab-b", "protocol");
    expect(done.ok ? "" : done.why).toMatch(
      /is error: there is nothing to take over/,
    );
  });

  it("case (B5): a picked capture never replaces a pin silently: another tab's pinned collection, a protocol without W2, another file and two different pins of this tab are refused unless the target is chosen", () => {
    const H1 = "1".repeat(64);
    const H2 = "2".repeat(64);
    const s = store();
    // No collection: the capture is kept.
    expect(captureDecision(both(s), "tab-a", H1, "auto").action).toBe("keep");
    // An idle manual collection that pins nothing does not hold the pick.
    expect(startManual(s, "tab-b").ok).toBe(true);
    expect(captureDecision(both(s), "tab-a", H1, "auto").action).toBe("keep");
    s.map.clear();
    // Another tab's manual collection pins H1: refused for this tab until a take-over.
    expect(startManual(s, "tab-b", H1).ok).toBe(true);
    const foreign = captureDecision(both(s), "tab-a", H1, "auto");
    expect(whyOf(foreign)).toMatch(
      /another tab owns manual collection manual-1, which pins a W2 capture/,
    );
    // This tab's manual collection pins H1: the same file restores it, another is refused.
    const restored = captureDecision(both(s), "tab-b", H1, "auto");
    expect(
      restored.action === "restore" && restored.restored.map((r) => r.kind),
    ).toEqual(["manual"]);
    const other = captureDecision(both(s), "tab-b", H2, "auto");
    expect(whyOf(other)).toMatch(/pins W2 capture 1{64}/);
    // And a protocol of this tab pinning H2 beside it: two different pins need a target; the target restores its own and names the other.
    const p = newEnvelope({
      kind: "protocol",
      protocolId: "p-2",
      owner: "tab-b",
      workloadVersion: 1,
      w2sha256: H2,
      plan: PLAN,
      machine: {},
      now: "t0",
    });
    expect(compareAndSet(s, PROTOCOL_KEY, null, p).ok).toBe(true);
    const ambiguous = captureDecision(both(s), "tab-b", H2, "auto");
    expect(whyOf(ambiguous)).toMatch(/pin different W2 captures/);
    const chosen = captureDecision(both(s), "tab-b", H2, "protocol");
    expect(chosen.action).toBe("restore");
    if (chosen.action === "restore") {
      expect(chosen.restored.map((r) => r.kind)).toEqual(["protocol"]);
      expect(chosen.displaced.map((r) => r.kind)).toEqual(["manual"]);
    }
    expect(captureDecision(both(s), "tab-b", H1, "protocol").action).toBe(
      "refuse",
    );
    // A protocol without W2 never takes a capture.
    s.map.clear();
    const plain = newEnvelope({
      kind: "protocol",
      protocolId: "p-3",
      owner: "tab-b",
      workloadVersion: 1,
      w2sha256: null,
      plan: PLAN,
      machine: {},
      now: "t0",
    });
    expect(compareAndSet(s, PROTOCOL_KEY, null, plain).ok).toBe(true);
    const none = captureDecision(both(s), "tab-b", H1, "auto");
    expect(whyOf(none)).toMatch(/has no W2, and its plan never changes/);
    s.map.set(MANUAL_KEY, "{torn");
    expect(captureDecision(both(s), "tab-b", H1, "auto").action).toBe("refuse");
  });

  it("case (B5): a collection's diagnostic export carries its owner, next attempt and reservation, and an unreadable one its raw text", () => {
    const s = store();
    expect(startManual(s, "tab-a").ok).toBe(true);
    const r0 = presentAt(s, MANUAL_KEY);
    const held = reserve(r0.envelope, 0, { name: "W3", run: 1 }, "p", "t1");
    expect(compareAndSet(s, MANUAL_KEY, r0.raw, held).ok).toBe(true);
    expect(exportDiagnostic(readEnvelope(s, MANUAL_KEY))).toMatchObject({
      kind: "manual",
      protocol_id: "manual-1",
      owner: "tab-a",
      next: 0,
      reserved: { name: "W3", run: 1, index: 0 },
    });
    s.map.set(MANUAL_KEY, "{torn");
    expect(exportDiagnostic(readEnvelope(s, MANUAL_KEY))).toMatchObject({
      raw: "{torn",
    });
    expect(exportDiagnostic(readEnvelope(s, PROTOCOL_KEY))).toBeNull();
  });
});
