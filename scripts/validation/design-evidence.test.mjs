import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * WEB-10a revision 14 (review 14's R27, design assessment DA-H1, QH1–QH6): the design-pass screenshot and painted-contrast sinks
 * that the production public spec and the Settings fixture (through `checkSurface`) use are exercised through Playwright itself.
 * Each invocation gets its own run; a second or concurrent invocation, another project, repeat or retry cannot alter the first one's
 * files; a duplicate claim in one test is refused before writing; a contrast record names its own run and case; and the historical
 * folder (a sentinel copy here, relative to the working directory exactly as the old writers used it) is never touched.
 * Set ATLAS_EVIDENCE_BROWSER_SMOKE=1 to capture with a real Chromium page instead of a byte-writing stand-in.
 */
const root = resolve(import.meta.dirname, "../..");
const cli = resolve(root, "node_modules/@playwright/test/cli.js");
const realBrowser = process.env.ATLAS_EVIDENCE_BROWSER_SMOKE === "1";
const WIDTHS = [320, 390, 768, 1280];
const PROJECTS = ["fixture-chromium", "production-chromium"];

function fixture(t) {
  const directory = mkdtempSync(join(root, ".agtx/evidence-tool-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const helper = resolve(root, "tests/e2e/evidence-run.ts");
  const surface = resolve(root, "tests/e2e/surface-checks.ts");
  writeFileSync(
    join(directory, "playwright.config.ts"),
    `
    import { defineConfig } from '@playwright/test';
    import configuration from ${JSON.stringify(join(root, "playwright.config.ts"))};
    export default defineConfig({ ...configuration, testDir: '.', testMatch: 'probe.spec.ts',
      globalSetup: ${JSON.stringify(helper)}, webServer: [], reporter: 'line',
      projects: ${JSON.stringify(PROJECTS.map((name) => ({ name })))}, workers: 1 });
  `,
  );
  writeFileSync(
    join(directory, "probe.spec.ts"),
    `
    import { test, expect } from '@playwright/test';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { recordPaintedContrast, surfaceScreenshot } from ${JSON.stringify(surface)};
    import { evidenceRun, testEvidenceDirectory } from ${JSON.stringify(helper)};
    test('design evidence belongs to its run and case', async ({${realBrowser ? "page" : ""}}, info) => {
      const target = ${realBrowser ? "page" : "{ screenshot: async ({ path }) => writeFileSync(path, 'capture ' + info.testId + ' ' + info.repeatEachIndex + ' ' + path) }"};
      ${realBrowser ? "await page.setContent('<main><h1>Design evidence probe</h1></main>');" : ""}
      console.log('ATLAS_PROBE_RUN=' + evidenceRun());
      const paths = [];
      for (const width of ${JSON.stringify(WIDTHS)}) {
        paths.push(await surfaceScreenshot(target, info, { name: 'sign-in', width, scheme: 'dark' }));
        if (process.env.ATLAS_PROBE_FAILURE) expect('failed after one capture').toBe('');
      }
      const first = readFileSync(paths[0]);
      await expect(surfaceScreenshot(target, info, { name: 'sign-in', width: 320, scheme: 'dark' })).rejects.toThrow(/EEXIST/);
      expect(readFileSync(paths[0]).equals(first)).toBe(true);
      const observations = { engine: info.project.name, signIn: { border: 3.2 }, join: { label: 7.1 } };
      recordPaintedContrast(info, 'dark', observations);
      expect(() => recordPaintedContrast(info, 'dark', observations)).toThrow(/EEXIST/);
      recordPaintedContrast(info, 'light', observations);
      for (const path of paths) expect(path.startsWith(testEvidenceDirectory(info) + '/')).toBe(true);
      expect(info.attachments.filter((a) => a.contentType === 'image/png').map((a) => a.path)).toEqual(paths);
    });
  `,
  );
  // The historical folder, relative to the working directory as the old writers used it.
  const legacy = join(directory, ".agtx/evidence/WEB-08b/design");
  mkdirSync(join(legacy, "chromium"), { recursive: true });
  writeFileSync(join(legacy, "chromium/sign-in-320-dark.png"), "historical");
  writeFileSync(
    join(legacy, "painted-contrast.jsonl"),
    '{"historical":true}\n',
  );
  return { directory, legacy };
}

function run(directory, extra = [], env = {}) {
  const environment = { ...process.env, ...env };
  delete environment.ATLAS_EVIDENCE_RUN_DIR;
  delete environment.TEST_WORKER_INDEX;
  delete environment.TEST_PARALLEL_INDEX;
  if (!Object.hasOwn(env, "ATLAS_EVIDENCE_DIR"))
    delete environment.ATLAS_EVIDENCE_DIR;
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        "test",
        "--config",
        join(directory, "playwright.config.ts"),
        ...extra,
      ],
      { cwd: directory, env: environment },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      const runs = [...stdout.matchAll(/ATLAS_PROBE_RUN=(.+)/g)].map((m) =>
        m[1].trim(),
      );
      done({ status, stdout, stderr, runs: [...new Set(runs)] });
    });
  });
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

const files = (tree, suffix) =>
  Object.keys(tree).filter((path) => path.endsWith(suffix));

function oneRun(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.runs.length, 1, result.stdout);
  return result.runs[0];
}

test("two invocations, repeats and projects keep separate design evidence; the historical folder is untouched", async (t) => {
  const { directory, legacy } = fixture(t);
  const evidence = join(directory, "step-owned-evidence");
  const report = join(directory, "report-1.json");
  const historical = digestTree(legacy);
  const first = await run(
    directory,
    ["--repeat-each", "2", "--reporter=line,json"],
    { ATLAS_EVIDENCE_DIR: evidence, PLAYWRIGHT_JSON_OUTPUT_FILE: report },
  );
  assert.deepEqual(
    digestTree(legacy),
    historical,
    "the historical folder was written",
  );
  const run1 = oneRun(first);
  assert.ok(run1.startsWith(`${evidence}/runs/run-`), run1);
  const tree1 = digestTree(run1);
  // 2 projects x 2 repeats x 4 widths: every width kept, each in its own case directory.
  assert.equal(files(tree1, ".png").length, 16);
  assert.equal(
    new Set(files(tree1, ".png").map((p) => p.split("/chromium%2F")[0])).size,
    4,
  );
  const records = files(tree1, "painted-contrast-dark.json").map((path) => ({
    path,
    record: JSON.parse(readFileSync(path, "utf8")),
  }));
  assert.equal(records.length, 4);
  // Attributable without its directory: run, project, test, repeat and retry are in the record itself.
  for (const { record } of records) {
    assert.equal(record.schema, 1);
    assert.equal(record.kind, "painted-contrast");
    assert.equal(record.run, run1);
    assert.equal(record.scheme, "dark");
    assert.equal(record.retry, 0);
    assert.equal(record.engine, record.project);
    assert.deepEqual(record.signIn, { border: 3.2 });
    assert.deepEqual(record.join, { label: 7.1 });
    assert.match(record.title, /design evidence belongs to its run and case/);
  }
  assert.deepEqual(
    records.map(({ record }) => `${record.project}/${record.repeat}`).sort(),
    [
      "fixture-chromium/0",
      "fixture-chromium/1",
      "production-chromium/0",
      "production-chromium/1",
    ],
  );
  // Playwright gives each project and repeat its own test id: four distinct cases.
  assert.equal(new Set(records.map(({ record }) => record.testId)).size, 4);
  assert.equal(files(tree1, "painted-contrast-light.json").length, 4);
  // Discovery: the JSON report's annotations and attachments lead into this run.
  const json = JSON.parse(readFileSync(report, "utf8"));
  const results = json.suites
    .flatMap((s) => s.specs)
    .flatMap((spec) => spec.tests);
  assert.equal(results.length, 4);
  for (const result of results) {
    const annotated = result.annotations.filter((a) => a.type === "evidence");
    assert.equal(annotated.length, 1);
    assert.ok(annotated[0].description.startsWith(`${run1}/`));
    const shots = result.results[0].attachments.filter(
      (a) => a.contentType === "image/png",
    );
    assert.equal(shots.length, 4);
    for (const shot of shots) {
      assert.ok(
        shot.path.startsWith(`${annotated[0].description}/`),
        shot.path,
      );
      assert.ok(existsSync(shot.path));
    }
  }

  const second = await run(directory, ["--repeat-each", "2"], {
    ATLAS_EVIDENCE_DIR: evidence,
  });
  const run2 = oneRun(second);
  assert.notEqual(run2, run1);
  assert.deepEqual(
    digestTree(run1),
    tree1,
    "the second invocation altered the first one's evidence",
  );
  assert.equal(files(digestTree(run2), ".png").length, 16);
  assert.deepEqual(
    digestTree(legacy),
    historical,
    "the historical folder was written",
  );
});

test("concurrent invocations allocate disjoint runs; a failed attempt keeps its captures", async (t) => {
  const { directory, legacy } = fixture(t);
  const historical = digestTree(legacy);
  // The default parent (no ATLAS_EVIDENCE_DIR) beside an explicit one, launched together.
  const [a, b] = await Promise.all([
    run(directory),
    run(directory, [], { ATLAS_EVIDENCE_DIR: join(directory, "explicit") }),
  ]);
  assert.deepEqual(
    digestTree(legacy),
    historical,
    "the historical folder was written",
  );
  const runA = oneRun(a);
  const runB = oneRun(b);
  assert.notEqual(runA, runB);
  assert.ok(!runA.startsWith(`${runB}/`) && !runB.startsWith(`${runA}/`));
  const treeA = digestTree(runA);
  const treeB = digestTree(runB);
  assert.equal(files(treeA, ".png").length, 8);
  assert.equal(files(treeB, ".png").length, 8);
  for (const path of files(treeA, "painted-contrast-dark.json"))
    assert.equal(JSON.parse(readFileSync(path, "utf8")).run, runA);
  const failed = await run(directory, [], { ATLAS_PROBE_FAILURE: "1" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(failed.runs.length, 1);
  const kept = digestTree(failed.runs[0]);
  // Each project's test captured one width before failing; that capture is retained, nothing else is claimed.
  assert.equal(files(kept, ".png").length, 2);
  assert.equal(files(kept, "painted-contrast-dark.json").length, 0);
  assert.deepEqual(digestTree(runA), treeA);
  assert.deepEqual(digestTree(runB), treeB);
  assert.deepEqual(
    digestTree(legacy),
    historical,
    "the historical folder was written",
  );
});
