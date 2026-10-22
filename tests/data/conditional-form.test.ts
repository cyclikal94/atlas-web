// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { QuotaGuard } from "../../src/data/engine/quota-guard";
import { digestOf } from "../../src/data/model/canonical";
import type { FormRecoveryRow } from "../../src/data/model/types";
import { setClosing } from "../../src/data/plans/fence";
import { readFormCopies } from "../../src/data/plans/form-copies";
import { createConditionalFormPort } from "../../src/data/ports/conditional-form";
import { createFormRecoveryPort } from "../../src/data/ports/form-recovery";
import type { RecoverySnapshot } from "../../src/lib/form-recovery/port";
import { pageWorld } from "../support/data/page-world";

/**
 * The CONDITIONAL form port (review 2 of 22 October 2026, findings 2 and 4) over the real plans and the IndexedDB double: every write is a
 * compare-and-set of the stored row, every answer is typed, and nothing is reported as done that the store did not commit. The reviewer's
 * fault injection (a terminal write that throws inside the store) is reproduced here with its healthy control.
 */
type World = Awaited<ReturnType<typeof pageWorld>>;
const CONTEXT = "people-held:p:f";
const TAB = "hold-1";
const NOW = "2026-10-22T09:00:00.000Z";

const snap = (values: Record<string, string>, tab = TAB): RecoverySnapshot => ({
  formContext: CONTEXT,
  tabInstanceId: tab,
  values,
  savedAt: NOW,
});
const portOf = (w: World, quota?: QuotaGuard) =>
  createConditionalFormPort({
    service: () => w.service,
    now: () => NOW,
    ...(quota === undefined ? {} : { quota }),
  });
const rowsOf = async (w: World) =>
  (
    await w.service.store.run(readFormCopies, {
      incarnationId: w.service.incarnationId,
      prefix: "people-held:",
    })
  ).copies;
/** Every write of `saveFormRecovery` that `fail` matches throws inside the store (as a failed transaction does). */
const failing = (
  w: World,
  fail: (input: { row?: FormRecoveryRow }) => boolean,
) => {
  const run = w.service.store.run.bind(w.service.store);
  w.service.store.run = ((plan: { name: string }, input: never) => {
    if (plan.name === "data.saveFormRecovery" && fail(input))
      return Promise.reject(new Error("injected storage failure"));
    return run(plan as never, input);
  }) as typeof w.service.store.run;
};

describe("the conditional form port", () => {
  test("put creates only an absent row and answers with the digest it stored; a second create of it is `changed`", async () => {
    const w = await pageWorld();
    const port = portOf(w);
    const created = await port.put(snap({ held: "a" }), null);
    expect(created).toEqual({ kind: "saved", digest: digestOf({ held: "a" }) });
    expect(await port.put(snap({ held: "b" }), null)).toEqual({
      kind: "changed",
      stored: "live",
    });
    expect((await rowsOf(w)).map((row) => row.fields)).toEqual([{ held: "a" }]);
  });

  test("put replaces only the state it names: another digest is `changed` and nothing is written", async () => {
    const w = await pageWorld();
    const port = portOf(w);
    const first = await port.put(snap({ held: "a" }), null);
    if (first.kind !== "saved") throw new Error("setup");
    expect(await port.put(snap({ held: "c" }), "not-the-digest")).toEqual({
      kind: "changed",
      stored: "live",
    });
    const next = await port.put(snap({ held: "b" }), first.digest);
    expect(next).toEqual({ kind: "saved", digest: digestOf({ held: "b" }) });
    // The older state's writer is now refused: its digest is not stored.
    expect(await port.put(snap({ held: "z" }), first.digest)).toEqual({
      kind: "changed",
      stored: "live",
    });
    expect((await rowsOf(w))[0]?.fields).toEqual({ held: "b" });
  });

  test("end makes the row terminal only from the state it names, and an ended row is never written again", async () => {
    const w = await pageWorld();
    const port = portOf(w);
    const first = await port.put(snap({ held: "a" }), null);
    if (first.kind !== "saved") throw new Error("setup");
    expect(await port.end(CONTEXT, TAB, "other")).toEqual({
      kind: "changed",
      stored: "live",
    });
    expect(await port.end(CONTEXT, TAB, first.digest)).toEqual({
      kind: "ended",
    });
    expect(await port.read(CONTEXT, TAB)).toEqual({ kind: "ended" });
    expect(await port.end(CONTEXT, TAB, first.digest)).toEqual({
      kind: "changed",
      stored: "ended",
    });
    // A late writer of the state it read cannot bring it back, nor can a create.
    expect(await port.put(snap({ held: "late" }), first.digest)).toEqual({
      kind: "changed",
      stored: "ended",
    });
    expect(await port.put(snap({ held: "late" }), null)).toEqual({
      kind: "changed",
      stored: "ended",
    });
    expect(await rowsOf(w)).toEqual([]);
    expect(await port.end(CONTEXT, "never-held", "x")).toEqual({
      kind: "changed",
      stored: "absent",
    });
  });

  for (const fail of [false, true])
    test(`a terminal write that fails inside the store is \`failed\` and the copy stays live (${fail ? "fault" : "healthy control"})`, async () => {
      const w = await pageWorld();
      const port = portOf(w);
      const first = await port.put(snap({ held: "a" }), null);
      if (first.kind !== "saved") throw new Error("setup");
      if (fail) failing(w, (input) => input.row?.terminal === true);
      const end = await port.end(CONTEXT, TAB, first.digest);
      if (fail) {
        expect(end).toEqual({ kind: "failed" });
        expect(await rowsOf(w)).toHaveLength(1);
        expect(await port.read(CONTEXT, TAB)).toMatchObject({ kind: "live" });
      } else {
        expect(end).toEqual({ kind: "ended" });
        expect(await rowsOf(w)).toEqual([]);
      }
    });

  test("a put that fails inside the store is `failed`, and what was stored is untouched", async () => {
    const w = await pageWorld();
    const port = portOf(w);
    const first = await port.put(snap({ held: "a" }), null);
    if (first.kind !== "saved") throw new Error("setup");
    failing(w, () => true);
    expect(await port.put(snap({ held: "b" }), first.digest)).toEqual({
      kind: "failed",
    });
    expect((await rowsOf(w))[0]?.fields).toEqual({ held: "a" });
  });

  test("REFUSED while signing out (`closing`), put and end alike, and nothing is written", async () => {
    const w = await pageWorld();
    const port = portOf(w);
    const first = await port.put(snap({ held: "a" }), null);
    if (first.kind !== "saved") throw new Error("setup");
    await w.service.store.run(setClosing, {
      incarnationId: w.service.incarnationId,
      now: 1,
      token: "t",
    });
    expect(await port.put(snap({ held: "b" }), first.digest)).toEqual({
      kind: "refused",
    });
    expect(await port.end(CONTEXT, TAB, first.digest)).toEqual({
      kind: "refused",
    });
    expect((await rowsOf(w))[0]?.fields).toEqual({ held: "a" });
  });

  test("a put the quota guard refuses writes nothing (`failed`)", async () => {
    const w = await pageWorld();
    const refusing = {
      reserve: async () => ({
        verdict: "refuse",
        live: () => false,
        settle: () => undefined,
      }),
    } as unknown as QuotaGuard;
    expect(await portOf(w, refusing).put(snap({ held: "a" }), null)).toEqual({
      kind: "failed",
    });
    expect(await rowsOf(w)).toEqual([]);
  });

  test("no service: every answer is `failed` (or null), never absence", async () => {
    const port = createConditionalFormPort({
      service: () => null,
      now: () => NOW,
    });
    expect(await port.put(snap({ held: "a" }), null)).toEqual({
      kind: "failed",
    });
    expect(await port.end(CONTEXT, TAB, "d")).toEqual({ kind: "failed" });
    expect(await port.read(CONTEXT, TAB)).toEqual({ kind: "failed" });
    expect(await port.list("people-held:", null)).toBeNull();
  });

  test("the ordinary form port can never write a conditional row (it holds the highest writer generation): its save fails, its discard writes nothing", async () => {
    const w = await pageWorld();
    const conditional = portOf(w);
    const first = await conditional.put(snap({ held: "a" }), null);
    if (first.kind !== "saved") throw new Error("setup");
    const ordinary = createFormRecoveryPort({
      service: () => w.service,
      now: () => NOW,
    });
    expect(await ordinary.save(snap({ held: "generic" }))).toBe("failed");
    await ordinary.discard(CONTEXT, TAB);
    expect((await rowsOf(w))[0]?.fields).toEqual({ held: "a" });
    expect(await conditional.end(CONTEXT, TAB, first.digest)).toEqual({
      kind: "ended",
    });
    expect(await ordinary.save(snap({ held: "revived" }))).toBe("failed");
    expect(await rowsOf(w)).toEqual([]);
  });
});
