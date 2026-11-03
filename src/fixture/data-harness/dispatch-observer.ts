/**
 * FIXTURE (WEB-09c revision 14; review 14 R2, design assessment DA-R14-A/B/C; family profiling-evidence-completeness): what the harness
 * outbox's dispatcher actually did, for the P-4 draft sample's completion evidence. Loaded lazily, and only when a spec starts the
 * harness outbox with `observeDispatch: true`; production composes nothing of it.
 *
 * Revision 13 closed a draft sample on a later, unfenced queue read: any status but `queued`/`in_flight` passed, including a read that
 * threw, a replacement page's empty queue and a row a later retry acknowledged. Production emits `data.outbox_answer` BEFORE it awaits the
 * receipt transaction (outbox-dispatcher.ts `answer`), so the answer is not the end of the operation, and no queue state can say WHICH
 * transaction wrote it. This observer records the dispatcher's own acts where it makes them:
 *
 *   - every `commit` the dispatcher makes through its service view (the claim, the receipt, the outcome), with the local ID and the epoch
 *     of its input, and the ACTUAL result it receives (outer `applied`/`dropped`/`failed`, inner `claimed`/`admitted`/`recorded`/`noop`…);
 *   - the store runs of its writer plans that carry no commit (`unclaimDraft`, `recordFailureOfSend`, `recordLocalWriteOutcome`,
 *     `resumeDrafts`): a failed attempt, a give-back or a local-write failure inside a sample is visible;
 *   - every stamped request it issues, by its `Idempotency-Key` (the draft's local ID), and whether a response or an error came back;
 *   - its lifecycle: built, started, stopped, its service ended.
 *
 * Each record carries a monotone sequence number, the unrounded page time, and the dispatcher serial, run and service serial captured
 * SYNCHRONOUSLY from the actor that made the call (never the globals when an await resolves); an end record also carries the run at
 * delivery. A wrapper returns the very promise the production call returned and only appends to a bounded array, so no await, timer,
 * poll or I/O is added to the dispatcher's path and its order is unchanged. When the log is trimmed, `first()` moves: a reader that
 * needs records from before it can tell they are gone.
 *
 * Qualification gates (never used by a measurement): `gate(plan)` makes the dispatcher's NEXT commit of `plan` wait before it is called
 * (the transaction is not yet admitted); `release()` lets it go.
 */
import type { AccountService } from "../../data/engine/account-service";
import type { Plan } from "../../data/store/port";

/** One dispatcher the harness built (its serial) and its starts (`run`). */
export interface DispatchLife {
  readonly dispatcher: number;
  run: number;
  running: boolean;
}

export interface DispatchRecord {
  seq: number;
  /** `performance.now()`, unrounded. */
  at: number;
  event:
    | "commit_begin"
    | "commit_end"
    | "commit_gated"
    | "write_begin"
    | "write_end"
    | "request_begin"
    | "request_end"
    | "dispatcher_built"
    | "dispatcher_started"
    | "dispatcher_stopped"
    | "service_ended";
  dispatcher: number;
  run: number;
  service?: number | null;
  plan?: string;
  local_id?: string | null;
  epoch?: number | null;
  /** The begin record an end record closes. */
  of?: number;
  outer?: string;
  reason?: string;
  inner?: string;
  removed?: boolean;
  status?: string;
  key?: string | null;
  path?: string;
  http?: number;
  error?: string;
}

export interface DispatchObserver {
  readonly log: DispatchRecord[];
  /** The sequence number of the oldest record still held (`next()` when none). */
  first(): number;
  /** The sequence number the next record takes. */
  next(): number;
  built(): DispatchLife;
  started(life: DispatchLife): void;
  stopped(life: DispatchLife): void;
  serviceEnded(life: DispatchLife | null, service: object): void;
  /** A monotone serial per service object (a service ended and opened again is another lifetime, whatever its incarnation). */
  serial(service: object | null | undefined): number | null;
  /** The dispatcher's view of `raw` (through `view`, the harness's own view of it), observed for `life`. One object per pair. */
  view(
    view: AccountService,
    raw: AccountService,
    life: DispatchLife,
  ): AccountService;
  requests(
    fetchFor: (
      account: string,
      epoch: number,
    ) => (request: Request) => Promise<Response>,
    life: DispatchLife,
  ): (
    account: string,
    epoch: number,
  ) => (request: Request) => Promise<Response>;
  gate(plan: string): void;
  gated(): boolean;
  release(): void;
}

/** The writer plans the dispatcher runs on its store without a commit. */
const WRITES = new Set([
  "data.unclaimDraft",
  "data.recordFailureOfSend",
  "data.recordLocalWriteOutcome",
  "data.resumeDrafts",
]);
/** The log keeps at most this many records; when it is exceeded the oldest half goes at once (amortised constant cost per record). */
const LIMIT = 4096;

const localIdOf = (input: unknown): string | null => {
  const id = (input as { localId?: unknown } | null)?.localId;
  return typeof id === "string" ? id : null;
};
const describe = (error: unknown): string => {
  const e = error as { kind?: unknown; name?: unknown; cause?: unknown } | null;
  const label = [e?.name, e?.kind, e?.cause]
    .filter((x) => typeof x === "string")
    .join("/");
  return (label || String(error)).slice(0, 200);
};
/** The actual result of a commit, as fields of its end record. */
const outcomeOf = (out: unknown): Partial<DispatchRecord> => {
  const o = out as {
    kind?: unknown;
    reason?: unknown;
    failure?: { cause?: unknown };
    value?: {
      kind?: unknown;
      reason?: unknown;
      removed?: unknown;
      status?: unknown;
    };
  } | null;
  if (o?.kind === "applied") {
    const v = o.value;
    return {
      outer: "applied",
      inner: typeof v?.kind === "string" ? v.kind : "unknown",
      ...(typeof v?.removed === "boolean" ? { removed: v.removed } : {}),
      ...(typeof v?.status === "string" ? { status: v.status } : {}),
      ...(typeof v?.reason === "string" ? { reason: v.reason } : {}),
    };
  }
  if (o?.kind === "dropped")
    return { outer: "dropped", reason: String(o.reason) };
  if (o?.kind === "failed")
    return { outer: "failed", reason: String(o.failure?.cause ?? "error") };
  return { outer: "unknown" };
};

export function createDispatchObserver(): DispatchObserver {
  const log: DispatchRecord[] = [];
  let seq = 0;
  let dispatchers = 0;
  let services = 0;
  const serials = new WeakMap<object, number>();
  const views = new WeakMap<object, Map<DispatchLife, AccountService>>();
  let gate: { plan: string | null; release: (() => void) | null } = {
    plan: null,
    release: null,
  };
  const append = (record: Omit<DispatchRecord, "seq" | "at">): number => {
    const n = seq;
    seq += 1;
    log.push({ seq: n, at: performance.now(), ...record });
    if (log.length > LIMIT) log.splice(0, log.length - LIMIT / 2);
    return n;
  };
  const serial = (service: object | null | undefined): number | null => {
    if (service === null || service === undefined) return null;
    let n = serials.get(service);
    if (n === undefined) {
      services += 1;
      n = services;
      serials.set(service, n);
    }
    return n;
  };
  return {
    log,
    first: () => log[0]?.seq ?? seq,
    next: () => seq,
    built() {
      dispatchers += 1;
      const life: DispatchLife = {
        dispatcher: dispatchers,
        run: 0,
        running: false,
      };
      append({
        event: "dispatcher_built",
        dispatcher: life.dispatcher,
        run: 0,
      });
      return life;
    },
    started(life) {
      life.run += 1;
      life.running = true;
      append({
        event: "dispatcher_started",
        dispatcher: life.dispatcher,
        run: life.run,
      });
    },
    stopped(life) {
      life.running = false;
      append({
        event: "dispatcher_stopped",
        dispatcher: life.dispatcher,
        run: life.run,
      });
    },
    serviceEnded(life, service) {
      append({
        event: "service_ended",
        dispatcher: life?.dispatcher ?? 0,
        run: life?.run ?? 0,
        service: serial(service),
      });
    },
    serial,
    view(view, raw, life) {
      let byLife = views.get(view);
      if (byLife === undefined) {
        byLife = new Map();
        views.set(view, byLife);
      }
      const known = byLife.get(life);
      if (known !== undefined) return known;
      const service = serial(raw);
      // The store the view itself exposes (the harness's fault/hold seams), observed for the writer plans; one object for the view's life.
      const store = new Proxy(view.store, {
        get(target, name) {
          const value = Reflect.get(target, name, target);
          if (name !== "run") return value;
          return (
            plan: Plan<never, never, never>,
            input: never,
            options: never,
          ) => {
            if (!WRITES.has(plan.name)) return target.run(plan, input, options);
            const fields = {
              dispatcher: life.dispatcher,
              service,
              plan: plan.name,
              local_id: localIdOf(input),
            };
            const begin = append({
              event: "write_begin",
              run: life.run,
              ...fields,
            });
            const answer = target.run(plan, input, options);
            answer.then(
              () =>
                append({
                  event: "write_end",
                  of: begin,
                  run: life.run,
                  outer: "ran",
                  ...fields,
                }),
              (error) =>
                append({
                  event: "write_end",
                  of: begin,
                  run: life.run,
                  outer: "threw",
                  error: describe(error),
                  ...fields,
                }),
            );
            return answer;
          };
        },
      });
      const made = new Proxy(view, {
        get(target, key) {
          if (key === "store") return store;
          const value = Reflect.get(target, key, target);
          if (key !== "commit") return value;
          return (
            plan: Plan<never, never, never>,
            input: { captured?: { epoch?: unknown } },
          ) => {
            const call = (): Promise<unknown> => {
              const epoch = input?.captured?.epoch;
              const fields = {
                dispatcher: life.dispatcher,
                service,
                plan: plan.name,
                local_id: localIdOf(input),
                epoch: typeof epoch === "number" ? epoch : null,
              };
              const begin = append({
                event: "commit_begin",
                run: life.run,
                ...fields,
              });
              const answer = Reflect.apply(
                value as (...a: unknown[]) => Promise<unknown>,
                target,
                [plan, input],
              );
              answer.then(
                (out) =>
                  append({
                    event: "commit_end",
                    of: begin,
                    run: life.run,
                    ...fields,
                    ...outcomeOf(out),
                  }),
                (error) =>
                  append({
                    event: "commit_end",
                    of: begin,
                    run: life.run,
                    ...fields,
                    outer: "threw",
                    error: describe(error),
                  }),
              );
              return answer;
            };
            if (gate.plan === null || gate.plan !== plan.name) return call();
            // Qualification only: the commit is not called (its transaction not admitted) until the spec releases it.
            gate.plan = null;
            append({
              event: "commit_gated",
              dispatcher: life.dispatcher,
              run: life.run,
              service,
              plan: plan.name,
              local_id: localIdOf(input),
            });
            return new Promise((resolve) => {
              gate.release = () => {
                gate.release = null;
                resolve(call());
              };
            });
          };
        },
      });
      byLife.set(life, made);
      return made;
    },
    requests(fetchFor, life) {
      return (account, epoch) => {
        const send = fetchFor(account, epoch);
        return (request) => {
          const fields = {
            dispatcher: life.dispatcher,
            key: request.headers.get("Idempotency-Key"),
            path: new URL(request.url).pathname,
          };
          const begin = append({
            event: "request_begin",
            run: life.run,
            ...fields,
          });
          const answer = send(request);
          answer.then(
            (response) =>
              append({
                event: "request_end",
                of: begin,
                run: life.run,
                outer: "response",
                http: response.status,
                ...fields,
              }),
            (error) =>
              append({
                event: "request_end",
                of: begin,
                run: life.run,
                outer: "error",
                error: describe(error),
                ...fields,
              }),
          );
          return answer;
        };
      };
    },
    gate(plan) {
      gate = { plan, release: null };
    },
    gated: () => gate.release !== null,
    release() {
      gate.release?.();
    },
  };
}
