import type { Page } from "@playwright/test";

/**
 * The D5 collector (revision 38, Q15 of the design assessment of review 37). D5 measures a Web-Locks-serialised read-modify-write of one
 * `localStorage` record across three pages; its locked half once did not finish in WebKit (revision 34) and nothing then recorded why. This
 * records, per page and per iteration of the loop, how far each Web Lock request got, and, when a half stops progressing, what the
 * browser's lock manager says, so a stall is CLASSIFIED rather than inferred from a count:
 *
 *  - `requested`: requests made; `granted`: callbacks entered; `exited`: callbacks returned; `settled`: request promises resolved (the
 *    lock was released and the page was told). A page whose `requested` exceeds `granted` is waiting for a grant; `granted` over `exited`
 *    is inside its callback; `exited` over `settled` returned from its callback and was not told of the release.
 *  - The lock manager's view (`navigator.locks.query()`, read by the TEST only, bounded) names the holder and the queue of the lock, and
 *    each page names its own client id through a lock of its own (`d5-whoami:<page>`), so a holder is a page of the three, another
 *    client, or nobody (a grant that was never delivered).
 *  - A page that does not answer within the bound is named as such (an unresponsive page), distinct from one that answers with an
 *    unfinished count; a page that reports its loop finished while the test never received the answer is named too.
 *
 * Nothing here changes the loop's work: the counters are increments in page memory beside the original read-modify-write, and the lock
 * manager is read only when a half has stopped progressing (or by the controls). FIXTURE diagnostics: what an engine did, not a product
 * behaviour.
 */
export const D5_PAGES = 3;
export const D5_STEPS = 400;

/** What the page-side loop records for one key (`window.__d5State[key]`). */
export interface LoopState {
  requested: number;
  granted: number;
  exited: number;
  settled: number;
  count: number;
  lastRequestAt: number | null;
  lastGrantAt: number | null;
  lastExitAt: number | null;
  lastSettleAt: number | null;
  done: boolean;
}

export interface LockEntry {
  name: string;
  clientId: string;
  mode: string;
}

export interface Snapshot {
  answered: true;
  /** The page's own `performance.now()` when it answered. */
  at: number;
  state: LoopState | null;
  /** This page's client id, read through its own `d5-whoami` lock (`null`: the probe was not granted within the bound). */
  clientId: string | null;
  /** The lock manager's view of the measured lock (`null`: not asked, or not answered within the bound). */
  manager: { held: LockEntry[]; pending: LockEntry[] } | null;
}
export type Report = Snapshot | { answered: false };

/** What happens inside the callback of one iteration (the controls' faults; the measurement uses `none`). */
export type Fault =
  | { kind: "none" }
  /** At iteration `at`, the callback never returns. */
  | { kind: "block"; at: number }
  /** Every callback waits `ms` (a responsive, slow page). */
  | { kind: "slow"; ms: number }
  /** At iteration `at`, the page's main thread is busy for `ms` inside the callback (it cannot answer meanwhile). */
  | { kind: "busy"; at: number; ms: number };

export interface LoopOptions {
  id: string;
  key: string;
  locked: boolean;
  fault?: Fault;
}

/**
 * Runs the D5 loop in `page` (the original read-modify-write, 400 steps, locked or not) and records its progress. Resolves with the
 * number of steps made, exactly as the measurement's loop did.
 */
export function runLoop(page: Page, options: LoopOptions): Promise<number> {
  return page.evaluate(
    async ({ id, key, locked, fault, steps }) => {
      const host = window as unknown as {
        __d5?: Record<string, number>;
        __d5State?: Record<string, LoopState>;
      };
      const progress: Record<string, number> = host.__d5 ?? {};
      host.__d5 = progress;
      const states: Record<string, LoopState> = host.__d5State ?? {};
      host.__d5State = states;
      const s: LoopState = {
        requested: 0,
        granted: 0,
        exited: 0,
        settled: 0,
        count: 0,
        lastRequestAt: null,
        lastGrantAt: null,
        lastExitAt: null,
        lastSettleAt: null,
        done: false,
      };
      states[key] = s;
      const step = () => {
        const raw = localStorage.getItem(key);
        const record =
          raw === null
            ? { items: [] as string[] }
            : (JSON.parse(raw) as { items: string[] });
        record.items.push(`${id}:${record.items.length}`);
        localStorage.setItem(key, JSON.stringify(record));
      };
      const inside = async (i: number) => {
        if (fault.kind === "block" && i === fault.at)
          await new Promise<never>(() => undefined);
        if (fault.kind === "slow")
          await new Promise((resolve) => setTimeout(resolve, fault.ms));
        if (fault.kind === "busy" && i === fault.at) {
          const end = performance.now() + fault.ms;
          while (performance.now() < end) {
            // The page's main thread is busy: it answers nothing meanwhile.
          }
        }
      };
      // Without a fault the callback is synchronous, as the measurement's always was: nothing but the counters is added to its work.
      const plain = fault.kind === "none";
      for (let i = 0; i < steps; i += 1) {
        if (locked) {
          s.requested += 1;
          s.lastRequestAt = performance.now();
          await navigator.locks.request(
            `rmw:${key}`,
            plain
              ? () => {
                  s.granted += 1;
                  s.lastGrantAt = performance.now();
                  step();
                  s.exited += 1;
                  s.lastExitAt = performance.now();
                }
              : async () => {
                  s.granted += 1;
                  s.lastGrantAt = performance.now();
                  await inside(i);
                  step();
                  s.exited += 1;
                  s.lastExitAt = performance.now();
                },
          );
          s.settled += 1;
          s.lastSettleAt = performance.now();
        } else {
          if (!plain) await inside(i);
          step();
        }
        s.count += 1;
        progress[key] = s.count;
        if (!locked && i % 7 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      s.done = true;
      return s.count;
    },
    {
      id: options.id,
      key: options.key,
      locked: options.locked,
      fault: options.fault ?? ({ kind: "none" } as Fault),
      steps: D5_STEPS,
    },
  );
}

/**
 * One bounded report of `page`: its loop state, and (with `manager`) its client id and the lock manager's view of `rmw:<key>`. Every
 * part of it is bounded: a page that does not answer within `answerMs` is `{ answered: false }`.
 */
export function report(
  page: Page,
  key: string,
  index: number,
  options: { answerMs: number; manager: boolean },
): Promise<Report> {
  const asked = page
    .evaluate(
      async ({ k, index: n, manager, boundMs }) => {
        const host = window as unknown as {
          __d5State?: Record<string, LoopState>;
        };
        const at = performance.now();
        const state = host.__d5State?.[k] ?? null;
        if (!manager)
          return {
            answered: true as const,
            at,
            state: state === null ? null : { ...state },
            clientId: null,
            manager: null,
          };
        const bounded = <T>(work: Promise<T>): Promise<T | null> =>
          Promise.race([
            work,
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), boundMs),
            ),
          ]);
        const whoami = `d5-whoami:${n}:${Math.random()}`;
        const clientId = await bounded(
          navigator.locks.request(whoami, { ifAvailable: true }, async () => {
            const view = await navigator.locks.query();
            return (
              view.held?.find((lock) => lock.name === whoami)?.clientId ?? null
            );
          }),
        );
        const view = await bounded(navigator.locks.query());
        const pick = (entries: LockSnapshotLike[] | undefined) =>
          (entries ?? [])
            .filter((lock) => lock.name === `rmw:${k}`)
            .map((lock) => ({
              name: lock.name ?? "",
              clientId: lock.clientId ?? "",
              mode: lock.mode ?? "",
            }));
        interface LockSnapshotLike {
          name?: string;
          clientId?: string;
          mode?: string;
        }
        return {
          answered: true as const,
          at,
          state: state === null ? null : { ...state },
          clientId,
          manager:
            view === null
              ? null
              : { held: pick(view.held), pending: pick(view.pending) },
        };
      },
      {
        k: key,
        index,
        manager: options.manager,
        boundMs: Math.max(1, Math.floor(options.answerMs / 2)),
      },
    )
    .catch(() => ({ answered: false as const }));
  return Promise.race([
    asked,
    new Promise<Report>((resolve) =>
      setTimeout(() => resolve({ answered: false }), options.answerMs),
    ),
  ]);
}

export type Verdict =
  /** The loop finished (and the test received its answer, unless `unanswered`). */
  | { kind: "finished"; unanswered: boolean }
  /** The page did not answer within the bound: its main thread is busy, or it is gone. */
  | { kind: "no_answer" }
  /** The page answered and has not started the loop. */
  | { kind: "not_started" }
  /** Waiting for a grant: the lock is held by `holder` (one of the pages, `other` for another client, `none` for nobody). */
  | {
      kind: "waiting";
      holder: string;
      queued: boolean | null;
    }
  /** Inside its callback (entered, not returned). */
  | { kind: "in_callback" }
  /** Returned from its callback and not told of the release. */
  | { kind: "release_undelivered" }
  /** Between two steps of its own (nothing outstanding with the lock manager). */
  | { kind: "between_steps" };

/**
 * The verdict of each page from its report, the reports of the others (their client ids name the holder) and whether its answer reached
 * the test. Pure: the controls check it against faults they install.
 */
export function classify(
  reports: readonly Report[],
  answered: readonly boolean[],
): Verdict[] {
  const ids = reports.map((r) => (r.answered ? r.clientId : null));
  const manager =
    reports.find(
      (r): r is Snapshot =>
        r.answered && r.manager !== null && r.manager !== undefined,
    )?.manager ?? null;
  const nameOf = (clientId: string): string => {
    const index = ids.indexOf(clientId);
    return index >= 0 ? `p${index}` : "other";
  };
  return reports.map((r, index) => {
    if (!r.answered) return { kind: "no_answer" };
    const s = r.state;
    if (s === null) return { kind: "not_started" };
    if (s.done) return { kind: "finished", unanswered: !answered[index] };
    if (s.requested > s.granted) {
      const own = ids[index];
      const holder =
        manager === null
          ? "unknown"
          : manager.held.length === 0
            ? "none"
            : nameOf(manager.held[0]?.clientId ?? "");
      const queued =
        manager === null || own === null
          ? null
          : manager.pending.some((lock) => lock.clientId === own);
      return { kind: "waiting", holder, queued };
    }
    if (s.granted > s.exited) return { kind: "in_callback" };
    if (s.exited > s.settled) return { kind: "release_undelivered" };
    return { kind: "between_steps" };
  });
}

/** A short line per page for a failure message or a record. */
export function describe(
  reports: readonly Report[],
  verdicts: readonly Verdict[],
): string {
  return verdicts
    .map((v, index) => {
      const r = reports[index];
      const s = r?.answered ? r.state : null;
      const counts =
        s === null
          ? ""
          : ` [count ${s.count}, requested ${s.requested}, granted ${s.granted}, exited ${s.exited}, settled ${s.settled}]`;
      const detail =
        v.kind === "waiting"
          ? `waiting, held by ${v.holder}${v.queued === null ? "" : v.queued ? ", queued" : ", NOT queued"}`
          : v.kind === "finished"
            ? `finished${v.unanswered ? " (its answer did not reach the test)" : ""}`
            : v.kind.replace(/_/g, " ");
      return `p${index} ${detail}${counts}`;
    })
    .join("; ");
}
