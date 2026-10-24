import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const module = new URL("./git.mjs", import.meta.url).href;
const hash = (s) => createHash("sha256").update(s).digest("hex");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atlas-provenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".runner-input"));
  writeFileSync(join(root, "source.txt"), "original");
  const manifest = {
    head: "a".repeat(40),
    git_state: { commit: "a".repeat(40), dirty: true, tag: null },
    files: { "source.txt": hash("original") },
    source_sha256: "b".repeat(64),
  };
  return { root, manifest, path: join(root, ".runner-input/manifest.json") };
}
function run(f) {
  writeFileSync(f.path, JSON.stringify(f.manifest));
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {gitState} from ${JSON.stringify(module)};console.log(JSON.stringify(gitState()));`,
    ],
    {
      cwd: f.root,
      env: { ...process.env, ATLAS_RUNNER_SOURCE_MANIFEST: f.path },
      encoding: "utf8",
    },
  );
}
test("snapshot carries the actual captured commit and dirty state without Git history", (t) => {
  const f = fixture(t),
    r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(r.stdout);
  assert.equal(state.commit, f.manifest.head);
  assert.equal(state.dirty, true);
});
test("changed source, unsafe paths and incomplete provenance refuse", (t) => {
  for (const mutate of [
    (f) => writeFileSync(join(f.root, "source.txt"), "changed"),
    (f) => (f.manifest.files["../outside"] = "x"),
    (f) => (f.manifest.git_state.commit = null),
  ]) {
    const f = fixture(t);
    mutate(f);
    assert.notEqual(run(f).status, 0);
  }
});
test("ordinary repository provenance continues to use Git", (t) => {
  const f = fixture(t);
  execFileSync("git", ["init", "-q"], { cwd: f.root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Atlas Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Fixture",
    ],
    { cwd: f.root },
  );
  const env = { ...process.env };
  delete env.ATLAS_RUNNER_SOURCE_MANIFEST;
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {gitState} from ${JSON.stringify(module)};console.log(JSON.stringify(gitState()));`,
    ],
    { cwd: f.root, env, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).commit, /^[a-f0-9]{40}$/);
});
