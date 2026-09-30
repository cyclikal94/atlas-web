import { execFileSync } from "node:child_process";

/** The frontend commit that is being built. `dirty` is true when the working tree differs from it. */
export function gitState() {
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
