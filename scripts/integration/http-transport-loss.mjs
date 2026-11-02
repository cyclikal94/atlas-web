// WEB-13b revision 18 (Review 22, family webkit-offline-emulation-file-read; hand-off
// delivery/handoffs/web13b-native-transport-qualification-20261102.md): an OPT-IN HTTP transport-loss controller for ONE browser context.
//
// The context's base URL is this server: a loopback FRONT ORIGIN that carries every HTTP request of the application's origin (its
// documents, assets, API calls and the witness probes) to allow-listed loopback targets. While the transport is LOST, the front destroys
// every request's socket before anything is forwarded: the browser's request fails in the network and no target receives it. Browser
// File reads are untouched (no File API stub, no `context.setOffline`, whose WebKit emulation fails every File read:
// .agtx/evidence/WEB-13b/findings/webkit-offline-file).
//
// Why a front origin and not the hand-off's per-browser forward proxy: through ANY HTTP forward proxy, Playwright's WebKit 26.6 writes
// only the first few requests of a many-module document to the proxy and answers the rest itself with 404 (no byte on the wire), so the
// application never boots; and it bypasses a SOCKS proxy for loopback altogether. Chromium and Firefox are unaffected. The diagnostics
// are .agtx/evidence/WEB-13b/revision-18/diag (execute.md). The front gives all three engines the same mechanism. Its loss covers the
// application's whole origin, not other origins of the browser: the application requests only its own origin (relative paths; the
// production CSP is connect-src 'self', deploy/nginx/security-headers.conf), and the test lane fails a case that requests any other.
//
// What it records, as separate facts (the design assessment's invariant 1): every request the front saw (`attempts`, with the generation
// and phase it arrived in and what the front did), every transition (`transitions`), and the requests in flight at a loss
// (`interrupted`). Targets record their own receipts (`createWitnessOrigin`, the test's scripted origin, the integration runner's delaying
// proxy); the front's record is never evidence that a target did or did not receive something.
//
// It is NOT OS connectivity, physical offline, `navigator.onLine` (which stays native: a UI connectivity stimulus is a separate,
// document-owned thing, tests/e2e/native-transport.ts) or a real device. No host networking is changed; it listens on 127.0.0.1 only,
// forwards only to the loopback targets it is given, and is not a forward proxy (an absolute-form request or CONNECT is refused).
import { randomUUID } from "node:crypto";
import { Agent, createServer, request as httpRequest } from "node:http";

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });

const closeServer = (server) =>
  new Promise((resolve) => {
    if (!server.listening) return resolve(null);
    server.closeAllConnections?.();
    server.close((error) => resolve(error ?? null));
  });

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+$/;

/**
 * `routes`: ordered `{ name, prefix, target, presentOrigin? }`. A request is forwarded to the first route whose `prefix` starts its path;
 * `target` is the loopback origin that receives it (path, query and the browser's Host header kept). A request no route takes is refused
 * (403). `presentOrigin` (the released-backend lane only): a request whose `Origin` header is the FRONT's own origin is forwarded with
 * `Origin: <presentOrigin>`, the public origin the backend was configured with (ATLAS_PUBLIC_ORIGIN), as a reverse proxy serving that
 * origin would present it; any other Origin is forwarded unchanged (and refused by the backend, as before). Each rewrite is recorded.
 */
export function createTransport({ routes }) {
  if (!Array.isArray(routes) || routes.length === 0)
    throw new Error("createTransport: at least one route");
  for (const route of routes) {
    if (!LOOPBACK.test(route.target))
      throw new Error(
        `createTransport: route ${route.name} must target a loopback http origin, not ${route.target}`,
      );
    if (typeof route.prefix !== "string" || !route.prefix.startsWith("/"))
      throw new Error(`createTransport: route ${route.name} needs a /prefix`);
    if (
      route.presentOrigin !== undefined &&
      !LOOPBACK.test(route.presentOrigin)
    )
      throw new Error(
        `createTransport: route ${route.name} presents a non-loopback origin ${route.presentOrigin}`,
      );
  }
  const state = {
    phase: "online",
    generation: 0,
    nonce: null,
    // A NEGATIVE-CONTROL switch only (`lose({ enforce: false })`): the phase says lost but requests are forwarded, so an oracle that
    // trusted the phase instead of its witnesses would pass. Never set by a positive case.
    enforce: true,
  };
  const attempts = [];
  const transitions = [];
  const interrupted = [];
  const sockets = new Set();
  const inFlight = new Map();
  const agent = new Agent({ keepAlive: false });
  let seq = 0;
  let url = null;

  const stamp = () => ({
    generation: state.generation,
    phase: state.phase,
    nonce: state.nonce,
  });

  const server = createServer((req, res) => {
    const attempt = {
      seq: ++seq,
      ...stamp(),
      method: req.method,
      url: req.url?.startsWith("/") ? `${url}${req.url}` : req.url,
      at: Date.now(),
      outcome: "pending",
    };
    attempts.push(attempt);
    if (state.phase === "loss" && state.enforce) {
      // Before anything is forwarded: the browser sees a failed request, no target sees anything.
      attempt.outcome = "lost";
      req.socket.destroy();
      return;
    }
    if (!req.url?.startsWith("/")) {
      attempt.outcome = "refused";
      res.writeHead(403, { "content-type": "text/plain" }).end("not a proxy");
      return;
    }
    const path = new URL(req.url, "http://front").pathname;
    const route = routes.find((r) => path.startsWith(r.prefix));
    if (route === undefined) {
      attempt.outcome = "refused";
      res.writeHead(403, { "content-type": "text/plain" }).end("not allowed");
      return;
    }
    attempt.route = route.name;
    attempt.outcome = "forwarded";
    const target = new URL(route.target);
    const headers = { ...req.headers };
    if (route.presentOrigin !== undefined && headers.origin === url) {
      headers.origin = route.presentOrigin;
      attempt.originPresented = route.presentOrigin;
    }
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers,
        agent,
      },
      (reply) => {
        attempt.status = reply.statusCode;
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
        reply.on("end", () => {
          attempt.completed = true;
          inFlight.delete(attempt.seq);
        });
        reply.on("error", () => {
          inFlight.delete(attempt.seq);
          res.destroy();
        });
      },
    );
    inFlight.set(attempt.seq, { attempt, upstream });
    upstream.on("error", (error) => {
      attempt.upstreamError = String(error.code ?? error.message);
      inFlight.delete(attempt.seq);
      // The target reset or was unreachable: the browser sees the same failure (a lost answer AFTER forwarding is the target's doing).
      res.destroy();
    });
    res.on("close", () => {
      if (!attempt.completed && inFlight.has(attempt.seq)) {
        attempt.clientClosed = true;
        inFlight.delete(attempt.seq);
        upstream.destroy();
      }
    });
    req.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, socket) => {
    attempts.push({
      seq: ++seq,
      ...stamp(),
      method: "CONNECT",
      url: req.url,
      at: Date.now(),
      outcome: "connect_refused",
    });
    socket.destroy();
  });

  /** Destroys every client socket (and the upstream request of anything in flight) and resolves when they are closed. */
  const dropAll = async () => {
    const closing = [...sockets].map(
      (socket) =>
        new Promise((resolve) => {
          if (socket.destroyed) return resolve();
          socket.once("close", resolve);
          socket.destroy();
        }),
    );
    for (const { attempt, upstream } of inFlight.values()) {
      attempt.interruptedAtLoss = state.generation;
      interrupted.push({ ...attempt });
      upstream.destroy();
    }
    inFlight.clear();
    await Promise.all(closing);
  };

  return {
    /** Starts listening; returns the front origin to use as the browser context's base URL. */
    async start() {
      url = await listen(server);
      return url;
    },
    get url() {
      return url;
    },
    stamp,
    get phase() {
      return state.phase;
    },
    get generation() {
      return state.generation;
    },
    attempts,
    transitions,
    interrupted,
    /** How many forwarded requests have not completed (a loss entry is quiescent when this is 0). */
    inFlight: () => inFlight.size,
    /**
     * Enters a loss interval: a new generation and nonce, then every open client socket and in-flight upstream request destroyed. Resolves
     * (the acknowledgement) only when they are closed, with the requests that were in flight (`interrupted`; a quiescent loss has none).
     */
    async lose(options = {}) {
      if (state.phase === "loss") throw new Error("transport: already lost");
      state.phase = "loss";
      state.generation += 1;
      state.nonce = randomUUID();
      state.enforce = options.enforce ?? true;
      const before = interrupted.length;
      await dropAll();
      const record = {
        to: "loss",
        generation: state.generation,
        nonce: state.nonce,
        enforce: state.enforce,
        at: Date.now(),
        interrupted: interrupted.slice(before),
      };
      transitions.push(record);
      return record;
    },
    /** Ends the loss interval: a new generation; requests are forwarded again. */
    async restore() {
      if (state.phase !== "loss") throw new Error("transport: not lost");
      state.phase = "online";
      state.generation += 1;
      state.nonce = null;
      state.enforce = true;
      // Sockets the browser opened during the loss were destroyed; none is carried over.
      await dropAll();
      const record = {
        to: "online",
        generation: state.generation,
        at: Date.now(),
      };
      transitions.push(record);
      return record;
    },
    /** Stops listening and destroys every socket; resolves with the close error, if any. */
    async close() {
      await dropAll();
      agent.destroy();
      return closeServer(server);
    },
  };
}

/**
 * A loopback witness origin: `GET /__transport/probe/<nonce>` answers `200 witness-<nonce>` (never cacheable); `GET
 * /__transport/cacheable/<nonce>` answers the same, cacheable for an hour (the cache-bypass NEGATIVE only). Every request is recorded
 * when it ARRIVES (`receipts`), stamped with `stamp()` (the transport's generation and phase at arrival). `answer` replaces the probe's
 * answer, for the wrong-status/wrong-body negatives.
 */
export function createWitnessOrigin({ stamp = () => ({}) } = {}) {
  const receipts = [];
  const options = { answer: null };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://witness").pathname;
    const match = /^\/__transport\/(probe|cacheable)\/([0-9a-f-]{36})$/.exec(
      path,
    );
    receipts.push({
      ...stamp(),
      method: req.method,
      path,
      nonce: match?.[2] ?? null,
      at: Date.now(),
    });
    if (match === null) {
      res.writeHead(404, { "content-type": "text/plain" }).end("unknown");
      return;
    }
    const nonce = match[2];
    const answer = options.answer?.(nonce) ?? {
      status: 200,
      body: `witness-${nonce}`,
    };
    res.writeHead(answer.status, {
      "content-type": "text/plain",
      "cache-control":
        match[1] === "cacheable" ? "public, max-age=3600" : "no-store",
    });
    res.end(answer.body);
  });
  let url = null;
  return {
    async start() {
      url = await listen(server);
      return url;
    },
    get url() {
      return url;
    },
    receipts,
    options,
    close: () => closeServer(server),
  };
}
