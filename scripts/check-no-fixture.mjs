#!/usr/bin/env node
// B12. Fixture code must never reach an artefact. Fails when a directory, a .tar.gz archive or an image filesystem export
// contains fixture.html, the fixture entry path, or the ATLAS_FIXTURE_ONLY marker.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const MARKERS = [
  "ATLAS_FIXTURE_ONLY",
  "/src/fixture/",
  "ControlsGallery",
  "__atlasFixture",
];
const findings = [];

function scanBuffer(label, buffer) {
  const text = buffer.toString("latin1");
  for (const marker of MARKERS)
    if (text.includes(marker)) findings.push(`${label}: contains "${marker}"`);
}
function scanName(label) {
  if (
    /(^|\/)fixture\.html$/.test(label) ||
    /(^|\/)dist-fixture(\/|$)/.test(label)
  )
    findings.push(`${label}: fixture file`);
}
function walk(directory, prefix = "") {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const label = `${prefix}${entry}`;
    if (statSync(full).isDirectory()) {
      scanName(label);
      walk(full, `${label}/`);
    } else {
      scanName(label);
      scanBuffer(label, readFileSync(full));
    }
  }
}
function scanTar(label, tar) {
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const size = Number.parseInt(
      header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() ||
        "0",
      8,
    );
    const full = prefix ? `${prefix}/${name}` : name;
    scanName(`${label}!${full}`);
    if (size > 0)
      scanBuffer(
        `${label}!${full}`,
        tar.subarray(offset + 512, offset + 512 + size),
      );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: check-no-fixture.mjs <directory|archive.tar.gz>...");
  process.exit(2);
}
for (const target of targets) {
  const stat = statSync(target);
  if (stat.isDirectory()) walk(target, `${target}/`);
  else
    scanTar(
      target,
      target.endsWith(".gz") || target.endsWith(".tgz")
        ? gunzipSync(readFileSync(target))
        : readFileSync(target),
    );
}
if (findings.length > 0) {
  console.error(
    `Fixture code found in an artefact:\n - ${findings.join("\n - ")}`,
  );
  process.exit(1);
}
console.log(`No fixture code in: ${targets.join(", ")}`);
