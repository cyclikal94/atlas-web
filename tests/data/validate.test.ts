// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { scanSyncPage } from "../../src/data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
  decodeChange,
  PageInvalid,
} from "../../src/data/scan/validate";
import {
  bytesOf,
  type Projection,
  pageJson,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * F-C10 (plan 8.3): the validators reject hostile input with a FIXED-SHAPE summary only. Nothing of the document, of a value, or
 * of a validator's own issue list is read, stored or logged.
 */
const deps = () => ({
  validators: createValueValidators(),
  derivers: createKeyDerivers(),
});
const element = (change: unknown) => {
  const bytes = bytesOf(JSON.stringify(change));
  return { bytes, start: 0, end: bytes.length, nodes: 1 };
};
const decode = (change: unknown, d = deps()) => {
  const e = element(change);
  return decodeChange(e.bytes, e.start, e.end, e.nodes, d);
};
const refusal = (change: unknown, d = deps()): PageInvalid => {
  try {
    decode(change, d);
  } catch (error) {
    if (error instanceof PageInvalid) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};
const good = (over: Partial<Projection> = {}): Projection => ({
  id: uuid(1),
  kind: "task",
  parent_id: null,
  label: "Water plants",
  value: { a: 1 },
  version: 3,
  can_edit: true,
  archived: false,
  ...over,
});
// An id with letters in it, so that upper-casing it actually changes something.
const LETTERS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const upsert = (resource: object) => ({
  kind: "upsert",
  resource,
});

describe("decode: the accepted shapes", () => {
  test("an upsert becomes a cache row with the base fields verbatim and `kind_date` null by default", () => {
    const out = decode(upsert(good()));
    expect(out).toEqual({
      kind: "upsert",
      row: {
        id: uuid(1),
        kind: "task",
        parent_id: null,
        label: "Water plants",
        value: { a: 1 },
        version: 3,
        can_edit: true,
        archived: false,
        kind_date: null,
      },
    });
  });
  test("`policy_version` is carried when present and the key is absent when not", () => {
    const withPolicy = decode(upsert(good({ policy_version: 4 })));
    expect(withPolicy.kind === "upsert" && withPolicy.row.policy_version).toBe(
      4,
    );
    const without = decode(upsert(good()));
    expect(without.kind === "upsert" && "policy_version" in without.row).toBe(
      false,
    );
  });
  test("a null value, a null parent, and a parent id are all fine", () => {
    expect(decode(upsert(good({ value: null }))).kind).toBe("upsert");
    expect(decode(upsert(good({ parent_id: uuid(2) }))).kind).toBe("upsert");
  });
  test("a remove carries the id", () => {
    expect(decode({ kind: "remove", id: uuid(9) })).toEqual({
      kind: "remove",
      id: uuid(9),
    });
  });
  test("all eleven kinds are accepted", () => {
    for (const kind of [
      "person",
      "field",
      "task",
      "execution",
      "occurrence",
      "progress",
      "list",
      "calendar_source",
      "event",
      "review",
      "reminder",
    ])
      expect(decode(upsert(good({ kind }))).kind).toBe("upsert");
  });
  test("a label of 300 code points is accepted, 301 is not (code points, not UTF-16 units)", () => {
    expect(decode(upsert(good({ label: "a".repeat(300) }))).kind).toBe(
      "upsert",
    );
    expect(decode(upsert(good({ label: "😀".repeat(300) }))).kind).toBe(
      "upsert",
    );
    expect(refusal(upsert(good({ label: "a".repeat(301) }))).reason).toBe(
      "bad_label",
    );
    expect(refusal(upsert(good({ label: "😀".repeat(301) }))).reason).toBe(
      "bad_label",
    );
  });
  test("the registered kind-date deriver supplies `kind_date`, and a registered value validator can refuse", () => {
    const d = deps();
    d.derivers.register(
      "occurrence",
      (row) => (row.value as { date?: string } | null)?.date ?? null,
    );
    const out = decode(
      upsert(good({ kind: "occurrence", value: { date: "2026-10-01" } })),
      d,
    );
    expect(out.kind === "upsert" && out.row.kind_date).toBe("2026-10-01");
    d.validators.register(
      "task",
      (value) => (value as { ok?: boolean } | null)?.ok === true,
    );
    expect(
      refusal(upsert(good({ kind: "task", value: { ok: false } })), d),
    ).toMatchObject({ stage: "value", reason: "rejected_by_kind" });
    expect(
      decode(upsert(good({ kind: "task", value: { ok: true } })), d).kind,
    ).toBe("upsert");
  });
});

describe("decode: hostile input is refused with a fixed-shape reason", () => {
  const cases: Array<[string, unknown, string, string]> = [
    [
      "wrong envelope kind",
      { kind: "replace", resource: good() },
      "envelope",
      "unknown_kind",
    ],
    ["an array element", [], "envelope", "not_an_object"],
    [
      "an extra envelope key",
      { kind: "upsert", resource: good(), extra: 1 },
      "envelope",
      "bad_upsert",
    ],
    [
      "an upsert with no resource",
      { kind: "upsert" },
      "envelope",
      "bad_upsert",
    ],
    [
      "a remove with an extra key",
      { kind: "remove", id: uuid(1), x: 1 },
      "envelope",
      "bad_remove",
    ],
    ["a remove with no id", { kind: "remove" }, "envelope", "bad_remove"],
    [
      "an upper-case id",
      upsert(good({ id: LETTERS.toUpperCase() })),
      "projection",
      "bad_id",
    ],
    [
      "a malformed id",
      upsert(good({ id: "not-a-uuid" })),
      "projection",
      "bad_id",
    ],
    ["a numeric id", upsert({ ...good(), id: 5 }), "projection", "bad_id"],
    [
      "a remove with an upper-case id",
      { kind: "remove", id: LETTERS.toUpperCase() },
      "envelope",
      "bad_id",
    ],
    [
      "a kind outside the enum",
      upsert(good({ kind: "widget" })),
      "projection",
      "bad_kind",
    ],
    [
      "a numeric parent",
      upsert({ ...good(), parent_id: 3 }),
      "projection",
      "bad_parent",
    ],
    ["an empty label", upsert(good({ label: "" })), "projection", "bad_label"],
    [
      "a non-string label",
      upsert({ ...good(), label: 5 }),
      "projection",
      "bad_label",
    ],
    [
      "an array value",
      upsert({ ...good(), value: [] }),
      "projection",
      "bad_value",
    ],
    [
      "a string value",
      upsert({ ...good(), value: "x" }),
      "projection",
      "bad_value",
    ],
    [
      "a version of 0",
      upsert(good({ version: 0 })),
      "projection",
      "bad_version",
    ],
    [
      "a fractional version",
      upsert(good({ version: 1.5 })),
      "projection",
      "bad_version",
    ],
    [
      "a string version",
      upsert({ ...good(), version: "1" }),
      "projection",
      "bad_version",
    ],
    [
      "a version beyond 2^53",
      upsert(good({ version: 2 ** 53 })),
      "projection",
      "bad_version",
    ],
    [
      "a non-boolean can_edit",
      upsert({ ...good(), can_edit: 1 }),
      "projection",
      "bad_can_edit",
    ],
    [
      "a non-boolean archived",
      upsert({ ...good(), archived: "no" }),
      "projection",
      "bad_archived",
    ],
    [
      "a policy_version of 0",
      upsert(good({ policy_version: 0 })),
      "projection",
      "bad_policy_version",
    ],
    [
      "an extra property",
      upsert({ ...good(), surprise: true }),
      "projection",
      "unknown_field",
    ],
    [
      "a missing field",
      upsert({
        id: uuid(1),
        kind: "task",
        parent_id: null,
        label: "x",
        value: null,
        version: 1,
        can_edit: true,
      }),
      "projection",
      "missing_field",
    ],
  ];
  for (const [name, change, stage, reason] of cases)
    test(`${name}: ${stage}/${reason}`, () => {
      expect(refusal(change)).toMatchObject({ stage, reason });
    });

  test("the failure carries NOTHING of the document: its message is stage:reason, from a closed vocabulary", () => {
    const secret = "TOP-SECRET-LABEL-CONTENT";
    const err = refusal(
      upsert({ ...good({ label: secret }), surprise: secret }),
    );
    expect(err.message).toBe("projection:unknown_field");
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(String(err.stack ?? "").includes(secret)).toBe(false);
  });

  test("a registered validator's own thrown text is never read (it throws; we report only the fixed reason)", () => {
    const d = deps();
    d.validators.register("task", () => {
      throw new Error("validator says: label 'SECRET' is wrong");
    });
    // A throwing validator is a defect of the registrant: it is a refusal of the page with a fixed reason, never a success and never
    // a storage fault, and its message appears nowhere.
    const err = refusal(upsert(good()), d);
    expect(err).toMatchObject({ stage: "value", reason: "validator_failed" });
    expect(JSON.stringify(err) + err.message).not.toContain("SECRET");
  });

  test("invalid UTF-8 inside a string is refused (fatal decoding), not silently replaced", () => {
    const head = bytesOf('{"kind":"remove","id":"');
    const tail = bytesOf('"}');
    const bytes = new Uint8Array([...head, 0xc3, 0x28, ...tail]);
    expect(() => decodeChange(bytes, 0, bytes.length, 1, deps())).toThrowError(
      /not_decodable/,
    );
  });
});

describe("the shape gate", () => {
  test("an element over the byte limit is refused before it is parsed", () => {
    const big = upsert(
      good({ value: { text: "x".repeat(DATA_CONFIG.maxChangeBytes) } }),
    );
    expect(refusal(big)).toMatchObject({
      stage: "gate",
      reason: "element_too_large",
    });
  });
  test("a value over the node limit is refused (the count comes from the scan)", () => {
    const e = element(upsert(good()));
    expect(() =>
      decodeChange(e.bytes, 0, e.end, DATA_CONFIG.maxValueNodes + 1, deps()),
    ).toThrowError(/too_many_nodes/);
    expect(
      decodeChange(e.bytes, 0, e.end, DATA_CONFIG.maxValueNodes, deps()).kind,
    ).toBe("upsert");
  });
  test("end to end: scan, then decode every element of a generated page", () => {
    const rng = new Rng(2);
    const spec = {
      batches: [
        {
          revision: 1,
          changes: Array.from({ length: 50 }, (_, i) => ({
            kind: "upsert" as const,
            resource: projection(rng, i + 1, 3),
          })),
        },
      ],
    };
    const bytes = bytesOf(pageJson(spec));
    const scan = scanSyncPage(bytes);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    for (let i = 0; i < scan.totalChanges; i += 1) {
      const change = decodeChange(
        bytes,
        scan.elements[i * 2] as number,
        scan.elements[i * 2 + 1] as number,
        scan.nodes[i] as number,
        deps(),
      );
      expect(change.kind).toBe("upsert");
    }
  });
});
