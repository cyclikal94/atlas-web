// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { codePointCount } from "../../src/data/scan/code-points";
import { scanSyncPage } from "../../src/data/scan/scan";

/**
 * R41 (revision 22): the cursor is bounded by 512 CODE POINTS, whatever JSON representation carries them.
 *
 * The preliminary bound on the token assumed six encoded bytes a code point. An astral character written as the escapes of its two
 * surrogates, `😀`, is twelve, so a valid cursor of 257 of them (257 code points, 514 code units, well inside the pinned
 * `SyncPage.next_cursor` `maxLength: 512`, which has no narrower character pattern) was refused as `limit / string too long` before the
 * corrected code-point count ran. The bound on the token is now the widest representation of the permitted length (12 bytes a code point,
 * plus the quotes); the length proper is the decoded code-point count; processing stays bounded either way.
 *
 * Every case is compared with native `JSON.parse` for the decoded length: the expectation is what the contract says, not what the scanner
 * did. The reviewer's six-case probe is a separate, byte-identical copy in the evidence.
 */
const encoder = new TextEncoder();
const MAX = DATA_CONFIG.maxCursorLength;
const ASTRAL = "😀";
const ASTRAL_ESCAPED = "\\ud83d\\ude00";
const BMP_ESCAPED = "\\u00e9";
const LONE_HIGH = "\\ud800";
const LONE_LOW = "\\udc00";

const page = (token: string): Uint8Array =>
  encoder.encode(
    `{"phase":"delta","batches":[],"next_cursor":"${token}","has_more":false}`,
  );
/** The decoded length the CONTRACT counts: what native `JSON.parse` yields, in code points as the string iterator counts them. */
const decodedLength = (token: string): number =>
  [...(JSON.parse(`"${token}"`) as string)].length;

interface Case {
  name: string;
  token: string;
}
const repeat = (unit: string, n: number): string => unit.repeat(n);
const mixed = (n: number): string => {
  // ASCII, literal astral, escaped astral, escaped BMP and an escaped lone surrogate pair of its own, in turn: n code points.
  const units = ["a", ASTRAL, ASTRAL_ESCAPED, BMP_ESCAPED, "\\/"];
  let out = "";
  for (let i = 0; i < n; i += 1) out += units[i % units.length];
  return out;
};

const AT_AND_OVER: Case[] = [];
for (const [form, unit] of [
  ["literal ASCII", "a"],
  ["literal astral", ASTRAL],
  ["escaped astral", ASTRAL_ESCAPED],
  ["escaped BMP", BMP_ESCAPED],
] as const)
  for (const n of [1, 256, 257, 511, MAX, MAX + 1, MAX + 2])
    AT_AND_OVER.push({ name: `${form} x ${n}`, token: repeat(unit, n) });
for (const n of [1, 300, MAX - 1, MAX, MAX + 1])
  AT_AND_OVER.push({ name: `mixed forms x ${n}`, token: mixed(n) });

describe("R41: the cursor's length is its decoded code points, whatever representation carries them", () => {
  for (const { name, token } of AT_AND_OVER)
    test(`${name}: accepted exactly when the decoded length is at most ${MAX}`, () => {
      const decoded = decodedLength(token);
      const scanned = scanSyncPage(page(token));
      expect(scanned.ok, `${decoded} code points`).toBe(decoded <= MAX);
      if (scanned.ok) {
        expect(scanned.nextCursor).toBe(JSON.parse(`"${token}"`));
        expect(codePointCount(scanned.nextCursor)).toBe(decoded);
      } else {
        // an over-long cursor is refused for its LENGTH and never as a syntax or structure fault: by the code-point count when the token
        // fits the widest representation of the permitted length, and by that bound (on work) when it is wider than any permitted cursor
        expect(scanned.stage).toBe("limit");
        expect(scanned.reason).toBe(
          encoder.encode(token).length + 2 > MAX * 12 + 2
            ? "string too long"
            : "cursor too long",
        );
      }
    });

  test("the reviewer's four controls and two failures: literal 512 and 513, escaped 256, 257, 512 and 513", () => {
    const outcomes = [
      ["literal-512", repeat(ASTRAL, 512), true],
      ["literal-513", repeat(ASTRAL, 513), false],
      ["escaped-256", repeat(ASTRAL_ESCAPED, 256), true],
      ["escaped-257", repeat(ASTRAL_ESCAPED, 257), true],
      ["escaped-512", repeat(ASTRAL_ESCAPED, 512), true],
      ["escaped-513", repeat(ASTRAL_ESCAPED, 513), false],
    ] as const;
    for (const [name, token, accepted] of outcomes)
      expect(scanSyncPage(page(token)).ok, name).toBe(accepted);
  });

  test("a lone surrogate written as an escape is one code point each, and is kept byte for byte", () => {
    for (const [name, token, accepted] of [
      ["512 lone high", repeat(LONE_HIGH, 512), true],
      ["513 lone high", repeat(LONE_HIGH, 513), false],
      ["512 lone low", repeat(LONE_LOW, 512), true],
      ["513 lone low", repeat(LONE_LOW, 513), false],
      // a low then a high form no pair: 512 of each unit is 1,024 code points
      [
        "low then high, 256 times (512 units, 512 code points)",
        repeat(LONE_LOW + LONE_HIGH, 256),
        true,
      ],
      [
        "a high then ASCII, 256 times (512 code points)",
        repeat(`${LONE_HIGH}a`, 256),
        true,
      ],
      [
        "a high then ASCII, 257 times (514 code points)",
        repeat(`${LONE_HIGH}a`, 257),
        false,
      ],
    ] as const) {
      const scanned = scanSyncPage(page(token));
      expect(scanned.ok, name).toBe(accepted);
      if (scanned.ok) expect(scanned.nextCursor).toBe(JSON.parse(`"${token}"`));
    }
  });

  test("a valid surrogate pair is one code point whichever way it is written, and the two ways agree", () => {
    const literal = scanSyncPage(page(repeat(ASTRAL, 400)));
    const escaped = scanSyncPage(page(repeat(ASTRAL_ESCAPED, 400)));
    expect(literal.ok && escaped.ok).toBe(true);
    if (literal.ok && escaped.ok)
      expect(literal.nextCursor).toBe(escaped.nextCursor);
  });

  test("malformed escapes are syntax faults, not lengths: a short hex run, a bad hex digit, an unknown escape, a bare backslash", () => {
    for (const token of [
      "\\ud83",
      "\\ud83g",
      "\\ud83d\\ude0",
      "\\x",
      "a\\",
      "\\u12",
    ]) {
      const scanned = scanSyncPage(page(token));
      expect(scanned.ok, token).toBe(false);
      if (!scanned.ok) expect(scanned.stage, token).toBe("syntax");
    }
  });

  test("a raw control character, and a cursor that is not UTF-8, are refused as before", () => {
    const head = encoder.encode(
      '{"phase":"delta","batches":[],"next_cursor":"',
    );
    const tail = encoder.encode('","has_more":false}');
    expect(scanSyncPage(new Uint8Array([...head, 0x0a, ...tail])).ok).toBe(
      false,
    );
    expect(
      scanSyncPage(new Uint8Array([...head, 0xc3, 0x28, ...tail])).ok,
    ).toBe(false);
  });

  test("processing stays bounded: a token beyond the widest representation of the permitted length is refused by size, undecoded", () => {
    // 512 code points at their widest is 6,146 bytes with the quotes; one more byte of token than that cannot be a permitted cursor.
    const widest = repeat(ASTRAL_ESCAPED, MAX);
    expect(scanSyncPage(page(widest)).ok).toBe(true);
    const huge = repeat("a", 4 * 1024 * 1024);
    const scanned = scanSyncPage(page(huge));
    expect(scanned.ok).toBe(false);
    if (!scanned.ok) {
      expect(scanned.stage).toBe("limit");
      expect(scanned.reason).toBe("string too long");
    }
    // a token within the bound but over the length is counted, then refused for its length
    const wideButBounded = repeat(BMP_ESCAPED, MAX + 1);
    const refused = scanSyncPage(page(wideButBounded));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("cursor too long");
    // one escaped astral character beyond the permitted length is wider than the widest permitted token: refused by size, at once
    const tooWide = scanSyncPage(page(repeat(ASTRAL_ESCAPED, MAX + 1)));
    expect(tooWide.ok).toBe(false);
    if (!tooWide.ok) expect(tooWide.reason).toBe("string too long");
  });

  test("a seeded sweep of 400 random cursors agrees with native JSON.parse on acceptance and on the kept text", () => {
    let seed = 41;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pieces = [
      "a",
      "Z",
      "é",
      ASTRAL,
      ASTRAL_ESCAPED,
      BMP_ESCAPED,
      "\\/",
      "\\n",
      LONE_HIGH,
      LONE_LOW,
      "☃",
    ];
    for (let i = 0; i < 400; i += 1) {
      // lengths straddle the limit: 0 to 600 pieces
      const n = Math.floor(next() * 600) + 1;
      let token = "";
      for (let k = 0; k < n; k += 1)
        token += pieces[Math.floor(next() * pieces.length)];
      const decoded = decodedLength(token);
      const scanned = scanSyncPage(page(token));
      expect(scanned.ok, `sweep ${i}: ${decoded} code points`).toBe(
        decoded <= MAX,
      );
      if (scanned.ok)
        expect(scanned.nextCursor, `sweep ${i}`).toBe(JSON.parse(`"${token}"`));
    }
  });
});

describe("R41, the same family: a key or the phase written with escapes is the same name", () => {
  // The preliminary bound on a key was 64 bytes and on `phase` 32: a fully escaped `next_cursor` (11 characters, 68 bytes) and a fully
  // escaped `snapshot` (8 characters, 50 bytes) are the same names in JSON and were refused by size.
  const escaped = (text: string): string =>
    [...text]
      .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");

  test("every top-level key and the phase may be written fully escaped", () => {
    const text = `{"${escaped("phase")}":"${escaped("snapshot")}","${escaped("batches")}":[],"${escaped("next_cursor")}":"c","${escaped("has_more")}":false}`;
    const scanned = scanSyncPage(encoder.encode(text));
    expect(scanned.ok).toBe(true);
    if (scanned.ok) {
      expect(scanned.phase).toBe("snapshot");
      expect(scanned.nextCursor).toBe("c");
    }
  });

  test("a batch's keys may be written fully escaped", () => {
    const text = `{"phase":"delta","batches":[{"${escaped("revision")}":3,"${escaped("changes")}":[]}],"next_cursor":"c","has_more":false}`;
    const scanned = scanSyncPage(encoder.encode(text));
    expect(scanned.ok).toBe(true);
    if (scanned.ok)
      expect(scanned.batches).toEqual([{ revision: 3, first: 0, count: 0 }]);
  });

  test("an unknown key is still refused by name, however it is written, and a long one cannot be a name of the contract", () => {
    for (const key of ["other", escaped("other"), "k".repeat(700)]) {
      const scanned = scanSyncPage(
        encoder.encode(
          `{"${key}":1,"phase":"delta","batches":[],"next_cursor":"c","has_more":false}`,
        ),
      );
      expect(scanned.ok, key.slice(0, 20)).toBe(false);
    }
    // beyond the widest representation of the longest key looked at: refused by size, undecoded
    const huge = scanSyncPage(
      encoder.encode(
        `{"${"k".repeat(5_000)}":1,"phase":"delta","batches":[],"next_cursor":"c","has_more":false}`,
      ),
    );
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.reason).toBe("string too long");
  });

  test("an unknown or over-long phase is still refused", () => {
    for (const phase of ["other", escaped("other"), "p".repeat(700)])
      expect(
        scanSyncPage(
          encoder.encode(
            `{"phase":"${phase}","batches":[],"next_cursor":"c","has_more":false}`,
          ),
        ).ok,
        phase.slice(0, 20),
      ).toBe(false);
  });
});
