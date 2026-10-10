// The initial chunk of a built client: what the browser fetches before anything else (the entry script and every modulepreload).
// Shared by `check-initial-chunk.mjs` and its test, so the check that runs on a real build is the one the test proves can fail.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Strings that identify code which must never be fetched before the protected tree is needed (WEB-09a plan 3.4, 5.3.1). */
export const FORBIDDEN = [
  {
    why: "Dexie (the account database library) belongs to the protected-tree chunk",
    // Library signatures, not file names: the entry legitimately NAMES the lazy chunk it loads.
    patterns: ["DexieError", "Dexie.js", "PrematureCommitError"],
  },
  {
    why: "the sync engine, the outbox dispatcher and the transaction plans are not part of the boot path",
    patterns: [
      "data.commitPage",
      "data.enqueueDraft",
      "data.markInFlight",
      "data.captureRequest",
    ],
  },
];

/** The relative paths of the scripts `index.html` loads eagerly. */
export function initialScripts(html) {
  return [
    ...html.matchAll(
      /<(?:script[^>]*type="module"[^>]*src|link[^>]*rel="modulepreload"[^>]*href)="([^"]+)"/g,
    ),
  ].map((m) => m[1].replace(/^\//, ""));
}

/** Findings for one build directory: an empty list means the initial chunk is clean. */
export function checkInitialChunk(root) {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const findings = [];
  const scripts = initialScripts(html);
  if (scripts.length === 0)
    findings.push(`${root}/index.html loads no script: nothing was checked`);
  for (const script of scripts) {
    const text = readFileSync(join(root, script), "latin1");
    for (const rule of FORBIDDEN)
      for (const pattern of rule.patterns)
        if (text.includes(pattern))
          findings.push(`${script} contains "${pattern}": ${rule.why}`);
  }
  return findings;
}
