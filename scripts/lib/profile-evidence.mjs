// Where the sync-profiling programme writes, and what it refuses (WEB-09c plan 4.1). The evidence key is still `WEB-09a:sync-profiling`;
// WEB-09c owns it. Every run writes into a directory the caller names, and nothing here ever deletes: an earlier run's files are evidence.
//
// A programme is several invocations into ONE directory (`--only bundle,fixture`, then `contention`, then `integration`, then `handoff`),
// so the refusal is per stage: a stage that has already been recorded in the directory (its stage record, or its own output) is refused,
// and the caller must use a fresh directory. The measurement files `measurements.jsonl` and `values.jsonl` are shared and only appended to.
//
// One writer at a time (revision 2, design assessment DA-2): an invocation first CLAIMS the directory by creating `writer.lock`
// exclusively (the file system refuses a second creation, so two invocations can never both pass), and only then checks which stages are
// recorded. The nested contention driver runs under its parent's claim (`ATLAS_PROFILE_CLAIM`). A finished invocation releases its claim
// into `writers/`; an interrupted one leaves it, so the directory is refused from then on and its evidence stays as it was for diagnosis.
// Each stage record is SEALED when its action ends: its action interval (inside the load sampler's first and last samples), the sampler's
// state, and the line ranges of the shared files its rows occupy.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { loadavg } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fingerprint } from "../validation/runtime.mjs";

export const EVIDENCE_KEY = "WEB-09a:sync-profiling";
export const EVIDENCE_OWNER = "WEB-09c";
/**
 * The version of the evidence contract (scripts/lib/profile-contract.mjs) a stage was recorded under. Version 2 (WEB-09c revision 3,
 * review 3 R2): the contents of every observation and the support its derived figures are recomputed from (P-Q2's initial and ledger
 * readings, P-8's trace support, P-13's observed hints and transactions, memory and heap samples, W2's seeded person) are required, so
 * version 1 evidence is historical and resolves incomplete; it is never rewritten.
 */
export const CONTRACT_VERSION = 2;
export const CLAIM_FILE = "writer.lock";
/** The files every stage appends rows to; a sealed stage records which lines are its own. */
export const SHARED_ROWS = [
  "measurements.jsonl",
  "values.jsonl",
  "collection.jsonl",
];

/** Every BE-B1 item (1 to 7) and BE-Q23 row (M0 to M9) the hand-over's consumer map must answer, with a status, evidence and owner. */
export const CONSUMER_KEYS = [
  "BE-B1:1 provenance",
  "BE-B1:2 real devices, named",
  "BE-B1:3 workloads with bytes, nodes and changes",
  "BE-B1:4 multi-tab on every class",
  "BE-B1:5 metrics per run",
  "BE-B1:6 derived values",
  "BE-B1:7 format",
  "BE-Q23:M0 provenance",
  "BE-Q23:M1 roster",
  "BE-Q23:M2 method",
  "BE-Q23:M3 fixtures",
  "BE-Q23:M4 granularity sweep",
  "BE-Q23:M5 multi-tab scenarios",
  "BE-Q23:M6 bounded processing as built",
  "BE-Q23:M7 cost of finer requests",
  "BE-Q23:M8 smallest unprocessable response",
  "BE-Q23:M9 derived values",
];
/**
 * The rows that ask for real devices: on a desktop record they are never `measured`. Revision 6 (review 6 R7, STAGED-ACCEPTANCE-20261011):
 * a current hand-over marks them `transferred` (to WEB-09d, not run); `escalated` is OD-1's status of 10 October 2026, kept so that the
 * vocabulary still reads the hand-overs written before it.
 */
export const DEVICE_KEYS = ["BE-B1:2 real devices, named", "BE-Q23:M1 roster"];
export const CONSUMER_STATUSES = [
  "measured",
  "partial",
  "not_run",
  "escalated",
  "transferred",
];

/**
 * What each stage writes of its own (besides appending rows to the shared measurement files and the collection log). Every measuring stage
 * also writes its load samples, `isolation/<stage>.jsonl` (scripts/lib/profile-isolation.mjs). `device` is the device page's protocol on
 * the desktop engines, W2 included: it reads the integration stage's captures, so it runs after it.
 */
export const STAGE_OUTPUTS = {
  bundle: ["bundle", "bundle-delta.json"],
  fixture: ["raw", "memory", "fixture-build.json"],
  shell: ["shell"],
  contention: ["contention"],
  integration: ["integration-run", "w2"],
  device: ["device-page"],
  handoff: ["handoff"],
};
export const STAGES = Object.keys(STAGE_OUTPUTS);

// ---- the finite inventory of a complete desktop programme (review finding R2) -----------------------------------------------------------
// A conclusion about the desktop engines (H8, H9, M8) is drawn only from a programme that holds ALL of it; anything missing, failed or
// not isolated leaves the desktop answer undetermined, and the validator refuses such a hand-over unless it is accepted as partial.
export const ENGINES = ["chromium", "firefox", "webkit"];
/** The stages a complete programme records, each finished with exit status 0. */
export const PROGRAMME_STAGES = [
  "bundle",
  "fixture",
  "shell",
  "contention",
  "integration",
  "device",
];
/** The cases each stage's spec must have collected in EVERY engine, passed: title prefixes, each matching exactly one test. */
export const REQUIRED_CASES = {
  fixture: ["P-2:", "P-3:", "P-5:", "P-11:", "P-Q:", "P-5 (dense):", "P-Q2:"],
  contention: [
    "P-7 and P-8:",
    "P-7: a frozen owner",
    "P-7: the PRODUCTION lock wait",
    "P-6:",
    "P-9:",
    "P-13:",
  ],
  integration: [
    "P-4: what the page does around ONE sync page",
    "P-4: what the page does around ONE draft submission",
    "P-10:",
    "W2:",
    "W2-limits:",
  ],
  device: ["P-11 (device page):"],
};
/** Cold runs each valid workload needs in every engine: W1, W3, W4 and W6 through P-11, W2 through P-W2 (beside its live application). */
export const REQUIRED_COLD_RUNS = 5;
export const COLD_RUN_WORKLOADS = ["W1", "W3", "W4", "W6"];
/** The collection log every profiling spec appends to: one line per test, with its window and how it ended. */
export const COLLECTION_LOG = "collection.jsonl";

/**
 * The evidence directory of a spec run, from `ATLAS_PROFILE_OUT`. A profiling run (`ATLAS_PROFILE=1`) without an absolute directory is
 * an error: there is no default, so no spec can write into an earlier owner's path. Outside a profiling run the specs skip themselves and
 * the answer is `null` (nothing may be written).
 */
export function profileOutFromEnv(env = process.env) {
  const dir = env.ATLAS_PROFILE_OUT;
  if (!env.ATLAS_PROFILE) return dir && isAbsolute(dir) ? dir : null;
  if (!dir || !isAbsolute(dir))
    throw new Error(
      "ATLAS_PROFILE_OUT must name an absolute evidence directory for a profiling run (the drivers set it from --evidence); there is no default",
    );
  return dir;
}

/** The value of `--evidence <dir>` (required), resolved against the repository; exits 2 with a usage line when it is missing. */
export function evidenceArg(args, root, usage) {
  const at = args.indexOf("--evidence");
  const dir = at >= 0 ? args[at + 1] : undefined;
  if (!dir || dir.startsWith("--")) {
    console.error(
      `--evidence <dir> is required (a fresh directory; nothing is ever deleted)\n${usage}`,
    );
    process.exit(2);
  }
  return resolve(root, dir);
}

/** What in `dir` already records one of `stages`: an empty list means every stage may write. */
export function recordedStages(dir, stages) {
  const found = [];
  for (const stage of stages) {
    if (!STAGE_OUTPUTS[stage]) throw new Error(`unknown stage ${stage}`);
    for (const name of [
      join("stages", `${stage}.json`),
      join("isolation", `${stage}.jsonl`),
      ...STAGE_OUTPUTS[stage],
    ])
      if (existsSync(join(dir, name))) found.push(`${stage}: ${name}`);
  }
  return found;
}

/** Refuses (exit 2, nothing touched) a directory in which any of `stages` is already recorded. */
export function refuseRecorded(dir, stages, log = console.error) {
  const found = recordedStages(dir, stages);
  if (found.length === 0) return;
  log(
    `refused: ${dir} already records ${found.join(", ")}. Use a fresh evidence directory; nothing was changed or deleted.`,
  );
  process.exit(2);
}

/** Who holds the directory now, or null. */
export function claimHolder(dir) {
  const file = join(dir, CLAIM_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { unreadable: true };
  }
}

/**
 * Claims `dir` for this invocation, or runs under the claim `delegated` names (a nested driver). The claim is created with O_EXCL: of two
 * invocations that reach this point together, exactly one succeeds; the other is refused (exit 2) without touching anything. Returns the
 * invocation id and `release(status)`, which moves the claim to `writers/<invocation>.json` with its end.
 */
export function claimDirectory(
  dir,
  { stages, delegated = process.env.ATLAS_PROFILE_CLAIM, log = console.error },
) {
  if (delegated) {
    const holder = claimHolder(dir);
    if (holder?.invocation !== delegated) {
      log(
        `refused: ${dir} is not held by the delegating invocation ${delegated} (holder: ${JSON.stringify(holder)}); nothing was changed`,
      );
      process.exit(2);
    }
    return { invocation: delegated, delegated: true, release: () => undefined };
  }
  mkdirSync(dir, { recursive: true });
  const invocation = randomUUID();
  const file = join(dir, CLAIM_FILE);
  let fd;
  try {
    fd = openSync(file, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    log(
      `refused: ${dir} is held by another invocation (${JSON.stringify(claimHolder(dir))}), or by one that was interrupted; use a fresh evidence directory. Nothing was changed or deleted.`,
    );
    process.exit(2);
  }
  const record = {
    invocation,
    pid: process.pid,
    started_at: new Date().toISOString(),
    stages,
    argv: process.argv.slice(1),
  };
  writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
  closeSync(fd);
  return {
    invocation,
    delegated: false,
    /** Withdraws a claim under which nothing was written (a refusal after the claim): the directory is left as it was found. */
    withdraw() {
      unlinkSync(file);
    },
    release(status) {
      mkdirSync(join(dir, "writers"), { recursive: true });
      writeFileSync(
        join(dir, "writers", `${invocation}.json`),
        `${JSON.stringify({ ...record, finished_at: new Date().toISOString(), exit_status: status }, null, 2)}\n`,
      );
      unlinkSync(file);
    },
  };
}

/** How many lines each shared row file holds now (a stage's rows are the lines added between its start and its seal). */
export function sharedRowCounts(dir) {
  return Object.fromEntries(
    SHARED_ROWS.map((name) => [
      name,
      existsSync(join(dir, name))
        ? readFileSync(join(dir, name), "utf8")
            .split("\n")
            .filter((l) => l.trim()).length
        : 0,
    ]),
  );
}

/** Load and competing work on this machine: a measurement taken beside another heavy run is contaminated, and says so. */
export function loadSnapshot() {
  let competing = [];
  try {
    competing = execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .filter((line) =>
        /playwright|chrome|firefox|webkit|vitest|run-validation|atlas-server|cargo|rustc/i.test(
          line,
        ),
      )
      .map((line) => line.trim().slice(0, 240));
  } catch {
    competing = ["ps failed"];
  }
  return {
    at: new Date().toISOString(),
    loadavg: loadavg().map((n) => +n.toFixed(2)),
    competing_processes: competing,
    note: "every process whose command line names a browser, a test runner, the validation driver or a backend; this run's own children are included and must be told apart by the reader",
  };
}

/** The candidate: commit, tree, the porcelain status and the validation driver's source fingerprint (tracked and non-ignored untracked). */
export function candidate(root) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const print = fingerprint(root);
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    status_porcelain: git("status", "--porcelain").split("\n").filter(Boolean),
    source_fingerprint: print.sha256,
    fingerprint_method:
      "scripts/validation/runtime.mjs fingerprint(): SHA-256 over every tracked and non-ignored untracked file outside .agtx/",
    node: print.node,
    platform: `${print.platform} ${print.arch}`,
  };
}

/** Writes `stages/<stage>.json` (the stage began here, on this candidate, under this load, by this invocation). */
export function recordStage(dir, stage, extra = {}) {
  mkdirSync(join(dir, "stages"), { recursive: true });
  const record = {
    evidence_key: EVIDENCE_KEY,
    owner: EVIDENCE_OWNER,
    stage,
    contract_version: CONTRACT_VERSION,
    invocation: extra.invocation ?? null,
    started_at: new Date().toISOString(),
    rows_at_start: sharedRowCounts(dir),
    candidate: candidate(extra.root ?? process.cwd()),
    load_at_start: loadSnapshot(),
    // A shortened DEBUGGING run (ATLAS_PROFILE_SAMPLES) is never evidence: the handoff refuses a directory that holds one.
    debugging_samples: process.env.ATLAS_PROFILE_SAMPLES || null,
    ...extra,
  };
  delete record.root;
  writeFileSync(
    join(dir, "stages", `${stage}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

/**
 * Seals a stage: its exit status, its action interval (`action_started_at`/`action_finished_at`, taken inside the sampler's barriers),
 * the sampler's state, a failure if the action threw, the shared rows it added, and the load when it ended.
 */
export function finishStage(dir, stage, status, seal = {}) {
  const file = join(dir, "stages", `${stage}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.finished_at = new Date().toISOString();
  record.exit_status = status;
  record.action_started_at = seal.action_started_at ?? null;
  record.action_finished_at = seal.action_finished_at ?? null;
  record.sampler = seal.sampler ?? null;
  record.failure = seal.failure ?? null;
  record.rows_at_end = sharedRowCounts(dir);
  record.load_at_end = loadSnapshot();
  record.sealed = true;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Runs one stage's `action` between the sampler's barriers and seals it whatever happens: the sampler must have written a valid first
 * sample before the action starts (otherwise the stage fails closed), the action's interval is recorded inside it, a throw is recorded as
 * a failure, and the sampler's final sample is written after the action. Returns the exit status.
 */
export async function runStage(
  dir,
  stage,
  action,
  { sample, invocation, extra = {} },
) {
  recordStage(dir, stage, { ...extra, invocation });
  let sampler = null;
  let status = 1;
  let failure = null;
  let started = null;
  let finished = null;
  let stopped = null;
  try {
    sampler = sample ? await sample(dir, stage) : null;
    started = new Date().toISOString();
    status = (await action()) ?? 1;
  } catch (error) {
    failure = String(error?.stack ?? error).slice(0, 2000);
    status = 1;
  } finally {
    finished = new Date().toISOString();
    if (sampler)
      stopped = await sampler.stop().catch((error) => ({
        error: String(error).slice(0, 200),
      }));
  }
  finishStage(dir, stage, status, {
    action_started_at: started,
    action_finished_at: finished,
    sampler: sampler
      ? {
          ready: sampler.ready === true,
          ready_at: sampler.ready_at ?? null,
          final_sample: stopped?.final_sample === true,
          exit_code: stopped?.exit_code ?? null,
          samples: stopped?.samples ?? null,
          error: stopped?.error ?? null,
        }
      : null,
    failure,
  });
  return status;
}
