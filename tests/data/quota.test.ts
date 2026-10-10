// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import {
  createWriteFailureMarkers,
  DIRECTORY_PREFIX,
  MARKER_PREFIX,
  type MarkerStorage,
} from "../../src/data/engine/write-failure-marker";
import { DATA_CONFIG } from "../../src/data/model/config";
import { decideQuota, freeBytes } from "../../src/data/model/quota";

import { scopeOf } from "../support/data/marker-storage";

const MIB = 1024 * 1024;
const RESERVE = DATA_CONFIG.quotaReserveBytes;

describe("F-Q1: the quota reserve policy", () => {
  test("cache pages are refused before user input; user input is the LAST refusal", () => {
    // Between half the reserve and the reserve plus a page: cache refuses, input still goes through.
    const free = RESERVE + 100 - 1;
    expect(decideQuota(free, "cache", 100)).toBe("refuse");
    expect(decideQuota(free, "input", 100)).toBe("ok");
    expect(decideQuota(RESERVE / 2 - 1, "input", 0)).toBe("refuse");
    expect(decideQuota(RESERVE / 2, "input", 0)).toBe("ok");
    expect(decideQuota(RESERVE + 100, "cache", 100)).toBe("ok");
  });
  test("an estimate that is missing or unreadable is `unknown`, never a refusal: the engine relies on actual failures", () => {
    expect(decideQuota(null, "cache", 1)).toBe("unknown");
    expect(decideQuota(null, "input", 1)).toBe("unknown");
    expect(freeBytes({})).toBeNull();
    expect(freeBytes({ usage: 1 })).toBeNull();
    expect(freeBytes({ usage: Number.NaN, quota: 5 })).toBeNull();
    expect(freeBytes({ usage: 10 * MIB, quota: 4 * MIB })).toBe(0);
    expect(freeBytes({ usage: 1 * MIB, quota: 4 * MIB })).toBe(3 * MIB);
  });
});

describe("QuotaGuard", () => {
  test("caches the estimate for its TTL and refreshes afterwards or on invalidate", async () => {
    let now = 0;
    let calls = 0;
    const guard = createQuotaGuard({
      storage: {
        estimate: async () => {
          calls += 1;
          return { usage: 0, quota: 100 * MIB + calls };
        },
      },
      now: () => now,
    });
    expect(await guard.check("cache")).toBe("ok");
    expect(await guard.check("cache")).toBe("ok");
    expect(calls).toBe(1);
    now += DATA_CONFIG.quotaEstimateTtlMs;
    await guard.check("cache");
    expect(calls).toBe(2);
    guard.invalidate();
    await guard.check("cache");
    expect(calls).toBe(3);
  });
  test("missing or throwing estimate() reports unknown", async () => {
    expect(
      await createQuotaGuard({ storage: undefined, now: () => 0 }).check(
        "cache",
      ),
    ).toBe("unknown");
    expect(
      await createQuotaGuard({ storage: {}, now: () => 0 }).check("cache"),
    ).toBe("unknown");
    expect(
      await createQuotaGuard({
        storage: {
          estimate: async () => {
            throw new Error("blocked");
          },
        },
        now: () => 0,
      }).check("input"),
    ).toBe("unknown");
  });
  test("a low estimate refuses the cache first (the injected figure is named: the engine's own quota is not exercised)", async () => {
    const guard = createQuotaGuard({
      storage: {
        estimate: async () => ({
          usage: 100 * MIB - 6 * MIB,
          quota: 100 * MIB,
        }),
      },
      now: () => 0,
    });
    expect(await guard.check("cache", 1 * MIB)).toBe("refuse");
    expect(await guard.check("input", 1 * MIB)).toBe("ok");
  });
});

describe("the write-failure marker (decision D-14)", () => {
  const memory = (): MarkerStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return {
      data,
      get length() {
        return data.size;
      },
      key: (index) => [...data.keys()][index] ?? null,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };
  };
  test("scoped by account and operation; holds no content", () => {
    const storage = memory();
    const markers = createWriteFailureMarkers(storage, undefined, {
      ownSlot: 0,
    });
    expect(markers.set(scopeOf("acct-1"), "page:cursor").state).toBe(
      "recorded",
    );
    expect(markers.set(scopeOf("acct-2"), "page:cursor").state).toBe(
      "recorded",
    );
    // ADAPTED, revision 33: a marker's key names its failure and the database lifetime it belongs to
    // (`<account>:<incarnation>:<operation>#<random>.<count>`), the value is the fixed `1`, still no content, and every failure that
    // records one writes a new key (see `marker-instances.test.ts`). The page's directory lists the same names and nothing else.
    const entries = [...storage.data.entries()]
      .filter(([key]) => key.startsWith(MARKER_PREFIX))
      .sort();
    expect(entries.map(([key]) => key.replace(/#.*$/, ""))).toEqual([
      `${MARKER_PREFIX}acct-1:incarnation-1:page:cursor`,
      `${MARKER_PREFIX}acct-2:incarnation-1:page:cursor`,
    ]);
    for (const [key, value] of entries) {
      expect(key).toMatch(/#[a-z0-9-]+\.\d+$/);
      expect(value).toBe("1");
    }
    expect(entries[0]?.[0]).not.toBe(entries[1]?.[0]);
    const directories = [...storage.data.entries()].filter(([key]) =>
      key.startsWith(DIRECTORY_PREFIX),
    );
    expect(directories).toHaveLength(2);
    for (const [, value] of directories)
      for (const [operation, instance] of (
        JSON.parse(value) as { e: Array<[string, string]> }
      ).e) {
        expect(operation).toBe("page:cursor");
        expect(instance).toMatch(/^[a-z0-9-]+\.\d+$/);
      }
    expect(markers.has(scopeOf("acct-1"), "page:cursor")).toBe(true);
    expect(markers.operations(scopeOf("acct-1"))).toEqual(["page:cursor"]);
    markers.clear(scopeOf("acct-1"), "page:cursor");
    expect(markers.has(scopeOf("acct-1"), "page:cursor")).toBe(false);
    expect(markers.has(scopeOf("acct-2"), "page:cursor")).toBe(true);
  });
  test("deleting an account's database removes its markers and only its markers", () => {
    const storage = memory();
    storage.setItem("unrelated", "keep");
    const markers = createWriteFailureMarkers(storage, undefined, {
      ownSlot: 0,
    });
    markers.set(scopeOf("acct-1"), "a");
    markers.set(scopeOf("acct-1"), "b");
    markers.set(scopeOf("acct-2"), "a");
    markers.clearAccount("acct-1");
    expect(markers.operations(scopeOf("acct-1"))).toEqual([]);
    expect(markers.operations(scopeOf("acct-2"))).toEqual(["a"]);
    expect(storage.getItem("unrelated")).toBe("keep");
  });
  test("an unavailable or throwing storage degrades: set reports false and nothing throws", () => {
    expect(
      createWriteFailureMarkers(undefined).set(scopeOf("a"), "b").state,
    ).toBe("unavailable");
    const throwing: MarkerStorage = {
      get length(): number {
        throw new Error("blocked");
      },
      key: () => {
        throw new Error("blocked");
      },
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const markers = createWriteFailureMarkers(throwing, undefined, {
      ownSlot: 0,
    });
    expect(markers.set(scopeOf("a"), "b").state).toBe("unavailable");
    expect(markers.has(scopeOf("a"), "b")).toBe(false);
    expect(markers.operations(scopeOf("a"))).toEqual([]);
    expect(() => markers.clear(scopeOf("a"), "b")).not.toThrow();
    expect(() => markers.clearAccount("a")).not.toThrow();
  });
});
