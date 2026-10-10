// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import { digestOf } from "../../src/data/model/canonical";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { FormRecoveryRow } from "../../src/data/model/types";
import { setClosing } from "../../src/data/plans/fence";
import { saveFormRecovery } from "../../src/data/plans/form-recovery";
import { listPlans } from "../../src/data/plans/registry";
import { createFormRecoveryPort } from "../../src/data/ports/form-recovery";
import { DataTestWorld } from "../support/data/env";
import { recoveryRow } from "../support/data/rows";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NAME = accountDatabaseName(ACCOUNT);

async function setup() {
  const env = new DataTestWorld();
  env.idb.autoDrive = true;
  const page = env.page("A");
  page.identity.account = ACCOUNT;
  const opened = await page.open(ACCOUNT, { create: true });
  if (opened.kind !== "opened") throw new Error("setup");
  const store = opened.store;
  // The port is bound to a service; a minimal one over the same store is enough for these tests.
  const service = {
    store,
    incarnationId: store.incarnationId,
  } as unknown as Parameters<typeof createFormRecoveryPort>[0] extends {
    service(): infer S;
  }
    ? NonNullable<S>
    : never;
  let current: typeof service | null = service;
  const port = createFormRecoveryPort({
    service: () => current,
    now: () => "2026-10-01T12:00:00.000Z",
  });
  const rows = () =>
    (env.idb.snapshot(NAME)?.form_recovery ?? []) as FormRecoveryRow[];
  return {
    env,
    store,
    port,
    rows,
    drop: () => {
      current = null;
    },
  };
}

const snap = (
  values: Record<string, string>,
  tab = "tab-a",
  ctx = "task-edit:42",
) => ({
  formContext: ctx,
  tabInstanceId: tab,
  values,
  savedAt: "2026-10-01T09:00:00.000Z",
});

describe("FormRecoveryPort over the form_recovery store", () => {
  test("save then load round-trips, per [form, tab]: two tabs on one form stay separate", async () => {
    const { port } = await setup();
    expect(await port.save(snap({ title: "from A" }, "tab-a"))).toBe("saved");
    expect(await port.save(snap({ title: "from B" }, "tab-b"))).toBe("saved");
    expect((await port.load("task-edit:42", "tab-a"))?.values).toEqual({
      title: "from A",
    });
    expect((await port.load("task-edit:42", "tab-b"))?.values).toEqual({
      title: "from B",
    });
    expect(await port.load("task-edit:42", "tab-c")).toBeNull();
  });

  test("the same content again does not write: no saved_at bump, so the digest of the work does not move", async () => {
    const { port, rows } = await setup();
    await port.save({
      ...snap({ title: "x" }),
      savedAt: "2026-10-01T09:00:00.000Z",
    });
    const first = rows()[0] as FormRecoveryRow;
    await port.save({
      ...snap({ title: "x" }),
      savedAt: "2026-10-01T09:05:00.000Z",
    });
    // Only the order record moved (the capture is the latest); the content, its digest and `saved_at` did not.
    expect(rows()[0]).toEqual({ ...first, capture_seq: 2 });
    expect(rows()[0]?.saved_at).toBe("2026-10-01T09:00:00.000Z");
  });

  test("every capture takes the next sequence in CALL order; the same content again moves the order record and nothing else", async () => {
    const { port, rows } = await setup();
    await port.save(snap({ title: "one" }));
    expect(rows()[0]?.capture_seq).toBe(1);
    await port.save(snap({ title: "two" }));
    expect(rows()[0]?.capture_seq).toBe(2);
    const before = rows()[0];
    await port.save({
      ...snap({ title: "two" }),
      savedAt: "2026-10-01T09:30:00.000Z",
    });
    // The capture is durable (the content is there) and it is the latest: the ORDER record moves up so that an older capture still
    // on its way cannot land above it. The content, its digest and `saved_at` do not move.
    expect(rows()[0]?.capture_seq).toBe(3);
    expect(rows()[0]).toEqual({ ...before, capture_seq: 3 });
  });

  test("admission inside the transaction: a late write of an older capture cannot overwrite a newer one (non-terminal needs `>`)", async () => {
    const { store, rows } = await setup();
    const row = (seq: number, title: string): FormRecoveryRow =>
      recoveryRow({
        form_context: "f",
        tab_instance_id: "t",
        fields: { title },
        capture_seq: seq,
        content_digest: digestOf({ title }),
      });
    const run = (r: FormRecoveryRow) =>
      store.run(saveFormRecovery, {
        incarnationId: store.incarnationId,
        row: r,
      });
    expect(await run(row(5, "five"))).toEqual({ kind: "saved" });
    // Declined for its place in the order, with other content: NOT durable, and FINAL (never "unchanged", and nothing to retry).
    expect(await run(row(4, "four"))).toEqual({ kind: "superseded" });
    expect(await run(row(5, "five-again"))).toEqual({ kind: "superseded" });
    // This very content is already durable, whatever number it carries: nothing to write and nothing to retry.
    expect(await run(row(3, "five"))).toEqual({ kind: "unchanged" });
    expect(rows()[0]?.fields).toEqual({ title: "five" });
    expect(await run(row(6, "six"))).toEqual({ kind: "saved" });
    expect(rows()[0]?.fields).toEqual({ title: "six" });
  });

  test("a terminal write is admitted at `>=`, clears the fields, and the row is kept (never hard-deleted)", async () => {
    const { store, rows, port } = await setup();
    await port.save(snap({ title: "x" }));
    await port.discard("task-edit:42", "tab-a");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ terminal: true, fields: {} });
    expect(await port.load("task-edit:42", "tab-a")).toBeNull();
    // An equal-sequence terminal write is admitted; an equal-sequence non-terminal one is not.
    const stored = rows()[0] as FormRecoveryRow;
    expect(
      await store.run(saveFormRecovery, {
        incarnationId: store.incarnationId,
        row: { ...stored, saved_at: "later" },
      }),
    ).toEqual({ kind: "saved" });
    expect(
      await store.run(saveFormRecovery, {
        incarnationId: store.incarnationId,
        row: {
          ...stored,
          terminal: false,
          fields: { a: "b" },
          content_digest: digestOf({ a: "b" }),
        },
      }),
    ).toEqual({ kind: "superseded" });
    // New typing after a terminal capture (a higher number) reopens the row.
    expect(await port.save(snap({ title: "typed again" }))).toBe("saved");
    expect((await port.load("task-edit:42", "tab-a"))?.values).toEqual({
      title: "typed again",
    });
  });

  test("REFUSED once `closing` is set, in the same connection and in a brand-new one, and nothing is written (MU-14)", async () => {
    const { env, store, port, rows } = await setup();
    await port.save(snap({ title: "before" }));
    await store.run(setClosing, {
      incarnationId: store.incarnationId,
      now: 1,
      token: "t",
    });
    expect(await port.save(snap({ title: "after" }))).toBe("refused");
    expect(rows()[0]?.fields).toEqual({ title: "before" });
    // A brand-new connection (another tab) sees the same durable fact.
    const other = env.page("B");
    other.identity.account = ACCOUNT;
    const reopened = await other.open(ACCOUNT);
    if (reopened.kind !== "opened") throw new Error("setup");
    const second = createFormRecoveryPort({
      service: () =>
        ({
          store: reopened.store,
          incarnationId: reopened.store.incarnationId,
        }) as never,
      now: () => "t",
    });
    expect(await second.save(snap({ title: "from a new tab" }, "tab-z"))).toBe(
      "refused",
    );
    expect(rows().map((r) => r.tab_instance_id)).toEqual(["tab-a"]);
  });

  test("a recovery write is still allowed while a fence stands without `closing` (it is counted in the digest)", async () => {
    const { store, port } = await setup();
    const { setDraftFence } = await import("../../src/data/plans/fence");
    await store.run(setDraftFence, {
      incarnationId: store.incarnationId,
      now: 1,
      token: "t",
      operationId: "op",
    });
    expect(await port.save(snap({ title: "still saving" }))).toBe("saved");
  });

  test("a failed write is `failed`, never a throw; no service is `failed`; the user-input quota refuses last", async () => {
    const { env, port, drop } = await setup();
    env.idb.inject({
      match: (tx) => tx.label === "data.saveFormRecovery",
      mode: "error",
      times: 1,
    });
    expect(await port.save(snap({ title: "x" }))).toBe("failed");
    expect(await port.save(snap({ title: "x" }))).toBe("saved");
    drop();
    expect(await port.save(snap({ title: "y" }))).toBe("failed");
    expect(await port.load("task-edit:42", "tab-a")).toBeNull();
    await expect(
      port.discard("task-edit:42", "tab-a"),
    ).resolves.toBeUndefined();
  });

  test("the quota reserve refuses user input only below half the reserve", async () => {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = ACCOUNT;
    const opened = await page.open(ACCOUNT, { create: true });
    if (opened.kind !== "opened") throw new Error("setup");
    const make = (free: number) =>
      createFormRecoveryPort({
        service: () =>
          ({
            store: opened.store,
            incarnationId: opened.store.incarnationId,
          }) as never,
        quota: createQuotaGuard({
          storage: { estimate: async () => ({ usage: 0, quota: free }) },
          now: () => 0,
        }),
        now: () => "t",
      });
    expect(await make(3 * 1024 * 1024).save(snap({ a: "1" }))).toBe("failed");
    expect(await make(6 * 1024 * 1024).save(snap({ a: "1" }))).toBe("saved");
  });
});

describe("a page context that loads after another saved: its first capture is the later one, with no reconciliation (R1)", () => {
  /**
   * A reloaded page: a NEW store handle for the same database (what a reload, or a re-opened account, makes), and a port over it.
   * Its writer state is fresh; whatever the durable row says, its claim of the generation is what puts it after.
   */
  async function reloaded() {
    const world = await setup();
    const reload = async () => {
      const page = world.env.page("A");
      page.identity.account = ACCOUNT;
      const opened = await page.open(ACCOUNT);
      if (opened.kind !== "opened") throw new Error("setup: reload");
      const store = opened.store;
      const port = createFormRecoveryPort({
        service: () => ({ store, incarnationId: store.incarnationId }) as never,
        now: () => "2026-10-01T12:00:00.000Z",
      });
      return { store, port };
    };
    return { ...world, reload };
  }

  test("several earlier captures, a reload, then newer text: the new text is saved, durably, in a LATER generation, and the next capture follows in order", async () => {
    const { port, reload, rows } = await reloaded();
    for (const title of ["one", "two", "three"])
      expect(await port.save(snap({ title }))).toBe("saved");
    expect(rows()[0]).toMatchObject({ capture_seq: 3, writer_gen: 1 });

    const { port: after } = await reload();
    expect((await after.load("task-edit:42", "tab-a"))?.values.title).toBe(
      "three",
    );
    // No reconciliation: the claim is the generation above the stored one, and the first capture is its first sequence.
    expect(await after.save(snap({ title: "four" }))).toBe("saved");
    expect((await after.load("task-edit:42", "tab-a"))?.values.title).toBe(
      "four",
    );
    expect(rows()[0]).toMatchObject({ capture_seq: 1, writer_gen: 2 });
    expect(await after.save(snap({ title: "five" }))).toBe("saved");
    expect(rows()[0]).toMatchObject({ capture_seq: 2, writer_gen: 2 });
  });

  test("the content already stored, saved again after a reload, is durable: saved, and neither the content nor saved_at moves", async () => {
    const { port, reload, rows } = await reloaded();
    await port.save(snap({ title: "one" }));
    await port.save(snap({ title: "two" }));
    const before = structuredClone(rows()[0]) as FormRecoveryRow;
    const { port: after } = await reload();
    expect(await after.save(snap({ title: "two" }))).toBe("saved");
    // Only the order record (the generation, the sequence) moved.
    expect(rows()[0]).toEqual({ ...before, writer_gen: 2, capture_seq: 1 });
  });

  test("a discard after a reload clears a row stored in an earlier generation, and typing after it reopens the row", async () => {
    const { port, reload, rows } = await reloaded();
    for (const title of ["a", "b", "c", "d", "e"])
      await port.save(snap({ title }));
    expect(rows()[0]?.capture_seq).toBe(5);
    const { port: after } = await reload();
    await after.discard("task-edit:42", "tab-a");
    expect(rows()[0]).toMatchObject({
      terminal: true,
      fields: {},
      writer_gen: 2,
    });
    expect(await after.load("task-edit:42", "tab-a")).toBeNull();
    expect(await after.save(snap({ title: "again" }))).toBe("saved");
    expect((await after.load("task-edit:42", "tab-a"))?.values.title).toBe(
      "again",
    );
  });

  test("a capture the store declines as superseded is reported as failed after ONE write, never as saved, and is never re-numbered above the newer one", async () => {
    const writes: Array<{ gen: number | undefined; seq: number }> = [];
    const stubborn = createFormRecoveryPort({
      service: () =>
        ({
          incarnationId: "i",
          store: {
            run: async (
              plan: { name: string },
              input: { row: FormRecoveryRow },
            ) => {
              if (plan.name === "data.claimFormWriter")
                return { kind: "claimed", gen: 4 };
              writes.push({
                gen: input.row.writer_gen,
                seq: input.row.capture_seq,
              });
              return { kind: "superseded" };
            },
          },
        }) as never,
      now: () => "t",
    });
    expect(await stubborn.save(snap({ title: "x" }))).toBe("failed");
    expect(writes).toEqual([{ gen: 4, seq: 1 }]);
  });

  test("a write of an earlier page instance that landed but was never answered: the reloaded page still saves newer text after it", async () => {
    const { env, port, reload, rows } = await reloaded();
    await port.save(snap({ title: "before" }));
    // The earlier page's write of "second" commits, but the page never hears back (it was reloaded meanwhile): its caller is
    // never told "saved".
    env.idb.inject({
      match: (tx) => tx.label === "data.saveFormRecovery",
      mode: "commit_then_lose_completion",
      times: 1,
    });
    let answered: string | null = null;
    void port.save(snap({ title: "second" })).then((r) => {
      answered = r;
    });
    await env.settle();
    expect(rows()[0]?.fields).toEqual({ title: "second" });
    expect(answered).toBeNull();
    // The reloaded page claims the next generation and saves newer text in it.
    const { port: after } = await reload();
    expect(await after.save(snap({ title: "third" }))).toBe("saved");
    expect(rows()[0]).toMatchObject({
      fields: { title: "third" },
      writer_gen: 2,
      capture_seq: 1,
    });
    expect((await after.load("task-edit:42", "tab-a"))?.values.title).toBe(
      "third",
    );
  });

  test("an older capture can never overwrite a newer one, whichever order they reach the store in (sequence within a generation, and generation across them)", async () => {
    const { store, rows } = await reloaded();
    // (generation, sequence) pairs in capture order 1, 2, 3; the text names the capture.
    const captures: Array<[number, number]> = [
      [1, 1],
      [1, 7],
      [2, 1],
    ];
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [2, 0, 1],
      [1, 0, 2],
      [0, 2, 1],
    ];
    for (const [index, order] of orders.entries()) {
      // One tab per order, so each order starts from nothing.
      const tab = `tab-order-${index}`;
      for (const at of order) {
        const [gen, seq] = captures[at] as [number, number];
        await store.run(saveFormRecovery, {
          incarnationId: store.incarnationId,
          row: recoveryRow({
            form_context: "task-edit:42",
            tab_instance_id: tab,
            fields: { title: `text-${at}` },
            capture_seq: seq,
            writer_gen: gen,
            content_digest: digestOf({ title: `text-${at}` }),
          }),
        });
      }
      expect(
        rows().find((r) => r.tab_instance_id === tab)?.fields,
        `order ${order.join(",")}`,
      ).toEqual({ title: "text-2" });
    }
  });

  test("writes of one form and tab from one port run one at a time, in call order", async () => {
    const { port, rows } = await reloaded();
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((title) => port.save(snap({ title }))),
    );
    expect(results).toEqual(["saved", "saved", "saved", "saved"]);
    expect(rows()[0]?.fields).toEqual({ title: "d" });
    expect(rows()[0]?.capture_seq).toBe(4);
  });

  test("two accounts' databases never share a writer: the same form and tab keep separate numbers and generations", async () => {
    const a = await setup();
    const b = await setup();
    await a.port.save(snap({ title: "a1" }));
    await a.port.save(snap({ title: "a2" }));
    expect(await b.port.save(snap({ title: "b1" }))).toBe("saved");
    expect(b.rows()[0]).toMatchObject({ capture_seq: 1, writer_gen: 1 });
  });
});

describe("the form_recovery writer's scope (MU-15)", () => {
  test("every writing plan of the store has `sync_state` in its scope, because the `closing` argument depends on overlapping-scope ordering", () => {
    const writers = listPlans().filter(
      (p) => p.writer === "W9" && p.mode === "readwrite",
    );
    expect(writers.length).toBeGreaterThan(0);
    for (const plan of writers) {
      expect(plan.scope, plan.name).toContain("sync_state");
      expect(plan.scope, plan.name).toContain("form_recovery");
      expect(plan.guards, plan.name).toEqual(
        expect.arrayContaining(["INC", "CLS"]),
      );
      expect(plan.durability, plan.name).toBe("strict");
    }
  });
});
