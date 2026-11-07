import type { BrowserContext, Page, Route } from "@playwright/test";
import { ACCOUNT } from "./data-sync-helpers";
import { expect } from "./helpers";

/**
 * R21 (WEB-14a revision 14): what a page's outbox does across a RECONNECT while a local stop stands, observed through the compatibility
 * check the reconnect asks for.
 *
 * Every `online` event withdraws the page's `supported` compatibility answer at once (`src/session/session.ts`, `revalidate`) and asks
 * `/health` again; until a check asked AFTER that reconnect answers, the dispatcher holds queued writes (`held / compat_unconfirmed`, which
 * takes precedence over the stopped projection). The observers that stood here before (E-O9/E-O10, WEB-09a revisions 27 to 31) dispatched
 * `online` and read the state at once, so they read the compatibility hold, not the stop: a harness observation that predates the reconnect
 * guard (review R21 of WEB-14a revision 13). These helpers make the compatibility schedule EXPLICIT instead of tolerating it:
 *
 * - the page's `/health` requests go through a gate that holds them on request (`healthGate`): a wake is observed while the check is held
 *   (exactly `held / compat_unconfirmed`, compatibility exactly `unknown`), then while the fresh `supported` answer has been APPLIED (the
 *   session cell is read, not the response released) and the dispatcher is back in the caller's EXACT stopped state;
 * - the stop's facts are read raw at every sample of both phases and must equal what they were when the observation began: the durable
 *   failure counts, the names of every marker instance (`atlas-write-failing:` keys, read by listing the real `localStorage`, never through
 *   the reads a case makes fail), the local warning, and every queued draft (its command digest, attempts and retry state);
 * - the commands the network stub recorded (every send, as it happens) must equal those recorded before the observation began, at every
 *   sample, so a send between two samples is still seen.
 *
 * Nothing here supplies a compatibility answer to the page directly, shortens a production timer (the health timeout is 3 s and a held
 * phase stays well inside it; a check that timed out reads `unreachable` and fails as a precondition, never as the held control) or
 * clears a stop. FIXTURE evidence: the `/health` answers are scripted.
 */

/** The dispatcher's state while a reconnect's check has not answered. */
export const COMPAT_HELD = { kind: "held", reason: "compat_unconfirmed" };

/** What a held `/health` request is finally answered with. */
export type HealthAnswer =
  | { kind: "version"; version: string | null }
  | { kind: "status"; status: number }
  | { kind: "abort" };
export const SUPPORTED: HealthAnswer = { kind: "version", version: "0.31.0" };

interface PageGate {
  holding: boolean;
  requests: number;
  held: Route[];
}
export interface HealthGate {
  /** `/health` requests this page made since the gate was installed. */
  requests(): number;
  /** Requests held now. */
  pending(): number;
  /** Hold every `/health` request this page makes from now on. */
  hold(): void;
  /** Answer the OLDEST held request (holding goes on for later ones). */
  answerOldest(answer?: HealthAnswer): Promise<void>;
  /** Stop holding and answer every held request. */
  release(answer?: HealthAnswer): Promise<void>;
}

const gates = new WeakMap<BrowserContext, Map<Page, PageGate>>();

async function answer(route: Route, with_: HealthAnswer): Promise<void> {
  try {
    if (with_.kind === "abort") await route.abort("connectionreset");
    else if (with_.kind === "status")
      await route.fulfill({
        status: with_.status,
        contentType: "application/json",
        body: "{}",
      });
    else
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          with_.version === null
            ? { status: "ok" }
            : { status: "ok", api_version: with_.version },
        ),
      });
  } catch {
    // The page gave the request up (its own timeout or a navigation): there is nothing left to answer.
  }
}

/**
 * The page's `/health` gate. Registered on the context AFTER `stubNetwork` (a later route wins); requests of other pages, and of this page
 * while nothing is held, fall back to the stub's own answer.
 */
export async function healthGate(page: Page): Promise<HealthGate> {
  const context = page.context();
  let pages = gates.get(context);
  if (pages === undefined) {
    const installed = new Map<Page, PageGate>();
    pages = installed;
    gates.set(context, installed);
    await context.route("**/health", async (route) => {
      let owner: Page | null = null;
      try {
        owner = route.request().frame().page();
      } catch {
        owner = null;
      }
      const gate = owner === null ? undefined : installed.get(owner);
      if (gate === undefined) return route.fallback();
      gate.requests += 1;
      if (!gate.holding) return route.fallback();
      gate.held.push(route);
    });
  }
  let gate = pages.get(page);
  if (gate === undefined) {
    gate = { holding: false, requests: 0, held: [] };
    pages.set(page, gate);
  }
  const state = gate;
  return {
    requests: () => state.requests,
    pending: () => state.held.length,
    hold() {
      state.holding = true;
    },
    async answerOldest(with_ = SUPPORTED) {
      const route = state.held.shift();
      if (route !== undefined) await answer(route, with_);
    },
    async release(with_ = SUPPORTED) {
      state.holding = false;
      for (const route of state.held.splice(0)) await answer(route, with_);
    },
  };
}

/** One sample: compatibility and the dispatcher's state read in ONE synchronous step, then the stop's raw facts. */
export interface StopSnapshot {
  compat: string | null;
  state: unknown;
  binding: { live: boolean; sameService: boolean } | null;
  facts: {
    warning: unknown;
    streaks: Record<string, number>;
    markerKeys: string[];
    queued: unknown[];
  };
}
export const stopSnapshot = (page: Page): Promise<StopSnapshot> =>
  page.evaluate(async (account) => {
    const data = window.__atlasData;
    const session = (
      window as unknown as {
        __atlasFixture?: {
          session?: {
            booted?: {
              session?: { compat: { get(): { status: string } } };
            };
          };
        };
      }
    ).__atlasFixture?.session?.booted?.session;
    const compat = session?.compat.get().status ?? null;
    const state = data?.outboxState() ?? null;
    const bound = data?.outboxBinding() ?? null;
    const warning = data?.outboxStorage() ?? null;
    const markerKeys = Object.keys(localStorage)
      .filter((key) => key.startsWith("atlas-write-failing:"))
      .sort();
    const sync = (await data?.syncState(account)) as {
      local_write_streaks?: Record<string, number>;
    } | null;
    const rows = ((await data?.rows(account, "drafts")) ?? []) as Array<{
      local_id: string;
      status: string;
      command_digest: string;
      attempts: number;
      retry_state: unknown;
      last_error?: unknown;
    }>;
    return {
      compat,
      state,
      binding:
        bound === null
          ? null
          : { live: bound.live, sameService: bound.sameService },
      facts: {
        warning,
        streaks: sync?.local_write_streaks ?? {},
        markerKeys,
        queued: rows
          .filter((row) => row.status === "queued")
          .map((row) => ({
            local_id: row.local_id,
            command_digest: row.command_digest,
            attempts: row.attempts,
            retry_state: row.retry_state ?? null,
            last_error: row.last_error ?? null,
          }))
          .sort((a, b) => a.local_id.localeCompare(b.local_id)),
      },
    };
  }, ACCOUNT);

const FAST = { intervals: [10, 25, 50], timeout: 10_000 };
const sentNow = (net: { commands: unknown[] }) =>
  JSON.parse(JSON.stringify(net.commands)) as unknown[];

/**
 * A reconnect whose check is held: `online` is dispatched, the fresh `/health` request is seen held, and the page is read until
 * compatibility is `unknown` and the dispatcher is exactly `held / compat_unconfirmed`. The gate is left holding; the caller releases it.
 */
export async function reconnectHeld(
  page: Page,
  gate: HealthGate,
): Promise<void> {
  expect(gate.pending(), "R21: no earlier check is held").toBe(0);
  gate.hold();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect
    .poll(() => gate.pending(), {
      ...FAST,
      message: "R21: the reconnect asks /health again",
    })
    .toBe(1);
  await expect
    .poll(
      async () => {
        const s = await stopSnapshot(page);
        return { compat: s.compat, state: s.state };
      },
      { ...FAST, message: "R21: while the check is held the writes are held" },
    )
    .toEqual({ compat: "unknown", state: COMPAT_HELD });
}

/** The held check is answered `supported` and that answer is APPLIED (the session cell says so). */
export async function supportReturns(
  page: Page,
  gate: HealthGate,
): Promise<void> {
  await gate.release(SUPPORTED);
  await expect
    .poll(async () => (await stopSnapshot(page)).compat, {
      ...FAST,
      message: "R21: the fresh supported answer is applied",
    })
    .toBe("supported");
}

/**
 * The stop stands and nothing is sent while the page is observed across TWELVE reconnects (WEB-09a revisions 27 to 31, adapted in WEB-14a
 * revision 14 for R21). For each reconnect: the check is held and the writes are held (`held / compat_unconfirmed`, the first reconnect for
 * twelve samples 50 ms apart, the others for one sample); then the fresh `supported` answer is applied, the dispatcher is back in EXACTLY
 * the state it was in when the observation began, and it is observed under support for at least 50 ms. At every sample the stop's facts,
 * the outbox binding and the commands sent equal what they were at the start; `allowed` is how many commands had been sent before.
 */
export async function staysHeld(
  page: Page,
  net: { commands: unknown[] },
  allowed = 0,
): Promise<void> {
  const gate = await healthGate(page);
  expect(net.commands).toHaveLength(allowed);
  const sent = sentNow(net);
  const base = await stopSnapshot(page);
  expect(
    base.compat,
    "R21 precondition: compatibility is supported when the observation begins",
  ).toBe("supported");
  expect((base.state as { kind?: string } | null)?.kind).toBe("stopped");
  expect(base.binding, "R21 precondition: the harness outbox is bound").toEqual(
    { live: true, sameService: true },
  );
  const same = (s: StopSnapshot, at: string) => {
    expect(s.binding, `${at}: the outbox binding`).toEqual(base.binding);
    expect(s.facts, `${at}: the stop's facts are exactly as recorded`).toEqual(
      base.facts,
    );
    expect(net.commands, `${at}: nothing more is sent`).toEqual(sent);
  };
  for (let wake = 1; wake <= 12; wake += 1) {
    try {
      await reconnectHeld(page, gate);
      for (let sample = 0; sample < (wake === 1 ? 12 : 1); sample += 1) {
        const s = await stopSnapshot(page);
        expect(
          s.compat,
          `reconnect ${wake}, check held: compatibility is unknown (unreachable here means the 3 s health timeout ran out: a precondition failure, not the held control)`,
        ).toBe("unknown");
        expect(s.state, `reconnect ${wake}, check held`).toEqual(COMPAT_HELD);
        same(s, `reconnect ${wake}, check held`);
        if (wake === 1) await page.waitForTimeout(50);
      }
    } finally {
      await gate.release(SUPPORTED);
    }
    await supportReturns(page, gate);
    await expect
      .poll(async () => (await stopSnapshot(page)).state, {
        ...FAST,
        message: `reconnect ${wake}: supported again, the dispatcher is exactly as stopped as before`,
      })
      .toEqual(base.state);
    same(await stopSnapshot(page), `reconnect ${wake}, supported`);
    await page.waitForTimeout(50);
    const after = await stopSnapshot(page);
    expect(after.compat, `reconnect ${wake}, 50 ms supported`).toBe(
      "supported",
    );
    expect(after.state, `reconnect ${wake}, 50 ms supported`).toEqual(
      base.state,
    );
    same(after, `reconnect ${wake}, 50 ms supported`);
  }
}

/**
 * Nothing is sent while the page is observed across twelve reconnects, and the dispatcher ends up stopped. Unlike `staysHeld` it does not
 * require the stopped state or unchanged facts at every sample: after a person's retry the dispatcher passes through `waiting` while the
 * retry resumes it (a transient of the retry, not a send), and the case is about what is sent. The compatibility schedule is explicit as
 * in `staysHeld`: each reconnect's check is held until the writes are held, then answered `supported`, then 50 ms are observed under it.
 */
export async function staysUnsent(
  page: Page,
  net: { commands: unknown[] },
  allowed = 0,
): Promise<void> {
  const gate = await healthGate(page);
  expect(net.commands).toHaveLength(allowed);
  const sent = sentNow(net);
  for (let wake = 1; wake <= 12; wake += 1) {
    try {
      await reconnectHeld(page, gate);
      expect(net.commands, `reconnect ${wake}, check held`).toEqual(sent);
    } finally {
      await gate.release(SUPPORTED);
    }
    await supportReturns(page, gate);
    await page.waitForTimeout(50);
    expect(net.commands, `reconnect ${wake}, 50 ms supported`).toEqual(sent);
  }
  await expect
    .poll(async () => (await stopSnapshot(page)).state, {
      timeout: 10_000,
    })
    .toMatchObject({ kind: "stopped" });
  expect(net.commands).toEqual(sent);
}
