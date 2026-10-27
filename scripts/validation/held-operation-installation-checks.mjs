// WEB-08d revision 27 (review r26 R26-N1; design assessment eff76566 Q1, Q3, Q4, Q5, H1-H6): the installation boundary's checks on DISK.
// Each check builds a small pnpm-shaped installation (a virtual store, hoisted and direct links, a transitive dependency, a cycle, a
// plugin, a native payload, an executable bin, a `.bin` shim exporting NODE_PATH, pnpm's metadata and workspace state, a Vite cache) in
// a fresh temporary directory, and drives the REAL collector, comparator, snapshot and seal on it: content and resolution edits, link
// retargets and escapes, special entries, hard links, unreadable entries, ancestor and global resolution paths, shims and files that
// name another installation, relocation, a change made and undone after sealing, and the records' comparisons. They are run by
// held-operation-installation.test.mjs one by one and, under every evaluator mutant, by held-operation-qualification.test.mjs Q3 (with
// the mutated modules passed in), so each mutation of the boundary must fail at least one of them.
//
// No browser, build or package manager runs here: the child probe of collectApplicability is replaced by a stub that reports what the
// real probe would (resolution from each origin), so these checks qualify the controller's side; the real probe and pnpm are exercised
// by the actual producer (the revision-27 producer differential).
//
// Revision 28 (review r27 R27-N1/R27-N2; design assessment 3f7047c0 Q1, Q3, Q5, H1-H9): the execution module (`x`,
// held-operation-execution.mjs) too. Q1: a real installation root admitted; absolute, relative and dangling root links refused before
// anything is written (the link's target unchanged); relocation, sealing and removal refusing a linked or replaced root and never writing
// through a link; nested links back to the source or out of the copy, hard links, shared inodes and overlapping destinations refused;
// the source installation's full state unchanged by a whole lifecycle and sensitive to modes, nested shims and link targets. The launcher
// chain: the task's launcher and Corepack's pnpm.js accepted, an opaque wrapper (review r27's private wrapper), another interpreter, an
// inexact or uncached package-manager release and a global npmrc refused. Q3: the private runtime is independent, sealed and
// location-free; a launcher, a Node or a configuration change made and undone after sealing (times restored, or by an atomic rename) is
// seen by the guard; a guarded tree's change is seen; a launch runs the private launcher by its absolute path in the frozen environment
// only and never after a failed guard; the frozen environment refuses injection and path-valued settings. The SHARED lifecycle
// (prepareExecution/finishExecution) is run end to end over a fake launcher chain whose Corepack only exits: allocated, copied,
// sealed, prepared through the guard, removed; a linked root refused before any allocation (also through collectSnapshotTarget); a write
// into the source installation during preparation refused, naming it, with every allocation removed.
//
// Revision 29 (review r28 R28-N1; design assessment d3cff73e Q1, Q2, Q12): the execution policy. The fake installation's playwright is
// 1.63.0 with the two REAL upstream compilation-cache files (copied, read only, from this worktree's installation), so the shared
// lifecycle applies the actual adapter: both files adapted exactly as reviewed, an unknown layout, another release or other upstream
// bytes refused before anything is written, the snapshot (never the source) adapted, the policy recorded, the generated directories
// guarded empty (a cache entry, and a file created, read and deleted between two checks, both seen), a tool cache present at sealing
// refused, the environment closed to the policy's inherited names, a copied configuration file that selects code refused, the record's
// policy required and compared. The real loaders themselves are exercised by held-operation-policy.test.mjs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// Revision 29: the policy's constants (fixtures name them; the modules under test are always the ones passed in).
import {
  ADAPTED_FILES,
  EXECUTION_POLICY,
  GENERATED_TREES,
  POLICY_SHA256,
} from "./held-operation-execution.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const write = (path, text, mode) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode) chmodSync(path, mode);
};
const link = (path, target) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
};
const NATIVE = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

/**
 * A small pnpm-shaped installation at `<dir>/node_modules` with the source files `package.json` and `src/x.js`; returns `files`, the
 * source fingerprint map createSnapshot takes.
 */
export function pnpmTree(dir) {
  const nm = join(dir, "node_modules");
  const store = join(nm, ".pnpm");
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "t",
      dependencies: { a: "1.0.0", plug: "1.0.0", react: "19.3.0" },
    }),
  );
  write(join(dir, "src/x.js"), "export const x = 1;\n");
  write(join(nm, ".modules.yaml"), "layoutVersion: 5\n");
  write(join(store, "lock.yaml"), "lockfileVersion: '9.0'\n");
  write(
    join(nm, ".pnpm-workspace-state-v1.json"),
    JSON.stringify({
      lastValidatedTimestamp: 1,
      projects: { [dir]: { name: "t" } },
      settings: { nodeLinker: "isolated" },
    }),
  );
  const a = join(store, "a@1.0.0/node_modules/a");
  write(join(a, "package.json"), '{"name":"a","version":"1.0.0"}');
  write(join(a, "index.js"), "module.exports = require('c');\n");
  // A nested shim inside a recorded package (pnpm writes one per bin dependency): it names the installation's absolute path.
  write(
    join(a, "node_modules/.bin/c"),
    `#!/bin/sh\nexport NODE_PATH="${join(store, "c@1.0.0/node_modules")}"\n`,
    0o755,
  );
  link(join(store, "a@1.0.0/node_modules/c"), "../../c@1.0.0/node_modules/c");
  const c = join(store, "c@1.0.0/node_modules/c");
  write(join(c, "package.json"), '{"name":"c","version":"1.0.0"}');
  write(join(c, "index.js"), "module.exports = 'c';\n");
  write(join(c, "build/native.node"), NATIVE);
  write(join(c, "bin/c.js"), "#!/usr/bin/env node\n", 0o755);
  // A cycle: c's own store directory links back to a.
  link(join(store, "c@1.0.0/node_modules/a"), "../../a@1.0.0/node_modules/a");
  const plug = join(store, "plug@1.0.0/node_modules/plug");
  write(join(plug, "package.json"), '{"name":"plug","version":"1.0.0"}');
  write(join(plug, "index.js"), "export default () => ({ name: 'plug' });\n");
  // An application dependency none of the four recorded package trees contains (review r26's React).
  const react = join(store, "react@19.3.0/node_modules/react");
  write(join(react, "package.json"), '{"name":"react","version":"19.3.0"}');
  write(
    join(react, "index.js"),
    "module.exports = require('./cjs/react.js');\n",
  );
  write(join(react, "cjs/react.js"), "module.exports = {};\n");
  link(join(nm, "react"), ".pnpm/react@19.3.0/node_modules/react");
  link(join(store, "node_modules/c"), "../c@1.0.0/node_modules/c");
  link(join(nm, "a"), ".pnpm/a@1.0.0/node_modules/a");
  link(join(nm, "plug"), ".pnpm/plug@1.0.0/node_modules/plug");
  write(
    join(nm, ".bin/c"),
    `#!/bin/sh\nexport NODE_PATH="${join(store, "c@1.0.0/node_modules")}:$NODE_PATH"\nexec node "$basedir/../c/bin/c.js" "$@"\n`,
    0o755,
  );
  write(join(nm, ".vite/deps/cache.json"), "{}");
  return {
    "package.json": sha(readFileSync(join(dir, "package.json"))),
    "src/x.js": sha(readFileSync(join(dir, "src/x.js"))),
  };
}

/** A temporary directory, removed (read-only entries included) by `done()`. */
function scratch(i) {
  const dirs = [];
  return {
    make(label) {
      const d = realpathSync(mkdtempSync(join(tmpdir(), `held-op-${label}-`)));
      dirs.push(d);
      return d;
    },
    done() {
      for (const d of dirs) i.removeSnapshot(d);
    },
  };
}
const STORE_A = "node_modules/.pnpm/a@1.0.0/node_modules/a";
const STORE_C = "node_modules/.pnpm/c@1.0.0/node_modules/c";

/**
 * A stub child probe over a pnpm tree (what the real probe reports): Node and pnpm as this process, the four packages as the tree's own
 * directories, browsers in `browsers`, every dependency of package.json resolved from each origin by Node's own directory lookup.
 */
export function stubProbe(tree, runtime, change) {
  return ({ root, origins }) => {
    const resolveFrom = (origin, name) => {
      for (let d = origin; ; d = dirname(d)) {
        const p = join(d, "node_modules", name);
        if (existsSync(join(p, "package.json"))) return realpathSync(p);
        if (d === dirname(d)) return null;
      }
    };
    const names = Object.keys(
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies,
    ).sort();
    const pkg = (rel) => ({
      version: "1.0.0",
      dir: realpathSync(join(tree, rel)),
    });
    const child = {
      node: process.version,
      exec_path: join(runtime, "bin/node"),
      platform: process.platform,
      arch: process.arch,
      user_agent: "pnpm/12.4.2 npm/? node/? darwin arm64",
      parent_exec_path: join(runtime, "corepack/v1/pnpm/12.4.2/pnpm-native"),
      corepack_root: null,
      node_path: null,
      node_options: null,
      resolution: Object.fromEntries(
        [root, ...origins].map((o) => [
          o,
          Object.fromEntries(names.map((n) => [n, resolveFrom(o, n)])),
        ]),
      ),
      packages: {
        "@playwright/test": pkg(STORE_A),
        playwright: pkg(STORE_A),
        "playwright-core": pkg(STORE_C),
        vite: pkg("node_modules/.pnpm/plug@1.0.0/node_modules/plug"),
      },
      browsers: {
        chromium: join(runtime, "ms-playwright/chromium-1/chrome"),
      },
    };
    change?.(child);
    return child;
  };
}
/**
 * A private runtime's layout (held-operation-execution.mjs createRuntime's), small: the task launcher, a Node, Corepack, the package
 * manager's release, a private HOME without configuration and the browsers. Revision 28: a collection measures only such a runtime.
 */
function runtimeAt(s) {
  const rt = s.make("runtime");
  write(join(rt, "bin/pnpm"), '#!/bin/sh\nexec corepack pnpm "$@"\n', 0o755);
  write(join(rt, "bin/node"), "node", 0o755);
  write(
    join(rt, "lib/node_modules/corepack/package.json"),
    '{"name":"corepack"}',
  );
  write(
    join(rt, "lib/node_modules/corepack/dist/corepack.js"),
    "#!/usr/bin/env node\n",
    0o755,
  );
  link(
    join(rt, "bin/corepack"),
    "../lib/node_modules/corepack/dist/corepack.js",
  );
  write(join(rt, "corepack/v1/pnpm/12.4.2/pnpm-native"), "pnpm", 0o755);
  write(join(rt, "corepack/v1/pnpm/12.4.2/package.json"), '{"name":"pnpm"}');
  mkdirSync(join(rt, "home"));
  write(join(rt, "ms-playwright/chromium-1/chrome"), "chrome");
  write(join(rt, "ms-playwright/chromium_headless_shell-1/shell"), "shell");
  return rt;
}
/** The execution a collection over a pnpm tree uses (collectApplicability's `execution`): a private runtime and its environment. */
function executionAt(s, rt = runtimeAt(s)) {
  return {
    runtime: rt,
    launcher: join(rt, "bin/pnpm"),
    chain: { form: "task-shim", pnpm: { path: "/x/pnpm-shim/pnpm" } },
    // Revision 29: what prepareExecution records once it has applied the execution policy.
    policy: { id: EXECUTION_POLICY, sha256: POLICY_SHA256 },
    env: {
      PATH: join(rt, "bin"),
      HOME: join(rt, "home"),
      XDG_CONFIG_HOME: join(rt, "home/.config"),
      LANG: "en_GB.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: join(rt, "ms-playwright"),
    },
  };
}

/** Every check (design assessment Q1/Q3/Q4 cells); `i` the installation module, `a` the applicability module, `q` the evaluator. */
export function installationAssessments(i, a, q, check, x) {
  const s = scratch(i);
  try {
    const fresh = (label = "tree") => {
      const d = s.make(label);
      const files = pnpmTree(d);
      return { d, files };
    };
    const digest = (d, options) => i.installationManifest(d, options).sha256;
    const refuses = (d, pattern, options) => {
      try {
        i.installationManifest(d, options);
        return false;
      } catch (error) {
        return pattern.test(String(error.message));
      }
    };
    const edited = (edit, label) => {
      const { d } = fresh(label);
      const was = i.installationManifest(d);
      edit(d);
      const now = i.installationManifest(d);
      return { was, now, d };
    };
    const differs = (edit) => {
      const { was, now } = edited(edit);
      return was.sha256 !== now.sha256;
    };

    // Q1: completeness, determinism and termination.
    check(
      "installation: the manifest of a pnpm tree is deterministic and terminates over its cycle",
      () => {
        const { d } = fresh();
        const m = i.installationManifest(d);
        return (
          m.schema === i.INSTALLATION_SCHEMA &&
          m.sha256 === digest(d) &&
          m.inventory.length === m.entries &&
          m.inventory.some((l) =>
            l.startsWith(
              "L .pnpm/c@1.0.0/node_modules/a -> .pnpm/a@1.0.0/node_modules/a D",
            ),
          )
        );
      },
    );
    check(
      "installation: every installed file is in the inventory by its bytes (virtual store, native payload, shim, metadata)",
      () => {
        const { d } = fresh();
        const m = i.installationManifest(d);
        return (
          [
            `F .pnpm/a@1.0.0/node_modules/a/index.js -- ${sha("module.exports = require('c');\n")}`,
            `F .pnpm/c@1.0.0/node_modules/c/build/native.node -- ${sha(NATIVE)}`,
            `F .pnpm/lock.yaml -- ${sha("lockfileVersion: '9.0'\n")}`,
          ].every((l) => m.inventory.includes(l)) &&
          m.inventory.some((l) => l.startsWith("F .bin/c xn ")) &&
          m.inventory.some((l) =>
            l.startsWith("F .pnpm/c@1.0.0/node_modules/c/bin/c.js x- "),
          )
        );
      },
    );
    check(
      "installation: a direct dependency's content-only edit changes the identity and names the file (H2)",
      () => {
        const { was, now } = edited((d) =>
          write(join(d, STORE_A, "index.js"), "module.exports = 'changed';\n"),
        );
        const diff = i.inventoryDifferences(was.inventory, now.inventory);
        return (
          was.sha256 !== now.sha256 &&
          diff.counts.changed === 1 &&
          diff.changed[0].now.startsWith(
            "F .pnpm/a@1.0.0/node_modules/a/index.js",
          )
        );
      },
    );
    check(
      "installation: a transitive dependency's edit changes the identity (H3)",
      () =>
        differs((d) =>
          write(join(d, STORE_C, "index.js"), "module.exports = 'c2';\n"),
        ),
    );
    check("installation: a plugin's edit changes the identity (H3)", () =>
      differs((d) =>
        write(
          join(d, "node_modules/.pnpm/plug@1.0.0/node_modules/plug/index.js"),
          "export default () => ({});\n",
        ),
      ),
    );
    check(
      "installation: one byte of a native payload changes the identity (H3)",
      () =>
        differs((d) => {
          const b = Buffer.from(NATIVE);
          b[17] ^= 1;
          write(join(d, STORE_C, "build/native.node"), b);
        }),
    );
    check("installation: an executable bit changes the identity", () =>
      differs((d) => chmodSync(join(d, STORE_C, "index.js"), 0o755)),
    );
    check("installation: an added file changes the identity", () =>
      differs((d) => write(join(d, STORE_C, "extra.js"), "1")),
    );
    check("installation: a removed file changes the identity", () =>
      differs((d) => unlinkSync(join(d, STORE_C, "index.js"))),
    );
    check("installation: a shim's edit changes the identity", () =>
      differs((d) => {
        const p = join(d, "node_modules/.bin/c");
        write(p, `${readFileSync(p, "utf8")}# edited\n`, 0o755);
      }),
    );
    check("installation: pnpm's metadata changes the identity", () =>
      differs((d) =>
        write(join(d, "node_modules/.modules.yaml"), "layoutVersion: 6\n"),
      ),
    );
    check(
      "installation: a link retargeted inside the installation changes the identity (H4)",
      () =>
        differs((d) => {
          unlinkSync(join(d, "node_modules/a"));
          symlinkSync(
            ".pnpm/plug@1.0.0/node_modules/plug",
            join(d, "node_modules/a"),
          );
        }),
    );
    check(
      "installation: a link rewritten to an equivalent text (the same entry) keeps the identity",
      () =>
        !differs((d) => {
          unlinkSync(join(d, "node_modules/a"));
          symlinkSync(
            "./.pnpm/a@1.0.0/node_modules/../node_modules/a",
            join(d, "node_modules/a"),
          );
        }),
    );
    check(
      "installation: the workspace state's validation time alone keeps the identity",
      () =>
        !differs((d) => {
          const p = join(d, "node_modules/.pnpm-workspace-state-v1.json");
          const st = JSON.parse(readFileSync(p, "utf8"));
          st.lastValidatedTimestamp = 2;
          write(p, JSON.stringify(st));
        }),
    );
    check(
      "installation: another workspace-state setting changes the identity",
      () =>
        differs((d) => {
          const p = join(d, "node_modules/.pnpm-workspace-state-v1.json");
          const st = JSON.parse(readFileSync(p, "utf8"));
          st.settings.nodeLinker = "hoisted";
          write(p, JSON.stringify(st));
        }),
    );
    check(
      "installation: a tool cache (.vite) is not installed content",
      () =>
        !differs((d) =>
          write(join(d, "node_modules/.vite/deps/other.json"), "[]"),
        ),
    );
    // Refusals: what cannot be measured is never given an identity.
    check(
      "installation: a link out of the installation is refused (H4)",
      () => {
        const { d } = fresh();
        const out = s.make("outside");
        write(join(out, "package.json"), "{}");
        link(join(d, "node_modules/outside"), out);
        return refuses(d, /a link out of the measured installation/);
      },
    );
    check("installation: a dangling link is refused", () => {
      const { d } = fresh();
      link(join(d, "node_modules/gone"), ".pnpm/gone@1.0.0/node_modules/gone");
      return refuses(d, /a dangling link/);
    });
    check(
      "installation: a file sharing its bytes with another path (a hard link) is refused",
      () => {
        const { d } = fresh();
        const other = s.make("store");
        write(join(other, "shared.js"), "1");
        linkSync(join(other, "shared.js"), join(d, STORE_C, "shared.js"));
        return refuses(d, /hard link/);
      },
    );
    check("installation: a special entry is refused", () => {
      const { d } = fresh();
      const r = spawnSync("mkfifo", [join(d, STORE_C, "pipe")]);
      return (
        r.status === 0 && refuses(d, /neither a file, a directory nor a link/)
      );
    });
    check("installation: an unreadable entry is refused, never skipped", () => {
      const { d } = fresh();
      chmodSync(join(d, STORE_C, "index.js"), 0o000);
      try {
        return refuses(d, /EACCES/);
      } finally {
        chmodSync(join(d, STORE_C, "index.js"), 0o644);
      }
    });
    check(
      "installation: a shim exporting NODE_PATH outside the installation is refused (H6)",
      () => {
        const { d } = fresh();
        write(
          join(d, "node_modules/.bin/c"),
          `#!/bin/sh\nexport NODE_PATH="/elsewhere/node_modules:$NODE_PATH"\n`,
          0o755,
        );
        return refuses(d, /exports NODE_PATH \/elsewhere\/node_modules/);
      },
    );
    check(
      "installation: a nested shim exporting NODE_PATH outside the installation is refused (H6)",
      () => {
        const { d } = fresh();
        write(
          join(d, STORE_A, "node_modules/.bin/c"),
          `#!/bin/sh\nexport NODE_PATH="/elsewhere/node_modules"\n`,
          0o755,
        );
        return refuses(d, /exports NODE_PATH/);
      },
    );
    check(
      "installation: a file naming the live installation is refused",
      () => {
        const { d } = fresh();
        const live = s.make("live");
        write(
          join(d, STORE_C, "config.js"),
          `module.exports = ${JSON.stringify(join(live, "node_modules/x"))};\n`,
        );
        return refuses(d, /names the live installation/, { foreign: [live] });
      },
    );
    // H1: the same content at another private path is the same installation.
    check(
      "installation: a relocated snapshot has the identity of the tree it was cloned from (H1)",
      () => {
        const { d, files } = fresh();
        const x = i.allocateSnapshot(s.make("parent"));
        i.createSnapshot({ root: d, files, dir: x });
        const relocated = i.relocate(x, d);
        return (
          relocated.includes(".bin/c") &&
          relocated.includes(".pnpm-workspace-state-v1.json") &&
          digest(x, { foreign: [d] }) === digest(d)
        );
      },
    );
    check(
      "installation: a snapshot not relocated names the tree it came from and is refused",
      () => {
        const { d, files } = fresh();
        const x = i.allocateSnapshot(s.make("parent"));
        i.createSnapshot({ root: d, files, dir: x });
        return refuses(x, /exports NODE_PATH|names the live installation/, {
          foreign: [d],
        });
      },
    );
    check(
      "installation: a snapshot copies the source exactly and leaves the caches out",
      () => {
        const { d, files } = fresh();
        const x = i.allocateSnapshot(s.make("parent"));
        i.createSnapshot({ root: d, files, dir: x });
        return (
          sha(readFileSync(join(x, "src/x.js"))) === files["src/x.js"] &&
          !existsSync(join(x, "node_modules/.vite")) &&
          statSync(join(x, STORE_C, "index.js")).nlink === 1
        );
      },
    );
    check(
      "installation: a snapshot refuses a source file that is not the fingerprinted one",
      () => {
        const { d, files } = fresh();
        write(join(d, "src/x.js"), "export const x = 2;\n");
        const x = i.allocateSnapshot(s.make("parent"));
        try {
          i.createSnapshot({ root: d, files, dir: x });
          return false;
        } catch (error) {
          return /is not the fingerprinted file/.test(error.message);
        }
      },
    );
    // Resolution boundary (H4, H6): no other node_modules on the way up, no global folders.
    check(
      "resolution: a pnpm tree in a private directory has no other resolution path",
      () => {
        const { d } = fresh();
        const home = s.make("home");
        return i.resolutionProblems(d, [d], { home, nodes: [] }).length === 0;
      },
    );
    check(
      "resolution: a node_modules between a copy origin and the root is found (a shadowing copy)",
      () => {
        const { d } = fresh();
        const origin = join(d, ".agtx/trees/run");
        mkdirSync(join(d, ".agtx/trees/node_modules"), { recursive: true });
        mkdirSync(origin, { recursive: true });
        return i
          .resolutionProblems(d, [d, origin], {
            home: s.make("home"),
            nodes: [],
          })
          .some((p) => p.includes(".agtx/trees/node_modules"));
      },
    );
    check(
      "resolution: a node_modules above the root is found (an ancestor fallback)",
      () => {
        const parent = s.make("ancestor");
        mkdirSync(join(parent, "node_modules"));
        const d = join(parent, "work");
        mkdirSync(d);
        pnpmTree(d);
        return i
          .resolutionProblems(d, [d], { home: s.make("home"), nodes: [] })
          .some((p) => p.includes(`${parent}/node_modules`));
      },
    );
    check("resolution: Node's global folders are found", () => {
      const { d } = fresh();
      const home = s.make("home");
      mkdirSync(join(home, ".node_modules"));
      const prefix = s.make("prefix");
      mkdirSync(join(prefix, "lib/node"), { recursive: true });
      const p = i.resolutionProblems(d, [d], {
        home,
        nodes: [join(prefix, "bin/node")],
      });
      return (
        p.some((x) => x.includes(".node_modules")) &&
        p.some((x) => x.includes("lib/node"))
      );
    });
    // The children's view of resolution (applicability resolutionOf): the probe's report.
    const view = (change) => {
      const { d } = fresh();
      const origin = join(d, ".agtx/trees/run");
      mkdirSync(origin, { recursive: true });
      const child = stubProbe(
        d,
        s.make("rt"),
        change,
      )({ root: d, origins: [origin] });
      return a.resolutionOf(child, d, [origin]);
    };
    check(
      "resolution: every dependency resolving inside, the same from each origin, has a location-free digest",
      () => {
        const one = view();
        const two = view();
        return (
          one.problems.length === 0 &&
          one.dependencies === 3 &&
          one.sha256 === two.sha256
        );
      },
    );
    check("resolution: NODE_OPTIONS in the children is refused", () =>
      view((c) => {
        c.node_options = "--require /x/hook.js";
      }).problems.some((p) => p.includes("NODE_OPTIONS")),
    );
    check("resolution: a NODE_PATH outside the installation is refused", () =>
      view((c) => {
        c.node_path = "/elsewhere/node_modules";
      }).problems.some((p) => p.includes("NODE_PATH /elsewhere")),
    );
    check(
      "resolution: a dependency resolving outside the installation is refused",
      () =>
        view((c) => {
          for (const v of Object.values(c.resolution))
            v.a = "/elsewhere/node_modules/a";
        }).problems.some((p) =>
          p.includes("outside the measured installation"),
        ),
    );
    check(
      "resolution: a dependency resolving differently from a copy origin is refused",
      () =>
        view((c) => {
          const views = Object.values(c.resolution);
          views[1].a = views[1].plug;
        }).problems.some((p) => p.includes("resolves differently")),
    );
    check("resolution: a dependency that does not resolve is refused", () =>
      view((c) => {
        for (const v of Object.values(c.resolution)) v.a = null;
      }).problems.some((p) => p.includes("does not resolve")),
    );
    // The collector end to end over a pnpm tree (stub child probe): the review r26 counterexample and its controls.
    const collect = (d, change, ex = executionAt(s), source = null) => {
      const origin = join(d, ".agtx/trees/run");
      mkdirSync(origin, { recursive: true });
      return a.collectApplicability({
        root: d,
        source,
        origins: [origin],
        browsers: ["chromium"],
        execution: ex,
        probe: stubProbe(d, ex.runtime, change),
      });
    };
    check(
      "collector: an installed file naming the live worktree's installation refuses collection",
      () => {
        const { d } = fresh();
        const live = s.make("live");
        write(
          join(d, STORE_C, "config.js"),
          `module.exports = ${JSON.stringify(join(live, "node_modules/x"))};\n`,
        );
        try {
          collect(d, undefined, executionAt(s), live);
          return false;
        } catch (error) {
          return /names the live installation/.test(error.message);
        }
      },
    );
    check(
      "collector: a collected record is of the current schema and names the installation and resolution",
      () => {
        const { d } = fresh();
        const r = collect(d);
        return (
          r.schema === a.APPLICABILITY_SCHEMA &&
          r.runtime.schema === x.RUNTIME_SCHEMA &&
          r.runtime.form === "task-shim" &&
          r.launcher.source_path === "/x/pnpm-shim/pnpm" &&
          r.installation.schema === i.INSTALLATION_SCHEMA &&
          r.installation.sha256 === digest(d) &&
          r.installation.entries > 0 &&
          r.installation.dependencies === 3 &&
          Object.values(r.config).every((v) => v === "none")
        );
      },
    );
    // Revision 29 (review r28 R28-N1): the record names the execution policy; an execution without the current one is not collected,
    // and a record without it (revision 28) or of another policy is never applicable.
    check(
      "collector: a record names the current execution policy; an execution without it is not collected (revision 29)",
      () => {
        const { d } = fresh();
        const r = collect(d);
        const ex = executionAt(s);
        ex.policy = null;
        return (
          r.runtime.policy === EXECUTION_POLICY &&
          r.runtime.policy_sha256 === POLICY_SHA256 &&
          throwsLike(
            () => collect(d, undefined, ex),
            /no current execution policy/,
          )
        );
      },
    );
    check(
      "comparison: a record without an execution policy (revision 28) is unknown, and one of another policy is not applicable (revision 29)",
      () => {
        const { d } = fresh();
        const r = collect(d);
        const none = structuredClone(r);
        delete none.runtime.policy;
        delete none.runtime.policy_sha256;
        const other = structuredClone(r);
        other.runtime.policy_sha256 = "d".repeat(64);
        return (
          a.compareApplicability(none, none).decision === "unknown" &&
          a.compareApplicability(r, none).decision !== "applicable" &&
          a.compareApplicability(r, other).decision !== "applicable" &&
          a.compareApplicability(r, r).decision === "applicable"
        );
      },
    );
    check(
      "collector: two collections of the same tree are applicable to each other",
      () => {
        const { d } = fresh();
        const ex = executionAt(s);
        return (
          a.compareApplicability(
            collect(d, undefined, ex),
            collect(d, undefined, ex),
          ).decision === "applicable"
        );
      },
    );
    check(
      "collector: review r26's counterexample: a changed installed entry with the same four package trees is incompatible",
      () => {
        const { d } = fresh();
        const ex = executionAt(s);
        const was = collect(d, undefined, ex);
        write(
          join(
            d,
            "node_modules/.pnpm/react@19.3.0/node_modules/react/index.js",
          ),
          "throw new Error('REVIEW_INSTALLED_REACT_CHANGED');\n",
        );
        const now = collect(d, undefined, ex);
        const c = a.compareApplicability(now, was);
        return (
          c.decision === "incompatible" &&
          c.differences.length === 1 &&
          c.differences[0].field === "installation.sha256" &&
          a.PACKAGES.every(
            (p) => now.packages[p].tree_sha256 === was.packages[p].tree_sha256,
          ) &&
          now.installation.modules_yaml_sha256 ===
            was.installation.modules_yaml_sha256
        );
      },
    );
    check(
      "collector: snapshots of one tree at two private paths are applicable to each other (nested shims in recorded packages included)",
      () => {
        const { d, files } = fresh();
        const ex = executionAt(s);
        const [x1, x2] = ["one", "two"].map((label) => {
          const x = i.allocateSnapshot(s.make(label));
          i.createSnapshot({ root: d, files, dir: x });
          i.relocate(x, d);
          return x;
        });
        const one = collect(x1, undefined, ex, d);
        const two = collect(x2, undefined, ex, d);
        return (
          a.compareApplicability(two, one).decision === "applicable" &&
          one.installation.root !== two.installation.root
        );
      },
    );
    check(
      "collector: a change inside a recorded package changes that package's digest",
      () => {
        const { d } = fresh();
        const ex = executionAt(s);
        const was = collect(d, undefined, ex);
        write(join(d, STORE_A, "lib.js"), "1");
        const now = collect(d, undefined, ex);
        const c = a.compareApplicability(now, was);
        return (
          c.differences.some(
            (x) => x.field === "packages.@playwright/test.tree_sha256",
          ) && c.differences.some((x) => x.field === "installation.sha256")
        );
      },
    );
    check(
      "collector: a package-manager configuration file outside the worktree is compared",
      () => {
        const { d } = fresh();
        const ex = executionAt(s);
        const one = collect(d, undefined, ex);
        write(join(ex.env.HOME, ".npmrc"), "node-linker=hoisted\n");
        const two = collect(d, undefined, ex);
        const c = a.compareApplicability(two, one);
        // Revision 28: the file lives in the private runtime's HOME, so the runtime's own digest differs with it (and nothing else).
        return (
          c.differences.some((d) => d.field === "config.npmrc_user") &&
          c.differences.every((d) =>
            ["config.npmrc_user", "runtime.sha256", "runtime.entries"].includes(
              d.field,
            ),
          )
        );
      },
    );
    check(
      "collector: a resolution path out of the installation refuses collection",
      () => {
        const parent = s.make("ancestor");
        mkdirSync(join(parent, "node_modules"));
        const d = join(parent, "work");
        mkdirSync(d);
        pnpmTree(d);
        try {
          collect(d);
          return false;
        } catch (error) {
          return /resolution can leave the measured installation/.test(
            error.message,
          );
        }
      },
    );
    check("collector: the children's NODE_OPTIONS refuses collection", () => {
      const { d } = fresh();
      try {
        collect(d, (c) => {
          c.node_options = "--import /x.mjs";
        });
        return false;
      } catch (error) {
        return /NODE_OPTIONS/.test(error.message);
      }
    });
    check(
      "collector: an installation that cannot be measured refuses collection, never a record",
      () => {
        const { d } = fresh();
        link(join(d, "node_modules/gone"), "nowhere");
        try {
          collect(d);
          return false;
        } catch (error) {
          return /a dangling link/.test(error.message);
        }
      },
    );
    // Revision 28: the actual-execution witness and the runtime's identity.
    const refusesCollection = (change, pattern, ex) => {
      const { d } = fresh();
      try {
        collect(d, change, ex);
        return false;
      } catch (error) {
        return pattern.test(String(error.message));
      }
    };
    check(
      "collector: children whose Node is outside the private runtime refuse collection (the actual-execution witness)",
      () =>
        refusesCollection((c) => {
          c.exec_path = process.execPath;
        }, /did not run from the private runtime.*Node/),
    );
    check(
      "collector: children launched by a pnpm outside the private runtime refuse collection",
      () =>
        refusesCollection((c) => {
          c.parent_exec_path = process.execPath;
        }, /did not run from the private runtime.*pnpm that launched them/),
    );
    check(
      "collector: a browser outside the private runtime refuses collection",
      () => {
        const b = s.make("external-browsers");
        write(join(b, "chromium-1/chrome"), "chrome");
        return refusesCollection((c) => {
          c.browsers.chromium = join(b, "chromium-1/chrome");
        }, /chromium's executable/);
      },
    );
    check(
      "collector: a Corepack outside the private runtime refuses collection",
      () =>
        refusesCollection((c) => {
          c.corepack_root = s.make("external-corepack");
        }, /Corepack is/),
    );
    check(
      "collector: a launcher outside the private runtime refuses collection",
      () => {
        const ex = executionAt(s);
        const other = s.make("external-bin");
        write(join(other, "pnpm"), "#!/bin/sh\n", 0o755);
        ex.launcher = join(other, "pnpm");
        return refusesCollection(undefined, /not the private runtime's/, ex);
      },
    );
    check(
      "collector: no execution refuses collection (no fallback to PATH)",
      () => refusesCollection(undefined, /no execution/, { env: {} }),
    );
    check(
      "collector: the runtime probe refuses to run without the guarded launcher",
      () => {
        try {
          a.runChildProbe({
            root: "/x",
            browsers: ["chromium"],
            execution: { env: {} },
          });
          return false;
        } catch (error) {
          return /guarded launcher/.test(error.message);
        }
      },
    );
    check(
      "collector: the same runtime content at two private paths is applicable (location-free), a changed launcher byte is not",
      () => {
        const { d } = fresh();
        const one = collect(d, undefined, executionAt(s));
        const two = collect(d, undefined, executionAt(s));
        const ex3 = executionAt(s);
        write(
          join(ex3.runtime, "bin/pnpm"),
          '#!/bin/sh\nexec corepack pnpm "$@" # B\n',
          0o755,
        );
        const three = collect(d, undefined, ex3);
        const c = a.compareApplicability(three, one);
        return (
          a.compareApplicability(two, one).decision === "applicable" &&
          one.runtime.root !== two.runtime.root &&
          c.differences.some((x) => x.field === "runtime.sha256") &&
          c.differences.some((x) => x.field === "launcher.pnpm_sha256")
        );
      },
    );
    check(
      "collector: a changed private Node or package-manager release changes the runtime digest",
      () => {
        const { d } = fresh();
        const one = collect(d, undefined, executionAt(s));
        const ex2 = executionAt(s);
        write(
          join(ex2.runtime, "corepack/v1/pnpm/12.4.2/package.json"),
          '{"name":"pnpm","x":1}',
        );
        const two = collect(d, undefined, ex2);
        return a
          .compareApplicability(two, one)
          .differences.some((x) => x.field === "runtime.sha256");
      },
    );
    check(
      "collector: the environment's private roots are tokenised; any other path still counts",
      () => {
        const { d } = fresh();
        const ex1 = executionAt(s);
        const ex2 = executionAt(s);
        const one = collect(d, undefined, ex1);
        const two = collect(d, undefined, ex2);
        const ex3 = executionAt(s);
        ex3.env.PLAYWRIGHT_BROWSERS_PATH = "/elsewhere/ms-playwright";
        const three = collect(d, undefined, ex3);
        return (
          one.env.PLAYWRIGHT_BROWSERS_PATH ===
            `${a.RUNTIME_TOKEN}/ms-playwright` &&
          a.compareApplicability(two, one).decision === "applicable" &&
          a
            .compareApplicability(three, one)
            .differences.some((x) => x.field === "env.PLAYWRIGHT_BROWSERS_PATH")
        );
      },
    );
    check(
      "comparison: a revision 27 /2 record is unknown, never applicable, even against itself",
      () => {
        const { d } = fresh();
        const r = collect(d);
        const old = { ...r, schema: "web08d-held-operation-applicability/2" };
        delete old.runtime;
        return (
          a.compareApplicability(r, old).decision === "unknown" &&
          a.compareApplicability(old, old).decision === "unknown"
        );
      },
    );
    check(
      "comparison: a revision 26 /1 record is unknown, never applicable, even against itself",
      () => {
        const { d } = fresh();
        const r = collect(d);
        const old = { ...r, schema: "web08d-held-operation-applicability/1" };
        return (
          a.compareApplicability(r, old).decision === "unknown" &&
          a.compareApplicability(old, old).decision === "unknown"
        );
      },
    );
    check(
      "comparison: a record missing its installation digest is unknown",
      () => {
        const { d } = fresh();
        const r = collect(d);
        const missing = structuredClone(r);
        delete missing.installation.sha256;
        return a.compareApplicability(r, missing).decision === "unknown";
      },
    );
    check(
      "witness: a /2 record's report must name the snapshot's own @playwright/test",
      () => {
        const { d } = fresh();
        const r = collect(d);
        const w = {
          node: r.child.node,
          exec_path: r.child.exec_path,
          platform: r.child.platform,
          arch: r.child.arch,
          playwright: r.packages["@playwright/test"].version,
        };
        return (
          a.witnessProblems(
            { ...w, playwright_dir: r.packages["@playwright/test"].dir },
            r,
          ).length === 0 &&
          a.witnessProblems(
            { ...w, playwright_dir: "/live/node_modules/@playwright/test" },
            r,
          ).length === 1 &&
          a.witnessProblems(w, r).length === 1
        );
      },
    );
    // Sealing (I4, H5): any write after sealing, even one undone, is seen; a sealed installation refuses writes.
    const sealed = (beforeSeal) => {
      const { d, files } = fresh();
      const x = i.allocateSnapshot(s.make("parent"));
      i.createSnapshot({ root: d, files, dir: x });
      i.relocate(x, d);
      beforeSeal?.(x);
      return { x, baseline: i.seal(x) };
    };
    const seen = (x, baseline) => {
      try {
        i.verifySealed(x, baseline, "in the check");
        return false;
      } catch (error) {
        return /the execution snapshot changed in the check/.test(
          error.message,
        );
      }
    };
    // Revision 29 (review r28 R28-N1), a labelled ADAPTATION of revision 27's "an untouched sealed snapshot verifies, and its caches
    // stay writable": the untouched snapshot still verifies (the original's first half, unchanged), but Vite's `.vite-temp` held an
    // executed config module, so a sealed snapshot has no tool cache and one created after sealing is now a change that is seen.
    check(
      "seal: an untouched sealed snapshot verifies; it has no tool cache, and one created after sealing is seen (revision 29)",
      () => {
        const { x, baseline } = sealed();
        const untouched =
          i.verifySealed(x, baseline, "unchanged").sha256 === baseline.sha256;
        const none = i.CACHE_DIRS.every(
          (c) => !existsSync(join(x, "node_modules", c)),
        );
        write(
          join(x, "node_modules/.vite-temp/config.mjs"),
          "export default {}",
        );
        return untouched && none && seen(x, baseline);
      },
    );
    check("seal: the sealed installation refuses a write", () => {
      const { x } = sealed();
      try {
        writeFileSync(join(x, STORE_A, "index.js"), "changed");
        return false;
      } catch (error) {
        return error.code === "EACCES";
      }
    });
    check(
      "seal: a change made and undone after sealing (A -> B -> A, times restored) is seen (H5)",
      () => {
        // Whole-second times before sealing, so the writer can restore them EXACTLY: only the change time can tell.
        const T = 1_700_000_000;
        const { x, baseline } = sealed((root) =>
          utimesSync(join(root, STORE_A, "index.js"), T, T),
        );
        const p = join(x, STORE_A, "index.js");
        const st = statSync(p, { bigint: true });
        const was = readFileSync(p);
        chmodSync(p, 0o644);
        writeFileSync(p, "changed");
        writeFileSync(p, was);
        chmodSync(p, Number(st.mode) & 0o7777);
        utimesSync(p, T, T);
        const now = statSync(p, { bigint: true });
        return (
          sha(readFileSync(p)) === sha(was) &&
          now.mtimeNs === st.mtimeNs &&
          now.ino === st.ino &&
          now.size === st.size &&
          now.mode === st.mode &&
          seen(x, baseline)
        );
      },
    );
    check(
      "seal: a file replaced by an identical copy (a rename) is seen",
      () => {
        const { x, baseline } = sealed();
        const dir = join(x, STORE_C);
        chmodSync(dir, 0o755);
        cpSync(join(dir, "index.js"), join(dir, "index.js.new"));
        renameSync(join(dir, "index.js.new"), join(dir, "index.js"));
        return seen(x, baseline);
      },
    );
    check("seal: a file added to a source directory is seen", () => {
      const { x, baseline } = sealed();
      write(join(x, "src/shadow.js"), "1");
      return seen(x, baseline);
    });
    check("seal: a removed snapshot leaves nothing behind", () => {
      const { x } = sealed();
      return i.removeSnapshot(x) === null && !existsSync(x);
    });
    // The snapshot record (qualification.mjs snapshotProblems), against the record it measured.
    const record = {
      installation: { sha256: "a".repeat(64), root: "/t/x" },
      runtime: {
        sha256: "e".repeat(64),
        root: "/t/rt",
        policy: EXECUTION_POLICY,
        policy_sha256: POLICY_SHA256,
      },
    };
    const R = "f".repeat(64);
    const T = "9".repeat(64);
    // Revision 29: the policy's guarded-empty generated directories, unchanged from sealing to the end.
    const E = sha("");
    const G = Object.fromEntries(GENERATED_TREES.map((n) => [n, E]));
    const good = {
      schema: i.SNAPSHOT_SCHEMA,
      policy: { id: EXECUTION_POLICY, sha256: POLICY_SHA256 },
      root: "/t/x",
      sealed_sha256: "b".repeat(64),
      installation_sha256: "a".repeat(64),
      runtime_root: "/t/rt",
      runtime_sha256: "e".repeat(64),
      runtime_sealed_sha256: R,
      runtime_checks: [
        { when: "before pnpm's preparation", runtime_sha256: R },
      ],
      source_state_before_sha256: "8".repeat(64),
      source_state_after_sha256: "8".repeat(64),
      trees: {
        ...Object.fromEntries(
          GENERATED_TREES.map((n) => [
            n,
            { sealed_sha256: E, entries: 0, self: "1 16832 2 1 1" },
          ]),
        ),
        "build b": { sealed_sha256: T },
      },
      checks: [
        {
          when: "before the build",
          sha256: "b".repeat(64),
          runtime_sha256: R,
          trees: { ...G },
        },
        {
          when: "before the preview",
          sha256: "b".repeat(64),
          runtime_sha256: R,
          trees: { ...G, "build b": T },
        },
      ],
      end_sha256: "b".repeat(64),
      runtime_end_sha256: R,
      trees_end: { ...G, "build b": T },
      unchanged: true,
      removed: true,
      runtime_removed: true,
    };
    const problems = (change) => {
      const sn = structuredClone(good);
      change?.(sn);
      return q.snapshotProblems(sn, record);
    };
    check(
      "snapshot record: a sealed, unchanged, removed snapshot of the record has no problem",
      () => problems().length === 0,
    );
    check(
      "snapshot record: none at all is unknown",
      () => q.snapshotProblems(null, record).length === 1,
    );
    check(
      "snapshot record: another schema is refused",
      () =>
        problems((x) => {
          x.schema = "other/1";
        }).length > 0,
    );
    check("snapshot record: a check that saw a change is refused", () =>
      problems((x) => {
        // Revision 28: only the snapshot's digest differs (the runtime and trees unchanged), so only this check can refuse it.
        x.checks.push({
          when: "before Playwright",
          sha256: "c".repeat(64),
          runtime_sha256: R,
          trees: {},
        });
      }).some((p) =>
        p.includes("execution snapshot changed (before Playwright)"),
      ),
    );
    check("snapshot record: a change by the end is refused", () =>
      problems((x) => {
        x.end_sha256 = "c".repeat(64);
      }).some((p) => p.includes("by the end")),
    );
    check("snapshot record: a snapshot not removed is refused", () =>
      problems((x) => {
        x.removed = false;
        x.removal_error = "EBUSY";
      }).some((p) => p.includes("not removed")),
    );
    check(
      "snapshot record: a snapshot of another installation is refused",
      () =>
        problems((x) => {
          x.installation_sha256 = "d".repeat(64);
        }).some((p) => p.includes("measured installation")),
    );
    check("snapshot record: a snapshot at another root is refused", () =>
      problems((x) => {
        x.root = "/t/y";
      }).some((p) => p.includes("collected at")),
    );
    check("snapshot record: one never sealed is refused", () =>
      problems((x) => {
        x.sealed_sha256 = null;
      }).some((p) => p.includes("never sealed")),
    );
    check("snapshot record: one not recorded unchanged is refused", () =>
      problems((x) => {
        x.unchanged = false;
      }).some((p) => p.includes("not recorded unchanged")),
    );
    check("snapshot record: no record to bind it to is refused", () =>
      q.snapshotProblems(good, null).some((p) => p.includes("cannot be bound")),
    );
    // Revision 29: the execution policy and its guarded-empty generated directories in the snapshot record.
    check(
      "snapshot record: one naming no execution policy (revision 28) is refused",
      () =>
        problems((x) => {
          delete x.policy;
        }).some((p) => p.includes("no current execution policy")),
    );
    check("snapshot record: one of an older execution policy is refused", () =>
      problems((x) => {
        x.policy.id = "web08d-held-operation-execution-policy/0";
      }).some((p) => p.includes("no current execution policy")),
    );
    check(
      "snapshot record: a generated directory that was not guarded, or not empty, is refused",
      () =>
        problems((x) => {
          delete x.trees[GENERATED_TREES[0]];
        }).some((p) => p.includes("was not guarded empty")) &&
        problems((x) => {
          x.trees[GENERATED_TREES[1]].entries = 1;
        }).some((p) => p.includes("was not guarded empty")),
    );
    check(
      "snapshot record: a run of another policy than its applicability record names is refused",
      () =>
        q
          .snapshotProblems(good, {
            ...record,
            runtime: { ...record.runtime, policy_sha256: "d".repeat(64) },
          })
          .some((p) => p.includes("but its applicability record names")),
    );
    // Revision 28: the private runtime, the guarded trees and the source installation's state in the snapshot record.
    check("snapshot record: a runtime never sealed is refused", () =>
      problems((x) => {
        x.runtime_sealed_sha256 = null;
      }).some((p) => p.includes("private runtime was never sealed")),
    );
    check(
      "snapshot record: a runtime change before the snapshot was sealed is refused",
      () =>
        problems((x) => {
          x.runtime_checks.push({
            when: "before the probe",
            runtime_sha256: "c".repeat(64),
          });
        }).some((p) =>
          p.includes("private runtime changed (before the probe)"),
        ),
    );
    check("snapshot record: a runtime change at a later check is refused", () =>
      problems((x) => {
        x.checks[1].runtime_sha256 = "c".repeat(64);
      }).some((p) =>
        p.includes("private runtime changed (before the preview)"),
      ),
    );
    check("snapshot record: a runtime changed by the end is refused", () =>
      problems((x) => {
        x.runtime_end_sha256 = "c".repeat(64);
      }).some((p) => p.includes("private runtime changed by the end")),
    );
    check("snapshot record: a runtime not removed is refused", () =>
      problems((x) => {
        x.runtime_removed = false;
      }).some((p) => p.includes("private runtime was not removed")),
    );
    check("snapshot record: a runtime of another digest is refused", () =>
      problems((x) => {
        x.runtime_sha256 = "d".repeat(64);
      }).some((p) => p.includes("private runtime measured")),
    );
    check("snapshot record: a runtime at another root is refused", () =>
      problems((x) => {
        x.runtime_root = "/t/other";
      }).some((p) => p.includes("collected from")),
    );
    check("snapshot record: a guarded tree changed at a check is refused", () =>
      problems((x) => {
        x.checks[1].trees["build b"] = "c".repeat(64);
      }).some((p) =>
        p.includes("guarded tree build b changed (before the preview)"),
      ),
    );
    check("snapshot record: a guarded tree changed by the end is refused", () =>
      problems((x) => {
        x.trees_end["build b"] = "c".repeat(64);
      }).some((p) => p.includes("guarded tree build b changed by the end")),
    );
    check(
      "snapshot record: a source installation written during preparation is refused",
      () =>
        problems((x) => {
          x.source_state_after_sha256 = "c".repeat(64);
        }).some((p) =>
          p.includes("source installation is not recorded unchanged"),
        ),
    );
    check(
      "snapshot record: an unrecorded source installation state is refused",
      () =>
        problems((x) => {
          x.source_state_before_sha256 = null;
          x.source_state_after_sha256 = null;
        }).some((p) =>
          p.includes("source installation is not recorded unchanged"),
        ),
    );
    check("snapshot record: the revision 27 schema (/1) is refused", () =>
      problems((x) => {
        x.schema = "web08d-held-operation-snapshot/1";
      }).some((p) => p.includes("not web08d-held-operation-snapshot/2")),
    );
    executionAssessments(i, a, x, check, s);
  } finally {
    s.done();
  }
}

/** This worktree's own installed playwright package (read only: the source of the adapter's upstream files in the fixtures). */
const UPSTREAM_PLAYWRIGHT = dirname(
  createRequire(
    createRequire(join(import.meta.dirname, "../../package.json")).resolve(
      "@playwright/test/package.json",
    ),
  ).resolve("playwright/package.json"),
);
/**
 * A pnpm tree whose installation also holds a minimal @playwright/test -> playwright -> playwright-core chain (browsers.json).
 * Revision 29: its playwright is 1.63.0 with the two upstream compilation-cache files the transform adapter changes.
 */
function playwrightTree(dir) {
  const files = pnpmTree(dir);
  const nm = join(dir, "node_modules");
  const store = join(nm, ".pnpm");
  const pkg = (rel, name) =>
    write(
      join(store, rel, "package.json"),
      JSON.stringify({ name, version: "1.0.0" }),
    );
  pkg(
    "@playwright+test@1.0.0/node_modules/@playwright/test",
    "@playwright/test",
  );
  pkg("playwright@1.0.0/node_modules/playwright", "playwright");
  // Revision 29: the transform adapter's release and its two upstream files, by their exact bytes (copied from this installation).
  write(
    join(store, "playwright@1.0.0/node_modules/playwright/package.json"),
    JSON.stringify({ name: "playwright", version: "1.63.0" }),
  );
  for (const rel of Object.keys(ADAPTED_FILES))
    write(
      join(store, "playwright@1.0.0/node_modules/playwright", rel),
      readFileSync(join(UPSTREAM_PLAYWRIGHT, rel)),
    );
  pkg("playwright-core@1.0.0/node_modules/playwright-core", "playwright-core");
  write(
    join(
      store,
      "playwright-core@1.0.0/node_modules/playwright-core/browsers.json",
    ),
    JSON.stringify({
      browsers: [
        { name: "chromium", revision: "1" },
        { name: "chromium-headless-shell", revision: "1" },
        { name: "firefox", revision: "2" },
        { name: "webkit", revision: "3", revisionOverrides: { mac14: "4" } },
      ],
    }),
  );
  link(
    join(store, "@playwright+test@1.0.0/node_modules/playwright"),
    "../../playwright@1.0.0/node_modules/playwright",
  );
  link(
    join(store, "playwright@1.0.0/node_modules/playwright-core"),
    "../../playwright-core@1.0.0/node_modules/playwright-core",
  );
  link(
    join(nm, "@playwright/test"),
    "../.pnpm/@playwright+test@1.0.0/node_modules/@playwright/test",
  );
  return files;
}

/**
 * A fake EXTERNAL launcher chain (what a developer's PATH resolves): a PATH directory with the task launcher (or Corepack's pnpm.js
 * through a link), `corepack` and `node` (a link to this Node), a Corepack package whose entry points only exit 0, a Corepack cache
 * holding pnpm 12.4.2, a HOME and the browsers. The project's package.json names packageManager pnpm@12.4.2.
 */
function fakeChain(
  s,
  { form = "task-shim", project, entry = "process.exit(0);\n" } = {},
) {
  const base = s.make("chain");
  const bin = join(base, "bin");
  const corepack = join(base, "lib/node_modules/corepack");
  write(
    join(corepack, "package.json"),
    JSON.stringify({ name: "corepack", version: "0.34.0" }),
  );
  write(
    join(corepack, "dist/corepack.js"),
    `#!/usr/bin/env node\n${entry}`,
    0o755,
  );
  write(join(corepack, "dist/pnpm.js"), `#!/usr/bin/env node\n${entry}`, 0o755);
  if (form === "task-shim")
    write(join(bin, "pnpm"), '#!/bin/sh\nexec corepack pnpm "$@"\n', 0o755);
  else link(join(bin, "pnpm"), "../lib/node_modules/corepack/dist/pnpm.js");
  link(join(bin, "corepack"), "../lib/node_modules/corepack/dist/corepack.js");
  link(join(bin, "node"), process.execPath);
  const home = join(base, "home");
  write(join(home, ".cache/node/corepack/v1/pnpm/12.4.2/.corepack"), "{}");
  write(
    join(home, ".cache/node/corepack/v1/pnpm/12.4.2/pnpm-native"),
    "pnpm",
    0o755,
  );
  const browsers = join(base, "ms-playwright");
  write(join(browsers, "chromium-1/chrome"), "chrome");
  write(join(browsers, "chromium_headless_shell-1/shell"), "shell");
  if (project) {
    const p = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    p.packageManager = "pnpm@12.4.2";
    writeFileSync(join(project, "package.json"), JSON.stringify(p));
  }
  const tmp = s.make("tmpdir");
  return {
    base,
    bin,
    corepack,
    home,
    browsers,
    env: {
      PATH: [bin, "/usr/bin", "/bin"].join(":"),
      HOME: home,
      TMPDIR: tmp,
      LANG: "en_GB.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: browsers,
    },
  };
}
/** The fingerprint map of a tree's source files (createSnapshot's `files`), recomputed after an edit to package.json. */
const filesOf = (d) => ({
  "package.json": sha(readFileSync(join(d, "package.json"))),
  "src/x.js": sha(readFileSync(join(d, "src/x.js"))),
});
const throwsLike = (fn, pattern) => {
  try {
    fn();
    return false;
  } catch (error) {
    return pattern.test(String(error.message));
  }
};

/** Revision 28 checks (design assessment Q1, Q3, Q5): `i` installation, `a` applicability, `x` execution, `s` the scratch helper. */
function executionAssessments(i, a, x, check, s) {
  const tree = (label = "src") => {
    const d = s.make(label);
    const files = pnpmTree(d);
    return { d, files };
  };
  const state = (d) => i.sourceState(d).sha256;
  // Q1 / H2: linked installation roots are refused before anything is written.
  check("isolation: a real installation root has no root problem", () => {
    const { d } = tree();
    return i.installationRootProblems(d).length === 0;
  });
  const linkedRoot = (target) => {
    const { d: other } = tree("linked-target");
    const d = s.make("linked-source");
    write(join(d, "package.json"), readFileSync(join(other, "package.json")));
    write(join(d, "src/x.js"), "export const x = 1;\n");
    symlinkSync(target(other, d), join(d, "node_modules"));
    return { d, other, files: filesOf(d) };
  };
  for (const [label, target] of [
    ["an absolute", (other) => join(other, "node_modules")],
    [
      "a relative",
      (other) => join("..", other.split("/").at(-1), "node_modules"),
    ],
  ])
    check(
      `isolation: ${label} installation-root link is refused before anything is copied or written (its target unchanged; review r27 R27-N2)`,
      () => {
        const { d, other, files } = linkedRoot(target);
        const before = state(other);
        const dir = i.allocateSnapshot(s.make("parent"));
        const refused = throwsLike(
          () => i.createSnapshot({ root: d, files, dir }),
          /is a link .*not supported/,
        );
        return (
          refused &&
          readdirSync(dir).length === 0 &&
          state(other) === before &&
          i.installationRootProblems(d).length === 1
        );
      },
    );
  check("isolation: a dangling installation-root link is refused", () => {
    const d = s.make("dangling");
    pnpmTree(join(d, "w"));
    symlinkSync(join(d, "nowhere"), join(d, "node_modules"));
    return /dangling/.test(i.installationRootProblems(d)[0] ?? "");
  });
  check(
    "isolation: relocation through a linked snapshot root is refused and writes nothing into the installation it names (R27-N2's writer)",
    () => {
      const { d } = tree();
      const before = state(d);
      const dir = i.allocateSnapshot(s.make("parent"));
      symlinkSync(join(d, "node_modules"), join(dir, "node_modules"));
      return (
        throwsLike(
          () => i.relocate(dir, d),
          /relocation refused: .*is a link/,
        ) && state(d) === before
      );
    },
  );
  check(
    "isolation: sealing through a linked snapshot root is refused and changes no mode in the installation it names",
    () => {
      const { d } = tree();
      const before = state(d);
      const dir = i.allocateSnapshot(s.make("parent"));
      symlinkSync(join(d, "node_modules"), join(dir, "node_modules"));
      return (
        throwsLike(() => i.seal(dir), /sealing refused/) && state(d) === before
      );
    },
  );
  check(
    "isolation: a nested absolute link back into the source is refused by the copy check, before relocation (source unchanged)",
    () => {
      const { d, files } = tree();
      symlinkSync(join(d, STORE_C), join(d, "node_modules/back"));
      const before = state(d);
      const dir = i.allocateSnapshot(s.make("parent"));
      const refused = throwsLike(
        () => i.createSnapshot({ root: d, files, dir }),
        /not independent of its source.*back resolves to/,
      );
      return (
        refused &&
        state(d) === before &&
        i.removeSnapshot(dir) === null &&
        !existsSync(dir)
      );
    },
  );
  check(
    "isolation: a nested link out of the installation is refused by the copy check",
    () => {
      const { d, files } = tree();
      const out = s.make("outside");
      symlinkSync(out, join(d, "node_modules/out"));
      const dir = i.allocateSnapshot(s.make("parent"));
      return throwsLike(
        () => i.createSnapshot({ root: d, files, dir }),
        /out resolves to .*outside the copy/,
      );
    },
  );
  check("isolation: a hard link inside a copy is refused", () => {
    const { d, files } = tree();
    const dir = i.allocateSnapshot(s.make("parent"));
    i.createSnapshot({ root: d, files, dir });
    const other = s.make("hard");
    write(join(other, "f"), "1");
    linkSync(join(other, "f"), join(dir, STORE_C, "hard.js"));
    return i.independenceProblems(d, dir).some((p) => p.includes("hard link"));
  });
  check(
    "isolation: the source's own installation as the copy is refused (shared inodes)",
    () => {
      const { d } = tree();
      return i
        .independenceProblems(d, d)
        .some((p) =>
          p.includes("installation root is the source's own directory"),
        );
    },
  );
  check(
    "isolation: a destination inside the source is refused before anything is copied",
    () => {
      const { d, files } = tree();
      const dir = join(d, ".agtx/inside");
      mkdirSync(dir, { recursive: true });
      return throwsLike(
        () => i.createSnapshot({ root: d, files, dir }),
        /overlap/,
      );
    },
  );
  const prepared = () => {
    const { d, files } = tree();
    const dir = i.allocateSnapshot(s.make("parent"));
    i.createSnapshot({ root: d, files, dir });
    return { d, dir };
  };
  check(
    "isolation: a snapshot root replaced by a link before relocation is refused; the link's target is untouched",
    () => {
      const { d, dir } = prepared();
      const moved = `${dir}.moved`;
      renameSync(dir, moved);
      symlinkSync(moved, dir);
      const shim = readFileSync(join(moved, "node_modules/.bin/c"));
      return (
        throwsLike(() => i.relocate(dir, d), /not a real directory/) &&
        readFileSync(join(moved, "node_modules/.bin/c")).equals(shim)
      );
    },
  );
  check(
    "isolation: a snapshot root replaced by another directory is refused",
    () => {
      const { d, dir } = prepared();
      renameSync(dir, `${dir}.old`);
      mkdirSync(dir, { mode: 0o700 });
      return throwsLike(() => i.relocate(dir, d), /was replaced/);
    },
  );
  check(
    "isolation: removing a snapshot whose root was replaced by a link removes and unseals nothing through it",
    () => {
      const { d, dir } = prepared();
      i.relocate(dir, d);
      i.seal(dir);
      const moved = `${dir}.moved`;
      renameSync(dir, moved);
      symlinkSync(moved, dir);
      const was = i.statInventory(moved).sha256;
      const error = i.removeSnapshot(dir);
      return (
        typeof error === "string" &&
        /not a real directory/.test(error) &&
        existsSync(moved) &&
        i.statInventory(moved).sha256 === was
      );
    },
  );
  check(
    "isolation: relocation never writes through a link inside the copy",
    () => {
      const { d, dir } = prepared();
      const outside = s.make("victim");
      write(
        join(outside, "shim"),
        `export NODE_PATH="${join(d, "node_modules")}"\n`,
      );
      const before = readFileSync(join(outside, "shim"));
      unlinkSync(join(dir, "node_modules/.bin/c"));
      symlinkSync(join(outside, "shim"), join(dir, "node_modules/.bin/c"));
      i.relocate(dir, d);
      return readFileSync(join(outside, "shim")).equals(before);
    },
  );
  check(
    "isolation: an independent snapshot's whole lifecycle leaves the source installation exactly as it was (H1)",
    () => {
      const { d, files } = tree();
      const before = i.sourceState(d);
      const dir = i.allocateSnapshot(s.make("parent"));
      i.createSnapshot({ root: d, files, dir });
      i.relocate(dir, d);
      const baseline = i.seal(dir);
      i.verifySealed(dir, baseline, "now");
      const removed = i.removeSnapshot(dir);
      return (
        removed === null &&
        !existsSync(dir) &&
        i.sourceState(d).sha256 === before.sha256
      );
    },
  );
  for (const [label, edit] of [
    ["a mode change", (d) => chmodSync(join(d, STORE_C, "index.js"), 0o600)],
    [
      "a nested shim edit",
      (d) =>
        writeFileSync(
          join(d, STORE_A, "node_modules/.bin/c"),
          "#!/bin/sh\n# edited\n",
        ),
    ],
    [
      "a link retarget",
      (d) => {
        unlinkSync(join(d, "node_modules/a"));
        symlinkSync(
          ".pnpm/plug@1.0.0/node_modules/plug",
          join(d, "node_modules/a"),
        );
      },
    ],
    [
      "a directory mode change",
      (d) => chmodSync(join(d, "node_modules/.pnpm"), 0o700),
    ],
  ])
    check(`isolation: the source installation's state sees ${label}`, () => {
      const { d } = tree();
      const before = state(d);
      edit(d);
      return state(d) !== before;
    });
  check(
    "isolation: the source installation's state ignores the tool caches",
    () => {
      const { d } = tree();
      const before = state(d);
      write(join(d, "node_modules/.vite/deps/more.json"), "{}");
      return state(d) === before;
    },
  );

  // The launcher chain (C3): supported forms only; an opaque launcher is refused, never hashed into acceptance.
  const chainOf = (options = {}) => {
    const { d } = tree("project");
    const c = fakeChain(s, { ...options, project: d });
    return { d, c };
  };
  check(
    "launcher: the task's launcher resolves its whole chain (corepack, node, pnpm 12.4.2 from Corepack's cache)",
    () => {
      const { d, c } = chainOf();
      const chain = x.launcherChain(c.env, d);
      return (
        chain.form === "task-shim" &&
        chain.node.realpath === realpathSync(process.execPath) &&
        chain.corepack.package === realpathSync(c.corepack) &&
        chain.manager.version === "12.4.2"
      );
    },
  );
  check("launcher: Corepack's own pnpm.js is a supported launcher", () => {
    const { d, c } = chainOf({ form: "corepack-pnpm" });
    return x.launcherChain(c.env, d).form === "corepack-pnpm";
  });
  check(
    "launcher: an opaque wrapper first on PATH (review r27's private wrapper) is refused: its closure cannot be known",
    () => {
      const { d, c } = chainOf();
      const wrapper = s.make("wrapper");
      write(
        join(wrapper, "pnpm"),
        `#!/bin/sh\nexec ${join(c.bin, "pnpm")} "$@"\n`,
        0o755,
      );
      return throwsLike(
        () =>
          x.launcherChain({ ...c.env, PATH: `${wrapper}:${c.env.PATH}` }, d),
        /not a supported launcher/,
      );
    },
  );
  check(
    "launcher: a task launcher whose corepack is not Corepack's is refused",
    () => {
      const { d, c } = chainOf();
      unlinkSync(join(c.bin, "corepack"));
      write(join(c.bin, "corepack"), "#!/bin/sh\n", 0o755);
      return throwsLike(() => x.launcherChain(c.env, d), /not Corepack's own/);
    },
  );
  check("launcher: Corepack run by another interpreter is refused", () => {
    const { d, c } = chainOf();
    writeFileSync(join(c.corepack, "dist/corepack.js"), "#!/usr/bin/env bun\n");
    return throwsLike(
      () => x.launcherChain(c.env, d),
      /not #!\/usr\/bin\/env node/,
    );
  });
  check("launcher: an inexact packageManager is refused", () => {
    const { d, c } = chainOf();
    const p = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
    p.packageManager = "pnpm@^12";
    writeFileSync(join(d, "package.json"), JSON.stringify(p));
    return throwsLike(
      () => x.launcherChain(c.env, d),
      /not an exact pnpm release/,
    );
  });
  check(
    "launcher: a release not in Corepack's cache is refused (nothing is downloaded)",
    () => {
      const { d, c } = chainOf();
      rmSync(join(c.home, ".cache/node/corepack/v1/pnpm/12.4.2"), {
        recursive: true,
      });
      return throwsLike(
        () => x.launcherChain(c.env, d),
        /nothing is downloaded/,
      );
    },
  );
  check("launcher: a global npmrc beside the external Node is refused", () => {
    const { d, c } = chainOf();
    const prefix = s.make("prefix");
    copyFileSync(process.execPath, join(prefix, "node"));
    mkdirSync(join(prefix, "bin"));
    renameSync(join(prefix, "node"), join(prefix, "bin/node"));
    write(join(prefix, "etc/npmrc"), "x=1\n");
    unlinkSync(join(c.bin, "node"));
    symlinkSync(join(prefix, "bin/node"), join(c.bin, "node"));
    return throwsLike(() => x.launcherChain(c.env, d), /global npmrc/);
  });
  check("launcher: no pnpm on PATH is refused", () => {
    const { d, c } = chainOf();
    return throwsLike(
      () => x.launcherChain({ ...c.env, PATH: "/usr/bin" }, d),
      /no executable pnpm/,
    );
  });

  // The private runtime (C3, C4): independent, sealed, location-free; every change after sealing is seen by the guard.
  const runtimeOf = (options) => {
    const { d, c } = chainOf(options);
    const chain = x.launcherChain(c.env, d);
    const dir = i.allocateSnapshot(s.make("parent"));
    i.createSnapshot({ root: d, files: filesOf(d), dir });
    const rt = i.allocateSnapshot(s.make("parent"), "held-op-runtime-");
    const sources = [
      { name: "chromium-1", from: join(c.browsers, "chromium-1") },
      {
        name: "chromium_headless_shell-1",
        from: join(c.browsers, "chromium_headless_shell-1"),
      },
    ];
    const baseline = x.createRuntime(rt, chain, c.env, sources);
    const journal = x.snapshotJournal(d, true);
    const ex = x.newExecution({ journal });
    Object.assign(ex, {
      runtime: rt,
      runtimeBaseline: baseline,
      chain,
      launcher: join(rt, "bin/pnpm"),
    });
    return { d, c, rt, ex, journal, baseline, chain };
  };
  const guardSees = (ex, pattern) => {
    try {
      ex.check("in the check");
      return false;
    } catch (error) {
      return pattern.test(String(error.message));
    }
  };
  check(
    "runtime: the private runtime holds the measured chain, sealed and independent of its sources",
    () => {
      const { rt, c } = runtimeOf();
      const nodeStat = lstatSync(join(rt, "bin/node"));
      const extStat = lstatSync(realpathSync(process.execPath));
      return (
        readFileSync(join(rt, "bin/pnpm"), "utf8") === x.TASK_SHIM &&
        realpathSync(join(rt, "bin/corepack")) ===
          realpathSync(
            join(rt, "lib/node_modules/corepack/dist/corepack.js"),
          ) &&
        existsSync(join(rt, "corepack/v1/pnpm/12.4.2/pnpm-native")) &&
        existsSync(join(rt, "ms-playwright/chromium-1/chrome")) &&
        nodeStat.ino !== extStat.ino &&
        (statSync(join(rt, "bin/pnpm")).mode & 0o222) === 0 &&
        throwsLike(() => writeFileSync(join(rt, "bin/pnpm"), "x"), /EACCES/) &&
        existsSync(join(c.bin, "pnpm"))
      );
    },
  );
  check(
    "runtime: a chain whose Corepack package links outside itself is refused (the runtime would share what the link names)",
    () => {
      const { d, c } = chainOf();
      const outside = s.make("outside");
      write(join(outside, "lib.js"), "1");
      symlinkSync(join(outside, "lib.js"), join(c.corepack, "dist/lib.js"));
      const chain = x.launcherChain(c.env, d);
      const rt = i.allocateSnapshot(s.make("parent"), "held-op-runtime-");
      return throwsLike(
        () => x.createRuntime(rt, chain, c.env, []),
        /private runtime is not independent: .*lib\.js resolves to/,
      );
    },
  );
  check("runtime: an untouched runtime passes the guard", () => {
    const { ex, journal } = runtimeOf();
    const e = ex.check("now");
    return (
      e.runtime_sha256 === journal.runtime_checks[0].runtime_sha256 && !e.error
    );
  });
  check(
    "runtime: the runtime's content digest is location-free (two runtimes of one chain)",
    () => {
      const one = runtimeOf();
      const twoRt = i.allocateSnapshot(s.make("parent"), "held-op-runtime-");
      x.createRuntime(twoRt, one.chain, one.c.env, []);
      const strip = i.allocateSnapshot(s.make("parent"), "held-op-runtime-");
      x.createRuntime(strip, one.chain, one.c.env, []);
      return (
        x.runtimeManifest(twoRt).sha256 === x.runtimeManifest(strip).sha256 &&
        x.runtimeManifest(one.rt).entries > 5
      );
    },
  );
  const T0 = 1_700_000_000;
  check(
    "runtime: the launcher changed and restored after sealing (A -> B -> A, bytes, mode and times restored) is seen by the guard (H5)",
    () => {
      const { ex, rt } = runtimeOf();
      const p = join(rt, "bin/pnpm");
      chmodSync(join(rt, "bin"), 0o755);
      chmodSync(p, 0o755);
      const was = readFileSync(p);
      writeFileSync(p, "#!/bin/sh\necho B\n");
      writeFileSync(p, was);
      chmodSync(p, 0o555);
      utimesSync(p, T0, T0);
      chmodSync(join(rt, "bin"), 0o555);
      return (
        guardSees(
          ex,
          /private runtime changed in the check: (D bin|F bin\/pnpm)/,
        ) && ex.journal.runtime_checks.at(-1).error
      );
    },
  );
  check(
    "runtime: the launcher replaced by an identical copy (an atomic rename) is seen by the guard (H6)",
    () => {
      const { ex, rt } = runtimeOf();
      chmodSync(join(rt, "bin"), 0o755);
      copyFileSync(join(rt, "bin/pnpm"), join(rt, "bin/pnpm.new"));
      chmodSync(join(rt, "bin/pnpm.new"), 0o555);
      renameSync(join(rt, "bin/pnpm.new"), join(rt, "bin/pnpm"));
      chmodSync(join(rt, "bin"), 0o555);
      return guardSees(ex, /private runtime changed/);
    },
  );
  check(
    "runtime: the private Node changed and restored is seen by the guard (H7)",
    () => {
      const { ex, rt } = runtimeOf();
      const p = join(rt, "bin/node");
      chmodSync(p, 0o755);
      const fd = readFileSync(p, { flag: "r" }).subarray(0, 4);
      writeFileSync(
        p,
        Buffer.concat([Buffer.from("BBBB"), readFileSync(p).subarray(4)]),
      );
      writeFileSync(p, Buffer.concat([fd, readFileSync(p).subarray(4)]));
      chmodSync(p, 0o555);
      return guardSees(ex, /private runtime changed in the check: F bin\/node/);
    },
  );
  check(
    "runtime: a configuration file created and removed in the private HOME is seen (an absent candidate, H7)",
    () => {
      const { ex, rt } = runtimeOf();
      chmodSync(join(rt, "home"), 0o755);
      writeFileSync(join(rt, "home/.npmrc"), "x=1\n");
      unlinkSync(join(rt, "home/.npmrc"));
      chmodSync(join(rt, "home"), 0o555);
      return guardSees(ex, /private runtime changed in the check: D home/);
    },
  );
  check(
    "runtime: a browser payload changed and restored is seen by the guard (H7)",
    () => {
      const { ex, rt } = runtimeOf();
      const p = join(rt, "ms-playwright/chromium-1/chrome");
      chmodSync(p, 0o644);
      writeFileSync(p, "B");
      writeFileSync(p, "chrome");
      chmodSync(p, 0o444);
      utimesSync(p, T0, T0);
      return guardSees(ex, /private runtime changed/);
    },
  );
  check(
    "runtime: an existing configuration file is copied into the private HOME, an absent one stays absent",
    () => {
      const { d, c } = chainOf();
      write(join(c.home, ".npmrc"), "node-linker=isolated\n");
      const chain = x.launcherChain(c.env, d);
      const rt = i.allocateSnapshot(s.make("parent"), "held-op-runtime-");
      x.createRuntime(rt, chain, c.env, []);
      return (
        readFileSync(join(rt, "home/.npmrc"), "utf8") ===
          "node-linker=isolated\n" &&
        !existsSync(join(rt, "home/Library/Preferences/pnpm/rc")) &&
        !existsSync(join(rt, "home/.config/pnpm/rc"))
      );
    },
  );
  check(
    "runtime: a guarded tree changed and restored is seen by the guard (H9)",
    () => {
      const { ex } = runtimeOf();
      const t = s.make("guarded");
      write(join(t, "tests/e2e/a.spec.ts"), "a");
      ex.guard("copy tree t", t);
      chmodSync(join(t, "tests/e2e"), 0o755);
      chmodSync(join(t, "tests/e2e/a.spec.ts"), 0o644);
      writeFileSync(join(t, "tests/e2e/a.spec.ts"), "b");
      writeFileSync(join(t, "tests/e2e/a.spec.ts"), "a");
      return guardSees(ex, /guarded tree copy tree t changed/);
    },
  );
  check(
    "runtime: the runtime root replaced by a link to its own moved content (identical entries) is seen by the guard",
    () => {
      const { ex, rt } = runtimeOf();
      renameSync(rt, `${rt}.moved`);
      symlinkSync(`${rt}.moved`, rt);
      const seen = guardSees(
        ex,
        /its root .* is not the directory that was sealed/,
      );
      unlinkSync(rt);
      renameSync(`${rt}.moved`, rt);
      return seen;
    },
  );
  check(
    "runtime: a guarded tree's root replaced by another directory with the same content is seen",
    () => {
      const { ex } = runtimeOf();
      const t = s.make("guarded");
      write(join(t, "x.txt"), "a");
      ex.guard("tree", t);
      renameSync(t, `${t}.old`);
      cpSync(`${t}.old`, t, { recursive: true, preserveTimestamps: true });
      const seen = guardSees(
        ex,
        /guarded tree tree changed in the check: its root/,
      );
      i.removeSnapshot(`${t}.old`);
      return seen;
    },
  );
  check("runtime: a guarded tree is read-only once guarded", () => {
    const { ex } = runtimeOf();
    const t = s.make("guarded");
    write(join(t, "x.txt"), "a");
    ex.guard("tree", t);
    return throwsLike(() => writeFileSync(join(t, "x.txt"), "b"), /EACCES/);
  });

  // The frozen environment and the guarded launch (C3).
  check(
    "environment: the frozen environment names only the private runtime and the system directories",
    () => {
      const env = x.frozenEnv(
        {
          PATH: "/opt/homebrew/bin:/usr/bin",
          HOME: "/Users/u",
          COREPACK_ROOT: "/x",
          PNPM_HOME: "/p",
          XDG_CACHE_HOME: "/c",
          LANG: "C",
        },
        "/rt",
        "/s",
      );
      return (
        env.PATH === "/rt/bin:/usr/bin:/bin:/usr/sbin:/sbin" &&
        env.HOME === "/rt/home" &&
        env.XDG_CONFIG_HOME === "/rt/home/.config" &&
        env.COREPACK_HOME === "/rt/corepack" &&
        env.COREPACK_ENABLE_NETWORK === "0" &&
        env.PLAYWRIGHT_BROWSERS_PATH === "/rt/ms-playwright" &&
        env.PWTEST_CACHE_DIR === "/s/.agtx/cache/playwright" &&
        !("COREPACK_ROOT" in env) &&
        env.PNPM_HOME === "/s/.agtx/state/pnpm" &&
        !("XDG_CACHE_HOME" in env) &&
        env.LANG === "C"
      );
    },
  );
  for (const [k, v] of [
    ["DYLD_INSERT_LIBRARIES", "/x/hook.dylib"],
    ["NODE_OPTIONS", "--require /x/hook.js"],
    ["LD_PRELOAD", "/x/hook.so"],
    ["BASH_ENV", "/x/rc"],
    ["npm_config_globalconfig", "/x/npmrc"],
  ])
    check(
      `environment: ${k} is refused (an input no measurement follows)`,
      () =>
        throwsLike(
          () => x.frozenEnv({ PATH: "/usr/bin", [k]: v }, "/rt", "/c"),
          new RegExp(k),
        ),
    );
  // Revision 29 (review r28 R28-N1), a labelled ADAPTATION of revision 28's "a package-manager setting that names no path is kept":
  // such a setting is still not refused (the original's intent: only path-valued settings refuse), but it is no longer inherited,
  // because a setting without an absolute path can still select code (node-options with a relative --require, for one).
  check(
    "environment: a package-manager setting that names no path is not refused, and is not inherited (revision 29)",
    () => {
      const env = x.frozenEnv(
        {
          PATH: "/usr/bin",
          npm_config_user_agent: "pnpm/12.4.2 npm/? node/v22 darwin arm64",
          npm_config_node_options: "--require=./.agtx/cache/x.cjs",
        },
        "/rt",
        "/c",
      );
      return (
        !("npm_config_user_agent" in env) && !("npm_config_node_options" in env)
      );
    },
  );
  const launchRuntime = () => {
    const rt = i.allocateSnapshot(s.make("parent"), "held-op-runtime-");
    const marker = join(s.make("marker"), "ran");
    write(
      join(rt, "bin/pnpm"),
      `#!/bin/sh\nprintf '%s|%s|%s|%s' "$0" "$PATH" "\${HELD_OP_OUTSIDE:-unset}" "$1" > "${marker}"\n`,
      0o755,
    );
    const ex = x.newExecution({ journal: x.snapshotJournal("/src", true) });
    const st = lstatSync(rt);
    const baseline = { ...i.sealTree(rt), root: { dev: st.dev, ino: st.ino } };
    Object.assign(ex, {
      runtime: rt,
      runtimeBaseline: baseline,
      launcher: join(rt, "bin/pnpm"),
      env: {
        PATH: [join(rt, "bin"), ...x.SYSTEM_PATH].join(":"),
        HOME: "/nonexistent",
      },
    });
    return { rt, ex, marker };
  };
  check(
    "launch: a guarded launch runs the private launcher by its absolute path in the frozen environment only",
    () => {
      const { rt, ex, marker } = launchRuntime();
      process.env.HELD_OP_OUTSIDE = "leaked";
      try {
        const r = ex.spawnSync("the probe", ["exec"], { cwd: rt });
        const [zero, path, outside, arg] = readFileSync(marker, "utf8").split(
          "|",
        );
        return (
          r.status === 0 &&
          zero === join(rt, "bin/pnpm") &&
          path === [join(rt, "bin"), ...x.SYSTEM_PATH].join(":") &&
          outside === "unset" &&
          arg === "exec" &&
          ex.journal.runtime_checks.at(-1).when === "before the probe"
        );
      } finally {
        delete process.env.HELD_OP_OUTSIDE;
      }
    },
  );
  check(
    "launch: after a runtime change the guard refuses the launch and the child never runs",
    () => {
      const { rt, ex, marker } = launchRuntime();
      chmodSync(join(rt, "bin"), 0o755);
      copyFileSync(join(rt, "bin/pnpm"), join(rt, "bin/pnpm.b"));
      renameSync(join(rt, "bin/pnpm.b"), join(rt, "bin/pnpm"));
      return (
        throwsLike(
          () => ex.spawnSync("the build", [], { cwd: rt }),
          /private runtime changed before the build/,
        ) && !existsSync(marker)
      );
    },
  );
  check(
    "launch: the qualification seam runs after the guard and before the child, with the launch's number",
    () => {
      const { rt, ex, marker } = launchRuntime();
      const seen = [];
      const ex2 = x.newExecution({
        journal: ex.journal,
        afterGuard: (what, n) =>
          seen.push([
            what,
            n,
            ex.journal.runtime_checks.length,
            existsSync(marker),
          ]),
      });
      Object.assign(ex2, {
        runtime: ex.runtime,
        runtimeBaseline: ex.runtimeBaseline,
        launcher: ex.launcher,
        env: ex.env,
      });
      ex2.spawnSync("one", [], { cwd: rt });
      ex2.spawnSync("two", [], { cwd: rt });
      return (
        seen.length === 2 &&
        seen[0][1] === 1 &&
        seen[1][1] === 2 &&
        seen[0][2] === 1 &&
        seen[0][3] === false &&
        seen[1][0] === "two"
      );
    },
  );
  check(
    "launch: pnpm's preparation needs the guarded launcher (no PATH fallback)",
    () => throwsLike(() => i.preparePnpm("/x", undefined), /guarded launcher/),
  );

  // The shared lifecycle end to end (C1, C2, I5) over the fake chain: its Corepack only exits 0, so pnpm's preparation "succeeds".
  const lifecycle = () => {
    const d = s.make("lifecycle");
    playwrightTree(d);
    const c = fakeChain(s, { project: d });
    const journal = x.snapshotJournal(d, true);
    const ex = x.newExecution({ journal });
    return { d, c, journal, ex, files: filesOf(d) };
  };
  check(
    "lifecycle: the shared preparation copies, seals, prepares through the guard and removes everything it allocated (source unchanged)",
    () => {
      const { d, c, journal, ex, files } = lifecycle();
      const before = state(d);
      x.prepareExecution(ex, {
        source: d,
        files,
        browsers: ["chromium"],
        env: c.env,
        trees: ".agtx/trees/t",
      });
      const ok =
        journal.prepared === true &&
        journal.runtime_form === "task-shim" &&
        journal.runtime_checks.some(
          (e) => e.when === "before pnpm's preparation in the snapshot",
        ) &&
        journal.checks.some((e) => e.when === "when the snapshot was sealed") &&
        journal.source_state_after_sha256 ===
          journal.source_state_before_sha256 &&
        existsSync(join(ex.runtime, "ms-playwright/chromium-1/chrome")) &&
        existsSync(
          join(ex.runtime, "ms-playwright/chromium_headless_shell-1/shell"),
        ) &&
        existsSync(join(ex.root, ".agtx/trees/t")) &&
        ex.env.PATH.startsWith(join(ex.runtime, "bin"));
      x.finishExecution(ex);
      return (
        ok &&
        journal.removed === true &&
        journal.runtime_removed === true &&
        !existsSync(ex.root) &&
        !existsSync(ex.runtime) &&
        x.journalUnchanged(journal) &&
        state(d) === before
      );
    },
  );
  check(
    "lifecycle: a change found by the final check is recorded and the journal is not unchanged; removal still happens",
    () => {
      const { d, c, journal, ex, files } = lifecycle();
      x.prepareExecution(ex, {
        source: d,
        files,
        browsers: ["chromium"],
        env: c.env,
      });
      chmodSync(join(ex.runtime, "bin"), 0o755);
      copyFileSync(
        join(ex.runtime, "bin/pnpm"),
        join(ex.runtime, "bin/pnpm.b"),
      );
      renameSync(join(ex.runtime, "bin/pnpm.b"), join(ex.runtime, "bin/pnpm"));
      x.finishExecution(ex);
      return (
        /private runtime changed at the end of the run/.test(
          journal.end_error ?? "",
        ) &&
        x.journalUnchanged(journal) === false &&
        journal.removed &&
        journal.runtime_removed
      );
    },
  );
  check(
    "lifecycle: a linked installation root is refused before anything is allocated",
    () => {
      const { d: other } = tree("linked-target");
      const d = s.make("linked");
      write(join(d, "package.json"), readFileSync(join(other, "package.json")));
      write(join(d, "src/x.js"), "export const x = 1;\n");
      symlinkSync(join(other, "node_modules"), join(d, "node_modules"));
      const c = fakeChain(s, { project: d });
      const before = state(other);
      const ex = x.newExecution({ journal: x.snapshotJournal(d, true) });
      const refused = throwsLike(
        () =>
          x.prepareExecution(ex, {
            source: d,
            files: filesOf(d),
            browsers: ["chromium"],
            env: c.env,
          }),
        /is a link/,
      );
      return (
        refused &&
        ex.root === null &&
        readdirSync(c.env.TMPDIR).length === 0 &&
        state(other) === before
      );
    },
  );
  check(
    "lifecycle: the judge's current target refuses a linked installation root the same way (nothing allocated)",
    () => {
      const { d: other } = tree("linked-target");
      const d = s.make("linked");
      write(join(d, "package.json"), readFileSync(join(other, "package.json")));
      write(join(d, "src/x.js"), "export const x = 1;\n");
      symlinkSync(join(other, "node_modules"), join(d, "node_modules"));
      const c = fakeChain(s, { project: d });
      const before = state(other);
      return (
        throwsLike(
          () =>
            a.collectSnapshotTarget({
              source: d,
              files: filesOf(d),
              browsers: ["chromium"],
              env: c.env,
            }),
          /is a link/,
        ) &&
        readdirSync(c.env.TMPDIR).length === 0 &&
        state(other) === before
      );
    },
  );
  check(
    "lifecycle: a write into the source installation during preparation is refused, naming it, and every allocation is removed",
    () => {
      const { d, c, journal, ex, files } = lifecycle();
      const refused = throwsLike(
        () =>
          x.prepareExecution(ex, {
            source: d,
            files,
            browsers: ["chromium"],
            env: c.env,
            barrier: (point) => {
              if (point === "runtime")
                writeFileSync(
                  join(d, STORE_C, "index.js"),
                  "module.exports = 'written';\n",
                );
            },
          }),
        /source installation changed while the snapshot was prepared: F \.pnpm\/c@1\.0\.0\/node_modules\/c\/index\.js/,
      );
      x.finishExecution(ex, { check: false });
      return (
        refused &&
        journal.removed &&
        journal.runtime_removed &&
        readdirSync(c.env.TMPDIR).length === 0
      );
    },
  );
  check(
    "lifecycle: the runtime changed before pnpm's preparation is refused by the guard, before pnpm runs",
    () => {
      const { d, c, journal, ex, files } = lifecycle();
      const refused = throwsLike(
        () =>
          x.prepareExecution(ex, {
            source: d,
            files,
            browsers: ["chromium"],
            env: c.env,
            barrier: (point) => {
              if (point === "runtime") {
                chmodSync(join(ex.runtime, "bin"), 0o755);
                copyFileSync(
                  join(ex.runtime, "bin/pnpm"),
                  join(ex.runtime, "bin/pnpm.b"),
                );
                renameSync(
                  join(ex.runtime, "bin/pnpm.b"),
                  join(ex.runtime, "bin/pnpm"),
                );
              }
            },
          }),
        /private runtime changed before pnpm's preparation/,
      );
      x.finishExecution(ex, { check: false });
      return refused && journal.prepared === false && journal.runtime_removed;
    },
  );
  check(
    "lifecycle: an unsupported launcher is refused before anything is allocated",
    () => {
      const { d, c, ex, files } = lifecycle();
      const wrapper = s.make("wrapper");
      write(join(wrapper, "pnpm"), '#!/bin/sh\nexec pnpm "$@"\n', 0o755);
      return (
        throwsLike(
          () =>
            x.prepareExecution(ex, {
              source: d,
              files,
              browsers: ["chromium"],
              env: { ...c.env, PATH: `${wrapper}:${c.env.PATH}` },
            }),
          /not a supported launcher/,
        ) &&
        ex.root === null &&
        readdirSync(c.env.TMPDIR).length === 0
      );
    },
  );
  check(
    "lifecycle: browsers are taken from the snapshot's own browsers.json, revision overrides included",
    () => {
      const d = s.make("bj");
      playwrightTree(d);
      const b = s.make("browsers");
      for (const n of ["webkit-3", "webkit-4", "firefox-2"])
        write(join(b, n, "x"), "x");
      const got = x
        .browserSources({ PLAYWRIGHT_BROWSERS_PATH: b, HOME: "/x" }, d, [
          "webkit",
          "firefox",
        ])
        .map((e) => e.name);
      return (
        JSON.stringify(got) ===
        JSON.stringify(["webkit-3", "webkit-4", "firefox-2"])
      );
    },
  );
  check(
    "lifecycle: a selected browser that is not installed is refused",
    () => {
      const d = s.make("bj");
      playwrightTree(d);
      return throwsLike(
        () =>
          x.browserSources(
            { PLAYWRIGHT_BROWSERS_PATH: s.make("empty"), HOME: "/x" },
            d,
            ["firefox"],
          ),
        /not installed/,
      );
    },
  );

  // Revision 29 (review r28 R28-N1; design assessment d3cff73e Q1, Q2, Q5, Q12): the execution policy through the shared lifecycle.
  const upstreamOf = (rel) =>
    readFileSync(join(UPSTREAM_PLAYWRIGHT, rel), "utf8");
  check(
    "policy: the adapter turns both upstream compilation caches into exactly their reviewed adapted files",
    () =>
      Object.entries(x.ADAPTED_FILES).every(([rel, want]) => {
        const text = upstreamOf(rel);
        return (
          sha(text) === want.upstream &&
          sha(x.adaptedText(text, rel)) === want.adapted
        );
      }),
  );
  check(
    "policy: the adapter refuses an unknown layout (an anchor missing or doubled)",
    () => {
      const text = upstreamOf("lib/common/index.js");
      const from = text.indexOf(
        "function _innerAddToCompilationCacheAndSerialize(",
      );
      const block = text.slice(from, text.indexOf("\n}\n", from) + 3);
      return (
        throwsLike(
          () => x.adaptedText(text.replace(block, "")),
          /occurs 0 times/,
        ) &&
        throwsLike(
          () => x.adaptedText(text.replace(block, block + block)),
          /occurs 2 times/,
        )
      );
    },
  );
  const preparedRun = (options = {}) => {
    const { d, c, journal, ex, files } = lifecycle();
    x.prepareExecution(ex, {
      source: d,
      files,
      browsers: ["chromium"],
      env: c.env,
      ...options,
    });
    return { d, c, journal, ex };
  };
  const pw = (root) =>
    join(root, "node_modules/.pnpm/playwright@1.0.0/node_modules/playwright");
  check(
    "policy: the shared preparation adapts the snapshot's Playwright (never the source's), records the policy and guards the generated directories empty",
    () => {
      const { d, journal, ex } = preparedRun();
      const ok =
        journal.policy?.id === x.EXECUTION_POLICY &&
        journal.policy?.sha256 === x.POLICY_SHA256 &&
        Object.keys(journal.policy?.playwright?.files ?? {}).length === 2 &&
        x.adaptationProblems(ex.root).length === 0 &&
        Object.entries(x.ADAPTED_FILES).every(
          ([rel, want]) =>
            sha(readFileSync(join(pw(d), rel))) === want.upstream &&
            sha(readFileSync(join(pw(ex.root), rel))) === want.adapted,
        ) &&
        x.GENERATED_TREES.every(
          (n) =>
            journal.trees[n]?.entries === 0 &&
            typeof journal.trees[n]?.self === "string",
        ) &&
        ex.env.NODE_DISABLE_COMPILE_CACHE === "1";
      x.finishExecution(ex);
      return ok && x.journalUnchanged(journal);
    },
  );
  check(
    "policy: a cache entry written into the Playwright cache directory after sealing is seen by the next check",
    () => {
      const { ex } = preparedRun();
      // A same-user writer: the directory is read only, so it gives itself write permission first.
      chmodSync(x.cacheDir(ex.root), 0o755);
      write(join(x.cacheDir(ex.root), "ab/entry.js"), "// x\n");
      const seen = throwsLike(
        () => ex.check("before Playwright"),
        /guarded tree generated \.agtx\/cache\/playwright changed before Playwright/,
      );
      x.finishExecution(ex, { check: false });
      return seen;
    },
  );
  check(
    "policy: a file created, read and deleted in a guarded-empty directory between two checks is seen (write/read/delete)",
    () => {
      const { ex } = preparedRun();
      const f = join(x.stateDir(ex.root), "transient.js");
      const read = (() => {
        try {
          writeFileSync(f, "refused?\n");
          return false;
        } catch (error) {
          return error.code === "EACCES";
        }
      })();
      // A same-user writer that restores everything it can: the mode, the bytes (none left) and the times.
      chmodSync(x.stateDir(ex.root), 0o755);
      writeFileSync(f, "module.exports = 1;\n");
      readFileSync(f);
      unlinkSync(f);
      chmodSync(x.stateDir(ex.root), 0o555);
      if (!read) return false;
      const seen = throwsLike(
        () => ex.check("before Playwright"),
        /its own directory .*pnpm was written/,
      );
      x.finishExecution(ex, { check: false });
      return seen;
    },
  );
  check(
    "policy: a tool cache that exists when the snapshot is sealed is refused (a generated config is not an input)",
    () => {
      const { d, c, journal, ex, files } = lifecycle();
      const refused = throwsLike(
        () =>
          x.prepareExecution(ex, {
            source: d,
            files,
            browsers: ["chromium"],
            env: c.env,
            barrier: (point) => {
              if (point === "runtime")
                mkdirSync(join(ex.root, "node_modules/.vite-temp"));
            },
          }),
        /node_modules\/\.vite-temp exists when the snapshot is sealed/,
      );
      x.finishExecution(ex, { check: false });
      return refused && journal.removed && journal.runtime_removed;
    },
  );
  check(
    "policy: another Playwright release, or an upstream file of other bytes, is refused before anything is written",
    () => {
      const at = (change) => {
        const { d, c, ex, files } = lifecycle();
        change(d);
        const refusal = (() => {
          try {
            x.prepareExecution(ex, {
              source: d,
              files,
              browsers: ["chromium"],
              env: c.env,
            });
            return null;
          } catch (error) {
            return String(error.message);
          }
        })();
        const untouched =
          ex.root === null ||
          sha(readFileSync(join(pw(ex.root), "lib/common/index.js"))) ===
            sha(readFileSync(join(pw(d), "lib/common/index.js")));
        x.finishExecution(ex, { check: false });
        return { refusal, untouched };
      };
      const release = at((d) =>
        writeFileSync(
          join(pw(d), "package.json"),
          JSON.stringify({ name: "playwright", version: "1.62.0" }),
        ),
      );
      const bytes = at((d) =>
        writeFileSync(
          join(pw(d), "lib/transform/esmLoader.js"),
          `${upstreamOf("lib/transform/esmLoader.js")}\n// changed\n`,
        ),
      );
      return (
        /is 1\.62\.0, not 1\.63\.0/.test(release.refusal ?? "") &&
        release.untouched &&
        /esmLoader\.js is not the known 1\.63\.0 upstream file/.test(
          bytes.refusal ?? "",
        )
      );
    },
  );
  check(
    "environment: only the policy's inherited names reach a child; executable-cache, loader and code-selecting settings never do",
    () => {
      const env = x.frozenEnv(
        {
          PATH: "/usr/bin",
          LANG: "en_GB.UTF-8",
          TZ: "Europe/London",
          TMPDIR: "/t",
          SHELL: "/bin/zsh",
          NODE_COMPILE_CACHE: "/t/node-compile-cache",
          NODE_EXTRA_CA_CERTS: "/t/ca.pem",
          NODE_USE_ENV_PROXY: "1",
          PW_TEST_SOURCE_TRANSFORM: "./transform.js",
          PW_TEST_SOURCE_TRANSFORM_SCOPE: "/s",
          PLAYWRIGHT_FORCE_ASYNC_LOADER: "1",
          VITE_FIXTURE: "1",
          JITI_FS_CACHE: "1",
          ESBUILD_BINARY_PATH: "/t/esbuild",
          NAPI_RS_NATIVE_LIBRARY_PATH: "/t/lib.node",
          ATLAS_E2E_WORKERS: "4",
        },
        "/rt",
        "/s",
      );
      const inherited = Object.keys(env).filter(
        (k) =>
          ![
            "PATH",
            "HOME",
            "XDG_CONFIG_HOME",
            "COREPACK_HOME",
            "COREPACK_ENABLE_NETWORK",
            "PLAYWRIGHT_BROWSERS_PATH",
            "PWTEST_CACHE_DIR",
            "PNPM_HOME",
            ...Object.keys(x.POLICY_ENV),
          ].includes(k),
      );
      return (
        JSON.stringify(inherited.sort()) ===
          JSON.stringify(["LANG", "TMPDIR", "TZ"]) &&
        env.NODE_DISABLE_COMPILE_CACHE === "1"
      );
    },
  );
  check(
    "config: a copied package-manager configuration file that selects code is refused before anything runs; an ordinary one is copied",
    () => {
      const d = s.make("cfg");
      playwrightTree(d);
      const c = fakeChain(s, { project: d });
      const chain = x.launcherChain(c.env, d);
      const rt = i.allocateSnapshot(s.make("parent"), "held-op-runtime-");
      write(join(c.home, ".npmrc"), "registry=https://registry.example/\n");
      const ordinary = x.createRuntime(rt, chain, c.env, []);
      const copied = existsSync(join(rt, "home/.npmrc"));
      i.removeSnapshot(rt);
      write(
        join(c.home, ".npmrc"),
        "registry=https://registry.example/\nnode-options=--require ./hook.cjs\n",
      );
      const rt2 = i.allocateSnapshot(s.make("parent"), "held-op-runtime-");
      const refused = throwsLike(
        () => x.createRuntime(rt2, chain, c.env, []),
        /sets node-options, which selects code/,
      );
      i.removeSnapshot(rt2);
      return (
        Boolean(ordinary) &&
        copied &&
        refused &&
        x.configProblems("scriptShell: /bin/bash\n").length === 1 &&
        x.configProblems("store-dir=/x\n# node-options=y\n").length === 0
      );
    },
  );
}
