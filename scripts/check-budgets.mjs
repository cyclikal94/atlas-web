#!/usr/bin/env node
// A2. Measures the built client (initial JS and CSS gzip, font bytes, precache size) and holds each figure to the
// provisional budget and, once recorded, to the baseline plus a tolerance. `--record` stores the current figures as the
// baseline for that build. Usage: check-budgets.mjs [dist|dist-fixture] [--record]. The fixture build is the shell, so it
// is the honest measure of what the signed-in client will cost; the production build is the neutral entry only.
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
const failures = [];
for (const [name, value] of Object.entries(measured)) {
  // A build may carry its own ceiling for a figure (`provisional_by_build`, recorded with its authority in perf-budget.json).
  const ceiling =
    budget.provisional_by_build?.[root]?.[name] ?? budget.provisional[name];
  if (value > ceiling)
    failures.push(`${name} ${value} exceeds the provisional budget ${ceiling}`);
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
