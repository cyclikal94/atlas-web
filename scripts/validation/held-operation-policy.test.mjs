// WEB-08d revision 29 (review r28 R28-N1; design assessment d3cff73e Q2, I1, I3-I5): the execution policy's Playwright transform
// adapter, exercised through the REAL installed Playwright 1.63.0 loaders rather than a model of them. Each case runs in a fresh Node
// child over two disposable copies of this worktree's playwright package (its playwright-core linked, read only): the UPSTREAM copy as
// installed and the ADAPTED copy the snapshot executes (held-operation-execution.mjs adaptedText, digests checked). Nothing here writes
// into the worktree or its installation.
//
// A cache entry B, written at Playwright's own key for each test file with its own checksum header, writes a marker when executed and
// then runs the file's real code. The upstream loaders must EXECUTE it (the entry was reachable at the scheduled lookup: the
// counterexample of review r28 in miniature), the adapted ones must never supply it to execution while the file's real code still
// runs, and neither copy's verdict may depend on stdout/stderr framing (each child writes its result to its own file):
//  - the ESM loader in-thread (Node's registerHooks: lib/common/index.js) and in its own thread (PLAYWRIGHT_FORCE_ASYNC_LOADER:
//    lib/transform/esmLoader.js), for an ES module config and a CommonJS helper;
//  - the in-memory cache a controller hands to its workers and loader thread (addToCompilationCache): an entry naming a code path;
//  - a cold run: the upstream copy writes its cache, the adapted copy writes nothing at all and hands its source maps over by value;
//  - attribution: an error thrown by transformed TypeScript is reported at the same original line by both copies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ADAPTED_FILES,
  adaptedText,
  PLAYWRIGHT_VERSION,
} from "./held-operation-execution.mjs";

const sha = (b, kind = "sha256") => createHash(kind).update(b).digest("hex");
const require = createRequire(join(import.meta.dirname, "../../package.json"));
const installed = dirname(
  createRequire(require.resolve("@playwright/test/package.json")).resolve(
    "playwright/package.json",
  ),
);
const core = dirname(
  createRequire(join(installed, "package.json")).resolve(
    "playwright-core/package.json",
  ),
);

/** A disposable copy of the installed playwright package under `<dir>/node_modules`, adapted when `adapted`. Returns its directory. */
function copyOf(dir, adapted) {
  const nm = join(dir, "node_modules");
  mkdirSync(nm, { recursive: true });
  const pkg = join(nm, "playwright");
  cpSync(installed, pkg, { recursive: true, verbatimSymlinks: true });
  symlinkSync(core, join(nm, "playwright-core"));
  for (const [rel, want] of Object.entries(ADAPTED_FILES)) {
    const text = readFileSync(join(pkg, rel), "utf8");
    assert.equal(sha(text), want.upstream, `${rel} is the known upstream`);
    if (adapted) {
      const out = adaptedText(text, rel);
      assert.equal(sha(out), want.adapted, `${rel} adapts as reviewed`);
      writeFileSync(join(pkg, rel), out);
    }
  }
  return pkg;
}

/** The project the loaders load: an ES module config and a CommonJS helper (TypeScript, so both are transformed), each marking A. */
function project(dir, marks) {
  const esm = join(dir, "esm");
  const cjs = join(dir, "cjs");
  mkdirSync(esm, { recursive: true });
  mkdirSync(cjs, { recursive: true });
  writeFileSync(join(esm, "package.json"), '{"type":"module"}');
  writeFileSync(join(cjs, "package.json"), '{"type":"commonjs"}');
  const files = {
    esm: join(esm, "config.ts"),
    cjs: join(cjs, "helper.ts"),
    throws: join(esm, "throws.ts"),
  };
  writeFileSync(
    files.esm,
    `import { writeFileSync } from "node:fs";\ntype Kind = "A";\nconst kind: Kind = "A";\nwriteFileSync(${JSON.stringify(join(marks, "esm-A"))}, kind);\nexport default { kind };\n`,
  );
  writeFileSync(
    files.cjs,
    `const { writeFileSync } = require("node:fs");\nconst kind: string = "A";\nwriteFileSync(${JSON.stringify(join(marks, "cjs-A"))}, kind);\nmodule.exports = { kind };\n`,
  );
  writeFileSync(
    files.throws,
    `interface Shape {\n  a: number;\n  b: number;\n}\nconst s: Shape = { a: 1, b: 2 };\nexport function fail(): never {\n  throw new Error("thrown at line 7 " + (s.a + s.b));\n}\n`,
  );
  return files;
}

/** Playwright 1.63.0's cache path and header for `file` (compilationCache.ts calculateHash / calculateCachePath / writeCodeCache). */
function cacheEntry(cache, file, isModule) {
  const content = readFileSync(file, "utf8");
  const hash = sha(
    `${isModule ? "esm" : "no_esm"}${content}${file}${PLAYWRIGHT_VERSION}`,
    "sha1",
  );
  const pathHash = sha(file, "sha1").slice(0, 10);
  const base = file
    .split("/")
    .at(-1)
    .replace(/\.[^.]+$/, "");
  return join(
    cache,
    pathHash.slice(0, 2),
    `${pathHash}_${hash.slice(0, 7)}_${base.replace(/\W/g, "")}.js`,
  );
}
/** Writes B at `path`: it marks its own execution, then runs `real` (the file's real behaviour), under a self-consistent header. */
function seed(path, marker, real) {
  const code = `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(marker)}, "B");\n${real}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `// ${sha(code, "sha1")}\n${code}`);
}

const CHILD = `
const { writeFileSync, readdirSync } = require("node:fs");
const [pkg, input] = process.argv.slice(1);
const { files, seedTransfer, result } = JSON.parse(input);
(async () => {
  const out = { errors: [] };
  const pw = require(pkg + "/lib/common/index.js");
  if (seedTransfer) pw.cc.addToCompilationCache({ sourceMaps: [], memoryCache: [[files.cjs, { codePath: seedTransfer }]], fileDependencies: [] });
  for (const f of [files.esm, files.cjs]) {
    try { await pw.transform.requireOrImport(f); } catch (e) { out.errors.push(String(e.stack || e)); }
  }
  try { (await pw.transform.requireOrImport(files.throws)).fail(); } catch (e) { out.thrown = String(e.stack).split("\\n").slice(0, 3).join("\\n"); }
  await pw.transform.incorporateCompilationCache();
  const s = pw.cc.serializeCompilationCache();
  out.code_paths = s.memoryCache.filter(([, e]) => e && e.codePath).length;
  out.map_values = s.sourceMaps.map(([, v]) => (v && typeof v === "object" ? "object" : typeof v));
  writeFileSync(result, JSON.stringify(out), { flag: "wx" });
})().catch((e) => { writeFileSync(result, JSON.stringify({ fatal: String(e.stack || e) }), { flag: "wx" }); process.exitCode = 1; });
`;

/** Runs one loader child over `pkg`; returns its result record, the markers written and the cache's files afterwards. */
function load(
  t,
  { adapted, async = false, seedNormal = true, transfer = false },
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "atlas-policy-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = copyOf(join(dir, "install"), adapted);
  const marks = join(dir, "marks");
  mkdirSync(marks);
  const cache = join(dir, "cache");
  mkdirSync(cache);
  const files = project(join(dir, "project"), marks);
  const seeded = [];
  if (seedNormal)
    for (const [kind, isModule] of [
      ["esm", true],
      ["cjs", false],
    ]) {
      const p = cacheEntry(cache, files[kind], isModule);
      seed(
        p,
        join(marks, `${kind}-B`),
        `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(join(marks, `${kind}-A`))}, "A");${isModule ? "\nexport default { kind: 'A' };" : ""}`,
      );
      seeded.push(p);
    }
  let seedTransfer = null;
  if (transfer) {
    seedTransfer = join(dir, "transferred.js");
    seed(
      seedTransfer,
      join(marks, "cjs-B"),
      `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(join(marks, "cjs-A"))}, "A");`,
    );
  }
  const before = listing(cache);
  const result = join(dir, "result.json");
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    TMPDIR: dir,
    PWTEST_CACHE_DIR: cache,
    NODE_DISABLE_COMPILE_CACHE: "1",
    ...(async ? { PLAYWRIGHT_FORCE_ASYNC_LOADER: "1" } : {}),
  };
  const r = spawnSync(
    process.execPath,
    ["-e", CHILD, pkg, JSON.stringify({ files, seedTransfer, result })],
    { cwd: join(dir, "project"), env, encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(r.signal, null);
  const record = JSON.parse(readFileSync(result, "utf8"));
  assert.equal(record.fatal, undefined, record.fatal);
  assert.deepEqual(record.errors, []);
  return {
    record,
    marks: readdirSync(marks).sort(),
    before,
    after: listing(cache),
    seeded,
  };
}
const listing = (dir) => {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(`${r} ${sha(readFileSync(join(d, e.name)))}`);
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
};

for (const async of [false, true]) {
  const loader = async
    ? "the ESM loader thread (lib/transform/esmLoader.js)"
    : "the in-thread ESM loader and CommonJS hooks (lib/common/index.js)";
  test(`upstream Playwright executes a seeded cache entry through ${loader} (the entry is reachable at the lookup)`, (t) => {
    const r = load(t, { adapted: false, async });
    // The ES module config is always loaded through the loader under test; the CommonJS helper through the CJS hooks.
    assert.deepEqual(r.marks, ["cjs-A", "cjs-B", "esm-A", "esm-B"]);
    for (const line of r.before)
      assert.ok(
        r.after.includes(line),
        "the seeded entries were read, not replaced",
      );
  });
  test(`adapted Playwright never executes a seeded cache entry through ${loader}, runs the real code and writes nothing`, (t) => {
    const r = load(t, { adapted: true, async });
    assert.deepEqual(r.marks, ["cjs-A", "esm-A"]);
    assert.deepEqual(
      r.after,
      r.before,
      "the cache is neither read into execution nor written",
    );
    assert.equal(r.record.code_paths, 0);
    assert.ok(r.record.map_values.length > 0);
    assert.ok(r.record.map_values.every((v) => v === "object"));
  });
}
test("a code path handed over in the in-memory cache (controller to worker or loader thread) is executed upstream, never when adapted", (t) => {
  const up = load(t, { adapted: false, seedNormal: false, transfer: true });
  assert.ok(up.marks.includes("cjs-B"), up.marks.join(","));
  const ad = load(t, { adapted: true, seedNormal: false, transfer: true });
  assert.deepEqual(ad.marks, ["cjs-A", "esm-A"]);
  assert.equal(ad.record.code_paths, 0);
});
test("a cold run: upstream writes its transform cache; adapted writes nothing, and both attribute an error to the same original line", (t) => {
  const up = load(t, { adapted: false, seedNormal: false });
  const ad = load(t, { adapted: true, seedNormal: false });
  assert.deepEqual(up.marks, ["cjs-A", "esm-A"]);
  assert.deepEqual(ad.marks, ["cjs-A", "esm-A"]);
  assert.ok(up.after.length > 0, "upstream wrote cache entries");
  assert.deepEqual(ad.after, [], "adapted wrote no cache entry");
  const where = (s) => /throws\.ts:(\d+):(\d+)/.exec(s)?.slice(1).join(":");
  assert.match(where(up.record.thrown) ?? "", /^7:/, up.record.thrown);
  assert.equal(
    where(ad.record.thrown),
    where(up.record.thrown),
    ad.record.thrown,
  );
});
test("the adapter refuses an unknown layout: a missing or doubled anchor, never a partial edit", () => {
  const text = readFileSync(join(installed, "lib/common/index.js"), "utf8");
  assert.throws(
    () =>
      adaptedText(
        text.replace("function getFromCompilationCache(", "function other("),
      ),
    /occurs 0 times/,
  );
  const from = text.indexOf(
    "function _innerAddToCompilationCacheAndSerialize(",
  );
  const block = text.slice(from, text.indexOf("\n}\n", from) + 3);
  assert.throws(
    () => adaptedText(text.replace(block, block + block)),
    /occurs 2 times/,
  );
});
