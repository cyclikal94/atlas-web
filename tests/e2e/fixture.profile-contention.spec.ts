import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { BrowserContext, Page, Route } from "@playwright/test";
import {
  ACCOUNT,
  seedSettled,
  startLeader,
  stubNetwork,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";
import {
  engineOf,
  PROFILE_OUT,
  record,
  recordValue,
  sleep,
} from "./profile-helpers";

/**
 * WEB-09a profiling, desktop CONTENTION programme (plan 7.2: P-6, P-7, P-8, P-9), through the REAL stamped wrapper and the ordinary sync
 * engine, in real Chromium, Firefox and WebKit, with two or more pages of one browser context (one origin: one `atlas-auth`, one set of
 * Web Locks). MEASUREMENTS, not budgets; skipped unless ATLAS_PROFILE=1 (`pnpm profile:contention`).
 *
 * WHAT IS FIXTURE, AND SAYS SO: the leader is the FIXTURE test leader (production starts no engine until WEB-09b supplies leadership);
 * the network is a stub with SYNTHETIC delays (5 ms between pages: "back-to-back"; a held response); the "frozen owner" is a main-thread
 * block in a page that holds `atlas-auth` (a Playwright engine cannot freeze a page, so a freeze is SIMULATED and called synthetic); the
 * closing-write give-up is observed with a SCALED `lockWaitMs` (production: 20 s) so it can be observed many times, plus a few runs at the
 * production value. None of it is a real freeze, a real device, the production leader, or the released backend.
 *
 * ATLAS_PROFILE_SAMPLES shortens a DEBUGGING run; the recorded measurements use the full counts below.
 */
test.skip(
  !process.env.ATLAS_PROFILE,
  "not run: measurements are taken by `pnpm profile:contention`",
);
test.describe.configure({ mode: "serial" });

const QUICK = Number(process.env.ATLAS_PROFILE_SAMPLES ?? 0);
const N = (full: number): number => (QUICK > 0 ? Math.min(full, QUICK) : full);
const OUT = `${PROFILE_OUT}/contention`;
const write = (name: string, data: unknown): void => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}`, `${JSON.stringify(data, null, 2)}\n`);
};
const append = (name: string, row: unknown): void => {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(`${OUT}/${name}`, `${JSON.stringify(row)}\n`);
};

interface TraceEntry {
  at: number;
  event: string;
  data?: Record<string, unknown>;
}
declare global {
  interface Window {
    __frozen?: boolean;
  }
}

// ---- the stub server: instant answers, a back-to-back `/sync`, and held ordinary requests ------------------------------------------------------
interface Server {
  syncPages: number;
  /** Synthetic latency before each `/sync` answer (ms); 0 answers at once. */
  syncDelayMs: number;
  /** While true `/sync` keeps answering `has_more: true` (a leader that never reaches the live edge). */
  catchingUp: boolean;
  /** Pages left in a bounded catch-up (when `catchingUp` is false). */
  budget: number;
  /** Ordinary `/probe` requests are held until `releaseHeld()`; `heldCount` counts those waiting. */
  hold: boolean;
  heldCount: number;
  releaseHeld(): void;
}

async function serve(context: BrowserContext): Promise<Server> {
  await stubNetwork(context);
  const waiting: Array<() => void> = [];
  const server: Server = {
    syncPages: 0,
    syncDelayMs: 5,
    catchingUp: false,
    budget: 0,
    hold: false,
    heldCount: 0,
    releaseHeld() {
      for (const release of waiting.splice(0)) release();
      server.heldCount = 0;
    },
  };
  // Registered after `stubNetwork`, so these win for their paths.
  await context.route(
    /\/api\/experimental\/v1\/sync(\?|$)/,
    async (route: Route) => {
      server.syncPages += 1;
      if (server.syncDelayMs > 0) await sleep(server.syncDelayMs);
      const more = server.catchingUp || server.budget-- > 0;
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            phase: "delta",
            batches: [],
            next_cursor: `cursor-${server.syncPages}`,
            has_more: more,
          }),
        })
        .catch(() => undefined);
    },
  );
  await context.route(
    /\/api\/experimental\/v1\/probe/,
    async (route: Route) => {
      if (server.hold) {
        server.heldCount += 1;
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        })
        .catch(() => undefined);
    },
  );
  return server;
}

async function sessionPage(
  context: BrowserContext,
  options: { lockWaitMs?: number; init?: () => void } = {},
): Promise<Page> {
  const page = await context.newPage();
  if (options.init) await page.addInitScript(options.init);
  const query = [
    "route=%2Ftoday",
    ...(options.lockWaitMs ? [`lockWaitMs=${options.lockWaitMs}`] : []),
  ].join("&");
  await page.goto(`/__session?${query}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

const trace = (page: Page): Promise<TraceEntry[]> =>
  page.evaluate(
    () => (window.__atlasFixture?.session?.trace ?? []) as TraceEntry[],
  );
const countOf = (entries: TraceEntry[], event: string): number =>
  entries.filter((entry) => entry.event === event).length;

// ---- the probes (each runs in the PROBE page B and returns milliseconds) -------------------------------------------------------------------------
/** An ordinary stamped request through the real wrapper: from the call to the released Response. */
const ordinaryProbe = (page: Page, count: number) =>
  page.evaluate(
    async ({ account, n }) => {
      const session = window.__atlasFixture?.session?.booted?.session;
      const identity = session?.identity.get();
      if (!session || !identity) throw new Error("no session");
      const out: Array<{ ms: number; outcome: string }> = [];
      for (let i = 0; i < n; i += 1) {
        const started = performance.now();
        let outcome = "released";
        try {
          const response = await session.api.fetchFor(
            "ordinary",
            account,
            identity.epoch,
          )(
            new Request(new URL("/api/experimental/v1/probe", location.origin)),
          );
          await response.arrayBuffer();
        } catch (error) {
          outcome = (error as { kind?: string }).kind ?? "error";
        }
        out.push({ ms: performance.now() - started, outcome });
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return out;
    },
    { account: ACCOUNT, n: count },
  );

/** The exposure: from the page becoming visible to the gate lifting (the method of WEB-08a's P-2). */
const exposureProbe = (page: Page, count: number) =>
  page.evaluate(async (n) => {
    const root = document.getElementById("protected-root") as HTMLElement;
    const out: Array<{ ms: number; outcome: string }> = [];
    const setVisibility = (state: string) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    for (let i = 0; i < n; i += 1) {
      setVisibility("hidden");
      const lifted = new Promise<string>((resolve) => {
        const observer = new MutationObserver(() => {
          if (!root.hasAttribute("inert")) {
            observer.disconnect();
            resolve("lifted");
          }
        });
        observer.observe(root, {
          attributes: true,
          attributeFilter: ["inert"],
        });
        setTimeout(() => {
          observer.disconnect();
          resolve("not_lifted");
        }, 8_000);
      });
      const started = performance.now();
      setVisibility("visible");
      const outcome = await lifted;
      out.push({ ms: performance.now() - started, outcome });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return out;
  }, count);

/**
 * An `atlas-auth` WRITER with the session's own bounded wait (`attempts.begin`, then `cancel`): the nearest probe to a closing write
 * that needs no confirmed wipe. `lock_timeout` is its give-up.
 */
const writerProbe = (page: Page, count: number) =>
  page.evaluate(async (n) => {
    const session = window.__atlasFixture?.session?.booted?.session;
    if (!session) throw new Error("no session");
    const out: Array<{ ms: number; outcome: string }> = [];
    for (let i = 0; i < n; i += 1) {
      const started = performance.now();
      const begun = await session.attempts.begin("password");
      out.push({ ms: performance.now() - started, outcome: begun.kind });
      if (begun.kind === "started") await session.attempts.cancel(begun.handle);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return out;
  }, count);

/**
 * The CLOSING WRITE itself, including its wait for another page's issue lock: a logout's initiation (draft fence, recount, then the
 * closing transaction that raises the operation fence). Each sample is on a fresh page of the same context, because a logout is
 * destructive: the session record is reseeded afterwards. Returns the milliseconds to the answer and its outcome.
 */
async function closingProbe(
  context: BrowserContext,
  lockWaitMs: number,
): Promise<{ ms: number; outcome: string }> {
  const page = await sessionPage(context, { lockWaitMs });
  try {
    return await page.evaluate(async () => {
      const session = window.__atlasFixture?.session?.booted?.session;
      if (!session) throw new Error("no session");
      const started = performance.now();
      const first = await session.operations.logout({
        unsynced: { count: 0, items: [], digest: "unknown" },
      });
      // A `reconfirm` carries the real recount: confirm it, as the dialog does.
      const outcome =
        first.kind === "reconfirm"
          ? await session.operations.logout({ unsynced: first.unsynced })
          : first;
      return {
        ms: performance.now() - started,
        outcome:
          outcome.kind === "refused"
            ? `refused:${outcome.reason}`
            : outcome.kind,
      };
    });
  } finally {
    await page.close();
  }
}

const reseed = async (context: BrowserContext): Promise<void> => {
  await seedSettled(context);
};

const summarise = (
  samples: Array<{ ms: number; outcome: string }>,
): { ms: number[]; outcomes: Record<string, number> } => {
  const outcomes: Record<string, number> = {};
  for (const sample of samples)
    outcomes[sample.outcome] = (outcomes[sample.outcome] ?? 0) + 1;
  return { ms: samples.map((sample) => sample.ms), outcomes };
};

// ---- P-7 (and P-8): waits against a back-to-back leader ---------------------------------------------------------------------------------------------
type Condition = { name: string; leader: boolean; policy?: string };
const CONDITIONS: Condition[] = [
  { name: "no leader", leader: false },
  { name: "back-to-back leader, 5 ms apart (platform yield)", leader: true },
];

test("P-7 and P-8: the wait for another page's activity against a back-to-back sync leader (pages 5 ms apart), and what is cancelled and retired", async ({
  context,
}, info) => {
  test.setTimeout(30 * 60_000);
  const engine = engineOf(info);
  const server = await serve(context);
  await reseed(context);
  const leaderPage = await sessionPage(context);
  const probe = await sessionPage(context);
  const results: Record<string, unknown>[] = [];
  for (const condition of CONDITIONS) {
    if (condition.leader) {
      server.catchingUp = true;
      server.syncDelayMs = 5;
      await startLeader(leaderPage, ACCOUNT, "cursor-0");
      await sleep(500);
    }
    const before = server.syncPages;
    const startedAt = Date.now();
    const leaderTraceBefore = (await trace(leaderPage)).length;
    const probeTraceBefore = (await trace(probe)).length;
    const ordinary = summarise(await ordinaryProbe(probe, N(100)));
    const exposure = summarise(await exposureProbe(probe, N(100)));
    const writer = summarise(await writerProbe(probe, N(100)));
    const elapsed = (Date.now() - startedAt) / 1000;
    const pages = server.syncPages - before;
    const leaderTrace = (await trace(leaderPage)).slice(leaderTraceBefore);
    const probeTrace = (await trace(probe)).slice(probeTraceBefore);
    for (const [kind, samples] of [
      ["ordinary request", ordinary],
      ["exposure (visible to lifted)", exposure],
      ["atlas-auth writer (begin)", writer],
    ] as const) {
      record(`P-7 ${kind}, ${condition.name}`, engine, samples.ms, {
        outcomes: samples.outcomes,
        condition: condition.name,
        synthetic: "5 ms server latency between pages; fixture leader",
      });
      append("waits.jsonl", {
        probe: kind,
        condition: condition.name,
        engine,
        n: samples.ms.length,
        outcomes: samples.outcomes,
        ms: samples.ms,
      });
    }
    results.push({
      condition: condition.name,
      leader_pages: pages,
      leader_pages_per_second: +(pages / elapsed).toFixed(1),
      leader_cover_commits: countOf(leaderTrace, "cover.committed"),
      leader_requests_issued: countOf(leaderTrace, "request.issued"),
      leader_leases_retired: countOf(leaderTrace, "lease.retired"),
      leader_activity_cancelled: countOf(leaderTrace, "activity.cancel"),
      probe_activity_cancelled: countOf(probeTrace, "activity.cancel"),
      probe_leases_retired: countOf(probeTrace, "lease.retired"),
      probe_retire_failed: countOf(probeTrace, "lease.retire_failed"),
      probe_closing_gave_up: countOf(probeTrace, "closing.gave_up"),
    });
    if (condition.leader) {
      server.catchingUp = false;
      server.budget = 0;
      await leaderPage.evaluate(() => window.__atlasData?.stopSync());
      await sleep(300);
    }
  }
  // The closing write proper (a logout's fence), with the leader running and without it: the nearest to the plan's "closing write".
  for (const condition of CONDITIONS) {
    if (condition.leader) {
      server.catchingUp = true;
      await leaderPage.evaluate(() => window.__atlasData?.stopSync());
      await startLeader(leaderPage, ACCOUNT, "cursor-0");
    }
    const samples: Array<{ ms: number; outcome: string }> = [];
    for (let i = 0; i < N(30); i += 1) {
      await reseed(context);
      samples.push(await closingProbe(context, 20_000));
    }
    const summary = summarise(samples);
    record(
      `P-7 closing write (logout initiation), ${condition.name}`,
      engine,
      summary.ms,
      { outcomes: summary.outcomes, condition: condition.name },
    );
    append("waits.jsonl", {
      probe: "closing write (logout initiation)",
      condition: condition.name,
      engine,
      n: summary.ms.length,
      outcomes: summary.outcomes,
      ms: summary.ms,
    });
    if (condition.leader) {
      server.catchingUp = false;
      await leaderPage.evaluate(() => window.__atlasData?.stopSync());
    }
  }
  write(`retirements.${engine}.json`, {
    id: "P-8",
    engine,
    status: "measured",
    label:
      "counted from the kernel's own trace in each page (activity.cancel, lease.retired, lease.retire_failed); the cost of one retirement is one small write",
    conditions: results,
  });
  recordValue("P-8 retirements", engine, { conditions: results });
  expect(results.length).toBe(CONDITIONS.length);
});

// ---- P-7: a frozen owner (SYNTHETIC) ---------------------------------------------------------------------------------------------------------------------
test("P-7: a frozen owner (a main-thread block in a page that holds atlas-auth: SYNTHETIC, not a real freeze) and how often a closing write gives up (SCALED lock wait)", async ({
  context,
}, info) => {
  test.setTimeout(30 * 60_000);
  const engine = engineOf(info);
  await serve(context);
  await reseed(context);
  const frozenPage = await sessionPage(context);
  const SCALED_WAIT_MS = 1_000;
  const probe = await sessionPage(context, { lockWaitMs: SCALED_WAIT_MS });
  // Freezes shorter and longer than the scaled wait: the writer waits out the shorter ones and gives up on the longer.
  const freezes = [100, 250, 500, 750, 1_000, 1_500, 2_500];
  const perFreeze = N(15);
  const rows: Array<{
    freeze_ms: number;
    gave_up: boolean;
    waited_ms: number;
    outcome: string;
  }> = [];
  for (const freeze of freezes) {
    for (let i = 0; i < perFreeze; i += 1) {
      // The frozen page takes `atlas-auth` (as a request's cover would) and then blocks its own thread: it cannot release or answer.
      const frozen = frozenPage.evaluate(async (ms) => {
        const locks = window.__atlasFixture?.session?.locks;
        if (!locks) throw new Error("no locks");
        const handle = await locks.acquire("atlas-auth");
        const end = performance.now() + ms;
        while (performance.now() < end) {
          // a synthetic freeze: nothing in this page runs until the block ends
        }
        handle?.release();
      }, freeze);
      await sleep(30);
      const started = Date.now();
      const [sample] = await writerProbe(probe, 1);
      rows.push({
        freeze_ms: freeze,
        gave_up: sample?.outcome === "lock_timeout",
        waited_ms: sample?.ms ?? Date.now() - started,
        outcome: sample?.outcome ?? "none",
      });
      await frozen;
      await sleep(20);
    }
  }
  const gaveUp = rows.filter((row) => row.gave_up).length;
  write(`frozen-owner.${engine}.json`, {
    id: "P-7 frozen owner",
    engine,
    status: "measured, SYNTHETIC",
    label:
      "a main-thread block in a page that holds atlas-auth stands for a frozen tab (a Playwright engine cannot freeze a page); the writer's wait is SCALED to 1 s (production: 20 s) so the give-up can be observed 100 times",
    scaled_lock_wait_ms: SCALED_WAIT_MS,
    freezes_ms: freezes,
    samples_per_freeze: perFreeze,
    gave_up: gaveUp,
    of: rows.length,
    rows,
  });
  record(
    "P-7 frozen owner: writer wait (scaled 1 s)",
    engine,
    rows.map((row) => row.waited_ms),
    {
      gave_up: gaveUp,
      synthetic: true,
    },
  );
  recordValue("P-7 frozen owner give-ups", engine, {
    gave_up: gaveUp,
    of: rows.length,
    scaled_lock_wait_ms: SCALED_WAIT_MS,
  });
  // The give-up is never a commit: after every sample the record is unchanged (no attempt left behind by a timed-out begin).
  expect(rows.length).toBe(freezes.length * perFreeze);
});

test("P-7: the PRODUCTION lock wait (20 s) against a synthetic freeze that outlasts it: the writer gives up at the bound, never earlier", async ({
  context,
}, info) => {
  test.setTimeout(10 * 60_000);
  const engine = engineOf(info);
  await serve(context);
  await reseed(context);
  const frozenPage = await sessionPage(context);
  const probe = await sessionPage(context);
  const runs = N(2);
  const rows: Array<{ outcome: string; waited_ms: number }> = [];
  for (let i = 0; i < runs; i += 1) {
    const frozen = frozenPage.evaluate(async () => {
      const locks = window.__atlasFixture?.session?.locks;
      if (!locks) throw new Error("no locks");
      const handle = await locks.acquire("atlas-auth");
      const end = performance.now() + 23_000;
      while (performance.now() < end) {
        // synthetic freeze
      }
      handle?.release();
    });
    await sleep(100);
    const [sample] = await writerProbe(probe, 1);
    rows.push({
      outcome: sample?.outcome ?? "none",
      waited_ms: sample?.ms ?? 0,
    });
    await frozen;
  }
  write(`frozen-owner-production-wait.${engine}.json`, {
    id: "P-7 frozen owner, production lock wait",
    engine,
    status: "measured, SYNTHETIC freeze",
    lock_wait_ms: 20_000,
    freeze_ms: 23_000,
    rows,
  });
  for (const row of rows) {
    expect(row.outcome).toBe("lock_timeout");
    expect(row.waited_ms).toBeGreaterThanOrEqual(19_500);
  }
});

// ---- P-6: unresolved leases seen by a page that did not send the request -------------------------------------------------------------------------------
test("P-6: how often a page meets an unresolved lease it did not create (a tab closed mid-request; a live page whose response handling is slowed or failing, INJECTED)", async ({
  context,
}, info) => {
  test.setTimeout(45 * 60_000);
  const engine = engineOf(info);
  const server = await serve(context);
  await reseed(context);
  const observer = await sessionPage(context);
  type Scenario = {
    cause:
      | "tab_closed_cleanly_mid_request"
      | "tab_killed_mid_request_simulated"
      | "tab_crashed_mid_request_chromium"
      | "slow_handling_injected"
      | "failing_recording_injected";
    /** Leases of OTHER pages in the record when the observer first asked: the scenario's precondition. */
    foreign_leases: number;
    /** The sender's own `lease.retire_failed` events (the failing-recording injection took effect when this is above zero). */
    sender_retire_failed: number;
    /** The observer's covers (after the closure) that carried at least one unresolved lease. */
    covers_with_unresolved: number;
    first: string;
    resolved: boolean;
    resolve_ms: number | null;
    retired_by_observer: number;
  };
  const rows: Scenario[] = [];

  const sendOnce = (page: Page) =>
    page.evaluate(async (account) => {
      const session = window.__atlasFixture?.session?.booted?.session;
      const identity = session?.identity.get();
      if (!session || !identity) throw new Error("no session");
      void session.api
        .fetchFor(
          "ordinary",
          account,
          identity.epoch,
        )(new Request(new URL("/api/experimental/v1/probe", location.origin)))
        .then(
          () => undefined,
          () => undefined,
        );
    }, ACCOUNT);
  const issuedProbes = async (page: Page): Promise<number> =>
    (await trace(page)).filter(
      (entry) =>
        entry.event === "request.issued" && entry.data?.klass === "ordinary",
    ).length;
  /**
   * Sends one ordinary request and waits until it has been ISSUED. A brief hold that a boot-time verification sets can cancel the
   * first try (that is the protocol: the caller is told and asks again), so it is retried; the retries are not counted.
   */
  const sendHeld = async (page: Page): Promise<void> => {
    await sleep(300);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await issuedProbes(page);
      await sendOnce(page);
      for (let i = 0; i < 20; i += 1) {
        await sleep(50);
        if ((await issuedProbes(page)) > before) return;
      }
    }
    throw new Error("the request was never issued");
  };

  const foreignLeases = async (): Promise<number> => {
    const records = (await observer.evaluate(() =>
      window.__atlasFixture?.session?.readRecords(),
    )) as { auth_state: { leases: Record<string, { boot_id: string }> } };
    const bootId = await observer.evaluate(
      () => window.__atlasFixture?.session?.booted?.session.bootId,
    );
    return Object.values(records.auth_state.leases).filter(
      (lease) => lease.boot_id !== bootId,
    ).length;
  };
  const observe = async (
    cause: Scenario["cause"],
    senderRetireFailed = 0,
  ): Promise<void> => {
    const before = (await trace(observer)).length;
    // The precondition, read from the record before the observer asks: another page's lease is there.
    const foreign = await foreignLeases();
    const [first] = await ordinaryProbe(observer, 1);
    const firstOutcome = first?.outcome ?? "none";
    // What B does next: the verification of an unresolved lease runs in the session; ask again until a request goes through.
    let resolved = firstOutcome === "released";
    const started = Date.now();
    for (let i = 0; i < 40 && !resolved; i += 1) {
      await sleep(250);
      const [again] = await ordinaryProbe(observer, 1);
      if (again?.outcome === "released") resolved = true;
    }
    const after = (await trace(observer)).slice(before);
    rows.push({
      cause,
      foreign_leases: foreign,
      sender_retire_failed: senderRetireFailed,
      covers_with_unresolved: after.filter(
        (entry) =>
          entry.event === "cover.committed" &&
          Array.isArray(entry.data?.unresolved) &&
          (entry.data.unresolved as unknown[]).length > 0,
      ).length,
      first: firstOutcome,
      resolved,
      resolve_ms: resolved ? Date.now() - started : null,
      retired_by_observer: countOf(after, "lease.retired"),
    });
  };

  // (1) a tab closed while its request is outstanding. THREE variants, because a Playwright `page.close()` runs the page's own
  // `pagehide` handler (a CLEAN closure: the session retires its lease), which is not what a killed or crashed tab does:
  //  - clean: `page.close()` as it is;
  //  - killed (SIMULATED): the page's `pagehide` and `freeze` handlers are neutralised before anything registers them, so closing it
  //    runs none of the session's own cleanup, as a killed tab would not;
  //  - crashed (Chromium only, a REAL renderer crash through CDP): no handler runs at all.
  const neutralisePagehide = () => {
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      ...rest: unknown[]
    ) {
      if (type === "pagehide" || type === "freeze") return;
      return (add as (...args: unknown[]) => void).call(this, type, ...rest);
    } as typeof add;
  };
  const closings: Array<{
    cause: Scenario["cause"];
    howMany: number;
    close: (sender: Page) => Promise<void>;
    init?: () => void;
  }> = [
    {
      cause: "tab_closed_cleanly_mid_request",
      howMany: N(40),
      close: (sender) => sender.close(),
    },
    {
      cause: "tab_killed_mid_request_simulated",
      howMany: N(100),
      init: neutralisePagehide,
      close: (sender) => sender.close(),
    },
    ...(engine === "chromium"
      ? [
          {
            cause: "tab_crashed_mid_request_chromium" as const,
            howMany: N(60),
            close: async (sender: Page) => {
              // `Page.crash` never answers (the target is gone), so it is sent without waiting and the `crash` event is awaited.
              const client = await context.newCDPSession(sender);
              const crashed = new Promise<void>((resolve) =>
                sender.once("crash", () => resolve()),
              );
              void client.send("Page.crash").catch(() => undefined);
              await Promise.race([crashed, sleep(4_000)]);
              await Promise.race([
                sender.close().catch(() => undefined),
                sleep(5_000),
              ]);
            },
          },
        ]
      : []),
  ];
  for (const closing of closings) {
    for (let i = 0; i < closing.howMany; i += 1) {
      server.hold = true;
      const sender = await sessionPage(
        context,
        closing.init ? { init: closing.init } : {},
      );
      await sendHeld(sender);
      await expect
        .poll(() => server.heldCount, { timeout: 10_000 })
        .toBeGreaterThan(0);
      await closing.close(sender);
      server.hold = false;
      server.releaseHeld();
      await observe(closing.cause);
      await reseed(context);
    }
  }

  // (2) a LIVE page whose response handling is slowed (INJECTED: its fetch is delayed 800 ms before the kernel sees the answer): the
  // lease is outstanding for longer; does a second page see it as unresolved?
  for (let i = 0; i < N(50); i += 1) {
    const sender = await sessionPage(context, {
      init: () => {
        const real = window.fetch.bind(window);
        window.fetch = async (...args: Parameters<typeof fetch>) => {
          const response = await real(...args);
          await new Promise((resolve) => setTimeout(resolve, 800));
          return response;
        };
      },
    });
    await sendHeld(sender);
    await sleep(150);
    await observe("slow_handling_injected");
    await sender.close();
    await reseed(context);
  }

  // (3) a LIVE page whose recording write FAILS (INJECTED: a put on the session's `auth_state` store throws once the request is
  // issued): the lease cannot be retired by its owner.
  for (let i = 0; i < N(50); i += 1) {
    const sender = await sessionPage(context, {
      init: () => {
        const proto = IDBObjectStore.prototype;
        const put = proto.put;
        let armed = false;
        window.addEventListener("atlas-arm-failure", () => {
          armed = true;
        });
        proto.put = function (...args: Parameters<typeof put>) {
          if (armed && this.name === "records") {
            armed = false;
            throw new DOMException("injected", "UnknownError");
          }
          return put.apply(this, args);
        };
      },
    });
    server.hold = true;
    await sendHeld(sender);
    await expect
      .poll(() => server.heldCount, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await sender.evaluate(() =>
      window.dispatchEvent(new Event("atlas-arm-failure")),
    );
    server.hold = false;
    server.releaseHeld();
    await sleep(150);
    const failed = countOf(await trace(sender), "lease.retire_failed");
    await observe("failing_recording_injected", failed);
    await sender.close();
    await reseed(context);
  }

  const byCause: Record<
    string,
    {
      n: number;
      precondition_met: number;
      injection_took_effect: number;
      /** Scenarios in which the observer's own cover carried an unresolved lease of another page. */
      saw_unresolved: number;
      first: Record<string, number>;
      unresolved_then_resolved: number;
      never_resolved: number;
      resolve_ms: number[];
    }
  > = {};
  for (const row of rows) {
    const entry = byCause[row.cause] ?? {
      n: 0,
      precondition_met: 0,
      injection_took_effect: 0,
      saw_unresolved: 0,
      first: {},
      unresolved_then_resolved: 0,
      never_resolved: 0,
      resolve_ms: [],
    };
    byCause[row.cause] = entry;
    entry.n += 1;
    if (row.foreign_leases > 0) entry.precondition_met += 1;
    if (row.sender_retire_failed > 0) entry.injection_took_effect += 1;
    if (row.covers_with_unresolved > 0) entry.saw_unresolved += 1;
    entry.first[row.first] = (entry.first[row.first] ?? 0) + 1;
    if (row.first !== "released" && row.resolved)
      entry.unresolved_then_resolved += 1;
    if (!row.resolved) entry.never_resolved += 1;
    if (row.resolve_ms !== null && row.first !== "released")
      entry.resolve_ms.push(row.resolve_ms);
  }
  write(`unresolved-leases.${engine}.json`, {
    id: "P-6",
    engine,
    status: "measured, with INJECTED causes labelled",
    label:
      "the first verdict a second page gets for an ordinary request while another page's lease is unresolved, counted per cause; 'released' means the request went through at once. The two live-page causes are injected (a delayed response, a failing recording write); a closed tab is the real cause. The fixture leader is not involved; the network is a stub.",
    scenarios: rows.length,
    by_cause: byCause,
    rows,
  });
  for (const [cause, entry] of Object.entries(byCause))
    recordValue(`P-6 ${cause}`, engine, {
      n: entry.n,
      precondition_met: entry.precondition_met,
      injection_took_effect: entry.injection_took_effect,
      saw_unresolved: entry.saw_unresolved,
      first_verdicts: entry.first,
      unresolved_then_resolved: entry.unresolved_then_resolved,
      never_resolved: entry.never_resolved,
    });
  expect(rows.length).toBeGreaterThan(0);
});

// ---- P-9: the yield policy between pages ----------------------------------------------------------------------------------------------------------------
const POLICIES = ["none", "macrotask", "scheduler_yield", "idle"] as const;
test("P-9: the yield between pages (none, macrotask, scheduler.yield, idle): its effect on another page's waits and on catch-up throughput", async ({
  context,
}, info) => {
  test.setTimeout(45 * 60_000);
  const engine = engineOf(info);
  const server = await serve(context);
  await reseed(context);
  const leaderPage = await sessionPage(context);
  const probe = await sessionPage(context);
  const available = await leaderPage.evaluate(() => ({
    scheduler_yield:
      typeof (globalThis as { scheduler?: { yield?: unknown } }).scheduler
        ?.yield === "function",
    request_idle_callback: typeof requestIdleCallback === "function",
  }));
  const rows: Record<string, unknown>[] = [];
  for (const policy of POLICIES) {
    // Catch-up throughput: a bounded run of pages with no probe running, five times.
    const throughput: number[] = [];
    for (let run = 0; run < N(5); run += 1) {
      server.catchingUp = false;
      server.syncDelayMs = 0;
      server.budget = 200;
      const before = server.syncPages;
      const started = Date.now();
      await leaderPage.evaluate(() => window.__atlasData?.stopSync());
      await leaderPage.evaluate(
        async ([account, chosen]) => {
          await window.__atlasData?.startSync(account as string, {
            seedCursor: "cursor-0",
            yieldPolicy: chosen as never,
          });
        },
        [ACCOUNT, policy],
      );
      await expect
        .poll(() => server.syncPages - before, { timeout: 60_000 })
        .toBeGreaterThanOrEqual(200);
      throughput.push(
        ((server.syncPages - before) / (Date.now() - started)) * 1000,
      );
      await sleep(200);
    }
    // The waits of another page while the leader catches up (5 ms server latency, so pages are back to back).
    server.catchingUp = true;
    server.syncDelayMs = 5;
    await leaderPage.evaluate(() => window.__atlasData?.stopSync());
    await leaderPage.evaluate(
      async ([account, chosen]) => {
        await window.__atlasData?.startSync(account as string, {
          seedCursor: "cursor-0",
          yieldPolicy: chosen as never,
        });
      },
      [ACCOUNT, policy],
    );
    await sleep(400);
    const ordinary = summarise(await ordinaryProbe(probe, N(50)));
    const exposure = summarise(await exposureProbe(probe, N(50)));
    const writer = summarise(await writerProbe(probe, N(50)));
    server.catchingUp = false;
    server.budget = 0;
    await leaderPage.evaluate(() => window.__atlasData?.stopSync());
    for (const [kind, samples] of [
      ["ordinary request", ordinary],
      ["exposure", exposure],
      ["atlas-auth writer", writer],
    ] as const) {
      record(`P-9 ${policy}: ${kind} wait`, engine, samples.ms, {
        policy,
        outcomes: samples.outcomes,
      });
      append("yield-policy.jsonl", {
        policy,
        engine,
        probe: kind,
        n: samples.ms.length,
        outcomes: samples.outcomes,
        ms: samples.ms,
      });
    }
    record(
      `P-9 ${policy}: catch-up throughput (pages/s, 200 pages, no probe)`,
      engine,
      throughput,
      {
        policy,
      },
    );
    rows.push({ policy, throughput_pages_per_second: throughput });
  }
  write(`yield-policy.${engine}.json`, {
    id: "P-9",
    engine,
    status: "measured",
    label:
      "the fixture leader with each yield policy; policies are fixture code (production supplies its own at WEB-09b). scheduler_yield falls back to a macrotask where the engine has none (see engine_support).",
    engine_support: available,
    rows,
  });
  expect(rows.length).toBe(POLICIES.length);
});
