#!/usr/bin/env node
// CHECKS ONLY (WEB-14a). Serves ONE generation of dist-pwa/ at a time, on loopback, with the reference nginx configuration's semantics
// (deploy/nginx/web.conf), so the PWA browser checks can deploy a new version under open tabs, take the server away, and see every request:
//
//  - a backend path (/api, /health, /ready, /auth, /oidc and below) is a 404 that never carries the shell, except the stub `/health` and
//    `/ready` (the `/health` body is set from the control port: the `api_version` gate's fixture cases) and, once set, the stub identity read
//    `browser-sessions/current`, `me`, `sessions` and empty Today/defaults reads (so a seeded account has a healthy landing without a backend);
//  - `/assets/` files are immutable and a missing one is a 404; the unhashed entry points (index.html, sw.js, manifest.webmanifest, ...) and
//    every other file revalidate (`no-cache`); a missing file with an extension is a 404; anything else is the shell (history fallback);
//  - every response carries the production security headers (deploy/nginx/security-headers.conf), the content security policy included;
//  - only GET and HEAD.
//
// A passing check against it is fixture evidence about the client, not about a deployment.
//
//   node scripts/serve-generations.mjs [--dir dist-pwa] [--generation fixture-a] [--omit-header <name>]...
//
// `--omit-header Cross-Origin-Opener-Policy` is for DIAGNOSIS only (no spec uses it since WEB-14a revision 1, R9): the PWA specs serve every
// production header to every engine, and a fresh Firefox page's first navigation is made by the page itself (`navigate` in
// tests/e2e/pwa-world.ts; .agtx/evidence/WEB-14a/revision-1/firefox-coop.md). Every other header, the content security policy included, is
// always sent.
//
// Prints one JSON line: {"url": "http://127.0.0.1:<port>", "control": "http://127.0.0.1:<port>"}. The CONTROL server (another port):
//   POST /generation?name=<dir>   serve another generation from now on (the previous one's files are gone, as after a deployment)
//   POST /dark?on=1|0             destroy every connection (the server is unreachable) or serve again
//   POST /health                  the body of `/health`: JSON in the request body, or `?status=<code>` for an error status
//   POST /identity                the stub identity read, `{"account": ..., "session": ...}` (an empty body: none, the backend's 404)
//   POST /identity/hold?on=1|0    hold every identity read (`browser-sessions/current`) unanswered from now on, or answer every held one
//                                 as the stub stands and stop holding; answers {"hold", "held"} (WEB-14a revision 13, F-8: a page's
//                                 session check that does not finish, in every engine: Playwright's WebKit routing misses this page's request)
//   GET  /log                     every request served so far: [{ "method", "path", "at", "status" }]
//   POST /log/clear
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const base = resolve(root, arg("--dir", "dist-pwa"));
let generation = arg("--generation", "fixture-a");

const HEADERS = Object.fromEntries(
  [
    ...readFileSync(
      join(root, "deploy/nginx/security-headers.conf"),
      "utf8",
    ).matchAll(/^add_header\s+(\S+)\s+"([^"]*)"\s+always;/gm),
  ].map((match) => [match[1], match[2]]),
);
for (
  let at = process.argv.indexOf("--omit-header");
  at >= 0;
  at = process.argv.indexOf("--omit-header", at + 1)
) {
  const name = process.argv[at + 1];
  if (name !== "Cross-Origin-Opener-Policy")
    throw new Error(
      `only Cross-Origin-Opener-Policy may be omitted, not ${name}`,
    );
  delete HEADERS[name];
}
if (!HEADERS["Content-Security-Policy"])
  throw new Error("could not read the security headers");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};
const BACKEND = /^\/(?:api|health|ready|auth|oidc)(?:\/|$)/;
const UNHASHED =
  /^\/(?:index\.html|sw\.js|theme-init\.js|noscript\.css|favicon\.svg|manifest\.webmanifest)$/;

let health = { status: 200, body: { status: "ok", api_version: "0.29.0" } };
let dark = false;
/** The stub identity read (`GET /api/experimental/v1/browser-sessions/current`), or null for the backend's 404. */
let identity = null;
/** While true, identity reads wait in `heldReads` (each answers when released, or never if its page went away). */
let holdIdentity = false;
const heldReads = [];
const log = [];
const sockets = new Set();

/** The stub identity read's answer, as the stub stands when it is answered (none now: the backend's 404). */
const answerIdentity = (answer) => {
  if (identity === null)
    return answer(404, { "Cache-Control": "no-store" }, "");
  return answer(
    200,
    { "content-type": "application/json", "Cache-Control": "no-store" },
    JSON.stringify({
      account_id: identity.account,
      session_id: identity.session,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      csrf_token: `csrf.${identity.session}`,
    }),
  );
};

const send = (response, status, headers, body) => {
  response.writeHead(status, { ...HEADERS, ...headers });
  response.end(body);
};

const app = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://x");
  const path = url.pathname;
  const entry = {
    method: request.method,
    path: path + url.search,
    at: Date.now(),
    status: 0,
  };
  log.push(entry);
  const answer = (status, headers, body) => {
    entry.status = status;
    send(response, status, headers, body);
  };
  if (request.method !== "GET" && request.method !== "HEAD")
    return answer(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" }, "");
  if (path === "/health") {
    if (health.status !== 200)
      return answer(health.status, { "Cache-Control": "no-store" }, "");
    return answer(
      200,
      { "content-type": "application/json", "Cache-Control": "no-store" },
      JSON.stringify(health.body),
    );
  }
  if (path === "/ready")
    return answer(
      200,
      { "content-type": "application/json", "Cache-Control": "no-store" },
      JSON.stringify({ status: "ready" }),
    );
  if (
    path === "/api/experimental/v1/browser-sessions/current" &&
    identity !== null
  ) {
    if (!holdIdentity) return answerIdentity(answer);
    heldReads.push(() => {
      if (!response.destroyed) answerIdentity(answer);
    });
    return;
  }
  // The profile read and the device mirror, as a healthy backend answers them for the stub identity.
  if (path === "/api/experimental/v1/me" && identity !== null)
    return answer(
      200,
      { "content-type": "application/json", "Cache-Control": "no-store" },
      JSON.stringify({ id: identity.account, username: "alice" }),
    );
  if (path === "/api/experimental/v1/sessions" && identity !== null)
    return answer(
      200,
      { "content-type": "application/json", "Cache-Control": "no-store" },
      JSON.stringify({
        sessions: [
          {
            id: identity.session,
            device_id: "dev-1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            authentication: "password",
            current: true,
          },
        ],
      }),
    );
  // The accepted WEB-10a landing screen reads Today and sharing defaults. As in auth-stub.ts, this PWA fixture owns no task
  // resources: answer the healthy empty-account shapes only while its stub identity is set. Unknown backend paths still fail below.
  if (path === "/api/experimental/v1/daily" && identity !== null)
    return answer(
      200,
      { "content-type": "application/json", "Cache-Control": "no-store" },
      JSON.stringify({
        items: [],
        next_after: null,
        revision: 1,
        pending_tasks: [],
      }),
    );
  if (path === "/api/experimental/v1/defaults/snapshot" && identity !== null)
    return answer(
      200,
      { "content-type": "application/json", "Cache-Control": "no-store" },
      JSON.stringify({
        defaults: {
          revision: `${"0".repeat(63)}1`,
          preferences_version: 1,
          primary_household_id: null,
          person: { kind: "private" },
          field: { kind: "private" },
          task: { kind: "private" },
          list: { kind: "private" },
          progress: { kind: "private" },
        },
        households: [],
      }),
    );
  if (BACKEND.test(path))
    return answer(
      404,
      { "content-type": "text/plain", "Cache-Control": "no-store" },
      "This path belongs to the Atlas backend.\n",
    );
  const dir = join(base, generation);
  const file = normalize(join(dir, decodeURIComponent(path)));
  if (!file.startsWith(dir)) return answer(403, {}, "");
  const exists = existsSync(file) && statSync(file).isFile();
  const typed = (target) => ({
    "content-type": TYPES[extname(target)] ?? "application/octet-stream",
  });
  if (path.startsWith("/assets/")) {
    if (!exists)
      return answer(404, { "content-type": "text/plain" }, "not found\n");
    return answer(
      200,
      {
        ...typed(file),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      request.method === "HEAD" ? "" : readFileSync(file),
    );
  }
  if (UNHASHED.test(path) || /\.[A-Za-z0-9]{1,8}$/.test(path)) {
    if (!exists)
      return answer(
        404,
        { "content-type": "text/plain", "Cache-Control": "no-cache" },
        "not found\n",
      );
    return answer(
      200,
      { ...typed(file), "Cache-Control": "no-cache" },
      request.method === "HEAD" ? "" : readFileSync(file),
    );
  }
  const index = join(dir, "index.html");
  return answer(
    200,
    { ...typed(index), "Cache-Control": "no-cache" },
    request.method === "HEAD" ? "" : readFileSync(index),
  );
});
app.on("connection", (socket) => {
  if (dark) {
    socket.destroy();
    return;
  }
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

const control = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://x");
  const done = (value) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    switch (url.pathname) {
      case "/generation": {
        const name = url.searchParams.get("name") ?? "";
        if (!existsSync(join(base, name, "index.html"))) {
          response.writeHead(400).end(`no generation ${name}`);
          return;
        }
        generation = name;
        return done({ generation });
      }
      case "/dark":
        dark = url.searchParams.get("on") === "1";
        if (dark) for (const socket of sockets) socket.destroy();
        return done({ dark });
      case "/health":
        health = url.searchParams.has("status")
          ? { status: Number(url.searchParams.get("status")), body: null }
          : { status: 200, body: JSON.parse(body) };
        return done(health);
      case "/identity":
        identity = body ? JSON.parse(body) : null;
        return done({ identity });
      case "/identity/hold": {
        holdIdentity = url.searchParams.get("on") === "1";
        const held = heldReads.length;
        if (!holdIdentity) for (const release of heldReads.splice(0)) release();
        return done({ hold: holdIdentity, held });
      }
      case "/log":
        return done(log);
      case "/log/clear":
        log.length = 0;
        return done({ cleared: true });
      default:
        response.writeHead(404).end();
    }
  });
});

const listen = (server) =>
  new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port)),
  );
const port = await listen(app);
const controlPort = await listen(control);
console.log(
  JSON.stringify({
    url: `http://127.0.0.1:${port}`,
    control: `http://127.0.0.1:${controlPort}`,
  }),
);
const stop = () => {
  for (const socket of sockets) socket.destroy();
  app.close();
  control.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
