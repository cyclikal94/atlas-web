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

// ---- WEB-09c revision 26 (R26-DIAG): the DIAGNOSTIC selection ---------------------------------------------------------------------
//
// Kieran's answer of 1 November 2026 (approval/be-q23-diagnostic-build-approved-20261101.json, assigned to this task by
// delivery/handoffs/web-09c-diagnostic-build-approved-20261101.md) approves ONE exact diagnostic executable, `atlas-sync-diagnostic`, for
// isolated real-expiry (PAIR-X0) and real-pruning (PAIR-X2) qualification, CONDITIONAL on an independent review of this client adapter
// before any paired execution. It is a separate selection: the normal development selection above stays exactly as it was and keeps
// refusing a backend checkout that has moved past it; the released control is untouched.
//
// The approved review is pinned by its BYTES. The authority names the backend's rotating `.agtx/review.md`, which now holds a later review
// (design assessment, 1 Nov 2026: DA-DIAG-PROVENANCE); the preserved copy in the orchestrator holds the approved Review 9 bytes exactly.
// Both locations are recorded; only the preserved bytes are verified, and the rotating path's current hash is observed, never accepted
// in their place.
//
// Labels: UNRELEASED, UNACCEPTED diagnostic fixture for qualification only. Not the normal backend, not a release, not acceptance, not
// tuning. Review 9's unqualified collector-chunk, `after_error` and `stopping` branches and the inherited wrong-length HMAC limitation stay.
const DIAGNOSTIC_AUTHORITY = `${ORCHESTRATOR}/approval/be-q23-diagnostic-build-approved-20261101.json`;
const DIAGNOSTIC_HANDOVER = `${ORCHESTRATOR}/delivery/handoffs/web-09c-diagnostic-build-approved-20261101.md`;
const DIAGNOSTIC_PROPOSAL = `${ORCHESTRATOR}/.local/atlas/maintenance/usage-reset-20261101/diagnostic-build-proposal.json`;
const PRESERVED_REVIEW = `${ORCHESTRATOR}/.local/atlas/maintenance/unblock-20261101/BE-Q23-review-preserved.md`;
const DIAGNOSTIC_EXECUTABLE = `${BACKEND}/target/q23-review9/debug/atlas-sync-diagnostic`;

export const DIAGNOSTIC_SELECTION = Object.freeze({
  mode: "diagnostic",
  label:
    "UNRELEASED diagnostic fixture (atlas-sync-diagnostic, approved 1 Nov 2026 for isolated X0/X2 qualification): not the normal backend, not release, acceptance, tuning or activation",
  authority: Object.freeze({
    [DIAGNOSTIC_AUTHORITY]:
      "147775cc4f37d1f5ff6737e893e98ca8376024095477e6ec1ce74fe72fe5f471",
    [DIAGNOSTIC_HANDOVER]:
      "effe5013725bcf7ff55970de1b32469b59a11fe315e49ceab56536c798d302c6",
    [DIAGNOSTIC_PROPOSAL]:
      "b368f2af77f4fb612a6d4fbb5df4e8d9f5d16c5195970133f51200cf64b948d2",
  }),
  review: Object.freeze({
    named_path: `${BACKEND}/.agtx/review.md`,
    preserved_path: PRESERVED_REVIEW,
    sha256: "2a8fcb1366fb0fc294606ea34e75679c9c385663786d194217078ed92af13a88",
  }),
  recipe: Object.freeze({
    path: `${BACKEND}/docs/testing.md`,
    sha256: "d875870a427bb1ee39d799d3968e33534380c199dc448505c969cef14f0f8ee9",
  }),
  backend: Object.freeze({
    checkout: BACKEND,
    head: "d9adb95de7ee7a7db90f2ad0fd90824688b8cad1",
    tree: "3ee3008bf8e6d987b15d37cf0103cf43c3d73ff6",
    apiVersion: "0.30.0",
  }),
  executable: Object.freeze({
    path: DIAGNOSTIC_EXECUTABLE,
    name: "atlas-sync-diagnostic",
    sha256: "61e2a0e7ab0e1e434c76705ac8cb0c23bbe754ae8a1e5ed1191fe8621192c50a",
  }),
  /** Source and contract provenance at the approved HEAD (also covered by the tree; recorded so a reader sees which bytes). */
  files: Object.freeze({
    [`${BACKEND}/api/openapi.json`]:
      "9433b84572d083b53fdf545e88f69d5a526d254908b97192854d0edeed80aaed",
    [`${BACKEND}/.agtx/contract/bounded-sync-contract-v1.md`]:
      "d8677478cbc315750a6027b13faddf755def0fd33e4e6bd989e5670372bab386",
    [`${BACKEND}/crates/server/src/bin/atlas-sync-diagnostic.rs`]:
      "e144091a29e04637ca13bff3ad4baa3b37aa0ecd6163885a7ca26ad47cd4b03d",
    [`${BACKEND}/crates/server/src/diagnostic.rs`]:
      "7ae7a37efcfb80e1c2dbe2d8ac65011538935210d05f5386d7ef89dc57120096",
  }),
  /** What the executable's ready receipt must say about itself (atlas-sync-diagnostic.rs `serve`). */
  features: Object.freeze({ "sync-diagnostic": true, "test-hooks": false }),
  retentionSeconds: 90 * 86400,
  consumer: Object.freeze({
    task_id: "7b882f5f-13c6-4649-bd9b-1947f49a7d29",
    worktree:
      "/Users/kieran/atlas/atlas-web/.agtx/worktrees/7b882f5f-WEB-09c--Sync-measurements-an",
  }),
  platform: Object.freeze({ os: "darwin", arch: "arm64" }),
});

/** A stable identity of a selection descriptor (sorted-key JSON, hashed): what an interval and an attempt record name. */
export function selectionIdentity(selection = DIAGNOSTIC_SELECTION) {
  const sorted = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sorted(v[k])]),
        )
      : v;
  return sha256Of(Buffer.from(JSON.stringify(sorted(selection))));
}

/** The production dependencies of `verifyDiagnosticSelection` (git in the diagnostic's checkout); tests replace every one. */
export const realDiagnosticDeps = (run) => ({
  ...realSelectionDeps(run),
  git: (args) => {
    const done = run("git", [
      "-C",
      DIAGNOSTIC_SELECTION.backend.checkout,
      ...args,
    ]);
    if (done.status !== 0)
      throw new Error(
        `git ${args.join(" ")}: exit ${done.status}: ${done.stderr}`,
      );
    return done.stdout.trim();
  },
});

/**
 * Checks the whole diagnostic selection, like `verifySelection`: `{ ok, problems, record }`, never throwing for a mismatch. Beyond the
 * hashes it reads the AUTHORITY and requires it to name exactly this executable, HEAD, review, recipe, proposal and consumer (a mistaken
 * constant here is refused, not trusted because a hash matched).
 */
export function verifyDiagnosticSelection(
  deps,
  selection = DIAGNOSTIC_SELECTION,
) {
  const problems = [];
  const observed = {
    authority: {},
    files: {},
    review: {},
    recipe: null,
    executable: null,
    backend: {},
    platform: { os: deps.platform, arch: deps.arch },
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
  const [authorityPath] = Object.keys(selection.authority);
  const authority = attempt("authority JSON", () =>
    JSON.parse(String(deps.read(authorityPath))),
  );
  if (authority !== null) {
    const expectSame = (what, got, want) => {
      if (got !== want)
        problems.push(
          `the authority's ${what} is ${JSON.stringify(got)}, the selection ${JSON.stringify(want)}`,
        );
    };
    expectSame("authority", authority.authority, "human_user");
    expectSame(
      "binary path",
      authority.binary?.path,
      selection.executable.path,
    );
    expectSame(
      "binary sha256",
      authority.binary?.sha256,
      selection.executable.sha256,
    );
    expectSame("head", authority.head, selection.backend.head);
    expectSame(
      "preserved review sha256",
      authority.preserved_review_sha256,
      selection.review.sha256,
    );
    expectSame(
      "independent review path",
      authority.independent_review?.path,
      selection.review.named_path,
    );
    expectSame(
      "independent review sha256",
      authority.independent_review?.sha256,
      selection.review.sha256,
    );
    expectSame("recipe path", authority.recipe?.path, selection.recipe.path);
    expectSame(
      "recipe sha256",
      authority.recipe?.sha256,
      selection.recipe.sha256,
    );
    const [, , proposalPath] = Object.keys(selection.authority);
    expectSame("proposal path", authority.proposal?.path, proposalPath);
    expectSame(
      "proposal sha256",
      authority.proposal?.sha256,
      selection.authority[proposalPath],
    );
    expectSame(
      "consumer task",
      authority.consumer?.task_id,
      selection.consumer.task_id,
    );
    expectSame(
      "consumer worktree",
      authority.consumer?.worktree,
      selection.consumer.worktree,
    );
  }
  // The approved review: the preserved bytes are verified; the rotating path named by the authority is observed and recorded only.
  const preserved = attempt("preserved review", () =>
    deps.hashFile(selection.review.preserved_path),
  );
  observed.review.preserved = {
    path: selection.review.preserved_path,
    sha256: preserved,
  };
  if (preserved !== null && preserved !== selection.review.sha256)
    problems.push(
      `preserved review sha256 ${preserved}, approved ${selection.review.sha256}`,
    );
  let named = null;
  try {
    named = deps.hashFile(selection.review.named_path);
  } catch {
    named = null;
  }
  observed.review.named = {
    path: selection.review.named_path,
    sha256: named,
    note:
      named === selection.review.sha256
        ? "still the approved bytes"
        : "the rotating path no longer holds the approved bytes (observed only; the preserved copy is the verified one)",
  };
  const recipe = attempt("recipe", () => deps.hashFile(selection.recipe.path));
  observed.recipe = { path: selection.recipe.path, sha256: recipe };
  if (recipe !== null && recipe !== selection.recipe.sha256)
    problems.push(
      `recipe sha256 ${recipe}, approved ${selection.recipe.sha256}`,
    );
  const executable = attempt("executable", () =>
    deps.hashFile(selection.executable.path),
  );
  observed.executable = { path: selection.executable.path, sha256: executable };
  if (executable !== null && executable !== selection.executable.sha256)
    problems.push(
      `executable sha256 ${executable}, approved ${selection.executable.sha256}`,
    );
  for (const [path, expected] of Object.entries(selection.files)) {
    const got = attempt(`file ${path}`, () => deps.hashFile(path));
    observed.files[path] = got;
    if (got !== null && got !== expected)
      problems.push(`file ${path}: sha256 ${got}, approved ${expected}`);
  }
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
    record: {
      label: selection.label,
      identity: selectionIdentity(selection),
      expected: selection,
      observed,
    },
  };
}

/** Copies the approved diagnostic executable into `dir` and verifies the COPY (as `stageExecutable`); throws on any difference. */
export function stageDiagnosticExecutable(
  dir,
  deps = {
    copy: copyFileSync,
    chmod: chmodSync,
    hashFile: (p) => sha256Of(readFileSync(p)),
  },
  selection = DIAGNOSTIC_SELECTION,
) {
  const path = join(dir, selection.executable.name);
  deps.copy(selection.executable.path, path);
  deps.chmod(path, 0o755);
  const sha256 = deps.hashFile(path);
  if (sha256 !== selection.executable.sha256)
    throw new Error(
      `the staged diagnostic executable hashes to ${sha256}, approved ${selection.executable.sha256}`,
    );
  return { path, sha256 };
}
