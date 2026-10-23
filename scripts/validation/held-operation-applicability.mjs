// WEB-08d revision 26 (review r25 R25-N1; design assessment 26f1a626, invariants I1-I6, correction steps 1-4): the RUNTIME applicability of
// held-operation evidence. Revision 25 bound a bundle to its exact bytes, execution and source, but the source digest (runtime.mjs
// `fingerprint().sha256`) covers source-file bytes only: the Node that ran the controller and Playwright, the pnpm that launched them, the
// installed Playwright and Vite and the browser installations are separate facts. A split-stage consumer under another Node admitted the
// genuine controls of a Node 22 run because nothing compared them (review r25: v25.8.2 against v22.23.2, both controls `verified`, the
// build reached).
//
// This module keeps that dimension apart from the source digest (whose meaning other runners rely on) as a versioned RECORD:
//  - controller: the Node running the runner (version, the executable's bytes, platform, architecture, the host OS);
//  - launcher: the `pnpm` the runner's environment resolves first on PATH, by its bytes;
//  - child: what the build and Playwright actually run under, reported by a probe launched exactly as they are (`pnpm exec node`, same
//    environment): its Node (version and bytes), platform, architecture, pnpm's user agent, the pnpm executable that launched it (bytes
//    and its installed package tree) and Corepack's tree when Corepack is in the chain;
//  - packages: @playwright/test, playwright, playwright-core (the chain the test runner follows) and vite, each its version and the digest
//    of its INSTALLED tree (a version or a lockfile alone is not evidence of installed bytes);
//  - installation: pnpm's own records of what is installed (node_modules/.modules.yaml and node_modules/.pnpm/lock.yaml), by digest;
//  - browsers: per selected engine, the installation directories Playwright launches (Chromium's full build and its headless shell), each
//    by the digest of its whole tree;
//  - env: the behavioural environment (Node, Playwright, pnpm/Corepack and colour/locale settings); locations (evidence and output paths,
//    ports, TMPDIR, HOME, PATH itself, which the resolved tools stand for) are not behaviour and are left out by name.
// Executable and package LOCATIONS are kept and reported, never compared: the same bytes at another path are the same runtime.
//
// compareApplicability(target, record) returns `applicable` only when every required field of both is present, well formed and equal;
// `incompatible` names each differing field; `unknown` names each missing, malformed or unsupported one (two unknowns are never equal).
// There is no equivalence relation: a different supported Node patch is a different runtime here. Collection that fails is a refusal,
// never a fabricated identity.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APPLICABILITY_SCHEMA = "web08d-held-operation-applicability/1";
export const COMPARISON_VERSION =
  "web08d-held-operation-applicability-comparison/1";
export const PACKAGES = [
  "@playwright/test",
  "playwright",
  "playwright-core",
  "vite",
];
/** Behavioural environment: these names, and every name with one of these prefixes, except the locations and selections below. */
export const ENV_NAMES = [
  "CI",
  "DEBUG",
  "FORCE_COLOR",
  "NO_COLOR",
  "COLORTERM",
  "TERM",
  "TZ",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
];
export const ENV_PREFIXES = [
  "NODE_",
  "PLAYWRIGHT_",
  "PW_",
  "COREPACK_",
  "PNPM_",
  "npm_config_",
  "ATLAS_E2E_",
  "ATLAS_PROBE_",
];
/** Locations (where output goes) and the runner's own per-part selection (recorded in each execution record): never behaviour here. */
export const NOT_BEHAVIOUR_ENV = [
  "PLAYWRIGHT_JSON_OUTPUT_FILE",
  "PLAYWRIGHT_JSON_OUTPUT_NAME",
  "PLAYWRIGHT_JSON_OUTPUT_DIR",
  "PLAYWRIGHT_HTML_OUTPUT_DIR",
  "PLAYWRIGHT_HTML_REPORT",
  "ATLAS_E2E_PROBES",
  "ATLAS_E2E_BROWSERS",
  "ATLAS_PROBE_FAULT",
  "ATLAS_PROBE_FAULT_IDS",
];
const ENGINES = ["chromium", "firefox", "webkit"];
const DIGEST = /^[0-9a-f]{64}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
const BROWSER_DIR = /^[a-z][a-z_]*-\d+$/;
const PROBE = join(
  dirname(fileURLToPath(import.meta.url)),
  "held-operation-runtime-probe.cjs",
);

/** Every compared field: its dotted path in the record and the shape a known value has. */
export const FIELDS = [
  ["controller.node", "version"],
  ["controller.exec_sha256", "digest"],
  ["controller.platform", "word"],
  ["controller.arch", "word"],
  ["controller.os_type", "word"],
  ["controller.os_release", "word"],
  ["controller.os_version", "word"],
  ["launcher.pnpm_sha256", "digest"],
  ["child.node", "version"],
  ["child.exec_sha256", "digest"],
  ["child.platform", "word"],
  ["child.arch", "word"],
  ["child.user_agent", "word"],
  ["child.pnpm_sha256", "digest"],
  ["child.pnpm_tree_sha256", "digest"],
  ["child.corepack_tree_sha256", "digest-or-none"],
  ["installation.modules_yaml_sha256", "digest"],
  ["installation.lock_yaml_sha256", "digest"],
  ...PACKAGES.flatMap((p) => [
    [`packages.${p}.version`, "word"],
    [`packages.${p}.tree_sha256`, "digest"],
  ]),
];
/** Locations: reported when they differ, never compared. */
export const LOCATIONS = [
  "controller.exec_path",
  "launcher.pnpm_path",
  "launcher.pnpm_realpath",
  "child.exec_path",
  "child.pnpm_path",
  "child.corepack_root",
  ...PACKAGES.map((p) => `packages.${p}.dir`),
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const at = (record, path) => {
  let v = record;
  for (const key of path.split(".")) {
    if (!object(v) || !Object.hasOwn(v, key)) return undefined;
    v = v[key];
  }
  return v;
};
const RULES = {
  version: (v) => typeof v === "string" && VERSION.test(v),
  digest: (v) => typeof v === "string" && DIGEST.test(v),
  "digest-or-none": (v) =>
    v === "none" || (typeof v === "string" && DIGEST.test(v)),
  word: (v) => typeof v === "string" && v.trim() !== "" && v !== "unknown",
};

/** The record's bytes as written: keys sorted at every level, so the same identity has the same bytes. */
export function canonical(value) {
  const sort = (v) =>
    Array.isArray(v)
      ? v.map(sort)
      : object(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** The digest of a directory tree: every entry by relative path, a file by its bytes' digest, a link by its target, sorted. */
export function treeDigest(root) {
  const h = createHash("sha256");
  const walk = (dir, rel) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const e of entries) {
      const full = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) h.update(`L ${r} ${readlinkSync(full)}\n`);
      else if (e.isDirectory()) {
        h.update(`D ${r}\n`);
        walk(full, r);
      } else if (e.isFile()) h.update(`F ${r} ${sha256(readFileSync(full))}\n`);
      else h.update(`O ${r}\n`);
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/** The first executable `name` on the environment's PATH, as spawn resolves it, with the bytes it really is. */
export function resolveOnPath(name, env) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const real = realpathSync(candidate);
    return {
      path: candidate,
      realpath: real,
      sha256: sha256(readFileSync(real)),
    };
  }
  throw new Error(`no executable ${name} on PATH`);
}

/** The behavioural environment, by name; locations and the runner's selections are left out. */
export function behaviouralEnv(env) {
  return Object.fromEntries(
    Object.keys(env)
      .filter(
        (k) =>
          !NOT_BEHAVIOUR_ENV.includes(k) &&
          (ENV_NAMES.includes(k) || ENV_PREFIXES.some((p) => k.startsWith(p))),
      )
      .sort()
      .map((k) => [k, String(env[k])]),
  );
}

/** The installation directory of a browser executable under Playwright's registry (`chromium-1243`, `webkit-2359`, ...). */
function browserDirectory(executable) {
  let d = dirname(executable);
  while (d !== dirname(d) && !BROWSER_DIR.test(basename(d))) d = dirname(d);
  if (!BROWSER_DIR.test(basename(d)))
    throw new Error(`${executable} is not inside a browser installation`);
  return d;
}

/** The package root holding `file` (the nearest directory with a package.json, at most four levels up), or its directory. */
function packageRoot(file) {
  let d = dirname(file);
  for (let i = 0; i < 4; i++, d = dirname(d))
    if (existsSync(join(d, "package.json"))) return d;
  return dirname(file);
}

/** Runs the child probe exactly as the runner runs its children (`pnpm exec`, this environment, the worktree as cwd). */
export function runChildProbe({ root, browsers, env }) {
  const dir = mkdtempSync(join(env.TMPDIR ?? os.tmpdir(), "held-op-runtime-"));
  const out = join(dir, "child.json");
  try {
    const r = spawnSync(
      "pnpm",
      ["exec", "node", PROBE, out, root, browsers.join(",")],
      { cwd: root, env, encoding: "utf8", timeout: 120_000 },
    );
    if (r.error) throw r.error;
    if (r.status !== 0)
      throw new Error(
        `the runtime probe exited ${r.status ?? r.signal}: ${`${r.stderr}${r.stdout}`.slice(-600)}`,
      );
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Collects the applicability record of a run that will use `browsers` from `root` with environment `env` (design assessment step 2).
 * `probe` is a seam for the unit tests; the runner always uses the real child probe. Throws when anything cannot be established.
 */
export function collectApplicability({
  root,
  browsers,
  env = process.env,
  probe = runChildProbe,
  controller = process,
}) {
  if (
    !Array.isArray(browsers) ||
    !browsers.length ||
    browsers.some((b) => !ENGINES.includes(b))
  )
    throw new Error(`unknown engines ${JSON.stringify(browsers)}`);
  const exec = realpathSync(controller.execPath);
  const launcher = resolveOnPath("pnpm", env);
  const child = probe({ root: resolve(root), browsers, env });
  if (!child?.parent_exec_path)
    throw new Error(
      "the runtime probe could not name the pnpm that launched it",
    );
  const childExec = realpathSync(child.exec_path);
  const pnpm = realpathSync(child.parent_exec_path);
  const corepack = child.corepack_root
    ? realpathSync(child.corepack_root)
    : null;
  const packages = {};
  for (const name of PACKAGES) {
    const p = child.packages?.[name];
    if (!p?.dir || !p.version)
      throw new Error(`the runtime probe could not resolve ${name}`);
    packages[name] = {
      version: String(p.version),
      dir: p.dir,
      tree_sha256: treeDigest(p.dir),
    };
  }
  const installed = {};
  for (const engine of browsers) {
    const executable = child.browsers?.[engine];
    if (typeof executable !== "string" || !existsSync(executable))
      throw new Error(`${engine} is not installed (${executable})`);
    const dir = browserDirectory(executable);
    const dirs = [dir];
    if (engine === "chromium") {
      const shell = join(
        dirname(dir),
        `chromium_headless_shell-${basename(dir).split("-").at(-1)}`,
      );
      if (!existsSync(shell))
        throw new Error(
          `Chromium's headless shell is not installed (${shell})`,
        );
      dirs.push(shell);
    }
    installed[engine] = {
      executable,
      directories: Object.fromEntries(
        dirs.map((d) => [basename(d), treeDigest(d)]),
      ),
    };
  }
  return {
    schema: APPLICABILITY_SCHEMA,
    controller: {
      node: controller.version,
      exec_path: exec,
      exec_sha256: sha256(readFileSync(exec)),
      platform: controller.platform,
      arch: controller.arch,
      os_type: os.type(),
      os_release: os.release(),
      os_version: os.version(),
    },
    launcher: {
      pnpm_path: launcher.path,
      pnpm_realpath: launcher.realpath,
      pnpm_sha256: launcher.sha256,
    },
    child: {
      node: child.node,
      exec_path: child.exec_path,
      exec_sha256: sha256(readFileSync(childExec)),
      platform: child.platform,
      arch: child.arch,
      user_agent: child.user_agent ?? "none",
      pnpm_path: pnpm,
      pnpm_sha256: sha256(readFileSync(pnpm)),
      pnpm_tree_sha256: treeDigest(packageRoot(pnpm)),
      corepack_root: corepack ?? "none",
      corepack_tree_sha256: corepack ? treeDigest(corepack) : "none",
    },
    packages,
    installation: {
      modules_yaml_sha256: sha256(
        readFileSync(join(root, "node_modules/.modules.yaml")),
      ),
      lock_yaml_sha256: sha256(
        readFileSync(join(root, "node_modules/.pnpm/lock.yaml")),
      ),
    },
    browsers: installed,
    env: behaviouralEnv(env),
  };
}

/** Why one side's browsers or environment cannot be compared (null when it can). */
function browsersProblem(b) {
  if (!object(b) || !Object.keys(b).length) return "no browser installations";
  for (const [engine, v] of Object.entries(b)) {
    if (!ENGINES.includes(engine)) return `an unknown engine ${engine}`;
    const dirs = v?.directories;
    if (!object(dirs) || !Object.keys(dirs).length)
      return `${engine} names no installation`;
    for (const [name, digest] of Object.entries(dirs))
      if (!BROWSER_DIR.test(name) || !RULES.digest(digest))
        return `${engine}'s installation ${name} has no digest`;
  }
  return null;
}
function envProblem(e) {
  if (!object(e)) return "no behavioural environment";
  for (const [k, v] of Object.entries(e))
    if (typeof v !== "string") return `${k} is not a string`;
  return null;
}

/**
 * Compares a consuming target with a recorded applicability (design assessment step 3): field by field, never record-to-itself. Returns
 * the decision with every differing field (`differences`), every field that is missing, malformed or of an unsupported schema
 * (`unknown`, with the side it is on) and the locations that differ (`locations`, informational). Only `applicable` admits.
 */
export function compareApplicability(target, record) {
  const out = {
    comparison: COMPARISON_VERSION,
    decision: "applicable",
    differences: [],
    unknown: [],
    locations: [],
  };
  const sides = [
    ["target", target],
    ["record", record],
  ];
  for (const [side, r] of sides)
    if (!object(r) || r.schema !== APPLICABILITY_SCHEMA)
      out.unknown.push({
        field: "schema",
        side,
        why: object(r)
          ? `schema ${JSON.stringify(r.schema)}, not ${APPLICABILITY_SCHEMA}`
          : "no applicability record",
      });
  if (!out.unknown.length) {
    for (const [field, rule] of FIELDS) {
      const a = at(target, field);
      const b = at(record, field);
      const okA = RULES[rule](a);
      const okB = RULES[rule](b);
      if (!okA)
        out.unknown.push({
          field,
          side: "target",
          why: `${JSON.stringify(a)} is not a ${rule}`,
        });
      if (!okB)
        out.unknown.push({
          field,
          side: "record",
          why: `${JSON.stringify(b)} is not a ${rule}`,
        });
      if (okA && okB && a !== b)
        out.differences.push({ field, target: a, record: b });
    }
    for (const field of LOCATIONS) {
      const a = at(target, field);
      const b = at(record, field);
      if (a !== b)
        out.locations.push({ field, target: a ?? null, record: b ?? null });
    }
    const bt = browsersProblem(target.browsers);
    const br = browsersProblem(record.browsers);
    if (bt) out.unknown.push({ field: "browsers", side: "target", why: bt });
    if (br) out.unknown.push({ field: "browsers", side: "record", why: br });
    if (!bt && !br)
      for (const engine of new Set([
        ...Object.keys(target.browsers),
        ...Object.keys(record.browsers),
      ])) {
        const a = target.browsers[engine]?.directories;
        const b = record.browsers[engine]?.directories;
        if (!a || !b) {
          out.differences.push({
            field: `browsers.${engine}`,
            target: a ? "installed" : "not selected",
            record: b ? "installed" : "not selected",
          });
          continue;
        }
        for (const name of new Set([...Object.keys(a), ...Object.keys(b)]))
          if (a[name] !== b[name])
            out.differences.push({
              field: `browsers.${engine}.directories.${name}`,
              target: a[name] ?? null,
              record: b[name] ?? null,
            });
      }
    const et = envProblem(target.env);
    const er = envProblem(record.env);
    if (et) out.unknown.push({ field: "env", side: "target", why: et });
    if (er) out.unknown.push({ field: "env", side: "record", why: er });
    if (!et && !er)
      for (const k of new Set([
        ...Object.keys(target.env),
        ...Object.keys(record.env),
      ]))
        if (target.env[k] !== record.env[k])
          out.differences.push({
            field: `env.${k}`,
            target: target.env[k] ?? null,
            record: record.env[k] ?? null,
          });
  }
  out.decision = out.differences.length
    ? "incompatible"
    : out.unknown.length
      ? "unknown"
      : "applicable";
  return out;
}

/** One line per reason a comparison does not admit (empty when it is `applicable`). */
export function applicabilityReasons(c) {
  if (!c || typeof c !== "object") return ["no applicability decision"];
  return [
    ...(c.differences ?? []).map(
      (d) =>
        `${d.field} differs: ${JSON.stringify(d.record)} recorded, ${JSON.stringify(d.target)} here`,
    ),
    ...(c.unknown ?? []).map(
      (u) => `${u.field} is unknown (${u.side}): ${u.why}`,
    ),
    ...(c.decision === "applicable" ||
    (c.differences ?? []).length ||
    (c.unknown ?? []).length
      ? []
      : [`decision ${c.decision}`]),
  ];
}

/** The witness of the runtime a Playwright run reports in its own metadata (tests/e2e/evidence-run.ts runtimeWitness), against a record. */
export function witnessProblems(witness, record) {
  if (!object(witness)) return ["the report records no runtime witness"];
  const problems = [];
  for (const [key, field] of [
    ["node", "child.node"],
    ["exec_path", "child.exec_path"],
    ["platform", "child.platform"],
    ["arch", "child.arch"],
    ["playwright", "packages.@playwright/test.version"],
  ]) {
    const want = at(record, field);
    if (want === undefined) continue;
    if (witness[key] !== want)
      problems.push(
        `the report's runtime witness has ${key} ${JSON.stringify(witness[key])}, but the record's ${field} is ${JSON.stringify(want)}`,
      );
  }
  return problems;
}
