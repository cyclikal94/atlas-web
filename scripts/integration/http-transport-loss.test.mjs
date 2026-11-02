// WEB-13b revision 18: the transport-loss controller's own controls (design assessment Q2, C01/C20), without a browser. Each case drives
// the front origin as a browser does (ordinary origin-form requests to it), with independent targets that record their own arrivals.
import assert from "node:assert/strict";
import { Agent, createServer, request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import {
  createTransport,
  createWitnessOrigin,
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
