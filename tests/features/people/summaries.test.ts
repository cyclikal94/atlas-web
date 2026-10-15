import { afterEach, describe, expect, test } from "vitest";
import type { PeopleResult } from "../../../src/features/people/api";
import type { PeopleEnv } from "../../../src/features/people/env";
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import type { SummaryPage } from "../../../src/features/people/model/summary";
import { sendOnline, sentSomething } from "../../../src/features/people/online";
import {
  admitSummary,
  readSummary,
  type WalkOutcome,
  walkPages,
} from "../../../src/features/people/summaries";

/**
 * The summaries' READ rules (finding 8; backend `docs/people.md` "Consistency and freshness"): bounded walks, supersession by an
 * invalidation, restart of a traversal mixed across snapshots, the `preferences_version` and row-version monotonicity, and identity.
 */
interface Item {
  id: string;
  version: number;
  policy_version: number;
  label: string;
}
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n: number, over: Partial<Item> = {}): Item => ({
  id: id(n),
  version: 1,
  policy_version: 1,
  label: `P${n}`,
  ...over,
});
const page = (
  items: Item[],
  next: string | null,
  preferences = 1,
): PeopleResult<SummaryPage<Item>> => ({
  ok: true,
  value: {
    items,
    next_after: next,
    home: null,
    preferences_version: preferences,
  },
});

/** A server of `count` items, in pages of `size`, recording each `after` it was asked for. */
function server(count: number, size: number, preferences = () => 1) {
  const asked: (string | null)[] = [];
  const all = Array.from({ length: count }, (_, i) => item(i + 1));
  return {
    asked,
    read: async (after: string | null) => {
      asked.push(after);
      const rest = all.filter((x) => after === null || x.id > after);
      const items = rest.slice(0, size);
      return page(
        items,
        items.length === size ? (items.at(-1)?.id ?? null) : null,
        preferences(),
      );
    },
  };
}
const always = () => true;

afterEach(() => forgetAllPeopleMemory());

describe("a bounded walk", () => {
  test("keeps at most `limit`, reads at most `pages`, and says where the next step begins", async () => {
    const s = server(1000, 100);
    const kept = await walkPages(
      s.read,
      { start: null, keep: () => true, limit: 150, pages: 20 },
      always,
    );
    expect(kept.kind).toBe("ok");
    if (kept.kind !== "ok") return;
    expect(kept.value.kept).toHaveLength(150);
    expect(kept.value.next).toBe(id(150));
    expect(kept.value.end).toBe(false);
    expect(s.asked).toEqual([null, id(100)]);
    const bounded = await walkPages(
      s.read,
      { start: null, keep: (x) => x.label === "P999", limit: 100, pages: 3 },
      always,
    );
    if (bounded.kind !== "ok") throw new Error("expected ok");
    expect(bounded.value.kept).toEqual([]);
    expect(bounded.value.next).toBe(id(300));
    expect(bounded.value.end).toBe(false);
  });

  test("reaches the end and says so; a join stops once it has covered what it needs", async () => {
    const s = server(250, 100);
    const all = await walkPages(
      s.read,
      { start: id(100), keep: () => true, limit: 1000, pages: 20 },
      always,
    );
    if (all.kind !== "ok") throw new Error("expected ok");
    expect(all.value.end).toBe(true);
    expect(all.value.kept).toHaveLength(150);
    const t = server(1000, 100);
    const joined = await walkPages(
      t.read,
      {
        start: null,
        keep: () => false,
        limit: 1,
        pages: 20,
        covered: (read) => read.has(id(150)),
      },
      always,
    );
    if (joined.kind !== "ok") throw new Error("expected ok");
    expect(t.asked).toEqual([null, id(100)]);
    expect(joined.value.read.get(id(150))?.label).toBe("P150");
  });

  test("pages from different snapshots restart the traversal; a superseded walk stops before its next page", async () => {
    let preferences = 1;
    const s = server(300, 100, () => preferences++);
    expect(
      (
        await walkPages(
          s.read,
          { start: null, keep: () => true, limit: 1000, pages: 20 },
          always,
        )
      ).kind,
    ).toBe("restart");
    const t = server(300, 100);
    let live = true;
    const read = async (after: string | null) => {
      const answer = await t.read(after);
      live = false;
      return answer;
    };
    expect(
      (
        await walkPages(
          read,
          { start: null, keep: () => true, limit: 1000, pages: 20 },
          () => live,
        )
      ).kind,
    ).toBe("superseded");
    expect(t.asked).toEqual([null]);
  });

  test("a refusal fails the walk: not_found is told apart", async () => {
    const outcome = await walkPages<Item>(
      async () => ({ ok: false, kind: "not_found" }),
      { start: null, keep: () => true, limit: 1, pages: 1 },
      always,
    );
    expect(outcome).toEqual({ kind: "failed", reason: "not_found" });
    expect(
      await walkPages<Item>(
        async () => ({ ok: false, kind: "uncertain" }),
        { start: null, keep: () => true, limit: 1, pages: 1 },
        always,
      ),
    ).toEqual({ kind: "failed", reason: "failed" });
  });
});

describe("monotonicity", () => {
  const ok = (
    preferencesVersion: number,
    rows: Item[] = [],
  ): Extract<WalkOutcome<unknown>, { kind: "ok" }> => ({
    kind: "ok",
    value: null,
    preferencesVersion,
    rows,
  });
  test("an older preferences_version is never applied; a newer one makes every other summary out of date", () => {
    const memory = peopleMemory("me:1");
    const entry = { generation: 0, state: { kind: "loading" as const } };
    memory.summaries.set("a", entry);
    memory.summaries.set("other", {
      generation: 0,
      state: { kind: "loading" },
    });
    expect(admitSummary(memory, ok(2), { key: "a", entry })).toBe("admitted");
    expect(memory.summaryGeneration).toBe(0);
    expect(admitSummary(memory, ok(1), { key: "a", entry })).toBe("stale");
    expect(admitSummary(memory, ok(3), { key: "a", entry })).toBe("admitted");
    // The others are superseded; this answer stays, under the new generation.
    expect(memory.summaryGeneration).toBe(1);
    expect([...memory.summaries.keys()]).toEqual(["a"]);
    expect(entry.generation).toBe(1);
  });

  test("a row is never replaced by one with a lower version or policy version", () => {
    const memory = peopleMemory("me:1");
    const entry = { generation: 0, state: { kind: "loading" as const } };
    expect(
      admitSummary(
        memory,
        ok(1, [item(1, { version: 3, policy_version: 2 })]),
        { key: "a", entry },
      ),
    ).toBe("admitted");
    expect(
      admitSummary(
        memory,
        ok(1, [item(1, { version: 2, policy_version: 2 })]),
        { key: "a", entry },
      ),
    ).toBe("stale");
    expect(
      admitSummary(
        memory,
        ok(1, [item(1, { version: 3, policy_version: 1 })]),
        { key: "a", entry },
      ),
    ).toBe("stale");
    expect(
      admitSummary(
        memory,
        ok(1, [item(1, { version: 4, policy_version: 2 })]),
        { key: "a", entry },
      ),
    ).toBe("admitted");
    expect(memory.summaryFloors.get(id(1))).toEqual({
      version: 4,
      policyVersion: 2,
    });
  });
});

describe("reading a summary into page memory", () => {
  const envOf = (identity = "me:1", online = true): PeopleEnv =>
    ({
      memory: peopleMemory(identity),
      online,
      now: () => 1234,
    }) as unknown as PeopleEnv;
  const deferred = <T>() => {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("never twice for one query and generation; an answer after an invalidation is dropped and the newer read applies", async () => {
    const env = envOf();
    const first = deferred<PeopleResult<SummaryPage<Item>>>();
    const second = deferred<PeopleResult<SummaryPage<Item>>>();
    const answers = [first.promise, second.promise];
    let reads = 0;
    const walk = (current: () => boolean) =>
      walkPages(
        () => {
          reads += 1;
          return answers.shift() as Promise<PeopleResult<SummaryPage<Item>>>;
        },
        { start: null, keep: () => true, limit: 10, pages: 1 },
        current,
      );
    readSummary(env, "q", walk);
    readSummary(env, "q", walk);
    expect(reads).toBe(1);
    env.memory.invalidateSummaries();
    readSummary(env, "q", walk);
    expect(reads).toBe(2);
    second.resolve(page([item(2)], null));
    await flush();
    first.resolve(page([item(1)], null));
    await flush();
    const state = env.memory.summaries.get("q")?.state;
    expect(state?.kind).toBe("ready");
    expect(
      (state as { value: { kept: Item[] } }).value.kept.map((x) => x.label),
    ).toEqual(["P2"]);
  });

  test("an older snapshot is read again (bounded), then reported stale; a mixed traversal starts again from its first page", async () => {
    const env = envOf();
    const memory = env.memory;
    memory.summaryPreferences = 5;
    let reads = 0;
    readSummary(env, "old", (current) =>
      walkPages(
        async () => {
          reads += 1;
          return page([item(1)], null, 4);
        },
        { start: null, keep: () => true, limit: 10, pages: 1 },
        current,
      ),
    );
    await flush();
    expect(reads).toBe(3);
    expect(memory.summaries.get("old")?.state).toEqual({
      kind: "failed",
      reason: "stale",
    });
    // Pages 1 and 2 disagree once: the walk starts again from the first page and then agrees.
    const asked: (string | null)[] = [];
    const versions = [5, 6, 6, 6];
    readSummary(env, "mixed", (current) =>
      walkPages(
        async (after) => {
          asked.push(after);
          const preferences = versions.shift() ?? 6;
          return after === null
            ? page([item(1)], id(1), preferences)
            : page([item(2)], null, preferences);
        },
        { start: null, keep: () => true, limit: 10, pages: 5 },
        current,
      ),
    );
    await flush();
    expect(asked).toEqual([null, id(1), null, id(1)]);
    expect(memory.summaries.get("mixed")?.state.kind).toBe("ready");
  });

  test("offline, nothing is read; another identity's late answer writes into a memory nobody reads", async () => {
    const offline = envOf("me:1", false);
    let reads = 0;
    const walk = (current: () => boolean) =>
      walkPages(
        async () => {
          reads += 1;
          return page([item(1)], null);
        },
        { start: null, keep: () => true, limit: 10, pages: 1 },
        current,
      );
    readSummary(offline, "q", walk);
    expect(reads).toBe(0);
    const before = envOf("me:1");
    const late = deferred<PeopleResult<SummaryPage<Item>>>();
    readSummary(before, "q", (current) =>
      walkPages(
        () => late.promise,
        { start: null, keep: () => true, limit: 10, pages: 1 },
        current,
      ),
    );
    const after = envOf("me:2");
    late.resolve(page([item(1)], null));
    await flush();
    expect(after.memory.summaries.size).toBe(0);
    expect(after.memory.summaryFloors.size).toBe(0);
    expect(before.memory.summaries.get("q")?.state.kind).toBe("loading");
  });
});

describe("a command's receipt invalidates the summaries", () => {
  test("every online command that may have reached the server reads the summaries again; one that never left does not", async () => {
    const memory = peopleMemory("me:1");
    const env = { memory, newId: () => "k1" } as unknown as PeopleEnv;
    const results: PeopleResult<unknown>[] = [
      { ok: true, value: {} },
      { ok: false, kind: "uncertain" },
      { ok: false, kind: "conflict" },
      { ok: false, kind: "offline" },
      { ok: false, kind: "closed" },
    ];
    const generations: number[] = [];
    for (const result of results) {
      await sendOnline(
        env,
        "t",
        { a: 1 },
        async () => result,
        async () => {},
      );
      generations.push(memory.summaryGeneration);
    }
    expect(generations).toEqual([1, 2, 3, 3, 3]);
    expect(sentSomething({ ok: false, kind: "not_sent" })).toBe(false);
    expect(sentSomething({ ok: false, kind: "forbidden" })).toBe(true);
  });
});
