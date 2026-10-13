// @vitest-environment node
import { describe, expect, test } from "vitest";
import { population } from "../../src/data/model/local-work";
import type { FormRecoveryRow } from "../../src/data/model/types";
import { readFormCopies } from "../../src/data/plans/form-copies";
import { listReadPlans } from "../../src/data/plans/registry";
import { createFormRecoveryPort } from "../../src/data/ports/form-recovery";
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

const list = (w: World, prefix: string) =>
  w.service.store.run(readFormCopies, {
    incarnationId: w.service.incarnationId,
    prefix,
  });

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

  test("an empty prefix lists nothing (a family is always named)", async () => {
    const w = await pageWorld();
    seed(w, [row("people-held:p:f", "t")]);
    expect((await list(w, "")).copies).toEqual([]);
  });
});

describe("a held change is a durable form copy of the account (Q3, Q20)", () => {
  test("saved through the real port, it is listed and read back exactly; a discard ends it", async () => {
    const w = await pageWorld();
    const now = () => "2026-10-13T09:00:00.000Z";
    const store = heldStoreOver(
      createFormRecoveryPort({ service: () => w.service, now }),
      now,
    );
    expect(await store.save(change())).toBe("saved");
    const page = await list(w, heldPrefixOf(P));
    expect(page.copies).toHaveLength(1);
    expect(decodeHeld(page.copies[0] as FormRecoveryRow)).toEqual(change());
    await store.discard({ personId: P, fieldId: F, holdId: change().holdId });
    expect((await list(w, heldPrefixOf(P))).copies).toEqual([]);
  });

  test("it is unsynced local work: a logout warns about it and its consent binds to it (category form_copy)", async () => {
    const w = await pageWorld();
    const now = () => "2026-10-13T09:00:00.000Z";
    const store = heldStoreOver(
      createFormRecoveryPort({ service: () => w.service, now }),
      now,
    );
    await store.save(change());
    const copies = (await list(w, heldPrefixOf(P))).copies;
    expect(population([], copies)).toEqual([
      { kind: "form", category: "form_copy", row: copies[0] },
    ]);
  });

  test("a copy that is not a held change this page can read is never decoded as one", () => {
    const good = row(`people-held:${P}:${F}`, "h", {}) as FormRecoveryRow & {
      fields: Record<string, string>;
    };
    expect(decodeHeld({ ...good, fields: { held: "not json" } })).toBeNull();
    expect(decodeHeld({ ...good, fields: { held: "{}" } })).toBeNull();
    // A copy whose context names another field than its text is not that change.
    const other = heldStoreOver(
      {
        save: async (snapshot) => {
          good.fields = snapshot.values;
          return "saved";
        },
        load: async () => null,
        discard: async () => undefined,
      },
      () => "now",
    );
    void other.save(change());
    expect(decodeHeld(good)).not.toBeNull();
    expect(
      decodeHeld({ ...good, form_context: `people-held:${P}:another` }),
    ).toBeNull();
  });
});
