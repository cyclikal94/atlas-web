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
// The controller's load is sampled throughout (`<dir>/isolation/contention.jsonl`, scripts/lib/profile-isolation.mjs), and the stage is
// sealed with its action interval inside the sampler's first and last samples, whatever happens to the action. Run by `profile-sync.mjs`, the
// samples attribute by that invocation's root (the claim's isolation context), which must be this driver's live ancestor.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withFixtureServer } from "./lib/fixture-server.mjs";
import {
  CLAIM_FILE,
  claimDirectory,
  claimHolder,
  evidenceArg,
  recordedStages,
  refuseRecorded,
  runStage,
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
// Run directly, this driver claims the directory itself; run by `profile-sync.mjs`, it runs under that invocation's claim
// (ATLAS_PROFILE_CLAIM), which must be the one holding the directory.
const delegated = process.env.ATLAS_PROFILE_CLAIM;
if (!delegated && claimHolder(out)) {
  console.error(
    `refused: ${out} is held by another invocation, or by one that was interrupted (${CLAIM_FILE}: ${JSON.stringify(claimHolder(out))}); use a fresh evidence directory. Nothing was changed or deleted.`,
  );
  process.exit(2);
}
if (flag("--preflight")) {
  log(
    `preflight: would run the contention stage into ${out}; nothing was written`,
  );
  process.exit(0);
}
const claim = claimDirectory(out, { stages: ["contention"], delegated });
if (recordedStages(out, ["contention"]).length > 0) {
  if (!claim.delegated) claim.withdraw();
  refuseRecorded(out, ["contention"]);
}
const samples = value("--samples", "");

const status = await runStage(
  out,
  "contention",
  async () => {
    if (!flag("--skip-build")) {
      log("pnpm build:fixture");
      const built = spawnSync("pnpm", ["build:fixture"], {
        cwd: root,
        encoding: "utf8",
      });
      if (built.status !== 0) {
        console.error(built.stdout, built.stderr);
        return 1;
      }
    }
    return withFixtureServer(root, async (url) => {
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
            ATLAS_PROFILE_STAGE: "contention",
            ATLAS_PROFILE_INVOCATION: claim.invocation,
            ATLAS_E2E_BROWSERS: "all",
            ATLAS_FIXTURE_URL: url,
            ...(samples ? { ATLAS_PROFILE_SAMPLES: samples } : {}),
          },
        },
      );
      return ran.status ?? 1;
    });
  },
  {
    // The invocation's context, from this driver's own claim or (delegated) the claim it runs under: its samples attribute by the
    // invocation's root, so the parent driver's tree (and the launcher's helper under it) is this run's (review 8 R1).
    sample: (dir, stage, context) => startLoadSampler(dir, stage, { context }),
    invocation: claim.invocation,
    context: claim.context,
    extra: {
      root,
      debugging_samples: samples || null,
      note: samples
        ? "a DEBUGGING run (--samples): never evidence"
        : "the recorded counts",
    },
  },
);
claim.release(status);
log(`written to ${out}/contention (exit ${status})`);
process.exit(status);
