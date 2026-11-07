import type { BrowserContext } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LedgerRead, RequestRecorder } from "../e2e/request-origin";
import type { LedgerEntry } from "../e2e/request-origin-judge";

/**
 * WEB-14a revision 44 (review r43 F-FRESH-2 incomplete_fix; design assessment Q1): the ASYNCHRONOUS recorder, driven through a fake
 * context's events, a fake server ledger whose replies can be deferred, and fake timers at the unchanged 5,000 ms bound. Each fault has a
 * healthy counterpart that differs only in the request reaching its end. These schedules (opening/closing cuts, carried work, final
 * windows, bounded ledger I/O, ownership) are the ones revision 43's pure tests could not reach.
 */
const ORIGIN = "http://127.0.0.1:4000";
const BOUND = 5_000;

type Listener = (value: unknown) => void;
class FakeContext {
  readonly listeners = new Map<string, Listener[]>();
  readonly open: object[] = [];
  pages() {
    return this.open;
  }
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, value: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  newPage() {
    const page = {};
    this.open.push(page);
    this.emit("page", page);
    return page;
  }
}

class FakeServer {
  readonly entries: LedgerEntry[] = [];
  /** When set, the next ledger reads wait for `release()` (or never answer). */
  hold = false;
  private held: Array<() => void> = [];
  reads = 0;
  failWith: Error | null = null;
  malformed = false;
  /** Called while a read is in flight, before it answers (an event during the control round trip). */
  during: (() => void) | null = null;
  receive(method: string, path: string, status = 200) {
    const entry: LedgerEntry = {
      id: this.entries.length + 1,
      method,
      path,
      at: 0,
      status,
      end: null,
    };
    this.entries.push(entry);
    return entry;
  }
  release() {
    for (const go of this.held.splice(0)) go();
  }
  readonly read: LedgerRead = (after, signal) => {
    this.reads += 1;
    const answer = () => {
      const during = this.during;
      this.during = null;
      during?.();
      if (this.failWith) throw this.failWith;
      if (this.malformed) return { high: "x", entries: null } as never;
      return {
        high: this.entries.length,
        entries: this.entries
          .filter((entry) => entry.id > after)
          .map((entry) => ({ ...entry })),
      };
    };
    if (!this.hold) return Promise.resolve().then(answer);
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      this.held.push(() => {
        try {
          resolve(answer());
        } catch (error) {
          reject(error);
        }
      });
    });
  };
}

/** One browser request through the fake context: admit, then optionally headers / finish / fail, and its server receipt. */
class Flow {
  private readonly request: object;
  entry: LedgerEntry | null = null;
  constructor(
    private readonly world: World,
    readonly path: string,
    readonly options: {
      page?: object;
      worker?: boolean;
      unknown?: boolean;
      navigation?: boolean;
      method?: string;
    } = {},
  ) {
    const url = `${ORIGIN}${path}`;
    const method = options.method ?? "GET";
    this.request = {
      url: () => url,
      method: () => method,
      serviceWorker: () => (options.worker ? {} : null),
      frame: () => {
        if (options.worker || options.unknown)
          throw new Error(
            "Service Worker requests do not have an associated frame",
          );
        return { page: () => options.page };
      },
      isNavigationRequest: () => options.navigation ?? false,
      failure: () => ({ errorText: "net::ERR_ABORTED" }),
    };
    world.context.emit("request", this.request);
  }
  reach(status = 200) {
    this.entry = this.world.server.receive(
      this.options.method ?? "GET",
      this.path,
      status,
    );
    return this;
  }
  headers(options: { fromServiceWorker?: boolean; id?: string | null } = {}) {
    const id =
      options.id !== undefined
        ? options.id
        : this.entry
          ? String(this.entry.id)
          : null;
    this.world.context.emit("response", {
      request: () => this.request,
      status: () => this.entry?.status ?? 200,
      fromServiceWorker: () => options.fromServiceWorker ?? false,
      headers: () => (id === null ? {} : { "x-atlas-fixture-request": id }),
    });
    return this;
  }
  finish() {
    if (this.entry) this.entry.end = "finished";
    this.world.context.emit("requestfinished", this.request);
    return this;
  }
  fail() {
    if (this.entry && this.entry.end === null) this.entry.end = "closed";
    this.world.context.emit("requestfailed", this.request);
    return this;
  }
  /** The ordinary healthy request: server receipt, headers, end. */
  complete(status = 200) {
    return this.reach(status).headers().finish();
  }
}

class World {
  readonly context = new FakeContext();
  readonly server = new FakeServer();
  readonly recorder = new RequestRecorder(
    this.context as unknown as BrowserContext,
    ORIGIN,
    this.server.read,
  );
  readonly tab = this.context.newPage();
  flow(path: string, options: ConstructorParameters<typeof Flow>[2] = {}) {
    return new Flow(this, path, { page: this.tab, ...options });
  }
}

/** Runs `promise` to its end under fake timers, returning it and the fake time it took. */
async function settle<T>(promise: Promise<T>) {
  const began = Date.now();
  let value: T | undefined;
  let error: unknown;
  let done = false;
  promise.then(
    (result) => {
      value = result;
      done = true;
    },
    (failure) => {
      error = failure;
      done = true;
    },
  );
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(25);
  if (!done) throw new Error("did not settle within 10 s of fake time");
  if (error) throw error;
  return { value: value as T, took: Date.now() - began };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("request-origin recorder: the bounded end (review r43 native witness)", () => {
  it("an observed page request with no response and no server receipt fails at the 5,000 ms bound; its healthy counterpart passes at once", async () => {
    const world = new World();
    const start = await settle(world.recorder.open());
    world.flow("/health?review-control=1").complete();
    world.flow("/health?review-pending=1");
    const { value: closed, took } = await settle(
      world.recorder.close(start.value, { scope: "backend" }),
    );
    expect(took).toBeGreaterThanOrEqual(BOUND);
    expect(took).toBeLessThan(BOUND + 100);
    expect(closed.complete).toBe(false);
    expect(closed.endedBy).toBe("bound");
    expect(closed.pageBackend).toHaveLength(1);
    expect(closed.problems).toEqual([
      "page tab 1 GET /health?review-pending=1: no end yet (browser record 2, pending)",
      "incomplete: 1 obligation(s) still unresolved when the 5000 ms bound expired",
    ]);

    const healthy = new World();
    const begin = await settle(healthy.recorder.open());
    healthy.flow("/health?review-control=1").complete();
    healthy.flow("/health?review-pending=1").complete();
    const done = await settle(
      healthy.recorder.close(begin.value, { scope: "backend" }),
    );
    expect(done.took).toBeLessThan(100);
    expect(done.value.complete).toBe(true);
    expect(done.value.endedBy).toBe("stopped");
    expect(done.value.problems).toEqual([]);
    expect(done.value.pageBackend).toHaveLength(2);
  });

  it("just before, at and after the bound: a request ending at 4,900 ms passes; one never ending fails exactly at 5,000 ms", async () => {
    const world = new World();
    const start = await settle(world.recorder.open());
    const slow = world.flow("/api/experimental/v1/me").reach();
    const closing = world.recorder.close(start.value, { scope: "backend" });
    await vi.advanceTimersByTimeAsync(4_900);
    slow.headers().finish();
    const { value: closed } = await settle(closing);
    expect(closed.complete).toBe(true);
    expect(closed.problems).toEqual([]);
    expect(closed.elapsedMs).toBeLessThan(BOUND);

    const stuck = new World();
    const begin = await settle(stuck.recorder.open());
    stuck.flow("/api/experimental/v1/me").reach().headers();
    const pending = stuck.recorder.close(begin.value, { scope: "backend" });
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(BOUND - 1);
    expect(finished).toBe(false);
    const { value } = await settle(pending);
    expect(value.elapsedMs).toBeGreaterThanOrEqual(BOUND);
    expect(value.complete).toBe(false);
    expect(value.problems.join("\n")).toMatch(
      /the server has not finished it[\s\S]*headers 200 only[\s\S]*incomplete/,
    );
  });

  it("aborted with no receipt, failure after headers, and unknown origin with no receipt fail beside a healthy read", async () => {
    const faults: Array<[string, (world: World) => void, RegExp]> = [
      [
        "aborted, no server",
        (world) => world.flow("/api/experimental/v1/defaults/snapshot").fail(),
        /failed: net::ERR_ABORTED/,
      ],
      [
        "headers then failure",
        (world) =>
          world
            .flow("/api/experimental/v1/defaults/snapshot")
            .reach()
            .headers()
            .fail(),
        /failed after headers \(200\)/,
      ],
      [
        "unknown origin, pending",
        (world) =>
          world.flow("/api/experimental/v1/defaults/snapshot", {
            unknown: true,
          }),
        /unknown GET [^\n]*no end yet/,
      ],
      [
        "unknown origin, ended without receipt",
        (world) =>
          world
            .flow("/api/experimental/v1/defaults/snapshot", { unknown: true })
            .headers({ id: null })
            .finish(),
        /no page frame made it/,
      ],
      [
        "worker, pending",
        (world) =>
          world.flow("/api/experimental/v1/defaults/snapshot", {
            worker: true,
          }),
        /worker GET [^\n]*no end yet/,
      ],
    ];
    for (const [name, fault, reason] of faults) {
      const world = new World();
      const start = await settle(world.recorder.open());
      world.flow("/health").complete();
      fault(world);
      const { value } = await settle(
        world.recorder.close(start.value, { scope: "backend", final: true }),
      );
      expect(value.pageBackend, name).toHaveLength(1);
      expect(value.problems.join("\n"), name).toMatch(reason);
      expect(value.complete && value.problems.length === 0, name).toBe(false);
    }
  });
});

describe("request-origin recorder: cuts and ownership", () => {
  it("a request admitted DURING the opening ledger read is this window's, with its receipt below `from`", async () => {
    for (const ending of ["finish", "fail", "never"] as const) {
      const world = new World();
      world.flow("/health").complete();
      world.server.hold = true;
      const opening = world.recorder.open();
      await vi.advanceTimersByTimeAsync(1);
      // The browser admits a request, the server receives it, then the opening read answers (so it counts it in `from`).
      const racing = world.flow("/api/experimental/v1/me").reach();
      world.server.hold = false;
      world.server.release();
      const { value: start } = await settle(opening);
      expect(start.from).toBe(2);
      expect(start.seenFrom).toBe(1);
      if (ending === "finish") racing.headers().finish();
      if (ending === "fail") racing.headers().fail();
      const { value } = await settle(
        world.recorder.close(start, { scope: "backend", final: true }),
      );
      expect(value.owned, ending).toEqual([2]);
      // Once the browser has headers, the record names its receipt (at or below `from`), which is then judged here. Before headers it
      // cannot be joined yet; the record's own missing end fails the window instead.
      expect(value.receipts, ending).toEqual(ending === "never" ? [] : [2]);
      if (ending === "finish") {
        expect(value.problems).toEqual([]);
        expect(value.pageBackend.map((a) => a.entry.id)).toEqual([2]);
      } else expect(value.problems, ending).not.toEqual([]);
    }
  });

  it("work unfinished when a window opens is carried into it and must end there", async () => {
    const world = new World();
    const early = world.flow("/api/experimental/v1/daily?scope=joint").reach();
    const { value: start } = await settle(world.recorder.open());
    expect(start.carry).toEqual([1]);
    early.headers().finish();
    const { value } = await settle(
      world.recorder.close(start, { scope: "backend", final: true }),
    );
    expect(value.problems).toEqual([]);
    expect(value.receipts).toEqual([1]);

    const stuck = new World();
    stuck.flow("/api/experimental/v1/daily?scope=joint").reach();
    const { value: begin } = await settle(stuck.recorder.open());
    const { value: failed } = await settle(
      stuck.recorder.close(begin, { scope: "backend", final: true }),
    );
    expect(failed.complete).toBe(false);
    expect(failed.problems[0]).toBe(
      "page tab 1 GET /api/experimental/v1/daily?scope=joint: no end yet (browser record 1, pending)",
    );
  });

  it("a request admitted DURING a close's ledger read takes part in that close's decision", async () => {
    for (const ending of ["finish", "pending", "fail"] as const) {
      const world = new World();
      const { value: start } = await settle(world.recorder.open());
      world.flow("/health").complete();
      world.server.during = () => {
        const late = world.flow("/api/experimental/v1/me");
        if (ending === "finish") late.complete();
        if (ending === "fail") late.fail();
      };
      const { value, took } = await settle(
        world.recorder.close(start, { scope: "backend", final: true }),
      );
      expect(value.owned, ending).toEqual([1, 2]);
      if (ending === "finish") {
        expect(value.problems).toEqual([]);
        expect(took).toBeLessThan(100);
      } else if (ending === "pending") {
        expect(value.problems[0]).toMatch(/no end yet/);
        expect(took).toBeGreaterThanOrEqual(BOUND);
      } else {
        // Revision 45 (review r44 F-R44-Q1): an exact comparison, so an absent failure is a completed assertion, never a matcher
        // that throws on `undefined` before comparing.
        expect(value.problems, ending).toEqual([
          "page tab 1 GET /api/experimental/v1/me: failed: net::ERR_ABORTED (browser record 2)",
        ]);
      }
    }
  });

  it("two tabs reading one URL with reversed completions are two occurrences; a worker's third read of it fails", async () => {
    const world = new World();
    const other = world.context.newPage();
    const { value: start } = await settle(world.recorder.open());
    const first = world.flow("/api/experimental/v1/daily?scope=joint").reach();
    const second = world
      .flow("/api/experimental/v1/daily?scope=joint", { page: other })
      .reach();
    second.headers().finish();
    first.headers().finish();
    const { value } = await settle(
      world.recorder.close(start, { scope: "backend" }),
    );
    expect(value.problems).toEqual([]);
    expect(value.pageBackend.map((a) => a.seen[0]?.page)).toEqual([
      "tab 1",
      "tab 2",
    ]);
    // Next window: a worker's own read of the same URL (Chromium reports it; Firefox/WebKit leave it unobserved).
    world
      .flow("/api/experimental/v1/daily?scope=joint", { worker: true })
      .complete();
    world.server.receive("GET", "/api/experimental/v1/daily?scope=joint").end =
      "finished";
    const { value: next } = await settle(
      world.recorder.close(value.next as never, {
        scope: "backend",
        final: true,
      }),
    );
    expect(next.problems.join("\n")).toMatch(
      /#3 [^\n]*worker-origin[\s\S]*a worker's backend request[\s\S]*#4 [^\n]*unobserved[\s\S]*incomplete/,
    );
  });

  it("consecutive windows: nothing is lost between them, and an earlier verdict cannot be rewritten", async () => {
    const world = new World();
    const { value: start } = await settle(world.recorder.open());
    world.flow("/health").complete();
    const { value: first } = await settle(
      world.recorder.close(start, { scope: "backend" }),
    );
    expect(first.problems).toEqual([]);
    const next = first.next;
    expect(next).not.toBeNull();
    // Between the two closes a worker-only receipt arrives (no browser event in Firefox/WebKit), then a page read.
    const own = world.server.receive("GET", "/api/experimental/v1/sessions");
    own.end = "finished";
    world.flow("/api/experimental/v1/me").complete();
    const { value: second } = await settle(
      world.recorder.close(next as never, { scope: "backend", final: true }),
    );
    expect(second.window.from).toBe(first.window.to);
    expect(second.window.seenFrom).toBe(first.window.seenTo);
    expect(second.problems[0]).toBe(
      "#2 GET /api/experimental/v1/sessions (200, finished): unobserved",
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.problems)).toBe(true);
    expect(first.problems).toEqual([]);
  });

  it("a closed tab's failed request stays a failure while a companion tab carries on healthily", async () => {
    const world = new World();
    const companion = world.context.newPage();
    const { value: start } = await settle(world.recorder.open());
    world.flow("/api/experimental/v1/me").reach().fail();
    world.flow("/api/experimental/v1/me", { page: companion }).complete();
    const { value } = await settle(
      world.recorder.close(start, { scope: "backend", final: true }),
    );
    expect(value.pageBackend.map((a) => a.seen[0]?.page)).toEqual(["tab 2"]);
    expect(value.problems.join("\n")).toMatch(
      /#1 [^\n]*unfinished[\s\S]*page tab 1 [^\n]*failed: net::ERR_ABORTED/,
    );
  });

  it("the returned result is the snapshot judged: later events change neither it nor its records", async () => {
    const world = new World();
    const { value: start } = await settle(world.recorder.open());
    const flow = world.flow("/health");
    flow.reach();
    const { value } = await settle(
      world.recorder.close(start, { scope: "backend", final: true }),
    );
    expect(value.complete).toBe(false);
    flow.headers().finish();
    expect(value.snapshot[0]?.finished).toBe(false);
    expect(value.problems).toHaveLength(3);
  });
});

describe("request-origin recorder: bounded control reads and ownership rules", () => {
  it("a ledger read that never answers cannot outlive the bound; the late reply is ignored", async () => {
    const world = new World();
    const { value: start } = await settle(world.recorder.open());
    world.flow("/health").complete();
    world.server.hold = true;
    const { value, took } = await settle(
      world.recorder.close(start, { scope: "backend", final: true }),
    );
    expect(took).toBeGreaterThanOrEqual(BOUND);
    expect(took).toBeLessThan(BOUND + 100);
    expect(value.complete).toBe(false);
    expect(value.endedBy).toBe("control");
    expect(value.problems).toEqual([
      "ledger control: a ledger read did not answer within the bound (no snapshot was judged)",
    ]);
    world.server.hold = false;
    world.server.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(value.problems).toHaveLength(1);
  });

  it("a ledger read cut off by the bound after a snapshot reports the bound, judging that snapshot", async () => {
    const world = new World();
    const { value: start } = await settle(world.recorder.open());
    world.flow("/health");
    const closing = world.recorder.close(start, {
      scope: "backend",
      final: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    world.server.hold = true;
    const { value } = await settle(closing);
    expect(value.endedBy).toBe("bound");
    expect(value.complete).toBe(false);
    expect(value.problems.join("\n")).toMatch(/no end yet[\s\S]*incomplete/);
  });

  it("a rejected or malformed ledger reply is a control failure, never a pass", async () => {
    for (const fault of ["reject", "malformed"] as const) {
      const world = new World();
      const { value: start } = await settle(world.recorder.open());
      world.flow("/health").complete();
      if (fault === "reject")
        world.server.failWith = new Error("control /ledger: 500");
      else world.server.malformed = true;
      const { value } = await settle(
        world.recorder.close(start, { scope: "backend", final: true }),
      );
      expect(value.endedBy, fault).toBe("control");
      expect(value.complete, fault).toBe(false);
      expect(value.problems[0], fault).toMatch(/^ledger control: /);
    }
    const opening = new World();
    opening.server.malformed = true;
    await expect(settle(opening.recorder.open())).rejects.toThrow(
      /malformed ledger reply/,
    );
  });

  it("a final close seals the recorder; overlapping, stale and repeated operations throw instead of moving ownership", async () => {
    const world = new World();
    const { value: start } = await settle(world.recorder.open());
    await expect(settle(world.recorder.open())).rejects.toThrow(/already open/);
    world.flow("/health").reach();
    const closing = world.recorder.close(start, { scope: "backend" });
    await expect(
      settle(world.recorder.close(start, { scope: "backend" })),
    ).rejects.toThrow(/in progress/);
    const { value: first } = await settle(closing);
    // (the request never ended: the first window fails, and its successor is still handed out, in order)
    expect(first.complete).toBe(false);
    await expect(
      settle(world.recorder.close(start, { scope: "backend" })),
    ).rejects.toThrow(/not the open one/);
    const { value: last } = await settle(
      world.recorder.close(first.next as never, {
        scope: "backend",
        final: true,
      }),
    );
    expect(last.next).toBeNull();
    await expect(settle(world.recorder.open())).rejects.toThrow(
      /after the final window/,
    );
    await expect(
      settle(world.recorder.close(first.next as never, { scope: "backend" })),
    ).rejects.toThrow(/after the final window/);
  });

  it("records persist across a page's reload and closing; labels are stable per page", async () => {
    const world = new World();
    const { value: start } = await settle(world.recorder.open());
    world.flow("/", { navigation: true }).complete();
    world.flow("/", { navigation: true }).complete();
    world.context.open.splice(0);
    const fresh = world.context.newPage();
    world.flow("/health", { page: fresh }).complete();
    const { value } = await settle(
      world.recorder.close(start, { scope: "all", final: true }),
    );
    expect(value.problems).toEqual([]);
    expect(value.snapshot.map((r) => r.page)).toEqual([
      "tab 1",
      "tab 1",
      "tab 2",
    ]);
  });
});
