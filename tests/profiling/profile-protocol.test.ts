import { describe, expect, it } from "vitest";
import type { ProfileRun } from "../../src/fixture/data-harness/profile-page";
import {
  admission,
  compareAndSet,
  complete,
  decide,
  type Envelope,
  exportResults,
  type KeyValue,
  MANUAL_KEY,
  mayClear,
  newEnvelope,
  type Permit,
  PROTOCOL_KEY,
  permitProblem,
  readEnvelope,
  recoverInterrupted,
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
      schema: 2,
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
      error: "not a schema-2 protocol envelope",
    });
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

  it("case: a structurally inconsistent schema-2 envelope is corrupt: nothing runs, nothing is started over it", () => {
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
        error: expect.stringContaining("inconsistent schema-2 envelope"),
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
});
