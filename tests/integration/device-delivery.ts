import type { Page } from "@playwright/test";

/**
 * WEB-18 revision 3 (review 3 F-R9, family `integration-case-opens-cache-reading-ui-without-sync-barrier`; design assessment C-1):
 * the ONE way an integration case waits until "this page's device holds what the server holds".
 *
 * The helpers of a case write to the server with page-level stamped requests, which bypass the outbox: nothing tells the sync engine
 * that the server moved. Only a sync read that STARTS after the write can bring it in. And the engine deliberately keeps its own
 * schedule over a nudge that arrives while a step runs: a step that ends in the idle poll keeps that deadline, so the nudge is lost
 * until the next timer (`sync-engine.ts` `tick`/`settle`; pinned for a notification by `tests/data/pending-wake.test.ts` and for
 * `nudge("now")` by `device-delivery.test.ts`). `bootAs` ends with `startSync`, so a step is in flight when a case makes its first write.
 * A single nudge followed by a passive wait therefore races the engine's timers (F-R9), and a bare UI timeout waits for them (the
 * latent waits of G1 to G9). So:
 *
 * - I-1: every wait is a poll whose BODY nudges sync and whose predicate is observed device state (`driveUntilHeld`).
 * - I-2: the predicate is monotone and durable: the applied revision has reached the wanted revision AND every named task row is in
 *   the cache, read in that order (both are written by the same commit and only grow, so a later assertion cannot race it).
 * - I-3: a revision bound is the WRITER's own receipt revision, used only on the writer's own device; another account's device waits
 *   for the rows alone (the callers pass `revision` only when the reading account wrote it).
 * - I-4: a wait that ends without the state says what was missing: wanted and applied revision, the tasks not held, the engine's
 *   state and its last steps.
 * - I-5: the limit only bounds a held or stopped engine: a driven wait ends about one step after the state is on the server.
 * - I-7: a case that stops sync (I-18-G7a) never waits on the device afterwards.
 * - I-8: `nudgeSync` is called by this module alone (guarded by `device-delivery.test.ts`).
 *
 * `judgeDelivery` and `driveUntilHeld` are pure (no Playwright), so `device-delivery.test.ts` drives the very same loop against the real
 * sync engine under fake time. `untilDeviceHolds` is the thin Playwright wrapper; it RETURNS the verdict, and the spec asserts
 * `.toBe("held")` at its own line, so a failure is located in the case and its message carries the cause.
 */

/** A task the case wrote, named in a wait (its title is only for the message). */
export interface DeviceTask {
  taskId: string;
  title?: string;
}

export interface DeviceWant {
  /** The writer's own receipt revision (I-3); omitted when the reading device is another account's. */
  revision?: number;
  tasks: DeviceTask[];
}

/** One reading of the page's device. */
export interface DeviceReading {
  /** `sync_state.applied_revision` (0 when absent). */
  applied: number;
  /** The wanted task ids the cache holds. */
  held: string[];
  /** The engine's state, as text (`idle`, `running`, `backing_off`, `none`...). */
  engine: string;
  /** The engine's last steps (`data.sync_tick` trace entries), for the message only. */
  steps?: string[];
}

export const HELD = "held";

/** Whether one reading meets the want: `"held"`, or a sentence that names what is missing (I-4). */
export function judgeDelivery(
  want: DeviceWant,
  reading: DeviceReading,
): string {
  if (want.revision === undefined && want.tasks.length === 0)
    return "nothing to wait for: a wait names a revision or a task";
  const problems: string[] = [];
  if (want.revision !== undefined && !(reading.applied >= want.revision))
    problems.push(`applied revision ${reading.applied} of ${want.revision}`);
  const held = new Set(reading.held);
  const missing = want.tasks.filter((t) => !held.has(t.taskId));
  if (missing.length > 0)
    problems.push(
      `missing ${missing.length} of ${want.tasks.length} (${missing
        .map((t) => (t.title ? `“${t.title}”` : t.taskId))
        .join(", ")})`,
    );
  if (problems.length === 0) return HELD;
  const steps = reading.steps?.length
    ? `; last steps ${reading.steps.join(" | ")}`
    : "";
  return `waiting: ${problems.join("; ")}; engine ${reading.engine}${steps}`;
}

/** What the driven loop needs from its world: the real page, or the engine world of the unit test. */
export interface DeliveryIo {
  /** Asks the engine for a step now (a nudge that finds a step running may be lost: the next pass nudges again). */
  nudge(): Promise<void>;
  read(): Promise<DeviceReading>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface DeliveryOptions {
  /** Bounds a held or stopped engine only (I-5). */
  timeout?: number;
  interval?: number;
}

/**
 * Nudges, reads and judges until the want is held or the limit has passed; returns `"held"` or the last judgement with the elapsed
 * time. Every pass nudges (I-1): a nudge lost to a running step is followed by another once that step has ended.
 */
export async function driveUntilHeld(
  io: DeliveryIo,
  want: DeviceWant,
  { timeout = 60_000, interval = 500 }: DeliveryOptions = {},
): Promise<string> {
  const start = io.now();
  for (;;) {
    await io.nudge();
    const verdict = judgeDelivery(want, await io.read());
    if (verdict === HELD) return HELD;
    const elapsed = io.now() - start;
    if (elapsed >= timeout || verdict.startsWith("nothing to wait for"))
      return `${verdict} (after ${elapsed} ms of ${timeout})`;
    await io.sleep(interval);
  }
}

/** The page's device, read in the I-2 order: the applied revision first, then the cache rows. */
function readPage(page: Page, accountId: string, ids: string[]) {
  return page.evaluate(
    async ({ a, ids }) => {
      const data = window.__atlasData;
      if (!data)
        return { applied: 0, held: [], engine: "none (no data harness)" };
      const sync = (await data.rows(a, "sync_state")) as Array<{
        applied_revision?: number | null;
      }>;
      const cache = (await data.rows(a, "cache")) as Array<{ id?: string }>;
      const cached = new Set(cache.map((x) => x.id));
      const state = data.engineState() as
        | ({ kind: string } & Record<string, unknown>)
        | null;
      return {
        applied: sync[0]?.applied_revision ?? 0,
        held: ids.filter((id) => cached.has(id)),
        engine: state
          ? `${state.kind}${typeof state.reason === "string" ? `/${state.reason}` : ""}`
          : "none (no engine)",
        steps: data.engineTrace
          .filter((line) => line.includes("data.sync_tick"))
          .slice(-3),
      };
    },
    { a: accountId, ids },
  );
}

/**
 * Waits, driving sync, until `accountId`'s device in `page` holds `want`. Returns `"held"` or what was missing; assert it with
 * `expect(await untilDeviceHolds(...)).toBe("held")`.
 */
export function untilDeviceHolds(
  page: Page,
  accountId: string,
  want: DeviceWant,
  options?: DeliveryOptions,
): Promise<string> {
  const ids = want.tasks.map((t) => t.taskId);
  return driveUntilHeld(
    {
      nudge: () => page.evaluate(() => window.__atlasData?.nudgeSync()),
      read: () => readPage(page, accountId, ids),
      sleep: (ms) => page.waitForTimeout(ms),
      now: () => Date.now(),
    },
    want,
    options,
  );
}
