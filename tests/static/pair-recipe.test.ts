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
      "file:vendor/atlas-api-types-0.29.0-rc.1.tgz",
    );
    const pin = JSON.parse(read("contract-pin.json")) as {
      version: string;
      backend_tag: string;
    };
    expect(pin.version).toBe("0.29.0-rc.1");
    expect(pin.backend_tag).toBe("v0.29.0-rc.1");
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
});

describe("the released path is untouched", () => {
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

  it("every case asks for its own matrix row (the designed skip on a backend it is not executable on)", () => {
    const rows = spec.match(/caseRow\((?:"(PAIR-[A-Z]+[0-9]+)"|id)\)/g) ?? [];
    const literal = rows.filter((r) => r.includes('"')).length;
    const looped = rows.filter((r) => r === "caseRow(id)").length;
    // Loops: W2/W3, S1/S2, G1/G2/G3 (each loop body calls caseRow(id) once).
    expect(looped).toBe(3);
    expect(literal + 2 + 2 + 3).toBe(CASES.length);
  });
});
