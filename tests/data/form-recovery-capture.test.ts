// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import { digestOf } from "../../src/data/model/canonical";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { FormRecoveryRow } from "../../src/data/model/types";
import { setClosing } from "../../src/data/plans/fence";
import {
  claimFormWriter,
  saveFormRecovery,
} from "../../src/data/plans/form-recovery";
import { listPlans } from "../../src/data/plans/registry";
import {
  createFormRecoveryPort,
  recoveryWriteBytes,
} from "../../src/data/ports/form-recovery";
import { RECOVERY_PLANS } from "../../src/data/store/recovery-store";
import {
  controlsOf,
  lineageOf,
  unreadable,
  versioned,
} from "../../src/lib/form-recovery/control-state";
import type { RecoverySnapshot } from "../../src/lib/form-recovery/port";
import { DataTestWorld } from "../support/data/env";

/**
 * WEB-14a revision 8 at the store (review of 13 October 2026, R16 and R17; design assessment C1, C2, C5, C6; Q3 and Q16). Over the production
 * port and W9 plans and the IndexedDB double:
 *  - R16: every capture is written WITH its identity (`meta.capture`), and a copy another page wrote is removed only by
 *    `saveFormRecovery` with `expect`, which compares that identity and decides the terminal row in ONE transaction, before anything of the row
 *    (content or order record) changes. A row that holds another capture is left exactly as it is. Claims move the order record only, never
 *    the identity; the same content saved again by its page moves the identity with the order record; an update hand-off's lineage round-trips.
 *  - R17: a copy's control state is stored versioned and exactly as given, is content (in `content_digest`, so a checked box is never "the
 *    same content" as an unchecked one), and a version or entry the form's code cannot read makes the copy unreadable (`controlsOf`), never
 *    a copy without that state. A row with no control state digests exactly as before revision 8.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NAME = accountDatabaseName(ACCOUNT);
const FORM = "task-edit:42";

async function setup(options: { freeBytes?: number } = {}) {
  const env = new DataTestWorld();
  env.idb.autoDrive = true;
  const page = env.page("A");
  page.identity.account = ACCOUNT;
  const opened = await page.open(ACCOUNT, { create: true });
  if (opened.kind !== "opened") throw new Error("setup");
  const store = opened.store;
  const service = {
    store,
    incarnationId: store.incarnationId,
  } as unknown as Parameters<typeof createFormRecoveryPort>[0] extends {
    service(): infer S;
  }
    ? NonNullable<S>
    : never;
  const reserved: number[] = [];
  const quota =
    options.freeBytes === undefined
      ? undefined
      : createQuotaGuard({
          storage: {
            estimate: async () => ({
              usage: 0,
              quota: (options.freeBytes ?? 0) + 4_194_304 + 1_048_576,
            }),
          },
          now: () => Date.now(),
        });
  const port = createFormRecoveryPort({
    service: () => service,
    now: () => "2026-10-14T12:00:00.000Z",
    ...(quota
      ? {
          quota: {
            ...quota,
            reserve: (kind, bytes) => {
              reserved.push(bytes);
              return quota.reserve(kind, bytes);
            },
          },
        }
      : {}),
  });
  const rows = () =>
    (env.idb.snapshot(NAME)?.form_recovery ?? []) as FormRecoveryRow[];
  const row = (tab: string, form = FORM) =>
    rows().find((r) => r.form_context === form && r.tab_instance_id === tab);
  const counter = () =>
    (
      env.idb.snapshot(NAME)?.sync_state as Array<{ form_writer_gen?: number }>
    )?.[0]?.form_writer_gen ?? 0;
  /** The conditional removal (revision 8): the terminal row written ONLY if the row still holds `capture` (`saveFormRecovery` `expect`). */
  const conditional = (tab: string, capture: string, form = FORM) =>
    store.run(saveFormRecovery, {
      incarnationId: store.incarnationId,
      row: {
        form_context: form,
        tab_instance_id: tab,
        fields: {},
        redacted: [],
        saved_at: "2026-10-14T12:30:00.000Z",
        capture_seq: 0,
        terminal: true,
        content_digest: digestOf({}),
      },
      expect: capture,
    });
  /** A port of ANOTHER page context over the same database (its own store handle, writers and claims). */
  const otherPort = async () => {
    const other = env.page("B");
    other.identity.account = ACCOUNT;
    const opened2 = await other.open(ACCOUNT);
    if (opened2.kind !== "opened") throw new Error("setup");
    const service2 = {
      store: opened2.store,
      incarnationId: opened2.store.incarnationId,
    } as unknown as typeof service;
    return createFormRecoveryPort({
      service: () => service2,
      now: () => "2026-10-14T12:20:00.000Z",
    });
  };
  return {
    env,
    store,
    port,
    rows,
    row,
    counter,
    conditional,
    reserved,
    otherPort,
  };
}

const snap = (
  values: Record<string, string>,
  extra: Partial<RecoverySnapshot> = {},
  tab = "tab-a",
): RecoverySnapshot => ({
  formContext: FORM,
  tabInstanceId: tab,
  values,
  savedAt: "2026-10-14T09:00:00.000Z",
  ...extra,
});

describe("R16: a capture is removed only while its row still holds it, decided in one transaction (Q3)", () => {
  test("CONTROL: the row holds the capture: it is terminal now, ordered above every claim, and the counter moved with it", async () => {
    const { port, row, counter, conditional } = await setup();
    expect(await port.save(snap({ title: "P" }, { capture: "cap-p1" }))).toBe(
      "saved",
    );
    const before = row("tab-a") as FormRecoveryRow;
    expect(before.meta?.capture).toBe("cap-p1");
    const gen = counter();
    expect(await conditional("tab-a", "cap-p1")).toEqual({ kind: "saved" });
    const after = row("tab-a") as FormRecoveryRow;
    expect(after.terminal).toBe(true);
    expect(after.fields).toEqual({});
    expect(after.writer_gen).toBe(Math.max(gen, before.writer_gen ?? 0) + 1);
    expect(counter()).toBe(after.writer_gen);
    expect(await port.load(FORM, "tab-a")).toBeNull();
  });

  test("REQUIREMENT: the row holds another capture (its page saved again, with the SAME text): nothing of it changes, not even its order record", async () => {
    const { port, row, counter, conditional } = await setup();
    expect(await port.save(snap({ title: "P" }, { capture: "cap-p1" }))).toBe(
      "saved",
    );
    expect(await port.save(snap({ title: "P" }, { capture: "cap-p2" }))).toBe(
      "saved",
    );
    const before = structuredClone(row("tab-a"));
    expect(before?.meta?.capture).toBe("cap-p2");
    const gen = counter();
    expect(await conditional("tab-a", "cap-p1")).toEqual({ kind: "changed" });
    expect(row("tab-a")).toEqual(before);
    expect(counter()).toBe(gen);
    // Through the port: that capture cannot come back (it was replaced by its own page), and the newer one is left as it is.
    expect(await port.discard(FORM, "tab-a", "cap-p1")).toBe("discarded");
    expect(row("tab-a")).toEqual(before);
    expect((await port.load(FORM, "tab-a"))?.capture).toBe("cap-p2");
  });

  test("REQUIREMENT: another page context asks to remove a capture the row no longer holds: nothing of the row changes, not even its order record (no claim of its writer first)", async () => {
    const { port, row, counter, otherPort } = await setup();
    await port.save(snap({ title: "P" }, { capture: "cap-p1" }));
    await port.save(snap({ title: "P" }, { capture: "cap-p2" }));
    const before = structuredClone(row("tab-a"));
    const gen = counter();
    const b = await otherPort();
    expect(await b.discard(FORM, "tab-a", "cap-p1")).toBe("discarded");
    expect(row("tab-a")).toEqual(before);
    expect(counter()).toBe(gen);
    // CONTROL: the same page context asks for the capture the row holds: removed, ordered above every claim.
    expect(await b.discard(FORM, "tab-a", "cap-p2")).toBe("discarded");
    expect(row("tab-a")?.terminal).toBe(true);
  });

  test("REQUIREMENT: the row holds other content under another capture: left exactly as it is", async () => {
    const { port, row, conditional } = await setup();
    await port.save(snap({ title: "P" }, { capture: "cap-p1" }));
    await port.save(snap({ title: "NEWER" }, { capture: "cap-p2" }));
    const before = structuredClone(row("tab-a"));
    expect(await conditional("tab-a", "cap-p1")).toEqual({ kind: "changed" });
    expect(row("tab-a")).toEqual(before);
  });

  test("a claim of the row (another page context of the same form and tab) moves its order record, never its identity: the capture still matches", async () => {
    const { port, store, row, conditional } = await setup();
    await port.save(snap({ title: "P" }, { capture: "cap-p1" }));
    const claimed = await store.run(claimFormWriter, {
      incarnationId: store.incarnationId,
      formContext: FORM,
      tabInstanceId: "tab-a",
      now: "2026-10-14T12:10:00.000Z",
    });
    expect(claimed.kind).toBe("claimed");
    expect(row("tab-a")?.meta?.capture).toBe("cap-p1");
    expect(row("tab-a")?.capture_seq).toBe(0);
    expect(await conditional("tab-a", "cap-p1")).toEqual({ kind: "saved" });
  });

  test("no row, or a row already terminal: resolved, nothing written (no row is ever created by it)", async () => {
    const { port, rows, conditional } = await setup();
    expect(await conditional("tab-none", "x")).toEqual({ kind: "resolved" });
    expect(rows()).toEqual([]);
    await port.save(snap({ title: "P" }, { capture: "cap-p1" }));
    expect(await port.discard(FORM, "tab-a")).toBe("discarded");
    const terminal = structuredClone(rows());
    expect(await conditional("tab-a", "cap-p1")).toEqual({ kind: "resolved" });
    expect(rows()).toEqual(terminal);
  });

  test("`closing` is set: refused, nothing written; through the port `refused`", async () => {
    const { port, store, row, conditional } = await setup();
    await port.save(snap({ title: "P" }, { capture: "cap-p1" }));
    await store.run(setClosing, {
      incarnationId: store.incarnationId,
      now: 1,
      token: "t",
    });
    const before = structuredClone(row("tab-a"));
    expect(await conditional("tab-a", "cap-p1")).toEqual({ kind: "refused" });
    expect(await port.discard(FORM, "tab-a", "cap-p1")).toBe("refused");
    expect(row("tab-a")).toEqual(before);
  });

  test("the terminal row is above every earlier claim: a late capture of the row's own page (its earlier generation) cannot bring it back", async () => {
    const { port, row } = await setup();
    // The page that wrote P still has a capture on its way (same port: same writer and generation).
    await port.save(snap({ title: "P" }, { capture: "cap-p1" }));
    expect(await port.discard(FORM, "tab-a", "cap-p1")).toBe("discarded");
    expect(
      await port.save(snap({ title: "LATE" }, { capture: "cap-p3" })),
    ).toBe("failed");
    expect(row("tab-a")?.terminal).toBe(true);
  });

  test("no new plan: the conditional removal is a mode of the W9 `saveFormRecovery` (INC, CLS, strict), so the recovery connection runs it as it runs every recovery write", () => {
    const plan = listPlans().find((p) => p.name === "data.saveFormRecovery");
    expect(plan?.writer).toBe("W9");
    expect(plan?.guards).toEqual(["INC", "CLS"]);
    expect(RECOVERY_PLANS).toContain("data.saveFormRecovery");
    expect(listPlans().some((p) => p.name.includes("Capture"))).toBe(false);
  });
});

describe("R16: the identity and lineage are written with the capture, and move only with its order record (Q16)", () => {
  test("the same content saved again by its page: the order record AND the identity move, the content and saved_at do not", async () => {
    const { port, row } = await setup();
    await port.save(snap({ title: "P" }, { capture: "cap-p1" }));
    const first = structuredClone(row("tab-a")) as FormRecoveryRow;
    await port.save({
      ...snap({ title: "P" }, { capture: "cap-p2" }),
      savedAt: "2026-10-14T09:30:00.000Z",
    });
    expect(row("tab-a")).toEqual({
      ...first,
      capture_seq: 2,
      meta: { capture: "cap-p2" },
    });
  });

  test("an update hand-off's lineage round-trips exactly, and moves with the same content saved again", async () => {
    const { port, row } = await setup();
    const handoff = "atlas-update-handoff:task-edit:42";
    const lineage = versioned([
      { formContext: FORM, tabInstanceId: "tab-a", capture: "cap-p1" },
      { formContext: FORM, tabInstanceId: "tab-legacy", capture: null },
    ]);
    expect(
      await port.save({
        formContext: handoff,
        tabInstanceId: "handoff-one",
        values: { title: "P" },
        savedAt: "2026-10-14T09:00:00.000Z",
        capture: "cap-h1",
        lineage,
      }),
    ).toBe("saved");
    const read = await port.load(handoff, "handoff-one");
    expect(read?.lineage).toEqual(lineage);
    expect(lineageOf(read as RecoverySnapshot)).toEqual(lineage.entries);
    expect(read?.capture).toBe("cap-h1");
    expect((await port.list(handoff))[0]?.lineage).toEqual(lineage);
    const moved = versioned([
      { formContext: FORM, tabInstanceId: "tab-a", capture: "cap-p2" },
    ]);
    await port.save({
      formContext: handoff,
      tabInstanceId: "handoff-one",
      values: { title: "P" },
      savedAt: "2026-10-14T09:10:00.000Z",
      capture: "cap-h2",
      lineage: moved,
    });
    expect((await port.load(handoff, "handoff-one"))?.lineage).toEqual(moved);
    expect(row("handoff-one", handoff)?.saved_at).toBe(
      "2026-10-14T09:00:00.000Z",
    );
  });

  test("the store keeps a lineage exactly as given; one the form's code cannot read (another version, an entry that is not a target) is no lineage: nothing is removed on its account", async () => {
    const { port } = await setup();
    const handoff = "atlas-update-handoff:task-edit:42";
    for (const [id, lineage] of [
      ["handoff-v2", { version: 2, entries: [] }],
      ["handoff-bad", { version: 1, entries: [{ formContext: FORM }] }],
      ["handoff-shape", { version: 1, entries: "not a list" }],
    ] as const) {
      expect(
        await port.save({
          formContext: handoff,
          tabInstanceId: id,
          values: { title: "T" },
          savedAt: "2026-10-14T09:00:00.000Z",
          lineage,
        }),
      ).toBe("saved");
      const read = (await port.load(handoff, id)) as RecoverySnapshot;
      expect(read.lineage).toEqual(lineage);
      expect(lineageOf(read)).toEqual([]);
    }
  });
});

describe("R17: control state is stored versioned, and is content (C5, Q16)", () => {
  const checked = versioned({ agree: { kind: "checkbox", checked: true } });
  const unchecked = versioned({ agree: { kind: "checkbox", checked: false } });

  test("control state round-trips beside the texts; the texts stay literal", async () => {
    const { port } = await setup();
    const controls = versioned({
      agree: { kind: "checkbox", checked: true },
      colour: { kind: "radio", value: null },
      tags: { kind: "checkboxes", checked: ["a", "c"] },
      pick: { kind: "multiple", selected: [] },
    });
    const literal = `${String.fromCharCode(1)}{"kind":"checkbox"}`;
    await port.save(snap({ title: literal }, { controls }));
    const read = (await port.load(FORM, "tab-a")) as RecoverySnapshot;
    expect(read.values).toEqual({ title: literal });
    expect(read.controls).toEqual(controls);
    expect(controlsOf(read)).toEqual(controls.entries);
    expect(unreadable(read)).toBe(false);
  });

  test("REQUIREMENT: a checked box saved over the same texts unchecked is NOT the same content: written, digest moved", async () => {
    const { port, row } = await setup();
    await port.save(snap({ title: "T" }, { controls: unchecked }));
    const first = structuredClone(row("tab-a")) as FormRecoveryRow;
    await port.save({
      ...snap({ title: "T" }, { controls: checked }),
      savedAt: "2026-10-14T09:30:00.000Z",
    });
    const second = row("tab-a") as FormRecoveryRow;
    expect(second.content_digest).not.toBe(first.content_digest);
    expect(second.meta?.controls).toEqual(checked);
    expect(second.saved_at).toBe("2026-10-14T09:30:00.000Z");
    expect((await port.load(FORM, "tab-a"))?.controls).toEqual(checked);
  });

  test("CONTROL: a row with no control state digests exactly as before revision 8 (no stored copy's digest moves)", async () => {
    const { port, row } = await setup();
    await port.save(snap({ title: "T" }));
    expect(row("tab-a")?.content_digest).toBe(digestOf({ title: "T" }));
    expect(row("tab-a")?.meta).toBeUndefined();
  });

  test("control state of another version, or an entry that is not a state, is kept exactly as given and makes the copy unreadable to the form's code (never a copy without that state)", async () => {
    const { port } = await setup();
    for (const [tab, controls] of [
      ["tab-v2", { version: 2, entries: { agree: { kind: "toggle" } } }],
      ["tab-bad", { version: 1, entries: { agree: { kind: "checkbox" } } }],
      ["tab-null", { version: 1, entries: null }],
    ] as const) {
      expect(await port.save(snap({ title: "T" }, { controls }, tab))).toBe(
        "saved",
      );
      const read = (await port.load(FORM, tab)) as RecoverySnapshot;
      expect(read.controls).toEqual(controls);
      expect(read.values).toEqual({ title: "T" });
      expect(controlsOf(read)).toBeNull();
      expect(unreadable(read)).toBe(true);
    }
  });

  test("the whole row is sized: control state, identity and lineage count in the reservation (C6)", async () => {
    const { port, reserved } = await setup({ freeBytes: 10_000_000 });
    const controls = versioned({
      tags: { kind: "checkboxes", checked: ["a".repeat(500)] },
    });
    const lineage = versioned([
      { formContext: FORM, tabInstanceId: "tab-a", capture: "c".repeat(300) },
    ]);
    await port.save(
      snap({ title: "T" }, { capture: "k".repeat(200), controls, lineage }),
    );
    const plain = recoveryWriteBytes({
      form_context: FORM,
      tab_instance_id: "tab-a",
      fields: { title: "T" },
      redacted: [],
      saved_at: "2026-10-14T09:00:00.000Z",
      capture_seq: 1,
      writer_gen: 0,
      terminal: false,
      content_digest: digestOf({ title: "T" }),
    });
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toBeGreaterThan(plain + 2 * (500 + 300 + 200));
  });
});
