#!/usr/bin/env node
// WEB-09c (R23-PAIR, Decision D of 29 October 2026): the maintained DEVELOPMENT-PAIR runner. It runs tests/pair/pair.development.spec.ts
// in real browser engines against EITHER
//   --backend development   the approved UNRELEASED backend (scripts/integration/pair-selection.mjs: manifest, executable, source,
//                           contract, fixture and types, every one hash-bound; any difference refuses the run), or
//   --backend released      the RELEASED-backend control (contract-pin.json's release, fetched and verified by the unchanged
//                           fetch-backend.mjs), which runs only the whole-revision cases (pair-matrix.mjs);
// on an owned disposable SQLite database, behind the PASSIVE tap (pair-tap.mjs) and the delaying proxy, with a fixture build made by this
// invocation from the current source and served by its own `vite preview`.
//
//   node scripts/integration/run-development-pair.mjs --backend development|released [--browsers chromium,firefox,webkit]
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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProxy } from "./delaying-proxy.mjs";
import { freePort } from "./free-port.mjs";
import { membersOf, processTable, stopMembers } from "./ownership.mjs";
import { CORRELATION_HEADER } from "./pair-attempts.mjs";
import { identityProblems, validateInterval } from "./pair-evidence.mjs";
import {
  accountNames,
  BROWSERS,
  CASES,
  discoveryProblems,
  judgeResults,
  UNSUPPORTED,
} from "./pair-matrix.mjs";
import {
  PAIR_SELECTION,
  realSelectionDeps,
  sha256Of,
  stageExecutable,
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
if (!["development", "released"].includes(backendKind)) {
  console.error(
    "REFUSED: --backend development|released is required (there is no default backend)",
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

const summary = {
  label:
    backendKind === "development"
      ? "UNRELEASED development pairing (Decision D): diagnostic evidence only; not integration, activation or acceptance"
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
if (backendKind === "development") {
  // The approved bytes did not change while the run used them.
  const after = verifySelection(realSelectionDeps(run));
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
