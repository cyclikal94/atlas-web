#!/usr/bin/env node
// Generates THIRD-PARTY-NOTICES.txt for what this distribution actually contains, and fails on any licence that is not on
// the reviewed list. Two sources are combined:
//  - the packages the build itself recorded as bundled into the output (dist/_web/bundled-packages-*.json, written by the
//    bundler's module graph for the application and, separately, for the service worker: build/bundled-packages.ts). This
//    is what makes the notices complete: Vite compiles every imported package into the output whatever package.json calls
//    it, and the Workbox packages that make up sw.js are devDependencies;
//  - the declared production dependencies (`pnpm licenses --prod`), so nothing the project declares as shipped can drop out.
// `pnpm licenses` gives the licence and install path of each installed package; the licence text is read from the package.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const out = process.argv[2] ?? "dist/_web/third-party-notices.txt";
const recordsDirectory = dirname(out);
// Reviewed, compatible with AGPL-3.0-only distribution of the client. Anything else fails until reviewed.
const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense", // public-domain dedication (isbot, used by the router)
  "OFL-1.1",
  "AGPL-3.0-only", // @atlas/api-types: this project's own backend contract types
]);

function licences(...flags) {
  return JSON.parse(
    execFileSync("pnpm", ["licenses", "list", ...flags, "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

/** name@version -> { name, version, license, path } for every entry of a `pnpm licenses` listing. */
function indexed(listing) {
  const index = new Map();
  for (const [license, entries] of Object.entries(listing)) {
    for (const entry of entries) {
      for (const [position, path] of entry.paths.entries()) {
        const version = entry.versions[position] ?? entry.versions[0];
        index.set(`${entry.name}@${version}`, {
          name: entry.name,
          version,
          license,
          path,
        });
      }
    }
  }
  return index;
}

const records = existsSync(recordsDirectory)
  ? readdirSync(recordsDirectory).filter((name) =>
      /^bundled-packages-.+\.json$/.test(name),
    )
  : [];
if (!records.includes("bundled-packages-app.json")) {
  console.error(
    `No bundled-package record in ${recordsDirectory} (expected bundled-packages-app.json from the build): run pnpm build first, ` +
      "so the notices describe the files they ship beside.",
  );
  process.exit(1);
}

// Every installed package (development dependencies included, because Vite bundles some of them), then the two selections.
const installed = indexed(licences());
const wanted = new Map(); // name@version -> entry
for (const [key, entry] of indexed(licences("--prod"))) wanted.set(key, entry);
const unknown = [];
for (const record of records) {
  const { packages: bundled } = JSON.parse(
    readFileSync(join(recordsDirectory, record), "utf8"),
  );
  for (const { name, version } of bundled) {
    const entry = installed.get(`${name}@${version}`);
    if (entry) wanted.set(`${name}@${version}`, entry);
    else unknown.push(`${name}@${version} (recorded in ${record})`);
  }
}
if (unknown.length > 0) {
  console.error(
    `Bundled packages that pnpm cannot find installed (stale build output?):\n - ${unknown.join("\n - ")}`,
  );
  process.exit(1);
}
const packages = [...wanted.values()];
const rejected = packages
  .filter((entry) => !ALLOWED.has(entry.license))
  .map((entry) => `${entry.name}@${entry.version}: ${entry.license}`);
if (rejected.length > 0) {
  console.error(
    `Licences not on the reviewed list:\n - ${rejected.join("\n - ")}`,
  );
  process.exit(1);
}
packages.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);

function licenceText(path) {
  if (!existsSync(path))
    return "(licence text not found in the installed package)";
  const file = readdirSync(path).find((name) =>
    /^(licen[cs]e|copying)(\.|$)/i.test(name),
  );
  return file
    ? readFileSync(join(path, file), "utf8").trim()
    : "(the package ships no licence file; its licence is stated in its package.json)";
}

const sections = [
  "Atlas Web third-party notices",
  "",
  "Atlas Web itself is licensed under AGPL-3.0-only (see LICENSE). It includes the following third-party software: every",
  "package the build bundled into the application and the service worker (including the Workbox packages compiled into",
  "sw.js), and the declared production dependencies. Geist and Geist Mono are licensed under the SIL Open Font License 1.1.",
  "",
  ...packages.map((p) => `${p.name}@${p.version}  (${p.license})`),
  "",
];
const seen = new Map(); // licence text -> the first package that carries it in full
for (const p of packages) {
  const text = licenceText(p.path);
  const key = `${p.license}\n${text}`;
  const first = seen.get(key);
  sections.push(
    "=".repeat(78),
    `${p.name}@${p.version} - ${p.license}`,
    "=".repeat(78),
    first ? `(same licence text as ${first}, in full above)` : text,
    "",
  );
  if (!first) seen.set(key, `${p.name}@${p.version}`);
}
mkdirSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
writeFileSync(out, `${sections.join("\n")}\n`);
console.log(
  `Wrote ${out}: ${packages.length} packages (bundled: ${records.join(", ")}; plus declared production dependencies), all on the reviewed licence list.`,
);
