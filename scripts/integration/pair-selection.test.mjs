// WEB-09c R23-PAIR: the hash-bound selection refuses every difference (doubles), and the real selection holds on this host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import {
  PAIR_SELECTION,
  realSelectionDeps,
  sha256Of,
  stageExecutable,
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
test("the approved selection holds on this host", {
  skip:
    !existsSync(PAIR_SELECTION.manifest.path) &&
    "the approved pairing artefacts are not on this host",
}, () => {
  const out = verifySelection(
    realSelectionDeps((cmd, args) =>
      spawnSync(cmd, args, { encoding: "utf8" }),
    ),
  );
  assert.deepEqual(out.problems, []);
});
