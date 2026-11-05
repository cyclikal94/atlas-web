// The image smoke's composed origin (scripts/smoke-image.sh) and its strict case accounting (scripts/lib/playwright-cases.mjs).
// These are deterministic checks of the tooling; the script itself needs Docker and a browser and is run as its own check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { casesOf, reconcile } from "../lib/playwright-cases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

// A Playwright JSON report: files → describe → tests, each with its results.
function report(cases, { stats, errors = [] } = {}) {
  const files = new Map();
  for (const c of cases) {
    const file = files.get(c.file) ?? {
      title: c.file,
      file: c.file,
      specs: [],
      suites: [],
    };
    files.set(c.file, file);
    let describe = file;
    if (c.describe) {
      describe = file.suites.find((s) => s.title === c.describe);
      if (!describe) {
        describe = { title: c.describe, file: c.file, specs: [], suites: [] };
        file.suites.push(describe);
      }
    }
    describe.specs.push({
      title: c.title,
      file: c.file,
      line: c.line ?? 1,
      tests: [
        {
          projectName: c.project ?? "production-chromium",
          expectedStatus: c.expectedStatus ?? "passed",
          status: c.status ?? "expected",
          results: c.results ?? [{ status: "passed", retry: 0 }],
        },
      ],
    });
  }
  const expected = cases.filter(
    (c) => (c.status ?? "expected") === "expected",
  ).length;
  return {
    suites: [...files.values()],
    errors,
    stats: stats ?? { expected, skipped: 0, unexpected: 0, flaky: 0 },
  };
}
const listed = (cases) =>
  report(
    cases.map((c) => ({ ...c, status: "skipped", results: [] })),
    { stats: { expected: 0, skipped: cases.length, unexpected: 0, flaky: 0 } },
  );

const base = [
  { file: "production.csp.spec.ts", describe: "csp", title: "no violations" },
  {
    file: "production.neutral.spec.ts",
    describe: "neutral shell",
    title: "sign-in surface",
  },
  {
    file: "production.neutral.spec.ts",
    describe: "neutral shell",
    title: "deep link",
  },
  { file: "production.neutral.spec.ts", title: "top level" },
];
const pinned = casesOf(report(base)).map((c) => c.id);

describe("strict accounting of the image smoke's browser cases", () => {
  test("identities are project, file and full title path, not line", () => {
    assert.deepEqual(pinned, [
      "production-chromium › production.csp.spec.ts › csp › no violations",
      "production-chromium › production.neutral.spec.ts › top level",
      "production-chromium › production.neutral.spec.ts › neutral shell › sign-in surface",
      "production-chromium › production.neutral.spec.ts › neutral shell › deep link",
    ]);
    const moved = base.map((c) => ({ ...c, line: 99 }));
    assert.deepEqual(
      casesOf(report(moved)).map((c) => c.id),
      pinned,
    );
  });

  test("healthy control: exact inventory and one passing result each", () => {
    const verdict = reconcile({
      expected: pinned,
      inventory: listed(base),
      results: report(base),
    });
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.passed, true);
    assert.equal(verdict.summary.ran, 4);
  });

  test("an inventory alone is judged before anything runs", () => {
    assert.equal(
      reconcile({ expected: pinned, inventory: listed(base) }).passed,
      true,
    );
    const fewer = reconcile({
      expected: pinned,
      inventory: listed(base.slice(1)),
    });
    assert.equal(fewer.passed, false);
    assert.match(
      fewer.problems.join("\n"),
      /inventory: .*no violations is missing/,
    );
  });

  const broken = {
    "a missing result": () => report(base.slice(0, 3)),
    "an extra case": () =>
      report([...base, { file: "production.csp.spec.ts", title: "extra" }]),
    "a duplicated case": () => report([...base, base[1]]),
    "a skipped case": () => {
      const r = report(
        base.map((c, i) =>
          i === 2
            ? {
                ...c,
                status: "skipped",
                results: [{ status: "skipped", retry: 0 }],
              }
            : c,
        ),
      );
      return r;
    },
    "a retried case": () =>
      report(
        base.map((c, i) =>
          i === 0
            ? {
                ...c,
                results: [
                  { status: "failed", retry: 0 },
                  { status: "passed", retry: 1 },
                ],
                status: "flaky",
              }
            : c,
        ),
        {
          stats: { expected: 3, skipped: 0, unexpected: 0, flaky: 1 },
        },
      ),
    "a failed case": () =>
      report(
        base.map((c, i) =>
          i === 1
            ? {
                ...c,
                status: "unexpected",
                results: [{ status: "failed", retry: 0 }],
              }
            : c,
        ),
        {
          stats: { expected: 3, skipped: 0, unexpected: 1, flaky: 0 },
        },
      ),
    "an interrupted case": () =>
      report(
        base.map((c, i) =>
          i === 3
            ? {
                ...c,
                status: "unexpected",
                results: [{ status: "interrupted", retry: 0 }],
              }
            : c,
        ),
      ),
    "a case that expects to fail": () =>
      report(
        base.map((c, i) => (i === 0 ? { ...c, expectedStatus: "failed" } : c)),
      ),
    "a case with no result": () =>
      report(base.map((c, i) => (i === 0 ? { ...c, results: [] } : c))),
    "a reporter error outside any test": () =>
      report(base, {
        errors: [{ message: "Error: global setup failed\n at x" }],
      }),
    "reporter counts that disagree": () =>
      report(base, {
        stats: { expected: 3, skipped: 1, unexpected: 0, flaky: 0 },
      }),
  };
  for (const [name, make] of Object.entries(broken))
    test(`${name} is refused`, () => {
      const verdict = reconcile({
        expected: pinned,
        inventory: listed(base),
        results: make(),
      });
      assert.equal(verdict.passed, false, JSON.stringify(verdict.problems));
      assert.ok(verdict.problems.length > 0);
    });

  test("an inventory that is not the pinned list is refused, whatever the run says", () => {
    const other = [
      ...base.slice(0, 3),
      { file: "production.neutral.spec.ts", title: "renamed" },
    ];
    const verdict = reconcile({
      expected: pinned,
      inventory: listed(other),
      results: report(other),
    });
    assert.equal(verdict.passed, false);
    assert.match(
      verdict.problems.join("\n"),
      /renamed is not in the pinned list/,
    );
    assert.match(verdict.problems.join("\n"), /top level is missing/);
  });

  test("the same count with a different case is not a pass", () => {
    const swapped = [
      ...base.slice(0, 3),
      { file: "production.neutral.spec.ts", title: "other" },
    ];
    assert.equal(
      reconcile({
        expected: pinned,
        inventory: listed(swapped),
        results: report(swapped),
      }).passed,
      false,
    );
  });

  test("an empty or duplicated pinned list is an error, not a pass", () => {
    assert.throws(
      () => reconcile({ expected: [], inventory: listed(base) }),
      /empty/,
    );
    assert.throws(
      () =>
        reconcile({
          expected: [pinned[0], pinned[0]],
          inventory: listed(base),
        }),
      /duplicate/,
    );
    assert.throws(
      () => reconcile({ expected: pinned, inventory: { nope: true } }),
      /not a Playwright JSON report/,
    );
  });

  test("the command line exits 0, 1 or 2 and always writes its verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "playwright-cases-"));
    try {
      const write = (name, value) => {
        writeFileSync(join(dir, name), JSON.stringify(value));
        return join(dir, name);
      };
      const expected = write("pinned.json", { cases: pinned });
      const inventory = write("list.json", listed(base));
      const run = (results) => {
        const out = join(dir, `verdict-${Math.random()}.json`);
        const args = [
          "scripts/check-playwright-cases.mjs",
          "--expected",
          expected,
          "--inventory",
          inventory,
          "--results",
          results,
          "--out",
          out,
        ];
        let code = 0;
        try {
          execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" });
        } catch (error) {
          code = error.status;
        }
        return { code, verdict: JSON.parse(readFileSync(out, "utf8")) };
      };
      assert.deepEqual(
        [
          run(write("good.json", report(base))).code,
          run(write("good.json", report(base))).verdict.passed,
        ],
        [0, true],
      );
      const bad = run(write("bad.json", report(base.slice(1))));
      assert.equal(bad.code, 1);
      assert.equal(bad.verdict.passed, false);
      writeFileSync(join(dir, "malformed.json"), "{");
      const malformed = run(join(dir, "malformed.json"));
      assert.equal(malformed.code, 2);
      assert.equal(malformed.verdict.passed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the pinned list for the image smoke is well formed", () => {
    const list = JSON.parse(read("scripts/smoke-image-cases.json"));
    assert.equal(list.cases.length, 28);
    assert.equal(new Set(list.cases).size, 28);
    for (const id of list.cases)
      assert.match(
        id,
        /^production-chromium › production\.(neutral|csp)\.spec\.ts › /,
      );
  });
});

describe("the composed origin's check-only backend", () => {
  const conf = read("scripts/smoke-image-backend.conf");
  const literal = (text, path) => {
    const match = text.match(
      new RegExp(`location = ${path} \\{[^}]*?return 200 '([^']*)'`, "s"),
    );
    assert.ok(match, `${path} answer`);
    return match[1];
  };

  test("answers /health and /ready as the other stubs do, in the released shape", () => {
    const preview = read("scripts/preview-with-stub-backend.mjs");
    // The preview stub's object literal ({ api_version: "0.29.0", status: "ok" }), read as JSON and serialised as it does.
    const previewBody = (path) =>
      JSON.stringify(
        JSON.parse(
          preview
            .match(
              new RegExp(
                `path === "${path}"\\) \\{\\s*response\\.end\\(JSON\\.stringify\\((\\{[^)]*\\})\\)`,
              ),
            )[1]
            .replace(/(\w+):/g, '"$1":'),
        ),
      );
    const compose = read("deploy/stub-backend.conf");
    for (const path of ["/health", "/ready"]) {
      assert.equal(
        literal(conf, path),
        literal(compose, path),
        `${path} as deploy/stub-backend.conf`,
      );
      assert.equal(
        literal(conf, path),
        previewBody(path),
        `${path} as the preview stub`,
      );
    }
    assert.deepEqual(JSON.parse(literal(conf, "/health")), {
      api_version: "0.29.0",
      status: "ok",
    });
  });

  test("refuses every other path with a 404 rather than a success", () => {
    assert.match(conf, /location \/ \{\s*return 404 '\{\}';\s*\}/);
    assert.equal(conf.match(/return 200/g).length, 2);
    assert.match(conf, /add_header X-Atlas-Check-Backend "stub" always;/);
  });

  test("the script's own idea of the stub's answers is the stub's", () => {
    const script = read("scripts/smoke-image.sh");
    assert.equal(
      script.match(/^STUB_HEALTH='([^']*)'$/m)[1],
      literal(conf, "/health"),
    );
    assert.equal(
      script.match(/^STUB_READY='([^']*)'$/m)[1],
      literal(conf, "/ready"),
    );
  });
});

describe("the image smoke keeps the image's own checks and runs the browser only at the composed origin", () => {
  const script = read("scripts/smoke-image.sh");
  const joined = script.replace(/\\\n/g, " ");

  test("the container itself still refuses every backend path", () => {
    const loop = joined.match(
      /for path in (\/api [^;]*); do\s+expect_eq "\$arch: backend path \$path is an explicit 404"/,
    );
    assert.ok(loop, "the direct backend-path loop");
    for (const path of [
      "/api",
      "'/health'",
      "'/health?probe=1'",
      "'/ready'",
      "'/ready?probe=1'",
      "/auth",
      "/oidc",
    ])
      assert.ok(loop[1].split(/\s+/).includes(path), path);
  });

  test("every browser run is given the composed origin, never the container's own", () => {
    const runs = joined
      .split("\n")
      .filter((line) => /playwright test/.test(line));
    assert.equal(runs.length, 2);
    for (const line of runs) {
      assert.match(line, /ATLAS_PRODUCTION_URL="\$ORIGIN"/);
      assert.doesNotMatch(line, /ATLAS_PRODUCTION_URL="\$base"/);
      assert.match(
        line,
        /--workers=1 --retries=0 --repeat-each=1 --forbid-only/,
      );
    }
    assert.match(runs[1], /--update-snapshots=none/);
    assert.equal((joined.match(/ATLAS_PRODUCTION_URL=/g) ?? []).length, 2);
  });

  test("the proxy runs the reference template and the stub this repository's check-only configuration", () => {
    assert.match(
      script,
      /ATLAS_SMOKE_TEMPLATE="\$\(cat deploy\/nginx\/proxy\.conf\.template\)"/,
    );
    assert.match(script, /^STUB_CONF=scripts\/smoke-image-backend\.conf$/m);
    assert.match(script, /the proxy runs this repository's reference template/);
  });

  test("the run is judged against the pinned list, and cleanup failures fail it", () => {
    assert.equal(
      (
        joined.match(
          /check-playwright-cases\.mjs --expected scripts\/smoke-image-cases\.json/g,
        ) ?? []
      ).length,
      2,
    );
    assert.match(script, /^trap cleanup EXIT$/m);
    assert.match(script, /resources this run created survived cleanup/);
    assert.match(script, /already holds an earlier attempt's evidence/);
  });
});
