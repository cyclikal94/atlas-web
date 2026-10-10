#!/usr/bin/env node
// `pnpm profile:contention` (P-6 to P-9 and P-13): the desktop CONTENTION programme, MEASUREMENTS and not budgets, through the real stamped
// wrapper and the ordinary sync engine, in real Chromium, Firefox and WebKit, with more than one page of one browser context. The leader is
// the FIXTURE test leader, the network a stub with SYNTHETIC delays, the "frozen owner" a main-thread block in a page that holds
// `atlas-auth` (a Playwright engine cannot freeze a page) and the closing-write give-up is observed with a SCALED lock wait; the results
// say so. It writes `<dir>/contention/` and appends its rows to `<dir>/{measurements,values}.jsonl`, beside `pnpm profile:sync`'s files;
// `pnpm profile:sync --evidence <dir> --only handoff` folds them into the hand-over (evidence key `WEB-09a:sync-profiling`, owner WEB-09c).
//
//   node scripts/profile-contention.mjs --evidence <dir> [--skip-build] [--preflight] [--samples N]
//
// `--evidence` is required and nothing is deleted: a directory whose contention stage is already recorded is refused (exit 2).
// `--samples N` is a DEBUGGING run with at most N per cell; it is never recorded as evidence (its stage record says so).
// The controller's load is sampled throughout (`<dir>/isolation/contention.jsonl`, scripts/lib/profile-isolation.mjs).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withFixtureServer } from "./lib/fixture-server.mjs";
import {
  evidenceArg,
  finishStage,
  recordStage,
  refuseRecorded,
} from "./lib/profile-evidence.mjs";
import { startLoadSampler } from "./lib/profile-isolation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "usage: node scripts/profile-contention.mjs --evidence <dir> [--skip-build] [--preflight] [--samples N]";
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const out = evidenceArg(args, root, USAGE);
const log = (message) => console.log(`[profile:contention] ${message}`);
refuseRecorded(out, ["contention"]);
if (flag("--preflight")) {
  log(
    `preflight: would run the contention stage into ${out}; nothing was written`,
  );
  process.exit(0);
}
mkdirSync(out, { recursive: true });
const samples = value("--samples", "");
recordStage(out, "contention", {
  root,
  debugging_samples: samples || null,
  note: samples
    ? "a DEBUGGING run (--samples): never evidence"
    : "the recorded counts",
});

const loadSampler = await startLoadSampler(out, "contention");
let status = 0;
if (!flag("--skip-build")) {
  log("pnpm build:fixture");
  const built = spawnSync("pnpm", ["build:fixture"], {
    cwd: root,
    encoding: "utf8",
  });
  if (built.status !== 0) {
    console.error(built.stdout, built.stderr);
    status = 1;
  }
}

if (status === 0)
  status = await withFixtureServer(root, async (url) => {
    log(`contention profiling against ${url} (one worker, three engines)`);
    const ran = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/@playwright/test/cli.js"),
        "test",
        "--project=fixture-chromium",
        "--project=fixture-firefox",
        "--project=fixture-webkit",
        "--workers=1",
        "--retries=0",
        "tests/e2e/fixture.profile-contention.spec.ts",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          ATLAS_PROFILE: "1",
          ATLAS_PROFILE_OUT: out,
          ATLAS_E2E_BROWSERS: "all",
          ATLAS_FIXTURE_URL: url,
          ...(samples ? { ATLAS_PROFILE_SAMPLES: samples } : {}),
        },
      },
    );
    return ran.status ?? 1;
  });
await loadSampler.stop();
finishStage(out, "contention", status);
log(`written to ${out}/contention (exit ${status})`);
process.exit(status);
