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
// Loopback listeners on OS-chosen free ports only. Disposable state under a fresh directory in $TMPDIR. It touches no existing
// service and no real user data.
//
// Ownership (review r6, H4). Each stack has one resource scope (scripts/integration/scope.mjs): the disposal of every resource is
// registered before the resource is created, preparation runs as a tracked producer, and the stack's clean-up first stops and waits
// for that producer, so a signal that arrives part-way through starting PostgreSQL, a listener or the backend cannot be followed by
// a resource nobody disposes of. Every process is spawned with an inherited ownership mark and stopped with everything that carries
// it (scripts/integration/ownership.mjs), every Docker resource is labelled and found again by label
// (scripts/integration/docker-resources.mjs), and the clean-up is ok only when an independent look finds nothing left: no owned
// process, no listener, no labelled container, network or volume, no disposable directory, images as the policy says. Every
// preparation command is an owned, bounded process that ends on a stop. A REAPER process (scripts/integration/reaper.mjs), started
// first in a process group of its own, holds a journal of what the run owns and finishes the clean-up and the summary if the runner
// itself is killed before it could (the shared validation driver kills the runner's group two seconds after asking it to stop).
// Qualification boundaries: scripts/integration/faults.mjs (inactive unless ATLAS_INTEGRATION_FAULTS is set).
//
// Review r9 H4e (revision 10): every commit of a stack's facts is an observation with an ordinal of its own, whether or not its write
// succeeds, and each one carries every earlier observation of the stack (stack-records.mjs `commitObservation`); run-level evidence
// failures are journalled as they happen. The run has ONE terminal procedure (`finish`): once it begins, no partial summary is written;
// it settles the current stack, then joins the run's own work (the schedule) before it publishes the terminal summary and releases the
// reaper last. Work it cannot join within its bound is not declared finished: the journal ends WITHOUT a release and the reaper,
// after this process has gone, reconciles every record, checkpoint and summary.
//
// Review r10 H4f (revision 11): every file the reaper may read as evidence is published whole: invocation.json and plan.json exclusively
// and atomically, summary-error.json atomically. The parent folder's copy of the final summary is written separately from the run's
// own summary; a failure to write it (other than "it already exists") is an evidence failure found AFTER the summary was published, so
// the summary is concluded and published once more with it (never a pass); only when that cannot be published either is
// summary-error.json written and the reaper left to reconcile.
import { spawn } from "node:child_process";
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
import {
  DOCKER_CONTEXT,
  disposeLabelled,
  dockerClient,
  LABEL_INVOCATION,
  LABEL_STACK,
} from "./docker-resources.mjs";
import { createFaults } from "./faults.mjs";
import { freePort } from "./free-port.mjs";
import { createOidcProvider } from "./oidc-provider.mjs";
import {
  cleanupFailed,
  describe,
  judge,
  overall,
  project,
  schedule,
  settleStack,
  withCancellation,
} from "./outcome.mjs";
import { Cancelled, createOwner } from "./ownership.mjs";
import { startPostgresBackend } from "./postgres-backend.mjs";
import { createScope } from "./scope.mjs";
import {
  commitObservation,
  createStackStore,
  joinVersions,
  publishAtomically,
  publishExclusively,
} from "./stack-records.mjs";
import { plan, selectStacks, stackArgs } from "./stacks.mjs";

// This runner's own modules (the reaper, the backend fetch) are beside it; the repository it tests (Playwright, the specs, the
// fixture build) is two levels up, unless a qualification run of a COPY of these scripts names it (ATLAS_INTEGRATION_TOOLS_ROOT).
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(
  process.env.ATLAS_INTEGRATION_TOOLS_ROOT ?? resolve(here, "../.."),
);
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

const faults = createFaults({ dir: runDir });
// Review r8 H4d (revision 9): each stack's durable record, the authority every finaliser recovers from (stack-records.mjs).
const stackStore = createStackStore(runDir, {
  fail: (phase) => faults.write(`stack:${phase}`),
});
let released = false;
let reaperLost = null;
// The whole run's stop (a signal, a lost reaper): what ends a qualification hold placed after a stack's scope has closed.
const runStop = new AbortController();
let reaper = null;
/** One line of the reaper's journal (what this run owns). A journal that cannot be written is a lost reaper. */
function journal(message) {
  if (!reaper || released) return;
  // Qualification (revision 11): a journal message that never reaches the reaper (the pipe is not acknowledged; a runner killed
  // before it is flushed loses it). Inactive unless ATLAS_INTEGRATION_FAULTS names its type in `lose_journal`.
  if (faults.loseJournal(message.type)) return;
  try {
    reaper.stdin.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    loseReaper(
      `the reaper's journal could not be written: ${error?.message ?? error}`,
    );
  }
}
const owner = createOwner({
  onMember: ({ pid, started, label }) =>
    journal({ type: "process", pid, started, label }),
});
let current = null; // the stack being prepared, run or cleaned up
/**
 * Review r7 H4c; review r8 H4d (revision 9): what a stack has established is COMMITTED before anything can lose it. Its durable record
 * (stack-records.mjs, the authority) is published first, merged with what was committed before; then it is kept on the stack's state
 * (the runner's own finaliser) and announced to the reaper with its sequence number (the journal is a notification, and a copy of
 * the facts for a record that could not be written). A record that cannot be written stops the run, nothing more is launched, and
 * the stack keeps that as an evidence failure; the reaper then keeps the journalled facts. Returns the committed record.
 *
 * Review r9 H4e (revision 10): each call is an observation (`obs`, increasing across the run whether or not the write succeeds). The
 * stack's overlay (`state.judged`: everything observed, committed or not) is merged into what the caller establishes, so a caller
 * holding an older copy (the stack's own end after the finaliser settled it) cannot drop a fact, and a later successful write carries
 * an earlier failed one.
 */
function commitStack(state, record, phase) {
  observed += 1;
  const full = {
    browser: state.browser,
    stack: state.stack.suffix || "base",
    index: state.index,
    ...record,
  };
  const result = commitObservation({
    store: stackStore,
    known: state.judged,
    record: full,
    phase,
    obs: observed,
    describe: (error) =>
      `the record of integration-${state.browser} ${full.stack} could not be committed (${phase}): ${String(error?.message ?? error)}`,
  });
  if (!result.committed) {
    runError(result.reason);
    if (!owner.latched) console.error(`\nSTOPPING: ${result.reason}`);
    owner.stop(result.reason);
  }
  state.judged = result.record;
  const { error: _stack, admissions: _admissions, ...facts } = result.record;
  journal({
    type: "judged",
    browser: state.browser,
    index: state.index,
    seq: result.record.seq,
    obs: result.record.obs,
    phase: result.record.phase,
    record: facts,
  });
  return result.record;
}
/** A stack's record in `records`, joined with any version already there (by observation): one record per stack, facts kept. */
function putRecord(record) {
  const at = records.findIndex(
    (r) => r.browser === record.browser && r.index === record.index,
  );
  if (at < 0) records.push(record);
  else records[at] = joinVersions(records[at], record);
}
/** Review r9 H4e: a run-level evidence failure, kept once and journalled at once (the reaper keeps it if this process is lost). */
function runError(reason) {
  if (evidenceErrors.includes(reason)) return;
  evidenceErrors.push(reason);
  journal({ type: "run-error", reason });
}
let lastBackend = null;
let signalled = null;
let planning = null; // the discovery's abort controller while the run is being planned
const records = [];
const evidenceErrors = [];
// Review r9 H4e: the run's observations so far (every stack commit attempt), every stack launched (its overlay), the schedule (the
// run's own work, joined before the terminal summary) and whether the terminal procedure has begun (no partial summary after it).
let observed = 0;
const launched = [];
let running = null;
let terminal = false;

function loseReaper(reason) {
  if (reaperLost || released) return;
  reaperLost = reason;
  runStop.abort(new Cancelled(reason));
  console.error(`\nSTOPPING: ${reason}; nothing more is launched`);
  owner.stop(reason);
  planning?.abort(new Cancelled(reason));
  current?.scope.stop(reason);
}

// The reaper first, before anything that could need cleaning up: in a group of its own (a group signal to this runner does not
// reach it), with this runner's stdout/stderr (a caller waiting for them waits for its clean-up too).
reaper = spawn(
  process.execPath,
  [join(here, "reaper.mjs"), runDir, owner.token, String(process.pid)],
  { detached: true, stdio: ["pipe", "inherit", "inherit"] },
);
reaper.stdin.on("error", (error) =>
  loseReaper(`the reaper's journal failed: ${error?.message ?? error}`),
);
reaper.once("error", (error) =>
  loseReaper(`the reaper could not start: ${error?.message ?? error}`),
);
reaper.once("exit", (code, signal) =>
  loseReaper(
    `the reaper exited (${signal ?? code}) before the run released it`,
  ),
);
if (reaper.pid) owner.exclude(reaper.pid);
journal({ type: "hello", invocation: invocation.id, evidence });
// Who this run is, from its first moment (a run killed before its first summary is still identifiable by its mark).
publishExclusively(
  join(runDir, "invocation.json"),
  `${JSON.stringify({ ...invocation, run_dir: runDir, owner_token: owner.token, reaper_pid: reaper.pid ?? null }, null, 2)}\n`,
);

const docker = dockerClient((args, options = {}) => {
  const injected = faults.docker(args);
  if (injected) return Promise.resolve(injected);
  return owner.exec("docker", "docker", args, {
    ...options,
    env: { ...process.env, DOCKER_CONTEXT },
  });
});

const listening = (port) =>
  new Promise((resolveCheck) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveCheck(true);
    });
    socket.once("error", () => resolveCheck(false));
  });

async function waitFor(url, label, tries, signal) {
  for (let i = 0; i < tries; i += 1) {
    if (signal.aborted)
      throw new Cancelled(String(signal.reason?.reason ?? "aborted"));
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (response.ok || response.status < 500) return;
    } catch {
      // not yet (or stopped: looked at above)
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
 * Stop everything one stack owns, once (a signal and the stack's own end share the same promise): the scope stops admission, waits
 * for preparation to settle and disposes of what was registered, last first (Playwright, the preview, the proxy, the backend or the
 * containers, the provider, the disposable directory). Then an independent look: no process carrying the run's mark, no listener on
 * the stack's ports, the directory gone; the containers' own disposal verified its labelled inventory. Returns what happened.
 */
function cleanupStack(state, why = "the stack ended") {
  state.cleanup ??= (async () => {
    const closed = await state.scope.close(why);
    const result = {
      reason: closed.reason,
      ports: state.ports,
      tmp: state.tmp,
      producers_settled: closed.producers_settled,
      unsettled_producers: closed.unsettled_producers,
      steps: closed.steps,
      late: closed.late,
      errors: closed.steps
        .filter((step) => !step.ok)
        .map((step) => `${step.label}: ${step.error ?? "not verified"}`),
    };
    let survivors = [];
    result.process_inventory = "complete";
    try {
      survivors = owner.sweep();
    } catch (error) {
      result.process_inventory = "unknown";
      result.errors.push(`processes: ${String(error?.message ?? error)}`);
    }
    result.survivors = survivors;
    const still = [];
    for (const port of state.ports) if (await listening(port)) still.push(port);
    result.listeners_left = still;
    result.tmp_removed = state.tmp ? !existsSync(state.tmp) : true;
    result.ok =
      closed.ok &&
      result.errors.length === 0 &&
      result.process_inventory === "complete" &&
      survivors.length === 0 &&
      still.length === 0 &&
      result.tmp_removed;
    if (!closed.producers_settled)
      console.error(
        `WARNING: preparation did not settle (${closed.unsettled_producers.join(", ")})`,
      );
    for (const error of result.errors)
      console.error(`WARNING: clean-up: ${error}`);
    if (still.length > 0)
      console.error(
        `WARNING: a listener remains on port(s) ${still.join(", ")}`,
      );
    if (survivors.length > 0)
      console.error(
        `WARNING: owned process(es) survived clean-up: ${survivors.join(", ")}`,
      );
    if (result.ok)
      console.error(
        `clean-up verified: no owned process, no listener on ${state.ports.join(", ") || "(none)"}${state.tmp ? `, ${state.tmp} removed` : ""}`,
      );
    return result;
  })();
  return state.cleanup;
}

const removeTmp = (path) => {
  rmSync(path, { recursive: true, force: true });
  return { ok: !existsSync(path), path };
};

/**
 * Start one stack: accounts, invitations, the backend (or the PostgreSQL container pair), the proxy and the preview. Runs as the
 * stack scope's producer: each resource's disposal is registered before the resource is created, every wait ends on `signal`.
 */
async function prepare(state, signal) {
  const { stack, scope } = state;
  const at = (name) => faults.at(name, signal);
  await at("prepare:start");
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
  scope.defer("tmp", () => removeTmp(state.tmp));
  journal({ type: "tmp", path: state.tmp });
  const [backendPort, previewPort, proxyPort, controlPort] = [
    await freePort(),
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  state.ports.push(backendPort, previewPort, proxyPort, controlPort);
  journal({ type: "ports", ports: state.ports });
  const origin = `http://127.0.0.1:${previewPort}`;
  // alice and bob for the read-only and sign-in specs; carol, dave and erin for the specs that change an account (password,
  // logout, retirement), so no spec depends on another spec's side effects. Passwords are generated per run and travel by stdin
  // and the environment only.
  const accounts = {};
  let revision;
  let oidc = null;
  if (stack.oidc && !postgres) {
    // The stub provider, on loopback, before the backend: the backend discovers it at the first single-sign-on request.
    const provider = createOidcProvider({
      clientId: "atlas-web-integration",
      callbackUrl: `${origin}/api/experimental/v1/oidc/callback`,
    });
    state.provider = provider;
    scope.defer("provider", () => provider.stop());
    oidc = await provider.start();
    state.ports.push(oidc.issuerPort, oidc.controlPort);
    journal({ type: "ports", ports: state.ports });
    await at("oidc:started");
  }

  if (postgres) {
    // OPTIONAL repeat: the released backend CONTAINER image against a disposable PostgreSQL (docs/session.md, "Integration").
    // Everything it creates carries the stack's labels; its disposal (by label, verified) is registered before the first docker call.
    journal({ type: "docker" });
    scope.defer("containers", () =>
      disposeLabelled(docker, { filter: `${LABEL_STACK}=${state.id}` }),
    );
    state.backendStartedAt = Date.now();
    const started = await startPostgresBackend({
      backendPort,
      origin,
      names,
      docker,
      labels: { [LABEL_INVOCATION]: invocation.id, [LABEL_STACK]: state.id },
      signal,
      at,
      log: (line) => console.error(line),
    });
    Object.assign(accounts, started.accounts);
    revision = started.describe;
    lastBackend = started.describe;
    console.error(
      `backend container ${started.describe.backend_image} on ${started.describe.postgres_image}`,
    );
    await waitFor(
      `http://127.0.0.1:${backendPort}/ready`,
      "backend container",
      240,
      signal,
    );
  } else {
    // 1. The released backend, verified against the release's SHA256SUMS.
    const fetched = await owner.exec(
      "fetch-backend",
      process.execPath,
      [join(here, "fetch-backend.mjs")],
      { signal, timeoutMs: 600_000 },
    );
    if (fetched.status !== 0)
      throw new Error(
        `fetch-backend failed (${fetched.timedOut ? "timed out" : `exit ${fetched.status}`}):\n${fetched.stdout}${fetched.stderr}`,
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
    await at("sqlite:fetched");
    const database = `sqlite://${join(state.tmp, "atlas.sqlite")}?mode=rwc`;

    // 2. Accounts, made with the backend's own command.
    for (const name of names) {
      const password = randomBytes(16).toString("hex");
      const made = await owner.exec(
        "account",
        backend.binary,
        ["account", name],
        {
          input: `${password}\n`,
          env: { ...process.env, ATLAS_DATABASE_URL: database },
          signal,
          timeoutMs: 60_000,
        },
      );
      if (made.status !== 0)
        throw new Error(
          `could not create ${name}:\n${made.stdout}${made.stderr}`,
        );
      accounts[name] = { username: name, password };
    }

    // 2b. Standalone signup invitations, made with the backend's own command (the token is printed once).
    for (let i = 0; i < 19; i += 1) {
      const made = await owner.exec("invite", backend.binary, ["invite"], {
        env: { ...process.env, ATLAS_DATABASE_URL: database },
        signal,
        timeoutMs: 60_000,
      });
      if (made.status !== 0)
        throw new Error(
          `could not create an invitation:\n${made.stdout}${made.stderr}`,
        );
      invitations.push(JSON.parse(made.stdout.trim().split("\n").at(-1)));
    }
    await at("sqlite:accounts");

    // 3. The backend. Its sign-in budget's clock starts with the process.
    scope.check();
    state.backendStartedAt = Date.now();
    const handle = owner.spawnOwned("backend", backend.binary, [], {
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
    state.handles.backend = handle;
    scope.defer("backend", () => owner.terminate(handle));
    const serverLog = capture(handle);
    await at("backend:spawned");
    await waitFor(
      `http://127.0.0.1:${backendPort}/ready`,
      "backend",
      80,
      signal,
    ).catch((e) => {
      if (e instanceof Cancelled) throw e;
      throw new Error(`${e.message}\n${serverLog().slice(-2000)}`);
    });
  }
  if (faults.stubbornChild) {
    // Qualification only: a child whose shutdown is held (it ignores SIGTERM), so stopping the stack takes longer than a caller waits.
    scope.check();
    const stubborn = owner.spawnOwned(
      "stubborn",
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      // "detached": in a process group of its own, as Playwright starts browsers (a caller's group signal does not reach it).
      { stdio: "ignore", detached: faults.spec.stubborn_child === "detached" },
    );
    scope.defer("stubborn", () => owner.terminate(stubborn));
  }

  // 4. The delaying proxy (it accounts for the stack's sign-in traffic), then the preview server whose backend is the proxy.
  const proxy = createProxy({
    upstream: `http://127.0.0.1:${backendPort}`,
    port: proxyPort,
    controlPort,
    observe: state.admissions.observe,
  });
  state.proxy = proxy;
  scope.defer("proxy", () => proxy.stop());
  const urls = await proxy.start();
  await at("proxy:started");
  scope.check();
  const preview = owner.spawnOwned(
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
  state.handles.preview = preview;
  scope.defer("preview", () => owner.terminate(preview));
  capture(preview);
  await at("preview:spawned");
  await waitFor(`${origin}/`, "preview", 80, signal);
  await at("preview:ready");

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
  id: `${invocation.id}-${index}-${browser}`,
  browser,
  stack,
  index,
  tmp: "",
  ports: [],
  handles: {},
  proxy: null,
  provider: null,
  admissions: createAdmissionRecorder(),
  scope: createScope(`${browser}${stack.suffix || ""}`, {
    settleMs: faults.spec.settle_ms ?? 90_000,
  }),
  cleanup: null,
});

/** One stack, start to end. Never throws: whatever happens becomes the stack's record, with its clean-up. */
async function launch(browser, stack, index, expected) {
  const state = newState(browser, stack, index);
  current = state;
  launched.push(state);
  journal({ type: "stack", browser, index, stack: stack.suffix || "base" });
  const label = `${browser}${stack.suffix}`;
  const reportPath = join(runDir, `results-${label}.json`);
  commitStack(
    state,
    {
      outcome: "running",
      reason: null,
      expected: expected.length,
      report: reportPath,
      started_at: new Date().toISOString(),
    },
    "started",
  );
  let record;
  try {
    const env = await state.scope.run("prepare", (signal) =>
      prepare(state, signal),
    );
    state.scope.check();
    if (existsSync(reportPath))
      throw new Error(`refusing to reuse an existing report: ${reportPath}`);
    const launchedAt = Date.now();
    // The launch time and report path are durable before Playwright runs: a reaper can judge the raw report against them.
    commitStack(
      state,
      { outcome: "running", launched_at: launchedAt },
      "launched",
    );
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
    // Playwright is asked to stop as on Ctrl-C first (it ends its workers and browsers and writes the report of what ran).
    state.scope.defer("playwright", () =>
      owner.terminate(handle, undefined, { signal: "SIGINT", ms: 10_000 }),
    );
    // Membership is by mark; this only remembers members whose environment `ps` cannot read (WebKit's launcher shell).
    const watch = setInterval(() => owner.snapshot(handle), 2000);
    await faults
      .at("playwright:spawned", state.scope.signal)
      .catch(() => undefined);
    const exit = await handle.closed;
    // Review r7 H4c: whether a stop came before Playwright ended decides who caused an incomplete report.
    const stopAtExit = owner.latched;
    clearInterval(watch);
    let report = null;
    let readError = null;
    try {
      report = faults.report(JSON.parse(readFileSync(reportPath, "utf8")));
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
        stop: stopAtExit ?? null,
      }),
      report: reportPath,
    };
  } catch (error) {
    const reason = String(error?.message ?? error);
    record = {
      outcome: error instanceof Cancelled ? "cancelled" : "error",
      reason,
      error: String(error?.stack ?? error),
      expected: expected.length,
      // Review r7 H4c: an error raised before any stop is a failure of its own; one raised after a stop may be the stop's doing.
      ...(error instanceof Cancelled || owner.latched
        ? {}
        : { failure: { kind: "preparation_error", reason } }),
    };
  }
  // A stop (a signal, a lost reaper) keeps what the stack had established: a recorded failure stays a failure.
  record = commitStack(
    state,
    withCancellation(record, owner.latched),
    "judged",
  );
  // Evidence of the stack's sign-in traffic. Its failure is committed at once (review r8 H4d); it never skips the clean-up below.
  try {
    const requests = state.admissions.requests();
    const admissions = faults.admissions(
      audit(requests, { backendStartedAt: state.backendStartedAt }),
    );
    record = commitStack(state, settleStack(record, { admissions }), "judged");
    faults.write("admissions");
    writeFileSync(
      join(runDir, `admissions-${label}.json`),
      `${JSON.stringify({ summary: admissions, backend_started_at: state.backendStartedAt ?? null, requests }, null, 2)}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    const reason = `admissions: ${String(error?.message ?? error)}`;
    runError(`${label}: ${reason}`);
    record = commitStack(
      state,
      settleStack(record, { evidenceErrors: [reason] }),
      "judged",
    );
  }
  await faults.at("stack:judged", state.scope.signal).catch(() => undefined);
  let cleanup;
  try {
    cleanup = await cleanupStack(state);
  } catch (error) {
    cleanup = { ok: false, errors: [String(error?.stack ?? error)] };
  }
  // Qualification boundary (revision 10): the stack's clean-up has ended; its own end has not committed the settled record.
  await faults.at("stack:cleaned", runStop.signal).catch(() => undefined);
  // The one reducer (shared with the finaliser and the reaper): the stop and clean-up are added to what was established, and the
  // complete record is committed BEFORE the reaper is told the stack ended (with the committed sequence: it retires only that).
  record = commitStack(
    state,
    settleStack(record, { stop: owner.latched, cleanup }),
    "settled",
  );
  await faults.at("stack:settled", runStop.signal).catch(() => undefined);
  if (record.seq !== null)
    journal({ type: "stack-end", browser, index, seq: record.seq });
  await faults.at("stack:ended", runStop.signal).catch(() => undefined);
  current = null;
  return record;
}

const layer = postgres
  ? "integration (PostgreSQL repeat): the session module and its production adapters in a real engine against the RELEASED backend CONTAINER IMAGE on a disposable PostgreSQL, behind the delaying proxy, for the specs selected by --grep only; NOT the WEB-08c lifecycle traces on a rendered cache, NOT real Safari or a real device, NOT assistive technology, NOT the unmodified Compose or Ingress arrangement"
  : "integration: the session module and its production adapters in a real engine against the RELEASED backend on a disposable SQLite database, behind the delaying proxy; NOT the WEB-08c lifecycle traces on a rendered cache, NOT real Safari or a real device, NOT assistive technology, NOT PostgreSQL";

let planned = null;
function summarise(final, extra = {}) {
  const { first_failure, engines } = project(records, {
    browsers,
    planned: planned?.stacks.length,
  });
  return {
    schema: 3,
    layer,
    invocation: {
      ...invocation,
      run_dir: runDir,
      owner_token: owner.token,
      finished: final,
    },
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
    first_failure,
    signal: signalled,
    reaper: { pid: reaper?.pid ?? null, lost: reaperLost },
    faults: faults.active
      ? { spec: faults.spec, reached: faults.reached }
      : null,
    evidence_errors: evidenceErrors,
    stacks: records,
    engines,
    backend: lastBackend,
    ...extra,
  };
}

function writeSummary(final, extra) {
  const text = `${JSON.stringify(summarise(final, extra), null, 2)}\n`;
  // Review r8 H4d (revision 9): replaced atomically: a reader sees the previous complete summary or this one, never a part.
  publishAtomically(join(runDir, "summary.json"), text, {
    fail: () => {
      faults.write("summary");
      if (final) faults.write("summary-final");
    },
  });
  return text;
}
/**
 * Review r10 H4f (revision 11): the parent folder's copy of the final summary (a convenience: the first run's is kept there). Null when
 * it was written or already exists; otherwise the evidence failure.
 */
function copySummary(text) {
  try {
    faults.write("summary-copy");
    writeFileSync(join(evidence, "summary.json"), text, { flag: "wx" });
    return null;
  } catch (error) {
    if (error?.code !== "EEXIST")
      return `the parent summary.json copy could not be written: ${String(error?.message ?? error)}`;
    console.error(
      `${join(evidence, "summary.json")} already exists and is left as it is; this run's summary is ${join(runDir, "summary.json")}`,
    );
    return null;
  }
}

let finishing = null;
// Review r9 H4e: how long the terminal procedure waits for the run's own work (the schedule finishing its current stack) to end.
const JOIN_MS = faults.spec.join_ms ?? 15_000;
/** Has `work` ended within JOIN_MS? (No work: nothing to join.) */
async function joined(work) {
  if (!work) return true;
  let timer;
  const ended = await Promise.race([
    work.then(
      () => true,
      () => true,
    ),
    new Promise((resolveJoin) => {
      timer = setTimeout(() => resolveJoin(false), JOIN_MS);
    }),
  ]);
  clearTimeout(timer);
  return ended;
}
/**
 * The one way out, unconditional: clean up whatever stack is current, account for every planned stack, write the final summary (a
 * summary that cannot be written is recorded beside it, the clean-up already happened), release the reaper, exit. The first caller
 * decides the code; a failure, a clean-up that was not verified or an evidence error never exits 0.
 *
 * Review r9 H4e (revision 10): the ONE terminal procedure. From its first moment no partial summary is written (`terminal`). It settles
 * the current stack (the same reducer, through the same overlay, as the stack's own end), then joins the run's own work (the schedule,
 * which may still be ending that stack) within JOIN_MS, and only then concludes from every committed record and every stack's overlay,
 * publishes the terminal summary (`terminal`: whether the run was quiescent, and the observations it covers) and releases the reaper
 * LAST. Work it could not join is not declared finished: the journal ends WITHOUT a release and the reaper reconciles every record,
 * checkpoint and summary once this process has gone (which ends that work too).
 */
function finish(code, extra = {}) {
  finishing ??= (async () => {
    terminal = true;
    if (current) {
      const state = current;
      let cleaned;
      try {
        cleaned = await cleanupStack(
          state,
          owner.latched ?? "the run is finishing",
        );
      } catch (error) {
        cleaned = { ok: false, errors: [String(error?.stack ?? error)] };
      }
      // The same reducer and the same committed record as the stack's own end (review r8 H4d): what the stack had committed is
      // kept and merged with whatever its own end commits too; without anything, the stop caused what is known.
      const stop = owner.latched ?? "interrupted";
      putRecord(
        commitStack(
          state,
          settleStack(
            state.judged ?? {
              outcome: "cancelled",
              reason: `stopped: ${stop}`,
            },
            { stop, cleanup: cleaned },
          ),
          "settled",
        ),
      );
    }
    // Qualification boundary (revision 10): the finaliser has settled the current stack; the run's work has not been joined.
    await faults.at("finish:settled", runStop.signal).catch(() => undefined);
    const quiescent = await joined(running);
    // Every planned stack has a record, even when the fallback finaliser ends a run whose schedule never got there.
    if (planned)
      for (const browser of browsers)
        for (const [index, { stack }] of planned.stacks.entries())
          if (
            !records.some((r) => r.browser === browser && r.index === index)
          ) {
            const first = records.find(
              (r) => r.outcome !== "passed" && r.outcome !== "not_run",
            );
            records.push({
              browser,
              stack: stack.suffix || "base",
              index,
              outcome: "not_run",
              reason: `not launched: ${first ? describe(first) : (owner.latched ?? "the run ended first")}`,
            });
          }
    // Review r8 H4d (revision 9): the summary is a projection of the committed stack records. Review r9 H4e (revision 10): and of every
    // stack's overlay (a fact whose write failed is in no committed record), joined by observation.
    const conclude = () => {
      for (const state of launched) if (state.judged) putRecord(state.judged);
      for (const r of [...records]) {
        let latest = null;
        try {
          // Every stack entry (an overlay whose first write failed has no `key`); a stack never launched has no file.
          latest = stackStore.latest(r.browser, r.index);
        } catch (error) {
          runError(String(error?.message ?? error));
        }
        if (latest) putRecord(latest);
      }
      // Review r10 H4f (revision 11): an earlier unverified clean-up of a stack counts even after a later one succeeded.
      const cleanupNotVerified = records.some(cleanupFailed);
      const outcome =
        extra.outcome === "plan_error"
          ? "plan_error"
          : planned === null && !signalled && !reaperLost
            ? (extra.outcome ?? "failed")
            : overall(records, {
                signalled: signalled ?? reaperLost,
                planned: browsers.length * (planned?.stacks.length ?? 0),
                failures: evidenceErrors,
              });
      return { cleanupFailed: cleanupNotVerified, outcome };
    };
    const publish = async () => {
      const frontier = observed;
      let { cleanupFailed, outcome } = conclude();
      if (serve) return { cleanupFailed, written: true, frontier };
      const terminalSummary = () => ({
        ...extra,
        outcome,
        cleanup_failed: cleanupFailed,
        terminal: { quiescent, observations: frontier },
      });
      try {
        const text = writeSummary(true, terminalSummary());
        // Review r10 H4f (revision 11): a copy that cannot be written is found after the summary was published: concluded again with
        // it (an evidence failure: never a pass) and published once more.
        const copyFailure = copySummary(text);
        if (copyFailure !== null) {
          runError(copyFailure);
          console.error(`ERROR: ${copyFailure}`);
          ({ cleanupFailed, outcome } = conclude());
          writeSummary(true, terminalSummary());
        }
        return { cleanupFailed, written: true, frontier };
      } catch (error) {
        const reason = `summary: ${String(error?.message ?? error)}`;
        runError(reason);
        console.error(
          `ERROR: the summary could not be written: ${error?.message ?? error}`,
        );
        ({ cleanupFailed, outcome } = conclude());
        try {
          // Review r10 H4f (revision 11): published whole (the reaper reads one it cannot parse as a failure, never as absent).
          publishAtomically(
            join(runDir, "summary-error.json"),
            `${JSON.stringify({ error: String(error?.stack ?? error), outcome, cleanup_failed: cleanupFailed, evidence_errors: evidenceErrors, stacks: records }, null, 2)}\n`,
            { fail: () => faults.write("summary-error") },
          );
        } catch {
          // nothing more can be written; the journalled run error and the exit code still say it
        }
        // Qualification boundary (revision 11): the summary could not be published and summary-error.json was attempted; the journal
        // has not ended.
        await faults.at("finish:marker", runStop.signal).catch(() => undefined);
        return { cleanupFailed, written: false, frontier };
      }
    };
    let result = await publish();
    if (result.written && quiescent) {
      // Release the reaper last: the run's work has ended, so it has nothing to finish and waits for nothing more.
      released = true;
      try {
        reaper?.stdin.end(
          `${JSON.stringify({ type: "released", ok: !result.cleanupFailed })}\n`,
        );
      } catch {
        // already gone: recorded as lost
      }
      if (reaper?.exitCode === null && reaper.signalCode === null)
        await Promise.race([
          new Promise((r) => reaper.once("exit", r)),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      // Nothing can observe after the join. Should anything have, the terminal summary did not cover it: a failure, published again.
      if (observed !== result.frontier) {
        const reason = `${observed - result.frontier} stack observation(s) came after the terminal summary was published`;
        if (!evidenceErrors.includes(reason)) evidenceErrors.push(reason);
        result = await publish();
      }
    } else {
      // Review r8 H4d: a summary that could not be written is not "nothing left to finish"; review r9 H4e: nor is work that could not be
      // joined. The journal ends WITHOUT a release, so the reaper reconciles the summary with the committed records and its
      // checkpoints (or records why it could not) once this process is gone.
      if (!quiescent) {
        console.error(
          `ERROR: the run's own work did not end within ${JOIN_MS} ms of its terminal summary; the reaper reconciles its evidence`,
        );
        journal({
          type: "handover",
          reason: "the runner's own work could not be joined",
        });
      }
      released = true;
      try {
        reaper?.stdin.end();
      } catch {
        // already gone: recorded as lost
      }
    }
    const failedRun =
      result.cleanupFailed ||
      !result.written ||
      !quiescent ||
      evidenceErrors.length > 0 ||
      reaperLost !== null;
    process.exit(code === 0 && failedRun ? 1 : code);
  })();
  return finishing;
}

const signalCode = () =>
  signalled === "SIGINT" ? 130 : signalled ? 143 : null;

function onSignal(signal) {
  if (signalled) {
    console.error(`${signal} again: already stopping`);
    return;
  }
  signalled = signal;
  const reason = `received ${signal}`;
  runStop.abort(new Cancelled(reason));
  owner.stop(reason);
  planning?.abort(new Cancelled(reason));
  console.error(`\n${signal}: stopping; no further stack is launched`);
  // Stop the current stack now (its preparation is stopped and waited for, then Playwright first); the schedule then records it and
  // stops. Should the main flow not get there (a preparation step that does not look at the stop), finish on our own, bounded.
  if (current) void cleanupStack(current, reason);
  if (serve) {
    void finish(signalCode());
    return;
  }
  setTimeout(
    () => void finish(signalCode(), { fallback_finaliser: true }),
    faults.fallbackMs,
  ).unref();
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

if (!reaper.pid) {
  console.error("the reaper could not be started: nothing is run");
  await finish(1, { outcome: "error", error: reaperLost });
}

if (serve) {
  // `--serve` starts one stack and never returns: nothing is planned or run.
  const state = newState(browsers[0], selection.stacks[0], 0);
  current = state;
  try {
    const env = await state.scope.run("prepare", (signal) =>
      prepare(state, signal),
    );
    console.error(
      `serving: preview ${env.ATLAS_INTEGRATION_URL}  proxy control ${env.ATLAS_INTEGRATION_CONTROL}  backend ${env.ATLAS_INTEGRATION_BACKEND}`,
    );
    writeFileSync(join(state.tmp, "env.json"), JSON.stringify(env));
    await new Promise(() => undefined);
  } catch (error) {
    console.error(String(error?.stack ?? error));
    await finish(signalCode() ?? 1);
  }
}

try {
  planning = new AbortController();
  planned = await plan({
    root,
    browsers,
    selection,
    evidence: join(runDir, "discovery"),
    exec: owner.exec,
    signal: planning.signal,
  });
  planning = null;
} catch (error) {
  planned = null;
  console.error(String(error?.stack ?? error));
  if (error instanceof Cancelled) await finish(signalCode() ?? 1);
  await finish(1, { outcome: "plan_error", plan_error: String(error) });
}
publishExclusively(
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

running = schedule({
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
    putRecord(record);
    if (record.outcome !== "passed" && record.outcome !== "not_run")
      console.error(`\nSTOPPING: ${describe(record)}`);
    // Review r9 H4e: once the terminal procedure has begun, only it publishes (a partial summary would replace the terminal one).
    if (terminal) return;
    try {
      writeSummary(false);
    } catch (error) {
      // A run whose summary cannot be written launches nothing more (its evidence would not say what ran).
      const reason = `the summary could not be written: ${String(error?.message ?? error)}`;
      runError(reason);
      if (!owner.latched) console.error(`\nSTOPPING: ${reason}`);
      owner.stop(reason);
    }
  },
});
const result = await running;
await finish(signalCode() ?? (result.passed && !reaperLost ? 0 : 1));
