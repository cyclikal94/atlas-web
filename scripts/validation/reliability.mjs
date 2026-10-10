// VR-20261007: qualification order and conservative, auditable pure-check reuse.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && !Array.isArray(v) && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const pureCommands = new Set(["typecheck", "lint", "check:contract"]);
export function qualify(plan) {
  if (plan.version !== 2)
    throw new Error(
      "VR-20261007 requires a version 2 plan: declare qualification.changed_files and targeted controls/cases/mutations before broad checks; see docs/validation-reliability.md",
    );
  const q = plan.qualification;
  if (
    !q ||
    !Array.isArray(q.changed_files) ||
    q.changed_files.some(
      (f) =>
        typeof f !== "string" ||
        !f ||
        isAbsolute(f) ||
        f.split("/").includes(".."),
    )
  )
    throw new Error(
      "qualification.changed_files must explicitly list changed test/fixture inputs",
    );
  if (
    !q.changed_files.length &&
    (typeof q.no_changes_reason !== "string" || !q.no_changes_reason.trim())
  )
    throw new Error("Explain why no tests/fixtures changed");
  if (q.changed_files.length) {
    for (const kind of ["control", "case", "mutation"]) {
      if (
        !plan.steps.some(
          (s) => s.stage === "qualification" && s.qualification_kind === kind,
        )
      )
        throw new Error(`Missing early ${kind} qualification`);
    }
  }
  for (const step of plan.steps) {
    if (
      step.after !== undefined &&
      (!Array.isArray(step.after) ||
        step.after.some(
          (id) => !plan.steps.some((s) => s.id === id) || id === step.id,
        ))
    )
      throw new Error(`Invalid dependencies: ${step.id}`);
    if (
      step.stage === "qualification" &&
      !["control", "case", "mutation", "stability"].includes(
        step.qualification_kind,
      )
    )
      throw new Error("Qualification steps must name their purpose");
    if (
      step.reuse &&
      (step.stage !== "focused" ||
        step.reuse.kind !== "pure" ||
        !step.reuse.basis?.trim() ||
        !Array.isArray(step.reuse.runtime_files) ||
        !Array.isArray(step.reuse.artifacts))
    )
      throw new Error(
        "Reuse is explicit and limited to pure focused checks with runtime files and artefacts",
      );
    if (
      step.reuse &&
      !(
        step.argv[0] === "pnpm" &&
        step.argv.length === 2 &&
        pureCommands.has(step.argv[1])
      )
    )
      throw new Error(
        "Only audited static checks (typecheck, lint, check:contract) support reuse; all test, browser, mutation, integration, repeat and profiling checks must run",
      );
  }
}
export function ordered(plan) {
  const result = [];
  for (const stage of [
    "preflight",
    "qualification",
    "focused",
    "final",
    "profiling",
  ]) {
    const pending = plan.steps.filter((s) => s.stage === stage);
    while (pending.length) {
      const at = pending.findIndex((s) =>
        (s.after ?? []).every((id) => result.some((x) => x.id === id)),
      );
      if (at < 0) throw new Error("Cyclic or backwards stage dependencies");
      result.push(pending.splice(at, 1)[0]);
    }
  }
  return result;
}
function safeFile(root, name) {
  if (
    typeof name !== "string" ||
    !name ||
    isAbsolute(name) ||
    name.split(/[\\/]/).includes("..")
  )
    throw new Error("Evidence/runtime paths must stay inside the checkout");
  const path = resolve(root, name);
  const actual = realpathSync(path),
    rel = relative(realpathSync(root), actual);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    !lstatSync(actual).isFile()
  )
    throw new Error("External or non-file evidence/runtime input");
  return path;
}
function files(root, names) {
  return Object.fromEntries(
    [...new Set(names)]
      .sort()
      .map((name) => [name, hash(readFileSync(safeFile(root, name)))]),
  );
}
function executable(name, environment) {
  for (const parent of (environment.PATH ?? "").split(":").filter(Boolean)) {
    const file = join(parent, name);
    if (existsSync(file)) return realpathSync(file);
  }
  throw new Error(`Missing executable provenance: ${name}`);
}
function tree(root) {
  const result = {};
  const seen = new Set();
  function visit(path, name) {
    if (lstatSync(path).isSymbolicLink())
      result[`${name}/@symlink`] = readlinkSync(path);
    const actual = realpathSync(path);
    if (
      !actual.startsWith(realpathSync(root) + sep) &&
      actual !== realpathSync(root)
    )
      throw new Error("External dependency link needs fresh execution");
    const stat = lstatSync(actual);
    if (stat.isFile()) result[name] = hash(readFileSync(actual));
    else if (stat.isDirectory() && !seen.has(actual)) {
      seen.add(actual);
      for (const child of readdirSync(actual).sort())
        visit(join(actual, child), `${name}/${child}`);
    }
  }
  visit(root, ".");
  return hash(stable(result));
}
function toolchain(environment, root) {
  const node = executable("node", environment);
  const pnpm = executable("pnpm", environment);
  let packageRoot = dirname(pnpm);
  while (!existsSync(join(packageRoot, "package.json"))) {
    const parent = dirname(packageRoot);
    if (parent === packageRoot)
      throw new Error("Unknown pnpm installation; fresh execution required");
    packageRoot = parent;
  }
  const locator = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  let payload = null;
  if (locator.name === "corepack") {
    if (
      environment.COREPACK_ENABLE_PROJECT_SPEC === "0" ||
      environment.COREPACK_ENABLE_STRICT === "0" ||
      environment.LOCALAPPDATA
    )
      throw new Error(
        "Non-default Corepack resolution requires fresh execution",
      );
    const requested = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ).packageManager;
    const match = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)(?:\+.*)?$/.exec(
      requested ?? "",
    );
    if (!match)
      throw new Error("An exact pnpm packageManager pin is required for reuse");
    const home =
      environment.COREPACK_HOME ??
      join(
        environment.XDG_CACHE_HOME ??
          join(environment.HOME ?? os.homedir(), ".cache"),
        "node/corepack",
      );
    const directory = join(home, "v1/pnpm", match[1]);
    if (
      JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
        .version !== match[1]
    )
      throw new Error("Corepack payload pin differs");
    payload = tree(directory);
  }
  return {
    node: hash(readFileSync(node)),
    pnpm: hash(readFileSync(pnpm)),
    packages: tree(packageRoot),
    payload,
  };
}
export class EvidenceCache {
  constructor(root, directory, source, environment = process.env) {
    this.root = root;
    this.directory = directory;
    this.source = source;
    this.environment = environment;
    mkdirSync(directory, { recursive: true });
  }
  identity(step) {
    if (!step.reuse) return null;
    // No dependency/fixture affectedness guesses: the ENTIRE source inventory must match.
    // Installed package provenance and declared ignored runtime inputs must also match.
    const runtime = files(this.root, [
      "pnpm-lock.yaml",
      "node_modules/.modules.yaml",
      ...step.reuse.runtime_files,
    ]);
    const environment = { ...this.environment, ...step.env };
    const dependencies = tree(join(this.root, "node_modules"));
    const tools = toolchain(environment, this.root);
    return hash(
      stable({
        source: this.source,
        argv: step.argv,
        env: environment,
        runtime,
        dependencies,
        tools,
        executable: hash(readFileSync(process.execPath)),
        host: os.hostname(),
        release: os.release(),
        metadata: {
          ...step,
          id: undefined,
          requirement: undefined,
          after: undefined,
        },
        tool: hash(readFileSync(new URL(import.meta.url))),
      }),
    );
  }
  load(key) {
    if (!key) return null;
    try {
      const value = JSON.parse(
        readFileSync(join(this.directory, `${key}.json`), "utf8"),
      );
      if (
        value.key !== key ||
        value.status !== "passed" ||
        !value.files ||
        !Object.keys(value.files).length
      )
        return null;
      if (
        stable(files(this.root, Object.keys(value.files))) !==
        stable(value.files)
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }
  save(key, step, record, log) {
    if (!key) return;
    // A later failure poisons an earlier success; it cannot be hidden by a cache hit.
    const value = {
      key,
      status: record.status,
      origin: relative(this.root, log),
      at: new Date().toISOString(),
      record,
      files: files(this.root, [
        relative(this.root, log),
        ...step.reuse.artifacts,
      ]),
    };
    const destination = join(this.directory, `${key}.json`),
      temporary = `${destination}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(temporary, destination);
  }
}
