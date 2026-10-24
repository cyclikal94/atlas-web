import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { neededTargets, projectFilters, TARGETS } from "../e2e/targets";

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

describe("the smoke scripts' browser runs need no build they do not have", () => {
  const scripts = readdirSync(resolve(ROOT, "scripts")).filter((file) =>
    file.endsWith(".sh"),
  );
  const invocations = scripts.flatMap((file) =>
    readFileSync(resolve(ROOT, "scripts", file), "utf8")
      // A command continued over several lines (a `\` at the end) is ONE command: its environment can be on the line before.
      .replace(/\\\n/g, " ")
      .split("\n")
      .filter((line) => /playwright test/.test(line))
      .map((line) => ({ file, line })),
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

  test.each(invocations)(
    "$file: every server the run selects is one it supplies by URL",
    ({ line }) => {
      const args = line
        .slice(line.indexOf("playwright test") + "playwright test".length)
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.replace(/^["']|["']$/g, ""));
      const supplied = new Set(
        TARGETS.filter((target) =>
          line.includes(`ATLAS_${target.toUpperCase()}_URL=`),
        ),
      );
      expect(supplied.size).toBeGreaterThan(0);
      for (const target of neededTargets(cli(...args), NAMES))
        expect(
          supplied,
          `the ${target} preview would need dist${target === "fixture" ? "-fixture" : ""} to be built`,
        ).toContain(target);
    },
  );
});
