// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  DRAFT_ALLOWANCE_BYTES,
  draftWriteBytes,
  type EnqueueRequest,
  estimateDraftBytes,
  IDENTIFIER_COPIES,
  plainJsonBytes,
  REWRITTEN_DEPENDANT_BYTES,
  utf8Length,
} from "../../src/data/model/outbox";
import type { DraftRow, JsonObject } from "../../src/data/model/types";
import {
  editQueuedDraft,
  enqueueDraft,
  supersedeDraft,
} from "../../src/data/plans/outbox";
import { outboxWorld } from "../support/data/outbox-world";

/**
 * R25 (revision 13): the quota reserve covers the WHOLE variable-size write, not the command alone.
 *
 * Revision 12 measured the command and the display patch and added a fixed allowance for everything else. `BuildResult.defaultsContext`
 * is typed `unknown`, has no size restriction and is persisted as `DraftRow.defaults_context`; an edit may replace it and a
 * supersession may create a replacement that carries it. A 900,000-character context was admitted on all three growth paths with an
 * estimate of 4,164 bytes while the stored header was 900,861 bytes. The same hole stood for every other caller-sized contribution
 * (`defaults_revision`, `endpoint`, `target_id`, `kind`, the identifiers in the header and the index entries, the version rows, the
 * caller's own dependencies).
 *
 * The rule under test: every caller-sized value in a save raises BOTH the estimate the facade reserves and the measure the transaction
 * takes of the rows it composed, by at least its own size; a value that cannot be measured is refused; and a refusal changes nothing.
 * The free space is an injected figure of the repository's store double, not a measurement of what an engine allocates. FIXTURE evidence.
 */
const RESERVE = DATA_CONFIG.quotaReserveBytes;
const MIB = 1024 * 1024;
const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const BIG = 900_000;
const GROW = 200_000;
const NOW = "2026-10-01T10:00:00.000Z";
/** Inflating a value by GROW bytes adds at least this much per stored copy (within 1%: the baseline value's own few bytes). */
const LEAST_GROWTH = Math.floor(GROW * 0.99);

interface Shape {
  context?: unknown;
  revision?: string;
  endpoint?: string;
  targetId?: string;
  kind?: string;
  patch?: string;
  resourceId?: string;
  extraDependency?: string;
  localId?: string;
  text?: string;
  /** An extra member of the command (what a `Map` in a command would be: the canonical form says `{}`, the clone stores what it holds). */
  commandExtra?: unknown;
  /** The same for the display patch's `value`. */
  patchExtra?: unknown;
}

/** A request whose every caller-sized value can be inflated on its own. */
function request(shape: Shape = {}): EnqueueRequest {
  const resource = shape.resourceId ?? T;
  return {
    localId: shape.localId ?? NEW,
    endpoint: shape.endpoint ?? "/commands",
    ...(shape.targetId === undefined ? {} : { targetId: shape.targetId }),
    targets: [
      {
        resourceId: resource,
        role: "primary",
        basis: "resource",
        versionChecked: true,
        seedIfUntracked: 1,
      },
    ],
    ...(shape.extraDependency === undefined
      ? {}
      : { dependsOnExtra: [shape.extraDependency] }),
    build: (bases) => ({
      command: {
        kind: shape.kind ?? "update",
        text: shape.text ?? "small",
        expected_version: bases[resource] as number,
        ...((shape.commandExtra === undefined
          ? {}
          : { extra: shape.commandExtra }) as Record<string, never>),
      },
      ...(shape.patch === undefined && shape.patchExtra === undefined
        ? {}
        : {
            displayPatch: {
              [resource]: {
                label: shape.patch ?? "patch",
                ...(shape.patchExtra === undefined
                  ? {}
                  : { value: { extra: shape.patchExtra } }),
              },
            },
          }),
      ...(shape.revision === undefined
        ? {}
        : { defaultsRevision: shape.revision }),
      ...(shape.context === undefined
        ? {}
        : { defaultsContext: shape.context }),
    }),
  };
}

type World = Awaited<ReturnType<typeof outboxWorld>>;
type Path = "enqueue" | "edit" | "supersede";
const PATHS: Path[] = ["enqueue", "edit", "supersede"];

/** A small queued draft under `OLD` (not for the enqueue path), in a version conflict when it is to be superseded. */
async function started(path: Path, free: number): Promise<World> {
  const w = await outboxWorld();
  if (path !== "enqueue") {
    expect((await w.outbox.enqueue(request({ localId: OLD }))).kind).toBe(
      "queued",
    );
    if (path === "supersede")
      w.put("drafts", [{ ...w.drafts()[0], status: "version_conflict" }]);
  }
  w.freeBytes = free;
  w.quota.invalidate();
  return w;
}
const run = (w: World, path: Path, shape: Shape) => {
  const id = path === "edit" ? OLD : NEW;
  const asked = request({ ...shape, localId: shape.localId ?? id });
  return path === "enqueue"
    ? w.outbox.enqueue(asked)
    : path === "edit"
      ? w.outbox.editQueued(OLD, asked)
      : w.outbox.supersede(OLD, asked);
};
const exec = (w: World, plan: unknown, over: object): Promise<unknown> =>
  w.service.store.run(
    plan as never,
    { ...over, incarnationId: w.service.incarnationId } as never,
  );

/** What the transaction measures of the write it composes for `shape` on `path`, from a bound that cannot hold it. */
async function measured(path: Path, shape: Shape): Promise<number> {
  const w = await outboxWorld();
  let out: unknown;
  if (path === "enqueue")
    out = await exec(w, enqueueDraft, {
      request: request(shape),
      localId: request(shape).localId,
      accountId: ACCOUNT,
      now: NOW,
      maxBytes: 1,
    });
  else {
    await w.outbox.enqueue(request({ localId: OLD }));
    if (path === "edit")
      out = await exec(w, editQueuedDraft, {
        localId: OLD,
        request: request({ ...shape, localId: OLD }),
        maxBytes: 1,
      });
    else {
      w.put("drafts", [{ ...w.drafts()[0], status: "version_conflict" }]);
      out = await exec(w, supersedeDraft, {
        oldLocalId: OLD,
        request: request(shape),
        localId: request(shape).localId,
        accountId: ACCOUNT,
        now: NOW,
        maxBytes: 1,
      });
    }
  }
  const result = out as { kind: string; bytes?: number };
  if (result.kind !== "too_large")
    throw new Error(`setup: ${path} reported ${JSON.stringify(result)}`);
  return result.bytes as number;
}

describe("the reviewer's matrix: a large defaults context on enqueue, an edit and a supersession", () => {
  for (const path of PATHS) {
    test(`${path}: a ${BIG}-character context with room for half the reserve plus 500,000 bytes is refused as quota and nothing is written`, async () => {
      const w = await started(path, RESERVE / 2 + 500_000);
      const before = JSON.stringify(w.snapshot());
      const outcome = await run(w, path, {
        context: { previousAudience: "x".repeat(BIG) },
      });
      expect(outcome).toEqual({ kind: "refused", reason: "quota" });
      expect(JSON.stringify(w.snapshot())).toBe(before);
      // The refusal released everything it held: a small write at the same free space is admitted.
      expect((await run(w, path, {})).kind).not.toBe("refused");
    });

    test(`control: ${path}, a small context at the same free space is written, with the context stored`, async () => {
      const w = await started(path, RESERVE / 2 + 500_000);
      const outcome = await run(w, path, {
        context: { previousAudience: "x".repeat(100) },
      });
      expect(outcome.kind).not.toBe("refused");
      const id = path === "edit" ? OLD : NEW;
      const stored = w.drafts().find((row) => row.local_id === id);
      expect(stored?.defaults_context).toEqual({
        previousAudience: "x".repeat(100),
      });
    });

    test(`control: ${path}, the large context with room for it is written as given`, async () => {
      const w = await started(path, RESERVE / 2 + 5 * MIB);
      const outcome = await run(w, path, {
        context: { previousAudience: "x".repeat(BIG) },
      });
      expect(outcome.kind).not.toBe("refused");
      const id = path === "edit" ? OLD : NEW;
      const stored = w.drafts().find((row) => row.local_id === id);
      expect(stored).toBeDefined();
      const context = (stored as DraftRow).defaults_context as {
        previousAudience: string;
      };
      expect(context.previousAudience).toHaveLength(BIG);
    });

    test(`${path}: the exact boundary: one byte short of the write is refused, the write itself fits (the transaction's own figure)`, async () => {
      const shape: Shape = { context: { note: "y".repeat(3000) } };
      const bytes = await measured(path, shape);
      const tight = await started(path, RESERVE / 2 + bytes - 1);
      expect((await run(tight, path, shape)).kind).toBe("refused");
      // Room for the whole write and the slack of the estimate's placeholders (the estimate is a bound, never below the write).
      const roomy = await started(path, RESERVE / 2 + bytes + 4096);
      expect((await run(roomy, path, shape)).kind).not.toBe("refused");
    });
  }
});

/**
 * R25 (revision 14): the measure covers what the STORED form can retain. The reviewer's schedule: `Object.assign([], { previousAudience:
 * "x".repeat(900_000) })` was a two-byte context (its members are none), and IndexedDB retained all 900,000 bytes of the named property.
 * The same measure serves the estimate and the transaction's check, so one omission was in both. Three growth paths and nested forms,
 * each against the ordinary array or object of the same size as the control.
 */
describe("R25 (revision 14): a named property of an array is part of the write", () => {
  const named = (value: string): unknown =>
    Object.assign([], { previousAudience: value });
  /** The same payload shaped as the ordinary values the guard already handled: the controls. */
  const FORMS: Array<{
    name: string;
    odd: (value: string) => Shape;
    ordinary: (value: string) => Shape;
    read: (stored: DraftRow, value: string) => string | undefined;
  }> = [
    {
      name: "the defaults context itself is an array with a named property",
      odd: (value) => ({ context: named(value) }),
      ordinary: (value) => ({ context: { previousAudience: value } }),
      read: (stored) =>
        (stored.defaults_context as { previousAudience?: string })
          ?.previousAudience,
    },
    {
      name: "the array with the property is a member of an object in the context",
      odd: (value) => ({ context: { audience: { list: named(value) } } }),
      ordinary: (value) => ({
        context: { audience: { list: { previousAudience: value } } },
      }),
      read: (stored) =>
        (
          stored.defaults_context as {
            audience?: { list?: { previousAudience?: string } };
          }
        )?.audience?.list?.previousAudience,
    },
    {
      name: "the array with the property is an element of an array in the context",
      odd: (value) => ({ context: [1, [named(value)]] }),
      ordinary: (value) => ({
        context: [1, [{ previousAudience: value }]],
      }),
      read: (stored) => {
        const outer = stored.defaults_context as unknown[];
        const inner = outer?.[1];
        return Array.isArray(inner)
          ? (inner[0] as { previousAudience?: string } | undefined)
              ?.previousAudience
          : undefined;
      },
    },
  ];

  for (const path of PATHS)
    for (const form of FORMS) {
      test(`${path}, ${form.name}: refused as quota with room for half the reserve plus 500,000 bytes, nothing written`, async () => {
        const w = await started(path, RESERVE / 2 + 500_000);
        const before = JSON.stringify(w.snapshot());
        const outcome = await run(w, path, form.odd("x".repeat(BIG)));
        expect(outcome).toEqual({ kind: "refused", reason: "quota" });
        expect(JSON.stringify(w.snapshot())).toBe(before);
        // The refusal held nothing: a small write at the same free space is admitted.
        expect((await run(w, path, {})).kind).not.toBe("refused");
      });

      test(`control: ${path}, the same payload as an ordinary value is refused the same way (${form.name})`, async () => {
        const w = await started(path, RESERVE / 2 + 500_000);
        const outcome = await run(w, path, form.ordinary("x".repeat(BIG)));
        expect(outcome).toEqual({ kind: "refused", reason: "quota" });
      });

      test(`control: ${path}, a SMALL named property at the same free space is written, and kept as given (${form.name})`, async () => {
        const w = await started(path, RESERVE / 2 + 500_000);
        const outcome = await run(w, path, form.odd("kept"));
        expect(outcome.kind).not.toBe("refused");
        const id = path === "edit" ? OLD : NEW;
        const stored = w.drafts().find((row) => row.local_id === id);
        expect(form.read(stored as DraftRow, "kept")).toBe("kept");
      });

      test(`control: ${path}, the large named property with room for it is written whole (${form.name})`, async () => {
        const w = await started(path, RESERVE / 2 + 5 * MIB);
        const outcome = await run(w, path, form.odd("x".repeat(BIG)));
        expect(outcome.kind).not.toBe("refused");
        const id = path === "edit" ? OLD : NEW;
        const stored = w.drafts().find((row) => row.local_id === id);
        expect(form.read(stored as DraftRow, "x")).toHaveLength(BIG);
      });

      test(`${path}, ${form.name}: the exact boundary (the transaction's own figure) is the same as the ordinary payload's`, async () => {
        const odd = await measured(path, form.odd("y".repeat(3000)));
        const ordinary = await measured(path, form.ordinary("y".repeat(3000)));
        // The array form adds its brackets where the object form adds braces: the named property is counted as an object's entry is.
        expect(Math.abs(odd - ordinary)).toBeLessThanOrEqual(8);
        const tight = await started(path, RESERVE / 2 + odd - 1);
        expect((await run(tight, path, form.odd("y".repeat(3000)))).kind).toBe(
          "refused",
        );
      });
    }

  for (const path of PATHS)
    for (const [place, shape] of [
      [
        "the command",
        (value: string): Shape => ({ commandExtra: named(value) }),
      ],
      [
        "the display patch",
        (value: string): Shape => ({ patchExtra: named(value) }),
      ],
    ] as const)
      test(`${path}: a named property of an array inside ${place} is refused as quota with room for half the reserve plus 500,000 bytes`, async () => {
        const w = await started(path, RESERVE / 2 + 500_000);
        const before = JSON.stringify(w.snapshot());
        const outcome = await run(w, path, shape("x".repeat(BIG)));
        expect(outcome).toEqual({ kind: "refused", reason: "quota" });
        expect(JSON.stringify(w.snapshot())).toBe(before);
      });
});

describe("`plainJsonBytes` measures what a structured clone retains of an array", () => {
  const big = "x".repeat(10_000);
  const keyed = (key: string, value: string) =>
    utf8Length(JSON.stringify(key)) + 1 + utf8Length(JSON.stringify(value));

  test("a named property is counted as an object's entry is, beside the members the array has", () => {
    const list = Object.assign([1, 2], { note: big });
    expect(plainJsonBytes(list)).toBe(
      2 + "1,2".length + 1 + keyed("note", big),
    );
    // What a clone keeps is what is measured: the property survives it.
    expect((structuredClone(list) as unknown as { note: string }).note).toBe(
      big,
    );
  });

  test("an array of only named properties, and several of them, are all counted", () => {
    const list = Object.assign([], { a: big, b: big, c: 1 });
    // Brackets, then three entries as an object's, with the two commas between them.
    expect(plainJsonBytes(list)).toBe(
      2 + keyed("a", big) + 1 + keyed("b", big) + 1 + `"c":1`.length,
    );
  });

  test("an array whose named property is an array with a named property is counted at every level", () => {
    const inner = Object.assign([], { deep: big });
    const outer = Object.assign([inner], { shallow: big });
    expect(plainJsonBytes(outer)).toBeGreaterThanOrEqual(2 * big.length);
  });

  test("a property that is not an array index is named, however it looks: `-1`, `01`, `1.5`, `4294967295`, `length `", () => {
    for (const key of ["-1", "01", "1.5", "4294967295", "length "]) {
      const list = Object.assign([], { [key]: big });
      expect(plainJsonBytes(list), key).toBe(2 + keyed(key, big));
      // ...and a clone keeps it as a property, not an element.
      expect(Object.keys(structuredClone(list) as unknown as object)).toEqual([
        key,
      ]);
    }
  });

  test("a hole is counted as the null JSON says it is, in constant time whatever the length", () => {
    // biome-ignore lint/suspicious/noSparseArray: the shape under test
    const sparse = [1, , 3] as unknown[];
    expect(plainJsonBytes(sparse)).toBe(
      new TextEncoder().encode(JSON.stringify(sparse)).length,
    );
    const holes: unknown[] = [];
    holes.length = 4_294_967_294;
    expect(plainJsonBytes(holes)).toBe(
      2 + 4 * holes.length + (holes.length - 1),
    );
    const lone: unknown[] = [];
    lone[1_000_000] = "x";
    expect(plainJsonBytes(lone)).toBe(
      2 + 4 * 1_000_000 + 1_000_000 + 3 /* "x" */,
    );
  });

  test("an array is measured by its keys, not its iterator: a replaced `Symbol.iterator` hides nothing", () => {
    const list = Object.assign([big, big], {
      [Symbol.iterator]: function* () {
        // yields nothing
      },
    });
    expect(plainJsonBytes(list)).toBe(plainJsonBytes([big, big]));
    expect(plainJsonBytes([...list])).toBe(2);
  });

  test("a symbol-keyed or non-enumerable property is not retained by a clone, so it is not counted", () => {
    const list = [1];
    Object.defineProperty(list, "hidden", { value: big, enumerable: false });
    (list as unknown as Record<symbol, string>)[Symbol("s")] = big;
    expect(plainJsonBytes(list)).toBe(plainJsonBytes([1]));
    expect(Object.keys(structuredClone(list) as unknown as object)).toEqual([
      "0",
    ]);
  });

  test("an accessor is not plain data: a getter on an array member, a named property or an object key is refused, never run", () => {
    let calls = 0;
    const getter = {
      enumerable: true,
      get() {
        calls += 1;
        return calls > 1 ? big : "small";
      },
    };
    expect(plainJsonBytes(Object.defineProperty({}, "k", getter))).toBeNull();
    expect(
      plainJsonBytes(Object.defineProperty([], "named", getter)),
    ).toBeNull();
    expect(plainJsonBytes(Object.defineProperty([0], "0", getter))).toBeNull();
    expect(calls).toBe(0);
  });

  test("an array subclass is an array to a clone and is measured as one", () => {
    class Audience extends Array<string> {
      note = big;
    }
    const list = Audience.from(["a"]);
    expect(plainJsonBytes(list)).toBeGreaterThanOrEqual(big.length);
  });

  test("a dense array of plain members is exactly what it was (no key-based figure for the common case)", () => {
    for (const value of [
      [],
      [1],
      ["a", null, true],
      [[], [[1]]],
      [{ a: [1, { b: 2 }] }],
    ])
      expect(plainJsonBytes(value)).toBe(
        new TextEncoder().encode(JSON.stringify(value)).length,
      );
  });
});

describe("every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size", () => {
  const filler = "q".repeat(GROW);
  // Each entry: what is inflated, the paths on which the value can differ (an edit cannot change what a draft targets), and the least
  // that growing it by GROW must add (identifiers are stored again in the header's other arrays, the index entries and the version rows).
  const SOURCES: Array<{
    name: string;
    shape: (n: string) => Shape;
    paths: Path[];
    copies: number;
  }> = [
    {
      name: "defaults context (opaque, unbounded)",
      shape: (n) => ({ context: { audience: n } }),
      paths: PATHS,
      copies: 1,
    },
    {
      name: "defaults context as a list of many short strings",
      shape: (n) => ({
        context: Array.from({ length: 200 }, () => n.slice(0, 1000)),
      }),
      paths: PATHS,
      copies: 1,
    },
    {
      // R25 (revision 14): a structured clone keeps the named properties of an array, which a walk of its members never sees.
      name: "defaults context: a NAMED property of an array (kept by a clone, invisible to JSON and to its members)",
      shape: (n) => ({ context: Object.assign([], { previousAudience: n }) }),
      paths: PATHS,
      copies: 1,
    },
    {
      name: "defaults context: a named property of an array inside an object inside an array",
      shape: (n) => ({
        context: [{ nest: Object.assign([1, 2], { note: n }) }, "tail"],
      }),
      paths: PATHS,
      copies: 1,
    },
    {
      name: "command: a named property of an array member",
      shape: (n) => ({ commandExtra: Object.assign(["a"], { note: n }) }),
      paths: PATHS,
      copies: 1,
    },
    {
      name: "display patch: a named property of an array in its value",
      shape: (n) => ({ patchExtra: Object.assign(["a"], { note: n }) }),
      paths: PATHS,
      copies: 1,
    },
    {
      name: "defaults revision",
      shape: (n) => ({ revision: n }),
      paths: PATHS,
      copies: 1,
    },
    {
      name: "command kind (derived into the header once more)",
      shape: (n) => ({ kind: n }),
      paths: PATHS,
      copies: 2,
    },
    {
      name: "display patch",
      shape: (n) => ({ patch: n }),
      paths: PATHS,
      copies: 1,
    },
    {
      name: "command text",
      shape: (n) => ({ text: n }),
      paths: PATHS,
      copies: 1,
    },
    {
      name: "endpoint",
      shape: (n) => ({ endpoint: `/commands/${n}` }),
      paths: ["enqueue", "supersede"],
      copies: 1,
    },
    {
      name: "target id",
      shape: (n) => ({ endpoint: "/commands/{id}", targetId: n }),
      paths: ["enqueue", "supersede"],
      copies: 1,
    },
    {
      name: "resource id (in the header's four arrays and keys, the version row, and every index entry)",
      shape: (n) => ({ resourceId: n }),
      paths: ["enqueue", "supersede"],
      copies: 4,
    },
    {
      name: "the caller's own dependency",
      shape: (n) => ({ extraDependency: n }),
      paths: ["enqueue", "supersede"],
      copies: 1,
    },
    {
      name: "local id",
      shape: (n) => ({ localId: n }),
      paths: ["enqueue", "supersede"],
      copies: 1,
    },
  ];

  for (const source of SOURCES) {
    test(`${source.name}: the estimate grows by at least ${source.copies} x its size`, () => {
      const small = estimateDraftBytes(request(source.shape("n")));
      const large = estimateDraftBytes(request(source.shape(filler)));
      expect(large - small).toBeGreaterThanOrEqual(
        source.copies * LEAST_GROWTH,
      );
    });

    for (const path of source.paths)
      test(`${source.name}: ${path}: the transaction's measure grows by at least ${source.copies} x its size`, async () => {
        const small = await measured(path, source.shape("n"));
        const large = await measured(path, source.shape(filler));
        expect(large - small).toBeGreaterThanOrEqual(
          source.copies * LEAST_GROWTH,
        );
      });
  }

  for (const source of SOURCES.filter((entry) =>
    ["defaults revision", "endpoint", "target id", "local id"].some((name) =>
      entry.name.startsWith(name),
    ),
  ))
    for (const path of source.paths)
      test(`${source.name}: ${path} with a ${BIG}-byte value and room for half the reserve plus 500,000 bytes is refused as quota, nothing written`, async () => {
        const w = await started(path, RESERVE / 2 + 500_000);
        const before = JSON.stringify(w.snapshot());
        const outcome = await run(w, path, source.shape("z".repeat(BIG)));
        expect(outcome).toEqual({ kind: "refused", reason: "quota" });
        expect(JSON.stringify(w.snapshot())).toBe(before);
      });

  test("the old figure (the command and its display patch) is a floor under the whole write, and the allowance a floor under both", async () => {
    for (const path of PATHS) {
      const bytes = await measured(path, {});
      expect(bytes).toBeGreaterThan(DRAFT_ALLOWANCE_BYTES);
    }
    expect(estimateDraftBytes(request({}))).toBeGreaterThan(
      DRAFT_ALLOWANCE_BYTES,
    );
  });
});

describe("an edit that keeps the context it already holds is charged for it", () => {
  test("the estimate cannot know a stored context: the plan measures the header it rewrites, so a tight edit is refused and a roomy one is written", async () => {
    const stored = { audience: "x".repeat(BIG) };
    const seed = async (free: number) => {
      const w = await outboxWorld();
      w.freeBytes = RESERVE / 2 + 5 * MIB;
      w.quota.invalidate();
      expect(
        (await w.outbox.enqueue(request({ localId: OLD, context: stored })))
          .kind,
      ).toBe("queued");
      w.freeBytes = free;
      w.quota.invalidate();
      return w;
    };
    // The new request carries no context: `planEdit` keeps the stored one, and it is stored again with the rewritten header.
    const tight = await seed(RESERVE / 2 + 500_000);
    const before = JSON.stringify(tight.snapshot());
    expect(
      await tight.outbox.editQueued(
        OLD,
        request({ localId: OLD, text: "new" }),
      ),
    ).toEqual({ kind: "refused", reason: "quota" });
    expect(JSON.stringify(tight.snapshot())).toBe(before);

    const roomy = await seed(RESERVE / 2 + 5 * MIB);
    expect(
      (
        await roomy.outbox.editQueued(
          OLD,
          request({ localId: OLD, text: "new" }),
        )
      ).kind,
    ).toBe("edited");
    expect(roomy.drafts()[0]?.defaults_context).toEqual(stored);
  });
});

describe("a supersession is charged for the dependants it rewrites", () => {
  test("each direct dependant adds at least the rewritten-dependant allowance to the measure, and the measure of N is N times that of one", async () => {
    const sizeWith = async (dependants: number): Promise<number> => {
      const w = await outboxWorld();
      await w.outbox.enqueue(request({ localId: OLD }));
      for (let i = 0; i < dependants; i += 1) {
        const id = `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, "0")}`;
        const resource = `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, "0")}`;
        expect(
          (
            await w.outbox.enqueue({
              ...request({ localId: id, resourceId: resource }),
              dependsOnExtra: [OLD],
            })
          ).kind,
        ).toBe("queued");
      }
      w.put("drafts", [
        {
          ...(w.drafts().find((row) => row.local_id === OLD) as DraftRow),
          status: "version_conflict",
        },
      ]);
      const out = (await exec(w, supersedeDraft, {
        oldLocalId: OLD,
        request: request({}),
        localId: NEW,
        accountId: ACCOUNT,
        now: NOW,
        maxBytes: 1,
      })) as { kind: string; bytes: number };
      expect(out.kind).toBe("too_large");
      return out.bytes;
    };
    const none = await sizeWith(0);
    const some = await sizeWith(5);
    const more = await sizeWith(10);
    expect(some - none).toBeGreaterThanOrEqual(5 * REWRITTEN_DEPENDANT_BYTES);
    expect(more - some).toBeGreaterThanOrEqual(5 * REWRITTEN_DEPENDANT_BYTES);
  });

  test("the version rows a save writes are measured: each row adds its own bytes beyond its identifier", () => {
    const base = {
      draft: {
        local_id: NEW,
        depends_on: [],
        index_targets: [],
        target_resource_ids: [],
        display_patch: null,
      } as unknown as DraftRow,
      command: { kind: "x" } as JsonObject,
    };
    const rows = Array.from({ length: 10 }, (_, i) => ({
      resource_id: `r${i}`,
      locally_assumed_version: 123456789,
      basis: "progress_stream" as const,
    }));
    const none = draftWriteBytes({ ...base, versionPuts: [] }) as number;
    const some = draftWriteBytes({ ...base, versionPuts: rows }) as number;
    // Beyond the identifiers (which are counted again on their own), a row is its field names, its version and its basis.
    expect(some - none).toBeGreaterThanOrEqual(
      10 * (plainJsonBytes(rows[0]) as number) + 0,
    );
  });

  test("the pure measure takes the count of dependants rewritten as given", () => {
    const base = {
      draft: {
        local_id: NEW,
        depends_on: [],
        index_targets: [],
        target_resource_ids: [],
        display_patch: null,
      } as unknown as DraftRow,
      command: { kind: "x" } as JsonObject,
      versionPuts: [],
    };
    const none = draftWriteBytes(base) as number;
    expect(
      (draftWriteBytes({ ...base, rewritten: 3 }) as number) - none,
    ).toBeGreaterThanOrEqual(3 * REWRITTEN_DEPENDANT_BYTES);
  });
});

describe("a value that cannot be measured is never a small write: the caller's defect, refused before anything is stored", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const deep = (levels: number): unknown => {
    let value: unknown = "leaf";
    for (let i = 0; i < levels; i += 1) value = [value];
    return value;
  };
  const CASES: Array<[string, unknown]> = [
    ["a Map (JSON turns it into {})", new Map([["audience", "x".repeat(BIG)]])],
    ["a Set", new Set(["x".repeat(BIG)])],
    ["a Date", new Date(0)],
    ["a typed array", new Uint8Array(BIG)],
    ["an ArrayBuffer", new ArrayBuffer(BIG)],
    ["a class instance", new (class Audience {})()],
    ["a bigint", { n: 10n }],
    ["a function", { f: () => 1 }],
    ["a symbol", { s: Symbol("s") }],
    ["a cycle", cyclic],
    ["a value nested beyond the depth limit", deep(300)],
    ["a non-finite number", { n: Number.POSITIVE_INFINITY }],
    [
      "a getter that throws",
      Object.defineProperty({}, "boom", {
        enumerable: true,
        get() {
          throw new Error("no");
        },
      }),
    ],
  ];
  for (const [label, context] of CASES)
    for (const path of PATHS)
      test(`${label} as the defaults context, ${path}: the facade throws, nothing is written and nothing is left held`, async () => {
        const w = await started(path, RESERVE / 2 + 500_000);
        const before = JSON.stringify(w.snapshot());
        await expect(run(w, path, { context })).rejects.toThrow(TypeError);
        expect(JSON.stringify(w.snapshot())).toBe(before);
        expect((await run(w, path, {})).kind).not.toBe("refused");
      });

  for (const [label, value] of [
    ["a Map", new Map([["k", "x".repeat(BIG)]])],
    ["a Set", new Set(["x".repeat(BIG)])],
    ["a typed array", new Uint8Array(BIG)],
  ] as Array<[string, unknown]>)
    for (const path of PATHS) {
      test(`${label} inside the COMMAND, ${path}: canonical JSON would call it {} and the clone would store it whole, so it is refused, nothing is written`, async () => {
        const w = await started(path, RESERVE / 2 + 500_000);
        const before = JSON.stringify(w.snapshot());
        await expect(run(w, path, { commandExtra: value })).rejects.toThrow(
          TypeError,
        );
        expect(JSON.stringify(w.snapshot())).toBe(before);
      });
      test(`${label} inside the DISPLAY PATCH, ${path}: refused the same way`, async () => {
        const w = await started(path, RESERVE / 2 + 500_000);
        const before = JSON.stringify(w.snapshot());
        await expect(run(w, path, { patchExtra: value })).rejects.toThrow(
          TypeError,
        );
        expect(JSON.stringify(w.snapshot())).toBe(before);
      });
    }

  test("an `undefined` member is counted like a `null` (the structured clone stores the key), not as nothing", () => {
    expect(plainJsonBytes({ a: undefined })).toBe(plainJsonBytes({ a: null }));
    expect(plainJsonBytes(undefined)).toBe(4);
  });
});

describe("`plainJsonBytes` is the UTF-8 size of the JSON it stands for", () => {
  /** A seeded generator of JSON values over an alphabet that has every UTF-8 width, escapes and surrogate pairs. */
  const alphabet = [
    "a",
    "Z",
    "0",
    " ",
    '"',
    "\\",
    "\n",
    "\u0001",
    "é",
    "界",
    " ",
    "😀",
    "\ud800",
    "\udc00",
  ];
  const seeded = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  test("equals the encoded length of JSON.stringify over a seeded walk of nested values", () => {
    const next = seeded(20261004);
    const text = (): string =>
      Array.from(
        { length: Math.floor(next() * 12) },
        () => alphabet[Math.floor(next() * alphabet.length)],
      ).join("");
    const value = (depth: number): unknown => {
      const pick = Math.floor(next() * (depth > 3 ? 5 : 7));
      switch (pick) {
        case 0:
          return null;
        case 1:
          return next() < 0.5;
        case 2:
          return Math.floor(next() * 2 ** 40) / (next() < 0.5 ? 1 : 7);
        case 3:
        case 4:
          return text();
        case 5:
          return Array.from({ length: Math.floor(next() * 4) }, () =>
            value(depth + 1),
          );
        default:
          return Object.fromEntries(
            Array.from({ length: Math.floor(next() * 4) }, () => [
              text(),
              value(depth + 1),
            ]),
          );
      }
    };
    for (let i = 0; i < 400; i += 1) {
      const v = value(0);
      expect(plainJsonBytes(v), JSON.stringify(v)).toBe(
        new TextEncoder().encode(JSON.stringify(v)).length,
      );
    }
  });

  test("counts bytes, not code units: a CJK string is three bytes a character", () => {
    expect(plainJsonBytes("界".repeat(1000))).toBe(2 + 3000);
    expect(utf8Length("界".repeat(1000))).toBe(3000);
  });

  test("a value shared twice (not a cycle) is measured twice, and the depth limit is on nesting, not on breadth", () => {
    const shared = { k: "v" };
    expect(plainJsonBytes([shared, shared])).toBe(
      new TextEncoder().encode(JSON.stringify([shared, shared])).length,
    );
    const nest = (levels: number): unknown => {
      let value: unknown = 1;
      for (let i = 0; i < levels; i += 1) value = [value];
      return value;
    };
    expect(plainJsonBytes(nest(250))).not.toBeNull();
    expect(plainJsonBytes(nest(260))).toBeNull();
    expect(
      plainJsonBytes(Array.from({ length: 5000 }, () => 1)),
    ).not.toBeNull();
  });

  test("the identifiers are counted again for the index entries and candidate rows", () => {
    const row = (id: string) =>
      ({
        draft: {
          local_id: id,
          depends_on: [],
          index_targets: [],
          target_resource_ids: [],
          display_patch: null,
        } as unknown as DraftRow,
        command: { kind: "x" } as JsonObject,
        versionPuts: [],
      }) as const;
    const small = draftWriteBytes(row("a")) as number;
    const large = draftWriteBytes(row("a".repeat(1001))) as number;
    // The id is in the header once and in the identifier ledger IDENTIFIER_COPIES times more.
    expect(large - small).toBeGreaterThanOrEqual(
      1000 * (1 + IDENTIFIER_COPIES),
    );
  });
});
