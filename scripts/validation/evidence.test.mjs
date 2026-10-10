import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const cli = resolve(root, "node_modules/@playwright/test/cli.js");
const realBrowser = process.env.ATLAS_EVIDENCE_BROWSER_SMOKE === "1";
function fixture(t, legacy = false) {
  const directory = mkdtempSync(join(root, ".agtx/evidence-tool-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const helper = resolve(root, "tests/e2e/evidence-run.ts");
  const data = resolve(root, "tests/e2e/data-evidence.ts");
  writeFileSync(
    join(directory, "playwright.config.ts"),
    legacy
      ? `
    import { defineConfig } from '@playwright/test';
    export default defineConfig({ testDir: '.', testMatch: 'probe.spec.ts', workers: 1,
      reporter: 'line', outputDir: ${JSON.stringify(join(directory, "legacy-output"))} });
  `
      : `
    import { defineConfig } from '@playwright/test';
    import configuration from ${JSON.stringify(join(root, "playwright.config.ts"))};
    export default defineConfig({ ...configuration, testDir: '.', testMatch: 'probe.spec.ts',
      globalSetup: ${JSON.stringify(helper)}, webServer: [], reporter: 'line',
      projects: [{ name: 'fixture-chromium' }], workers: 1 });
  `,
  );
  writeFileSync(
    join(directory, "probe.spec.ts"),
    `
    import { test, expect } from '@playwright/test';
    import { recordEvidence } from ${JSON.stringify(data)};
    import { claimEvidencePath, evidenceRun } from ${JSON.stringify(helper)};
    import { writeFileSync, readFileSync } from 'node:fs';
    test('same evidence identity', async ({${realBrowser ? "page" : ""}}, info) => {
      recordEvidence(info, 'probe', { value: 42 });
      expect(() => recordEvidence(info, 'probe', { value: 99 })).toThrow(/EEXIST/);
      const image = claimEvidencePath(info, 'nested/probe.png');
      ${realBrowser ? "await page.setContent('<main><h1>Evidence preservation probe</h1></main>'); await page.screenshot({ path: image });" : "writeFileSync(image, 'first');"}
      const before = readFileSync(image);
      expect(() => claimEvidencePath(info, 'nested/probe.png')).toThrow(/EEXIST/);
      expect(readFileSync(image).equals(before)).toBe(true);
      for (const name of ['../escape', '/absolute', 'a/../escape'])
        expect(() => claimEvidencePath(info, name)).toThrow();
      console.log('ATLAS_PROBE_RUN=' + evidenceRun());
      if (process.env.ATLAS_PROBE_FAILURE) expect(1).toBe(2);
    });
  `,
  );
  return directory;
}
function run(directory, extra = [], env = {}) {
  const environment = { ...process.env, ...env };
  delete environment.ATLAS_EVIDENCE_RUN_DIR;
  delete environment.TEST_WORKER_INDEX;
  delete environment.TEST_PARALLEL_INDEX;
  if (!Object.hasOwn(env, "ATLAS_EVIDENCE_DIR"))
    delete environment.ATLAS_EVIDENCE_DIR;
  return spawnSync(
    process.execPath,
    [
      cli,
      "test",
      "--config",
      join(directory, "playwright.config.ts"),
      ...extra,
    ],
    { cwd: directory, env: environment, encoding: "utf8", timeout: 30_000 },
  );
}
function digestTree(directory) {
  const values = {};
  for (const item of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!item.isFile()) continue;
    const path = join(item.parentPath, item.name);
    values[path] = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");
  }
  return values;
}
for (const explicit of [false, true]) {
  test(`repeated ordinary launches preserve evidence (${explicit ? "explicit parent" : "default parent"})`, (t) => {
    const directory = fixture(t);
    const env = explicit
      ? { ATLAS_EVIDENCE_DIR: join(directory, "evidence") }
      : {};
    const first = run(directory, ["--repeat-each", "2"], env);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const run1 = /ATLAS_PROBE_RUN=(.+)/.exec(first.stdout)?.[1]?.trim();
    assert.ok(run1, first.stdout);
    const hashes = digestTree(run1);
    assert.equal(
      Object.keys(hashes).filter((p) => p.endsWith("probe.json")).length,
      2,
    );
    const failed = run(directory, [], { ...env, ATLAS_PROBE_FAILURE: "1" });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const run2 = /ATLAS_PROBE_RUN=(.+)/.exec(failed.stdout)?.[1]?.trim();
    assert.ok(run2);
    assert.notEqual(run1, run2);
    assert.deepEqual(digestTree(run1), hashes);
    const failureHashes = digestTree(run2);
    if (realBrowser)
      assert.ok(
        Object.keys(failureHashes).some((p) => p.endsWith("trace.zip")),
        "failed browser trace is retained",
      );
    assert.ok(Object.keys(failureHashes).some((p) => p.endsWith("probe.json")));
    const third = run(directory, [], env);
    assert.equal(third.status, 0, third.stdout + third.stderr);
    assert.deepEqual(digestTree(run2), failureHashes);
  });
}
test("legacy config without setup still preserves previous worker evidence", (t) => {
  const directory = fixture(t, true);
  const first = run(directory);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const run1 = /ATLAS_PROBE_RUN=(.+)/.exec(first.stdout)?.[1]?.trim();
  assert.ok(run1);
  const before = digestTree(run1);
  const second = run(directory);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.notEqual(
    /ATLAS_PROBE_RUN=(.+)/.exec(second.stdout)?.[1]?.trim(),
    run1,
  );
  assert.deepEqual(digestTree(run1), before);
});
test("an explicit reused Playwright output is refused before its files are deleted", (t) => {
  const directory = fixture(t);
  const output = join(directory, "private-output");
  const first = run(directory, ["--output", output]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  writeFileSync(join(output, "sentinel.txt"), "preserve me");
  const before = digestTree(output);
  const second = run(directory, [`--output=${output}`]);
  assert.notEqual(second.status, 0);
  assert.match(
    second.stdout + second.stderr,
    /Refusing to replace existing Playwright output/,
  );
  assert.deepEqual(digestTree(output), before);
});
