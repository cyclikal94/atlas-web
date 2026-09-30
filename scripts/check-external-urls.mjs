#!/usr/bin/env node
// A2/B9. Nothing may load from off the origin (fonts included). Scans the built output and fails on:
//  - any src/href/@import/url() that is not same-origin;
//  - any other absolute http(s) URL in a shipped file, unless it is a known inert string (an XML namespace, or a
//    documentation link inside a library's error message) listed below with the reason.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

const root = process.argv[2] ?? "dist";
const INERT = [
  {
    pattern: /^https?:\/\/www\.w3\.org\//,
    reason: "XML/SVG namespace identifier, never fetched",
  },
  {
    pattern: /^https:\/\/react\.dev\/errors/,
    reason: "documentation link inside a React error message, never fetched",
  },
  {
    pattern: /^https:\/\/reactjs\.org\//,
    reason: "documentation link inside a React message, never fetched",
  },
  {
    pattern: /^https:\/\/tailwindcss\.com$/,
    reason: "licence banner comment in the generated stylesheet, never fetched",
  },
  {
    pattern: /^https:\/\/bit\.ly\/wb-precache$/,
    reason:
      "documentation link inside a Workbox warning message, never fetched",
  },
];
// Text files (.txt) are not scanned: the third-party notices are licence prose full of project URLs and are never loaded by the client.
const TEXT = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".svg",
  ".webmanifest",
]);
const findings = [];
const inert = [];

function scan(file, text) {
  for (const match of text.matchAll(
    /(?:src|href|action|poster|data)=["'](?!#)([^"']+)["']/g,
  )) {
    if (/^(?:https?:)?\/\//.test(match[1]))
      findings.push(`${file}: attribute points off-origin: ${match[1]}`);
  }
  for (const match of text.matchAll(/@import\s+(?:url\()?["']?([^"')\s]+)/g)) {
    if (/^(?:https?:)?\/\//.test(match[1]))
      findings.push(`${file}: @import off-origin: ${match[1]}`);
  }
  for (const match of text.matchAll(
    /url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/g,
  ))
    findings.push(`${file}: url() off-origin: ${match[1]}`);
  for (const match of text.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
    const url = match[0];
    const known = INERT.find((item) => item.pattern.test(url));
    if (known) inert.push({ file, url, reason: known.reason });
    else if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)/.test(url))
      findings.push(`${file}: absolute URL: ${url}`);
  }
}
function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (TEXT.has(extname(entry))) scan(full, readFileSync(full, "utf8"));
  }
}
walk(root);
mkdirSync(".agtx/evidence/WEB-07/A2", { recursive: true });
writeFileSync(
  `.agtx/evidence/WEB-07/A2/external-urls-${root.replaceAll("/", "_")}.json`,
  `${JSON.stringify({ root, findings, inert }, null, 2)}\n`,
);
if (findings.length > 0) {
  console.error(
    `Off-origin references in ${root}:\n - ${findings.join("\n - ")}`,
  );
  process.exit(1);
}
console.log(
  `No off-origin references in ${root} (${inert.length} inert strings, listed in the evidence file).`,
);
