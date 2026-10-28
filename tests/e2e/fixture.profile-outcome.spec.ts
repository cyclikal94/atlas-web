import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  COMMANDS_PATH,
  draftWitnessSelection,
  p2IterationSelection,
  SYNC_PATH,
  syncWitnessSelection,
} from "../../scripts/lib/profile-sample-rules.mjs";
import {
  denseChecklistPage,
  ordinaryPage,
  w4,
} from "../../scripts/lib/profile-workloads.mjs";
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
import { p2PortOf } from "./profile-p2-port";
import {
  collectDraftSamples,
  collectP2Iterations,
  collectSyncSamples,
  type DraftWitness,
  markP2Iteration,
  nudgeP2Iteration,
  type P2Port,
  type P2Shape,
  prepareDraftSample,
  prepareSyncSample,
  readDraftSample,
  readP2Iteration,
  readSyncSample,
  type SamplePage,
  type SyncMark,
  type SyncWitness,
  samplePageOf,
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
  // REVISION 18 ADAPTATION (labelled; review 18 R18-P2): revision 12's `selectP2Sample`/`p2SampleProblems` are replaced by the writer's
  // page functions and the shared iteration rule; the schedule (three lapses, then none, on the same page) and its intent are unchanged.
  const port = p2PortOf(page, net);
  for (const lapses of [3, 0]) {
    await page.evaluate(() => performance.clearResourceTimings());
    const mark = await port.run(markP2Iteration, null);
    if (!mark) throw new Error("no data harness");
    const served = port.enqueue(body);
    await page.evaluate((n) => {
      (
        globalThis as { __fixtureLapseReservations?: number }
      ).__fixtureLapseReservations = n;
    }, lapses);
    await port.run(nudgeP2Iteration, null);
    const read = await port.poll(
      readP2Iteration,
      { mark, force: false },
      { timeout: 60_000, polling: 10 },
    );
    const s = p2IterationSelection(
      { ...read, served: served.served(), pending: port.pending() },
      bytes,
    );
    if (lapses) {
      expect(s.problem).toBe("its commit wrote no page (applied/lease_lapsed)");
      // The retry's empty page then commits and the engine goes idle: the next sample starts from there.
      await waitForState(page, "idle");
      continue;
    }
    expect(s.status, String(s.problem)).toBe("complete");
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
  // Revision 16 (review 16 R16-SYNC, design assessment DA16-S1/S2, Q7): the real writer stores the exact pathname; its mark and read
  // enclose every retained line (within the trace's 1 ms rounding) and entry (the same unrounded clock); lines never go back; each mark
  // follows the previous read in position and time.
  for (const [k, e] of c.samples.entries()) {
    expect(e.resources.map((r) => r.name)).toEqual([SYNC_PATH]);
    expect(e.mark.at).toBeLessThanOrEqual(e.read.at);
    const times = e.lines.map((l) => Number(l.split("ms")[0]));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const ms of times) {
      expect(ms).toBeGreaterThanOrEqual(e.mark.at - 1);
      expect(ms).toBeLessThanOrEqual(e.read.at + 1);
    }
    for (const r of e.resources) {
      expect(r.startTime).toBeGreaterThanOrEqual(e.mark.at);
      expect(r.responseEnd).toBeLessThanOrEqual(e.read.at);
    }
    const previous = c.samples[k - 1];
    if (previous) {
      expect(e.mark.from).toBeGreaterThanOrEqual(previous.read.to);
      expect(e.mark.at).toBeGreaterThanOrEqual(previous.read.at);
    }
  }
  // LABELLED CONSUMER-INTEGRITY COPIES (not a writer's output): review 16's contradictions applied to a copy of a REAL witness are refused;
  // the unedited copy is complete.
  const real = c.samples[0];
  if (!real) throw new Error("no sample");
  const copy = (edit: (w: SyncWitness) => void) => {
    const w = structuredClone(real) as SyncWitness;
    edit(w);
    return syncWitnessSelection(w);
  };
  expect(copy(() => {}).status).toBe("complete");
  expect(
    copy((w) => {
      w.read.at = w.mark.at - 1000;
    }).problem,
  ).toBe("its read is timed before its mark");
  expect(
    copy((w) => {
      delete (w.mark as { at?: number }).at;
      delete (w.read as { at?: number }).at;
    }).problem,
  ).toBe("its mark records no finite, non-negative page time");
  expect(
    copy((w) => {
      const i = real.selected.end - w.mark.from;
      w.lines[i] = (w.lines[i] ?? "").replace(/^-?\d+ms/, "1ms");
    }).problem,
  ).toMatch(/^a trace line \(\d+\) precedes the sample's mark$/);
  expect(
    copy((w) => {
      const r = w.resources[0];
      if (r) r.name = "/not-sync";
    }).problem,
  ).toBe("a retained request entry is not the /sync endpoint (/not-sync)");
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

/**
 * Revision 18 (review 18 R18-P2, design assessment schedule matrix rows 1-5): the P-2 writer's own collector and port over the real engine.
 * Short LABELLED schedules (two ordinary-100 warm-ups and two samples, then one dense-100 warm-up and sample): they qualify the control
 * flow, never a measurement. The lapses are the labelled fixture fault (`__fixtureLapseReservations`), set before the chosen iteration's
 * nudge: one lapse per iteration is retried within its request (valid); three exhaust its rounds (applied/lease_lapsed, the engine asks
 * again and its empty retry reaches idle), which must stop the collection AT that iteration, warm-up or not, later shape included.
 */
test("P-2 collector natively (revision 18): healthy and one-lapse iterations complete; three lapses at the first warm-up, a measured iteration or the later shape's warm-up stop the collection there, with nothing further queued", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const net = await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await startLeader(page);
  await waitForState(page, "idle");
  let round = 1_000;
  const shapes = (): P2Shape[] => {
    round += 10;
    const base = round;
    return [
      {
        name: "ordinary-100",
        body: (i) => ordinaryPage(100, base + i),
        warmup: 2,
        samples: 2,
      },
      {
        name: "dense-100",
        body: () => denseChecklistPage(100),
        warmup: 1,
        samples: 1,
      },
    ];
  };
  const lapsing = (lapses: Record<number, number>) => {
    const base = p2PortOf(page, net);
    let nudges = 0;
    const port: P2Port = {
      ...base,
      run: async (fn, arg) => {
        if ((fn as unknown) === nudgeP2Iteration) {
          const n = lapses[nudges] ?? 0;
          nudges += 1;
          if (n)
            await page.evaluate((k) => {
              (
                globalThis as { __fixtureLapseReservations?: number }
              ).__fixtureLapseReservations = k;
            }, n);
        }
        return base.run(fn, arg);
      },
    };
    return { port, nudges: () => nudges };
  };
  const options = { longTasks: false, timeout: 60_000, polling: 10 };
  for (const lapses of [{}, { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 }] as Record<
    number,
    number
  >[]) {
    const p = lapsing(lapses);
    const c = await collectP2Iterations(p.port, shapes(), options);
    expect(c.failure, JSON.stringify(c.failure)).toBeNull();
    expect(c.iterations.map((e) => [e.shape, e.index])).toEqual([
      ["ordinary-100", 0],
      ["ordinary-100", 1],
      ["ordinary-100", 2],
      ["ordinary-100", 3],
      ["dense-100", 0],
      ["dense-100", 1],
    ]);
    expect(c.series["ordinary-100"]?.scan).toHaveLength(2);
    expect(c.series["dense-100"]?.commit).toHaveLength(1);
    expect(p.nudges()).toBe(6);
    expect(net.script).toHaveLength(0);
  }
  for (const [at, shape, index, warmup] of [
    [0, "ordinary-100", 0, true],
    [2, "ordinary-100", 2, false],
    [4, "dense-100", 0, true],
  ] as const) {
    const p = lapsing({ [at]: 3 });
    const c = await collectP2Iterations(p.port, shapes(), options);
    expect(c.failure).toMatchObject({
      shape,
      index,
      warmup,
      phase: "selection",
      problem: "its commit wrote no page (applied/lease_lapsed)",
    });
    expect(c.iterations).toHaveLength(at);
    // No further body was queued and no further nudge sent after the failed iteration.
    expect(p.nudges()).toBe(at + 1);
    expect(net.script).toHaveLength(0);
    const w = c.failure?.witness as { served: number; lines: string[] };
    expect(w.served).toBe(1);
    await waitForState(page, "idle");
  }
});

/**
 * Revision 19 (review 19 R19-P2, design assessment C2, Q11): the same short LABELLED schedules through the writer's collector and port.
 * The healthy collection's retained witnesses are checked here against the page's own trace by hand (every line non-negative, in order
 * and inside its mark and read within the trace's 1 ms rounding), independently of the shared rule. The faults are review 19's corrected
 * native edit, made on the page read the collector receives: its read time set to its mark's. Each fault is counted and proved effective
 * (the retained commit lies more than the rounding after the claimed read); it is made at the first warm-up and the first measured
 * iteration through the normal poll, and at the last measured ordinary iteration through the forced read the collector takes when the
 * poll fails. Each must stop the collection AT that iteration, with nothing further queued. Not a measurement.
 */
test("P-2 collector natively (revision 19): healthy witnesses lie inside their observations; a read edited to its mark, by the poll at the first warm-up or a measured iteration or by the forced read, stops the collection there", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const net = await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await startLeader(page);
  await waitForState(page, "idle");
  let round = 2_000;
  const shapes = (): P2Shape[] => {
    round += 10;
    const base = round;
    return [
      {
        name: "ordinary-100",
        body: (i) => ordinaryPage(100, base + i),
        warmup: 2,
        samples: 2,
      },
      {
        name: "dense-100",
        body: () => denseChecklistPage(100),
        warmup: 1,
        samples: 1,
      },
    ];
  };
  const options = { longTasks: false, timeout: 60_000, polling: 10 };
  const msOf = (line: string) => Number(/^(-?\d+)ms /.exec(line)?.[1]);
  type Read = {
    mark: { from: number; at: number };
    read: { to: number; at: number };
    lines: string[];
  };
  const injecting = (at: number, path: "poll" | "run") => {
    const base = p2PortOf(page, net);
    let reads = 0;
    let nudges = 0;
    const edits: Array<{ read_at: number; commit_ms: number }> = [];
    const edit = (r: Read | null) => {
      if (!r) return r;
      reads += 1;
      if (reads - 1 !== at) return r;
      const x = { ...r, read: { ...r.read, at: r.mark.at } };
      const commit = x.lines.find(
        (l) => l.split(" ")[1] === "data.sync_commit",
      );
      const commitMs = msOf(commit ?? "");
      // The fault took effect beyond the trace's rounding: the retained commit is after the claimed read.
      expect(commitMs - x.read.at).toBeGreaterThan(1);
      edits.push({ read_at: x.read.at, commit_ms: commitMs });
      return x;
    };
    const port: P2Port = {
      ...base,
      poll: async (fn, arg, o) => {
        if (path === "run") throw new Error("injected: the poll timed out");
        return edit((await base.poll(fn, arg, o)) as Read | null) as never;
      },
      run: async (fn, arg) => {
        if ((fn as unknown) === nudgeP2Iteration) nudges += 1;
        const r = await base.run(fn, arg);
        return (
          (fn as unknown) === readP2Iteration ? edit(r as Read | null) : r
        ) as never;
      },
    };
    return { port, edits, nudges: () => nudges, reads: () => reads };
  };
  // Healthy: the shared rule accepted every iteration; the page's own trace corroborates each witness by hand.
  const healthy = injecting(-1, "poll");
  const c = await collectP2Iterations(healthy.port, shapes(), options);
  expect(c.failure, JSON.stringify(c.failure)).toBeNull();
  expect(c.iterations).toHaveLength(6);
  expect(healthy.edits).toHaveLength(0);
  const trace = (await page.evaluate(
    () => window.__atlasData?.engineTrace ?? [],
  )) as string[];
  const margins: Array<{ before: number; after: number }> = [];
  for (const e of c.iterations) {
    const times = trace.slice(e.mark.from, e.read.to).map(msOf);
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((t) => Number.isFinite(t) && t >= 0)).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    margins.push({
      before: Math.min(...times) - e.mark.at,
      after: e.read.at - Math.max(...times),
    });
  }
  expect(margins.every((m) => m.before >= -1 && m.after >= -1)).toBe(true);
  test.info().annotations.push({
    type: "p2-healthy-margins",
    description: JSON.stringify(margins),
  });
  for (const [at, path, shape, index, warmup] of [
    [0, "poll", "ordinary-100", 0, true],
    [2, "poll", "ordinary-100", 2, false],
    [3, "run", "ordinary-100", 3, false],
  ] as const) {
    const p = injecting(at, path);
    const f = await collectP2Iterations(p.port, shapes(), options);
    expect(p.edits, `${path} ${at}`).toHaveLength(1);
    expect(p.reads()).toBe(at + 1);
    expect(f.failure).toMatchObject({
      shape,
      index,
      warmup,
      phase: "selection",
    });
    expect(f.failure?.problem).toMatch(
      /^a trace line \(\d+\) follows the sample's read$/,
    );
    expect(f.iterations).toHaveLength(at);
    const w = f.failure?.witness as Read & { served: number };
    expect(w.read.at).toBe(w.mark.at);
    expect(w.served).toBe(1);
    // Nothing further was queued or nudged after the failed iteration.
    expect(p.nudges()).toBe(at + 1);
    expect(net.script).toHaveLength(0);
    test.info().annotations.push({
      type: `p2-injected-${path}-${at}`,
      description: JSON.stringify(p.edits),
    });
    await waitForState(page, "idle");
  }
});

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
  // (4) Revision 16 (DA16-S1, Q7): a healthy step read late, after a LATER real step and its own request, is still that step with the
  // same values; the later request is retained inside the read and excluded. A second same-origin tab's own /sync fetch during a sample
  // is in that tab's ResourceTiming, never this page's.
  const timely = await markAndRead(page);
  const first = syncWitnessSelection(timely.witness);
  expect(first.status, String(first.problem)).toBe("complete");
  await page.evaluate(() => window.__atlasData?.nudgeSync());
  await expect
    .poll(() =>
      page.evaluate(
        (from) =>
          (window.__atlasData?.engineTrace ?? [])
            .slice(from)
            .filter((l) => l.split(" ")[1] === "data.sync_next").length,
        timely.witness.read.to,
      ),
    )
    .toBeGreaterThan(0);
  const lateRead = (await page.evaluate(readSyncSample, {
    mark: timely.mark,
    force: true,
  })) as SyncWitness;
  expect(lateRead.resources.map((r) => r.name)).toEqual([SYNC_PATH, SYNC_PATH]);
  expect(syncWitnessSelection(lateRead)).toEqual(first);
  await waitForState(page, "idle");
  const other = await context.newPage();
  // A same-origin JSON document (the stubbed identity read): no app boots in the other tab.
  await other.goto("/api/experimental/v1/browser-sessions/current");
  const sampleMark = (await (
    await page.waitForFunction(prepareSyncSample, undefined, {
      timeout: 60_000,
      polling: 10,
    })
  ).jsonValue()) as SyncMark;
  const status = await other.evaluate(async () => {
    const r = await fetch("/api/experimental/v1/sync?limit=1", {
      credentials: "same-origin",
    });
    await r.text();
    return r.status;
  });
  expect(status).toBe(200);
  expect(
    await other.evaluate(
      () =>
        performance
          .getEntriesByType("resource")
          .filter((e) => new URL(e.name).pathname.endsWith("/sync")).length,
    ),
  ).toBe(1);
  const alongside = (await (
    await page.waitForFunction(
      readSyncSample,
      { mark: sampleMark, force: false },
      { timeout: 60_000, polling: 10 },
    )
  ).jsonValue()) as SyncWitness;
  expect(alongside.resources).toHaveLength(1);
  expect(syncWitnessSelection(alongside).status).toBe("complete");
  await other.close();
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

// ---- revision 18 (A18-T2; Kieran's measurement identity decision of 25 October 2026): the page instance, not the time origin ----------
// macOS WebKit moves `performance.timeOrigin` with the disciplined wall clock on an unchanged document (+1 ms every 92 s, measured), too
// slowly to wait for here. The page's own `performance.timeOrigin` is shadowed (+1 ms each time) right after each sample's mark: the real
// engine, dispatcher, ResourceTiming and page clock are untouched. LABELLED DIAGNOSTIC SEAM: no timer, count or assertion of the writer changed.
const shiftTimeOrigin = () => {
  const moved = performance.timeOrigin + 1;
  Object.defineProperty(performance, "timeOrigin", {
    configurable: true,
    get: () => moved,
  });
  return moved;
};
/** The writer's page, with the time origin moved once after each mark that `marks` produces. */
const drifting = (page: Page, marks: unknown): SamplePage => {
  const base = samplePageOf(page);
  const after = async <T>(fn: unknown, out: T): Promise<T> => {
    if (fn === marks && out !== null) await page.evaluate(shiftTimeOrigin);
    return out;
  };
  return {
    poll: async (fn, arg, o) => after(fn, await base.poll(fn, arg, o)),
    run: async (fn, arg) => after(fn, await base.run(fn, arg)),
  };
};

test("P-4/P-10 natively (revision 18, A18-T2): a time origin that moves on the unchanged document keeps every sync sample complete with the same selection and figures; a real reload during a sample is refused", async ({
  context,
}) => {
  test.setTimeout(180_000);
  await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await startLeader(page);
  await waitForState(page, "idle");
  const c = await collectSyncSamples(drifting(page, prepareSyncSample), {
    warmup: 1,
    samples: 3,
    timeout: 60_000,
    polling: 10,
  });
  expect(c.failure).toBeNull();
  expect(c.samples).toHaveLength(3);
  for (const e of c.samples) {
    expect(e.read.time_origin).toBeGreaterThan(e.mark.time_origin);
    const s = syncWitnessSelection(e);
    expect(s.status, String(s.problem)).toBe("complete");
    expect(s.selected).toEqual(e.selected);
    // Timing accuracy: the selection and figures rest on the page clock, ResourceTiming and the trace, not on the time origin.
    expect(
      syncWitnessSelection({
        ...e,
        read: { ...e.read, time_origin: e.mark.time_origin },
      }),
    ).toEqual(s);
  }
  // A real reload between the mark and the read: a new document, so a new page id; refused whatever its time origin.
  await waitForState(page, "idle");
  const mark = (await (
    await page.waitForFunction(prepareSyncSample, undefined, {
      timeout: 60_000,
      polling: 10,
    })
  ).jsonValue()) as SyncMark;
  await page.reload();
  const reloaded = (await page.evaluate(readSyncSample, {
    mark,
    force: true,
  })) as SyncWitness;
  expect(reloaded.read.page).not.toBe(mark.page);
  expect(syncWitnessSelection(reloaded).problem).toBe(
    "the page was reloaded or replaced during the sample",
  );
});

test("P-4 draft natively (revision 18, A18-T2): a time origin that moves on the unchanged document keeps every draft sample complete with the same selection and figures", async ({
  context,
}) => {
  test.setTimeout(180_000);
  await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await startOutbox(page, ACCOUNT, { observeDispatch: true });
  const c = await collectDraftSamples(drifting(page, prepareDraftSample), {
    timeout: 30_000,
    polling: 10,
    account: ACCOUNT,
    person: () => crypto.randomUUID(),
    warmup: 1,
    samples: 3,
  });
  expect(c.failure).toBeNull();
  expect(c.samples).toHaveLength(3);
  for (const e of c.samples) {
    expect(
      e.completion.identity_after?.time_origin ?? Number.NaN,
    ).toBeGreaterThan(e.mark.time_origin);
    const s = draftWitnessSelection(e);
    expect(s.status, String(s.problem)).toBe("complete");
    expect(s.selected).toEqual(e.selected);
    // Timing accuracy: every identity's time origin set back to the mark's gives the same selection and figures.
    const origin = e.mark.time_origin;
    const unmoved = <T extends { time_origin: number } | null>(id: T): T =>
      id === null ? id : { ...id, time_origin: origin };
    const still: DraftWitness = {
      ...e,
      identities: {
        before: unmoved(e.identities.before),
        queued: unmoved(e.identities.queued),
        enqueued: unmoved(e.identities.enqueued),
      },
      timing: { ...e.timing, identity: unmoved(e.timing.identity) },
      completion: {
        ...e.completion,
        identity_before: unmoved(e.completion.identity_before),
        identity_after: unmoved(e.completion.identity_after),
      },
    };
    expect(draftWitnessSelection(still)).toEqual(s);
  }
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
    // Revision 15 (`draft-request-sample/3`; review 15 R2): the real records are complete for their kinds and ordered in time inside the
    // sample, each result repeats its call, and the completion read's recorded start follows the receipt's result in position and time.
    for (const [i, r] of e.records.entries()) {
      expect(Number.isFinite(r.at) && r.at >= e.mark.t0).toBe(true);
      if (i > 0) expect(r.at).toBeGreaterThanOrEqual(e.records[i - 1]?.at ?? 0);
      if (r.event.startsWith("commit_"))
        expect(r.service).toEqual(expect.any(Number));
    }
    for (const [end, call] of [
      [1, 0],
      [3, 2],
      [5, 4],
    ] as const) {
      expect(e.records[end]?.of).toBe(e.records[call]?.seq);
      for (const k of [
        "dispatcher",
        "service",
        "plan",
        "local_id",
        "epoch",
        "key",
        "path",
      ] as const)
        expect(e.records[end]?.[k]).toEqual(e.records[call]?.[k]);
    }
    expect(e.completion.log_before).toBe((e.records[5]?.seq ?? -1) + 1);
    expect(e.records[5]?.at).toBeLessThanOrEqual(e.completion.started_at);
    expect(e.timing.done).toBeLessThanOrEqual(e.completion.started_at);
    expect(e.completion.started_at).toBeLessThanOrEqual(e.completion.at);
    // Revision 16 (`draft-request-sample/4`; DA16-D1, Q7): the real request and entry are the exact /commands pathname, and the entry lies
    // inside [t0, completion read], ending by the timing read.
    expect(e.records[2]?.path).toBe(COMMANDS_PATH);
    expect(e.resources.map((r) => r.name)).toEqual([COMMANDS_PATH]);
    for (const r of e.resources) {
      expect(r.startTime).toBeGreaterThanOrEqual(e.mark.t0);
      expect(r.responseEnd).toBeLessThanOrEqual(e.timing.done);
    }
  }
  // LABELLED CONSUMER-INTEGRITY COPY (not a writer's output): the request, its result and its entry all moved to another endpoint.
  const foreign = structuredClone(healthy.samples[0]) as DraftWitness;
  for (const r of foreign.records)
    if (r.event === "request_begin" || r.event === "request_end")
      (r as { path?: string }).path = "/api/experimental/v1/task-commands";
  if (foreign.resources[0])
    foreign.resources[0].name = "/api/experimental/v1/task-commands";
  expect(draftWitnessSelection(foreign).problem).toBe(
    "a retained request entry is not the /commands endpoint (/api/experimental/v1/task-commands)",
  );
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

/**
 * WEB-09c revision 17 (review 17 R17-REQUEST/R17-BUFFER; design assessment DA17-RQ/BF/HR, Q10/Q13): the `draft-request-sample/5` relations
 * natively, in Chromium, Firefox and WebKit, through the production dispatcher, its stamped sender and real ResourceTiming, with the stubbed
 * network. (1) The raw-clock policy (no allowance between the observer's `performance.now()` and ResourceTiming): every one of 100 healthy samples'
 * call begins no later than its entry starts and returns no earlier than its request was sent; the margins are recorded, never widened.
 * (2) DA17-HR: the stamped sender returns a FULLY READ response (`fetchFor`), so the observer's `request_end` is the stamped return, not
 * the headers: a LABELLED fixture fetch wrapper (this test's init script only) delivers the real response's headers and holds its body
 * at the page's fetch boundary; no `request_end` is recorded while it is held, and the sample completes after its release. The network
 * itself is not held (the stub fulfils at once), so this is the stamped sender's contract, not a network body hold. (3) The buffer:
 * unrelated entries between the reads (a growth to 249) keep the sample; 250 at the completion read refuses it as full; another tab's
 * clear and fetch never touch this page's buffer. Not a measurement: no figure here is evidence, and nothing is recorded into a programme.
 */
test("P-4 draft natively (revision 17): every healthy call begins no later than its entry and returns no earlier than its request (margins recorded); a held body keeps the stamped call open until it is read; unrelated growth and 249 entries keep the sample, 250 refuses it, and another tab's buffer is its own", async ({
  context,
}, info) => {
  test.setTimeout(300_000);
  await stubNetwork(context);
  await context.route("**/__fill/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "x" }),
  );
  // LABELLED FIXTURE FETCH WRAPPER (DA17-HR): armed once by the test; the real fetch runs, its headers are delivered, its body is held.
  await context.addInitScript(() => {
    const real = window.fetch.bind(window);
    const hold: {
      armed: boolean;
      headersAt: number | null;
      pulledAt: number | null;
      releasedAt: number | null;
      release: () => void;
    } = {
      armed: false,
      headersAt: null,
      pulledAt: null,
      releasedAt: null,
      release: () => {},
    };
    (globalThis as { __heldCommandsBody?: typeof hold }).__heldCommandsBody =
      hold;
    window.fetch = async (input, init) => {
      const response = await real(input, init);
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      if (!hold.armed || !url.pathname.endsWith("/commands") || !response.body)
        return response;
      hold.armed = false;
      hold.headersAt = performance.now();
      const released = new Promise<void>((resolve) => {
        hold.release = () => {
          hold.releasedAt = performance.now();
          resolve();
        };
      });
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          hold.pulledAt ??= performance.now();
          await released;
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  });
  await seedSettled(context);
  const page = await bootSession(context);
  await startOutbox(page, ACCOUNT, { observeDispatch: true });
  const base = samplePageOf(page);
  // A hook run once, right after the timing read and before the completion read (the collector's own order).
  let afterTiming: (() => Promise<void>) | null = null;
  const sampler: SamplePage = {
    run: base.run,
    async poll(fn, arg, o) {
      const out = await base.poll(fn, arg, o);
      if ((fn as unknown) === readDraftSample && afterTiming) {
        const hook = afterTiming;
        afterTiming = null;
        await hook();
      }
      return out;
    },
  };
  const options = {
    timeout: 30_000,
    polling: 10,
    account: ACCOUNT,
    person: () => crypto.randomUUID(),
  };
  const isolated = await page.evaluate(() => crossOriginIsolated);

  // (1) The raw-clock policy on 100 healthy samples after a warm-up. Firefox and WebKit clamp both clocks to 1 ms here (not cross-origin
  // isolated), so a call and its entry often share a millisecond: about one sample in five ties (revision 17's diagnostic, 20 per engine).
  // A tie is where clamping that differed between the two clocks would invert them; 100 samples give some twenty ties per engine for a
  // few seconds. The first inversion fails the test (the collector keeps it), never widened.
  const healthy = await collectDraftSamples(sampler, {
    ...options,
    warmup: 1,
    samples: 100,
  });
  expect(healthy.failure).toBeNull();
  const margins = healthy.samples.map((e) => {
    const begin = e.records.find((r) => r.event === "request_begin");
    const end = e.records.find((r) => r.event === "request_end");
    const r = e.resources[e.selected.request];
    if (!begin || !end || !r) throw new Error("a healthy sample lost its call");
    return {
      begin_to_start: r.startTime - begin.at,
      request_to_return: end.at - r.requestStart,
      body_to_return: end.at - r.responseEnd,
      totals: [e.timing.resource_entries, e.completion.resource_entries],
    };
  });
  for (const m of margins) {
    expect(m.begin_to_start).toBeGreaterThanOrEqual(0);
    expect(m.request_to_return).toBeGreaterThanOrEqual(0);
  }
  const least = (
    k: "begin_to_start" | "request_to_return" | "body_to_return",
  ) => Math.min(...margins.map((m) => m[k]));
  const clock = {
    engine: info.project.name,
    cross_origin_isolated: isolated,
    samples: margins.length,
    least_begin_to_start_ms: least("begin_to_start"),
    least_request_to_return_ms: least("request_to_return"),
    least_body_to_return_ms: least("body_to_return"),
    margins,
  };
  console.log(`(1) raw-clock margins: ${JSON.stringify(clock)}`);
  await info.attach("raw-clock-margins.json", {
    body: JSON.stringify(clock, null, 2),
    contentType: "application/json",
  });
  // LABELLED CONSUMER-INTEGRITY COPIES (not a writer's output) of a real witness: review 17's late begin, and its buffer contradictions.
  for (const [label, edit, problem] of [
    [
      "the call begun 0.05 ms after its entry ended",
      (w: DraftWitness) => {
        const begin = w.records.find((r) => r.event === "request_begin");
        const entry = w.resources[0];
        if (begin && entry) begin.at = entry.responseEnd + 0.05;
      },
      "the dispatcher's request began after its /commands entry started: the entry is not that call's",
    ],
    [
      "the timing total missing",
      (w: DraftWitness) => {
        delete (w.timing as { resource_entries?: number }).resource_entries;
      },
      "its timing read does not record the resource buffer's entries",
    ],
    [
      "the completion total zero",
      (w: DraftWitness) => {
        w.completion.resource_entries = 0;
      },
      "the completion read retains more requests than the buffer held",
    ],
    [
      "249 at the timing read",
      (w: DraftWitness) => {
        w.timing.resource_entries = 249;
      },
      "the resource-timing buffer shrank between the timing and completion reads: it was cleared or lost entries",
    ],
  ] as const) {
    // REVISION 18 HARNESS CORRECTION: the late begin is applied to a sample whose later records and reads all follow its entry's end by
    // 0.05 ms. Under a 1 ms clock the first sample's return can tie `responseEnd`, and the moved begin then broke the records' order first.
    const base = label.startsWith("the call begun")
      ? healthy.samples.find((e) => {
          const begin = e.records.find((r) => r.event === "request_begin");
          const late = (e.resources[0]?.responseEnd ?? Number.NaN) + 0.05;
          return (
            begin !== undefined &&
            e.records.every((r) => r.seq <= begin.seq || r.at >= late) &&
            [e.timing.done, e.completion.started_at, e.completion.at].every(
              (at) => at >= late,
            )
          );
        })
      : healthy.samples[0];
    expect(base, `${label}: a healthy sample to edit`).toBeDefined();
    const copy = structuredClone(base) as DraftWitness;
    edit(copy);
    expect(draftWitnessSelection(copy).problem, label).toBe(problem);
  }

  // (2) DA17-HR: the body held after the headers; the stamped call stays open until it is read.
  await page.evaluate(() => {
    const h = (globalThis as { __heldCommandsBody?: { armed: boolean } })
      .__heldCommandsBody;
    if (h) h.armed = true;
  });
  const holding = collectDraftSamples(sampler, {
    ...options,
    warmup: 0,
    samples: 1,
  });
  const heldState = () =>
    page.evaluate(() => {
      const h = (
        globalThis as {
          __heldCommandsBody?: {
            headersAt: number | null;
            pulledAt: number | null;
          };
        }
      ).__heldCommandsBody;
      const log = window.__atlasData?.dispatchLog ?? [];
      const begin = log.filter((r) => r.event === "request_begin").at(-1);
      return {
        headersAt: h?.headersAt ?? null,
        pulledAt: h?.pulledAt ?? null,
        begun: begin?.seq ?? null,
        ended: log.some(
          (r) => r.event === "request_end" && r.of === begin?.seq,
        ),
        now: performance.now(),
      };
    });
  await expect
    .poll(async () => (await heldState()).pulledAt !== null, {
      timeout: 30_000,
    })
    .toBe(true);
  // The sender is reading the body (its pull began); give its continuation further turns of the page's event loop: still no result.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 250)));
  const whileHeld = await heldState();
  console.log(`(2) while held: ${JSON.stringify(whileHeld)}`);
  expect(whileHeld.headersAt).not.toBeNull();
  expect(whileHeld.begun).not.toBeNull();
  expect(whileHeld.ended).toBe(false);
  await page.evaluate(() =>
    (
      globalThis as { __heldCommandsBody?: { release: () => void } }
    ).__heldCommandsBody?.release(),
  );
  const held = await holding;
  expect(held.failure).toBeNull();
  const releasedAt = await page.evaluate(
    () =>
      (globalThis as { __heldCommandsBody?: { releasedAt: number | null } })
        .__heldCommandsBody?.releasedAt ?? null,
  );
  const hw = held.samples[0];
  const hend = hw?.records.find((r) => r.event === "request_end");
  const hentry = hw?.resources[hw.selected.request];
  if (!hw || !hend || !hentry || releasedAt === null)
    throw new Error("the held sample lost its call");
  console.log(
    `(2) stamped return ${hend.at}, body released ${releasedAt}, headers ${whileHeld.headersAt}, entry responseEnd ${hentry.responseEnd}`,
  );
  expect(hend.at).toBeGreaterThanOrEqual(releasedAt);
  expect(releasedAt).toBeGreaterThanOrEqual(whileHeld.headersAt ?? Infinity);
  expect(hend.at).toBeGreaterThanOrEqual(hentry.responseEnd);
  expect(draftWitnessSelection(hw).status).toBe("complete");

  // (3) The buffer between the reads: unrelated growth (one entry, then up to 249) keeps the sample; 250 refuses it as full.
  /** In the page: same-origin unrelated fetches, one at a time, each waited for in the buffer, until it holds `target` entries. */
  const fillTo = (target: number) =>
    page.evaluate(async (n) => {
      const count = () => performance.getEntriesByType("resource").length;
      for (let i = 0; count() < n; i += 1) {
        const before = count();
        await (await fetch(`/__fill/${crypto.randomUUID()}`)).text();
        for (let t = 0; count() === before; t += 1) {
          if (t > 400) throw new Error(`no resource entry after fetch ${i}`);
          await new Promise((r) => setTimeout(r, 5));
        }
      }
      return count();
    }, target);
  const grown: number[] = [];
  for (const [label, target] of [
    ["one more", 0],
    ["249", 249],
  ] as const) {
    afterTiming = async () => {
      const now = await page.evaluate(
        () => performance.getEntriesByType("resource").length,
      );
      grown.push(await fillTo(target === 0 ? now + 1 : target));
    };
    const c = await collectDraftSamples(sampler, {
      ...options,
      warmup: 0,
      samples: 1,
    });
    expect(c.failure, label).toBeNull();
    const e = c.samples[0];
    console.log(
      `(3) ${label}: totals ${e?.timing.resource_entries} -> ${e?.completion.resource_entries}`,
    );
    expect(e?.completion.resource_entries, label).toBe(grown.at(-1));
    expect(e?.completion.resource_entries ?? 0, label).toBeGreaterThan(
      e?.timing.resource_entries ?? Infinity,
    );
    expect(e?.resources, label).toHaveLength(1);
  }
  afterTiming = async () => {
    grown.push(await fillTo(250));
  };
  const full = await collectDraftSamples(sampler, {
    ...options,
    warmup: 0,
    samples: 1,
  });
  expect(grown.at(-1)).toBe(250);
  expect(full.values).toEqual([]);
  expect(full.failure?.problem).toBe(
    "the resource-timing buffer was full: requests may be missing",
  );
  const fullWitness = full.failure?.witness as DraftWitness | undefined;
  expect(fullWitness?.completion.resource_entries).toBe(250);

  // Another tab clears its own buffer and fetches between the reads: this page's totals are its own (unchanged between the reads).
  const other = await context.newPage();
  await other.goto("/__fill/start");
  afterTiming = async () => {
    await other.evaluate(async () => {
      performance.clearResourceTimings();
      await (await fetch(`/__fill/${crypto.randomUUID()}`)).text();
    });
    await expect
      .poll(() =>
        other.evaluate(() => performance.getEntriesByType("resource").length),
      )
      .toBe(1);
  };
  const beside = await collectDraftSamples(sampler, {
    ...options,
    warmup: 0,
    samples: 1,
  });
  expect(beside.failure).toBeNull();
  const b = beside.samples[0];
  console.log(
    `(3) another tab: totals ${b?.timing.resource_entries} -> ${b?.completion.resource_entries}`,
  );
  expect(b?.completion.resource_entries).toBe(b?.timing.resource_entries);
  await other.close();
});
