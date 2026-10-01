#!/usr/bin/env node
// Part C (plan 14): run the integration specs against the RELEASED backend, on a disposable SQLite database, behind the delaying
// proxy, with the fixture-only session harness page served by `vite preview --mode fixture`.
//
//   node scripts/integration/run.mjs [--serve] [--postgres] [--evidence <dir>] [--browsers chromium,firefox,webkit] [--grep <pattern>] [-- <playwright args>]
//
//   default   for each browser: start a FRESH stack, run Playwright's `integration-<browser>` project, stop everything; exit non-zero if any failed.
//             With no --grep the project runs in two stacks per browser (see STACKS): the suite exceeds what one stack's backend allows.
//   --serve   start everything and print the URLs; run until interrupted (for exploring; nothing is run)
//
// Loopback listeners on OS-chosen free ports only. Disposable state under a fresh directory in $TMPDIR. Every process this script
// starts is stopped on exit and the ports are checked to be free again. It touches no existing service and no real user data.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProxy } from "./delaying-proxy.mjs";
import { freePort } from "./free-port.mjs";
import { startPostgresBackend } from "./postgres-backend.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
// `--evidence <dir>` keeps a measurement run (pnpm profile:session) from overwriting the integration evidence.
const evidenceFlag = args.indexOf("--evidence");
const evidence = resolve(
  root,
  evidenceFlag >= 0
    ? (args[evidenceFlag + 1] ?? "")
    : ".agtx/evidence/WEB-08a/integration",
);
mkdirSync(evidence, { recursive: true });
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const serve = flag("--serve");
const postgres = flag("--postgres");
const browsers = value("--browsers", "chromium").split(",");
const grep = value("--grep", "");
const passthrough = args.includes("--")
  ? args.slice(args.indexOf("--") + 1)
  : [];
// The backend throttles password sign-ins per source (a fixed window of 60 s: at most 120 requests, and 10 attempts per account),
// and every spec of a stack signs in from the same loopback address. One stack that runs the whole suite therefore exhausts the
// window and the last specs are refused with 429 (this happened when I-14e was added, before it had its own stack). The suite is
// split over fresh stacks: everything but I-14e, then I-14e. A run the caller has narrowed (`--grep`, or Playwright arguments
// after `--` such as a spec file or a config) is one stack, as before: the caller chose what runs.
const STACKS =
  grep || passthrough.length > 0
    ? [{ suffix: "", args: grep ? ["--grep", grep] : [] }]
    : [
        { suffix: "", args: ["--grep-invert", "I-14e"] },
        { suffix: "-i14e", args: ["--grep", "I-14e"] },
      ];

const children = [];
let tmp = "";
const ports = [];
let proxy = null;
let lastBackend = null;
let extraCleanup = null;

const listening = (port) =>
  new Promise((resolveCheck) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveCheck(true);
    });
    socket.once("error", () => resolveCheck(false));
  });

async function cleanup() {
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGKILL");
  if (proxy) await proxy.stop().catch(() => undefined);
  if (extraCleanup) {
    const left = extraCleanup();
    console.error(
      `clean-up (containers, network, images added by this run): ${JSON.stringify(left)}`,
    );
    extraCleanup = null;
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  const still = [];
  for (const port of ports) if (await listening(port)) still.push(port);
  if (still.length > 0)
    console.error(`WARNING: a listener remains on port(s) ${still.join(", ")}`);
  else
    console.error(
      `clean-up: no listener remains on ${ports.join(", ")}; ${tmp} removed`,
    );
  // The next engine gets a fresh stack and a fresh list.
  children.length = 0;
  ports.length = 0;
  proxy = null;
  tmp = "";
}
process.on("SIGINT", () => cleanup().finally(() => process.exit(130)));
process.on("SIGTERM", () => cleanup().finally(() => process.exit(143)));

async function waitFor(url, label, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

async function main(browser, stack) {
  const names = ["alice", "bob", "carol", "dave", "erin"];
  tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "atlas-integration-"));
  const [backendPort, previewPort, proxyPort, controlPort] = [
    await freePort(),
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  ports.push(backendPort, previewPort, proxyPort, controlPort);
  const origin = `http://127.0.0.1:${previewPort}`;
  // alice and bob for the read-only and sign-in specs; carol, dave and erin for the specs that change an account (password,
  // logout, retirement), so no spec depends on another spec's side effects. Passwords are generated per run and travel by stdin
  // and the environment only.
  const accounts = {};
  let revision;

  if (postgres) {
    // OPTIONAL repeat: the released backend CONTAINER image against a disposable PostgreSQL (docs/session.md, "Integration").
    const started = await startPostgresBackend({ backendPort, origin, names });
    extraCleanup = started.stop;
    Object.assign(accounts, started.accounts);
    revision = started.describe;
    lastBackend = started.describe;
    console.error(
      `backend container ${started.describe.backend_image} on ${started.describe.postgres_image}`,
    );
  } else {
    // 1. The released backend, verified against the release's SHA256SUMS.
    const fetched = spawnSync(
      process.execPath,
      [join(root, "scripts/integration/fetch-backend.mjs")],
      { encoding: "utf8" },
    );
    if (fetched.status !== 0)
      throw new Error(
        `fetch-backend failed:\n${fetched.stdout}${fetched.stderr}`,
      );
    const backend = JSON.parse(fetched.stdout.trim().split("\n").at(-1));
    revision = {
      tag: backend.tag,
      archive: backend.archive,
      sha256: backend.sha256,
    };
    lastBackend = revision;
    console.error(
      `backend ${backend.tag} (${backend.archive}, sha256 ${backend.sha256.slice(0, 12)}…, verified against SHA256SUMS)`,
    );
    const database = `sqlite://${join(tmp, "atlas.sqlite")}?mode=rwc`;

    // 2. Accounts, made with the backend's own command.
    for (const name of names) {
      const password = randomBytes(16).toString("hex");
      const made = spawnSync(backend.binary, ["account", name], {
        input: `${password}\n`,
        env: { ...process.env, ATLAS_DATABASE_URL: database },
        encoding: "utf8",
      });
      if (made.status !== 0)
        throw new Error(
          `could not create ${name}:\n${made.stdout}${made.stderr}`,
        );
      accounts[name] = { username: name, password };
    }

    // 3. The backend.
    const server = spawn(backend.binary, [], {
      env: {
        ...process.env,
        ATLAS_DATABASE_URL: database,
        ATLAS_BIND: `127.0.0.1:${backendPort}`,
        ATLAS_PUBLIC_ORIGIN: origin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(server);
    let serverLog = "";
    server.stdout.on("data", (d) => (serverLog += d));
    server.stderr.on("data", (d) => (serverLog += d));
    await waitFor(`http://127.0.0.1:${backendPort}/ready`, "backend").catch(
      (e) => {
        throw new Error(`${e.message}\n${serverLog.slice(-2000)}`);
      },
    );
  }
  if (postgres)
    await waitFor(
      `http://127.0.0.1:${backendPort}/ready`,
      "backend container",
      240,
    );

  // 4. The delaying proxy, then the preview server whose backend is the proxy.
  proxy = createProxy({
    upstream: `http://127.0.0.1:${backendPort}`,
    port: proxyPort,
    controlPort,
  });
  const urls = await proxy.start();
  const preview = spawn(
    process.execPath,
    [
      join(root, "node_modules/vite/bin/vite.js"),
      "preview",
      "--mode",
      "fixture",
      "--host",
      "127.0.0.1",
      "--port",
      String(previewPort),
      "--strictPort",
    ],
    {
      cwd: root,
      env: { ...process.env, ATLAS_BACKEND_URL: urls.proxyUrl },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(preview);
  await waitFor(`${origin}/`, "preview");

  const env = {
    ...process.env,
    ATLAS_INTEGRATION_URL: origin,
    ATLAS_INTEGRATION_CONTROL: urls.controlUrl,
    ATLAS_INTEGRATION_BACKEND: `http://127.0.0.1:${backendPort}`,
    ATLAS_INTEGRATION_ACCOUNTS: JSON.stringify(accounts),
    ATLAS_INTEGRATION_BACKEND_REVISION: JSON.stringify(revision),
    ATLAS_E2E_BROWSERS: browser === "chromium" ? "" : "all",
  };
  if (serve) {
    console.error(
      `serving: preview ${origin}  proxy control ${urls.controlUrl}  backend ${env.ATLAS_INTEGRATION_BACKEND}`,
    );
    writeFileSync(join(tmp, "env.json"), JSON.stringify(env));
    await new Promise(() => undefined);
    return 0;
  }

  // 5. The specs.
  const projectArgs = ["--project", `integration-${browser}`];
  const grepArgs = stack.args;
  const run = spawn(
    process.execPath,
    [
      join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      ...projectArgs,
      "--reporter=list,json",
      ...grepArgs,
      ...passthrough,
    ],
    {
      cwd: root,
      env: {
        ...env,
        PLAYWRIGHT_JSON_OUTPUT_NAME: join(
          evidence,
          `results-${browser}${stack.suffix}.json`,
        ),
      },
      stdio: "inherit",
    },
  );
  return new Promise((resolveRun) =>
    run.on("exit", (code) => resolveRun(code ?? 1)),
  );
}

// One fresh stack per engine: the specs that change an account (password, logout, retirement, device capacity) must not leave
// the next engine's run with accounts they have used up.
let status = 0;
const summary = {
  layer: postgres
    ? "integration (PostgreSQL repeat): the session module and its production adapters in a real engine against the RELEASED backend CONTAINER IMAGE on a disposable PostgreSQL, behind the delaying proxy, for the specs selected by --grep only; NOT the WEB-08c lifecycle traces on a rendered cache, NOT real Safari or a real device, NOT assistive technology, NOT the unmodified Compose or Ingress arrangement"
    : "integration: the session module and its production adapters in a real engine against the RELEASED backend on a disposable SQLite database, behind the delaying proxy; NOT the WEB-08c lifecycle traces on a rendered cache, NOT real Safari or a real device, NOT assistive technology, NOT PostgreSQL",
  generated_at: new Date().toISOString(),
  engines: {},
};
for (const browser of browsers) {
  // `--serve` starts one stack and never returns, so only the first is ever started.
  for (const stack of serve ? STACKS.slice(0, 1) : STACKS) {
    console.error(
      `\n=== integration-${browser}${stack.suffix ? ` (${stack.suffix.slice(1)})` : ""} ===`,
    );
    try {
      status = (await main(browser, stack)) || status;
    } catch (error) {
      console.error(String(error?.stack ?? error));
      status = 1;
    } finally {
      await cleanup();
    }
  }
  // One entry per engine: the statistics of its stacks added together.
  const merged = {};
  let missing = false;
  for (const stack of STACKS) {
    try {
      const result = JSON.parse(
        readFileSync(
          join(evidence, `results-${browser}${stack.suffix}.json`),
          "utf8",
        ),
      );
      for (const [key, number] of Object.entries(result.stats))
        if (typeof number === "number")
          merged[key] = (merged[key] ?? 0) + number;
    } catch {
      missing = true;
    }
  }
  summary.engines[browser] = missing
    ? "no result file (a run did not get as far as Playwright)"
    : merged;
}
summary.backend = lastBackend;
if (!serve)
  writeFileSync(
    join(evidence, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
process.exit(status);
