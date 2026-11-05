import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { neededTargets, projectFilters, TARGETS } from "../e2e/targets";
import {
  playwrightInvocations,
  type ShellInvocation,
} from "./shell-invocations";

const ROOT = resolve(__dirname, "../..");
const NAMES = [
  "production-chromium",
  "fixture-chromium",
  "production-firefox",
  "fixture-firefox",
  "production-webkit",
  "fixture-webkit",
  "integration-chromium",
  "integration-firefox",
  "integration-webkit",
];
const cli = (...args: string[]) => ["node", "playwright", "test", ...args];

describe("--project parsing follows Playwright's own command line", () => {
  test("no filter means every project", () => {
    expect(projectFilters(cli("production.neutral"))).toBeUndefined();
  });

  test("--project=name takes one value; the words after it are test file filters", () => {
    expect(
      projectFilters(
        cli(
          "--project=production-chromium",
          "production.neutral",
          "production.csp",
        ),
      ),
    ).toEqual(["production-chromium"]);
  });

  test("--project name takes every following word up to the next option (it is variadic)", () => {
    expect(
      projectFilters(
        cli(
          "--project",
          "production-chromium",
          "fixture-chromium",
          "--workers=1",
        ),
      ),
    ).toEqual(["production-chromium", "fixture-chromium"]);
  });

  test("repeated options accumulate", () => {
    expect(projectFilters(cli("--project=a", "x", "--project", "b"))).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("which servers a run needs", () => {
  const needed = (...args: string[]) => [...neededTargets(cli(...args), NAMES)];

  test("an unfiltered run needs both", () => {
    expect(needed()).toEqual([...TARGETS]);
  });

  test("a production-only run needs no fixture server (R1: the clean image and Compose jobs have no dist-fixture)", () => {
    expect(
      needed("--project=production-chromium", "production.neutral"),
    ).toEqual(["production"]);
    expect(needed("--project", "production-webkit")).toEqual(["production"]);
    expect(needed("--project=production-*")).toEqual(["production"]);
  });

  test("a fixture-only run needs no production server", () => {
    expect(needed("--project=fixture-chromium")).toEqual(["fixture"]);
    expect(needed("--project=fixture-*", "-g", "loop")).toEqual(["fixture"]);
  });

  test("an integration-only run needs neither of our servers (its runner starts the released backend and its own preview)", () => {
    expect(needed("--project=integration-chromium")).toEqual([]);
    expect(
      needed("--project", "integration-firefox", "integration-webkit"),
    ).toEqual([]);
    expect(needed("--project=integration-*")).toEqual([]);
  });

  test("an integration project mixed with a fixture project still needs the fixture server", () => {
    expect(
      needed("--project=integration-chromium", "--project=fixture-chromium"),
    ).toEqual(["fixture"]);
  });

  test("a mixed selection needs both, and names match case-insensitively", () => {
    expect(
      needed(
        "--project=Production-Chromium",
        "--project=fixture-firefox",
      ).sort(),
    ).toEqual(["fixture", "production"]);
    expect(needed("--project=*-chromium").sort()).toEqual([
      "fixture",
      "production",
    ]);
  });

  test("an unknown project name is left to Playwright to report, with both servers assumed", () => {
    expect(needed("--project=nope")).toEqual([...TARGETS]);
  });
});

describe("the real playwright.config.ts", () => {
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function servers(args: string[], env: Record<string, string> = {}) {
    process.argv = cli(...args);
    vi.stubEnv("ATLAS_PRODUCTION_URL", "");
    vi.stubEnv("ATLAS_FIXTURE_URL", "");
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.resetModules();
    const { default: config } = await import("../../playwright.config");
    const list = config.webServer;
    // The production preview is started through scripts/preview-with-stub-backend.mjs (`vite preview` with a stub backend behind its
    // proxy, because the app now asks the server for its API version at boot); it is still "the production preview" here.
    return (Array.isArray(list) ? list : list ? [list] : []).map(
      (entry) =>
        entry.command
          .replace(/^node scripts\/preview-with-stub-backend\.mjs/, "preview")
          .replace(/^pnpm /, "")
          .split(" ")[0],
    );
  }

  test("starts each preview server for an unfiltered run", async () => {
    expect(await servers([])).toEqual(["preview", "preview:fixture"]);
  });

  test("a production-only run starts only the production preview, and never the fixture one", async () => {
    expect(
      await servers(["--project=production-chromium", "production.neutral"]),
    ).toEqual(["preview"]);
  });

  test("a fixture-only run starts only the fixture preview", async () => {
    expect(await servers(["--project=fixture-chromium"])).toEqual([
      "preview:fixture",
    ]);
  });

  test("a server that is already running (a container) is not started again", async () => {
    const url = "http://127.0.0.1:9";
    expect(
      await servers(["--project=production-chromium"], {
        ATLAS_PRODUCTION_URL: url,
      }),
    ).toEqual([]);
    expect(await servers([], { ATLAS_FIXTURE_URL: url })).toEqual(["preview"]);
  });
});

/**
 * The servers a run selects but does not supply by URL: each would need its build (dist/ or dist-fixture/) to start a preview.
 * Only the run's own assignments count (see tests/static/shell-invocations.ts).
 */
function unsupplied({ assignments, args }: ShellInvocation) {
  const supplied = TARGETS.filter((target) =>
    Boolean(assignments.get(`ATLAS_${target.toUpperCase()}_URL`)),
  );
  return {
    supplied,
    missing: [...neededTargets(cli(...args), NAMES)].filter(
      (target) => !supplied.includes(target),
    ),
  };
}

describe("the smoke scripts' browser runs need no build they do not have", () => {
  const scripts = readdirSync(resolve(ROOT, "scripts")).filter((file) =>
    file.endsWith(".sh"),
  );
  const invocations = scripts.flatMap((file) =>
    playwrightInvocations(
      file,
      readFileSync(resolve(ROOT, "scripts", file), "utf8"),
    ),
  );

  test("there are browser runs to check", () => {
    expect(invocations.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        "smoke-image.sh",
        "smoke-compose.sh",
        "smoke-fixture-nginx.sh",
      ]),
    );
  });

  test("the image smoke's inventory and browser runs are both found, each with the composed origin and the same cases (R36)", () => {
    const image = invocations.filter(({ file }) => file === "smoke-image.sh");
    // ADAPTATION (base merge of 5 November 2026, labelled for review): this assertion was `image.map(({line, endLine}) => endLine > line)`
    // equal to `[true, true]`, because WEB-14a's script continued each run over several lines (the R36 layout the physical-line reader
    // lost). Accepted main's script (WEB-09c F-PACK-COMPOSE) writes each run on one line as `run_child env ATLAS_PRODUCTION_URL="$ORIGIN"
    // … pnpm exec playwright test …`. The intent kept: exactly the inventory and the run are found in the script as written, each supplied
    // the composed origin through the shell layout actually used; the continued layout stays covered by the controls below.
    expect(image).toHaveLength(2);
    const [inventory, run] = image;
    expect(inventory?.args).toContain("--list");
    expect(run?.args).not.toContain("--list");
    for (const invocation of image) {
      expect(invocation.assignments.get("ATLAS_PRODUCTION_URL")).toBe(
        "$ORIGIN",
      );
      expect(invocation.args.slice(0, 7)).toEqual([
        "--project=production-chromium",
        "production.neutral",
        "production.csp",
        "--workers=1",
        "--retries=0",
        "--repeat-each=1",
        "--forbid-only",
      ]);
    }
  });

  test.each(invocations)(
    "$file:$line: every server the run selects is one it supplies by URL",
    (invocation) => {
      const { supplied, missing } = unsupplied(invocation);
      expect(supplied.length).toBeGreaterThan(0);
      for (const target of missing)
        expect.fail(
          `the ${target} preview would need dist${target === "fixture" ? "-fixture" : ""} to be built`,
        );
    },
  );
});

describe("reading a script's Playwright runs (R36's controls)", () => {
  const runs = (source: string) => playwrightInvocations("probe.sh", source);
  const missing = (source: string) =>
    runs(source).map((run) => unsupplied(run));
  const imageLayout = (inventoryUrl: string, runUrl: string) =>
    [
      'if compose_up "$tag"; then',
      `  ${inventoryUrl}PLAYWRIGHT_JSON_OUTPUT_FILE="$EVIDENCE/inventory.json" \\`,
      "    pnpm exec playwright test --project=production-chromium production.neutral \\",
      '    --workers=1 --list --reporter=json > "$EVIDENCE/inventory.log" 2>&1',
      `  if ${runUrl}PLAYWRIGHT_JSON_OUTPUT_FILE="$EVIDENCE/run.json" \\`,
      "    pnpm exec playwright test --project=production-chromium production.neutral \\",
      '    --workers=1 --reporter=list,json > "$EVIDENCE/run.log" 2>&1; then ok "passes"; else fail "fails"; fi',
      "fi",
    ].join("\n");
  const url = 'ATLAS_PRODUCTION_URL="$ORIGIN" ';

  test("a continued command keeps its assignments, attribution and arguments, and stops at redirections and separators", () => {
    const [inventory, run] = runs(imageLayout(url, url));
    expect(inventory).toMatchObject({ line: 2, endLine: 4 });
    expect(run).toMatchObject({ line: 5, endLine: 7 });
    expect(inventory?.args).toEqual([
      "--project=production-chromium",
      "production.neutral",
      "--workers=1",
      "--list",
      "--reporter=json",
    ]);
    expect(run?.args).toEqual([
      "--project=production-chromium",
      "production.neutral",
      "--workers=1",
      "--reporter=list,json",
    ]);
    expect([...(run?.assignments.keys() ?? [])]).toEqual([
      "ATLAS_PRODUCTION_URL",
      "PLAYWRIGHT_JSON_OUTPUT_FILE",
    ]);
    expect(missing(imageLayout(url, url))).toEqual([
      { supplied: ["production"], missing: [] },
      { supplied: ["production"], missing: [] },
    ]);
  });

  test("the existing single-line forms are still read", () => {
    expect(
      missing(
        'if ATLAS_FIXTURE_URL="$base" pnpm exec playwright test --project=fixture-chromium >"$EVIDENCE/x.log" 2>&1; then',
      ),
    ).toEqual([{ supplied: ["fixture"], missing: [] }]);
    expect(
      runs(
        "ATLAS_PRODUCTION_URL=$ORIGIN npx playwright test --project production-webkit fixture-webkit --workers=1",
      )[0]?.args,
    ).toEqual([
      "--project",
      "production-webkit",
      "fixture-webkit",
      "--workers=1",
    ]);
  });

  test("removing the URL from only the inventory, or only the run, is caught for that command", () => {
    expect(
      missing(imageLayout("", url)).map(({ supplied }) => supplied),
    ).toEqual([[], ["production"]]);
    expect(
      missing(imageLayout(url, "")).map(({ supplied }) => supplied),
    ).toEqual([["production"], []]);
  });

  test("a URL supplied elsewhere never counts: another command, a separate statement, a comment or an empty value", () => {
    for (const source of [
      'ATLAS_PRODUCTION_URL="$ORIGIN" true; pnpm exec playwright test --project=production-chromium',
      'ATLAS_PRODUCTION_URL="$ORIGIN" check && pnpm exec playwright test --project=production-chromium',
      'ATLAS_PRODUCTION_URL="$ORIGIN"\npnpm exec playwright test --project=production-chromium',
      '# ATLAS_PRODUCTION_URL="$ORIGIN" \\\npnpm exec playwright test --project=production-chromium',
      'pnpm exec playwright test --project=production-chromium # ATLAS_PRODUCTION_URL="$ORIGIN"',
      'echo ATLAS_PRODUCTION_URL="$ORIGIN" | pnpm exec playwright test --project=production-chromium',
      'ATLAS_PRODUCTION_URL="" pnpm exec playwright test --project=production-chromium',
    ])
      expect(missing(source), source).toEqual([
        { supplied: [], missing: ["production"] },
      ]);
  });

  test("the wrong target, or an unsupplied extra project, is missing", () => {
    expect(
      missing(
        'ATLAS_FIXTURE_URL="$base" pnpm exec playwright test --project=production-chromium',
      ),
    ).toEqual([{ supplied: ["fixture"], missing: ["production"] }]);
    expect(
      missing(
        'ATLAS_PRODUCTION_URL="$ORIGIN" pnpm exec playwright test \\\n  --project=production-chromium --project=fixture-chromium',
      ),
    ).toEqual([{ supplied: ["production"], missing: ["fixture"] }]);
  });

  test("a pass-through runner keeps the environment it is given: `run_child` and `env NAME=value` (base merge of 5 November 2026)", () => {
    const [inventory] = runs(
      'run_child env ATLAS_PRODUCTION_URL="$ORIGIN" PLAYWRIGHT_JSON_OUTPUT_FILE="$inventory" pnpm exec playwright test --project=production-chromium --list > "$x" 2>&1 || fail "x"',
    );
    expect([...(inventory?.assignments.entries() ?? [])]).toEqual([
      ["ATLAS_PRODUCTION_URL", "$ORIGIN"],
      ["PLAYWRIGHT_JSON_OUTPUT_FILE", "$inventory"],
    ]);
    expect(inventory?.args).toEqual([
      "--project=production-chromium",
      "--list",
    ]);
    expect(
      missing(
        'if run_child env ATLAS_PRODUCTION_URL="$ORIGIN" pnpm exec playwright test --project=production-chromium; then ok; fi',
      ),
    ).toEqual([{ supplied: ["production"], missing: [] }]);
    // A prefix before the runner is the command's environment too; a runner with no assignment supplies nothing.
    expect(
      missing(
        'ATLAS_PRODUCTION_URL="$ORIGIN" run_child pnpm exec playwright test --project=production-chromium',
      ),
    ).toEqual([{ supplied: ["production"], missing: [] }]);
    for (const source of [
      "run_child pnpm exec playwright test --project=production-chromium",
      "run_child env pnpm exec playwright test --project=production-chromium",
      'run_child env PLAYWRIGHT_JSON_OUTPUT_FILE="$x" pnpm exec playwright test --project=production-chromium',
      'run_child true ATLAS_PRODUCTION_URL="$ORIGIN"; pnpm exec playwright test --project=production-chromium',
    ])
      expect(missing(source), source).toEqual([
        { supplied: [], missing: ["production"] },
      ]);
    // An option of env changes the environment in a way this reader does not model: refused, not guessed.
    for (const source of [
      'run_child env -i ATLAS_PRODUCTION_URL="$ORIGIN" pnpm exec playwright test --project=production-chromium',
      'env -u HOME ATLAS_PRODUCTION_URL="$ORIGIN" pnpm exec playwright test --project=production-chromium',
    ])
      expect(() => runs(`true\n${source}`), source).toThrow(/^probe\.sh:2: /);
  });

  test("a mention it cannot attribute to a run is refused with its location, not guessed", () => {
    for (const source of [
      'echo "now: playwright test"',
      "out=`pnpm exec playwright test --list`",
      "pnpm exec playwright test <<EOF\nEOF",
      'ATLAS_PRODUCTION_URL="$ORIGIN pnpm exec playwright test',
    ])
      expect(() => runs(`true\n${source}`), source).toThrow(/^probe\.sh:2: /);
  });
});
