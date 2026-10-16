import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * WEB-10a revision 14 (review 14's R27 and design assessment DA-H1): a browser test's retained evidence belongs to its invocation
 * and test. `tests/e2e/evidence-run.ts` allocates a fresh run directory and claims every file exclusively per project, test, repeat
 * and retry. A fixed destination written from a test (`.agtx/evidence/WEB-08b/design/` was one) bypasses that: a second invocation
 * replaces the first one's screenshots, and an appended file mixes campaigns without saying which run wrote what.
 *
 * Exempt: the profiling producers. Their output paths are the measurement programme's own contract (its drivers read and reset those
 * directories), outside the functional/design suites; this guard does not change or approve them.
 */
const E2E = resolve(__dirname, "../e2e");
const PROFILING = (file: string) =>
  file === "profile-helpers.ts" || /^fixture\.profile-.*\.spec\.ts$/.test(file);
/** The allocator's own parent: runs are created beneath it with mkdtemp, never written to directly. */
const ALLOCATOR = 'const DEFAULT_PARENT = ".agtx/evidence/browser";';

function sources(): Array<{ file: string; code: string }> {
  return readdirSync(E2E, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !PROFILING(file))
    .map((file) => ({
      file,
      // Whole-line comments only (this suite's style); paths named in prose are history, not writers.
      code: readFileSync(join(E2E, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join("\n"),
    }));
}

describe("browser evidence is written only through the invocation's own run (R27)", () => {
  test("the scan sees the suite (not vacuous)", () => {
    const files = sources().map((s) => s.file);
    expect(files).toContain("production.auth-public.spec.ts");
    expect(files).toContain("fixture.auth-settings.spec.ts");
    expect(files).toContain("surface-checks.ts");
    expect(files).toContain("evidence-run.ts");
    expect(files.length).toBeGreaterThan(40);
  });

  test("no test or helper names a fixed .agtx/evidence destination", () => {
    const found = sources().flatMap(({ file, code }) =>
      code
        .split("\n")
        .filter((line) => /["'`]\.agtx\/evidence\//.test(line))
        .filter(
          (line) => !(file === "evidence-run.ts" && line.trim() === ALLOCATOR),
        )
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });

  test("nothing appends to or streams into a shared evidence file", () => {
    const found = sources()
      .filter(({ code }) =>
        /\b(appendFileSync|appendFile|createWriteStream)\b/.test(code),
      )
      .map(({ file }) => file);
    expect(found).toEqual([]);
  });

  test("every screenshot path comes from a claim, never a literal or template", () => {
    const found = sources().flatMap(({ file, code }) => {
      const out: string[] = [];
      for (const match of code.matchAll(/\.screenshot\(/g)) {
        const call = code.slice(match.index, match.index + 400);
        if (/path:\s*["'`]/.test(call))
          out.push(`${file}: ${call.split("\n").slice(0, 3).join(" ").trim()}`);
      }
      return out;
    });
    expect(found).toEqual([]);
  });

  test("the R27/DA-H1 producers use the run-owned sinks", () => {
    const read = (file: string) => readFileSync(join(E2E, file), "utf8");
    const helper = read("surface-checks.ts");
    expect(helper).toMatch(/const path = claimEvidencePath\(info, name\);/);
    expect(helper).toMatch(
      /writeEvidence\(info, `painted-contrast-\$\{scheme\}`/,
    );
    expect(helper).toMatch(
      /await surfaceScreenshot\(page, options\.info, options\)/,
    );
    const production = read("production.auth-public.spec.ts");
    expect(production).toMatch(/await surfaceScreenshot\(page, testInfo, \{/);
    expect(production).toMatch(/recordPaintedContrast\(info, scheme, \{/);
    expect(read("fixture.auth-settings.spec.ts")).toMatch(/info: testInfo,/);
  });
});
