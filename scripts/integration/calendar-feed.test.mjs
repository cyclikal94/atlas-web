// Self-tests of the WEB-13a integration infrastructure: the loopback calendar feed and the delaying proxy's `drop_client_after`
// action, with a control showing that an existing action (`drop_after_forward`) behaves as before. Run: node --test scripts/integration/calendar-feed.test.mjs
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { createCalendarFeed, sampleIcs } from "./calendar-feed.mjs";
import { createProxy } from "./delaying-proxy.mjs";

const control = (origin, action, body) =>
  fetch(`${origin}/__feed/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json());

test("the feed answers what it was set to, counts requests, holds until released, and records only whether a token was sent", async () => {
  const feed = createCalendarFeed();
  const { origin } = await feed.start();
  try {
    assert.equal((await fetch(`${origin}/feeds/a.ics`)).status, 404);
    await control(origin, "set", { path: "/feeds/a.ics", body: sampleIcs() });
    const ok = await fetch(`${origin}/feeds/a.ics`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /BEGIN:VCALENDAR/);
    await control(origin, "hold", { path: "/feeds/a.ics" });
    let settled = false;
    const held = fetch(`${origin}/feeds/a.ics`).then((r) => {
      settled = true;
      return r.status;
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(settled, false);
    const state = await control(origin, "state");
    assert.deepEqual(state.held, { "/feeds/a.ics": 1 });
    assert.equal(state.counts["/feeds/a.ics"], 3);
    assert.equal(JSON.stringify(state.log).includes("secret-token"), false);
    assert.deepEqual(
      state.log.map((e) => e.auth),
      ["none", "bearer", "none"],
    );
    assert.deepEqual(
      await control(origin, "release", { path: "/feeds/a.ics" }),
      {
        released: 1,
      },
    );
    assert.equal(await held, 200);
  } finally {
    await feed.stop();
  }
});

/** A tiny upstream that answers after `ms`, counting the requests that reached it and the answers it finished. */
async function upstream(ms) {
  const seen = { requests: 0, finished: 0 };
  const server = createServer((req, res) => {
    seen.requests += 1;
    req.resume();
    setTimeout(() => {
      seen.finished += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"revision":1}');
    }, ms);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, server };
}

const post = (url) =>
  new Promise((resolve) => {
    const req = request(url, { method: "POST" }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", (error) => resolve({ error: error.code ?? String(error) }));
    req.end("{}");
  });

async function withProxy(rule, ms, run) {
  const up = await upstream(ms);
  const proxy = createProxy({ upstream: up.url });
  const urls = await proxy.start();
  try {
    if (rule)
      await fetch(`${urls.controlUrl}/rules`, {
        method: "POST",
        body: JSON.stringify(rule),
      });
    return await run(urls, up.seen, proxy);
  } finally {
    await proxy.stop();
    await new Promise((r) => up.server.close(r));
  }
}

test("drop_client_after: the browser's connection is destroyed while the backend is still executing; the backend finishes", async () => {
  await withProxy(
    {
      method: "POST",
      path: "/x",
      ordinal: 1,
      action: "drop_client_after",
      ms: 50,
    },
    400,
    async (urls, seen, proxy) => {
      const outcome = await post(`${urls.proxyUrl}/x`);
      assert.ok("error" in outcome, JSON.stringify(outcome));
      // At the moment the browser lost it, the backend had NOT answered yet.
      assert.equal(seen.finished, 0);
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(seen.requests, 1);
      assert.equal(seen.finished, 1);
      const events = proxy.log[0].events.map((e) => e.event);
      assert.deepEqual(events, [
        "dropped_client",
        "upstream_response",
        "discarded",
      ]);
      // The next request is untouched (the rule was for the first only).
      assert.deepEqual(await post(`${urls.proxyUrl}/x`), { status: 200 });
    },
  );
});

test("control: drop_after_forward still waits for the backend's answer before it destroys the connection", async () => {
  await withProxy(
    { method: "POST", path: "/x", ordinal: 1, action: "drop_after_forward" },
    200,
    async (urls, seen, proxy) => {
      const outcome = await post(`${urls.proxyUrl}/x`);
      assert.ok("error" in outcome);
      assert.equal(seen.finished, 1);
      assert.deepEqual(
        proxy.log[0].events.map((e) => e.event),
        ["upstream_response", "dropped"],
      );
    },
  );
});

test("control: with no rule the answer is delivered unchanged", async () => {
  await withProxy(null, 10, async (urls) => {
    assert.deepEqual(await post(`${urls.proxyUrl}/x`), { status: 200 });
  });
});
