import { defineConfig, devices } from "@playwright/test";
import { configureEvidenceRun } from "./tests/e2e/evidence-run";
import { PARALLEL_UI } from "./tests/e2e/scheduling";
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

// ATLAS_INTEGRATION_URL is set by scripts/integration/run.mjs only: the specs in tests/integration run against the RELEASED backend
// behind the delaying proxy. Without it they skip themselves and are reported as not run, so `pnpm test:e2e` is unaffected.
const INTEGRATION = process.env.ATLAS_INTEGRATION_URL ?? "http://127.0.0.1:9";

const lane = process.env.ATLAS_E2E_LANE;
if (lane && !["parallel-ui", "serial"].includes(lane))
  throw new Error("Unknown ATLAS_E2E_LANE");
const requestedWorkers = Number(process.env.ATLAS_E2E_WORKERS ?? "1");
if (![1, 2, 3, 4].includes(requestedWorkers))
  throw new Error("ATLAS_E2E_WORKERS must be 1..4");

const projects = browsers.flatMap(({ name, device }) => [
  {
    name: `production-${name}`,
    testMatch: lane === "parallel-ui" ? /$a/ : /production\..*\.spec\.ts/,
    use: { ...device, baseURL: PRODUCTION },
  },
  {
    name: `fixture-${name}`,
    testMatch: lane === "parallel-ui" ? PARALLEL_UI : /fixture\..*\.spec\.ts/,
    ...(lane === "serial" ? { testIgnore: PARALLEL_UI } : {}),
    use: { ...device, baseURL: FIXTURE },
  },
  {
    name: `integration-${name}`,
    testDir: "./tests/integration",
    testMatch: lane === "parallel-ui" ? /$a/ : /integration\..*\.spec\.ts/,
    use: { ...device, baseURL: INTEGRATION },
  },
]);
const needed = neededTargets(
  process.argv,
  projects.map((project) => project.name),
);

const browserEvidenceRun = configureEvidenceRun();

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: `${browserEvidenceRun}/test-results`,
  metadata: { atlasEvidenceRun: browserEvidenceRun },
  globalSetup: "./tests/e2e/evidence-run.ts",
  reporter: "list",
  fullyParallel: false,
  workers: lane === "parallel-ui" ? requestedWorkers : 1,
  use: { trace: "retain-on-failure" },
  projects,
  webServer: [
    ...(process.env.ATLAS_PRODUCTION_URL || !needed.has("production")
      ? []
      : [
          {
            // The production app asks the server for its API version at boot; a stub backend answers it (scripts/preview-with-stub-backend.mjs).
            command: "node scripts/preview-with-stub-backend.mjs --port 4173",
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
