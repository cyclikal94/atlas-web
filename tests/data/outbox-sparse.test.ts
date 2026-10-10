// @vitest-environment node
import { describe, expect, test } from "vitest";
import { digestOf } from "../../src/data/model/canonical";
import { digestOfMembers, population } from "../../src/data/model/local-work";
import { type EnqueueRequest, wireBody } from "../../src/data/model/outbox";
import type { DraftRow, JsonObject } from "../../src/data/model/types";
import { outboxWorld } from "../support/data/outbox-world";

/**
 * R40 (revision 22): a sparse array has ONE policy at the public boundary, which is refusal, and a genuine retry is still recognised.
 *
 * `canonicalJson` mapped over the members of an array and so skipped its holes: `new Array(1)` had the digest of `[]`, `JSON.stringify`
 * says `[null]`, a stored clone keeps the hole, and the body the dispatcher builds (`wireBody`, the canonical form again) said `[]` or, for
 * two holes, `[,]`, which is not JSON. The review's schedule through the real adapter: supersede a conflict with the empty-list command,
 * then repeat the supersession under the same local id with a one-hole command, and the second, DIFFERENT command answered `superseded`
 * as the previous save; a direct enqueue stored a command whose digest was not that of any of its readings.
 *
 * The consumers are checked as well as the supersession: an in-place EDIT (a queued command replaced by another that has the same digest
 * would leave the consent digest of the account's local work unchanged, and the logout dialog's "something changed since you
 * agreed" could not fire), and the body sent on the wire.
 */
const OLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FRESH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type World = Awaited<ReturnType<typeof outboxWorld>>;
const save = (id: string, command: unknown): EnqueueRequest => ({
  localId: id,
  endpoint: "/commands",
  targets: [],
  build: () => ({ command: command as JsonObject }),
});
async function conflicted(): Promise<World> {
  const world = await outboxWorld();
  expect((await world.outbox.enqueue(save(OLD, { kind: "prior" }))).kind).toBe(
    "queued",
  );
  world.put("drafts", [{ ...world.drafts()[0], status: "version_conflict" }]);
  return world;
}
const consentDigest = (world: World): string =>
  digestOfMembers(population(world.drafts(), []));

/* biome-ignore-start lint/suspicious/noSparseArray: the shapes under test */
const SPARSE: Array<[string, () => unknown]> = [
  ["one hole, the whole list", () => ({ kind: "create", items: new Array(1) })],
  ["a leading hole", () => ({ kind: "create", items: [, "a"] })],
  ["a trailing hole", () => ({ kind: "create", items: ["a", ,] })],
  ["a hole in the middle", () => ({ kind: "create", items: ["a", , "b"] })],
  [
    "several holes (this canonicalised to `[,]`)",
    () => ({ kind: "create", items: new Array(3) }),
  ],
  ["holes in a nested list", () => ({ kind: "create", items: [["a", , "b"]] })],
  [
    "a hole inside an object inside a list",
    () => ({ kind: "create", items: [{ inner: [, 1] }] }),
  ],
  [
    "a hole in the command's own commands group",
    () => ({ commands: [{ kind: "x" }, ,] }),
  ],
];
/* biome-ignore-end lint/suspicious/noSparseArray: the shapes under test */

describe("R40: the reviewer's schedule, on every engine-independent path (supersede under one local id)", () => {
  for (const [name, make] of SPARSE)
    test(`${name}: the second, different command under the same id is NOT the previous save`, async () => {
      const world = await conflicted();
      // the first save: the empty-list command
      const first = await world.outbox.supersede(
        OLD,
        save(FRESH, { kind: "create", items: [] }),
      );
      expect(first.kind).toBe("superseded");
      const before = JSON.stringify(world.snapshot());
      // the same id, a different command (a sparse one): not recognised as that save, and nothing is written
      const second = await world.outbox.supersede(OLD, save(FRESH, make()));
      expect(second.kind).not.toBe("superseded");
      expect(second).toEqual({ kind: "refused", reason: "not_found" });
      expect(JSON.stringify(world.snapshot())).toBe(before);
    });

  test("controls: the genuine same save is recognised, a dense `[null]` is a different save, and neither writes", async () => {
    const same = await conflicted();
    await same.outbox.supersede(
      OLD,
      save(FRESH, { kind: "create", items: [] }),
    );
    const written = JSON.stringify(same.snapshot());
    const again = await same.outbox.supersede(
      OLD,
      save(FRESH, { kind: "create", items: [] }),
    );
    expect(again.kind).toBe("superseded");
    expect(JSON.stringify(same.snapshot())).toBe(written);

    const dense = await conflicted();
    await dense.outbox.supersede(
      OLD,
      save(FRESH, { kind: "create", items: [] }),
    );
    const different = await dense.outbox.supersede(
      OLD,
      save(FRESH, { kind: "create", items: [null] }),
    );
    expect(different).toEqual({ kind: "refused", reason: "not_found" });
  });
});

describe("R40: no path stores a command whose digest does not describe it", () => {
  for (const [name, make] of SPARSE) {
    test(`${name}: enqueue is refused as not JSON, loudly, and stores nothing`, async () => {
      const world = await outboxWorld();
      const before = JSON.stringify(world.snapshot());
      await expect(world.outbox.enqueue(save(FRESH, make()))).rejects.toThrow(
        TypeError,
      );
      expect(JSON.stringify(world.snapshot())).toBe(before);
      // the reservation was released: an ordinary save is admitted and written afterwards
      expect(
        (await world.outbox.enqueue(save(FRESH, { kind: "create", items: [] })))
          .kind,
      ).toBe("queued");
    });

    test(`${name}: an edit is refused, and the queued draft, its body and the consent digest are untouched`, async () => {
      const world = await outboxWorld();
      await world.outbox.enqueue(save(OLD, { kind: "create", items: [] }));
      const before = JSON.stringify(world.snapshot());
      const digest = consentDigest(world);
      await expect(
        world.outbox.editQueued(OLD, save(OLD, make())),
      ).rejects.toThrow(TypeError);
      expect(JSON.stringify(world.snapshot())).toBe(before);
      expect(consentDigest(world)).toBe(digest);
    });

    test(`${name}: a first supersession is refused, and the conflicted draft is untouched`, async () => {
      const world = await conflicted();
      const before = JSON.stringify(world.snapshot());
      await expect(
        world.outbox.supersede(OLD, save(FRESH, make())),
      ).rejects.toThrow(TypeError);
      expect(JSON.stringify(world.snapshot())).toBe(before);
      expect(world.drafts().map((row) => row.status)).toEqual([
        "version_conflict",
      ]);
    });
  }

  test("the consent digest follows the command: an edit from `[]` to `[null]` changes it, an edit to a hole is refused and cannot leave it equal", async () => {
    const world = await outboxWorld();
    await world.outbox.enqueue(save(OLD, { kind: "create", items: [] }));
    const empty = consentDigest(world);
    expect(
      (
        await world.outbox.editQueued(
          OLD,
          save(OLD, { kind: "create", items: [null] }),
        )
      ).kind,
    ).toBe("edited");
    const dense = consentDigest(world);
    expect(dense).not.toBe(empty);
    // back to the empty list, then the hole: refused, so the digest is still the empty list's, and the command is too
    await world.outbox.editQueued(
      OLD,
      save(OLD, { kind: "create", items: [] }),
    );
    expect(consentDigest(world)).toBe(empty);
    await expect(
      world.outbox.editQueued(
        OLD,
        save(OLD, { kind: "create", items: new Array(1) }),
      ),
    ).rejects.toThrow(TypeError);
    expect(consentDigest(world)).toBe(empty);
    expect(world.commandOf(OLD)).toEqual({ kind: "create", items: [] });
  });
});

describe("R40: what is accepted is exactly what is sent", () => {
  const ACCEPTED: Array<[string, JsonObject]> = [
    ["an empty list", { kind: "create", items: [] }],
    ["a list with a null", { kind: "create", items: [null] }],
    [
      "a list with several members",
      { kind: "create", items: [1, "two", [3, [4]], { five: 5 }] },
    ],
    [
      "nested objects and lists",
      { kind: "update", a: { b: [{ c: [] }, { d: null }] } },
    ],
    ["a command group", { commands: [{ kind: "x", n: 1 }, { kind: "y" }] }],
    ["multi-byte text", { kind: "create", text: "naïve ☃ 😀 \u0000  " }],
    ["-0", { kind: "create", n: -0 }],
  ];
  for (const [name, command] of ACCEPTED)
    test(`${name}: the stored command, its digest and the body of the request agree`, async () => {
      const world = await outboxWorld();
      expect((await world.outbox.enqueue(save(FRESH, command))).kind).toBe(
        "queued",
      );
      const header = world.drafts()[0] as DraftRow;
      const stored = world.commandOf(FRESH) as JsonObject;
      // the digest is that of the JSON the command is on the wire...
      expect(header.command_digest).toBe(
        digestOf(JSON.parse(JSON.stringify(stored))),
      );
      // ...and the body that is sent is that same JSON (the canonical form of the stored command), valid JSON, equal to JSON.stringify's reading
      const body = wireBody({ command: stored });
      expect(JSON.parse(body)).toEqual(JSON.parse(JSON.stringify(stored)));
      expect(digestOf(JSON.parse(body))).toBe(header.command_digest);
    });

  test("a list with a named property keeps it in the store (what a clone keeps) while the digest and the body say what JSON says", async () => {
    const world = await outboxWorld();
    const items = Object.assign(["a"], { note: "kept in the store" });
    await world.outbox.enqueue(save(FRESH, { kind: "create", items }));
    const header = world.drafts()[0] as DraftRow;
    const stored = world.commandOf(FRESH) as {
      items: string[] & { note?: string };
    };
    expect(stored.items.note).toBe("kept in the store");
    expect(header.command_digest).toBe(
      digestOf({ kind: "create", items: ["a"] }),
    );
    expect(wireBody({ command: stored as unknown as JsonObject })).toBe(
      '{"items":["a"],"kind":"create"}',
    );
  });

  test("`undefined` in a command is still refused, as it was: it has no form", async () => {
    const world = await outboxWorld();
    await expect(
      world.outbox.enqueue(save(FRESH, { kind: "create", items: [undefined] })),
    ).rejects.toThrow(TypeError);
    await expect(
      world.outbox.enqueue(save(FRESH, { kind: "create", missing: undefined })),
    ).rejects.toThrow(TypeError);
  });
});
