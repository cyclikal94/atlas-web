import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { denseChecklistPage } from "../../scripts/lib/profile-workloads.mjs";
import { expect, test } from "./helpers";

/**
 * The device page's W2 route (`/profile-harness`, fixture only; review finding R3): the operator picks the capture file once, the page
 * keeps it on the origin, and every W2 run reads it back, hashes what it read, runs it through the production processing path and records
 * what it ran. These are the desktop CONTROLS of that exact path in Chromium, Firefox and WebKit, not measurements and not a device run.
 * The bytes are a STAND-IN: a 200-change dense checklist page from the workload generator, where an operator picks the hand-over's real W2
 * capture (the profiling programme's `device` stage runs the whole protocol with the released backend's capture;
 * docs/profiling-devices.md).
 */
const STAND_IN = Buffer.from(denseChecklistPage(200));
const SHA = createHash("sha256").update(STAND_IN).digest("hex");
const NAME = "W2-captured.stand-in.limit-1.json";

interface Run {
  workload: string;
  run: number;
  expected: string;
  outcome: string;
  sha256: string;
  sha256_verified: boolean;
  source?: string;
  bytes: number;
  request_count: number;
}

/** Picks the capture on the page, as an operator does: the page reports what it kept. */
async function pick(page: Page): Promise<void> {
  await page.goto("/profile-harness");
  await page.setInputFiles("#w2-capture", {
    name: NAME,
    mimeType: "application/json",
    buffer: STAND_IN,
  });
  await expect(page.locator("#profile-status")).toHaveText(
    `W2 capture kept: ${NAME}, ${STAND_IN.length} bytes, SHA-256 ${SHA}`,
  );
}

async function oneRun(page: Page, w2sha256: string): Promise<Run[]> {
  await page.goto(`/profile-harness?w=W2&run=1&w2sha256=${w2sha256}`);
  await expect(page.locator("#profile-status")).toContainText("W2 run 1:", {
    timeout: 120_000,
  });
  return page.evaluate(
    () =>
      (
        JSON.parse(localStorage.getItem("atlas-profile-results") ?? "null") as {
          runs: Run[];
        }
      ).runs,
  );
}

test("control: the picked W2 capture is kept, read back, verified against the SHA-256 the URL names and run through the production path", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await pick(page);
  const runs = await oneRun(page, SHA);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    workload: "W2",
    run: 1,
    expected: "admitted",
    outcome: "admitted",
    sha256: SHA,
    sha256_verified: true,
    source: NAME,
    bytes: STAND_IN.length,
    request_count: 1,
  });
  // Every link of the page keeps the capture: the protocol, and the next single run of W2.
  await expect(page.getByRole("link", { name: /W2 included/ })).toHaveAttribute(
    "href",
    `?protocol=1&w2sha256=${SHA}`,
  );
  await expect(
    page.getByRole("link", { name: "W2", exact: true }),
  ).toHaveAttribute("href", `?w=W2&run=2&w2sha256=${SHA}`);
});

test("case: bytes that are not the named capture are recorded with their own hash and NOT verified", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await pick(page);
  const runs = await oneRun(page, "0".repeat(64));
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    workload: "W2",
    sha256: SHA,
    sha256_verified: false,
  });
});

test("case: a W2 run with no capture kept is an error run, and nothing stands in for the capture", async ({
  page,
}) => {
  const runs = await oneRun(page, SHA);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    workload: "W2",
    outcome: "error",
    sha256: "",
    sha256_verified: false,
    bytes: 0,
    request_count: 0,
  });
});

test("case: without a named capture the protocol has no W2, and the page says so", async ({
  page,
}) => {
  await page.goto("/profile-harness");
  await expect(
    page.getByRole("link", { name: /NO W2: choose the capture/ }),
  ).toHaveAttribute("href", "?protocol=1");
  await expect(page.getByRole("link", { name: "W2", exact: true })).toHaveCount(
    0,
  );
});
