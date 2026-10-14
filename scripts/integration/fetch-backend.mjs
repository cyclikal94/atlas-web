#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Part C (plan 14.2): fetch the RELEASED backend binary for this machine, verify it against the release's published SHA256SUMS,
// and print the path of the extracted executable. Never a binary built from the adjacent repository. Read-only against the public
// release of cyclikal94/atlas; nothing is installed and no dependency is added. The extracted release is published once into
// <dir>/<target>-<checksum prefix>/ and never rewritten (scripts/integration/release-cache.mjs), so concurrent runs cannot overwrite
// an executable another run is using.
//
//   node scripts/integration/fetch-backend.mjs [--dir <dir>]      (default: $TMPDIR/atlas-integration-backend)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publish, writeAtomic } from "./release-cache.mjs";

// The repository's pin (a qualification run of a COPY of these scripts names the repository: ATLAS_INTEGRATION_TOOLS_ROOT).
const pin = JSON.parse(
  readFileSync(
    process.env.ATLAS_INTEGRATION_TOOLS_ROOT
      ? join(process.env.ATLAS_INTEGRATION_TOOLS_ROOT, "contract-pin.json")
      : new URL("../../contract-pin.json", import.meta.url),
    "utf8",
  ),
);
const TAG = pin.backend_tag;
const BASE = `https://github.com/cyclikal94/atlas/releases/download/${TAG}`;
const targets = {
  "darwin arm64": "aarch64-apple-darwin",
  "linux arm64": "aarch64-unknown-linux-gnu",
  "linux x64": "x86_64-unknown-linux-gnu",
};
const key = `${process.platform} ${process.arch}`;
const target = targets[key];
if (!target) {
  console.error(
    `No released native archive for ${key} (available: ${Object.values(targets).join(", ")}).`,
  );
  process.exit(2);
}
const dirFlag = process.argv.indexOf("--dir");
const dir =
  dirFlag > 0
    ? process.argv[dirFlag + 1]
    : join(process.env.TMPDIR ?? tmpdir(), "atlas-integration-backend");
mkdirSync(dir, { recursive: true });

async function download(name) {
  const response = await fetch(`${BASE}/${name}`, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${name}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const archiveName = `atlas-${target}.tar.gz`;
const sums = (await download("SHA256SUMS")).toString("utf8");
const line = sums.split("\n").find((l) => l.trim().endsWith(archiveName));
if (!line) throw new Error(`SHA256SUMS has no entry for ${archiveName}`);
const expected = line.trim().split(/\s+/)[0];
const archivePath = join(dir, archiveName);
let archive;
if (
  existsSync(archivePath) &&
  createHash("sha256").update(readFileSync(archivePath)).digest("hex") ===
    expected
) {
  archive = readFileSync(archivePath);
} else {
  archive = await download(archiveName);
  writeAtomic(archivePath, archive);
}
const actual = createHash("sha256").update(archive).digest("hex");
if (actual !== expected) {
  console.error(
    `CHECKSUM MISMATCH for ${archiveName}: expected ${expected}, got ${actual}`,
  );
  process.exit(1);
}
const listing = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
  .stdout.split("\n")
  .filter(Boolean);
const entry =
  listing.find((name) => /(^|\/)atlas(-server)?$/.test(name)) ??
  listing.find((name) => !name.endsWith("/"));
const release = publish({
  dir,
  key: `${target}-${expected.slice(0, 16)}`,
  fill: (staging) => {
    const extract = spawnSync("tar", ["-xzf", archivePath, "-C", staging], {
      stdio: "inherit",
    });
    if (extract.status !== 0)
      throw new Error(`tar -xzf ${archivePath} failed (${extract.status})`);
  },
});
console.log(
  JSON.stringify({
    tag: TAG,
    archive: archiveName,
    sha256: actual,
    verified_against: "SHA256SUMS",
    dir: release.path,
    reused: release.reused,
    binary: join(release.path, entry ?? ""),
  }),
);
