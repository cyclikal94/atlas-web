import { beforeEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import {
  readVisibleChildren,
  type VisibleChildren,
} from "../../../src/data/plans/outbox";
import type { Loadable } from "../../../src/data/store/port";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { pageWorld } from "../data/page-world";
import { fieldRow, peopleWorld, person } from "./world";

/**
 * The People world's `data.readVisibleChildren` against the production plan (review 15, R15.1; design assessment DA15-10). The screens'
 * tests read the world's answer, so a world that lists a hidden person's fields (or hides a visible person's) would make them pass on
 * what the product never shows. Each population is read by BOTH and compared with the same LITERAL expectation, not with each other.
 * FIXTURE evidence: the world answers synchronously; the production plan runs over the double of IndexedDB.
 */
const P = "55555555-5555-4555-8555-555555555555";
const OTHER = "44444444-4444-4444-8444-444444444444";
const field = (n: number, over: Partial<CacheRow> = {}) =>
  fieldRow({
    id: `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`,
    parent_id: P,
    ...over,
  });

beforeEach(() => forgetAllPeopleMemory());

/** What a page lists: its ids in order and its cursor, or "hidden". */
const shape = (value: VisibleChildren) =>
  value === null
    ? "hidden"
    : {
        ids: value.rows.map((row) => row.base.id),
        next: value.next,
      };

const populations: Array<{
  name: string;
  rows: CacheRow[];
  expected: ReturnType<typeof shape>;
}> = [
  {
    name: "a visible person with two fields and another person's field",
    rows: [
      person({ id: P }),
      field(2),
      field(1),
      fieldRow({ id: "f-other", parent_id: OTHER }),
    ],
    expected: { ids: [field(1).id, field(2).id], next: null },
  },
  {
    name: "a read-only, archived person",
    rows: [person({ id: P, can_edit: false, archived: true }), field(1)],
    expected: { ids: [field(1).id], next: null },
  },
  {
    name: "no person, the fields still cached",
    rows: [field(1), field(2)],
    expected: "hidden",
  },
  {
    name: "a row of that id that is not a person",
    rows: [person({ id: P, kind: "task" }), field(1)],
    expected: "hidden",
  },
  {
    name: "a visible person with no fields",
    rows: [person({ id: P })],
    expected: { ids: [], next: null },
  },
  {
    name: "a visible person with 101 fields: a page of 100 and a cursor",
    rows: [
      person({ id: P }),
      ...Array.from({ length: 101 }, (_, i) => field(i)),
    ],
    expected: {
      ids: Array.from({ length: 100 }, (_, i) => field(i).id),
      next: field(99).id,
    },
  },
];

describe("the world and the production plan answer each population as the contract says", () => {
  for (const population of populations)
    test(population.name, async () => {
      const w = peopleWorld();
      w.setCache(population.rows);
      const service = w.env.service();
      if (!service) throw new Error("the world has a service");
      const answer = service.store
        .watch(readVisibleChildren, {
          incarnationId: service.incarnationId,
          parentId: P,
          parentKind: "person",
          kind: "field",
        })
        .get() as Loadable<VisibleChildren>;
      expect(answer.status).toBe("ready");
      if (answer.status === "ready")
        expect(shape(answer.value)).toEqual(population.expected);

      const real = await pageWorld();
      real.put("cache", population.rows);
      const produced = await real.service.store.run(readVisibleChildren, {
        incarnationId: real.service.incarnationId,
        parentId: P,
        parentKind: "person",
        kind: "field",
      });
      expect(shape(produced)).toEqual(population.expected);
    });
});
