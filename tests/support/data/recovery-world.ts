import { createQuotaGuard } from "../../../src/data/engine/quota-guard";
import {
  createRecoveryJob,
  type RecoveryJob,
  type RecoveryJobDeps,
  type RecoveryJobState,
} from "../../../src/data/engine/recovery-job";
import type { SyncMessage } from "../../../src/data/engine/sync-channel";
import type { SyncOwnership } from "../../../src/data/engine/sync-engine";
import type { WriteFailureMarkers } from "../../../src/data/engine/write-failure-marker";
import { acquireOwnership } from "../../../src/data/plans/recovery-writers";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../../src/data/scan/validate";
import {
  type RecoveryBegin,
  type RecoveryHandle,
  type SessionView,
  StampedRequestError,
} from "../../../src/session";
import { EPOCH_BASE } from "../session/env";
import { FakeMarkerStorage, pageMarkers } from "./marker-storage";
import { ACCOUNT, type PageWorld, pageWorld } from "./page-world";
import { type PageSpec, pageJson } from "./sync-pages";

/**
 * The recovery job's world: the page world (production plans over the double of IndexedDB), a scriptable `/sync` server that records
 * the request CLASS of every request, a scriptable `session.recovery` (`begin`, `finish`, `report`), the session view, fake-world timers
 * and the page's markers. The job is bound with an ownership the world acquired through W20, as the leader does.
 */
export type Scripted =
  | Response
  | Error
  | StampedRequestError
  | (() => Response | Error | Promise<Response | Error>);

export interface RecoveryWorld extends PageWorld {
  job: RecoveryJob;
  requests: Array<{ klass: "ordinary" | "recovery"; url: URL; epoch: number }>;
  /** The `Request` objects themselves (their signals), in the order they were sent. */
  sent: Request[];
  /**
   * Whether a request's own signal ends it at once (default true, as the stamped wrapper's caller signal does). False models a wrapper
   * that settles an aborted call only LATER (it has its own lease to clean up first), so the step that made it is still busy when the
   * job is bound again (R4 of the review of 10 October 2026).
   */
  honourAbort: boolean;
  script: Scripted[];
  posted: SyncMessage[];
  online: boolean;
  view: { get(): SessionView; set(next: SessionView): void };
  /**
   * What `begin` answers next. Default: the record's gate (below) if one stands, else eligible with a handle of the current epoch and
   * `s = sequence`.
   */
  begins: Array<RecoveryBegin | Error>;
  /**
   * The session's record and page memory as far as admission goes (R3, second cycle): a durable gate and a page-local hold. A scripted
   * `begin` refusal on the record sets the gate (the record says so), an eligible answer clears it, and a scripted `auth_state` answer
   * records a current-epoch entry, as the session does. `session.api.admission` reads them: its revision is a digest of the gate, the
   * hold and `salt` (a test moves `salt` for a change that admits nothing new), and it is blocked while either stands.
   */
  recordGate: { reason: GateReason; epoch: number } | null;
  setGate(reason: GateReason | null): void;
  hold: boolean;
  salt: number;
  /** The admission probe cannot read the record (it answers null). */
  admissionUnreadable: boolean;
  /**
   * The account has nothing fenced (WEB-08c K-2). Production's probe then answers `blocked` for the RECOVERY class (`recoveryEligible`
   * is false without a fence) and `begin` says `no_fence`; the world's probe models that only when a test sets this.
   */
  unfenced: boolean;
  /** Called after `begin` has decided its answer and before it returns: a test changes the record in that interval (WEB-08c K-2). */
  afterBegin?: (answer: RecoveryBegin) => void;
  probes: Array<{ klass: "ordinary" | "recovery"; epoch: number }>;
  /**
   * Whether `report` notifies the job's subscription, as production's does (the session evaluates on a report and publishes a new
   * identity object): the loop-safety cases set it.
   */
  reportNotifies: boolean;
  /** The job's trace events (a fixed vocabulary), in order. */
  traced: Array<{ event: string; data?: unknown }>;
  finishes: Array<Awaited<ReturnType<RecoveryJobDeps["recovery"]["finish"]>>>;
  calls: Array<
    | { call: "begin"; account: string }
    | { call: "finish"; handle: RecoveryHandle }
    | { call: "report"; phase: string | null }
  >;
  markers: WriteFailureMarkers;
  markerStorage: FakeMarkerStorage;
  freeBytes: number | null;
  /** Called at each read of the free space (inside the quota check, before the issue check): a test can move a fact there. */
  beforeEstimate?: () => void;
  token: string;
  ownership: SyncOwnership;
  /** Acquires the ownership (W20) with a new token and binds the job to it. */
  bindJob(token?: string): Promise<void>;
  state(): RecoveryJobState;
  fire(): void;
  goOnline(): void;
  settle(): Promise<void>;
  advance(ms: number): Promise<void>;
  /** A page reload: a NEW job over the same database, markers double and server (nothing in memory survives). */
  reload(): Promise<void>;
  page_(spec: PageSpec): Response;
  status(
    code: number,
    body?: unknown,
    headers?: Record<string, string>,
  ): Response;
}

export type GateReason =
  | "attempt_gating"
  | "operation_pending"
  | "credential_unverified"
  | "current_epoch_entry";
const GATES: readonly string[] = [
  "attempt_gating",
  "operation_pending",
  "credential_unverified",
  "current_epoch_entry",
];

export async function recoveryWorld(
  options: {
    cursor?: string | null;
    phase?: "snapshot" | "delta";
    cacheStatus?: "valid" | "invalid" | "empty";
    displayed?: boolean;
    config?: RecoveryJobDeps["config"];
  } = {},
): Promise<RecoveryWorld> {
  const base = await pageWorld({
    cursor: options.cursor === undefined ? null : options.cursor,
    phase: options.phase ?? "snapshot",
    cacheStatus: options.cacheStatus ?? "empty",
  });
  const { env } = base;
  const world = env.world;
  const listeners = new Set<() => void>();
  const onlineListeners = new Set<() => void>();
  const cancelled = new Set<number>();
  let timerSeq = 0;
  let view: SessionView =
    options.displayed === false
      ? { kind: "neutral", state: "2.catching_up" as never }
      : { kind: "displaying", account_id: ACCOUNT, epoch: 1 };
  const markerStorage = new FakeMarkerStorage();
  let sequence = 0;
  const out = {
    ...base,
    requests: [],
    sent: [],
    honourAbort: true,
    script: [],
    posted: [],
    online: true,
    begins: [],
    finishes: [],
    calls: [],
    markerStorage,
    markers: pageMarkers(markerStorage),
    freeBytes: 500 * 1024 * 1024,
    token: "",
    recordGate: null,
    hold: false,
    salt: 0,
    admissionUnreadable: false,
    unfenced: false,
    probes: [],
    reportNotifies: false,
    traced: [],
  } as unknown as RecoveryWorld;
  out.setGate = (reason) => {
    out.recordGate =
      reason === null
        ? null
        : { reason, epoch: base.identity.get()?.epoch ?? 1 };
  };
  /** A current-epoch entry stands only in its own epoch; the other gates stand until removed. */
  const gateNow = (): GateReason | null => {
    const gate = out.recordGate;
    if (gate === null) return null;
    if (
      gate.reason === "current_epoch_entry" &&
      gate.epoch !== (base.identity.get()?.epoch ?? 1)
    )
      return null;
    return gate.reason;
  };
  const revisionNow = (): string =>
    JSON.stringify([gateNow(), out.hold, out.salt, out.unfenced]);
  out.view = {
    get: () => view,
    set(next) {
      view = next;
      for (const listener of [...listeners]) listener();
    },
  };
  const quota = createQuotaGuard({
    storage: {
      estimate: async () => {
        out.beforeEstimate?.();
        return out.freeBytes === null ? {} : { usage: 0, quota: out.freeBytes };
      },
    },
    now: () => EPOCH_BASE + world.time,
  });
  const deps: RecoveryJobDeps = {
    identity: base.identity,
    view: {
      get: () => view,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as RecoveryJobDeps["view"],
    fetchFor: (klass, _account, epoch) => async (request) => {
      out.requests.push({ klass, url: new URL(request.url), epoch });
      out.sent.push(request);
      const next = out.script.shift();
      // The request's own signal ends it, as the stamped wrapper's caller signal does (a clean `AbortError`).
      const aborted = new Promise<never>((_, reject) => {
        const fail = () =>
          reject(new DOMException("The request was aborted", "AbortError"));
        if (!out.honourAbort) return;
        if (request.signal.aborted) fail();
        else request.signal.addEventListener("abort", fail, { once: true });
      });
      const answered = (async () => {
        const resolved = typeof next === "function" ? await next() : next;
        if (
          resolved instanceof StampedRequestError &&
          resolved.kind === "auth_state"
        )
          out.setGate("current_epoch_entry");
        if (resolved instanceof Error) throw resolved;
        if (resolved) return resolved;
        // Nothing scripted: the request stays in flight (a test counts it; nothing is answered that it did not ask for).
        return new Promise<Response>(() => undefined);
      })();
      return Promise.race([answered, aborted]);
    },
    recovery: {
      begin: async (account) => {
        out.calls.push({ call: "begin", account });
        const next = out.begins.shift();
        if (next instanceof Error) throw next;
        const answer = ((): RecoveryBegin => {
          if (next === undefined) {
            const gate = gateNow();
            if (gate !== null) return { kind: "ineligible", reason: gate };
          } else if (next.kind === "ineligible") {
            if (GATES.includes(next.reason))
              out.setGate(next.reason as GateReason);
            return next;
          }
          out.recordGate = null;
          sequence += 1;
          return (
            next ?? {
              kind: "eligible",
              handle: {
                account,
                epoch: base.identity.get()?.epoch ?? 1,
                s: sequence,
              },
            }
          );
        })();
        // As production's `begin` (WEB-08c K-2): a refusal decided on the record carries the admission revision of that same read.
        const recorded =
          answer.kind === "ineligible" &&
          answer.revision === undefined &&
          answer.reason !== "stale" &&
          answer.reason !== "offline" &&
          answer.reason !== "unresolved_lease"
            ? { ...answer, revision: revisionNow() }
            : answer;
        out.afterBegin?.(recorded);
        return recorded;
      },
      finish: async (handle) => {
        out.calls.push({ call: "finish", handle });
        return out.finishes.shift() ?? "cleared";
      },
      report: (phase) => {
        out.calls.push({ call: "report", phase });
        if (out.reportNotifies)
          world.schedule("misc", "A", { what: "evaluate" }, () => out.fire());
      },
    },
    admission: async (klass, _account, epoch) => {
      out.probes.push({ klass, epoch });
      if (out.admissionUnreadable) return null;
      const gate = gateNow();
      return {
        revision: revisionNow(),
        blocked:
          gate !== null || out.hold || (klass === "recovery" && out.unfenced),
      };
    },
    apiUrl: (path) => new URL(`http://localhost/api/experimental/v1${path}`),
    online: () => out.online,
    // The session view and the identity, as production's subscription covers both.
    subscribe: (listener) => {
      listeners.add(listener);
      const off = base.identity.subscribe(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
    onOnline: (listener) => {
      onlineListeners.add(listener);
      return () => {
        onlineListeners.delete(listener);
      };
    },
    clock: {
      now: () => EPOCH_BASE + world.time,
      iso: () => new Date(EPOCH_BASE + world.time).toISOString(),
      random: () => 0.5,
      setTimeout: (fn, ms) => {
        timerSeq += 1;
        const id = timerSeq;
        world.schedule(
          "timer",
          "A",
          { timer: id },
          () => {
            if (!cancelled.has(id)) fn();
          },
          ms,
        );
        return id;
      },
      clearTimeout: (handle) => {
        cancelled.add(handle as number);
      },
    },
    yield: () =>
      new Promise<void>((resolve) =>
        world.schedule("misc", "A", { what: "yield" }, resolve),
      ),
    decode: {
      validators: createValueValidators(),
      derivers: createKeyDerivers(),
    },
    quota,
    signals: { hasStorageEstimate: true },
    channel: {
      post: (message) => {
        out.posted.push(message);
      },
      subscribe: () => () => undefined,
    },
    get markers() {
      return out.markers;
    },
    ids: { uuid: () => crypto.randomUUID() },
    trace: {
      emit: (event: string, data?: unknown) => {
        out.traced.push({ event, data });
      },
    } as RecoveryJobDeps["trace"],
    elapsed: () => world.time,
    ...(options.config ? { config: options.config } : {}),
  };
  out.job = createRecoveryJob(deps);
  let tokens = 0;
  let abort = new AbortController();
  out.bindJob = async (token) => {
    abort.abort();
    abort = new AbortController();
    tokens += 1;
    const next = token ?? `token-${tokens}`;
    const owned = await base.service.store.run(acquireOwnership, {
      incarnationId: base.service.incarnationId,
      tabId: "tab-a",
      token: next,
      now: EPOCH_BASE + world.time,
    });
    if (owned.kind !== "owned") throw new Error(`setup: ${owned.kind}`);
    out.token = next;
    out.ownership = { token: next, signal: abort.signal };
    out.job.bind({ service: base.service, ownership: out.ownership });
  };
  out.state = () => out.job.state.get();
  out.fire = () => {
    for (const listener of [...listeners]) listener();
  };
  out.goOnline = () => {
    out.online = true;
    for (const listener of [...onlineListeners]) listener();
    for (const listener of [...listeners]) listener();
  };
  out.settle = async () => {
    for (let i = 0; i < 80; i += 1) await world.runUntilIdle();
    base.assertNoOrphanBodies();
  };
  out.advance = async (ms) => {
    await world.advance(ms);
    await out.settle();
  };
  out.reload = async () => {
    out.job.bind(null);
    out.job = createRecoveryJob(deps);
    await out.bindJob();
  };
  out.page_ = (spec) =>
    new Response(pageJson(spec), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  out.status = (code, body = {}, headers = {}) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { "content-type": "application/json", ...headers },
    });
  return out;
}
