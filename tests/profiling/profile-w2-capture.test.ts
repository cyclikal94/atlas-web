import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  observeW2Capture,
  RESOURCE_KINDS,
  sameTargetProblems,
} from "../../scripts/lib/profile-w2-capture.mjs";
import { RESOURCE_KINDS as PRODUCTION_KINDS } from "../../src/data/model/types";
import { scanSyncPage } from "../../src/data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
  decodeChange,
  PageInvalid,
} from "../../src/data/scan/validate";

/**
 * scripts/lib/profile-w2-capture.mjs (WEB-09c revision 4; review 4 R2, design assessment A1-A3 and Q-C1-Q-C3): the W2 capture observation,
 * held against the PRODUCTION scanner and decoder as its structural reference. Where they refuse an element, the observer refuses the
 * page; where they admit a page whose checklists are not the seed (they cannot see density: an unregistered value kind is accepted), the
 * observer refuses it. Pages here are built in the test, with fresh ids; the synthetic programme's own captures are read as well.
 */
const encoder = new TextEncoder();
/** The cases edit pages freely: a loosely typed JSON document, as `JSON.parse` returns one. */
type Json = ReturnType<typeof JSON.parse>;
const projection = (
  id: string,
  kind: string,
  parent: string | null,
  label: string,
  value: unknown,
) => ({
  id,
  kind,
  parent_id: parent,
  label,
  value,
  version: 1,
  policy_version: 1,
  can_edit: false,
  archived: false,
});
const checklist = () => {
  const items = Array.from({ length: 100 }, () => ({
    id: randomUUID(),
    label: "x",
  }));
  return {
    kind: "checklist",
    items,
    checked: items.slice(0, 40).map((i) => i.id),
  };
};
interface Page {
  phase: string;
  batches: Array<{ revision: number; changes: Array<Json> }>;
  next_cursor: string;
  has_more: boolean;
}
const seedPage = (person: string): Page => ({
  phase: "delta",
  batches: [
    {
      revision: 12,
      changes: [
        {
          kind: "upsert",
          resource: projection(person, "person", null, "W2 person", null),
        },
        ...Array.from({ length: 199 }, () => ({
          kind: "upsert",
          resource: projection(
            randomUUID(),
            "field",
            person,
            "Checklist",
            checklist(),
          ),
        })),
      ],
    },
  ],
  next_cursor: "d1.0000000c",
  has_more: false,
});
/** What the production processing path says of every element of a page: null, or the decoder's refusal. */
function productionVerdict(bytes: Uint8Array): string | null {
  const scan = scanSyncPage(bytes);
  if (!scan.ok) return `${scan.stage}:${scan.reason}`;
  const deps = {
    validators: createValueValidators(),
    derivers: createKeyDerivers(),
  };
  try {
    for (let i = 0; i < scan.totalChanges; i += 1)
      decodeChange(
        bytes,
        scan.elements[i * 2] as number,
        scan.elements[i * 2 + 1] as number,
        scan.nodes[i] as number,
        deps,
      );
  } catch (error) {
    if (error instanceof PageInvalid) return error.message;
    throw error;
  }
  return null;
}
const observe = (page: unknown, person: string, limit = 1) =>
  observeW2Capture(encoder.encode(JSON.stringify(page)), { person, limit });

describe("profile-w2-capture", () => {
  it("lists the production resource kinds", () => {
    expect([...RESOURCE_KINDS]).toEqual([...PRODUCTION_KINDS]);
  });

  it("accepts the writer's seed, which the production scanner and decoder admit too: 199 fields of 7,402-byte checklists", () => {
    const person = randomUUID();
    const bytes = encoder.encode(JSON.stringify(seedPage(person)));
    expect(productionVerdict(bytes)).toBeNull();
    const observed = observeW2Capture(bytes, { person, limit: 1 });
    expect(observed.problems).toEqual([]);
    expect(observed.target).toMatchObject({
      index: 0,
      revision: 12,
      person,
      fields: 199,
      value_bytes: 7_402,
    });
  });

  it("accepts the synthetic programme's captures (both limits, every engine), which production admits, with one seeded batch per engine", async () => {
    const fixture = (await import(
      pathToFileURL(resolve("scripts/validation/profile-programme-fixture.mjs"))
        .href
    )) as {
      captureBody: (engine: string, limit: number) => string;
      PERSON: string;
    };
    for (const engine of ["chromium", "firefox", "webkit"]) {
      const seen = [1, 80].map((limit) => {
        const bytes = encoder.encode(fixture.captureBody(engine, limit));
        expect(productionVerdict(bytes), `${engine} ${limit}`).toBeNull();
        const o = observeW2Capture(bytes, { person: fixture.PERSON, limit });
        expect(o.problems, `${engine} ${limit}`).toEqual([]);
        return o;
      });
      expect(sameTargetProblems(seen[0] as never, seen[1] as never)).toEqual(
        [],
      );
    }
  });

  it("refuses the page wherever the production decoder refuses one of its elements", () => {
    const person = randomUUID();
    const defects: Array<[string, (c: Json) => void]> = [
      ["a projection field missing", (c) => delete c.resource.can_edit],
      ["a field outside the contract", (c) => (c.resource.extra = 1)],
      ["an id that is not a UUID", (c) => (c.resource.id = "f-1")],
      ["an unknown kind", (c) => (c.resource.kind = "widget")],
      ["a bad parent", (c) => (c.resource.parent_id = 3)],
      ["an empty label", (c) => (c.resource.label = "")],
      ["a value that is an array", (c) => (c.resource.value = [])],
      ["version 0", (c) => (c.resource.version = 0)],
      ["can_edit that is text", (c) => (c.resource.can_edit = "no")],
      ["policy version 0", (c) => (c.resource.policy_version = 0)],
      ["an unknown change kind", (c) => (c.kind = "update")],
      ["an upsert with another key", (c) => (c.extra = true)],
    ];
    for (const [what, change] of defects) {
      const page = seedPage(person);
      change(page.batches[0]?.changes[5] as Json);
      const bytes = encoder.encode(JSON.stringify(page));
      expect(productionVerdict(bytes), what).not.toBeNull();
      expect(
        observeW2Capture(bytes, { person, limit: 1 }).problems.join(" | "),
        what,
      ).toMatch(/batch 1 change 6 /);
    }
    const removal: Page = {
      ...seedPage(person),
      batches: [
        ...seedPage(person).batches,
        {
          revision: 13,
          changes: [{ kind: "remove", id: randomUUID(), resource_kind: "x" }],
        },
      ],
    };
    expect(
      productionVerdict(encoder.encode(JSON.stringify(removal))),
    ).not.toBeNull();
    expect(observe(removal, person, 80).problems.join(" | ")).toMatch(
      /batch 2 change 1 is not a removal of exactly a UUID id/,
    );
  });

  it("refuses what production admits but is not the seed: empty, under-filled or foreign-labelled checklists, a field of another person, a missing field", () => {
    const person = randomUUID();
    const defects: Array<[string, (p: Page) => void, RegExp]> = [
      [
        "every checklist emptied (review 4)",
        (p) => {
          for (const c of p.batches[0]?.changes.slice(1) ?? [])
            Object.assign(c.resource.value, { items: [], checked: [] });
        },
        /holds 0 items, not 100/,
      ],
      [
        "one item fewer",
        (p) => p.batches[0]?.changes[9]?.resource.value.items.pop(),
        /holds 99 items, not 100/,
      ],
      [
        "an item labelled otherwise",
        (p) => {
          const item = p.batches[0]?.changes[9]?.resource.value.items[3];
          item.label = "xy";
        },
        /labelled "xy", not "x"/,
      ],
      [
        "a field of another person",
        (p) => {
          const c = p.batches[0]?.changes[9];
          if (c) c.resource.parent_id = randomUUID();
        },
        /not checklist fields of the seeded person/,
      ],
      [
        "a field removed",
        (p) => p.batches[0]?.changes.pop(),
        /holds 199 changes, not the seed's 200/,
      ],
      [
        "another person's seed",
        (p) => {
          const other = randomUUID();
          for (const c of p.batches[0]?.changes ?? [])
            if (c.resource.id === person) c.resource.id = other;
            else c.resource.parent_id = other;
        },
        /no batch holds the seeded person/,
      ],
    ];
    for (const [what, change, pattern] of defects) {
      const page = seedPage(person);
      change(page);
      const bytes = encoder.encode(JSON.stringify(page));
      expect(productionVerdict(bytes), what).toBeNull();
      expect(
        observeW2Capture(bytes, { person, limit: 1 }).problems.join(" | "),
        what,
      ).toMatch(pattern);
    }
  });

  it("refuses bytes that are not a page, in every form, and never throws", () => {
    const person = randomUUID();
    for (const [text, pattern] of [
      ["null", /is null, not a sync page/],
      ["7", /is a number, not a sync page/],
      ["[]", /is an array, not a sync page/],
      ['"page"', /is a string, not a sync page/],
      ["{}", /the page's fields are \[\]/],
      ["{", /not JSON/],
    ] as const)
      expect(
        observeW2Capture(encoder.encode(text), { person, limit: 1 }).problems,
      ).toEqual([expect.stringMatching(pattern)]);
    expect(
      observeW2Capture(new Uint8Array([0x7b, 0xff, 0x7d]), { person, limit: 1 })
        .problems,
    ).toEqual(["the capture is not UTF-8"]);
  });

  it("compares the two limits' seeded batches by revision and contents", () => {
    const person = randomUUID();
    const page = seedPage(person);
    const a = observe(page, person, 1);
    const later = structuredClone(page);
    later.batches.push({
      revision: 13,
      changes: [{ kind: "remove", id: randomUUID() }],
    });
    expect(sameTargetProblems(a, observe(later, person, 80))).toEqual([]);
    const moved = structuredClone(page);
    (moved.batches[0] as { revision: number }).revision = 11;
    expect(sameTargetProblems(a, observe(moved, person, 80))).toEqual([
      expect.stringMatching(/revision 12 at one limit and 11 at the other/),
    ]);
    const renamed = structuredClone(page);
    const renamedChange = renamed.batches[0]?.changes[4] as Json;
    renamedChange.resource.label = "Other";
    expect(sameTargetProblems(a, observe(renamed, person, 80))).toEqual([
      "the seeded batch's contents differ between the two limits",
    ]);
  });
});
