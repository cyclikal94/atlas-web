// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  isArrayIndex,
  MAX_DEPTH,
  NotPlainData,
  snapshotPlain,
} from "../../src/data/model/snapshot";

/**
 * R39 and R40 (revision 22): `snapshotPlain` is the ONE private, validated copy that a plan takes of everything a build returns. These
 * tests pin its policy: what is copied (exactly what a structured clone retains, as plain data), that nothing of the caller's graph is
 * shared or read twice, and what is refused (as a `NotPlainData`, a `TypeError`, which the plans report as `not_json`).
 */
const refused = (value: unknown): unknown => {
  try {
    snapshotPlain(value);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("what is copied: exactly what a structured clone retains, as plain data", () => {
  test("primitives, and null and undefined, are themselves", () => {
    for (const value of [null, undefined, true, false, 0, 1.5, -3, "", "a"])
      expect(snapshotPlain(value)).toBe(value);
    expect(Object.is(snapshotPlain(-0), -0)).toBe(true);
  });

  test("a graph comes back equal, deep and sharing no object with the original", () => {
    const original = {
      kind: "update",
      list: [1, { deep: ["x", { deeper: null }] }, [[]]],
      nested: { a: { b: { c: true } } },
      none: undefined,
    };
    const copy = snapshotPlain(original) as typeof original;
    expect(copy).toStrictEqual(original);
    expect(copy).not.toBe(original);
    expect(copy.list).not.toBe(original.list);
    expect(copy.list[1]).not.toBe(original.list[1]);
    expect(copy.nested.a.b).not.toBe(original.nested.a.b);
  });

  test("nothing the caller does to its graph afterwards reaches the copy, and nothing done to the copy reaches the caller", () => {
    const original = {
      text: "small",
      nested: { label: "original", list: [1, 2] },
    };
    const copy = snapshotPlain(original) as typeof original;
    original.text = "x".repeat(900_000);
    original.nested.label = "later edit";
    original.nested.list.push(3);
    expect(copy).toStrictEqual({
      text: "small",
      nested: { label: "original", list: [1, 2] },
    });
    copy.nested.list.push(99);
    expect(original.nested.list).toEqual([1, 2, 3]);
  });

  test("key order is kept, integer-like keys as an object keeps them", () => {
    const copy = snapshotPlain({ b: 1, 2: "two", a: 2, 1: "one" });
    expect(Object.keys(copy as object)).toEqual(["1", "2", "b", "a"]);
  });

  test("an own `__proto__` key is data, never a prototype", () => {
    const original = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    const copy = snapshotPlain(original) as Record<string, unknown>;
    expect(Object.keys(copy)).toEqual(["__proto__", "a"]);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("an object with no prototype is plain, and comes back as an ordinary one", () => {
    const bare = Object.assign(Object.create(null) as object, { a: 1 });
    expect(snapshotPlain(bare)).toStrictEqual({ a: 1 });
  });

  test("the named properties of an array are kept as a clone keeps them, beside its members", () => {
    const list = Object.assign([1, [2]], { note: "x".repeat(10) });
    const copy = snapshotPlain(list) as unknown[] & { note?: string };
    expect([...copy]).toEqual([1, [2]]);
    expect(copy.note).toBe("x".repeat(10));
    expect(Object.keys(copy)).toEqual(["0", "1", "note"]);
    expect(copy).not.toBe(list);
    // not an index however it looks
    for (const key of ["-1", "01", "1.5", "4294967295", "length "]) {
      const odd = Object.assign([], { [key]: "v" }) as unknown[];
      const out = snapshotPlain(odd) as unknown[];
      expect(out.length, key).toBe(0);
      expect(Object.keys(out), key).toEqual([key]);
    }
  });

  test("an array subclass is an array to a clone and is copied as one", () => {
    class Audience extends Array<string> {
      note = "kept";
    }
    const copy = snapshotPlain(Audience.from(["a"])) as unknown[] & {
      note?: string;
    };
    expect(Array.isArray(copy)).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBe(Array.prototype);
    expect(copy[0]).toBe("a");
    expect(copy.note).toBe("kept");
  });

  test("symbol-keyed and non-enumerable properties are not retained, as a clone drops them", () => {
    const list = [1];
    Object.defineProperty(list, "hidden", { value: "h", enumerable: false });
    (list as unknown as Record<symbol, string>)[Symbol("s")] = "s";
    const copy = snapshotPlain(list) as unknown[];
    expect(Object.keys(copy)).toEqual(["0"]);
    expect(Object.getOwnPropertySymbols(copy)).toEqual([]);
  });

  test("an array is read by its keys, not its iterator: a replaced `Symbol.iterator` hides nothing", () => {
    const list = Object.assign(["a", "b"], {
      [Symbol.iterator]: function* () {
        // yields nothing
      },
    });
    expect(snapshotPlain(list)).toEqual(["a", "b"]);
  });

  test("an `undefined` member is kept (the canonical form refuses it where it must, not this copy), `null` and `[null]` are themselves", () => {
    expect(snapshotPlain({ a: undefined })).toStrictEqual({ a: undefined });
    expect(snapshotPlain([undefined])).toStrictEqual([undefined]);
    expect(snapshotPlain([null])).toStrictEqual([null]);
  });

  test("as deep as MAX_DEPTH containers is copied", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < MAX_DEPTH; i += 1) value = [value];
    expect(() => snapshotPlain(value)).not.toThrow();
  });

  test("a sweep of 300 seeded random graphs equals a structured clone, and has the same JSON", () => {
    let seed = 20261006;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const build = (depth: number): unknown => {
      const pick = next();
      if (depth > 4 || pick < 0.3) {
        const leaf = Math.floor(next() * 6);
        return [null, true, 17.25, "text ☃ 😀", "", -4][leaf];
      }
      if (pick < 0.6) {
        const list: unknown[] = [];
        for (let i = Math.floor(next() * 4); i > 0; i -= 1)
          list.push(build(depth + 1));
        return list;
      }
      const object: Record<string, unknown> = {};
      for (let i = Math.floor(next() * 4); i > 0; i -= 1)
        object[`k${Math.floor(next() * 5)}`] = build(depth + 1);
      return object;
    };
    for (let i = 0; i < 300; i += 1) {
      const original = build(0);
      const copy = snapshotPlain(original);
      expect(copy, `graph ${i}`).toStrictEqual(structuredClone(original));
      expect(JSON.stringify(copy), `graph ${i}`).toBe(JSON.stringify(original));
    }
  });
});

describe("what is refused: anything that is not plain JSON data, as a TypeError", () => {
  const cases: Array<[string, () => unknown]> = [
    ["a function", () => ({ a: () => 1 })],
    ["a function at the root", () => () => 1],
    ["a symbol", () => ({ a: Symbol("s") })],
    ["a bigint", () => ({ a: 1n })],
    ["NaN", () => ({ a: Number.NaN })],
    ["Infinity", () => [Number.POSITIVE_INFINITY]],
    ["a Map", () => ({ a: new Map([["k", 1]]) })],
    ["a Set", () => ({ a: new Set([1]) })],
    ["a Date", () => ({ a: new Date(0) })],
    ["a RegExp", () => ({ a: /x/ })],
    ["a typed array", () => ({ a: new Uint8Array(4) })],
    ["an ArrayBuffer", () => ({ a: new ArrayBuffer(4) })],
    [
      "a class instance",
      () =>
        new (class Box {
          a = 1;
        })(),
    ],
    ["a boxed string", () => ({ a: new String("x") })],
    ["an Error", () => ({ a: new Error("x") })],
  ];
  for (const [name, make] of cases)
    test(`${name}`, () => {
      const error = refused(make());
      expect(error).toBeInstanceOf(NotPlainData);
      expect(error).toBeInstanceOf(TypeError);
    });

  test("an accessor is not data: never run, on an object key, an array member or an array's named property", () => {
    let calls = 0;
    const getter = {
      enumerable: true,
      get() {
        calls += 1;
        return calls > 1 ? "x".repeat(900_000) : "small";
      },
    };
    for (const value of [
      Object.defineProperty({}, "k", getter),
      Object.defineProperty([], "named", getter),
      Object.defineProperty([0], "0", getter),
      { outer: [{ inner: Object.defineProperty({}, "k", getter) }] },
    ])
      expect(refused(value)).toBeInstanceOf(NotPlainData);
    expect(calls).toBe(0);
  });

  test("a cycle: itself, indirect, through an array", () => {
    const self: Record<string, unknown> = {};
    self.me = self;
    const a: Record<string, unknown> = {};
    const b = { a };
    a.b = b;
    const list: unknown[] = [];
    list.push([list]);
    for (const value of [self, a, list])
      expect(refused(value)).toBeInstanceOf(NotPlainData);
  });

  test("a value shared twice but not cyclic is a tree, copied once for each place it stands", () => {
    const shared = { n: 1 };
    const copy = snapshotPlain({ a: shared, b: [shared, shared] }) as {
      a: object;
      b: object[];
    };
    expect(copy).toStrictEqual({ a: { n: 1 }, b: [{ n: 1 }, { n: 1 }] });
    expect(copy.a).not.toBe(copy.b[0]);
  });

  test("nested one container deeper than MAX_DEPTH", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < MAX_DEPTH + 1; i += 1) value = { v: value };
    expect(refused(value)).toBeInstanceOf(NotPlainData);
  });

  test("a proxy whose trap throws, and a revoked one, cannot be read as data", () => {
    const hostile = new Proxy(
      { a: 1 },
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    const revocable = Proxy.revocable({ a: 1 }, {});
    revocable.revoke();
    expect(refused({ nested: hostile })).toBeInstanceOf(NotPlainData);
    expect(refused(revocable.proxy)).toBeInstanceOf(NotPlainData);
  });
});

describe("R40: a hole is refused, in every position, by one policy", () => {
  /* biome-ignore-start lint/suspicious/noSparseArray: the shapes under test */
  const holes: Array<[string, unknown]> = [
    ["one hole, the whole list", new Array(1)],
    ["leading", [, 1]],
    ["trailing", [1, ,]],
    ["in the middle", [1, , 2]],
    ["several", [1, , , 2]],
    ["only holes", new Array(3)],
    ["nested in an object", { items: [1, , 2] }],
    ["nested in an array", [[1], [, 2]]],
    ["in a named property's array", Object.assign([], { note: new Array(1) })],
    [
      "a deleted member",
      (() => {
        const list = [1, 2, 3];
        delete list[1];
        return list;
      })(),
    ],
    [
      "a long list with one far member",
      (() => {
        const lone: unknown[] = [];
        lone[1_000_000] = "x";
        return lone;
      })(),
    ],
  ];
  /* biome-ignore-end lint/suspicious/noSparseArray: the shapes under test */
  for (const [name, value] of holes)
    test(`${name}`, () => {
      const error = refused({ kind: "create", items: value });
      expect(error).toBeInstanceOf(NotPlainData);
      expect(error).toBeInstanceOf(TypeError);
    });

  test("a list of four billion holes is refused at once: a refusal costs one read, not a loop", () => {
    const huge: unknown[] = [];
    huge.length = 4_294_967_294;
    const started = Date.now();
    expect(refused(huge)).toBeInstanceOf(NotPlainData);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("the neighbours that are NOT holes are copied: the empty list, `[null]`, `[undefined]`, an explicit `undefined` member", () => {
    expect(snapshotPlain({ items: [] })).toStrictEqual({ items: [] });
    expect(snapshotPlain({ items: [null] })).toStrictEqual({ items: [null] });
    expect(snapshotPlain([undefined, undefined])).toStrictEqual([
      undefined,
      undefined,
    ]);
    const filled = new Array(2).fill(0);
    expect(snapshotPlain(filled)).toStrictEqual([0, 0]);
  });
});

describe("a property is read once, as data, and nothing else of the caller's runs", () => {
  test("a proxy is read as data: the value of each property comes from ONE descriptor answer, and the copy is not a live view of it", () => {
    // `Object.keys` asks the descriptor trap for the enumerability of each key, and the copy asks once more for its value: at most
    // twice a key, never once per use, and what is stored is the answer of ONE of them, not a second look at the caller's object.
    let answers = 0;
    const reads = new Map<string, number>();
    const target = { a: "first", b: { c: "inner" } };
    const spy = new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        answers += 1;
        reads.set(String(key), (reads.get(String(key)) ?? 0) + 1);
        const real = Reflect.getOwnPropertyDescriptor(object, key);
        return real === undefined || typeof real.value !== "string"
          ? real
          : { ...real, value: `answer ${answers}` };
      },
    });
    const copy = snapshotPlain(spy) as { a: string; b: { c: string } };
    expect(copy.a).toMatch(/^answer \d+$/);
    expect(copy.b).toStrictEqual({ c: "inner" });
    for (const count of reads.values()) expect(count).toBeLessThanOrEqual(2);
    const seen = answers;
    // Using the copy asks the proxy nothing, and a change to the original does not reach it.
    const first = copy.a;
    target.a = "changed";
    expect(copy.a).toBe(first);
    expect(answers).toBe(seen);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
  });

  test("isArrayIndex: canonical array indexes below 2^32 - 1 only", () => {
    for (const key of ["0", "1", "10", "4294967294"])
      expect(isArrayIndex(key), key).toBe(true);
    for (const key of ["-1", "01", "1.5", "4294967295", "", "a", " 1"])
      expect(isArrayIndex(key), key).toBe(false);
  });
});
