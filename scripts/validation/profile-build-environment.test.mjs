// The profiling tooling leaves the build environment as its caller gave it (WEB-09c revision 7; review 7 R8, family
// profiling-build-environment). Importing the evidence contract loads the production page reader, whose Vite module runner used to set an
// unset NODE_ENV to `development` on the process; the driver's `pnpm build` and `build:fixture` inherited it and built the development
// application (Air request profile-20261012-195422-1b32a3d1 failed both bundle budgets). Every case starts a child process with a chosen
// environment: the public import chains, the driver's two build paths (the bundle stage and the fixture stage without it) with a recording
// `pnpm` on PATH, and the bundle stage's real builds and budget checks from an environment without NODE_ENV. `ATLAS_TOOLING_ROOT` points
// them at another copy of the repository (the qualification runner's mutated copies); by default they are this repository's own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(
  process.env.ATLAS_TOOLING_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-profile-build-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** This process's environment with NODE_ENV absent, or set to `nodeEnv`, plus `extra`: exactly what the child is given. */
const environment = (nodeEnv, extra = {}) => {
  const env = { ...process.env, ...extra };
  delete env.NODE_ENV;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  return env;
};
const run = (args, env, timeout = 180_000) =>
  spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });

// ---- the public import chains ----
// Every module the driver and the validator import that reaches the production page reader, imported in one child; it reports its whole
// environment before and after.
const IMPORTED = [
  "scripts/lib/production-page-reader.mjs",
  "scripts/lib/profile-w2-capture.mjs",
  "scripts/lib/profile-contract.mjs",
  "scripts/lib/profile-device-results.mjs",
  "scripts/lib/profile-evidence.mjs",
  "scripts/lib/profile-projection.mjs",
  "scripts/lib/profile-source-facts.mjs",
];
const afterImport = (env) => {
  const imports = IMPORTED.map(
    (rel) =>
      `await import(${JSON.stringify(pathToFileURL(join(root, rel)).href)});`,
  ).join("\n");
  const child = run(
    [
      "--input-type=module",
      "-e",
      `const before = { ...process.env };\n${imports}\nconsole.log(JSON.stringify({ before, after: { ...process.env } }));`,
    ],
    env,
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split("\n").at(-1));
};

test("case: importing the evidence contract, the projection and the reader leaves an environment without NODE_ENV exactly as it was", () => {
  const { before, after } = afterImport(environment(undefined));
  assert.equal(Object.hasOwn(before, "NODE_ENV"), false);
  assert.equal(
    Object.hasOwn(after, "NODE_ENV"),
    false,
    `NODE_ENV became ${after.NODE_ENV}`,
  );
  assert.deepEqual(after, before);
});

for (const nodeEnv of ["production", "development", "test"])
  test(`case: importing them keeps a NODE_ENV the caller supplied (${nodeEnv}) and every other variable`, () => {
    const { before, after } = afterImport(environment(nodeEnv));
    assert.equal(before.NODE_ENV, nodeEnv);
    assert.equal(after.NODE_ENV, nodeEnv);
    assert.deepEqual(after, before);
  });

// ---- the driver's two build paths, with a recording pnpm ----
// A `pnpm` first on PATH that records the arguments and the whole environment it was given, succeeds for `build` and fails for
// `build:fixture`, so the driver stops right after its last build in either path (nothing is built, no browser stage runs).
const recordingPnpm = (dir) => {
  const bin = join(dir, "bin");
  const log = join(dir, "pnpm.jsonl");
  const pnpm = join(bin, "pnpm");
  mkdirSync(bin);
  writeFileSync(
    pnpm,
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + "\\n");
process.exit(process.argv[2] === "build:fixture" ? 1 : 0);
`,
  );
  chmodSync(pnpm, 0o755);
  return { bin, log };
};
const driverBuilds = (t, { stage, nodeEnv }) => {
  const dir = scratch(t);
  const { bin, log } = recordingPnpm(dir);
  const env = environment(nodeEnv, {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
  });
  const evidence = join(dir, "evidence");
  const driver = run(
    [
      join(root, "scripts/profile-sync.mjs"),
      "--evidence",
      evidence,
      "--only",
      stage,
    ],
    env,
  );
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { driver, calls, env, evidence };
};

test("case: the bundle stage gives both builds the caller's environment when it has no NODE_ENV", (t) => {
  const { driver, calls, env, evidence } = driverBuilds(t, { stage: "bundle" });
  assert.equal(driver.status, 1, `${driver.stdout}${driver.stderr}`);
  assert.deepEqual(
    calls.map((c) => c.args),
    [["build"], ["build:fixture"]],
    `${driver.stdout}${driver.stderr}`,
  );
  for (const call of calls) {
    assert.equal(
      Object.hasOwn(call.env, "NODE_ENV"),
      false,
      `pnpm ${call.args[0]} was given NODE_ENV=${call.env.NODE_ENV}`,
    );
    assert.deepEqual(call.env, env);
  }
  const record = JSON.parse(
    readFileSync(join(evidence, "bundle/build-production.json"), "utf8"),
  );
  assert.equal(record.node_env, null);
});

test("case: the fixture stage without the bundle stage gives its build the caller's environment when it has no NODE_ENV", (t) => {
  const { driver, calls, env } = driverBuilds(t, { stage: "fixture" });
  assert.equal(driver.status, 1, `${driver.stdout}${driver.stderr}`);
  assert.deepEqual(
    calls.map((c) => c.args),
    [["build:fixture"]],
    `${driver.stdout}${driver.stderr}`,
  );
  assert.equal(
    Object.hasOwn(calls[0].env, "NODE_ENV"),
    false,
    `pnpm build:fixture was given NODE_ENV=${calls[0].env.NODE_ENV}`,
  );
  assert.deepEqual(calls[0].env, env);
});

for (const [stage, nodeEnv] of [
  ["bundle", "production"],
  ["fixture", "development"],
])
  test(`case: the ${stage} stage gives its builds a NODE_ENV the caller supplied (${nodeEnv}) unchanged`, (t) => {
    const { driver, calls, env, evidence } = driverBuilds(t, {
      stage,
      nodeEnv,
    });
    assert.equal(driver.status, 1, `${driver.stdout}${driver.stderr}`);
    assert.deepEqual(
      calls.map((c) => c.args),
      stage === "bundle" ? [["build"], ["build:fixture"]] : [["build:fixture"]],
    );
    for (const call of calls) {
      assert.equal(call.env.NODE_ENV, nodeEnv);
      assert.deepEqual(call.env, env);
    }
    if (stage === "bundle")
      assert.equal(
        JSON.parse(
          readFileSync(join(evidence, "bundle/build-production.json"), "utf8"),
        ).node_env,
        nodeEnv,
      );
  });

// ---- the real builds ----
/** Every built JavaScript asset of `build` that is React's development JSX runtime or calls it. */
const developmentRuntime = (build) => {
  const assets = join(root, build, "assets");
  return readdirSync(assets)
    .filter((name) => name.endsWith(".js"))
    .filter(
      (name) =>
        /jsx-dev-runtime/.test(name) ||
        readFileSync(join(assets, name), "utf8").includes("jsxDEV"),
    );
};

test("case: the bundle stage started without NODE_ENV builds the production application and both builds pass their budget checks", (t) => {
  const dir = scratch(t);
  const evidence = join(dir, "evidence");
  const driver = run(
    [
      join(root, "scripts/profile-sync.mjs"),
      "--evidence",
      evidence,
      "--only",
      "bundle",
    ],
    environment(undefined),
    600_000,
  );
  assert.equal(driver.status, 0, `${driver.stdout}${driver.stderr}`);
  const delta = JSON.parse(
    readFileSync(join(evidence, "bundle-delta.json"), "utf8"),
  );
  assert.equal(
    delta.budgets.dist.exit,
    0,
    "the production build failed its budget check",
  );
  assert.equal(
    delta.budgets["dist-fixture"].exit,
    0,
    "the fixture build failed its budget check",
  );
  for (const label of ["production", "fixture"])
    assert.equal(
      JSON.parse(
        readFileSync(join(evidence, `bundle/build-${label}.json`), "utf8"),
      ).node_env,
      null,
    );
  assert.deepEqual(developmentRuntime("dist"), []);
  assert.deepEqual(developmentRuntime("dist-fixture"), []);
});
