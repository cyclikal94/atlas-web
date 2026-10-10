// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../src/data/engine/quota-guard";
import { digestOf } from "../../src/data/model/canonical";
import { DATA_CONFIG } from "../../src/data/model/config";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { FormRecoveryRow } from "../../src/data/model/types";
import { setClosing } from "../../src/data/plans/fence";
import { claimFormWriter } from "../../src/data/plans/form-recovery";
import {
  createFormRecoveryPort,
  RECOVERY_ALLOWANCE_BYTES,
  recoveryWriteBytes,
} from "../../src/data/ports/form-recovery";
import type { RecoverySnapshot } from "../../src/lib/form-recovery/port";
import { DataTestWorld } from "../support/data/env";
import { fakeOrigin } from "../support/data/origin-ledger";

/**
 * R33 (revision 18): recovery writes are admitted for what they store, and nothing is created before it is.
 *
 * The review of revision 17 found, with the production port, plans and guard, that (1) the port sized only `snapshot.values` while it
 * stored the form context, the tab id, the timestamp and the row's metadata as well, so a 900,000-character context and a one-character
 * value were SAVED with 500,000 bytes of room above the floor; (2) the claim of a writer generation wrote an empty terminal row, carrying
 * that context, BEFORE the guard was asked, so a refused save left it behind, and below the floor even an ordinary short context created
 * a record; and (3) the port copied the caller's still-mutable snapshot after it had been admitted, so a title changed from one character
 * to 900,000 while the guard was asked was stored (3,794,304 bytes left of the 4,194,304-byte floor).
 *
 * The invariants: what is admitted is what is written (the capture is copied when `save` is called, and that copy is sized, reserved and
 * written), the WHOLE row and its keys are sized, and the claim that orders the page contexts (R1) creates no row; the first row of a form
 * is the save that was admitted, and a discard of a form that has none is admitted the same way. The estimate is the origin's, injected;
 * the ledger is the model of the origin's: PROTOCOL evidence, no native quota is exhausted.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NAME = accountDatabaseName(ACCOUNT);
const FLOOR = DATA_CONFIG.quotaReserveBytes / 2;
const FORM = "task-edit:42";
const TAB = "tab-a";
const NOW = "2026-10-01T12:00:00.000Z";
const SAVED_AT = "2026-10-01T09:00:00.000Z";

const snap = (
  values: Record<string, string>,
  formContext = FORM,
  tabInstanceId = TAB,
): RecoverySnapshot => ({
  formContext,
  tabInstanceId,
  values,
  savedAt: SAVED_AT,
});

/** The row the port will write for `snapshot` (its order record is the widest in the estimate). */
const rowFor = (snapshot: RecoverySnapshot): FormRecoveryRow => ({
  form_context: snapshot.formContext,
  tab_instance_id: snapshot.tabInstanceId,
  fields: { ...snapshot.values },
  redacted: [],
  saved_at: snapshot.savedAt,
  capture_seq: 0,
  writer_gen: 0,
  terminal: false,
  content_digest: digestOf(snapshot.values),
});

async function world() {
  const env = new DataTestWorld();
  env.idb.autoDrive = true;
  const page = env.page("A");
  page.identity.account = ACCOUNT;
  const opened = await page.open(ACCOUNT, { create: true });
  if (opened.kind !== "opened") throw new Error("setup");
  const store = opened.store;
  const reload = async () => {
    const again = await page.open(ACCOUNT);
    if (again.kind !== "opened") throw new Error("setup: reload");
    return again.store;
  };
  const rows = () =>
    (env.idb.snapshot(NAME)?.form_recovery ?? []) as FormRecoveryRow[];
  const counter = () =>
    (
      (env.idb.snapshot(NAME)?.sync_state ?? []) as Array<{
        form_writer_gen?: number;
      }>
    )[0]?.form_writer_gen;
  const portOver = (on: typeof store, quota?: QuotaGuard) =>
    createFormRecoveryPort({
      service: () => ({ store: on, incarnationId: on.incarnationId }) as never,
      now: () => NOW,
      ...(quota === undefined ? {} : { quota }),
    });
  return { env, store, reload, rows, counter, portOver };
}

/** A guard over an estimate of `free` bytes (nothing used) and a ledger of its own. */
const guardOf = (free: number, name = "form"): QuotaGuard =>
  createQuotaGuard({
    storage: { estimate: async () => ({ usage: 0, quota: free }) },
    now: () => 100_000,
    ledger: fakeOrigin().page(name).ledger,
  });

/** The bytes retained, counted as the review counted them: the ASCII content of every row, once (a lower bound). */
const retained = (rows: FormRecoveryRow[]): number =>
  rows.reduce(
    (sum, row) =>
      sum +
      row.form_context.length +
      Object.values(row.fields).reduce((n, v) => n + v.length, 0),
    0,
  );

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("the whole row is sized: every string it stores, and the copies of its key", () => {
  test("at two bytes a unit of every string of the row, the context three more times and the tab twice, plus the fixed allowance", () => {
    const row = rowFor(snap({ title: "x".repeat(10), body: "y" }));
    const strings =
      row.form_context.length +
      row.tab_instance_id.length +
      row.saved_at.length +
      row.content_digest.length +
      "title".length +
      10 +
      "body".length +
      1;
    const keyCopies =
      3 * row.form_context.length + 2 * row.tab_instance_id.length;
    expect(recoveryWriteBytes(row)).toBeGreaterThanOrEqual(
      RECOVERY_ALLOWANCE_BYTES + 2 * (strings + keyCopies),
    );
  });

  test("the old estimate stood for the values alone: a long context, tab id or timestamp now changes the figure, each by what it adds", () => {
    const base = recoveryWriteBytes(rowFor(snap({ title: "x" })));
    const longContext = recoveryWriteBytes(
      rowFor(snap({ title: "x" }, "f".repeat(1_000))),
    );
    const longTab = recoveryWriteBytes(
      rowFor(snap({ title: "x" }, FORM, "t".repeat(1_000))),
    );
    // The context is in the row and again three times as a key; the tab id is in the row and twice as a key.
    expect(longContext - base).toBeGreaterThanOrEqual(
      2 * 4 * (1_000 - FORM.length),
    );
    expect(longTab - base).toBeGreaterThanOrEqual(2 * 3 * (1_000 - TAB.length));
    const stamped = rowFor(snap({ title: "x" }));
    expect(
      recoveryWriteBytes({
        ...stamped,
        saved_at: `${stamped.saved_at}${"z".repeat(500)}`,
      }) - base,
    ).toBeGreaterThanOrEqual(2 * 500);
  });

  test("the order record is sized at its widest: the figure does not depend on the numbers the claim and the call will give it", () => {
    const row = rowFor(snap({ title: "x" }));
    expect(recoveryWriteBytes({ ...row, capture_seq: 1, writer_gen: 1 })).toBe(
      recoveryWriteBytes({ ...row, capture_seq: 987_654, writer_gen: 31 }),
    );
  });

  test("the guard's boundary is the figure: with exactly the figure above the floor the copy is saved, with a byte less it is refused and nothing is written", async () => {
    const row = rowFor(snap({ title: "x".repeat(20_000) }, "f".repeat(3_000)));
    const bytes = recoveryWriteBytes(row);
    for (const [free, outcome] of [
      [FLOOR + bytes, "saved"],
      [FLOOR + bytes - 1, "failed"],
    ] as const) {
      const w = await world();
      const guard = guardOf(free);
      expect(
        await w
          .portOver(w.store, guard)
          .save(snap({ title: "x".repeat(20_000) }, "f".repeat(3_000))),
        `${free - FLOOR - bytes}`,
      ).toBe(outcome);
      expect(w.rows()).toHaveLength(outcome === "saved" ? 1 : 0);
      guard.close?.();
    }
  });
});

describe("the review's schedules: a recovery write never retains what the origin cannot spare, and a refused save leaves nothing", () => {
  for (const bodySize of [1, 900_000]) {
    test(`a 900,000-character form context and a ${bodySize}-character value with 500,000 bytes of room above the floor: refused, and no row is left, claim included`, async () => {
      const w = await world();
      const free = FLOOR + 500_000;
      const guard = guardOf(free);
      const outcome = await w
        .portOver(w.store, guard)
        .save(snap({ title: "x".repeat(bodySize) }, "f".repeat(900_000)));
      expect(outcome).toBe("failed");
      expect(w.rows()).toEqual([]);
      expect(free - retained(w.rows())).toBeGreaterThanOrEqual(FLOOR);
      guard.close?.();
    });
  }

  test("an ordinary short context below the input floor creates no record at all: the first claim of a form creates nothing", async () => {
    const w = await world();
    const guard = guardOf(FLOOR - 1);
    expect(await w.portOver(w.store, guard).save(snap({ title: "x" }))).toBe(
      "failed",
    );
    expect(w.rows()).toEqual([]);
    // What the claim did write is one number in a row that is always there (it is made at the call, and may finish after the save has been refused).
    await vi.waitFor(() => expect(w.counter()).toBe(1));
    expect(w.rows()).toEqual([]);
    guard.close?.();
  });

  test("the controls: an ordinary context and value save in a tight budget, and an ample one saves a large context", async () => {
    const w = await world();
    const tight = guardOf(FLOOR + 500_000);
    expect(await w.portOver(w.store, tight).save(snap({ title: "x" }))).toBe(
      "saved",
    );
    tight.close?.();
    const big = snap({ title: "x" }, "g".repeat(200_000), "tab-big");
    const ample = guardOf(
      FLOOR + recoveryWriteBytes(rowFor(big)) + 1_000,
      "ample",
    );
    expect(await w.portOver(w.store, ample).save(big)).toBe("saved");
    expect(w.rows()).toHaveLength(2);
    ample.close?.();
  });

  test("(adapted, revision 18) the review's sufficient-space controls, with room above the measure: the same 900,000-character context and the same values are saved", async () => {
    // The review's controls gave 2,500,000 bytes for 900,000 characters of context and up to 900,000 of value. Counted by this port's measure
    // (two bytes a unit, the context three more times as a key and in an index) that content needs about 7.2 and 10.8 million; the
    // control keeps its intent, that room which suffices is not refused, and is sized by the same measure.
    for (const bodySize of [1, 900_000]) {
      const w = await world();
      const wide = snap({ title: "x".repeat(bodySize) }, "f".repeat(900_000));
      const free = FLOOR + recoveryWriteBytes(rowFor(wide)) + 1_000;
      const guard = guardOf(free);
      expect(await w.portOver(w.store, guard).save(wide), `${bodySize}`).toBe(
        "saved",
      );
      expect(free - retained(w.rows())).toBeGreaterThanOrEqual(FLOOR);
      guard.close?.();
    }
  });

  test("the review's own sufficient-space figure does not suffice for a 900,000-character context counted by the measure: it is refused, with nothing retained", async () => {
    const w = await world();
    const guard = guardOf(FLOOR + 2_500_000);
    expect(
      await w
        .portOver(w.store, guard)
        .save(snap({ title: "x" }, "f".repeat(900_000))),
    ).toBe("failed");
    expect(w.rows()).toEqual([]);
    guard.close?.();
  });
});

describe("what is admitted is what is written: the caller's object is copied when `save` is called", () => {
  /** A guard whose reservation is held until `release()`, recording the bytes it was asked for. */
  function held(free: number) {
    const inner = guardOf(free, "held");
    const gate = deferred();
    const entered = deferred();
    const asked: number[] = [];
    const quota = {
      ...inner,
      reserve: async (kind: "input" | "cache", bytes: number) => {
        asked.push(bytes);
        const reservation = await inner.reserve(kind, bytes);
        entered.resolve();
        await gate.promise;
        return reservation;
      },
    } as QuotaGuard;
    return { quota, asked, entered, release: gate.resolve, inner };
  }

  for (const roomy of [false, true])
    for (const change of [
      "the title is replaced by 900,000 characters",
      "a field is added",
      "the values object is replaced",
      "the form context and the tab id are reassigned",
      "the timestamp is reassigned",
    ] as const)
      test(`${change} while the guard is asked, ${roomy ? "room for the new text" : "room for the old"}: the saved row is the capture that was admitted`, async () => {
        const w = await world();
        const original = snap({ title: "x" });
        const free = FLOOR + (roomy ? 20_000_000 : 500_000);
        const h = held(free);
        const snapshot: RecoverySnapshot = snap({ title: "x" });
        const saving = w.portOver(w.store, h.quota).save(snapshot);
        await h.entered.promise;
        if (change === "the title is replaced by 900,000 characters")
          snapshot.values.title = "x".repeat(900_000);
        else if (change === "a field is added")
          snapshot.values.extra = "e".repeat(900_000);
        else if (change === "the values object is replaced")
          snapshot.values = { other: "o".repeat(900_000) };
        else if (change === "the form context and the tab id are reassigned") {
          snapshot.formContext = "f".repeat(900_000);
          snapshot.tabInstanceId = "other-tab";
        } else snapshot.savedAt = "1999-01-01T00:00:00.000Z";
        h.release();
        expect(await saving).toBe("saved");
        expect(w.rows()).toHaveLength(1);
        expect(w.rows()[0]).toMatchObject({
          form_context: original.formContext,
          tab_instance_id: original.tabInstanceId,
          fields: { title: "x" },
          saved_at: original.savedAt,
        });
        // What was reserved is the size of the row that was written.
        expect(h.asked).toEqual([recoveryWriteBytes(rowFor(original))]);
        expect(free - retained(w.rows())).toBeGreaterThanOrEqual(FLOOR);
        h.inner.close?.();
      });

  test("a capture QUEUED behind an earlier one of the same port is still the copy made when it was asked for: the caller's later edits are not part of it", async () => {
    const w = await world();
    const gate = deferred();
    const entered = deferred();
    let calls = 0;
    const quota = {
      reserve: async () => {
        calls += 1;
        if (calls === 1) {
          entered.resolve();
          await gate.promise;
        }
        return { verdict: "ok", live: () => true, settle: () => undefined };
      },
    } as unknown as QuotaGuard;
    const port = w.portOver(w.store, quota);
    const first = port.save(snap({ title: "first" }));
    await entered.promise;
    const second: RecoverySnapshot = snap({ title: "second" });
    const queued = port.save(second);
    // The second capture has not begun (it waits behind the first): the caller edits its object.
    second.values.title = "edited after the call";
    second.formContext = "another-form";
    second.savedAt = "1999-01-01T00:00:00.000Z";
    gate.resolve();
    expect(await first).toBe("saved");
    expect(await queued).toBe("saved");
    expect(w.rows()).toHaveLength(1);
    expect(w.rows()[0]).toMatchObject({
      form_context: FORM,
      fields: { title: "second" },
      saved_at: SAVED_AT,
    });
  });

  test("a snapshot that cannot be copied (a getter that throws) is a failed save, never a throw, and nothing is claimed or written", async () => {
    const w = await world();
    const hostile = {
      formContext: FORM,
      tabInstanceId: TAB,
      savedAt: SAVED_AT,
      get values(): Record<string, string> {
        throw new Error("a revoked proxy");
      },
    } as RecoverySnapshot;
    expect(await w.portOver(w.store).save(hostile)).toBe("failed");
    expect(w.rows()).toEqual([]);
    expect(w.counter()).toBeUndefined();
  });
});

describe("a refusal preserves what is already saved", () => {
  test("a copy is saved, then a larger one that does not fit is refused: the earlier text, its digest and its timestamp are untouched", async () => {
    const w = await world();
    expect(await w.portOver(w.store).save(snap({ title: "kept" }))).toBe(
      "saved",
    );
    const before = structuredClone(w.rows()[0]) as FormRecoveryRow;
    const guard = guardOf(FLOOR + 2_000);
    expect(
      await w
        .portOver(w.store, guard)
        .save(snap({ title: "z".repeat(50_000) })),
    ).toBe("failed");
    const after = w.rows()[0] as FormRecoveryRow;
    expect(after.fields).toEqual(before.fields);
    expect(after.content_digest).toBe(before.content_digest);
    expect(after.saved_at).toBe(before.saved_at);
    expect(after.terminal).toBe(false);
    guard.close?.();
  });

  test("a discard of a form that has a row needs no room: it replaces what is there with less, whatever the guard says", async () => {
    const w = await world();
    await w.portOver(w.store).save(snap({ title: "kept" }));
    const asked: number[] = [];
    const refusing = {
      reserve: async (_kind: string, bytes: number) => {
        asked.push(bytes);
        return {
          verdict: "refuse",
          live: () => false,
          settle: () => undefined,
        };
      },
    } as unknown as QuotaGuard;
    await w.portOver(w.store, refusing).discard(FORM, TAB);
    expect(asked).toEqual([]);
    expect(w.rows()[0]).toMatchObject({ terminal: true, fields: {} });
  });
});

describe("a discard of a form that has no row would create one, and is admitted like a save", () => {
  test("it is reserved at the size of the terminal row and keys, and written under its hold", async () => {
    const w = await world();
    const asked: number[] = [];
    const settled: string[] = [];
    const quota = {
      reserve: async (_kind: string, bytes: number) => {
        asked.push(bytes);
        return {
          verdict: "ok",
          live: () => true,
          settle: (outcome: string) => settled.push(outcome),
        };
      },
    } as unknown as QuotaGuard;
    await w.portOver(w.store, quota).discard(FORM, TAB);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThan(RECOVERY_ALLOWANCE_BYTES);
    expect(settled).toEqual(["written"]);
    expect(w.rows()[0]).toMatchObject({ terminal: true, fields: {} });
  });

  test("a discard whose hold ended before its row was written writes nothing, asks the guard once, and releases the reservation as not written", async () => {
    const w = await world();
    const asked: number[] = [];
    const settled: string[] = [];
    const quota = {
      reserve: async (_kind: string, bytes: number) => {
        asked.push(bytes);
        return {
          verdict: "ok",
          live: () => false,
          settle: (outcome: string) => settled.push(outcome),
        };
      },
    } as unknown as QuotaGuard;
    await w.portOver(w.store, quota).discard(FORM, TAB);
    expect(asked).toHaveLength(1);
    expect(settled).toEqual(["not_written"]);
    expect(w.rows()).toEqual([]);
  });

  test("below the floor nothing is created: no row, whatever length of key the caller gave", async () => {
    for (const context of [FORM, "f".repeat(900_000)]) {
      const w = await world();
      const guard = guardOf(FLOOR - 1);
      await w.portOver(w.store, guard).discard(context, TAB);
      expect(w.rows()).toEqual([]);
      guard.close?.();
    }
  });

  test("a capture asked for BEFORE a discard that could write no row is refused as well: the writer remembers the discard, because nothing in the store can", async () => {
    const w = await world();
    const gate = deferred();
    const entered = deferred();
    let calls = 0;
    const quota = {
      reserve: async () => {
        calls += 1;
        if (calls === 1) {
          entered.resolve();
          await gate.promise;
          return { verdict: "ok", live: () => true, settle: () => undefined };
        }
        // The discard's terminal row would not fit.
        return {
          verdict: "refuse",
          live: () => false,
          settle: () => undefined,
        };
      },
    } as unknown as QuotaGuard;
    const older = w.portOver(w.store, quota);
    const later = w.portOver(w.store, quota);
    const saving = older.save(snap({ title: "older capture" }));
    await entered.promise;
    await later.discard(FORM, TAB);
    expect(w.rows()).toEqual([]);
    gate.resolve();
    // It is refused (reported as failed) and the text the person discarded does not come back.
    expect(await saving).toBe("failed");
    expect(w.rows()).toEqual([]);
    // A capture asked for AFTER the discard is a new capture and is written.
    expect(await w.portOver(w.store).save(snap({ title: "typed after" }))).toBe(
      "saved",
    );
    expect(w.rows()[0]?.fields).toEqual({ title: "typed after" });
  });
});

describe("overlapping writers", () => {
  test("two ports over one page's handle save at once with room for ONE copy: exactly one is saved, the other is refused, and nothing is left of it", async () => {
    const w = await world();
    const body = snap({ title: "x".repeat(300_000) });
    const bytes = recoveryWriteBytes(rowFor(body));
    const guard = guardOf(FLOOR + Math.floor(bytes * 1.5));
    const a = w.portOver(w.store, guard);
    const b = w.portOver(w.store, guard);
    const results = await Promise.all([
      a.save(snap({ title: "x".repeat(300_000) }, FORM, "tab-1")),
      b.save(snap({ title: "y".repeat(300_000) }, FORM, "tab-2")),
    ]);
    expect(results.filter((r) => r === "saved")).toHaveLength(1);
    expect(results.filter((r) => r === "failed")).toHaveLength(1);
    expect(w.rows()).toHaveLength(1);
    guard.close?.();
  });

  test("two page contexts whose first saves are both refused leave no row; when room returns, the later context's capture is the later generation", async () => {
    const w = await world();
    const tight = guardOf(FLOOR - 1, "tight");
    const store1 = w.store;
    const store2 = await w.reload();
    expect(await w.portOver(store1, tight).save(snap({ title: "one" }))).toBe(
      "failed",
    );
    expect(await w.portOver(store2, tight).save(snap({ title: "two" }))).toBe(
      "failed",
    );
    expect(w.rows()).toEqual([]);
    tight.close?.();
    // The claims were made (in call order) and each one counted: the later context holds the higher generation.
    await vi.waitFor(() => expect(w.counter()).toBe(2));
    const roomy = guardOf(FLOOR + 5_000_000, "roomy");
    // Each context's writer keeps the generation it claimed: the first writes under 1, the second under 2.
    expect(
      await w.portOver(store1, roomy).save(snap({ title: "one again" })),
    ).toBe("saved");
    expect(w.rows()[0]).toMatchObject({ writer_gen: 1 });
    expect(
      await w.portOver(store2, roomy).save(snap({ title: "two again" })),
    ).toBe("saved");
    expect(w.rows()[0]).toMatchObject({
      fields: { title: "two again" },
      writer_gen: 2,
    });
    // And the older context cannot overtake the later one any more.
    expect(
      await w.portOver(store1, roomy).save(snap({ title: "one, late" })),
    ).toBe("failed");
    expect(w.rows()[0]?.fields).toEqual({ title: "two again" });
    roomy.close?.();
  });

  test("(adapted, revision 19) a form that already has a row is claimed in place (its order record moves, its content does not) and the database's counter moves with it: every claim is one generation of one order (R1)", async () => {
    // The original of revision 18 asserted that the counter was NOT touched by this claim. That was the defect of R1 (revision 19): a claim
    // of an existing row took `stored + 1` without moving the counter, so it could be given the generation that an earlier claim of the
    // same form, whose save had not landed, already held. The intent that is kept: the claim rewrites what the row already holds and
    // nothing else (the content is "kept", the guard that refuses the growth is not asked for the claim). The counter now equals the
    // generation handed out, and the two are the same number.
    const w = await world();
    await w.portOver(w.store).save(snap({ title: "kept" }));
    expect(w.counter()).toBe(1);
    const guard = guardOf(FLOOR - 1);
    const reloaded = w.portOver(await w.reload(), guard);
    expect(await reloaded.save(snap({ title: "x".repeat(10_000) }))).toBe(
      "failed",
    );
    // The claim is made at the call and may finish after the refusal.
    await vi.waitFor(() =>
      expect(w.rows()[0]).toMatchObject({
        fields: { title: "kept" },
        writer_gen: 2,
        capture_seq: 0,
      }),
    );
    expect(w.counter()).toBe(2);
    guard.close?.();
  });
});

describe("a claim made while `closing` is set writes nothing at all", () => {
  test("it is refused, and not even the database's counter moves, whether the form has a row or not (D-16: nothing is written once the account is signing out)", async () => {
    const w = await world();
    await w
      .portOver(w.store)
      .save(snap({ title: "kept" }, FORM, "tab-with-row"));
    const before = {
      rows: structuredClone(w.rows()),
      counter: w.counter(),
    };
    await w.store.run(setClosing, {
      incarnationId: w.store.incarnationId,
      now: 1,
      token: "t",
    });
    for (const tab of ["tab-with-row", "tab-without-row"])
      expect(
        await w.store.run(claimFormWriter, {
          incarnationId: w.store.incarnationId,
          formContext: FORM,
          tabInstanceId: tab,
          now: NOW,
        }),
        tab,
      ).toEqual({ kind: "refused" });
    expect(
      await w
        .portOver(w.store)
        .save(snap({ title: "late" }, FORM, "tab-without-row")),
    ).toBe("refused");
    await w.portOver(w.store).discard(FORM, "tab-without-row");
    expect(w.rows()).toEqual(before.rows);
    expect(w.counter()).toBe(before.counter);
  });
});

describe("the guard is asked once the copy is made, and the claim stays at the call (R1)", () => {
  test("the claim's transaction is created before the guard answers, and the capture's sequence is fixed in call order", async () => {
    const w = await world();
    const gate = deferred();
    const entered = deferred();
    const quota = {
      reserve: async () => {
        entered.resolve();
        await gate.promise;
        return { verdict: "ok", live: () => true, settle: () => undefined };
      },
    } as unknown as QuotaGuard;
    const port = w.portOver(w.store, quota);
    const saving = port.save(snap({ title: "x" }));
    await entered.promise;
    // The guard has not answered, and the claim has already been made.
    await vi.waitFor(() => expect(w.counter()).toBe(1));
    expect(w.rows()).toEqual([]);
    gate.resolve();
    expect(await saving).toBe("saved");
    expect(w.rows()[0]).toMatchObject({ capture_seq: 1, writer_gen: 1 });
  });

  test("a failed estimate is a failed save with nothing created, and the next save is written", async () => {
    const w = await world();
    const broken = {
      reserve: vi.fn(async () => {
        throw new Error("the guard threw");
      }),
    } as unknown as QuotaGuard;
    expect(await w.portOver(w.store, broken).save(snap({ title: "x" }))).toBe(
      "failed",
    );
    expect(w.rows()).toEqual([]);
    expect(await w.portOver(w.store).save(snap({ title: "y" }))).toBe("saved");
  });
});
