#!/usr/bin/env node
// Part C (plan 14): run the integration specs against the RELEASED backend, on a disposable SQLite database, behind the delaying
// proxy, with the fixture-only session harness page served by `vite preview --mode fixture`.
//
//   node scripts/integration/run.mjs [--serve] [--postgres] [--oidc on|off] [--evidence <dir>] [--browsers chromium,firefox,webkit] [--grep <pattern>] [-- <playwright args>]
//
//   default   plan first: Playwright's own discovery gives every case of the programme exactly one stack (scripts/integration/stacks.mjs),
//             before anything is started. Then, for each browser, each stack in turn: a FRESH stack (backend, database, proxy, preview),
//             Playwright's `integration-<browser>` project on that stack's cases, everything stopped. The suite is split over stacks
//             because one backend's sign-in budget does not cover it; the proxy records each stack's sign-in traffic and a stack
//             that went over the budget is not a pass (scripts/integration/admission.mjs).
//             The FIRST stack that does not pass (a failed or missing case, a report that is not this launch's, a preparation error, a
//             signal, a clean-up that leaves something behind, sign-in traffic over the backend's budget) stops the run: no later stack or browser is launched, and each is
//             recorded `not_run` with that reason. Exit 0 only when every planned stack passed.
//   --serve   start one stack and print the URLs; run until interrupted (for exploring; nothing is run, nothing is planned)
//   --oidc    for a NARROWED run only (--grep or Playwright arguments): whether the stack configures the stub OpenID Connect provider
//             (default on). The full programme decides per stack.
//
// Evidence: every invocation writes into a fresh directory of its own, <evidence>/runs/<invocation>/ (plan.json, results-<browser><stack>.json,
// admissions-<browser><stack>.json, summary.json, the browser evidence unless ATLAS_EVIDENCE_DIR says otherwise). summary.json is rewritten
// as each stack ends, so an interrupted run still says what completed, what failed and what never ran. <evidence>/summary.json is
// written too when it does not exist yet; an existing file there is left as it is.
//
// Loopback listeners on OS-chosen free ports only. Disposable state under a fresh directory in $TMPDIR. Every process this script
// starts is registered when it is spawned and stopped, with its descendants (Playwright's workers and browsers), when its stack ends
// or the run is interrupted (scripts/integration/ownership.mjs); the ports are checked to be free again. It touches no existing
// service and no real user data.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
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
import { audit, createAdmissionRecorder } from "./admission.mjs";
import { createProxy } from "./delaying-proxy.mjs";
import { freePort } from "./free-port.mjs";
import { createOidcProvider } from "./oidc-provider.mjs";
import { applyBudget, describe, judge, schedule } from "./outcome.mjs";
import { Cancelled, createOwner } from "./ownership.mjs";
import { startPostgresBackend } from "./postgres-backend.mjs";
import { plan, selectStacks, stackArgs } from "./stacks.mjs";

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
const oidcFlag = value("--oidc", "on") !== "off";
const selection = selectStacks({ grep, passthrough, postgres, oidc: oidcFlag });

// The invocation's own evidence directory: created exclusively, so no earlier run's files can be read as this one's.
const invocation = {
  id: `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
  started_at: new Date().toISOString(),
  argv: args,
  pid: process.pid,
  node: process.version,
};
mkdirSync(join(evidence, "runs"), { recursive: true });
const runDir = join(evidence, "runs", invocation.id);
mkdirSync(runDir);
const browserEvidence =
  process.env.ATLAS_EVIDENCE_DIR ?? join(runDir, "browser");

const owner = createOwner();
let current = null; // the stack being prepared, run or cleaned up
let lastBackend = null;
let signalled = null;
const records = [];

const listening = (port) =>
  new Promise((resolveCheck) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveCheck(true);
    });
    socket.once("error", () => resolveCheck(false));
  });

async function waitFor(url, label, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    owner.check();
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

/** A bounded tail of a child's output, for the error that explains why it did not become ready. */
function capture(handle) {
  let text = "";
  const add = (d) => {
    text = (text + d).slice(-16_000);
  };
  handle.child.stdout?.on("data", add);
  handle.child.stderr?.on("data", add);
  return () => text;
}

/**
 * Stop everything one stack owns, once (a signal and the stack's own end share the same promise): Playwright and its descendants
 * first, then the preview and the backend, then the in-process proxy and provider, the containers of a PostgreSQL stack, the
 * disposable directory; then check the ports. Returns what happened, including anything that could not be stopped.
 */
function cleanupStack(state) {
  state.cleanup ??= (async () => {
    const result = { processes: [], errors: [] };
    for (const label of ["playwright", "preview", "backend"]) {
      const handle = state.handles[label];
      if (!handle) continue;
      try {
        // Playwright is asked to stop as on Ctrl-C first (it ends its workers and browsers and writes the report of what ran).
        result.processes.push(
          await owner.terminate(
            handle,
            undefined,
            label === "playwright" ? { signal: "SIGINT", ms: 10_000 } : null,
          ),
        );
      } catch (error) {
        result.errors.push(`${label}: ${String(error?.message ?? error)}`);
      }
    }
    for (const [label, stop] of [
      ["proxy", () => state.proxy?.stop()],
      ["provider", () => state.provider?.stop()],
    ])
      await Promise.resolve()
        .then(stop)
        .catch((error) =>
          result.errors.push(`${label}: ${String(error?.message ?? error)}`),
        );
    if (state.extraCleanup) {
      try {
        result.containers = state.extraCleanup();
        console.error(
          `clean-up (containers, network, images added by this run): ${JSON.stringify(result.containers)}`,
        );
        if (
          result.containers.containers_left === undefined ||
          result.containers.images_added_and_left?.length > 0
        )
          result.errors.push("container clean-up left images behind");
      } catch (error) {
        result.errors.push(`containers: ${String(error?.message ?? error)}`);
      }
    }
    if (state.tmp) {
      try {
        rmSync(state.tmp, { recursive: true, force: true });
        result.tmp_removed = !existsSync(state.tmp);
      } catch (error) {
        result.errors.push(`tmp: ${String(error?.message ?? error)}`);
      }
    }
    const still = [];
    for (const port of state.ports) if (await listening(port)) still.push(port);
    result.listeners_left = still;
    result.survivors = result.processes.flatMap((p) => p.survivors);
    result.ok =
      result.errors.length === 0 &&
      still.length === 0 &&
      result.survivors.length === 0;
    if (still.length > 0)
      console.error(
        `WARNING: a listener remains on port(s) ${still.join(", ")}`,
      );
    if (result.survivors.length > 0)
      console.error(
        `WARNING: owned process(es) survived clean-up: ${result.survivors.join(", ")}`,
      );
    if (result.ok)
      console.error(
        `clean-up: no listener remains on ${state.ports.join(", ")}; ${state.tmp} removed`,
      );
    return result;
  })();
  return state.cleanup;
}

/** Start one stack: accounts, invitations, the backend (or the PostgreSQL container pair), the proxy and the preview. */
async function prepare(state) {
  const { stack } = state;
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
  state.tmp = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), "atlas-integration-"),
  );
  const [backendPort, previewPort, proxyPort, controlPort] = [
    await freePort(),
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  state.ports.push(backendPort, previewPort, proxyPort, controlPort);
  const origin = `http://127.0.0.1:${previewPort}`;
  // alice and bob for the read-only and sign-in specs; carol, dave and erin for the specs that change an account (password,
  // logout, retirement), so no spec depends on another spec's side effects. Passwords are generated per run and travel by stdin
  // and the environment only.
  const accounts = {};
  let revision;
  let oidc = null;
  if (stack.oidc && !postgres) {
    // The stub provider, on loopback, before the backend: the backend discovers it at the first single-sign-on request.
    state.provider = createOidcProvider({
      clientId: "atlas-web-integration",
      callbackUrl: `${origin}/api/experimental/v1/oidc/callback`,
    });
    oidc = await state.provider.start();
    state.ports.push(oidc.issuerPort, oidc.controlPort);
    owner.check();
  }

  if (postgres) {
    // OPTIONAL repeat: the released backend CONTAINER image against a disposable PostgreSQL (docs/session.md, "Integration").
    state.backendStartedAt = Date.now();
    const started = await startPostgresBackend({ backendPort, origin, names });
    state.extraCleanup = started.stop;
    Object.assign(accounts, started.accounts);
    revision = started.describe;
    lastBackend = started.describe;
    console.error(
      `backend container ${started.describe.backend_image} on ${started.describe.postgres_image}`,
    );
    owner.check();
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
    const database = `sqlite://${join(state.tmp, "atlas.sqlite")}?mode=rwc`;

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
    owner.check();

    // 3. The backend. Its sign-in budget's clock starts with the process.
    state.backendStartedAt = Date.now();
    state.handles.backend = owner.spawnOwned("backend", backend.binary, [], {
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
    const serverLog = capture(state.handles.backend);
    await waitFor(`http://127.0.0.1:${backendPort}/ready`, "backend").catch(
      (e) => {
        if (e instanceof Cancelled) throw e;
        throw new Error(`${e.message}\n${serverLog().slice(-2000)}`);
      },
    );
  }
  if (postgres)
    await waitFor(
      `http://127.0.0.1:${backendPort}/ready`,
      "backend container",
      240,
    );

  // 4. The delaying proxy (it accounts for the stack's sign-in traffic), then the preview server whose backend is the proxy.
  state.proxy = createProxy({
    upstream: `http://127.0.0.1:${backendPort}`,
    port: proxyPort,
    controlPort,
    observe: state.admissions.observe,
  });
  const urls = await state.proxy.start();
  owner.check();
  state.handles.preview = owner.spawnOwned(
    "preview",
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
  capture(state.handles.preview);
  await waitFor(`${origin}/`, "preview");

  // The specs' own pacing files (tmpdir()) belong to this stack alone, not to whichever stack last had the same port.
  const specTmp = join(state.tmp, "specs");
  mkdirSync(specTmp);
  return {
    ...process.env,
    TMPDIR: specTmp,
    TMP: specTmp,
    TEMP: specTmp,
    ATLAS_EVIDENCE_DIR: browserEvidence,
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
    ATLAS_E2E_BROWSERS: state.browser === "chromium" ? "" : "all",
  };
}

const newState = (browser, stack, index) => ({
  browser,
  stack,
  index,
  tmp: "",
  ports: [],
  handles: {},
  proxy: null,
  provider: null,
  extraCleanup: null,
  admissions: createAdmissionRecorder(),
  cleanup: null,
});

/** One stack, start to end. Never throws: whatever happens becomes the stack's record, with its clean-up. */
async function launch(browser, stack, index, expected) {
  const state = newState(browser, stack, index);
  current = state;
  const label = `${browser}${stack.suffix}`;
  const reportPath = join(runDir, `results-${label}.json`);
  let record;
  try {
    const env = await prepare(state);
    owner.check();
    if (existsSync(reportPath))
      throw new Error(`refusing to reuse an existing report: ${reportPath}`);
    const launchedAt = Date.now();
    const handle = owner.spawnOwned(
      "playwright",
      process.execPath,
      [
        join(root, "node_modules/@playwright/test/cli.js"),
        "test",
        `--project=integration-${browser}`,
        "--reporter=list,json",
        ...stackArgs(stack),
      ],
      {
        cwd: root,
        env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
        stdio: "inherit",
      },
    );
    state.handles.playwright = handle;
    // Playwright's workers and browsers are remembered while they run, so they are still owned if their parent dies first.
    const watch = setInterval(() => owner.snapshot(handle), 2000);
    const exit = await handle.closed;
    clearInterval(watch);
    let report = null;
    let readError = null;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch (error) {
      readError = String(error?.message ?? error);
    }
    record = {
      ...judge({
        expected,
        report,
        readError,
        exit: { ...exit, spawnError: handle.spawnError },
        launchedAt,
      }),
      report: reportPath,
    };
  } catch (error) {
    record = {
      outcome: error instanceof Cancelled ? "cancelled" : "error",
      reason: String(error?.message ?? error),
      error: String(error?.stack ?? error),
      expected: expected.length,
    };
  }
  // A signal: the stack is cancelled, and what it had come to before is kept beside that (a stack that still finished cleanly keeps
  // its pass; the run stops after it either way).
  if (
    signalled &&
    record.outcome !== "passed" &&
    record.outcome !== "cancelled"
  )
    record = {
      ...record,
      outcome: "cancelled",
      reason: owner.latched,
      before_cancellation: { outcome: record.outcome, reason: record.reason },
    };
  const requests = state.admissions.requests();
  record = applyBudget(
    record,
    audit(requests, { backendStartedAt: state.backendStartedAt }),
  );
  writeFileSync(
    join(runDir, `admissions-${label}.json`),
    `${JSON.stringify({ summary: record.admissions, backend_started_at: state.backendStartedAt ?? null, requests }, null, 2)}\n`,
    { flag: "wx" },
  );
  record.cleanup = await cleanupStack(state);
  if (record.outcome === "passed" && !record.cleanup.ok)
    record = {
      ...record,
      outcome: "cleanup_failed",
      reason: "the stack's clean-up left something behind",
    };
  current = null;
  return record;
}

const layer = postgres
  ? "integration (PostgreSQL repeat): the session module and its production adapters in a real engine against the RELEASED backend CONTAINER IMAGE on a disposable PostgreSQL, behind the delaying proxy, for the specs selected by --grep only; NOT the WEB-08c lifecycle traces on a rendered cache, NOT real Safari or a real device, NOT assistive technology, NOT the unmodified Compose or Ingress arrangement"
  : "integration: the session module and its production adapters in a real engine against the RELEASED backend on a disposable SQLite database, behind the delaying proxy; NOT the WEB-08c lifecycle traces on a rendered cache, NOT real Safari or a real device, NOT assistive technology, NOT PostgreSQL";

let planned = null;
function summarise(final, extra = {}) {
  const engines = {};
  for (const browser of browsers) {
    const mine = records.filter((r) => r.browser === browser);
    const merged = { passed: 0, failed: 0, skipped: 0, flaky: 0, not_run: 0 };
    for (const r of mine)
      for (const [k, n] of Object.entries(r.counts ?? {}))
        merged[k] = (merged[k] ?? 0) + n;
    engines[browser] = {
      // Counts are of judged reports only; `complete` says whether they cover the whole plan for this browser.
      complete:
        mine.length === (planned?.stacks.length ?? -1) &&
        mine.every((r) => r.outcome === "passed"),
      counts: merged,
    };
  }
  const failure = records.find(
    (r) => r.outcome !== "passed" && r.outcome !== "not_run",
  );
  return {
    schema: 2,
    layer,
    invocation: { ...invocation, run_dir: runDir, finished: final },
    selection: planned
      ? {
          mode: planned.mode,
          ok: planned.ok,
          problems: planned.problems,
          stacks: planned.stacks.map(({ stack, cases }) => ({
            stack: stack.suffix || "base",
            args: stackArgs(stack),
            oidc: Boolean(stack.oidc),
            cases_per_browser: Object.fromEntries(
              browsers.map((b) => [
                b,
                cases.filter((c) => c.project === `integration-${b}`).length,
              ]),
            ),
          })),
        }
      : null,
    outcome: extra.outcome ?? (final ? "pending" : "running"),
    first_failure: failure ? describe(failure) : null,
    signal: signalled,
    stacks: records,
    engines,
    backend: lastBackend,
    ...extra,
  };
}

function writeSummary(final, extra) {
  const text = `${JSON.stringify(summarise(final, extra), null, 2)}\n`;
  writeFileSync(join(runDir, "summary.json"), text);
  if (final)
    try {
      writeFileSync(join(evidence, "summary.json"), text, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      console.error(
        `${join(evidence, "summary.json")} already exists and is left as it is; this run's summary is ${join(runDir, "summary.json")}`,
      );
    }
}

let finishing = null;
/** The one way out: clean up whatever stack is current, write the final summary, exit. The first caller decides the code. */
function finish(code, extra = {}) {
  finishing ??= (async () => {
    if (current) {
      const state = current;
      const cleaned = await cleanupStack(state);
      if (
        !records.some(
          (r) => r.browser === state.browser && r.index === state.index,
        )
      )
        records.push({
          browser: state.browser,
          stack: state.stack.suffix || "base",
          index: state.index,
          outcome: "cancelled",
          reason: owner.latched ?? "interrupted",
          cleanup: cleaned,
        });
    }
    const cleanupFailed = records.some((r) => r.cleanup && !r.cleanup.ok);
    writeSummary(true, {
      outcome: extra.outcome,
      cleanup_failed: cleanupFailed,
      ...extra,
    });
    process.exit(code === 0 && cleanupFailed ? 1 : code);
  })();
  return finishing;
}

function onSignal(signal) {
  if (signalled) {
    console.error(`${signal} again: already stopping`);
    return;
  }
  signalled = signal;
  const code = signal === "SIGINT" ? 130 : 143;
  owner.stop(`received ${signal}`);
  console.error(`\n${signal}: stopping; no further stack is launched`);
  if (serve) {
    void (current ? cleanupStack(current) : Promise.resolve()).finally(() =>
      process.exit(code),
    );
    return;
  }
  // Stop the running stack now (Playwright first); the schedule then records it and stops. Should the main flow not get there
  // (a preparation step that does not look at the latch), finish on our own after a bounded wait.
  if (current) void cleanupStack(current);
  setTimeout(() => void finish(code, { outcome: "cancelled" }), 60_000).unref();
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

if (serve) {
  // `--serve` starts one stack and never returns: nothing is planned or run.
  const state = newState(browsers[0], selection.stacks[0], 0);
  current = state;
  try {
    const env = await prepare(state);
    console.error(
      `serving: preview ${env.ATLAS_INTEGRATION_URL}  proxy control ${env.ATLAS_INTEGRATION_CONTROL}  backend ${env.ATLAS_INTEGRATION_BACKEND}`,
    );
    writeFileSync(join(state.tmp, "env.json"), JSON.stringify(env));
    await new Promise(() => undefined);
  } catch (error) {
    console.error(String(error?.stack ?? error));
    await cleanupStack(state);
    process.exit(signalled === "SIGINT" ? 130 : signalled ? 143 : 1);
  }
}

try {
  planned = plan({
    root,
    browsers,
    selection,
    evidence: join(runDir, "discovery"),
  });
} catch (error) {
  planned = null;
  console.error(String(error?.stack ?? error));
  await finish(1, { outcome: "plan_error", plan_error: String(error) });
}
writeFileSync(
  join(runDir, "plan.json"),
  `${JSON.stringify(
    {
      mode: planned.mode,
      ok: planned.ok,
      problems: planned.problems,
      browsers,
      full_cases: planned.full.length,
      stacks: planned.stacks.map(({ stack, cases }) => ({
        stack: stack.suffix || "base",
        args: stackArgs(stack),
        oidc: Boolean(stack.oidc),
        cases: cases.map((c) => ({
          key: c.key,
          project: c.project,
          file: c.file,
          title: c.title,
        })),
      })),
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);
if (!planned.ok) {
  for (const problem of planned.problems) console.error(`plan: ${problem}`);
  for (const browser of browsers)
    for (const [index, { stack }] of planned.stacks.entries())
      records.push({
        browser,
        stack: stack.suffix || "base",
        index,
        outcome: "not_run",
        reason:
          "not launched: the plan does not give every case exactly one stack",
      });
  await finish(1, { outcome: "plan_error" });
}

const result = await schedule({
  browsers,
  stacks: planned.stacks.map(({ stack }) => stack),
  latched: () => owner.latched,
  launch: (browser, stack, index) => {
    console.error(
      `\n=== integration-${browser}${stack.suffix ? ` (${stack.suffix.slice(1)})` : ""} ===`,
    );
    return launch(
      browser,
      stack,
      index,
      planned.stacks[index].cases.filter(
        (c) => c.project === `integration-${browser}`,
      ),
    );
  },
  onRecord: (record) => {
    records.push(record);
    if (record.outcome !== "passed" && record.outcome !== "not_run")
      console.error(`\nSTOPPING: ${describe(record)}`);
    writeSummary(false);
  },
});
const outcome = signalled ? "cancelled" : result.passed ? "passed" : "failed";
await finish(
  signalled === "SIGINT" ? 130 : signalled ? 143 : result.passed ? 0 : 1,
  {
    outcome,
  },
);
