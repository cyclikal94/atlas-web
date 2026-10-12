import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { productionRefusal } from "../../scripts/lib/production-page-reader.mjs";
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

  // ---- Revision 5 (review 5 R2; design assessment DA-E1/DA-E2, Q1/Q2): the BYTES, not their parsed form ----------------------------------
  // Every case is a literal edit of a page's text whose PARSED form is unchanged (or only legally changed), with the production verdict
  // stated here independently ("accept" or the refusal it must give), checked against the production scanner and decoder imported directly,
  // against the observer's reader of the candidate's modules (scripts/lib/production-page-reader.mjs) and against the observer.
  const PAGE_KEYS = ["phase", "batches", "next_cursor", "has_more"] as const;
  /** `{"key":<value text>` of the page's own top-level member, so a duplicate written with it parses to the very same page. */
  const member = (page: Page, key: (typeof PAGE_KEYS)[number]) =>
    `${JSON.stringify(key)}:${JSON.stringify(page[key])}`;
  /** The first character of a key written as a `\u` escape: the same decoded key, other bytes. */
  const escaped = (key: string) =>
    `"\\u${key.charCodeAt(0).toString(16).padStart(4, "0")}${key.slice(1)}"`;
  const companionPage = (person: string, value: unknown): Page => {
    const page = seedPage(person);
    page.batches.push({
      revision: 13,
      changes: [
        {
          kind: "upsert",
          resource: {
            id: randomUUID(),
            kind: "task",
            parent_id: null,
            label: "companion",
            value,
            version: 1,
            can_edit: false,
            archived: false,
          },
        },
      ],
    });
    return page;
  };
  /** A value whose deepest object lies `levels` objects below the value itself. */
  const nested = (levels: number) => {
    let value: Json = { leaf: true };
    for (let i = 0; i < levels; i += 1) value = { n: value };
    return value;
  };
  type Verdict = "accept" | RegExp;
  const raw = (
    what: string,
    text: string | Uint8Array,
    expected: Verdict,
    person: string,
    limit = 1,
  ) => ({
    what,
    bytes: typeof text === "string" ? encoder.encode(text) : text,
    expected,
    person,
    limit,
  });
  const expectVerdicts = (
    cases: Array<ReturnType<typeof raw>>,
  ): Array<ReturnType<typeof observeW2Capture>> =>
    cases.map(({ what, bytes, expected, person, limit }) => {
      const direct = productionVerdict(bytes);
      const reader = productionRefusal(bytes, { limit });
      const observed = observeW2Capture(bytes, { person, limit });
      if (expected === "accept") {
        expect(direct, what).toBeNull();
        expect(reader, what).toBeNull();
        expect(observed.problems, what).toEqual([]);
        expect(observed.target, what).not.toBeNull();
      } else {
        // The direct helper writes `stage:reason`; the reader `stage: reason`.
        expect((direct ?? "").replace(":", ": "), what).toMatch(expected);
        expect(reader ?? "", what).toMatch(expected);
        expect(observed.problems.join(" | "), what).toMatch(expected);
        expect(observed.target, what).toBeNull();
      }
      return observed;
    });

  it("refuses, as production does, every duplicated or escaped-alias page key whose parsed page is unchanged, before or after the original", () => {
    const person = randomUUID();
    const page = seedPage(person);
    const text = JSON.stringify(page);
    expect(text.startsWith('{"phase":')).toBe(true);
    const cases = [raw("the page as written", text, "accept", person)];
    for (const key of PAGE_KEYS) {
      const pattern = new RegExp(`structure: duplicate ${key}`);
      cases.push(
        raw(
          `${key} twice, first`,
          `{${member(page, key)},${text.slice(1)}`,
          pattern,
          person,
        ),
        raw(
          `${key} twice, last`,
          `${text.slice(0, -1)},${member(page, key)}}`,
          pattern,
          person,
        ),
        raw(
          `${key} twice, once escaped`,
          `{${member(page, key).replace(JSON.stringify(key), escaped(key))},${text.slice(1)}`,
          pattern,
          person,
        ),
        raw(
          `${key} once, escaped (legal)`,
          text.replace(`${JSON.stringify(key)}:`, `${escaped(key)}:`),
          "accept",
          person,
        ),
      );
    }
    for (const c of cases)
      expect(JSON.parse(new TextDecoder().decode(c.bytes)), c.what).toEqual(
        page,
      );
    expectVerdicts(cases);
  });

  it("refuses, as production does, a duplicated batch revision or changes and every non-plain revision; plain revisions, reordered keys and whitespace stay valid", () => {
    const person = randomUUID();
    const page = seedPage(person);
    const text = JSON.stringify(page);
    const changes = JSON.stringify(page.batches[0]?.changes);
    expect(text).toContain('"batches":[{"revision":12,"changes":');
    const batchAt = (replacement: string) =>
      text.replace('{"revision":12,', replacement);
    const cases = [
      raw(
        "revision twice",
        batchAt('{"revision":12,"revision":12,'),
        /structure: duplicate revision/,
        person,
      ),
      raw(
        "revision twice, escaped",
        batchAt('{"revision":12,"\\u0072evision":12,'),
        /structure: duplicate revision/,
        person,
      ),
      raw(
        "changes twice",
        batchAt(`{"changes":${changes},"revision":12,`),
        /structure: duplicate changes/,
        person,
      ),
      raw(
        "revision 12e0",
        batchAt('{"revision":12e0,'),
        /structure: expected a plain integer/,
        person,
      ),
      raw(
        "revision 12E0",
        batchAt('{"revision":12E0,'),
        /structure: expected a plain integer/,
        person,
      ),
      raw(
        "revision 1.2e1",
        batchAt('{"revision":1.2e1,'),
        /structure: expected a plain integer/,
        person,
      ),
      raw(
        "revision 12.0",
        batchAt('{"revision":12.0,'),
        /structure: expected a plain integer/,
        person,
      ),
      raw(
        "batch keys reordered (legal)",
        text.replace(
          `{"revision":12,"changes":${changes}}`,
          `{"changes":${changes},"revision":12}`,
        ),
        "accept",
        person,
      ),
      raw(
        "whitespace between every structural token (legal)",
        ` \n{ "phase" : "delta" ,\t"batches" : [ { "revision" : 12 , "changes" : ${changes} } ] , "next_cursor" : "d1.0000000c" , "has_more" : false }\r\n`,
        "accept",
        person,
      ),
      raw(
        "a resource version written 1e0 (legal: production decodes resource fields as numbers)",
        text.replace('"version":1,', '"version":1e0,'),
        "accept",
        person,
      ),
    ];
    for (const c of cases)
      expect(JSON.parse(new TextDecoder().decode(c.bytes)), c.what).toEqual(
        page,
      );
    const zero = seedPage(person);
    (zero.batches[0] as { revision: number }).revision = 0;
    const zeroText = JSON.stringify(zero);
    expectVerdicts([
      ...cases,
      raw("revision 0 (legal)", zeroText, "accept", person),
      raw(
        "revision -0",
        zeroText.replace('"revision":0,', '"revision":-0,'),
        /structure: expected a non-negative integer/,
        person,
      ),
    ]);
  });

  it("refuses a byte order mark and invalid UTF-8 in the cursor, as production does; a non-ASCII and escaped cursor stays valid", () => {
    const person = randomUUID();
    const text = JSON.stringify(seedPage(person));
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(text)]);
    // The bytes as they are: the BOM is not dropped on the way in (the observer's own decoder would drop it).
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bom)).toBe(text);
    const cursor = encoder.encode(text);
    const at =
      encoder.encode(text).length -
      encoder.encode('c","has_more":false}').length;
    const badCursor = new Uint8Array([
      ...cursor.subarray(0, at),
      0xff,
      ...cursor.subarray(at),
    ]);
    expectVerdicts([
      raw("a byte order mark", bom, /syntax: expected '\{'/, person),
      raw(
        "a cursor of non-ASCII and escaped characters (legal)",
        text.replace('"d1.0000000c"', '"d1.é😀\\u00e9\\ud83d\\ude00"'),
        "accept",
        person,
      ),
    ]);
    expect(productionRefusal(bom, { limit: 1 }) ?? "").toMatch(/at byte 0\)$/);
    expect(productionVerdict(badCursor)).toBe("syntax:invalid text");
    expect(productionRefusal(badCursor, { limit: 1 }) ?? "").toMatch(
      /syntax: invalid text/,
    );
    expect(observeW2Capture(badCursor, { person, limit: 1 })).toMatchObject({
      problems: ["the capture is not UTF-8"],
      target: null,
    });
  });

  it("applies production's nesting, element-size and element-node gates to a companion batch at their exact bounds", () => {
    const person = randomUUID();
    // Depth: the document 1, batches 2, a batch 3, changes 4, the change 5, its resource 6, the value 7: 17 objects below the value reach
    // maxDepth 24 exactly, 18 go beyond it.
    const depth = (levels: number) =>
      JSON.stringify(companionPage(person, nested(levels)));
    // Element bytes: the companion change's text padded to exactly maxChangeBytes (65,536), then one byte more.
    const padded = (size: number) => {
      const page = companionPage(person, { t: "" });
      const change = page.batches[1]?.changes[0] as Json;
      change.resource.value.t = "p".repeat(
        size - JSON.stringify(change).length,
      );
      expect(JSON.stringify(change).length).toBe(size);
      return JSON.stringify(page);
    };
    // Element nodes: the change, its kind, the resource, its seven scalars and its value object (11), the value's array (12) and n
    // numbers: n = 8,180 is maxValueNodes 8,192 exactly.
    const nodes = (n: number) =>
      JSON.stringify(companionPage(person, { a: Array(n).fill(0) }));
    expectVerdicts([
      raw(
        "a valid companion of another kind with any value (legal)",
        JSON.stringify(companionPage(person, { unknown: "allowed" })),
        "accept",
        person,
        80,
      ),
      raw(
        "companion value nested to depth 24 (legal)",
        depth(17),
        "accept",
        person,
        80,
      ),
      raw(
        "companion value nested to depth 25",
        depth(18),
        /limit: nesting too deep/,
        person,
        80,
      ),
      raw(
        "companion element of 65,536 bytes (legal)",
        padded(65_536),
        "accept",
        person,
        80,
      ),
      raw(
        "companion element of 65,537 bytes",
        padded(65_537),
        /gate: element_too_large/,
        person,
        80,
      ),
      raw(
        "companion element of 8,192 nodes (legal)",
        nodes(8_180),
        "accept",
        person,
        80,
      ),
      raw(
        "companion element of 8,193 nodes",
        nodes(8_181),
        /gate: too_many_nodes/,
        person,
        80,
      ),
    ]);
  });

  it("names the production refusal of a body above the response bound for its limit", () => {
    const person = randomUUID();
    const text = JSON.stringify(seedPage(person));
    expect(productionRefusal(encoder.encode(text), { limit: 1 })).toBeNull();
    // maxResponseBytesFor(1) = 800 x 9,216 x 1.5 + 65,536 = 11,124,736 bytes; trailing whitespace is legal JSON, so only the size refuses.
    const big = encoder.encode(text + " ".repeat(11_124_737 - text.length));
    expect(productionVerdict(big)).toBeNull();
    expect(productionRefusal(big, { limit: 1 }) ?? "").toMatch(
      /oversize: 11124737 bytes, above the 11124736-byte response bound for limit 1/,
    );
    expect(observeW2Capture(big, { person, limit: 1 })).toMatchObject({
      target: null,
    });
    expect(productionRefusal(encoder.encode(text), { limit: 0 }) ?? "").toMatch(
      /not a positive integer/,
    );
  });
});
