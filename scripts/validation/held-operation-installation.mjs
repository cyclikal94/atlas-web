// WEB-08d revision 27 (review r26 R26-N1; design assessment eff76566, invariants I2-I5, correction steps 1-3): the INSTALLED CONTENT a
// held-operation run executes, and the private installation it executes from. Revision 26 compared four package trees and pnpm's two
// metadata files; React, react-dom, the Vite plugins and every other installed byte were outside the record, so a changed installed
// dependency still admitted saved controls (review r26: a private `react/index.js` changed, the record's bytes stayed identical).
//
// Completeness is structural, not a list of names:
//  - the manifest is the WHOLE `node_modules` of the execution root (the pnpm virtual store, hoisted links, `.bin` shims, native and
//    generated payloads): every directory, every file by its bytes and executable bit, every link by the entry it really resolves to.
//    A link must resolve inside the measured installation (its target's bytes are then measured where they stand); a dangling link, a
//    link out of it, a special file, an unreadable entry or a file sharing its bytes with another path (a hard link) is a refusal;
//  - resolution cannot leave it: no other `node_modules` may stand between any execution origin and the filesystem root, Node's global
//    folders must be absent, NODE_OPTIONS must be empty and every NODE_PATH entry (the children's and every `.bin` shim's) must lie
//    inside it. A file that names the live worktree's installation is a refusal (a fallback into unmeasured bytes);
//  - tool CACHES under node_modules (Vite's `.vite` and `.vite-temp`) are not copied into a snapshot and are measured by neither side.
//    Revision 29 (R28-N1): they are not "outputs, never inputs" (Vite imported a generated config module from `.vite-temp`): a snapshot
//    has none, nothing it runs creates one, and creating one after sealing changes the sealed node_modules entry.
// The execution root's own absolute path is replaced by a token before hashing (`n` marks such an entry), so the same content at another
// private path has the same identity, while a path to anywhere else still counts as content. pnpm's `lastValidatedTimestamp` (when it
// last checked, not what is installed) is the one field normalised away from its workspace state file.
//
// Execution is bound to what was measured (I4): a run executes from a PRIVATE SNAPSHOT (createSnapshot): the fingerprinted source files
// and the installation, cloned (APFS copy-on-write: no link or inode shared with the live tree or the pnpm store) into a new 0700
// directory under TMPDIR. pnpm finishes its own preparation there first (it relinks `.bin` shims to their new location), then the
// installation is SEALED read-only and its stat inventory (inode, size, mode, link count, modification and change times of every entry
// outside the caches) is recorded. Any write, replacement or addition after that changes an inode or a change time, which no ordinary
// writer can restore; the inventory is compared before every child is started and at the end (verifySealed), so a change made and
// undone between two collections (A -> B -> A) still fails the run. Limit, stated rather than claimed away: a process of the same user
// that deliberately unseals and edits the private snapshot between two checks could only be detected by those checks, and a clock set
// backwards by an administrator could forge a change time; no exclusion of such writers is claimed.
//
// Revision 28 (review r27 R27-N2; design assessment 3f7047c0 RC2, I2, I5, I8, steps C1-C2): a snapshot's installation was copied with
// its root link kept verbatim, and relocation then wrote THROUGH that link into the installation it named (the live one), before
// anything had proved the copy was physically separate. Nothing is written now until independence is established:
//  - installationRootProblems refuses a `node_modules` root that is a link (absolute, relative or dangling) or that resolves anywhere but
//    `<root>/node_modules`, before any copy (the reviewed conservative option: linked layouts are refused, not materialised);
//  - createSnapshot writes only into an empty, owned 0700 destination that is neither inside nor around the source, and then proves the
//    copy independent (independenceProblems): its root a different directory from the source's, every file with one link (a file
//    sharing an inode is a hard link), every link resolving inside the copy itself. A copied absolute link back to the source is refused;
//  - relocate, seal and removeSnapshot re-check the root (an owned allocation keeps its device and inode: a replaced root is refused,
//    never chmodded or traversed), write files only through no-follow descriptors, and never follow a link;
//  - sourceState is the source installation's complete content, mode and link state, compared before and after preparation by the
//    shared lifecycle (held-operation-execution.mjs), so a write into the source is a refusal that names it.
// Snapshot records are of schema /2 (they also record the private runtime's seal and the guarded trees, held-operation-execution.mjs).
// Sealing now makes FILES read-only and leaves directories owner-writable (a SIGKILLed run's residue under the shared driver's TMPDIR
// otherwise made the driver's own cleanup fail before it wrote its results); detection never relied on the modes: every write,
// addition, removal or replacement changes the stat inventory.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const INSTALLATION_SCHEMA = "web08d-held-operation-installation/1";
export const SNAPSHOT_SCHEMA = "web08d-held-operation-snapshot/2";
/** Tool cache/output directories directly under node_modules: outputs, never measured, never copied. */
export const CACHE_DIRS = [".vite", ".vite-temp"];
/** pnpm's workspace state: the one file normalised (its last validation time is not installed content). */
export const WORKSPACE_STATE = ".pnpm-workspace-state-v1.json";
/** The token an execution root's own absolute path becomes before hashing. */
export const ROOT_TOKEN = "<execution-root>";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const inside = (base, p) => p === base || p.startsWith(`${base}${sep}`);
const posix = (p) => p.split(sep).join("/");

/** Both spellings of a directory (as given and as the kernel resolves it, e.g. /var and /private/var), longest first. */
function spellings(dir) {
  return [...new Set([resolve(dir), realpathSync(dir)])].sort(
    (a, b) => b.length - a.length,
  );
}
/** `bytes` with every spelling of the execution root replaced by the token, and whether anything was replaced. */
function normalised(bytes, roots) {
  let out = bytes;
  let changed = false;
  const token = Buffer.from(ROOT_TOKEN);
  for (const r of roots) {
    const needle = Buffer.from(r);
    if (out.indexOf(needle) < 0) continue;
    const parts = [];
    let from = 0;
    for (
      let at = out.indexOf(needle);
      at >= 0;
      at = out.indexOf(needle, from)
    ) {
      parts.push(out.subarray(from, at), token);
      from = at + needle.length;
    }
    parts.push(out.subarray(from));
    out = Buffer.concat(parts);
    changed = true;
  }
  return { bytes: out, changed };
}
/** Every NODE_PATH entry a pnpm `.bin` shim exports (an empty list when it exports none). */
export function shimNodePaths(text) {
  const out = [];
  for (const m of text.matchAll(/export NODE_PATH="([^"]*)"/g))
    for (const entry of m[1].split(":"))
      if (entry && entry !== "$NODE_PATH") out.push(entry);
  return out;
}

/**
 * The complete manifest of `<root>/node_modules` (design assessment step 1): sorted inventory lines, their digest and counts. `foreign`
 * names absolute directories no installed file may name (the live installation a snapshot was cloned from). Throws on any refusal.
 */
export function installationManifest(root, { foreign = [] } = {}) {
  const roots = spellings(root);
  const base = realpathSync(join(root, "node_modules"));
  const baseSpellings = [
    ...new Set([join(resolve(root), "node_modules"), base]),
  ];
  const forbidden = foreign.flatMap((f) =>
    existsSync(f) ? spellings(f) : [resolve(f)],
  );
  const lines = [];
  const counts = {
    directories: 0,
    files: 0,
    links: 0,
    bytes: 0,
    normalised: 0,
  };
  const refuse = (rel, why) => {
    throw new Error(`installation entry ${rel}: ${why}`);
  };
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && CACHE_DIRS.includes(e.name)) continue;
      const full = join(dir, e.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const text = readlinkSync(full);
        let real;
        try {
          real = realpathSync(full);
        } catch {
          refuse(r, `a dangling link (${text})`);
        }
        if (!inside(base, real))
          refuse(
            r,
            `a link out of the measured installation (${text} -> ${real})`,
          );
        const kind = lstatSync(real).isDirectory() ? "D" : "F";
        lines.push(`L ${r} -> ${posix(relative(base, real)) || "."} ${kind}`);
        counts.links++;
      } else if (st.isDirectory()) {
        lines.push(`D ${r}`);
        counts.directories++;
        walk(full, r);
      } else if (st.isFile()) {
        if (st.nlink !== 1)
          refuse(
            r,
            `a file sharing its bytes with ${st.nlink - 1} other path(s) (a hard link)`,
          );
        let bytes = readFileSync(full);
        for (const f of forbidden)
          if (bytes.indexOf(join(f, "node_modules")) >= 0)
            refuse(r, `names the live installation ${join(f, "node_modules")}`);
        if (/(^|\/)\.bin\//.test(r))
          for (const entry of shimNodePaths(bytes.toString("utf8")))
            if (!baseSpellings.some((b) => inside(b, entry)))
              refuse(
                r,
                `exports NODE_PATH ${entry}, outside the measured installation`,
              );
        if (r === WORKSPACE_STATE) {
          const state = JSON.parse(bytes.toString("utf8"));
          delete state.lastValidatedTimestamp;
          bytes = Buffer.from(JSON.stringify(state));
        }
        const n = normalised(bytes, roots);
        if (n.changed) counts.normalised++;
        lines.push(
          `F ${r} ${st.mode & 0o111 ? "x" : "-"}${n.changed || r === WORKSPACE_STATE ? "n" : "-"} ${sha256(n.bytes)}`,
        );
        counts.files++;
        counts.bytes += st.size;
      } else refuse(r, "neither a file, a directory nor a link");
    }
  };
  walk(base, "");
  return {
    schema: INSTALLATION_SCHEMA,
    sha256: sha256(lines.join("\n")),
    entries: lines.length,
    ...counts,
    inventory: lines,
  };
}

/** The digest an inventory has (installationManifest's `sha256`): a saved inventory is checked against it, never trusted. */
export const inventoryDigest = (lines) => sha256(lines.join("\n"));

/** Added, removed and changed entries between two inventories (diagnostics only; `limit` per kind). */
export function inventoryDifferences(was, now, limit = 20) {
  const key = (l) => l.split(" ")[1];
  const a = new Map(was.map((l) => [key(l), l]));
  const b = new Map(now.map((l) => [key(l), l]));
  const out = { added: [], removed: [], changed: [] };
  for (const [k, l] of b)
    if (!a.has(k)) out.added.push(l);
    else if (a.get(k) !== l) out.changed.push({ was: a.get(k), now: l });
  for (const [k, l] of a) if (!b.has(k)) out.removed.push(l);
  return {
    counts: {
      added: out.added.length,
      removed: out.removed.length,
      changed: out.changed.length,
    },
    added: out.added.slice(0, limit),
    removed: out.removed.slice(0, limit),
    changed: out.changed.slice(0, limit),
  };
}

/**
 * Where Node could resolve a module from outside the measured installation (design assessment step 2): every other `node_modules` on
 * the way from each origin (and its real path) to the filesystem root, and Node's global folders for each Node executable. Returns the
 * problems (empty when resolution can only reach `<root>/node_modules`).
 */
export function resolutionProblems(root, origins, { home, nodes = [] }) {
  const own = realpathSync(join(root, "node_modules"));
  const problems = [];
  const seen = new Set();
  for (const origin of origins)
    for (const start of spellings(origin)) {
      for (let d = start; ; d = dirname(d)) {
        const candidate = join(d, "node_modules");
        if (!seen.has(candidate)) {
          seen.add(candidate);
          if (existsSync(candidate) && realpathSync(candidate) !== own)
            problems.push(`${candidate} could be resolved from ${origin}`);
        }
        if (d === dirname(d)) break;
      }
    }
  const globals = [
    ...(home
      ? [join(home, ".node_modules"), join(home, ".node_libraries")]
      : []),
    ...nodes.map((exec) => join(dirname(dirname(exec)), "lib", "node")),
  ];
  for (const g of globals)
    if (existsSync(g)) problems.push(`Node's global folder ${g} exists`);
  return problems;
}

/** A configuration file's digest, or "none" when it does not exist. */
export function fileDigestOrNone(path) {
  try {
    return sha256(readFileSync(path));
  } catch (error) {
    if (error.code === "ENOENT") return "none";
    throw error;
  }
}
/** The package-manager configuration outside the worktree that pnpm (and npm's config loader) reads, by name. */
export function globalConfig(home, env = {}) {
  const xdg = env.XDG_CONFIG_HOME || (home ? join(home, ".config") : null);
  const files = {
    npmrc_user: home ? join(home, ".npmrc") : null,
    pnpm_rc_macos: home ? join(home, "Library/Preferences/pnpm/rc") : null,
    pnpm_config_macos: home
      ? join(home, "Library/Preferences/pnpm/config.yaml")
      : null,
    pnpm_rc_xdg: xdg ? join(xdg, "pnpm/rc") : null,
    pnpm_config_xdg: xdg ? join(xdg, "pnpm/config.yaml") : null,
  };
  return Object.fromEntries(
    Object.entries(files).map(([k, p]) => [
      k,
      p ? fileDigestOrNone(p) : "none",
    ]),
  );
}

/** The allocations this process made (allocateSnapshot): real path -> device and inode, so a replaced root is never treated as owned. */
const ALLOCATIONS = new Map();
/** A new, empty, private (0700) snapshot directory under `parent`, by its real path; its identity is kept for every later writer. */
export function allocateSnapshot(parent, prefix = "held-op-exec-") {
  const dir = realpathSync(mkdtempSync(join(parent, prefix)));
  chmodSync(dir, 0o700);
  const st = lstatSync(dir);
  ALLOCATIONS.set(dir, { dev: st.dev, ino: st.ino });
  return dir;
}
/**
 * Throws unless `dir` is still the real directory it was (revision 28, I2): not a link, not replaced since this process allocated it
 * (same device and inode), private to its owner. A directory this process did not allocate must at least be a real directory.
 */
export function assertOwnedRoot(dir, when) {
  let st;
  try {
    st = lstatSync(dir);
  } catch (error) {
    throw new Error(
      `the execution directory ${dir} is gone ${when}: ${error.code ?? error.message}`,
    );
  }
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new Error(
      `the execution directory ${dir} is not a real directory ${when} (nothing is written through it)`,
    );
  const owned = ALLOCATIONS.get(dir);
  if (owned && (owned.dev !== st.dev || owned.ino !== st.ino))
    throw new Error(
      `the execution directory ${dir} was replaced ${when} (it is not the directory allocated; nothing is written through it)`,
    );
  if (owned && (st.mode & 0o077) !== 0)
    throw new Error(
      `the execution directory ${dir} is no longer private ${when}`,
    );
  if (realpathSync(dir) !== resolve(dir) && owned)
    throw new Error(
      `the execution directory ${dir} no longer resolves to itself ${when}`,
    );
}
/**
 * Why `root`'s installation cannot be snapshotted (revision 28, R27-N2, H2): its `node_modules` must be a real directory at exactly
 * `<root>/node_modules`, never a link of any kind. Returns the problems (empty when it can be copied); nothing is written.
 */
export function installationRootProblems(root) {
  const nm = join(root, "node_modules");
  let st;
  try {
    st = lstatSync(nm);
  } catch (error) {
    return [
      `the installation root ${nm} cannot be read: ${error.code ?? error.message}`,
    ];
  }
  if (st.isSymbolicLink()) {
    let real = null;
    try {
      real = realpathSync(nm);
    } catch {
      real = null;
    }
    return [
      `the installation root ${nm} is a link (${readlinkSync(nm)}${real ? ` -> ${real}` : ", dangling"}): a linked installation is not supported and is never copied or written through`,
    ];
  }
  if (!st.isDirectory())
    return [`the installation root ${nm} is not a directory`];
  if (realpathSync(nm) !== join(realpathSync(root), "node_modules"))
    return [
      `the installation root ${nm} resolves to ${realpathSync(nm)}, not inside ${realpathSync(root)}`,
    ];
  return [];
}
/** True when one of two real paths contains the other (or they are the same). */
const overlapping = (a, b) => inside(a, b) || inside(b, a);
/**
 * Why the copy `dir/node_modules` of `source/node_modules` is not physically independent (revision 28, C1): the copy's root must be a
 * different directory from the source's (device and inode), every file must have one link (a file sharing an inode with any other path,
 * the source's included, is a hard link; a directory can only be shared through a link), and every link must resolve inside the copy
 * itself. Returns the problems (empty when independent).
 */
export function independenceProblems(source, dir) {
  const from = join(source, "node_modules");
  const to = join(dir, "node_modules");
  const problems = [];
  const rootProblems = installationRootProblems(dir);
  if (rootProblems.length) return rootProblems.map((p) => `the copy: ${p}`);
  const base = realpathSync(to);
  const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
  const sourceStat = (rel) => {
    try {
      return lstatSync(rel ? join(from, rel) : from);
    } catch {
      return null;
    }
  };
  if (same(lstatSync(to), sourceStat("")))
    problems.push(`the copy's installation root is the source's own directory`);
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort(byName)) {
      if (problems.length > 20) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = join(d, e.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        let real = null;
        try {
          real = realpathSync(full);
        } catch {
          problems.push(`${r} is a dangling link in the copy`);
          continue;
        }
        if (!inside(base, real))
          problems.push(
            `${r} resolves to ${real}, outside the copy (the copy would share what it names)`,
          );
        continue;
      }
      // A file sharing the source's inode is a hard link (refused below); a directory cannot be shared but through a link (above).
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile() && st.nlink !== 1)
        problems.push(
          `${r} shares its bytes with ${st.nlink - 1} other path(s) (a hard link)`,
        );
    }
  };
  walk(to, "");
  return problems;
}
/**
 * Fills a private execution snapshot `dir` of `root` (design assessment step 3): a clone of each fingerprinted source file (`files`:
 * name -> SHA-256, as runtime.mjs fingerprint() records them; each clone is checked against it) and of the whole installation except
 * its caches, symlinks copied verbatim. Returns `dir`.
 *
 * Revision 28 (R27-N2, C1): refuses a linked installation root BEFORE anything is copied, writes only into an empty real directory that
 * neither contains nor is contained by the source, and refuses a copy that is not physically independent (independenceProblems)
 * before any later writer (relocation, pnpm, sealing) can reach it.
 */
export function createSnapshot({ root, files, dir }) {
  const rootProblems = installationRootProblems(root);
  if (rootProblems.length) throw new Error(rootProblems.join("; "));
  assertOwnedRoot(dir, "before the snapshot was copied");
  if (overlapping(realpathSync(root), realpathSync(dir)))
    throw new Error(`the snapshot ${dir} and its source ${root} overlap`);
  if (readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  for (const [name, digest] of Object.entries(files)) {
    if (digest === "deleted") continue;
    if (
      name.split("/").includes("node_modules") ||
      isAbsolute(name) ||
      name.split("/").some((c) => c === ".." || c === "." || c === "")
    )
      throw new Error(
        `a source file name that cannot be copied safely: ${name}`,
      );
    const from = join(root, name);
    if (!lstatSync(from).isFile())
      throw new Error(`a source entry that is not a regular file: ${name}`);
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    copyFileSync(from, join(dir, name), constants.COPYFILE_FICLONE);
    if (sha256(readFileSync(join(dir, name))) !== digest)
      throw new Error(
        `the snapshot's copy of ${name} is not the fingerprinted file`,
      );
  }
  const modules = join(root, "node_modules");
  if (existsSync(join(dir, "node_modules")))
    throw new Error(
      `a source file created ${join(dir, "node_modules")} before the installation was copied`,
    );
  cpSync(modules, join(dir, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (from) => !CACHE_DIRS.some((c) => from === join(modules, c)),
  });
  const shared = independenceProblems(root, dir);
  if (shared.length)
    throw new Error(
      `the snapshot's installation is not independent of its source (nothing is relocated, prepared or sealed): ${shared.slice(0, 5).join("; ")}`,
    );
  return dir;
}

/** Writes `bytes` to the existing regular file `path` without following a link, keeping its mode (revision 28: no write through a link). */
export function writeNoFollow(path, bytes, mode) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
  );
  try {
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    fchmodSync(fd, mode & 0o7777);
  } finally {
    closeSync(fd);
  }
}

/**
 * Relocates a snapshot's installation (design assessment step 3, "finish preparation inside it"): pnpm writes the installation's
 * absolute location into generated files (every `.bin` shim's NODE_PATH, nested ones included, and its workspace state), and its own
 * preparation in a new location rewrites only the top-level shims. Every installed file that names the live installation (`from`, in
 * either spelling) is rewritten to name the snapshot instead, as pnpm would have generated it there. Returns the relocated entries.
 */
export function relocate(root, from) {
  assertOwnedRoot(root, "before relocation");
  const rootProblems = installationRootProblems(root);
  if (rootProblems.length)
    throw new Error(`relocation refused: ${rootProblems.join("; ")}`);
  if (overlapping(realpathSync(root), realpathSync(from)))
    throw new Error(`relocation refused: ${root} and ${from} overlap`);
  const pairs = [
    [realpathSync(from), root],
    [resolve(from), root],
  ].filter(([a], i, all) => all.findIndex(([b]) => b === a) === i);
  const relocated = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && CACHE_DIRS.includes(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) {
        const bytes = readFileSync(full);
        let out = bytes;
        for (const [a, b] of pairs) {
          const needle = Buffer.from(a);
          if (out.indexOf(needle) < 0) continue;
          const parts = [];
          let start = 0;
          for (
            let at = out.indexOf(needle);
            at >= 0;
            at = out.indexOf(needle, start)
          ) {
            parts.push(out.subarray(start, at), Buffer.from(b));
            start = at + needle.length;
          }
          parts.push(out.subarray(start));
          out = Buffer.concat(parts);
        }
        if (out !== bytes) {
          writeNoFollow(full, out, lstatSync(full).mode);
          relocated.push(r);
        }
      }
    }
  };
  walk(join(root, "node_modules"), "");
  return relocated;
}

/** Every entry of the snapshot outside `.agtx` (its copy trees) and the caches, with what any write changes (bigint times). */
export function statInventory(root) {
  const lines = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === ".agtx" || CACHE_DIRS.some((c) => r === `node_modules/${c}`))
        continue;
      const full = join(dir, e.name);
      const st = lstatSync(full, { bigint: true });
      const kind = st.isSymbolicLink() ? "L" : st.isDirectory() ? "D" : "F";
      lines.push(
        `${kind} ${r} ${st.ino} ${st.size} ${st.mode} ${st.nlink} ${st.mtimeNs} ${st.ctimeNs}${kind === "L" ? ` ${readlinkSync(full)}` : ""}`,
      );
      if (kind === "D") walk(full, r);
    }
  };
  walk(root, "");
  return { sha256: sha256(lines.join("\n")), entries: lines.length, lines };
}

/** Makes the snapshot's installation and source files read-only (revision 29: no tool cache is created); returns the baseline. */
export function seal(root) {
  // Revision 28: the root must still be the owned real directory and its installation a real directory (never chmod through a link).
  assertOwnedRoot(root, "before sealing");
  const rootProblems = installationRootProblems(root);
  if (rootProblems.length)
    throw new Error(`sealing refused: ${rootProblems.join("; ")}`);
  // Revision 29 (R28-N1): the tool caches are no longer created. Vite's bundled config module was written, imported and deleted there,
  // outside the inventory; build and preview now load their config in memory, and a cache directory created after sealing changes the
  // sealed node_modules entry, which every check sees.
  mkdirSync(join(root, ".agtx"), { recursive: true });
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === ".agtx" || CACHE_DIRS.some((c) => r === `node_modules/${c}`))
        continue;
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      // Revision 28: files lose write permission; directories keep their owner's (an interrupted run's residue, e.g. a SIGKILLed run
      // under the shared driver, must stay removable by an ordinary recursive removal of its TMPDIR). Anything added to, removed from
      // or renamed in a directory still changes the stat inventory (the directory's own change time and its entries).
      if (e.isDirectory()) walk(full, r);
      else readOnly(full);
    }
  };
  walk(root, "");
  return statInventory(root);
}
/** Removes write permission from one real entry, only when it has any (an entry already read-only keeps its change time). */
function readOnly(full) {
  const st = lstatSync(full);
  if (st.isSymbolicLink()) return;
  if ((st.mode & 0o222) !== 0) chmodSync(full, st.mode & 0o7555);
}
/**
 * Seals a whole tree (revision 28: the private runtime, a copied test tree once its patches are installed, a completed build) and
 * returns its stat inventory: every real file loses write permission; links are never followed. `root` must be a real directory.
 */
export function sealTree(root) {
  assertOwnedRoot(root, "before sealing a tree");
  // Files only, as in seal(): directories stay owner-writable so residue stays removable; every change is still in the inventory.
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else readOnly(full);
    }
  };
  walk(root);
  return statInventory(root);
}
/** Gives a sealed tree's real directories back their owner write permission (so it can be kept or removed); links are never followed. */
export function unsealTree(root) {
  assertOwnedRoot(root, "before unsealing a tree");
  const walk = (dir) => {
    chmodSync(dir, lstatSync(dir).mode | 0o700);
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory() && !e.isSymbolicLink()) walk(join(dir, e.name));
  };
  walk(root);
}

/** Throws when the sealed snapshot differs from its baseline (any write, replacement, addition or removal since sealing). */
export function verifySealed(root, baseline, when) {
  const now = statInventory(root);
  if (now.sha256 === baseline.sha256) return now;
  const was = new Set(baseline.lines);
  const is = new Set(now.lines);
  const first =
    now.lines.find((l) => !was.has(l)) ??
    baseline.lines.find((l) => !is.has(l));
  throw new Error(
    `the execution snapshot changed ${when}: ${first?.split(" ").slice(0, 2).join(" ") ?? "(entry order)"}`,
  );
}

/** Removes a snapshot (unsealing it first); returns null or the reason it could not be removed. */
export function removeSnapshot(root) {
  try {
    // Revision 28 (I2, I5): only the owned real directory is unsealed and removed; a root replaced by a link or another directory is
    // left alone (and reported), never chmodded or traversed. Links inside are removed as links, never followed.
    let present = true;
    try {
      lstatSync(root);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      present = false;
    }
    if (present) {
      assertOwnedRoot(root, "before removal");
      const walk = (dir) => {
        chmodSync(dir, 0o700);
        for (const e of readdirSync(dir, { withFileTypes: true }))
          if (e.isDirectory() && !e.isSymbolicLink()) walk(join(dir, e.name));
      };
      walk(root);
      rmSync(root, { recursive: true, force: true });
    }
    if (existsSync(root)) return `${root} still exists`;
    ALLOCATIONS.delete(root);
    return null;
  } catch (error) {
    return String(error.message ?? error);
  }
}

/**
 * The complete state of `root`'s installation as it stands (revision 28, I2): every entry under `<root>/node_modules` except the tool
 * caches, a directory by its mode, a file by its mode and bytes, a link by its text (never followed). Its digest is compared before and
 * after a snapshot is prepared, so any write into the source installation (a shim, a nested shim, the virtual store, pnpm's metadata, a
 * mode) is seen and named.
 */
export function sourceState(root) {
  const lines = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (rel === "" && CACHE_DIRS.includes(e.name)) continue;
      const full = join(dir, e.name);
      const st = lstatSync(full);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) lines.push(`L ${r} ${readlinkSync(full)}`);
      else if (st.isDirectory()) {
        lines.push(`D ${r} ${mode}`);
        walk(full, r);
      } else if (st.isFile())
        lines.push(`F ${r} ${mode} ${sha256(readFileSync(full))}`);
      else lines.push(`O ${r} ${mode}`);
    }
  };
  const nm = join(root, "node_modules");
  const st = lstatSync(nm);
  lines.push(
    st.isSymbolicLink()
      ? `L . ${readlinkSync(nm)}`
      : `D . ${(st.mode & 0o7777).toString(8)}`,
  );
  if (!st.isSymbolicLink()) walk(nm, "");
  return { sha256: sha256(lines.join("\n")), entries: lines.length, lines };
}

/**
 * Runs `pnpm exec node -e 0` in the snapshot: pnpm's own preparation (relinking its shims there) before anything is measured.
 * Revision 28 (R27-N1, C3): only through `launch`, the execution's guarded launcher (held-operation-execution.mjs): its private, sealed
 * copy of the launcher chain, its frozen environment, the guard before the child starts. There is no fallback to a `pnpm` on PATH.
 */
export function preparePnpm(root, launch) {
  if (typeof launch !== "function")
    throw new Error(
      "pnpm's preparation needs the execution's guarded launcher (no pnpm is resolved on PATH)",
    );
  const r = launch(
    "pnpm's preparation in the snapshot",
    ["exec", "node", "-e", "0"],
    {
      cwd: root,
      // A hang guard, not a duration requirement: a timeout refuses the run.
      timeout: 900_000,
    },
  );
  if (r.error) throw r.error;
  if (r.status !== 0)
    throw new Error(
      `pnpm's preparation in the snapshot exited ${r.status ?? r.signal}: ${`${r.stderr}${r.stdout}`.slice(-600)}`,
    );
  return `${r.stdout}${r.stderr}`;
}

/** The parent directory a snapshot is created in: the launcher's TMPDIR (never inside the worktree). */
export const snapshotParent = (env) => env.TMPDIR || os.tmpdir();
/** True when `p` is absolute and inside `base` (exported for the applicability collector's resolution checks). */
export const isInside = (base, p) => isAbsolute(p) && inside(base, p);
