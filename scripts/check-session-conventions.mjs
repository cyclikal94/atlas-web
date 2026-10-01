#!/usr/bin/env node
// Lint rules R7 to R12 (docs/lint-rules.md): the session module's conventions. Run by `pnpm lint`. SYNTACTIC: see the header
// of scripts/lib/session-conventions.mjs for what it can and cannot see.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTree, format } from "./lib/session-conventions.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const diagnostics = checkTree(root);
if (diagnostics.length > 0) {
  for (const d of diagnostics) console.error(format(d));
  console.error(
    `\n${diagnostics.length} session convention violation(s) (docs/lint-rules.md, R7 to R12)`,
  );
  process.exit(1);
}
console.log("session conventions R7 to R12: clean");
