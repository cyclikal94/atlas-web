// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { QuotaGuard } from "../../src/data/engine/quota-guard";
import { digestOf } from "../../src/data/model/canonical";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { FormRecoveryRow, SyncStateRow } from "../../src/data/model/types";
import { setClosing } from "../../src/data/plans/fence";
import {
  claimFormWriter,
  MAX_WRITER_GEN,
  saveFormRecovery,
} from "../../src/data/plans/form-recovery";
import { createFormRecoveryPort } from "../../src/data/ports/form-recovery";
import type { RecoverySnapshot } from "../../src/lib/form-recovery/port";
import { DataTestWorld } from "../support/data/env";

/**
 * R1 (revision 6), reopened by R33 and corrected in revision 19: ONE ORDER FOR EVERY CLAIM.
 *
 * Revision 18 handed a claim of an EXISTING row `stored + 1` and a claim of an absent one the database's counter + 1, and only the second
 * moved the counter. With the form's row absent, A claimed generation 1 and B generation 2 (their saves waiting in the quota estimate); A's
 * save landed; and a later context C, claiming the existing row, was handed 2 as well. B's second pending capture (generation 2, sequence
 * 2) then overwrote C's newer text, and the same pair of generations let a pending discard of B's clear C's input and an older save
 * restore what C had discarded. A quota wait is a controlled asynchronous boundary the port allows, and B's captures were made BEFORE
 * C's.
 *
 * The invariant: a claim of a form and tab, whether or not the form has a row when it is made, is a generation no other claim has had and
 * above every claim made before it, including a claim whose save has not landed. The database's counter orders them all
 * (`max(counter, stored generation) + 1`, and every claim moves the counter); where no unique generation can be issued the claim answers
 * `no_generation`, writes nothing and the capture fails. An obsolete capture stays final and is never re-numbered above the newer one.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NAME = accountDatabaseName(ACCOUNT);
const FORM = "task-edit:42";
const TAB = "tab-a";
const FORM_2 = "task-edit:43";
const TAB_2 = "tab-b";
const NOW = "2026-10-01T12:00:00.000Z";

const snap = (
  text: string,
  formContext = FORM,
  tabInstanceId = TAB,
): RecoverySnapshot => ({
  formContext,
  tabInstanceId,
  values: { text },
  savedAt: "2026-10-01T09:00:00.000Z",
});

interface Gate {
  entered: Promise<void>;
  release(): void;
}
const gate = (): { gate: Gate; wait: () => Promise<void> } => {
  let release!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    gate: { entered: reached, release },
    wait: async () => {
      entered();
      await opened;
    },
  };
};

/** A guard whose first estimate is held until its gate opens (every later reservation passes at once). Settlements are recorded. */
const heldQuota = (
  g: { wait: () => Promise<void> },
  settled: string[] = [],
): QuotaGuard => {
  let first = true;
  return {
    reserve: async () => {
      if (first) {
        first = false;
        await g.wait();
      }
      return {
        verdict: "ok",
        live: () => true,
        settle: (outcome: string) => settled.push(outcome),
      };
    },
  } as unknown as QuotaGuard;
};

/** A guard that admits everything at once and records how each reservation was settled. */
const recordingQuota = (settled: string[]): QuotaGuard =>
  ({
    reserve: async () => ({
      verdict: "ok",
      live: () => true,
      settle: (outcome: string) => settled.push(outcome),
    }),
  }) as unknown as QuotaGuard;

async function world() {
  const env = new DataTestWorld();
  env.idb.autoDrive = true;
  const page = env.page("A");
  page.identity.account = ACCOUNT;
  const opened = await page.open(ACCOUNT, { create: true });
  if (opened.kind !== "opened") throw new Error("setup");
  const store = opened.store;
  /** A further handle on the same database: the page context that a reload makes. */
  const reload = async () => {
    const again = await page.open(ACCOUNT);
    if (again.kind !== "opened") throw new Error("setup: reload");
    return again.store;
  };
  const rows = () =>
    (env.idb.snapshot(NAME)?.form_recovery ?? []) as FormRecoveryRow[];
  const rowOf = (form = FORM, tab = TAB) =>
    rows().find((r) => r.form_context === form && r.tab_instance_id === tab);
  const sync = () =>
    env.idb.peek(NAME, "sync_state", "singleton") as SyncStateRow | undefined;
  const counter = () => sync()?.form_writer_gen;
  /** Direct, non-transactional edit of the singleton, for arranging a counter (never used by the code under test). */
  const setSync = (patch: Record<string, unknown>) => {
    const current = sync();
    if (!current) throw new Error("setup: no singleton");
    env.idb.seed(NAME, "sync_state", [{ ...current, ...patch } as never]);
  };
  const portOver = (on: typeof store, quota?: QuotaGuard) =>
    createFormRecoveryPort({
      service: () => ({ store: on, incarnationId: on.incarnationId }) as never,
      now: () => NOW,
      ...(quota === undefined ? {} : { quota }),
    });
  const claim = (form = FORM, tab = TAB) =>
    store.run(claimFormWriter, {
      incarnationId: store.incarnationId,
      formContext: form,
      tabInstanceId: tab,
      now: NOW,
    });
  return {
    env,
    store,
    reload,
    rows,
    rowOf,
    sync,
    counter,
    setSync,
    portOver,
    claim,
  };
}

const rowAt = (
  text: string,
  gen: number | undefined,
  seq: number,
  form = FORM,
  tab = TAB,
): FormRecoveryRow => ({
  form_context: form,
  tab_instance_id: tab,
  fields: { text },
  redacted: [],
  saved_at: "2026-10-01T08:00:00.000Z",
  capture_seq: seq,
  ...(gen === undefined ? {} : { writer_gen: gen }),
  terminal: false,
  content_digest: digestOf({ text }),
});

describe("R1 (revision 19): a claim of an absent row and a claim of an existing row are one order", () => {
  test("control: three contexts that all claim an EXISTING row keep the newest generation", async () => {
    const w = await world();
    expect(await w.portOver(w.store).save(snap("seed"))).toBe("saved");
    const wait = gate();
    const b = w.portOver(await w.reload(), heldQuota(wait));
    const b1 = b.save(snap("old one"));
    const b2 = b.save(snap("old two"));
    await wait.gate.entered;
    expect(await w.portOver(await w.reload()).save(snap("newest"))).toBe(
      "saved",
    );
    wait.gate.release();
    expect([await b1, await b2]).toEqual(["failed", "failed"]);
    expect(w.rowOf()?.fields.text).toBe("newest");
  });

  test("control: two contexts that claim while the row is ABSENT: the later claimant wins", async () => {
    const w = await world();
    const aw = gate();
    const bw = gate();
    const a = w.portOver(w.store, heldQuota(aw));
    const b = w.portOver(await w.reload(), heldQuota(bw));
    const a1 = a.save(snap("first"));
    await aw.gate.entered;
    const b1 = b.save(snap("second"));
    await bw.gate.entered;
    aw.gate.release();
    expect(await a1).toBe("saved");
    bw.gate.release();
    expect(await b1).toBe("saved");
    expect(w.rowOf()).toMatchObject({
      fields: { text: "second" },
      writer_gen: 2,
    });
  });

  test("the review's schedule: an absent claimant whose captures wait cannot overwrite a LATER claimant of the row that the first landed (generations 1, 2, 3)", async () => {
    const w = await world();
    const aw = gate();
    const bw = gate();
    const a = w.portOver(w.store, heldQuota(aw));
    const b = w.portOver(await w.reload(), heldQuota(bw));
    const a1 = a.save(snap("first"));
    await aw.gate.entered;
    // B's two captures are made now, before C exists, and wait behind B's quota admission.
    const b1 = b.save(snap("old one"));
    const b2 = b.save(snap("old two"));
    await bw.gate.entered;
    aw.gate.release();
    expect(await a1).toBe("saved");
    expect(w.rowOf()).toMatchObject({ writer_gen: 1 });
    const c = w.portOver(await w.reload());
    expect(await c.save(snap("newest"))).toBe("saved");
    // C's generation is above B's, which has not landed anything: no collision at 2.
    expect(w.rowOf()).toMatchObject({
      fields: { text: "newest" },
      writer_gen: 3,
      capture_seq: 1,
    });
    const before = structuredClone(w.rowOf());
    bw.gate.release();
    expect([await b1, await b2]).toEqual(["failed", "failed"]);
    // Final, and never re-numbered above the newer text: the stored row is untouched, timestamp included.
    expect(w.rowOf()).toEqual(before);
    expect(await c.load(FORM, TAB)).toMatchObject({
      values: { text: "newest" },
    });
    expect(w.counter()).toBe(3);
  });

  test("a later claimant's DISCARD stands against the older claimant's pending second save: the discarded text does not come back", async () => {
    const w = await world();
    const aw = gate();
    const bw = gate();
    const a = w.portOver(w.store, heldQuota(aw));
    const b = w.portOver(await w.reload(), heldQuota(bw));
    const a1 = a.save(snap("seed"));
    await aw.gate.entered;
    const b1 = b.save(snap("old one"));
    const b2 = b.save(snap("old two"));
    await bw.gate.entered;
    aw.gate.release();
    await a1;
    const c = w.portOver(await w.reload());
    await c.discard(FORM, TAB);
    expect(await c.load(FORM, TAB)).toBeNull();
    const before = structuredClone(w.rowOf());
    bw.gate.release();
    await Promise.all([b1, b2]);
    expect(w.rowOf()).toEqual(before);
    expect(w.rowOf()?.terminal).toBe(true);
    expect(await c.load(FORM, TAB)).toBeNull();
  });

  test("an older claimant's pending DISCARD does not erase a later claimant's newer input", async () => {
    const w = await world();
    const aw = gate();
    const bw = gate();
    const a = w.portOver(w.store, heldQuota(aw));
    const b = w.portOver(await w.reload(), heldQuota(bw));
    const a1 = a.save(snap("seed"));
    await aw.gate.entered;
    const b1 = b.save(snap("old one"));
    const b2 = b.discard(FORM, TAB);
    await bw.gate.entered;
    aw.gate.release();
    await a1;
    const c = w.portOver(await w.reload());
    expect(await c.save(snap("newest"))).toBe("saved");
    const before = structuredClone(w.rowOf());
    bw.gate.release();
    await Promise.all([b1, b2]);
    expect(w.rowOf()).toEqual(before);
    expect(await c.load(FORM, TAB)).toMatchObject({
      values: { text: "newest" },
    });
  });

  test("the same schedule with the later claimant on another handle of the SAME page and a replacement port: sequences run on, generations do not collide", async () => {
    const w = await world();
    const aw = gate();
    const a = w.portOver(w.store, heldQuota(aw));
    const bHandle = await w.reload();
    const b = w.portOver(bHandle);
    const a1 = a.save(snap("first"));
    await aw.gate.entered;
    const b1 = b.save(snap("second"));
    expect(await b1).toBe("saved");
    expect(w.rowOf()).toMatchObject({
      writer_gen: 2,
      fields: { text: "second" },
    });
    // A replacement port over the same handle as B is the same writer: B's generation, and its sequence runs on.
    expect(await w.portOver(bHandle).save(snap("third"))).toBe("saved");
    expect(w.rowOf()).toMatchObject({
      writer_gen: 2,
      capture_seq: 2,
      fields: { text: "third" },
    });
    aw.gate.release();
    expect(await a1).toBe("failed");
    expect(w.rowOf()?.fields.text).toBe("third");
  });
});

describe("the claim: one counter, every claim moves it", () => {
  test("a claim of an existing row moves the counter to its generation, whatever the counter was (here: below the row)", async () => {
    const w = await world();
    expect(await w.portOver(w.store).save(snap("seed"))).toBe("saved");
    expect(w.counter()).toBe(1);
    w.env.idb.seed(NAME, "form_recovery", [rowAt("legacy", 7, 4)]);
    expect(await w.claim()).toEqual({ kind: "claimed", gen: 8 });
    expect(w.rowOf()).toMatchObject({
      fields: { text: "legacy" },
      writer_gen: 8,
      capture_seq: 0,
    });
    expect(w.counter()).toBe(8);
  });

  test("a counter above the row's generation is the one the claim goes above (a claim of another form moved it)", async () => {
    const w = await world();
    expect(await w.portOver(w.store).save(snap("seed"))).toBe("saved");
    w.setSync({ form_writer_gen: 10 });
    expect(await w.claim()).toEqual({ kind: "claimed", gen: 11 });
    expect(w.rowOf()?.writer_gen).toBe(11);
    expect(w.counter()).toBe(11);
  });

  test("claims made while the row is absent, then a row landing at the first of them, then a claim of that row: three different generations, the last above both", async () => {
    const w = await world();
    expect(await w.claim()).toEqual({ kind: "claimed", gen: 1 });
    expect(await w.claim()).toEqual({ kind: "claimed", gen: 2 });
    expect(w.rows()).toEqual([]);
    // The first claimant's save lands (a row at generation 1, sequence 1)...
    expect(
      await w.store.run(saveFormRecovery, {
        incarnationId: w.store.incarnationId,
        row: rowAt("first", 1, 1),
      }),
    ).toEqual({ kind: "saved" });
    // ...and the claim of that row is NOT given 2, which the second claimant holds.
    expect(await w.claim()).toEqual({ kind: "claimed", gen: 3 });
    expect(w.rowOf()).toMatchObject({ writer_gen: 3, capture_seq: 0 });
    expect(w.counter()).toBe(3);
  });

  test("different forms and tabs: one counter, so every claim of every key is a different number and each key's claims increase in the order they were made", async () => {
    const w = await world();
    const seen: Array<{ key: string; gen: number }> = [];
    const keys: Array<[string, string]> = [
      [FORM, TAB],
      [FORM_2, TAB_2],
      [FORM, TAB_2],
    ];
    // Interleaved, with a row landing for the first key part-way (so absent and existing claims both occur for it).
    const order = [0, 1, 0, 2, 1, 0, 2, 1];
    for (const [index, which] of order.entries()) {
      const [form, tab] = keys[which] as [string, string];
      const result = await w.claim(form, tab);
      if (result.kind !== "claimed") throw new Error("not claimed");
      seen.push({ key: `${form}|${tab}`, gen: result.gen });
      if (index === 2)
        await w.store.run(saveFormRecovery, {
          incarnationId: w.store.incarnationId,
          row: rowAt("first", result.gen, 1),
        });
    }
    const gens = seen.map((s) => s.gen);
    expect(new Set(gens).size).toBe(gens.length);
    expect(gens).toEqual([...gens].sort((x, y) => x - y));
    for (const key of new Set(seen.map((s) => s.key))) {
      const own = seen.filter((s) => s.key === key).map((s) => s.gen);
      expect(own).toEqual([...own].sort((x, y) => x - y));
    }
    expect(w.counter()).toBe(gens.at(-1));
  });

  test("a generation is never issued twice, even if the row that carried it is gone: the counter keeps what was handed out", async () => {
    const w = await world();
    expect(await w.claim()).toEqual({ kind: "claimed", gen: 1 });
    await w.store.run(saveFormRecovery, {
      incarnationId: w.store.incarnationId,
      row: rowAt("first", 1, 1),
    });
    expect(await w.claim()).toEqual({ kind: "claimed", gen: 2 });
    // Nothing in production removes a recovery row (terminal rows are kept so that a late write can be ordered against them), but the
    // order must not depend on that: were the row ever gone (damage, a later retention sweep), the next claim must still be above the
    // generation that the claim of the row was given, which a page may still hold.
    w.env.idb.clearStore(NAME, "form_recovery");
    expect(await w.claim()).toEqual({ kind: "claimed", gen: 3 });
    expect(w.counter()).toBe(3);
  });

  test("a row written before generations counts as generation 0, with or without a counter", async () => {
    const w = await world();
    w.env.idb.seed(NAME, "form_recovery", [rowAt("old build", undefined, 9)]);
    expect(w.counter()).toBeUndefined();
    expect(await w.claim()).toEqual({ kind: "claimed", gen: 1 });
    expect(w.rowOf()).toMatchObject({ writer_gen: 1, capture_seq: 0 });
    expect(w.counter()).toBe(1);
  });

  test("a claim made while `closing` is set is refused even when the counter is unusable: nothing is written", async () => {
    const w = await world();
    w.setSync({ form_writer_gen: -1 });
    await w.store.run(setClosing, {
      incarnationId: w.store.incarnationId,
      now: 1,
      token: "t",
    });
    expect(await w.claim()).toEqual({ kind: "refused" });
    expect(w.counter()).toBe(-1);
  });
});

describe("numeric bounds: no generation is issued where it could be another claim's", () => {
  test("the last generation is issued once; the next claim is refused with nothing written", async () => {
    const w = await world();
    w.setSync({ form_writer_gen: MAX_WRITER_GEN - 1 });
    expect(await w.claim()).toEqual({ kind: "claimed", gen: MAX_WRITER_GEN });
    expect(w.counter()).toBe(MAX_WRITER_GEN);
    const before = structuredClone(w.sync());
    expect(await w.claim()).toEqual({ kind: "no_generation" });
    expect(await w.claim(FORM_2, TAB_2)).toEqual({ kind: "no_generation" });
    expect(w.sync()).toEqual(before);
    expect(w.rows()).toEqual([]);
  });

  test("a counter at the limit refuses the claim of an EXISTING row as well, and the row is untouched", async () => {
    const w = await world();
    w.env.idb.seed(NAME, "form_recovery", [rowAt("kept", 3, 5)]);
    w.setSync({ form_writer_gen: MAX_WRITER_GEN });
    const before = structuredClone(w.rows());
    expect(await w.claim()).toEqual({ kind: "no_generation" });
    expect(w.rows()).toEqual(before);
    expect(w.counter()).toBe(MAX_WRITER_GEN);
  });

  test("a stored generation at the limit refuses the claim although the counter is small; one below it is issued the limit", async () => {
    const w = await world();
    w.setSync({ form_writer_gen: 5 });
    w.env.idb.seed(NAME, "form_recovery", [rowAt("kept", MAX_WRITER_GEN, 2)]);
    const before = structuredClone(w.rows());
    expect(await w.claim()).toEqual({ kind: "no_generation" });
    expect(w.rows()).toEqual(before);
    expect(w.counter()).toBe(5);
    w.env.idb.seed(NAME, "form_recovery", [
      rowAt("kept", MAX_WRITER_GEN - 1, 2),
    ]);
    expect(await w.claim()).toEqual({ kind: "claimed", gen: MAX_WRITER_GEN });
    expect(w.counter()).toBe(MAX_WRITER_GEN);
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["past the safe integers", 2 ** 53],
    ["text", "3"],
  ])(
    "a counter that is %s is not trusted: no generation, nothing written",
    async (_name, value) => {
      const w = await world();
      w.setSync({ form_writer_gen: value });
      const before = structuredClone(w.sync());
      expect(await w.claim()).toEqual({ kind: "no_generation" });
      expect(w.sync()).toEqual(before);
      expect(w.rows()).toEqual([]);
    },
  );

  test.each([
    ["negative", -1],
    ["fractional", 2.5],
    ["not a number", Number.NaN],
    ["text", "2"],
  ])(
    "a stored generation that is %s is not trusted: no generation, the row is untouched",
    async (_name, value) => {
      const w = await world();
      w.env.idb.seed(NAME, "form_recovery", [
        { ...rowAt("kept", 1, 1), writer_gen: value as never },
      ]);
      const before = structuredClone(w.rows());
      const counter = w.counter();
      expect(await w.claim()).toEqual({ kind: "no_generation" });
      expect(w.rows()).toEqual(before);
      expect(w.counter()).toBe(counter);
    },
  );

  test("without the singleton that holds the counter nothing can say what was issued: no generation, and nothing is created", async () => {
    const w = await world();
    w.env.idb.clearStore(NAME, "sync_state");
    expect(await w.claim()).toEqual({ kind: "no_generation" });
    expect(w.rows()).toEqual([]);
    expect(w.sync()).toBeUndefined();
  });

  test("through the port: a save is `failed` (the claim is refused, its reservation released as not written), and the text that is saved stays", async () => {
    const w = await world();
    expect(await w.portOver(w.store).save(snap("kept"))).toBe("saved");
    w.setSync({ form_writer_gen: MAX_WRITER_GEN });
    const settled: string[] = [];
    const guarded = w.portOver(await w.reload(), recordingQuota(settled));
    expect(await guarded.save(snap("lost"))).toBe("failed");
    expect(settled).toEqual(["not_written"]);
    expect(w.rowOf()).toMatchObject({
      fields: { text: "kept" },
      writer_gen: 1,
    });
    // A discard is no better placed: nothing is written, and the saved copy is shown again (the safe direction).
    const later = w.portOver(await w.reload());
    await later.discard(FORM, TAB);
    expect(w.rowOf()).toMatchObject({
      fields: { text: "kept" },
      terminal: false,
    });
    expect(await later.load(FORM, TAB)).toMatchObject({
      values: { text: "kept" },
    });
  });

  test("through the port: the refusal is not remembered: once a generation can be issued the next capture of the same page claims afresh and is saved", async () => {
    const w = await world();
    w.setSync({ form_writer_gen: MAX_WRITER_GEN });
    const port = w.portOver(w.store);
    expect(await port.save(snap("first try"))).toBe("failed");
    expect(w.rows()).toEqual([]);
    w.setSync({ form_writer_gen: 4 });
    expect(await port.save(snap("second try"))).toBe("saved");
    expect(w.rowOf()).toMatchObject({
      fields: { text: "second try" },
      writer_gen: 5,
    });
  });

  test("through the port: a discard of a form with no row, with no generation to issue, creates nothing", async () => {
    const w = await world();
    w.setSync({ form_writer_gen: MAX_WRITER_GEN });
    await w.portOver(w.store).discard(FORM, TAB);
    expect(w.rows()).toEqual([]);
  });
});

/**
 * The schedule space. Three page contexts (A, B, C) each make two captures at once (its first call is its claim), and each context's
 * first estimate is either held (and released later) or passes at once. Every ordering of the calls and releases that respects "a
 * release follows its call" is run, with the second capture of each context a save or a discard. The oracle does not look at generations:
 * the context that CLAIMED last (called first-save last) owns the final state, whatever order anything landed in: its last capture's
 * text, or nothing if that was a discard. A context that claimed earlier can never overwrite, erase or restore what a later context did.
 */
type Event = { kind: "call" | "release"; who: number };

function schedules(held: boolean[]): Event[][] {
  const out: Event[][] = [];
  const pending: Event[] = [];
  held.forEach((isHeld, who) => {
    pending.push({ kind: "call", who });
    if (isHeld) pending.push({ kind: "release", who });
  });
  const walk = (done: Event[], left: Event[]) => {
    if (left.length === 0) {
      out.push(done);
      return;
    }
    left.forEach((event, index) => {
      // A release must follow its own call.
      if (
        event.kind === "release" &&
        !done.some((d) => d.kind === "call" && d.who === event.who)
      )
        return;
      walk(
        [...done, event],
        [...left.slice(0, index), ...left.slice(index + 1)],
      );
    });
  };
  walk([], pending);
  return out;
}

async function runSchedule(
  events: Event[],
  held: boolean[],
  second: Array<"save" | "discard">,
): Promise<{ final: string | null; claimOrder: number[] }> {
  const w = await world();
  const handles = [w.store, await w.reload(), await w.reload()];
  const gates = held.map(() => gate());
  const ports = handles.map((handle, who) =>
    w.portOver(handle, held[who] ? heldQuota(gates[who] as never) : undefined),
  );
  const pending: Array<Promise<unknown>> = [];
  const bothOf: Array<Promise<unknown> | undefined> = [];
  const claimOrder: number[] = [];
  for (const event of events) {
    const who = event.who;
    if (event.kind === "call") {
      claimOrder.push(who);
      const port = ports[who] as ReturnType<typeof w.portOver>;
      const first = port.save(snap(`${"ABC"[who]} one`));
      const next =
        second[who] === "discard"
          ? port.discard(FORM, TAB)
          : port.save(snap(`${"ABC"[who]} two`));
      const both = Promise.all([first, next]);
      pending.push(both);
      bothOf[who] = both;
      if (held[who]) await (gates[who] as { gate: Gate }).gate.entered;
      else await both;
    } else {
      (gates[who] as { gate: Gate }).gate.release();
      // Its own two captures land now; the contexts that are still held stay held.
      await bothOf[who];
    }
  }
  await Promise.all(pending);
  const reader = w.portOver(await w.reload());
  const loaded = await reader.load(FORM, TAB);
  return { final: loaded ? (loaded.values.text ?? null) : null, claimOrder };
}

describe("every schedule of three page contexts: the context that claimed last owns the final state", () => {
  const heldSets: boolean[][] = [];
  for (let mask = 0; mask < 8; mask += 1)
    heldSets.push([Boolean(mask & 1), Boolean(mask & 2), Boolean(mask & 4)]);
  const variants: Array<Array<"save" | "discard">> = [
    ["save", "save", "save"],
    ["save", "discard", "save"],
    ["discard", "save", "discard"],
    ["save", "save", "discard"],
  ];

  test("the schedule space is the one described (222 orderings)", () => {
    expect(heldSets.reduce((n, held) => n + schedules(held).length, 0)).toBe(
      222,
    );
  });

  test.each(variants.map((second, index) => [index, second] as const))(
    "variant %i of the second captures",
    async (_index, second) => {
      const failures: string[] = [];
      let runs = 0;
      for (const held of heldSets)
        for (const events of schedules(held)) {
          runs += 1;
          const { final, claimOrder } = await runSchedule(events, held, [
            ...second,
          ]);
          const winner = claimOrder.at(-1) as number;
          const expected =
            second[winner] === "discard" ? null : `${"ABC"[winner]} two`;
          if (final !== expected)
            failures.push(
              `${events.map((e) => `${e.kind[0]}${"ABC"[e.who]}`).join(" ")} [held ${held.map((h) => (h ? "y" : "n")).join("")}]: expected ${expected}, got ${final}`,
            );
        }
      expect(runs).toBe(222);
      expect(failures).toEqual([]);
    },
    60_000,
  );
});
