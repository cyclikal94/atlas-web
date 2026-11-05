#!/usr/bin/env node
// Writes the recorded SHA-256 of every profiling workload (plan 7.3, H3) to scripts/lib/profile-workload-hashes.json, and copies the
// generator source and the hashes into `<dir>/fixtures` (WEB-09c plan 4.1: the directory is the caller's, there is no default, and an
// existing one is refused). `--check` verifies the recorded hashes against the generators and changes nothing.
//
//   node scripts/generate-profile-fixtures.mjs --out <dir> | --check
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allWorkloads,
  countNodes,
  sha256Hex,
  WORKLOAD_VERSION,
} from "./lib/profile-workloads.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recorded = join(root, "scripts/lib/profile-workload-hashes.json");
const check = process.argv.includes("--check");
const outAt = process.argv.indexOf("--out");
const outArg = outAt >= 0 ? process.argv[outAt + 1] : undefined;
if (!check && (!outArg || outArg.startsWith("--"))) {
  console.error(
    "usage: node scripts/generate-profile-fixtures.mjs --out <dir> | --check (there is no default directory)",
  );
  process.exit(2);
}
const out = check ? null : join(resolve(root, outArg), "fixtures");
if (out && existsSync(out)) {
  console.error(
    `refused: ${out} already exists; use a fresh directory (nothing was changed)`,
  );
  process.exit(2);
}

const workloads = [];
for (const { name, body } of allWorkloads()) {
  let nodes = null;
  try {
    nodes = countNodes(JSON.parse(body));
  } catch {
    nodes = null; // a malformed negative control has no node count
  }
  workloads.push({
    name,
    bytes: new TextEncoder().encode(body).length,
    nodes,
    sha256: await sha256Hex(body),
  });
}
const next = { version: WORKLOAD_VERSION, workloads };

if (check) {
  const have = JSON.parse(readFileSync(recorded, "utf8"));
  const same = JSON.stringify(have) === JSON.stringify(next);
  console.log(
    same
      ? `profiling workload hashes match (${workloads.length} workloads)`
      : "profiling workload hashes DO NOT match the generators",
  );
  process.exit(same ? 0 : 1);
}

writeFileSync(recorded, `${JSON.stringify(next, null, 2)}\n`);
mkdirSync(out, { recursive: true });
copyFileSync(
  join(root, "scripts/lib/profile-workloads.mjs"),
  join(out, "profile-workloads.mjs"),
);
writeFileSync(join(out, "hashes.json"), `${JSON.stringify(next, null, 2)}\n`);
console.log(`wrote ${workloads.length} workload hashes to ${recorded}`);
for (const w of workloads)
  console.log(
    `${w.name.padEnd(22)} ${String(w.bytes).padStart(9)} B  ${String(w.nodes ?? "-").padStart(8)} nodes  ${w.sha256.slice(0, 16)}`,
  );
