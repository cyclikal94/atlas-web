// WEB-08d revision 25 (review r24 R24-N1; design assessment 91d0404c, invariants I1-I10, correction C1-C5): the evidence boundary of
// the held-operation qualification. Revision 24's runner recorded a negative control's provenance (report, spec, hook and installed-file
// digests, exit, signal), but the evaluator compared those values only with each other and only when a receipt was supplied: a receipt
// with a wrong report digest or exit, or one of another invocation, or none, still qualified (review r24's 30 unexpected acceptances).
//
// Here one part (a control or a negative control) is a BUNDLE: a directory whose manifest names every artefact by relative path and
// SHA-256, published last and exclusively, so an unfinished part has no manifest. The verifier never trusts a recorded value with
// another recorded value. It reads each artefact once, hashes and parses those same bytes, and derives every relationship itself:
//  - the report is the bytes the manifest names, and the execution record (written when Playwright closed: exit, signal, its own digest
//    of the report, the argv and the fault environment) names the same digest; the report's evidence run is this invocation's part;
//  - the source fingerprint (inputs.json of the run) is internally consistent and, when the caller names one, the expected source;
//  - the live spec snapshot is the fingerprint's spec; the spec that ran is exactly that snapshot with this evaluator's FAULT_HOOK
//    appended (a negative control) or the snapshot itself (a control); NC4's installed helper is exactly HM2's patch applied once to the
//    fingerprint's helper, and nothing else is installed;
//  - the copied tree, before and after Playwright ran, is exactly the fingerprint's tests/e2e and config with those files replaced;
//  - the selection (engines, probes, one worker, no retries) and the fault given to the hook are the control's own.
// A judgement then normalises exactly the verified bytes with the recorded exit and signal (qualifyNegative, judgeControlEvidence), and
// judgeNegative compares them again. Live runs (held-operation-probes.mjs) and replays (held-operation-judge.mjs) use this same path.
// This is a local integrity check of the runner's own evidence, not remote attestation: a producer that rewrites every input and digest
// consistently is outside it.
import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  CONTRACT_VERSION,
  ENGINES,
  EVIDENCE_SCHEMA,
  FAULT_HOOK,
  judgeControl,
  judgeNegative,
  mutantOf,
  NEGATIVE_CONTRACT_VERSION,
  normalise,
  PROBE_IDS,
  PROBE_SPEC,
} from "./held-operation-qualification.mjs";

export { EVIDENCE_SCHEMA };
export const MANIFEST = "manifest.json";
const DIGEST = /^[0-9a-f]{64}$/;
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const CONFIG = "playwright.config.ts";

/** The `-g` pattern selecting exactly these probes: a probe's id begins its title ("P03 ...", "S1 shape: ..."), and no other title has it. */
export const grepOf = (ids) => `(?:^|\\s)(?:${ids.join("|")})\\s`;
/** The probes a `grepOf` pattern selects (null when it is not one). */
function idsOfGrep(grep) {
  const m = /^\(\?:\^\|\\s\)\(\?:(.+)\)\\s$/.exec(String(grep));
  return m ? m[1].split("|") : null;
}
/** Playwright's arguments for the probes: every selected engine, one worker, no retries, the JSON reporter. */
export const probeArgv = (config, browsers, ids, output) => [
  "exec",
  "playwright",
  "test",
  "--config",
  config,
  ...browsers.map((b) => `--project=fixture-${b}`),
  "-g",
  grepOf(ids),
  "--workers=1",
  "--retries=0",
  "--reporter=json",
  `--output=${output}`,
];
/** The environment a part's run selects with (the rest of its environment is locations, not selection). */
export const SELECTION_ENV = [
  "ATLAS_E2E_PROBES",
  "ATLAS_PROBE_FAULT",
  "ATLAS_PROBE_FAULT_IDS",
];

/** The artefacts a part's bundle must hold, exactly. */
export function artefactNames({ kind, part, nc }) {
  const names = ["report", "execution", "source", "spec"];
  if (kind === "negative" || part === "copy-control") names.push("inventory");
  if (kind === "negative") {
    names.push(`base:${PROBE_SPEC}`);
    if (nc?.mutant) {
      const file = mutantOf(nc.mutant).file;
      names.push(`base:${file}`, `installed:${file}`);
    }
  }
  return names;
}

/** Every file of what Playwright loads from a tree (its config and tests/e2e), by relative path: its digest, or null if not a regular file. */
export function inventoryOf(tree) {
  const out = {};
  const dir = join(tree, "tests/e2e");
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isDirectory()) continue;
    const full = join(e.parentPath ?? e.path, e.name);
    const rel = join("tests/e2e", full.slice(dir.length + 1));
    out[rel] = e.isFile() ? sha256(readFileSync(full)) : null;
  }
  try {
    const st = lstatSync(join(tree, CONFIG));
    out[CONFIG] = st.isFile() ? sha256(readFileSync(join(tree, CONFIG))) : null;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Writes one artefact of a bundle that must not exist yet. */
export function writeArtefact(root, rel, bytes) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), bytes, { flag: "wx" });
}

/**
 * Publishes a part's manifest last (design assessment C2): every artefact hashed as it now is on disk, then the manifest written to a
 * private name and linked into place, which fails if a manifest already exists. A part that never reaches this has no manifest.
 */
export function publishBundle(root, header, artefacts) {
  const manifest = { schema: EVIDENCE_SCHEMA, ...header, artefacts: {} };
  for (const [name, rel] of Object.entries(artefacts))
    manifest.artefacts[name] = {
      path: rel,
      sha256: sha256(readFileSync(join(root, rel))),
    };
  const partial = join(root, `${MANIFEST}.partial`);
  writeFileSync(partial, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  try {
    linkSync(partial, join(root, MANIFEST));
  } finally {
    unlinkSync(partial);
  }
  return manifest;
}

/** Why `rel` is not a plain relative path inside a bundle (null when it is). */
function pathProblem(rel) {
  if (typeof rel !== "string" || !rel) return "no path";
  if (isAbsolute(rel)) return `absolute path ${rel}`;
  if (rel.split(/[\\/]/).some((p) => p === "" || p === "." || p === ".."))
    return `path ${JSON.stringify(rel)} is not a plain relative path`;
  return null;
}

/**
 * Reads a part's bundle once (design assessment C3: one captured byte buffer per artefact; never reopened for the verdict). Each artefact
 * must be a regular file reached without a link inside the manifest's directory. `beforeArtefact(name)` is a test seam only.
 */
export function readBundle(manifestPath, { beforeArtefact } = {}) {
  const root = dirname(resolve(manifestPath));
  const bundle = { root, manifest_bytes: null, files: {}, read_problems: [] };
  const read = (rel) => {
    const why = pathProblem(rel);
    if (why) throw new Error(why);
    const full = join(root, rel);
    if (!lstatSync(full).isFile()) throw new Error("not a regular file");
    if (realpathSync(full) !== join(realpathSync(root), rel))
      throw new Error("reached through a link or outside the bundle");
    return readFileSync(full);
  };
  try {
    bundle.manifest_bytes = read(basename(resolve(manifestPath)));
  } catch (error) {
    bundle.read_problems.push(
      `${manifestPath}: no published manifest (${error.code ?? error.message})`,
    );
    return bundle;
  }
  let manifest;
  try {
    manifest = JSON.parse(bundle.manifest_bytes.toString("utf8"));
  } catch {
    return bundle;
  }
  const artefacts =
    manifest && typeof manifest.artefacts === "object"
      ? manifest.artefacts
      : {};
  for (const [name, a] of Object.entries(artefacts ?? {})) {
    beforeArtefact?.(name);
    try {
      bundle.files[name] = read(a?.path);
    } catch (error) {
      bundle.read_problems.push(
        `${name}: unreadable (${error.code ?? error.message})`,
      );
    }
  }
  return bundle;
}

const parse = (bytes) => JSON.parse(bytes.toString("utf8"));
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((x, i) => x === b[i]);

/** Why an inventory of a copied tree is not exactly the expected one. */
function inventoryProblems(when, expected, actual) {
  if (!object(actual)) return [`no ${when} inventory of the copied tree`];
  const problems = [];
  for (const file of new Set([
    ...Object.keys(expected),
    ...Object.keys(actual),
  ]))
    if (!(file in expected))
      problems.push(`${when}: ${file} is not in the source's tree`);
    else if (!(file in actual))
      problems.push(`${when}: ${file} is missing from the copy`);
    else if (actual[file] !== expected[file])
      problems.push(
        `${when}: ${file} is ${actual[file] === null ? "not a regular file" : "not the expected bytes"}`,
      );
  return problems;
}

/**
 * Verifies a bundle (read by readBundle, or built in memory with the same shape) as part `expect.part` of kind `expect.kind`
 * ("negative": `expect.nc` is the control; "control": the live `control` or the unmutated `copy-control`). Optional bindings:
 * `invocation` (the run's directory name), `source` (the fingerprint digest), and a report/spec digest and exit that a caller supplied
 * separately and that must be the bundle's own. Returns `verified` only with no problem, the verified report and spec bytes, their
 * digests, the recorded execution and the selection read from it.
 */
export function verifyBundle(bundle, expect) {
  const problems = [...(bundle?.read_problems ?? [])];
  const out = {
    schema: EVIDENCE_SCHEMA,
    status: "refused",
    problems,
    kind: expect.kind,
    part: expect.part,
    invocation: null,
    manifest_sha256: null,
    source_sha256: null,
    report_sha256: null,
    spec_sha256: null,
    execution: null,
    browsers: null,
    probes: null,
    report: null,
    spec: null,
  };
  const done = () => {
    out.status = problems.length ? "refused" : "verified";
    return out;
  };
  if (!Buffer.isBuffer(bundle?.manifest_bytes)) {
    if (!problems.length)
      problems.push("no published manifest (an unfinished or absent bundle)");
    return done();
  }
  out.manifest_sha256 = sha256(bundle.manifest_bytes);
  let m;
  try {
    m = parse(bundle.manifest_bytes);
  } catch {
    problems.push("the manifest is not JSON (truncated or damaged)");
    return done();
  }
  if (!object(m)) {
    problems.push("the manifest is not an object");
    return done();
  }
  if (m.schema !== EVIDENCE_SCHEMA) {
    problems.push(
      `the manifest's schema is ${JSON.stringify(m.schema)}, not ${EVIDENCE_SCHEMA} (a legacy receipt is never verifiable evidence)`,
    );
    return done();
  }
  const contract =
    expect.kind === "negative" ? NEGATIVE_CONTRACT_VERSION : CONTRACT_VERSION;
  if (m.kind !== expect.kind)
    problems.push(`the bundle is a ${m.kind} part, not a ${expect.kind}`);
  if (m.part !== expect.part)
    problems.push(`the bundle is part ${m.part}, not ${expect.part}`);
  out.kind = m.kind;
  out.part = m.part;
  if (m.contract !== contract)
    problems.push(`the bundle's contract is ${m.contract}, not ${contract}`);
  if (typeof m.invocation !== "string" || !/^[\w.:-]+$/.test(m.invocation))
    problems.push("the bundle names no invocation");
  else out.invocation = m.invocation;
  if (expect.invocation !== undefined && m.invocation !== expect.invocation)
    problems.push(
      `the bundle is invocation ${m.invocation}, not ${expect.invocation}`,
    );
  if (!DIGEST.test(String(m.source_sha256)))
    problems.push("the bundle names no source digest");
  else out.source_sha256 = m.source_sha256;
  if (expect.source !== undefined && m.source_sha256 !== expect.source)
    problems.push(
      `the bundle ran on source ${m.source_sha256}, not ${expect.source}`,
    );

  // Every artefact: exactly the required set, each a plain relative path whose bytes are the digest named.
  const required = artefactNames(expect);
  const artefacts = object(m.artefacts) ? m.artefacts : {};
  if (!object(m.artefacts)) problems.push("the manifest lists no artefacts");
  for (const name of required)
    if (!(name in artefacts)) problems.push(`no ${name} artefact`);
  for (const name of Object.keys(artefacts))
    if (!required.includes(name))
      problems.push(`an unexpected ${name} artefact`);
  const bytes = {};
  for (const name of required) {
    const a = artefacts[name];
    if (!object(a)) continue;
    const why = pathProblem(a.path);
    if (why) {
      problems.push(`${name}: ${why}`);
      continue;
    }
    if (!DIGEST.test(String(a.sha256))) {
      problems.push(`${name}: no digest`);
      continue;
    }
    const b = bundle.files?.[name];
    if (!Buffer.isBuffer(b)) {
      if (!problems.some((p) => p.startsWith(`${name}: unreadable`)))
        problems.push(`${name}: not read`);
      continue;
    }
    const actual = sha256(b);
    if (actual !== a.sha256)
      problems.push(
        `${name}: its bytes (${actual}) are not the manifest's (${a.sha256})`,
      );
    else bytes[name] = b;
  }

  // The source fingerprint: internally consistent and the manifest's.
  let files = null;
  if (bytes.source) {
    try {
      const source = parse(bytes.source);
      if (!object(source?.files)) throw new Error("no files");
      if (sha256(JSON.stringify(source.files)) !== source.sha256)
        problems.push("the source fingerprint's files are not its digest");
      else if (source.sha256 !== m.source_sha256)
        problems.push(
          `the source fingerprint is ${source.sha256}, not the manifest's ${m.source_sha256}`,
        );
      else files = source.files;
    } catch {
      problems.push("the source fingerprint is unreadable");
    }
  }

  // The execution record written when Playwright closed: exit, signal, the report it saw, and what the run selected.
  if (bytes.execution) {
    let x;
    try {
      x = parse(bytes.execution);
    } catch {
      problems.push("the execution record is not JSON");
    }
    if (object(x)) {
      if (!Number.isInteger(x.exit))
        problems.push("the execution record has no integer exit");
      if (!("signal" in x))
        problems.push("the execution record has no signal (not even null)");
      else if (x.signal !== null && (typeof x.signal !== "string" || !x.signal))
        problems.push("the execution record's signal is malformed");
      if (x.report_sha256 !== artefacts.report?.sha256)
        problems.push(
          `the execution saw report ${x.report_sha256}, not the manifest's ${artefacts.report?.sha256}`,
        );
      const argv = Array.isArray(x.argv) ? x.argv.map(String) : [];
      if (!argv.length) problems.push("the execution record has no argv");
      const browsers = argv
        .filter((a) => a.startsWith("--project=fixture-"))
        .map((a) => a.slice("--project=fixture-".length));
      if (
        !browsers.length ||
        new Set(browsers).size !== browsers.length ||
        browsers.some((b) => !ENGINES.includes(b))
      )
        problems.push(
          `the run's engine selection ${JSON.stringify(browsers)} is not a set of known engines`,
        );
      for (const [flag, value] of [
        ["--workers=", "1"],
        ["--retries=", "0"],
        ["--reporter=", "json"],
      ]) {
        const given = argv.filter((a) => a.startsWith(flag));
        if (given.length !== 1 || given[0] !== `${flag}${value}`)
          problems.push(
            `the run was given ${JSON.stringify(given)}, not ${flag}${value} once`,
          );
      }
      const g = argv.indexOf("-g");
      const ids =
        g >= 0 && argv.indexOf("-g", g + 1) < 0 ? idsOfGrep(argv[g + 1]) : null;
      if (!ids || ids.some((id) => !PROBE_IDS.includes(id)))
        problems.push("the run's probe selection is not a set of probes");
      const env = object(x.env) ? x.env : {};
      if (!object(x.env))
        problems.push("the execution record has no environment");
      for (const key of Object.keys(env))
        if (!SELECTION_ENV.includes(key))
          problems.push(`the execution record's environment has ${key}`);
      if (env.ATLAS_E2E_PROBES !== "held-operation")
        problems.push("the run did not enable the held-operation probes");
      if (expect.kind === "negative") {
        const nc = expect.nc;
        if (!same(ids, nc.probes))
          problems.push(
            `the run selected ${JSON.stringify(ids)}, not ${JSON.stringify(nc.probes)}`,
          );
        if (env.ATLAS_PROBE_FAULT !== nc.fault)
          problems.push(
            `the hook was given fault ${env.ATLAS_PROBE_FAULT}, not ${nc.fault}`,
          );
        if (env.ATLAS_PROBE_FAULT_IDS !== nc.probes.join(","))
          problems.push(
            `the hook was given probes ${env.ATLAS_PROBE_FAULT_IDS}, not ${nc.probes.join(",")}`,
          );
      } else if ("ATLAS_PROBE_FAULT" in env || "ATLAS_PROBE_FAULT_IDS" in env)
        problems.push("a control's run was given a fault");
      if (expect.exit !== undefined && x.exit !== expect.exit)
        problems.push(
          `the supplied exit ${expect.exit} is not the recorded execution's ${x.exit}`,
        );
      out.execution = {
        exit: x.exit,
        signal: "signal" in x ? x.signal : undefined,
      };
      out.browsers = browsers;
      out.probes = ids;
    } else if (x !== undefined)
      problems.push("the execution record is not an object");
  }

  // The report: the verified bytes, of this invocation's part.
  if (bytes.report) {
    out.report = bytes.report;
    out.report_sha256 = sha256(bytes.report);
    if (
      expect.report_sha256 !== undefined &&
      expect.report_sha256 !== out.report_sha256
    )
      problems.push(
        `the supplied report (${expect.report_sha256}) is not the bundle's (${out.report_sha256})`,
      );
    try {
      const run = parse(bytes.report)?.config?.metadata?.atlasEvidenceRun;
      if (
        typeof run !== "string" ||
        !run.includes(`/${m.invocation}/${m.part}/`)
      )
        problems.push(
          `the report's evidence run ${JSON.stringify(run)} is not this invocation's ${m.part}`,
        );
    } catch {
      problems.push("the report is not JSON");
    }
  }

  // The spec that ran, and (copied trees) what was installed and the tree around it, each derived from the source.
  let expectedSpec = null;
  const patched = {};
  if (expect.kind === "negative") {
    const base = bytes[`base:${PROBE_SPEC}`];
    if (base && files) {
      if (sha256(base) !== files[PROBE_SPEC])
        problems.push("the live spec snapshot is not the source's spec");
      else expectedSpec = Buffer.concat([base, Buffer.from(FAULT_HOOK)]);
    }
    const nc = expect.nc;
    if (nc.mutant) {
      const file = mutantOf(nc.mutant).file;
      const b = bytes[`base:${file}`];
      const installed = bytes[`installed:${file}`];
      if (b && files) {
        if (sha256(b) !== files[file])
          problems.push(`the ${file} snapshot is not the source's`);
        else {
          let want = null;
          try {
            want = Buffer.from(mutantOf(nc.mutant).patch(b.toString("utf8")));
          } catch (error) {
            problems.push(`${nc.mutant} does not apply: ${error.message}`);
          }
          if (want?.equals(b))
            problems.push(`${nc.mutant}'s patch changed nothing`);
          else if (want && installed && !installed.equals(want))
            problems.push(
              `the installed ${file} is not ${nc.mutant} applied once to the source's`,
            );
          if (want) patched[file] = sha256(want);
        }
      }
    }
  }
  if (bytes.spec) {
    out.spec = bytes.spec;
    out.spec_sha256 = sha256(bytes.spec);
    if (
      expect.spec_sha256 !== undefined &&
      expect.spec_sha256 !== out.spec_sha256
    )
      problems.push(
        `the supplied spec (${expect.spec_sha256}) is not the bundle's (${out.spec_sha256})`,
      );
    if (expect.kind === "negative") {
      if (expectedSpec && !bytes.spec.equals(expectedSpec))
        problems.push(
          "the spec that ran is not the source's spec with exactly this evaluator's fault hook appended",
        );
    } else if (files && out.spec_sha256 !== files[PROBE_SPEC])
      problems.push("the spec that ran is not the source's spec");
  }
  if (bytes.inventory && files) {
    let inv;
    try {
      inv = parse(bytes.inventory);
    } catch {
      problems.push("the inventory is not JSON");
    }
    if (inv !== undefined) {
      const expected = {};
      for (const [file, digest] of Object.entries(files))
        if (
          (file === CONFIG || file.startsWith("tests/e2e/")) &&
          digest !== "deleted"
        )
          expected[file] = digest;
      if (expect.kind === "negative") {
        expected[PROBE_SPEC] = expectedSpec ? sha256(expectedSpec) : "unknown";
        for (const [file, digest] of Object.entries(patched))
          expected[file] = digest;
      }
      for (const when of ["before", "after"])
        problems.push(...inventoryProblems(when, expected, inv?.[when]));
    }
  }
  return done();
}

/** The verifier's result without the bytes: what judgements and records carry. */
export function evidenceSummary(v) {
  const { report: _r, spec: _s, ...rest } = v;
  return { ...rest, problems: [...v.problems] };
}

/** The verified bytes normalised with the recorded exit and signal (null when there is nothing verified to normalise). */
function runOf(v) {
  if (!v.report || !v.spec || !v.execution || !v.browsers) return null;
  const run = normalise(
    parse(v.report),
    v.browsers,
    v.execution.exit,
    v.spec.toString("utf8"),
    v.execution.signal ?? null,
  );
  run.report_sha256 = v.report_sha256;
  run.spec_sha256 = v.spec_sha256;
  return run;
}

/** A judgement that could not be made from verified bytes: unqualified, with every reason. */
function unjudged(nc, evidence, why) {
  const integrity = [...evidence.problems.map((p) => `evidence: ${p}`), why];
  return {
    contract: NEGATIVE_CONTRACT_VERSION,
    negative_control: nc.id,
    fault: nc.fault,
    probes: nc.probes,
    coverage: null,
    mode: "bound",
    evidence,
    integrity: { valid: false, problems: integrity },
    scenario: { valid: false, problems: ["not judged"], cases: [] },
    classifier: {
      verdict: "unjudged",
      refused: false,
      problems: [],
      cases: [],
      native: {},
    },
    qualified: false,
    outcome: "unqualified",
    problems: integrity.map((p) => `integrity: ${p}`),
  };
}

/**
 * A negative control judged from its bundle (design assessment C1, C3): verified, then the verified bytes normalised with the recorded
 * exit and signal and judged by judgeNegative, which compares them with the evidence again. The live runner and the replay CLI both call
 * this; nothing else qualifies a negative control.
 */
export function qualifyNegative(nc, bundle, expect = {}) {
  const v = verifyBundle(bundle, {
    ...expect,
    kind: "negative",
    part: nc.id,
    nc,
  });
  const evidence = evidenceSummary(v);
  let run;
  try {
    run = runOf(v);
  } catch (error) {
    return unjudged(
      nc,
      evidence,
      `the verified report cannot be judged: ${error.message}`,
    );
  }
  if (!run)
    return unjudged(
      nc,
      evidence,
      "no verified report, spec and execution to judge",
    );
  return judgeNegative(nc, run, v.browsers, evidence);
}

/**
 * A control part judged from its bundle (design assessment C5): verified, re-normalised from the verified bytes and judged healthy over
 * the probes its run selected. A --stage negatives prerequisite reads both controls this way; a summary's `ok` is never enough.
 */
export function judgeControlEvidence(bundle, expect) {
  const v = verifyBundle(bundle, { ...expect, kind: "control" });
  const evidence = evidenceSummary(v);
  const result = {
    name: expect.part,
    ok: false,
    probes: v.probes,
    browsers: v.browsers,
    evidence,
    problems: evidence.problems.map((p) => `evidence: ${p}`),
  };
  let run;
  try {
    run = runOf(v);
  } catch (error) {
    result.problems.push(
      `the verified report cannot be judged: ${error.message}`,
    );
    return result;
  }
  if (!run) {
    result.problems.push("no verified report, spec and execution to judge");
    return result;
  }
  const judged = judgeControl(run, v.probes, v.browsers);
  result.problems.push(...judged.problems);
  if (run.report_sha256 !== v.report_sha256 || run.exit !== v.execution.exit)
    result.problems.push("the judged run is not the bundle's");
  result.ok =
    v.status === "verified" && judged.ok && result.problems.length === 0;
  result.cases = judged.cases;
  result.native = judged.native;
  return result;
}
