// WEB-13b revision 18: the transport-loss controller's own controls (design assessment Q2, C01/C20), without a browser. Each case drives
// the front origin as a browser does (ordinary origin-form requests to it), with independent targets that record their own arrivals.
import assert from "node:assert/strict";
import { Agent, createServer, request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import {
  createTransport,
  createWitnessOrigin,
  ownUpstream,
} from "./http-transport-loss.mjs";

const listening = (port) =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/** A target that records arrivals; a path ending `/hold` answers only when released. */
async function target() {
  const receipts = [];
  const held = [];
  const server = createServer((req, res) => {
    receipts.push({ path: req.url, host: req.headers.host });
    if (req.url?.endsWith("/hold")) {
      held.push(res);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`target${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    receipts,
    held,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** One request to the front as a browser makes it (`path` origin-form; absolute-form is what a proxy client sends): {status, body} or {error}. */
function through(front, path, { agent, method = "GET" } = {}) {
  const at = new URL(front);
  return new Promise((resolve) => {
    const req = request(
      {
        host: at.hostname,
        port: at.port,
        method,
        path,
        headers: { host: at.host },
        agent: agent ?? false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", (error) => resolve({ error: error.code }));
      },
    );
    req.on("error", (error) => resolve({ error: error.code }));
    req.end();
  });
}

async function setup() {
  const app = await target();
  const api = await target();
  const transport = createTransport({
    routes: [
      { name: "api", prefix: "/api/", target: api.url },
      { name: "app", prefix: "/app/", target: app.url },
    ],
  });
  const front = await transport.start();
  return {
    app,
    api,
    transport,
    front,
    close: async () => {
      await transport.close();
      await app.close();
      await api.close();
    },
  };
}

test("C01 online: a request is forwarded to the target its prefix names, with the browser's Host, and only that target records it", async () => {
  const s = await setup();
  try {
    assert.deepEqual(await through(s.front, "/app/a?b=1"), {
      status: 200,
      body: "target/app/a?b=1",
    });
    assert.deepEqual(await through(s.front, "/api/c"), {
      status: 200,
      body: "target/api/c",
    });
    assert.deepEqual(s.app.receipts, [
      { path: "/app/a?b=1", host: new URL(s.front).host },
    ]);
    assert.deepEqual(
      s.api.receipts.map((r) => r.path),
      ["/api/c"],
    );
    assert.deepEqual(
      s.transport.attempts.map((a) => [
        a.outcome,
        a.route,
        a.phase,
        a.completed,
      ]),
      [
        ["forwarded", "app", "online", true],
        ["forwarded", "api", "online", true],
      ],
    );
    assert.equal(s.transport.attempts[0].url, `${s.front}/app/a?b=1`);
  } finally {
    await s.close();
  }
});

test("C01 allow-list: an unrouted path, an absolute-form (proxy) request and CONNECT are refused, and no target receives them", async () => {
  const s = await setup();
  try {
    assert.equal((await through(s.front, "/other")).status, 403);
    assert.equal((await through(s.front, `${s.app.url}/app/x`)).status, 403);
    const connectResult = await new Promise((resolve) => {
      const at = new URL(s.front);
      const req = request({
        host: at.hostname,
        port: at.port,
        method: "CONNECT",
        path: "example.com:443",
        agent: false,
      });
      req.on("connect", () => resolve("connected"));
      req.on("error", (error) => resolve(error.code));
      req.end();
    });
    assert.notEqual(connectResult, "connected");
    assert.deepEqual(s.app.receipts, []);
    assert.deepEqual(s.api.receipts, []);
    assert.deepEqual(
      s.transport.attempts.map((a) => a.outcome),
      ["refused", "refused", "connect_refused"],
    );
  } finally {
    await s.close();
  }
});

test("C01 loss: a new request fails before forwarding, no target records it, the front records it as lost in the loss generation; restored, it is forwarded", async () => {
  const s = await setup();
  try {
    const loss = await s.transport.lose();
    assert.equal(loss.generation, 1);
    assert.match(loss.nonce, /^[0-9a-f-]{36}$/);
    assert.deepEqual(loss.interrupted, []);
    const failed = await through(s.front, "/app/during");
    assert.ok(
      failed.error,
      `expected a failure, got ${JSON.stringify(failed)}`,
    );
    assert.deepEqual(s.app.receipts, []);
    assert.deepEqual(
      s.transport.attempts.map((a) => [a.outcome, a.generation, a.phase]),
      [["lost", 1, "loss"]],
    );
    const restored = await s.transport.restore();
    assert.equal(restored.generation, 2);
    assert.deepEqual(await through(s.front, "/app/after"), {
      status: 200,
      body: "target/app/after",
    });
    assert.deepEqual(
      s.app.receipts.map((r) => r.path),
      ["/app/after"],
    );
  } finally {
    await s.close();
  }
});

test("C01 kept-alive socket: a connection opened online is destroyed at the loss, so a request on it cannot reach a target", async () => {
  const s = await setup();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    assert.equal((await through(s.front, "/app/one", { agent })).status, 200);
    await s.transport.lose();
    const second = await through(s.front, "/app/two", { agent });
    assert.ok(
      second.error,
      `expected a failure, got ${JSON.stringify(second)}`,
    );
    assert.deepEqual(
      s.app.receipts.map((r) => r.path),
      ["/app/one"],
    );
  } finally {
    agent.destroy();
    await s.close();
  }
});

test("C01 in flight at the transition: recorded as interrupted (not hidden); its answer is never delivered after restoration", async () => {
  const s = await setup();
  try {
    const held = through(s.front, "/app/hold");
    while (s.app.held.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(s.transport.inFlight(), 1);
    const loss = await s.transport.lose();
    assert.deepEqual(
      loss.interrupted.map((a) => [a.url, a.generation]),
      [[`${s.front}/app/hold`, 0]],
    );
    const outcome = await held;
    assert.ok(
      outcome.error,
      `expected a failure, got ${JSON.stringify(outcome)}`,
    );
    await s.transport.restore();
    // The target answers late: nothing carries it to the (already failed) browser request.
    s.app.held[0].end("late");
    assert.equal(s.transport.inFlight(), 0);
  } finally {
    await s.close();
  }
});

test("C01 negative switch: lose({enforce:false}) forwards during the 'loss' phase, so an oracle reading only the phase is fooled and one reading receipts is not", async () => {
  const s = await setup();
  try {
    await s.transport.lose({ enforce: false });
    assert.equal((await through(s.front, "/app/leak")).status, 200);
    assert.equal(s.app.receipts.length, 1);
    assert.equal(s.transport.attempts[0].phase, "loss");
    assert.equal(s.transport.attempts[0].outcome, "forwarded");
  } finally {
    await s.close();
  }
});

test("presentOrigin: only the front's own Origin is replaced by the configured public origin, and each replacement is recorded", async () => {
  const seen = [];
  const backend = createServer((req, res) => {
    seen.push(req.headers.origin ?? null);
    res.end("ok");
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const publicOrigin = `http://127.0.0.1:${backend.address().port}`;
  const transport = createTransport({
    routes: [
      {
        name: "app",
        prefix: "/",
        target: publicOrigin,
        presentOrigin: publicOrigin,
      },
    ],
  });
  const front = await transport.start();
  const send = (origin) =>
    new Promise((resolve) => {
      const at = new URL(front);
      const req = request(
        {
          host: at.hostname,
          port: at.port,
          method: "POST",
          path: "/api/x",
          headers: origin === null ? {} : { origin },
          agent: false,
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.end("{}");
    });
  try {
    await send(front);
    await send("http://127.0.0.1:1");
    await send(null);
    assert.deepEqual(seen, [publicOrigin, "http://127.0.0.1:1", null]);
    assert.deepEqual(
      transport.attempts.map((a) => a.originPresented ?? null),
      [publicOrigin, null, null],
    );
    assert.throws(() =>
      createTransport({
        routes: [
          {
            name: "x",
            prefix: "/",
            target: publicOrigin,
            presentOrigin: "https://example.com",
          },
        ],
      }),
    );
  } finally {
    await transport.close();
    await new Promise((resolve) => {
      backend.closeAllConnections();
      backend.close(resolve);
    });
  }
});

test("C20 an unreachable target fails the request (no hang) and is recorded; close() releases the port and every socket", async () => {
  const dead = await target();
  const deadUrl = dead.url;
  await dead.close();
  const transport = createTransport({
    routes: [{ name: "dead", prefix: "/", target: deadUrl }],
  });
  const front = await transport.start();
  const port = Number(new URL(front).port);
  const failed = await through(front, "/x");
  assert.ok(failed.error, `expected a failure, got ${JSON.stringify(failed)}`);
  assert.equal(transport.attempts[0].upstreamError, "ECONNREFUSED");
  assert.equal(await listening(port), true);
  assert.equal(await transport.close(), null);
  assert.equal(await listening(port), false);
});

// Revision 19 (Review 23 F23-2, design assessment correction 5 / D11): the front's OUTGOING requests are joined, not only its incoming
// sockets. A named observation bound turns a missing close into an assertion, never a timeout.
const closedWithin = (socket, ms = 2_000) =>
  Promise.race([
    new Promise((resolve) =>
      socket.closed
        ? resolve("closed")
        : socket.once("close", () => resolve("closed")),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve("still open"), ms).unref(),
    ),
  ]);

test("C20 outgoing join at close: a held forwarded request's upstream is closed when close() resolves, and the target sees it close", async () => {
  const s = await setup();
  try {
    const held = through(s.front, "/app/hold");
    while (s.app.held.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const targetSide = s.app.held[0].socket;
    assert.equal(s.transport.owned().upstreams, 1);
    assert.equal(await s.transport.close(), null);
    assert.deepEqual(s.transport.owned(), {
      clientSockets: 0,
      upstreams: 0,
      listening: false,
    });
    assert.equal(await closedWithin(targetSide), "closed");
    assert.ok((await held).error);
  } finally {
    await s.close();
  }
});

test("C20 outgoing join at a loss: the interrupted upstream is closed when lose() resolves", async () => {
  const s = await setup();
  try {
    const held = through(s.front, "/app/hold");
    while (s.app.held.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const targetSide = s.app.held[0].socket;
    const loss = await s.transport.lose();
    assert.equal(loss.interrupted.length, 1);
    assert.equal(s.transport.owned().upstreams, 0);
    assert.equal(await closedWithin(targetSide), "closed");
    assert.ok((await held).error);
  } finally {
    await s.close();
  }
});

test("C20 close is idempotent, joins a start in progress, and a closed front never starts again", async () => {
  const app = await target();
  try {
    const transport = createTransport({
      routes: [{ name: "app", prefix: "/", target: app.url }],
    });
    const starting = transport.start();
    const first = transport.close();
    assert.equal(transport.close(), first);
    assert.equal(await first, null);
    const front = await starting;
    assert.equal(transport.owned().listening, false);
    assert.equal(await listening(Number(new URL(front).port)), false);
    await assert.rejects(transport.start(), /start\(\) once, before close\(\)/);
    assert.deepEqual(app.receipts, []);
  } finally {
    await app.close();
  }
});

test("C20 ownUpstream: done() resolves only once the request AND its socket have closed, not at destroy()", async () => {
  const app = await target();
  try {
    const req = request(`${app.url}/app/hold`, { agent: false });
    req.on("error", () => undefined);
    const owned = ownUpstream(req);
    req.end();
    while (app.held.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(owned.open, true);
    req.destroy();
    let done = false;
    const joined = owned.done().then(() => {
      done = true;
    });
    await Promise.resolve();
    assert.equal(done, false, "destroy() alone is not the join");
    assert.equal(owned.open, true);
    await joined;
    assert.equal(owned.requestClosed, true);
    assert.equal(owned.socketClosed, true);
    assert.equal(owned.open, false);
  } finally {
    await app.close();
  }
});

test("C20 configuration: non-loopback targets or prefix-less routes are refused at creation; double lose/restore throw", async () => {
  assert.throws(() => createTransport({ routes: [] }));
  assert.throws(() =>
    createTransport({
      routes: [{ name: "x", prefix: "/", target: "http://example.com" }],
    }),
  );
  assert.throws(() =>
    createTransport({
      routes: [{ name: "x", prefix: "", target: "http://127.0.0.1:1" }],
    }),
  );
  const transport = createTransport({
    routes: [{ name: "x", prefix: "/", target: "http://127.0.0.1:1" }],
  });
  await transport.start();
  await assert.rejects(transport.restore());
  await transport.lose();
  await assert.rejects(transport.lose());
  await transport.close();
});

test("witness origin: probe answers no-store with its nonce, cacheable answers max-age; every arrival stamped; answer override for negatives", async () => {
  let generation = 0;
  const witness = createWitnessOrigin({
    stamp: () => ({ generation, phase: "online", nonce: null }),
  });
  const url = await witness.start();
  try {
    const nonce = "00000000-0000-4000-8000-000000000001";
    const probe = await fetch(`${url}/__transport/probe/${nonce}`);
    assert.equal(probe.status, 200);
    assert.equal(await probe.text(), `witness-${nonce}`);
    assert.equal(probe.headers.get("cache-control"), "no-store");
    generation = 3;
    const cacheable = await fetch(`${url}/__transport/cacheable/${nonce}`);
    assert.equal(
      cacheable.headers.get("cache-control"),
      "public, max-age=3600",
    );
    witness.options.answer = () => ({ status: 500, body: "wrong" });
    const wrong = await fetch(`${url}/__transport/probe/${nonce}`);
    assert.equal(wrong.status, 500);
    const unknown = await fetch(`${url}/other`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(
      witness.receipts.map((r) => [r.path, r.nonce, r.generation]),
      [
        [`/__transport/probe/${nonce}`, nonce, 0],
        [`/__transport/cacheable/${nonce}`, nonce, 3],
        [`/__transport/probe/${nonce}`, nonce, 3],
        ["/other", null, 3],
      ],
    );
  } finally {
    await witness.close();
  }
});

// Revision 20 (Review 24 F24-1, design assessment correction 5 / L02): the witness has the same start/close lifecycle as the front.
test("L02 witness origin: close is idempotent, joins a start in progress (no listener outlives it), and a closed witness never starts", async () => {
  const witness = createWitnessOrigin({ closeBoundMs: 1_000 });
  const starting = witness.start();
  const first = witness.close();
  assert.equal(witness.close(), first, "one shared close");
  assert.equal(await first, null);
  const url = await starting;
  assert.equal(await listening(Number(new URL(url).port)), false);
  assert.deepEqual(witness.owned(), {
    state: "closed",
    listening: false,
    connections: 0,
  });
  await assert.rejects(
    witness.start(),
    /witness origin: start\(\) in state closed/,
  );
  const never = createWitnessOrigin();
  assert.equal(await never.close(), null);
  await assert.rejects(never.start(), /start\(\) in state closed/);
});

test("L02 witness origin: close destroys and joins an idle connection on its close event before it resolves", async () => {
  const witness = createWitnessOrigin({ closeBoundMs: 1_000 });
  const url = await witness.start();
  const idle = connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
  idle.on("error", () => undefined);
  await new Promise((resolve) => idle.once("connect", resolve));
  while (witness.owned().connections === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await witness.close(), null);
  assert.equal(
    witness.owned().connections,
    0,
    "the idle connection's close is delivered before close() resolves",
  );
  idle.destroy();
});

// Design assessment correction 5: `done()` reads the socket's join when it is CALLED. Asked before the request has its socket (the
// scripted origin's forward asks at once), it must still not resolve before that socket has closed.
test("C21 ownUpstream: done() asked before the request is given its socket still resolves only after that socket has closed", async () => {
  const app = await target();
  try {
    const req = request(`${app.url}/app/hold`, { agent: false });
    req.on("error", () => undefined);
    const owned = ownUpstream(req);
    const joined = owned.done();
    assert.equal(owned.socket, null, "asked before the socket event");
    req.end();
    while (app.held.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const socket = owned.socket;
    assert.notEqual(socket, null);
    req.destroy();
    await joined;
    assert.equal(owned.requestClosed, true);
    assert.equal(socket.destroyed, true);
    assert.equal(
      owned.socketClosed,
      true,
      "the socket's close was delivered first",
    );
  } finally {
    await app.close();
  }
});
