import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armedOn,
  armReload,
  type DocumentReport,
  JOIN_BOUNDS,
  ReceiptMachine,
  type ReceiptPage,
  reloadAfter,
  unsettled,
} from "../e2e/reload-receipt";

/**
 * WEB-14a revision 47 (F-R46-PWA-LOAD, family `pwa-reload-document-load-premise`; design assessment of 2 November 2026, Q1): the reload
 * receipt's state machine and its wiring, over hand-fed per-document reports and a page double. The receipt completes only on the load of
 * the one main-frame document that started after it was armed, at the expected address; the old document, a frame, another page, a
 * superseding or unannounced document, a duplicate report, a close, a crash and an expired bound never complete it, and it leaves no
 * listener, timer or rejected promise behind. The native boundary (real tracing over a held-parse replacement) is qualified separately.
 */
const OLD = "https://app.test/today";
const report = (
  nonce: string,
  phase: "start" | "load",
  href = OLD,
): DocumentReport => ({
  nonce,
  phase,
  href,
  readyState: phase === "load" ? "complete" : "loading",
});
const machine = (
  old: { nonce?: string | null; href?: string } = {},
  expected: (href: string) => boolean = (href) => href === OLD,
) =>
  new ReceiptMachine(
    { token: "token", href: old.href ?? OLD, nonce: old.nonce ?? null },
    expected,
  );

describe("ReceiptMachine: what completes a receipt", () => {
  it("a new main-frame document that started and then loaded at the old address (same URL): loaded only after its load", () => {
    const m = machine();
    m.report(report("n1", "start"), true);
    expect(m.state).toEqual({ kind: "started", nonce: "n1", href: OLD });
    m.report(report("n1", "load"), true);
    expect(m.state).toEqual({ kind: "loaded", nonce: "n1", href: OLD });
    m.join();
    expect(m.state.kind).toBe("joined");
  });

  it("the old document's own start and load (the bridge was installed before it started) are ignored, never a replacement", () => {
    const m = machine({ nonce: "old" });
    m.report(report("old", "start"), true);
    m.report(report("old", "load"), true);
    expect(m.state.kind).toBe("armed");
    m.report(report("n1", "start"), true);
    m.report(report("old", "load"), true);
    expect(m.state.kind).toBe("started");
  });

  it("a frame's reports are ignored", () => {
    const m = machine();
    m.report(report("frame", "start"), false);
    m.report(report("frame", "load"), false);
    expect(m.state.kind).toBe("armed");
    m.report(report("n1", "start"), true);
    m.report(report("frame2", "start"), false);
    m.report(report("n1", "load"), true);
    expect(m.state.kind).toBe("loaded");
  });

  it("a caller-named address (RegExp) is accepted; the default is the old document's own", () => {
    const m = machine({}, (href) => /\/sign-in$/.test(href));
    m.report(report("n1", "start", "https://app.test/sign-in"), true);
    expect(m.state.kind).toBe("started");
  });
});

describe("ReceiptMachine: what fails a receipt (with its reason)", () => {
  const failed = (m: ReceiptMachine) =>
    m.state.kind === "failed" ? m.state.reason : `not failed: ${m.state.kind}`;

  it("a load whose document never reported its start", () => {
    const m = machine();
    m.report(report("n1", "load"), true);
    expect(failed(m)).toMatch(
      /^a document loaded whose start was not reported/,
    );
  });

  it("a document starting at an unexpected address", () => {
    const m = machine();
    m.report(report("n1", "start", "https://app.test/elsewhere"), true);
    expect(failed(m)).toMatch(/^a document started at an unexpected address/);
  });

  it("supersession: a second document starts before the first loaded", () => {
    const m = machine();
    m.report(report("n1", "start"), true);
    m.report(report("n2", "start"), true);
    expect(failed(m)).toMatch(
      /^superseded: another document started after n1 started/,
    );
  });

  it("supersession after the load (before the join)", () => {
    const m = machine();
    m.report(report("n1", "start"), true);
    m.report(report("n1", "load"), true);
    m.report(report("n2", "start"), true);
    expect(failed(m)).toMatch(
      /^superseded: another document started after n1 loaded/,
    );
  });

  it("another document's load", () => {
    const m = machine();
    m.report(report("n1", "start"), true);
    m.report(report("n2", "load"), true);
    expect(failed(m)).toMatch(/^a document other than n1 loaded/);
  });

  it("a duplicate start, and a duplicate load", () => {
    const a = machine();
    a.report(report("n1", "start"), true);
    a.report(report("n1", "start"), true);
    expect(failed(a)).toMatch(/^a duplicate start report/);
    const b = machine();
    b.report(report("n1", "start"), true);
    b.report(report("n1", "load"), true);
    b.report(report("n1", "load"), true);
    expect(failed(b)).toMatch(/^a duplicate load report/);
  });

  it("a join before the load", () => {
    const m = machine();
    m.report(report("n1", "start"), true);
    m.join();
    expect(failed(m)).toBe("joined while started");
  });

  it("settled states keep their outcome: later reports and failures are only recorded", () => {
    const m = machine();
    m.fail("the page closed");
    m.report(report("n1", "start"), true);
    m.report(report("n1", "load"), true);
    m.cancel();
    expect(failed(m)).toBe("the page closed");
    expect(m.history.map((e) => e.event)).toEqual([
      `armed on ${OLD}`,
      "FAILED: the page closed",
      `after failed: start n1 ${OLD} (loading)`,
      `after failed: load n1 ${OLD} (complete)`,
    ]);
    const c = machine();
    c.cancel();
    c.report(report("n1", "start"), true);
    expect(c.state.kind).toBe("cancelled");
  });
});

// ---- the wiring, over a page double ------------------------------------------------------------------------------------------------------

interface Doc {
  nonce: string | null;
  token: unknown;
  readyState: string;
  href: string;
  marked: boolean;
}
type Source = { page: unknown; frame: unknown; context: unknown };

class FakePage {
  readonly frame = { name: "main" };
  readonly child = { name: "child" };
  readonly ctx: object;
  binding: ((source: Source, report: DocumentReport) => unknown) | null = null;
  exposeCalls = 0;
  initScripts = 0;
  doc: Doc = {
    nonce: null,
    token: null,
    readyState: "complete",
    href: OLD,
    marked: true,
  };
  /** Runs during the join's read of the loaded document (a report arriving meanwhile). */
  onRead: (() => void) | null = null;
  private readonly listeners = new Map<
    string,
    Set<(...a: unknown[]) => void>
  >();

  constructor(ctx: object = {}) {
    this.ctx = ctx;
  }
  async exposeBinding(
    _name: string,
    callback: (source: Source, report: DocumentReport) => unknown,
  ) {
    this.exposeCalls += 1;
    this.binding = callback;
  }
  async addInitScript() {
    this.initScripts += 1;
  }
  mainFrame() {
    return this.frame;
  }
  context() {
    return this.ctx;
  }
  on(event: string, listener: (...a: unknown[]) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }
  off(event: string, listener: (...a: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
  count(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
  async evaluate(_fn: unknown, arg: Record<string, unknown>) {
    if ("value" in arg) {
      this.doc.token = arg.value;
      return {
        readyState: this.doc.readyState,
        href: this.doc.href,
        nonce: this.doc.nonce,
      };
    }
    this.onRead?.();
    return {
      nonce: this.doc.nonce,
      token: this.doc.token,
      marked: this.doc.marked,
      readyState: this.doc.readyState,
    };
  }
  /** A new document commits (the init script reports its start). */
  navigate(nonce: string, href = this.doc.href) {
    this.doc = {
      nonce,
      token: null,
      readyState: "loading",
      href,
      marked: false,
    };
    this.send(nonce, "start", href);
  }
  load() {
    this.doc.readyState = "complete";
    this.send(this.doc.nonce ?? "", "load", this.doc.href);
  }
  send(
    nonce: string,
    phase: "start" | "load",
    href = OLD,
    frame: unknown = this.frame,
  ) {
    this.binding?.(
      { page: this, frame, context: this.ctx },
      report(nonce, phase, href),
    );
  }
  get page(): ReceiptPage {
    return this as unknown as ReceiptPage;
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/**
 * A promise's outcome as a value, so every check below is an assertion (a sensitivity mutant that makes a join reject or resolve wrongly is
 * caught by `expect`, never by an uncaught error), and no rejection is ever left unobserved.
 */
type Outcome<T> = { value: T } | { error: string };
const outcome = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
/** Small explicit bounds for joins that must NOT wait (a mutant that waits then fails at once, as an assertion). */
const SHORT = { start: 100, load: 100 };

afterEach(() => {
  vi.useRealTimers();
});

describe("armReload/loaded: the wiring", () => {
  it("refuses to arm on a document that has not loaded", async () => {
    const fake = new FakePage();
    fake.doc.readyState = "interactive";
    expect(await outcome(armReload(fake.page))).toEqual({
      error:
        "reload receipt: armed on a document that has not loaded (interactive, https://app.test/today)",
    });
  });

  it("a load before the join is kept; the join reads the new document once, then every listener is gone", async () => {
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    expect(fake.doc.token).not.toBeNull();
    expect(armedOn(fake.page)).toBe(true);
    expect([fake.count("close"), fake.count("crash")]).toEqual([1, 1]);
    fake.navigate("n1");
    fake.load();
    expect(await outcome(receipt.loaded(SHORT))).toMatchObject({
      value: { nonce: "n1", href: OLD },
    });
    expect(receipt.machine.state.kind).toBe("joined");
    expect([fake.count("close"), fake.count("crash")]).toEqual([0, 0]);
    expect(armedOn(fake.page)).toBe(false);
    expect(unsettled(fake.ctx)).toEqual([]);
  });

  it("a join before the load stays pending through the start and resolves only at the load; its timer is cleared", async () => {
    vi.useFakeTimers();
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    let settled = false;
    const joined = outcome(receipt.loaded()).then((value) => {
      settled = true;
      return value;
    });
    await flush();
    expect(settled).toBe(false);
    fake.navigate("n1");
    await flush();
    expect(settled).toBe(false);
    expect(receipt.machine.state.kind).toBe("started");
    fake.load();
    expect(await joined).toMatchObject({ value: { nonce: "n1" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no new document within the start bound: fails with its history, no timer or listener left", async () => {
    vi.useFakeTimers();
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    const joined = outcome(receipt.loaded());
    await vi.advanceTimersByTimeAsync(JOIN_BOUNDS.start);
    const seen = await joined;
    expect("error" in seen ? seen.error : "resolved").toMatch(
      /^reload receipt: no new document started within 5000 ms of the join\n {2}\+\d+ ms armed on /,
    );
    expect(vi.getTimerCount()).toBe(0);
    expect([fake.count("close"), fake.count("crash")]).toEqual([0, 0]);
  });

  it("a started document that never loads within the load bound fails", async () => {
    vi.useFakeTimers();
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    fake.navigate("n1");
    const joined = outcome(receipt.loaded());
    await vi.advanceTimersByTimeAsync(JOIN_BOUNDS.load);
    const seen = await joined;
    expect("error" in seen ? seen.error : "resolved").toMatch(
      /^reload receipt: the new document did not load within 30000 ms/,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the page closing (or crashing) while the join waits fails it", async () => {
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    const joined = outcome(receipt.loaded(SHORT));
    fake.emit("close");
    const seen = await joined;
    expect("error" in seen ? seen.error : "resolved").toMatch(
      /^reload receipt: the page closed/,
    );
    const crashing = new FakePage();
    const second = await armReload(crashing.page);
    crashing.navigate("n1");
    crashing.emit("crash");
    const crashed = await outcome(second.loaded(SHORT));
    expect("error" in crashed ? crashed.error : "resolved").toMatch(
      /^reload receipt: the page crashed/,
    );
  });

  it("a page closed with an unjoined receipt leaves no rejected promise and is reported as unsettled", async () => {
    const ctx = {};
    const fake = new FakePage(ctx);
    await armReload(fake.page);
    fake.emit("close");
    await flush();
    expect(unsettled(ctx)).toHaveLength(1);
    expect(unsettled(ctx)[0]).toMatch(/^failed receipt on /);
  });

  it("the old document still runs (it carries the arm token): refused, even after a load report", async () => {
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    const token = fake.doc.token;
    fake.navigate("n1");
    fake.load();
    fake.doc.token = token;
    const seen = await outcome(receipt.loaded(SHORT));
    expect("error" in seen ? seen.error : "resolved").toMatch(
      /^reload receipt: the page still runs the old document \(it carries the arm token\)/,
    );
  });

  it("the page runs another document than the one that loaded: refused", async () => {
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    fake.navigate("n1");
    fake.load();
    fake.doc.nonce = "n2";
    const seen = await outcome(receipt.loaded(SHORT));
    expect("error" in seen ? seen.error : "resolved").toMatch(
      /^reload receipt: the page runs document n2, not the loaded n1/,
    );
  });

  it("the loaded document carries the old mark, or is not complete: refused", async () => {
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    fake.navigate("n1");
    fake.load();
    fake.doc.marked = true;
    const marked = await outcome(receipt.loaded(SHORT));
    expect("error" in marked ? marked.error : "resolved").toMatch(
      /^reload receipt: the loaded document carries the old document's mark/,
    );
    const other = new FakePage();
    const second = await armReload(other.page);
    other.navigate("n1");
    other.load();
    other.doc.readyState = "interactive";
    const parsing = await outcome(second.loaded(SHORT));
    expect("error" in parsing ? parsing.error : "resolved").toMatch(
      /^reload receipt: the loaded document is interactive/,
    );
  });

  it("a further document starting while the loaded one is read fails the join", async () => {
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    fake.navigate("n1");
    fake.load();
    fake.onRead = () => fake.send("n2", "start");
    const seen = await outcome(receipt.loaded(SHORT));
    expect("error" in seen ? seen.error : "resolved").toMatch(
      /^reload receipt: superseded: another document started after n1 loaded/,
    );
  });

  it("the read itself failing (the context went away) fails the join, never completes it", async () => {
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    fake.navigate("n1");
    fake.load();
    fake.onRead = () => {
      throw new Error("Execution context was destroyed");
    };
    const seen = await outcome(receipt.loaded(SHORT));
    expect("error" in seen ? seen.error : "resolved").toMatch(
      /^reload receipt: the loaded document could not be read: Execution context was destroyed/,
    );
  });

  it("two pages: the other page's documents never complete this page's receipt", async () => {
    const ctx = {};
    const a = new FakePage(ctx);
    const b = new FakePage(ctx);
    const ra = await armReload(a.page);
    const rb = await armReload(b.page);
    b.navigate("b1");
    b.load();
    expect(ra.machine.state.kind).toBe("armed");
    expect(await outcome(rb.loaded(SHORT))).toMatchObject({
      value: { nonce: "b1" },
    });
    a.navigate("a1");
    a.load();
    expect(await outcome(ra.loaded(SHORT))).toMatchObject({
      value: { nonce: "a1" },
    });
  });

  it("a frame's document never completes the receipt", async () => {
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    fake.send("f1", "start", OLD, fake.child);
    fake.send("f1", "load", OLD, fake.child);
    expect(receipt.machine.state.kind).toBe("armed");
    receipt.cancel();
  });

  it("the bridge is installed once per page; a later receipt ignores the reports of the document it was armed on", async () => {
    const fake = new FakePage();
    const first = await armReload(fake.page);
    fake.navigate("n1");
    fake.load();
    expect(await outcome(first.loaded(SHORT))).toMatchObject({
      value: { nonce: "n1" },
    });
    const second = await armReload(fake.page);
    expect([fake.exposeCalls, fake.initScripts]).toEqual([1, 1]);
    expect(second.machine.old.nonce).toBe("n1");
    // A late report of the document the second receipt was armed on.
    fake.send("n1", "load");
    expect(second.machine.state.kind).toBe("armed");
    fake.navigate("n2");
    fake.load();
    expect(await outcome(second.loaded(SHORT))).toMatchObject({
      value: { nonce: "n2" },
    });
  });

  it("a second arm while one is open is refused", async () => {
    const fake = new FakePage();
    const first = await armReload(fake.page);
    const second = await outcome(armReload(fake.page));
    expect("error" in second ? second.error : "armed twice").toMatch(
      /^reload receipt: one is already armed for this page/,
    );
    expect(fake.count("close"), "the refused arm attached nothing").toBe(1);
    first.cancel();
  });

  it("cancel stops observing; a later join is refused", async () => {
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    receipt.cancel();
    expect([fake.count("close"), fake.count("crash")]).toEqual([0, 0]);
    expect(armedOn(fake.page)).toBe(false);
    expect(unsettled(fake.ctx)).toEqual([]);
    fake.navigate("n1");
    expect(receipt.machine.state.kind).toBe("cancelled");
    const seen = await outcome(receipt.loaded(SHORT));
    expect("error" in seen ? seen.error : "resolved").toMatch(
      /^reload receipt: joined after it was cancelled/,
    );
  });

  it("an armed receipt that is never joined is reported as unsettled", async () => {
    const ctx = {};
    const fake = new FakePage(ctx);
    await armReload(fake.page);
    expect(unsettled(ctx)).toHaveLength(1);
    expect(unsettled(ctx)[0]).toMatch(
      /^armed receipt on https:\/\/app\.test\/today/,
    );
  });

  it("reloadAfter: a throwing action cancels the receipt and rethrows; a reloading action is joined", async () => {
    const fake = new FakePage();
    expect(
      await outcome(
        reloadAfter(fake.page, async () => {
          throw new Error("the click failed");
        }),
      ),
    ).toEqual({ error: "the click failed" });
    expect(armedOn(fake.page)).toBe(false);
    expect(unsettled(fake.ctx)).toEqual([]);
    expect(
      await outcome(
        reloadAfter(
          fake.page,
          async () => {
            fake.navigate("n1");
            fake.load();
          },
          { bounds: SHORT },
        ),
      ),
    ).toMatchObject({ value: { nonce: "n1" } });
  });

  it("the host side never rejects the page's report, even for a page it does not know", async () => {
    const fake = new FakePage();
    const receipt = await armReload(fake.page);
    receipt.cancel();
    const binding = fake.binding;
    expect(binding).not.toBeNull();
    expect(() =>
      binding?.({ page: {}, frame: {}, context: {} }, report("x", "start")),
    ).not.toThrow();
  });
});
