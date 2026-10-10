import {
  createQuotaGuard,
  type QuotaGuard,
  type StorageLike,
} from "../../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../../src/data/model/config";
import type { FakeOrigin } from "./origin-ledger";

/**
 * A model of the browser's free-space estimate and of the clocks a page reads (R28, revision 17), for the schedules in which the AGE of a
 * reading and the STEP of a clock matter.
 *
 * - The browser shows a write that has landed only in an estimate REQUESTED at least one estimate lifetime after it landed, in real time
 *   (the lag the guard assumes: `quotaEstimateTtlMs`). A request answers what the origin held when it BEGAN, whenever the answer is
 *   delivered (`hold()` delays delivery, never what is answered): a reading is as old as its request.
 * - `real` is the time that really passed (what a page's monotonic clock reads); `offset` is how far the wall clock is from it. `step`
 *   moves the wall clock (a person sets the time, a time service corrects it) and moves nothing else; `advance` moves both.
 *
 * It is a model of the contract the guard relies on, not of a browser: no native quota is exhausted and no clock is really altered.
 */
export interface AgeWorld {
  real: number;
  offset: number;
  /** The wall clock: `Date.now()` as the page reads it. */
  wall(): number;
  advance(ms: number): void;
  /** A step of the wall clock (positive forwards, negative backwards). */
  step(ms: number): void;
  /** `bytes` have landed now, in real time: the estimate shows them from one lifetime later. */
  wrote(bytes: number): void;
  /** `real` at each request for the estimate, in order (every page's). */
  requests: number[];
  /** The same, by the page that asked (`guard`'s `name`). */
  asked: Record<string, number[]>;
  /** The next request for the estimate is delivered only after `release()` (what it answers is still what was true when it began). */
  hold(): { release(): void };
  storage(quota: number, page?: string): StorageLike;
  /** A page's guard over the origin's ledger. `monotonic: true` gives it the page's monotonic clock (`real`); otherwise it has the wall clock only. */
  guard(
    origin: FakeOrigin,
    name: string,
    quota: number,
    options?: { monotonic?: boolean },
  ): QuotaGuard;
}

export function ageWorld(start = 0): AgeWorld {
  const landed: Array<{ at: number; bytes: number }> = [];
  const gates: Array<Promise<void>> = [];
  const world: AgeWorld = {
    real: start,
    offset: 0,
    wall: () => world.real + world.offset,
    advance(ms) {
      world.real += ms;
    },
    step(ms) {
      world.offset += ms;
    },
    wrote(bytes) {
      landed.push({ at: world.real, bytes });
    },
    requests: [],
    asked: {},
    hold() {
      let release: () => void = () => undefined;
      gates.push(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return { release: () => release() };
    },
    storage(quota, page = "-") {
      return {
        estimate: async () => {
          const began = world.real;
          world.requests.push(began);
          const log = world.asked[page] ?? [];
          log.push(began);
          world.asked[page] = log;
          const gate = gates.shift();
          if (gate !== undefined) await gate;
          let usage = 0;
          for (const write of landed)
            if (write.at + DATA_CONFIG.quotaEstimateTtlMs <= began)
              usage += write.bytes;
          return { usage, quota };
        },
      };
    },
    guard(origin, name, quota, options = {}) {
      return createQuotaGuard({
        storage: world.storage(quota, name),
        now: () => world.wall(),
        ...(options.monotonic ? { monotonic: () => world.real } : {}),
        ledger: origin.page(name).ledger,
      });
    },
  };
  return world;
}
