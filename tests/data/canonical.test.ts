// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  digestOf,
  sha256Bytes,
  sha256Hex,
} from "../../src/data/model/canonical";

const reference = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("the synchronous SHA-256 (decision D-07)", () => {
  test("the published test vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256Bytes(new Uint8Array(1_000_000).fill(0x61))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  test("agrees with the platform on every length around the block boundaries, and on random data", () => {
    for (let length = 0; length <= 200; length += 1) {
      const bytes = randomBytes(length);
      expect(sha256Bytes(bytes), `length ${length}`).toBe(reference(bytes));
    }
    for (const length of [511, 512, 513, 4095, 4096, 65_535, 65_536]) {
      const bytes = randomBytes(length);
      expect(sha256Bytes(bytes), `length ${length}`).toBe(reference(bytes));
    }
  });

  test("agrees on multi-byte text", () => {
    const text = "naïve ☃ 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 — 日本語";
    expect(sha256Hex(text)).toBe(
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
  });
});

describe("canonical JSON", () => {
  test("sorts keys at every depth and has no whitespace", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  test("is independent of key order, so a digest is stable", () => {
    expect(digestOf({ a: 1, b: [1, 2], c: { x: "y" } })).toBe(
      digestOf({ c: { x: "y" }, b: [1, 2], a: 1 }),
    );
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });
  test("-0 is 0 and a non-finite number or an undefined has no form", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
  test("strings are escaped as JSON", () => {
    expect(canonicalJson('a"b\\c\n ')).toBe(JSON.stringify('a"b\\c\n '));
  });
});

/**
 * R40 (revision 22): a HOLE in an array has no canonical form. `Array.prototype.map` skips a hole, so `new Array(1)` was `[]` here (the
 * digest of the empty list) while `JSON.stringify` says `[null]`, and two holes made `[,]`, which is not JSON at all. A hole is the absence
 * of a member, as `undefined` is the absence of a value, and neither is canonicalised.
 */
describe("R40: a hole in an array is refused, not skipped", () => {
  /* biome-ignore-start lint/suspicious/noSparseArray: the shapes under test */
  const holes: Array<[string, unknown]> = [
    ["one hole", new Array(1)],
    ["three holes (this was `[,,]`)", new Array(3)],
    ["leading", [, 1]],
    ["trailing", [1, ,]],
    ["in the middle", [1, , 2]],
    ["several, apart", [1, , 2, , 3]],
    ["nested in an object", { kind: "create", items: [1, , 2] }],
    ["nested in an array", [[1], [, 2]]],
    [
      "a deleted member",
      (() => {
        const list = ["a", "b", "c"];
        delete list[1];
        return list;
      })(),
    ],
  ];
  /* biome-ignore-end lint/suspicious/noSparseArray: the shapes under test */
  for (const [name, value] of holes)
    test(`${name}: canonicalJson and digestOf refuse, and say it is a hole`, () => {
      expect(() => canonicalJson(value)).toThrow(TypeError);
      expect(() => digestOf(value)).toThrow(TypeError);
      // A hole reads as `undefined`, which has no form either; the diagnostic tells the two apart (and shows the explicit check).
      expect(() => canonicalJson(value)).toThrow(/hole/);
    });

  test("a list of four billion holes is refused at once, not walked", () => {
    const huge: unknown[] = [];
    huge.length = 4_294_967_294;
    const started = Date.now();
    expect(() => canonicalJson(huge)).toThrow(TypeError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("the neighbours are distinct and exact: the empty list, `[null]`, a filled list, none of them the digest of another", () => {
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson([null])).toBe("[null]");
    expect(canonicalJson(new Array(2).fill(null))).toBe("[null,null]");
    expect(canonicalJson({ items: [] })).toBe('{"items":[]}');
    expect(canonicalJson({ items: [null] })).toBe('{"items":[null]}');
    const digests = new Set([
      digestOf({ items: [] }),
      digestOf({ items: [null] }),
      digestOf({ items: [null, null] }),
      digestOf({ items: [0] }),
    ]);
    expect(digests.size).toBe(4);
  });

  test("an `undefined` member is still refused (the same absence, written out), as an undefined and not as a hole", () => {
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
    expect(() => canonicalJson({ a: [undefined] })).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/);
    expect(() => canonicalJson([undefined])).not.toThrow(/hole/);
  });

  test("a dense list of any length is unchanged, member for member", () => {
    const list = Array.from({ length: 1_000 }, (_, i) => i);
    expect(canonicalJson(list)).toBe(JSON.stringify(list));
    expect(canonicalJson([[1, [2, [3]]], "x"])).toBe('[[1,[2,[3]]],"x"]');
  });
});
