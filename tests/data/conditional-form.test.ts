// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { QuotaGuard } from "../../src/data/engine/quota-guard";
import { digestOf } from "../../src/data/model/canonical";
import type { FormRecoveryRow } from "../../src/data/model/types";
import { setClosing } from "../../src/data/plans/fence";
import { readFormCopies } from "../../src/data/plans/form-copies";
import { saveFormRecovery } from "../../src/data/plans/form-recovery";
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
    // Adapted (review 4): an ended row is read as `ended` with what its terminal write kept (nothing, without a tombstone).
    expect(await port.read(CONTEXT, TAB)).toMatchObject({
      kind: "ended",
      fields: {},
    });
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

describe("review 4: several rows in one transaction, tombstones and one binding per operation (the assessment's C7, C10)", () => {
  const head = (values: Record<string, string>) => ({
    snapshot: { ...snap(values, "~head") },
    terminal: true,
  });

  test("`apply` writes every row or none: a second row not as read leaves the first unwritten", async () => {
    const w = await pageWorld();
    const port = portOf(w);
    expect(
      await port.apply([
        {
          snapshot: snap({ held: "a" }),
          terminal: false,
          expect: { state: "absent" },
        },
        {
          ...head({ h: "1" }),
          expect: { state: "ended", digest: "not-there" },
        },
      ]),
    ).toEqual({ kind: "changed", index: 1, stored: "absent" });
    expect(await rowsOf(w)).toEqual([]);
    expect(await port.read(CONTEXT, TAB)).toEqual({ kind: "absent" });
    // Control: both as read, both written.
    const both = await port.apply([
      {
        snapshot: snap({ held: "a" }),
        terminal: false,
        expect: { state: "absent" },
      },
      { ...head({ h: "1" }), expect: { state: "absent" } },
    ]);
    expect(both).toEqual({
      kind: "saved",
      digests: [digestOf({ held: "a" }), digestOf({ h: "1" })],
    });
    expect(await port.read(CONTEXT, "~head")).toEqual({
      kind: "ended",
      fields: { h: "1" },
      digest: digestOf({ h: "1" }),
    });
    // A terminal row is never listed (a head is not a held change).
    expect((await rowsOf(w)).map((row) => row.tab_instance_id)).toEqual([TAB]);
  });

  test("`apply` replaces a TERMINAL row only from the digest read (a field's head), never from another", async () => {
    const w = await pageWorld();
    const port = portOf(w);
    await port.apply([{ ...head({ h: "1" }), expect: { state: "absent" } }]);
    expect(
      await port.apply([
        { ...head({ h: "2" }), expect: { state: "ended", digest: "stale" } },
      ]),
    ).toEqual({ kind: "changed", index: 0, stored: "ended" });
    expect(
      await port.apply([
        {
          ...head({ h: "2" }),
          expect: { state: "ended", digest: digestOf({ h: "1" }) },
        },
      ]),
    ).toMatchObject({ kind: "saved" });
    expect(await port.read(CONTEXT, "~head")).toMatchObject({
      fields: { h: "2" },
    });
  });

  test("`apply` is refused while signing out, and a failure inside the store is `failed` with nothing written", async () => {
    const w = await pageWorld();
    const port = portOf(w);
    await w.service.store.run(setClosing, {
      incarnationId: w.service.incarnationId,
      now: 1,
      token: "t",
    });
    expect(
      await port.apply([
        {
          snapshot: snap({ held: "a" }),
          terminal: false,
          expect: { state: "absent" },
        },
      ]),
    ).toEqual({ kind: "refused" });
    const w2 = await pageWorld();
    const run = w2.service.store.run.bind(w2.service.store);
    w2.service.store.run = ((plan: { name: string }, input: never) =>
      plan.name === "data.saveFormOperation"
        ? Promise.reject(new Error("injected storage failure"))
        : run(plan as never, input)) as typeof w2.service.store.run;
    expect(
      await portOf(w2).apply([
        {
          snapshot: snap({ held: "a" }),
          terminal: false,
          expect: { state: "absent" },
        },
      ]),
    ).toEqual({ kind: "failed" });
    expect(await rowsOf(w2)).toEqual([]);
  });

  test("an end keeps the caller's tombstone, and a read of the ended row says what it kept", async () => {
    const w = await pageWorld();
    const port = portOf(w);
    const first = await port.put(snap({ held: "a" }), null);
    if (first.kind !== "saved") throw new Error("setup");
    expect(
      await port.end(CONTEXT, TAB, first.digest, { held_end: "why" }),
    ).toEqual({ kind: "ended" });
    expect(await port.read(CONTEXT, TAB)).toEqual({
      kind: "ended",
      fields: { held_end: "why" },
      digest: digestOf({ held_end: "why" }),
    });
    // Still terminal for every writer.
    expect(await port.put(snap({ held: "late" }), null)).toEqual({
      kind: "changed",
      stored: "ended",
    });
  });

  for (const moved of [true, false])
    test(`a PINNED port ${moved ? "fails every call once another service is displayed: nothing reaches the new one" : "control: keeps working while its service is displayed"} (C10)`, async () => {
      const x = await pageWorld();
      const y = await pageWorld();
      let displayed = x.service;
      const port = createConditionalFormPort({
        service: () => displayed,
        now: () => NOW,
      }).pinned();
      expect((await port.put(snap({ held: "a" }), null)).kind).toBe("saved");
      if (moved) displayed = y.service;
      const answers = [
        await port.put(snap({ held: "b" }, "hold-2"), null),
        await port.apply([
          {
            snapshot: snap({ held: "c" }, "hold-3"),
            terminal: false,
            expect: { state: "absent" },
          },
        ]),
        await port.read(CONTEXT, TAB),
      ];
      if (moved) {
        expect(answers.map((answer) => answer.kind)).toEqual([
          "failed",
          "failed",
          "failed",
        ]);
        expect(await port.list("people-held:", null)).toBeNull();
        expect(await rowsOf(y)).toEqual([]);
        expect((await rowsOf(x)).map((row) => row.tab_instance_id)).toEqual([
          TAB,
        ]);
      } else
        expect(answers.map((answer) => answer.kind)).toEqual([
          "saved",
          "saved",
          "live",
        ]);
    });
});

describe("WEB-14a / WEB-11a integration: capture identity and content digest", () => {
  test("a digest string cannot retire a capture, and a People replacement invalidates the old capture", async () => {
    const w = await pageWorld();
    const ordinary = createFormRecoveryPort({
      service: () => w.service,
      now: () => NOW,
    });
    expect(
      await ordinary.save({
        ...snap({ held: "original" }),
        capture: "pwa-capture",
      }),
    ).toBe("saved");
    const [row] = await rowsOf(w);
    if (!row) throw new Error("Expected a saved recovery row");
    const retire = (capture: string) =>
      w.service.store.run(saveFormRecovery, {
        incarnationId: w.service.incarnationId,
        row: {
          ...row,
          terminal: true,
          fields: {},
          content_digest: digestOf({}),
        },
        expect: capture,
      });
    expect(await retire(row.content_digest)).toEqual({ kind: "changed" });
    expect((await rowsOf(w))[0]).toEqual(row);
    expect(
      await portOf(w).put(
        snap({ held: "new People state" }),
        row.content_digest,
      ),
    ).toEqual({
      kind: "saved",
      digest: digestOf({ held: "new People state" }),
    });
    expect(await retire("pwa-capture")).toEqual({ kind: "changed" });
    expect((await rowsOf(w))[0]?.fields).toEqual({ held: "new People state" });
  });

  test("exact PWA retirement stays terminal against a People write with the old digest", async () => {
    const w = await pageWorld();
    const ordinary = createFormRecoveryPort({
      service: () => w.service,
      now: () => NOW,
    });
    expect(
      await ordinary.save({
        ...snap({ held: "original" }),
        capture: "pwa-capture",
      }),
    ).toBe("saved");
    const [row] = await rowsOf(w);
    if (!row) throw new Error("Expected a saved recovery row");
    expect(
      await w.service.store.run(saveFormRecovery, {
        incarnationId: w.service.incarnationId,
        row: {
          ...row,
          terminal: true,
          fields: {},
          content_digest: digestOf({}),
        },
        expect: "pwa-capture",
      }),
    ).toEqual({ kind: "saved" });
    expect(
      await portOf(w).put(
        snap({ held: "obsolete People state" }),
        row.content_digest,
      ),
    ).toEqual({ kind: "changed", stored: "ended" });
    const read = await portOf(w).read(CONTEXT, TAB);
    expect(read.kind).toBe("ended");
  });
});
