import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// A pool archive carries the controller's real Git metadata, not synthetic history.
function snapshotState() {
  const path = process.env.ATLAS_RUNNER_SOURCE_MANIFEST;
  if (!path) return null;
  const root = realpathSync(process.cwd());
  if (realpathSync(path) !== resolve(root, ".runner-input/manifest.json"))
    throw new Error(
      "Source manifest must be the job's own immutable snapshot manifest",
    );
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const state = manifest.git_state;
  if (
    !state ||
    !/^[a-f0-9]{40}$/.test(state.commit) ||
    state.commit !== manifest.head ||
    typeof state.dirty !== "boolean" ||
    (state.tag !== null && typeof state.tag !== "string") ||
    !/^[a-f0-9]{64}$/.test(manifest.source_sha256) ||
    !Object.keys(manifest.files ?? {}).length
  )
    throw new Error("Incomplete snapshot Git provenance");
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = resolve(root, name),
      rel = relative(root, realpathSync(file));
    if (
      isAbsolute(name) ||
      name.split(/[\\/]/).includes("..") ||
      isAbsolute(rel) ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      !lstatSync(file).isFile() ||
      lstatSync(file).isSymbolicLink() ||
      createHash("sha256").update(readFileSync(file)).digest("hex") !== expected
    )
      throw new Error(`Snapshot source differs: ${name}`);
  }
  return { ...state, source_sha256: manifest.source_sha256 };
}

import { execFileSync } from "node:child_process";

/** The frontend commit that is being built. `dirty` is true when the working tree differs from it. */
export function gitState() {
  const snapshot = snapshotState();
  if (snapshot) return snapshot;
  const run = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const commit = run("rev-parse", "HEAD");
    const dirty =
      run("status", "--porcelain", "--untracked-files=no").length > 0;
    let tag = null;
    try {
      tag = run("describe", "--exact-match", "--tags", "HEAD");
    } catch {
      tag = null;
    }
    return { commit, dirty, tag };
  } catch {
    return { commit: null, dirty: true, tag: null };
  }
}
