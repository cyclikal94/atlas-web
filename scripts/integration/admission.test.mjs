import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  admit,
  audit,
  createAdmissionRecorder,
  createBudget,
  SOURCE_LIMIT,
  slidingPeak,
  sourceRoute,
} from "./admission.mjs";
import { createProxy } from "./delaying-proxy.mjs";

const API = "/api/experimental/v1";

test("the source budget admits 120 uses in a window opened by the first, and a refusal is not counted", () => {
  const b = createBudget(SOURCE_LIMIT);
  for (let i = 0; i < 120; i += 1) assert.equal(b.allow("src", 10), true);
  assert.equal(b.allow("src", 10), false, "121st");
  assert.equal(b.allow("src", 69), false, "still the window opened at 10");
  assert.equal(b.used("src"), 120);
  assert.equal(b.allow("src", 70), true, "a new window at 70");
  assert.equal(b.used("src"), 1);
});

test("keys are independent", () => {
  const b = createBudget(2);
  assert.equal(b.allow("a", 0), true);
  assert.equal(b.allow("a", 0), true);
  assert.equal(b.allow("a", 0), false);
  assert.equal(b.allow("b", 0), true);
});

const signIn = (seconds, account, succeeds = true) => ({
  seconds,
  route: "password (browser)",
  account,
  succeeds,
});

test("rotating accounts never escapes the source budget", () => {
  const accounts = ["alice", "carol", "dave", "erin"];
  const events = [];
  for (let i = 0; i < 121; i += 1)
    events.push(signIn(5, accounts[i % accounts.length]));
  const verdicts = admit(events);
  assert.equal(verdicts.filter((v) => v === "admitted").length, 120);
  assert.equal(verdicts[120], "rate_limited_source");
});

test("activation, cancellation and a password change take from the same source budget as sign-in", () => {
  const events = [];
  for (let i = 0; i < 60; i += 1) {
    events.push(signIn(1, "alice"));
    events.push({ seconds: 1, route: "activation" });
  }
  events.push({ seconds: 2, route: "activation cancel" });
  events.push({ seconds: 2, route: "password change" });
  const verdicts = admit(events);
  assert.equal(verdicts.at(-2), "rate_limited_source");
  assert.equal(verdicts.at(-1), "rate_limited_source");
});

test("ten failed attempts exhaust an account; a success resets the account but never the source", () => {
  const failures = Array.from({ length: 11 }, () => signIn(0, "bob", false));
  const verdicts = admit(failures);
  assert.deepEqual(verdicts.slice(0, 10), Array(10).fill("unauthenticated"));
  assert.equal(verdicts[10], "rate_limited_principal");
  // Nine failures, one success, then ten more failures: the success reset the account's bucket.
  const reset = admit([
    ...Array.from({ length: 9 }, () => signIn(0, "bob", false)),
    signIn(0, "bob", true),
    ...Array.from({ length: 10 }, () => signIn(0, "bob", false)),
  ]);
  assert.equal(reset.includes("rate_limited_principal"), false);
  // ... while the source counted all twenty, and an unknown name has a bucket of its own.
  const mixed = admit([
    ...Array.from({ length: 10 }, () => signIn(0, "bob", false)),
    signIn(0, null, false),
  ]);
  assert.equal(mixed.at(-1), "unauthenticated");
});

test("routes: every source-consuming route is recognised, reads are not, the query is ignored", () => {
  for (const [method, path] of [
    ["POST", `${API}/sessions`],
    ["POST", `${API}/browser-sessions`],
    ["POST", `${API}/browser-sessions/activate`],
    ["POST", `${API}/browser-sessions/activate/cancel`],
    ["POST", `${API}/password`],
    ["POST", `${API}/registration`],
    ["POST", `${API}/registration/preview`],
    ["POST", `${API}/browser-registration`],
    ["POST", `${API}/oidc/start`],
    ["GET", `${API}/oidc/callback?code=x&state=y`],
    ["GET", `${API}/oidc/native/start?x=1`],
    ["POST", `${API}/oidc/native/exchange`],
  ])
    assert.notEqual(sourceRoute(method, path), null, `${method} ${path}`);
  for (const [method, path] of [
    ["GET", `${API}/sessions`],
    ["DELETE", `${API}/sessions/abc`],
    ["GET", `${API}/browser-sessions/current`],
    ["DELETE", `${API}/sessions/current`],
    ["GET", `${API}/me`],
  ])
    assert.equal(sourceRoute(method, path), null, `${method} ${path}`);
});

test("the sliding peak bounds every fixed window", () => {
  assert.equal(slidingPeak([0, 59_999, 60_000]), 2);
  assert.equal(slidingPeak([0, 1, 2, 70_000]), 3);
  assert.equal(slidingPeak([]), 0);
  const over = Array.from({ length: 121 }, (_, i) => i * 400); // 121 in 48 s
  const r = audit(
    over.map((t, i) => ({
      id: i,
      kind: "password (browser)",
      path: `${API}/browser-sessions`,
      forwarded_at: t,
      status: 200,
    })),
    { backendStartedAt: 0 },
  );
  assert.equal(r.sliding_peak_60s, 121);
  assert.equal(r.within_limit, false);
  assert.equal(r.modelled_source_refusals, 1);
});

/** A stub upstream and the real delaying proxy, with the recorder on its hook. */
async function proxied(t, { observe } = {}) {
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const limited = req.url.includes("limited");
      res.writeHead(limited ? 429 : 200, {
        "content-type": "application/json",
      });
      res.end("{}");
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const recorder = createAdmissionRecorder();
  const proxy = createProxy({
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    observe: observe ?? recorder.observe,
  });
  const urls = await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await new Promise((r) => upstream.close(r));
  });
  return { recorder, urls };
}

test("the proxy reports what it forwards on source routes; /reset leaves that record alone", async (t) => {
  const { recorder, urls } = await proxied(t);
  const post = (path) =>
    fetch(`${urls.proxyUrl}${path}`, { method: "POST", body: "{}" });
  await post(`${API}/browser-sessions`);
  await post(`${API}/browser-sessions/activate`);
  await fetch(`${urls.proxyUrl}${API}/sessions`);
  await fetch(`${urls.controlUrl}/reset`, { method: "POST" });
  await post(`${API}/sessions?limited=1`);
  const seen = recorder.requests();
  assert.deepEqual(
    seen.map((r) => [r.kind, r.status]),
    [
      ["password (browser)", 200],
      ["activation", 200],
      ["password (native)", 429],
    ],
  );
  assert.deepEqual(
    audit(seen).rate_limited.map((r) => r.kind),
    ["password (native)"],
  );
});

test("a request held BEFORE forwarding counts when it is forwarded, and not at all if it never is", async (t) => {
  const { recorder, urls } = await proxied(t);
  await fetch(`${urls.controlUrl}/rules`, {
    method: "POST",
    body: JSON.stringify({
      id: "h",
      method: "POST",
      path: `${API}/browser-sessions`,
      action: "buffer_request",
    }),
  });
  const pending = fetch(`${urls.proxyUrl}${API}/browser-sessions`, {
    method: "POST",
    body: "{}",
  }).catch(() => null);
  for (let i = 0; i < 50 && recorder.requests().length === 0; i += 1)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(recorder.requests().length, 0, "held, not forwarded");
  await fetch(`${urls.controlUrl}/release/h`, { method: "POST" });
  await pending;
  assert.equal(recorder.requests().length, 1);
  // A buffered request that a reset discards never reaches the backend and is never counted.
  await fetch(`${urls.controlUrl}/rules`, {
    method: "POST",
    body: JSON.stringify({
      id: "g",
      method: "POST",
      path: `${API}/password`,
      action: "buffer_request",
    }),
  });
  const discarded = fetch(`${urls.proxyUrl}${API}/password`, {
    method: "POST",
    body: "{}",
    signal: AbortSignal.timeout(300),
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 100));
  await fetch(`${urls.controlUrl}/reset`, { method: "POST" });
  await discarded;
  assert.equal(recorder.requests().length, 1);
});

test("an observer that throws changes nothing the proxy does", async (t) => {
  const { urls } = await proxied(t, {
    observe: () => {
      throw new Error("observer broke");
    },
  });
  const answer = await fetch(`${urls.proxyUrl}${API}/browser-sessions`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(answer.status, 200);
});
