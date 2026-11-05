// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  charCount,
  type FieldValue,
  formatDate,
  formatValue,
  isAcceptedUrl,
  isRealDate,
  isTaskDecimal,
  labelProblem,
  parseFieldValue,
  valueProblem,
} from "../../../src/features/people/model/values";

/**
 * The seven `FieldValue` kinds (TASK-10). The accepted and refused cases are transcribed from the pinned backend's own validation
 * (`/Users/kieran/atlas/atlas` at `v0.28.0-rc.1`, `30fec6a3`): `crates/core/src/resources/fields.rs` `FieldValue::validate`,
 * `crates/core/src/tasks/mod.rs` `Decimal::units` (lines 20-50) and `Goal::Checklist` (lines 154-165), `crates/core/src/lib.rs`
 * `identifier`/`content` (lines 154-164), and `crates/core/tests/cases/tasks/lists_fields.rs` (29 February without a year, line 87).
 * The editor must accept exactly what the server accepts, so a refusal is a defect of input, never a surprise after saving.
 */
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("TaskDecimal (Decimal::units)", () => {
  test.each([
    ["0", true],
    ["1", true],
    ["12.5", true],
    ["0.000001", true],
    ["999999999999", true],
    ["999999999999.999999", true],
    ["1000000000000", true],
    ["1000000000000.000000", true],
    ["1000000000000.1", false],
    ["1000000000001", false],
    ["-1", false],
    ["01", false],
    ["1.", false],
    [".5", false],
    ["1.0000001", false],
    ["1e3", false],
    ["", false],
    [" 1", false],
  ])("%s → %s", (text, accepted) => {
    expect(isTaskDecimal(text)).toBe(accepted);
  });
});

describe("dates (NaiveDate::from_ymd_opt with 2000 for a missing year)", () => {
  test.each([
    [null, 2, 29, true],
    [2024, 2, 29, true],
    [2023, 2, 29, false],
    [1900, 2, 29, false],
    [2000, 2, 29, true],
    [null, 4, 31, false],
    [null, 12, 31, true],
    [null, 13, 1, false],
    [null, 0, 1, false],
    [null, 1, 0, false],
  ])("%s-%s-%s → %s", (year, month, day, real) => {
    expect(isRealDate(year, month, day)).toBe(real);
  });

  test("the year is 1900 to 9999 when given", () => {
    const at = (year: number | null) =>
      valueProblem({ kind: "date", year, month: 1, day: 1 });
    expect(at(1899)).toBe("year_out_of_range");
    expect(at(1900)).toBeNull();
    expect(at(9999)).toBeNull();
    expect(at(10000)).toBe("year_out_of_range");
    expect(at(null)).toBeNull();
  });
});

describe("links (Url::parse; http/https; a host; no credentials)", () => {
  test.each([
    ["https://example.org/a?b=c", true],
    ["http://example.org", true],
    ["ftp://example.org", false],
    ["mailto:someone@example.org", false],
    ["https://user@example.org", false],
    ["https://user:secret@example.org", false],
    ["example.org", false],
    ["https://", false],
  ])("%s → %s", (url, accepted) => {
    expect(isAcceptedUrl(url)).toBe(accepted);
  });
});

describe("valueProblem", () => {
  test("text: at most 4,096 characters, counted as code points (not UTF-16 units)", () => {
    expect(valueProblem({ kind: "text", text: "x".repeat(4096) })).toBeNull();
    expect(valueProblem({ kind: "text", text: "x".repeat(4097) })).toBe(
      "text_too_long",
    );
    // 2,000 astral characters are 4,000 UTF-16 units but 2,000 characters, and 8,000 bytes: under both bounds.
    const astral = "😀".repeat(2000);
    expect(astral.length).toBe(4000);
    expect(charCount(astral)).toBe(2000);
    expect(valueProblem({ kind: "text", text: astral })).toBeNull();
  });

  test("the whole value serialised is at most 8,192 bytes (fields.rs): 4,096 three-byte characters are refused", () => {
    expect(valueProblem({ kind: "text", text: "€".repeat(4096) })).toBe(
      "value_too_large",
    );
  });

  test("quantity: a TaskDecimal amount and a unit of 1 to 40 characters that is not blank", () => {
    const q = (amount: string, unit: string) =>
      valueProblem({ kind: "quantity", amount, unit });
    expect(q("2.5", "kg")).toBeNull();
    expect(q("-2", "kg")).toBe("amount_invalid");
    expect(q("2", "  ")).toBe("unit_missing");
    expect(q("2", "u".repeat(40))).toBeNull();
    expect(q("2", "u".repeat(41))).toBe("unit_too_long");
  });

  test("choices: 1 to 100 unique options, not blank, at most 100 characters; the selection unique and among them", () => {
    const c = (options: string[], selected: string[]) =>
      valueProblem({ kind: "choices", options, selected });
    expect(c(["a", "b"], ["a"])).toBeNull();
    expect(c(["a", "b"], [])).toBeNull();
    expect(c([], [])).toBe("options_missing");
    expect(c(["a", " "], [])).toBe("option_blank");
    expect(c(["a".repeat(101)], [])).toBe("option_too_long");
    expect(c(["a", "a"], [])).toBe("options_repeated");
    expect(c(["a", "b"], ["a", "a"])).toBe("options_repeated");
    expect(c(["a"], ["z"])).toBe("selected_unknown");
    expect(
      c(
        Array.from({ length: 101 }, (_, i) => `o${i}`),
        [],
      ),
    ).toBe("options_too_many");
  });

  test("checklist: 1 to 100 items with unique canonical UUIDs and labels of 1 to 300; checked unique and among them", () => {
    const k = (
      items: Array<{ id: string; label: string }>,
      checked: string[],
    ) => valueProblem({ kind: "checklist", items, checked });
    expect(k([{ id: ID, label: "Milk" }], [ID])).toBeNull();
    expect(k([], [])).toBe("items_missing");
    expect(k([{ id: ID.toUpperCase(), label: "Milk" }], [])).toBe(
      "item_id_invalid",
    );
    expect(
      k(
        [
          { id: ID, label: "a" },
          { id: ID, label: "b" },
        ],
        [],
      ),
    ).toBe("item_id_invalid");
    expect(k([{ id: ID, label: " " }], [])).toBe("item_blank");
    expect(k([{ id: ID, label: "x".repeat(301) }], [])).toBe("item_too_long");
    expect(k([{ id: ID, label: "Milk" }], [ID2])).toBe("checked_unknown");
    expect(k([{ id: ID, label: "Milk" }], [ID, ID])).toBe("checked_unknown");
  });

  test("boolean and url", () => {
    expect(valueProblem({ kind: "boolean", value: false })).toBeNull();
    expect(valueProblem({ kind: "url", url: "https://a.example" })).toBeNull();
    expect(valueProblem({ kind: "url", url: "nope" })).toBe("url_invalid");
  });
});

describe("labelProblem (content: not blank, at most 300 characters)", () => {
  test("bounds", () => {
    expect(labelProblem("Birthday")).toBeNull();
    expect(labelProblem("   ")).toBe("label_missing");
    expect(labelProblem("x".repeat(300))).toBeNull();
    expect(labelProblem("x".repeat(301))).toBe("label_too_long");
  });
});

describe("parseFieldValue is strict", () => {
  const values: FieldValue[] = [
    { kind: "text", text: "Penicillin allergy" },
    { kind: "quantity", amount: "2.5", unit: "kg" },
    { kind: "date", month: 4, day: 2 },
    { kind: "date", year: 1991, month: 4, day: 2 },
    { kind: "date", year: null, month: 2, day: 29 },
    { kind: "url", url: "https://example.org" },
    { kind: "boolean", value: true },
    { kind: "choices", options: ["a", "b"], selected: ["b"] },
    { kind: "checklist", items: [{ id: ID, label: "Milk" }], checked: [] },
  ];
  test.each(values.map((v) => [v.kind, v]))(
    "a valid %s value reads back unchanged",
    (_kind, value) => {
      expect(parseFieldValue(value)).toEqual(value);
    },
  );

  test.each([
    ["null", null],
    ["no kind", { text: "x" }],
    ["unknown kind", { kind: "colour", value: "red" }],
    ["an extra key", { kind: "text", text: "x", extra: 1 }],
    ["a wrong type", { kind: "boolean", value: "yes" }],
    [
      "a value the server would refuse",
      { kind: "quantity", amount: "-1", unit: "kg" },
    ],
    ["an impossible date", { kind: "date", year: 2023, month: 2, day: 29 }],
    [
      "a damaged checklist item",
      { kind: "checklist", items: [{ id: ID }], checked: [] },
    ],
    ["an array", [{ kind: "text", text: "x" }]],
  ])("%s is not shown as anything (null)", (_name, raw) => {
    expect(parseFieldValue(raw)).toBeNull();
  });
});

describe("display", () => {
  test("dates: '3 March' without a year, '3 March 2027' with one", () => {
    expect(formatDate({ month: 3, day: 3 })).toBe("3 March");
    expect(formatDate({ year: 2027, month: 3, day: 3 })).toBe("3 March 2027");
  });

  test("each kind has a one-line summary", () => {
    expect(formatValue({ kind: "quantity", amount: "2.5", unit: "kg" })).toBe(
      "2.5 kg",
    );
    expect(formatValue({ kind: "boolean", value: false })).toBe("No");
    expect(
      formatValue({
        kind: "choices",
        options: ["a", "b", "c"],
        selected: ["b"],
      }),
    ).toBe("b (of 3)");
    expect(
      formatValue({
        kind: "checklist",
        items: [
          { id: ID, label: "Milk" },
          { id: ID2, label: "Eggs" },
        ],
        checked: [ID],
      }),
    ).toBe("1 of 2 done");
  });
});
