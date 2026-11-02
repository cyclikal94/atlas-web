import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  ConsoleMessage,
  Page,
  PlaywrightWorkerArgs,
  TestInfo,
} from "@playwright/test";
import { expect } from "@playwright/test";
import {
  createTransport,
  createWitnessOrigin,
  type LossRecord,
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
 *  - the BROWSER's own outcome of a request (a probe's resolved status/body, or its rejection);
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
 * Console problems of every lane page are collected as the maintained guard does (tests/e2e/helpers.ts). A browser's message about a
 * failed request is expected ONLY when its URL is one the front dropped during a loss, at most once per drop; every other error, warning
 * or page error fails the case at teardown. FIXTURE evidence on the fixture lane; the released backend's lane is the integration runner's.
 */

export interface TransportLaneOptions {
  /**
   * `fixture`: the front sends `/api/` and `/health` to the lane's scripted origin and everything else to the project's base URL (the
   * fixture preview). `integration`: everything to the base URL (the preview in front of the delaying proxy and the released backend).
   */
  mode: "fixture" | "integration";
  /** HTTP statuses this case provokes on purpose (the integration guard's `provokes`); Chromium names them in a console error. */
  provokes?: number[];
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
  /** What answered it: a handler's fulfil or abort, a forward to the fallback (no handler), or a handler error. */
  outcome?: "fulfilled" | "aborted" | "unrouted" | "handler_error";
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

type Decision = "fulfilled" | "aborted" | "fallback";

/** The Playwright `Route` surface the fixture handlers use (`request`, `fulfill`, `abort`, `fallback`), answering over real HTTP. */
export class OriginRoute {
  decided: Decision | null = null;
  private resolve: (decision: Decision) => void = () => undefined;
  readonly decision = new Promise<Decision>((resolve) => {
    this.resolve = resolve;
  });
  constructor(
    private readonly req: OriginRequest,
    private readonly res: ServerResponse,
  ) {}
  request(): OriginRequest {
    return this.req;
  }
  private decide(decision: Decision) {
    if (this.decided !== null) throw new Error(`route already ${this.decided}`);
    this.decided = decision;
    this.resolve(decision);
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
    this.decide("fulfilled");
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
    this.decide("aborted");
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

/**
 * The fixture lane's API origin: a loopback HTTP server that answers each ARRIVING request with the handlers registered through
 * `route` (newest first; `fallback` passes on, as in Playwright), records the arrival (stamped with the transport's generation and
 * phase; the body only as its length and SHA-256, never its text), and forwards a request no handler takes to `fallback`.
 */
export function createScriptedOrigin(options: {
  stamp: () => TransportStamp;
  fallback: string;
}) {
  const handlers: Array<{ glob: string; re: RegExp; handler: Handler }> = [];
  const receipts: OriginReceipt[] = [];
  const errors: string[] = [];
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
      void dispatch(req, res, receipt, body);
    });
  });
  const dispatch = async (
    req: OriginRequest,
    res: ServerResponse,
    receipt: OriginReceipt,
    body: Buffer,
  ) => {
    for (const { re, handler, glob } of [...handlers].reverse()) {
      if (!re.test(req.url())) continue;
      const route = new OriginRoute(req, res);
      try {
        await Promise.resolve(handler(route, req));
        const decision = await route.decision;
        if (decision === "fallback") continue;
        receipt.outcome = decision;
        return;
      } catch (error) {
        errors.push(`${glob}: ${String(error)}`);
        receipt.outcome = "handler_error";
        if (!res.headersSent) res.writeHead(500).end();
        return;
      }
    }
    receipt.outcome = "unrouted";
    const target = new URL(options.fallback);
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method(),
        path: new URL(req.url()).pathname + new URL(req.url()).search,
        headers: req.headers(),
        agent: false,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    upstream.end(body);
  };
  let url: string | null = null;
  return {
    async start(): Promise<string> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("scripted origin: no port");
      url = `http://127.0.0.1:${address.port}`;
      return url;
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
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
/** Chromium, Firefox and WebKit's own messages about a request that failed in the network (not an HTTP status). */
const NETWORK_FAILURE =
  /Failed to load resource|net::ERR_|NetworkError|network connection was lost|Could not connect|Load failed|Fetch API cannot load/i;

interface Problem {
  page: number;
  type: string;
  text: string;
  url: string;
}

export interface ConsoleVerdict {
  expected: Array<Problem & { lost: string }>;
  unexpected: Problem[];
}

/** Classifies a lane's console problems against the front's record (exported for the guard's own negatives). */
export function classifyConsole(
  problems: Problem[],
  attempts: TransportAttempt[],
  provokes: ReadonlySet<number> = new Set(),
): ConsoleVerdict {
  const drops = new Map<string, number>();
  for (const a of attempts)
    if (a.outcome === "lost" && a.url !== undefined)
      drops.set(a.url, (drops.get(a.url) ?? 0) + 1);
  const verdict: ConsoleVerdict = { expected: [], unexpected: [] };
  for (const problem of problems) {
    const status = /status of (\d{3})/.exec(problem.text)?.[1];
    if (status !== undefined && provokes.has(Number(status))) continue;
    const named =
      problem.url || (/(https?:\/\/[^\s'")]+)/.exec(problem.text)?.[1] ?? "");
    const left = drops.get(named) ?? 0;
    if (
      problem.type !== "pageerror" &&
      NETWORK_FAILURE.test(problem.text) &&
      left > 0
    ) {
      drops.set(named, left - 1);
      verdict.expected.push({ ...problem, lost: named });
    } else verdict.unexpected.push(problem);
  }
  return verdict;
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
  problems: Problem[];
  /** Requests of the lane's pages to any origin but the front (each fails the case: the loss would not cover them). */
  foreign: string[];
  /** Declares one exact `METHOD url` outside the lane's origin as provoked on purpose (the check's own negative); others still fail. */
  declareForeign(entry: string): void;
  undeclaredForeign(): string[];
  consoleVerdict(): ConsoleVerdict;
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

async function openLane(
  options: TransportLaneOptions,
  browser: Browser,
  testInfo: TestInfo,
  cleanup: Array<() => Promise<unknown>>,
): Promise<TransportLane> {
  const use = testInfo.project.use as Record<string, unknown>;
  // The project's server: the fixture preview, or (integration) the preview in front of the delaying proxy and the released backend.
  const base = new URL(String(use.baseURL ?? "")).origin;
  let transport: Transport | null = null;
  const stamp = (): TransportStamp =>
    transport?.stamp() ?? { generation: 0, phase: "online", nonce: null };
  const witness = createWitnessOrigin({ stamp });
  const witnessUrl = await witness.start();
  cleanup.push(() => witness.close());
  let origin: ScriptedOrigin | null = null;
  const routes = [
    { name: "witness", prefix: "/__transport/", target: witnessUrl },
  ];
  if (options.mode === "fixture") {
    origin = createScriptedOrigin({ stamp, fallback: base });
    const originUrl = await origin.start();
    cleanup.push(() => (origin as ScriptedOrigin).close());
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
  transport = createTransport({ routes });
  const front = await transport.start();
  const owned = transport;
  cleanup.push(() => owned.close());
  const contextOptions: BrowserContextOptions = {};
  for (const key of CONTEXT_KEYS)
    if (use[key] !== undefined)
      (contextOptions as Record<string, unknown>)[key] = use[key];
  // The lane's context talks to the FRONT origin directly (no browser proxy setting): the front carries all of the application's HTTP.
  contextOptions.baseURL = front;
  const context = await browser.newContext(contextOptions);
  // Playwright's own `trace: retain-on-failure` instrumentation already records every context a test creates, this one included.
  cleanup.push(() => context.close());
  const foreign: string[] = [];
  const declaredForeign = new Set<string>();
  context.on("request", (request) => {
    const url = request.url();
    if (/^(data|blob):/.test(url)) return;
    if (new URL(url).origin !== front)
      foreign.push(`${request.method()} ${url}`);
  });
  await context.addInitScript(installUiStimulus);
  const problems: Problem[] = [];
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
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() === "error" || message.type() === "warning")
        problems.push({
          page: index,
          type: message.type(),
          text: message.text(),
          url: message.location().url ?? "",
        });
    });
    page.on("pageerror", (error) =>
      problems.push({
        page: index,
        type: "pageerror",
        text: error.message,
        url: "",
      }),
    );
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
    problems,
    foreign,
    declareForeign: (entry) => {
      declaredForeign.add(entry);
    },
    undeclaredForeign: () => foreign.filter((f) => !declaredForeign.has(f)),
    consoleVerdict: () =>
      classifyConsole(problems, owned.attempts, new Set(options.provokes)),
    ledger: () => ({
      transitions: owned.transitions,
      attempts: owned.attempts,
      interrupted: owned.interrupted,
      witness: witness.receipts,
      origin: origin?.receipts ?? null,
      originErrors: origin?.errors ?? null,
      foreign,
      probes,
      console: classifyConsole(
        problems,
        owned.attempts,
        new Set(options.provokes),
      ),
    }),
  };
  return lane;
}

export type OpenTransportLane = (
  options: TransportLaneOptions,
) => Promise<TransportLane>;

/**
 * The `transportLane` fixture: `await transportLane({ mode })` opens one lane (its own browser) for the case. A spec adds it with
 * `test.extend<{ transportLane: OpenTransportLane }>({ transportLane: transportLaneFixture })`. At teardown it attaches the lane's ledger,
 * fails the case on an unexpected console problem or a scripted-origin handler error, and closes every context, browser and listener it
 * owns (a cleanup failure is reported, not hidden).
 */
export async function transportLaneFixture(
  { browser }: Pick<PlaywrightWorkerArgs, "browser">,
  use: (open: OpenTransportLane) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const lanes: TransportLane[] = [];
  const cleanup: Array<() => Promise<unknown>> = [];
  await use(async (options) => {
    const lane = await openLane(options, browser, testInfo, cleanup);
    lanes.push(lane);
    return lane;
  });
  const failures: string[] = [];
  for (const [i, lane] of lanes.entries()) {
    await testInfo.attach(`transport-ledger-${i}`, {
      body: JSON.stringify(lane.ledger(), null, 1),
      contentType: "application/json",
    });
    const verdict = lane.consoleVerdict();
    for (const p of verdict.unexpected)
      failures.push(`page ${p.page} ${p.type}: ${p.text}`);
    for (const e of lane.origin?.errors ?? [])
      failures.push(`scripted origin handler: ${e}`);
    for (const f of lane.undeclaredForeign())
      failures.push(`a request outside the lane's origin: ${f}`);
  }
  const closeErrors: string[] = [];
  for (const step of cleanup.reverse())
    try {
      const result = await step();
      if (result instanceof Error) closeErrors.push(String(result));
    } catch (error) {
      closeErrors.push(String(error));
    }
  expect(closeErrors, "transport lane cleanup").toEqual([]);
  expect(
    failures,
    "transport lane console errors and warnings (other than requests the front dropped during a loss)",
  ).toEqual([]);
}
