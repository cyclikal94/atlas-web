import { beforeEach, describe, expect, test } from "vitest";
import type { CacheRow, DraftWithCommand } from "../../../src/data";
import { readMergedUnder } from "../../../src/data/plans/merged-under";
import {
  type ChildPage,
  readChildPage,
  readFormCopiesUnder,
  readOutstandingCreates,
} from "../../../src/data/plans/outstanding-reads";
import type { Loadable, Plan } from "../../../src/data/store/port";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { pageWorld } from "../data/page-world";
import { draftRow, recoveryRow } from "../data/rows";
import { fieldRow, peopleWorld, person } from "./world";

/**
 * The People world's answers to the reads of WEB-11a review 16 (R16.1; design assessment DA16-15) against the PRODUCTION plans. The screens'
 * tests read the world's answers, so a world that pairs a field with a person its read did not hold, ignores a cursor, keeps a draft of
 * another row or reads the witness of another id would let them pass on what the product never shows. Each population is read by BOTH and
 * compared with the same LITERAL expectation, never with each other. FIXTURE evidence: the world answers synchronously from one state and
 * models no pending effects (an acknowledged draft's effect is the production plan's alone, tested in `tests/data/child-reads.test.ts`).
 */
const P = "55555555-5555-4555-8555-555555555555";
const OTHER = "44444444-4444-4444-8444-444444444444";
const KINDS = ["create_person", "put_field", "edit", "archive"];
const fid = (n: number) =>
  `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
const field = (n: number, over: Partial<CacheRow> = {}) =>
  fieldRow({ id: fid(n), parent_id: P, label: `field ${n}`, ...over });
const edit = (target: string, local: string, seq: number, over = {}) =>
  draftRow({
    local_id: local,
    created_seq: seq,
    command: {
      command: { kind: "put_field", id: target, parent_id: P, label: local },
    },
    target_resource_ids: [target],
    index_targets: [target],
    ...over,
  });

beforeEach(() => forgetAllPeopleMemory());

/** The world's answer to `plan` with `input`, read as a screen's watch reads it. */
function worldRead<T>(
  rows: CacheRow[],
  drafts: DraftWithCommand[],
  plan: Plan<never, never, T>,
  input: Record<string, unknown>,
  setup?: (w: ReturnType<typeof peopleWorld>) => void,
): T {
  const w = peopleWorld();
  w.setCache(rows);
  w.setDrafts(drafts);
  setup?.(w);
  const service = w.env.service();
  if (!service) throw new Error("the world has a service");
  const answer = service.store
    .watch(plan as never, { incarnationId: service.incarnationId, ...input })
    .get() as Loadable<T>;
  if (answer.status !== "ready") throw new Error(`not ready: ${answer.status}`);
  return answer.value;
}

async function productionRead<T>(
  rows: CacheRow[],
  drafts: DraftWithCommand[],
  plan: Plan<never, never, T>,
  input: Record<string, unknown>,
  setup?: (w: Awaited<ReturnType<typeof pageWorld>>) => void,
): Promise<T> {
  const real = await pageWorld();
  real.put("cache", rows);
  real.put("drafts", drafts);
  setup?.(real);
  return real.service.store.run(
    plan as never,
    {
      incarnationId: real.service.incarnationId,
      ...input,
    } as never,
  );
}

/** What a child page says: its ids, cursor, the parents it holds (with labels) and the drafts over it (local ids, oldest first). */
const shape = (value: ChildPage) => ({
  ids: value.page.rows.map((row) => row.base.id),
  next: value.page.next,
  parents: Object.fromEntries(
    Object.entries(value.parents).map(([id, row]) => [id, row.label]),
  ),
  ...("drafts" in value
    ? { drafts: value.drafts?.map((d) => d.local_id) ?? null }
    : {}),
});

const populations: Array<{
  name: string;
  rows: CacheRow[];
  drafts?: DraftWithCommand[];
  input: Record<string, unknown>;
  expected: ReturnType<typeof shape>;
}> = [
  {
    name: "a visible person: its fields, the person, and only the outstanding drafts of the kinds over them",
    rows: [
      person({ id: P, label: "Mo" }),
      field(2),
      field(1),
      fieldRow({ id: "f-other", parent_id: OTHER }),
    ],
    drafts: [
      edit(fid(2), "Q2", 3),
      edit(fid(1), "Q1", 2),
      edit(fid(1), "CONFLICT", 4, { status: "version_conflict" }),
      edit("f-other", "ELSEWHERE", 5),
      edit(fid(1), "TASK", 6, { kind: "create_task" }),
    ],
    input: { kind: "field", parentKind: "person", parentId: P, kinds: KINDS },
    expected: {
      ids: [fid(1), fid(2)],
      next: null,
      parents: { [P]: "Mo" },
      drafts: ["Q1", "Q2"],
    },
  },
  {
    name: "no person, the fields still cached: nothing answered, no drafts read",
    rows: [field(1), field(2)],
    drafts: [edit(fid(1), "Q1", 1)],
    input: { kind: "field", parentKind: "person", parentId: P, kinds: KINDS },
    expected: { ids: [], next: null, parents: {}, drafts: [] },
  },
  {
    name: "a row of that id that is not a person: not held",
    rows: [person({ id: P, kind: "task" }), field(1)],
    input: { kind: "field", parentKind: "person", parentId: P },
    expected: { ids: [], next: null, parents: {} },
  },
  {
    name: "a read-only, archived person with no fields: held, an empty page",
    rows: [person({ id: P, label: "Mo", can_edit: false, archived: true })],
    input: { kind: "field", parentKind: "person", parentId: P },
    expected: { ids: [], next: null, parents: { [P]: "Mo" } },
  },
  {
    name: "a visible person with 101 fields, read after the 100th: the last field",
    rows: [
      person({ id: P, label: "Mo" }),
      ...Array.from({ length: 101 }, (_, i) => field(i)),
    ],
    input: {
      kind: "field",
      parentKind: "person",
      parentId: P,
      after: fid(99),
    },
    expected: { ids: [fid(100)], next: null, parents: { [P]: "Mo" } },
  },
  {
    name: "the ledger: 100 fields of an absent person first, one of a visible person after them; the cursor of the page READ",
    rows: [
      person({ id: OTHER, label: "Bo" }),
      ...Array.from({ length: 100 }, (_, i) => field(i)),
      fieldRow({ id: fid(500), parent_id: OTHER }),
    ],
    input: { kind: "field", parentKind: "person", after: null },
    expected: { ids: [], next: fid(99), parents: {} },
  },
  {
    name: "the ledger's next page: the visible person's field, with its person",
    rows: [
      person({ id: OTHER, label: "Bo" }),
      ...Array.from({ length: 100 }, (_, i) => field(i)),
      fieldRow({ id: fid(500), parent_id: OTHER }),
    ],
    input: { kind: "field", parentKind: "person", after: fid(99) },
    expected: { ids: [fid(500)], next: null, parents: { [OTHER]: "Bo" } },
  },
  {
    name: "1,001 draft entries over the page: drafts null",
    rows: [person({ id: P, label: "Mo" }), field(1)],
    drafts: Array.from({ length: 1001 }, (_, i) =>
      edit(fid(1), `D${i}`, i + 1),
    ),
    input: { kind: "field", parentKind: "person", parentId: P, kinds: KINDS },
    expected: {
      ids: [fid(1)],
      next: null,
      parents: { [P]: "Mo" },
      drafts: null,
    },
  },
  // WEB-11a review 17 (R17.1; DA17-09): the bound is of OUTSTANDING drafts, each counted once, never of the entries naming the rows.
  {
    name: "1,001 retained rejections and conflicts over the page, one queued edit: drafts answered (the edit alone)",
    rows: [person({ id: P, label: "Mo" }), field(1), field(2)],
    drafts: [
      ...Array.from({ length: 1001 }, (_, i) =>
        edit(
          fid(i % 2 === 0 ? 1 : 2),
          `R${String(i).padStart(4, "0")}`,
          i + 10,
          {
            status: i % 2 === 0 ? "rejected" : "version_conflict",
          },
        ),
      ),
      edit(fid(2), "LIVE", 5),
    ],
    input: { kind: "field", parentKind: "person", parentId: P, kinds: KINDS },
    expected: {
      ids: [fid(1), fid(2)],
      next: null,
      parents: { [P]: "Mo" },
      drafts: ["LIVE"],
    },
  },
  {
    name: "1,000 queued drafts each naming both fields (2,000 entries): all answered, each once",
    rows: [person({ id: P, label: "Mo" }), field(1), field(2)],
    drafts: Array.from({ length: 1000 }, (_, i) =>
      edit(fid(1), `D${String(i).padStart(4, "0")}`, i + 1, {
        target_resource_ids: [fid(1), fid(2)],
        index_targets: [fid(1), fid(2)],
      }),
    ),
    input: { kind: "field", parentKind: "person", parentId: P, kinds: KINDS },
    expected: {
      ids: [fid(1), fid(2)],
      next: null,
      parents: { [P]: "Mo" },
      drafts: Array.from(
        { length: 1000 },
        (_, i) => `D${String(i).padStart(4, "0")}`,
      ),
    },
  },
  {
    name: "1,001 queued drafts naming both fields: drafts null (the real overflow is still not answered as all)",
    rows: [person({ id: P, label: "Mo" }), field(1), field(2)],
    drafts: Array.from({ length: 1001 }, (_, i) =>
      edit(fid(1), `D${String(i).padStart(4, "0")}`, i + 1, {
        target_resource_ids: [fid(1), fid(2)],
        index_targets: [fid(1), fid(2)],
      }),
    ),
    input: { kind: "field", parentKind: "person", parentId: P, kinds: KINDS },
    expected: {
      ids: [fid(1), fid(2)],
      next: null,
      parents: { [P]: "Mo" },
      drafts: null,
    },
  },
];

describe("data.readChildPage: the world and the production plan answer each population as the contract says", () => {
  for (const population of populations)
    test(population.name, async () => {
      const drafts = population.drafts ?? [];
      expect(
        shape(
          worldRead(
            population.rows,
            drafts,
            readChildPage as never,
            population.input,
          ),
        ),
      ).toEqual(population.expected);
      expect(
        shape(
          await productionRead(
            population.rows,
            drafts,
            readChildPage as never,
            population.input,
          ),
        ),
      ).toEqual(population.expected);
    });
});

describe("data.readMergedUnder: the world and the production plan", () => {
  const cases: Array<{
    name: string;
    rows: CacheRow[];
    input: Record<string, unknown>;
    expected: { resource: string | null; parent: string | null | "none" };
  }> = [
    {
      name: "a field and the person it names",
      rows: [person({ id: P, label: "Mo" }), field(1)],
      input: { id: fid(1) },
      expected: { resource: "field 1", parent: "Mo" },
    },
    {
      name: "the person removed, the field kept: the parent is not cached",
      rows: [field(1)],
      input: { id: fid(1) },
      expected: { resource: "field 1", parent: null },
    },
    {
      name: "a field the cache does not hold, under the person the caller names",
      rows: [person({ id: P, label: "Mo" })],
      input: { id: fid(1), parentId: P },
      expected: { resource: null, parent: "Mo" },
    },
    {
      name: "a resource that names no parent",
      rows: [person({ id: P, label: "Mo" })],
      input: { id: P },
      expected: { resource: "Mo", parent: "none" },
    },
  ];
  const said = (value: {
    resource: { merged: CacheRow | null };
    parent: { merged: CacheRow | null } | null;
  }) => ({
    resource: value.resource.merged?.label ?? null,
    parent:
      value.parent === null ? "none" : (value.parent.merged?.label ?? null),
  });
  for (const c of cases)
    test(c.name, async () => {
      expect(
        said(worldRead(c.rows, [], readMergedUnder as never, c.input)),
      ).toEqual(c.expected);
      expect(
        said(
          await productionRead(c.rows, [], readMergedUnder as never, c.input),
        ),
      ).toEqual(c.expected);
    });
});

describe("witnesses: the world and the production plans", () => {
  for (const held of [true, false])
    test(`data.readOutstandingCreates with a witness: ${held ? "held" : "not held"}`, async () => {
      const rows = held ? [person({ id: P })] : [];
      const drafts = [edit(fid(1), "Q1", 1)];
      const input = { kinds: KINDS, witness: { id: P, kind: "person" } };
      const expected = { drafts: ["Q1"], next: null, witnessed: held };
      const said = (value: {
        drafts: DraftWithCommand[];
        next: number | null;
        witnessed?: boolean;
      }) => ({
        drafts: value.drafts.map((d) => d.local_id),
        next: value.next,
        witnessed: value.witnessed,
      });
      expect(
        said(worldRead(rows, drafts, readOutstandingCreates as never, input)),
      ).toEqual(expected);
      expect(
        said(
          await productionRead(
            rows,
            drafts,
            readOutstandingCreates as never,
            input,
          ),
        ),
      ).toEqual(expected);
    });

  for (const [name, rows, witnessed] of [
    ["held", [person({ id: P })], true],
    ["not held", [], false],
    [
      "a row of that id that is not a person",
      [person({ id: P, kind: "task" })],
      false,
    ],
  ] as const)
    test(`data.readFormCopiesUnder: ${name}`, async () => {
      const copy = recoveryRow({
        form_context: `people-held:${P}:F`,
        tab_instance_id: "h1",
      });
      const input = {
        prefix: `people-held:${P}:`,
        after: null,
        witness: { id: P, kind: "person" },
      };
      const said = (value: {
        page: { copies: Array<{ tab_instance_id: string }> };
        witnessed: boolean;
      }) => ({
        copies: value.page.copies.map((row) => row.tab_instance_id),
        witnessed: value.witnessed,
      });
      const expected = { copies: ["h1"], witnessed };
      expect(
        said(
          worldRead([...rows], [], readFormCopiesUnder as never, input, (w) =>
            w.copies.set(`${copy.form_context}\u0000h1`, copy),
          ),
        ),
      ).toEqual(expected);
      expect(
        said(
          await productionRead(
            [...rows],
            [],
            readFormCopiesUnder as never,
            input,
            (real) => real.put("form_recovery" as never, [copy] as never),
          ),
        ),
      ).toEqual(expected);
    });
});
