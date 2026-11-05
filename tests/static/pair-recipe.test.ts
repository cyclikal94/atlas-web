import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CASES, UNSUPPORTED } from "../../scripts/integration/pair-matrix.mjs";
import { DATA_CONFIG } from "../../src/data/model/config";

/**
 * WEB-09c R23-PAIR: the development-pair recipe stays DIAGNOSTIC. The production composition never supplies the segmentation seam, the released
 * pin, API types and opt-in stay as they are, the released runner never reaches the pair modules, the pair projects exist only for their own
 * runner, and the spec's cases are exactly the explicit matrix (the runner's discovery check is the executable counterpart).
 */
const read = (path: string): string => readFileSync(path, "utf8");
/** The code alone: comments removed (they name the rules they keep). */
const code = (path: string): string =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the seam is diagnostic only", () => {
  it("production never opts in: no minimum API version, the released types and pin unchanged", () => {
    expect(DATA_CONFIG.segmentedMinApiVersion).toBeNull();
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@atlas/api-types"]).toBe(
      "file:vendor/atlas-api-types-0.31.0-rc.1.tgz",
    );
    const pin = JSON.parse(read("contract-pin.json")) as {
      version: string;
      backend_tag: string;
    };
    expect(pin.version).toBe("0.31.0-rc.1");
    expect(pin.backend_tag).toBe("v0.31.0-rc.1");
  });

  it("main.tsx passes no diagnostic; boot hands it only to the leader's start; the shim forwards it only to the browser composition", () => {
    expect(read("src/main.tsx")).not.toMatch(/dataLeaderDiagnostic|segmented/);
    const boot = code("src/app/boot.tsx");
    expect(boot.match(/options\.dataLeaderDiagnostic/g)).toHaveLength(1);
    expect(boot).toMatch(
      /dataLeader\.start\(session, options\.trace, options\.dataLeaderDiagnostic\)/,
    );
    const shim = code("src/data/leader/start.ts");
    expect(shim).toMatch(/diagnostic: options\.diagnostic,/);
    expect(code("src/app/data-leader.ts")).toMatch(
      /startDataLeader\(session, \{ trace, diagnostic \}\)/,
    );
  });

  it("the browser composition supplies segmentedCapable only from the diagnostic option, and the leader hands it to BOTH callers", () => {
    const browser = code("src/data/ui/browser-leader.ts");
    expect(
      browser.split("\n").filter((line) => line.includes("segmentedCapable")),
    ).toHaveLength(1);
    expect(browser).toMatch(
      /segmentedCapable: options\.diagnostic\.segmentedCapable/,
    );
    const leader = code("src/data/leader/leader.ts");
    expect(
      leader.match(
        /\.\.\.\(deps\.segmentedCapable\s*\?\s*\{ segmentedCapable: deps\.segmentedCapable \}\s*:\s*\{\}\)/g,
      ),
    ).toHaveLength(2);
  });

  it("only the fixture session harness passes it, only when the page asks, and only with the production leader", () => {
    const harness = code("src/fixture/session-harness/main.tsx");
    expect(harness).toMatch(
      /segmentedParam !== "capable" \|\| !productionLeader/,
    );
    expect(harness).toMatch(/harness\.pairing === null\s*\?\s*\{\}/);
    expect(harness).toMatch(/pairMaxChanges >= 4\s*&&\s*pairMaxChanges <= 800/);
  });

  it("R38-DIAG: the exact-version compatibility policy is the harness's alone, from a named selection, only with the production leader; boot reads it once, for the session's range", () => {
    expect(read("src/main.tsx")).not.toMatch(
      /diagnosticCompatibility|exactVersionRange|pairApi|pairSelection/,
    );
    const boot = code("src/app/boot.tsx");
    expect(boot.match(/options\.diagnosticCompatibility/g)).toHaveLength(1);
    expect(boot).toMatch(
      /supportedRange:\s*options\.diagnosticCompatibility\?\.supportedRange \?\?\s*rangeFromPin\(contractVersion\)/,
    );
    expect(boot).not.toMatch(/exactVersionRange/);
    const harness = code("src/fixture/session-harness/main.tsx");
    expect(harness.match(/diagnosticCompatibility:/g)).toHaveLength(1);
    expect(harness).toMatch(/supportedRange: pairRange/);
    expect(harness).toMatch(
      /pairRange =\s*pairApiParam === null \? null : exactVersionRange\(pairApiParam\)/,
    );
    expect(harness).toMatch(
      /\(pairApiParam === null\) !== \(pairSelectionParam === null\)/,
    );
    expect(harness).toMatch(/pairApiParam !== null && !productionLeader/);
    expect(harness).toMatch(
      /\/\^\[0-9a-f\]\{64\}\$\/\.test\(pairSelectionParam\)/,
    );
    // No other source composes a session with another range, and no source but the harness uses the exact-version policy.
    const sources = execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "src"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((f) => f && existsSync(f) && !statSync(f).isDirectory());
    for (const file of sources) {
      const text = code(file);
      if (
        file !== "src/session/model/api-version.ts" &&
        file !== "src/session/index.ts" &&
        file !== "src/fixture/session-harness/main.tsx"
      )
        expect(text, file).not.toMatch(/exactVersionRange/);
      if (
        ![
          "src/app/boot.tsx",
          "src/session/session.ts",
          "src/fixture/session-harness/main.tsx",
        ].includes(file)
      )
        expect(text, file).not.toMatch(/supportedRange:/);
    }
    // The pair page names it only against the diagnostic executable, from the verified selection.
    const support = code("tests/pair/support.ts");
    expect(support).toMatch(
      /if \(PAIR_BACKEND !== "diagnostic"\) return null;/,
    );
    expect(support).toMatch(
      /const apiVersion = DIAGNOSTIC_SELECTION\.backend\.apiVersion;/,
    );
  });
});

describe("the released path is untouched", () => {
  it("revision 40 (R40-PAIR): the runner verifies the maintained normal selection through its default dependencies before discovery and again after the run, stages from it, and the released branch keeps the unchanged fetcher", () => {
    const runner = code("scripts/integration/run-development-pair.mjs");
    // Exactly two verifications of the maintained descriptor with the default deps (preflight, post-run), never another descriptor.
    expect(
      runner.match(/verifySelection\(realSelectionDeps\(run\)\)/g),
    ).toHaveLength(2);
    expect(runner.match(/verifySelection\(/g)).toHaveLength(2);
    expect(runner).toMatch(
      /selection = verifySelection\(realSelectionDeps\(run\)\);\s*writeJson\("selection\.json", selection\);\s*if \(!selection\.ok\)/,
    );
    expect(runner).toMatch(
      /\? verifySelection\(realSelectionDeps\(run\)\)\s*: verifyDiagnosticSelection\(realDiagnosticDeps\(run\)\);\s*summary\.selection_after = \{ ok: after\.ok, problems: after\.problems \};\s*if \(!after\.ok\) failed = true;/,
    );
    // The staged copy is the maintained selection's executable (no descriptor argument), and the released branch fetches.
    expect(runner.match(/stageExecutable\(/g)).toHaveLength(1);
    expect(runner).toMatch(/const staged = stageExecutable\(tmp\);/);
    expect(runner).toMatch(/scripts\/integration\/fetch-backend\.mjs/);
    // The selector reads the normal backend from its own stable location and the diagnostic one from its own.
    const selector = code("scripts/integration/pair-selection.mjs");
    expect(selector).toMatch(
      /const NORMAL_BACKEND = `\$\{ORCHESTRATOR\}\/\.local\/atlas\/maintenance\/web09c-r39-admission-20261102\/normal-backend`;/,
    );
    expect(selector).toMatch(/checkout: NORMAL_BACKEND,/);
    expect(selector).toMatch(/checkout: DIAGNOSTIC_BACKEND,/);
    // No shared location constant remains (`_` is a word character, so NORMAL_/DIAGNOSTIC_BACKEND do not match).
    expect(selector).not.toMatch(/\bBACKEND\b/);
  });

  it("the released integration runner and its fetcher never reach the pair modules", () => {
    for (const file of [
      "scripts/integration/run.mjs",
      "scripts/integration/fetch-backend.mjs",
      "scripts/integration/stacks.mjs",
      "scripts/integration/schedule.mjs",
    ])
      expect(read(file)).not.toMatch(
        /pair-(selection|matrix|tap|evidence|attempts|driver|recovery|schedule|capture)|run-development-pair|diagnostic-(fixture|evidence|fake)|causal-journal/,
      );
  });

  it("revision 26/27/28: no product, fixture or service-worker source reaches the diagnostic adapter, its bridge, its stand-in, the causal journal, the recovery observer or the schedule", () => {
    const sources = execFileSync(
      "git",
      [
        "ls-files",
        "-co",
        "--exclude-standard",
        "src",
        "public",
        "index.html",
        "vite.config.ts",
      ],
      {
        encoding: "utf8",
      },
    )
      .split("\n")
      .filter((f) => f && existsSync(f) && !statSync(f).isDirectory());
    expect(sources.length).toBeGreaterThan(100);
    for (const file of sources)
      expect(read(file), file).not.toMatch(
        /diagnostic-(fixture|evidence|fake)|ATLAS_PAIR_DIAGNOSTIC|atlas-sync-diagnostic|causal-journal|pair-recovery|pair-schedule|pair-capture|__pairDocument|__pairLatch/,
      );
  });

  it("the pair projects exist only when the pair runner asks (ATLAS_PAIR=1), with their own test directory", () => {
    const config = code("playwright.config.ts");
    expect(config).toMatch(/const pair = process\.env\.ATLAS_PAIR === "1";/);
    expect(config).toMatch(/\.\.\.\(pair\s*\?\s*\[/);
    expect(config).toMatch(/testDir: "\.\/tests\/pair"/);
    expect(read("scripts/integration/run-development-pair.mjs")).toMatch(
      /ATLAS_PAIR: "1"/,
    );
  });
});

describe("the spec is exactly the explicit matrix", () => {
  const spec = read("tests/pair/pair.development.spec.ts");
  it("every matrix case is a titled case of the spec, and the spec names no case outside it", () => {
    const ids = CASES.map((c) => c.id);
    for (const id of ids)
      expect(
        spec.includes(`"${id}:`) ||
          spec.includes(`\`${id}:`) ||
          new RegExp(`\\[\\s*"${id}",`).test(spec),
        id,
      ).toBe(true);
    const named = new Set(spec.match(/PAIR-[A-Z]+[0-9]+/g) ?? []);
    for (const id of named) expect(ids, id).toContain(id);
    for (const unrun of UNSUPPORTED) expect(spec).not.toContain(`"${unrun.id}`);
  });

  it("revision 30 (R30-DIAG): the pair readers use the MAINTAINED capture composition (pair-capture.mjs), never a copy or a merged flag", () => {
    const support = code("tests/pair/support.ts");
    const reader = support.slice(
      support.indexOf("export async function recoveryReader("),
      support.indexOf("export async function observeRecoveryOf("),
    );
    expect(reader).toMatch(/return \(await recoverySample\(/);
    expect(reader).toMatch(/rendering: \(\) => renderingOf\(page, account\)/);
    expect(reader).toMatch(/stored\(page, account, rows, local\)/);
    expect(reader).not.toMatch(/coherent|incoherence|storedStamp/);
    expect(support).toMatch(
      /import \{ recoverySample \} from "\.\.\/\.\.\/scripts\/integration\/pair-capture\.mjs";/,
    );
    // The observer's owner keeps the first failure in the incomplete interval.
    expect(support).toMatch(
      /failed: \(f\) => \{\s*iv\.observationFailure \?\?= f;/,
    );
    expect(support).toMatch(
      /observation_failure: iv\.observationFailure \?\? null,/,
    );
    const rendering = code("tests/pair/rendering.ts");
    expect(rendering).toMatch(
      /import \{ renderingOf as maintained \} from "\.\.\/\.\.\/scripts\/integration\/pair-capture\.mjs";/,
    );
    expect(rendering).not.toMatch(/page\.evaluate/);
    // The capture module has no imports at all (no runner state, bridge or evidence), and no merged quality flag.
    const capture = read("scripts/integration/pair-capture.mjs");
    expect(capture).not.toMatch(/^import /m);
    expect(code("scripts/integration/pair-capture.mjs")).not.toMatch(
      /coherent/,
    );
    // The native qualification drives the same composition with the same raw read.
    const native = code("tests/e2e/fixture.pair-rendering.spec.ts");
    expect(native).toMatch(/recoverySample\(/);
    expect(native).toMatch(/from "\.\.\/pair\/stored"/);
    expect(read("tests/pair/stored.ts")).not.toMatch(/from "\.\.\/integration/);
  });

  it("revision 28 (R28-DIAG.a): the real-410 schedule is the maintained pair-schedule.mjs composition; no hook reads the outer token", () => {
    const src = code("tests/pair/pair.development.spec.ts");
    expect(src).toMatch(
      /from "\.\.\/\.\.\/scripts\/integration\/pair-schedule\.mjs"/,
    );
    // Exactly the five real-410 callers use the shared helper, and the one afterE hook is the maintained reload hook.
    expect(src.match(/token = \(\s*await queueContinuation\(/g)?.length).toBe(
      5,
    );
    expect(src.match(/afterE:/g)?.length).toBe(1);
    expect(src).toMatch(/afterE: reloadHook\(\{/);
    // The spec's own wrapper delegates; it neither awaits the control nor re-implements the reload poll.
    expect(src).not.toMatch(/await control\(token\)/);
    expect(src).not.toMatch(/r\.query\?\.cursor === token/);
    expect(src).not.toMatch(/\(tok: string\)/);
  });

  it("revision 39 (R39-DIAG): XL0's two refusals are the maintained refusalPair, bound at the gate and the reload and selected by identity", () => {
    const src = code("tests/pair/pair.development.spec.ts");
    expect(src).toMatch(
      /const pair = refusalPair<TapRecord>\(\{\s*label: o\.iv\.id\s*\}\)/,
    );
    expect(src.match(/select: pair\.select,/g)?.length).toBe(1);
    expect(src).toMatch(
      /reloaded: \(request, at\) => pair\.reloaded\(request, at\)/,
    );
    expect(src).toMatch(/\(request, ctx\) => pair\.queued\(request, ctx\)/);
    expect(src).toMatch(/return pair\.answer\(/);
    // The order-dependent branches (the departed 410 required to be handled first) are gone.
    expect(src).not.toMatch(/lost !== null && refused === null/);
    expect(src).not.toMatch(/j_request \?\? 0\) < \(m\.marks\.reload_begin/);
  });

  it("every case asks for its own matrix row (the designed skip on a backend it is not executable on)", () => {
    const rows = spec.match(/caseRow\((?:"(PAIR-[A-Z]+[0-9]+)"|id)\)/g) ?? [];
    const literal = rows.filter((r) => r.includes('"')).length;
    const looped = rows.filter((r) => r === "caseRow(id)").length;
    // Loops: W2/W3, S1/S2, G1/G2/G3 (each loop body calls caseRow(id) once).
    expect(looped).toBe(3);
    expect(literal + 2 + 2 + 3).toBe(CASES.length);
  });
});
