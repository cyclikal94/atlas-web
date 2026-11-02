import type { BrowserContext, Page, Request } from "@playwright/test";
import {
  type JudgeOptions,
  type LedgerEntry,
  parseRequestId,
  type Reconciliation,
  reconcile,
  type Seen,
  terminal,
  type Window,
} from "./request-origin-judge";

/**
 * WEB-14a revision 43 (F-FRESH-2), corrected in revision 44: records the browser's side of every request the context makes to the
 * generation server, so a check can say per occurrence whether a page or a worker made it, and whether it ended (tests/e2e/request-origin-
 * judge.ts has the rules and why they hold per engine).
 *
 * It only LISTENS to Playwright's context events: nothing is injected into a page or a worker, no request is changed, delayed or routed.
 * It is attached before any page of the test navigates (the `requests` fixture in tests/e2e/pwa-world.ts), and its records live in the
 * test process, so a document that reloads or closes loses nothing already reported.
 *
 * Revision 44 (design assessment C2-C5). Each record has an explicit lifecycle: admitted (`request`), headers (`response`), and an END,
 * `requestfinished` or `requestfailed`; headers alone are not an end. Windows are EPOCHS handed out one at a time: `open` takes the
 * browser cut synchronously before its ledger read and carries every record still unfinished at that moment; `close` judges, at every
 * poll, one consistent pair (the ledger reply, then a copy of every browser record so far) with the same `reconcile` that decides whether
 * to stop, and returns exactly the pair it judged. One bound covers the whole close, its ledger reads included; at the bound, whatever is
 * unresolved is a problem. A `final` close seals the recorder: there is no later window to hand anything to. Overlapping or stale
 * operations throw instead of transferring ownership implicitly.
 */

/** A window handed out by `open` (or as a closed window's `next`): its starting cut. Closed at most once, in order. */
export interface Epoch {
  readonly serial: number;
  readonly from: number;
  readonly seenFrom: number;
  readonly carry: readonly number[];
}

export interface CloseOptions extends JudgeOptions {
  /** The last window of the case: no successor, the recorder is sealed afterwards. */
  final?: boolean;
}

export interface Closed extends Reconciliation {
  /** The cut actually judged. */
  window: Window;
  /** True only when every obligation of the window reached a terminal outcome inside the bound, with every ledger read answered. */
  complete: boolean;
  /** `stopped`: nothing left unresolved; `bound`: the bound expired first; `control`: a ledger read failed, was malformed or timed out. */
  endedBy: "stopped" | "bound" | "control";
  elapsedMs: number;
  /** The bound applied (ms). */
  boundMs: number;
  /** The browser records exactly as judged (copies). */
  snapshot: readonly Seen[];
  /** The following window (its cut is this one's end); null after a `final` close. */
  next: Epoch | null;
}

/** The server's ledger after request `after`, aborting when `signal` does. */
export type LedgerRead = (
  after: number,
  signal: AbortSignal,
) => Promise<{ high: number; entries: LedgerEntry[] }>;

const POLL_MS = 50;

/** A ledger read stopped by the close's bound (not by the control channel itself). */
class BoundExpired extends Error {}

export class RequestRecorder {
  readonly seen: Seen[] = [];
  private readonly records = new Map<Request, Seen>();
  private readonly labels = new Map<Page, string>();
  private serial = 0;
  /** The serial of the one epoch that may be closed next; null when none is outstanding. */
  private outstanding: number | null = null;
  private busy = false;
  private sealed = false;

  constructor(
    context: BrowserContext,
    private readonly origin: string,
    private readonly ledger: LedgerRead,
  ) {
    for (const page of context.pages()) this.labelOf(page);
    context.on("page", (page) => this.labelOf(page));
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== this.origin) return;
      let origin: Seen["origin"] = "unknown";
      let page: string | null = null;
      if (request.serviceWorker() !== null) origin = "worker";
      else
        try {
          page = this.labelOf(request.frame().page());
          origin = "page";
        } catch {
          // Playwright: "Service Worker requests do not have an associated frame". Without a frame the origin is not a page's.
          origin = "unknown";
        }
      const record: Seen = {
        n: this.seen.length + 1,
        method: request.method(),
        path: url.pathname + url.search,
        origin,
        page,
        navigation: request.isNavigationRequest(),
        idHeader: null,
        id: null,
        status: null,
        fromServiceWorker: null,
        finished: false,
        failed: null,
      };
      this.seen.push(record);
      this.records.set(request, record);
    });
    context.on("response", (response) => {
      const record = this.records.get(response.request());
      if (!record) return;
      record.status = response.status();
      record.fromServiceWorker = response.fromServiceWorker();
      record.idHeader = response.headers()["x-atlas-fixture-request"] ?? null;
      record.id = parseRequestId(record.idHeader);
    });
    context.on("requestfinished", (request) => {
      const record = this.records.get(request);
      if (record) record.finished = true;
    });
    context.on("requestfailed", (request) => {
      const record = this.records.get(request);
      if (record) record.failed = request.failure()?.errorText || "failed";
    });
  }

  /** The label of a page in this recorder's records (`tab 1`, `tab 2`, ... in order of creation). */
  labelOf(page: Page): string {
    let label = this.labels.get(page);
    if (label === undefined) {
      label = `tab ${this.labels.size + 1}`;
      this.labels.set(page, label);
    }
    return label;
  }

  /**
   * Opens a window. The browser cut is taken BEFORE the ledger read, so a request admitted while the read is in flight belongs to this
   * window (its receipt may then lie at or below `from`; the backend record names it, so it is still judged here). Every record still
   * unfinished at the cut is carried: its end, whenever it comes, is this window's to account for.
   */
  async open(boundMs = 5_000): Promise<Epoch> {
    this.claim("open");
    if (this.outstanding !== null) {
      this.busy = false;
      throw new Error(
        "request-origin: a window is already open; close it (or its successor) first",
      );
    }
    try {
      const seenFrom = this.seen.length;
      const carry = this.seen
        .filter((record) => !terminal(record))
        .map((record) => record.n);
      const reply = await this.read(Date.now() + boundMs);
      if (!Number.isSafeInteger(reply.high) || reply.high < 0)
        throw new Error(
          `request-origin: malformed ledger reply at opening: ${JSON.stringify(reply).slice(0, 200)}`,
        );
      const epoch: Epoch = Object.freeze({
        serial: ++this.serial,
        from: reply.high,
        seenFrom,
        carry: Object.freeze(carry),
      });
      this.outstanding = epoch.serial;
      return epoch;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Closes `epoch`: it covers every server request after its start up to the latest one the ledger reports, every browser record so far,
   * and its carried records. It waits (bounded by `boundMs` from the call, ledger reads included) while anything is unresolved, and judges
   * the one consistent snapshot it stopped on: anything still unresolved, or a failed ledger read, is a problem and `complete` is false.
   */
  async close(
    epoch: Epoch,
    options: CloseOptions,
    boundMs = 5_000,
  ): Promise<Closed> {
    this.claim("close");
    if (this.outstanding !== epoch.serial) {
      this.busy = false;
      throw new Error(
        `request-origin: window ${epoch.serial} is not the open one (${this.outstanding ?? "none"}); each window is closed once, in order`,
      );
    }
    const began = Date.now();
    const deadline = began + boundMs;
    let last: {
      window: Window;
      result: Reconciliation;
      snapshot: Seen[];
    } | null = null;
    let control: string | null = null;
    let endedBy: Closed["endedBy"] = "bound";
    try {
      for (;;) {
        let reply: { high: number; entries: LedgerEntry[] };
        try {
          reply = await this.read(deadline);
        } catch (error) {
          // A read the bound cut off after an earlier snapshot: the bound expired, and that snapshot is judged. Any other failure (or no
          // snapshot at all) is the control channel's, never a pass either.
          if (error instanceof BoundExpired && last !== null) break;
          control = error instanceof Error ? error.message : String(error);
          endedBy = "control";
          break;
        }
        if (
          !Number.isSafeInteger(reply?.high) ||
          !Array.isArray(reply?.entries)
        ) {
          control = `malformed ledger reply: ${JSON.stringify(reply).slice(0, 200)}`;
          endedBy = "control";
          break;
        }
        if (reply.high < epoch.from) {
          control = `the ledger went back from #${epoch.from} to #${reply.high} (another server?)`;
          endedBy = "control";
          break;
        }
        // The browser side is copied AFTER the reply, so every record the decision sees is judged, and nothing is added afterwards.
        const snapshot = this.seen.map((record) => ({ ...record }));
        const window: Window = {
          from: epoch.from,
          to: reply.high,
          seenFrom: epoch.seenFrom,
          seenTo: snapshot.length,
          carry: epoch.carry,
        };
        const result = reconcile(
          window,
          { after: 0, high: reply.high, entries: reply.entries },
          snapshot,
          options,
        );
        last = { window, result, snapshot };
        if (result.unresolved.length === 0) {
          endedBy = "stopped";
          break;
        }
        const left = deadline - Date.now();
        if (left <= 0) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(POLL_MS, left)),
        );
        if (Date.now() >= deadline) break;
      }
    } finally {
      this.busy = false;
    }
    const elapsedMs = Date.now() - began;
    const window: Window = last?.window ?? {
      from: epoch.from,
      to: epoch.from,
      seenFrom: epoch.seenFrom,
      seenTo: epoch.seenFrom,
      carry: epoch.carry,
    };
    const result: Reconciliation = last?.result ?? {
      attributions: [],
      pageBackend: [],
      failures: [],
      unresolved: [],
      problems: [],
      owned: [],
      receipts: [],
    };
    const problems = [...result.problems];
    if (control !== null)
      problems.push(
        `ledger control: ${control}${last === null ? " (no snapshot was judged)" : ""}`,
      );
    if (endedBy === "bound")
      problems.push(
        `incomplete: ${result.unresolved.length} obligation(s) still unresolved when the ${boundMs} ms bound expired`,
      );
    let next: Epoch | null = null;
    if (options.final) {
      this.sealed = true;
      this.outstanding = null;
    } else {
      const ended = new Set(
        (last?.snapshot ?? [])
          .filter((record) => terminal(record))
          .map((record) => record.n),
      );
      next = Object.freeze({
        serial: ++this.serial,
        from: window.to,
        seenFrom: window.seenTo,
        carry: Object.freeze(
          (last !== null ? result.owned : [...epoch.carry]).filter(
            (n) => !ended.has(n),
          ),
        ),
      });
      this.outstanding = next.serial;
    }
    return Object.freeze({
      ...result,
      problems: Object.freeze(problems) as string[],
      window: Object.freeze({ ...window }),
      complete: endedBy === "stopped" && control === null,
      endedBy,
      elapsedMs,
      boundMs,
      snapshot: Object.freeze(last?.snapshot ?? []),
      next,
    });
  }

  private claim(operation: string): void {
    if (this.sealed)
      throw new Error(
        `request-origin: ${operation} after the final window was closed`,
      );
    if (this.busy)
      throw new Error(
        `request-origin: ${operation} while another open/close is in progress`,
      );
    this.busy = true;
  }

  /** One ledger read that cannot outlive `deadline`: it is aborted then, and a late reply is ignored. */
  private read(
    deadline: number,
  ): Promise<{ high: number; entries: LedgerEntry[] }> {
    const left = deadline - Date.now();
    if (left <= 0)
      return Promise.reject(new BoundExpired("no time left for a ledger read"));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Rejected BEFORE the abort, so the bound (not the transport's abort error) is what the race reports.
        const expiry = new BoundExpired(
          "a ledger read did not answer within the bound",
        );
        reject(expiry);
        controller.abort(expiry);
      }, left);
    });
    return Promise.race([this.ledger(0, controller.signal), expired]).finally(
      () => clearTimeout(timer),
    );
  }
}
