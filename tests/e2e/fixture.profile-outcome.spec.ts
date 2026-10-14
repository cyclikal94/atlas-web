import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { w4 } from "../../scripts/lib/profile-workloads.mjs";
import {
  bootSession,
  seedSettled,
  startLeader,
  stubNetwork,
  waitForState,
} from "./data-sync-helpers";
import { oneColdRun } from "./profile-cold-run";
import {
  p2SampleProblems,
  readSyncSample,
  selectP2Sample,
  syncSample,
} from "./profile-samples";

/**
 * WEB-09c revision 12 (review 12's R2 follow-up; design assessment DA-C1, DA-M1, DA-M2, Q5): short NATIVE counterparts of the deterministic
 * outcome controls, in Chromium, Firefox and WebKit, through the production engine, its real IndexedDB commit and the stubbed network.
 * The measured page's hold is made to lapse by a LABELLED fixture fault injection (`__fixtureLapseReservations`,
 * src/fixture/data-harness/main.ts): with three lapses every admission round of the page lapses, so the engine traces
 * applied/lease_lapsed, writes nothing, stays running and asks again (the stub then answers an empty page); with one lapse the engine
 * retries within the same request and commits. Production timers, quotas and workloads are unchanged. Not a measurement: no figure here is
 * evidence, and nothing is recorded into a programme.
 */
const W4 = w4();
/** What W4 leaves in an empty cache: 80 surviving rows from its 800 changes (ten rounds over the same 80 ids), at version 10. */
const W4_ROWS = 80;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const W4_DIGEST = sha(
  Array.from(
    { length: W4_ROWS },
    (_, c) =>
      `00000000-0000-4000-8000-${(400_000 + c).toString(16).padStart(12, "0")}@10`,
  )
    .sort()
    .join("\n"),
);

test.describe.configure({ mode: "serial" });

test("cold (P-11 path): a measured page whose every admission lapsed is an error run with the cache untouched; the retry's idle never admits it", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const r = await oneColdRun(
    browser,
    info.project.use.baseURL,
    info.project.name,
    W4,
    { lapseReservations: 3 },
  );
  expect(r.outcome, r.detail).toBe("error");
  expect(r.detail).toMatch(
    /^the measured page was not written \(value lease_lapsed\) and the engine asked again/,
  );
  expect(r.observation?.method).toBe("engine-state-log/3");
  expect(r.observation?.terminal.state.kind).toBe("running");
  expect(r.observation?.commits[0]).toMatchObject({
    kind: "applied",
    value: "lease_lapsed",
    bytes: Buffer.byteLength(W4),
  });
  expect(r.effects).toEqual({
    method: "cache-rows/1",
    rows: 0,
    entries_sha256: sha(""),
  });
});

test("cold (P-11 path): one lapsed admission round retried within the request commits; the run is admitted and W4 leaves 80 rows, not 800", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  for (const lapses of [1, 0]) {
    const r = await oneColdRun(
      browser,
      info.project.use.baseURL,
      info.project.name,
      W4,
      { lapseReservations: lapses },
    );
    expect(r.outcome, `${lapses}: ${r.detail}`).toBe("admitted");
    expect(r.observation?.commits[0]).toMatchObject({
      kind: "applied",
      value: "committed",
    });
    expect(r.effects).toEqual({
      method: "cache-rows/1",
      rows: W4_ROWS,
      entries_sha256: W4_DIGEST,
    });
  }
});

test("P-2 and P-4 selectors: a lapsed sample is refused as no written page; healthy samples are one committed page ending idle, with one /sync request", async ({
  context,
}) => {
  test.setTimeout(180_000);
  const net = await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await startLeader(page);
  await waitForState(page, "idle");
  const body = W4;
  const bytes = Buffer.byteLength(body);
  for (const lapses of [3, 0]) {
    await page.evaluate(() => performance.clearResourceTimings());
    net.script.push(() => ({ status: 200, body }));
    const before = await page.evaluate((n) => {
      (
        globalThis as { __fixtureLapseReservations?: number }
      ).__fixtureLapseReservations = n;
      return (window.__atlasData?.engineTrace ?? []).length;
    }, lapses);
    await page.evaluate(() => window.__atlasData?.nudgeSync());
    const support = await (
      await page.waitForFunction(selectP2Sample, before, {
        timeout: 60_000,
        polling: 10,
      })
    ).jsonValue();
    const problems = p2SampleProblems(support as never, bytes);
    if (lapses) {
      expect(problems[0]).toBe(
        "its commit wrote no page (applied/lease_lapsed)",
      );
      // The retry's empty page then commits and the engine goes idle: the next sample starts from there.
      await waitForState(page, "idle");
      continue;
    }
    expect(problems).toEqual([]);
    const read = await (
      await page.waitForFunction(readSyncSample, before, {
        timeout: 60_000,
        polling: 10,
      })
    ).jsonValue();
    const { problem } = syncSample(read as never);
    expect(problem).toBeNull();
  }
});
