// @vitest-environment node
import { describe, expect, test } from "vitest";
import { accountDatabaseName } from "../../src/data/model/schema";
import {
  LIST_PAGE_ROWS,
  listFormRecovery,
} from "../../src/data/plans/form-recovery";
import { listPlans } from "../../src/data/plans/registry";
import { createFormRecoveryPort } from "../../src/data/ports/form-recovery";
import { DataTestWorld } from "../support/data/env";

/**
 * WEB-14a D-P6: `FormRecoveryPort.list`, every copy of one form that can still be restored. One row per [form, tab]; newest first; a
 * discarded (terminal) copy is not listed; another form's rows are not listed; EVERY restorable copy is answered, whatever the number of
 * terminal rows (revision 1, R5), while each read of the walk is bounded; and a port with no open database answers an empty list. FIXTURE
 * evidence over the double of IndexedDB.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

async function portFor(account: string, env = new DataTestWorld()) {
  env.idb.autoDrive = true;
  const page = env.page(account);
  page.identity.account = account;
  const opened = await page.open(account, { create: true });
  if (opened.kind !== "opened") throw new Error("setup");
  const store = opened.store;
  const service = { store, incarnationId: store.incarnationId } as never;
  let saved = 0;
  const port = createFormRecoveryPort({
    service: () => service,
    // Each save is a second later than the one before: `saved_at` orders the list.
    now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, saved++)).toISOString(),
  });
  return { env, port, store };
}

const snap = (tab: string, at: number, ctx = "task-edit:42") => ({
  formContext: ctx,
  tabInstanceId: tab,
  values: { title: `from ${tab}` },
  savedAt: new Date(Date.UTC(2026, 9, 1, 9, 0, at)).toISOString(),
});

describe("FormRecoveryPort.list", () => {
  test("newest first, one per tab, only the form asked for", async () => {
    const { port } = await portFor(ACCOUNT);
    expect(await port.save(snap("tab-a", 1))).toBe("saved");
    expect(await port.save(snap("tab-c", 3))).toBe("saved");
    expect(await port.save(snap("tab-b", 2))).toBe("saved");
    expect(await port.save(snap("tab-z", 9, "other-form"))).toBe("saved");
    const listed = await port.list("task-edit:42");
    expect(listed.map((s) => s.tabInstanceId)).toEqual([
      "tab-c",
      "tab-b",
      "tab-a",
    ]);
    expect(listed[0]?.values).toEqual({ title: "from tab-c" });
  });

  test("a discarded copy is not listed, and a later save of the same tab is", async () => {
    const { port } = await portFor(ACCOUNT);
    await port.save(snap("tab-a", 1));
    await port.save(snap("tab-b", 2));
    await port.discard("task-edit:42", "tab-b");
    expect(
      (await port.list("task-edit:42")).map((s) => s.tabInstanceId),
    ).toEqual(["tab-a"]);
    expect(await port.save(snap("tab-b", 5))).toBe("saved");
    expect(
      (await port.list("task-edit:42")).map((s) => s.tabInstanceId),
    ).toEqual(["tab-b", "tab-a"]);
  });

  // ADAPTED (revision 1, R5). Revision 0 asserted "at most 10 copies are answered" (the 10 newest). The review showed that bound hides an
  // eligible copy (ten open tabs' copies in front of a closed tab's) and omits alternatives the design says must be offered; the intent kept
  // is the order (newest first) and that nothing is lost, now for every copy.
  test("every copy is answered, newest first, however many there are", async () => {
    const { port } = await portFor(ACCOUNT);
    for (let i = 0; i < 13; i += 1)
      expect(
        await port.save(snap(`tab-${String(i).padStart(2, "0")}`, i)),
      ).toBe("saved");
    const listed = await port.list("task-edit:42");
    expect(listed).toHaveLength(13);
    expect(listed[0]?.tabInstanceId).toBe("tab-12");
    expect(listed.at(-1)?.tabInstanceId).toBe("tab-00");
  });

  test(`${LIST_PAGE_ROWS * 2 + 7} terminal rows whose ids sort first do not hide a durable copy; no read returns more than ${LIST_PAGE_ROWS} rows`, async () => {
    const { env, port } = await portFor(ACCOUNT);
    expect(await port.save(snap("zz-live", 1))).toBe("saved");
    for (let i = 0; i < LIST_PAGE_ROWS * 2 + 7; i += 1) {
      const tab = `aa-${String(i).padStart(4, "0")}`;
      expect(await port.save(snap(tab, 2))).toBe("saved");
      expect(await port.discard("task-edit:42", tab)).toBe("discarded");
    }
    expect(await port.save(snap("ab-live", 0))).toBe("saved");
    env.idb.reads.reset();
    const listed = await port.list("task-edit:42");
    expect(listed.map((s) => s.tabInstanceId)).toEqual(["zz-live", "ab-live"]);
    expect(
      env.idb.reads.maxBatch.get("form_recovery") ?? 0,
    ).toBeLessThanOrEqual(LIST_PAGE_ROWS);
    expect(env.idb.reads.rows.get("form_recovery")).toBe(
      LIST_PAGE_ROWS * 2 + 9,
    );
  });

  test("a walk that ends exactly on a page boundary still reads to the end", async () => {
    const { port } = await portFor(ACCOUNT);
    for (let i = 0; i < LIST_PAGE_ROWS - 1; i += 1) {
      const tab = `aa-${String(i).padStart(4, "0")}`;
      await port.save(snap(tab, 2));
      await port.discard("task-edit:42", tab);
    }
    expect(await port.save(snap("zz-live", 1))).toBe("saved");
    expect(
      (await port.list("task-edit:42")).map((s) => s.tabInstanceId),
    ).toEqual(["zz-live"]);
  });

  test("the walk is readonly, and it lists the incarnation guard (R18)", () => {
    expect(LIST_PAGE_ROWS).toBeGreaterThan(0);
    expect(listFormRecovery.mode).toBe("readonly");
    const registered = listPlans().find(
      (plan) => plan.name === "data.listFormRecovery",
    );
    expect(registered).toMatchObject({ writer: "W9", guards: ["INC"] });
  });

  test("one database per account: another account's copies are never listed", async () => {
    const env = new DataTestWorld();
    const a = await portFor(ACCOUNT, env);
    await a.port.save(snap("tab-a", 1));
    const b = await portFor(OTHER, env);
    expect(await b.port.list("task-edit:42")).toEqual([]);
    expect(accountDatabaseName(ACCOUNT)).not.toBe(accountDatabaseName(OTHER));
  });

  test("no open database: an empty list, never a throw", async () => {
    const port = createFormRecoveryPort({
      service: () => null,
      now: () => "2026-10-01T12:00:00.000Z",
    });
    expect(await port.list("task-edit:42")).toEqual([]);
  });
});

/**
 * WEB-14a revision 1, R6: a discard says what it did. `discarded` only when no copy of that form and tab can be restored; `failed` when the
 * copy may come back (the caller must not say it was discarded); `refused` while the account is being signed out.
 */
describe("FormRecoveryPort.discard answers what it did", () => {
  test("a copy that is there: discarded, and it is no longer listed", async () => {
    const { port } = await portFor(ACCOUNT);
    await port.save(snap("tab-a", 1));
    expect(await port.discard("task-edit:42", "tab-a")).toBe("discarded");
    expect(await port.list("task-edit:42")).toEqual([]);
  });

  test("no copy at all: discarded (nothing can be restored)", async () => {
    const { port } = await portFor(ACCOUNT);
    expect(await port.discard("task-edit:42", "tab-never")).toBe("discarded");
  });

  test("a write that fails: failed, and the copy is still there", async () => {
    const { env, port } = await portFor(ACCOUNT);
    await port.save(snap("tab-a", 1));
    env.idb.inject({
      match: (tx) => tx.label === "data.saveFormRecovery",
      mode: "error",
      times: 1,
    });
    expect(await port.discard("task-edit:42", "tab-a")).toBe("failed");
    expect(
      (await port.list("task-edit:42")).map((s) => s.tabInstanceId),
    ).toEqual(["tab-a"]);
  });

  test("no copy, and the terminal row cannot be created: discarded (nothing can be restored; an earlier capture is refused)", async () => {
    const { env, port } = await portFor(ACCOUNT);
    // The first write finds no row (`absent`); the second, which would create the terminal row, fails.
    let writes = 0;
    env.idb.inject({
      match: (tx) => tx.label === "data.saveFormRecovery" && ++writes === 2,
      mode: "error",
      times: 1,
    });
    expect(await port.discard("task-edit:42", "tab-a")).toBe("discarded");
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(await port.list("task-edit:42")).toEqual([]);
  });

  test("no open database: failed", async () => {
    const port = createFormRecoveryPort({
      service: () => null,
      now: () => "2026-10-01T12:00:00.000Z",
    });
    expect(await port.discard("task-edit:42", "tab-a")).toBe("failed");
  });

  test("closing is set: refused", async () => {
    const { port, store } = await portFor(ACCOUNT);
    await port.save(snap("tab-a", 1));
    const { setClosing } = await import("../../src/data/plans/fence");
    await store.run(setClosing, {
      incarnationId: store.incarnationId,
      now: 1,
      token: "t",
    });
    expect(await port.discard("task-edit:42", "tab-a")).toBe("refused");
  });
});

/** Revision 1: `pin` fixes the port to the account and store handle it reaches NOW. */
describe("FormRecoveryPort.pin", () => {
  test("answers the account it reaches now and one port per store handle; a pinned port keeps writing there; nothing to pin without a store", async () => {
    const env = new DataTestWorld();
    const a = await portFor(ACCOUNT, env);
    const b = await portFor(OTHER, env);
    let target: { store: unknown; incarnationId: string } | null = {
      store: a.store,
      incarnationId: a.store.incarnationId,
    };
    const port = createFormRecoveryPort({
      service: () => target as never,
      now: () => "2026-10-01T12:00:00.000Z",
    });
    const pinned = port.pin?.();
    expect(pinned?.account).toBe(ACCOUNT);
    expect(port.pin?.()?.port).toBe(pinned?.port);
    target = { store: b.store, incarnationId: b.store.incarnationId };
    expect(port.pin?.()?.account).toBe(OTHER);
    expect(await pinned?.port.save(snap("tab-a", 1))).toBe("saved");
    expect(
      (await a.port.list("task-edit:42")).map((s) => s.tabInstanceId),
    ).toEqual(["tab-a"]);
    expect(await b.port.list("task-edit:42")).toEqual([]);
    target = null;
    expect(port.pin?.()).toBeNull();
  });
});
