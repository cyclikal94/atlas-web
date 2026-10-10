// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import { scanSyncPage } from "../../src/data/scan/scan";
import {
  bytesOf,
  type PageSpec,
  pageJson,
  projection,
  Rng,
  randomPage,
  reference,
  uuid,
} from "../support/data/sync-pages";

const decode = (bytes: Uint8Array, start: number, end: number) =>
  JSON.parse(new TextDecoder().decode(bytes.subarray(start, end)));

/** What scanning must report for a document the reference accepts. */
function expectAgreement(text: string, label: string) {
  const bytes = bytesOf(text);
  const ref = reference(text);
  const scan = scanSyncPage(bytes);
  expect(
    scan.ok,
    `${label}: scan.ok vs reference.ok for ${text.slice(0, 120)}`,
  ).toBe(ref.ok);
  if (!scan.ok || !ref.ok) return;
  expect(scan.phase).toBe(ref.phase);
  expect(scan.hasMore).toBe(ref.hasMore);
  expect(scan.nextCursor).toBe(ref.nextCursor);
  expect(scan.batches.map((b) => b.revision)).toEqual(ref.revisions);
  expect(scan.batches.map((b) => b.count)).toEqual(ref.counts);
  expect(scan.totalChanges).toBe(ref.elements?.length);
  const nodes = Array.from(scan.nodes);
  expect(nodes).toEqual(ref.nodes);
  for (let i = 0; i < scan.totalChanges; i += 1)
    expect(
      decode(
        bytes,
        scan.elements[i * 2] as number,
        scan.elements[i * 2 + 1] as number,
      ),
    ).toEqual(ref.elements?.[i]);
}

describe("F-C9: the scanner agrees with JSON.parse on valid documents", () => {
  test("generated pages, in several layouts (compact, indented, reversed key order)", () => {
    const rng = new Rng(7);
    for (let seed = 1; seed <= 80; seed += 1) {
      const spec = randomPage(rng, seed, {
        batches: rng.int(5),
        changes: rng.int(8),
        valueDepth: 1 + rng.int(5),
      });
      for (const options of [
        {},
        { spaces: 2 },
        { keyOrder: "reverse" as const },
      ])
        expectAgreement(pageJson(spec, options), `seed ${seed}`);
    }
  });

  test("the contract's own example page", () => {
    expectAgreement(
      '{"phase":"snapshot","batches":[{"revision":0,"changes":[]}],"next_cursor":"30000000-0000-4000-8000-000000000001","has_more":false}',
      "contract example",
    );
  });

  test("an EMPTY page (no batches) and a page of empty batches", () => {
    expectAgreement(pageJson({ batches: [] }), "no batches");
    expectAgreement(
      pageJson({
        batches: [
          { revision: 3, changes: [] },
          { revision: 4, changes: [] },
        ],
      }),
      "empty batches",
    );
    const scan = scanSyncPage(
      bytesOf(pageJson({ batches: [], nextCursor: "reused" })),
    );
    expect(scan.ok && scan.nextCursor).toBe("reused");
  });

  test("escapes, surrogate pairs and multi-byte text inside changes and in the cursor, kept verbatim", () => {
    const rng = new Rng(3);
    const p = projection(rng, 1);
    p.label = 'esc " \\ \u0000 \u001f /é 𝔘 ☃';
    const spec: PageSpec = {
      nextCursor: 'a"b\\c\n 😀é',
      batches: [{ revision: 9, changes: [{ kind: "upsert", resource: p }] }],
    };
    expectAgreement(pageJson(spec), "escapes");
    const scan = scanSyncPage(bytesOf(pageJson(spec)));
    expect(scan.ok && scan.nextCursor).toBe(spec.nextCursor);
  });

  test("numbers of every shape inside values (the scanner validates them without decoding)", () => {
    const text =
      '{"phase":"delta","batches":[{"revision":1,"changes":[{"kind":"upsert","resource":{"id":"x","n":[0,-0,1,-1,1.5,-1.5e10,2E-3,1e+2,123456789012345678901234567890]}}]}],"next_cursor":"c","has_more":true}';
    expectAgreement(text, "numbers");
  });
});

describe("F-C9: the scanner agrees with JSON.parse on MUTATED documents", () => {
  const rng = new Rng(11);
  const base = pageJson(
    randomPage(new Rng(5), 1, { batches: 2, changes: 3, valueDepth: 2 }),
  );

  test("truncation at EVERY byte offset is rejected exactly when the reference rejects it", () => {
    let rejected = 0;
    for (let cut = 0; cut < base.length; cut += 1) {
      expectAgreement(base.slice(0, cut), `cut at ${cut}`);
      if (!scanSyncPage(bytesOf(base.slice(0, cut))).ok) rejected += 1;
    }
    expect(rejected).toBe(base.length); // every proper prefix of this document is invalid
    expectAgreement(base, "the whole document");
  });

  test("random ASCII byte flips, insertions and deletions agree with the reference (2,000 mutants)", () => {
    // ASCII-only operations: whether pass 1 decodes UTF-8 is deliberately NOT part of this property (pass 2 does).
    const ascii = '{}[]:," \\/0123456789.-+eEtrufalsn\nabcdxyz';
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 2000; i += 1) {
      const at = rng.int(base.length);
      const op = rng.int(3);
      const ch = rng.pick([...ascii]);
      const text =
        op === 0
          ? base.slice(0, at) + ch + base.slice(at + 1)
          : op === 1
            ? base.slice(0, at) + ch + base.slice(at)
            : base.slice(0, at) + base.slice(at + 1);
      const ref = reference(text);
      const scan = scanSyncPage(bytesOf(text));
      if (scan.ok !== ref.ok) {
        // The one tolerated difference class: a revision that JSON.parse reads as an integer but is not a plain integer literal.
        if (!scan.ok && ref.ok && /"revision":\s*-?\d+(\.\d+|[eE])/.test(text))
          continue;
        expect.fail(
          `disagreement (scan ${scan.ok}, reference ${ref.ok}) for ${JSON.stringify(text.slice(0, 200))}`,
        );
      }
      if (scan.ok) accepted += 1;
      else refused += 1;
      if (scan.ok && ref.ok) expect(scan.nextCursor).toBe(ref.nextCursor);
    }
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(500);
  });

  test("duplicate keys are refused (JSON.parse would keep the last; the contract never has them)", () => {
    const dup = (text: string) => scanSyncPage(bytesOf(text));
    expect(
      dup(
        '{"phase":"delta","phase":"delta","batches":[],"next_cursor":"c","has_more":false}',
      ).ok,
    ).toBe(false);
    expect(
      dup(
        '{"phase":"delta","batches":[],"batches":[],"next_cursor":"c","has_more":false}',
      ).ok,
    ).toBe(false);
    expect(
      dup(
        '{"phase":"delta","batches":[{"revision":1,"revision":2,"changes":[]}],"next_cursor":"c","has_more":false}',
      ).ok,
    ).toBe(false);
    expect(
      dup(
        '{"phase":"delta","batches":[{"revision":1,"changes":[],"changes":[]}],"next_cursor":"c","has_more":false}',
      ).ok,
    ).toBe(false);
  });

  test("unknown keys, wrong types and missing fields are refused", () => {
    const page = (batch: string, extra = "") =>
      `{"phase":"delta","batches":[${batch}],"next_cursor":"c","has_more":false${extra}}`;
    const refused = [
      page("", ',"extra":1'),
      page('{"revision":1,"changes":[],"x":1}'),
      page('{"revision":1}'),
      page('{"changes":[]}'),
      page('{"revision":"1","changes":[]}'),
      page('{"revision":-1,"changes":[]}'),
      page('{"revision":1.0,"changes":[]}'),
      page('{"revision":1e2,"changes":[]}'),
      page('{"revision":01,"changes":[]}'),
      page('{"revision":9007199254740993,"changes":[]}'),
      page('{"revision":1,"changes":[1]}'),
      page('{"revision":1,"changes":["x"]}'),
      page('{"revision":1,"changes":[[]]}'),
      page('{"revision":1,"changes":null}'),
      page("1"),
      '{"phase":"delta","batches":[],"has_more":false}',
      '{"phase":"other","batches":[],"next_cursor":"c","has_more":false}',
      '{"phase":"delta","batches":[],"next_cursor":5,"has_more":false}',
      '{"phase":"delta","batches":[],"next_cursor":"c","has_more":"false"}',
      '{"phase":"delta","batches":{},"next_cursor":"c","has_more":false}',
      "[]",
      "null",
      '"x"',
      "",
      " ",
      "{}",
    ];
    for (const text of refused)
      expect(scanSyncPage(bytesOf(text)).ok, text).toBe(false);
  });

  test("trailing bytes, a byte order mark, and leading/trailing whitespace", () => {
    const ok = pageJson({ batches: [] });
    expect(scanSyncPage(bytesOf(`  \n${ok}\r\n `)).ok).toBe(true);
    expect(scanSyncPage(bytesOf(`${ok}x`)).ok).toBe(false);
    expect(scanSyncPage(bytesOf(`${ok} ${ok}`)).ok).toBe(false);
    expect(
      scanSyncPage(new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf(ok)])).ok,
    ).toBe(false);
  });
});

describe("F-C9: limits", () => {
  const withValue = (value: string) =>
    `{"phase":"delta","batches":[{"revision":1,"changes":[{"kind":"upsert","resource":{"value":${value}}}]}],"next_cursor":"c","has_more":false}`;
  const nest = (depth: number) => "[".repeat(depth) + "]".repeat(depth);

  test("nesting is capped at 24 levels of the document, counted from the top-level object", () => {
    // document 1 > batches 2 > batch 3 > changes 4 > change 5 > resource 6 > value (depth 7 for the outermost array).
    expect(scanSyncPage(bytesOf(withValue(nest(18)))).ok).toBe(true); // value levels 7..24
    const over = scanSyncPage(bytesOf(withValue(nest(19)))); // 25
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.stage).toBe("limit");
    expect(scanSyncPage(bytesOf(withValue(nest(5000)))).ok).toBe(false); // no stack overflow
  });

  test("more than 80 batches, or more than 800 changes in a batch, is a contract violation", () => {
    const batch = '{"revision":1,"changes":[]}';
    const many = (n: number) =>
      `{"phase":"delta","batches":[${Array(n).fill(batch).join(",")}],"next_cursor":"c","has_more":false}`;
    expect(scanSyncPage(bytesOf(many(80))).ok).toBe(true);
    const over = scanSyncPage(bytesOf(many(81)));
    expect(over.ok === false && over.stage).toBe("limit");
    const changes = (n: number) =>
      `{"phase":"delta","batches":[{"revision":1,"changes":[${Array(n).fill("{}").join(",")}]}],"next_cursor":"c","has_more":false}`;
    expect(scanSyncPage(bytesOf(changes(800))).ok).toBe(true);
    const tooMany = scanSyncPage(bytesOf(changes(801)));
    expect(tooMany.ok === false && tooMany.stage).toBe("limit");
  });

  test("the cursor is at most 512 code points (not UTF-16 units) and is stored verbatim", () => {
    const page = (cursor: string) =>
      `{"phase":"delta","batches":[],"next_cursor":${JSON.stringify(cursor)},"has_more":false}`;
    expect(scanSyncPage(bytesOf(page("a".repeat(512)))).ok).toBe(true);
    expect(scanSyncPage(bytesOf(page("a".repeat(513)))).ok).toBe(false);
    expect(scanSyncPage(bytesOf(page("😀".repeat(512)))).ok).toBe(true); // 512 code points, 1,024 units
    expect(scanSyncPage(bytesOf(page("😀".repeat(513)))).ok).toBe(false);
  });

  test("a cursor with invalid UTF-8 is refused (fatal decoding), as is a key", () => {
    const head = bytesOf('{"phase":"delta","batches":[],"next_cursor":"');
    const tail = bytesOf('","has_more":false}');
    const bad = new Uint8Array([...head, 0xc3, 0x28, ...tail]);
    expect(scanSyncPage(bad).ok).toBe(false);
  });
});

describe("F-C9: it never builds an object graph (allocation counters)", () => {
  test("scanning a dense page materialises only keys and small fields: a bounded number of tiny strings, whatever the page size", () => {
    const rng = new Rng(21);
    const spec = randomPage(rng, 9, {
      batches: 10,
      changes: 200,
      valueDepth: 4,
    });
    const text = pageJson(spec);
    const bytes = bytesOf(text);
    expect(bytes.length).toBeGreaterThan(200_000);
    const parse = vi.spyOn(JSON, "parse");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const result = scanSyncPage(bytes);
    const parsed = parse.mock.calls.map((c) => String(c[0]).length);
    const decoded = decode.mock.calls.map((c) => (c[0] as Uint8Array).length);
    parse.mockRestore();
    decode.mockRestore();
    expect(result.ok).toBe(true);
    // 4 top-level keys + phase + cursor + (2 keys per batch): a few dozen calls, none larger than a short token.
    expect(parsed.length).toBeLessThanOrEqual(4 + 2 + 10 * 2 + 4);
    expect(Math.max(...parsed)).toBeLessThanOrEqual(64);
    expect(Math.max(...decoded)).toBeLessThanOrEqual(64);
    expect(decoded.reduce((a, b) => a + b, 0)).toBeLessThan(2_000);
    // What it returns is integer arrays and a few small strings.
    if (result.ok) {
      expect(result.elements).toBeInstanceOf(Uint32Array);
      expect(result.nodes).toBeInstanceOf(Uint32Array);
      expect(result.totalChanges).toBe(2000);
    }
  });

  test("a 64,000-change page scans within its element budget", () => {
    const element =
      '{"kind":"remove","id":"00000000-0000-4000-8000-000000000001"}';
    const batch = `{"revision":1,"changes":[${Array(800).fill(element).join(",")}]}`;
    const text = `{"phase":"delta","batches":[${Array(80).fill(batch).join(",")}],"next_cursor":"c","has_more":false}`;
    const result = scanSyncPage(bytesOf(text));
    expect(result.ok && result.totalChanges).toBe(64_000);
    expect(uuid(1)).toBeDefined();
  });
});
