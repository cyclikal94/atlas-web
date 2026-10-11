#!/usr/bin/env node
// Part C (plan 14): run the integration specs against the RELEASED backend, on a disposable SQLite database, behind the delaying
// proxy, with the fixture-only session harness page served by `vite preview --mode fixture`.
//
//   node scripts/integration/run.mjs [--serve] [--postgres] [--oidc on|off] [--evidence <dir>] [--browsers chromium,firefox,webkit] [--grep <pattern>] [-- <playwright args>]
//
//   default   for each browser: start a FRESH stack, run Playwright's `integration-<browser>` project, stop everything; exit non-zero if any failed.
//             With no --grep the project runs in separate stacks per browser (see STACKS): the suite exceeds what one stack's backend allows.
//   --serve   start everything and print the URLs; run until interrupted (for exploring; nothing is run)
//   --oidc    for a NARROWED run only (--grep or Playwright arguments): whether the stack configures the stub OpenID Connect provider
//             (default on). The default suite decides per stack (WEB-08b: STACKS below).
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
import { createOidcProvider } from "./oidc-provider.mjs";
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
// split over fresh stacks: the base cases, I-14e, the I-14d cases of revision 11, data cases, and the WEB-08b groups below.
// A run the caller has narrowed (`--grep`, or Playwright arguments
// after `--` such as a spec file or a config) is one stack, as before: the caller chose what runs.
// WEB-08b adds stacks that each run a group of specs: the ordering traces, registration and the browser OIDC round trip consume
// sign-ins, invitations and provider flows, and some need a stack WITHOUT single sign-on configured (I-28b). `oidc` says whether the
// stack starts the stub provider and configures the backend with it.
const oidcFlag = value("--oidc", "on") !== "off";
const NARROWED = grep || passthrough.length > 0;
const STACKS = NARROWED
  ? [
      {
        suffix: "",
        args: grep ? ["--grep", grep] : [],
        oidc: oidcFlag && !postgres,
      },
    ]
  : [
      {
        suffix: "",
        args: [
          "--grep-invert",
          "I-14e|I-14d \\(revision 11\\)|I-(P|O|C|S|W)[0-9]|I-2[0-9]|I-30|I-8d",
        ],
        oidc: false,
      },
      { suffix: "-i14e", args: ["--grep", "I-14e"], oidc: false },
      {
        suffix: "-i14d",
        args: ["--grep", "I-14d \\(revision 11\\)"],
        oidc: false,
      },
      {
        suffix: "-data",
        args: ["tests/integration/integration.data.spec.ts"],
        oidc: false,
      },
      { suffix: "-traces", args: ["--grep", "I-20|I-22|I-23"], oidc: false },
      {
        suffix: "-registration",
        args: ["--grep", "I-24|I-25|I-26"],
        oidc: false,
      },
      {
        suffix: "-oidc",
        args: ["--grep", "I-21|I-27|I-28a"],
        oidc: true,
      },
      { suffix: "-oidc-off", args: ["--grep", "I-28b"], oidc: false },
      { suffix: "-settings", args: ["--grep", "I-29|I-30"], oidc: false },
      // WEB-08d: the BE-Q25 labels, names and capacities against the released 0.28 backend, in a fresh stack of their own.
      { suffix: "-labels", args: ["--grep", "I-8d"], oidc: false },
    ];

const children = [];
let tmp = "";
const ports = [];
let proxy = null;
let lastBackend = null;
let extraCleanup = null;
let provider = null;

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
  if (provider) await provider.stop().catch(() => undefined);
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
  provider = null;
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
  // alice to erin: the earlier specs. frank to quinn: WEB-08b (ordering traces, sign-in surface, Settings, single sign-on), each
  // spec using its own account so no spec depends on another's side effects or on a sign-in throttle another has used up.
  const names = [
    "alice",
    "bob",
    "carol",
    "dave",
    "erin",
    "frank",
    "grace",
    "heidi",
    "ivan",
    "judy",
    "kate",
    "liam",
    "mia",
    "nora",
    "olga",
    "pete",
    "quinn",
  ];
  const invitations = [];
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
  let oidc = null;
  if (stack.oidc && !postgres) {
    // The stub provider, on loopback, before the backend: the backend discovers it at the first single-sign-on request.
    provider = createOidcProvider({
      clientId: "atlas-web-integration",
      callbackUrl: `${origin}/api/experimental/v1/oidc/callback`,
    });
    oidc = await provider.start();
    ports.push(oidc.issuerPort, oidc.controlPort);
  }

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

    // 2b. Standalone signup invitations, made with the backend's own command (the token is printed once).
    for (let i = 0; i < 19; i += 1) {
      const made = spawnSync(backend.binary, ["invite"], {
        env: { ...process.env, ATLAS_DATABASE_URL: database },
        encoding: "utf8",
      });
      if (made.status !== 0)
        throw new Error(
          `could not create an invitation:\n${made.stdout}${made.stderr}`,
        );
      invitations.push(JSON.parse(made.stdout.trim().split("\n").at(-1)));
    }

    // 3. The backend.
    const server = spawn(backend.binary, [], {
      env: {
        ...process.env,
        ATLAS_DATABASE_URL: database,
        ATLAS_BIND: `127.0.0.1:${backendPort}`,
        ATLAS_PUBLIC_ORIGIN: origin,
        ...(oidc
          ? {
              ATLAS_OIDC_ISSUER: oidc.issuer,
              ATLAS_OIDC_CLIENT_ID: oidc.clientId,
            }
          : {}),
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
    ATLAS_INTEGRATION_INVITATIONS: JSON.stringify(invitations),
    ATLAS_INTEGRATION_OIDC: oidc
      ? JSON.stringify({
          issuer: oidc.issuer,
          control: oidc.controlUrl,
          client_id: oidc.clientId,
        })
      : "",
    // WEB-08b measurements and evidence stay apart from every earlier task's (the earlier default is WEB-08a-named).
    ATLAS_MEASUREMENTS_DIR: join(dirname(evidence), "profiling"),
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
