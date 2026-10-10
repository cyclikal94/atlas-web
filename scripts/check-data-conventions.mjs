#!/usr/bin/env node
// Lint rules R13 to R18 (docs/lint-rules.md): the data layer's conventions. Run by `pnpm lint`. SYNTACTIC: see the header of
// scripts/lib/data-conventions.mjs for what it can and cannot see.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTree, format } from "./lib/data-conventions.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const diagnostics = checkTree(root);
if (diagnostics.length > 0) {
  for (const d of diagnostics) console.error(format(d));
  console.error(
    `\n${diagnostics.length} data convention violation(s) (docs/lint-rules.md, R13 to R18)`,
  );
  process.exit(1);
}
console.log("data conventions R13 to R18: clean");
