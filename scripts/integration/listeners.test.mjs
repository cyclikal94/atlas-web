import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { createProxy } from "./delaying-proxy.mjs";
import { createOidcProvider } from "./oidc-provider.mjs";

const listening = (port) =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

test("Q2: the proxy stopped between its two listeners leaves neither listening, and its start reports the stop", async () => {
  const [port, controlPort] = [await freePort(), await freePort()];
  const proxy = createProxy({
    upstream: "http://127.0.0.1:9",
    port,
    controlPort,
  });
  const starting = proxy.start();
  let settled = false;
  starting
    .catch(() => undefined)
    .finally(() => {
      settled = true;
    });
  const stopped = await proxy.stop();
  assert.equal(
    settled,
    true,
    "stop() resolves only once the start it raced has settled",
  ); // called before either listen has completed
  await assert.rejects(starting, /stopped while it was starting/);
  assert.equal(stopped.ok, true);
  assert.equal(await listening(port), false);
  assert.equal(await listening(controlPort), false);
});

test("Q2: the provider stopped between its two listeners leaves neither listening", async () => {
  const [port, controlPort] = [await freePort(), await freePort()];
  const provider = createOidcProvider({
    clientId: "c",
    callbackUrl: "http://127.0.0.1:9/cb",
    port,
    controlPort,
  });
  const starting = provider.start();
  let settled = false;
  starting
    .catch(() => undefined)
    .finally(() => {
      settled = true;
    });
  const stopped = await provider.stop();
  assert.equal(
    settled,
    true,
    "stop() resolves only once the start it raced has settled",
  );
  await assert.rejects(starting, /stopped while it was starting/);
  assert.equal(stopped.ok, true);
  assert.equal(await listening(port), false);
  assert.equal(await listening(controlPort), false);
});

test("Q2: a stopped proxy forwards nothing more: a held request is discarded, not sent upstream", async (t) => {
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push(req.url);
    res.end("{}");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const forwarded = [];
  const proxy = createProxy({
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    observe: (event) => {
      if (event.event === "forwarded") forwarded.push(event.path);
    },
  });
  const { proxyUrl, controlUrl } = await proxy.start();
  t.after(() => proxy.stop());
  const rule = await (
    await fetch(`${controlUrl}/rules`, {
      method: "POST",
      body: JSON.stringify({ path: "/held", action: "hold_request" }),
    })
  ).json();
  const answered = new Promise((resolve) => {
    const req = request(`${proxyUrl}/held`, (res) => {
      res.resume();
      res.on("end", () => resolve("answered"));
    });
    req.on("error", () => resolve("closed"));
    req.end();
  });
  while ((await (await fetch(`${controlUrl}/held`)).json())[rule.id] !== 1)
    await new Promise((r) => setTimeout(r, 10));
  const stopped = await proxy.stop();
  assert.equal(stopped.ok, true);
  assert.equal(
    await answered,
    "closed",
    "the client is told nothing more will come",
  );
  assert.deepEqual(
    forwarded,
    [],
    "nothing was forwarded upstream at or after the stop",
  );
  assert.deepEqual(seen, [], "the held request never reached the backend");
});
