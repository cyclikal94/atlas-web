#!/usr/bin/env node
// CHECKS ONLY. `vite preview` of the production build with a tiny stub backend behind its proxy, for Playwright's production project.
// The production app now asks the server which API version it is (decision D-08); with nothing behind the proxy that request is a 502, which a
// browser logs as a console error and the suites' console guard rightly refuses. The stub answers /health and /ready the way the released
// backend does and everything else with a 404. A pass against it is fixture evidence and says nothing about a real backend.
//
//   node scripts/preview-with-stub-backend.mjs --port 4173
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = process.argv.indexOf("--port");
const port = at >= 0 ? process.argv[at + 1] : "4173";

const stub = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://x").pathname;
  response.setHeader("content-type", "application/json");
  if (path === "/health") {
    response.end(JSON.stringify({ api_version: "0.29.0", status: "ok" }));
  } else if (path === "/ready") {
    response.end(JSON.stringify({ status: "ready" }));
  } else {
    response.statusCode = 404;
    response.end("{}");
  }
});
await new Promise((resolveListen) =>
  stub.listen(0, "127.0.0.1", resolveListen),
);
const target = `http://127.0.0.1:${stub.address().port}`;

const preview = spawn(
  process.execPath,
  [
    join(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    port,
    "--strictPort",
  ],
  {
    cwd: root,
    env: { ...process.env, ATLAS_BACKEND_URL: target },
    stdio: "inherit",
  },
);
const stop = () => {
  preview.kill("SIGTERM");
  stub.close();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
preview.on("exit", (code) => {
  stub.close();
  process.exit(code ?? 0);
});
