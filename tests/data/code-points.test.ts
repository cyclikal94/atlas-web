// @vitest-environment node
import { describe, expect, test } from "vitest";
import { codePointCount } from "../../src/data/scan/code-points";
import { scanSyncPage } from "../../src/data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
  decodeChange,
  PageInvalid,
} from "../../src/data/scan/validate";
import { bytesOf, Rng } from "../support/data/sync-pages";

/**
 * F-C10 / F-C2 (R38, revision 21): a string bounded in CODE POINTS is counted as the string iterator counts it, whatever its surrogates
 * are. The review's reproduction: `"\ud800a"` repeated 151 times (302 code points) passed the 300-code-point label bound, and the same
 * unit repeated 257 times (514) passed the 512-code-point cursor bound, because every high surrogate was taken to start a pair.
 *
 * The counter is checked against `[...text].length` on its own (a fixed table and a seeded random sweep over every kind of unit), and then
 * through BOTH public decoders at and over their limits for each kind of text: ASCII, valid astral pairs, an unpaired high surrogate
 * (before an ordinary unit, before another high surrogate, at the end), and a lone low surrogate. Legitimate astral text still counts one
 * per pair, and an opaque cursor is preserved verbatim.
 */
const HIGH = "\ud800";
const LOW = "\udc00";
const KINDS: Array<{ name: string; unit: string; points: number }> = [
  { name: "ascii", unit: "a", points: 1 },
  { name: "valid pair", unit: "😀", points: 1 },
  {
    name: "unpaired high before an ordinary unit",
    unit: `${HIGH}a`,
    points: 2,
  },
  { name: "lone low before an ordinary unit", unit: `${LOW}a`, points: 2 },
  { name: "unpaired high before a high", unit: `${HIGH}${HIGH}`, points: 2 },
  { name: "two lone lows", unit: `${LOW}${LOW}`, points: 2 },
  {
    name: "the top high surrogate before an ordinary unit",
    unit: "\udbffa",
    points: 2,
  },
  {
    name: "a valid pair at the top of the range",
    unit: "\udbff\udfff",
    points: 1,
  },
];

describe("codePointCount", () => {
  test("a fixed table of strings", () => {
    const table: Array<[string, number]> = [
      ["", 0],
      ["a", 1],
      ["😀", 1],
      ["😀😀", 2],
      [HIGH, 1],
      [LOW, 1],
      [`${HIGH}a`, 2],
      [`${HIGH}${HIGH}`, 2],
      [`${HIGH}${LOW}`, 1],
      [`${HIGH}${HIGH}${LOW}`, 2],
      [`${LOW}${LOW}`, 2],
      [`a${HIGH}`, 2],
      ["é", 1],
    ];
    for (const [text, expected] of table) {
      expect(codePointCount(text), JSON.stringify(text)).toBe(expected);
      expect([...text].length).toBe(expected);
    }
  });

  test("agrees with the string iterator over a seeded random sweep of every kind of unit", () => {
    const rng = new Rng(20261005);
    const alphabet = ["a", "é", "☃", HIGH, "\udbff", LOW, "\udfff", "😀"];
    for (let round = 0; round < 400; round += 1) {
      const length = 1 + Math.floor(rng.next() * 40);
      let text = "";
      for (let i = 0; i < length; i += 1)
        text += alphabet[Math.floor(rng.next() * alphabet.length)];
      expect(codePointCount(text), JSON.stringify(text)).toBe([...text].length);
    }
  });
});

const label = (text: string): Uint8Array =>
  bytesOf(
    JSON.stringify({
      kind: "upsert",
      resource: {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "task",
        parent_id: null,
        label: text,
        value: null,
        version: 1,
        can_edit: true,
        archived: false,
      },
    }),
  );

const decodes = (text: string): "accepted" | "bad_label" => {
  const bytes = label(text);
  try {
    decodeChange(bytes, 0, bytes.length, 1, {
      validators: createValueValidators(),
      derivers: createKeyDerivers(),
    });
    return "accepted";
  } catch (error) {
    if (error instanceof PageInvalid && error.reason === "bad_label")
      return "bad_label";
    throw error;
  }
};

const cursorOk = (cursor: string): boolean =>
  scanSyncPage(
    bytesOf(
      `{"phase":"delta","batches":[],"next_cursor":${JSON.stringify(cursor)},"has_more":false}`,
    ),
  ).ok;

describe("the label bound (300 code points) counts every kind of text the same way", () => {
  for (const { name, unit, points } of KINDS) {
    test(`${name}: exactly 300 code points is accepted, 301 is refused`, () => {
      const atBound = unit.repeat(300 / points);
      expect([...atBound].length).toBe(300);
      expect(decodes(atBound)).toBe("accepted");
      // One more unit of this kind, and the count passes the bound by `points`.
      const over = unit.repeat(300 / points + 1);
      expect([...over].length).toBe(300 + points);
      expect(decodes(over)).toBe("bad_label");
    });
  }

  test("the review's reproduction: an unpaired high surrogate before an ordinary unit, repeated 151 times, holds 302 code points and is refused", () => {
    const text = `${HIGH}a`.repeat(151);
    expect([...text].length).toBe(302);
    expect(decodes(text)).toBe("bad_label");
  });

  test("a label that is a single unpaired surrogate is one code point (accepted), and the empty label is refused", () => {
    expect(decodes(HIGH)).toBe("accepted");
    expect(decodes(LOW)).toBe("accepted");
    expect(decodes("")).toBe("bad_label");
  });

  test("a pair split by an ordinary unit is two code points, not one", () => {
    // 150 x (high, ordinary, low): the high and low units are NOT adjacent, so 450 code points.
    const text = `${HIGH}a${LOW}`.repeat(150);
    expect([...text].length).toBe(450);
    expect(decodes(text)).toBe("bad_label");
  });
});

describe("the cursor bound (512 code points) counts every kind of text the same way", () => {
  for (const { name, unit, points } of KINDS) {
    test(`${name}: exactly 512 code points is accepted, 513 is refused`, () => {
      const atBound = unit.repeat(512 / points);
      expect([...atBound].length).toBe(512);
      expect(cursorOk(atBound)).toBe(true);
      const over = unit.repeat(512 / points + 1);
      expect([...over].length).toBe(512 + points);
      expect(cursorOk(over)).toBe(false);
    });
  }

  test("the review's reproduction: the same unit repeated 257 times holds 514 code points and is refused", () => {
    const cursor = `${HIGH}a`.repeat(257);
    expect([...cursor].length).toBe(514);
    expect(cursorOk(cursor)).toBe(false);
  });

  test("a cursor is opaque: an accepted one is stored byte for byte, an unpaired surrogate included", () => {
    for (const cursor of [`${HIGH}a`.repeat(100), "😀é☃", `${LOW}x${HIGH}`]) {
      const result = scanSyncPage(
        bytesOf(
          `{"phase":"delta","batches":[],"next_cursor":${JSON.stringify(cursor)},"has_more":false}`,
        ),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextCursor).toBe(cursor);
    }
  });
});
