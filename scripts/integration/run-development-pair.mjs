#!/usr/bin/env node
// WEB-09c (R23-PAIR, Decision D of 29 October 2026): the maintained DEVELOPMENT-PAIR runner. It runs tests/pair/pair.development.spec.ts
// in real browser engines against EITHER
//   --backend development   the approved UNRELEASED backend (scripts/integration/pair-selection.mjs: manifest, executable, source,
//                           contract, fixture and types, every one hash-bound; any difference refuses the run), or
//   --backend released      the RELEASED-backend control (contract-pin.json's release, fetched and verified by the unchanged
//                           fetch-backend.mjs), which runs only the whole-revision cases (pair-matrix.mjs);
//   --backend diagnostic    revision 26 (R26-DIAG): the approved DIAGNOSTIC executable `atlas-sync-diagnostic` (pair-selection.mjs
//                           DIAGNOSTIC_SELECTION), for PAIR-P0 and the REAL expiry/pruning cases PAIR-X0/X2 only. Each case gets its OWN
//                           stack and fixture attempt (diagnostic-fixture.mjs): a staged, re-hashed copy launched with an allow-listed
//                           environment (no ATLAS_* variable), a previously nonexistent fixture directory under its own parent (never
//                           removed recursively), the stack's real preview origin, a loopback bind the executable chooses, its ready
//                           receipt verified against the files, accounts made by its `add_account` setup commands, the spec's private
//                           bridge (an owned Unix socket and a per-attempt secret), and the sequenced shutdown that removes the fixture.
//                           Each attempt's envelope and each X0/X2 proof are re-validated here (diagnostic-evidence.mjs). Independent
//                           review of this exact adapter must precede any such paired run (approval of 1 Nov 2026).
// on an owned disposable SQLite database, behind the PASSIVE tap (pair-tap.mjs) and the delaying proxy, with a fixture build made by this
// invocation from the current source and served by its own `vite preview`.
//
//   node scripts/integration/run-development-pair.mjs --backend development|released|diagnostic [--browsers chromium,firefox,webkit]
//       [--evidence <fresh dir>] [--grep <pattern>] [--check] [--diagnostic-dirty]
//
//   --check             verify the selection (development), the source state and the discovery against the explicit matrix, write the
//                       record and STOP: no build, no backend, no browser. The only mode the author runs before the recipe's
//                       independent review (Decision D: the exact recipe is reviewed before paired execution).
//   --grep              a narrowed, PARTIAL run: the summary says so and is never a complete matrix.
//   --diagnostic-dirty  run on a source tree with uncommitted or untracked files: the summary is labelled NOT EVIDENCE.
//
// It never changes package.json, the lockfile, contract-pin.json or the released runner's fetch/cache path; it never runs the developer's
// executable in place (the verified bytes are copied into the run's own directory and the copy is verified and launched). Ownership is the
// released runner's: every process leads its own group (process-groups.mjs), carries this invocation's mark (ownership.mjs) and is known to a
// reaper (reaper.mjs) that cleans up if this process dies; loopback listeners on OS-chosen ports only; all state under a fresh $TMPDIR
// directory, removed and checked at the end. One worker, no retry, stop at the first failure (stacks.mjs PLAYWRIGHT_POLICY). The first
// browser whose stack is not a complete pass stops the schedule; the rest are recorded as not run.
//
// Labels: development-pair results are UNRELEASED, UNACCEPTED diagnostic evidence. They are not released-backend integration, not
// production activation, not acceptance of WEB-09c, BE-Q23 or BE-B1, and not device evidence.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProxy } from "./delaying-proxy.mjs";
import {
  ATTEMPT_SCHEMA,
  attemptProblems,
  PROOF_VALIDATORS,
  readTranscript,
} from "./diagnostic-evidence.mjs";
import {
  childEnvironment,
  createControlServer,
  finishAttempt,
  launchAttempt,
  newAttemptId,
  RETENTION_SECONDS,
  removeParentIfEmpty,
} from "./diagnostic-fixture.mjs";
import { freePort } from "./free-port.mjs";
import { membersOf, processTable, stopMembers } from "./ownership.mjs";
import { CORRELATION_HEADER } from "./pair-attempts.mjs";
import { identityProblems, validateInterval } from "./pair-evidence.mjs";
import {
  accountNames,
  BROWSERS,
  CASES,
  diagnosticAccounts,
  diagnosticCases,
  discoveryProblems,
  judgeResults,
  UNSUPPORTED,
} from "./pair-matrix.mjs";
import {
  DIAGNOSTIC_SELECTION,
  PAIR_SELECTION,
  realDiagnosticDeps,
  realSelectionDeps,
  selectionIdentity,
  sha256Of,
  stageDiagnosticExecutable,
  stageExecutable,
  verifyDiagnosticSelection,
  verifySelection,
} from "./pair-selection.mjs";
import { createTap } from "./pair-tap.mjs";
import { ownedGroups } from "./process-groups.mjs";
import { PLAYWRIGHT_POLICY } from "./stacks.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const KNOWN = new Set([
  "--backend",
  "--browsers",
  "--evidence",
  "--grep",
  "--check",
  "--diagnostic-dirty",
]);
const valued = new Set(["--backend", "--browsers", "--evidence", "--grep"]);
for (let i = 0; i < args.length; i += 1) {
  if (!KNOWN.has(args[i])) {
    console.error(`REFUSED: unknown argument ${args[i]}`);
    process.exit(2);
  }
  if (valued.has(args[i])) i += 1;
}
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const backendKind = value("--backend", "");
if (!["development", "released", "diagnostic"].includes(backendKind)) {
  console.error(
    "REFUSED: --backend development|released|diagnostic is required (there is no default backend)",
  );
  process.exit(2);
}
const browsers = value("--browsers", BROWSERS.join(",")).split(",");
if (
  browsers.length === 0 ||
  !browsers.every((b) => BROWSERS.includes(b)) ||
  new Set(browsers).size !== browsers.length
) {
  console.error(
    `REFUSED: --browsers takes distinct names from ${BROWSERS.join(", ")}`,
  );
  process.exit(2);
}
const grep = value("--grep", "");
const checkOnly = args.includes("--check");
const dirty = args.includes("--diagnostic-dirty");
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
const evidence = resolve(
  root,
  value(
    "--evidence",
    `.agtx/evidence/WEB-09c/development-pair/${backendKind}-${runId}`,
  ),
);
if (existsSync(evidence) && readdirSync(evidence).length > 0) {
  console.error(
    `REFUSED: the evidence directory ${evidence} is not empty (every invocation gets a fresh one)`,
  );
  process.exit(2);
}
mkdirSync(evidence, { recursive: true });
const writeJson = (name, data) =>
  writeFileSync(join(evidence, name), `${JSON.stringify(data, null, 2)}\n`);
const run = (cmd, argv, options = {}) =>
  spawnSync(cmd, argv, { encoding: "utf8", ...options });
const log = (line) => console.error(`[pair] ${line}`);

// ---- 1. what is being run: the frontend source, the selection --------------------------------------------------------------------
const head = run("git", ["-C", root, "rev-parse", "HEAD"]).stdout.trim();
const status = run("git", ["-C", root, "status", "--porcelain"])
  .stdout.split("\n")
  .filter(Boolean);
const source = {
  head,
  uncommitted_or_untracked: status,
  diagnostic_dirty: dirty,
};
if (status.length > 0 && !dirty) {
  writeJson("refused.json", {
    reason: "the frontend source has uncommitted or untracked files",
    source,
  });
  console.error(
    `REFUSED: the frontend source is not committed (${status.length} entries); see ${evidence}/refused.json`,
  );
  process.exit(2);
}
let selection = null;
if (backendKind === "development") {
  selection = verifySelection(realSelectionDeps(run));
  writeJson("selection.json", selection);
  if (!selection.ok) {
    for (const problem of selection.problems)
      console.error(`REFUSED: ${problem}`);
    process.exit(2);
  }
  log(
    `selection verified: manifest ${PAIR_SELECTION.manifest.sha256.slice(0, 12)}…, backend ${PAIR_SELECTION.backend.head.slice(0, 12)}…`,
  );
}
const DIAGNOSTIC_IDENTITY = selectionIdentity(DIAGNOSTIC_SELECTION);
if (backendKind === "diagnostic") {
  selection = verifyDiagnosticSelection(realDiagnosticDeps(run));
  writeJson("selection.json", selection);
  if (!selection.ok) {
    for (const problem of selection.problems)
      console.error(`REFUSED: ${problem}`);
    process.exit(2);
  }
  log(
    `diagnostic selection verified: identity ${DIAGNOSTIC_IDENTITY.slice(0, 12)}…, executable ${DIAGNOSTIC_SELECTION.executable.sha256.slice(0, 12)}…, backend ${DIAGNOSTIC_SELECTION.backend.head.slice(0, 12)}…`,
  );
}
const pin = JSON.parse(readFileSync(join(root, "contract-pin.json"), "utf8"));

// ---- 2. discovery against the explicit matrix ------------------------------------------------------------------------------------
const listingFile = join(evidence, "discovery.json");
const listed = run(
  process.execPath,
  [
    join(root, "node_modules/@playwright/test/cli.js"),
    "test",
    "--list",
    "--reporter=json",
    ...browsers.map((b) => `--project=pair-${b}`),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ATLAS_PAIR: "1",
      ATLAS_E2E_BROWSERS: "all",
      ATLAS_EVIDENCE_DIR: join(evidence, "discovery-browser-evidence"),
      PLAYWRIGHT_JSON_OUTPUT_NAME: listingFile,
    },
  },
);
let discovery = [
  `playwright --list exited ${listed.status}: ${`${listed.stdout}${listed.stderr}`.slice(-400)}`,
];
if (listed.status === 0 && existsSync(listingFile))
  discovery = discoveryProblems(JSON.parse(readFileSync(listingFile, "utf8")), {
    browsers,
  });
writeJson("discovery-check.json", {
  browsers,
  cases: CASES.map((c) => c.id),
  problems: discovery,
});
if (discovery.length > 0) {
  for (const problem of discovery)
    console.error(`REFUSED (discovery): ${problem}`);
  process.exit(2);
}
log(
  `discovery: ${CASES.length} cases × ${browsers.length} engine(s), exactly the matrix`,
);
if (checkOnly) {
  writeJson("summary.json", {
    label:
      "CHECK ONLY: selection, source and discovery verified; nothing was built, started or run",
    backend: backendKind,
    source,
    browsers,
    ...(backendKind === "diagnostic"
      ? {
          diagnostic_attempts: browsers.flatMap((b) =>
            diagnosticCases().map((c) => ({
              browser: b,
              case: c,
              outcome: "unrun",
            })),
          ),
        }
      : {}),
    unsupported: UNSUPPORTED.map((u) => ({ ...u, outcome: "unrun" })),
  });
  log(`check complete; record in ${relative(root, evidence)}`);
  process.exit(0);
}

// ---- 3. ownership: reaper, mark, groups --------------------------------------------------------------------------------------------
const invocationId = randomUUID();
let reaperReleased = false;
const reaper = spawn(
  process.execPath,
  [
    join(root, "scripts/integration/reaper.mjs"),
    "--record",
    join(evidence, `reaper-${invocationId}.json`),
  ],
  {
    detached: true,
    stdio: ["pipe", "inherit", "inherit"],
  },
);
let reaperProblem = null;
reaper.once("error", (error) => {
  reaperProblem = `reaper: ${error.message}`;
});
reaper.once("exit", (code, signal) => {
  if (!reaperReleased)
    reaperProblem ??= `reaper ended early (exit ${code}, signal ${signal})`;
});
reaper.stdin.on("error", () => undefined);
reaper.unref();
const tellReaper = (message) => {
  if (reaper.stdin.writable) reaper.stdin.write(`${JSON.stringify(message)}\n`);
};
async function releaseReaper() {
  if (reaperReleased) return;
  reaperReleased = true;
  tellReaper({ type: "release" });
  reaper.stdin.end();
  if (reaper.exitCode === null && reaper.signalCode === null) {
    let timer;
    await Promise.race([
      new Promise((r) => reaper.once("exit", r)),
      new Promise((r) => {
        timer = setTimeout(r, 5_000);
      }),
    ]);
    clearTimeout(timer);
  }
}
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
    return null;
  }
};
const groups = ownedGroups({
  onSpawn: ({ pgid, label }) => {
    tellReaper({ type: "group", pgid });
    log(`owned process group ${pgid} (${label})`);
  },
});
let interrupted = null;
const onSignal = (signal) => {
  if (interrupted) return;
  interrupted = signal;
  log(`${signal}: stopping; nothing else starts`);
  // A running diagnostic attempt is told by EOF first (it stops and KEEPS its fixture); its group is then interrupted with the rest.
  try {
    stackState?.diagnostic?.child?.stdin?.end();
  } catch {
    // already closed
  }
  groups.interrupt();
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
const stopIfInterrupted = () => {
  if (interrupted) throw new Error(`interrupted by ${interrupted}`);
};
const listening = (port) =>
  new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    stopIfInterrupted();
    try {
      const response = await fetch(url);
      if (response.status < 500) return response;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

// ---- 4. the fixture build of THIS source, owned by the invocation ----------------------------------------------------------------
// The reaper removes only directories named `atlas-integration-*` (reaper.mjs): this one is, so a killed run's state is still removed.
const invocationTmp = mkdtempSync(
  join(process.env.TMPDIR ?? tmpdir(), "atlas-integration-pair-"),
);
tellReaper({ type: "dir", path: invocationTmp });
const build = join(invocationTmp, "dist-fixture");
const aggregate = (dir) => {
  const rows = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else rows.push([relative(dir, path), sha256Of(readFileSync(path))]);
    }
  };
  walk(dir);
  return {
    files: rows.length,
    sha256: sha256Of(Buffer.from(JSON.stringify(rows))),
  };
};

let stackState = null;
async function cleanupStack() {
  const problems = [];
  const stopped = await groups.stopAll();
  problems.push(...stopped.problems);
  for (const note of stopped.notes) log(`clean-up: ${note}`);
  if (stackState?.proxy)
    await stackState.proxy
      .stop()
      .catch((e) => problems.push(`proxy stop: ${e?.message ?? e}`));
  if (stackState?.tap)
    await stackState.tap
      .stop()
      .catch((e) => problems.push(`tap stop: ${e?.message ?? e}`));
  const escaped = marked();
  if (escaped === null) problems.push("the process table could not be read");
  else if (escaped.size > 0) {
    const swept = await stopMembers({ scan: marked });
    if (swept.left === null || swept.left.size > 0)
      problems.push(
        `marked process(es) remain: ${[...(swept.left ?? new Map()).keys()].join(", ") || "unknown"}`,
      );
  }
  if (stackState?.tmp) {
    try {
      rmSync(stackState.tmp, { recursive: true, force: true });
    } catch (e) {
      problems.push(`could not remove ${stackState.tmp}: ${e?.message ?? e}`);
    }
  }
  for (const port of stackState?.ports ?? [])
    if (await listening(port))
      problems.push(`a listener remains on port ${port}`);
  stackState = null;
  return problems;
}

/** One browser's fresh stack: backend, tap, proxy, preview, Playwright. Returns the stack's record (never throws). */
async function stack(browser) {
  const record = {
    browser,
    started_at: new Date().toISOString(),
    problems: [],
  };
  const out = join(evidence, browser);
  mkdirSync(join(out, "intervals"), { recursive: true });
  stackState = {
    tmp: mkdtempSync(join(invocationTmp, `${browser}-`)),
    ports: [],
    proxy: null,
    tap: null,
  };
  const { tmp } = stackState;
  const exchanges = [];
  try {
    // The backend's bytes: the verified development copy, or the released binary (verified against its SHA256SUMS by fetch-backend).
    let binary;
    if (backendKind === "development") {
      const staged = stageExecutable(tmp);
      binary = staged.path;
      record.backend = {
        kind: "development",
        staged: staged.sha256,
        approved_head: PAIR_SELECTION.backend.head,
      };
    } else {
      // The unchanged fetcher (verified against the release's SHA256SUMS) into this runner's OWN content-addressed cache: the released
      // runner's shared cache is neither relied on nor written by the pair runner.
      const fetched = run(process.execPath, [
        join(root, "scripts/integration/fetch-backend.mjs"),
        "--dir",
        join(process.env.TMPDIR ?? tmpdir(), "atlas-pair-released-backend"),
      ]);
      if (fetched.status !== 0)
        throw new Error(
          `fetch-backend failed (exit ${fetched.status}): ${`${fetched.stdout}${fetched.stderr}`.slice(-300)}`,
        );
      const released = JSON.parse(fetched.stdout.trim().split("\n").at(-1));
      binary = released.binary;
      record.backend = {
        kind: "released",
        tag: released.tag,
        archive: released.archive,
        sha256: released.sha256,
      };
    }
    stopIfInterrupted();
    const database = join(tmp, "atlas.sqlite");
    const url = `sqlite://${database}?mode=rwc`;
    const accounts = {};
    for (const name of accountNames()) {
      const password = randomBytes(16).toString("hex");
      const made = run(binary, ["account", name], {
        input: `${password}\n`,
        env: { ...process.env, ATLAS_DATABASE_URL: url },
      });
      if (made.status !== 0)
        throw new Error(
          `could not create ${name}: ${made.stdout}${made.stderr}`,
        );
      accounts[name] = {
        username: name,
        password,
        account_id: made.stdout.trim().split("\n").at(-1),
      };
    }
    const [
      backendPort,
      tapPort,
      tapControlPort,
      proxyPort,
      proxyControlPort,
      previewPort,
    ] = await Promise.all(Array.from({ length: 6 }, () => freePort()));
    stackState.ports.push(
      backendPort,
      tapPort,
      tapControlPort,
      proxyPort,
      proxyControlPort,
      previewPort,
    );
    const origin = `http://127.0.0.1:${previewPort}`;
    let serverLog = "";
    const server = groups.spawn("backend", binary, [], {
      env: {
        ...process.env,
        ATLAS_DATABASE_URL: url,
        ATLAS_BIND: `127.0.0.1:${backendPort}`,
        ATLAS_PUBLIC_ORIGIN: origin,
        ATLAS_SECRET_KEY: randomBytes(32).toString("hex"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (d) => (serverLog += d));
    server.stderr.on("data", (d) => (serverLog += d));
    await waitFor(`http://127.0.0.1:${backendPort}/ready`, "backend").catch(
      (e) => {
        throw new Error(`${e.message}\n${serverLog.slice(-1500)}`);
      },
    );
    // The launched process is the staged copy (development) or the released binary: what the kernel says it runs, not what was asked.
    const launched = run("ps", [
      "-o",
      "comm=",
      "-p",
      String(server.pid),
    ]).stdout.trim();
    record.backend.launched = launched;
    if (launched !== binary)
      throw new Error(`the backend process runs ${launched}, not ${binary}`);
    const health = await (
      await waitFor(`http://127.0.0.1:${backendPort}/health`, "health")
    ).json();
    record.backend.health = health;
    const expectedVersion =
      backendKind === "development" ? PAIR_SELECTION.backend.apiVersion : null;
    if (expectedVersion !== null && health.api_version !== expectedVersion)
      throw new Error(
        `the development backend reports api_version ${health.api_version}, approved ${expectedVersion}`,
      );
    stopIfInterrupted();
    stackState.tap = createTap({
      upstream: `http://127.0.0.1:${backendPort}`,
      port: tapPort,
      controlPort: tapControlPort,
      bodiesDir: join(out, "bodies"),
      correlation: CORRELATION_HEADER,
    });
    const tap = await stackState.tap.start();
    // The proxy names each forwarded request's log entry to the tap (which strips the header before the backend): every tap exchange is
    // joined to exactly one downstream outcome (R23-PAIR.a).
    stackState.proxy = createProxy({
      upstream: tap.tapUrl,
      port: proxyPort,
      controlPort: proxyControlPort,
      observe: (exchange) => exchanges.push(exchange),
      correlation: CORRELATION_HEADER,
    });
    const proxied = await stackState.proxy.start();
    groups.spawn(
      "preview",
      process.execPath,
      [
        join(root, "node_modules/vite/bin/vite.js"),
        "preview",
        "--mode",
        "fixture",
        "--outDir",
        build,
        "--host",
        "127.0.0.1",
        "--port",
        String(previewPort),
        "--strictPort",
      ],
      {
        cwd: root,
        env: { ...process.env, ATLAS_BACKEND_URL: proxied.proxyUrl },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    await waitFor(`${origin}/`, "preview");
    stopIfInterrupted();
    const reportFile = join(out, "results.json");
    mkdirSync(join(tmp, "state"), { recursive: true });
    const playwright = groups.spawn(
      "playwright",
      process.execPath,
      [
        join(root, "node_modules/@playwright/test/cli.js"),
        "test",
        `--project=pair-${browser}`,
        "--reporter=list,json",
        ...(grep ? ["--grep", grep] : []),
        ...PLAYWRIGHT_POLICY,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ATLAS_PAIR: "1",
          ATLAS_E2E_BROWSERS: "all",
          ATLAS_INTEGRATION_URL: origin,
          ATLAS_INTEGRATION_CONTROL: proxied.controlUrl,
          ATLAS_INTEGRATION_BACKEND: `http://127.0.0.1:${backendPort}`,
          ATLAS_INTEGRATION_ACCOUNTS: JSON.stringify(accounts),
          ATLAS_INTEGRATION_STATE_DIR: join(tmp, "state"),
          ATLAS_EVIDENCE_DIR: join(out, "browser-evidence"),
          ATLAS_PAIR_BACKEND: backendKind,
          ATLAS_PAIR_API_VERSION: String(health.api_version ?? ""),
          ATLAS_PAIR_RELEASED_VERSION: String(pin.version),
          ATLAS_PAIR_SELECTION_SHA256:
            backendKind === "development" ? PAIR_SELECTION.manifest.sha256 : "",
          ATLAS_PAIR_TAP: tap.controlUrl,
          ATLAS_PAIR_BODIES: join(out, "bodies"),
          ATLAS_PAIR_DATABASE: database,
          ATLAS_PAIR_EVIDENCE: out,
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
        },
        stdio: "inherit",
      },
      { interruptWith: "SIGINT" },
    );
    const exit = await new Promise((done) =>
      playwright.once("exit", (code, signal) => done({ code, signal })),
    );
    record.playwright = exit;
    record.judged = existsSync(reportFile)
      ? judgeResults(JSON.parse(readFileSync(reportFile, "utf8")), {
          browser,
          backend: backendKind,
          narrowed: grep !== "",
        })
      : {
          complete: false,
          selected_ok: false,
          problems: ["no Playwright report"],
          counts: null,
          outcomes: {},
          unsupported: UNSUPPORTED,
        };
    // Every interval record is validated again, with its bodies re-hashed, and checked to be the record of the case, engine, backend and
    // selection it is filed under; a passed workload case needs exactly one valid record. An INCOMPLETE record (a case that failed before
    // its interval ended) is kept and reported, never counted.
    record.intervals = {};
    const all = readdirSync(join(out, "intervals"));
    record.incomplete_intervals = all.filter((f) =>
      f.endsWith(".incomplete.json"),
    );
    const files = all.filter(
      (f) => f.endsWith(".json") && !f.endsWith(".incomplete.json"),
    );
    const owners = [];
    for (const file of files) {
      let interval = null;
      try {
        interval = JSON.parse(
          readFileSync(join(out, "intervals", file), "utf8"),
        );
      } catch (error) {
        record.intervals[file] = [
          `unreadable: ${String(error?.message ?? error).split("\n")[0]}`,
        ];
      }
      if (interval !== null) {
        record.intervals[file] = [
          ...validateInterval(interval, {
            readBody: (f) => readFileSync(join(out, "bodies", f)),
          }),
          ...identityProblems(interval, {
            file,
            engine: browser,
            backend: backendKind,
            manifest:
              backendKind === "development"
                ? PAIR_SELECTION.manifest.sha256
                : null,
            row: CASES.find((c) => c.id === interval.case),
          }),
        ];
        owners.push(interval.case);
      }
      if (record.intervals[file].length > 0)
        record.problems.push(
          `interval ${file}: ${record.intervals[file].join("; ")}`,
        );
    }
    for (const row of CASES)
      if (
        record.judged.outcomes?.[row.id] === "passed" &&
        row.workload !== null
      ) {
        const own = owners.filter((c) => c === row.id).length;
        if (own !== 1)
          record.problems.push(
            `${row.id} passed with ${own} interval records (one is required)`,
          );
        if (record.incomplete_intervals.some((f) => f.startsWith(`${row.id}.`)))
          record.problems.push(
            `${row.id} passed but left an incomplete interval record`,
          );
      }
    if (exchanges.some((e) => e.status === 429))
      record.problems.push(
        "the backend answered 429: the stack's throttle was exceeded",
      );
  } catch (error) {
    record.problems.push(
      `prepare: ${String(error?.message ?? error).slice(0, 600)}`,
    );
  }
  record.cleanup = await cleanupStack();
  record.problems.push(...record.cleanup);
  // A narrowed run is judged on what it selected (and is never complete: the summary says PARTIAL).
  record.complete =
    record.problems.length === 0 &&
    (grep === ""
      ? record.judged?.complete === true
      : record.judged?.selected_ok === true);
  record.finished_at = new Date().toISOString();
  writeJson(`stack-${browser}.json`, record);
  return record;
}

// ---- revision 26 (R26-DIAG): ONE diagnostic case in its own stack and fixture attempt ----------------------------------------------
const statId = (path) => {
  const st = statSync(path, { bigint: true });
  return { dev: String(st.dev), ino: String(st.ino) };
};
/** A stdin line as recorded: an `add_account` password is replaced by its digest (the sent bytes are hashed, never kept in evidence). */
function recordedLine(entry) {
  if (entry.stream !== "stdin") return entry;
  try {
    const sent = JSON.parse(entry.line);
    if (sent.op !== "add_account") return entry;
    const password = String(sent.args?.password ?? "");
    sent.args = {
      ...sent.args,
      password: `[redacted sha256 ${sha256Of(password).slice(0, 16)}]`,
    };
    return {
      ...entry,
      line: JSON.stringify(sent),
      sent_sha256: sha256Of(entry.line),
    };
  } catch {
    return entry;
  }
}
async function diagnosticStack(browser, caseId) {
  const record = {
    browser,
    case: caseId,
    started_at: new Date().toISOString(),
    problems: [],
  };
  const out = join(evidence, browser, caseId);
  mkdirSync(join(out, "intervals"), { recursive: true });
  const attemptDir = join(out, "attempt");
  mkdirSync(attemptDir, { recursive: true });
  stackState = {
    tmp: mkdtempSync(join(invocationTmp, `${browser}-${caseId}-`)),
    ports: [],
    proxy: null,
    tap: null,
  };
  const { tmp } = stackState;
  const exchanges = [];
  const attempt = newAttemptId(caseId, browser);
  const transcriptFile = join(attemptDir, "transcript.jsonl");
  const specCalls = [];
  // The fixture's PARENT is the attempt's own directory, outside the invocation's recursively removed tree and unknown to the reaper:
  // nobody ever removes it recursively, so a kept fixture or a replacement file survives every clean-up path.
  const fixtureParent = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), "atlas-diagnostic-"),
  );
  const bridgeDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "adc-"));
  const socketPath = join(bridgeDir, "c.sock");
  const envelope = {
    schema: ATTEMPT_SCHEMA,
    attempt,
    case: caseId,
    engine: browser,
    selection_identity: DIAGNOSTIC_IDENTITY,
    executable: null,
    fixture: { parent: fixtureParent, leaf: null },
    public_origin: null,
    argv: null,
    env_keys: null,
    ready: null,
    ready_problems: null,
    transcript: { file: relative(evidence, transcriptFile), sha256: null },
    accounts: {},
    spec_calls: specCalls,
    shutdown: null,
    exit: null,
    latched: null,
    fixture_after: null,
    parent_removed: null,
  };
  let running = null;
  let bridge = null;
  let passed = false;
  try {
    const staged = stageDiagnosticExecutable(tmp);
    envelope.executable = staged;
    record.backend = {
      kind: "diagnostic",
      staged: staged.sha256,
      approved_head: DIAGNOSTIC_SELECTION.backend.head,
      attempt,
    };
    stopIfInterrupted();
    const [tapPort, tapControlPort, proxyPort, proxyControlPort, previewPort] =
      await Promise.all(Array.from({ length: 5 }, () => freePort()));
    stackState.ports.push(
      tapPort,
      tapControlPort,
      proxyPort,
      proxyControlPort,
      previewPort,
    );
    const origin = `http://127.0.0.1:${previewPort}`;
    envelope.public_origin = origin;
    running = await launchAttempt(
      {
        spawn: (command, argv, options) =>
          groups.spawn("diagnostic", command, argv, options),
        realpath: realpathSync,
        exists: existsSync,
        stat: statId,
        readFile: readFileSync,
        record: (entry) =>
          appendFileSync(
            transcriptFile,
            `${JSON.stringify(recordedLine(entry))}\n`,
          ),
      },
      {
        executable: staged.path,
        executableSha256: DIAGNOSTIC_SELECTION.executable.sha256,
        fixtureParent,
        attempt,
        publicOrigin: origin,
        apiVersion: DIAGNOSTIC_SELECTION.backend.apiVersion,
        features: DIAGNOSTIC_SELECTION.features,
        retentionSeconds: DIAGNOSTIC_SELECTION.retentionSeconds,
        env: childEnvironment(),
      },
    );
    stackState.diagnostic = running;
    envelope.fixture.leaf = running.fixtureDir;
    envelope.argv = running.args;
    envelope.env_keys = running.env;
    envelope.ready = {
      receipt_sha256: running.ready.receipt_sha256,
      receipt_file: relative(evidence, join(attemptDir, "receipt.json")),
    };
    writeFileSync(
      join(attemptDir, "receipt.json"),
      running.receiptBytes ?? Buffer.alloc(0),
    );
    envelope.ready_problems = running.problems;
    if (running.problems.length > 0)
      throw new Error(
        `the ready receipt is not this attempt's: ${running.problems.join("; ")}`,
      );
    const backendUrl = running.backendUrl;
    stackState.ports.push(Number(new URL(backendUrl).port));
    record.backend.receipt = running.ready.receipt;
    // The accounts: the executable's own setup command (its stdin), one per name the case uses.
    const accounts = {};
    for (const name of diagnosticAccounts(caseId)) {
      const password = randomBytes(16).toString("hex");
      const answer = await running.control.send("add_account", {
        username: name,
        password,
      });
      accounts[name] = {
        username: name,
        password,
        account_id: answer.result.account,
      };
      envelope.accounts[name] = {
        account_id: answer.result.account,
        seq: answer.seq,
      };
    }
    const health = await (
      await waitFor(`${backendUrl}/health`, "diagnostic health")
    ).json();
    record.backend.health = health;
    if (health.api_version !== DIAGNOSTIC_SELECTION.backend.apiVersion)
      throw new Error(
        `the diagnostic backend reports api_version ${health.api_version}, approved ${DIAGNOSTIC_SELECTION.backend.apiVersion}`,
      );
    stopIfInterrupted();
    const token = randomBytes(24).toString("hex");
    bridge = createControlServer({
      control: running.control,
      socketPath,
      token,
      onCall: (call) => specCalls.push(call),
    });
    await bridge.listen();
    stackState.tap = createTap({
      upstream: backendUrl,
      port: tapPort,
      controlPort: tapControlPort,
      bodiesDir: join(out, "bodies"),
      correlation: CORRELATION_HEADER,
    });
    const tap = await stackState.tap.start();
    stackState.proxy = createProxy({
      upstream: tap.tapUrl,
      port: proxyPort,
      controlPort: proxyControlPort,
      observe: (exchange) => exchanges.push(exchange),
      correlation: CORRELATION_HEADER,
    });
    const proxied = await stackState.proxy.start();
    groups.spawn(
      "preview",
      process.execPath,
      [
        join(root, "node_modules/vite/bin/vite.js"),
        "preview",
        "--mode",
        "fixture",
        "--outDir",
        build,
        "--host",
        "127.0.0.1",
        "--port",
        String(previewPort),
        "--strictPort",
      ],
      {
        cwd: root,
        env: { ...process.env, ATLAS_BACKEND_URL: proxied.proxyUrl },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    await waitFor(`${origin}/`, "preview");
    stopIfInterrupted();
    const reportFile = join(out, "results.json");
    mkdirSync(join(tmp, "state"), { recursive: true });
    const r = running.ready.receipt;
    const playwright = groups.spawn(
      "playwright",
      process.execPath,
      [
        join(root, "node_modules/@playwright/test/cli.js"),
        "test",
        `--project=pair-${browser}`,
        "--reporter=list,json",
        "--grep",
        `${caseId}:`,
        ...PLAYWRIGHT_POLICY,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ATLAS_PAIR: "1",
          ATLAS_E2E_BROWSERS: "all",
          ATLAS_INTEGRATION_URL: origin,
          ATLAS_INTEGRATION_CONTROL: proxied.controlUrl,
          ATLAS_INTEGRATION_BACKEND: backendUrl,
          ATLAS_INTEGRATION_ACCOUNTS: JSON.stringify(accounts),
          ATLAS_INTEGRATION_STATE_DIR: join(tmp, "state"),
          ATLAS_EVIDENCE_DIR: join(out, "browser-evidence"),
          ATLAS_PAIR_BACKEND: "diagnostic",
          ATLAS_PAIR_API_VERSION: String(health.api_version ?? ""),
          ATLAS_PAIR_RELEASED_VERSION: String(pin.version),
          ATLAS_PAIR_SELECTION_SHA256: DIAGNOSTIC_IDENTITY,
          ATLAS_PAIR_TAP: tap.controlUrl,
          ATLAS_PAIR_BODIES: join(out, "bodies"),
          // No database path: nothing in the spec writes the diagnostic's database directly.
          ATLAS_PAIR_DATABASE: "",
          ATLAS_PAIR_EVIDENCE: out,
          ATLAS_PAIR_DIAGNOSTIC_SOCKET: socketPath,
          ATLAS_PAIR_DIAGNOSTIC_TOKEN: token,
          ATLAS_PAIR_DIAGNOSTIC_RECEIPT: JSON.stringify({
            attempt: r.attempt,
            sync_start: r.sync_start,
            retention_seconds: r.retention_seconds,
            api_version: r.api_version,
            public_origin: r.public_origin,
            features: r.features,
          }),
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
        },
        stdio: "inherit",
      },
      { interruptWith: "SIGINT" },
    );
    const exit = await new Promise((done) =>
      playwright.once("exit", (code, signal) => done({ code, signal })),
    );
    record.playwright = exit;
    record.judged = existsSync(reportFile)
      ? judgeResults(JSON.parse(readFileSync(reportFile, "utf8")), {
          browser,
          backend: "diagnostic",
          narrowed: true,
        })
      : {
          complete: false,
          selected_ok: false,
          problems: ["no Playwright report"],
          counts: null,
          outcomes: {},
        };
    if (record.judged.outcomes?.[caseId] !== "passed")
      record.problems.push(
        `${caseId} did not pass (${record.judged.outcomes?.[caseId] ?? "no result"})`,
      );
    passed =
      record.problems.length === 0 &&
      record.judged.selected_ok === true &&
      running.control.latched() === null;
  } catch (error) {
    record.problems.push(
      `prepare: ${String(error?.message ?? error).slice(0, 600)}`,
    );
  }
  // The attempt ends BEFORE any generic clean-up: no new work (the browser is gone), the tap and proxy stop (their connections to the
  // backend close, so it can drain), the bridge closes, then the sequenced shutdown, removing the fixture only for a passing attempt.
  for (const [what, part] of [
    ["proxy", stackState.proxy],
    ["tap", stackState.tap],
  ])
    if (part) {
      await part
        .stop()
        .catch((e) => record.problems.push(`${what} stop: ${e?.message ?? e}`));
      stackState[what] = null;
    }
  if (bridge) await bridge.close();
  rmSync(socketPath, { force: true });
  try {
    rmdirSync(bridgeDir);
  } catch (e) {
    record.problems.push(`bridge directory: ${e?.code ?? e}`);
  }
  if (running) {
    const finished = await finishAttempt(running, { remove: passed });
    envelope.shutdown = {
      requested_remove: finished.requested_remove,
      eof: finished.eof,
      error: finished.shutdown_error,
      stopped: finished.stopped,
    };
    envelope.exit = finished.exit;
    envelope.latched = finished.latched;
  }
  envelope.fixture_after =
    envelope.fixture.leaf === null
      ? null
      : { leaf_exists: existsSync(envelope.fixture.leaf) };
  envelope.parent_removed = removeParentIfEmpty(
    { rmdir: rmdirSync },
    fixtureParent,
  );
  if (!envelope.parent_removed.removed)
    record.problems.push(
      `the attempt's fixture is kept for inspection at ${fixtureParent} (${envelope.parent_removed.error})`,
    );
  if (existsSync(transcriptFile))
    envelope.transcript.sha256 = sha256Of(readFileSync(transcriptFile));
  writeFileSync(
    join(attemptDir, "attempt.json"),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  // The independent re-reading: the attempt from its retained transcript, then every interval and the case's causal proof.
  const readEvidence = (file) => readFileSync(join(evidence, file));
  record.attempt = attemptProblems(envelope, {
    readFile: readEvidence,
    expected: {
      selectionIdentity: DIAGNOSTIC_IDENTITY,
      executableSha256: DIAGNOSTIC_SELECTION.executable.sha256,
      apiVersion: DIAGNOSTIC_SELECTION.backend.apiVersion,
      features: DIAGNOSTIC_SELECTION.features,
      retentionSeconds: RETENTION_SECONDS,
      publicOrigin: envelope.public_origin,
    },
  });
  for (const p of record.attempt) record.problems.push(`attempt: ${p}`);
  const row = CASES.find((c) => c.id === caseId);
  record.intervals = {};
  const all = existsSync(join(out, "intervals"))
    ? readdirSync(join(out, "intervals"))
    : [];
  record.incomplete_intervals = all.filter((f) =>
    f.endsWith(".incomplete.json"),
  );
  for (const f of record.incomplete_intervals)
    record.problems.push(`an incomplete interval record ${f}`);
  const files = all.filter(
    (f) => f.endsWith(".json") && !f.endsWith(".incomplete.json"),
  );
  if (
    row.workload !== null &&
    record.judged?.outcomes?.[caseId] === "passed" &&
    files.length !== 1
  )
    record.problems.push(
      `${caseId} passed with ${files.length} interval records (one is required)`,
    );
  for (const file of files) {
    let interval = null;
    try {
      interval = JSON.parse(readFileSync(join(out, "intervals", file), "utf8"));
    } catch (error) {
      record.intervals[file] = [
        `unreadable: ${String(error?.message ?? error).split("\n")[0]}`,
      ];
    }
    if (interval !== null) {
      record.intervals[file] = [
        ...validateInterval(interval, {
          readBody: (f) => readFileSync(join(out, "bodies", f)),
        }),
        ...identityProblems(interval, {
          file,
          engine: browser,
          backend: "diagnostic",
          manifest: DIAGNOSTIC_IDENTITY,
          row: CASES.find((c) => c.id === interval.case),
        }),
      ];
      if (interval.case !== caseId)
        record.intervals[file].push(
          `the attempt for ${caseId} holds an interval of ${interval.case}`,
        );
      const validator = PROOF_VALIDATORS[interval.case];
      if (validator) {
        const ref = interval.extra?.diagnostic_proof;
        const proofFile = join(out, "diagnostic", String(ref?.file ?? ""));
        let proof = null;
        try {
          const bytes = readFileSync(proofFile);
          if (sha256Of(bytes) !== ref?.sha256)
            record.intervals[file].push(
              "the interval's proof reference does not name the proof's bytes",
            );
          proof = JSON.parse(String(bytes));
        } catch (error) {
          record.intervals[file].push(
            `the causal proof cannot be read: ${String(error?.message ?? error).split("\n")[0]}`,
          );
        }
        if (proof !== null) {
          if (proof.interval !== interval.interval)
            record.intervals[file].push("the proof names another interval");
          let entries = [];
          try {
            entries = readTranscript(readEvidence(envelope.transcript.file));
          } catch {
            record.intervals[file].push(
              "the transcript cannot be re-read for the proof",
            );
          }
          record.intervals[file].push(
            ...validator(proof, {
              attempt: envelope,
              entries,
              requests: [
                ...(interval.requests ?? []),
                ...(interval.other_requests ?? []),
              ],
              readFile: (f) => readFileSync(join(out, "bodies", f)),
            }),
          );
        }
      }
    }
    if (record.intervals[file].length > 0)
      record.problems.push(
        `interval ${file}: ${record.intervals[file].join("; ")}`,
      );
  }
  if (exchanges.some((e) => e.status === 429))
    record.problems.push(
      "the backend answered 429: the stack's throttle was exceeded",
    );
  if (exchanges.some((e) => e.status === 503))
    record.problems.push(
      "an answer was 503: a diagnostic refusal or capacity answer is never passing evidence",
    );
  stackState.diagnostic = null;
  record.cleanup = await cleanupStack();
  record.problems.push(...record.cleanup);
  record.complete = record.problems.length === 0 && passed;
  record.finished_at = new Date().toISOString();
  writeJson(`stack-${browser}-${caseId}.json`, record);
  return record;
}

const summary = {
  label:
    backendKind === "development"
      ? "UNRELEASED development pairing (Decision D): diagnostic evidence only; not integration, activation or acceptance"
      : backendKind === "diagnostic"
        ? "UNRELEASED diagnostic fixture (approved 1 Nov 2026): real expiry/pruning qualification only; not the normal backend, integration, tuning, activation or acceptance"
        : "RELEASED-backend control of the pair journey (whole-revision cases only)",
  backend: backendKind,
  released_pin: { backend_tag: pin.backend_tag, version: pin.version },
  selection: selection?.record?.observed ?? null,
  source,
  partial: grep !== "",
  grep: grep || null,
  browsers: {},
  unsupported: UNSUPPORTED.map((u) => ({ ...u, outcome: "unrun" })),
};
let failed = false;
try {
  const built = run(
    process.execPath,
    [
      join(root, "node_modules/vite/bin/vite.js"),
      "build",
      "--mode",
      "fixture",
      "--outDir",
      build,
      "--emptyOutDir",
    ],
    {
      cwd: root,
    },
  );
  if (built.status !== 0)
    throw new Error(
      `fixture build failed: ${`${built.stdout}${built.stderr}`.slice(-600)}`,
    );
  summary.fixture_build = aggregate(build);
  for (const browser of browsers) {
    if (backendKind === "diagnostic") {
      // Revision 26: each diagnostic case in its own fresh stack and attempt; the first incomplete one stops the schedule.
      const cases = {};
      for (const caseId of diagnosticCases()) {
        if (failed || interrupted) {
          cases[caseId] = {
            complete: false,
            problems: [
              "not run: an earlier attempt was not a complete pass, or the run was interrupted",
            ],
          };
          continue;
        }
        const result = await diagnosticStack(browser, caseId);
        cases[caseId] = result;
        if (!result.complete) failed = true;
      }
      summary.browsers[browser] = {
        complete: Object.values(cases).every((c) => c.complete === true),
        cases,
        not_applicable: CASES.filter(
          (c) => !c.backends.includes("diagnostic"),
        ).map((c) => c.id),
      };
      continue;
    }
    if (failed || interrupted) {
      summary.browsers[browser] = {
        complete: false,
        problems: [
          "not run: an earlier stack was not a complete pass, or the run was interrupted",
        ],
      };
      continue;
    }
    const result = await stack(browser);
    summary.browsers[browser] = result;
    if (!result.complete) failed = true;
  }
} catch (error) {
  summary.error = String(error?.message ?? error).slice(0, 600);
  failed = true;
}
if (backendKind === "development" || backendKind === "diagnostic") {
  // The approved bytes did not change while the run used them.
  const after =
    backendKind === "development"
      ? verifySelection(realSelectionDeps(run))
      : verifyDiagnosticSelection(realDiagnosticDeps(run));
  summary.selection_after = { ok: after.ok, problems: after.problems };
  if (!after.ok) failed = true;
}
const { problems: left } = await groups.stopAll();
rmSync(invocationTmp, { recursive: true, force: true });
await releaseReaper();
if (reaperProblem) left.push(reaperProblem);
summary.left = left;
summary.complete = !failed && left.length === 0 && !summary.partial;
writeJson("summary.json", summary);
log(
  `summary ${relative(root, evidence)}/summary.json: ${summary.complete ? "complete" : summary.partial ? "PARTIAL" : "NOT a complete pass"}`,
);
process.exit(failed || left.length > 0 || interrupted ? 1 : 0);
