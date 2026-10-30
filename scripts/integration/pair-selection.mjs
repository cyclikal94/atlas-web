// WEB-09c (R23-PAIR, Decision D of 29 October 2026): the ONE hash-bound selection of the unreleased development backend pairing.
//
// The released integration runner (run.mjs) fetches the RELEASED backend named by contract-pin.json and verifies it against the release's
// SHA256SUMS; nothing here touches that path, its cache or the pin. This module names the exact development artefacts Decision D approved
// (backend-pairing/manifest.json in the orchestrator, itself pinned by hash) and checks, before anything starts, that every one of them is
// on disk with exactly the approved bytes, that the backend checkout is at the approved commit and tree with no tracked change, and that the
// host can run the Mach-O arm64 debug executable. Any difference REFUSES the run: there is no override, no fallback and no "closest match".
//
// It is pure apart from the injected `deps` (file reads, hashing, git, platform), so the refusals are tested with doubles
// (pair-selection.test.mjs). The executable is then COPIED into the run's own disposable directory and the copy is hashed again
// (`stageExecutable`): the launched bytes are the verified bytes, and the developer's worktree binary is never executed in place.
//
// Labels: UNRELEASED, UNACCEPTED development pairing for diagnostic qualification only. Not a release, not a tagged verification, not
// production activation, not acceptance; the inherited wrong-length HMAC-signature panic recorded in the backend's review stays open.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ORCHESTRATOR = "/Users/kieran/atlas/atlas-orchestrator";
const BACKEND =
  "/Users/kieran/atlas/atlas/.agtx/worktrees/f3852338-BE-Q23--Measured-bounded-sync";
const PAIRING = `${ORCHESTRATOR}/.local/atlas/maintenance/unblock-all-20261029/backend-pairing`;

/** The approved selection. Every value was verified independently by the current review and design assessment (30 Oct 2026). */
export const PAIR_SELECTION = Object.freeze({
  label:
    "UNRELEASED development pairing (Decision D, 29 Oct 2026): diagnostic qualification only; not release, acceptance or activation",
  authority: Object.freeze({
    [`${ORCHESTRATOR}/approval/web09c-development-pair-approved-20261029.json`]:
      "98209f388dcbcb11f56320ee225a61b4a6d6d2ea9eb614f5aa444676d89dd246",
    [`${ORCHESTRATOR}/delivery/handoffs/web09c-development-pair-approved-20261029.md`]:
      "65e3417644eaceaa2287411ea62afe4e0192b559591f8723a86a92b8141a377e",
  }),
  manifest: Object.freeze({
    path: `${PAIRING}/manifest.json`,
    sha256: "f434df4ae2cfe8dd42e78efddff3819556bc01b01b88e5a54b818f6f643f70d6",
  }),
  backend: Object.freeze({
    checkout: BACKEND,
    head: "633edd4f3d36383df140f0022d129e49128ba338",
    tree: "1f1c84dc1e3e4fb9b83367fcd3aad86df4e78405",
    executable: `${BACKEND}/target/debug/atlas-server`,
    apiVersion: "0.30.0",
  }),
  files: Object.freeze({
    [`${BACKEND}/target/debug/atlas-server`]:
      "a6a73bbfb368f17612d00b3b4d71c0c6273764b52e1b514fddd3814e96a294c9",
    [`${BACKEND}/api/openapi.json`]:
      "9433b84572d083b53fdf545e88f69d5a526d254908b97192854d0edeed80aaed",
    [`${BACKEND}/.agtx/contract/bounded-sync-contract-v1.md`]:
      "d8677478cbc315750a6027b13faddf755def0fd33e4e6bd989e5670372bab386",
    [`${BACKEND}/.agtx/review.md`]:
      "60f6e41a2621eea1810c08c18153fc9e65536aa3bba835a96118be61ae749e9c",
    [`${BACKEND}/scripts/sync_dense_fixture.py`]:
      "8ff71cc18b95175f9ad6c8cf1b929b22775fbacb8b09183c2860b69773736cd5",
    [`${BACKEND}/scripts/api-types/package-lock.json`]:
      "ceb016b20df02408c885a7de9c202c31b4fcf02259a1a16cefae8c66f97200cf",
  }),
  types: Object.freeze({
    path: `${PAIRING}/api-types/atlas-api-types-0.0.0-pairing.20261029.tgz`,
    sha256: "5694ff2da18af982b8275c32468df3c96ebb85876e63ad1c76698a850568c06a",
    version: "0.0.0-pairing.20261029",
  }),
  platform: Object.freeze({ os: "darwin", arch: "arm64" }),
});

export const sha256Of = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

/** The production dependencies of `verifySelection`; tests replace every one of them. */
export const realSelectionDeps = (run) => ({
  read: (path) => readFileSync(path),
  hashFile: (path) => sha256Of(readFileSync(path)),
  git: (args) => {
    const done = run("git", ["-C", PAIR_SELECTION.backend.checkout, ...args]);
    if (done.status !== 0)
      throw new Error(
        `git ${args.join(" ")}: exit ${done.status}: ${done.stderr}`,
      );
    return done.stdout.trim();
  },
  platform: process.platform,
  arch: process.arch,
});

const sameEntries = (a, b) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return (
    ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
  );
};

/**
 * Checks the whole selection. Returns `{ ok, problems, record }`: `ok` only when there is no problem at all; `record` holds every observed
 * value (never only the expected one), for the run's provenance file. It never throws for a mismatch: a missing file or a failing command
 * is a problem in the list.
 */
export function verifySelection(deps, selection = PAIR_SELECTION) {
  const problems = [];
  const observed = {
    authority: {},
    files: {},
    manifest: null,
    types: null,
    backend: {},
    platform: null,
  };
  const attempt = (what, fn) => {
    try {
      return fn();
    } catch (error) {
      problems.push(
        `${what}: ${String(error?.message ?? error).split("\n")[0]}`,
      );
      return null;
    }
  };
  observed.platform = { os: deps.platform, arch: deps.arch };
  if (
    deps.platform !== selection.platform.os ||
    deps.arch !== selection.platform.arch
  )
    problems.push(
      `unsupported platform ${deps.platform}/${deps.arch}: the approved executable is ${selection.platform.os}/${selection.platform.arch}`,
    );
  for (const [path, expected] of Object.entries(selection.authority)) {
    const got = attempt(`authority ${path}`, () => deps.hashFile(path));
    observed.authority[path] = got;
    if (got !== null && got !== expected)
      problems.push(`authority ${path}: sha256 ${got}, approved ${expected}`);
  }
  const bytes = attempt("manifest", () => deps.read(selection.manifest.path));
  if (bytes !== null) {
    const got = sha256Of(bytes);
    observed.manifest = { path: selection.manifest.path, sha256: got };
    if (got !== selection.manifest.sha256)
      problems.push(
        `manifest sha256 ${got}, approved ${selection.manifest.sha256}`,
      );
    const manifest = attempt("manifest JSON", () => JSON.parse(String(bytes)));
    if (manifest !== null) {
      if (manifest.backend_head !== selection.backend.head)
        problems.push(
          `manifest backend_head ${manifest.backend_head}, approved ${selection.backend.head}`,
        );
      if (manifest.backend_tree !== selection.backend.tree)
        problems.push(
          `manifest backend_tree ${manifest.backend_tree}, approved ${selection.backend.tree}`,
        );
      if (!manifest.files || !sameEntries(manifest.files, selection.files))
        problems.push(
          "manifest files differ from the approved selection (paths or hashes)",
        );
      if (
        manifest.api_types?.path !== selection.types.path ||
        manifest.api_types?.sha256 !== selection.types.sha256
      )
        problems.push("manifest api_types differ from the approved selection");
      if (
        manifest.api_types?.provenance?.api_version !==
        selection.backend.apiVersion
      )
        problems.push(
          `manifest api_version ${manifest.api_types?.provenance?.api_version}, approved ${selection.backend.apiVersion}`,
        );
    }
  }
  for (const [path, expected] of Object.entries(selection.files)) {
    const got = attempt(`file ${path}`, () => deps.hashFile(path));
    observed.files[path] = got;
    if (got !== null && got !== expected)
      problems.push(`file ${path}: sha256 ${got}, approved ${expected}`);
  }
  const types = attempt("types", () => deps.hashFile(selection.types.path));
  observed.types = {
    path: selection.types.path,
    sha256: types,
    version: selection.types.version,
  };
  if (types !== null && types !== selection.types.sha256)
    problems.push(`types sha256 ${types}, approved ${selection.types.sha256}`);
  const head = attempt("backend HEAD", () => deps.git(["rev-parse", "HEAD"]));
  const tree = attempt("backend tree", () =>
    deps.git(["rev-parse", "HEAD^{tree}"]),
  );
  const tracked = attempt("backend tracked status", () =>
    deps.git(["status", "--porcelain", "--untracked-files=no"]),
  );
  observed.backend = {
    head,
    tree,
    tracked_changes:
      tracked === null ? null : tracked.split("\n").filter(Boolean),
  };
  if (head !== null && head !== selection.backend.head)
    problems.push(`backend HEAD ${head}, approved ${selection.backend.head}`);
  if (tree !== null && tree !== selection.backend.tree)
    problems.push(`backend tree ${tree}, approved ${selection.backend.tree}`);
  if (tracked !== null && tracked !== "")
    problems.push("the backend checkout has tracked changes");
  return {
    ok: problems.length === 0,
    problems,
    record: { label: selection.label, expected: selection, observed },
  };
}

/**
 * Copies the approved executable into `dir` (the run's own disposable directory), makes the copy executable and verifies the COPY's bytes.
 * Returns `{ path, sha256 }`; throws when the copy does not hash to the approved value (a file that changed after `verifySelection`).
 */
export function stageExecutable(
  dir,
  deps = {
    copy: copyFileSync,
    chmod: chmodSync,
    hashFile: (p) => sha256Of(readFileSync(p)),
  },
  selection = PAIR_SELECTION,
) {
  const path = join(dir, "atlas-server");
  deps.copy(selection.backend.executable, path);
  deps.chmod(path, 0o755);
  const sha256 = deps.hashFile(path);
  const expected = selection.files[selection.backend.executable];
  if (sha256 !== expected)
    throw new Error(
      `the staged executable hashes to ${sha256}, approved ${expected}`,
    );
  return { path, sha256 };
}
