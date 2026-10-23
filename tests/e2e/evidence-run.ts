import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FullConfig, TestInfo } from "@playwright/test";

const DEFAULT_PARENT = ".agtx/evidence/browser";
let fallback: string | undefined;

/** Allocate once in the controller; global setup passes this to all workers. */
export function newEvidenceRun(): string {
  const parent = resolve(process.env.ATLAS_EVIDENCE_DIR ?? DEFAULT_PARENT);
  mkdirSync(join(parent, "runs"), { recursive: true });
  const directory = mkdtempSync(join(parent, "runs", "run-"));
  writeFileSync(
    join(directory, "run.json"),
    `${JSON.stringify({ schema: 1, startedAt: new Date().toISOString(), pid: process.pid, note: "Allocation only; not a passing test result." }, null, 2)}\n`,
    { flag: "wx" },
  );
  return directory;
}

/** Config executes before Playwright deletes --output; reserve it here, not in setup. */
export function configureEvidenceRun(argv = process.argv): string {
  if (process.env.TEST_WORKER_INDEX !== undefined) return evidenceRun();
  if (!argv.includes("--list")) {
    if (
      argv.filter((arg) => arg === "--output" || arg.startsWith("--output="))
        .length > 1
    )
      throw new Error(
        "Supply --output only once; each invocation requires its own directory",
      );
    const separate = argv.indexOf("--output");
    const attached = argv.find((arg) => arg.startsWith("--output="));
    const selected =
      attached?.slice("--output=".length) ??
      (separate < 0 ? undefined : argv[separate + 1]);
    if (selected !== undefined) {
      if (!selected || selected.startsWith("--"))
        throw new Error("Missing --output directory");
      const output = resolve(selected);
      if (
        existsSync(output) &&
        (lstatSync(output).isSymbolicLink() ||
          !lstatSync(output).isDirectory() ||
          readdirSync(output).length)
      )
        throw new Error(
          `Refusing to replace existing Playwright output: ${output}`,
        );
      mkdirSync(dirname(output), { recursive: true });
      mkdirSync(`${output}.atlas-evidence-claim`);
    }
  }
  return newEvidenceRun();
}

/**
 * WEB-08d revision 26 (review r25 R25-N1): the runtime this Playwright run is, as its own process sees it. The config records it in the
 * report's metadata (`atlasRuntime`), so held-operation evidence can check the runtime its applicability record names against the one
 * that actually ran (scripts/validation/held-operation-applicability.mjs witnessProblems). Metadata only: it selects and changes nothing.
 */
export function runtimeWitness() {
  const version: unknown = createRequire(import.meta.url)(
    "@playwright/test/package.json",
  ).version;
  return {
    node: process.version,
    exec_path: process.execPath,
    platform: process.platform,
    arch: process.arch,
    playwright: String(version),
  };
}

export default function setupEvidenceRun(config: FullConfig): void {
  const directory = config.metadata.atlasEvidenceRun;
  if (typeof directory !== "string" || !isAbsolute(directory))
    throw new Error("Missing browser evidence run directory");
  process.env.ATLAS_EVIDENCE_RUN_DIR = directory;
  console.log(`Browser evidence: ${directory}`);
}

export function evidenceRun(): string {
  // Custom/older configurations without global setup still get fresh worker
  // directories. Never fall back to a shared historical evidence destination.
  if (process.env.ATLAS_EVIDENCE_RUN_DIR)
    return process.env.ATLAS_EVIDENCE_RUN_DIR;
  fallback ??= newEvidenceRun();
  return fallback;
}

function component(value: string): string {
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

export function testEvidenceDirectory(info: TestInfo): string {
  return join(
    evidenceRun(),
    component(info.project.name),
    `${component(info.testId)}-repeat${info.repeatEachIndex}-retry${info.retry}`,
  );
}

/** Exclusive creation also protects against two writers choosing the same key. */
export function writeEvidence(
  info: TestInfo,
  name: string,
  data: unknown,
): void {
  const directory = testEvidenceDirectory(info);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${component(name)}.json`),
    `${JSON.stringify(data, null, 2)}\n`,
    { flag: "wx" },
  );
}

/** Reserve an exclusive directory before an API such as screenshot writes. */
export function claimEvidencePath(info: TestInfo, name: string): string {
  if (
    !name ||
    isAbsolute(name) ||
    name.split(/[\\/]/).some((part) => part === ".." || part === ".")
  )
    throw new Error("Evidence names must be relative without traversal");
  const claim = join(
    testEvidenceDirectory(info),
    `${component(name)}.artifact`,
  );
  mkdirSync(dirname(claim), { recursive: true });
  mkdirSync(claim); // EEXIST is intentional: never replace an earlier artefact.
  return join(claim, basename(name));
}
