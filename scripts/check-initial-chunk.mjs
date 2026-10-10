#!/usr/bin/env node
// S-2 (WEB-09a). Dexie and the data layer's engines must not be in the INITIAL chunk: the boot path gains only the small static
// deletion-port shims (plan 5.3.1). Usage: check-initial-chunk.mjs [dist]. Fails on any finding.
import { checkInitialChunk } from "./lib/initial-chunk.mjs";

const root = process.argv[2] ?? "dist";
const findings = checkInitialChunk(root);
if (findings.length > 0) {
  console.error(`Initial chunk check FAILED (${root}):`);
  for (const finding of findings) console.error(` - ${finding}`);
  process.exit(1);
}
console.log(`Initial chunk ok (${root}): no Dexie, no engine, no plan.`);
