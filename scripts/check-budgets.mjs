#!/usr/bin/env node
// A2. Measures the built client (initial JS and CSS gzip, font bytes, precache size) and holds each figure to the
// measured `budget` shared by both builds and, once recorded, to that build's baseline plus a tolerance. `--record` stores
// the current figures as the baseline for that build. Usage: check-budgets.mjs [dist|dist-fixture] [--record]. The fixture
// build is the shell, so it is the honest measure of what the signed-in client will cost; the production build is the
// neutral entry only. The budget is the signed-in (fixture) measurement plus the tolerance (WEB-09c, OD-2: `budget_basis` in
// perf-budget.json); a file that still carries the provisional figures of WEB-07 is refused.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";

const root =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "dist";
const record = process.argv.includes("--record");
const html = readFileSync(join(root, "index.html"), "utf8");
const gz = (file) =>
  gzipSync(readFileSync(join(root, file)), { level: 9 }).length;
const local = (url) => url.replace(/^\//, "");

const scripts = [
  ...html.matchAll(
    /<(?:script[^>]*type="module"[^>]*src|link[^>]*rel="modulepreload"[^>]*href)="([^"]+)"/g,
  ),
].map((m) => local(m[1]));
const styles = [
  ...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g),
]
  .map((m) => local(m[1]))
  .filter((f) => f.startsWith("assets/"));

const files = [];
(function walk(directory, prefix = "") {
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
    else files.push({ path: `${prefix}${name}`, size: statSync(full).size });
  }
})(root);
const fonts = files.filter((file) => extname(file.path) === ".woff2");
const precache = files.filter(
  (file) =>
    /\.(js|css|html|woff2|svg)$/.test(file.path) && file.path !== "sw.js",
);

const measured = {
  initial_js_gzip: scripts.reduce((sum, file) => sum + gz(file), 0),
  css_gzip: styles.reduce((sum, file) => sum + gz(file), 0),
  fonts: fonts.reduce((sum, file) => sum + file.size, 0),
};
const detail = {
  scripts,
  styles,
  fonts: fonts.map((file) => ({ file: file.path, bytes: file.size })),
  precache_bytes: precache.reduce((sum, file) => sum + file.size, 0),
  precache_entries: precache.length,
};

const budgetFile = "perf-budget.json";
const budget = JSON.parse(readFileSync(budgetFile, "utf8"));
// The provisional figures (WEB-07) and the per-build ceiling (WEB-09a R61) were replaced by one measured budget (WEB-09c): a file
// that still holds either is not a budget this checker can hold a build to.
for (const retired of ["provisional", "provisional_by_build"])
  if (retired in budget) {
    console.error(
      `Budget check REFUSED: ${budgetFile} still has \`${retired}\`; the measured \`budget\` (WEB-09c) replaced it`,
    );
    process.exit(1);
  }
const failures = [];
for (const [name, value] of Object.entries(measured)) {
  const ceiling = budget.budget?.[name];
  if (typeof ceiling !== "number") {
    console.error(
      `Budget check REFUSED: ${budgetFile} has no \`budget.${name}\``,
    );
    process.exit(1);
  }
  if (value > ceiling)
    failures.push(`${name} ${value} exceeds the budget ${ceiling}`);
  const base = budget.baseline?.[root]?.[name];
  if (base !== undefined && value > base * (1 + budget.tolerance)) {
    failures.push(
      `${name} ${value} is more than ${budget.tolerance * 100}% above the baseline ${base}`,
    );
  }
}
mkdirSync(".agtx/evidence/WEB-07/A2", { recursive: true });
writeFileSync(
  `.agtx/evidence/WEB-07/A2/bundle-profile-${root}.json`,
  `${JSON.stringify({ measured, detail, budget, failures }, null, 2)}\n`,
);
if (record) {
  budget.baseline = { ...(budget.baseline ?? {}), [root]: measured };
  writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`);
  console.log(`Recorded baseline: ${JSON.stringify(measured)}`);
}
if (failures.length > 0) {
  console.error(`Budget check FAILED:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log(
  `Budgets ok (${root}): ${JSON.stringify(measured)}${budget.baseline?.[root] ? "" : " (no baseline recorded yet)"}`,
);
