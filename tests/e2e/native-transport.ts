import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
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
 *
 * Revision 26 (Review 31 F31-1, family native-transport-console-attribution, harness incomplete_fix; design assessment token
 * 37c3b6402c…, C1–C5, invariants 1–7): revision 19 advanced a page's document at a main-frame navigation's RESPONSE, while the request
 * kept the document it was issued from; a declared navigation's own HTTP-status message (Chromium logs it after the commit) was then
 * the next document's and matched no request. Now (`recordPage`; since revision 28 `recordContext`) the document moves on at the main frame's COMMIT of the pending
 * navigation, the request keeps its initiating document and records the document it committed, and the classifier admits an HTTP-status
 * message in that committed document for that navigation alone (`Relation`), in an engine that logs such statuses. Every other
 * exclusion is unchanged: page, initiating document, URL, request before message, its own terminal and front record, the declaration
 * and its exact count, one message per request. Each problem is a frozen envelope taken in the native listener; an optional
 * qualification seam (`Ingest`) can hold its delivery to the journal, and settlement seals the journal before classifying it.
 *
 * Revision 27 (Review 32 F32-1, same family, harness incomplete_fix; design assessment token f0a2dd0e6c…, C1–C5, invariants 1–10):
 * revision 26 took a public `framenavigated` of a pending navigation's URL as its commit, so a history change to a STOPPED navigation's
 * URL (which left that navigation pending in the recorder) invented its commit, and a declared delayed fetch of the surviving document
 * was then judged in the wrong document. Now the only navigation authority is Playwright's own per-frame `navigated` event
 * (`observeNavigations`, pinned to playwright-core 1.63.0 and shape-checked): `new-document` (with the request it links, by identity),
 * `same-document`, or `aborted`. No URL, response, failure or public event moves a document; the classifier's commit relation also
 * requires that recorded new-document event; any unavailable, unreadable or contradicting provenance is a named lane violation.
 *
 * Revision 28 (Review 33; design assessment token 98d2410c…, C1–C6, invariants 1–8). F33-1 (same family, harness incomplete_fix): pages
 * were recorded from Playwright's announcement of them, which a native popup's first request, response and commit precede, so the popup's
 * first document went unrecorded and its declared status matched nothing. Capture is now the CONTEXT's (`recordContext`), attached as the
 * context arrives: one canonical path per network fact, each request attributed by its frame's identity, each page numbered and its
 * navigation provenance subscribed when the recorder first meets its main frame (for a popup, at its first request, through the pinned
 * client initializer frame: `frameOfRequest`). A page first met already showing a document, an unidentifiable frame, and a response,
 * failure or end of an unseen request are named failures. F33-2 (family native-transport-ui-initialisation, harness new): the UI stimulus
 * installer is repeat-safe in a global it already installed (WebKit runs init scripts twice in a popup's reused Window) and keeps its state
 * per DOCUMENT (`installUiStimulus`).
 *
 * Revision 29 (Review 34 F34-1, same family, harness incomplete_fix; design assessment token 5b499855…): an activation without any request
 * before the page's announcement (Firefox's native same-origin `blob:` popup) never reaches Playwright's client. The recorder also observes
 * the lane context's in-process SERVER commits (`observeActivations`, pinned and shape-checked, attached before any page exists) and hands
 * off between the two streams by Playwright's own dispatch: undispatched activations are applied when the frame is first met, dispatched
 * ones are paired with the client's events by request identity, and the native document id checks the chain (`journal.activations`).
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
 *
 * Revision 28 (Review 33 F33-2, family native-transport-ui-initialisation, harness new; design assessment token 98d2410c…, C4,
 * invariant 5): every engine reuses a popup's initial about:blank Window for its first same-origin document, and WebKit runs the lane's
 * init script in BOTH (diag popup-order-1). Revision 27 then wrapped its own getter as if it were the engine's and redefined the
 * protected API slot, which throws a page error. Now the state is the DOCUMENT's: an installation records the engine's original getter,
 * its own getter and its API (under a brand), and a later run in the same global recognises that installation BEFORE changing anything
 * and only adopts the current document. The stimulus and id belong to the document they were made in: any other document of the global
 * (a reused Window's new document, whether or not the engine re-ran the script) starts with a new id and no stimulus. A slot or getter
 * that is not this installation's is a named, visible error, never caught. The API slot is defined before the getter, so a failed
 * definition changes nothing; the slot stays protected (non-configurable, read-only) from the application.
 */
export function installUiStimulus() {
  const KEY = "__atlasUiConnectivity";
  const BRAND = Symbol.for("atlas.native-transport.ui-connectivity");
  const proto = Navigator.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "onLine");
  const slot = Object.getOwnPropertyDescriptor(window, KEY);
  if (slot !== undefined) {
    const installation = (
      slot.value as Record<symbol, unknown> | null | undefined
    )?.[BRAND] as
      | { version?: unknown; getter?: unknown; adopt?: unknown }
      | undefined;
    if (
      typeof installation !== "object" ||
      installation === null ||
      installation.version !== 1 ||
      typeof installation.adopt !== "function" ||
      descriptor?.get === undefined ||
      descriptor.get !== installation.getter
    )
      throw new Error(
        `native transport lane: window.${KEY} exists but is not the lane's UI stimulus installation over navigator.onLine; refusing to install over it`,
      );
    (installation.adopt as () => void)();
    return;
  }
  const native = descriptor?.get;
  if (native === undefined || descriptor?.configurable !== true)
    throw new Error(
      "native transport lane: navigator.onLine has no configurable getter; the UI stimulus cannot be installed",
    );
  if ((native as unknown as Record<symbol, unknown>)[BRAND] === true)
    throw new Error(
      `native transport lane: navigator.onLine already has the lane's getter but window.${KEY} is missing; refusing to wrap it again`,
    );
  const newId = () =>
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `doc-${Math.random()}`;
  let state: { document: Document; id: string; stimulus: boolean | null } = {
    document,
    id: newId(),
    stimulus: null,
  };
  const current = () => {
    if (state.document !== document)
      state = { document, id: newId(), stimulus: null };
    return state;
  };
  const getter = function (this: Navigator) {
    const s = current();
    return s.stimulus === null ? native.call(this) : s.stimulus;
  };
  Object.defineProperty(getter, BRAND, { value: true });
  const read = () => {
    const s = current();
    return {
      document: s.id,
      native: native.call(navigator) as boolean,
      ui: navigator.onLine,
      stimulus: s.stimulus,
    };
  };
  const api = {
    read,
    set(online: boolean) {
      current().stimulus = online;
      window.dispatchEvent(new Event(online ? "online" : "offline"));
      return read();
    },
  };
  Object.defineProperty(api, BRAND, {
    value: Object.freeze({
      version: 1,
      getter,
      adopt: () => {
        current();
      },
    }),
  });
  Object.defineProperty(window, KEY, {
    configurable: false,
    value: Object.freeze(api),
  });
  Object.defineProperty(proto, "onLine", { configurable: true, get: getter });
}

type UiApi = {
  read(): UiRecord;
  set(online: boolean): UiRecord;
};

// ---- Revision 19: the journal and its classification (F23-1) ------------------------------------------------------------------------

/**
 * A problem's category, from its type and the engine's exact wording (nothing else): a page error (`exception`); a `warning`; an engine's
 * HTTP-status message (`http`); an engine's network-failure message (`network`); `other`. Revision 31 (Review 36 F36-1): a native
 * renderer `crash` of the page (type `crash`, from Playwright's own crash signal, never a fabricated page error or network message).
 */
export type ProblemCategory =
  | "exception"
  | "warning"
  | "http"
  | "network"
  | "crash"
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
  if (type === "crash") return { category: "crash", url: location };
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
  /** The lane-wide journal sequence when this process observed it (taken at the native listener: revision 26's ingestion envelope). */
  seq: number;
  page: number;
  /**
   * The page's document when the native listener received it. Revision 26 (F31-1): it moves on when a main-frame document COMMITS
   * (`DocumentTransition`), not at a navigation's response (which a redirect hop, a 204 or a download also has).
   */
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
  /** The INITIATING document: the page's document when the request was issued (never rewritten: revision 26). */
  document: number;
  method: string;
  url: string;
  /** A main-frame navigation (it may commit the page's next document: `commit`). */
  navigation: boolean;
  observed: TransportStamp;
  /** The request's FIRST end: its response (headers) or its failure. */
  terminal: RequestTerminal | null;
  failedAfterResponse?: { seq: number; errorText: string };
  finishedSeq?: number;
  /** Revision 26: the journal sequence of the redirect hop this request continues (Playwright's `redirectedFrom`). */
  redirectedFrom?: number;
  /**
   * Revision 26 (F31-1), a main-frame navigation only: the document it COMMITTED. Revision 27 (F32-1): set only by a `new-document`
   * navigation event that names this very request (`DocumentTransition.request`), never from a URL; null once it can no longer commit one
   * (`commitReason`: redirected, superseded by a later navigation, or aborted with its error, as a stop, a 204 or a download is). Absent
   * while no event has decided it.
   */
  commit?: { seq: number; document: number } | null;
  commitReason?: string;
  /**
   * Revision 28 (F33-1), `journal.unattributedRequests` only: why the request is no page's (a service worker's, one without any frame, or
   * an unidentifiable frame, which is also a named provenance failure). Its `page` and `document` are then -1; it is never classified.
   */
  unattributed?: string;
}

/**
 * Revision 27 (F32-1): each navigation event of a lane page's main frame, from its navigation provenance (`observeNavigations`), as the
 * recorder read it. `new-document`: a committed new document (`request`: the navigation request the event names, or null, unattributed:
 * an engine's error page or a requestless commit). `same-document`: a fragment or history-API change; the document does not change.
 * `aborted`: a navigation that did not commit (`error`); the document does not change. `unreadable`: an event of an unexpected shape (a
 * named failure; the document is unknown from there).
 */
export interface DocumentTransition {
  seq: number;
  page: number;
  url: string;
  kind: "new-document" | "same-document" | "aborted" | "unreadable";
  /** The page's document before and after. */
  from: number;
  document: number;
  request: number | null;
  error?: string;
  reason: string;
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
  /** Revision 26: every main-frame document transition (audit; each problem and request already carries its document). */
  navigations?: DocumentTransition[];
  /** Revision 27: each page's navigation provenance source (its pinned Playwright version and bundle hash), or why it is unavailable. */
  navigationProvenance?: Array<
    { page: number } & (NavigationProvenance | { unavailable: string })
  >;
  /** Revision 27: named navigation-provenance failures (unavailable source, unreadable or contradicting events); each fails the lane. */
  provenanceFailures?: string[];
  /**
   * Revision 26: the lane's engine (`chromium`, `firefox`, `webkit`), when known. Only an engine observed to log a navigation's HTTP
   * status (`ENGINES_LOGGING_HTTP`) can have that message attributed through the navigation's commit; unknown is not one.
   */
  engine?: string;
  /** Revision 26: problems delivered by the ingestion seam AFTER the journal was sealed for classification (never classified). */
  late?: Problem[];
  /** Revision 28 (F33-1): each lane page, numbered when the recorder first met its main frame (`recordContext`). */
  pages?: PageAssociation[];
  /** Revision 28 (F33-1): requests of no page (a service worker's, one without a frame); recorded, never classified or credited. */
  unattributedRequests?: RequestRecord[];
  /** Revision 28 (F33-1): browser events delivered after the recorder was detached (never recorded). */
  lateEvents?: string[];
  /** Revision 29 (F34-1): every main-frame activation Playwright's server observed, in server receipt order (`ActivationRecord`). */
  activations?: ActivationRecord[];
  /** Revision 31 (F36-1): how each page's renderer crash is observed (one canonical source per page; `CrashWatch`). */
  crashWatches?: CrashWatch[];
  /** Revision 29 (F34-1): the activation source (its pin and bundle hash), or why it is unavailable. */
  activationSource?:
    | {
        source: "playwright-server-context";
        version: string;
        bundleSha256: string | null;
        pagesAtAttach: number;
      }
    | { unavailable: string };
}

/**
 * How a message was related to its request (revision 26): `same-document`, the message's document is the request's initiating document;
 * `committed-by-navigation`, an HTTP-status message in the document that the request (a main-frame navigation) itself committed.
 */
export type Relation = "same-document" | "committed-by-navigation";

export interface Classified extends Problem {
  verdict: "expected" | "unexpected";
  reason: string;
  evidence?: {
    request: number;
    attempts: number[];
    generations: number[];
    expectation?: number;
    relation: Relation;
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
  /** Revision 26, a main-frame navigation only: the document it committed (null: none; absent: still pending when classified). */
  commit?: { seq: number; document: number } | null;
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
 * Revision 26 (F31-1): the engines observed to log a main-frame navigation's HTTP status (revision-26 diagnostics): Chromium after the
 * main frame's commit, WebKit between the response and the commit. Firefox logs none (for a fetch or a navigation), so in Firefox a status
 * message in a navigation's committed document can only be the page's own text and is never attributed through that commit.
 */
export const ENGINES_LOGGING_HTTP: ReadonlySet<string> = new Set([
  "chromium",
  "webkit",
]);

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
      ...(r.navigation && r.commit !== undefined ? { commit: r.commit } : {}),
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
  // Revision 27 (F32-1): a page whose navigation provenance failed has unknown documents; the lane fails by name.
  for (const f of journal.provenanceFailures ?? [])
    violations.push(`navigation provenance: ${f}`);

  // 4. Every problem, once, in journal order. A message can only be its own page and document's, for a request that started before it
  //    and ended after that page/document/URL's previous message of the same category; at most one message per request.
  //    Revision 26 (F31-1): "its own document" is the request's INITIATING document, or, for an HTTP-status message only, the document
  //    that the request (a main-frame navigation answered with that status) itself committed, observed after that commit, in an engine
  //    that logs such a status (`ENGINES_LOGGING_HTTP`). No other request becomes eligible in either document.
  //    Revision 27 (F32-1, C3): that commit must be a recorded `new-document` navigation event naming this very request, at the commit's
  //    sequence and document; a commit field without that provenance (or with any other kind of event) admits nothing.
  const evidencedCommit = (r: RequestRecord) =>
    r.commit != null &&
    (journal.navigations ?? []).some(
      (t) =>
        t.kind === "new-document" &&
        t.page === r.page &&
        t.request === r.seq &&
        t.seq === r.commit?.seq &&
        t.document === r.commit?.document,
    );
  const committedBy = (r: RequestRecord, p: Problem) =>
    p.category === "http" &&
    r.navigation &&
    r.terminal?.kind === "response" &&
    r.commit != null &&
    r.commit.document === p.document &&
    r.commit.seq < p.seq &&
    evidencedCommit(r) &&
    journal.engine !== undefined &&
    ENGINES_LOGGING_HTTP.has(journal.engine);
  const relationOf = (r: RequestRecord, p: Problem): Relation | null =>
    r.document === p.document
      ? "same-document"
      : committedBy(r, p)
        ? "committed-by-navigation"
        : null;
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
    // Revision 31 (Review 36 F36-1, C1): judged before any request matching; nothing (a loss, a restoration, a declaration, a clean close)
    // can excuse it.
    if (p.category === "crash") {
      out(
        "unexpected",
        "a native renderer crash always fails: its page's evidence after it is incomplete, whatever the case did",
      );
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
        relationOf(r, p) !== null &&
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
    const relation = relationOf(nearest, p) as Relation;
    out(
      "expected",
      p.category === "network"
        ? `request #${nearest.seq} ${own(nearest).reason}`
        : `request #${nearest.seq} met declaration ${own(nearest).declared}${relation === "committed-by-navigation" ? ` (the navigation's own response, in the document it committed at #${(nearest.commit as { seq: number }).seq})` : ""}`,
      {
        request: nearest.seq,
        attempts: attempts.map((a) => a.seq),
        generations: [...new Set(attempts.map((a) => a.attempt.generation))],
        ...(p.category === "http"
          ? { expectation: own(nearest).declared as number }
          : {}),
        relation,
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

// ---- Revision 26: the page recorder (F31-1) ------------------------------------------------------------------------------------------

/** The parts of a Playwright request the recorder reads. */
export interface RecordedRequest {
  method(): string;
  url(): string;
  isNavigationRequest(): boolean;
  frame(): unknown;
  failure(): { errorText: string } | null;
  redirectedFrom(): RecordedRequest | null;
  /** Revision 28: the service worker that issued it (then it has no frame), when the request reports one. */
  serviceWorker?(): unknown;
}
/**
 * The parts of a Playwright page the recorder reads (a static test drives it with an event sequence an engine was observed to emit):
 * `mainFrame()` is a Playwright client frame, whose `navigated` events (`observeNavigations`) are the navigation provenance.
 */
export interface RecordedPage {
  mainFrame(): unknown;
  on(event: string, listener: (value: never) => void): unknown;
}
export interface RecorderSink {
  journal: Journal;
  /** The lane-wide journal sequence. */
  next: () => number;
  stamp: () => TransportStamp;
  /** Receives each problem's frozen envelope (taken at the native listener) and puts it in the journal, now or when the seam releases it. */
  ingest: (problem: Readonly<Problem>) => void;
}

// ---- Revision 27: navigation provenance (Review 32 F32-1) ---------------------------------------------------------------------------

/**
 * Revision 27 (Review 32 F32-1, family native-transport-console-attribution, harness incomplete_fix; design assessment token
 * f0a2dd0e6c…, C1–C4, invariants 1–8): the ONE source of navigation authority for a lane page. Revision 26 inferred a commit from the
 * public `framenavigated` event (which Playwright also emits for a same-document history change) plus a pending request of that URL, so a
 * history update to a cancelled navigation's URL invented that navigation's commit (Review 32's Chromium Stop schedule).
 *
 * The installed Playwright client keeps, on each frame, the protocol's own `navigated` event (`FrameNavigatedEvent`), which its public
 * API reduces to the frame: `newDocument` present for a committed NEW document (with the navigation request, when Playwright's server
 * linked one), absent for a SAME-DOCUMENT change, and `error` for an ABORTED navigation (which also carries `newDocument`: the pending
 * document that did not commit; Playwright emits no public event for it). Playwright's own `waitForNavigation` reads exactly this event.
 * It is a private interface of one pinned version: the adapter checks the installed `playwright-core` version and the event's shape, and
 * an unavailable or unreadable source is a NAMED failure of the case, never a fallback to URL matching.
 */
export const NAVIGATION_PROVENANCE_PIN = {
  package: "playwright-core",
  version: "1.63.0",
  event: "navigated",
} as const;

/** Where a lane page's navigation authority came from (in the ledger: the package version and its bundle's hash). */
export interface NavigationProvenance {
  source: "playwright-frame-navigated";
  version: string;
  bundleSha256: string | null;
}

/** The installed `playwright-core` the lane's Playwright client runs (resolved through `@playwright/test`, as the runner loads it). */
export interface InstalledPlaywrightCore {
  version: string | null;
  bundleSha256: string | null;
  error: string | null;
}

let installedCore: InstalledPlaywrightCore | undefined;
export function installedPlaywrightCore(): InstalledPlaywrightCore {
  if (installedCore !== undefined) return installedCore;
  try {
    const test = createRequire(import.meta.url).resolve(
      "@playwright/test/package.json",
    );
    const playwright = createRequire(test).resolve("playwright/package.json");
    const fromPlaywright = createRequire(playwright);
    const core = fromPlaywright.resolve("playwright-core/package.json");
    const version = (
      JSON.parse(readFileSync(core, "utf8")) as { version?: unknown }
    ).version;
    let bundleSha256: string | null = null;
    try {
      bundleSha256 = createHash("sha256")
        .update(
          readFileSync(
            fromPlaywright.resolve("playwright-core/lib/coreBundle"),
          ),
        )
        .digest("hex");
    } catch {
      bundleSha256 = null;
    }
    installedCore = {
      version: typeof version === "string" ? version : null,
      bundleSha256,
      error:
        typeof version === "string" ? null : "no version in its package.json",
    };
  } catch (error) {
    installedCore = { version: null, bundleSha256: null, error: String(error) };
  }
  return installedCore;
}

export type NavigationSubscription =
  | { ok: true; provenance: NavigationProvenance; dispose: () => void }
  | { ok: false; reason: string };

/**
 * Revision 32 (Review 39 F39-1, family native-transport-upstream-cleanup, harness incomplete_fix; design assessment token bde6ad2e…,
 * C1/C2, invariants 2/3): why a native callback was refused before it read anything. `enclosing`: its owner (the recorder, the lane) was
 * revoked; `local`: its own subscription was refused, rolled back or disposed; `installing`: it arrived while its own `on` was still
 * running (a named gap: the owner is not ready to read it).
 */
export type Refusal = "enclosing" | "local" | "installing";

/**
 * Revision 32 (C2): what an adapter's owner supplies. `admits` is the owner's own authority, consulted at EVERY callback before the
 * adapter touches its payload; `rejected` is told of each refused callback, payload-free (it must not throw; anything it throws is
 * swallowed so nothing reaches the emitter). Without an owner the adapter's own state alone admits.
 */
export interface CallbackAdmission {
  admits?: () => boolean;
  rejected?: (refusal: Refusal) => void;
}

/** Revision 32 (C1/C2): an adapter's own callback state; `revoked` before any rollback or removal, never re-enabled. */
type AdapterState = "installing" | "active" | "revoked";

const adapterRefusal = (
  state: AdapterState,
  admission: CallbackAdmission,
): Refusal | null => {
  try {
    if (admission.admits?.() === false) return "enclosing";
  } catch {
    return "enclosing";
  }
  return state === "revoked"
    ? "local"
    : state === "installing"
      ? "installing"
      : null;
};

const reportRefusal = (admission: CallbackAdmission, refusal: Refusal) => {
  try {
    admission.rejected?.(refusal);
  } catch {
    // Never thrown back into the emitter.
  }
};

/**
 * Subscribes `listener` to a Playwright client frame's `navigated` events (the frame's own emitter, so a subframe's never arrive). A
 * different installed version, or a frame without the emitter, is refused by name (`ok: false`); nothing is subscribed then.
 *
 * Revision 32 (Review 39 F39-1, C2): the emitter receives the adapter's own exact GUARDED wrapper, never `listener` itself. The wrapper is
 * admitted (owner first, then its own state) before the event is passed on; its state becomes `revoked` BEFORE a rollback or removal is
 * attempted, so a listener a failed `off` left attached, or one re-entered during that `off`, reaches neither `listener` nor the payload.
 */
export function observeNavigations(
  frame: unknown,
  listener: (event: unknown) => void,
  installed: InstalledPlaywrightCore = installedPlaywrightCore(),
  admission: CallbackAdmission = {},
): NavigationSubscription {
  if (installed.version !== NAVIGATION_PROVENANCE_PIN.version)
    return {
      ok: false,
      reason: `navigation provenance is qualified for ${NAVIGATION_PROVENANCE_PIN.package} ${NAVIGATION_PROVENANCE_PIN.version} only; installed: ${installed.version ?? `unknown (${installed.error})`}`,
    };
  const emitter = (frame as { _eventEmitter?: unknown } | null)
    ?._eventEmitter as
    | {
        on?: (event: string, listener: (event: unknown) => void) => unknown;
        off?: (event: string, listener: (event: unknown) => void) => unknown;
      }
    | undefined;
  if (typeof emitter?.on !== "function" || typeof emitter.off !== "function")
    return {
      ok: false,
      reason:
        "the main frame has no Playwright client navigation emitter (`_eventEmitter` with on/off)",
    };
  let state: AdapterState = "installing";
  const guarded = (event: unknown) => {
    const refusal = adapterRefusal(state, admission);
    if (refusal !== null) return reportRefusal(admission, refusal);
    listener(event);
  };
  // Revision 30 (Review 35 F35-1, C2, OWN-2): an `on` that attached and then threw is removed again here (exact callback), so a refused
  // subscription never leaves an undisclosed listener; a failing removal is named in the refusal.
  // Revision 32 (F39-1): revoked first, so a listener that removal leaves attached (or re-enters) stays inert.
  try {
    emitter.on(NAVIGATION_PROVENANCE_PIN.event, guarded);
  } catch (error) {
    state = "revoked";
    let rollback = "its listener was removed again";
    try {
      emitter.off(NAVIGATION_PROVENANCE_PIN.event, guarded);
    } catch (offError) {
      rollback = `removing its listener again also failed: ${String(offError)}`;
    }
    return {
      ok: false,
      reason: `subscribing to the main frame's navigation events threw: ${String(error)}; ${rollback}`,
    };
  }
  state = "active";
  return {
    ok: true,
    provenance: {
      source: "playwright-frame-navigated",
      version: installed.version,
      bundleSha256: installed.bundleSha256,
    },
    dispose: () => {
      if (state === "revoked") return;
      state = "revoked";
      emitter.off?.(NAVIGATION_PROVENANCE_PIN.event, guarded);
    },
  };
}

/** One `navigated` event, read: its kind, the request it names (the PUBLIC request object, or null: none named) and its error. */
export type ReadNavigation =
  | {
      ok: true;
      kind: "new-document" | "same-document" | "aborted";
      url: string;
      request: unknown;
      error?: string;
    }
  | { ok: false; reason: string };

/**
 * Reads a client `navigated` event (`FrameNavigatedEvent`: `url`, `name`, optional `newDocument: {request?}`, optional `error`). The
 * client delivers a named request as its CHANNEL; the public `Request` (the object the page's `request` event gave) is the channel's
 * `_object`, as Playwright's own `Request.from` reads it. Anything else is unreadable.
 */
export function readNavigated(value: unknown): ReadNavigation {
  if (typeof value !== "object" || value === null)
    return { ok: false, reason: "not an object" };
  const event = value as Record<string, unknown>;
  if (typeof event.url !== "string")
    return { ok: false, reason: "no string url" };
  if (event.error !== undefined && typeof event.error !== "string")
    return { ok: false, reason: "a non-string error" };
  const doc = event.newDocument;
  if (doc !== undefined && (typeof doc !== "object" || doc === null))
    return { ok: false, reason: "a newDocument that is not an object" };
  let request: unknown = null;
  const channel = (doc as { request?: unknown } | undefined)?.request;
  if (channel !== undefined && channel !== null) {
    const object = (channel as { _object?: unknown })._object;
    if (
      typeof channel !== "object" ||
      typeof object !== "object" ||
      object === null
    )
      return {
        ok: false,
        reason:
          "a newDocument request that is not a client channel (no `_object`)",
      };
    request = object;
  }
  if (event.error !== undefined)
    return {
      ok: true,
      kind: "aborted",
      url: event.url,
      request,
      error: event.error as string,
    };
  return {
    ok: true,
    kind: doc === undefined ? "same-document" : "new-document",
    url: event.url,
    request,
  };
}

// ---- Revision 29: the activation source (Review 34 F34-1) ---------------------------------------------------------------------------

/**
 * Revision 29 (Review 34 F34-1, family native-transport-console-attribution, harness incomplete_fix; design assessment token
 * 5b499855…, C1–C5, invariants 1–8): the source of every main-frame document ACTIVATION of a lane context, including one Playwright never
 * delivers to its client.
 *
 * Q0 (`revision-29/diag/activation-boundary-1`, all three engines): Playwright's server sends a frame's `navigated` events to the client
 * only once that frame has a dispatcher, which a request of the frame or the page's announcement creates. Firefox opens a same-origin
 * `blob:` popup WITHOUT a request: its document commits while the frame has no dispatcher, so the client never receives that commit and
 * first meets the page already showing the blob (Review 34's F34-1). A client-side subscription at frame creation therefore cannot see
 * it: the event does not exist on the client. Playwright's in-process SERVER browser context, however, emits
 * `internalframenavigatedtonewdocument` for every non-initial new-document commit of any frame of the context, from the moment its server
 * page exists (before its announcement), and its DispatcherConnection knows whether the frame had a dispatcher then, i.e. whether the
 * client was sent that commit. The adapter listens there, passively (an ordinary emitter listener on the lane's own server context; no
 * hook, factory or method is replaced, no navigation added), and reads each commit synchronously: the server frame (identity), whether it
 * is a main frame, its URL, its NATIVE document id, whether a server request is linked, and whether it was dispatched.
 *
 * It is a private interface of one pinned version (`ACTIVATION_SOURCE_PIN`, the same pin as the navigation provenance), reachable only
 * through the in-process client connection's `toImpl`: a different version, a remote (connected) client without `toImpl`, or any part of
 * an unexpected shape is a NAMED unavailability (`ok: false`), never a fallback. The adapter never throws; its disposer detaches its one
 * listener once.
 */
export const ACTIVATION_SOURCE_PIN = {
  package: "playwright-core",
  version: "1.63.0",
  event: "internalframenavigatedtonewdocument",
} as const;

/** One server-observed commit, as the adapter read it in the server's own listener. */
export type ServerCommit =
  | {
      ok: true;
      /** The server frame (identity only). */
      frame: object;
      main: boolean;
      url: string;
      /** The engine's own id of the committed document (`documentId`; WebKit's initial document has ""). */
      nativeDocument: string | null;
      /** The server request linked to the commit (identity only), or null: none. */
      request: object | null;
      /** Whether the frame had a dispatcher, i.e. whether Playwright sent the client this commit as `navigated`. */
      dispatched: boolean;
    }
  | { ok: false; reason: string };

export type ActivationSource =
  | {
      ok: true;
      /** The server context's pages (initialised or not) when the listener attached: 0 proves it attached before any page existed. */
      pagesAtAttach: number;
      /** The server frame behind a client frame (identity), and its current native document. */
      serverFrameOf: (
        clientFrame: unknown,
      ) =>
        | { ok: true; frame: object; currentDocument: string | null }
        | { ok: false; reason: string };
      /** The server object behind a client request (identity), or null when Playwright holds none. */
      serverRequestOf: (clientRequest: unknown) => object | null;
      /** Revision 31 (F36-1): the server Page of a server frame (`RENDERER_CRASH_PIN`), or why it cannot be read. */
      serverPageOfFrame: (serverFrame: unknown) => ServerPageRead;
      dispose: () => void;
    }
  | { ok: false; reason: string };

/**
 * Revision 31 (Review 36 F36-1, family native-transport-console-attribution, harness new; design assessment token 7c961068…, C1/C2/C6,
 * invariants 1–4/10): Playwright's SERVER Page emits its own `crash` event synchronously when its engine reports the renderer crashed
 * (`Page._didCrash`: Chromium `Inspector.targetCrashed`, Firefox `Page.crashed`, WebKit a crashed target), and its lifecycle becomes
 * `crashed`; its client Page is sent `crash` only once the page has a dispatcher, so a crash before Playwright announced the page never
 * reaches the client at all, and the server does not replay it (unlike console messages and page errors). The recorder therefore takes
 * the crash at the server Page, subscribed at the earliest server boundary it sees (the page's first main-frame commit, possibly before
 * dispatch, or the recorder's first meeting with the page), and reads the server lifecycle there: a page already `crashed` crashed
 * before the subscription. Same pin and in-process requirement as the activation source; anything of another shape is a NAMED gap.
 */
export const RENDERER_CRASH_PIN = {
  package: "playwright-core",
  version: "1.63.0",
  event: "crash",
  lifecycles: ["open", "closing", "closed", "crashed"],
} as const;

export type ServerPageRead =
  | {
      ok: true;
      /** The server Page (identity; an emitter of `crash`). */
      page: object;
      /** Its lifecycle now (`open`, `closing`, `closed` or `crashed`), read again whenever called. */
      lifecycle: () => string;
    }
  | { ok: false; reason: string };

/** Reads a server Page of the pinned shape: `on`/`off` and a `_lifecycle` Playwright 1.63.0 defines. Never throws. */
export function readServerPage(value: unknown): ServerPageRead {
  try {
    const page = value as {
      on?: unknown;
      off?: unknown;
      _lifecycle?: unknown;
    } | null;
    if (typeof page !== "object" || page === null)
      return { ok: false, reason: "no server Page" };
    if (typeof page.on !== "function" || typeof page.off !== "function")
      return {
        ok: false,
        reason: "a server Page without on/off of the pinned shape",
      };
    const known: readonly string[] = RENDERER_CRASH_PIN.lifecycles;
    const lifecycle = () => {
      const now = page._lifecycle;
      if (typeof now !== "string" || !known.includes(now))
        throw new TypeError(
          `a server Page lifecycle outside the pinned ${known.join("/")}: ${JSON.stringify(now)}`,
        );
      return now;
    };
    lifecycle();
    return { ok: true, page, lifecycle };
  } catch (error) {
    return {
      ok: false,
      reason: `reading the server Page threw: ${firstLine(error)}`,
    };
  }
}

type ServerFrameShape = {
  parentFrame?: () => unknown;
  url?: () => unknown;
  _currentDocument?: { documentId?: unknown; request?: unknown } | null;
};
const readDocument = (
  frame: ServerFrameShape,
):
  | { ok: true; nativeDocument: string | null; request: object | null }
  | { ok: false; reason: string } => {
  const current = frame._currentDocument;
  if (typeof current !== "object" || current === null)
    return { ok: false, reason: "a server frame without `_currentDocument`" };
  const id = current.documentId;
  if (id !== undefined && typeof id !== "string")
    return { ok: false, reason: "a non-string native document id" };
  const request = current.request;
  if (
    request !== undefined &&
    (typeof request !== "object" || request === null)
  )
    return {
      ok: false,
      reason: "a server document request that is not an object",
    };
  return {
    ok: true,
    nativeDocument: id ?? null,
    request: (request as object | undefined) ?? null,
  };
};

/**
 * Attaches `listener` to the lane context's server-side commits (above). Returns the source, or why it is unavailable (nothing attached).
 *
 * Revision 32 (Review 39 F39-1, C2, invariants 2/3): each server callback is admitted (owner first, then the adapter's own state) BEFORE
 * it reads the frame, its document, url, parent or dispatcher; the state is `revoked` before a rollback or removal is attempted, so a
 * listener a failed `off` left attached, or one re-entered during it, reads nothing and reports itself payload-free to `admission`.
 */
export function observeActivations(
  context: unknown,
  listener: (commit: ServerCommit) => void,
  installed: InstalledPlaywrightCore = installedPlaywrightCore(),
  admission: CallbackAdmission = {},
): ActivationSource {
  try {
    if (installed.version !== ACTIVATION_SOURCE_PIN.version)
      return {
        ok: false,
        reason: `the activation source is qualified for ${ACTIVATION_SOURCE_PIN.package} ${ACTIVATION_SOURCE_PIN.version} only; installed: ${installed.version ?? `unknown (${installed.error})`}`,
      };
    const connection = (context as { _connection?: unknown } | null)
      ?._connection as { toImpl?: unknown } | undefined;
    const toImpl = connection?.toImpl;
    if (typeof toImpl !== "function")
      return {
        ok: false,
        reason:
          "the client connection has no in-process `toImpl` (a remote or connected Playwright client): Playwright's server context is not reachable",
      };
    const impl = (x: unknown): unknown => toImpl.call(connection, x);
    const server = impl(context) as {
      on?: unknown;
      off?: unknown;
      possiblyUninitializedPages?: unknown;
    } | null;
    if (
      typeof server?.on !== "function" ||
      typeof server.off !== "function" ||
      typeof server.possiblyUninitializedPages !== "function"
    )
      return {
        ok: false,
        reason:
          "the server context has no on/off/possiblyUninitializedPages of the pinned shape",
      };
    const dispatchers = impl(connection) as {
      existingDispatcher?: unknown;
    } | null;
    if (typeof dispatchers?.existingDispatcher !== "function")
      return {
        ok: false,
        reason:
          "the in-process dispatcher connection has no existingDispatcher of the pinned shape",
      };
    const existing = dispatchers.existingDispatcher as (o: unknown) => unknown;
    const pages = (server.possiblyUninitializedPages as () => unknown).call(
      server,
    );
    if (!Array.isArray(pages))
      return {
        ok: false,
        reason: "possiblyUninitializedPages() did not return an array",
      };
    let state: AdapterState = "installing";
    const onCommit = (frame: unknown) => {
      const refusal = adapterRefusal(state, admission);
      if (refusal !== null) return reportRefusal(admission, refusal);
      let commit: ServerCommit;
      try {
        const f = frame as ServerFrameShape | null;
        if (
          typeof f !== "object" ||
          f === null ||
          typeof f.parentFrame !== "function" ||
          typeof f.url !== "function"
        )
          commit = {
            ok: false,
            reason: "a committed server frame without parentFrame()/url()",
          };
        else {
          const document = readDocument(f);
          const url = f.url.call(f);
          if (!document.ok) commit = document;
          else if (typeof url !== "string")
            commit = {
              ok: false,
              reason: "a server frame url that is not a string",
            };
          else
            commit = {
              ok: true,
              frame: f,
              main: f.parentFrame.call(f) === null,
              url,
              nativeDocument: document.nativeDocument,
              request: document.request,
              dispatched: existing.call(dispatchers, f) !== undefined,
            };
        }
      } catch (error) {
        commit = {
          ok: false,
          reason: `reading a server commit threw: ${firstLine(error)}`,
        };
      }
      listener(commit);
    };
    // Revision 30 (Review 35 F35-1, C2, OWN-2): an `on` that attached and then threw is detached again (exact callback) before the
    // source reports itself unavailable, so the refusal never swallows an attached listener; a failing detachment is named in it.
    try {
      (server.on as (e: string, l: (f: unknown) => void) => unknown).call(
        server,
        ACTIVATION_SOURCE_PIN.event,
        onCommit,
      );
    } catch (error) {
      state = "revoked";
      let rollback = "its listener was detached again";
      try {
        (server.off as (e: string, l: (f: unknown) => void) => unknown).call(
          server,
          ACTIVATION_SOURCE_PIN.event,
          onCommit,
        );
      } catch (offError) {
        rollback = `detaching its listener again also failed: ${String(offError)}`;
      }
      return {
        ok: false,
        reason: `attaching the activation source threw: ${String(error)}; ${rollback}`,
      };
    }
    state = "active";
    return {
      ok: true,
      pagesAtAttach: pages.length,
      serverFrameOf: (clientFrame) => {
        let frame: unknown;
        try {
          frame = impl(clientFrame);
        } catch (error) {
          return {
            ok: false,
            reason: `the client frame's server frame is unreadable (${firstLine(error)})`,
          };
        }
        if (typeof frame !== "object" || frame === null)
          return { ok: false, reason: "the client frame has no server frame" };
        const document = readDocument(frame as ServerFrameShape);
        if (!document.ok) return document;
        return {
          ok: true,
          frame,
          currentDocument: document.nativeDocument,
        };
      },
      serverRequestOf: (clientRequest) => {
        try {
          const r = impl(clientRequest);
          return typeof r === "object" && r !== null ? r : null;
        } catch {
          return null;
        }
      },
      serverPageOfFrame: (serverFrame) => {
        try {
          return readServerPage(
            (serverFrame as { _page?: unknown } | null)?._page,
          );
        } catch (error) {
          return {
            ok: false,
            reason: `reading the server frame's page threw: ${firstLine(error)}`,
          };
        }
      },
      dispose: () => {
        if (state === "revoked") return;
        state = "revoked";
        (server.off as (e: string, l: (f: unknown) => void) => unknown).call(
          server,
          ACTIVATION_SOURCE_PIN.event,
          onCommit,
        );
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `attaching the activation source threw: ${firstLine(error)}`,
    };
  }
}

/**
 * Revision 29 (F34-1): one main-frame document activation of a lane context, as its server observed it (`observeActivations`), in server
 * receipt order (`journal.activations`). Immutable once recorded, except `page` (-1 until the recorder first meets the frame: the identity
 * reference resolved, never renumbered) and `pairedWith`.
 *  - `kind`: `initial-document`, the browsing context's initial empty document (the frame's FIRST commit, undispatched, requestless,
 *    `about:blank`: every engine creates a new top-level context with one, and some report its commit: Firefox for an explicit page,
 *    every engine for a named `window.open("", name)`). It is the page's document 0, as an unreported initial document always was.
 *    `new-document`: any other commit; it is a new lane document.
 *  - `dispatched`: Playwright sent the client this commit as `navigated`. A dispatched activation is PAIRED with the client's
 *    `new-document` event of that page (`pairedWith`: its navigation's sequence; the client's named request must be this commit's server
 *    request, by identity). An undispatched one never reaches the client: the recorder applies it to the page when it first meets the
 *    frame (a requestless `new-document` navigation at the activation's own sequence; `request` "unresolved" when the server linked one).
 */
export interface ActivationRecord {
  seq: number;
  page: number;
  /** The server frame, numbered in order of its first commit (identity only). */
  frame: number;
  kind: "initial-document" | "new-document";
  url: string;
  nativeDocument: string | null;
  request: "none" | "linked" | "unresolved";
  dispatched: boolean;
  observed: TransportStamp;
  pairedWith?: number;
}

// ---- Revision 30: owned subscriptions and complete cleanup outcomes (Review 35 F35-1/F35-2) ------------------------------------------

/** An emitter as the lane subscribes to it: Playwright's own `on`/`off` (exact callback). */
export interface OwnedEmitter {
  on(event: string, listener: (value: never) => void): unknown;
  off(event: string, listener: (value: never) => void): unknown;
}

/**
 * Revision 30 (Review 35 F35-1, family native-transport-upstream-cleanup, harness new; design assessment token 2868a8a2…, C2, invariants
 * 1/3/4/7): a ledger of the lane's own subscriptions. Each REMOVAL obligation is recorded BEFORE its `on` runs, so an `on` that throws
 * before attaching and one that attaches and then throws are both unwound by the same exact-callback `off` (removing a listener that never
 * attached is a no-op on Playwright's and Node's emitters). An emitter without `on`/`off` is refused before anything is attached.
 * `detach` attempts every obligation, newest first, whatever the others did, and returns each failure by its label (`<label> failed:
 * <error>`); it is single use. `child` opens a nested scope (a page's own listeners) that can be rolled back alone and is otherwise
 * detached with its parent. Nothing here calls `removeAllListeners`: another owner's listeners on the same emitters are never touched.
 */
export class Subscriptions {
  private readonly entries: Array<
    { label: string; detach: () => void } | { child: Subscriptions }
  > = [];
  private done = false;
  /** Revision 32: this scope's own callback authority was revoked (rollback, finalisation or detachment), apart from removal. */
  private revokedHere = false;
  /** Revision 32: callbacks refused without a caller's sink (`add` with no `rejected`), by label: never silent. */
  readonly rejections: string[] = [];

  /** Revision 32 (C1): a nested scope consults its enclosing scope's authority dynamically, at every callback. */
  constructor(private readonly parent: Subscriptions | null = null) {}

  /**
   * Subscribes `listener` to `event` on `emitter`; the removal is owned first. Throws what `on` threw (the caller rolls back).
   *
   * Revision 32 (Review 39 F39-1 / design assessment DA39-2/DA39-3, family native-transport-upstream-cleanup, harness incomplete_fix;
   * token bde6ad2e…, C1, invariants 2/3/5): what is registered (and removed) is the scope's own exact GUARDED wrapper of `listener`. The
   * wrapper consults this scope's admission (`refusal`) before it calls `listener`, so a refused callback never reads its payload, forwards
   * or mutates anything: it reports itself, payload-free, to `rejected` (or to `rejections`), and returns. A callback delivered while its
   * own `on` is still running (installation re-entry) is refused as `installing`: a named gap for the caller, never silently lost and never
   * run against a half-initialised owner. Nothing the wrapper or `rejected` throws reaches the emitter.
   */
  add(
    label: string,
    emitter: unknown,
    event: string,
    listener: (value: never) => void,
    rejected?: (refusal: Refusal) => void,
  ): void {
    if (this.done)
      throw new Error(
        `${label}: refused, its owner's subscriptions were already detached`,
      );
    const on = (emitter as { on?: unknown } | null)?.on;
    const off = (emitter as { off?: unknown } | null)?.off;
    if (typeof on !== "function" || typeof off !== "function")
      throw new TypeError(
        `${label}: the emitter has no on/off of Playwright's shape (its listener could not be removed); refused before anything was attached`,
      );
    let installing = true;
    const guarded = (value: never) => {
      const refusal = this.refusal() ?? (installing ? "installing" : null);
      if (refusal !== null) {
        try {
          if (rejected !== undefined) rejected(refusal);
          else
            this.rejections.push(`${label}: a callback refused (${refusal})`);
        } catch {
          // A rejection sink failing must not throw back into the emitter.
        }
        return;
      }
      listener(value);
    };
    // The removal is read from the emitter when it runs (as the source and frame adapters do), never cached: a replaced or missing `off`
    // is the emitter's own state then, and its failure is named.
    this.entries.push({
      label,
      detach: () => {
        const remove = (emitter as { off?: unknown }).off;
        if (typeof remove !== "function")
          throw new TypeError("its emitter no longer has off()");
        remove.call(emitter, event, guarded);
      },
    });
    on.call(emitter, event, guarded);
    installing = false;
  }

  /**
   * Revision 32 (C1, invariant 3): why a callback of this scope is refused now, or null when it is admitted. The ENCLOSING scope's
   * revocation is consulted first (dynamically: it applies to every descendant at once, before that descendant's own removal is
   * visited), then this scope's own.
   */
  refusal(): Exclude<Refusal, "installing"> | null {
    if (this.parent?.revoked === true) return "enclosing";
    return this.revokedHere ? "local" : null;
  }

  /** Revision 32: this scope's callbacks are refused (it, or a scope enclosing it, was revoked). */
  get revoked(): boolean {
    return this.revokedHere || this.parent?.revoked === true;
  }

  /**
   * Revision 32 (C1/C3, invariant 3): revokes this scope's callback authority, synchronously and WITHOUT removing anything (so it can
   * precede any `off` that might throw or re-enter). Idempotent; a removal failure can never re-enable it. `detach` revokes first too.
   */
  revoke(): void {
    this.revokedHere = true;
  }

  /** Owns an adapter's own disposer (the activation source, a navigation subscription), detached with the rest. */
  adopt(label: string, detach: () => void): void {
    if (this.done) {
      throw new Error(
        `${label}: refused, its owner's subscriptions were already detached`,
      );
    }
    this.entries.push({ label, detach });
  }

  /** A nested scope, detached with this one (newest first, in its place) unless it was rolled back alone before. */
  child(): Subscriptions {
    if (this.done)
      throw new Error(
        "a nested subscription scope was refused: its owner's subscriptions were already detached",
      );
    const child = new Subscriptions(this);
    this.entries.push({ child });
    return child;
  }

  get detached(): boolean {
    return this.done;
  }

  detach(): string[] {
    if (this.done) return [];
    // Revision 32 (C1, invariant 3): authority is revoked BEFORE the first removal is attempted (a throwing or re-entrant `off` below
    // meets refused callbacks only, here and in every nested scope).
    this.revokedHere = true;
    this.done = true;
    const errors: string[] = [];
    for (const entry of [...this.entries].reverse()) {
      if ("child" in entry) {
        errors.push(...entry.child.detach());
        continue;
      }
      try {
        entry.detach();
      } catch (error) {
        errors.push(`${entry.label} failed: ${String(error)}`);
      }
    }
    return errors;
  }
}

/**
 * Revision 30 (Review 35 F35-2, harness incomplete_fix; C3/C4, invariant 4): every cause of one cleanup, kept. `String(error)` (what the
 * report, the teardown record and the fixture's thrown error carry) names each cause in order, so none is lost to a reader that only
 * stringifies; `causes` keeps them separately.
 */
export class CleanupFailures extends Error {
  override name = "CleanupFailures";
  constructor(readonly causes: readonly string[]) {
    super(
      `${causes.length} cause${causes.length === 1 ? "" : "s"}: ${causes.map((cause, i) => `[${i + 1}] ${cause}`).join("; ")}`,
    );
  }
}

/**
 * Revision 30 (F35-1, C2): installing a context's capture failed. Every registration it had made was rolled back (exact callbacks, newest
 * first) before this was thrown; `rollback` names each removal that failed. The message carries the installation's cause first.
 */
export class CaptureInstallError extends Error {
  override name = "CaptureInstallError";
  constructor(
    readonly installation: unknown,
    readonly rollback: readonly string[],
  ) {
    super(
      `${String(installation)}; ${rollback.length === 0 ? "every partial registration was rolled back" : `rolling back its partial registrations also failed: ${rollback.join("; ")}`}`,
      { cause: installation },
    );
  }
}

// ---- Revision 28: the context's capture registry (Review 33 F33-1) ------------------------------------------------------------------

/** The parts of a Playwright client frame the recorder reads (its `_eventEmitter`, the navigation provenance, is read by `observeNavigations`). */
export interface RecordedFrame {
  url(): string;
  parentFrame(): unknown;
}
/**
 * The parts of a Playwright browser context the recorder reads (a static test drives it with an event sequence an engine was observed to
 * emit). Revision 30 (F35-1): its `off` too, so each listener the recorder attached is removed by its exact callback.
 */
export type RecordedContext = OwnedEmitter;

/**
 * The installed capture of one context (`recordContext`). Revision 32 (C3, invariant 6): `revoke` withdraws every callback's authority
 * at once and removes nothing (the owner calls it after the context's close ended, before ANY removal); `dispose` finalises: it revokes
 * too, detaches every subscription once and reports the undelivered/unattributed evidence with the close's status.
 */
export interface RecordedCapture {
  revoke: () => void;
  dispose: (status?: CloseStatus) => string[];
}

/** How the context's close ended when the recorder was finalised (revision 30, invariant 8): only "closed" means every event arrived. */
export type CloseStatus = "closed" | "failed" | "pending" | "not attempted";

/**
 * Revision 28 (F33-1): a lane page as the recorder identifies it, from its FIRST observation, never renumbered. `via`: how the recorder
 * first met the page's main frame: a request of it (a popup's first navigation, which Playwright delivers before it announces the page:
 * diag popup-order-1), the context's `page` event, or a problem of a page not yet announced. `firstUrl`: the main frame's URL then ("" or
 * about:blank, its initial empty document; anything else is a named gap). `announced`: whether the context announced the page.
 */
export interface PageAssociation {
  page: number;
  via: "request" | "page" | "problem";
  firstUrl: string;
  announced: boolean;
}

/**
 * Revision 31 (F36-1, C2): one page's renderer-crash subscription. `source`: the SERVER Page's own `crash` (canonical whenever the
 * activation source can read it: `RENDERER_CRASH_PIN`), or the public client Page's `crash` (only when it cannot: the source is
 * unavailable or this page's server frame is unidentified; its pre-announcement window is then a named gap already). `at`: the boundary
 * where it was subscribed (`server-commit`: the page's main-frame commit at the server, possibly before Playwright dispatched the frame;
 * `page-met`: the recorder's first meeting with the page; `announcement`/`early-problem`: a client Page object). `announced`: whether
 * the context had announced the page then. `page` is -1 until the recorder meets the frame (resolved by identity, never renumbered).
 */
export interface CrashWatch {
  page: number;
  frame: number | null;
  source: "server-page" | "client-page";
  at: "server-commit" | "page-met" | "announcement" | "early-problem";
  announced: boolean;
  /** The server lifecycle when subscribed (`crashed`: the crash preceded the subscription and is recorded at once). */
  lifecycle?: string;
}

/** Where a request was issued: a frame (`early`: one Playwright has not announced the page of yet), none (a service worker's), or unknown. */
export type RequestFrame =
  | { ok: true; frame: unknown; early: boolean }
  | { ok: true; frame: null; reason: string }
  | { ok: false; reason: string };

const firstLine = (error: unknown) => String(error).split("\n")[0] ?? "";

/**
 * The frame that issued `request`. Playwright's public `Request.frame()` refuses a frame whose page it has not announced yet (a popup's
 * first navigation request: "Frame for this navigation request is not available") although its client frame already exists: it is the
 * request's initializer frame, it already receives that frame's `navigated` events, and it becomes the announced page's main frame (diag
 * popup-order-1, all three engines). Only for that refusal, and only under the pinned `playwright-core` (NAVIGATION_PROVENANCE_PIN), the
 * recorder reads the initializer frame; anything else unreadable is a named failure, never a guess.
 */
export function frameOfRequest(
  request: RecordedRequest,
  installed: InstalledPlaywrightCore = installedPlaywrightCore(),
): RequestFrame {
  let worker: unknown = null;
  try {
    worker = request.serviceWorker?.() ?? null;
  } catch {
    worker = null;
  }
  if (worker !== null)
    return {
      ok: true,
      frame: null,
      reason: "a service worker's request (it has no frame)",
    };
  try {
    return { ok: true, frame: request.frame(), early: false };
  } catch (error) {
    if (installed.version !== NAVIGATION_PROVENANCE_PIN.version)
      return {
        ok: false,
        reason: `Request.frame() refused (${firstLine(error)}); the client initializer frame is read only under ${NAVIGATION_PROVENANCE_PIN.package} ${NAVIGATION_PROVENANCE_PIN.version} (installed: ${installed.version ?? `unknown (${installed.error})`})`,
      };
    const initializer = (
      request as {
        _initializer?: { frame?: { _object?: unknown } | null } | null;
      }
    )._initializer;
    if (typeof initializer !== "object" || initializer === null)
      return {
        ok: false,
        reason: `Request.frame() refused (${firstLine(error)}) and the request has no readable client initializer`,
      };
    // No frame at all (as Playwright's own page delivery never had one): browser traffic outside any page, recorded apart.
    if (initializer.frame === undefined || initializer.frame === null)
      return {
        ok: true,
        frame: null,
        reason: `a request without a frame (${firstLine(error)})`,
      };
    const early = initializer.frame._object;
    if (typeof early !== "object" || early === null)
      return {
        ok: false,
        reason: `Request.frame() refused (${firstLine(error)}) and its client initializer frame has no object`,
      };
    return { ok: true, frame: early, early: true };
  }
}

/** The top frame above `frame` (a page's main frame), through the public `parentFrame()`; an unreadable chain is a named failure. */
function rootOf(
  frame: unknown,
): { ok: true; root: unknown } | { ok: false; reason: string } {
  let current = frame;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = (current as { parentFrame?: unknown } | null)?.parentFrame;
    if (typeof parent !== "function")
      return { ok: false, reason: "a frame without parentFrame()" };
    let up: unknown;
    try {
      up = parent.call(current);
    } catch (error) {
      return { ok: false, reason: `parentFrame() threw: ${firstLine(error)}` };
    }
    if (up === null || up === undefined) return { ok: true, root: current };
    current = up;
  }
  return { ok: false, reason: "frames nested deeper than 64" };
}

/**
 * Records a lane context's requests, its pages' document transitions and their problems in the journal (revision 26, Review 31 F31-1;
 * revision 27, Review 32 F32-1; revision 28, Review 33 F33-1, design assessment token 98d2410c…, C1–C3/C5, invariants 1–4/7–8).
 *
 * Revision 28 (F33-1): capture is the CONTEXT's, attached when the context arrives (before any page exists, and before the lane or its
 * context reaches a caller). Revision 27 recorded a page from Playwright's announcement of it, but a native popup's first navigation
 * request, its response and its commit all precede that announcement (Playwright then delivers them to the context only): the popup's
 * first document was invisible, and its declared status matched nothing. Now there is ONE canonical path per fact: the context's
 * `request`, `response`, `requestfailed` and `requestfinished` events (never a page's as well), each request attributed to its page by
 * the IDENTITY of its frame's top frame (`frameOfRequest`, `rootOf`); a page is numbered when the recorder first meets its main frame
 * (`journal.pages`), and its navigation provenance (`observeNavigations`) is subscribed synchronously in that same listener, before
 * Playwright can deliver the frame's next event, so the popup's first commit is seen and linked to its request. The context's later
 * `page` event binds the page object to that SAME record (no new number, nothing re-stamped). A page first met already showing a real
 * document (its main frame's URL neither "" nor about:blank) had an activation the recorder did not see: a named failure, never an
 * invented commit. A request whose frame cannot be identified is a named failure; one without any frame (a service worker's, as
 * Playwright never delivered to a page) is recorded apart (`journal.unattributedRequests`) and never attributed to a page. A response, failure or end of a request the recorder never saw, and a
 * navigation event naming another page's request, are named failures.
 *
 * The page's DOCUMENT moves on only at a `new-document` event of its main frame's navigation provenance, never at a response, a failure,
 * a request's end, a public `framenavigated` or a URL: a redirect hop, a 204 and a download have a navigation response but commit nothing;
 * a history change (even to a pending or cancelled navigation's URL) is a `same-document` event; a stopped, failed or refused navigation
 * is an `aborted` event and leaves the old document. A `new-document` event that names a navigation request the page holds is THAT
 * request's commit (the request keeps its initiating `document` and records `commit`); one naming no request (an engine's error page, a
 * requestless commit) is a new, unattributed document. Request lifecycle facts stay separate: a later navigation request supersedes the
 * latest (Playwright then links no commit to it), a redirect hop is "redirected", an abort names its error. A `new-document` or abort
 * naming a request the page never saw or had already ended, an unreadable event, and an unavailable provenance source are each a named
 * failure (`journal.provenanceFailures`), with the document never guessed.
 *
 * Each problem is an immutable ENVELOPE taken synchronously in the native listener (sequence, page, document and transport stamp of that
 * moment) and only then handed to `ingest`. An announced page's console messages and page errors come from its own listeners, as before
 * (a service worker's messages keep Playwright's per-page delivery). A problem Playwright delivers for a page it has NOT announced yet
 * reaches only the context: the recorder takes it there, with that page's number and document, so it cannot be lost either.
 *
 * Revision 29 (Review 34 F34-1, design assessment token 5b499855…, C1–C5): the request-based bootstrap still missed an activation with
 * NO request before the page's announcement (Firefox's native same-origin `blob:` popup): its commit never reaches the client at all.
 * The recorder therefore also attaches the ACTIVATION SOURCE (`observeActivations`: the lane context's in-process server commits),
 * first, before any page exists (`pagesAtAttach` 0, else a named failure), and records every main-frame activation it reports
 * (`journal.activations`, server receipt order, never re-stamped). The two streams have one explicit hand-off, decided by Playwright's
 * own dispatch, never by URL or time: an activation Playwright did NOT dispatch to the client is applied to its page when the recorder
 * first meets the frame (by server-frame identity), at its own sequence: a requestless new document (or, as the browsing context's
 * first undispatched requestless about:blank commit, its initial document 0); one naming a server request is "unresolved", never
 * requestless. A DISPATCHED activation is paired with the page's next client `new-document` event, whose named request must be the
 * activation's server request (identity). At the first meeting the server frame must show the native document of its last observed
 * activation; with none observed, the old rule stands (an empty initial document, else the named gap). After the context closed, a
 * dispatched activation never delivered (a late subscription, whatever URL the page shows) and an undispatched one no lane page owns are
 * named failures. The first-URL gap is now only the guard for a page with no observed activation; it never clears one.
 *
 * Returns the disposer: it detaches every navigation-provenance subscription once, returning each detachment failure by name (the lane
 * calls it after its context closed, so a final event of the close is still recorded, including when an open fails after its context
 * arrived). An event arriving after it is a `journal.lateEvents` line, never recorded.
 *
 * Revision 30 (Review 35 F35-1, family native-transport-upstream-cleanup; design assessment token 2868a8a2…, C2/C3, invariants 1/3/4/7/8):
 * installation is a TRANSACTION. Every registration the recorder makes (the activation source, each context listener, each page's
 * navigation subscription and its own problem listeners) is owned by one exact-callback ledger (`Subscriptions`) before it is attempted.
 * A context without Playwright's on/off is refused before anything attaches. Should any registration of the installation throw, even
 * after an earlier one (the source) attached, every registration made so far is rolled back, newest first, and `CaptureInstallError`
 * carries the installation's cause and each failed removal: the caller never loses a disposer it was not given. A page's own listeners
 * are a nested scope: if one of them fails, that page's partial registrations are rolled back alone, its number and earlier evidence
 * stay, and its uncaptured problems are a named failure. The disposer now detaches EVERY owned subscription (also the context's and the
 * pages' client listeners, which revision 29 left attached), so an event can reach the recorder afterwards only through a listener whose
 * removal failed (named in the disposer's result); such an event is still a `journal.lateEvents` line, never recorded. `status` is how
 * the context's close ended: only after a completed close are an undelivered dispatched activation and an unowned undispatched one
 * reported as missed; otherwise they are reported as unattributable because the close did not complete (still failures, never dropped).
 *
 * Revision 31 (Review 36 F36-1, family native-transport-console-attribution, harness new; design assessment token 7c961068…, C1–C6,
 * invariants 1–10): a native renderer CRASH of a lane page is one unconditional `crash` problem of its page and document, taken at ONE
 * canonical source per page: the server Page's own `crash` (`RENDERER_CRASH_PIN`), subscribed in its own ledger scope at the earliest
 * server boundary the recorder sees (the page's main-frame commit, possibly before dispatch, or the recorder's first meeting with it),
 * with the server lifecycle read there (a page already crashed is recorded at once). A crash observed before the meeting is frozen then
 * and attributed at the meeting; one of a frame no lane page owns fails at disposal. Only when the server Page cannot be read does the
 * public client Page's `crash` stand in, at the earliest client Page object (announcement or an early problem), the gap already named.
 * DA-1 (C3): every problem and crash callback is ADMITTED before it reads its payload: after disposal (a listener whose removal failed,
 * or one re-entered during a throwing removal) or its own scope's rollback, it is a named `journal.lateEvents` line, never a fresh
 * journal entry; the context's fallback console/weberror no longer drop such events silently. A held envelope keeps the seam's rules.
 */
export function recordContext(
  context: RecordedContext,
  sink: RecorderSink,
  installed: InstalledPlaywrightCore = installedPlaywrightCore(),
): RecordedCapture {
  // Revision 30 (F35-1, C2): a shape refusal before anything is attached.
  if (
    typeof (context as { on?: unknown } | null)?.on !== "function" ||
    typeof (context as { off?: unknown } | null)?.off !== "function"
  )
    throw new CaptureInstallError(
      new TypeError(
        "the context has no on/off of Playwright's shape (a listener attached to it could not be removed); nothing was attached",
      ),
      [],
    );
  const subscriptions = new Subscriptions();
  const { journal, next, stamp } = sink;
  journal.navigations ??= [];
  journal.navigationProvenance ??= [];
  journal.provenanceFailures ??= [];
  journal.pages ??= [];
  const navigations = journal.navigations;
  const failures = journal.provenanceFailures;
  const pages = journal.pages;
  /** Revision 29 (F34-1): one server main frame's activations: those not yet applied (undispatched) or not yet paired (dispatched). */
  interface ServerFrameState {
    ordinal: number;
    page: PageRecord | null;
    /** Every activation of the frame, in server order. */
    all: ActivationRecord[];
    /** Undispatched activations the recorder has not met the frame for yet (applied at that meeting). */
    unapplied: ActivationRecord[];
    /** Dispatched activations whose client `new-document` event has not arrived yet, with their server request (identity). */
    unpaired: Array<{ record: ActivationRecord; request: object | null }>;
    /** Revision 31 (F36-1): the server frame (identity), its crash subscription's state, and whether its crash was observed. */
    frame: object;
    crashSource: "server" | "unavailable" | "failed" | null;
    crashWatch: CrashWatch | null;
    crashObserved: boolean;
    /** A crash observed before the recorder met the frame: frozen at observation, attributed at the meeting (else a named failure). */
    pendingCrash: {
      seq: number;
      observed: TransportStamp;
      text: string;
    } | null;
  }
  interface PageRecord {
    index: number;
    root: unknown;
    documentNo: number;
    latest: RequestRecord | null;
    association: PageAssociation;
    server: ServerFrameState | null;
    /** Revision 31 (F36-1): the client-Page fallback crash subscription, when the server Page cannot be read (once per page). */
    clientCrash: boolean;
    crashRecorded: boolean;
  }
  const byRoot = new Map<unknown, PageRecord>();
  const byPage = new Map<unknown, PageRecord>();
  const records = new Map<unknown, RequestRecord>();
  const owners = new Map<RequestRecord, PageRecord>();
  /** Revision 32: the recorder's finalisation ran (`dispose`); its callback authority is the root scope's (`subscriptions.revoked`). */
  let finalised = false;
  const late = (what: string) => {
    journal.lateEvents ??= [];
    journal.lateEvents.push(
      `${what} delivered after the recorder was detached; not recorded`,
    );
  };
  /**
   * Revision 31 (design assessment DA-1, C3, invariant 5) and revision 32 (Review 39 F39-1, design assessment DA39-2/DA39-3, family
   * native-transport-upstream-cleanup, harness incomplete_fix; token bde6ad2e…, C1–C4, invariants 2/3/9): EVERY native callback of the
   * recorder (context, page, crash, and both adapters') is admitted by its subscription's guard BEFORE it reads its payload; a refused one
   * reaches only this sink, with a static label (never a payload getter or method, also not to build the label). After the recorder was
   * revoked (finalisation began, or the installation failed: before any removal, so also a callback whose removal failed or one
   * re-entered during a throwing `off`) it is a named late line; after its own subscription was refused or rolled back, a named late
   * line of that; while its own `on` was still running, a named capture gap (a failure: the recorder could not read it then). Never a
   * fresh journal entry, document, request record or Page mutation. An envelope already captured and held by the ingestion seam is not a
   * callback: its delivery keeps the seam's own rules (`put`).
   */
  const refused = (
    what: string,
    refusal: Refusal,
    /** The refused callback's ledger scope; null for an adapter's own (whose `local` refusal is its refusal or rollback). */
    scope: Subscriptions | null,
  ) => {
    if (refusal === "installing") {
      failures.push(
        `${what} delivered while its listener was still being installed; not recorded, so the lane's capture of it is incomplete`,
      );
      return;
    }
    if (refusal === "enclosing" || scope === subscriptions) return late(what);
    journal.lateEvents ??= [];
    journal.lateEvents.push(
      `${what} delivered after its listener's subscription was rolled back; not recorded`,
    );
  };
  journal.crashWatches ??= [];
  const crashWatches = journal.crashWatches;
  // Revision 29 (F34-1): the activation source, attached FIRST (the recorder runs as the context arrives, before any page of it exists;
  // `pagesAtAttach` proves it). Unavailable is a named failure: then nothing undispatched can be observed, and the first-URL gap rule below
  // remains the only guard.
  journal.activations ??= [];
  const activations = journal.activations;
  const serverFrames = new Map<object, ServerFrameState>();
  const stateOf = (frame: object): ServerFrameState => {
    let state = serverFrames.get(frame);
    if (state === undefined) {
      state = {
        ordinal: serverFrames.size,
        page: null,
        all: [],
        unapplied: [],
        unpaired: [],
        frame,
        crashSource: null,
        crashWatch: null,
        crashObserved: false,
        pendingCrash: null,
      };
      serverFrames.set(frame, state);
    }
    return state;
  };
  const onServerCommit = (commit: ServerCommit) => {
    if (subscriptions.revoked)
      return late("a server-observed document activation");
    if (!commit.ok) {
      failures.push(
        `a document activation Playwright's server observed is unreadable (${commit.reason}); its page's documents cannot be attributed`,
      );
      return;
    }
    // A subframe's commit never changes its page's document (its client events never reach the main frame's provenance either).
    if (!commit.main) return;
    const state = stateOf(commit.frame);
    const record: ActivationRecord = {
      seq: next(),
      page: state.page?.index ?? -1,
      frame: state.ordinal,
      kind:
        state.all.length === 0 &&
        !commit.dispatched &&
        commit.request === null &&
        commit.url === "about:blank"
          ? "initial-document"
          : "new-document",
      url: commit.url,
      nativeDocument: commit.nativeDocument,
      request:
        commit.request === null
          ? "none"
          : commit.dispatched
            ? "linked"
            : "unresolved",
      dispatched: commit.dispatched,
      observed: stamp(),
    };
    activations.push(record);
    state.all.push(record);
    // Revision 31 (F36-1, C2): the page's renderer crash, subscribed at its server Page at this, the earliest server boundary (possibly
    // before Playwright dispatched the frame or announced the page).
    watchServerCrash(state, "server-commit");
    if (commit.dispatched) {
      state.unpaired.push({ record, request: commit.request });
      return;
    }
    if (state.page === null) {
      state.unapplied.push(record);
      return;
    }
    // A frame the recorder already met has a dispatcher (its client frame exists): an undispatched commit of it contradicts that.
    failures.push(
      `page ${state.page.index}: an activation of its main frame (journal #${record.seq}, ${record.url}) was not dispatched although the recorder already met the frame; its documents cannot be attributed`,
    );
    applyActivation(state.page, record);
  };
  /** An undispatched activation, applied to its page at its OWN sequence (never re-stamped): a requestless new document, or document 0. */
  const applyActivation = (page: PageRecord, record: ActivationRecord) => {
    record.page = page.index;
    if (record.kind === "initial-document") return;
    if (record.request === "unresolved")
      failures.push(
        `page ${page.index}: activation #${record.seq} (${record.url}) names a request Playwright never delivered: unresolved, never treated as requestless`,
      );
    const from = page.documentNo;
    page.documentNo += 1;
    navigations.push({
      seq: record.seq,
      page: page.index,
      url: record.url,
      kind: "new-document",
      from,
      document: page.documentNo,
      request: null,
      reason:
        record.request === "unresolved"
          ? "a new document whose request Playwright never delivered (unresolved; unattributed)"
          : "a requestless new document, committed before Playwright dispatched its frame (observed at the server context)",
    });
  };
  // Revision 32 (F39-1, C2): the source admits each commit by the recorder's authority before it reads it (its own state second).
  const source = observeActivations(context, onServerCommit, installed, {
    admits: () => !subscriptions.revoked,
    rejected: (refusal) =>
      refused("a server-observed document activation", refusal, null),
  });
  // Revision 30 (F35-1, C2): owned at once, so a later failure of the installation rolls it back with the rest.
  if (source.ok)
    subscriptions.adopt("detaching the activation source", source.dispose);
  if (source.ok) {
    journal.activationSource = {
      source: "playwright-server-context",
      version: installed.version as string,
      bundleSha256: installed.bundleSha256,
      pagesAtAttach: source.pagesAtAttach,
    };
    if (source.pagesAtAttach !== 0)
      failures.push(
        `the activation source attached after ${source.pagesAtAttach} page(s) of its context existed: their earlier activations cannot have been observed`,
      );
  } else {
    journal.activationSource = { unavailable: source.reason };
    failures.push(
      `activation source unavailable (${source.reason}): an activation before Playwright dispatches a page's frame cannot be observed`,
    );
  }
  // Revision 30 (F35-1, C2): the context's listeners are declared here in order and registered together by the installation below, each
  // through the ledger (its removal owned before its `on` runs).
  const declared: Array<{ event: string; listener: (value: never) => void }> =
    [];
  const on = <T>(event: string, listener: (value: T) => void) => {
    declared.push({ event, listener: listener as (value: never) => void });
  };
  /** Revision 32 (DA39-2, C2): the static label a refused context callback is reported by (no payload is read to build it). */
  const CONTEXT_EVENT_LABELS: Readonly<Record<string, string>> = {
    request: "a request",
    response: "a response",
    requestfailed: "a request failure",
    requestfinished: "a request end",
    page: "a page announcement",
    console: "a console message",
    weberror: "a page error",
  };
  const describe = (request: RecordedRequest) => {
    try {
      return `${request.method()} ${request.url()}`;
    } catch (error) {
      return `<unreadable request: ${firstLine(error)}>`;
    }
  };
  const end = (record: RequestRecord, reason: string) => {
    if (record.commit === undefined) {
      record.commit = null;
      record.commitReason = reason;
    }
    const owner = owners.get(record);
    if (owner !== undefined && owner.latest === record) owner.latest = null;
  };
  const onNavigated = (page: PageRecord, value: unknown) => {
    if (subscriptions.revoked)
      return late(`page ${page.index}: a navigation event`);
    const index = page.index;
    const seq = next();
    const from = page.documentNo;
    const read = readNavigated(value);
    if (!read.ok) {
      failures.push(
        `page ${index}: navigation event #${seq} unreadable (${read.reason}); the page's document is unknown from here`,
      );
      navigations.push({
        seq,
        page: index,
        url: "",
        kind: "unreadable",
        from,
        document: page.documentNo,
        request: null,
        reason: read.reason,
      });
      return;
    }
    const named = read.request === null ? undefined : records.get(read.request);
    const record =
      named !== undefined && owners.get(named) === page ? named : undefined;
    if (read.request !== null && record === undefined)
      failures.push(
        named === undefined
          ? `page ${index}: navigation event #${seq} (${read.kind}) names a request this page's recorder never saw`
          : `page ${index}: navigation event #${seq} (${read.kind}) names request #${named.seq}, which is ${named.page < 0 ? "not attributed to a page" : `page ${named.page}'s`}`,
      );
    const base = { seq, page: index, url: read.url, from };
    if (read.kind === "same-document") {
      navigations.push({
        ...base,
        kind: "same-document",
        document: page.documentNo,
        request: null,
        reason:
          "a same-document change (fragment or history API): no new document",
      });
      return;
    }
    if (read.kind === "aborted") {
      if (record !== undefined) {
        if (record.commit != null)
          failures.push(
            `page ${index}: navigation event #${seq} aborts request #${record.seq}, which had committed document ${record.commit.document}`,
          );
        end(record, `aborted without committing a document: ${read.error}`);
      }
      navigations.push({
        ...base,
        kind: "aborted",
        document: page.documentNo,
        request: record?.seq ?? null,
        error: read.error,
        reason: `a navigation aborted (${read.error}): the document stays`,
      });
      return;
    }
    // Revision 29 (F34-1): the hand-off. Each client new-document event is the page's oldest dispatched server activation not yet paired,
    // and names that activation's own server request (identity), or none when it has none. Anything else is a named failure.
    if (page.server !== null && source.ok) {
      const pair = page.server.unpaired.shift();
      if (pair === undefined)
        failures.push(
          `page ${index}: navigation event #${seq} (new-document, ${read.url}) has no activation observed at Playwright's server`,
        );
      else {
        pair.record.pairedWith = seq;
        pair.record.page = index;
        const named =
          read.request === null ? null : source.serverRequestOf(read.request);
        if (read.request !== null && named === null)
          failures.push(
            `page ${index}: navigation event #${seq} (new-document) names a request whose server request is unreadable; it cannot be paired with server activation #${pair.record.seq}`,
          );
        else if (named !== pair.request)
          failures.push(
            `page ${index}: navigation event #${seq} (new-document) ${read.request === null ? "names no request" : "names a request"} but its server activation #${pair.record.seq} ${pair.request === null ? "has none" : read.request === null ? "has one" : "has another"}`,
          );
      }
    }
    page.documentNo += 1;
    let request: number | null = null;
    let reason =
      "a new document no navigation request is linked to (unattributed)";
    if (record !== undefined) {
      if (record.commit === undefined) {
        record.commit = { seq, document: page.documentNo };
        if (page.latest === record) page.latest = null;
        request = record.seq;
        reason = `committed by navigation #${record.seq}`;
      } else {
        failures.push(
          `page ${index}: navigation event #${seq} commits a new document for request #${record.seq}, which had already ${record.commit === null ? `ended (${record.commitReason})` : `committed document ${record.commit.document}`}`,
        );
        reason = `a new document naming request #${record.seq}, which could no longer commit one (unattributed)`;
      }
    }
    navigations.push({
      ...base,
      kind: "new-document",
      document: page.documentNo,
      request,
      reason,
    });
  };
  /** The page whose main frame is `root`: the existing record (identity), or a new one, numbered and subscribed NOW. */
  const pageOf = (root: unknown, via: PageAssociation["via"]): PageRecord => {
    const known = byRoot.get(root);
    if (known !== undefined) return known;
    const index = pages.length;
    let firstUrl: string;
    try {
      firstUrl = String((root as RecordedFrame).url());
    } catch (error) {
      firstUrl = `<url() threw: ${firstLine(error)}>`;
    }
    const association: PageAssociation = {
      page: index,
      via,
      firstUrl,
      announced: false,
    };
    pages.push(association);
    const page: PageRecord = {
      index,
      root,
      documentNo: 0,
      latest: null,
      association,
      server: null,
      clientCrash: false,
      crashRecorded: false,
    };
    byRoot.set(root, page);
    // Subscribed in the listener that first met the frame, before Playwright can deliver its next event: no navigation of it is unobserved.
    // Revision 30 (F35-1, C2, OWN-3): owned by the ledger; a subscription that attached and then threw was removed by the adapter and is
    // this page's named capture gap below (its number and earlier evidence stay).
    // Revision 32 (F39-1, C2): admitted by the recorder's authority and the subscription's own state before the event is read; a
    // subscription refused with its listener left attached (a failed rollback) stays inert.
    const subscription = observeNavigations(
      root,
      (event) => onNavigated(page, event),
      installed,
      {
        admits: () => !subscriptions.revoked,
        rejected: (refusal) =>
          refused(`page ${index}: a navigation event`, refusal, null),
      },
    );
    if (subscription.ok) {
      subscriptions.adopt(
        `page ${index}: detaching its navigation provenance`,
        subscription.dispose,
      );
      journal.navigationProvenance?.push({
        page: index,
        ...subscription.provenance,
      });
    } else {
      journal.navigationProvenance?.push({
        page: index,
        unavailable: subscription.reason,
      });
      failures.push(
        `page ${index}: navigation provenance unavailable (${subscription.reason}); its documents cannot be attributed`,
      );
    }
    // Revision 29 (F34-1): the frame's activations before this meeting. Undispatched ones never reach the client: they are applied now, at
    // their own sequences. The chain is checked by NATIVE document identity: the server frame must now show the last activation observed
    // of it. With none observed, the page still shows its unreported initial document, which must be empty ("" or about:blank).
    let observed: ActivationRecord | undefined;
    if (source.ok) {
      const found = source.serverFrameOf(root);
      if (!found.ok)
        failures.push(
          `page ${index}: its server frame cannot be identified (${found.reason}); its activations cannot be attributed`,
        );
      else {
        const state = stateOf(found.frame);
        if (state.page !== null)
          failures.push(
            `page ${index}: its server frame is already page ${state.page.index}'s`,
          );
        else {
          state.page = page;
          page.server = state;
          for (const record of state.all) record.page = index;
          for (const record of state.unapplied.splice(0))
            applyActivation(page, record);
          // Revision 31 (F36-1, C2): a crash observed before this meeting is the page's, at its own frozen sequence and stamp, in the
          // document it had then (its earlier activations are applied above); then the page's crash subscription (once per frame).
          if (state.crashWatch !== null) state.crashWatch.page = index;
          const pending = state.pendingCrash;
          if (pending !== null) {
            state.pendingCrash = null;
            page.crashRecorded = true;
            problem(page, "crash", pending.text, urlOf(page), pending);
          }
          watchServerCrash(state, "page-met");
          observed = state.all.at(-1);
          if (
            observed !== undefined &&
            found.currentDocument !== observed.nativeDocument
          )
            failures.push(
              `page ${index}: first met showing native document ${JSON.stringify(found.currentDocument)}, not its last observed activation #${observed.seq} (${JSON.stringify(observed.nativeDocument)}): an activation was not observed, so its documents cannot be attributed`,
            );
        }
      }
    }
    if (observed === undefined && firstUrl !== "" && firstUrl !== "about:blank")
      failures.push(
        `page ${index}: first met (${via === "request" ? "at a request of its main frame" : via === "page" ? "at its announcement" : "at a problem before its announcement"}) already showing ${firstUrl}: an earlier document activation was not observed, so its documents cannot be attributed`,
      );
    return page;
  };
  const unattributed = (record: RequestRecord) => {
    journal.unattributedRequests ??= [];
    journal.unattributedRequests.push(record);
  };
  on("request", (request: RecordedRequest) => {
    const found = frameOfRequest(request, installed);
    let owner: PageRecord | null = null;
    let why = "";
    if (!found.ok) why = found.reason;
    else if (found.frame === null) why = "reason" in found ? found.reason : "";
    else {
      const top = rootOf(found.frame);
      if (top.ok) owner = pageOf(top.root, "request");
      else why = top.reason;
    }
    let navigation = false;
    try {
      navigation =
        owner !== null &&
        found.ok &&
        found.frame === owner.root &&
        request.isNavigationRequest();
    } catch {
      navigation = false;
    }
    const record: RequestRecord = {
      seq: next(),
      page: owner?.index ?? -1,
      document: owner?.documentNo ?? -1,
      method: request.method(),
      url: request.url(),
      navigation,
      observed: stamp(),
      terminal: null,
    };
    records.set(request, record);
    if (owner === null) {
      record.unattributed = why;
      unattributed(record);
      if (!found.ok || found.frame !== null)
        failures.push(
          `request #${record.seq} ${record.method} ${record.url}: its page cannot be identified (${why}); it is not attributed`,
        );
      return;
    }
    owners.set(record, owner);
    let hop: RequestRecord | undefined;
    try {
      const from = request.redirectedFrom();
      hop = from === null ? undefined : records.get(from);
    } catch {
      hop = undefined;
    }
    if (hop !== undefined) {
      record.redirectedFrom = hop.seq;
      if (hop.navigation) end(hop, `redirected to #${record.seq}`);
    }
    journal.requests.push(record);
    if (record.navigation) {
      // Playwright links a commit only to the frame's latest navigation request (its pending document's), so an earlier one that has not
      // committed cannot any more; a commit naming it is a named failure above, never re-attributed.
      if (owner.latest !== null)
        end(owner.latest, `superseded by navigation #${record.seq}`);
      owner.latest = record;
    }
  });
  on(
    "response",
    (response: { request(): RecordedRequest; status(): number }) => {
      const seq = next();
      const request = response.request();
      const record = records.get(request);
      if (record === undefined) {
        failures.push(
          `a response (journal #${seq}, status ${response.status()}) to a request the recorder never saw: ${describe(request)}`,
        );
        return;
      }
      // A response is not a commit: the document changes only at a new-document event (above).
      if (record.terminal === null)
        record.terminal = { seq, kind: "response", status: response.status() };
    },
  );
  on("requestfailed", (request: RecordedRequest) => {
    const seq = next();
    const record = records.get(request);
    if (record === undefined) {
      failures.push(
        `a request failure (journal #${seq}) of a request the recorder never saw: ${describe(request)}`,
      );
      return;
    }
    const errorText = request.failure()?.errorText ?? "";
    // A failure is not a document fact either: an abort (or an engine's error document) arrives as its own navigation event.
    if (record.terminal === null)
      record.terminal = { seq, kind: "failed", errorText };
    else record.failedAfterResponse = { seq, errorText };
  });
  on("requestfinished", (request: RecordedRequest) => {
    const seq = next();
    const record = records.get(request);
    if (record === undefined) {
      failures.push(
        `a request end (journal #${seq}) of a request the recorder never saw: ${describe(request)}`,
      );
      return;
    }
    record.finishedSeq = seq;
  });
  const problem = (
    page: PageRecord,
    type: string,
    text: string,
    location: string,
    /** Revision 31 (F36-1): a crash observed before the recorder met its page keeps the sequence and stamp of its observation. */
    at?: { seq: number; observed: TransportStamp },
  ) => {
    const { category, url, status } = categorise(type, text, location);
    // The envelope: everything that attributes it is taken HERE, in the native listener, and frozen before anything can hold it.
    sink.ingest(
      Object.freeze({
        seq: at?.seq ?? next(),
        page: page.index,
        document: page.documentNo,
        type,
        text,
        url,
        category,
        ...(status !== undefined ? { status } : {}),
        observed: Object.freeze(at?.observed ?? stamp()),
      }),
    );
  };
  /** The record of a page object Playwright delivered (announced or not), by its main frame's identity; null when unreadable. */
  const recordOfPage = (
    page: RecordedPage,
    via: PageAssociation["via"],
  ): PageRecord | null => {
    let root: unknown;
    try {
      root = page.mainFrame();
    } catch (error) {
      failures.push(
        `a page (${via}) without a readable main frame (${firstLine(error)}); not recorded`,
      );
      return null;
    }
    return pageOf(root, via);
  };
  // ---- Revision 31 (Review 36 F36-1, family native-transport-console-attribution; design assessment token 7c961068…, C1–C3/C6) ----
  // A native renderer crash is one unconditional failure of its page (`crash` problem), taken at ONE canonical source per page: the
  // server Page's own `crash` (`RENDERER_CRASH_PIN`), subscribed at the earliest server boundary the recorder sees, with the server
  // lifecycle read there (a page already crashed is recorded at once: its crash preceded the subscription and is never replayed). Only
  // when the server Page cannot be read does the public client Page's `crash` stand in, at the earliest client Page object. Nothing is
  // evaluated in the crashed renderer; its URL is optional diagnostic data. A crash moves no document and is no request terminal.
  const CRASH = "native renderer crash";
  const urlOf = (page: PageRecord) => {
    try {
      return String((page.root as RecordedFrame).url());
    } catch {
      return "";
    }
  };
  /** A crash observed at `state`'s server Page: its page's problem now, or frozen until the recorder meets the frame. Once per frame. */
  const serverCrash = (state: ServerFrameState, how: string) => {
    if (state.crashObserved) return;
    state.crashObserved = true;
    const text = `${CRASH} (${how})`;
    const page = state.page;
    if (page === null) {
      state.pendingCrash = {
        seq: next(),
        observed: Object.freeze(stamp()),
        text,
      };
      return;
    }
    page.crashRecorded = true;
    problem(page, "crash", text, urlOf(page));
  };
  function watchServerCrash(
    state: ServerFrameState,
    at: "server-commit" | "page-met",
  ): void {
    if (state.crashSource !== null || !source.ok) return;
    const where = () =>
      state.page === null
        ? `server frame ${state.ordinal} (a main frame the recorder has not met)`
        : `page ${state.page.index}`;
    const read = source.serverPageOfFrame(state.frame);
    if (!read.ok) {
      state.crashSource = "unavailable";
      failures.push(
        `${where()}: its renderer crash cannot be observed at Playwright's server page (${read.reason}); a crash before its announcement is not captured`,
      );
      return;
    }
    // Its own nested scope: a failure here rolls back this subscription alone, and the page's other evidence stays.
    const scope = subscriptions.child();
    const onCrash = () => {
      // Revision 32: admitted by the scope's guard (`add` below) before this runs.
      // Inside Playwright's own server listener: nothing may throw back into it.
      try {
        serverCrash(
          state,
          "Playwright's server page reported that the renderer crashed",
        );
      } catch (error) {
        failures.push(
          `${where()}: recording its renderer crash threw (${firstLine(error)}); the crash is not attributed`,
        );
      }
    };
    try {
      scope.add(
        `${where()}: detaching its renderer-crash listener`,
        read.page,
        RENDERER_CRASH_PIN.event,
        onCrash as (value: never) => void,
        (refusal) => refused(`${where()}: a renderer crash`, refusal, scope),
      );
    } catch (error) {
      const rollback = scope.detach();
      state.crashSource = "failed";
      failures.push(
        `${where()}: installing its renderer-crash listener failed (${String(error)}); a crash of it is not captured${rollback.length === 0 ? "" : `; rolling back its partial listener also failed: ${rollback.join("; ")}`}`,
      );
      return;
    }
    state.crashSource = "server";
    const watch: CrashWatch = {
      page: state.page?.index ?? -1,
      frame: state.ordinal,
      source: "server-page",
      at,
      announced: state.page?.association.announced ?? false,
    };
    state.crashWatch = watch;
    crashWatches.push(watch);
    let lifecycle: string;
    try {
      lifecycle = read.lifecycle();
    } catch (error) {
      failures.push(
        `${where()}: its server page's lifecycle is unreadable (${firstLine(error)}); a crash before its subscription cannot be known`,
      );
      return;
    }
    watch.lifecycle = lifecycle;
    if (lifecycle === "crashed")
      serverCrash(
        state,
        "the page had already crashed when the recorder subscribed at Playwright's server page",
      );
  }
  /** The fallback: the public client Page's `crash`, only for a page whose server Page could not be subscribed (named above). */
  const watchClientCrash = (
    pageObject: unknown,
    record: PageRecord,
    at: "announcement" | "early-problem",
  ) => {
    if (record.clientCrash || record.server?.crashSource === "server") return;
    record.clientCrash = true;
    const scope = subscriptions.child();
    const onCrash = () => {
      if (record.crashRecorded) return;
      record.crashRecorded = true;
      problem(
        record,
        "crash",
        `${CRASH} (Playwright's client page reported that the renderer crashed)`,
        urlOf(record),
      );
    };
    try {
      scope.add(
        `page ${record.index}: detaching its client renderer-crash listener`,
        pageObject,
        "crash",
        onCrash as (value: never) => void,
        (refusal) =>
          refused(`page ${record.index}: a renderer crash`, refusal, scope),
      );
    } catch (error) {
      const rollback = scope.detach();
      failures.push(
        `page ${record.index}: installing its client renderer-crash listener failed (${String(error)}); a crash of it is not captured${rollback.length === 0 ? "" : `; rolling back its partial listener also failed: ${rollback.join("; ")}`}`,
      );
      return;
    }
    crashWatches.push({
      page: record.index,
      frame: record.server?.ordinal ?? null,
      source: "client-page",
      at,
      announced: record.association.announced,
    });
  };
  on("page", (page: RecordedPage) => {
    const record = recordOfPage(page, "page");
    if (record === null) return;
    if (record.association.announced)
      failures.push(`page ${record.index}: announced twice`);
    record.association.announced = true;
    byPage.set(page, record);
    watchClientCrash(page, record, "announcement");
    // Revision 30 (F35-1, C2, OWN-3): the page's own listeners are a nested scope of the ledger. If one fails, the page's partial
    // registrations are rolled back alone, and its uncaptured problems are a named failure; the page and its evidence so far stay.
    // Revision 31 (DA-1, C3): each callback is admitted first (recorder disposal, and this scope's own rollback).
    // Revision 32 (C1): by the scope's guard, before the callback runs (the parent's revocation first).
    const own = subscriptions.child();
    const onConsole = (message: ConsoleMessage) => {
      if (message.type() === "error" || message.type() === "warning")
        problem(
          record,
          message.type(),
          message.text(),
          message.location().url ?? "",
        );
    };
    const onPageError = (error: Error) => {
      problem(record, "pageerror", error.message, "");
    };
    try {
      own.add(
        `page ${record.index}: detaching its console listener`,
        page,
        "console",
        onConsole as (value: never) => void,
        (refusal) =>
          refused(`page ${record.index}: a console message`, refusal, own),
      );
      own.add(
        `page ${record.index}: detaching its pageerror listener`,
        page,
        "pageerror",
        onPageError as (value: never) => void,
        (refusal) =>
          refused(`page ${record.index}: a page error`, refusal, own),
      );
    } catch (error) {
      const rollback = own.detach();
      failures.push(
        `page ${record.index}: installing its own problem listeners failed (${String(error)}); its console messages and page errors after its announcement are not captured${rollback.length === 0 ? "" : `; rolling back its partial listeners also failed: ${rollback.join("; ")}`}`,
      );
    }
  });
  // A page's problem Playwright delivers before it announced the page reaches only the context (its page has no listener of ours yet).
  const unannounced = (page: unknown): PageRecord | null => {
    if (page === null || page === undefined || byPage.has(page)) return null;
    const record = recordOfPage(page as RecordedPage, "problem");
    // Revision 31 (F36-1, C2): a Page object exposed before its announcement gets its crash subscription now, not at the announcement.
    if (record !== null) watchClientCrash(page, record, "early-problem");
    return record;
  };
  // Revision 31 (DA-1, C3): after disposal these are named late lines too (revision 30 dropped them silently).
  // Revision 32: refused by their guard (the installation below), before they run.
  on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    let page: unknown = null;
    try {
      page = message.page();
    } catch {
      page = null;
    }
    const record = unannounced(page);
    if (record !== null)
      problem(
        record,
        message.type(),
        message.text(),
        message.location().url ?? "",
      );
  });
  on("weberror", (webError: { page(): unknown; error(): Error }) => {
    let page: unknown = null;
    try {
      page = webError.page();
    } catch {
      page = null;
    }
    const record = unannounced(page);
    if (record !== null)
      problem(record, "pageerror", webError.error().message, "");
  });
  // Revision 30 (F35-1, C2): the installation, one transaction. Should any registration throw (before or after attaching), everything
  // registered so far, the activation source included, is rolled back newest first, and the caller receives every cause.
  try {
    for (const { event, listener } of declared)
      subscriptions.add(
        `detaching the recorder's context "${event}" listener`,
        context,
        event,
        listener,
        (refusal) =>
          refused(
            CONTEXT_EVENT_LABELS[event] ?? `a context "${event}" event`,
            refusal,
            subscriptions,
          ),
      );
  } catch (error) {
    finalised = true;
    throw new CaptureInstallError(error, subscriptions.detach());
  }
  return {
    // Revision 32 (C3, invariant 6): the owner revokes the recorder's authority BEFORE its first removal of any listener (its own lane
    // listeners included), once the context's close has ended; nothing is removed here.
    revoke: () => subscriptions.revoke(),
    dispose: (status: CloseStatus = "closed") => {
      if (finalised) return [];
      finalised = true;
      const errors = subscriptions.detach();
      // Revision 29 (F34-1): the lane's context has closed, so every commit Playwright dispatched has been delivered. A dispatched
      // activation without its client event was missed by a late subscription (whatever URL the page ended on); an undispatched one whose
      // frame the recorder never met belongs to no lane page. Both are named failures, never dropped.
      // Revision 30 (F35-2, C3, invariant 8): only a COMPLETED close says so. After a failed or pending close they are still named
      // failures, but as unattributable evidence of an incomplete close, never as proof that delivery was complete.
      const incomplete =
        status === "closed"
          ? ""
          : ` (the context's close ${status === "not attempted" ? "was not attempted" : status === "pending" ? "was still pending" : "failed"} when the recorder was finalised, so its delivery is incomplete)`;
      for (const state of serverFrames.values()) {
        const where =
          state.page === null
            ? `a main frame the recorder never met (server frame ${state.ordinal})`
            : `page ${state.page.index}`;
        for (const { record } of state.unpaired)
          failures.push(
            incomplete === ""
              ? `${where}: activation #${record.seq} (${record.url}) was dispatched to Playwright's client but the recorder never received its navigation event; its documents cannot be attributed`
              : `${where}: activation #${record.seq} (${record.url}) was dispatched to Playwright's client and its navigation event had not arrived${incomplete}; its documents cannot be attributed`,
          );
        for (const record of state.unapplied)
          failures.push(
            `${where}: activation #${record.seq} (${record.url}) was never attributed to a lane page${incomplete}`,
          );
        // Revision 31 (F36-1): a crash of a frame no lane page owns is still the lane's failure, never dropped.
        if (state.pendingCrash !== null)
          failures.push(
            `${where}: a native renderer crash observed at journal #${state.pendingCrash.seq} was never attributed to a lane page${incomplete}; the lane's capture of it is incomplete`,
          );
      }
      return errors;
    },
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
  /** Revision 26: envelopes the ingestion seam still holds (captured at the native listener, not yet in the journal). */
  heldProblems(): Array<Readonly<Problem>>;
  /**
   * Revision 26: seals the journal for classification (settlement calls it after closing): a later delivery is late, never classified.
   * Returns the failures it found: each envelope still held, and each misuse of the ingestion seam.
   */
  seal(): string[];
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
 *
 * Revision 21 (Review 25 F25-1): the scope owns what `acquire` acquired the moment it arrives, BEFORE the wrapper sees it, so a wrapper
 * that rejects (or is held) after a successful acquisition never takes that resource out of ownership. `acquire` is single-use; once the
 * wrapper has ended, the open has failed or settlement has begun, it refuses. A wrapper must deliver exactly what `acquire` gave it: a
 * second acquisition, a substituted value or a value delivered without a successful acquisition fails the stage (`LaneSeamMisuse`).
 */
export type Interpose = <T>(
  stage: OpenStage,
  acquire: () => Promise<T>,
) => Promise<T>;

/**
 * Revision 26 (F31-1, design assessment C4): a QUALIFICATION seam only (default: none), downstream of the native listener. It receives
 * each problem's frozen envelope, already attributed at the listener, and `deliver`, which puts that envelope in the journal (single use).
 * A control may hold delivery. A delivery after the lane's journal was sealed for classification is recorded as late and never classified;
 * an envelope still held at the seal fails the report by name. Never used by an application case.
 */
export type Ingest = (problem: Readonly<Problem>, deliver: () => void) => void;

export interface TransportLanesOptions {
  /** Bound on joining admitted opens and their pending acquisitions once settlement begins (default 10,000 ms). */
  joinBoundMs?: number;
  /** Bound on each disposer (default 10,000 ms). */
  disposeBoundMs?: number;
  interpose?: Interpose;
  ingest?: Ingest;
  /** Where an outcome arriving AFTER the report was returned is written (default: the worker's stderr); it is also kept in `late`. */
  onLate?: (line: string) => void;
}

/** A stage refused because settlement began (the open is cancelled, never published). */
export class LaneCancelled extends Error {
  override name = "LaneCancelled";
}

/** A qualification wrapper broke the seam's contract (revision 21): the stage fails by name; nothing it did not acquire is owned. */
export class LaneSeamMisuse extends Error {
  override name = "LaneSeamMisuse";
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

/**
 * One stage's holding: owned from admission, before its acquisition starts.
 *
 * Revision 21 (Review 25 F25-1, family native-transport-upstream-cleanup; design assessment token 8179e31e…, invariants 1–6): three
 * separately observable facts. `acquisition` is the REAL acquisition (the operation `acquire` starts), `wrapper` is the qualification
 * wrapper's outcome (the stage's outcome for its open), and `disposal` is the one close of what was acquired. Ownership follows the
 * acquisition, never the wrapper: a failed wrapper does not mean nothing was acquired, and a held wrapper does not mean the acquisition
 * is pending. A successful acquisition's value may be `undefined` (an init script's); its state, not its truthiness, says it was acquired.
 */
interface Holding {
  stage: OpenStage;
  acquisition: "not_begun" | "pending" | "acquired" | "rejected";
  wrapper: "pending" | "delivered" | "failed";
  disposal: "none" | "disposing" | "disposed" | "dispose_failed";
  /** Settles (never rejects) once the acquisition has settled and its result is recorded here; already settled if it never began. */
  acquired: Promise<void>;
  /** Settles (never rejects) once the wrapper's outcome is recorded here. */
  delivered: Promise<void>;
  /** The acquired value, recorded BEFORE the wrapper receives it (meaningful only once `acquisition` is "acquired"). */
  handle?: unknown;
  acquisitionError?: string;
  wrapperError?: string;
  /** How the wrapper broke the seam's contract, if it did (the stage then fails with `LaneSeamMisuse`). */
  misuse?: string;
  /** A join bound ended before the acquisition settled: its result is disposed, or its rejection recorded, when it arrives. */
  late?: boolean;
  /** A join bound ended with the wrapper still pending: its outcome is recorded when it arrives. */
  wrapperLate?: boolean;
  /**
   * `object`: the disposer closes a pre-built object (a listener) whatever its start did, so it is ARMED when the acquisition begins (a
   * partial or failed start is still closed; each listener's close joins a start in progress). `handle`: the disposer needs the acquired
   * value, so only a successful acquisition arms it (a foreign API that rejects, such as `newContext`, owns its own unwinding).
   */
  arms: "object" | "handle";
  dispose: ((handle: unknown) => Promise<unknown>) | null;
  /** The ONE disposal of this holding (shared by every caller: an open's own unwinding, settlement and a late arrival). */
  disposalRun?: Promise<string | null>;
  /**
   * Revision 30 (Review 35 F35-1, C1): a handle-armed holding whose acquisition ADOPTED its resource into an owner before a later step of
   * the same acquisition failed (the context, before its capture installation). True once adopted: the holding is then armed although
   * its acquisition rejected, so the failed open's unwinding, settlement and a late arrival close it through that owner, once.
   */
  adopted?: () => boolean;
  /** Revision 30 (F35-2, C3): the disposer bounds its own slow operation and reports every cause itself (it is not raced again). */
  boundsItself?: boolean;
  /** Revision 30 (C4): the disposal's failure, as reported (the snapshot keeps it beside `disposal`). */
  disposalError?: string;
}

/** Who is disposing (for the bound's named failure and the late lines). */
interface Disposer {
  bound: string;
  after: string;
}
const BY_SETTLEMENT: Disposer = {
  bound: "settlement's join bound",
  after: "settlement",
};
const BY_UNWINDING: Disposer = {
  bound: "its failed open's unwinding bound",
  after: "its failed open's unwinding",
};

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
 *
 * Revision 21 (F25-1): the result is adopted INSIDE the acquisition `acquire` hands the wrapper, before the wrapper's continuation can
 * run, so the wrapper's outcome can neither erase nor replace it. Once any stage of the open has failed the scope admits nothing more.
 */
class OpenScope {
  /** Set when a stage of this open fails (its wrapper failed) or the open failed: no stage or acquisition is admitted after it. */
  private failed = false;

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
    if (this.failed)
      throw new LaneSeamMisuse(
        `open ${this.record.id} refused ${when} ${stage}: the open has already failed`,
      );
  }

  /** The open failed: nothing more is admitted (its unwinding follows). */
  fail(): void {
    this.failed = true;
  }

  /** Revision 30 (F35-1, C1, OWN-7): whether further set-up may still use a resource that just arrived (settlement not begun, open not failed). */
  admits(): boolean {
    return !this.closing() && !this.failed;
  }

  acquire<T>(
    stage: OpenStage,
    start: () => Promise<T>,
    dispose: ((handle: T) => Promise<unknown>) | null,
    {
      gateAfter = true,
      arms = "handle",
      adopted,
      boundsItself,
    }: {
      gateAfter?: boolean;
      arms?: Holding["arms"];
      adopted?: Holding["adopted"];
      boundsItself?: boolean;
    } = {},
  ): Promise<T> {
    this.gate(stage, "before");
    this.record.stage = stage;
    this.record.stages.push({ stage, at: Date.now() });
    const id = this.record.id;
    const holding: Holding = {
      stage,
      acquisition: "not_begun",
      wrapper: "pending",
      disposal: "none",
      acquired: Promise.resolve(),
      delivered: Promise.resolve(),
      arms,
      dispose: dispose as Holding["dispose"],
      ...(adopted !== undefined ? { adopted } : {}),
      ...(boundsItself === true ? { boundsItself } : {}),
    };
    this.record.holdings.push(holding);
    let calls = 0;
    // The REAL acquisition, single-use. Its result is recorded on the holding (owned) in the first reaction to it, and only THEN is it
    // handed to the wrapper: whatever the wrapper later does (reject, hold, or never deliver), the resource is already owned.
    const acquireOnce = (): Promise<T> => {
      calls += 1;
      if (calls > 1) {
        holding.misuse ??= `the ${stage} wrapper asked for its acquisition more than once (it is single-use)`;
        return Promise.reject(
          new LaneSeamMisuse(`open ${id}: ${holding.misuse}`),
        );
      }
      try {
        this.gate(stage, "before");
      } catch (error) {
        return Promise.reject(error);
      }
      holding.acquisition = "pending";
      let inner: Promise<T>;
      try {
        inner = Promise.resolve(start());
      } catch (error) {
        inner = Promise.reject(error);
      }
      let failure: unknown;
      holding.acquired = inner.then(
        (handle) => {
          holding.acquisition = "acquired";
          holding.handle = handle;
        },
        (error) => {
          holding.acquisition = "rejected";
          holding.acquisitionError = String(error);
          failure = error;
        },
      );
      return holding.acquired.then(() => {
        if (holding.acquisition !== "acquired") throw failure;
        return holding.handle as T;
      });
    };
    const wrapped = new Promise<T>((resolve) =>
      resolve(this.interpose(stage, acquireOnce)),
    );
    // The wrapper must deliver exactly what was acquired: otherwise the stage fails by name (and the scope owns only the real result).
    const outcome = wrapped.then((value) => {
      if (holding.misuse !== undefined)
        throw new LaneSeamMisuse(`open ${id}: ${holding.misuse}`);
      if (holding.acquisition !== "acquired")
        throw new LaneSeamMisuse(
          `open ${id}: the ${stage} wrapper delivered without a successful acquisition (${holding.acquisition})`,
        );
      if (!Object.is(value, holding.handle))
        throw new LaneSeamMisuse(
          `open ${id}: the ${stage} wrapper delivered a value other than its acquisition's`,
        );
      return value;
    });
    // Observed at once: the wrapper's outcome is recorded (and a failure closes the scope's admission), whoever awaits the open.
    holding.delivered = outcome.then(
      () => {
        holding.wrapper = "delivered";
      },
      (error) => {
        holding.wrapper = "failed";
        holding.wrapperError = String(error);
        this.failed = true;
      },
    );
    return outcome.then((handle) => {
      if (gateAfter) this.gate(stage, "after");
      return handle;
    });
  }

  /** The holding's ONE disposal, started at most once (synchronously: failure, settlement and a late arrival cannot both start one). */
  private disposeHolding(
    holding: Holding,
    boundMs: number,
    late: (line: string) => void,
  ): Promise<string | null> {
    if (holding.disposalRun !== undefined) return holding.disposalRun;
    const armed =
      holding.arms === "object"
        ? holding.acquisition !== "not_begun"
        : holding.acquisition === "acquired" || holding.adopted?.() === true;
    if (!armed || holding.dispose === null) return Promise.resolve(null);
    const dispose = holding.dispose;
    holding.disposal = "disposing";
    const step: CleanupStep = {
      label: `open ${this.record.id} ${holding.stage}`,
      run: () => dispose(holding.handle),
    };
    // Revision 30 (F35-2, C3): a self-bounded disposer reports its own pending operation and every cause; it is not raced against a
    // second bound (which would report its complete outcome only late).
    const run: Promise<string | null> =
      holding.boundsItself === true
        ? (async () => {
            try {
              const value = await step.run();
              return value instanceof Error
                ? `${step.label}: ${String(value)}`
                : null;
            } catch (error) {
              return `${step.label}: ${String(error)}`;
            }
          })()
        : runStep(step, boundMs, late);
    holding.disposalRun = run.then((failure) => {
      holding.disposal = failure === null ? "disposed" : "dispose_failed";
      if (failure !== null) holding.disposalError = failure;
      return failure;
    });
    return holding.disposalRun;
  }

  /** A handle-armed acquisition that outlived a join bound: its result is disposed (or its rejection recorded) when it arrives, once. */
  private observeLateAcquisition(
    holding: Holding,
    by: Disposer,
    boundMs: number,
    late: (line: string) => void,
  ): void {
    if (holding.late) return;
    holding.late = true;
    const id = this.record.id;
    // Revision 30 (F35-1, C1): a context arriving after a join bound is adopted but never installed (its open no longer admits set-up),
    // so a late acquisition cannot reject after adopting; it arrives "acquired" and is disposed through its owner below.
    void holding.acquired.then(async () => {
      if (holding.acquisition === "rejected")
        late(
          `open ${id}: late ${holding.stage} acquisition rejected after ${by.after}: ${holding.acquisitionError}`,
        );
      else {
        const failure = await this.disposeHolding(holding, boundMs, late);
        late(
          `open ${id}: late ${holding.stage} arrived after ${by.after}; ${failure === null ? "disposed" : `dispose failed: ${failure}`}`,
        );
      }
    });
  }

  /** A wrapper that outlived a join bound: its outcome is recorded when it arrives, once. */
  private observeLateWrapper(
    holding: Holding,
    by: Disposer,
    late: (line: string) => void,
  ): void {
    if (holding.wrapperLate) return;
    holding.wrapperLate = true;
    const id = this.record.id;
    void holding.delivered.then(() =>
      late(
        `open ${id}: late ${holding.stage} wrapper ${holding.wrapper === "failed" ? `rejected after ${by.after}: ${holding.wrapperError}` : `delivered after ${by.after}`}`,
      ),
    );
  }

  /**
   * Disposes every holding, newest first, attempting each whatever the others did. A handle-armed acquisition still pending is joined
   * within `deadline` first (what it acquires depends on the older holdings); an object-armed one is closed at once (its close joins
   * its start). Only then are wrappers still pending joined: a held wrapper never keeps an acquired resource open.
   */
  async dispose(
    deadline: number,
    boundMs: number,
    late: (line: string) => void,
    by: Disposer = BY_SETTLEMENT,
  ): Promise<string[]> {
    const id = this.record.id;
    const errors: string[] = [];
    const newestFirst = [...this.record.holdings].reverse();
    for (const holding of newestFirst) {
      if (holding.arms === "handle" && holding.acquisition === "pending") {
        const arrived = await settlesWithin(
          holding.acquired,
          Math.max(0, deadline - Date.now()),
        );
        if (!arrived) {
          // Not cancelled by the bound: still owned. Its result is disposed (or its rejection recorded) when it arrives.
          errors.push(
            `open ${id}: ${holding.stage} acquisition still pending when ${by.bound} ended (its result will be disposed when it arrives)`,
          );
          this.observeLateAcquisition(holding, by, boundMs, late);
          continue;
        }
      }
      const failure = await this.disposeHolding(holding, boundMs, late);
      if (failure !== null) errors.push(failure);
    }
    for (const holding of newestFirst) {
      // A wrapper waiting on its own pending acquisition is already named by that acquisition's failure above.
      if (holding.wrapper !== "pending" || holding.acquisition === "pending")
        continue;
      const ended = await settlesWithin(
        holding.delivered,
        Math.max(0, deadline - Date.now()),
      );
      if (!ended) {
        const what =
          holding.acquisition === "acquired"
            ? "its acquired resource was disposed"
            : holding.acquisition === "rejected"
              ? "its acquisition was rejected"
              : "its acquisition never began and is now refused";
        errors.push(
          `open ${id}: ${holding.stage} wrapper still pending when ${by.bound} ended (${what}; its outcome will be recorded when it arrives)`,
        );
        this.observeLateWrapper(holding, by, late);
      }
    }
    return errors;
  }
}

/**
 * Revision 30 (Review 35 F35-1/F35-2, family native-transport-upstream-cleanup; design assessment token 2868a8a2…, C1/C3/C4, invariants
 * 1/3/4/5/8): the owner of one lane context and everything attached to it. It ADOPTS the raw context in the turn `newContext` delivers
 * it, before capture is installed and before any wrapper or caller can use it; from then on the context's holding is armed even if the
 * installation fails, so the failed open's unwinding, settlement and a late arrival all close it through this owner (no private close in
 * the acquisition, no second close). Its ONE disposal (shared by every caller) closes the context while capture is still attached (the
 * close's final events are captured), bounded by the dispose bound: a close still pending then is a named cause and its eventual outcome
 * a late line. It then detaches the lane's own context listeners and finalises the capture (detaching every subscription, with the
 * close's status), whatever the close did. Every cause (the close, each detachment, the finalisation) is collected independently and
 * thrown together (`CleanupFailures`), so a failed close and a failed detachment are both reported.
 */
class ContextOwner {
  handle: { close(): Promise<void> } | null = null;
  installation: "none" | "installed" | "failed" | "skipped" = "none";
  closeStatus: CloseStatus = "not attempted";
  capture: RecordedCapture | null = null;
  /** The lane's own listeners on its context (foreign requests, the page route guard). */
  readonly lane = new Subscriptions();
  private run: Promise<string[]> | null = null;
  private finalised = false;

  constructor(
    private readonly label: string,
    private readonly boundMs: number,
    private readonly late: (line: string) => void,
  ) {}

  adopt(handle: { close(): Promise<void> }): void {
    this.handle = handle;
  }

  /** Detaches the lane's listeners and finalises the capture, once (the disposal's second half; `seal`'s fallback). */
  finalise(): string[] {
    if (this.finalised) return [];
    this.finalised = true;
    // Revision 32 (Review 39 F39-1 / design assessment DA39-3, C3, invariants 3/4/6): the context's whole callback authority (the lane's
    // own listeners AND the capture) is revoked together, synchronously, BEFORE the first removal: a lane listener's `off` that re-enters
    // the capture, or a capture listener's `off` that re-enters the activation adapter, meets refused callbacks only. Capture stays valid
    // while the close runs (this is reached after it ended, failed or overran its bound). Another context or manager is not touched.
    this.lane.revoke();
    const causes: string[] = [];
    try {
      this.capture?.revoke();
    } catch (error) {
      causes.push(`revoking the capture's callbacks threw: ${String(error)}`);
    }
    causes.push(...this.lane.detach());
    try {
      causes.push(...(this.capture?.dispose(this.closeStatus) ?? []));
    } catch (error) {
      causes.push(`finalising the capture threw: ${String(error)}`);
    }
    return causes;
  }

  dispose(): Promise<string[]> {
    if (this.run !== null) return this.run;
    this.run = (async () => {
      const causes: string[] = [];
      const handle = this.handle;
      if (handle !== null) {
        const closing = await within(() => handle.close(), this.boundMs);
        if (closing.kind === "value") this.closeStatus = "closed";
        else if (closing.kind === "error") {
          this.closeStatus = "failed";
          causes.push(`closing the context failed: ${String(closing.error)}`);
        } else {
          this.closeStatus = "pending";
          causes.push(
            `closing the context was still pending ${this.boundMs} ms after it began; its capture was finalised without the close (its eventual outcome is recorded late)`,
          );
          void closing.later.then((o) =>
            this.late(
              `${this.label}: its context's close ended after its bound (${o.kind === "error" ? String(o.error) : "closed"})`,
            ),
          );
        }
      }
      causes.push(...this.finalise());
      return causes;
    })();
    return this.run;
  }
}

/** The lane context's engine (`chromium`, `firefox`, `webkit`), or undefined when it cannot be read. */
const engineOf = (context: BrowserContext): string | undefined => {
  try {
    return (context as { browser?: () => Browser | null })
      .browser?.()
      ?.browserType()
      .name();
  } catch {
    return undefined;
  }
};

async function openLane(
  options: TransportLaneOptions,
  browser: Browser,
  testInfo: TestInfo,
  scope: OpenScope,
  ingestion: { seam?: Ingest; late: (line: string) => void } = {
    late: () => undefined,
  },
  disposeBoundMs: number = DISPOSE_BOUND_MS,
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
  // Revision 26 (F31-1, C4): envelopes the ingestion seam holds, its misuse, and the seal settlement sets before classifying.
  const held = new Set<Readonly<Problem>>();
  const seamErrors: string[] = [];
  let sealed = false;
  const put = (problem: Readonly<Problem>) => {
    if (!sealed) {
      journal.problems.push(problem);
      return;
    }
    journal.late ??= [];
    journal.late.push(problem);
    ingestion.late(
      `journal #${problem.seq} (page ${problem.page} document ${problem.document} ${problem.type}) delivered after the lane's journal was classified; not classified: ${problem.text}`,
    );
  };
  const ingest = (problem: Readonly<Problem>) => {
    const seam = ingestion.seam;
    if (seam === undefined) return put(problem);
    held.add(problem);
    let delivered = false;
    const deliver = () => {
      if (delivered) {
        seamErrors.push(
          `the ingestion seam delivered journal #${problem.seq} more than once (delivery is single-use)`,
        );
        return;
      }
      delivered = true;
      held.delete(problem);
      put(problem);
    };
    try {
      seam(problem, deliver);
    } catch (error) {
      seamErrors.push(
        `the ingestion seam threw for journal #${problem.seq}: ${String(error)}`,
      );
      if (!delivered) deliver();
    }
  };
  // Revision 20 (F24-1): each stage is admitted, owned and gated by the open's scope (its disposer is registered before it starts).
  const witness = createWitnessOrigin({ stamp });
  const witnessUrl = await scope.acquire(
    "witness",
    () => witness.start(),
    () => witness.close(),
    { arms: "object" },
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
      { arms: "object" },
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
    { arms: "object" },
  );
  const contextOptions: BrowserContextOptions = {};
  for (const key of CONTEXT_KEYS)
    if (use[key] !== undefined)
      (contextOptions as Record<string, unknown>)[key] = use[key];
  // The lane's context talks to the FRONT origin directly (no browser proxy setting): the front carries all of the application's HTTP.
  contextOptions.baseURL = front;
  // Owned BEFORE `newContext` is called: a context that arrives after settlement began is closed, never published (F24-1); owned when it
  // arrives, before the qualification wrapper sees it, so a wrapper failing after it arrived cannot leave it open (revision 21, F25-1).
  // Revision 28 (F33-1, C1/C5): the context's capture registry attaches in the acquisition's own turn, before the scope, a wrapper or a
  // caller can use the context (so before any page of it exists), and its disposer is the context's: it detaches after the context
  // closed, also when the open fails or the context arrives late (each detachment failure fails that disposal by name).
  // Revision 30 (Review 35 F35-1/F35-2, C1/C3): the context's OWNER exists before `newContext` is called and adopts the context in the
  // turn it arrives, before capture is installed. The holding is armed by that adoption, so a failed installation leaves the context (and
  // nothing else: the installation rolled itself back) to the SAME disposal the failed open's unwinding and settlement share. A context
  // arriving once the open may no longer use it (settlement began, or the open failed) gets no capture at all; it is only closed.
  const owner = new ContextOwner(
    `open ${scope.record.id} context`,
    disposeBoundMs,
    ingestion.late,
  );
  const context = await scope.acquire(
    "context",
    async () => {
      const made = await browser.newContext(contextOptions);
      owner.adopt(made);
      if (!scope.admits()) {
        owner.installation = "skipped";
        return made;
      }
      try {
        owner.capture = recordContext(made as unknown as RecordedContext, {
          journal,
          next,
          stamp,
          ingest,
        });
        owner.installation = "installed";
      } catch (error) {
        owner.installation = "failed";
        throw new Error(
          `attaching the context's capture registry failed: ${error instanceof CaptureInstallError ? error.message : String(error)}`,
          { cause: error },
        );
      }
      return made;
    },
    async () => {
      const causes = await owner.dispose();
      if (causes.length > 0) throw new CleanupFailures(causes);
    },
    { adopted: () => owner.handle !== null, boundsItself: true },
  );
  journal.engine = engineOf(context);
  // Playwright's own `trace: retain-on-failure` instrumentation already records every context a test creates, this one included.
  const foreign: string[] = [];
  const declaredForeign = new Set<string>();
  // Revision 30 (F35-1, C2): the lane's own context listeners are owned by the context's owner (exact callbacks), detached with it.
  // Revision 32 (design assessment DA39-3, C3, invariants 2/3/9): each is admitted by the lane scope's guard before it reads its request
  // or touches its Page. The owner revokes that scope together with the capture before any removal, so a listener a failed `off` left
  // attached, or one re-entered during it, neither reads a request nor adds to `foreign` nor rewrites a Page's routes: it is a named,
  // payload-free late line. One delivered while its own `on` was still running is a named capture gap (a provenance failure).
  const laneRefused = (what: string) => (refusal: Refusal) => {
    if (refusal === "installing") {
      journal.provenanceFailures ??= [];
      journal.provenanceFailures.push(
        `the lane's ${what} was delivered while its listener was still being installed; not observed, so the lane's guard of it is incomplete`,
      );
      return;
    }
    journal.lateEvents ??= [];
    journal.lateEvents.push(
      `the lane's ${what} was delivered after the lane's own listeners were revoked; not observed`,
    );
  };
  owner.lane.add(
    "detaching the lane's foreign-request listener",
    context,
    "request",
    ((request: Request) => {
      const url = request.url();
      if (/^(data|blob):/.test(url)) return;
      if (new URL(url).origin !== front)
        foreign.push(`${request.method()} ${url}`);
    }) as (value: never) => void,
    laneRefused("foreign-request listener: a request"),
  );
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
  // Revision 28 (F33-1): pages are recorded by the context's capture registry (above); this only refuses a page's own routes.
  owner.lane.add(
    "detaching the lane's page route guard",
    context,
    "page",
    ((page: Page) => {
      const own = page as unknown as Record<string, unknown>;
      own.route = refuse("page.route");
      own.routeFromHAR = refuse("page.routeFromHAR");
    }) as (value: never) => void,
    laneRefused("page route guard: a page announcement"),
  );
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
    heldProblems: () => [...held],
    seal: () => {
      sealed = true;
      // Normally already finalised by the context's disposal (it closed first); a finalisation that already ran returns nothing.
      // Revision 30: the owner's finalisation (the lane's listeners and the capture, with the close's status), never a second one.
      let detached: string[];
      try {
        detached = owner.finalise();
      } catch (error) {
        detached = [`detaching the capture registry failed: ${String(error)}`];
      }
      return [
        ...detached,
        ...[...held].map(
          (p) =>
            `a console problem captured at journal #${p.seq} (page ${p.page} document ${p.document} ${p.type}) was still held by the ingestion seam when the journal was classified: ${p.text}`,
        ),
        ...seamErrors,
      ];
    },
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
      navigations: journal.navigations ?? [],
      navigationProvenance: journal.navigationProvenance ?? [],
      provenanceFailures: journal.provenanceFailures ?? [],
      pages: journal.pages ?? [],
      unattributedRequests: journal.unattributedRequests ?? [],
      lateEvents: journal.lateEvents ?? [],
      activations: journal.activations ?? [],
      crashWatches: journal.crashWatches ?? [],
      activationSource: journal.activationSource ?? null,
      engine: journal.engine ?? null,
      late: journal.late ?? [],
      held: [...held],
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
      /** Revision 26: seals the journal before it is classified (optional for a lane without the ingestion seam). */
      seal?: TransportLane["seal"];
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
    // Revision 26 (C4): sealed FIRST, so the ledger and the verdict judge one fixed journal; a held envelope fails by name.
    try {
      for (const f of lane.seal?.() ?? []) failures.push(`lane ${i}: ${f}`);
    } catch (error) {
      reportErrors.push(`lane ${i} seal: ${String(error)}`);
    }
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

/** Managers created in this worker (each teardown record names its manager: revision 21). */
let managerCount = 0;

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
 *
 * Revision 21 (Review 25 F25-1; design assessment token 8179e31e…): ownership follows each stage's REAL acquisition, adopted before a
 * qualification wrapper sees it. A known resource is disposed even while its wrapper is held or after its wrapper rejected; a still
 * pending acquisition is joined, or disposed late; a wrapper still pending at the bound fails the report by its own name. A failed open
 * closes its scope's admission and unwinds at once without waiting for settlement. Each teardown record names its manager.
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
  // Revision 21 (design assessment invariant 8): which manager a teardown record is, so two managers' same-named records stay distinct.
  managerCount += 1;
  const manager = managerCount;
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
      // Revision 21 (F25-1): the acquisition, the wrapper and the disposal separately (revision 20's single `state` is retired).
      holdings: r.holdings.map((h) => ({
        stage: h.stage,
        acquisition: h.acquisition,
        wrapper: h.wrapper,
        disposal: h.disposal,
        ...(h.acquisitionError !== undefined
          ? { acquisitionError: h.acquisitionError }
          : {}),
        ...(h.wrapperError !== undefined
          ? { wrapperError: h.wrapperError }
          : {}),
        ...(h.misuse !== undefined ? { misuse: h.misuse } : {}),
        ...(h.disposalError !== undefined
          ? { disposalError: h.disposalError }
          : {}),
        ...(h.late ? { late: true } : {}),
        ...(h.wrapperLate ? { wrapperLate: true } : {}),
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
        { seam: settings.ingest, late: noteLate },
        disposeBoundMs,
      );
      await scope.acquire("publication", async () => lane, null, {
        gateAfter: false,
      });
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
        // A FAILED open admits nothing more and unwinds what it had acquired at once, with no settlement needed (settlement shares the
        // same disposals and reports their failures); a cancelled one is being disposed by the settlement that cancelled it.
        if (record.outcome === "failed") {
          scope.fail();
          void scope.dispose(
            Date.now() + joinBoundMs,
            disposeBoundMs,
            noteLate,
            BY_UNWINDING,
          );
        }
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
              scope.dispose(deadline, disposeBoundMs, noteLate, BY_SETTLEMENT),
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
        body: JSON.stringify(
          { manager, report, opens: snapshot(), late },
          null,
          1,
        ),
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
