// The production receive path's verdict on a `/sync` body, for the profiling tooling (WEB-09c revision 5; review 5 R2, design assessment
// DA-E1/DA-E2, A1). The W2 capture observer (scripts/lib/profile-w2-capture.mjs) certified a PARSED projection of the bytes: `JSON.parse`
// had already collapsed duplicate page and batch keys, re-spelt a revision written `12e0` as 12 and (through the decoder) dropped a byte
// order mark, and the production gates on nesting, element size and element nodes were never applied. Production refuses all of these.
//
// So the observer no longer restates the structural contract: it asks the candidate's OWN modules. This file loads, once, at import time,
// `src/data/scan/scan.ts` (pass 1: the byte scan), `src/data/scan/validate.ts` (pass 2: every element's decoder and its byte/node gates)
// and `src/data/model/config.ts` (the configuration and the response-body bound) from the repository this file belongs to (a mutated copy
// reads its own sources), through Vite's module runner (no server, no watcher, no application plugins). The verdict is synchronous.
//
// It fails closed: a module that cannot be loaded, or a production decode composition this reader does not reproduce, throws at import,
// so every caller (the integration writer, the evidence contract, both validator modes, the tests) stops before it can certify anything.
// There is no flag that turns it off and no fallback.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

/** The repository whose production modules are loaded: the one this file is in. */
export const CANDIDATE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const PRODUCTION_MODULES = Object.freeze({
  scan: "src/data/scan/scan.ts",
  validate: "src/data/scan/validate.ts",
  config: "src/data/model/config.ts",
});
/** The browser composition whose decode dependencies the reader reproduces. */
const COMPOSITION = "src/data/ui/browser-leader.ts";

async function load(rel) {
  try {
    const { module } = await runnerImport(join(CANDIDATE_ROOT, rel), {
      root: CANDIDATE_ROOT,
      configFile: false,
      logLevel: "silent",
    });
    return module;
  } catch (error) {
    throw new Error(
      `the production page reader cannot load ${rel} from ${CANDIDATE_ROOT}: ${String(error?.message ?? error).slice(0, 300)}`,
    );
  }
}

/** Every production source file (fixture code excluded), relative to the root. */
function productionSources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(CANDIDATE_ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (rel === "src/fixture") continue;
      if (statSync(join(CANDIDATE_ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
    }
  };
  walk("src");
  return out;
}

/**
 * The decode dependencies the production leader gives the engine (`decode` in browser-leader.ts): today two EMPTY registries, so every
 * value kind is accepted and no key is derived. A feature that registers a value validator would change what production refuses; the
 * reader cannot know such a validator, so it refuses to start instead of certifying with less than production checks.
 */
function compositionProblem() {
  let text;
  try {
    text = readFileSync(join(CANDIDATE_ROOT, COMPOSITION), "utf8");
  } catch (error) {
    return `${COMPOSITION} cannot be read: ${error.message}`;
  }
  if (
    !/decode:\s*\{\s*validators:\s*createValueValidators\(\),\s*derivers:\s*createKeyDerivers\(\),\s*\}/.test(
      text,
    )
  )
    return `${COMPOSITION} no longer composes the engine's decode dependencies as two fresh registries`;
  const users = productionSources().filter((rel) => {
    if (rel === PRODUCTION_MODULES.validate || rel === COMPOSITION)
      return false;
    return /\b(createValueValidators|createKeyDerivers|ValueValidatorRegistry)\b/.test(
      readFileSync(join(CANDIDATE_ROOT, rel), "utf8"),
    );
  });
  if (users.length)
    return `production code outside ${COMPOSITION} reaches the value-validator registries (${users.join(", ")}): a registered validator would refuse what this reader admits`;
  if (/\.register\(/.test(text))
    return `${COMPOSITION} registers something on its registries`;
  return null;
}

const [scanModule, validateModule, configModule] = await Promise.all([
  load(PRODUCTION_MODULES.scan),
  load(PRODUCTION_MODULES.validate),
  load(PRODUCTION_MODULES.config),
]);
const { scanSyncPage } = scanModule;
const { decodeChange, createValueValidators, createKeyDerivers, PageInvalid } =
  validateModule;
const { DATA_CONFIG, maxResponseBytesFor } = configModule;
for (const [name, value] of Object.entries({
  scanSyncPage,
  decodeChange,
  createValueValidators,
  createKeyDerivers,
  PageInvalid,
  maxResponseBytesFor,
}))
  if (typeof value !== "function")
    throw new Error(
      `the production page reader found no ${name} in the candidate's modules`,
    );
if (!DATA_CONFIG || typeof DATA_CONFIG !== "object")
  throw new Error("the production page reader found no DATA_CONFIG");
const composition = compositionProblem();
if (composition)
  throw new Error(`the production page reader cannot start: ${composition}`);

/** The configuration the reader applied (the candidate's DATA_CONFIG, loaded with the modules). */
export const PRODUCTION_CONFIG = DATA_CONFIG;

/**
 * What the production receive path (the engine's `applyPage`, then the page commit) says of `bytes` read with `limit`: null when it would
 * accept every byte of them, else why not, in the production modules' own closed vocabulary. In order: the response-body bound for the
 * limit (`maxResponseBytesFor`), the byte scan (`scanSyncPage` with DATA_CONFIG: JSON syntax and no byte order mark, the page and batch
 * keys each exactly once, plain non-negative integer revisions, nesting, batch and change counts, the cursor), then EVERY element through
 * `decodeChange` with the production composition's decode dependencies (each element's byte span and node count, its decoding, envelope
 * and projection). Whether the page is a DELTA page is the caller's (the engine refuses a snapshot page on the delta path; the observer
 * names that itself). An allocation failure or any other unexpected error is thrown, never reported as a property of the bytes.
 */
export function productionRefusal(bytes, { limit }) {
  // By tag, not `instanceof`: a test environment's TextEncoder can return another realm's Uint8Array (a Buffer is one too).
  if (Object.prototype.toString.call(bytes) !== "[object Uint8Array]")
    return "the capture is not a byte sequence";
  if (!Number.isSafeInteger(limit) || limit < 1)
    return `the page limit ${JSON.stringify(limit)} is not a positive integer`;
  const ceiling = maxResponseBytesFor(limit, DATA_CONFIG);
  if (bytes.length > ceiling)
    return `the production engine refuses the capture as oversize: ${bytes.length} bytes, above the ${ceiling}-byte response bound for limit ${limit}`;
  const scan = scanSyncPage(bytes, DATA_CONFIG);
  if (!scan.ok)
    return `the production scanner refuses the capture (${scan.stage}: ${scan.reason}, at byte ${scan.offset})`;
  const deps = {
    validators: createValueValidators(),
    derivers: createKeyDerivers(),
  };
  for (const [b, batch] of scan.batches.entries())
    for (let j = 0; j < batch.count; j += 1) {
      const index = batch.first + j;
      try {
        decodeChange(
          bytes,
          scan.elements[index * 2],
          scan.elements[index * 2 + 1],
          scan.nodes[index],
          deps,
        );
      } catch (error) {
        if (error instanceof PageInvalid)
          return `the production decoder refuses batch ${b + 1} change ${j + 1} (${error.stage}: ${error.reason})`;
        throw error;
      }
    }
  return null;
}

/** The files the reader's verdict depends on, relative to the root (for provenance records). */
export const PRODUCTION_INPUTS = Object.freeze([
  ...Object.values(PRODUCTION_MODULES),
  COMPOSITION,
]);
