import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvidenceCache, ordered, qualify } from "./reliability.mjs";

const staticStep = () => ({
  id: "types",
  stage: "focused",
  argv: ["pnpm", "typecheck"],
  requirement: "types",
  reuse: {
    kind: "pure",
    basis: "Static compiler check; full input tree and installed toolchain",
    runtime_files: [],
    artifacts: [],
  },
});
const plan = (steps) => ({
  version: 2,
  qualification: {
    changed_files: [],
    no_changes_reason: "No product test changes",
  },
  steps,
});
test("new tests must qualify controls, cases and mutations before broad work", () => {
  const p = plan([staticStep()]);
  p.qualification.changed_files = ["tests/new.test.ts"];
  assert.throws(() => qualify(p), /control/);
  for (const kind of ["mutation", "case", "control"])
    p.steps.push({
      id: kind,
      stage: "qualification",
      qualification_kind: kind,
      argv: ["node", "probe"],
      requirement: kind,
    });
  qualify(p);
  assert.deepEqual(
    ordered(p).map((s) => s.id),
    ["mutation", "case", "control", "types"],
  );
});
test("cycles, backward barriers and test/repeat reuse fail closed", () => {
  const p = plan([
    staticStep(),
    {
      ...staticStep(),
      id: "later",
      stage: "final",
      after: ["types"],
      reuse: undefined,
    },
  ]);
  p.steps[0].after = ["later"];
  assert.throws(() => ordered(p), /backwards/);
  for (const argv of [
    ["pnpm", "test:validation-tools"],
    ["node", "--test", "scripts/validation/evidence.test.mjs"],
    ["pnpm", "exec", "playwright", "test", "--repeat-each=40"],
  ])
    assert.throws(
      () => qualify(plan([{ ...staticStep(), argv }])),
      /static checks/,
    );
  assert.throws(
    () => qualify(plan([{ ...staticStep(), stage: "final" }])),
    /limited/,
  );
});
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "atlas-reuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, value);
  };
  put("pnpm-lock.yaml", "lock");
  put("package.json", '{"packageManager":"pnpm@12.4.2"}');
  put("node_modules/.modules.yaml", "installed");
  put("node_modules/.pnpm/a/index.js", "a");
  put("node_modules/.pnpm/b/index.js", "b");
  symlinkSync(".pnpm/a", join(root, "node_modules/alias"));
  put("tools/package.json", '{"name":"pnpm","version":"12.4.2"}');
  put("tools/bin/pnpm", "launcher");
  mkdirSync(join(root, "node-bin"));
  symlinkSync(process.execPath, join(root, "node-bin/node"));
  const cache = new EvidenceCache(
    root,
    join(root, ".agtx/cache"),
    { sha256: "source" },
    {
      PATH: `${join(root, "node-bin")}:${join(root, "tools/bin")}`,
      HOME: root,
    },
  );
  put(".agtx/run/check.log", "passed");
  return {
    root,
    put,
    cache,
    step: staticStep(),
    log: join(root, ".agtx/run/check.log"),
  };
}
test("identical static checks reuse intact evidence; edits and failures invalidate it", (t) => {
  const { root, put, cache, step, log } = setup(t);
  const key = cache.identity(step);
  cache.save(key, step, { status: "passed" }, log);
  assert.ok(cache.load(key));
  assert.equal(
    cache.identity({ ...step, id: "other", requirement: "another mapping" }),
    key,
  );
  put("node_modules/.pnpm/a/index.js", "changed dependency");
  assert.notEqual(cache.identity(step), key);
  put(".agtx/run/check.log", "changed evidence");
  assert.equal(cache.load(key), null);
  cache.save(key, step, { status: "failed" }, log);
  assert.equal(cache.load(key), null);
  assert.ok(readFileSync(join(root, ".agtx/run/check.log")));
});
test("repointed installed aliases and replaced executable payloads invalidate reuse", (t) => {
  const { root, put, cache, step } = setup(t);
  const key = cache.identity(step);
  unlinkSync(join(root, "node_modules/alias"));
  symlinkSync(".pnpm/b", join(root, "node_modules/alias"));
  assert.notEqual(cache.identity(step), key);
  const later = cache.identity(step);
  put("tools/bin/pnpm", "different launcher");
  assert.notEqual(cache.identity(step), later);
});
test("Corepack's actual pinned payload is included", (t) => {
  const { put, cache, step } = setup(t);
  put("tools/package.json", '{"name":"corepack"}');
  put(
    ".cache/node/corepack/v1/pnpm/12.4.2/package.json",
    '{"version":"12.4.2"}',
  );
  put(".cache/node/corepack/v1/pnpm/12.4.2/bin/pnpm.cjs", "first");
  const key = cache.identity(step);
  put(".cache/node/corepack/v1/pnpm/12.4.2/bin/pnpm.cjs", "changed");
  assert.notEqual(cache.identity(step), key);
});
test("missing or external runtime inputs cannot authorise reuse", (t) => {
  const { root, cache, step } = setup(t);
  step.reuse.runtime_files = ["missing"];
  assert.throws(() => cache.identity(step));
  step.reuse.runtime_files = [];
  symlinkSync(process.execPath, join(root, "node_modules/external"));
  assert.throws(() => cache.identity(step), /External/);
});
