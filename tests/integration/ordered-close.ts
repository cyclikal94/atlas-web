/**
 * WEB-08d revision 34 (review 37 R37-N1, family `offline-continuation-close-lease-premise`): I-13's clean-close premise, established
 * by an ordering boundary and judged from evidence instead of inferred from one empty read.
 *
 * I-13 closes its signed-in document (the seed) and then needs a NEW document to display the settled account with the API
 * unreachable. That is the ordinary offline continuation only when no request of the seed survives its destruction: a surviving
 * request lease is unresolved, and the next document must verify it online before display (src/session/kernel/expose.ts, the
 * protection, not a defect). Revision 33's setup read the record once, found no lease and closed the seed. In review 37's Firefox
 * run the harness `/today` page's `/defaults/snapshot` and two `/daily` reads committed their leases after that read and were
 * abandoned by the close, so the target stayed neutral offline, correctly. An empty read says what was true IN its transaction,
 * not after it.
 *
 * The boundary (the design assessment's test-only ordered close). Every request lease is committed by a cover transaction on the one
 * `records` store of `atlas-auth`, and every auth transaction is READWRITE on that store, so transactions on it run one at a time in
 * creation order, across documents. A separate, non-producing document of the same context (the observer: the harness with
 * `?boot=off`, no session) creates a readwrite transaction on that store and, inside it:
 * - reads the record; unless it settles the expected identity with no attempt, no fence and no lease, it issues nothing more, so its
 *   transaction ends at once and the owners of what it saw can retire it (it never holds a record that is not clean);
 * - when clean, keeps that SAME transaction active with reads only (a chain of `get` requests: the barrier). Any cover created after it
 *   waits behind it; a cover's write is made by its body, in its own document, only after its transaction starts.
 * The seed (and every other listed producer) is closed WHILE the barrier is active: a destroyed document's queued cover can never run
 * its body, and a document's new requests end with it. The barrier is then released, its completion awaited, and the record read
 * again in a new transaction (ordered after every transaction created before it): still the identity, no lease, no fence, no attempt,
 * and no request lock held or requested. Only then is the observer closed, the API refusal installed and the target booted.
 *
 * Nothing is written, cleared or seeded in the record; no product code is changed or paused. A setup that cannot establish the
 * boundary (the record never clean within the setup's bound, an acquisition that never starts, a barrier that ends before every
 * producer is closed, an observer lost, a close that fails, a producer document the caller did not list) STOPS and says why: it is
 * never turned into an offline product pass or failure.
 *
 * `orderedClose` drives the steps over ports (unit-tested with fakes in ordered-close.test.ts); `closeInOrder` binds them to a real
 * browser context; `judgeOrderedClose` (pure) judges the receipt, including the target's ordering when the spec records it. The
 * native controls in integration.pages.spec.ts force the schedules: a request started after the barrier's read (queued, never
 * committed or sent, gone with its document), a request live at the read (declined, then armed once retired), an unlisted producer
 * tab (refused), the barrier's own failures, the engine-level exclusion of a queued write, and, without the barrier, review 37's
 * abandoned request (the target stays closed offline until an online verification resolves it).
 */
import type { BrowserContext, Page } from "@playwright/test";

export const AUTH_NAMES = {
  database: "atlas-auth",
  store: "records",
  version: 1,
} as const;

export interface CloseIdentity {
  account_id: string;
  epoch: number;
  session_id: string;
}

/** What the barrier saw in the record: the settled identity, whether an attempt is in progress, the fence count and the leases. */
export interface RecordSummary {
  settled: CloseIdentity | null;
  attempt: boolean;
  fences: number;
  leases: Record<
    string,
    { account_id?: string; epoch?: number; boot_id?: string; class?: string }
  >;
}

export type ArmResult =
  | { kind: "armed"; snapshot: RecordSummary }
  | { kind: "declined"; snapshot: RecordSummary; reasons: string[] }
  | { kind: "failed"; reason: string };

export type BarrierPhase =
  | "idle"
  | "acquiring"
  | "abandoning"
  | "abandoned"
  | "declining"
  | "armed"
  | "releasing"
  | "completed"
  | "ended_early"
  | "aborted"
  | "lost";

export interface BarrierState {
  phase: BarrierPhase;
  /** Reads the armed transaction has made; it grows while the transaction is active. */
  keepalive: number;
}

export interface BarrierPort {
  arm(identity: CloseIdentity): Promise<ArmResult>;
  /** Abort an acquisition that has not started (it is queued behind another transaction); resolves the settled state. */
  abandon(): Promise<BarrierState>;
  /** Until a declined (or released) transaction has ended. */
  settled(): Promise<BarrierState>;
  state(): Promise<BarrierState>;
  /** Stop the reads, so the transaction commits (it wrote nothing); resolves when it has ended. */
  release(): Promise<BarrierState>;
  reread(): Promise<RecordSummary>;
  locks(): Promise<{ held: string[]; pending: string[] }>;
  /** Whether the observer runs a session (it must not) or has any kernel activity. */
  booted(): Promise<boolean>;
  close(): Promise<void>;
}

export interface ProducerPort {
  name: string;
  close(): Promise<void>;
}

export interface RosterEntry {
  name: string;
  role: "producer" | "observer" | "inert" | "declared-inert" | "unlisted";
}

export interface OrderedCloseReceipt {
  identity: CloseIdentity;
  roster: RosterEntry[];
  /** Service and shared workers of the context (none may run). */
  workers: number;
  observer: { booted: boolean | null };
  arms: Array<{
    seq: number;
    kind: "armed" | "declined" | "failed" | "blocked";
    reasons?: string[];
    snapshot?: RecordSummary;
    /** For a declined or blocked attempt: the barrier's phase once its transaction had ended. */
    settledPhase?: BarrierPhase | "timeout";
  }>;
  keepaliveAtArm: number | null;
  closes: Array<{
    name: string;
    seq: number;
    ok: boolean;
    error?: string;
    phaseAfter: BarrierPhase | null;
    keepaliveAfter: number | null;
  }>;
  release: { seq: number; phase: BarrierPhase | "timeout" | "lost" } | null;
  after: {
    seq: number;
    snapshot: RecordSummary;
    locks: { held: string[]; pending: string[] };
  } | null;
  observerClosed: number | null;
  /** The setup's own reason for stopping; a receipt with a failure never establishes the premise. */
  failure: string | null;
  /** The last sequence number issued (`mark` continues it for the spec's own steps). */
  seq: number;
  /** Recorded by the spec: the API refusal, then the target's boot, and what the target's verifications captured. */
  target?: {
    refusalSeq: number;
    bootSeq: number;
    boot: string;
    producerBoots: string[];
    captured: string[][];
  };
}

export interface OrderedCloseOptions {
  /** Bound on one acquisition (a transaction queued behind another): abandoned after it. */
  acquireMs?: number;
  /** Bound on the whole wait for a clean record (the owners retire what the barrier saw meanwhile). */
  deadlineMs?: number;
  /** Interval between declined attempts. */
  pollMs?: number;
  /** Bound on a declined or released transaction's end. */
  releaseMs?: number;
  /** TEST INSTRUMENTATION: runs once the barrier is armed, before any producer closes (a control forces a late writer here). */
  whileArmed?: () => Promise<unknown>;
  /** TEST INSTRUMENTATION: runs after each declined attempt has ended (a control lets the seed's held request finish here). */
  onDeclined?: (
    result: Extract<ArmResult, { kind: "declined" }>,
  ) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Why a record is not the clean premise for `identity` (empty when it is). Shared by the judge; the page runs its own copy. */
export function cleanReasons(
  snapshot: RecordSummary,
  identity: CloseIdentity,
): string[] {
  const reasons: string[] = [];
  const s = snapshot.settled;
  if (s === null) reasons.push("no settled identity");
  else if (
    s.account_id !== identity.account_id ||
    s.epoch !== identity.epoch ||
    s.session_id !== identity.session_id
  )
    reasons.push(`a different settled identity (${s.account_id}/${s.epoch})`);
  if (snapshot.attempt) reasons.push("an attempt in progress");
  if (snapshot.fences > 0) reasons.push(`${snapshot.fences} fence(s)`);
  const leases = Object.keys(snapshot.leases).sort();
  if (leases.length > 0)
    reasons.push(`unresolved leases ${JSON.stringify(leases)}`);
  return reasons;
}

const TIMEOUT: unique symbol = Symbol("timeout");
function within<T>(
  promise: Promise<T>,
  ms: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T | typeof TIMEOUT> {
  return Promise.race([promise, sleep(ms).then((): typeof TIMEOUT => TIMEOUT)]);
}
const message = (error: unknown) =>
  error instanceof Error ? error.message.split("\n")[0] : String(error);

/**
 * Establish the clean-close boundary over `ports` and close every producer under it. Returns the receipt; `failure` names the
 * first step that could not be established (nothing after it is attempted except the release and the observer's close).
 */
export async function orderedClose(
  ports: {
    barrier: BarrierPort;
    producers: ProducerPort[];
    roster: () => Promise<{ roster: RosterEntry[]; workers: number }>;
  },
  identity: CloseIdentity,
  options: OrderedCloseOptions = {},
): Promise<OrderedCloseReceipt> {
  const acquireMs = options.acquireMs ?? 5_000;
  const deadlineMs = options.deadlineMs ?? 20_000;
  const pollMs = options.pollMs ?? 100;
  const releaseMs = options.releaseMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { barrier } = ports;
  const receipt: OrderedCloseReceipt = {
    identity,
    roster: [],
    workers: 0,
    observer: { booted: null },
    arms: [],
    keepaliveAtArm: null,
    closes: [],
    release: null,
    after: null,
    observerClosed: null,
    failure: null,
    seq: 0,
  };
  const next = () => {
    receipt.seq += 1;
    return receipt.seq;
  };
  const fail = (reason: string) => {
    receipt.failure ??= reason;
  };
  let armed = false;
  // A failing assertion of the caller's instrumentation is the caller's failure: rethrown once the barrier is released and the
  // observer closed, never reported as a lost observer.
  let instrumentation: { error: unknown } | null = null;
  const instrument = async (step: () => Promise<unknown>) => {
    try {
      await step();
      return true;
    } catch (error) {
      instrumentation = { error };
      fail(`the caller's instrumentation failed: ${message(error)}`);
      return false;
    }
  };
  const establish = async (): Promise<void> => {
    const { roster, workers } = await ports.roster();
    receipt.roster = roster;
    receipt.workers = workers;
    const unlisted = roster.filter((entry) => entry.role === "unlisted");
    if (unlisted.length > 0)
      return fail(
        `an unlisted document of the context can still produce requests: ${unlisted.map((e) => e.name).join(", ")}`,
      );
    if (workers > 0)
      return fail(
        `the context runs ${workers} worker(s) the setup does not account for`,
      );
    receipt.observer.booted = await barrier.booted();
    if (receipt.observer.booted)
      return fail("the observer document runs a session");
    const start = now();
    let last: string[] = [];
    for (;;) {
      if (now() - start > deadlineMs)
        return fail(
          `the record was never clean within ${deadlineMs} ms: ${last.join("; ")}`,
        );
      const result = await within(barrier.arm(identity), acquireMs, sleep);
      if (result === TIMEOUT) {
        const settled = await within(barrier.abandon(), releaseMs, sleep);
        receipt.arms.push({
          seq: next(),
          kind: "blocked",
          settledPhase: settled === TIMEOUT ? "timeout" : settled.phase,
        });
        return fail(`the barrier could not be acquired within ${acquireMs} ms`);
      }
      if (result.kind === "failed") {
        receipt.arms.push({
          seq: next(),
          kind: "failed",
          reasons: [result.reason],
        });
        return fail(result.reason);
      }
      if (result.kind === "declined") {
        const settled = await within(barrier.settled(), releaseMs, sleep);
        const settledPhase = settled === TIMEOUT ? "timeout" : settled.phase;
        receipt.arms.push({
          seq: next(),
          kind: "declined",
          reasons: result.reasons,
          snapshot: result.snapshot,
          settledPhase,
        });
        last = result.reasons;
        if (settledPhase !== "idle")
          return fail(
            `a declined barrier transaction was ${settledPhase} instead of ended`,
          );
        if (!(await instrument(async () => options.onDeclined?.(result))))
          return;
        await sleep(pollMs);
        continue;
      }
      armed = true;
      receipt.arms.push({
        seq: next(),
        kind: "armed",
        snapshot: result.snapshot,
      });
      receipt.keepaliveAtArm = (await barrier.state()).keepalive;
      break;
    }
    if (!(await instrument(async () => options.whileArmed?.()))) return;
    for (const producer of ports.producers) {
      try {
        await producer.close();
      } catch (error) {
        receipt.closes.push({
          name: producer.name,
          seq: next(),
          ok: false,
          error: message(error),
          phaseAfter: null,
          keepaliveAfter: null,
        });
        return fail(`closing ${producer.name} failed: ${message(error)}`);
      }
      const state = await barrier.state();
      receipt.closes.push({
        name: producer.name,
        seq: next(),
        ok: true,
        phaseAfter: state.phase,
        keepaliveAfter: state.keepalive,
      });
      if (state.phase !== "armed")
        return fail(
          `the barrier was ${state.phase}, not armed, when ${producer.name} had closed`,
        );
    }
  };
  try {
    await establish();
  } catch (error) {
    fail(`the observer document was lost or failed: ${message(error)}`);
  } finally {
    if (armed) {
      try {
        const state = await within(barrier.release(), releaseMs, sleep);
        receipt.release = {
          seq: next(),
          phase: state === TIMEOUT ? "timeout" : state.phase,
        };
      } catch (error) {
        receipt.release = { seq: next(), phase: "lost" };
        fail(`the observer document was lost or failed: ${message(error)}`);
      }
    }
    if (receipt.failure === null && receipt.release?.phase === "completed") {
      try {
        const snapshot = await barrier.reread();
        const locks = await barrier.locks();
        receipt.after = { seq: next(), snapshot, locks };
      } catch (error) {
        fail(`the observer document was lost or failed: ${message(error)}`);
      }
    }
    try {
      await barrier.close();
      receipt.observerClosed = next();
    } catch (error) {
      fail(`the observer could not be closed: ${message(error)}`);
    }
  }
  if (instrumentation) throw (instrumentation as { error: unknown }).error;
  return receipt;
}

/** The next sequence number of `receipt`, for the spec's own steps after the close (the refusal, the target's boot). */
export function mark(receipt: OrderedCloseReceipt): number {
  receipt.seq += 1;
  return receipt.seq;
}

/** Judge a receipt (and, with `target`, the target's ordering). Pure; every problem is specific. */
export function judgeOrderedClose(
  receipt: OrderedCloseReceipt,
  options: { target?: boolean } = {},
): { problems: string[] } {
  const problems: string[] = [];
  if (receipt.failure !== null)
    problems.push(`the setup stopped: ${receipt.failure}`);
  for (const entry of receipt.roster)
    if (entry.role === "unlisted")
      problems.push(
        `an unlisted document of the context can still produce requests: ${entry.name}`,
      );
  if (!receipt.roster.some((entry) => entry.role === "observer"))
    problems.push("the roster does not name the observer document");
  if (receipt.workers > 0)
    problems.push(
      `the context runs ${receipt.workers} worker(s) the setup does not account for`,
    );
  if (receipt.observer.booted !== false)
    problems.push(
      receipt.observer.booted === null
        ? "the observer's session state is unknown"
        : "the observer document runs a session",
    );

  const lastArm = receipt.arms.at(-1);
  if (lastArm?.kind !== "armed" || !lastArm.snapshot)
    problems.push("the barrier never armed over a clean record");
  else
    for (const reason of cleanReasons(lastArm.snapshot, receipt.identity))
      problems.push(`the barrier armed over ${reason}`);
  for (const arm of receipt.arms.slice(0, -1)) {
    if (arm.kind !== "declined")
      problems.push(`an earlier barrier attempt was ${arm.kind}, not declined`);
    else if (arm.settledPhase !== "idle")
      problems.push(
        `a declined barrier transaction was ${arm.settledPhase} before the next attempt`,
      );
  }

  const armedSeq = lastArm?.kind === "armed" ? lastArm.seq : null;
  const producers = receipt.roster.filter((entry) => entry.role === "producer");
  const closed = receipt.closes.map((c) => c.name);
  if (receipt.closes.length === 0)
    problems.push("no producer document was closed");
  for (const producer of producers)
    if (!closed.includes(producer.name))
      problems.push(`${producer.name} was not closed under the barrier`);
  for (const close of receipt.closes) {
    if (!close.ok)
      problems.push(
        `closing ${close.name} failed: ${close.error ?? "unknown"}`,
      );
    if (armedSeq === null || close.seq < armedSeq)
      problems.push(`${close.name} was closed before the barrier armed`);
    if (close.phaseAfter !== "armed")
      problems.push(
        `the barrier was ${close.phaseAfter ?? "unknown"}, not armed, when ${close.name} had closed`,
      );
    if (
      receipt.keepaliveAtArm === null ||
      close.keepaliveAfter === null ||
      close.keepaliveAfter <= receipt.keepaliveAtArm
    )
      problems.push(
        `the barrier transaction made no progress across the close of ${close.name}`,
      );
  }

  const lastClose = receipt.closes.at(-1)?.seq ?? Number.POSITIVE_INFINITY;
  if (receipt.release === null) problems.push("the barrier was never released");
  else {
    if (receipt.release.seq < lastClose)
      problems.push(
        "the barrier was released before every producer had closed",
      );
    if (receipt.release.phase !== "completed")
      problems.push(
        `the barrier transaction ended ${receipt.release.phase}, not completed`,
      );
  }

  if (receipt.after === null)
    problems.push("the record was not read again after the release");
  else {
    if (receipt.release === null || receipt.after.seq < receipt.release.seq)
      problems.push("the record was read again before the release");
    for (const reason of cleanReasons(receipt.after.snapshot, receipt.identity))
      problems.push(`after the release the record has ${reason}`);
    const request = (name: string) =>
      name.startsWith("atlas-lease-") || name.startsWith("atlas-issue-");
    const locks = [
      ...receipt.after.locks.held,
      ...receipt.after.locks.pending,
    ].filter(request);
    if (locks.length > 0)
      problems.push(
        `request locks are still held or requested after the close: ${locks.join(", ")}`,
      );
  }
  if (
    receipt.observerClosed === null ||
    receipt.after === null ||
    receipt.observerClosed < receipt.after.seq
  )
    problems.push("the observer document was not closed after the final read");

  if (/csrf|cookie|verifier|password|token/i.test(JSON.stringify(receipt)))
    problems.push("the receipt carries credential-bearing fields");

  if (options.target) {
    const target = receipt.target;
    if (!target) problems.push("the target was not recorded");
    else {
      if (
        receipt.observerClosed === null ||
        target.refusalSeq < receipt.observerClosed
      )
        problems.push("the API refusal was installed before the setup ended");
      if (target.bootSeq < target.refusalSeq)
        problems.push("the target booted before the API refusal was installed");
      if (target.producerBoots.includes(target.boot))
        problems.push("the target is a producer document");
      const captured = target.captured.flat();
      if (captured.length > 0)
        problems.push(
          `the target's verification captured unresolved leases ${JSON.stringify(captured)}`,
        );
    }
  }
  return { problems };
}

/**
 * The barrier, installed in the observer document (self-contained: Playwright serialises it). Exposes `window.__closeBarrier`.
 * TEST INSTRUMENTATION in a `?boot=off` harness page; it never writes.
 */
function installBarrier(names: {
  database: string;
  store: string;
  version: number;
}) {
  interface Summary {
    settled: { account_id: string; epoch: number; session_id: string } | null;
    attempt: boolean;
    fences: number;
    leases: Record<string, Record<string, unknown>>;
  }
  const w = window as unknown as { __closeBarrier?: unknown };
  if (w.__closeBarrier) return;
  const terminal = [
    "idle",
    "abandoned",
    "completed",
    "ended_early",
    "aborted",
    "lost",
  ];
  const state = { phase: "idle", keepalive: 0, release: false };
  let db: IDBDatabase | null = null;
  let tx: IDBTransaction | null = null;
  let waiters: Array<() => void> = [];
  const snapshotState = () => ({
    phase: state.phase,
    keepalive: state.keepalive,
  });
  const wake = () => {
    if (!terminal.includes(state.phase)) return;
    const now = waiters;
    waiters = [];
    for (const waiter of now) waiter();
  };
  const until = () =>
    new Promise<ReturnType<typeof snapshotState>>((resolve) => {
      if (terminal.includes(state.phase)) return resolve(snapshotState());
      waiters.push(() => resolve(snapshotState()));
    });
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      if (db) return resolve(db);
      const request = indexedDB.open(names.database, names.version);
      // The store must already exist: the observer never creates or upgrades it.
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onerror = () =>
        reject(new Error(`open: ${request.error?.name ?? "error"}`));
      request.onsuccess = () => {
        const opened = request.result;
        const lose = () => {
          state.phase = "lost";
          wake();
        };
        opened.onclose = lose;
        opened.onversionchange = () => {
          opened.close();
          lose();
        };
        db = opened;
        resolve(opened);
      };
    });
  const summarise = (keys: IDBValidKey[], values: unknown[]): Summary => {
    const at = keys.indexOf("auth_state");
    const auth = (at >= 0 ? values[at] : null) as {
      settled?: {
        account_id: string;
        epoch: number;
        session_id: string;
      } | null;
      attempt?: unknown;
      fences?: Record<string, unknown[]>;
      leases?: Record<string, Record<string, unknown>>;
    } | null;
    const settled = auth?.settled ?? null;
    return {
      settled: settled
        ? {
            account_id: settled.account_id,
            epoch: settled.epoch,
            session_id: settled.session_id,
          }
        : null,
      attempt: auth?.attempt !== null && auth?.attempt !== undefined,
      fences: Object.values(auth?.fences ?? {}).flat().length,
      leases: Object.fromEntries(
        Object.entries(auth?.leases ?? {}).map(([id, lease]) => [
          id,
          {
            account_id: lease.account_id,
            epoch: lease.epoch,
            boot_id: lease.boot_id,
            class: lease.class,
          },
        ]),
      ),
    };
  };
  const reasonsOf = (
    s: Summary,
    identity: { account_id: string; epoch: number; session_id: string },
  ) => {
    const reasons: string[] = [];
    if (s.settled === null) reasons.push("no settled identity");
    else if (
      s.settled.account_id !== identity.account_id ||
      s.settled.epoch !== identity.epoch ||
      s.settled.session_id !== identity.session_id
    )
      reasons.push(
        `a different settled identity (${s.settled.account_id}/${s.settled.epoch})`,
      );
    if (s.attempt) reasons.push("an attempt in progress");
    if (s.fences > 0) reasons.push(`${s.fences} fence(s)`);
    const leases = Object.keys(s.leases).sort();
    if (leases.length > 0)
      reasons.push(`unresolved leases ${JSON.stringify(leases)}`);
    return reasons;
  };
  w.__closeBarrier = {
    arm: (identity: {
      account_id: string;
      epoch: number;
      session_id: string;
    }) =>
      open().then(
        (database) =>
          new Promise((resolve) => {
            if (state.phase !== "idle" && state.phase !== "completed")
              return resolve({
                kind: "failed",
                reason: `the barrier is ${state.phase}`,
              });
            let t: IDBTransaction;
            try {
              t = database.transaction(names.store, "readwrite");
            } catch (error) {
              return resolve({
                kind: "failed",
                reason: `the barrier transaction could not be created (${(error as Error).name})`,
              });
            }
            tx = t;
            state.phase = "acquiring";
            state.keepalive = 0;
            state.release = false;
            let answered = false;
            const answer = (result: unknown) => {
              if (answered) return;
              answered = true;
              resolve(result);
            };
            const store = t.objectStore(names.store);
            const keys = store.getAllKeys();
            const values = store.getAll();
            t.oncomplete = () => {
              if (state.phase === "armed") state.phase = "ended_early";
              else if (state.phase === "releasing") state.phase = "completed";
              else if (state.phase === "declining") state.phase = "idle";
              else if (state.phase === "abandoning") state.phase = "abandoned";
              wake();
              answer({
                kind: "failed",
                reason: "the barrier transaction ended before its read",
              });
            };
            t.onabort = () => {
              if (state.phase === "abandoning") state.phase = "abandoned";
              else if (state.phase !== "lost") state.phase = "aborted";
              wake();
              answer({
                kind: "failed",
                reason: `the barrier transaction aborted (${t.error?.name ?? "abort"})`,
              });
            };
            values.onsuccess = () => {
              if (state.phase !== "acquiring") return;
              const snapshot = summarise(
                keys.result as IDBValidKey[],
                values.result as unknown[],
              );
              const reasons = reasonsOf(snapshot, identity);
              if (reasons.length > 0) {
                // Not clean: issue nothing more, so this transaction ends now and the owners can retire what it saw.
                state.phase = "declining";
                answer({ kind: "declined", snapshot, reasons });
                return;
              }
              state.phase = "armed";
              const keep = () => {
                if (state.release) {
                  state.phase = "releasing";
                  return;
                }
                const read = store.get("auth_state");
                read.onsuccess = () => {
                  state.keepalive += 1;
                  keep();
                };
              };
              keep();
              answer({ kind: "armed", snapshot });
            };
          }),
      ),
    abandon: () => {
      if (state.phase === "acquiring") {
        state.phase = "abandoning";
        try {
          tx?.abort();
        } catch {
          // it has already finished: its handlers set the phase
        }
      }
      return until();
    },
    settled: until,
    state: () => snapshotState(),
    release: () => {
      if (state.phase !== "armed") return Promise.resolve(snapshotState());
      state.release = true;
      return until();
    },
    reread: () =>
      open().then(
        (database) =>
          new Promise((resolve, reject) => {
            const t = database.transaction(names.store, "readwrite");
            const store = t.objectStore(names.store);
            const keys = store.getAllKeys();
            const values = store.getAll();
            let read: Summary | null = null;
            values.onsuccess = () => {
              read = summarise(
                keys.result as IDBValidKey[],
                values.result as unknown[],
              );
            };
            t.oncomplete = () =>
              read
                ? resolve(read)
                : reject(new Error("the reread read nothing"));
            t.onabort = () =>
              reject(
                new Error(`the reread aborted (${t.error?.name ?? "abort"})`),
              );
          }),
      ),
    locks: async () => {
      const snapshot = await navigator.locks.query();
      return {
        held: (snapshot.held ?? []).map((lock) => lock.name ?? ""),
        pending: (snapshot.pending ?? []).map((lock) => lock.name ?? ""),
      };
    },
    /** TEST INSTRUMENTATION for the failure controls: the current transaction. */
    transaction: () => tx,
    close: () => {
      db?.close();
      db = null;
    },
  };
}

interface BarrierWindow {
  __closeBarrier: {
    arm(identity: CloseIdentity): Promise<ArmResult>;
    abandon(): Promise<BarrierState>;
    settled(): Promise<BarrierState>;
    state(): BarrierState;
    release(): Promise<BarrierState>;
    reread(): Promise<RecordSummary>;
    locks(): Promise<{ held: string[]; pending: string[] }>;
    transaction(): IDBTransaction | null;
    close(): void;
  };
}

/** Open a non-producing observer document (`?boot=off`) in `context` and install the barrier in it. */
export async function openObserver(context: BrowserContext): Promise<Page> {
  const observer = await context.newPage();
  await observer.goto("/__session?boot=off");
  await observer.waitForFunction(
    () => window.__atlasFixture?.session !== undefined,
  );
  await observer.evaluate(installBarrier, AUTH_NAMES);
  return observer;
}

/** A harness document that never booted a session (a `?boot=off` page): no kernel, no trace. */
const notBooted = (page: Page) =>
  page.evaluate(
    () =>
      window.__atlasFixture?.session?.booted === null &&
      (window.__atlasFixture?.session?.trace.length ?? 0) === 0,
  );

/** The barrier's port over the observer page. */
export function pageBarrier(observer: Page): BarrierPort {
  return {
    arm: (identity) =>
      observer.evaluate(
        (id) => (window as unknown as BarrierWindow).__closeBarrier.arm(id),
        identity,
      ),
    abandon: () =>
      observer.evaluate(() =>
        (window as unknown as BarrierWindow).__closeBarrier.abandon(),
      ),
    settled: () =>
      observer.evaluate(() =>
        (window as unknown as BarrierWindow).__closeBarrier.settled(),
      ),
    state: () =>
      observer.evaluate(() =>
        (window as unknown as BarrierWindow).__closeBarrier.state(),
      ),
    release: () =>
      observer.evaluate(() =>
        (window as unknown as BarrierWindow).__closeBarrier.release(),
      ),
    reread: () =>
      observer.evaluate(() =>
        (window as unknown as BarrierWindow).__closeBarrier.reread(),
      ),
    locks: () =>
      observer.evaluate(() =>
        (window as unknown as BarrierWindow).__closeBarrier.locks(),
      ),
    booted: async () => !(await notBooted(observer)),
    close: async () => {
      if (observer.isClosed()) return;
      await observer
        .evaluate(() =>
          (window as unknown as BarrierWindow).__closeBarrier.close(),
        )
        .catch(() => undefined);
      await observer.close();
    },
  };
}

/** The address of a document without its query or fragment (a fragment can carry an invitation token). */
const where = (page: Page) => {
  const url = page.url();
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};

/**
 * Close `producers` (pages of `context`) in order under the barrier, judged against `identity`. `inert` names other harness pages
 * the caller declares non-producing; each is checked to have no session. Every other page of the context must be blank.
 */
export async function closeInOrder(
  context: BrowserContext,
  producers: Page[],
  identity: CloseIdentity,
  options: Omit<OrderedCloseOptions, "whileArmed"> & {
    inert?: Page[];
    whileArmed?: (observer: Page) => Promise<unknown>;
  } = {},
): Promise<OrderedCloseReceipt> {
  const observer = await openObserver(context);
  const names = new Map(
    producers.map((page, i) => [page, `producer-${i + 1}`]),
  );
  const { whileArmed, inert = [], ...rest } = options;
  return orderedClose(
    {
      barrier: pageBarrier(observer),
      producers: producers.map((page) => ({
        name: names.get(page) as string,
        close: () => page.close(),
      })),
      roster: async () => {
        const roster: RosterEntry[] = [];
        for (const page of context.pages()) {
          if (page === observer)
            roster.push({ name: "observer", role: "observer" });
          else if (names.has(page))
            roster.push({ name: names.get(page) as string, role: "producer" });
          else if (inert.includes(page) && (await notBooted(page)))
            roster.push({ name: where(page), role: "declared-inert" });
          else if (page.url() === "about:blank")
            roster.push({ name: "about:blank", role: "inert" });
          else roster.push({ name: where(page), role: "unlisted" });
        }
        // A producer's own dedicated workers end with it; any other worker could outlive the close.
        const workers =
          context.serviceWorkers().length +
          context
            .pages()
            .filter((page) => page !== observer && !names.has(page))
            .reduce((n, page) => n + page.workers().length, 0);
        return { roster, workers };
      },
    },
    identity,
    {
      ...rest,
      ...(whileArmed ? { whileArmed: () => whileArmed(observer) } : {}),
    },
  );
}
