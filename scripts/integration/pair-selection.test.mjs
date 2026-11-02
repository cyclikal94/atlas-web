// WEB-09c R23-PAIR: the hash-bound selection refuses every difference (doubles), and the real selection holds on this host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DIAGNOSTIC_SELECTION,
  PAIR_SELECTION,
  realDiagnosticDeps,
  realSelectionDeps,
  selectionIdentity,
  sha256Of,
  stageDiagnosticExecutable,
  stageExecutable,
  verifyDiagnosticSelection,
  verifySelection,
} from "./pair-selection.mjs";

/** A consistent fake selection: every file's content, a manifest naming them, and deps that answer from these maps. */
function world(change = {}) {
  const contents = {
    "/b/atlas-server": "binary",
    "/b/openapi.json": "openapi",
    "/b/contract.md": "contract",
  };
  const types = { path: "/o/types.tgz", content: "types" };
  const files = Object.fromEntries(
    Object.entries(contents).map(([p, c]) => [p, sha256Of(c)]),
  );
  const manifest = JSON.stringify({
    backend_head: "head1",
    backend_tree: "tree1",
    backend_checkout: "/b",
    files,
    api_types: {
      path: types.path,
      sha256: sha256Of(types.content),
      provenance: { api_version: "0.30.0" },
    },
    ...(change.manifest ?? {}),
  });
  const manifestSha256 = sha256Of(change.manifestBytes ?? manifest);
  // R40-PAIR: the original authority, the path reconciliation naming it, the manifest and the reconciliation's review.
  const reconciliation = JSON.stringify({
    original_authority: {
      path: "/o/approval.json",
      sha256: sha256Of("approval"),
    },
    manifest: { path: "/o/manifest.json", sha256: manifestSha256 },
    independent_review: { path: "/o/review.md", sha256: sha256Of("review") },
    ...(change.reconciliation ?? {}),
  });
  const authority = {
    "/o/approval.json": "approval",
    "/o/reconciliation.json": reconciliation,
    "/o/review.md": "review",
  };
  const selection = {
    label: "test",
    authority: Object.fromEntries(
      Object.entries(authority).map(([p, c]) => [p, sha256Of(c)]),
    ),
    reconciliation: {
      authority: "/o/reconciliation.json",
      original: "/o/approval.json",
      review: "/o/review.md",
      ...(change.roles ?? {}),
    },
    manifest: {
      path: "/o/manifest.json",
      sha256: manifestSha256,
    },
    backend: {
      checkout: "/b",
      head: "head1",
      tree: "tree1",
      executable: "/b/atlas-server",
      apiVersion: "0.30.0",
    },
    files,
    types: {
      path: types.path,
      sha256: sha256Of(types.content),
      version: "0.0.0-test",
    },
    platform: { os: "darwin", arch: "arm64" },
  };
  const disk = {
    ...contents,
    ...authority,
    [types.path]: types.content,
    "/o/manifest.json": manifest,
    ...(change.disk ?? {}),
  };
  const git = {
    "rev-parse HEAD": "head1",
    "rev-parse HEAD^{tree}": "tree1",
    "status --porcelain --untracked-files=no": "",
    ...(change.git ?? {}),
  };
  const deps = {
    read: (path) => {
      if (!(path in disk)) throw new Error(`ENOENT ${path}`);
      return Buffer.from(disk[path]);
    },
    hashFile: (path) => {
      if (!(path in disk)) throw new Error(`ENOENT ${path}`);
      return sha256Of(disk[path]);
    },
    git: (args) => {
      const key = args.join(" ");
      if (git[key] instanceof Error) throw git[key];
      return git[key];
    },
    platform: change.platform ?? "darwin",
    arch: change.arch ?? "arm64",
  };
  return { selection, deps };
}

test("a consistent selection verifies, and the record keeps every observed value", () => {
  const { selection, deps } = world();
  const out = verifySelection(deps, selection);
  assert.deepEqual(out.problems, []);
  assert.equal(out.ok, true);
  assert.equal(out.record.observed.backend.head, "head1");
  assert.equal(
    out.record.observed.files["/b/atlas-server"],
    sha256Of("binary"),
  );
});

for (const [name, change, expected] of [
  [
    "another platform",
    { platform: "linux", arch: "x64" },
    /unsupported platform linux\/x64/,
  ],
  [
    "the executable changed on disk",
    { disk: { "/b/atlas-server": "other" } },
    /file \/b\/atlas-server: sha256/,
  ],
  [
    "a pinned file is missing",
    { disk: { "/b/contract.md": undefined } },
    /file \/b\/contract.md: sha256 undefined|file \/b\/contract.md/,
  ],
  [
    "the manifest bytes differ from the pin",
    { manifestBytes: "something else" },
    /manifest sha256/,
  ],
  [
    "the authority record changed",
    { disk: { "/o/approval.json": "edited" } },
    /authority \/o\/approval.json/,
  ],
  [
    "the types tarball changed",
    { disk: { "/o/types.tgz": "edited" } },
    /types sha256/,
  ],
  [
    "the backend is at another commit",
    { git: { "rev-parse HEAD": "head2" } },
    /backend HEAD head2/,
  ],
  [
    "the backend tree differs",
    { git: { "rev-parse HEAD^{tree}": "tree2" } },
    /backend tree tree2/,
  ],
  [
    "the backend has tracked changes",
    { git: { "status --porcelain --untracked-files=no": " M src/x.rs" } },
    /tracked changes/,
  ],
  [
    "git cannot be asked",
    { git: { "rev-parse HEAD": new Error("not a repository") } },
    /backend HEAD: not a repository/,
  ],
])
  test(`refused: ${name}`, () => {
    const { selection, deps } = world(change);
    if (change.disk && Object.values(change.disk).includes(undefined)) {
      const original = deps.hashFile;
      deps.hashFile = (path) => {
        if (change.disk[path] === undefined && path in change.disk)
          throw new Error(`ENOENT ${path}`);
        return original(path);
      };
    }
    const out = verifySelection(deps, selection);
    assert.equal(out.ok, false);
    assert.ok(
      out.problems.some((p) => expected.test(p)),
      `${name}: ${JSON.stringify(out.problems)}`,
    );
  });

test("refused: a manifest that names other files, another head or another API version, even when its own hash is the pin", () => {
  for (const manifest of [
    { files: { "/b/atlas-server": sha256Of("binary") } },
    { backend_head: "head9" },
    {
      api_types: {
        path: "/o/types.tgz",
        sha256: sha256Of("types"),
        provenance: { api_version: "0.31.0" },
      },
    },
  ]) {
    const { selection, deps } = world({ manifest });
    const out = verifySelection(deps, selection);
    assert.equal(out.ok, false, JSON.stringify(manifest));
  }
});

// R40-PAIR: the path reconciliation is bound by its CONTENT as well as its hash, and the manifest names the checkout that is read.
for (const [name, change, expected] of [
  [
    "the manifest names another backend checkout",
    { manifest: { backend_checkout: "/elsewhere" } },
    /^manifest backend_checkout \/elsewhere, selected \/b$/,
  ],
  [
    "the reconciliation names another manifest path",
    { reconciliation: { manifest: { path: "/o/other.json", sha256: "x" } } },
    /^the reconciliation's manifest path is "\/o\/other.json"/,
  ],
  [
    "the reconciliation names another manifest hash",
    {
      reconciliation: {
        manifest: { path: "/o/manifest.json", sha256: "f".repeat(64) },
      },
    },
    /^the reconciliation's manifest sha256 is "f{64}"/,
  ],
  [
    "the reconciliation names another original authority",
    {
      reconciliation: {
        original_authority: {
          path: "/o/approval.json",
          sha256: "0".repeat(64),
        },
      },
    },
    /^the reconciliation's original authority sha256 is "0{64}"/,
  ],
  [
    "the reconciliation names another independent review",
    {
      reconciliation: {
        independent_review: {
          path: "/o/elsewhere.md",
          sha256: sha256Of("review"),
        },
      },
    },
    /^the reconciliation's independent review path is "\/o\/elsewhere.md"/,
  ],
  [
    "the selection's reconciliation role is not a pinned authority",
    { roles: { original: "/o/unpinned.json" } },
    /^the reconciliation's original \/o\/unpinned.json is not a pinned authority$/,
  ],
  [
    "the reconciliation's review bytes changed",
    { disk: { "/o/review.md": "edited" } },
    /^authority \/o\/review.md: sha256/,
  ],
  [
    "the reconciliation authority is not JSON",
    { disk: { "/o/reconciliation.json": "not json" } },
    /^reconciliation authority JSON: /,
  ],
])
  test(`refused: ${name} (R40-PAIR)`, () => {
    const { selection, deps } = world(change);
    const out = verifySelection(deps, selection);
    assert.equal(out.ok, false);
    assert.ok(
      out.problems.some((p) => expected.test(p)),
      `${name}: ${JSON.stringify(out.problems)}`,
    );
  });

test("refused: a selection without a reconciliation (R40-PAIR)", () => {
  const { selection, deps } = world();
  const { reconciliation: _, ...without } = selection;
  const out = verifySelection(deps, without);
  assert.equal(out.ok, false);
  for (const role of ["authority", "original", "review"])
    assert.ok(
      out.problems.includes(
        `the reconciliation's ${role} undefined is not a pinned authority`,
      ),
      JSON.stringify(out.problems),
    );
});

test("the executable is staged as a COPY and the copy is verified; a copy with other bytes throws", () => {
  const { selection } = world();
  const copies = [];
  const staged = stageExecutable(
    "/run",
    {
      copy: (from, to) => copies.push([from, to]),
      chmod: () => undefined,
      hashFile: () => sha256Of("binary"),
    },
    selection,
  );
  assert.deepEqual(copies, [["/b/atlas-server", "/run/atlas-server"]]);
  assert.equal(staged.path, "/run/atlas-server");
  assert.throws(
    () =>
      stageExecutable(
        "/run",
        {
          copy: () => undefined,
          chmod: () => undefined,
          hashFile: () => sha256Of("tampered"),
        },
        selection,
      ),
    /staged executable hashes to/,
  );
});

// ---- R40-PAIR: the ADOPTED normal selection on this host ---------------------------------------------------------------------------
//
// Revision 40 retires revision 26's adaptation R26-A1 (which tolerated exactly a moved-checkout refusal while the maintained selection read
// the active BE-Q23 checkout). The path reconciliation of 2 November 2026 retains the approved source at a stable isolated checkout, so the
// ORIGINAL expectation is restored: on this host the maintained selection, through the DEFAULT dependencies the runner uses
// (`realSelectionDeps`, git in `PAIR_SELECTION.backend.checkout`), verifies with no problem at all. The moved-checkout refusal is kept as
// a deliberate NEGATIVE control below; it can no longer satisfy readiness. On a host without the artefacts these tests are skipped and say
// so: there they prove nothing and pass nothing.
const ORCH = "/Users/kieran/atlas/atlas-orchestrator";
const STABLE = `${ORCH}/.local/atlas/maintenance/web09c-r39-admission-20261102/normal-backend`;
const BE_Q23 =
  "/Users/kieran/atlas/atlas/.agtx/worktrees/f3852338-BE-Q23--Measured-bounded-sync";
/**
 * The approved identities, fixed here INDEPENDENTLY of pair-selection.mjs (from Decision D's manifest f434df4a… and the reconciled manifest
 * 202eac18…, read and hashed by the author on 2 Nov 2026): a constant mistyped in the selector fails this table, not just a hash on disk.
 */
const APPROVED = {
  head: "633edd4f3d36383df140f0022d129e49128ba338",
  tree: "1f1c84dc1e3e4fb9b83367fcd3aad86df4e78405",
  apiVersion: "0.30.0",
  files: {
    "target/debug/atlas-server":
      "a6a73bbfb368f17612d00b3b4d71c0c6273764b52e1b514fddd3814e96a294c9",
    "api/openapi.json":
      "9433b84572d083b53fdf545e88f69d5a526d254908b97192854d0edeed80aaed",
    ".agtx/contract/bounded-sync-contract-v1.md":
      "d8677478cbc315750a6027b13faddf755def0fd33e4e6bd989e5670372bab386",
    ".agtx/review.md":
      "60f6e41a2621eea1810c08c18153fc9e65536aa3bba835a96118be61ae749e9c",
    "scripts/sync_dense_fixture.py":
      "8ff71cc18b95175f9ad6c8cf1b929b22775fbacb8b09183c2860b69773736cd5",
    "scripts/api-types/package-lock.json":
      "ceb016b20df02408c885a7de9c202c31b4fcf02259a1a16cefae8c66f97200cf",
  },
  types: {
    path: `${ORCH}/.local/atlas/maintenance/unblock-all-20261029/backend-pairing/api-types/atlas-api-types-0.0.0-pairing.20261029.tgz`,
    sha256: "5694ff2da18af982b8275c32468df3c96ebb85876e63ad1c76698a850568c06a",
    version: "0.0.0-pairing.20261029",
  },
  manifest: {
    path: `${ORCH}/delivery/tooling/web09c-r39-admission-20261102/normal-pair-manifest.json`,
    sha256: "202eac1826aa4a66749137d90ba7c7d64a3db4f0cb0ad37f594dedacadd910b4",
  },
  authority: {
    [`${ORCH}/approval/web09c-development-pair-approved-20261029.json`]:
      "98209f388dcbcb11f56320ee225a61b4a6d6d2ea9eb614f5aa444676d89dd246",
    [`${ORCH}/delivery/handoffs/web09c-development-pair-approved-20261029.md`]:
      "65e3417644eaceaa2287411ea62afe4e0192b559591f8723a86a92b8141a377e",
    [`${ORCH}/approval/web09c-r39-path-reconciliation-20261102.json`]:
      "3b0dd3ccb74a8c6affb631c42c2a8b348fd051da0cc9b260475732789fdeae54",
    [`${ORCH}/delivery/handoffs/web09c-r39-admission-reconciliation-20261102.md`]:
      "3456ffa33ef8f8411d7fb0a51b9693ae4f72f2337bd3ec207fe6b90744d48429",
    [`${ORCH}/delivery/tooling/web09c-r39-admission-20261102/review.md`]:
      "f42aea475f3986eb92dde73497464b8f03b90207271f551c8f3b7a2d08a52d95",
  },
};
/** The diagnostic selection's identity BEFORE revision 40 (computed on 2d1d2ab): the normal-only change must not move it. */
const DIAGNOSTIC_IDENTITY_R39 =
  "eb628c991ae387f019afd596b6b856f37b26f3ee5755a55e45266085a276a259";
const ON_HOST =
  !existsSync(PAIR_SELECTION.manifest.path) &&
  "the approved pairing artefacts are not on this host (unqualified here)";
const spawn = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
/** A deep, mutable copy of the maintained selection. */
const copyOf = (s) => JSON.parse(JSON.stringify(s));
/** The selection with its backend location moved to `checkout` (the six file keys and the executable follow), everything else kept. */
function relocated(selection, checkout) {
  const s = copyOf(selection);
  s.files = Object.fromEntries(
    Object.entries(s.files).map(([p, h]) => [
      p.replace(selection.backend.checkout, checkout),
      h,
    ]),
  );
  s.backend.checkout = checkout;
  s.backend.executable = selection.backend.executable.replace(
    selection.backend.checkout,
    checkout,
  );
  return s;
}
/** The default deps, with git run in `checkout` (only for descriptors deliberately not the maintained one). */
const depsAt = (checkout) => ({
  ...realSelectionDeps(spawn),
  git: (args) => {
    const done = spawn("git", ["-C", checkout, ...args]);
    if (done.status !== 0) throw new Error(`git: exit ${done.status}`);
    return done.stdout.trim();
  },
});

test("R40-PAIR: the maintained selection names exactly the approved identities at the reconciled stable paths", () => {
  assert.equal(PAIR_SELECTION.backend.checkout, STABLE);
  assert.equal(
    PAIR_SELECTION.backend.executable,
    `${STABLE}/target/debug/atlas-server`,
  );
  assert.equal(PAIR_SELECTION.backend.head, APPROVED.head);
  assert.equal(PAIR_SELECTION.backend.tree, APPROVED.tree);
  assert.equal(PAIR_SELECTION.backend.apiVersion, APPROVED.apiVersion);
  assert.deepEqual(
    { ...PAIR_SELECTION.files },
    Object.fromEntries(
      Object.entries(APPROVED.files).map(([rel, h]) => [`${STABLE}/${rel}`, h]),
    ),
  );
  assert.deepEqual({ ...PAIR_SELECTION.types }, APPROVED.types);
  assert.deepEqual({ ...PAIR_SELECTION.manifest }, APPROVED.manifest);
  assert.deepEqual({ ...PAIR_SELECTION.authority }, APPROVED.authority);
  assert.deepEqual(
    { ...PAIR_SELECTION.reconciliation },
    {
      authority: `${ORCH}/approval/web09c-r39-path-reconciliation-20261102.json`,
      original: `${ORCH}/approval/web09c-development-pair-approved-20261029.json`,
      review: `${ORCH}/delivery/tooling/web09c-r39-admission-20261102/review.md`,
    },
  );
  assert.deepEqual(
    { ...PAIR_SELECTION.platform },
    { os: "darwin", arch: "arm64" },
  );
  for (const path of Object.keys(PAIR_SELECTION.files))
    assert.ok(
      !path.startsWith(BE_Q23),
      `${path} reads the active BE-Q23 checkout`,
    );
});

test("R40-PAIR: the adopted selection verifies on this host through the runner's default dependencies, with no problem at all", {
  skip: ON_HOST,
}, () => {
  const out = verifySelection(realSelectionDeps(spawn));
  assert.deepEqual(out.problems, []);
  assert.equal(out.ok, true);
  assert.deepEqual(out.record.observed.backend, {
    head: APPROVED.head,
    tree: APPROVED.tree,
    tracked_changes: [],
  });
  for (const [rel, h] of Object.entries(APPROVED.files))
    assert.equal(out.record.observed.files[`${STABLE}/${rel}`], h, rel);
  assert.equal(out.record.observed.types.sha256, APPROVED.types.sha256);
  assert.equal(out.record.observed.manifest.sha256, APPROVED.manifest.sha256);
});

test("R40-PAIR: the default staging copies the stable executable into the run's directory and the copy hashes to the approved bytes", {
  skip: ON_HOST,
}, () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "r40-stage-"));
  try {
    // A refused copy (other bytes, or no file) is this test's assertion failure, not an unrelated error.
    let staged = null;
    assert.doesNotThrow(() => {
      staged = stageExecutable(dir);
    });
    assert.equal(staged.path, join(dir, "atlas-server"));
    assert.equal(staged.sha256, APPROVED.files["target/debug/atlas-server"]);
    assert.equal(sha256Of(readFileSync(staged.path)), staged.sha256);
    assert.equal(statSync(staged.path).mode & 0o777, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One real input perturbed at a time on top of the DEFAULT deps; each refusal must name its own cause. */
const REAL_TAMPER = [
  ...Object.keys(APPROVED.files).map((rel) => [
    `the stable ${rel} changed`,
    { hash: `${STABLE}/${rel}` },
    new RegExp(
      `^file ${STABLE}/${rel.replace(/[.]/g, "\\.")}: sha256 0{64}, approved ${APPROVED.files[rel]}$`,
    ),
  ]),
  [
    "the types tarball changed",
    { hash: APPROVED.types.path },
    /^types sha256 0{64}, approved 5694ff2d/,
  ],
  ...Object.keys(APPROVED.authority).map((path) => [
    `the authority ${path.slice(ORCH.length)} changed`,
    { hash: path },
    new RegExp(
      `^authority ${path.replace(/[.]/g, "\\.")}: sha256 0{64}, approved`,
    ),
  ]),
  [
    "Decision D's authority is missing",
    {
      missing: `${ORCH}/approval/web09c-development-pair-approved-20261029.json`,
    },
    /^authority .*web09c-development-pair-approved-20261029\.json: ENOENT/,
  ],
  [
    "the reconciliation authority is missing",
    {
      missing: `${ORCH}/approval/web09c-r39-path-reconciliation-20261102.json`,
    },
    /^reconciliation authority JSON: ENOENT/,
  ],
  [
    "the manifest bytes differ",
    { manifestBytes: "{}" },
    /^manifest sha256 [0-9a-f]{64}, approved 202eac18/,
  ],
  [
    "the manifest is missing",
    { missing: APPROVED.manifest.path },
    /^manifest: ENOENT/,
  ],
  [
    "the backend is at another commit",
    { git: { "rev-parse HEAD": "d".repeat(40) } },
    /^backend HEAD d{40}, approved 633edd4f/,
  ],
  [
    "the backend tree differs",
    { git: { "rev-parse HEAD^{tree}": "e".repeat(40) } },
    /^backend tree e{40}, approved 1f1c84dc/,
  ],
  [
    "the backend has tracked changes",
    {
      git: {
        "status --porcelain --untracked-files=no":
          " M crates/server/src/main.rs",
      },
    },
    /^the backend checkout has tracked changes$/,
  ],
  [
    "another platform",
    { platform: "linux" },
    /^unsupported platform linux\/arm64/,
  ],
  [
    "another architecture",
    { arch: "x64" },
    /^unsupported platform darwin\/x64/,
  ],
];
for (const [name, t, expected] of REAL_TAMPER)
  test(`R40-PAIR refused on this host: ${name}`, { skip: ON_HOST }, () => {
    const real = realSelectionDeps(spawn);
    const deps = {
      ...real,
      read: (path) => {
        if (path === t.missing) throw new Error(`ENOENT ${path}`);
        if (t.manifestBytes && path === APPROVED.manifest.path)
          return Buffer.from(t.manifestBytes);
        return real.read(path);
      },
      hashFile: (path) => {
        if (path === t.missing) throw new Error(`ENOENT ${path}`);
        if (path === t.hash) return "0".repeat(64);
        return real.hashFile(path);
      },
      git: (args) => t.git?.[args.join(" ")] ?? real.git(args),
      platform: t.platform ?? real.platform,
      arch: t.arch ?? real.arch,
    };
    const out = verifySelection(deps);
    assert.equal(out.ok, false);
    assert.ok(
      out.problems.some((p) => expected.test(p)),
      `${name}: ${JSON.stringify(out.problems)}`,
    );
  });

test("R40-PAIR negative control: the same selection read from the active BE-Q23 checkout is refused, never usable", {
  skip: ON_HOST,
}, () => {
  const moved = relocated(PAIR_SELECTION, BE_Q23);
  const out = verifySelection(depsAt(BE_Q23), moved);
  assert.equal(
    out.ok,
    false,
    "the mutable checkout is never the approved backend",
  );
  // Deterministic whatever BE-Q23 now holds: the reconciled manifest names the stable location, not this one.
  assert.ok(
    out.problems.includes(
      `manifest backend_checkout ${STABLE}, selected ${BE_Q23}`,
    ),
    JSON.stringify(out.problems),
  );
  assert.ok(
    out.problems.includes(
      "manifest files differ from the approved selection (paths or hashes)",
    ),
  );
  // The pre-R40 descriptor (old manifest, old paths) is still refused on the moved checkout's identities, as revision 26 recorded.
  if (out.record.observed.backend.head !== APPROVED.head)
    assert.ok(
      out.problems.some((p) =>
        /^backend HEAD [0-9a-f]{40}, approved 633edd4f/.test(p),
      ),
    );
});

test("R40-PAIR negative control: a normal selection cross-wired to the diagnostic executable or checkout is refused", {
  skip: ON_HOST,
}, () => {
  const wired = copyOf(PAIR_SELECTION);
  const hash = wired.files[wired.backend.executable];
  delete wired.files[wired.backend.executable];
  wired.backend.executable = DIAGNOSTIC_SELECTION.executable.path;
  wired.files[wired.backend.executable] = hash;
  const out = verifySelection(realSelectionDeps(spawn), wired);
  assert.equal(out.ok, false);
  assert.ok(
    out.problems.includes(
      "manifest files differ from the approved selection (paths or hashes)",
    ),
  );
  if (existsSync(DIAGNOSTIC_SELECTION.executable.path))
    assert.ok(
      out.problems.some((p) =>
        p.startsWith(
          `file ${DIAGNOSTIC_SELECTION.executable.path}: sha256 61e2a0e7`,
        ),
      ),
      JSON.stringify(out.problems),
    );
  const atDiagnostic = relocated(
    PAIR_SELECTION,
    DIAGNOSTIC_SELECTION.backend.checkout,
  );
  assert.equal(
    verifySelection(depsAt(DIAGNOSTIC_SELECTION.backend.checkout), atDiagnostic)
      .ok,
    false,
  );
});

test("R40-PAIR: the normal-only change leaves the diagnostic selection's identity and location, and the released path, as they were", () => {
  assert.equal(
    selectionIdentity(DIAGNOSTIC_SELECTION),
    DIAGNOSTIC_IDENTITY_R39,
  );
  assert.equal(DIAGNOSTIC_SELECTION.backend.checkout, BE_Q23);
  assert.equal(
    DIAGNOSTIC_SELECTION.executable.path,
    `${BE_Q23}/target/q23-review9/debug/atlas-sync-diagnostic`,
  );
  assert.notEqual(
    PAIR_SELECTION.backend.checkout,
    DIAGNOSTIC_SELECTION.backend.checkout,
  );
  for (const path of [
    ...Object.keys(PAIR_SELECTION.files),
    PAIR_SELECTION.manifest.path,
    PAIR_SELECTION.types.path,
  ]) {
    assert.ok(
      !/contract-pin|atlas-pair-released-backend|SHA256SUMS/.test(path),
      path,
    );
  }
});

// ---- R26-DIAG: the diagnostic selection ------------------------------------------------------------------------------------------------
/** A consistent fake diagnostic selection and deps answering from maps; `change` perturbs one input. */
function diagnosticWorld(change = {}) {
  const contents = {
    "/o/approval.json": "",
    "/o/handover.md": "handover",
    "/o/proposal.json": "proposal",
    "/o/review9.md": "review 9",
    "/b/.agtx/review.md": "review 10",
    "/b/docs/testing.md": "recipe",
    "/b/target/atlas-sync-diagnostic": "diagnostic binary",
    "/b/api/openapi.json": "openapi",
  };
  const h = (p) => sha256Of(contents[p]);
  const authority = {
    authority: "human_user",
    head: "head9",
    preserved_review_sha256: h("/o/review9.md"),
    proposal: { path: "/o/proposal.json", sha256: h("/o/proposal.json") },
    binary: {
      path: "/b/target/atlas-sync-diagnostic",
      sha256: h("/b/target/atlas-sync-diagnostic"),
    },
    independent_review: {
      path: "/b/.agtx/review.md",
      sha256: h("/o/review9.md"),
    },
    recipe: { path: "/b/docs/testing.md", sha256: h("/b/docs/testing.md") },
    consumer: { task_id: "task-1", worktree: "/w" },
    ...(change.authority ?? {}),
  };
  contents["/o/approval.json"] = JSON.stringify(authority);
  const selection = {
    mode: "diagnostic",
    label: "test",
    authority: {
      "/o/approval.json": sha256Of(contents["/o/approval.json"]),
      "/o/handover.md": h("/o/handover.md"),
      "/o/proposal.json": h("/o/proposal.json"),
    },
    review: {
      named_path: "/b/.agtx/review.md",
      preserved_path: "/o/review9.md",
      sha256: h("/o/review9.md"),
    },
    recipe: { path: "/b/docs/testing.md", sha256: h("/b/docs/testing.md") },
    backend: {
      checkout: "/b",
      head: "head9",
      tree: "tree9",
      apiVersion: "0.30.0",
    },
    executable: {
      path: "/b/target/atlas-sync-diagnostic",
      name: "atlas-sync-diagnostic",
      sha256: h("/b/target/atlas-sync-diagnostic"),
    },
    files: { "/b/api/openapi.json": h("/b/api/openapi.json") },
    features: { "sync-diagnostic": true, "test-hooks": false },
    retentionSeconds: 7776000,
    consumer: { task_id: "task-1", worktree: "/w" },
    platform: { os: "darwin", arch: "arm64" },
  };
  for (const [path, value] of Object.entries(change.contents ?? {}))
    if (value === undefined) delete contents[path];
    else contents[path] = value;
  const git = {
    "rev-parse HEAD": "head9",
    "rev-parse HEAD^{tree}": "tree9",
    "status --porcelain --untracked-files=no": "",
    ...(change.git ?? {}),
  };
  const deps = {
    read: (p) => {
      if (!(p in contents)) throw new Error(`ENOENT ${p}`);
      return Buffer.from(contents[p]);
    },
    hashFile: (p) => {
      if (!(p in contents)) throw new Error(`ENOENT ${p}`);
      return sha256Of(contents[p]);
    },
    git: (args) => {
      const key = args.join(" ");
      if (!(key in git)) throw new Error(`git ${key}`);
      return git[key];
    },
    platform: change.platform ?? "darwin",
    arch: change.arch ?? "arm64",
  };
  return { selection, deps };
}

test("diagnostic: a consistent selection verifies; the rotating review path is OBSERVED, never accepted in place of the preserved bytes", () => {
  const { selection, deps } = diagnosticWorld();
  const out = verifyDiagnosticSelection(deps, selection);
  assert.deepEqual(out.problems, []);
  assert.equal(out.ok, true);
  assert.equal(
    out.record.observed.review.preserved.sha256,
    selection.review.sha256,
  );
  assert.notEqual(
    out.record.observed.review.named.sha256,
    selection.review.sha256,
  );
  assert.match(
    out.record.observed.review.named.note,
    /no longer holds the approved bytes/,
  );
  assert.equal(out.record.identity, selectionIdentity(selection));
});

for (const [name, change, expected] of [
  ["another platform", { platform: "linux" }, /unsupported platform linux/],
  ["another architecture", { arch: "x64" }, /unsupported platform darwin\/x64/],
  [
    "a changed handover",
    { contents: { "/o/handover.md": "edited" } },
    /authority \/o\/handover\.md: sha256/,
  ],
  [
    "a missing proposal",
    { contents: { "/o/proposal.json": undefined } },
    /authority \/o\/proposal\.json|proposal/,
  ],
  [
    "a changed preserved review",
    { contents: { "/o/review9.md": "review 9 edited" } },
    /preserved review sha256/,
  ],
  [
    "a changed recipe",
    { contents: { "/b/docs/testing.md": "recipe edited" } },
    /recipe sha256/,
  ],
  [
    "a rebuilt executable",
    { contents: { "/b/target/atlas-sync-diagnostic": "rebuilt" } },
    /executable sha256/,
  ],
  [
    "a changed contract file",
    { contents: { "/b/api/openapi.json": "openapi 2" } },
    /file \/b\/api\/openapi\.json/,
  ],
  [
    "another backend HEAD",
    { git: { "rev-parse HEAD": "head10" } },
    /backend HEAD head10/,
  ],
  [
    "another backend tree",
    { git: { "rev-parse HEAD^{tree}": "tree10" } },
    /backend tree tree10/,
  ],
  [
    "tracked backend changes",
    { git: { "status --porcelain --untracked-files=no": " M src/x.rs" } },
    /tracked changes/,
  ],
  [
    "an authority naming another binary",
    {
      authority: {
        binary: { path: "/b/target/other", sha256: "0".repeat(64) },
      },
    },
    /authority's binary path/,
  ],
  [
    "an authority naming another head",
    { authority: { head: "head8" } },
    /authority's head/,
  ],
  [
    "an authority naming another consumer",
    { authority: { consumer: { task_id: "task-2", worktree: "/w" } } },
    /authority's consumer task/,
  ],
  [
    "an authority not from a human",
    { authority: { authority: "agent" } },
    /authority's authority/,
  ],
]) {
  test(`diagnostic: refused: ${name}`, () => {
    const world = diagnosticWorld(change);
    const out = verifyDiagnosticSelection(world.deps, world.selection);
    assert.equal(out.ok, false);
    assert.ok(
      out.problems.some((p) => expected.test(p)),
      `${name}: ${out.problems.join(" | ")}`,
    );
  });
}

test("diagnostic: the executable is staged as a COPY under its own name and the copy is verified; other bytes throw", () => {
  const { selection } = diagnosticWorld();
  const copies = [];
  const staged = stageDiagnosticExecutable(
    "/run",
    {
      copy: (a, b) => copies.push([a, b]),
      chmod: () => undefined,
      hashFile: () => selection.executable.sha256,
    },
    selection,
  );
  assert.deepEqual(copies, [
    ["/b/target/atlas-sync-diagnostic", "/run/atlas-sync-diagnostic"],
  ]);
  assert.equal(staged.path, "/run/atlas-sync-diagnostic");
  assert.throws(
    () =>
      stageDiagnosticExecutable(
        "/run",
        {
          copy: () => undefined,
          chmod: () => undefined,
          hashFile: () => "f".repeat(64),
        },
        selection,
      ),
    /staged diagnostic executable hashes to f{64}/,
  );
});

test("diagnostic: the selections stay distinct (the normal one is not repointed at the diagnostic executable)", () => {
  assert.notEqual(
    PAIR_SELECTION.backend.executable,
    DIAGNOSTIC_SELECTION.executable.path,
  );
  assert.equal(
    PAIR_SELECTION.backend.head,
    "633edd4f3d36383df140f0022d129e49128ba338",
  );
  assert.equal(
    DIAGNOSTIC_SELECTION.backend.head,
    "d9adb95de7ee7a7db90f2ad0fd90824688b8cad1",
  );
  assert.equal(
    DIAGNOSTIC_SELECTION.executable.sha256,
    "61e2a0e7ab0e1e434c76705ac8cb0c23bbe754ae8a1e5ed1191fe8621192c50a",
  );
  assert.equal(
    DIAGNOSTIC_SELECTION.review.sha256,
    "2a8fcb1366fb0fc294606ea34e75679c9c385663786d194217078ed92af13a88",
  );
  assert.equal(selectionIdentity(), selectionIdentity(DIAGNOSTIC_SELECTION));
});

test("diagnostic: the approved selection holds on this host", {
  skip:
    !existsSync(DIAGNOSTIC_SELECTION.executable.path) &&
    "the approved diagnostic executable is not on this host",
}, () => {
  const out = verifyDiagnosticSelection(
    realDiagnosticDeps((cmd, args) =>
      spawnSync(cmd, args, { encoding: "utf8" }),
    ),
  );
  assert.deepEqual(out.problems, []);
});
