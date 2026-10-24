// WEB-08d revision 25 (review r24 R24-N1; design assessment 91d0404c Q1-Q5, Q7): evidence bundles for the held-operation qualification's
// tests, built in memory exactly as scripts/validation/held-operation-probes.mjs publishes them (held-operation-evidence.mjs).
//
// Each bundle is SYNTHETIC-CONSISTENT: its report is a GENUINE saved report (fixtures/held-operation-*.json.gz) with the evidence-run
// metadata the trimmed copies lost restored for this bundle, its digests are real SHA-256 digests of the bytes it carries, its execution
// record has the controller's shape (exit, signal, report digest, argv, selection environment), and its source fingerprint is a small
// synthetic tree whose spec is the genuine live spec and whose helper is the current tests/e2e/held-operation.ts. These bundles qualify
// the verifier and the judgements; they are not browser runs. Fresh genuine bundles come from the runner itself.
//
// Every builder takes an `edit(parts)` step applied BEFORE the manifest is computed (a consistent change the derived relations must
// refuse) and a `tamper(bundle)` step applied AFTER it (bytes that are no longer the manifest's).
//
// Revision 26 (review r25 R25-N1; design assessment 26f1a626 Q1, Q2): a bundle is `/2` and carries a SYNTHETIC applicability record
// (`applicability`, default TARGET: complete and well formed, with made-up digests) and its report the matching runtime witness. `legacy:
// true` builds a revision 25 `/1` bundle (no record). Callers name the consumer's target explicitly; nothing defaults it for them.
//
// Revision 27 (review r26 R26-N1; design assessment eff76566 Q4): the synthetic record is of schema /2 (the complete installation's
// digest and entry count, the resolution digest, the snapshot root, the package-manager configuration), its witness names the snapshot's
// @playwright/test, and `legacyRecord(change)` builds the revision 26 /1 record a genuine r26 bundle carries.
//
// Revision 28 (review r27 R27-N1; design assessment 3f7047c0 Q4): the synthetic record is of schema /3 (it names the private runtime: its
// schema, launcher form, digest, entry count and root, and the external launcher it was cloned from), the snapshot record of schema /2
// (the runtime's seal and checks, the guarded trees, the source installation's state), `r27Record(change)` builds the revision 27 /2
// record, and `completedRun` / `writeCompletedRun` build a producing run's terminal completion record CONSISTENT with the records it
// binds (in memory as held-operation-evidence.mjs readRunCompletion returns it, or on disk as the runner writes it).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  APPLICABILITY_SCHEMA,
  canonical,
} from "./held-operation-applicability.mjs";
import { MANIFEST, probeArgv, sha256 } from "./held-operation-evidence.mjs";
import { RUNTIME_SCHEMA } from "./held-operation-execution.mjs";
import {
  INSTALLATION_SCHEMA,
  SNAPSHOT_SCHEMA,
} from "./held-operation-installation.mjs";
import {
  COMPLETION_SCHEMA,
  CONTRACT_VERSION,
  ENGINES,
  EVIDENCE_SCHEMA,
  FAULT_HOOK,
  HELPER,
  LEGACY_EVIDENCE_SCHEMAS,
  LEGACY_NEGATIVE_CONTRACTS,
  mutantOf,
  NEGATIVE_CONTRACT_VERSION,
  PROBE_SPEC,
} from "./held-operation-qualification.mjs";

const root = resolve(import.meta.dirname, "../..");
/** The current helper's bytes (NC4 installs HM2 into them). */
export const HELPER_BYTES = readFileSync(join(root, HELPER));
/** Invocation ids shaped like the runner's run directories. */
export const INVOCATION = "2026-10-23T09-00-00.000Z-aaaaaaaa";
export const OTHER_INVOCATION = "2026-10-23T09-30-00.000Z-bbbbbbbb";

const digest = (label) => sha256(`synthetic ${label}`);
/**
 * A SYNTHETIC applicability record (held-operation-applicability.mjs collectApplicability's shape): complete and well formed, its digests
 * made up. `change(record)` edits a copy (a different runtime, a missing field, ...). TARGET is the one every builder records by default.
 */
export function applicabilityRecord(change) {
  const r = {
    schema: APPLICABILITY_SCHEMA,
    controller: {
      node: "v22.23.2",
      exec_path: "/n/v22.23.2/bin/node",
      exec_sha256: digest("node 22.23.2"),
      platform: "darwin",
      arch: "arm64",
      os_type: "Darwin",
      os_release: "25.6.0",
      os_version: "Darwin Kernel Version 25.6.0",
    },
    launcher: {
      pnpm_path: "/t/held-op-runtime-aaaaaa/bin/pnpm",
      pnpm_realpath: "/t/held-op-runtime-aaaaaa/bin/pnpm",
      pnpm_sha256: digest("pnpm shim"),
      source_path: "/w/.agtx/evidence/revision-9/pnpm-shim/pnpm",
    },
    runtime: {
      schema: RUNTIME_SCHEMA,
      form: "task-shim",
      sha256: digest("private runtime"),
      entries: 620,
      root: "/t/held-op-runtime-aaaaaa",
    },
    child: {
      node: "v22.23.2",
      exec_path: "/n/v22.23.2/bin/node",
      exec_sha256: digest("node 22.23.2"),
      platform: "darwin",
      arch: "arm64",
      user_agent: "pnpm/12.4.2 npm/? node/? darwin arm64",
      pnpm_path: "/c/pnpm/12.4.2/pnpm-native",
      pnpm_sha256: digest("pnpm-native 12.4.2"),
      pnpm_tree_sha256: digest("pnpm tree 12.4.2"),
      corepack_root: "/n/v22.23.2/lib/node_modules/corepack",
      corepack_tree_sha256: digest("corepack tree"),
    },
    packages: {
      "@playwright/test": {
        version: "1.63.0",
        dir: "/w/node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test",
        tree_sha256: digest("@playwright/test 1.63.0"),
      },
      playwright: {
        version: "1.63.0",
        dir: "/w/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright",
        tree_sha256: digest("playwright 1.63.0"),
      },
      "playwright-core": {
        version: "1.63.0",
        dir: "/w/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core",
        tree_sha256: digest("playwright-core 1.63.0"),
      },
      vite: {
        version: "8.3.0",
        dir: "/w/node_modules/.pnpm/vite@8.3.0/node_modules/vite",
        tree_sha256: digest("vite 8.3.0"),
      },
    },
    installation: {
      modules_yaml_sha256: digest(".modules.yaml"),
      lock_yaml_sha256: digest("lock.yaml"),
      schema: INSTALLATION_SCHEMA,
      sha256: digest("installation"),
      entries: 28454,
      files: 22863,
      links: 1819,
      directories: 3772,
      bytes: 351000000,
      normalised: 111,
      resolution_sha256: digest("resolution"),
      dependencies: 31,
      root: "/t/held-op-exec-aaaaaa",
    },
    config: {
      npmrc_user: "none",
      pnpm_rc_macos: "none",
      pnpm_config_macos: "none",
      pnpm_rc_xdg: "none",
      pnpm_config_xdg: "none",
    },
    browsers: {
      chromium: {
        executable: "/b/chromium-1243/chrome",
        directories: {
          "chromium-1243": digest("chromium-1243"),
          "chromium_headless_shell-1243": digest("headless shell 1243"),
        },
      },
      firefox: {
        executable: "/b/firefox-1543/firefox",
        directories: { "firefox-1543": digest("firefox-1543") },
      },
      webkit: {
        executable: "/b/webkit-2359/pw_run.sh",
        directories: { "webkit-2359": digest("webkit-2359") },
      },
    },
    env: { LANG: "en_GB.UTF-8" },
  };
  change?.(r);
  return r;
}
export const TARGET = applicabilityRecord();
/**
 * A SYNTHETIC execution snapshot record (the runner's snapshot.json) of a run measured as `record`: sealed, checked unchanged before
 * each child and at the end, removed, and bound to the record's installation digest and root. `change(snapshot)` edits a copy.
 */
export function snapshotRecord(record = TARGET, change) {
  const sealed = digest("sealed snapshot");
  const rt = digest("sealed runtime");
  const build = digest("sealed build");
  const state = digest("source installation state");
  const s = {
    schema: SNAPSHOT_SCHEMA,
    root: record.installation?.root,
    source: "/w",
    used: true,
    runtime_root: record.runtime?.root,
    runtime_form: "task-shim",
    launcher_source: "/w/.agtx/evidence/revision-9/pnpm-shim/pnpm",
    runtime_sealed_sha256: rt,
    runtime_entries: 8031,
    runtime_checks: [
      { when: "before pnpm's preparation in the snapshot", runtime_sha256: rt },
    ],
    source_state_before_sha256: state,
    source_state_after_sha256: state,
    source_state_entries: 28460,
    relocated: [".bin/vite"],
    prepared: true,
    sealed_sha256: sealed,
    sealed_entries: 29545,
    installation_sha256: record.installation?.sha256,
    runtime_sha256: record.runtime?.sha256,
    trees: {
      "build control-build": {
        root: "/w/run/control-build",
        sealed_sha256: build,
        entries: 40,
      },
    },
    checks: [
      {
        when: "after the applicability was collected",
        sha256: sealed,
        runtime_sha256: rt,
        trees: {},
      },
      {
        when: "before the preview",
        sha256: sealed,
        runtime_sha256: rt,
        trees: { "build control-build": build },
      },
    ],
    end_sha256: sealed,
    runtime_end_sha256: rt,
    trees_end: { "build control-build": build },
    unchanged: true,
    removed: true,
    removal_error: null,
    runtime_removed: true,
    runtime_removal_error: null,
  };
  change?.(s);
  return s;
}
/** The revision 27 record (schema /2): the complete installation, but no private runtime (its launcher chain measured outside the run). */
export function r27Record(change) {
  const r = applicabilityRecord((x) => {
    x.schema = "web08d-held-operation-applicability/2";
    delete x.runtime;
    delete x.launcher.source_path;
  });
  change?.(r);
  return r;
}
/** The revision 26 record (schema /1): four package trees and pnpm's two metadata files, no installation content. */
export function legacyRecord(change) {
  const r = applicabilityRecord((x) => {
    x.schema = "web08d-held-operation-applicability/1";
    x.installation = {
      modules_yaml_sha256: x.installation.modules_yaml_sha256,
      lock_yaml_sha256: x.installation.lock_yaml_sha256,
    };
    delete x.config;
  });
  change?.(r);
  return r;
}
const recordBytes = (v) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
/**
 * A producing run's terminal completion record and the files it binds, as held-operation-evidence.mjs readRunCompletion returns them:
 * applicability before and after (`before`/`after`: records, written canonically), the snapshot record, the summary and `parts` (part
 * name -> manifest digest). Consistent unless `change(completion)` edits the completion record.
 */
export function completedRun({
  invocation = INVOCATION,
  before = TARGET,
  after = before,
  snapshot = snapshotRecord(before),
  summary = { passed: true, stage: "controls" },
  parts = {},
  change,
} = {}) {
  const b = Buffer.from(canonical(before));
  const a = Buffer.from(canonical(after));
  const record = {
    schema: COMPLETION_SCHEMA,
    invocation,
    stage: summary.stage ?? "controls",
    check_only: false,
    browsers: [...ENGINES],
    passed: true,
    reasons: [],
    processes_closed: true,
    source_sha256: digest("source"),
    source_after_sha256: digest("source"),
    applicability_sha256: sha256(b),
    applicability_after_sha256: sha256(a),
    applicability_after: "applicable",
    snapshot_sha256: sha256(recordBytes(snapshot)),
    summary_sha256: sha256(recordBytes({ summary })),
    parts,
    at: "2026-10-24T09:00:00.000Z",
  };
  change?.(record);
  return {
    files: {
      "applicability.json": b,
      "applicability-after.json": a,
      "snapshot.json": recordBytes(snapshot),
      "probe-results.json": recordBytes({ summary }),
      "completion.json": Buffer.from(canonical(record)),
    },
    completion: {
      sha256: sha256(Buffer.from(canonical(record))),
      record,
    },
    applicability: {
      before: { sha256: sha256(b), record: before },
      after: { sha256: sha256(a), record: after },
    },
    snapshot: { sha256: sha256(recordBytes(snapshot)), record: snapshot },
    summary: { sha256: sha256(recordBytes({ summary })), record: { summary } },
  };
}
/** Writes a completedRun's files into the run directory `dir` (beside its part directories), as the runner leaves them. */
export function writeCompletedRun(dir, run, { omit = [] } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(run.files))
    if (!omit.includes(name)) writeFileSync(join(dir, name), bytes);
}
/** The runtime witness a Playwright run under `record` writes into its report (tests/e2e/evidence-run.ts runtimeWitness). */
export const witnessOf = (record) => ({
  node: record.child?.node,
  exec_path: record.child?.exec_path,
  platform: record.child?.platform,
  arch: record.child?.arch,
  playwright: record.packages?.["@playwright/test"]?.version,
  ...(record.schema === APPLICABILITY_SCHEMA
    ? { playwright_dir: record.packages?.["@playwright/test"]?.dir }
    : {}),
});

/** A synthetic source fingerprint whose spec is `spec` and helper HELPER_BYTES, with the shape of runtime.mjs fingerprint(). */
export function sourceOf(spec, extra = {}) {
  const files = {
    "playwright.config.ts": sha256("synthetic config"),
    "src/fixture/data-harness/main.ts": sha256("synthetic harness"),
    "tests/e2e/helpers.ts": sha256("synthetic helpers"),
    [HELPER]: sha256(HELPER_BYTES),
    [PROBE_SPEC]: sha256(spec),
    ...extra,
  };
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return {
    sha256: sha256(JSON.stringify(sorted)),
    files: sorted,
    node: "v22.23.2",
    platform: "darwin",
    arch: "arm64",
  };
}
/** The copied tree a source implies (its config and tests/e2e), with `patched` files replaced. */
export function treeOf(source, patched = {}) {
  const out = {};
  for (const [file, digest] of Object.entries(source.files))
    if (file === "playwright.config.ts" || file.startsWith("tests/e2e/"))
      out[file] = digest;
  return { ...out, ...patched };
}
const bytesOf = (v) =>
  Buffer.isBuffer(v)
    ? v
    : Buffer.from(
        typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`,
      );
/**
 * The report a part wrote, with the evidence-run metadata of `invocation`'s `part` (the trimmed fixtures lost their config) and, unless
 * `witness` is null (a revision 25 report), the runtime witness its Playwright run recorded.
 */
export function reportOf(report, invocation, part, dir = "browser/", witness) {
  const copy = structuredClone(report);
  copy.config = {
    ...(copy.config ?? {}),
    metadata: {
      atlasEvidenceRun: `/w/.agtx/evidence/runs/${invocation}/${part}/${dir}evidence/runs/run-1`,
      actualWorkers: 1,
      ...(witness ? { atlasRuntime: witness } : {}),
    },
  };
  return copy;
}
/** The base (live) spec of a negative-control run: its spec up to the appended hook (the whole spec when it has none). */
export function baseSpecOf(entry) {
  const at = entry.spec.indexOf(FAULT_HOOK);
  return at < 0 ? entry.spec : entry.spec.slice(0, at);
}

/** Computes the manifest of `parts` and returns the bundle in readBundle's shape. */
function finish(parts, tamper) {
  const files = {};
  const manifest = {
    schema: parts.schema ?? EVIDENCE_SCHEMA,
    ...parts.header,
    artefacts: {},
  };
  for (const [name, { path, bytes }] of Object.entries(parts.files)) {
    files[name] = bytesOf(bytes);
    manifest.artefacts[name] = { path, sha256: sha256(files[name]) };
  }
  parts.manifest?.(manifest);
  const bundle = {
    root: null,
    manifest_bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    files,
    read_problems: [],
    paths: Object.fromEntries(
      Object.entries(parts.files).map(([n, f]) => [n, f.path]),
    ),
  };
  tamper?.(bundle);
  return bundle;
}

/**
 * A negative control's bundle over a genuine run `entry` ({ exit, report, spec, signal? }): what the runner publishes for it. The spec
 * that ran is `entry.spec` (normally the live spec with the hook appended; an edited entry's spec is recorded as it ran, consistently).
 * `edit(parts)` changes the parts consistently before the manifest; `tamper(bundle)` changes bytes after it.
 */
export function negativeBundle(
  nc,
  entry,
  {
    invocation = INVOCATION,
    exit = entry.exit,
    signal = entry.signal ?? null,
    browsers = ENGINES,
    source,
    applicability = TARGET,
    legacy = false,
    edit,
    tamper,
  } = {},
) {
  const base = Buffer.from(baseSpecOf(entry));
  const spec = Buffer.from(entry.spec);
  const src = source ?? sourceOf(base);
  const patched = { [PROBE_SPEC]: sha256(spec) };
  const parts = {
    schema: legacy ? LEGACY_EVIDENCE_SCHEMAS[0] : EVIDENCE_SCHEMA,
    header: {
      kind: "negative",
      part: nc.id,
      contract: legacy
        ? LEGACY_NEGATIVE_CONTRACTS[LEGACY_EVIDENCE_SCHEMAS[0]]
        : NEGATIVE_CONTRACT_VERSION,
      invocation,
      source_sha256: src.sha256,
    },
    files: {},
  };
  const report = bytesOf(
    reportOf(
      entry.report,
      invocation,
      nc.id,
      "browser/",
      legacy ? null : witnessOf(applicability),
    ),
  );
  parts.files.report = { path: "browser/report.json", bytes: report };
  if (!legacy)
    parts.files.applicability = {
      path: "bundle/applicability.json",
      bytes: canonical(applicability),
    };
  parts.files.source = { path: "bundle/source.json", bytes: src };
  parts.files.spec = { path: `bundle/ran/${PROBE_SPEC}`, bytes: spec };
  parts.files[`base:${PROBE_SPEC}`] = {
    path: `bundle/base/${PROBE_SPEC}`,
    bytes: base,
  };
  if (nc.mutant) {
    const file = mutantOf(nc.mutant).file;
    const installed = Buffer.from(
      mutantOf(nc.mutant).patch(HELPER_BYTES.toString("utf8")),
    );
    patched[file] = sha256(installed);
    parts.files[`base:${file}`] = {
      path: `bundle/base/${file}`,
      bytes: HELPER_BYTES,
    };
    parts.files[`installed:${file}`] = {
      path: `bundle/installed/${file}`,
      bytes: installed,
    };
  }
  const tree = treeOf(src, patched);
  parts.files.inventory = {
    path: "bundle/inventory.json",
    bytes: { before: tree, after: tree },
  };
  parts.execution = {
    exit,
    signal,
    report_sha256: sha256(report),
    argv: probeArgv(
      `/w/.agtx/held-operation-probe-trees/${invocation}/${nc.id}/playwright.config.ts`,
      browsers,
      nc.probes,
      `/w/.agtx/evidence/runs/${invocation}/${nc.id}/browser/test-results`,
    ),
    env: {
      ATLAS_E2E_PROBES: "held-operation",
      ATLAS_PROBE_FAULT: nc.fault,
      ATLAS_PROBE_FAULT_IDS: nc.probes.join(","),
    },
    closed_at: "2026-10-23T09:00:00.000Z",
  };
  edit?.(parts);
  // The execution record is written after edits so that an edit of the report is seen (or deliberately not) by it.
  if (!parts.files.execution && parts.execution !== null)
    parts.files.execution = {
      path: "execution.json",
      bytes: parts.execution,
    };
  return finish(parts, tamper);
}

/** A control part's bundle (`control`: the live tree; `copy-control`: an unmutated copy) over a genuine control run `entry`. */
export function controlBundle(
  part,
  entry,
  ids,
  {
    invocation = INVOCATION,
    source,
    browsers = ENGINES,
    applicability = TARGET,
    legacy = false,
    edit,
    tamper,
  } = {},
) {
  const spec = Buffer.from(entry.spec);
  const src = source ?? sourceOf(spec);
  const report = bytesOf(
    reportOf(
      entry.report,
      invocation,
      part,
      "",
      legacy ? null : witnessOf(applicability),
    ),
  );
  const parts = {
    schema: legacy ? LEGACY_EVIDENCE_SCHEMAS[0] : EVIDENCE_SCHEMA,
    header: {
      kind: "control",
      part,
      contract: CONTRACT_VERSION,
      invocation,
      source_sha256: src.sha256,
    },
    files: {
      report: { path: "report.json", bytes: report },
      source: { path: "bundle/source.json", bytes: src },
      spec: { path: `bundle/ran/${PROBE_SPEC}`, bytes: spec },
      ...(legacy
        ? {}
        : {
            applicability: {
              path: "bundle/applicability.json",
              bytes: canonical(applicability),
            },
          }),
    },
    execution: {
      exit: entry.exit,
      signal: null,
      report_sha256: sha256(report),
      argv: probeArgv(
        "/w/playwright.config.ts",
        browsers,
        ids,
        `/w/.agtx/evidence/runs/${invocation}/${part}/test-results`,
      ),
      env: { ATLAS_E2E_PROBES: "held-operation" },
      closed_at: "2026-10-23T09:00:00.000Z",
    },
  };
  if (part === "copy-control") {
    const tree = treeOf(src);
    parts.files.inventory = {
      path: "bundle/inventory.json",
      bytes: { before: tree, after: tree },
    };
  }
  edit?.(parts);
  if (!parts.files.execution && parts.execution !== null)
    parts.files.execution = { path: "execution.json", bytes: parts.execution };
  return finish(parts, tamper);
}

/** Writes a bundle to `dir` as the runner would leave it (its manifest last), returning the manifest's path. */
export function writeBundle(dir, bundle, { manifest = true } = {}) {
  for (const [name, bytes] of Object.entries(bundle.files)) {
    const path = bundle.paths[name];
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  if (manifest) writeFileSync(join(dir, MANIFEST), bundle.manifest_bytes);
  return join(dir, MANIFEST);
}

/** Rewrites a bundle's manifest object (after it was computed): the bytes no longer change with it. */
export function withManifest(bundle, change) {
  const m = JSON.parse(bundle.manifest_bytes.toString("utf8"));
  change(m);
  return {
    ...bundle,
    manifest_bytes: Buffer.from(`${JSON.stringify(m, null, 2)}\n`),
  };
}
