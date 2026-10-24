// WEB-08d revision 28 (review r27 R27-N1/R27-N2; design assessment 3f7047c0 RC1/RC2, I2-I5, I7, I8, steps C1-C4): the EXECUTION of a
// held-operation run, from its first launch to its removal.
//
// Revision 27 bound the installation a run measured to the one it executed (a sealed private snapshot), but every child still started
// by name: `pnpm` resolved on the external PATH at each launch, that launcher resolved `corepack` again, Corepack ran Node and pnpm from
// their external locations, the package-manager configuration was read from the external HOME and Playwright launched the external
// browser installations. The applicability record measured that chain only at its two ends, so a launcher replaced, executed and
// restored between them (A -> B -> A) left both measurements equal and the run admitted (review r27's atomic-launcher probe). It also
// copied a linked installation root verbatim and relocated through it into the installation it named (R27-N2).
//
// Execution now uses only what was measured, from a PRIVATE RUNTIME that no external change can reach:
//  - launcherChain resolves the supported launcher chain once, without executing anything: the `pnpm` first on PATH must be either the
//    task's launcher (exactly `#!/bin/sh` + `exec corepack pnpm "$@"`; `corepack` then resolved on PATH) or Corepack's own `pnpm.js`;
//    Corepack's entry point must be `#!/usr/bin/env node` (`node` resolved on PATH, as `env` would); the package manager is the
//    project's exact `packageManager` (pnpm@x.y.z) from Corepack's cache (it is never downloaded). Anything else is an opaque launcher
//    whose closure cannot be known: a refusal, never an allowlist or a hash;
//  - createRuntime clones that chain into a new 0700 directory (APFS copy-on-write): the launcher's bytes, Node, the Corepack package,
//    the package manager's cached release, the package-manager configuration files that exist (none is created) under a private HOME,
//    and the browser installations the snapshot's own playwright-core names. The copy is proved independent (no shared inode, no hard
//    link, every link inside it), SEALED (its files read-only) and its stat inventory (inode, mode, size, link count, modification and change
//    times) recorded before the first launch;
//  - frozenEnv is the one environment every child gets: PATH is the private `bin` followed only by the operating system's own
//    directories (/usr/bin, /bin, /usr/sbin, /sbin: the sealed system volume on macOS, root-owned elsewhere), HOME/XDG_CONFIG_HOME,
//    COREPACK_HOME and PLAYWRIGHT_BROWSERS_PATH name the private copies, Corepack's network is off, and Playwright's transform cache and
//    pnpm's own data/state directory (PNPM_HOME: pnpm writes there on every launch) are private writable directories of the snapshot,
//    outside every seal. Inputs no measurement can follow refuse: DYLD_*/LD_PRELOAD/LD_LIBRARY_PATH, NODE_OPTIONS,
//    NODE_PATH, BASH_ENV/ENV, a package-manager setting naming an absolute path, a global npmrc beside the external Node;
//  - every launch (pnpm's preparation, the runtime probe, the build, the preview, Playwright) goes through the execution's GUARD: the
//    private runtime, the sealed snapshot (once sealed) and every guarded tree (copied test trees once their patches are installed,
//    completed builds, a mutant's build input) are compared with their seals immediately before the child starts, and at the end; the
//    command is the private launcher by its absolute path. A change at any time between two checks changes an inode or a change time,
//    which no ordinary writer can restore, so the next check (the end check at the latest) fails the run permanently;
//  - prepareExecution is the ONE lifecycle the producer, the split-stage check and the judge's current target share: refuse a linked
//    installation root before anything is written, record the source installation's state, allocate, copy the snapshot (proved
//    independent), create and seal the runtime, relocate, prepare through the guard, seal, and compare the source installation's state
//    again (any write into it is a refusal that names it). finishExecution unseals what it sealed outside the snapshot and removes only
//    the owned allocations, recording every error beside the primary one.
// Limits, stated rather than claimed away: a process of the same user that deliberately unseals a private copy and edits it between
// two checks is detected by the next check, not prevented; the operating system's own executables and libraries (/bin/sh, /usr/bin/env,
// ps, the dynamic loader) are outside this writer model; an administrator who sets the clock back could forge a change time.
//
// Revision 29 (review r28 R28-N1; design assessment d3cff73e RC1, RC2, I1, I3, I4, I6, steps 1-4): GENERATED files were classified by
// their location ("outputs, never inputs") rather than by their use, and some of them are executed. Playwright's transform cache was a
// private writable directory outside every seal: a cached JavaScript entry under the normal key, with a self-consistent checksum, was
// executed in place of the measured config and restored, and the completed run was admitted (review r28's cache probe). Vite's default
// config loader writes, imports and deletes a bundled config module under node_modules/.vite-temp the same way, and Corepack enables
// Node's compile cache in the shared TMPDIR. A path, a privacy bit or a payload checksum proves nothing about where executed code came
// from. One versioned EXECUTION POLICY (EXECUTION_POLICY, its definition's digest POLICY_SHA256) now classifies every generated input
// by its use, and every child runs under it:
//  - Playwright's transform cache is ELIMINATED: adaptPlaywright applies a version-bound adapter to the snapshot's own Playwright
//    (exactly 1.63.0: both bundled compilation caches, lib/common/index.js and lib/transform/esmLoader.js, by their exact upstream
//    digests; anything else refuses) before it is measured and sealed. Transformed code is never read from or written to disk: every
//    process (controller, in-thread or worker-thread ESM loader, worker, replacement worker) derives it from the measured source with
//    the measured transformer, and its source map travels by value (memory and the serialised cache), never through a file;
//  - Vite's bundled-config file is ELIMINATED: build and preview load their config with `--configLoader runner` (in memory, through
//    Vite's module runner; no temporary module). node_modules/.vite and .vite-temp are no longer created in the snapshot: their creation
//    changes the sealed node_modules entry, which the guard sees;
//  - Node's compile cache is DISABLED (NODE_DISABLE_COMPILE_CACHE=1: Corepack's enableCompileCache() is then a no-op);
//  - the environment is CLOSED: a child inherits only the names in INHERITED_ENV (locale, terminal, TMPDIR, the user's name; nothing
//    that can select code: no NODE_*, PW_*/PLAYWRIGHT_* such as PW_TEST_SOURCE_TRANSFORM, package-manager settings such as node-options,
//    VITE_*, JITI_*, ESBUILD_BINARY_PATH, NAPI_RS_*), plus the policy's own values; injection and path-valued settings still refuse;
//  - a copied package-manager configuration file that selects code (node-options, script-shell, pnpmfile, use-node-version, ...)
//    refuses (configProblems): its digest would measure the setting, not the code it names;
//  - the two remaining locations a child is pointed at, the (now unused) Playwright cache directory and pnpm's state directory (pnpm
//    only probes it with a file it creates and deletes at each launch, and carries on when refused), are made READ ONLY and GUARDED
//    EMPTY from sealing to the end, their own directory entries included (a write, even one created, read and deleted between two
//    checks by a writer that restores the mode, changes the directory's change time);
//  - the policy's identity and digest are recorded by the snapshot journal and the applicability record (`runtime.policy`,
//    `runtime.policy_sha256`) and bound into the completion record; every admission reader requires the current policy, and a record of
//    an older or missing policy is unknown, never admitted.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import {
  allocateSnapshot,
  assertOwnedRoot,
  CACHE_DIRS,
  createSnapshot,
  installationRootProblems,
  preparePnpm,
  relocate,
  removeSnapshot,
  SNAPSHOT_SCHEMA,
  seal,
  sealTree,
  snapshotParent,
  sourceState,
  statInventory,
  unsealTree,
  writeNoFollow,
} from "./held-operation-installation.mjs";

export const RUNTIME_SCHEMA = "web08d-held-operation-runtime/1";
/** The task's launcher (`.agtx/evidence/revision-9/pnpm-shim/pnpm`): exactly these bytes. */
export const TASK_SHIM = '#!/bin/sh\nexec corepack pnpm "$@"\n';
/** The operating system's own executable directories: the only PATH entries after the private runtime's `bin`. */
export const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
/** Inherited variables that inject code or configuration no measurement follows: refused when set to anything. */
export const REFUSED_ENV = [
  /^DYLD_/,
  /^LD_PRELOAD$/,
  /^LD_LIBRARY_PATH$/,
  /^NODE_OPTIONS$/,
  /^NODE_PATH$/,
  /^BASH_ENV$/,
  /^ENV$/,
];
/** Package-manager settings: one naming an absolute path points the chain at an unmeasured file, so it is refused. */
const SETTING = /^(npm_config_|NPM_CONFIG_|PNPM_|COREPACK_)/;
/** Settings the runtime replaces with its own (never inherited) and locations removed from the children's environment. */
const REPLACED_ENV = [
  "COREPACK_HOME",
  "COREPACK_ROOT",
  "PNPM_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "npm_execpath",
  "npm_node_execpath",
];
/** Playwright's directory names for an engine's installations (browsers.json `name`, `-` written `_`). */
const ENGINE_INSTALLS = {
  chromium: ["chromium", "chromium-headless-shell"],
  firefox: ["firefox"],
  webkit: ["webkit"],
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (base, p) => p === base || p.startsWith(`${base}${sep}`);

// ---- The execution policy (revision 29) ------------------------------------------------------------------------------------------
export const EXECUTION_POLICY = "web08d-held-operation-execution-policy/1";
export const PLAYWRIGHT_ADAPTER = "web08d-playwright-transform-adapter/1";
/** The one Playwright release the adapter knows; any other refuses (an unknown layout is never adapted by guesswork). */
export const PLAYWRIGHT_VERSION = "1.63.0";
/** The inherited variables a child may receive: locale, terminal, the disposable-file location and the user's name, nothing else. */
export const INHERITED_ENV = [
  "LANG",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "DEBUG",
  "TMPDIR",
  "USER",
  "LOGNAME",
];
/** The values the policy itself sets for every child (besides the private runtime's locations). */
export const POLICY_ENV = { NODE_DISABLE_COMPILE_CACHE: "1" };
/** How build and preview load vite.mutant.config.ts: in memory through Vite's module runner, never a generated module on disk. */
export const VITE_CONFIG_LOADER = ["--configLoader", "runner"];
/** A package-manager configuration key (normalised: lower case, no `-`/`_`) that selects code to run: a copied file setting one refuses. */
const CODE_SETTINGS =
  /^(nodeoptions|scriptshell|pnpmfile|globalpnpmfile|usenodeversion|nodeversion|npmpath|nodegyp|nodepath|shell)$/;
/**
 * The adapter's edits, the same in both bundled compilation caches: `[upstream, adapted]`, each upstream text present exactly once.
 * (1) a source map is retrieved from memory, never read from a file; (2) the cache entries hold the map by value and no code path;
 * (3) a lookup never reads cached code, and a transform is never written: every process transforms the measured source itself.
 */
const ADAPTER_EDITS = [
  [
    '      const sourceMapPath = sourceMaps.get(source);\n      try {\n        return {\n          map: JSON.parse(import_fs.default.readFileSync(sourceMapPath, "utf-8")),\n          url: source\n        };\n      } catch {\n        return null;\n      }\n    }',
    '      const map = sourceMaps.get(source);\n      return map && typeof map === "object" ? { map, url: source } : null;\n    }',
  ],
  [
    "  sourceMaps.set(entry.moduleUrl || filename, entry.sourceMapPath);\n  memoryCache.set(filename, entry);\n  return {\n    sourceMaps: [[entry.moduleUrl || filename, entry.sourceMapPath]],\n    memoryCache: [[filename, entry]],",
    "  sourceMaps.set(entry.moduleUrl || filename, entry.sourceMap);\n  memoryCache.set(filename, { moduleUrl: entry.moduleUrl });\n  return {\n    sourceMaps: [[entry.moduleUrl || filename, entry.sourceMap]],\n    memoryCache: [[filename, { moduleUrl: entry.moduleUrl }]],",
  ],
  [
    'function getFromCompilationCache(filename, contentHash, moduleUrl) {\n  const cache = memoryCache.get(filename);\n  if (cache?.codePath) {\n    try {\n      return { cachedCode: readCodeCache(cache.codePath) };\n    } catch {\n    }\n  }\n  const filePathHash = calculateFilePathHash(filename);\n  const hashPrefix = filePathHash + "_" + contentHash.substring(0, 7);\n  const cacheFolderName = filePathHash.substring(0, 2);\n  const cachePath = calculateCachePath(filename, cacheFolderName, hashPrefix);\n  const codePath = cachePath + ".js";\n  const sourceMapPath = cachePath + ".map";\n  try {\n    const cachedCode = readCodeCache(codePath);\n    const serializedCache = _innerAddToCompilationCacheAndSerialize(filename, { codePath, sourceMapPath, moduleUrl });\n    return { cachedCode, serializedCache };\n  } catch {\n  }\n  return {\n    addToCache: (code, map) => {\n      if ((0, import_globals.isWorkerProcess)())\n        return {};\n      clearOldCacheEntries(cacheFolderName, filePathHash);\n      import_fs.default.mkdirSync(import_path.default.dirname(cachePath), { recursive: true });\n      if (map)\n        import_fs.default.writeFileSync(sourceMapPath, JSON.stringify(map), "utf8");\n      writeCodeCache(codePath, code);\n      const serializedCache = _innerAddToCompilationCacheAndSerialize(filename, { codePath, sourceMapPath, moduleUrl });\n      return { serializedCache };\n    }\n  };\n}\n',
    `function getFromCompilationCache(filename, contentHash, moduleUrl) {\n  // ${PLAYWRIGHT_ADAPTER} (WEB-08d held-operation execution policy): no transformed code is read from or written to disk.\n  return {\n    addToCache: (code, map) => ({ serializedCache: _innerAddToCompilationCacheAndSerialize(filename, { sourceMap: map || null, moduleUrl }) })\n  };\n}\n`,
  ],
];
/** The two files the adapter changes, inside the playwright package: their exact upstream and adapted digests. */
export const ADAPTED_FILES = {
  "lib/common/index.js": {
    upstream:
      "f4a6b14f5ba21a118b58a6a25eb0b281a3acc4157023b014e0197145056124a4",
    adapted: "7add3a334a4052d8cbbf7d6d2e02751c2bd331afe9e66d21aabb18aea5f18785",
  },
  "lib/transform/esmLoader.js": {
    upstream:
      "51a0a75a3aee8ec1dcfd545ad5c45300c282b5c4fe6d0a74b5a6cdcb649ad0de",
    adapted: "0e541e9693836aaa31d4829acf4d827dc32df36bc235a9be96a01d0fcc87968e",
  },
};
/** Applies the adapter's edits to one upstream file's text; throws unless every upstream text occurs exactly once. */
export function adaptedText(text, file = "the file") {
  let out = text;
  for (const [from, to] of ADAPTER_EDITS) {
    const n = out.split(from).length - 1;
    if (n !== 1)
      throw new Error(
        `the transform adapter's anchor occurs ${n} times in ${file}, not once: an unknown Playwright layout is not adapted`,
      );
    out = out.replace(from, () => to);
  }
  return out;
}
/** The policy's definition: what it covers and how, each adapted file by its digests. POLICY_SHA256 is its canonical digest. */
export const POLICY_DEFINITION = {
  id: EXECUTION_POLICY,
  playwright_transform_cache: {
    disposition: "eliminated",
    adapter: PLAYWRIGHT_ADAPTER,
    version: PLAYWRIGHT_VERSION,
    files: ADAPTED_FILES,
    edits_sha256: sha256(JSON.stringify(ADAPTER_EDITS)),
  },
  vite_config: { disposition: "eliminated", loader: VITE_CONFIG_LOADER },
  vite_cache_dirs: { disposition: "absent-and-sealed" },
  node_compile_cache: { disposition: "disabled", env: POLICY_ENV },
  environment: { disposition: "closed", inherited: INHERITED_ENV },
  package_manager_config: {
    disposition: "refused-when-selecting-code",
    settings: CODE_SETTINGS.source,
  },
  generated_dirs: {
    disposition: "guarded-empty-read-only",
    dirs: [".agtx/cache/playwright", ".agtx/state/pnpm"],
  },
};
const sortedJson = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
export const POLICY_SHA256 = sha256(sortedJson(POLICY_DEFINITION));
/** The guarded-empty trees' names in a run's journal (snapshotProblems requires each of them). */
export const GENERATED_TREES = POLICY_DEFINITION.generated_dirs.dirs.map(
  (d) => `generated ${d}`,
);

/** The snapshot's own playwright package directory (resolved as its test runner does), which must lie inside its installation. */
export function playwrightDir(root) {
  const test = createRequire(join(root, "package.json")).resolve(
    "@playwright/test/package.json",
  );
  const dir = dirname(
    realpathSync(createRequire(test).resolve("playwright/package.json")),
  );
  const base = realpathSync(join(root, "node_modules"));
  if (!inside(base, dir))
    throw new Error(
      `playwright resolves to ${dir}, outside the installation: it is not adapted`,
    );
  return dir;
}
/**
 * Applies the transform adapter to the snapshot `root`'s Playwright (before it is measured and sealed) and returns what it did. Refuses
 * another release, an upstream file of other bytes (an unknown layout) or an adapted result of other bytes; writes only through
 * no-follow descriptors into the owned snapshot, keeping each file's mode, and re-reads what it wrote.
 */
export function adaptPlaywright(root) {
  assertOwnedRoot(root, "before the transform adapter was applied");
  const dir = playwrightDir(root);
  const version = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ).version;
  if (version !== PLAYWRIGHT_VERSION)
    throw new Error(
      `the snapshot's Playwright is ${version}, not ${PLAYWRIGHT_VERSION}: the transform adapter knows no other release, so nothing is run`,
    );
  const files = {};
  for (const [rel, want] of Object.entries(ADAPTED_FILES)) {
    const full = join(dir, rel);
    const st = lstatSync(full);
    if (!st.isFile())
      throw new Error(`Playwright's ${rel} is not a regular file`);
    const text = readFileSync(full, "utf8");
    if (sha256(text) !== want.upstream)
      throw new Error(
        `Playwright's ${rel} is not the known ${PLAYWRIGHT_VERSION} upstream file (${sha256(text)}): an unknown layout is not adapted`,
      );
    const adapted = adaptedText(text, rel);
    if (sha256(adapted) !== want.adapted)
      throw new Error(
        `the adapted ${rel} is ${sha256(adapted)}, not the reviewed ${want.adapted}`,
      );
    writeNoFollow(full, Buffer.from(adapted), st.mode);
    if (sha256(readFileSync(full)) !== want.adapted)
      throw new Error(`the adapted ${rel} was not written as adapted`);
    files[rel] = {
      upstream_sha256: want.upstream,
      adapted_sha256: want.adapted,
    };
  }
  return {
    adapter: PLAYWRIGHT_ADAPTER,
    version,
    package: relative(realpathSync(root), dir).split(sep).join("/"),
    files,
  };
}
/** Why the snapshot `root`'s Playwright is not exactly the adapted one (an empty list when it is). Reads only. */
export function adaptationProblems(root) {
  try {
    const dir = playwrightDir(root);
    return Object.entries(ADAPTED_FILES)
      .filter(
        ([rel, want]) => sha256(readFileSync(join(dir, rel))) !== want.adapted,
      )
      .map(([rel]) => `Playwright's ${rel} is not the adapted file`);
  } catch (error) {
    return [String(error.message ?? error)];
  }
}
/** Why a copied package-manager configuration file `text` may not be used: a setting that selects code (configuration keys normalised). */
export function configProblems(text, file = "the configuration file") {
  const problems = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^([^=:\s]+)\s*[=:]/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/^["']|["']$/g, "");
    if (CODE_SETTINGS.test(key.toLowerCase().replace(/[-_]/g, "")))
      problems.push(
        `${file} sets ${key}, which selects code no measurement follows`,
      );
  }
  return problems;
}
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The first executable `name` on `env.PATH`, as a shell or spawn finds it: its path and real path. Throws when there is none. */
export function firstOnPath(name, env) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    return { path: candidate, realpath: realpathSync(candidate) };
  }
  throw new Error(`no executable ${name} on PATH`);
}

/**
 * The supported launcher chain `env` resolves for the project at `source` (C3), resolved without executing anything. Throws for an
 * unsupported launcher, interpreter or package-manager release (an unknown closure refuses).
 */
export function launcherChain(env, source) {
  const pnpm = firstOnPath("pnpm", env);
  const bytes = readFileSync(pnpm.realpath);
  let form;
  let entry;
  if (bytes.equals(Buffer.from(TASK_SHIM))) {
    form = "task-shim";
    entry = firstOnPath("corepack", env).realpath;
    if (
      basename(entry) !== "corepack.js" ||
      basename(dirname(entry)) !== "dist"
    )
      throw new Error(
        `the task launcher's corepack (${entry}) is not Corepack's own dist/corepack.js`,
      );
  } else if (
    basename(pnpm.realpath) === "pnpm.js" &&
    basename(dirname(pnpm.realpath)) === "dist"
  ) {
    form = "corepack-pnpm";
    entry = pnpm.realpath;
  } else
    throw new Error(
      `the pnpm first on PATH (${pnpm.path} -> ${pnpm.realpath}) is not a supported launcher (the task's \`exec corepack pnpm\` launcher or Corepack's pnpm.js): its closure cannot be known, so nothing is run`,
    );
  const corepack = dirname(dirname(entry));
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(corepack, "package.json"), "utf8"));
  } catch {
    pkg = null;
  }
  if (pkg?.name !== "corepack")
    throw new Error(`${corepack} is not the Corepack package`);
  for (const file of ["corepack.js", "pnpm.js"]) {
    const first = readFileSync(join(corepack, "dist", file), "utf8").split(
      "\n",
    )[0];
    if (first !== "#!/usr/bin/env node")
      throw new Error(
        `Corepack's dist/${file} starts ${JSON.stringify(first)}, not #!/usr/bin/env node`,
      );
  }
  const node = firstOnPath("node", env);
  const manager = JSON.parse(
    readFileSync(join(source, "package.json"), "utf8"),
  ).packageManager;
  const m = /^pnpm@(\d+\.\d+\.\d+)(\+sha\d+\.[0-9a-f]+)?$/.exec(
    String(manager),
  );
  if (!m)
    throw new Error(
      `the project's packageManager ${JSON.stringify(manager)} is not an exact pnpm release`,
    );
  const home =
    env.COREPACK_HOME ||
    join(
      env.XDG_CACHE_HOME || join(String(env.HOME), ".cache"),
      "node/corepack",
    );
  const release = join(home, "v1/pnpm", m[1]);
  if (!existsSync(join(release, ".corepack")))
    throw new Error(
      `pnpm ${m[1]} is not in Corepack's cache (${release}); nothing is downloaded`,
    );
  const globalRc = join(dirname(dirname(node.realpath)), "etc/npmrc");
  if (existsSync(globalRc))
    throw new Error(
      `a global npmrc beside the external Node (${globalRc}) is not supported (it would be read from outside the runtime)`,
    );
  return {
    form,
    pnpm,
    corepack: { package: corepack, version: String(pkg.version) },
    node,
    manager: { version: m[1], release, home },
  };
}

/** The package-manager configuration files a chain reads from HOME (held-operation-installation.mjs globalConfig), by name. */
export function configFiles(env) {
  const home = String(env.HOME ?? "");
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  return {
    npmrc_user: [join(home, ".npmrc"), ".npmrc"],
    pnpm_rc_macos: [
      join(home, "Library/Preferences/pnpm/rc"),
      "Library/Preferences/pnpm/rc",
    ],
    pnpm_config_macos: [
      join(home, "Library/Preferences/pnpm/config.yaml"),
      "Library/Preferences/pnpm/config.yaml",
    ],
    pnpm_rc_xdg: [join(xdg, "pnpm/rc"), ".config/pnpm/rc"],
    pnpm_config_xdg: [
      join(xdg, "pnpm/config.yaml"),
      ".config/pnpm/config.yaml",
    ],
  };
}

/**
 * The browser installations the run's Playwright would launch (C3): the directories named by the snapshot's own playwright-core
 * `browsers.json` (its revision and every revision override) for each selected engine, where they exist under the external browser
 * path. Only files are read; nothing runs.
 */
export function browserSources(env, root, browsers) {
  const given = env.PLAYWRIGHT_BROWSERS_PATH;
  if (given === "0")
    throw new Error(
      "PLAYWRIGHT_BROWSERS_PATH=0 (browsers inside node_modules) is not supported",
    );
  const base =
    given ||
    (process.platform === "darwin"
      ? join(String(env.HOME), "Library/Caches/ms-playwright")
      : join(
          env.XDG_CACHE_HOME || join(String(env.HOME), ".cache"),
          "ms-playwright",
        ));
  const test = createRequire(join(root, "package.json")).resolve(
    "@playwright/test/package.json",
  );
  const pw = createRequire(test).resolve("playwright/package.json");
  const core = createRequire(pw).resolve("playwright-core/package.json");
  const list = JSON.parse(
    readFileSync(join(dirname(core), "browsers.json"), "utf8"),
  ).browsers;
  const dirs = [];
  for (const engine of browsers) {
    for (const name of ENGINE_INSTALLS[engine] ?? []) {
      const b = list.find((x) => x.name === name);
      if (!b) throw new Error(`browsers.json names no ${name}`);
      const revisions = [
        b.revision,
        ...Object.values(b.revisionOverrides ?? {}),
      ];
      const found = [...new Set(revisions)]
        .map((r) => `${name.replaceAll("-", "_")}-${r}`)
        .filter((d) => existsSync(join(base, d)));
      if (!found.length)
        throw new Error(
          `${engine}'s ${name} is not installed under ${base} (revisions ${revisions.join(", ")})`,
        );
      dirs.push(...found.map((d) => ({ name: d, from: join(base, d) })));
    }
  }
  return dirs;
}

/** Throws when anything under the private runtime `rt` is shared with another path or resolves outside it. */
function runtimeIndependence(rt, sources) {
  const base = realpathSync(rt);
  const problems = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = join(dir, e.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        let real;
        try {
          real = realpathSync(full);
        } catch {
          problems.push(`${r} is a dangling link`);
          continue;
        }
        if (!inside(base, real))
          problems.push(`${r} resolves to ${real}, outside the runtime`);
      } else if (st.isDirectory()) walk(full, r);
      else if (!st.isFile())
        problems.push(`${r} is neither a file, a directory nor a link`);
      else if (st.nlink !== 1) problems.push(`${r} is a hard link`);
    }
  };
  walk(rt, "");
  for (const [to, from] of sources) {
    const a = lstatSync(join(rt, to));
    const b = lstatSync(from);
    if (a.dev === b.dev && a.ino === b.ino)
      problems.push(`${to} is the external ${from} itself`);
  }
  if (problems.length)
    throw new Error(
      `the private runtime is not independent: ${problems.slice(0, 5).join("; ")}`,
    );
}

const clone = (from, to) =>
  cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });

/**
 * Fills the private runtime `rt` (an empty owned directory) from `chain` (launcherChain), the existing configuration files of `env` and
 * the browser installations `browsers` (browserSources), proves it independent and seals it. Returns its stat inventory (the seal).
 */
export function createRuntime(rt, chain, env, browsers) {
  assertOwnedRoot(rt, "before the runtime was copied");
  if (readdirSync(rt).length) throw new Error(`${rt} is not empty`);
  const sources = [];
  mkdirSync(join(rt, "bin"));
  copyFileSync(
    chain.node.realpath,
    join(rt, "bin/node"),
    constants.COPYFILE_FICLONE,
  );
  sources.push(["bin/node", chain.node.realpath]);
  mkdirSync(join(rt, "lib/node_modules"), { recursive: true });
  clone(chain.corepack.package, join(rt, "lib/node_modules/corepack"));
  sources.push(["lib/node_modules/corepack", chain.corepack.package]);
  symlinkSync(
    "../lib/node_modules/corepack/dist/corepack.js",
    join(rt, "bin/corepack"),
  );
  if (chain.form === "task-shim") {
    copyFileSync(
      chain.pnpm.realpath,
      join(rt, "bin/pnpm"),
      constants.COPYFILE_FICLONE,
    );
    if (readFileSync(join(rt, "bin/pnpm"), "utf8") !== TASK_SHIM)
      throw new Error("the copied launcher is not the task's launcher");
    sources.push(["bin/pnpm", chain.pnpm.realpath]);
  } else
    symlinkSync(
      "../lib/node_modules/corepack/dist/pnpm.js",
      join(rt, "bin/pnpm"),
    );
  const release = join(rt, "corepack/v1/pnpm", chain.manager.version);
  mkdirSync(dirname(release), { recursive: true });
  clone(chain.manager.release, release);
  sources.push([
    `corepack/v1/pnpm/${chain.manager.version}`,
    chain.manager.release,
  ]);
  mkdirSync(join(rt, "home"));
  for (const [from, to] of Object.values(configFiles(env)))
    if (existsSync(from)) {
      if (!statSync(from).isFile())
        throw new Error(`the configuration file ${from} is not a regular file`);
      // Revision 29: a setting that selects code (node-options, script-shell, pnpmfile, ...) would run what its digest does not measure.
      const problems = configProblems(readFileSync(from, "utf8"), from);
      if (problems.length)
        throw new Error(`${problems.join("; ")}: nothing is run`);
      mkdirSync(dirname(join(rt, "home", to)), { recursive: true });
      copyFileSync(from, join(rt, "home", to));
    }
  mkdirSync(join(rt, "ms-playwright"));
  for (const b of browsers) {
    clone(b.from, join(rt, "ms-playwright", b.name));
    sources.push([`ms-playwright/${b.name}`, b.from]);
  }
  runtimeIndependence(rt, sources);
  return withRoot(sealTree(rt), rt);
}
/** A seal with its root's identity (device and inode), which verifyTree requires unchanged. */
function withRoot(baseline, root) {
  const st = lstatSync(root);
  return { ...baseline, root: { dev: st.dev, ino: st.ino } };
}

/**
 * The private runtime's content manifest (`runtime.sha256` of the applicability record): every entry except the browser installations
 * (each digested separately by the record), a file by its bytes and executable bit, a link by the entry it resolves to inside the
 * runtime. The same chain at another private path has the same digest.
 */
export function runtimeManifest(rt) {
  const base = realpathSync(rt);
  const lines = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === "ms-playwright") continue;
      const full = join(dir, e.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const real = realpathSync(full);
        if (!inside(base, real))
          throw new Error(`runtime entry ${r} resolves outside the runtime`);
        lines.push(`L ${r} -> ${real.slice(base.length + 1) || "."}`);
      } else if (st.isDirectory()) {
        lines.push(`D ${r}`);
        walk(full, r);
      } else if (st.isFile())
        lines.push(
          `F ${r} ${st.mode & 0o111 ? "x" : "-"} ${sha256(readFileSync(full))}`,
        );
      else throw new Error(`runtime entry ${r} is a special file`);
    }
  };
  walk(base, "");
  return { sha256: sha256(lines.join("\n")), entries: lines.length };
}

/** The one environment every child of the run gets (C3): `base` with the runtime's own locations; refuses unmeasurable inputs. */
export function frozenEnv(base, rt, root) {
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || v === "") continue;
    if (REFUSED_ENV.some((r) => r.test(k)))
      throw new Error(
        `the environment sets ${k} (an input no measurement follows): nothing is run`,
      );
    if (
      SETTING.test(k) &&
      !REPLACED_ENV.includes(k) &&
      String(v)
        .split(delimiter)
        .some((part) => isAbsolute(part))
    )
      throw new Error(
        `the environment's package-manager setting ${k}=${v} names a path outside the runtime: nothing is run`,
      );
  }
  // Revision 29 (the execution policy): only INHERITED_ENV is inherited; nothing else in `base` (NODE_*, PW_*, package-manager settings,
  // VITE_*, loader and native-binary overrides) reaches a child, whatever it names.
  const env = {};
  for (const k of INHERITED_ENV)
    if (base[k] !== undefined && base[k] !== "") env[k] = String(base[k]);
  return {
    ...env,
    ...POLICY_ENV,
    PATH: [join(rt, "bin"), ...SYSTEM_PATH].join(delimiter),
    HOME: join(rt, "home"),
    XDG_CONFIG_HOME: join(rt, "home/.config"),
    COREPACK_HOME: join(rt, "corepack"),
    COREPACK_ENABLE_NETWORK: "0",
    PLAYWRIGHT_BROWSERS_PATH: join(rt, "ms-playwright"),
    PWTEST_CACHE_DIR: cacheDir(root),
    // pnpm's data/state directory (revision 28: it must exist). Revision 29: guarded EMPTY from sealing to the end, as is the cache.
    PNPM_HOME: stateDir(root),
  };
}

/** The path Playwright's transform cache would live at inside a run's snapshot: unused under the adapter, guarded empty (revision 29). */
export const cacheDir = (root) => join(root, ".agtx/cache/playwright");
/** The path pnpm's own data and state go to inside a run's snapshot: guarded empty from sealing to the end (revision 29). */
export const stateDir = (root) => join(root, ".agtx/state/pnpm");

/** A directory's own entry as a write changes it (revision 29: guarded-empty generated directories): inode, mode, links and times. */
function selfLine(root) {
  const st = lstatSync(root, { bigint: true });
  return `${st.ino} ${st.mode} ${st.nlink} ${st.mtimeNs} ${st.ctimeNs}`;
}

/**
 * Verifies one sealed tree against its baseline; returns the current digest or throws naming the first difference. The root itself must
 * still be the real directory that was sealed (its device and inode, `baseline.root`): a root replaced by a link or another directory is
 * a change even when what it now names has the same entries (its children's own inodes would otherwise still match).
 */
function verifyTree(root, baseline, label, when) {
  let st;
  try {
    st = lstatSync(root);
  } catch (error) {
    throw new Error(`${label} is gone ${when}: ${error.code ?? error.message}`);
  }
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    st.dev !== baseline.root?.dev ||
    st.ino !== baseline.root?.ino
  )
    throw new Error(
      `${label} changed ${when}: its root ${root} is not the directory that was sealed`,
    );
  // Revision 29: a guarded-empty generated directory's own entry is part of its seal (a file created, read and deleted between two
  // checks leaves no entry behind, but it changes the directory's modification and change times).
  if (baseline.self !== undefined && selfLine(root) !== baseline.self)
    throw new Error(
      `${label} changed ${when}: its own directory ${root} was written`,
    );
  const now = statInventory(root);
  if (now.sha256 === baseline.sha256) return now.sha256;
  const was = new Set(baseline.lines);
  const is = new Set(now.lines);
  const first =
    now.lines.find((l) => !was.has(l)) ??
    baseline.lines.find((l) => !is.has(l));
  throw new Error(
    `${label} changed ${when}: ${first?.split(" ").slice(0, 2).join(" ") ?? "(entry order)"}`,
  );
}

/**
 * A run's execution (the shared lifecycle's state): its snapshot and runtime roots, the frozen environment, the private launcher, the
 * seals and the guarded trees. `journal` is the run's snapshot record (snapshot.json), updated in place; `save()` writes it.
 * `afterGuard(what, n)` is a qualification seam (the runner's barrier): called synchronously after the n-th launch's guard has passed
 * and before its child is spawned, so a change in exactly that window (design assessment H6) can be forced; it changes timing only.
 */
export function newExecution({ journal, save = () => {}, afterGuard = null }) {
  let launches = 0;
  const ex = {
    root: null,
    runtime: null,
    env: null,
    launcher: null,
    chain: null,
    policy: null,
    baseline: null,
    runtimeBaseline: null,
    trees: new Map(),
    journal,
    save,
    /** Every seal unchanged, now (C4): the runtime always, the snapshot once sealed, each guarded tree. Recorded; throws on a change. */
    check(when) {
      const entry = { when, at: new Date().toISOString() };
      try {
        if (!ex.runtimeBaseline) throw new Error(`no sealed runtime ${when}`);
        entry.runtime_sha256 = verifyTree(
          ex.runtime,
          ex.runtimeBaseline,
          "the private runtime",
          when,
        );
        if (ex.baseline)
          entry.sha256 = verifyTree(
            ex.root,
            ex.baseline,
            "the execution snapshot",
            when,
          );
        entry.trees = {};
        for (const [name, t] of ex.trees)
          entry.trees[name] = verifyTree(
            t.root,
            t.baseline,
            `the guarded tree ${name}`,
            when,
          );
      } catch (error) {
        entry.error = String(error.message ?? error);
        (ex.baseline ? journal.checks : journal.runtime_checks).push(entry);
        save();
        throw error;
      }
      (ex.baseline ? journal.checks : journal.runtime_checks).push(entry);
      save();
      return entry;
    },
    /**
     * Seals a tree the run will read from now on (a copied test tree, a build, a mutant's build input) and guards it until the end.
     * `self` (revision 29: the policy's guarded-empty generated directories) also seals the tree root's own directory entry.
     */
    guard(name, root, { outside = false, self = false } = {}) {
      if (ex.trees.has(name))
        throw new Error(`the tree ${name} is already guarded`);
      const baseline = withRoot(sealTree(root), root);
      if (self) baseline.self = selfLine(root);
      ex.trees.set(name, { root, baseline, outside });
      journal.trees[name] = {
        root,
        sealed_sha256: baseline.sha256,
        entries: baseline.entries,
        ...(self ? { self: baseline.self } : {}),
      };
      save();
    },
    /** The guard of one launch (C3): every seal checked, then the qualification seam; returns the private launcher to start. */
    guarded(what) {
      ex.check(`before ${what}`);
      launches += 1;
      afterGuard?.(what, launches);
      return ex.launcher;
    },
    /** A synchronous child, started only after the guard, through the private launcher, in the frozen environment (C3). */
    spawnSync(what, args, { cwd, timeout, env = {} } = {}) {
      return spawnSync(ex.guarded(what), args, {
        cwd,
        env: { ...ex.env, ...env },
        encoding: "utf8",
        timeout,
      });
    },
  };
  return ex;
}

/**
 * The shared preparation (C1, C2): refuse a linked installation root, record the source installation's state, allocate, copy the
 * snapshot (independent), create and seal the private runtime, relocate, prepare pnpm through the guard, seal, and compare the source
 * installation's state again. `trees` names a directory inside the snapshot (relative to its root) to create before sealing (the copy
 * trees' parent).
 * `barrier(point)` is the qualification seam, called synchronously (`runtime`: the runtime is sealed, pnpm not yet prepared;
 * `sealed`). Throws on any refusal; the caller then calls finishExecution, which removes whatever was allocated.
 */
export function prepareExecution(
  ex,
  {
    source,
    files,
    browsers,
    env = process.env,
    trees = null,
    barrier = () => {},
  },
) {
  const j = ex.journal;
  const rootProblems = installationRootProblems(source);
  if (rootProblems.length) throw new Error(rootProblems.join("; "));
  const before = sourceState(source);
  j.source_state_before_sha256 = before.sha256;
  j.source_state_entries = before.entries;
  ex.chain = launcherChain(env, source);
  j.runtime_form = ex.chain.form;
  j.launcher_source = ex.chain.pnpm.path;
  const parent = snapshotParent(env);
  ex.root = allocateSnapshot(parent);
  j.root = ex.root;
  ex.runtime = allocateSnapshot(parent, "held-op-runtime-");
  j.runtime_root = ex.runtime;
  ex.save();
  createSnapshot({ root: source, files, dir: ex.root });
  const sources = browserSources(env, ex.root, browsers);
  ex.runtimeBaseline = createRuntime(ex.runtime, ex.chain, env, sources);
  j.runtime_sealed_sha256 = ex.runtimeBaseline.sha256;
  j.runtime_entries = ex.runtimeBaseline.entries;
  j.relocated = relocate(ex.root, source);
  // Revision 29: the execution policy, before anything is measured or sealed (the adapted Playwright is what every reader measures).
  j.policy = {
    id: EXECUTION_POLICY,
    sha256: POLICY_SHA256,
    playwright: adaptPlaywright(ex.root),
    generated: GENERATED_TREES,
  };
  ex.policy = j.policy;
  ex.launcher = join(ex.runtime, "bin/pnpm");
  ex.env = frozenEnv(env, ex.runtime, ex.root);
  mkdirSync(cacheDir(ex.root), { recursive: true });
  mkdirSync(stateDir(ex.root), { recursive: true });
  if (trees) mkdirSync(join(ex.root, trees), { recursive: true });
  ex.save();
  barrier("runtime");
  preparePnpm(ex.root, (what, args, options) =>
    ex.spawnSync(what, args, options),
  );
  j.prepared = true;
  ex.baseline = withRoot(seal(ex.root), ex.root);
  j.sealed_sha256 = ex.baseline.sha256;
  j.sealed_entries = ex.baseline.entries;
  // Revision 29: no tool cache exists when the snapshot is sealed (so creating one later changes the sealed node_modules entry), and the
  // two writable locations are guarded empty, their own entries included, from now to the end.
  for (const c of CACHE_DIRS)
    if (existsSync(join(ex.root, "node_modules", c)))
      throw new Error(
        `node_modules/${c} exists when the snapshot is sealed: a generated cache is not an input`,
      );
  POLICY_DEFINITION.generated_dirs.dirs.forEach((d, n) => {
    if (readdirSync(join(ex.root, d)).length)
      throw new Error(
        `${d} is not empty when the snapshot is sealed: a generated file is not an input`,
      );
    // Read only (pnpm still writes a probe into its state directory at each launch; refused, it carries on): no ordinary write can
    // land there, and a writer that restores the mode still changes the directory's change time.
    chmodSync(join(ex.root, d), 0o555);
    ex.guard(GENERATED_TREES[n], join(ex.root, d), { self: true });
  });
  // The runtime's seal continues unbroken into the snapshot's (the runtime is never re-sealed).
  ex.check("when the snapshot was sealed");
  const after = sourceState(source);
  j.source_state_after_sha256 = after.sha256;
  ex.save();
  if (after.sha256 !== before.sha256) {
    const was = new Set(before.lines);
    const first =
      after.lines.find((l) => !was.has(l)) ??
      before.lines.find((l) => !new Set(after.lines).has(l));
    throw new Error(
      `the source installation changed while the snapshot was prepared: ${first?.split(" ").slice(0, 2).join(" ")}`,
    );
  }
  barrier("sealed");
  return ex;
}

/**
 * Ends an execution (I5): the final check of every seal (unless `check` is false), guarded trees outside the snapshot unsealed so they
 * can be kept, `beforeRemoval()` (the producer keeps its copy trees), then the snapshot and the runtime removed (only owned real
 * directories; links never followed). Records each step's error beside the others; never throws. Returns the journal.
 */
export function finishExecution(
  ex,
  {
    check = true,
    when = "at the end of the run",
    beforeRemoval = () => {},
  } = {},
) {
  const j = ex.journal;
  if (check && ex.runtimeBaseline) {
    try {
      const end = ex.check(when);
      j.end_sha256 = end.sha256 ?? null;
      j.runtime_end_sha256 = end.runtime_sha256;
      j.trees_end = end.trees;
    } catch (error) {
      j.end_error = String(error.message ?? error);
    }
  }
  for (const [name, t] of ex.trees)
    if (t.outside)
      try {
        unsealTree(t.root);
      } catch (error) {
        j.unseal_errors = {
          ...(j.unseal_errors ?? {}),
          [name]: String(error.message ?? error),
        };
      }
  try {
    beforeRemoval();
  } catch (error) {
    j.before_removal_error = String(error.message ?? error);
  }
  if (ex.root) {
    j.removal_error = removeSnapshot(ex.root);
    j.removed = j.removal_error === null;
  }
  if (ex.runtime) {
    j.runtime_removal_error = removeSnapshot(ex.runtime);
    j.runtime_removed = j.runtime_removal_error === null;
  }
  ex.save();
  return j;
}

/** The fresh snapshot record a run starts with (schema /2), before anything is allocated. */
export function snapshotJournal(source, used) {
  return {
    schema: SNAPSHOT_SCHEMA,
    root: null,
    source,
    used,
    runtime_root: null,
    runtime_form: null,
    launcher_source: null,
    runtime_sealed_sha256: null,
    runtime_entries: null,
    runtime_checks: [],
    source_state_before_sha256: null,
    source_state_after_sha256: null,
    source_state_entries: null,
    relocated: [],
    policy: null,
    prepared: false,
    sealed_sha256: null,
    sealed_entries: null,
    installation_sha256: null,
    runtime_sha256: null,
    trees: {},
    checks: [],
    end_sha256: null,
    runtime_end_sha256: null,
    trees_end: null,
    unchanged: false,
    removed: false,
    removal_error: null,
    runtime_removed: false,
    runtime_removal_error: null,
  };
}

/**
 * Whether a finished execution's record shows every seal unchanged from sealing to the end (revision 28): the snapshot and the runtime
 * at every check and the end, every guarded tree at every later check and the end, and the source installation's state unchanged.
 */
export function journalUnchanged(j) {
  const sealed = j.sealed_sha256;
  const rt = j.runtime_sealed_sha256;
  const trees = j.trees ?? {};
  const treeOk = (c) =>
    Object.entries(c.trees ?? {}).every(
      ([n, d]) => d === trees[n]?.sealed_sha256,
    );
  return (
    Boolean(sealed) &&
    Boolean(rt) &&
    !j.end_error &&
    j.end_sha256 === sealed &&
    j.runtime_end_sha256 === rt &&
    j.checks.every(
      (c) => c.sha256 === sealed && c.runtime_sha256 === rt && treeOk(c),
    ) &&
    j.runtime_checks.every((c) => c.runtime_sha256 === rt) &&
    Object.entries(trees).every(
      ([n, t]) => j.trees_end?.[n] === t.sealed_sha256,
    ) &&
    Boolean(j.source_state_before_sha256) &&
    j.source_state_after_sha256 === j.source_state_before_sha256
  );
}
