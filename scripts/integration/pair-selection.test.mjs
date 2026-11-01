// WEB-09c R23-PAIR: the hash-bound selection refuses every difference (doubles), and the real selection holds on this host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  const authority = { "/o/approval.json": "approval" };
  const types = { path: "/o/types.tgz", content: "types" };
  const files = Object.fromEntries(
    Object.entries(contents).map(([p, c]) => [p, sha256Of(c)]),
  );
  const manifest = JSON.stringify({
    backend_head: "head1",
    backend_tree: "tree1",
    files,
    api_types: {
      path: types.path,
      sha256: sha256Of(types.content),
      provenance: { api_version: "0.30.0" },
    },
    ...(change.manifest ?? {}),
  });
  const selection = {
    label: "test",
    authority: Object.fromEntries(
      Object.entries(authority).map(([p, c]) => [p, sha256Of(c)]),
    ),
    manifest: {
      path: "/o/manifest.json",
      sha256: sha256Of(change.manifestBytes ?? manifest),
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

// The REAL selection on this host (read-only: hashes and git rev-parse/status of the backend checkout). Skipped, and said so, where the
// approved artefacts are not present (another machine): there it proves nothing and passes nothing.
//
// Revision 26 ADAPTATION R26-A1 (for the reviewer to accept or reject; the original expectation is preserved in the execution report):
// this test asserted `problems === []`. Since 1 November 2026 the approved backend checkout has moved (HEAD d9adb95, a new tree, a rotated
// `.agtx/review.md`), so the normal development selection correctly REFUSES on this host (R26-DIAG: "This refusal is correct protection").
// The intent kept: the real-host verdict is EXACT. Either the checkout is the approved one and nothing is wrong, or it has moved and the
// refusal is exactly the moved-checkout set: no other file, authority, manifest, type or platform problem is tolerated, and the test
// never reports the normal selection as usable when it is not.
const MOVED = [
  /^file .*\/\.agtx\/review\.md: sha256 [0-9a-f]{64}, approved 60f6e41a/,
  /^backend HEAD [0-9a-f]{40}, approved 633edd4f/,
  /^backend tree [0-9a-f]{40}, approved 1f1c84dc/,
];
test("the approved selection holds on this host, or refuses exactly a moved backend checkout (R26-A1)", {
  skip:
    !existsSync(PAIR_SELECTION.manifest.path) &&
    "the approved pairing artefacts are not on this host",
}, () => {
  const out = verifySelection(
    realSelectionDeps((cmd, args) =>
      spawnSync(cmd, args, { encoding: "utf8" }),
    ),
  );
  if (out.record.observed.backend.head === PAIR_SELECTION.backend.head) {
    assert.deepEqual(out.problems, []);
    return;
  }
  assert.equal(out.ok, false, "a moved checkout is never usable");
  for (const problem of out.problems)
    assert.ok(
      MOVED.some((m) => m.test(problem)),
      `an unexpected refusal besides the moved checkout: ${problem}`,
    );
  assert.ok(
    out.problems.some((p) => MOVED[1].test(p)),
    "the moved HEAD is named",
  );
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
