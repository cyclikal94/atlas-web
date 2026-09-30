import { defineConfig, devices } from "@playwright/test";
import { neededTargets } from "./tests/e2e/targets";

/**
 * Two servers, two projects per browser:
 *  - production: the real production build (dist), the neutral app only.
 *  - fixture: the fixture build (dist-fixture), the shell with the gate lifted. Fixture evidence is never integration evidence.
 * Chromium always runs. Firefox and WebKit run when ATLAS_E2E_BROWSERS=all (CI sets it; browsers are installed with
 * `pnpm exec playwright install firefox webkit`).
 */
// ATLAS_PRODUCTION_URL and ATLAS_FIXTURE_URL point the suite at servers that are already running, for example the image and
// a container serving dist-fixture through the real nginx configuration (scripts/smoke-image.sh). Then no preview server starts.
// A preview server also starts only for a project that the run selects (`--project=...`): a production-only run, as in the image
// and Compose smoke tests on a clean CI job, must not need dist-fixture, and a fixture-only run must not need dist (tests/e2e/targets.ts).
const PRODUCTION = process.env.ATLAS_PRODUCTION_URL ?? "http://127.0.0.1:4173";
const FIXTURE = process.env.ATLAS_FIXTURE_URL ?? "http://127.0.0.1:4174";
const all = process.env.ATLAS_E2E_BROWSERS === "all";

const browsers = [
  { name: "chromium", device: devices["Desktop Chrome"] },
  ...(all
    ? [
        { name: "firefox", device: devices["Desktop Firefox"] },
        { name: "webkit", device: devices["Desktop Safari"] },
      ]
    : []),
];

const projects = browsers.flatMap(({ name, device }) => [
  {
    name: `production-${name}`,
    testMatch: /production\..*\.spec\.ts/,
    use: { ...device, baseURL: PRODUCTION },
  },
  {
    name: `fixture-${name}`,
    testMatch: /fixture\..*\.spec\.ts/,
    use: { ...device, baseURL: FIXTURE },
  },
]);
const needed = neededTargets(
  process.argv,
  projects.map((project) => project.name),
);

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results",
  reporter: "list",
  fullyParallel: false,
  workers: 1,
  use: { trace: "retain-on-failure" },
  projects,
  webServer: [
    ...(process.env.ATLAS_PRODUCTION_URL || !needed.has("production")
      ? []
      : [
          {
            command: "pnpm preview --port 4173 --strictPort",
            url: PRODUCTION,
            reuseExistingServer: false,
          },
        ]),
    ...(process.env.ATLAS_FIXTURE_URL || !needed.has("fixture")
      ? []
      : [
          {
            command: "pnpm preview:fixture --port 4174 --strictPort",
            url: FIXTURE,
            reuseExistingServer: false,
          },
        ]),
  ],
});
