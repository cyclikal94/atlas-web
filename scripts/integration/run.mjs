#!/usr/bin/env node
// Part C (plan 14): run the integration specs against the RELEASED backend, on a disposable SQLite database, behind the delaying
// proxy, with the fixture-only session harness page served by `vite preview --mode fixture`.
//
//   node scripts/integration/run.mjs [--serve] [--postgres] [--oidc on|off] [--evidence <dir>] [--browsers chromium,firefox,webkit] [--grep <pattern>] [--stacks <names>] [-- <playwright args>]
//
//   default   for each browser: start a FRESH stack, run Playwright's `integration-<browser>` project, stop everything; exit non-zero if any failed.
//             With no --grep the project runs in separate stacks per browser (scripts/integration/stacks.mjs): the suite exceeds what one
//             stack's backend allows. WEB-08c revision 14 (review 14, R17/R18): every discovered case is in exactly one stack (checked
//             before any backend starts), each stack's own result is judged after its clean-up, and the first stack that is not a
//             complete pass stops the schedule (scripts/integration/schedule.mjs); Playwright runs with one worker, no retry and
//             --max-failures=1 (stacks.mjs PLAYWRIGHT_POLICY). `--evidence` must not hold this invocation's files already.
//   --serve   start everything and print the URLs; run until interrupted (for exploring; nothing is run). The first SIGINT/SIGTERM
//             stops and cleans up the served stack and exits 130/143.
//   --stacks  a comma-separated subset of the default stacks (stacks.mjs DEFAULT_STACKS), run in their usual order; the summary is
//             marked partial and is never a complete suite
//   --oidc    for a NARROWED run only (--grep or Playwright arguments): whether the stack configures the stub OpenID Connect provider
//             (default on). The default suite decides per stack (stacks.mjs).
//
// R18 (process ownership): every process this script spawns (the backend, the preview and Playwright) leads a process group of its
// own, so Playwright's workers and browsers are owned with it. Clean-up signals each owned GROUP (never this script's own group or
// any other), waits for every member to be gone, escalates to SIGKILL, and reports a group that still has members as a failure.
// On SIGINT/SIGTERM Playwright is asked to interrupt (it reports what it ran) and every owned group is terminated within two
// seconds, inside the shared validation driver's grace period.
//
// WEB-08d revision 30 (DELEGATED-WEB08D-RUNNER-RECONCILIATION-20261024, the accepted runner merged into WEB-08d): the PostgreSQL
// repeat keeps WEB-08d's Docker ownership (review r6 H4a, r7 DA-1, r8 DA-1a). Everything a stack creates carries the invocation's and
// the stack's labels and is disposed of by label and VERIFIED gone (scripts/integration/docker-resources.mjs `disposeLabelled`), so
// a creation whose answer was lost is still found; the two pinned images are leased under a host lock shared by every invocation on
// this host and removed only by the last user of a generation that found them absent, never because "this run added them" (another
// invocation may be using them). An unverified disposal fails the stack. Docker commands are bounded and owned
// (scripts/integration/docker-exec.mjs); after a signal only clean-up commands start.
//
// Loopback listeners on OS-chosen free ports only. Disposable state under a fresh directory in $TMPDIR. Every process this script
// starts is stopped on exit and the ports are checked to be free again. It touches no existing service and no real user data.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCalendarFeed } from "./calendar-feed.mjs";
import { createProxy } from "./delaying-proxy.mjs";
import { dockerExec } from "./docker-exec.mjs";
import {
  disposeLabelled,
  dockerClient,
  LABEL_INVOCATION,
  LABEL_STACK,
} from "./docker-resources.mjs";
import { freePort } from "./free-port.mjs";
import { createOidcProvider } from "./oidc-provider.mjs";
import { membersOf, processTable, stopMembers } from "./ownership.mjs";
import { startPostgresBackend } from "./postgres-backend.mjs";
import { ownedGroups } from "./process-groups.mjs";
import { playwrightLister, runIntegration } from "./schedule.mjs";
import { PLAYWRIGHT_POLICY, planStacks, stackArgs } from "./stacks.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
// The runner's own options come before `--`; everything after it is Playwright's (a `--grep` meant for Playwright is not also read
// as the runner's).
const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
// `--evidence <dir>` keeps a measurement run (pnpm profile:session) from overwriting the integration evidence.
const evidenceFlag = own.indexOf("--evidence");
const evidence = resolve(
  root,
  evidenceFlag >= 0
    ? (own[evidenceFlag + 1] ?? "")
    : ".agtx/evidence/WEB-08a/integration",
);
const flag = (name) => own.includes(name);
const value = (name, fallback) => {
  const at = own.indexOf(name);
  return at >= 0 ? own[at + 1] : fallback;
};
const serve = flag("--serve");
const postgres = flag("--postgres");
const browsers = value("--browsers", "chromium").split(",");
const grep = value("--grep", "");
const passthrough = args.includes("--")
  ? args.slice(args.indexOf("--") + 1)
  : [];
// The backend throttles sign-in-class requests per source (a fixed window of 60 s: at most 120 requests, and 10 attempts per
// account), and every spec of a stack signs in from the same loopback address, so the suite is split over fresh stacks
// (stacks.mjs DEFAULT_STACKS). A run the caller has narrowed (`--grep`, or Playwright arguments after `--` such as a spec file) is
// one stack, as before: the caller chose what runs. `oidc` says whether the stack starts the stub provider and configures the
// backend with it.
const oidcFlag = value("--oidc", "on") !== "off";
// `--stacks a,b`: only these default stacks, in their usual order (a labelled partial run; see stacks.mjs planStacks).
const only = value("--stacks", "").split(",").filter(Boolean);
let plan;
try {
  plan = planStacks({
    grep,
    passthrough,
    oidc: oidcFlag,
    postgres,
    only,
  });
} catch (error) {
  console.error(`REFUSED: ${error.message}`);
  process.exit(2);
}
const { narrowed, partial, manifest, stacks: STACKS } = plan;

// The reaper (scripts/integration/reaper.mjs, WEB-08d review r6 H4, carried over in revision 30): started first, in a group of its
// own, told every owned group and Docker stack, released once this process has cleaned up. If this process is killed (SIGKILL, a
// crash) before it releases, the reaper stops those groups and disposes of those Docker resources itself. It holds this process's
// stdout and stderr, so a caller that waits for them also waits for its clean-up.
const invocationId = randomUUID();
let reaperReleased = false;
mkdirSync(evidence, { recursive: true });
const reaper = spawn(
  process.execPath,
  [
    join(root, "scripts/integration/reaper.mjs"),
    "--record",
    join(evidence, `reaper-${invocationId}.json`),
  ],
  { detached: true, stdio: ["pipe", "inherit", "inherit"] },
);
let reaperProblem = null;
reaper.once("error", (error) => {
  reaperProblem = `reaper: ${error.message}`;
  console.error(reaperProblem);
});
reaper.once("exit", (code, signal) => {
  if (!reaperReleased) {
    reaperProblem ??= `reaper ended early (exit ${code}, signal ${signal})`;
    console.error(reaperProblem);
  }
});
reaper.stdin.on("error", () => undefined);
reaper.unref();
const tellReaper = (message) => {
  if (!reaper.stdin.writable) return;
  reaper.stdin.write(`${JSON.stringify(message)}\n`);
};
/** After this process's own clean-up: the reaper exits doing nothing. Waits (bounded) for it to end. */
async function releaseReaper() {
  if (reaperReleased) return;
  reaperReleased = true;
  tellReaper({ type: "release" });
  reaper.stdin.end();
  // The bounded wait keeps the event loop alive (a referenced timer, cleared once the reaper exits): this runs under a top-level
  // await, and with nothing referenced Node would end the process there (exit 13) before the runner's own exit status is set.
  if (reaper.exitCode === null && reaper.signalCode === null) {
    let timer;
    await Promise.race([
      new Promise((resolveExit) => reaper.once("exit", resolveExit)),
      new Promise((resolveWait) => {
        timer = setTimeout(resolveWait, 5_000);
      }),
    ]);
    clearTimeout(timer);
  }
}

// WEB-08d review r6 H4b, carried over in revision 30: every process this invocation starts after this point inherits an ownership
// MARK in its environment (`ATLAS_IT_<token>=1`, scripts/integration/ownership.mjs), so a descendant that left its process group
// (a new session, an exited parent) is still found: each clean-up ends with a look for marked processes, which are stopped and
// reported. The reaper above was started before the mark was set and never carries it.
const markToken = randomBytes(8).toString("hex");
process.env[`ATLAS_IT_${markToken}`] = "1";
tellReaper({ type: "mark", token: markToken });
const marked = () => {
  try {
    return membersOf({
      table: processTable(),
      marks: new Set([`${markToken}=1`]),
      never: new Set([process.pid, process.ppid, reaper.pid]),
    });
  } catch {
    return null; // the table could not be read: stopMembers reports it
  }
};

// R18: every spawned process leads its own group; clean-up and signals reach the whole tree (scripts/integration/process-groups.mjs).
const groups = ownedGroups({
  onSpawn: ({ pgid, label }) => {
    tellReaper({ type: "group", pgid });
    console.error(`owned process group ${pgid} (${label})`);
  },
});
// The PostgreSQL repeat's Docker commands and labels (see the header). `dockerStack`: the label of the stack whose containers,
// network, volumes and image leases exist or may exist, set BEFORE the first docker command of that stack.
const dockerCommands = dockerExec();
const docker = dockerClient(dockerCommands.run);
const dockerStop = new AbortController();
let dockerStack = null;
let tmp = "";
const ports = [];
let proxy = null;
let feed = null;
let lastBackend = null;
let provider = null;
// R17: what the backend answered this stack (the proxy's `observe`), for its throttle record.
let exchanges = [];
// The first SIGINT/SIGTERM. The stack in progress is stopped and cleaned up, its partial result kept, and nothing else starts.
let interrupted = null;
// Settles on the first signal (and stays settled), so a wait that has no schedule behind it (`--serve`) ends too.
let cancel;
const cancelled = new Promise((resolveCancel) => {
  cancel = resolveCancel;
});
const exitFor = (signal) => (signal === "SIGINT" ? 130 : 143);
/** Checked after every awaited or blocking step of a stack's preparation, so no further resource starts after a signal. */
const stopIfInterrupted = () => {
  if (interrupted) throw new Error(`interrupted by ${interrupted}`);
};

const listening = (port) =>
  new Promise((resolveCheck) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveCheck(true);
    });
    socket.once("error", () => resolveCheck(false));
  });

/**
 * Stop everything this stack started (Playwright's whole process group included) and check its groups are empty and its ports
 * free. Idempotent: a clean-up already in progress is joined, not repeated. Returns the problems found; a problem fails the stack,
 * it is not only a warning.
 */
let cleaning = null;
function cleanup() {
  cleaning ??= (async () => {
    const stopped = await groups.stopAll();
    const problems = [...stopped.problems];
    for (const note of stopped.notes) console.error(`clean-up: ${note}`);
    if (proxy)
      await proxy
        .stop()
        .catch((e) => problems.push(`proxy stop: ${String(e?.message ?? e)}`));
    if (feed)
      await feed
        .stop()
        .catch((e) =>
          problems.push(`calendar feed stop: ${String(e?.message ?? e)}`),
        );
    if (provider)
      await provider
        .stop()
        .catch((e) =>
          problems.push(`provider stop: ${String(e?.message ?? e)}`),
        );
    if (dockerStack) {
      // Every container, network and volume labelled with this stack, then its image leases (never throws; ok only when verified).
      const disposed = await disposeLabelled(docker, {
        filter: `${LABEL_STACK}=${dockerStack}`,
      });
      console.error(
        `clean-up (containers, network, volumes, image leases of ${dockerStack}): ${JSON.stringify(disposed)}`,
      );
      if (!disposed.ok)
        problems.push(
          `docker clean-up of ${dockerStack} not verified: ${JSON.stringify({ errors: disposed.errors, remaining: disposed.remaining, images: disposed.images.filter((i) => !i.ok) })}`,
        );
      dockerStack = null;
    }
    // Anything still carrying this invocation's mark escaped its process group (H4b): stopped here, noted, and a failure if it
    // survives or the process table cannot be read.
    const escaped = marked();
    if (escaped === null) problems.push("the process table could not be read");
    else if (escaped.size > 0) {
      const pids = [...escaped.keys()];
      const swept = await stopMembers({ scan: marked });
      console.error(
        `clean-up: marked process(es) outside their group: ${pids.join(", ")}; ${JSON.stringify({ escalated: swept.escalated, left: swept.left === null ? "unknown" : [...swept.left.keys()] })}`,
      );
      if (swept.left === null || swept.left.size > 0)
        problems.push(
          `marked process(es) remain: ${swept.left === null ? "unknown" : [...swept.left.keys()].join(", ")}`,
        );
    }
    try {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      problems.push(`could not remove ${tmp}: ${String(e?.message ?? e)}`);
    }
    const still = [];
    for (const port of ports) if (await listening(port)) still.push(port);
    if (still.length > 0) {
      console.error(
        `WARNING: a listener remains on port(s) ${still.join(", ")}`,
      );
      problems.push(`a listener remains on port(s) ${still.join(", ")}`);
    } else
      console.error(
        `clean-up: no owned process group or listener remains (ports ${ports.join(", ")}); ${tmp} removed`,
      );
    // The next stack gets a fresh stack and a fresh list.
    ports.length = 0;
    proxy = null;
    feed = null;
    provider = null;
    tmp = "";
    return { problems, notes: stopped.notes };
  })().finally(() => {
    cleaning = null;
  });
  return cleaning;
}

// The first signal: no new process may start (groups.close), Playwright is asked to interrupt (so it still writes its partial
// result) and every owned group is terminated within two seconds (groups.interrupt), then the schedule cleans up, records the
// interruption and marks the rest not run. In `--serve` mode the same signal ends the served wait, which cleans up and exits.
// A second signal, or a schedule that has not finished 120 s later, cleans up and exits at once: a forced path, never the ordinary one.
const onSignal = (signal) => {
  const code = exitFor(signal);
  if (interrupted) {
    console.error(`${signal} again: forcing clean-up and exit`);
    cleanup()
      .then(releaseReaper)
      .finally(() => process.exit(code));
    return;
  }
  interrupted = signal;
  console.error(
    `\n${signal}: stopping the stack in progress; nothing else starts`,
  );
  groups.interrupt();
  dockerCommands.stop(signal);
  dockerStop.abort(signal);
  cancel(signal);
  setTimeout(() => {
    console.error(
      `${signal}: still running 120 s later: forcing clean-up and exit`,
    );
    cleanup()
      .then(releaseReaper)
      .finally(() => process.exit(code));
  }, 120_000).unref();
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

async function waitFor(url, label, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    if (interrupted) throw new Error(`interrupted by ${interrupted}`);
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

/** One stack: prepare it, run its specs and return Playwright's exit. A throw carries the phase it failed in (prepare or spawn). */
async function main(browser, stack) {
  exchanges = [];
  try {
    return await stackRun(browser, stack);
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      { phase: error?.phase ?? "prepare", exchanges },
    );
  }
}

async function stackRun(browser, stack) {
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
  // R17: the specs' sign-in ledger and account rotation live as long as THIS stack (removed with it), never keyed by a reusable port.
  const state = join(tmp, "state");
  mkdirSync(state);
  const [backendPort, previewPort, proxyPort, controlPort] = [
    await freePort(),
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  ports.push(backendPort, previewPort, proxyPort, controlPort);
  stopIfInterrupted();
  const origin = `http://127.0.0.1:${previewPort}`;
  // alice and bob for the read-only and sign-in specs; carol, dave and erin for the specs that change an account (password,
  // logout, retirement), so no spec depends on another spec's side effects. Passwords are generated per run and travel by stdin
  // and the environment only.
  const accounts = {};
  let revision;
  // WEB-13a: the loopback calendar feed (the "provider" the backend fetches linked calendars from). The SQLite backend is given a
  // fresh, disposable integration key (64 hex characters, by the environment only, never written anywhere) and an outbound exception
  // for the feed's exact origin, because it denies plain HTTP and loopback addresses by default. The PostgreSQL repeat runs the
  // backend in a container, which cannot reach a loopback feed: its I-CAL linked cases skip themselves with that reason.
  let calendar = null;
  if (!postgres) {
    feed = createCalendarFeed();
    calendar = await feed.start();
    ports.push(Number(new URL(calendar.origin).port));
    stopIfInterrupted();
  }
  let oidc = null;
  if (stack.oidc && !postgres) {
    // The stub provider, on loopback, before the backend: the backend discovers it at the first single-sign-on request.
    provider = createOidcProvider({
      clientId: "atlas-web-integration",
      callbackUrl: `${origin}/api/experimental/v1/oidc/callback`,
    });
    oidc = await provider.start();
    ports.push(oidc.issuerPort, oidc.controlPort);
    stopIfInterrupted();
  }

  if (postgres) {
    // OPTIONAL repeat: the released backend CONTAINER image against a disposable PostgreSQL (docs/session.md, "Integration").
    // Its disposal (by label, verified) is owed from before the first docker command.
    dockerStack = `${invocationId}-${browser}${stack.suffix || "-narrowed"}`;
    tellReaper({ type: "docker", stack: dockerStack });
    const started = await startPostgresBackend({
      backendPort,
      origin,
      names,
      docker,
      labels: { [LABEL_INVOCATION]: invocationId, [LABEL_STACK]: dockerStack },
      signal: dockerStop.signal,
      log: (line) => console.error(line),
    });
    stopIfInterrupted();
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
    stopIfInterrupted();
    if (fetched.status !== 0) {
      // The whole output goes to the log; the stack's recorded reason keeps its cause on ONE line (the schedule records a reason's
      // first line only), so a failed preparation is never reported without its cause (revision 14, campaign 2).
      const output = `${fetched.stdout ?? ""}${fetched.stderr ?? ""}`;
      console.error(`fetch-backend output:\n${output}`);
      const lines = output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      // The error's own headline (`TypeError: fetch failed`, `Error: GET SHA256SUMS: 503`), else the last line printed.
      const cause =
        lines.find((l) => /^[A-Za-z]*Error(: |$)/.test(l)) ??
        lines.at(-1) ??
        fetched.error?.message ??
        `signal ${fetched.signal}`;
      throw new Error(
        `fetch-backend failed (exit ${fetched.status}): ${cause.slice(0, 300)}`,
      );
    }
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
      stopIfInterrupted();
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
      stopIfInterrupted();
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
    stopIfInterrupted();
    let serverLog = "";
    const server = groups.spawn("backend", backend.binary, [], {
      env: {
        ...process.env,
        ATLAS_DATABASE_URL: database,
        ATLAS_BIND: `127.0.0.1:${backendPort}`,
        ATLAS_PUBLIC_ORIGIN: origin,
        ATLAS_SECRET_KEY: randomBytes(32).toString("hex"),
        ATLAS_OUTBOUND_ALLOW_ORIGINS: calendar?.origin ?? "",
        ...(oidc
          ? {
              ATLAS_OIDC_ISSUER: oidc.issuer,
              ATLAS_OIDC_CLIENT_ID: oidc.clientId,
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.once("error", (e) => (serverLog += `\nspawn: ${e.message}`));
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
  stopIfInterrupted();
  proxy = createProxy({
    upstream: `http://127.0.0.1:${backendPort}`,
    port: proxyPort,
    controlPort,
    observe: (exchange) => exchanges.push(exchange),
  });
  const urls = await proxy.start();
  stopIfInterrupted();
  const preview = groups.spawn(
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
  let previewError = null;
  preview.once("error", (e) => (previewError = e));
  await waitFor(`${origin}/`, "preview");
  if (previewError) throw previewError;
  stopIfInterrupted();

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
    ...(calendar === null ? {} : { ATLAS_INTEGRATION_FEED: calendar.origin }),
    ATLAS_E2E_BROWSERS: browser === "chromium" ? "" : "all",
    ATLAS_INTEGRATION_STATE_DIR: state,
    // The browser artefacts (traces, test-results) of this invocation stay with its evidence, in a fresh run directory each time.
    ATLAS_EVIDENCE_DIR: join(evidence, "browser-evidence"),
  };
  if (serve) {
    console.error(
      `serving: preview ${origin}  proxy control ${urls.controlUrl}  backend ${env.ATLAS_INTEGRATION_BACKEND}  (owned ports: ${ports.join(", ")})`,
    );
    writeFileSync(join(tmp, "env.json"), JSON.stringify(env));
    // Until the first signal (already received counts), then back to the caller, which cleans up and exits.
    await cancelled;
    return { exitCode: null, signal: interrupted, exchanges };
  }

  // 5. The specs: one worker, no retry, stop at the first failure (R18); Playwright's group is owned like the services'.
  stopIfInterrupted();
  const run = groups.spawn(
    "playwright",
    process.execPath,
    [
      join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      `--project=integration-${browser}`,
      "--reporter=list,json",
      ...stackArgs(stack),
      ...stack.passthrough,
      ...PLAYWRIGHT_POLICY,
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
    { interruptWith: "SIGINT" },
  );
  return new Promise((resolveRun, rejectRun) => {
    run.once("error", (error) =>
      rejectRun(Object.assign(error, { phase: "spawn" })),
    );
    run.once("exit", (code, signal) =>
      resolveRun({ exitCode: code ?? 1, signal, exchanges }),
    );
  });
}

const layer = postgres
  ? "integration (PostgreSQL repeat): the session module and its production adapters in a real engine against the RELEASED backend CONTAINER IMAGE on a disposable PostgreSQL, behind the delaying proxy, for the specs selected by --grep only; NOT the WEB-08c lifecycle traces on a rendered cache, NOT real Safari or a real device, NOT assistive technology, NOT the unmodified Compose or Ingress arrangement"
  : "integration: the session module and its production adapters in a real engine against the RELEASED backend on a disposable SQLite database, behind the delaying proxy; NOT the WEB-08c lifecycle traces on a rendered cache, NOT real Safari or a real device, NOT assistive technology, NOT PostgreSQL";

/**
 * `--serve`: one stack, served until the first signal; nothing is run, judged or recorded. The signal (or a failure) ends the
 * wait, the stack is cleaned up here and the process exits: 130/143 after a signal, 1 after a failure.
 */
async function serveOnly() {
  mkdirSync(evidence, { recursive: true });
  let failed = null;
  try {
    await main(browsers[0], STACKS[0]);
  } catch (error) {
    if (!interrupted) failed = error;
  }
  if (failed) console.error(String(failed?.stack ?? failed));
  const { problems } = await cleanup();
  for (const problem of problems) console.error(`clean-up problem: ${problem}`);
  return interrupted ? exitFor(interrupted) : 1;
}

// One fresh stack per stack and engine: the specs that change an account (password, logout, retirement, device capacity) must not
// leave the next stack with accounts, sessions or a throttle they have used up.
const status = serve
  ? await serveOnly()
  : await runIntegration({
      options: {
        browsers,
        stacks: STACKS,
        manifest,
        partial,
        narrowed,
        evidence,
        env: process.env,
        postgres,
        layer,
      },
      deps: {
        list: playwrightLister({
          root,
          browsers,
          dir: join(evidence, "discovery"),
          env: process.env,
        }),
        execute: (stack, browser) => main(browser, stack),
        cleanup,
        readReport: (file) =>
          existsSync(file) ? readFileSync(file, "utf8") : null,
        exists: existsSync,
        // Created only if absent (`wx`): of two invocations given the same directory, one claims it.
        claim: (file, text) => {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, text, { flag: "wx" });
        },
        // A reader never sees a half-written record: written beside it, then renamed over it.
        write: (file, text) => {
          mkdirSync(dirname(file), { recursive: true });
          const partialFile = `${file}.partial`;
          writeFileSync(partialFile, text);
          renameSync(partialFile, file);
        },
        now: () => Date.now(),
        log: (message) => console.error(message),
        interrupted: () => interrupted,
        backend: () => lastBackend,
      },
    });
// No owned process group may outlive the invocation (a stack's clean-up already checked its own; this covers an early exit).
const { problems: left } = await groups.stopAll();
// Nor a docker command (a clean-up waits for its own; this covers a stack that ended while one was still settling).
const dockerLeft = await dockerCommands.settle();
if (dockerLeft.length > 0)
  left.push(`docker command(s) still running: ${dockerLeft.join(", ")}`);
await releaseReaper();
if (reaperProblem) left.push(reaperProblem);
for (const problem of left) console.error(`clean-up problem: ${problem}`);
process.exit(left.length > 0 && status === 0 ? 1 : status);
