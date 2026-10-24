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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
export function stubProbe(tree, browsersDir, change) {
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
      exec_path: process.execPath,
      platform: process.platform,
      arch: process.arch,
      user_agent: "pnpm/12.4.2 npm/? node/? darwin arm64",
      parent_exec_path: process.execPath,
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
        chromium: join(browsersDir, "chromium-1/chrome"),
      },
    };
    change?.(child);
    return child;
  };
}
/** The environment a collection over a pnpm tree uses: a private PATH with a `pnpm`, a private HOME without configuration. */
function collectionEnv(s) {
  const bin = s.make("bin");
  write(join(bin, "pnpm"), "#!/bin/sh\nexit 0\n", 0o755);
  const home = s.make("home");
  return { PATH: bin, HOME: home, LANG: "en_GB.UTF-8" };
}
function browsersAt(s) {
  const b = s.make("browsers");
  write(join(b, "chromium-1/chrome"), "chrome");
  write(join(b, "chromium_headless_shell-1/shell"), "shell");
  return b;
}

/** Every check (design assessment Q1/Q3/Q4 cells); `i` the installation module, `a` the applicability module, `q` the evaluator. */
export function installationAssessments(i, a, q, check) {
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
        s.make("b"),
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
    const collect = (
      d,
      change,
      env = collectionEnv(s),
      b = browsersAt(s),
      source = null,
    ) => {
      const origin = join(d, ".agtx/trees/run");
      mkdirSync(origin, { recursive: true });
      return a.collectApplicability({
        root: d,
        source,
        origins: [origin],
        browsers: ["chromium"],
        env,
        probe: stubProbe(d, b, (c) => {
          c.parent_exec_path = join(env.PATH, "pnpm");
          change?.(c);
        }),
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
          collect(d, undefined, collectionEnv(s), browsersAt(s), live);
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
          r.installation.schema === i.INSTALLATION_SCHEMA &&
          r.installation.sha256 === digest(d) &&
          r.installation.entries > 0 &&
          r.installation.dependencies === 3 &&
          Object.values(r.config).every((v) => v === "none")
        );
      },
    );
    check(
      "collector: two collections of the same tree are applicable to each other",
      () => {
        const { d } = fresh();
        const env = collectionEnv(s);
        const b = browsersAt(s);
        return (
          a.compareApplicability(
            collect(d, undefined, env, b),
            collect(d, undefined, env, b),
          ).decision === "applicable"
        );
      },
    );
    check(
      "collector: review r26's counterexample: a changed installed entry with the same four package trees is incompatible",
      () => {
        const { d } = fresh();
        const env = collectionEnv(s);
        const b = browsersAt(s);
        const was = collect(d, undefined, env, b);
        write(
          join(
            d,
            "node_modules/.pnpm/react@19.3.0/node_modules/react/index.js",
          ),
          "throw new Error('REVIEW_INSTALLED_REACT_CHANGED');\n",
        );
        const now = collect(d, undefined, env, b);
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
        const env = collectionEnv(s);
        const b = browsersAt(s);
        const [x1, x2] = ["one", "two"].map((label) => {
          const x = i.allocateSnapshot(s.make(label));
          i.createSnapshot({ root: d, files, dir: x });
          i.relocate(x, d);
          return x;
        });
        const one = collect(x1, undefined, env, b, d);
        const two = collect(x2, undefined, env, b, d);
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
        const env = collectionEnv(s);
        const b = browsersAt(s);
        const was = collect(d, undefined, env, b);
        write(join(d, STORE_A, "lib.js"), "1");
        const now = collect(d, undefined, env, b);
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
        const env = collectionEnv(s);
        const b = browsersAt(s);
        const one = collect(d, undefined, env, b);
        write(join(env.HOME, ".npmrc"), "node-linker=hoisted\n");
        const two = collect(d, undefined, env, b);
        const c = a.compareApplicability(two, one);
        return (
          c.differences.length === 1 &&
          c.differences[0].field === "config.npmrc_user"
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
    check(
      "seal: an untouched sealed snapshot verifies, and its caches stay writable",
      () => {
        const { x, baseline } = sealed();
        write(
          join(x, "node_modules/.vite-temp/config.mjs"),
          "export default {}",
        );
        return (
          i.verifySealed(x, baseline, "unchanged").sha256 === baseline.sha256
        );
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
    const record = { installation: { sha256: "a".repeat(64), root: "/t/x" } };
    const good = {
      schema: i.SNAPSHOT_SCHEMA,
      root: "/t/x",
      sealed_sha256: "b".repeat(64),
      installation_sha256: "a".repeat(64),
      checks: [{ when: "before the build", sha256: "b".repeat(64) }],
      end_sha256: "b".repeat(64),
      unchanged: true,
      removed: true,
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
        x.checks.push({ when: "before Playwright", sha256: "c".repeat(64) });
      }).some((p) => p.includes("before Playwright")),
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
  } finally {
    s.done();
  }
}
