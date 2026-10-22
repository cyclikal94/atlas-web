// @vitest-environment node
import { describe, expect, test } from "vitest";
import { population } from "../../src/data/model/local-work";
import type { FormRecoveryRow } from "../../src/data/model/types";
import { readFormCopies } from "../../src/data/plans/form-copies";
import { listReadPlans } from "../../src/data/plans/registry";
import { createConditionalFormPort } from "../../src/data/ports/conditional-form";
import {
  decodeHeld,
  type HeldChange,
  heldPrefixOf,
  heldStoreOver,
} from "../../src/features/people/field/held-store";
import { pageWorld } from "../support/data/page-world";

/**
 * `readFormCopies` and WEB-11a's DURABLE held audience changes over it (finding 6 of the review of 13 October 2026): a held change is a
 * form copy of the account's own database, written through WEB-09a's `FormRecoveryPort` and listed by its family prefix. Fixture evidence
 * over the double of IndexedDB (the real plans and the real port).
 */
type World = Awaited<ReturnType<typeof pageWorld>>;

const row = (
  context: string,
  tab: string,
  over: Partial<FormRecoveryRow> = {},
): FormRecoveryRow => ({
  form_context: context,
  tab_instance_id: tab,
  fields: { held: "{}" },
  redacted: [],
  saved_at: "2026-10-13T09:00:00.000Z",
  capture_seq: 1,
  writer_gen: 1,
  terminal: false,
  content_digest: "d",
  ...over,
});

/** The world's `put` is typed for the stores its other tests seed; `form_recovery` is a store of the same double. */
const seed = (w: World, rows: FormRecoveryRow[]) =>
  (w.put as unknown as (store: string, rows: FormRecoveryRow[]) => void)(
    "form_recovery",
    rows,
  );

const list = (
  w: World,
  prefix: string,
  after: readonly [string, string] | null = null,
) =>
  w.service.store.run(readFormCopies, {
    incarnationId: w.service.incarnationId,
    prefix,
    after,
  });

/** Every live copy of a prefix, page by page from the cursors, with the number of reads it took. */
async function walk(w: World, prefix: string) {
  const seen: string[] = [];
  let after: readonly [string, string] | null = null;
  let reads = 0;
  do {
    const page = await list(w, prefix, after);
    reads += 1;
    seen.push(...page.copies.map((row) => row.tab_instance_id));
    if (page.next !== null && after !== null)
      expect(
        page.next[0] > after[0] ||
          (page.next[0] === after[0] && page.next[1] > after[1]),
      ).toBe(true);
    after = page.next;
    if (reads > 100) throw new Error("the walk does not end");
  } while (after !== null);
  return { seen, reads };
}

const P = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const change = (over: Partial<HeldChange> = {}): HeldChange => ({
  holdId: "aaaaaaaa-0000-4000-8000-000000000001",
  fieldId: F,
  personId: P,
  label: "Medical note",
  value: { kind: "text", text: "Penicillin" },
  sameKind: true,
  version: 4,
  expectedBase: 4,
  from: {
    version: 6,
    policy: {
      grants: [{ kind: "household", id: "h", edit: false }],
      exclude_accounts: [],
    },
  },
  to: { grants: [], exclude_accounts: [] },
  attempt: null,
  status: { kind: "waiting" },
  heldAt: "2026-10-13T09:00:00.000Z",
  rev: 0,
  queued: false,
  ...over,
});

describe("readFormCopies", () => {
  test("is a registered READ plan over form_recovery only", () => {
    const entry = listReadPlans().find(
      (plan) => plan.name === "data.readFormCopies",
    );
    expect(entry?.mode).toBe("readonly");
    expect(entry?.scope).toEqual(
      expect.arrayContaining(["form_recovery", "sync_state"]),
    );
    expect(entry?.scope).not.toContain("drafts");
  });

  test("lists the live copies of ONE family by prefix, oldest first, and never a terminal (discarded or finished) one", async () => {
    const w = await pageWorld();
    seed(w, [
      row("people-held:p1:f1", "b", { saved_at: "2026-10-13T09:00:02.000Z" }),
      row("people-held:p1:f2", "a", { saved_at: "2026-10-13T09:00:01.000Z" }),
      row("people-held:p1:f3", "c", { terminal: true, fields: {} }),
      row("people-held:p2:f1", "d"),
      row("task-editor:p1", "e"),
    ]);
    const page = await list(w, "people-held:p1:");
    expect(page.copies.map((r) => r.tab_instance_id)).toEqual(["a", "b"]);
    expect(page.more).toBe(false);
  });

  test("is bounded: one window of copies, and `more` when further copies may follow", async () => {
    const w = await pageWorld();
    seed(
      w,
      Array.from({ length: 101 }, (_, i) =>
        row(`people-held:p:f${String(i).padStart(3, "0")}`, `t${i}`),
      ),
    );
    const page = await list(w, "people-held:p:");
    expect(page.copies).toHaveLength(100);
    expect(page.more).toBe(true);
  });

  test("terminal rows are crossed, never a dead end (review 2, finding 4): 999, 1,000 and 1,001 of them before one live hold", async () => {
    for (const terminal of [999, 1000, 1001]) {
      const w = await pageWorld();
      const context = `people-held:${P}:${F}`;
      seed(w, [
        ...Array.from({ length: terminal }, (_, i) =>
          row(context, `t${String(i).padStart(5, "0")}`, {
            terminal: true,
            fields: {},
          }),
        ),
        row(context, "z-live"),
      ]);
      const first = await list(w, heldPrefixOf(P));
      if (terminal < 1000) {
        // The live hold is in the scan bound's last row: it is returned (the cursor may still say "more", conservatively).
        expect(first.copies.map((r) => r.tab_instance_id)).toEqual(["z-live"]);
      } else {
        // The scan bound: no live copy in this page, and a cursor that moved past the terminal rows it read.
        expect(first.copies).toEqual([]);
        expect(first.more).toBe(true);
        expect(first.next).toEqual([context, "t00999"]);
      }
      const { seen } = await walk(w, heldPrefixOf(P));
      expect(seen).toEqual(["z-live"]);
      // The terminal rows are kept (they order late captures).
      expect(
        (
          await w.service.store.run(readFormCopies, {
            incarnationId: w.service.incarnationId,
            prefix: heldPrefixOf(P),
          })
        ).copies.length,
      ).toBeLessThanOrEqual(1);
    }
  });

  test("0, 99, 100 and 101 live copies: each met exactly once, in bounded reads, a full page ending AT its last copy", async () => {
    for (const count of [0, 99, 100, 101]) {
      const w = await pageWorld();
      seed(
        w,
        Array.from({ length: count }, (_, i) =>
          row(`people-held:p:f${String(i).padStart(3, "0")}`, `t${i}`),
        ),
      );
      const { seen, reads } = await walk(w, "people-held:p:");
      expect([...seen].sort()).toEqual(
        Array.from({ length: count }, (_, i) => `t${i}`).sort(),
      );
      expect(reads).toBe(count >= 100 ? 2 : 1);
    }
  });

  test("a key cursor does not shift: a copy added BEFORE it is not met again, one AFTER it is met, a terminalised one is skipped", async () => {
    const w = await pageWorld();
    seed(
      w,
      Array.from({ length: 150 }, (_, i) =>
        row(`people-held:p:f${String(i).padStart(3, "0")}`, `t${i}`),
      ),
    );
    const first = await list(w, "people-held:p:");
    expect(first.copies).toHaveLength(100);
    expect(first.next).toEqual(["people-held:p:f099", "t99"]);
    seed(w, [
      row("people-held:p:f000", "a-before"),
      row("people-held:p:f149", "z-after"),
      row("people-held:p:f120", "t120", { terminal: true, fields: {} }),
    ]);
    const second = await list(w, "people-held:p:", first.next);
    const ids = second.copies.map((r) => r.tab_instance_id);
    expect(ids).not.toContain("a-before");
    expect(ids).toContain("z-after");
    expect(ids).not.toContain("t120");
    expect(ids).toHaveLength(50);
    expect(second.next).toBeNull();
  });

  test("a cursor of another family reads nothing (a late page of another person is never this one's)", async () => {
    const w = await pageWorld();
    seed(w, [row("people-held:p1:f", "a"), row("people-held:p2:f", "b")]);
    const page = await list(w, "people-held:p1:", ["people-held:p2:f", "b"]);
    expect(page).toEqual({ copies: [], next: null, more: false });
  });

  test("an empty prefix lists nothing (a family is always named)", async () => {
    const w = await pageWorld();
    seed(w, [row("people-held:p:f", "t")]);
    expect((await list(w, "")).copies).toEqual([]);
  });
});

const heldStore = (w: World) => {
  const now = () => "2026-10-13T09:00:00.000Z";
  return heldStoreOver(
    createConditionalFormPort({ service: () => w.service, now }),
    now,
  );
};
const KEY = { personId: P, fieldId: F, holdId: change().holdId };

describe("a held change is a durable form copy of the account (Q3, Q20)", () => {
  test("held through the real conditional port, it is listed and read back exactly; an end from its stored state ends it", async () => {
    const w = await pageWorld();
    const store = heldStore(w);
    const created = await store.create(change());
    expect(created.kind).toBe("saved");
    const page = await list(w, heldPrefixOf(P));
    expect(page.copies).toHaveLength(1);
    expect(decodeHeld(page.copies[0] as FormRecoveryRow)).toEqual(change());
    const digest = (page.copies[0] as FormRecoveryRow).content_digest;
    expect(created.kind === "saved" && created.copy.digest).toBe(digest);
    expect(await store.end(KEY, digest)).toEqual({ kind: "ended" });
    expect((await list(w, heldPrefixOf(P))).copies).toEqual([]);
    expect(await store.read(KEY)).toEqual({ kind: "ended" });
  });

  test("it is unsynced local work: a logout warns about it and its consent binds to it (category form_copy)", async () => {
    const w = await pageWorld();
    await heldStore(w).create(change());
    const copies = (await list(w, heldPrefixOf(P))).copies;
    expect(population([], copies)).toEqual([
      { kind: "form", category: "form_copy", row: copies[0] },
    ]);
  });

  test("a copy of the first shape (v 1) is read as state 0, not admitted; an unknown shape or a mismatched context is not a held change", () => {
    const first = row(`people-held:${P}:${F}`, change().holdId, {
      fields: {
        held: JSON.stringify({
          v: 1,
          fieldId: F,
          personId: P,
          label: "Medical note",
          value: { kind: "text", text: "Penicillin" },
          sameKind: true,
          version: 4,
          expectedBase: 4,
          from: change().from,
          to: change().to,
          attempt: null,
          failed: null,
          heldAt: change().heldAt,
        }),
      },
    });
    expect(decodeHeld(first)).toEqual(change());
    expect(decodeHeld({ ...first, fields: { held: "not json" } })).toBeNull();
    expect(decodeHeld({ ...first, fields: { held: "{}" } })).toBeNull();
    expect(
      decodeHeld({ ...first, form_context: `people-held:${P}:another` }),
    ).toBeNull();
  });
});
