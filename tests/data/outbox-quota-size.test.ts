// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  DRAFT_ALLOWANCE_BYTES,
  draftBytes,
  draftWriteBytes,
  type EnqueueRequest,
  estimateDraftBytes,
  utf8Length,
} from "../../src/data/model/outbox";
import type { JsonObject } from "../../src/data/model/types";
import {
  editQueuedDraft,
  enqueueDraft,
  supersedeDraft,
} from "../../src/data/plans/outbox";
import { outboxWorld } from "../support/data/outbox-world";

/**
 * R25 (revision 12): the quota reserve is charged the size of the command that is actually written.
 *
 * `estimateDraftBytes` called `request.build({})` before the transaction had read the bases. A normal builder that carries
 * `expected_version: bases[id]` produces an `undefined` member there, canonicalisation throws, and the estimate silently became the
 * 4,096-byte allowance whatever the body's size: a 900,048-byte command was admitted with a 4,096-byte debit on every growth path
 * (enqueue, an edit of a queued draft, a supersession). It also counted `.length`, UTF-16 code units, not bytes.
 *
 * The rule: text is counted in UTF-8 bytes (`utf8Length`); the facade reserves a BOUND (the larger of the commands built from two sets
 * of bases that bracket the real one); the PLAN measures the command it really built, from the bases it read, against that bound and
 * writes NOTHING when it is larger; the write is then admitted again at the size the plan reports, by the same overlapping-reservation
 * rule, a bounded number of times. The estimate is injected free space, not a measurement of what an engine allocates. FIXTURE evidence.
 */
const MIB = 1024 * 1024;
const RESERVE = DATA_CONFIG.quotaReserveBytes;
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
/** The account the world opens: the identity a direct plan call must carry for its measure to equal the facade's (the header holds it). */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const PRIMARY = {
  resourceId: TARGET,
  role: "primary" as const,
  basis: "resource" as const,
  versionChecked: true,
  seedIfUntracked: 1,
};
type Bases = Readonly<Record<string, number>>;

/** The ways a command's size can depend on the bases it is built from. */
type Mode =
  | "constant"
  | "needs-base"
  | "utf8"
  | "throws-without-bases"
  | "throws-for-probes";
const MODES: Mode[] = [
  "constant",
  "needs-base",
  "utf8",
  "throws-without-bases",
  "throws-for-probes",
];
const ASCII_BYTES = 900_000;
const CJK_CHARS = 300_000;

function builder(mode: Mode, localId: string, text?: string): EnqueueRequest {
  return {
    localId,
    endpoint: "/commands",
    targets: [PRIMARY],
    build: (bases: Bases) => {
      const base = bases[TARGET];
      switch (mode) {
        case "constant":
          return {
            command: {
              kind: "update",
              text: text ?? "x".repeat(ASCII_BYTES),
              expected_version: 1,
            },
          };
        case "needs-base":
          // `bases[TARGET]` is undefined until the transaction has read it: canonical JSON refuses an `undefined` member.
          return {
            command: {
              kind: "update",
              text: text ?? "x".repeat(ASCII_BYTES),
              expected_version: base as number,
            },
          };
        case "utf8":
          return {
            command: {
              kind: "update",
              text: text ?? "界".repeat(CJK_CHARS),
              expected_version: base as number,
            },
          };
        case "throws-without-bases":
          // A builder that cannot run without the base at all.
          if (base === undefined) throw new Error("needs the base");
          return {
            command: {
              kind: "update",
              text: text ?? "x".repeat(ASCII_BYTES),
              expected_version: base as number,
            },
          };
        case "throws-for-probes":
          // Runs only for a plausible version: both estimation probes (no bases, the widest version) throw, so the estimate is the
          // allowance alone and only the plan can say how large the command is.
          if (base === undefined || base > 1000)
            throw new Error("not a version this command can be built from");
          return {
            command: {
              kind: "update",
              text: text ?? "x".repeat(ASCII_BYTES),
              expected_version: base as number,
            },
          };
      }
    },
  };
}

type World = Awaited<ReturnType<typeof outboxWorld>>;
type Path = "enqueue" | "edit" | "supersede";
const PATHS: Path[] = ["enqueue", "edit", "supersede"];

/** A small queued draft under `OLD` (not for the enqueue path), in a version conflict when it is to be superseded. */
async function started(path: Path, free: number): Promise<World> {
  const w = await outboxWorld();
  if (path !== "enqueue") {
    const small = builder("constant", OLD, "small");
    expect((await w.outbox.enqueue(small)).kind).toBe("queued");
    if (path === "supersede")
      w.put("drafts", [{ ...w.drafts()[0], status: "version_conflict" }]);
  }
  w.freeBytes = free;
  w.quota.invalidate();
  return w;
}
const run = (w: World, path: Path, request: EnqueueRequest) =>
  path === "enqueue"
    ? w.outbox.enqueue(request)
    : path === "edit"
      ? w.outbox.editQueued(OLD, request)
      : w.outbox.supersede(OLD, request);
/** The command a request builds from the real base (1: the seed), in bytes, with the allowance: the COMMAND's share of a write. */
const real = (request: EnqueueRequest): number => {
  const built = request.build({ [TARGET]: 1 });
  const bytes = draftBytes(built.command, built.displayPatch);
  if (bytes === null) throw new Error("setup: unmeasurable");
  return bytes;
};

/**
 * ADAPTED (revision 13). What a write really adds, as the revision-13 accounting counts it (`draftWriteBytes`: the whole variable-size
 * write, not the command alone), measured from the ROWS A WRITE STORED, in a world of its own: an independent witness of what the plan
 * composed, which the plan's own report is then compared with. Revision 12 pinned `real(request)` (the command alone) as the whole.
 */
async function written(request: EnqueueRequest): Promise<number> {
  const w = await outboxWorld();
  const outcome = await w.outbox.enqueue(request);
  if (outcome.kind !== "queued") throw new Error("setup: not written");
  const draft = w.drafts()[0];
  const command = w.commandOf(outcome.localId) as JsonObject | undefined;
  if (draft === undefined || command === undefined)
    throw new Error("setup: nothing stored");
  const bytes = draftWriteBytes({
    draft,
    command,
    versionPuts: w.versions(),
  });
  if (bytes === null) throw new Error("setup: unmeasurable");
  return bytes;
}

/** ADAPTED (revision 13): the whole write of an edit of a small queued draft under `OLD`, from the rows it stored. */
async function editedBytes(request: EnqueueRequest): Promise<number> {
  const w = await outboxWorld();
  await w.outbox.enqueue(builder("constant", OLD, "small"));
  const outcome = await w.outbox.editQueued(OLD, request);
  if (outcome.kind !== "edited") throw new Error("setup: not edited");
  const draft = w.drafts()[0];
  const command = w.commandOf(OLD) as JsonObject | undefined;
  if (draft === undefined || command === undefined)
    throw new Error("setup: nothing stored");
  const bytes = draftWriteBytes({ draft, command, versionPuts: [] });
  if (bytes === null) throw new Error("setup: unmeasurable");
  return bytes;
}

/** ADAPTED (revision 13): the whole write of a supersession of a conflicted draft under `OLD`, from the rows it stored. */
async function supersededBytes(request: EnqueueRequest): Promise<number> {
  const w = await outboxWorld();
  await w.outbox.enqueue(builder("constant", OLD, "small"));
  w.put("drafts", [{ ...w.drafts()[0], status: "version_conflict" }]);
  const outcome = await w.outbox.supersede(OLD, request);
  if (outcome.kind !== "superseded") throw new Error("setup: not superseded");
  const draft = w.drafts().find((row) => row.local_id === outcome.localId);
  const command = w.commandOf(outcome.localId) as JsonObject | undefined;
  if (draft === undefined || command === undefined)
    throw new Error("setup: nothing stored");
  const bytes = draftWriteBytes({
    draft,
    command,
    versionPuts: w.versions(),
    rewritten: 0,
  });
  if (bytes === null) throw new Error("setup: unmeasurable");
  return bytes;
}

describe("every growth path is charged the size of the command it really writes (the reviewer's matrix, and its builders)", () => {
  for (const mode of MODES)
    for (const path of PATHS)
      test(`${path}, a ${mode} command with room for half the reserve plus 500,000 bytes: refused as quota, and nothing is written`, async () => {
        const w = await started(path, RESERVE / 2 + 500_000);
        const before = JSON.stringify(w.snapshot());
        const outcome = await run(w, path, builder(mode, NEW));
        expect(outcome).toMatchObject({ kind: "refused", reason: "quota" });
        expect(JSON.stringify(w.snapshot())).toBe(before);
        // The refusal released everything it held: a small write at the same free space is admitted.
        const small = await run(w, path, builder("constant", NEW, "tiny"));
        expect(small.kind).not.toBe("refused");
      });

  for (const mode of MODES)
    for (const path of PATHS)
      test(`control: ${path}, a ${mode} command with room for it: written, as built`, async () => {
        const w = await started(path, RESERVE / 2 + 5 * MIB);
        const request = builder(mode, NEW);
        const outcome = await run(w, path, request);
        expect(outcome.kind).not.toBe("refused");
        const id = path === "edit" ? OLD : NEW;
        expect(w.commandOf(id)).toEqual(request.build({ [TARGET]: 1 }).command);
      });
});

describe("the size is the real one, to the byte, on both sides of the line", () => {
  for (const mode of ["needs-base", "throws-without-bases", "utf8"] as const)
    for (const path of PATHS) {
      test(`${path}, ${mode}: one byte short of the command is refused, comfortably enough room is admitted`, async () => {
        const request = builder(mode, NEW);
        const bytes = real(request);
        const tight = await started(path, RESERVE / 2 + bytes - 1);
        expect((await run(tight, path, request)).kind).toBe("refused");
        const roomy = await started(path, RESERVE / 2 + bytes + 4096);
        expect((await run(roomy, path, request)).kind).not.toBe("refused");
      });
    }

  test("text is counted in UTF-8 bytes: a 300,000-character CJK command is not charged as 300,000 or 600,000", () => {
    const request = builder("utf8", NEW);
    const text = "界".repeat(CJK_CHARS);
    expect(text.length).toBe(CJK_CHARS);
    expect(utf8Length(text)).toBe(3 * CJK_CHARS);
    expect(estimateDraftBytes(request)).toBeGreaterThanOrEqual(
      DRAFT_ALLOWANCE_BYTES + 3 * CJK_CHARS,
    );
    expect(real(request)).toBeGreaterThanOrEqual(
      DRAFT_ALLOWANCE_BYTES + 3 * CJK_CHARS,
    );
  });
});

describe("the estimate saves a second reservation where it can, and the plan covers where it cannot", () => {
  for (const [mode, reservations] of [
    ["constant", 1],
    ["needs-base", 1],
    ["throws-without-bases", 1],
    ["throws-for-probes", 2],
  ] as const)
    test(`a ${mode} save reserves ${reservations} time${reservations === 1 ? "" : "s"}`, async () => {
      const w = await outboxWorld();
      w.freeBytes = RESERVE / 2 + 20 * MIB;
      w.quota.invalidate();
      const reserve = w.quota.reserve.bind(w.quota);
      let calls = 0;
      w.quota.reserve = ((...args: Parameters<typeof reserve>) => {
        calls += 1;
        return reserve(...args);
      }) as typeof w.quota.reserve;
      expect((await w.outbox.enqueue(builder(mode, NEW))).kind).toBe("queued");
      expect(calls).toBe(reservations);
    });
});

describe("overlapping reservations of base-dependent commands", () => {
  for (const mode of ["needs-base", "throws-for-probes"] as const)
    test(`two ${mode} saves at once with room for one (700 KB each): exactly one is written, whichever order they run`, async () => {
      const w = await outboxWorld();
      const text = "x".repeat(700_000);
      w.freeBytes = RESERVE / 2 + 1 * MIB;
      w.quota.invalidate();
      const outcomes = await Promise.all([
        w.outbox.enqueue(builder(mode, NEW, text)),
        w.outbox.enqueue(builder(mode, OTHER, text)),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["queued", "refused"]);
      expect(outcomes.find((o) => o.kind === "refused")).toMatchObject({
        reason: "quota",
      });
      expect(w.drafts()).toHaveLength(1);
      w.assertNoOrphanBodies();
    });

  test("two saves at once with room for both are both written (the reservation is not a lock)", async () => {
    const w = await outboxWorld();
    const text = "x".repeat(300_000);
    w.freeBytes = RESERVE / 2 + 5 * MIB;
    w.quota.invalidate();
    const outcomes = await Promise.all([
      w.outbox.enqueue(builder("throws-for-probes", NEW, text)),
      w.outbox.enqueue(builder("needs-base", OTHER, text)),
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual(["queued", "queued"]);
  });

  test("a base-dependent save that lands is debited at its real size: the next one is judged against what is left, whatever the estimate shows", async () => {
    const w = await outboxWorld();
    const text = "x".repeat(700_000);
    w.freeBytes = RESERVE / 2 + 1 * MIB;
    w.quota.invalidate();
    expect(
      (await w.outbox.enqueue(builder("needs-base", NEW, text))).kind,
    ).toBe("queued");
    // The browser's estimate lags (it still shows the old free space): the second is refused by what the first debited.
    expect(
      await w.outbox.enqueue(builder("throws-for-probes", OTHER, text)),
    ).toMatchObject({ kind: "refused", reason: "quota" });
    expect(w.drafts()).toHaveLength(1);
  });

  test("a builder that is NOT pure (each call larger) is admitted again at most a bounded number of times, then refused, writing nothing", async () => {
    const w = await outboxWorld();
    w.freeBytes = RESERVE / 2 + 5 * MIB;
    w.quota.invalidate();
    let builds = 0;
    const growing: EnqueueRequest = {
      localId: NEW,
      endpoint: "/commands",
      targets: [PRIMARY],
      build: (bases) => {
        builds += 1;
        return {
          command: {
            kind: "update",
            text: "x".repeat(100_000 * builds),
            expected_version: bases[TARGET] ?? 1,
          },
        };
      },
    };
    const outcome = await w.outbox.enqueue(growing);
    expect(outcome).toMatchObject({ kind: "refused", reason: "quota" });
    expect(builds).toBeLessThanOrEqual(8);
    expect(w.drafts()).toEqual([]);
    expect(w.commandOf(NEW)).toBeUndefined();
    // Nothing is left held by the refused rounds.
    w.freeBytes = RESERVE / 2 + 5 * MIB;
    w.quota.invalidate();
    expect(
      (await w.outbox.enqueue(builder("constant", OTHER, "tiny"))).kind,
    ).toBe("queued");
  });
});

describe("the plan measures what it built against what was reserved", () => {
  const input = (request: EnqueueRequest, maxBytes?: number) =>
    ({
      incarnationId: "",
      request,
      localId: NEW,
      accountId: ACCOUNT,
      now: "2026-10-01T10:00:00.000Z",
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }) as const;
  /** Runs a plan on the account's store, stamped with the incarnation the world opened (what the facade does). */
  const exec = (w: World, plan: unknown, over: object): Promise<unknown> =>
    w.service.store.run(
      plan as never,
      {
        ...over,
        incarnationId: w.service.incarnationId,
      } as never,
    );

  test("enqueue: at the bound it is written, one byte over it nothing is written and its exact size is reported; no bound, no limit", async () => {
    const w = await outboxWorld();
    const request = builder("needs-base", NEW, "y".repeat(5000));
    // ADAPTED (revision 13): the exact size is the whole write's (`written`, measured from the rows a write stores), and the revision-12
    // figure, the command alone, stays a floor under it.
    const bytes = await written(request);
    expect(bytes).toBeGreaterThan(real(request));
    const over = await exec(w, enqueueDraft, input(request, bytes - 1));
    expect(over).toEqual({ kind: "too_large", bytes });
    expect(w.drafts()).toEqual([]);
    expect(w.rows("draft_commands")).toEqual([]);
    expect(w.versions()).toEqual([]);
    expect(w.sync().draft_seq).toBe(0);
    const fits = await exec(w, enqueueDraft, input(request, bytes));
    expect(fits).toMatchObject({ kind: "queued", duplicate: false });
    expect(w.drafts()).toHaveLength(1);
  });

  test("enqueue: a retry of a save that already happened writes nothing and is never `too_large`", async () => {
    const w = await outboxWorld();
    const request = builder("needs-base", NEW, "y".repeat(5000));
    await exec(w, enqueueDraft, input(request));
    const again = await exec(w, enqueueDraft, input(request, 0));
    expect(again).toMatchObject({ kind: "queued", duplicate: true });
  });

  test("edit and supersede: the same bound, the same report, nothing written over it", async () => {
    const w = await outboxWorld();
    await w.outbox.enqueue(builder("constant", OLD, "small"));
    const request = builder("needs-base", OLD, "z".repeat(5000));
    // ADAPTED (revision 13): the whole write's size, measured from the rows an edit stores (the world is cloned by an identical edit).
    const bytes = await editedBytes(request);
    const before = JSON.stringify(w.snapshot());
    expect(
      await exec(w, editQueuedDraft, {
        incarnationId: "",
        localId: OLD,
        request,
        maxBytes: bytes - 1,
      }),
    ).toEqual({ kind: "too_large", bytes });
    expect(JSON.stringify(w.snapshot())).toBe(before);
    expect(
      await exec(w, editQueuedDraft, {
        incarnationId: "",
        localId: OLD,
        request,
        maxBytes: bytes,
      }),
    ).toEqual({ kind: "edited", localId: OLD });

    w.put("drafts", [{ ...w.drafts()[0], status: "version_conflict" }]);
    const replacement = builder("needs-base", NEW, "w".repeat(5000));
    const need = await supersededBytes(replacement);
    const beforeSupersede = JSON.stringify(w.snapshot());
    expect(
      await exec(w, supersedeDraft, {
        incarnationId: "",
        oldLocalId: OLD,
        request: replacement,
        localId: NEW,
        accountId: ACCOUNT,
        now: "2026-10-01T10:00:00.000Z",
        maxBytes: need - 1,
      }),
    ).toEqual({ kind: "too_large", bytes: need });
    expect(JSON.stringify(w.snapshot())).toBe(beforeSupersede);
  });

  test("a display patch that no JSON can carry is a defect of the caller, not a small write: the facade throws and nothing is written", async () => {
    const w = await outboxWorld();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const request: EnqueueRequest = {
      ...builder("constant", NEW, "tiny"),
      build: () => ({
        command: { kind: "update", text: "tiny", expected_version: 1 },
        displayPatch: cyclic as never,
      }),
    };
    await expect(w.outbox.enqueue(request)).rejects.toThrow(TypeError);
    expect(w.drafts()).toEqual([]);
    expect(draftBytes({ kind: "x" }, cyclic)).toBeNull();
  });
});

describe("the accounting itself", () => {
  const encoded = (text: string): number =>
    new TextEncoder().encode(text).length;

  test("UTF-8 bytes, character by character", () => {
    for (const [text, bytes] of [
      ["", 0],
      ["abc", 3],
      ["é", 2],
      ["界", 3],
      ["😀", 4],
      ["a界😀é", 1 + 3 + 4 + 2],
      ["\u{10ffff}", 4],
    ] as const)
      expect(utf8Length(text)).toBe(bytes);
  });

  test("a lone surrogate is the three bytes of its replacement character, and agrees with a real encoder everywhere", () => {
    expect(utf8Length("\ud800")).toBe(3);
    expect(utf8Length("a\udc00b")).toBe(5);
    expect(utf8Length("\ud83d")).toBe(3);
    // A seeded walk over the code-unit space, surrogates and pairs included: it equals what an encoder writes.
    let seed = 20261004;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 400; round += 1) {
      let text = "";
      for (let i = 0; i < 40; i += 1) {
        const pick = next() % 5;
        text +=
          pick === 0
            ? String.fromCharCode(next() % 0x80)
            : pick === 1
              ? String.fromCharCode(0x80 + (next() % 0x780))
              : pick === 2
                ? String.fromCharCode(0x800 + (next() % 0xf800))
                : pick === 3
                  ? String.fromCodePoint(0x10000 + (next() % 0x100000))
                  : String.fromCharCode(0xd800 + (next() % 0x800));
      }
      expect(utf8Length(text)).toBe(encoded(text));
    }
  });

  test("a draft is its command, its display patch and the allowance; `.length` is not the measure", () => {
    const command = { kind: "create", text: "界".repeat(1000) };
    const body = JSON.stringify(command);
    expect(body.length).toBeLessThan(encoded(body));
    expect(draftBytes(command, undefined)).toBe(
      DRAFT_ALLOWANCE_BYTES + encoded(body),
    );
    const patch = { r: { title: "界界界" } };
    expect(draftBytes(command, patch)).toBe(
      DRAFT_ALLOWANCE_BYTES + encoded(body) + encoded(JSON.stringify(patch)),
    );
  });

  test("the estimate is the larger of what the request builds from no bases and from the widest version, and never below the allowance", async () => {
    const withBase = builder("needs-base", NEW, "x".repeat(10_000));
    const widest = withBase.build({ [TARGET]: Number.MAX_SAFE_INTEGER });
    const widestBytes = draftBytes(
      widest.command,
      widest.displayPatch,
    ) as number;
    // ADAPTED (revision 13): revision 12 asserted `estimate === widestBytes` (the command alone). The estimate now bounds the WHOLE write:
    // never below the command's share at the widest version, never below what the transaction stores for the same request, and no more
    // than a small stated slack above it (the dependencies and the identity are the widest a real one could be).
    const estimate = estimateDraftBytes(withBase);
    expect(estimate).toBeGreaterThan(widestBytes);
    const stored = await written(withBase);
    expect(estimate).toBeGreaterThanOrEqual(stored);
    expect(estimate - stored).toBeLessThan(2048);
    // A request that builds from neither set is a floor, not a claim that the write is small.
    expect(estimateDraftBytes(builder("throws-for-probes", NEW))).toBe(
      DRAFT_ALLOWANCE_BYTES,
    );
    expect(
      estimateDraftBytes(builder("throws-without-bases", NEW)),
    ).toBeGreaterThan(DRAFT_ALLOWANCE_BYTES + ASCII_BYTES - 1);
  });
});
