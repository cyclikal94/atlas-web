// @vitest-environment node
import { describe, expect, test } from "vitest";
import { PURGE_GRACE_MS, precacheCacheName } from "../../src/sw/core";
import {
  handleReport,
  type LifecycleDeps,
  onActivated,
  recordInstalled,
  retentionPass,
} from "../../src/sw/lifecycle";
import { type CacheLike, createSwState } from "../../src/sw/state";

/**
 * WEB-14a D-P3: the worker's records and retention over a double of Cache Storage. A report is acknowledged only after its record is
 * written; a lost write leaves the client unacknowledged (every generation kept); the active generation is never purged; closed clients'
 * records are forgotten. FIXTURE evidence: the real worker in three engines is P-R1 (`fixture.pwa-retention.spec.ts`).
 */
const ORIGIN = "https://atlas.example";

class FakeCache implements CacheLike {
  readonly entries = new Map<string, string>();
  /** Makes the next `put` hang until released (a worker stopped before its write landed). */
  holdPuts = false;
  private held: Array<() => void> = [];
  async put(request: string, response: Response) {
    const text = await response.text();
    if (this.holdPuts)
      await new Promise<void>((resolve) => this.held.push(resolve));
    this.entries.set(request, text);
  }
  release() {
    for (const resolve of this.held.splice(0)) resolve();
  }
  async match(request: string) {
    const text = this.entries.get(request);
    return text === undefined ? undefined : new Response(text);
  }
  async delete(request: string) {
    return this.entries.delete(request);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
}
class FakeCaches {
  readonly caches = new Map<string, FakeCache>();
  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }
}

function world(own: string, paths: string[]) {
  const caches = new FakeCaches();
  let now = 1_000_000;
  let windows: Array<{ id: string }> = [];
  const deps: LifecycleDeps = {
    own: { generation: own, paths },
    state: createSwState(caches, ORIGIN),
    caches: {
      keys: async () => [...caches.caches.keys()],
      delete: async (name) => caches.caches.delete(name),
    },
    windows: async () => windows,
    now: () => now,
  };
  return {
    caches,
    deps,
    as: (generation: string, generationPaths: string[]): LifecycleDeps => ({
      ...deps,
      own: { generation, paths: generationPaths },
    }),
    setWindows: (next: Array<{ id: string }>) => {
      windows = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
    install: async (d: LifecycleDeps) => {
      await caches.open(precacheCacheName(d.own.generation));
      await recordInstalled(d);
    },
    precaches: () =>
      [...caches.caches.keys()].filter((name) =>
        name.startsWith("atlas-precache-"),
      ),
  };
}

const A = ["/index.html", "/assets/a.js"];
const B = ["/index.html", "/assets/b.js"];
const C = ["/index.html", "/assets/c.js"];

describe("reports", () => {
  test("the record is written before the answer, and names the page's generation", async () => {
    const w = world("A", A);
    await w.install(w.deps);
    const ack = await handleReport(w.deps, "client-1", "/assets/a.js", "n1");
    expect(ack).toEqual({
      type: "atlas:report-ack",
      nonce: "n1",
      generation: "A",
      active: "A",
      newer: false,
    });
    expect((await w.deps.state.clients()).get("client-1")?.generations).toEqual(
      ["A"],
    );
  });

  test("no answer before the record has landed (a worker stopped mid-write never acknowledges)", async () => {
    const w = world("A", A);
    await w.install(w.deps);
    const state = await w.caches.open("atlas-sw-state");
    state.holdPuts = true;
    let answered = false;
    const pending = handleReport(w.deps, "client-1", "/assets/a.js", "n1").then(
      () => {
        answered = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answered).toBe(false);
    state.release();
    await pending;
    expect(answered).toBe(true);
  });

  test("an unknown entry is answered null and records nothing", async () => {
    const w = world("A", A);
    await w.install(w.deps);
    const ack = await handleReport(w.deps, "client-1", "/assets/zzz.js", "n1");
    expect(ack.generation).toBeNull();
    expect((await w.deps.state.clients()).size).toBe(0);
  });

  test("a page on an older generation is told the active one is newer", async () => {
    const w = world("A", A);
    await w.install(w.deps);
    w.advance(1000);
    const b = w.as("B", B);
    await w.install(b);
    await onActivated(b);
    const ack = await handleReport(b, "client-1", "/assets/a.js", "n2");
    expect(ack).toMatchObject({ generation: "A", active: "B", newer: true });
  });
});

describe("retention", () => {
  test("WEB-04 8: an open page on A keeps A through B and C; when it closes, A and B go; the active one never does", async () => {
    const w = world("A", A);
    await w.install(w.deps);
    w.setWindows([{ id: "tab-1" }]);
    await handleReport(w.deps, "tab-1", "/assets/a.js", "n");
    const b = w.as("B", B);
    w.advance(1000);
    await w.install(b);
    await onActivated(b);
    const c = w.as("C", C);
    w.advance(1000);
    await w.install(c);
    w.setWindows([{ id: "tab-1" }, { id: "tab-2" }]);
    await onActivated(c);
    // tab-2 is loading C and has not reported: every generation is kept.
    expect(w.precaches().length).toBe(3);
    await handleReport(c, "tab-2", "/assets/c.js", "n");
    w.advance(PURGE_GRACE_MS);
    await retentionPass(c);
    // tab-1 still runs A: A is kept, B (nobody runs it) goes.
    expect(w.precaches().sort()).toEqual(
      [precacheCacheName("A"), precacheCacheName("C")].sort(),
    );
    // tab-1 closes.
    w.setWindows([{ id: "tab-2" }]);
    await retentionPass(c);
    expect(w.precaches()).toEqual([precacheCacheName("C")]);
    expect([...(await c.state.clients()).keys()]).toEqual(["tab-2"]);
    expect((await c.state.generations()).map((r) => r.generation)).toEqual([
      "C",
    ]);
  });

  test("a generation retired within the grace is not purged even with no client naming it", async () => {
    const w = world("A", A);
    await w.install(w.deps);
    const b = w.as("B", B);
    await w.install(b);
    w.setWindows([]);
    await onActivated(b);
    expect(w.precaches().length).toBe(2);
    w.advance(PURGE_GRACE_MS);
    await retentionPass(b);
    expect(w.precaches()).toEqual([precacheCacheName("B")]);
  });

  test("a waiting generation (installed, not active) is never purged by the active worker", async () => {
    const w = world("A", A);
    await w.install(w.deps);
    await onActivated(w.deps);
    const b = w.as("B", B);
    await w.install(b);
    w.advance(PURGE_GRACE_MS * 10);
    w.setWindows([{ id: "tab-1" }]);
    await handleReport(w.deps, "tab-1", "/assets/a.js", "n");
    await retentionPass(w.deps);
    expect(w.precaches().length).toBe(2);
  });
});
