import type { BrowserContext, Page } from "@playwright/test";

/**
 * WEB-14a revision 47 (F-R46-PWA-LOAD, family `pwa-reload-document-load-premise`; design assessment of 2 November 2026, C1–C4).
 * TEST INSTRUMENTATION ONLY: nothing here runs in, or changes, the product.
 *
 * A reload the APP starts (an accepted update's `location.reload()`) does not hand the test a navigation promise. The specs used to poll
 * the old document's mark with `marked(page).catch(() => false)`: "Execution context was destroyed" satisfied the poll, and the following
 * `waitForLoadState("load")` returned at once because the client still held the OLD document's load state. The next evaluation then made
 * Playwright's trace snapshotter read layout in a replacement that was still parsing, and Firefox warned "Layout was forced before the page
 * was fully loaded" (review r46: `fixture.pwa-forms.spec.ts`, the 2 s remount case). Every page evaluation, locator check and action is
 * snapshotted before and after it, so NO driver call may reach a replacement before it has loaded, whatever the call's own expression is.
 *
 * A reload RECEIPT is armed on an already loaded page BEFORE the action that may reload it, and joined later:
 *
 *  - Arming installs, once per page, a passive per-document bridge: an exposed binding plus an init script. Every later document of that
 *    page gets a fresh random nonce at its creation and reports `start` (from the init script, before any page script) and `load` (from
 *    its own `load` listener) through the binding. Reports travel page → host only; `BindingCall.resolve` is an internal call that takes
 *    no trace snapshot. No evaluation is made while a document is in transition.
 *  - Arming then evaluates ONCE in the old, loaded document: it must be `complete`, and it receives a random arm token. A replacement
 *    never carries the token (a new Window), so the token, not the build label or the URL, identifies the old document.
 *  - The receipt completes only on the `load` report of the ONE document that started after arming, in the page's main frame, at the
 *    expected address (the old document's own, unless the caller names another). The old document, another page, a frame, a same-document
 *    navigation, a build label or a destroyed context never completes it. A second document starting before the receipt is joined
 *    (supersession), a load of an unannounced document, a wrong address, a duplicate report, the page closing or crashing, or a bound
 *    expiring fails it, with its whole event history.
 *  - Joining (`loaded()`) waits for that load, then makes the first evaluation of the new document (after its load: safe), which must find
 *    the reported nonce, no arm token, no `__pwaMark` and `complete`; a report that arrived meanwhile still fails it. Callers then make
 *    their own generation, display and form checks: load is not display, and display is not form readiness.
 *
 * The receipt observes; it never navigates, waits on the network, releases a hold, saves or discards anything. A receipt keeps a load that
 * happened before it was joined, so a caller can make its original same-document checks (a 2 s wait, a 300 ms attempted input) between
 * the action and the join without a blocking wait in between.
 */

/** The exposed binding's name, and the per-document identity the init script defines. */
export const BRIDGE = "__pwaDocumentReport";
const IDENTITY = "__pwaDocument";
const ARM_TOKEN = "__pwaReloadArm";

/**
 * Bounds of a join. A new document must START within `start` ms of the join (the expectation timeout the former `expect.poll` used, the
 * configured default of 5 s), and LOAD within `load` ms of starting (the bound `navigate` gives a first navigation). Neither is a product
 * timer, and a load that came before the join satisfies both.
 */
export const JOIN_BOUNDS = { start: 5_000, load: 30_000 } as const;

export interface DocumentReport {
  nonce: string;
  phase: "start" | "load";
  href: string;
  readyState: string;
}

export interface ReceiptEvent {
  /** Host milliseconds since the receipt was armed. */
  at: number;
  event: string;
}

export type ReceiptState =
  | { kind: "armed" }
  | { kind: "started"; nonce: string; href: string }
  | { kind: "loaded"; nonce: string; href: string }
  | { kind: "joined"; nonce: string; href: string }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" };

export interface OldDocument {
  /** The arm token written into the old document. */
  token: string;
  href: string;
  /** The old document's own nonce when the bridge was already installed before it started; null otherwise. */
  nonce: string | null;
}

/**
 * The receipt's state machine (pure; unit-tested in tests/pwa/reload-receipt.test.ts). It never throws: every input is recorded, and a
 * failure is a state.
 */
export class ReceiptMachine {
  state: ReceiptState = { kind: "armed" };
  readonly history: ReceiptEvent[] = [];
  private readonly began: number;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly old: OldDocument,
    readonly expected: (href: string) => boolean,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.began = now();
    this.note(
      `armed on ${old.href}${old.nonce ? ` (document ${old.nonce})` : ""}`,
    );
  }

  get settled(): boolean {
    return (
      this.state.kind === "joined" ||
      this.state.kind === "failed" ||
      this.state.kind === "cancelled"
    );
  }

  /** Called on every state change (the join's wait). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  report(report: DocumentReport, mainFrame: boolean): void {
    const what = `${report.phase} ${report.nonce} ${report.href} (${report.readyState})`;
    if (!mainFrame) {
      this.note(`ignored a frame's ${what}`);
      return;
    }
    if (this.settled) {
      this.note(`after ${this.state.kind}: ${what}`);
      return;
    }
    if (this.old.nonce !== null && report.nonce === this.old.nonce) {
      // The old document's own report (it started before the receipt was armed): never evidence of a replacement.
      this.note(`ignored the old document's ${what}`);
      return;
    }
    // Not settled: armed, started or loaded.
    const state = this.state as Extract<
      ReceiptState,
      { kind: "armed" | "started" | "loaded" }
    >;
    if (report.phase === "start") {
      if (state.kind === "armed") {
        if (!this.expected(report.href)) {
          this.fail(`a document started at an unexpected address: ${what}`);
          return;
        }
        this.move(
          { kind: "started", nonce: report.nonce, href: report.href },
          what,
        );
        return;
      }
      if (state.nonce === report.nonce) {
        this.fail(`a duplicate start report: ${what}`);
        return;
      }
      this.fail(
        `superseded: another document started after ${state.nonce} ${state.kind === "started" ? "started" : "loaded"}: ${what}`,
      );
      return;
    }
    // A load report.
    if (state.kind === "armed") {
      this.fail(`a document loaded whose start was not reported: ${what}`);
      return;
    }
    if (state.nonce !== report.nonce) {
      this.fail(`a document other than ${state.nonce} loaded: ${what}`);
      return;
    }
    if (state.kind === "loaded") {
      this.fail(`a duplicate load report: ${what}`);
      return;
    }
    this.move({ kind: "loaded", nonce: report.nonce, href: report.href }, what);
  }

  /** The page closed or crashed, or a bound expired. */
  fail(reason: string): void {
    if (this.settled) {
      this.note(`after ${this.state.kind}: ${reason}`);
      return;
    }
    this.move({ kind: "failed", reason }, `FAILED: ${reason}`);
  }

  cancel(): void {
    if (this.settled) return;
    this.move({ kind: "cancelled" }, "cancelled");
  }

  /** The join's own check of the loaded document passed. */
  join(): void {
    const state = this.state;
    if (state.kind !== "loaded") {
      this.fail(`joined while ${state.kind}`);
      return;
    }
    this.move(
      { kind: "joined", nonce: state.nonce, href: state.href },
      "joined",
    );
  }

  describe(): string {
    return this.history
      .map((entry) => `  +${entry.at} ms ${entry.event}`)
      .join("\n");
  }

  private note(event: string): void {
    this.history.push({ at: this.now() - this.began, event });
  }

  private move(next: ReceiptState, event: string): void {
    this.state = next;
    this.note(event);
    for (const listener of [...this.listeners]) listener();
  }
}

export interface ReloadedDocument {
  nonce: string;
  href: string;
  history: ReceiptEvent[];
}

export interface ReloadReceipt {
  /** Waits until the replacement has loaded and checks it is the one reported (see above); throws with the history otherwise. */
  loaded(bounds?: { start?: number; load?: number }): Promise<ReloadedDocument>;
  /** For an action that is expected NOT to reload after all: stops observing. A later `loaded()` throws. */
  cancel(): void;
  readonly machine: ReceiptMachine;
}

/** The minimum of Playwright's Page these functions use (so the unit tests can drive them with a double). */
export type ReceiptPage = Pick<
  Page,
  | "exposeBinding"
  | "addInitScript"
  | "evaluate"
  | "mainFrame"
  | "on"
  | "off"
  | "context"
>;

interface Wiring {
  machine: ReceiptMachine;
  detach(): void;
}

/**
 * Pages are known by their MAIN FRAME, which Playwright keeps for the page's whole life across navigations: the binding's source names
 * the real page, and a caller may hand `armReload` a wrapper of it (the qualification records every call made through one).
 */
const keyOf = (page: Pick<Page, "mainFrame">): object => page.mainFrame();
const bridged = new WeakSet<object>();
const current = new WeakMap<object, Wiring>();
const open = new WeakMap<object, Set<ReceiptMachine>>();

/** The per-document identity and its two reports: serialised into every new document of a bridged page. */
function documentReporter(names: { bridge: string; identity: string }): void {
  const scope = window as unknown as Record<string, unknown>;
  if (Object.hasOwn(scope, names.identity)) return;
  const nonce =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  Object.defineProperty(scope, names.identity, {
    value: Object.freeze({ nonce }),
    enumerable: false,
  });
  const report = scope[names.bridge];
  if (typeof report !== "function") return;
  const send = (phase: "start" | "load") => {
    // The host records every report; a report lost to a closing page is the host's to see (the receipt then fails at its bound).
    void Promise.resolve(
      (report as (value: unknown) => Promise<unknown>)({
        nonce,
        phase,
        href: location.href,
        readyState: document.readyState,
      }),
    ).catch(() => undefined);
  };
  send("start");
  window.addEventListener("load", () => send("load"), { once: true });
}

async function bridge(page: ReceiptPage): Promise<void> {
  if (bridged.has(keyOf(page))) return;
  await page.exposeBinding(BRIDGE, (source, report: DocumentReport) => {
    try {
      const main = source.page.mainFrame();
      current.get(main)?.machine.report(report, source.frame === main);
    } catch {
      // Never let the host side reject the page's call (the page would report an unhandled rejection).
    }
  });
  await page.addInitScript(documentReporter, {
    bridge: BRIDGE,
    identity: IDENTITY,
  });
  bridged.add(keyOf(page));
}

/**
 * Arms a receipt on `page`, whose current document must be loaded. Call it BEFORE the action that may reload the page. `url`: the address
 * the replacement must start at (default: the old document's own, which `location.reload()` keeps).
 */
export async function armReload(
  page: ReceiptPage,
  options: { url?: string | RegExp } = {},
): Promise<ReloadReceipt> {
  const key = keyOf(page);
  const existing = current.get(key);
  if (existing && !existing.machine.settled)
    throw new Error(
      `reload receipt: one is already armed for this page\n${existing.machine.describe()}`,
    );
  await bridge(page);
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const seen = await page.evaluate(
    ({ key, value, identity }) => {
      const scope = window as unknown as Record<string, unknown>;
      scope[key] = value;
      const own = scope[identity] as { nonce?: string } | undefined;
      return {
        readyState: document.readyState,
        href: location.href,
        nonce: own?.nonce ?? null,
      };
    },
    { key: ARM_TOKEN, value: token, identity: IDENTITY },
  );
  if (seen.readyState !== "complete")
    throw new Error(
      `reload receipt: armed on a document that has not loaded (${seen.readyState}, ${seen.href})`,
    );
  const wanted = options.url ?? seen.href;
  const machine = new ReceiptMachine(
    { token, href: seen.href, nonce: seen.nonce },
    (href) =>
      typeof wanted === "string" ? href === wanted : wanted.test(href),
  );
  const onClose = () => machine.fail("the page closed");
  const onCrash = () => machine.fail("the page crashed");
  page.on("close", onClose);
  page.on("crash", onCrash);
  const context = page.context() as object;
  const mine = open.get(context) ?? new Set<ReceiptMachine>();
  open.set(context, mine);
  mine.add(machine);
  const wiring: Wiring = {
    machine,
    detach: () => {
      page.off("close", onClose);
      page.off("crash", onCrash);
      if (current.get(key) === wiring) current.delete(key);
      mine.delete(machine);
    },
  };
  current.set(key, wiring);
  /** Fails the receipt (unless it already failed), stops observing, and throws with the whole history. */
  const refuse = (problem: string): never => {
    machine.fail(problem);
    wiring.detach();
    const state = machine.state;
    throw new Error(
      `reload receipt: ${state.kind === "failed" ? state.reason : problem}\n${machine.describe()}`,
    );
  };
  return {
    machine,
    cancel: () => {
      machine.cancel();
      wiring.detach();
    },
    loaded: async (bounds = {}) => {
      if (machine.state.kind === "cancelled")
        refuse("joined after it was cancelled");
      await until(machine, "started", bounds.start ?? JOIN_BOUNDS.start);
      await until(machine, "loaded", bounds.load ?? JOIN_BOUNDS.load);
      const state = machine.state;
      if (state.kind !== "loaded") return refuse(`joined while ${state.kind}`);
      // The first evaluation of the replacement, made only now that it has loaded.
      let found: {
        nonce: string | null;
        token: unknown;
        marked: boolean;
        readyState: string;
      };
      try {
        found = await page.evaluate(
          ({ key, identity }) => {
            const scope = window as unknown as Record<string, unknown>;
            const own = scope[identity] as { nonce?: string } | undefined;
            return {
              nonce: own?.nonce ?? null,
              token: scope[key] ?? null,
              marked: scope.__pwaMark === 1,
              readyState: document.readyState,
            };
          },
          { key: ARM_TOKEN, identity: IDENTITY },
        );
      } catch (error) {
        return refuse(
          `the loaded document could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // A report that arrived while the document was read (a further document started) fails the receipt too.
      if (machine.state.kind !== "loaded")
        return refuse(
          `changed to ${machine.state.kind} while the loaded document was read`,
        );
      if (found.token !== null)
        return refuse(
          "the page still runs the old document (it carries the arm token)",
        );
      if (found.nonce !== state.nonce)
        return refuse(
          `the page runs document ${found.nonce}, not the loaded ${state.nonce}`,
        );
      if (found.marked)
        return refuse("the loaded document carries the old document's mark");
      if (found.readyState !== "complete")
        return refuse(`the loaded document is ${found.readyState}`);
      machine.join();
      wiring.detach();
      return {
        nonce: state.nonce,
        href: state.href,
        history: [...machine.history],
      };
    },
  };
}

/** Waits until the machine has reached `kind` (or later), failing it when `bound` ms pass first. Never leaves a timer or listener behind. */
async function until(
  machine: ReceiptMachine,
  kind: "started" | "loaded",
  bound: number,
): Promise<void> {
  const reached = () => {
    const now = machine.state.kind;
    if (machine.settled) return true;
    return kind === "started" ? now !== "armed" : now === "loaded";
  };
  if (reached()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      machine.fail(
        kind === "started"
          ? `no new document started within ${bound} ms of the join`
          : `the new document did not load within ${bound} ms`,
      );
      resolve();
    }, bound);
    const unsubscribe = machine.subscribe(() => {
      if (!reached()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/** Arms a receipt, runs `action` (cancelling the receipt if the action itself throws), and joins it. */
export async function reloadAfter(
  page: ReceiptPage,
  action: () => Promise<unknown>,
  options: {
    url?: string | RegExp;
    bounds?: { start?: number; load?: number };
  } = {},
): Promise<ReloadedDocument> {
  const receipt = await armReload(page, { url: options.url });
  try {
    await action();
  } catch (error) {
    receipt.cancel();
    throw error;
  }
  return receipt.loaded(options.bounds);
}

/** True while a receipt is armed on `page` and not yet joined, failed or cancelled. */
export function armedOn(page: ReceiptPage): boolean {
  const wiring = current.get(keyOf(page));
  return wiring !== undefined && !wiring.machine.settled;
}

/** The receipts of `context` that were armed and are neither joined nor cancelled (a test that armed one must settle it). */
export function unsettled(context: BrowserContext | object): string[] {
  return [...(open.get(context) ?? [])]
    .filter(
      (machine) =>
        machine.state.kind !== "joined" && machine.state.kind !== "cancelled",
    )
    .map(
      (machine) =>
        `${machine.state.kind} receipt on ${machine.old.href}\n${machine.describe()}`,
    );
}
