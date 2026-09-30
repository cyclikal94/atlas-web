#!/usr/bin/env node
// Artefact assertion for the third-party notices: every package the build put into the output has a notice with its licence
// text. Usage: node scripts/check-notices.mjs [directory=dist] [--notices <file>]
//
// The notices are checked against two independent descriptions of what is in the output, so a defect in either shows up:
//  1. the build's own record of bundled packages (_web/bundled-packages-*.json, from the bundler's module graph);
//  2. the output itself: every Workbox module marks the service worker with `self["workbox:<module>:<version>"]`, so a Workbox
//     package inside sw.js is found by reading sw.js, whatever the record says. The Workbox packages are devDependencies that
//     Vite compiles into sw.js, and an earlier generator that listed only `pnpm licenses --prod` omitted them.
// The directory may be dist/, or the site/ of an extracted archive (pass its THIRD-PARTY-NOTICES.txt with --notices).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = args.indexOf("--notices");
const noticesFile = flag >= 0 ? args[flag + 1] : undefined;
const positional = args.filter(
  (arg, index) => !arg.startsWith("--") && (flag < 0 || index !== flag + 1),
);
const directory = positional[0] ?? "dist";
const notices = noticesFile ?? join(directory, "_web/third-party-notices.txt");
const problems = [];

if (!existsSync(notices)) {
  console.error(`${notices} does not exist: run pnpm package:prepare`);
  process.exit(1);
}
const text = readFileSync(notices, "utf8");
const listed = (name, version) => text.includes(`\n${name}@${version}  (`);

/** The notice text under the package's heading, or undefined when there is no heading. */
function sectionOf(name, version) {
  const rule = "=".repeat(78);
  const heading = `${rule}\n${name}@${version} - `;
  const at = text.indexOf(heading);
  if (at < 0) return undefined;
  const bodyStart = text.indexOf(`\n${rule}\n`, at + heading.length);
  if (bodyStart < 0) return undefined;
  const from = bodyStart + rule.length + 2;
  const next = text.indexOf(`${rule}\n`, from);
  return text.slice(from, next < 0 ? undefined : next).trim();
}

const PLACEHOLDER =
  /^\((licence text not found|the package ships no licence file)/;
function requireNotice(name, version, why) {
  if (!listed(name, version)) {
    problems.push(`${name}@${version} (${why}) is not listed in the notices`);
    return;
  }
  const body = sectionOf(name, version);
  if (!body)
    problems.push(`${name}@${version} (${why}) has no licence section`);
  else if (PLACEHOLDER.test(body))
    problems.push(`${name}@${version} (${why}) has no licence text: ${body}`);
}

const webDirectory = join(directory, "_web");
const records = existsSync(webDirectory)
  ? readdirSync(webDirectory).filter((name) =>
      /^bundled-packages-.+\.json$/.test(name),
    )
  : [];
const recorded = new Map(); // build -> Set of names
for (const file of records) {
  const record = JSON.parse(readFileSync(join(webDirectory, file), "utf8"));
  if (record.schema !== 1 || !Array.isArray(record.packages)) {
    problems.push(`${file} is not a schema 1 bundled-packages record`);
    continue;
  }
  recorded.set(
    record.build,
    new Set(record.packages.map((entry) => entry.name)),
  );
  for (const { name, version } of record.packages)
    requireNotice(name, version, `bundled in the ${record.build} build`);
}
if (!recorded.has("app"))
  problems.push(
    "_web/bundled-packages-app.json is missing: the build did not record what it bundled",
  );

const worker = join(directory, "sw.js");
if (existsSync(worker)) {
  const code = readFileSync(worker, "utf8");
  if (!recorded.has("service-worker"))
    problems.push(
      "sw.js is present but _web/bundled-packages-service-worker.json is missing",
    );
  const markers = new Set(
    [...code.matchAll(/workbox:([a-z-]+):\d/g)].map((match) => match[1]),
  );
  if (markers.size === 0)
    problems.push(
      "sw.js carries no Workbox version markers: the marker scan has stopped detecting Workbox",
    );
  for (const marker of markers) {
    const name = `workbox-${marker}`;
    if (!recorded.get("service-worker")?.has(name))
      problems.push(
        `${name} is compiled into sw.js but is not in the service-worker record`,
      );
    // Found in the notices themselves, so this check does not lean on the record it is cross-checking.
    const versions = [
      ...text.matchAll(new RegExp(`^${name}@(\\S+)  \\(`, "gm")),
    ].map((match) => match[1]);
    if (versions.length === 0)
      problems.push(
        `${name} is compiled into sw.js but is not listed in the notices`,
      );
    for (const version of versions)
      requireNotice(name, version, "compiled into sw.js");
  }
}

if (problems.length > 0) {
  console.error(
    `Third-party notices are incomplete for ${directory}:\n - ${problems.join("\n - ")}`,
  );
  process.exit(1);
}
const count = [...recorded.values()].reduce(
  (sum, names) => sum + names.size,
  0,
);
console.log(
  `Notices complete for ${directory}: ${count} bundled packages (${records.join(", ")}), each with its licence text.`,
);
