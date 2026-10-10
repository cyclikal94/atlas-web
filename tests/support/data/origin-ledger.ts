import type {
  HoldOwners,
  LedgerChange,
  LedgerState,
  OriginLedger,
} from "../../../src/data/store/quota-ledger";
import { EMPTY_LEDGER } from "../../../src/data/store/quota-ledger";

/**
 * A model of the ORIGIN's quota ledger as IndexedDB gives it to several pages (R28): ONE state that every page reads and changes, each
 * operation applied atomically (a read-write transaction is one step), one page's operations entering in the order it made them, and
 * different pages' operations applied in the order they ARRIVE, which a test controls with `delay` (the page's next operation waits for
 * `release()`), `fail` (it rejects) and `hang` (it never arrives). It is a model of the contract the guard relies on, not of the
 * browser: the real IndexedDB ledger has its own tests and its own real-engine specs.
 */
export interface OriginPage {
  ledger: OriginLedger;
  /** Operations of this page that have been applied. */
  applied(): number;
  /**
   * The page is destroyed (R28, revision 15): the platform releases every lock it holds, so its holds can be proven over. A page that
   * is only SUSPENDED (frozen, or its timers throttled) is a page that is not `die`d: its locks stay held.
   */
  die(): void;
}

export interface FakeOrigin {
  /**
   * The ledger as one page sees it: its own queue over the origin's one state. `owners: false` is a ledger WITHOUT owners (its holds are
   * reclaimed by their leases alone, as a ledger of one realm or an older double): the default models production, where every hold has
   * an owner lock.
   */
  page(name: string, options?: { owners?: boolean }): OriginPage;
  /** The tokens whose ownership is held now, by any page (a hold's lock; never read by the code under test). */
  claimed(): string[];
  /** The next `times` claims of `page` fail (the lock manager answers nothing): the page can take no ownership. */
  failClaims(page: string, times?: number): void;
  /**
   * A release is not PUBLISHED at once (the platform's latency, premise P-lock-b): until `publish()` a released ownership is still
   * reported as held, so a probe says `false` and proves nothing.
   */
  delayReleases(): { publish(): void };
  state(): LedgerState;
  /** Every state the ledger was in after an operation was applied, with the page and kind that made it. */
  history: Array<{ page: string; kind: "update" | "peek"; state: LedgerState }>;
  /** The next operation of `page` (and so the ones behind it) waits until `release()` is called. */
  delay(page: string): { release(): void };
  /** The next `times` operations of `page` reject. */
  fail(page: string, times?: number): void;
  /** The failures armed for `page` end (the ledger answers again). */
  heal(page: string): void;
  /** How many operations of `page` were rejected so far (by `fail`). */
  rejected(page: string): number;
  /**
   * The next `times` UPDATES of `page` are applied and then REJECT: the change reached the origin, and the answer was lost (a
   * transaction that committed and reported an error). A call that is asked again must not count the hold its earlier try made.
   */
  loseAnswers(page: string, times?: number): void;
  /** How many times the ownership of a hold was asked about (by any page): a judgement that is not refused asks nobody. */
  probes(): number;
  /** The next operation of `page` never answers by itself; `arrive()` applies it late and answers. */
  hang(page: string): { arrive(): void };
  closed: string[];
  /** Number of writes (operations that stored a state). */
  writes(): number;
}

export function fakeOrigin(initial: LedgerState = EMPTY_LEDGER): FakeOrigin {
  let state: LedgerState = initial;
  let writes = 0;
  const history: FakeOrigin["history"] = [];
  const closed: string[] = [];
  const delays = new Map<string, Array<Promise<void>>>();
  const failures = new Map<string, number>();
  const rejections = new Map<string, number>();
  const lostAnswers = new Map<string, number>();
  let probed = 0;
  const hangs = new Map<
    string,
    Array<{ arrive(): void; promise: Promise<void> }>
  >();
  const applied = new Map<string, number>();
  /** token -> the page that holds its ownership. */
  const claims = new Map<string, string>();
  /** Releases that are not published yet (still reported as held). */
  const unpublished = new Set<string>();
  let delaying = false;
  const claimFailures = new Map<string, number>();

  const copy = (s: LedgerState): LedgerState => ({
    holds: { ...s.holds },
    landed: s.landed === null ? null : { ...s.landed },
  });

  function page(name: string, options?: { owners?: boolean }): OriginPage {
    let tail: Promise<unknown> = Promise.resolve();
    const run = <T>(
      kind: "update" | "peek",
      body: (current: LedgerState) => LedgerChange<T>,
    ): Promise<T> => {
      const task = tail.then(async () => {
        const gate = delays.get(name)?.shift();
        if (gate) await gate;
        const hang = hangs.get(name)?.shift();
        if (hang) {
          await hang.promise;
        }
        const left = failures.get(name) ?? 0;
        if (left > 0) {
          failures.set(name, left - 1);
          rejections.set(name, (rejections.get(name) ?? 0) + 1);
          throw new Error(`the ledger of ${name} failed`);
        }
        const out = body(copy(state));
        if (kind === "update" && out.state !== null) {
          state = out.state;
          writes += 1;
        }
        applied.set(name, (applied.get(name) ?? 0) + 1);
        history.push({ page: name, kind, state: copy(state) });
        const lost = lostAnswers.get(name) ?? 0;
        if (kind === "update" && lost > 0) {
          lostAnswers.set(name, lost - 1);
          rejections.set(name, (rejections.get(name) ?? 0) + 1);
          throw new Error(`the answer of the ledger of ${name} was lost`);
        }
        return out.result;
      });
      tail = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    };
    const release = (token: string): void => {
      if (claims.get(token) !== name) return;
      if (delaying) unpublished.add(token);
      else claims.delete(token);
    };
    const owners: HoldOwners = {
      async claim(token) {
        const left = claimFailures.get(name) ?? 0;
        if (left > 0) {
          claimFailures.set(name, left - 1);
          return null;
        }
        if (claims.has(token)) return null;
        claims.set(token, name);
        let released = false;
        return {
          release() {
            if (released) return;
            released = true;
            release(token);
          },
        };
      },
      async released(token) {
        probed += 1;
        return !claims.has(token);
      },
    };
    return {
      applied: () => applied.get(name) ?? 0,
      die() {
        for (const [token, holder] of [...claims])
          if (holder === name) {
            claims.delete(token);
            unpublished.delete(token);
          }
      },
      ledger: {
        shared: true,
        update: (change) => run("update", change),
        peek: (read) => run("peek", (s) => ({ state: null, result: read(s) })),
        ...(options?.owners === false ? {} : { owners }),
        close() {
          closed.push(name);
        },
      },
    };
  }

  return {
    page,
    claimed: () => [...claims.keys()],
    failClaims(name, times = 1) {
      claimFailures.set(name, (claimFailures.get(name) ?? 0) + times);
    },
    delayReleases() {
      delaying = true;
      return {
        publish() {
          for (const token of unpublished) claims.delete(token);
          unpublished.clear();
          delaying = false;
        },
      };
    },
    state: () => copy(state),
    history,
    closed,
    writes: () => writes,
    delay(name) {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queue = delays.get(name) ?? [];
      queue.push(gate);
      delays.set(name, queue);
      return { release };
    },
    fail(name, times = 1) {
      failures.set(name, (failures.get(name) ?? 0) + times);
    },
    heal(name) {
      failures.set(name, 0);
      lostAnswers.set(name, 0);
    },
    rejected: (name) => rejections.get(name) ?? 0,
    loseAnswers(name, times = 1) {
      lostAnswers.set(name, (lostAnswers.get(name) ?? 0) + times);
    },
    probes: () => probed,
    hang(name) {
      let arrive: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const queue = hangs.get(name) ?? [];
      queue.push({ arrive, promise });
      hangs.set(name, queue);
      return { arrive };
    },
  };
}
