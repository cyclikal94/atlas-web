#!/usr/bin/env node
// Judge a Playwright inventory (and run) against a pinned case list; see scripts/lib/playwright-cases.mjs.
//
//   node scripts/check-playwright-cases.mjs --expected scripts/smoke-image-cases.json --inventory list.json [--results run.json] --out verdict.json
//
// Exit 0 only when every pinned case is discovered exactly once and, with --results, passed exactly once with no retry; the
// verdict (every problem, and a summary) is written to --out either way. An unreadable or malformed file is exit 2.
import { readFileSync, writeFileSync } from "node:fs";
import { reconcile } from "./lib/playwright-cases.mjs";

const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const name = args[i]?.replace(/^--/, "");
  if (
    !["expected", "inventory", "results", "out"].includes(name) ||
    !args[i + 1]
  ) {
    console.error(
      "usage: check-playwright-cases.mjs --expected F --inventory F [--results F] --out F",
    );
    process.exit(2);
  }
  options[name] = args[i + 1];
}
if (!options.expected || !options.inventory || !options.out) {
  console.error("--expected, --inventory and --out are required");
  process.exit(2);
}

let verdict;
try {
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const pinned = read(options.expected);
  verdict = reconcile({
    expected: pinned.cases,
    inventory: read(options.inventory),
    results: options.results === undefined ? undefined : read(options.results),
  });
  verdict.inputs = { ...options };
} catch (error) {
  writeFileSync(
    options.out,
    `${JSON.stringify({ passed: false, error: String(error), inputs: options }, null, 2)}\n`,
  );
  console.error(`cannot judge the Playwright selection: ${error}`);
  process.exit(2);
}
writeFileSync(options.out, `${JSON.stringify(verdict, null, 2)}\n`);
for (const problem of verdict.problems) console.error(`  ${problem}`);
console.log(
  verdict.passed
    ? `all ${verdict.summary.pinned} pinned cases accounted for${options.results ? " and passed once" : ""}`
    : `${verdict.problems.length} problem(s) against the pinned ${verdict.summary.pinned} cases`,
);
process.exit(verdict.passed ? 0 : 1);
