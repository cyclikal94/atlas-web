#!/usr/bin/env node
// `pnpm profile:contention` (plan 7.2, P-6 to P-9): the desktop CONTENTION programme, MEASUREMENTS and not budgets, through the real
// stamped wrapper and the ordinary sync engine, in real Chromium, Firefox and WebKit, with more than one page of one browser context.
// The leader is the FIXTURE test leader, the network a stub with SYNTHETIC delays, the "frozen owner" a main-thread block in a page that
// holds `atlas-auth` (a Playwright engine cannot freeze a page) and the closing-write give-up is observed with a SCALED lock wait; the
// results say so. It writes into .agtx/evidence/WEB-09a/profiling/ beside `pnpm profile:sync`'s files, and `pnpm profile:sync --only
// handoff` folds them into the handoff.
//
//   node scripts/profile-contention.mjs [--skip-build] [--samples N]    (--samples N: a DEBUGGING run with at most N per cell; never recorded)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withFixtureServer } from "./lib/fixture-server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const out = resolve(root, ".agtx/evidence/WEB-09a/profiling");
const log = (message) => console.log(`[profile:contention] ${message}`);

if (!flag("--skip-build")) {
  log("pnpm build:fixture");
  const built = spawnSync("pnpm", ["build:fixture"], {
    cwd: root,
    encoding: "utf8",
  });
  if (built.status !== 0) {
    console.error(built.stdout, built.stderr);
    process.exit(1);
  }
}

// An earlier run of THIS programme is replaced, never appended to: its rows leave the shared files first.
rmSync(join(out, "contention"), { recursive: true, force: true });
for (const file of ["measurements.jsonl", "values.jsonl"]) {
  const path = join(out, file);
  if (!existsSync(path)) continue;
  const kept = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line && !/"name":"P-[6789] /.test(line));
  writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "");
}

const status = await withFixtureServer(root, async (url) => {
  log(`contention profiling against ${url} (one worker, three engines)`);
  const samples = value("--samples", "");
  const ran = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "--project=fixture-chromium",
      "--project=fixture-firefox",
      "--project=fixture-webkit",
      "--workers=1",
      "tests/e2e/fixture.profile-contention.spec.ts",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        ATLAS_PROFILE: "1",
        ATLAS_E2E_BROWSERS: "all",
        ATLAS_FIXTURE_URL: url,
        ...(samples ? { ATLAS_PROFILE_SAMPLES: samples } : {}),
      },
    },
  );
  return ran.status ?? 1;
});
log(`written to ${out}/contention`);
process.exit(status);
