import { describe, expect, test } from "vitest";
import {
  applyOverlay,
  emptyOverlay,
  foldEffect,
  mergeResource,
} from "../../src/data/model/overlay";
import type {
  CacheRow,
  PendingEffectRow,
  ProjectionPatch,
} from "../../src/data/model/types";
import { cacheRow, effectRow } from "../support/data/rows";

/**
 * R14: what a LIST shows of a resource is the fold of its outstanding changes, read a window at a time and dropped, and it must be
 * exactly what the sequential merge shows: for every population of changes, in whatever order the windows deliver them.
 * Whole-population `mergeResource` is the specification.
 */
const foldAll = (base: CacheRow, effects: readonly PendingEffectRow[]) => {
  const overlay = emptyOverlay();
  for (const effect of effects) foldEffect(overlay, effect);
  return { merged: applyOverlay(base, overlay), pending: overlay.pending };
};

/** A small deterministic generator, so a failing population can be replayed from its seed. */
function generator(seed: number) {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  return {
    int: (n: number): number => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T =>
      items[Math.floor(next() * items.length)] as T,
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
}

function population(seed: number): PendingEffectRow[] {
  const g = generator(seed);
  const count = g.int(40);
  const effects: PendingEffectRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const patch: ProjectionPatch = {};
    if (g.int(3) === 0) patch.label = `label-${g.int(5)}`;
    if (g.int(4) === 0) patch.archived = g.int(2) === 0;
    if (g.int(2) === 0) {
      patch.value = {};
      for (let k = g.int(4); k > 0; k -= 1)
        patch.value[g.pick(["a", "b", "c", "d", "e"])] = g.int(9);
    }
    effects.push(
      effectRow({
        resource_id: "r",
        // Few distinct instants and few distinct ids: ties on `created_at` are decided by `local_id`, and so are ties on both.
        local_id: `L${String(g.int(30)).padStart(3, "0")}-${i}`,
        created_at: `2026-10-01T09:00:0${g.int(4)}.000Z`,
        display: g.int(5) === 0 ? null : patch,
      }),
    );
  }
  return effects;
}

describe("the fold of a list's overlay equals the sequential merge", () => {
  const base = cacheRow({
    id: "r",
    label: "Base",
    value: { a: 0, z: 26 },
    archived: false,
  });

  test("over 400 random populations, in the order the index returns them and in any other order", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const effects = population(seed);
      const expected = mergeResource(base, effects).merged;
      const ordered = [...effects].sort((a, b) =>
        a.local_id < b.local_id ? -1 : a.local_id > b.local_id ? 1 : 0,
      );
      const shuffled = generator(seed + 1000).shuffle(effects);
      for (const [name, delivered] of [
        ["primary-key order", ordered],
        ["shuffled", shuffled],
        ["reversed", [...ordered].reverse()],
      ] as const) {
        const folded = foldAll(base, delivered);
        expect(folded.merged, `seed ${seed}, ${name}`).toEqual(expected);
        expect(folded.pending, `seed ${seed}, ${name}`).toBe(effects.length);
      }
    }
  });

  test("a population cut into windows of any size folds to the same state as one read", () => {
    for (const size of [1, 2, 3, 7, 100]) {
      for (let seed = 1; seed <= 60; seed += 1) {
        const effects = population(seed + 5000);
        const expected = mergeResource(base, effects).merged;
        const overlay = emptyOverlay();
        for (let at = 0; at < effects.length; at += size)
          for (const effect of effects.slice(at, at + size))
            foldEffect(overlay, effect);
        expect(
          applyOverlay(base, overlay),
          `size ${size} seed ${seed}`,
        ).toEqual(expected);
      }
    }
  });

  test("the state is bounded by the fields the patches name, never by how many patches there are", () => {
    const overlay = emptyOverlay();
    for (let i = 0; i < 20_000; i += 1)
      foldEffect(
        overlay,
        effectRow({
          resource_id: "r",
          local_id: `L${String(i).padStart(6, "0")}`,
          created_at: "2026-10-01T09:00:00.000Z",
          display: { label: `edit ${i}`, value: { a: i, b: i } },
        }),
      );
    expect(overlay.pending).toBe(20_000);
    expect(overlay.value?.size).toBe(2);
    expect(applyOverlay(base, overlay).label).toBe("edit 19999");
    expect(applyOverlay(base, overlay).value).toEqual({
      a: 19_999,
      b: 19_999,
      z: 26,
    });
  });

  test("the specifics: the latest by created_at wins, a tie goes to the larger local_id, a field no change names falls through, the cached row is never edited", () => {
    const early = effectRow({
      resource_id: "r",
      local_id: "z-early-id",
      created_at: "2026-10-01T09:00:00.000Z",
      display: { label: "early", archived: true, value: { a: 1 } },
    });
    const late = effectRow({
      resource_id: "r",
      local_id: "a-late-instant",
      created_at: "2026-10-01T09:00:05.000Z",
      display: { label: "late" },
    });
    const tieLow = effectRow({
      resource_id: "r",
      local_id: "tie-1",
      created_at: "2026-10-01T09:00:07.000Z",
      display: { value: { b: "low" } },
    });
    const tieHigh = effectRow({
      resource_id: "r",
      local_id: "tie-2",
      created_at: "2026-10-01T09:00:07.000Z",
      display: { value: { b: "high" } },
    });
    const none = effectRow({
      resource_id: "r",
      local_id: "no-display",
      display: null,
    });
    const frozen = JSON.stringify(base);
    for (const delivered of [
      [early, late, tieLow, tieHigh, none],
      [none, tieHigh, tieLow, late, early],
    ]) {
      const folded = foldAll(base, delivered);
      expect(folded.merged.label).toBe("late");
      expect(folded.merged.archived).toBe(true);
      expect(folded.merged.value).toEqual({ a: 1, b: "high", z: 26 });
      expect(folded.pending).toBe(5);
    }
    expect(JSON.stringify(base)).toBe(frozen);
    // No change with a display patch leaves the row exactly as cached (the same object), but is still counted.
    const only = foldAll(base, [none]);
    expect(only.merged).toBe(base);
    expect(only.pending).toBe(1);
    // Nothing at all.
    expect(foldAll(base, []).merged).toBe(base);
  });

  test("a cached row with no value takes the patched keys, as the sequential merge gives it", () => {
    const bare = cacheRow({ id: "r", value: null });
    const effects = [
      effectRow({
        resource_id: "r",
        local_id: "a",
        display: { value: { k: 1 } },
      }),
    ];
    expect(foldAll(bare, effects).merged).toEqual(
      mergeResource(bare, effects).merged,
    );
  });
});
