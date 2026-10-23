// WEB-08d revision 26 (review r25 R25-N1; design assessment 26f1a626 step 2): the CHILD side of a held-operation run's applicability
// record (held-operation-applicability.mjs). The runner launches it exactly as it launches the build and Playwright, through `pnpm exec`
// with the same environment, so what it reports is what those children resolve: the Node that runs them, the pnpm that launched them,
// the installed Playwright and Vite packages, and the browser installations Playwright would launch. It only resolves and reports;
// the controller hashes what it names. It builds, starts and writes nothing else.
//
// Usage (by the controller only): pnpm exec node scripts/validation/held-operation-runtime-probe.cjs <out.json> <root> <engines,...>
"use strict";
const { execFileSync } = require("node:child_process");
const { realpathSync, readFileSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");

const [out, root, engines] = process.argv.slice(2);
const resolveFrom = (from, name) => {
  const pkg = createRequire(from).resolve(`${name}/package.json`);
  return { pkg, dir: realpathSync(dirname(pkg)) };
};
const pkgOf = ({ pkg, dir }) => ({
  version: String(JSON.parse(readFileSync(pkg, "utf8")).version),
  dir,
});
// The resolution chain the test runner itself follows: the worktree's @playwright/test, its playwright, that one's playwright-core.
const test = resolveFrom(join(root, "package.json"), "@playwright/test");
const playwright = resolveFrom(test.pkg, "playwright");
const core = resolveFrom(playwright.pkg, "playwright-core");
const vite = resolveFrom(join(root, "package.json"), "vite");
const pw = require(core.dir);
let parent = null;
try {
  parent = execFileSync("ps", ["-o", "comm=", "-p", String(process.ppid)])
    .toString()
    .trim();
} catch {
  parent = null;
}
const result = {
  node: process.version,
  exec_path: process.execPath,
  platform: process.platform,
  arch: process.arch,
  user_agent: process.env.npm_config_user_agent ?? null,
  parent_exec_path: parent || null,
  corepack_root: process.env.COREPACK_ROOT ?? null,
  packages: {
    "@playwright/test": pkgOf(test),
    playwright: pkgOf(playwright),
    "playwright-core": pkgOf(core),
    vite: pkgOf(vite),
  },
  browsers: Object.fromEntries(
    String(engines)
      .split(",")
      .filter(Boolean)
      .map((engine) => [engine, pw[engine].executablePath()]),
  ),
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
