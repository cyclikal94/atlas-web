#!/usr/bin/env node
// Qualification of scripts/smoke-image.sh's composed origin, against a real Docker daemon and browser (F-PACK-COMPOSE, Q1-Q3).
//
//   node scripts/validation/smoke-image-controls.mjs --out <fresh directory> [--only id,id]
//
// Each case runs the script (or a deliberately broken copy of it, run in place as `bash -c <text> scripts/smoke-image.sh`, so
// the repository and dist/ are the real ones) on one architecture, with its own fresh evidence directory, and judges it by an
// explicit expected outcome: the exit status, the named FAIL lines that must appear, the only FAIL lines that may, and what
// cleanup left. A mutant is CAUGHT only by those named checks; a timeout, an unrelated failure, a missing evidence file or a
// survivor is never a catch. The unmutated control runs first, and the run stops at the first case that does not behave as
// expected (fail fast). Everything a case created is looked for afterwards by its run label; anything left fails the case.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const onlyAt = args.indexOf("--only");
if (outAt < 0 || !args[outAt + 1]) {
  console.error(
    "usage: smoke-image-controls.mjs --out <fresh directory> [--only id,id]",
  );
  process.exit(2);
}
const out = resolve(root, args[outAt + 1]);
if (existsSync(out) && readdirSync(out).length) {
  console.error(`${out} is not empty: give every run a fresh directory`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const only = onlyAt < 0 ? null : new Set(args[onlyAt + 1].split(","));
const script = readFileSync(join(root, "scripts/smoke-image.sh"), "utf8");
const stubConf = readFileSync(
  join(root, "scripts/smoke-image-backend.conf"),
  "utf8",
);
const LIMIT_MS = 15 * 60_000;

function mutate(text, from, to) {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0)
    throw new Error(`mutation anchor is not unique: ${from}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}
function stubVariant(name, from, to) {
  const file = join(out, `${name}.conf`);
  writeFileSync(file, mutate(stubConf, from, to));
  return mutate(
    script,
    "STUB_CONF=scripts/smoke-image-backend.conf",
    `STUB_CONF=${file}`,
  );
}

const ARM = { PLATFORMS: "linux/arm64", BROWSER_PLATFORM: "linux/arm64" };
const cases = [
  {
    id: "control",
    about:
      "unmutated script, one architecture with the browser suite: every check passes, nothing survives",
    text: script,
    env: ARM,
    exit: 0,
    must: [],
    may: [],
    evidence: [
      "composed-arm64.txt",
      "playwright-inventory-verdict-arm64.json",
      "playwright-image-verdict-arm64.json",
      "composed-backend-requests-arm64.txt",
    ],
  },
  {
    id: "not-fresh",
    about:
      "an evidence directory holding an earlier attempt is refused before anything is created",
    text: script,
    env: ARM,
    prepare: (dir) =>
      writeFileSync(join(dir, "earlier.txt"), "an earlier attempt\n"),
    exit: 2,
    must: [],
    may: [],
    stderr: /already holds an earlier attempt's evidence/,
    noDocker: true,
  },
  {
    id: "no-health",
    about:
      "the stub has no /health route: readiness fails by name, the browser never starts",
    text: stubVariant(
      "no-health",
      `location = /health {`,
      `location = /health-missing {`,
    ),
    env: ARM,
    exit: 1,
    must: [
      /the composed origin was not ready within 30 s/,
      /production browser suite not run/,
    ],
    may: [],
  },
  {
    id: "malformed-health",
    about:
      "the stub's /health lacks api_version: readiness fails by name, the browser never starts",
    text: stubVariant(
      "malformed-health",
      `'{"api_version":"0.31.0","status":"ok"}'`,
      `'{"status":"ok"}'`,
    ),
    env: ARM,
    exit: 1,
    must: [
      /the composed origin was not ready within 30 s/,
      /production browser suite not run/,
    ],
    may: [],
  },
  {
    id: "wrong-bytes",
    about:
      "the proxy sends /assets to the stub: the template identity and the per-file byte checks fail, the browser never starts",
    text: mutate(
      script,
      `ATLAS_SMOKE_TEMPLATE="$(cat deploy/nginx/proxy.conf.template)"`,
      `ATLAS_SMOKE_TEMPLATE="$(sed 's/|oidc)/|oidc|assets)/' deploy/nginx/proxy.conf.template)"`,
    ),
    env: ARM,
    exit: 1,
    must: [
      /the proxy runs this repository's reference template/,
      /composed \/assets\/[^ ]+ differs from dist\//,
      /production browser suite not run/,
    ],
    may: [
      /composed \/assets\/[^ ]+ keeps the image's/,
      /composed gzip/,
      /composed \/assets\/missing\.js comes from the image/,
      /composed \/assets\/missing\.js came from the stub/,
    ],
  },
  {
    id: "proxy-exits",
    about:
      "the proxy container exits at once: readiness fails by name and its log is kept",
    text: mutate(
      script,
      `printf "%s\\n" "$ATLAS_SMOKE_TEMPLATE" > /etc/nginx/templates/default.conf.template && exec`,
      `exit 3; exec`,
    ),
    env: ARM,
    exit: 1,
    must: [
      /-proxy exited before the composed origin was ready/,
      /production browser suite not run/,
    ],
    may: [],
  },
  {
    id: "original-origin",
    about:
      "the browser run is given the container's own origin (the reviewed defect): the suite, the case accounting and the backend audit fail",
    text: mutate(
      script,
      `run_child env ATLAS_PRODUCTION_URL="$ORIGIN" PLAYWRIGHT_JSON_OUTPUT_FILE="$results"`,
      `run_child env ATLAS_PRODUCTION_URL="$base" PLAYWRIGHT_JSON_OUTPUT_FILE="$results"`,
    ),
    env: ARM,
    exit: 1,
    must: [
      /production browser suite failed/,
      /the run does not account for the pinned cases/,
      /the browser never asked the stub for \/health/,
    ],
    may: [],
    verdict: (dir) => {
      const v = JSON.parse(
        readFileSync(join(dir, "playwright-image-verdict-arm64.json"), "utf8"),
      );
      return (
        v.passed === false &&
        v.summary.ran === 28 &&
        v.summary.stats.unexpected > 0
      );
    },
  },
  {
    id: "cleanup-fails",
    about:
      "cleanup leaves the built image behind: a run whose checks all passed still fails, naming the survivor",
    text: mutate(
      script,
      `for i in "\${IMAGES[@]:-}"; do [ -n "$i" ] && docker rmi -f "$i" >/dev/null 2>&1; done`,
      `:`,
    ),
    env: { PLATFORMS: "linux/arm64", BROWSER_PLATFORM: "none" },
    exit: 1,
    must: [/resources this run created survived cleanup/],
    may: [],
    stdout: /Image smoke ok for: linux\/arm64/,
    survivors: true,
  },
  {
    id: "signal",
    about:
      "SIGTERM while the browser suite runs: the suite's process group stops, everything is removed, exit 143",
    text: script,
    env: ARM,
    exit: 143,
    must: [],
    may: [],
    signalWhen: (dir) => existsSync(join(dir, "playwright-image-arm64.log")),
  },
];

const labelled = (runId) => {
  const label = `label=atlas-web-smoke-image=${runId}`;
  const lines = (argv) =>
    execFileSync("docker", argv, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  return [
    ...lines(["ps", "-aq", "--filter", label]),
    ...lines(["network", "ls", "-q", "--filter", label]),
    ...lines(["image", "ls", "-q", `atlas-web-smoke-${runId}`]),
  ];
};
// Every live process: pid, parent, process group and command.
const processTable = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, pgid, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      command,
    }));
// A browser process: its executable (not an argument such as --project=production-chromium) is Playwright's Chromium.
const isBrowser = (p) => /chrom|headless_shell/i.test(p.command.split(" ")[0]);
// The descendants of a process (browsers included, whatever process group Playwright gives them).
const descendants = (pid) => {
  const table = processTable();
  const found = [];
  const walk = (parent) => {
    for (const p of table) {
      if (p.ppid !== parent) continue;
      found.push(p);
      walk(p.pid);
    }
  };
  walk(pid);
  return found;
};

function runCase(c, dir) {
  return new Promise((resolveCase) => {
    const started = Date.now();
    const child = spawn("bash", ["-c", c.text, "scripts/smoke-image.sh"], {
      cwd: root,
      env: { ...process.env, ...c.env, SMOKE_IMAGE_EVIDENCE: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    let timedOut = false;
    let signalled = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, LIMIT_MS);
    let poll;
    if (c.signalWhen)
      poll = setInterval(() => {
        if (signalled || !c.signalWhen(dir)) return;
        // The script's child (pnpm → Playwright → Chromium) and everything under it, recorded before the signal.
        const tree = descendants(child.pid);
        if (
          !tree.some((p) => /playwright/.test(p.command)) ||
          !tree.some(isBrowser)
        )
          return;
        signalled = { at_ms: Date.now() - started, processes: tree };
        child.kill("SIGTERM");
      }, 250);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolveCase({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        signalled,
        ms: Date.now() - started,
      });
    });
  });
}

const results = [];
let stopped = null;
for (const c of cases) {
  if (only && !only.has(c.id)) continue;
  const dir = join(out, c.id);
  mkdirSync(dir, { recursive: true });
  c.prepare?.(dir);
  console.log(`--- ${c.id}: ${c.about}`);
  const r = await runCase(c, dir);
  writeFileSync(join(out, `${c.id}.stdout.txt`), r.stdout);
  writeFileSync(join(out, `${c.id}.stderr.txt`), r.stderr);
  const problems = [];
  if (r.timedOut)
    problems.push(`timed out after ${LIMIT_MS} ms (never a catch)`);
  if (r.code !== c.exit)
    problems.push(`exit ${r.code} (signal ${r.signal}), expected ${c.exit}`);
  const fails = r.stderr
    .split("\n")
    .filter((line) => line.startsWith("FAIL: "));
  for (const pattern of c.must)
    if (!fails.some((line) => pattern.test(line)))
      problems.push(`no FAIL line matches ${pattern}`);
  const allowed = [...c.must, ...c.may];
  for (const line of fails)
    if (!allowed.some((p) => p.test(line))) problems.push(`unexpected ${line}`);
  if (c.stderr && !c.stderr.test(r.stderr))
    problems.push(`stderr does not match ${c.stderr}`);
  if (c.stdout && !c.stdout.test(r.stdout))
    problems.push(`stdout does not match ${c.stdout}`);
  if (c.signalWhen && !r.signalled) problems.push("the signal was never sent");
  for (const file of c.evidence ?? [])
    if (!existsSync(join(dir, file)))
      problems.push(`evidence ${file} is missing`);
  if (c.verdict && !c.verdict(dir))
    problems.push("the saved case verdict does not show the expected failure");
  let runId = null;
  let left = [];
  const removed = [];
  if (c.noDocker) {
    if (existsSync(join(dir, "run.txt")))
      problems.push("the refused run still started");
  } else {
    const runFile = join(dir, "run.txt");
    runId = existsSync(runFile)
      ? readFileSync(runFile, "utf8")
          .trim()
          .replace(/^run_id=/, "")
      : null;
    if (!runId) problems.push("no run id recorded");
    else {
      const cleanup = existsSync(join(dir, "cleanup.txt"))
        ? readFileSync(join(dir, "cleanup.txt"), "utf8")
        : "";
      left = labelled(runId);
      if (c.survivors) {
        if (!left.length || /survivors=none/.test(cleanup))
          problems.push("the cleanup mutant left nothing behind");
        // The control removes what the mutant deliberately left, then checks it is gone.
        for (const id of left) {
          try {
            execFileSync("docker", ["rmi", "-f", id], { stdio: "ignore" });
            removed.push(id);
          } catch {
            problems.push(`could not remove the mutant's survivor ${id}`);
          }
        }
        if (labelled(runId).length)
          problems.push("the mutant's survivors remain after removal");
      } else {
        if (!/survivors=none/.test(cleanup))
          problems.push(`cleanup recorded: ${cleanup.trim() || "nothing"}`);
        if (left.length) problems.push(`left behind: ${left.join(" ")}`);
      }
    }
  }
  if (r.signalled) {
    await new Promise((settle) => setTimeout(settle, 3000));
    const live = processTable();
    for (const p of r.signalled.processes)
      if (live.some((q) => q.pid === p.pid && q.command === p.command))
        problems.push(
          `process ${p.pid} survived the signal: ${p.command.slice(0, 120)}`,
        );
    if (!r.signalled.processes.some(isBrowser))
      problems.push("no browser was running when the signal was sent");
  }
  const verdict =
    c.id === "control"
      ? problems.length
        ? "FAILED"
        : "PASSED"
      : problems.length
        ? "NOT CAUGHT / INVALID"
        : "CAUGHT";
  const record = {
    id: c.id,
    about: c.about,
    verdict,
    exit: r.code,
    signal: r.signal,
    ms: r.ms,
    runId,
    fails,
    problems,
    signalled: r.signalled,
    left,
    removed,
  };
  results.push(record);
  console.log(
    `${verdict} ${c.id} (${(r.ms / 1000).toFixed(1)} s)${problems.length ? `\n  ${problems.join("\n  ")}` : ""}`,
  );
  if (problems.length) {
    stopped = c.id;
    break;
  }
}

// Two unmutated runs at once: separate run ids, ports, networks and evidence; both pass; neither leaves anything.
if (!stopped && (!only || only.has("concurrent"))) {
  console.log("--- concurrent: two unmutated runs at once");
  const dirs = ["concurrent-a", "concurrent-b"].map((n) => join(out, n));
  for (const d of dirs) mkdirSync(d, { recursive: true });
  const runs = await Promise.all(
    dirs.map((d) => runCase({ text: script, env: ARM }, d)),
  );
  const problems = [];
  const ids = [];
  runs.forEach((r, i) => {
    writeFileSync(`${dirs[i]}.stdout.txt`, r.stdout);
    writeFileSync(`${dirs[i]}.stderr.txt`, r.stderr);
    if (r.code !== 0 || r.timedOut)
      problems.push(
        `${dirs[i]}: exit ${r.code}${r.timedOut ? " (timed out)" : ""}`,
      );
    const runId = readFileSync(join(dirs[i], "run.txt"), "utf8")
      .trim()
      .replace(/^run_id=/, "");
    ids.push(runId);
    if (labelled(runId).length) problems.push(`${runId} left resources behind`);
    if (
      !/survivors=none/.test(readFileSync(join(dirs[i], "cleanup.txt"), "utf8"))
    )
      problems.push(`${runId} recorded survivors`);
  });
  const origins = dirs.map(
    (d) =>
      readFileSync(join(d, "composed-arm64.txt"), "utf8").match(
        /^composed_origin=(.*)$/m,
      )?.[1],
  );
  if (ids[0] === ids[1] || origins[0] === origins[1])
    problems.push("the two runs shared a run id or an origin");
  const record = {
    id: "concurrent",
    verdict: problems.length ? "FAILED" : "PASSED",
    runs: runs.map((r, i) => ({
      dir: dirs[i],
      exit: r.code,
      ms: r.ms,
      runId: ids[i],
      origin: origins[i],
    })),
    problems,
  };
  results.push(record);
  console.log(
    `${record.verdict} concurrent${problems.length ? `\n  ${problems.join("\n  ")}` : ""}`,
  );
  if (problems.length) stopped = "concurrent";
}

const summary = {
  script_sha256: execFileSync(
    "shasum",
    ["-a", "256", "scripts/smoke-image.sh"],
    { cwd: root, encoding: "utf8" },
  ).split(" ")[0],
  driver_sha256: execFileSync(
    "shasum",
    ["-a", "256", fileURLToPath(import.meta.url)],
    { encoding: "utf8" },
  ).split(" ")[0],
  docker_context: process.env.DOCKER_CONTEXT ?? null,
  stopped_at: stopped,
  results,
};
writeFileSync(
  join(out, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(
  stopped
    ? `stopped at ${stopped}`
    : `all ${results.length} cases behaved as expected`,
);
process.exit(stopped ? 1 : 0);
