import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  draftWitnessSelection,
  syncWitnessSelection,
} from "../../scripts/lib/profile-sample-rules.mjs";
import { w4 } from "../../scripts/lib/profile-workloads.mjs";
import {
  ACCOUNT,
  bootSession,
  seedSettled,
  startLeader,
  startOutbox,
  stubNetwork,
  waitForState,
} from "./data-sync-helpers";
import { oneColdRun } from "./profile-cold-run";
import {
  collectDraftSamples,
  collectSyncSamples,
  type DraftWitness,
  p2SampleProblems,
  prepareSyncSample,
  readSyncSample,
  type SyncMark,
  type SyncWitness,
  samplePageOf,
  selectP2Sample,
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
  }
  // Revision 13: the P-4/P-10 collector (one mark per sample, its bounded witness and the shared rule) over the real engine and its
  // real ResourceTiming entries.
  const c = await collectSyncSamples(samplePageOf(page), {
    warmup: 1,
    samples: 3,
    timeout: 60_000,
    polling: 10,
  });
  expect(c.failure).toBeNull();
  expect(c.samples.map((e) => [e.index, e.resources.length])).toEqual([
    [1, 1],
    [2, 1],
    [3, 1],
  ]);
});

/**
 * WEB-09c revision 13 (review 13 R2; design assessment DA-R2-A/DA-N1, Q7): the request-association schedules natively, in Chromium, Firefox
 * and WebKit, through the production engine and dispatcher, their real ResourceTiming entries and the stubbed network. The no-request
 * step is the engine's own offline gate (`navigator.onLine` overridden to false, no event: the step publishes waiting and ends with no
 * request), then the browser's `online` event resumes it; the lapsed step is the labelled fixture fault seam above; the restart is the
 * harness's `restartSync`; the draft's first request is aborted by the stub (a lost connection) and the dispatcher's paced retry sends
 * again. Production timers are unchanged. Not a measurement: nothing is recorded into a programme.
 */
const markAndRead = async (
  page: import("@playwright/test").Page,
): Promise<{ mark: SyncMark; witness: SyncWitness }> => {
  const mark = (await (
    await page.waitForFunction(prepareSyncSample, undefined, {
      timeout: 60_000,
      polling: 10,
    })
  ).jsonValue()) as SyncMark;
  const witness = (await (
    await page.waitForFunction(
      readSyncSample,
      { mark, force: false },
      { timeout: 60_000, polling: 10 },
    )
  ).jsonValue()) as SyncWitness;
  return { mark, witness };
};
const setOnline = (page: import("@playwright/test").Page, on: boolean) =>
  page.evaluate((online) => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => online,
    });
    if (online) window.dispatchEvent(new Event("online"));
  }, on);

test("P-4/P-10 natively: a step that ended with no request is the sample's failure, also on a late read; a lapsed step is a complete latency sample; an engine restart since the mark is refused", async ({
  context,
}) => {
  test.setTimeout(180_000);
  const net = await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await startLeader(page);
  await waitForState(page, "idle");
  // (1) Offline, no event: the nudged step publishes waiting and ends without a request.
  await setOnline(page, false);
  const offline = await markAndRead(page);
  const problem = syncWitnessSelection(offline.witness).problem;
  expect(problem).toMatch(
    /^the sample's step ended without a commit \(\d+ms data\.sync_next \{"when":"event","state":"waiting"\}\): no later step can stand for it$/,
  );
  expect(offline.witness.resources).toEqual([]);
  // The browser comes back: the next step requests and commits. A late read of the whole history is still that failure.
  const requests = net.requests.length;
  await setOnline(page, true);
  await waitForState(page, "idle");
  await expect.poll(() => net.requests.length).toBeGreaterThan(requests);
  const late = (await page.evaluate(readSyncSample, {
    mark: offline.mark,
    force: true,
  })) as SyncWitness;
  expect(late.lines.some((l) => l.includes("data.sync_commit"))).toBe(true);
  expect(late.resources.length).toBeGreaterThan(0);
  expect(syncWitnessSelection(late).problem).toBe(problem);
  // (2) A lapsed hold: the step commits applied/lease_lapsed (nothing written) and ends running: one complete latency sample.
  const body = W4;
  net.script.push(() => ({ status: 200, body }));
  await page.evaluate(() => {
    (
      globalThis as { __fixtureLapseReservations?: number }
    ).__fixtureLapseReservations = 3;
  });
  const lapsed = await markAndRead(page);
  const s = syncWitnessSelection(lapsed.witness);
  expect(s.status, String(s.problem)).toBe("complete");
  expect(
    lapsed.witness.lines[(s.selected?.commit ?? 0) - lapsed.mark.from],
  ).toContain('"value":"lease_lapsed"');
  expect(
    lapsed.witness.lines[(s.selected?.end ?? 0) - lapsed.mark.from],
  ).toContain('"state":"running"');
  await waitForState(page, "idle");
  // (3) An engine started again between the mark and the read.
  const mark = (await (
    await page.waitForFunction(prepareSyncSample, undefined, {
      timeout: 60_000,
      polling: 10,
    })
  ).jsonValue()) as SyncMark;
  await page.evaluate(() => window.__atlasData?.restartSync());
  const restarted = (await (
    await page.waitForFunction(
      readSyncSample,
      { mark, force: false },
      { timeout: 60_000, polling: 10 },
    )
  ).jsonValue()) as SyncWitness;
  expect(syncWitnessSelection(restarted).problem).toBe(
    "the engine was started again during the sample",
  );
});

test("P-4 draft natively: healthy drafts are one send, its answer and its request; a draft whose first request was aborted and sent again fails as sent again", async ({
  context,
}) => {
  test.setTimeout(180_000);
  const net = await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  // Revision 14: the dispatcher is observed (the completion is its own admitted receipt).
  await startOutbox(page, ACCOUNT, { observeDispatch: true });
  const options = {
    timeout: 30_000,
    polling: 10,
    account: ACCOUNT,
    person: () => crypto.randomUUID(),
  };
  const healthy = await collectDraftSamples(samplePageOf(page), {
    ...options,
    warmup: 1,
    samples: 2,
  });
  expect(healthy.failure).toBeNull();
  expect(healthy.samples.map((e) => [e.index, e.resources.length])).toEqual([
    [1, 1],
    [2, 1],
  ]);
  // Revision 14: each sample is closed by the real dispatcher's claim, keyed request and admitted receipt of its own draft, with the row
  // read through the bound service.
  for (const e of healthy.samples) {
    expect(
      e.records.map((r) => [r.event, r.plan ?? r.path, r.local_id ?? r.key]),
    ).toEqual([
      ["commit_begin", "data.markInFlight", e.local_id],
      ["commit_end", "data.markInFlight", e.local_id],
      ["request_begin", "/api/experimental/v1/commands", e.local_id],
      ["request_end", "/api/experimental/v1/commands", e.local_id],
      ["commit_begin", "data.admitReceipt", e.local_id],
      ["commit_end", "data.admitReceipt", e.local_id],
    ]);
    expect(e.records[5]).toMatchObject({ outer: "applied", inner: "admitted" });
    expect(e.completion.row).toMatchObject({
      kind: "row",
      status: "acknowledged",
    });
  }
  net.commandScript.push(() => ({ abort: true }));
  const aborted = await collectDraftSamples(samplePageOf(page), {
    ...options,
    warmup: 0,
    samples: 1,
  });
  expect(aborted.values).toEqual([]);
  expect(aborted.failure?.problem).toBe(
    "the draft was sent again before an answer: a first attempt that got no answer cannot donate its send",
  );
});

/**
 * WEB-09c revision 14 (review 14 R2; design assessment DA-R14-A/B/C, Q8): the draft sample's completion natively, in Chromium, Firefox and
 * WebKit, through the production dispatcher, its real IndexedDB transactions and real ResourceTiming, with the stubbed network. The
 * schedules use LABELLED fixture seams only (src/fixture/data-harness/main.ts and dispatch-observer.ts): `gateDispatchCommit` holds the
 * dispatcher's receipt call before its transaction is admitted; `holdOutboxPlan("data.admitReceipt")` lets the transaction complete and
 * holds its delivery; `failOutboxPlan("data.admitReceipt", 1)` makes the real receipt transaction abort; `failDraftReads(1)` makes the
 * completion read's real transaction abort. Production timers and back-off are unchanged (the retry after a failed receipt is the
 * dispatcher's own). Not a measurement: nothing is recorded into a programme.
 */
test("P-4 draft natively (revision 14): a receipt not yet admitted or not yet delivered is pending, never complete; a failed receipt transaction is the sample's failure though the dispatcher's own retry later acknowledges the draft; a failed completion read, a rebuilt dispatcher, another writer's draft and a reload never complete a sample", async ({
  context,
}) => {
  test.setTimeout(240_000);
  await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  // Another tab of the account, booted before the measured outbox starts (a later boot runs the session check in this page), with an
  // outbox of its own that never dispatches (`start: false`): it saves drafts through the product facade into the shared database.
  const other = await bootSession(context);
  await other.evaluate(
    (a) => window.__atlasData?.startOutbox(a, { start: false }),
    ACCOUNT,
  );
  await startOutbox(page, ACCOUNT, { observeDispatch: true });
  const sampler = samplePageOf(page);
  const options = {
    timeout: 30_000,
    polling: 10,
    account: ACCOUNT,
    person: () => crypto.randomUUID(),
    warmup: 0,
    samples: 1,
  };
  const data = <R>(fn: () => R) => page.evaluate(fn);
  const settledQueue = async () => {
    await expect
      .poll(() =>
        page.evaluate(async (a) => {
          const rows = (await window.__atlasData?.queue(a)) ?? [];
          return rows.filter(
            (r) => r.status === "queued" || r.status === "in_flight",
          ).length;
        }, ACCOUNT),
      )
      .toBe(0);
  };
  const witnessOf = (c: { failure: { witness: unknown } | null }) =>
    c.failure?.witness as DraftWitness;
  // A healthy sample first: the observed path works on this page.
  const first = await collectDraftSamples(sampler, options);
  expect(first.failure).toBeNull();

  // (1) The receipt call gated BEFORE its transaction is admitted: pending at the time-out (never complete); released, the dispatcher
  // admits it and the next sample is healthy again.
  await data(() => window.__atlasData?.gateDispatchCommit("data.admitReceipt"));
  const notAdmitted = await collectDraftSamples(sampler, {
    ...options,
    timeout: 3_000,
  });
  expect(notAdmitted.values).toEqual([]);
  expect(notAdmitted.failure?.problem).toBe(
    "the draft's receipt transaction has not been admitted yet within 3000 ms",
  );
  expect(witnessOf(notAdmitted).records.map((r) => r.event)).toEqual([
    "commit_begin",
    "commit_end",
    "request_begin",
    "request_end",
    "commit_gated",
  ]);
  expect(await data(() => window.__atlasData?.dispatchCommitGated())).toBe(
    true,
  );
  await data(() => window.__atlasData?.releaseDispatchCommit());
  await settledQueue();

  // (2) Gated, then released while the collector waits: the sample completes on the admitted receipt that followed the release.
  await data(() => window.__atlasData?.gateDispatchCommit("data.admitReceipt"));
  const waiting = collectDraftSamples(sampler, options);
  await expect
    .poll(() => data(() => window.__atlasData?.dispatchCommitGated()))
    .toBe(true);
  await data(() => window.__atlasData?.releaseDispatchCommit());
  const released = await waiting;
  expect(released.failure).toBeNull();
  expect(released.samples[0]?.records.map((r) => r.event)).toEqual([
    "commit_begin",
    "commit_end",
    "request_begin",
    "request_end",
    "commit_gated",
    "commit_begin",
    "commit_end",
  ]);

  // (3) The transaction completes but its delivery is held: pending at the time-out; released, nothing of it is taken back.
  await data(() => window.__atlasData?.holdOutboxPlan("data.admitReceipt"));
  const undelivered = await collectDraftSamples(sampler, {
    ...options,
    timeout: 3_000,
  });
  expect(undelivered.failure?.problem).toBe(
    "the draft's receipt transaction has not completed within 3000 ms",
  );
  expect(witnessOf(undelivered).records.at(-1)).toMatchObject({
    event: "commit_begin",
    plan: "data.admitReceipt",
  });
  await data(() => window.__atlasData?.releaseOutboxPlan());
  await settledQueue();

  // (4) The receipt's REAL transaction aborts: the sample fails at that result; the dispatcher's own paced retry then resends the same
  // draft and admits it (observed, never borrowed).
  await data(() => window.__atlasData?.failOutboxPlan("data.admitReceipt", 1));
  const failed = await collectDraftSamples(sampler, options);
  expect(failed.values).toEqual([]);
  expect(failed.failure?.problem).toBe(
    "the draft's receipt transaction was not applied (failed/abort)",
  );
  const failedId = witnessOf(failed).local_id;
  await settledQueue();
  const after = await data(() => window.__atlasData?.dispatchLog ?? []);
  const own = after.filter((r) => (r.local_id ?? r.key) === failedId);
  expect(own.filter((r) => r.event === "request_begin")).toHaveLength(2);
  expect(own.at(-1)).toMatchObject({
    event: "commit_end",
    plan: "data.admitReceipt",
    outer: "applied",
    inner: "admitted",
  });
  expect(
    after.some(
      (r) =>
        r.event === "write_begin" && r.plan === "data.recordLocalWriteOutcome",
    ),
  ).toBe(true);

  // (5) The completion read's real transaction aborts: a recorded read failure, never absence.
  await data(() => window.__atlasData?.failDraftReads(1));
  const unreadable = await collectDraftSamples(sampler, options);
  expect(unreadable.values).toEqual([]);
  expect(unreadable.failure?.problem).toMatch(/^the completion read failed: /);
  expect(witnessOf(unreadable).completion.row.kind).toBe("error");
  await settledQueue();

  // (6) Another writer's draft during the sample (the other tab saves one while the receipt is gated).
  await data(() => window.__atlasData?.gateDispatchCommit("data.admitReceipt"));
  const interfered = collectDraftSamples(sampler, options);
  await expect
    .poll(() => data(() => window.__atlasData?.dispatchCommitGated()))
    .toBe(true);
  const written = await other.evaluate(
    (x) =>
      window.__atlasData?.enqueue({
        endpoint: "/commands",
        targets: [
          {
            resourceId: x.person,
            role: "primary",
            basis: "resource",
            versionChecked: false,
            seedIfUntracked: 1,
          },
        ],
        command: {
          commands: [
            { kind: "create_person", id: x.person, name: "other tab" },
          ],
        },
      }),
    { person: crypto.randomUUID() },
  );
  expect(written).toMatchObject({ kind: "queued" });
  await data(() => window.__atlasData?.releaseDispatchCommit());
  const intruded = await interfered;
  console.log(`(6) observed: ${intruded.failure?.problem}`);
  expect(intruded.values).toEqual([]);
  expect(intruded.failure?.problem).toMatch(
    /^(another draft was waiting at the completion read|another draft's dispatch \(data\.markInFlight\) was recorded during the sample)$/,
  );
  await settledQueue();

  // (7) The dispatcher is rebuilt while the receipt's delivery is held; the old result is delivered after: never the sample's.
  await data(() => window.__atlasData?.holdOutboxPlan("data.admitReceipt"));
  const rebuilt = collectDraftSamples(sampler, options);
  await expect
    .poll(() => data(() => window.__atlasData?.outboxPlanHeld()))
    .toBe(true);
  await data(() => window.__atlasData?.rebindOutbox());
  await data(() => window.__atlasData?.releaseOutboxPlan());
  const replaced = await rebuilt;
  console.log(`(7) observed: ${replaced.failure?.problem}`);
  expect(replaced.values).toEqual([]);
  expect(replaced.failure?.problem).toMatch(
    /^the dispatcher was rebuilt, restarted or stopped during the sample \(before the completion read: /,
  );
  await settledQueue();

  // (8) The page reloads while the receipt's delivery is held: the sample fails, whichever read meets the new page first.
  await data(() => window.__atlasData?.holdOutboxPlan("data.admitReceipt"));
  const reloading = collectDraftSamples(sampler, options);
  await expect
    .poll(() => data(() => window.__atlasData?.outboxPlanHeld()))
    .toBe(true);
  await page.reload();
  const reloaded = await reloading;
  console.log(`(8) observed: ${reloaded.failure?.problem}`);
  expect(reloaded.values).toEqual([]);
  expect(reloaded.failure?.problem).toMatch(
    /^(the page was reloaded or replaced during the sample \(|the sample's completion could not be read \()/,
  );
  // Whatever the failure, the witness that was read is kept, and no draft of it is selected.
  const w = reloaded.failure?.witness as DraftWitness | null;
  if (w?.completion) expect(draftWitnessSelection(w).status).toBe("invalid");
});
