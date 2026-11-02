import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  ConsoleMessage,
  Page,
  PlaywrightWorkerArgs,
  Request,
  TestInfo,
} from "@playwright/test";
import { expect } from "@playwright/test";
import {
  createTransport,
  createWitnessOrigin,
  type LossRecord,
  type OwnedUpstream,
  ownUpstream,
  settlesWithin,
  type Transport,
  type TransportAttempt,
  type TransportStamp,
  type WitnessOrigin,
} from "../../scripts/integration/http-transport-loss.mjs";

/**
 * WEB-13b revision 18 (Review 22, family webkit-offline-emulation-file-read; hand-off
 * delivery/handoffs/web13b-native-transport-qualification-20261102.md SHA-256 b2e5e8f2…; design assessment token 5b1d232f…): the OPT-IN
 * native transport lane. A case that asks for it gets its OWN context, in the project's browser and with the project's device, whose
 * base URL is a loopback FRONT ORIGIN (scripts/integration/http-transport-loss.mjs) carrying every HTTP request of the application's
 * origin. While the lane's transport is lost, every request of every page fails in the network before any target receives it, and
 * native File reads stay native: no File API stub and no `context.setOffline` (whose WebKit emulation fails every File read). The
 * hand-off's per-browser forward proxy is not used: Playwright's WebKit answers most requests of a many-module document itself with 404
 * when any HTTP proxy is configured (diagnostics in .agtx/evidence/WEB-13b/revision-18/diag). Nothing else uses this lane;
 * `goOfflineAtBoundary` (tasks-helpers.ts) keeps its meaning for its callers.
 *
 * Kept apart, as the design assessment's invariant 1 asks, and never derived from one another:
 *  - the TRANSPORT (the front's phase, generation and its record of every request it saw: `transport.attempts`);
 *  - TARGET RECEIPTS, recorded by each target when a request ARRIVES: the witness origin (`/__transport/...` probes), the lane's scripted
 *    origin (the fixture lane's API answers) or, on the released backend, the integration runner's delaying proxy (its `/log`);
 *  - the BROWSER's own outcome of a request (a probe's resolved status/body, or its rejection; and, revision 19, every request event of
 *    every lane page in the journal below);
 *  - the UI CONNECTIVITY stimulus: a document-owned `navigator.onLine` override installed before the app boots (`ui`), with the native
 *    value recorded beside it. A transport loss does not make `navigator.onLine` false; the stimulus does not block HTTP.
 *
 * The fixture lane's API answers come from a REAL loopback origin: the scripted origin runs the same handlers the fixture helpers install
 * with `context.route` (stubNetwork, serveIdentityReads, stubCalendars: `routes`, a context whose `route` registers there), so their
 * answer semantics are unchanged, but every answer travels the browser's network through the front. A route, HAR or emulated offline on
 * the lane's own context or pages throws: a fixture route answers without the network and so could pass for transport evidence. A request
 * of a lane page to any other origin fails the case (the loss would not cover it). The fixture build has no service worker (vite.config.ts
 * excludes the PWA plugin in fixture mode), so a document cannot load while the transport is lost; a loss-time reload is NOT exercised
 * here (execute.md: the actual-worker branch remains unqualified).
 *
 * Revision 19 (Review 23 F23-1, family native-transport-console-attribution; design assessment token 3266b126…, invariants 2–6): the
 * console guard no longer pools "dropped URLs" across the test. The lane keeps an append-only JOURNAL, in the order this process observed
 * it (one lane-wide sequence): every console error/warning and page error of every lane page (with its page and DOCUMENT), every browser
 * request of those pages with its own terminal event (response status or failure), every front attempt, and every declared HTTP
 * expectation. `classifyJournal` (pure: the same journal always gives the same verdict) then judges each problem exactly once:
 *  - a page error or a warning ALWAYS fails, whatever it names;
 *  - an engine's HTTP-status message is expected only for its own page/document's response with that status, from a request a case
 *    DECLARED (`expectHttp`: method, path, status, exact count, after the declaration) and the front saw answered with that status;
 *  - an engine's network-failure message is expected only for its own page/document's FAILED request whose every front attempt was
 *    dropped in a loss (attempts are assigned to the request of the same method and URL that ends next; a concurrent same-request
 *    overlap is ambiguous and so unexpected), at most once per request;
 *  - everything else, and every ambiguous attribution, is unexpected. Nothing is filtered by wording alone, and no later loss can excuse
 *    an earlier or a different page's, document's or request's message.
 * Review 23 F23-2 (family native-transport-upstream-cleanup): the scripted origin owns every request it dispatches and forwards, cancels
 * them when their downstream closes or the origin closes, and its close JOINS them (bounded; a failure names what stayed open). The
 * fixture closes everything a lane owns first (every step attempted), then classifies the settled journal and attaches the ledger.
 * FIXTURE evidence on the fixture lane; the released backend's lane is the integration runner's.
 */

export interface TransportLaneOptions {
  /**
   * `fixture`: the front sends `/api/` and `/health` to the lane's scripted origin and everything else to the project's base URL (the
   * fixture preview). `integration`: everything to the base URL (the preview in front of the delaying proxy and the released backend).
   */
  mode: "fixture" | "integration";
}

export interface UiRecord {
  document: string;
  /** The engine's own `navigator.onLine` (never overridden). */
  native: boolean;
  /** What the application reads (`navigator.onLine` with the stimulus). */
  ui: boolean;
  /** The stimulus in force: null = none (the native value shows through). */
  stimulus: boolean | null;
}

export interface ProbeResult {
  kind: "probe" | "cacheable";
  nonce: string;
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  ui: UiRecord;
}

export interface OriginReceipt extends TransportStamp {
  method: string;
  url: string;
  bodyBytes: number;
  bodySha256: string;
  at: number;
  /**
   * What answered it: a handler's fulfil or abort, a forward to the fallback (no handler), a handler error, cancelled (its downstream
   * closed or the origin closed before an answer was decided), or closed (it arrived while the origin was closing: nothing ran).
   */
  outcome?:
    | "fulfilled"
    | "aborted"
    | "unrouted"
    | "handler_error"
    | "cancelled"
    | "closed";
  /** Why it was cancelled. */
  cancelledBy?: string;
  /** The downstream (the front, or a client) closed before the answer was complete. */
  downstreamClosed?: boolean;
  /** A forward's end: completed, abandoned (its downstream or the origin closed first) or the upstream's error. */
  forward?: string;
  /** Decisions a handler made AFTER the request was cancelled: recorded, never written. */
  late?: string[];
}

type Handler = (route: OriginRoute, request: OriginRequest) => unknown;

/** The Playwright `Request` surface the fixture handlers read, over a request that ARRIVED at the scripted origin. */
export class OriginRequest {
  constructor(
    private readonly incoming: IncomingMessage,
    private readonly body: Buffer,
  ) {}
  url(): string {
    return `http://${this.incoming.headers.host}${this.incoming.url}`;
  }
  method(): string {
    return this.incoming.method ?? "GET";
  }
  headers(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.incoming.headers))
      if (value !== undefined)
        out[name] = Array.isArray(value) ? value.join(", ") : value;
    return out;
  }
  postData(): string | null {
    return this.body.length === 0 ? null : this.body.toString("utf8");
  }
}

type Decision = "fulfilled" | "aborted" | "fallback" | "cancelled";

/**
 * The Playwright `Route` surface the fixture handlers use (`request`, `fulfill`, `abort`, `fallback`), answering over real HTTP.
 * Revision 19: `signal` (not Playwright's) aborts when this request's downstream closes or the origin closes. A handler that HOLDS an
 * answer releases its hold on it (calendar-13b-helpers.ts `wait`); the origin's own wait for a decision ends then too. A decision made
 * after that is recorded as late and never written.
 */
export class OriginRoute {
  decided: Decision | null = null;
  private resolve: (decision: Decision) => void = () => undefined;
  readonly decision = new Promise<Decision>((resolve) => {
    this.resolve = resolve;
  });
  constructor(
    private readonly req: OriginRequest,
    private readonly res: ServerResponse,
    readonly signal: AbortSignal,
    private readonly onLate: (what: Decision) => void,
  ) {
    if (signal.aborted) this.cancel();
    else signal.addEventListener("abort", () => this.cancel(), { once: true });
  }
  private cancel() {
    if (this.decided !== null) return;
    this.decided = "cancelled";
    this.resolve("cancelled");
  }
  request(): OriginRequest {
    return this.req;
  }
  /** True when the decision is taken now; false (recorded as late, nothing written) after a cancellation. */
  private decide(decision: Decision): boolean {
    if (this.decided === "cancelled") {
      this.onLate(decision);
      return false;
    }
    if (this.decided !== null) throw new Error(`route already ${this.decided}`);
    this.decided = decision;
    this.resolve(decision);
    return true;
  }
  async fulfill(options: {
    status?: number;
    contentType?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  }): Promise<void> {
    const unknown = Object.keys(options).filter(
      (k) => !["status", "contentType", "headers", "body"].includes(k),
    );
    if (unknown.length > 0)
      throw new Error(`scripted origin: unsupported fulfil ${unknown}`);
    if (!this.decide("fulfilled")) return;
    const body = options.body ?? "";
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.contentType !== undefined)
      headers["content-type"] = options.contentType;
    headers["content-length"] = String(Buffer.byteLength(body));
    this.res.writeHead(options.status ?? 200, headers);
    this.res.end(body);
  }
  async abort(_code?: string): Promise<void> {
    // A reset AFTER the request arrived (the origin "applied" it): a lost answer, which the front passes on as the same failure.
    if (!this.decide("aborted")) return;
    this.res.socket?.destroy();
  }
  async fallback(): Promise<void> {
    this.decide("fallback");
  }
}

/** Playwright's URL glob (`*` within a segment, `**` across them, `**\/` and `/**\/` as Playwright reads them; braces unsupported). */
export function globRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === "*") {
      const before = glob[i - 1];
      let stars = 1;
      while (glob[i + 1] === "*") {
        stars += 1;
        i += 1;
      }
      if (stars > 1) {
        if (glob[i + 1] === "/") {
          out += before === "/" ? "((.+/)|)" : "(.*/)";
          i += 1;
        } else out += "(.*)";
      } else out += "([^/]*)";
      continue;
    }
    if (c === "{" || c === "}" || c === "\\")
      throw new Error(`globRegExp: unsupported ${c} in ${glob}`);
    out += /[$^+.()|?[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`${out}$`);
}

/** How long the scripted origin's close waits for its owned work to end once cancelled (a harness bound, not a duration under test). */
const ORIGIN_CLOSE_BOUND_MS = 10_000;

/**
 * The join of a connection still in the origin's set: its "close" event (its listener removes it from the set). `socket.closed` is not
 * used: it is already true between destroy() and the event's next-tick emission, when the set still holds the socket.
 */
const closedOf = (socket: Socket): Promise<void> =>
  new Promise((resolve) => socket.once("close", () => resolve()));

/**
 * The fixture lane's API origin: a loopback HTTP server that answers each ARRIVING request with the handlers registered through
 * `route` (newest first; `fallback` passes on, as in Playwright), records the arrival (stamped with the transport's generation and
 * phase; the body only as its length and SHA-256, never its text), and forwards a request no handler takes to `fallback`.
 *
 * Revision 19 (F23-2): it OWNS each request it dispatches until that dispatch ends, including the forwarded request (and its socket) of a
 * fallback. When a request's downstream closes before its answer is complete, that request is cancelled: a forward is destroyed (request
 * and reply) and a held handler is told through `route.signal`. `close()` enters a terminal closing state at once (nothing new is
 * dispatched or forwarded; a request arriving then is recorded as `closed`), cancels everything still live, destroys its connections and
 * forwards, JOINS all of them (the dispatches, each forwarded request with its socket, each connection) within a harness bound, and closes
 * the listener. It is idempotent (repeated and concurrent calls share one close), joins a start still in progress, and REJECTS naming what
 * stayed open, so a fixture's cleanup reports it.
 */
export function createScriptedOrigin(options: {
  stamp: () => TransportStamp;
  fallback: string;
  closeBoundMs?: number;
}) {
  const closeBoundMs = options.closeBoundMs ?? ORIGIN_CLOSE_BOUND_MS;
  const handlers: Array<{ glob: string; re: RegExp; handler: Handler }> = [];
  const receipts: OriginReceipt[] = [];
  const errors: string[] = [];
  const connections = new Set<Socket>();
  const live = new Map<
    Promise<void>,
    { what: string; controller: AbortController }
  >();
  const upstreams = new Set<OwnedUpstream>();
  let state: "new" | "starting" | "listening" | "closing" | "closed" = "new";
  let starting: Promise<string> | null = null;
  let closing: Promise<void> | null = null;
  const ending = () => state === "closing" || state === "closed";

  const cancelled = (
    receipt: OriginReceipt,
    res: ServerResponse,
    signal: AbortSignal,
  ) => {
    receipt.outcome = "cancelled";
    receipt.cancelledBy = String(
      (signal.reason as Error | undefined)?.message ?? signal.reason,
    );
    res.destroy();
  };
  const late = (receipt: OriginReceipt, what: Decision) => {
    receipt.late = [...(receipt.late ?? []), what];
    // After a downstream's own close a late answer is merely discarded (recorded on the receipt); after the ORIGIN closed it is a
    // handler that outlived its owner, and fails the case.
    if (ending())
      errors.push(
        `late ${what} of ${receipt.method} ${receipt.url} after the origin closed (discarded, not written)`,
      );
  };

  /** A fallback forward, owned until the forwarded request and its socket have closed. */
  const forward = (
    req: OriginRequest,
    res: ServerResponse,
    receipt: OriginReceipt,
    body: Buffer,
    signal: AbortSignal,
  ) =>
    new Promise<void>((resolve) => {
      const target = new URL(options.fallback);
      const upstream = httpRequest({
        host: target.hostname,
        port: target.port,
        method: req.method(),
        path: new URL(req.url()).pathname + new URL(req.url()).search,
        headers: req.headers(),
        agent: false,
      });
      const owned = ownUpstream(upstream);
      upstreams.add(owned);
      let reply: IncomingMessage | null = null;
      const abandon = () => {
        receipt.forward ??= "abandoned";
        upstream.destroy();
        reply?.destroy();
        res.destroy();
      };
      upstream.on("response", (answer) => {
        reply = answer;
        if (signal.aborted) {
          answer.destroy();
          return;
        }
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
        answer.on("end", () => {
          receipt.forward ??= "completed";
        });
        answer.on("error", () => res.destroy());
      });
      upstream.on("error", (error: NodeJS.ErrnoException) => {
        receipt.forward ??= signal.aborted
          ? "abandoned"
          : `error ${error.code ?? error.message}`;
        res.destroy();
      });
      if (signal.aborted) abandon();
      else signal.addEventListener("abort", abandon, { once: true });
      upstream.end(body);
      void owned.done().then(() => {
        signal.removeEventListener("abort", abandon);
        upstreams.delete(owned);
        resolve();
      });
    });

  const dispatch = async (
    req: OriginRequest,
    res: ServerResponse,
    receipt: OriginReceipt,
    body: Buffer,
    signal: AbortSignal,
  ) => {
    for (const { re, handler, glob } of [...handlers].reverse()) {
      if (!re.test(req.url())) continue;
      if (signal.aborted) return cancelled(receipt, res, signal);
      const route = new OriginRoute(req, res, signal, (what) =>
        late(receipt, what),
      );
      try {
        await Promise.resolve(handler(route, req));
        const decision = await route.decision;
        if (decision === "fallback") continue;
        if (decision === "cancelled") return cancelled(receipt, res, signal);
        receipt.outcome = decision;
        return;
      } catch (error) {
        errors.push(`${glob}: ${String(error)}`);
        receipt.outcome = "handler_error";
        if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
        return;
      }
    }
    if (signal.aborted) return cancelled(receipt, res, signal);
    receipt.outcome = "unrouted";
    await forward(req, res, receipt, body, signal);
  };

  const server = createServer((incoming, res) => {
    const chunks: Buffer[] = [];
    const stamped = options.stamp();
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const req = new OriginRequest(incoming, body);
      const receipt: OriginReceipt = {
        ...stamped,
        method: req.method(),
        url: req.url(),
        bodyBytes: body.length,
        bodySha256: createHash("sha256").update(body).digest("hex"),
        at: Date.now(),
      };
      receipts.push(receipt);
      if (ending()) {
        receipt.outcome = "closed";
        res.destroy();
        return;
      }
      const controller = new AbortController();
      const abandoned = () => {
        receipt.downstreamClosed = true;
        controller.abort(new Error("the downstream closed first"));
      };
      if (res.destroyed) abandoned();
      else
        res.once("close", () => {
          if (!res.writableFinished) abandoned();
        });
      const run: Promise<void> = dispatch(
        req,
        res,
        receipt,
        body,
        controller.signal,
      ).catch((error: unknown) => {
        errors.push(
          `dispatch of ${receipt.method} ${receipt.url}: ${String(error)}`,
        );
        res.destroy();
      });
      live.set(run, {
        what: `${receipt.method} ${receipt.url}`,
        controller,
      });
      void run.then(() => live.delete(run));
    });
  });
  server.on("connection", (socket: Socket) => {
    if (ending()) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });

  let url: string | null = null;
  return {
    start(): Promise<string> {
      if (state !== "new")
        return Promise.reject(
          new Error(`scripted origin: start() in state ${state}`),
        );
      state = "starting";
      starting = new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }).then(() => {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("scripted origin: no port");
        url = `http://127.0.0.1:${address.port}`;
        if (state === "starting") state = "listening";
        return url;
      });
      return starting;
    },
    get url() {
      return url;
    },
    route(glob: string, handler: Handler): Promise<void> {
      handlers.push({ glob, re: globRegExp(glob), handler });
      return Promise.resolve();
    },
    receipts,
    errors,
    /** What it still owns (for the cleanup controls and the ledger). */
    owned: () => ({
      state,
      listening: server.listening,
      dispatches: [...live.values()].map((l) => l.what),
      upstreams: [...upstreams].filter((o) => o.open).length,
      connections: connections.size,
    }),
    close(): Promise<void> {
      closing ??= (async () => {
        state = "closing";
        if (starting !== null) await starting.catch(() => undefined);
        const reason = new Error("the scripted origin closed");
        for (const { controller } of live.values()) controller.abort(reason);
        for (const owned of upstreams) owned.request.destroy();
        for (const socket of connections) socket.destroy();
        const joined = await settlesWithin(
          Promise.all([
            ...live.keys(),
            ...[...upstreams].map((o) => o.done()),
            ...[...connections].map(closedOf),
          ]),
          closeBoundMs,
        );
        const failures: string[] = [];
        if (!joined) {
          const left = [...live.values()].map((l) => l.what);
          failures.push(
            `scripted origin: still open ${closeBoundMs} ms after cancellation: ${left.length} dispatch(es) [${left.join(", ")}], ${[...upstreams].filter((o) => o.open).length} forwarded request(s), ${connections.size} connection(s)`,
          );
        }
        if (server.listening) {
          // Bounded too: the listener's close waits for every connection, so a connection the joins above could not end must be
          // REPORTED, not left to hang the case's teardown.
          let error: Error | undefined;
          const listenerClosed = await settlesWithin(
            new Promise<void>((resolve) =>
              server.close((e) => {
                error = e ?? undefined;
                resolve();
              }),
            ),
            closeBoundMs,
          );
          if (!listenerClosed)
            failures.push(
              `scripted origin listener: still waiting for ${connections.size} connection(s) ${closeBoundMs} ms after close`,
            );
          else if (error !== undefined)
            failures.push(`scripted origin listener: ${String(error)}`);
        }
        state = "closed";
        if (failures.length > 0) throw new Error(failures.join("; "));
      })();
      return closing;
    },
  };
}
export type ScriptedOrigin = ReturnType<typeof createScriptedOrigin>;

/**
 * The UI connectivity stimulus, installed before any document of the lane boots: `navigator.onLine` reads the stimulus when one is set
 * and the engine's own value otherwise. Each document has its own id and starts with NO stimulus; setting it dispatches the
 * `online`/`offline` event the application listens for. A stimulus never outlives its document, and never blocks HTTP.
 */
function installUiStimulus() {
  const proto = Navigator.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "onLine");
  const native = descriptor?.get;
  if (native === undefined) throw new Error("no navigator.onLine getter");
  let stimulus: boolean | null = null;
  const doc =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `doc-${Math.random()}`;
  Object.defineProperty(proto, "onLine", {
    configurable: true,
    get() {
      return stimulus === null ? native.call(this) : stimulus;
    },
  });
  const read = () => ({
    document: doc,
    native: native.call(navigator) as boolean,
    ui: navigator.onLine,
    stimulus,
  });
  Object.defineProperty(window, "__atlasUiConnectivity", {
    configurable: false,
    value: Object.freeze({
      read,
      set(online: boolean) {
        stimulus = online;
        window.dispatchEvent(new Event(online ? "online" : "offline"));
        return read();
      },
    }),
  });
}

type UiApi = {
  read(): UiRecord;
  set(online: boolean): UiRecord;
};

// ---- Revision 19: the journal and its classification (F23-1) ------------------------------------------------------------------------

/**
 * A problem's category, from its type and the engine's exact wording (nothing else): a page error (`exception`); a `warning`; an engine's
 * HTTP-status message (`http`); an engine's network-failure message (`network`); `other`.
 */
export type ProblemCategory =
  | "exception"
  | "warning"
  | "http"
  | "network"
  | "other";

/** Chromium and WebKit: "Failed to load resource: the server responded with a status of 422 (…)", located at the resource. */
const HTTP_STATUS =
  /^Failed to load resource: the server responded with a status of (\d{3})\b/;
/** Chromium's failed request (located at the resource): "Failed to load resource: net::ERR_EMPTY_RESPONSE". */
const CHROMIUM_NETWORK = /^Failed to load resource: net::ERR_[A-Z_]+$/;
/** WebKit's request whose connection the front destroyed (located at the resource). */
const WEBKIT_NETWORK =
  /^Failed to load resource: The network connection was lost\.$/;
/**
 * Firefox logs no message for a failed fetch (its rejection is the page's to handle); it logs a failed FONT download, naming the resource
 * in its text (the location is empty). Only the network status observed for a destroyed connection counts: NS_ERROR_NET_RESET.
 */
const FIREFOX_FONT =
  /^\[JavaScript Error: "downloadable font: download failed \(.*\): status=(\d+) source: (\S+?)"\]$/;
const FIREFOX_NETWORK_STATUSES = new Set([2152398868]);

export function categorise(
  type: string,
  text: string,
  location: string,
): { category: ProblemCategory; url: string; status?: number } {
  if (type === "pageerror") return { category: "exception", url: location };
  if (type === "warning") return { category: "warning", url: location };
  if (type !== "error") return { category: "other", url: location };
  const http = HTTP_STATUS.exec(text);
  if (http !== null)
    return { category: "http", url: location, status: Number(http[1]) };
  if (CHROMIUM_NETWORK.test(text) || WEBKIT_NETWORK.test(text))
    return { category: "network", url: location };
  const font = FIREFOX_FONT.exec(text);
  if (font !== null && FIREFOX_NETWORK_STATUSES.has(Number(font[1])))
    return { category: "network", url: font[2] as string };
  return { category: "other", url: location };
}

export interface Problem {
  /** The lane-wide journal sequence when this process observed it. */
  seq: number;
  page: number;
  /** The page's document when observed: it moves on at each main-frame navigation's response. */
  document: number;
  type: string;
  text: string;
  /** The message's location, or (Firefox's font message) the resource its text names. */
  url: string;
  category: ProblemCategory;
  status?: number;
  /** The transport's stamp when observed: an audit field, never attribution authority. */
  observed: TransportStamp;
}

export type RequestTerminal =
  | { seq: number; kind: "response"; status: number }
  | { seq: number; kind: "failed"; errorText: string };

export interface RequestRecord {
  /** The journal sequence of the browser's `request` event. */
  seq: number;
  page: number;
  document: number;
  method: string;
  url: string;
  /** A main-frame navigation (its response starts the page's next document). */
  navigation: boolean;
  observed: TransportStamp;
  /** The request's FIRST end: its response (headers) or its failure. */
  terminal: RequestTerminal | null;
  failedAfterResponse?: { seq: number; errorText: string };
  finishedSeq?: number;
}

export interface AttemptRecord {
  /** The journal sequence when the front recorded the attempt (synchronously, as it arrived). */
  seq: number;
  attempt: TransportAttempt;
}

export interface HttpExpectation {
  id: number;
  /** Declared at this journal sequence: only requests issued later can meet it. */
  seq: number;
  method: string;
  /** The request URL's path: exactly, or matched by the expression. */
  path: string | RegExp;
  status: number;
  /** Exactly this many requests: fewer or more fails the case. */
  count: number;
  reason: string;
}

export interface Journal {
  problems: Problem[];
  requests: RequestRecord[];
  attempts: AttemptRecord[];
  expectations: HttpExpectation[];
}

export interface Classified extends Problem {
  verdict: "expected" | "unexpected";
  reason: string;
  evidence?: {
    request: number;
    attempts: number[];
    generations: number[];
    expectation?: number;
  };
}

export interface RequestAttribution {
  seq: number;
  page: number;
  document: number;
  method: string;
  url: string;
  terminal: RequestTerminal | null;
  /** Journal sequences of the front attempts assigned to it. */
  attempts: number[];
  /** Failed, every one of its (one or more) attempts dropped in a loss, and not ambiguous. */
  loss: boolean;
  ambiguous: boolean;
  /** The expectation it met, if any. */
  declared: number | null;
  reason: string;
}

export interface LaneVerdict {
  /** Every problem exactly once, in journal order, with its verdict and reason. */
  problems: Classified[];
  expected: Classified[];
  unexpected: Classified[];
  requests: RequestAttribution[];
  /** Front attempts that no browser request of a lane page ended after (recorded; not themselves failures). */
  unassignedAttempts: number[];
  expectations: Array<{
    id: number;
    method: string;
    path: string;
    status: number;
    count: number;
    reason: string;
    matched: number[];
    excess: number[];
    uncorroborated: number[];
  }>;
  /** Failures that are not single problems: an unmet, exceeded or unattributable declaration. */
  violations: string[];
}

const requestKey = (method: string | undefined, url: string | undefined) =>
  `${method ?? "?"} ${url ?? "?"}`;
const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};
const pathMatches = (path: string | RegExp, url: string) =>
  typeof path === "string" ? pathOf(url) === path : path.test(pathOf(url));

/**
 * Judges every problem of a lane's journal (pure and repeatable: no mutable credit outlives one call). See the module comment for the
 * rules; every exclusion carries its reason and evidence.
 */
export function classifyJournal(journal: Journal): LaneVerdict {
  // 1. Front attempts to browser requests. For one method and URL, every attempt belongs to the request of that method and URL whose
  //    end the journal records next (an attempt precedes its request's end: the front answers or drops it first). A request open across
  //    another's end of the same method and URL makes both ambiguous: their attempts cannot be told apart.
  const events = new Map<
    string,
    Array<{ seq: number; attempt?: AttemptRecord; request?: RequestRecord }>
  >();
  const add = (
    key: string,
    event: { seq: number; attempt?: AttemptRecord; request?: RequestRecord },
  ) => {
    const list = events.get(key) ?? [];
    list.push(event);
    events.set(key, list);
  };
  for (const a of journal.attempts)
    add(requestKey(a.attempt.method, a.attempt.url), {
      seq: a.seq,
      attempt: a,
    });
  for (const r of journal.requests)
    if (r.terminal !== null)
      add(requestKey(r.method, r.url), { seq: r.terminal.seq, request: r });
  const segment = new Map<RequestRecord, AttemptRecord[]>();
  const ambiguous = new Set<RequestRecord>();
  const unassigned: AttemptRecord[] = [];
  for (const [key, list] of events) {
    list.sort((x, y) => x.seq - y.seq);
    let pending: AttemptRecord[] = [];
    for (const event of list) {
      if (event.attempt !== undefined) {
        pending.push(event.attempt);
        continue;
      }
      const r = event.request as RequestRecord;
      const end = (r.terminal as RequestTerminal).seq;
      segment.set(r, pending);
      pending = [];
      for (const other of journal.requests)
        if (
          other !== r &&
          requestKey(other.method, other.url) === key &&
          other.seq < end &&
          (other.terminal === null || other.terminal.seq > end)
        ) {
          ambiguous.add(r);
          ambiguous.add(other);
        }
    }
    unassigned.push(...pending);
  }

  // 2. Each request's own attribution.
  const attribution = new Map<RequestRecord, RequestAttribution>();
  for (const r of journal.requests) {
    const attempts = segment.get(r) ?? [];
    const isAmbiguous = ambiguous.has(r);
    let reason: string;
    let loss = false;
    if (r.terminal === null) reason = "never ended";
    else if (r.terminal.kind === "response")
      reason = `answered ${r.terminal.status}`;
    else if (isAmbiguous)
      reason =
        "failed, overlapping another request of the same method and URL (ambiguous)";
    else if (attempts.length === 0)
      reason = "failed without reaching the front (no attempt)";
    else if (
      !attempts.every(
        (a) => a.attempt.outcome === "lost" && a.attempt.phase === "loss",
      )
    )
      reason = `failed after the front ${[...new Set(attempts.map((a) => `${a.attempt.outcome} (${a.attempt.phase})`))].join(", ")}`;
    else {
      loss = true;
      reason = `dropped by the front in loss generation(s) ${[...new Set(attempts.map((a) => a.attempt.generation))].join(", ")}`;
    }
    attribution.set(r, {
      seq: r.seq,
      page: r.page,
      document: r.document,
      method: r.method,
      url: r.url,
      terminal: r.terminal,
      attempts: attempts.map((a) => a.seq),
      loss,
      ambiguous: isAmbiguous,
      declared: null,
      reason,
    });
  }

  // 3. Declared HTTP expectations: each takes exactly `count` later requests of its method, path and status, corroborated by the front
  //    having seen that status for one of the request's own attempts.
  const violations: string[] = [];
  const taken = new Set<RequestRecord>();
  const expectations: LaneVerdict["expectations"] = [];
  const bySeq = [...journal.requests].sort((x, y) => x.seq - y.seq);
  for (const e of [...journal.expectations].sort((x, y) => x.seq - y.seq)) {
    const out = {
      id: e.id,
      method: e.method,
      path: String(e.path),
      status: e.status,
      count: e.count,
      reason: e.reason,
      matched: [] as number[],
      excess: [] as number[],
      uncorroborated: [] as number[],
    };
    for (const r of bySeq) {
      if (
        taken.has(r) ||
        r.seq < e.seq ||
        r.method !== e.method ||
        !pathMatches(e.path, r.url) ||
        r.terminal?.kind !== "response" ||
        r.terminal.status !== e.status
      )
        continue;
      const own = attribution.get(r) as RequestAttribution;
      const seen = (segment.get(r) ?? []).some(
        (a) =>
          a.attempt.outcome === "forwarded" && a.attempt.status === e.status,
      );
      if (own.ambiguous || !seen) {
        out.uncorroborated.push(r.seq);
        continue;
      }
      if (out.matched.length < e.count) {
        out.matched.push(r.seq);
        own.declared = e.id;
        taken.add(r);
      } else out.excess.push(r.seq);
    }
    const label = `declared HTTP ${e.status} for ${e.method} ${String(e.path)} (${e.reason})`;
    if (out.matched.length !== e.count)
      violations.push(
        `${label}: ${out.matched.length} of the declared ${e.count} response(s)`,
      );
    if (out.excess.length > 0)
      violations.push(
        `${label}: ${out.excess.length} response(s) beyond the declared ${e.count}`,
      );
    if (out.uncorroborated.length > 0)
      violations.push(
        `${label}: ${out.uncorroborated.length} matching response(s) the front's own record cannot attribute`,
      );
    expectations.push(out);
  }

  // 4. Every problem, once, in journal order. A message can only be its own page and document's, for a request that started before it
  //    and ended after that page/document/URL's previous message of the same category; at most one message per request.
  const credited = new Set<RequestRecord>();
  const previous = new Map<string, number>();
  const problems: Classified[] = [];
  for (const p of [...journal.problems].sort((x, y) => x.seq - y.seq)) {
    const out = (
      verdict: "expected" | "unexpected",
      reason: string,
      evidence?: Classified["evidence"],
    ) =>
      problems.push({
        ...p,
        verdict,
        reason,
        ...(evidence ? { evidence } : {}),
      });
    if (p.category === "exception") {
      out("unexpected", "a page error always fails, whatever it names");
      continue;
    }
    if (p.category === "warning") {
      out("unexpected", "a warning always fails");
      continue;
    }
    if (p.category === "other") {
      out(
        "unexpected",
        "not an engine's network-failure or HTTP-status message for a request",
      );
      continue;
    }
    const scope = `${p.category} ${p.page}/${p.document} ${p.url}`;
    const since = previous.get(scope) ?? -1;
    previous.set(scope, p.seq);
    const candidates = journal.requests.filter(
      (r) =>
        r.page === p.page &&
        r.document === p.document &&
        r.url === p.url &&
        r.seq < p.seq &&
        r.terminal !== null &&
        r.terminal.seq > since &&
        !credited.has(r) &&
        (p.category === "network"
          ? r.terminal.kind === "failed"
          : r.terminal.kind === "response" && r.terminal.status === p.status),
    );
    if (candidates.length === 0) {
      out(
        "unexpected",
        p.category === "network"
          ? "no failed request of this page's document for this URL (an earlier one is already accounted for, or none)"
          : `no ${p.status} response of this page's document for this URL`,
      );
      continue;
    }
    const own = (r: RequestRecord) => attribution.get(r) as RequestAttribution;
    const unfit = candidates.filter((r) =>
      p.category === "network" ? !own(r).loss : own(r).declared === null,
    );
    if (unfit.length > 0) {
      out(
        "unexpected",
        p.category === "network"
          ? `a candidate request was not a transport loss: ${unfit.map((r) => `#${r.seq} ${own(r).reason}`).join("; ")}`
          : `HTTP ${p.status} of ${unfit.map((r) => `#${r.seq} ${r.method}`).join(", ")} was not declared`,
      );
      continue;
    }
    const nearest = candidates.reduce((best, r) =>
      Math.abs((r.terminal as RequestTerminal).seq - p.seq) <
      Math.abs((best.terminal as RequestTerminal).seq - p.seq)
        ? r
        : best,
    );
    credited.add(nearest);
    const attempts = segment.get(nearest) ?? [];
    out(
      "expected",
      p.category === "network"
        ? `request #${nearest.seq} ${own(nearest).reason}`
        : `request #${nearest.seq} met declaration ${own(nearest).declared}`,
      {
        request: nearest.seq,
        attempts: attempts.map((a) => a.seq),
        generations: [...new Set(attempts.map((a) => a.attempt.generation))],
        ...(p.category === "http"
          ? { expectation: own(nearest).declared as number }
          : {}),
      },
    );
  }
  return {
    problems,
    expected: problems.filter((p) => p.verdict === "expected"),
    unexpected: problems.filter((p) => p.verdict === "unexpected"),
    requests: journal.requests.map(
      (r) => attribution.get(r) as RequestAttribution,
    ),
    unassignedAttempts: unassigned.map((a) => a.seq),
    expectations,
    violations,
  };
}

export interface TransportLane {
  browser: Browser;
  context: BrowserContext;
  /** The fixture lane only: a context whose `route` registers on the scripted origin (give it to `bootAt`'s `routes`). */
  routes: BrowserContext;
  transport: Transport;
  witness: WitnessOrigin;
  origin: ScriptedOrigin | null;
  /** Waits (bounded) until nothing forwarded is outstanding, enters a loss in the same turn, and requires that nothing was interrupted. */
  lose(): Promise<LossRecord>;
  /** Ends the loss and returns the interval's violations (`intervalViolations` of the loss just ended). */
  restore(): Promise<string[]>;
  /** Any origin receipt, or any request the front did not drop, stamped with that loss's generation. */
  intervalViolations(loss: LossRecord): string[];
  /** One uncached request from `page` with a fresh nonce (`abortBeforeSend`: a fetch that never leaves the page, a negative). */
  probe(
    page: Page,
    options?: {
      kind?: "probe" | "cacheable";
      abortBeforeSend?: boolean;
      nonce?: string;
    },
  ): Promise<ProbeResult>;
  /** The violations of a probe judged as `expected` (empty: it shows what it should). */
  judge(result: ProbeResult, expected: "online" | "loss"): string[];
  ui: {
    read(page: Page): Promise<UiRecord>;
    set(page: Page, online: boolean): Promise<UiRecord>;
  };
  /**
   * Declares, BEFORE the operation, that exactly `count` later requests of `method` to `path` (exact, or matched) answer `status` on
   * purpose; the engine's message about each is then expected, nothing else's (revision 19, in place of a test-wide status allowance).
   */
  expectHttp(expectation: Omit<HttpExpectation, "id" | "seq">): void;
  /** The journal so far (append-only). */
  journal: Journal;
  /** The current classification of the journal (pure: recomputed each call). */
  verdict(): LaneVerdict;
  /** Requests of the lane's pages to any origin but the front (each fails the case: the loss would not cover them). */
  foreign: string[];
  /** Declares one exact `METHOD url` outside the lane's origin as provoked on purpose (the check's own negative); others still fail. */
  declareForeign(entry: string): void;
  undeclaredForeign(): string[];
  /** Everything recorded, without request bodies (for the report). */
  ledger(): unknown;
}

/** How long a loss entry waits for outstanding forwarded requests to finish before the set-up fails (a harness bound, not a duration under test). */
const QUIESCE_BOUND_MS = 15_000;

const CONTEXT_KEYS = [
  "baseURL",
  "viewport",
  "userAgent",
  "deviceScaleFactor",
  "isMobile",
  "hasTouch",
  "locale",
  "timezoneId",
  "colorScheme",
] as const;

/** One owned resource's disposer, registered BEFORE the resource is acquired (a partial start is still closed). */
export interface CleanupStep {
  label: string;
  run: () => Promise<unknown>;
}

/** How long one disposer may run before settlement reports it and moves on (a harness bound, not a duration under test). */
const DISPOSE_BOUND_MS = 10_000;
/** How long settlement waits for admitted opens and their pending acquisitions (a harness bound, not a duration under test). */
const JOIN_BOUND_MS = 10_000;

/**
 * Revision 20 (Review 24 F24-1, design assessment correction 1–2): the stages of opening a lane, in order. Each is admitted, owned and
 * gated by the open's scope; `publication` is the hand-over of a finished lane to its manager.
 */
export type OpenStage =
  | "witness"
  | "scripted origin"
  | "front"
  | "context"
  | "init script"
  | "publication";

/**
 * A QUALIFICATION seam only (default: none): wraps each stage. `acquire` performs the stage's real acquisition, and refuses to begin once
 * settlement has begun; a control can hold before or after it, release, or reject. Never used by an application case.
 */
export type Interpose = <T>(
  stage: OpenStage,
  acquire: () => Promise<T>,
) => Promise<T>;

export interface TransportLanesOptions {
  /** Bound on joining admitted opens and their pending acquisitions once settlement begins (default 10,000 ms). */
  joinBoundMs?: number;
  /** Bound on each disposer (default 10,000 ms). */
  disposeBoundMs?: number;
  interpose?: Interpose;
  /** Where an outcome arriving AFTER the report was returned is written (default: the worker's stderr); it is also kept in `late`. */
  onLate?: (line: string) => void;
}

/** A stage refused because settlement began (the open is cancelled, never published). */
export class LaneCancelled extends Error {
  override name = "LaneCancelled";
}

type Outcome<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "pending"; later: Promise<Outcome<T>> };

/** Runs `run` and reports what it did within `ms`; a pending one keeps its eventual outcome (`later`). */
async function within<T>(
  run: () => Promise<T>,
  ms: number,
): Promise<Outcome<T>> {
  const settled: Promise<Outcome<T>> = (async () => {
    try {
      return { kind: "value", value: await run() } as const;
    } catch (error) {
      return { kind: "error", error } as const;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "pending", later: settled }),
      Math.max(0, ms),
    );
  });
  const first = await Promise.race([settled, pending]);
  clearTimeout(timer);
  return first;
}

/** A disposer's failure, if any: a thrown error, a resolved Error, or still running at its bound (its eventual outcome goes to `late`). */
async function runStep(
  step: CleanupStep,
  boundMs: number,
  late?: (line: string) => void,
): Promise<string | null> {
  const outcome = await within(step.run, boundMs);
  if (outcome.kind === "error")
    return `${step.label}: ${String(outcome.error)}`;
  if (outcome.kind === "value")
    return outcome.value instanceof Error
      ? `${step.label}: ${String(outcome.value)}`
      : null;
  void outcome.later.then((o) =>
    late?.(
      `${step.label}: its close ended after its bound (${o.kind === "error" ? String(o.error) : o.kind === "value" && o.value instanceof Error ? String(o.value) : "closed"})`,
    ),
  );
  return `${step.label}: still running ${boundMs} ms after it began`;
}

/** One stage's holding: owned from admission, before its acquisition starts. */
interface Holding {
  stage: OpenStage;
  state: "acquiring" | "acquired" | "failed" | "disposed" | "dispose_failed";
  arrived: Promise<void>;
  handle?: unknown;
  error?: string;
  late?: boolean;
  dispose: ((handle: unknown) => Promise<unknown>) | null;
  /** The ONE disposal of this holding (shared by every caller: an open's own unwinding and settlement). */
  disposal?: Promise<string | null>;
}

/** One admitted open: registered synchronously at admission, whether or not it ever produces a lane. */
interface OpenRecord {
  id: number;
  stage: OpenStage | "admitted";
  stages: Array<{ stage: OpenStage | "admitted"; at: number }>;
  outcome: "opening" | "published" | "cancelled" | "failed";
  error: string | null;
  done: Promise<void>;
  holdings: Holding[];
}

/**
 * The scope of one open (design assessment correction 2): every stage is ADMITTED only while the manager is open, OWNED (with its
 * disposer) before its acquisition starts, and its result is owned the moment it arrives; after each stage, the open stops if settlement
 * has begun (no further listener, context set-up, stage or publication). Disposal is in reverse order of admission.
 */
class OpenScope {
  constructor(
    readonly record: OpenRecord,
    private readonly closing: () => boolean,
    private readonly interpose: Interpose,
  ) {}

  gate(stage: OpenStage, when: "before" | "after" | "at"): void {
    if (this.closing())
      throw new LaneCancelled(
        `open ${this.record.id} cancelled ${when} ${stage}: settlement began while it was opening`,
      );
  }

  acquire<T>(
    stage: OpenStage,
    start: () => Promise<T>,
    dispose: ((handle: T) => Promise<unknown>) | null,
    gateAfter = true,
  ): Promise<T> {
    this.gate(stage, "before");
    this.record.stage = stage;
    this.record.stages.push({ stage, at: Date.now() });
    const holding: Holding = {
      stage,
      state: "acquiring",
      arrived: Promise.resolve(),
      dispose: dispose as Holding["dispose"],
    };
    this.record.holdings.push(holding);
    const begun = new Promise<T>((resolve) =>
      resolve(
        this.interpose(stage, () => {
          this.gate(stage, "before");
          return start();
        }),
      ),
    );
    // Observed at once: the result is owned when it arrives, and a rejection is recorded, whoever (if anyone) awaits the open.
    holding.arrived = begun.then(
      (handle) => {
        holding.state = "acquired";
        holding.handle = handle;
      },
      (error) => {
        holding.state = "failed";
        holding.error = String(error);
      },
    );
    return begun.then((handle) => {
      if (gateAfter) this.gate(stage, "after");
      return handle;
    });
  }

  private async disposeHolding(
    holding: Holding,
    boundMs: number,
    late: (line: string) => void,
  ): Promise<string | null> {
    if (holding.disposal !== undefined) return holding.disposal;
    if (holding.state !== "acquired" || holding.dispose === null) return null;
    const dispose = holding.dispose;
    holding.disposal = runStep(
      {
        label: `open ${this.record.id} ${holding.stage}`,
        run: () => dispose(holding.handle),
      },
      boundMs,
      late,
    ).then((failure) => {
      holding.state = failure === null ? "disposed" : "dispose_failed";
      return failure;
    });
    return holding.disposal;
  }

  /** Disposes every holding, newest first, attempting each whatever the others did; a pending acquisition is joined within `deadline`. */
  async dispose(
    deadline: number,
    boundMs: number,
    late: (line: string) => void,
  ): Promise<string[]> {
    const errors: string[] = [];
    for (const holding of [...this.record.holdings].reverse()) {
      if (holding.state === "acquiring") {
        const arrived = await settlesWithin(
          holding.arrived,
          Math.max(0, deadline - Date.now()),
        );
        if (!arrived) {
          // Not cancelled by the bound: still owned. Its result is disposed (or its rejection recorded) when it arrives.
          holding.late = true;
          errors.push(
            `open ${this.record.id}: ${holding.stage} acquisition still pending when settlement's join bound ended (its result will be disposed when it arrives)`,
          );
          void holding.arrived.then(async () => {
            if (holding.state === "failed")
              late(
                `open ${this.record.id}: late ${holding.stage} rejected after settlement: ${holding.error}`,
              );
            else {
              const failure = await this.disposeHolding(holding, boundMs, late);
              late(
                `open ${this.record.id}: late ${holding.stage} arrived after settlement; ${failure === null ? "disposed" : `dispose failed: ${failure}`}`,
              );
            }
          });
          continue;
        }
      }
      const failure = await this.disposeHolding(holding, boundMs, late);
      if (failure !== null) errors.push(failure);
    }
    return errors;
  }
}

async function openLane(
  options: TransportLaneOptions,
  browser: Browser,
  testInfo: TestInfo,
  scope: OpenScope,
): Promise<TransportLane> {
  if ("provokes" in (options as unknown as Record<string, unknown>))
    throw new Error(
      "native transport lane: `provokes` was removed in revision 19; declare each HTTP status with lane.expectHttp",
    );
  const use = testInfo.project.use as Record<string, unknown>;
  // The project's server: the fixture preview, or (integration) the preview in front of the delaying proxy and the released backend.
  const base = new URL(String(use.baseURL ?? "")).origin;
  let clock = 0;
  const next = () => {
    clock += 1;
    return clock;
  };
  const journal: Journal = {
    problems: [],
    requests: [],
    attempts: [],
    expectations: [],
  };
  let transport: Transport | null = null;
  const stamp = (): TransportStamp =>
    transport?.stamp() ?? { generation: 0, phase: "online", nonce: null };
  // Revision 20 (F24-1): each stage is admitted, owned and gated by the open's scope (its disposer is registered before it starts).
  const witness = createWitnessOrigin({ stamp });
  const witnessUrl = await scope.acquire(
    "witness",
    () => witness.start(),
    () => witness.close(),
  );
  let origin: ScriptedOrigin | null = null;
  const routes = [
    { name: "witness", prefix: "/__transport/", target: witnessUrl },
  ];
  if (options.mode === "fixture") {
    const scripted = createScriptedOrigin({ stamp, fallback: base });
    origin = scripted;
    const originUrl = await scope.acquire(
      "scripted origin",
      () => scripted.start(),
      () => scripted.close(),
    );
    routes.push(
      { name: "api", prefix: "/api/", target: originUrl },
      { name: "health", prefix: "/health", target: originUrl },
    );
  }
  // The released backend accepts a browser request only with its configured public origin (ATLAS_PUBLIC_ORIGIN, the preview's: the
  // backend's browser.rs `origin`); the front presents it in place of its own, as a reverse proxy serving that origin would.
  routes.push({
    name: "app",
    prefix: "/",
    target: base,
    ...(options.mode === "integration" ? { presentOrigin: base } : {}),
  });
  const owned = createTransport({
    routes,
    observe: (attempt) => journal.attempts.push({ seq: next(), attempt }),
  });
  transport = owned;
  const front = await scope.acquire(
    "front",
    () => owned.start(),
    () => owned.close(),
  );
  const contextOptions: BrowserContextOptions = {};
  for (const key of CONTEXT_KEYS)
    if (use[key] !== undefined)
      (contextOptions as Record<string, unknown>)[key] = use[key];
  // The lane's context talks to the FRONT origin directly (no browser proxy setting): the front carries all of the application's HTTP.
  contextOptions.baseURL = front;
  // Owned BEFORE `newContext` is called: a context that arrives after settlement began is closed, never published (F24-1).
  const context = await scope.acquire(
    "context",
    () => browser.newContext(contextOptions),
    (c) => c.close(),
  );
  // Playwright's own `trace: retain-on-failure` instrumentation already records every context a test creates, this one included.
  const foreign: string[] = [];
  const declaredForeign = new Set<string>();
  context.on("request", (request) => {
    const url = request.url();
    if (/^(data|blob):/.test(url)) return;
    if (new URL(url).origin !== front)
      foreign.push(`${request.method()} ${url}`);
  });
  await scope.acquire(
    "init script",
    () => context.addInitScript(installUiStimulus),
    null,
  );
  const refuse = (what: string) => () => {
    throw new Error(
      `native transport lane: ${what} would answer without the network (a fixture route is not transport evidence)`,
    );
  };
  const ownContext = context as unknown as Record<string, unknown>;
  ownContext.route = refuse("context.route");
  ownContext.routeFromHAR = refuse("context.routeFromHAR");
  ownContext.setOffline = refuse(
    "context.setOffline (WebKit's emulation fails File reads)",
  );
  let pageIndex = 0;
  context.on("page", (page) => {
    const own = page as unknown as Record<string, unknown>;
    own.route = refuse("page.route");
    own.routeFromHAR = refuse("page.routeFromHAR");
    const index = pageIndex++;
    let documentNo = 0;
    const records = new Map<Request, RequestRecord>();
    const mainFrameNavigation = (request: Request) => {
      try {
        return (
          request.isNavigationRequest() && request.frame() === page.mainFrame()
        );
      } catch {
        return false;
      }
    };
    page.on("request", (request) => {
      const record: RequestRecord = {
        seq: next(),
        page: index,
        document: documentNo,
        method: request.method(),
        url: request.url(),
        navigation: mainFrameNavigation(request),
        observed: stamp(),
        terminal: null,
      };
      records.set(request, record);
      journal.requests.push(record);
    });
    page.on("response", (response) => {
      const seq = next();
      const record = records.get(response.request());
      if (record === undefined) return;
      if (record.terminal === null)
        record.terminal = { seq, kind: "response", status: response.status() };
      // A navigation's response begins the page's next document: later messages are that document's, not the previous one's.
      if (record.navigation) documentNo += 1;
    });
    page.on("requestfailed", (request) => {
      const seq = next();
      const record = records.get(request);
      if (record === undefined) return;
      const errorText = request.failure()?.errorText ?? "";
      if (record.terminal === null)
        record.terminal = { seq, kind: "failed", errorText };
      else record.failedAfterResponse = { seq, errorText };
    });
    page.on("requestfinished", (request) => {
      const seq = next();
      const record = records.get(request);
      if (record !== undefined) record.finishedSeq = seq;
    });
    const problem = (type: string, text: string, location: string) => {
      const { category, url, status } = categorise(type, text, location);
      journal.problems.push({
        seq: next(),
        page: index,
        document: documentNo,
        type,
        text,
        url,
        category,
        ...(status !== undefined ? { status } : {}),
        observed: stamp(),
      });
    };
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() === "error" || message.type() === "warning")
        problem(message.type(), message.text(), message.location().url ?? "");
    });
    page.on("pageerror", (error) => problem("pageerror", error.message, ""));
  });
  const routeHost =
    origin === null
      ? context
      : (new Proxy(context, {
          get(target, property) {
            if (property === "route")
              return (glob: string, handler: Handler) =>
                (origin as ScriptedOrigin).route(glob, handler);
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as BrowserContext);
  let current: LossRecord | null = null;
  let expectationId = 0;
  const probes: ProbeResult[] = [];
  const lane: TransportLane = {
    browser,
    context,
    routes: routeHost,
    transport: owned,
    witness,
    origin,
    async lose() {
      // A quiescent entry: wait (a condition, bounded) until nothing forwarded is outstanding, then flip the phase in the SAME turn
      // (`owned.lose` sets it synchronously), so no request can be forwarded in between. A page's own background reads (the sync
      // engine's) are then dropped like every other request of the loss.
      const deadline = Date.now() + QUIESCE_BOUND_MS;
      while (owned.inFlight() > 0) {
        if (Date.now() > deadline)
          throw new Error(
            `native transport lane: still ${owned.inFlight()} forwarded request(s) outstanding after ${QUIESCE_BOUND_MS} ms; no loss entered`,
          );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const record = await owned.lose();
      expect(
        record.interrupted,
        "the loss began with nothing in flight",
      ).toEqual([]);
      current = record;
      return record;
    },
    intervalViolations(loss) {
      const violations: string[] = [];
      for (const r of witness.receipts)
        if (r.generation === loss.generation)
          violations.push(`witness origin received ${r.path} during the loss`);
      for (const r of origin?.receipts ?? [])
        if (r.generation === loss.generation)
          violations.push(
            `scripted origin received ${r.method} ${r.url} during the loss`,
          );
      for (const a of owned.attempts)
        if (a.generation === loss.generation && a.outcome !== "lost")
          violations.push(`front ${a.outcome} ${a.url} during the loss`);
      return violations;
    },
    async restore() {
      const loss = current;
      if (loss === null) throw new Error("not lost");
      const violations = lane.intervalViolations(loss);
      await owned.restore();
      current = null;
      return violations;
    },
    async probe(page, probeOptions = {}) {
      const kind = probeOptions.kind ?? "probe";
      const nonce = probeOptions.nonce ?? randomUUID();
      const result = await page.evaluate(
        async ({ nonce: n, kind: k, abort }) => {
          const api = (
            window as unknown as {
              __atlasUiConnectivity: { read(): unknown };
            }
          ).__atlasUiConnectivity;
          const signal = abort
            ? AbortSignal.abort()
            : AbortSignal.timeout(5_000);
          try {
            const response = await fetch(`/__transport/${k}/${n}`, {
              cache: k === "probe" ? "no-store" : "force-cache",
              signal,
            });
            return {
              ok: response.ok,
              status: response.status,
              body: await response.text(),
              error: null,
              ui: api.read(),
            };
          } catch (error) {
            return {
              ok: false,
              status: null,
              body: null,
              error: (error as Error).name,
              ui: api.read(),
            };
          }
        },
        { nonce, kind, abort: probeOptions.abortBeforeSend === true },
      );
      const out = { kind, nonce, ...result } as ProbeResult;
      probes.push(out);
      return out;
    },
    judge(result, expected) {
      const v: string[] = [];
      const receipts = witness.receipts.filter((r) => r.nonce === result.nonce);
      const seen = owned.attempts.filter((a) =>
        (a.url ?? "").includes(result.nonce),
      );
      if (expected === "online") {
        if (result.status !== 200) v.push(`status ${result.status}`);
        if (result.body !== `witness-${result.nonce}`)
          v.push(`body ${JSON.stringify(result.body)}`);
        if (receipts.length !== 1)
          v.push(`${receipts.length} witness receipts`);
        if (receipts.some((r) => r.phase !== "online"))
          v.push("a witness receipt outside an online phase");
        if (seen.filter((a) => a.outcome === "forwarded").length !== 1)
          v.push(`${seen.length} front attempts, not one forwarded`);
      } else {
        // Judged while the loss is in force: its generation is the current one.
        const generation = owned.generation;
        if (owned.phase !== "loss")
          v.push(`the transport is not lost (phase ${owned.phase})`);
        if (result.error === null || result.status !== null)
          v.push(`the browser request did not fail (status ${result.status})`);
        const during = receipts.filter((r) => r.generation === generation);
        if (during.length !== 0)
          v.push(`${during.length} witness receipts during the loss`);
        if (receipts.length !== during.length)
          v.push(
            `${receipts.length - during.length} earlier witness receipts of this nonce (an answer a cache could hold)`,
          );
        const now = seen.filter((a) => a.generation === generation);
        if (now.length === 0)
          v.push(
            "no front attempt in this loss (never sent, or answered without the network)",
          );
        if (now.some((a) => a.outcome !== "lost"))
          v.push(
            `front attempts ${JSON.stringify(now.map((a) => a.outcome))} in the loss not all dropped`,
          );
      }
      return v;
    },
    ui: {
      read: (page) =>
        page.evaluate(() =>
          (
            window as unknown as { __atlasUiConnectivity: UiApi }
          ).__atlasUiConnectivity.read(),
        ),
      set: (page, online) =>
        page.evaluate(
          (o) =>
            (
              window as unknown as { __atlasUiConnectivity: UiApi }
            ).__atlasUiConnectivity.set(o),
          online,
        ),
    },
    expectHttp(expectation) {
      if (!Number.isInteger(expectation.count) || expectation.count < 1)
        throw new Error("expectHttp: count is a positive integer");
      expectationId += 1;
      journal.expectations.push({
        ...expectation,
        id: expectationId,
        seq: next(),
      });
    },
    journal,
    verdict: () => classifyJournal(journal),
    foreign,
    declareForeign: (entry) => {
      declaredForeign.add(entry);
    },
    undeclaredForeign: () => foreign.filter((f) => !declaredForeign.has(f)),
    ledger: () => ({
      transitions: owned.transitions,
      attempts: journal.attempts.map(({ seq, attempt }) => ({
        journal: seq,
        ...attempt,
      })),
      interrupted: owned.interrupted,
      witness: witness.receipts,
      origin: origin?.receipts ?? null,
      originErrors: origin?.errors ?? null,
      originOwned: origin?.owned() ?? null,
      frontOwned: owned.owned(),
      foreign,
      probes,
      expectations: journal.expectations.map((e) => ({
        ...e,
        path: String(e.path),
      })),
      problems: journal.problems,
      console: classifyJournal(journal),
    }),
  };
  return lane;
}

export type OpenTransportLane = (
  options: TransportLaneOptions,
) => Promise<TransportLane>;

/** What a settled set of lanes found: every failure retained (cleanup, report, the classified journal, and opens that never finished). */
export interface LaneReport {
  closeErrors: string[];
  reportErrors: string[];
  failures: string[];
  /** Revision 20: each admitted open that was not published, with its stage (cancelled by settlement, or failed). */
  openErrors: string[];
}

/** Runs EVERY disposer, newest first, even after one fails or overruns its bound; returns each failure with its label. */
export async function runCleanup(
  steps: CleanupStep[],
  boundMs = DISPOSE_BOUND_MS,
  late?: (line: string) => void,
): Promise<string[]> {
  const errors: string[] = [];
  for (const step of [...steps].reverse()) {
    const failure = await runStep(step, boundMs, late);
    if (failure !== null) errors.push(failure);
  }
  return errors;
}

/**
 * The defined final boundary: `close` ends everything the lanes own (each lane's context first, then its front, scripted origin and
 * witness), then each lane's settled journal is classified and its ledger attached. Each part, and each lane's ledger, classification,
 * origin errors and foreign requests, is attempted whatever the others did (revision 20), and every failure is kept.
 */
export async function settleLanes(
  lanes: Array<
    Pick<TransportLane, "verdict" | "ledger" | "undeclaredForeign"> & {
      origin: Pick<ScriptedOrigin, "errors"> | null;
    }
  >,
  close: () => Promise<string[]>,
  attach: (name: string, body: string) => Promise<void>,
): Promise<Omit<LaneReport, "openErrors">> {
  const reportErrors: string[] = [];
  let closeErrors: string[];
  try {
    closeErrors = await close();
  } catch (error) {
    closeErrors = [`close: ${String(error)}`];
  }
  const failures: string[] = [];
  for (const [i, lane] of lanes.entries()) {
    try {
      await attach(
        `transport-ledger-${i}`,
        JSON.stringify(lane.ledger(), null, 1),
      );
    } catch (error) {
      reportErrors.push(`lane ${i} ledger: ${String(error)}`);
    }
    try {
      const verdict = lane.verdict();
      for (const p of verdict.unexpected)
        failures.push(
          `lane ${i} page ${p.page} document ${p.document} ${p.type} [${p.category}]: ${p.text} (${p.reason})`,
        );
      for (const v of verdict.violations) failures.push(`lane ${i}: ${v}`);
    } catch (error) {
      reportErrors.push(`lane ${i} classification: ${String(error)}`);
    }
    try {
      for (const e of lane.origin?.errors ?? [])
        failures.push(`lane ${i} scripted origin handler: ${e}`);
    } catch (error) {
      reportErrors.push(`lane ${i} scripted origin errors: ${String(error)}`);
    }
    try {
      for (const f of lane.undeclaredForeign())
        failures.push(`lane ${i}: a request outside the lane's origin: ${f}`);
    } catch (error) {
      reportErrors.push(`lane ${i} foreign requests: ${String(error)}`);
    }
  }
  return { closeErrors, reportErrors, failures };
}

/**
 * Lanes for one test: `open` as many as it needs; `settle` (once; repeated and concurrent calls share it) ends them all and reports.
 *
 * Revision 20 (Review 24 F24-1, family native-transport-upstream-cleanup; design assessment token 1fd56474…, invariants 1–6): the manager
 * OWNS every admitted open from admission to disposal, including resources whose acquisition has not returned. `open` registers its
 * record synchronously (before any acquisition) and only while the manager is open. `settle` enters `closing` synchronously, before any
 * teardown: no open or stage is admitted after that, no stage's result is used for further set-up, and no unfinished lane is published.
 * It then disposes every open's holdings (newest first within an open; opens independently), JOINING a pending acquisition within a
 * harness bound. A result arriving later is still disposed and a late rejection still recorded (`late`), but the report has already
 * failed by name: a timeout is never success. Opens that were not published are reported with their stage (`openErrors`). The borrowed
 * worker browser and any context the manager did not create are never closed.
 */
export function openTransportLanes(
  browser: Pick<Browser, "newContext">,
  testInfo: Pick<TestInfo, "project" | "attach">,
  settings: TransportLanesOptions = {},
) {
  const joinBoundMs = settings.joinBoundMs ?? JOIN_BOUND_MS;
  const disposeBoundMs = settings.disposeBoundMs ?? DISPOSE_BOUND_MS;
  const interpose: Interpose =
    settings.interpose ??
    (<T>(_: OpenStage, acquire: () => Promise<T>) => acquire());
  const lanes: TransportLane[] = [];
  const records: OpenRecord[] = [];
  const scopes: OpenScope[] = [];
  const late: string[] = [];
  let state: "open" | "closing" | "settled" = "open";
  let settling: Promise<LaneReport> | null = null;
  const noteLate = (line: string) => {
    late.push(line);
    if (state === "settled")
      (
        settings.onLate ??
        ((l: string) =>
          void process.stderr.write(`[native transport lane] ${l}\n`))
      )(line);
  };
  const snapshot = () =>
    records.map((r) => ({
      id: r.id,
      stage: r.stage,
      outcome: r.outcome,
      error: r.error,
      stages: r.stages,
      holdings: r.holdings.map(({ stage, state: s, error, late: l }) => ({
        stage,
        state: s,
        ...(error !== undefined ? { error } : {}),
        ...(l ? { late: true } : {}),
      })),
    }));

  const open = ((options) => {
    // Refused BEFORE anything is allocated once settlement has begun.
    if (state !== "open")
      return Promise.reject(
        new LaneCancelled(
          `transport lanes: open refused, settlement began (${state})`,
        ),
      );
    const record: OpenRecord = {
      id: records.length + 1,
      stage: "admitted",
      stages: [{ stage: "admitted", at: Date.now() }],
      outcome: "opening",
      error: null,
      done: Promise.resolve(),
      holdings: [],
    };
    records.push(record);
    const scope = new OpenScope(record, () => state !== "open", interpose);
    scopes.push(scope);
    const run = (async () => {
      const lane = await openLane(
        options,
        browser as Browser,
        testInfo as TestInfo,
        scope,
      );
      await scope.acquire("publication", async () => lane, null, false);
      // The final gate and the publication in ONE turn: a lane is published only while the manager is open.
      scope.gate("publication", "at");
      record.outcome = "published";
      record.stage = "publication";
      lanes.push(lane);
      return lane;
    })();
    // Observed at registration: the open's end (and any rejection) is recorded whether or not its caller awaits it.
    record.done = run.then(
      () => undefined,
      (error) => {
        record.outcome =
          error instanceof LaneCancelled ? "cancelled" : "failed";
        record.error = String(error);
        // A FAILED open unwinds what it had acquired at once (settlement shares the same disposals and reports their failures); a
        // cancelled one is being disposed by the settlement that cancelled it.
        if (record.outcome === "failed")
          void scope.dispose(
            Date.now() + joinBoundMs,
            disposeBoundMs,
            noteLate,
          );
      },
    );
    return run;
  }) as OpenTransportLane;

  const settleNow = async (): Promise<LaneReport> => {
    const deadline = Date.now() + joinBoundMs;
    const admitted = [...records];
    const reported = await settleLanes(
      lanes,
      async () => {
        const errors = (
          await Promise.all(
            scopes.map((scope) =>
              scope.dispose(deadline, disposeBoundMs, noteLate),
            ),
          )
        ).flat();
        await settlesWithin(
          Promise.all(admitted.map((r) => r.done)),
          Math.max(0, deadline - Date.now()),
        );
        for (const r of admitted)
          if (r.outcome === "opening") {
            errors.push(
              `open ${r.id}: unfinished at ${r.stage} when settlement's join bound ended`,
            );
            void r.done.then(() =>
              noteLate(
                `open ${r.id}: ended ${r.outcome} after settlement (${r.error})`,
              ),
            );
          }
        return errors;
      },
      (name, body) =>
        testInfo.attach(name, { body, contentType: "application/json" }),
    );
    const openErrors = admitted
      .filter((r) => r.outcome === "cancelled" || r.outcome === "failed")
      .map((r) => `open ${r.id} ${r.outcome} at ${r.stage}: ${r.error}`);
    const report: LaneReport = { ...reported, openErrors };
    try {
      await testInfo.attach("transport-teardown", {
        body: JSON.stringify({ report, opens: snapshot(), late }, null, 1),
        contentType: "application/json",
      });
    } catch (error) {
      report.reportErrors.push(`teardown record: ${String(error)}`);
    }
    return report;
  };

  return {
    /** The published lanes. */
    lanes,
    /** Outcomes that arrived after settlement's join bound (each also written to `onLate` once the report was returned). */
    late,
    /** Every admitted open: its stages, holdings and outcome. */
    snapshot,
    get state() {
      return state;
    },
    open,
    settle: (): Promise<LaneReport> => {
      if (settling === null) {
        // Closing is entered synchronously, before any teardown work: nothing is admitted or published after this line.
        state = "closing";
        settling = settleNow()
          .catch(
            (error): LaneReport => ({
              closeErrors: [],
              reportErrors: [`settlement: ${String(error)}`],
              failures: [],
              openErrors: [],
            }),
          )
          .then((report) => {
            state = "settled";
            return report;
          });
      }
      return settling;
    },
  };
}

/**
 * The `transportLane` fixture: `await transportLane({ mode })` opens one lane (its own context) for the case. A spec adds it with
 * `test.extend<{ transportLane: OpenTransportLane }>({ transportLane: transportLaneFixture })`. At teardown (whatever the test did) it
 * closes every context, listener and owned request, attaches each lane's ledger, and fails the case on any cleanup or report failure,
 * unexpected console problem, unmet or exceeded HTTP declaration, scripted-origin handler error, undeclared foreign request or open that
 * never finished (revision 20).
 */
export async function transportLaneFixture(
  { browser }: Pick<PlaywrightWorkerArgs, "browser">,
  use: (open: OpenTransportLane) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  await runTransportLaneFixture(browser, use, testInfo);
}

/** The fixture's body (its own controls pass bounds or a qualification seam; the fixture passes none). */
export async function runTransportLaneFixture(
  browser: Pick<Browser, "newContext">,
  use: (open: OpenTransportLane) => Promise<void>,
  testInfo: Pick<TestInfo, "project" | "attach">,
  settings: TransportLanesOptions = {},
): Promise<void> {
  const lanes = openTransportLanes(browser, testInfo, settings);
  let primary: { error: unknown } | null = null;
  try {
    await use(lanes.open);
  } catch (error) {
    primary = { error };
  }
  let report: LaneReport;
  try {
    report = await lanes.settle();
  } catch (error) {
    // settle() does not reject; kept so that the original failure survives whatever settlement does.
    report = {
      closeErrors: [],
      reportErrors: [`settlement threw: ${String(error)}`],
      failures: [],
      openErrors: [],
    };
  }
  if (primary !== null)
    throw new Error(
      `transport lane fixture: ${String(primary.error)}; teardown ${JSON.stringify(report)}`,
      { cause: primary.error },
    );
  expect(
    report,
    "transport lane teardown: everything owned closed, ledgers attached, every open finished, and no console problem but a request-attributed transport loss or a declared HTTP response",
  ).toEqual({
    closeErrors: [],
    reportErrors: [],
    failures: [],
    openErrors: [],
  });
}
