import {
  type AccountService,
  commitMaterialiseDiscovery,
  commitMaterialiseSequence,
  type MaterialiseDiscovery,
  type MaterialiseSequenceRow,
  pruneOlderSequences,
  readMaterialiseDiscoveryNow,
  readMaterialiseSequenceNow,
  type SequenceKey,
} from "../../../data";
import type { MaterialiseCommand, TasksApi, TasksResult } from "../api";
import { noteIfRefused } from "../memory";
import { parseDefinition } from "../model/contract";
import {
  begin,
  expectationOf,
  tryAgain as freshBudget,
  MAX_READ_FAILURES,
  onRead,
  onSent,
  type Position,
  RETRY_DELAYS_MS,
  type ReadAnswer,
  recover,
  type SendAnswer,
  type Sequence,
  submit,
} from "../model/materialise";
import { todayIn } from "../model/time";

/**
 * The catch-up RUNNER of one page for one displayed identity (D-10c-1/3/5). It is an online feature service, not outbox drafts: both
 * triggers that occur against the released backend (Today's `pending_tasks`, the streak's `materialisation_required`) are online reads,
 * and so is the position read. Every attempt is sent directly through the stamped client, and the sequence record (W27) carries the
 * attempt's key and body durably BEFORE it is sent.
 *
 * One runner per ACCOUNT across tabs: the work runs while this page holds the Web Lock `atlas-materialise:<account>` (requested and
 * waited for; a page that does not hold it shows the other page's progress from the durable records, and takes over when that page goes).
 * Never `locks.query()` (lint R2). The runner sends only while the device is online and the API contract is `supported` (B2: the same
 * fact the outbox's dispatcher reads, `TasksEnv.writable`); otherwise its work waits for `kick()`.
 *
 * One task at a time, in the order asked. At most one AUTOMATIC sequence per `(task, through_date)` per page: a stopped sequence is shown
 * and resumed only by the person's "Try again", so a stop never loops; a new day is a new key. Everything is bound to the identity and
 * the database binding it was made for: an identity that moves disposes the runner, a late answer is dropped by W27's guards, and a
 * `401`, `not_sent` or `closed` answer writes nothing.
 *
 * DISCOVERY (review R13, design assessment DA-M1): the first read of a task (its zone and position, before a day and so a sequence row
 * can exist) keeps its failures and its stop in W27's discovery entry, written BEFORE another read is made, so its budget is the task's,
 * not this call's: a pause, a reload or another tab's turn carries on from the count reached, and a stop (three uncertain answers, or a
 * definite refusal) admits no automatic read again, whichever trigger asks (Today's list, the streak, a command's retry, a kick). Only
 * the person's "Try again" admits a fresh budget, once: it is made under the account's lock, against the stop it was pressed on (a
 * second press, here or in another tab, finds the stop already lifted and adds nothing), and every write of a discovery compares the
 * entry it decided on, so a late answer of an earlier budget never changes a newer one. A stop whose write failed is kept in this page's
 * memory (`unrecorded`) and refuses automatic work here alike. An environmental pause (offline, not compatible, the session held) is
 * not a stop: it resumes.
 */
export type Trigger = MaterialiseSequenceRow["trigger"];

export interface CatchUpDeps {
  api: TasksApi;
  /** `account:epoch`, the key of page memory (refusals). */
  identity: string;
  accountId: string;
  epoch: number;
  /** The displayed account's open service (W27 commits), or null. */
  service(): AccountService | null;
  online(): boolean;
  writable(): boolean;
  now(): number;
  newId(): string;
  /** The waits between uncertain answers; the page's timers when omitted (tests pass fake ones). */
  sleep?(ms: number): Promise<void>;
  /** `navigator.locks`, or null where there is none (one page: no cross-tab exclusion is needed). */
  locks?: LockManager | null;
}

/** What this page knows that the durable records do not show: what it is working on, and a stop it could not record. */
export interface RunnerState {
  /** Tasks queued or running on this page, in order. */
  active: readonly string[];
  /** The task being worked on now (this page holds the lock and is reading or sending for it). */
  current: string | null;
  /** This page waits for the account's lock (another page is catching up). */
  waiting: boolean;
  /** Discovery stops whose record could not be written (the store failed or is full): memory only, with "Try again". */
  unrecorded: ReadonlyMap<string, UnrecordedStop>;
  /** Tasks whose sequence finished on this page since it began (for an announcement). */
  finished: number;
  /** A stop was recorded or met on this page (its count moves once per stop, for an announcement). */
  stops: number;
}

export interface UnrecordedStop {
  reason: "unreachable" | "rejected";
  requestId?: string;
}

export interface CatchUpRunner {
  readonly identity: string;
  /** Asks for a task to be brought up to date through its today (or `throughDate`). Idempotent per task and day. */
  ensure(
    taskId: string,
    trigger: Trigger,
    options?: { throughDate?: string },
  ): void;
  /**
   * The person's "Try again" for a task's stopped sequence through `throughDate` (the record's own key, whichever page stopped it), or
   * for its memory-only stop (no day): a fresh budget, then the work resumes.
   */
  tryAgain(taskId: string, throughDate?: string): void;
  /** Connectivity or compatibility changed: waiting work may proceed. */
  kick(): void;
  get(): RunnerState;
  subscribe(listener: () => void): () => void;
  /** Ends the runner: nothing more is sent or written; an answer on its way is dropped. Idempotent. */
  dispose(): void;
}

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The task's zone from its details, as `GET /tasks/{id}` returned them. */
function zoneOf(execution: { value: unknown } | null): string | null {
  const definition = execution ? parseDefinition(execution.value) : null;
  return definition?.schedule.timezone ?? null;
}

type Pause = { kind: "pause" };
const PAUSE: Pause = { kind: "pause" };

function classifySend(result: TasksResult<unknown>): SendAnswer | Pause {
  if (result.ok) return { kind: "ok" };
  switch (result.kind) {
    case "uncertain":
      return result.code === "slice_capacity"
        ? {
            kind: "capacity",
            ...(result.requestId ? { requestId: result.requestId } : {}),
          }
        : {
            kind: "uncertain",
            ...(result.requestId ? { requestId: result.requestId } : {}),
          };
    case "not_sent":
    case "offline":
    case "closed":
      return PAUSE;
    default:
      // 409 (an unmet precondition), 422 (an archived task, a day beyond the horizon), 403, 404: definite and terminal.
      return {
        kind: "rejected",
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
  }
}

interface PositionRead {
  answer: ReadAnswer | Pause;
  zone: string | null;
}

function classifyRead(
  result: Awaited<ReturnType<TasksApi["readTask"]>>,
): PositionRead {
  if (result.ok) {
    const m = result.value.materialisation;
    // The details are unreadable here: the position cannot be known, so nothing can be caught up from this page.
    if (m === null)
      return {
        answer: {
          kind: "rejected",
          ...(result.requestId ? { requestId: result.requestId } : {}),
        },
        zone: null,
      };
    const position: Position = { last_date: m.last_date, pending: m.pending };
    return {
      answer: { kind: "ok", position },
      zone: zoneOf(result.value.execution),
    };
  }
  switch (result.kind) {
    case "uncertain":
      return { answer: { kind: "uncertain" }, zone: null };
    case "not_sent":
    case "offline":
    case "closed":
      return { answer: PAUSE, zone: null };
    default:
      return {
        answer: {
          kind: "rejected",
          ...(result.requestId ? { requestId: result.requestId } : {}),
        },
        zone: null,
      };
  }
}

const POSITION_READ = (taskId: string) => `task:${taskId}`;

/**
 * One task to bring up to date, as asked. `resume`: the item of a sequence this page paused, resumed (its day is known). `retry`: the
 * person's "Try again", with the stops it was pressed on (the discovery entry and the day's sequence as they were read then), which it
 * lifts under the lock only if they still stand as seen.
 */
interface Item {
  taskId: string;
  trigger: Trigger;
  throughDate?: string;
  manual: boolean;
  resume?: boolean;
  retry?: { discovery: MaterialiseDiscovery | null; sequence: Sequence | null };
}

const NO_DISCOVERY: MaterialiseDiscovery = {
  retry: 0,
  failures: 0,
  stop: null,
};

/**
 * How one task's work ended (review R1): `done` when nothing more is to happen without the person (complete, a stop recorded or shown,
 * already handled on this page); `paused` when it stopped part-way for a reason that can clear (offline, not compatible, the session
 * held, a write not applied, a thrown read or store), with the day of the sequence it was working on once that is known.
 */
type Outcome = { kind: "done" } | { kind: "paused"; throughDate?: string };
const DONE: Outcome = { kind: "done" };
const PAUSED: Outcome = { kind: "paused" };
const keyed = (outcome: Outcome, throughDate: string): Outcome =>
  outcome.kind === "paused" ? { kind: "paused", throughDate } : outcome;

export function createCatchUpRunner(deps: CatchUpDeps): CatchUpRunner {
  const sleep = deps.sleep ?? sleepFor;
  const locks =
    deps.locks === undefined
      ? (globalThis.navigator?.locks ?? null)
      : deps.locks;
  const listeners = new Set<() => void>();
  const queue: Item[] = [];
  /**
   * Work paused part-way, by task (review R1): a durable sequence left `ready`, `submitting` or `awaiting_position_read` that this page
   * must take up again when what paused it clears (`kick`: connectivity, compatibility or the binding moved; `ensure` of the task; "Try
   * again"). It resumes THE SAME key: its stored attempt is resent with its own key, or only its position is read (CM-440); a genuine stop
   * is never parked, so it is never restarted.
   */
  const parked = new Map<string, Item>();
  /** `task|day` of every automatic sequence this page began or found: never begun again automatically. */
  const attempted = new Set<string>();
  /** The day each task was last brought up to date (or found stopped) through, in its zone: Today asks again on every read. */
  const settledThrough = new Map<string, { zone: string; day: string }>();
  let state: RunnerState = {
    active: [],
    current: null,
    waiting: false,
    unrecorded: new Map(),
    finished: 0,
    stops: 0,
  };
  let disposed = false;
  let running = false;
  const abort = new AbortController();

  const set = (patch: Partial<RunnerState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const park = (item: Item, throughDate: string | undefined) => {
    if (disposed) return;
    const day = throughDate ?? item.throughDate;
    parked.set(item.taskId, {
      ...item,
      ...(day === undefined ? {} : { throughDate: day }),
      resume: day !== undefined,
    });
  };
  /** Paused work back in the queue, first (it was asked first), unless the task is queued or worked on already. */
  const unpark = (taskId?: string) => {
    const items = [...parked.values()].filter(
      (p) => taskId === undefined || p.taskId === taskId,
    );
    for (const item of items) parked.delete(item.taskId);
    const fresh = items.filter(
      (p) =>
        !queue.some((q) => q.taskId === p.taskId) && state.current !== p.taskId,
    );
    if (fresh.length > 0) queue.unshift(...fresh);
    return fresh.length > 0;
  };
  const publishQueue = (current: string | null = state.current) =>
    set({
      active: [
        ...new Set([
          ...(current === null ? [] : [current]),
          ...queue.map((q) => q.taskId),
        ]),
      ],
      current,
    });
  const unrecord = (taskId: string, value?: UnrecordedStop) => {
    const next = new Map(state.unrecorded);
    if (value === undefined) next.delete(taskId);
    else next.set(taskId, value);
    set({ unrecorded: next });
  };

  /** This runner may still act: not disposed, the service it writes through still the displayed one. */
  const alive = (): AccountService | null => {
    if (disposed) return null;
    const service = deps.service();
    return service?.live && service.account === deps.accountId ? service : null;
  };
  const mayRun = () => alive() !== null && deps.online() && deps.writable();

  /** Commits `next` (or deletes) over `row` as stored; on `stale`, what is stored now (adopted). `null`: stop for this identity. */
  const commit = async (
    service: AccountService,
    captured: ReturnType<AccountService["capture"]>,
    key: SequenceKey,
    expected: Sequence | null,
    next: Sequence | null,
  ): Promise<{ stored: Sequence | null } | null> => {
    const out = await commitMaterialiseSequence(service, captured, {
      key,
      expected: expected === null ? null : expectationOf(expected),
      next,
    });
    if (out.kind !== "applied") return null;
    return { stored: out.value.stored };
  };

  const readPosition = async (taskId: string): Promise<PositionRead> => {
    const result = await deps.api.readTask(taskId);
    // A refusal is noted when it arrives (WEB-10a's consumer obligation), whatever this runner does next.
    noteIfRefused(deps.identity, POSITION_READ(taskId), result);
    return classifyRead(result);
  };

  /**
   * One sequence to its end, a stop, a pause or this identity's end. `row` is the stored sequence this runner works from; every
   * transition is committed over it, and a lost compare-and-set adopts what is stored instead.
   */
  const drive = async (
    start: Sequence,
    todayOf: () => string,
  ): Promise<Outcome> => {
    let row: Sequence | null = start;
    const key: SequenceKey = {
      task_id: start.task_id,
      through_date: start.through_date,
    };
    while (row !== null && row.phase !== "stopped") {
      const service = alive();
      if (service === null || !mayRun()) return PAUSED;
      const step = recover(row);
      if (step === "continue") {
        // `ready`: the attempt is written BEFORE it is sent.
        const next = submit(row, deps.newId);
        const out = await commit(
          service,
          service.capture(deps.epoch),
          key,
          row,
          next,
        );
        if (out === null) return PAUSED;
        row = out.stored;
        continue;
      }
      if (step === "send") {
        const attempt = row.attempt as { key: string; body: string };
        const captured = service.capture(deps.epoch);
        const result = await deps.api.materialise(
          JSON.parse(attempt.body) as MaterialiseCommand,
          attempt.key,
        );
        const answer = classifySend(result);
        if (answer.kind === "pause" || alive() === null) return PAUSED;
        const next = onSent(row, answer);
        const out = await commit(service, captured, key, row, next);
        if (out === null) return PAUSED;
        row = out.stored;
        if (
          answer.kind === "uncertain" &&
          row !== null &&
          row.phase === "submitting"
        ) {
          await sleep(RETRY_DELAYS_MS[row.read_failures - 1] ?? 4_000);
        }
        continue;
      }
      if (step === "read") {
        const captured = service.capture(deps.epoch);
        const read = await readPosition(row.task_id);
        if (read.answer.kind === "pause" || alive() === null) return PAUSED;
        const next = onRead(row, read.answer, todayOf());
        const out = await commit(service, captured, key, row, next);
        if (out === null) return PAUSED;
        row = out.stored;
        if (row === null) {
          set({ finished: state.finished + 1 });
          return DONE;
        }
        if (read.answer.kind === "uncertain" && row.phase !== "stopped")
          await sleep(RETRY_DELAYS_MS[row.read_failures - 1] ?? 4_000);
        continue;
      }
      return DONE;
    }
    if (row?.phase === "stopped") set({ stops: state.stops + 1 });
    return DONE;
  };

  /** A discovery stop that could not be recorded: kept in this page's memory, which refuses automatic work alike. */
  const stopInMemory = (taskId: string, stop: UnrecordedStop) => {
    unrecord(taskId, stop);
    set({ stops: state.stops + 1 });
    return DONE;
  };

  /**
   * The person's "Try again", under the lock (review R13): lifts the discovery stop and the day's stopped sequence it was pressed on, if
   * they still stand as seen (another press, here or in another tab, has lifted them already otherwise: nothing more is added). `false`:
   * a lift could not be written, so the stop stays shown and nothing is read.
   */
  const lift = async (
    service: AccountService,
    item: Item & { retry: NonNullable<Item["retry"]> },
  ): Promise<boolean> => {
    const seen = item.retry.discovery;
    if (seen?.stop) {
      const out = await commitMaterialiseDiscovery(
        service,
        service.capture(deps.epoch),
        {
          task_id: item.taskId,
          expected: seen,
          next: { retry: seen.retry + 1, failures: 0, stop: null },
        },
      );
      if (out.kind !== "applied") return false;
    }
    unrecord(item.taskId);
    const stopped = item.retry.sequence;
    if (stopped !== null) {
      // A fresh budget from the position reached, the held attempt (if any) kept.
      const out = await commit(
        service,
        service.capture(deps.epoch),
        { task_id: stopped.task_id, through_date: stopped.through_date },
        stopped,
        freshBudget(stopped),
      );
      if (out === null) return false;
    }
    return true;
  };

  /**
   * The first read of a task, admitted and counted by its discovery entry (W27): its zone (its day) and position. Uncertain answers are
   * retried with the same pacing; each is recorded before the next read, the bound's or a definite refusal is a recorded stop. A stop
   * already standing admits no read. An answer of a budget that a "Try again" has replaced meanwhile changes nothing (`stale`).
   */
  const discover = async (
    service: AccountService,
    item: Item,
  ): Promise<
    | {
        kind: "ok";
        read: PositionRead;
        captured: ReturnType<AccountService["capture"]>;
      }
    | { kind: "end"; outcome: Outcome }
  > => {
    if (state.unrecorded.has(item.taskId))
      return { kind: "end", outcome: DONE };
    const entries = await readMaterialiseDiscoveryNow(service);
    if (entries === undefined) return { kind: "end", outcome: PAUSED };
    let entry: MaterialiseDiscovery | null = entries[item.taskId] ?? null;
    if (entry?.stop) return { kind: "end", outcome: DONE };
    const record = async (next: MaterialiseDiscovery | null) => {
      const live = alive();
      if (live === null) return "paused" as const;
      const out = await commitMaterialiseDiscovery(
        live,
        live.capture(deps.epoch),
        { task_id: item.taskId, expected: entry, next },
      );
      if (out.kind !== "applied" || out.value.kind === "full")
        return "unrecorded" as const;
      if (out.value.kind === "stale") return "stale" as const;
      entry = out.value.stored;
      return "written" as const;
    };
    for (;;) {
      const captured = service.capture(deps.epoch);
      const read = await readPosition(item.taskId);
      if (read.answer.kind === "pause" || alive() === null)
        return { kind: "end", outcome: PAUSED };
      if (read.answer.kind === "ok" && read.zone !== null) {
        // Found: the discovery's failures are over (its entry goes); a page's memory stop of it is lifted by its success.
        if (entry !== null) await record(null);
        if (state.unrecorded.has(item.taskId)) unrecord(item.taskId);
        return { kind: "ok", read, captured };
      }
      const base = entry ?? NO_DISCOVERY;
      const failures =
        read.answer.kind === "uncertain" ? base.failures + 1 : base.failures;
      const stop: UnrecordedStop | null =
        read.answer.kind !== "uncertain"
          ? {
              reason: "rejected",
              ...(read.answer.kind === "rejected" && read.answer.requestId
                ? { requestId: read.answer.requestId }
                : {}),
            }
          : failures >= MAX_READ_FAILURES
            ? { reason: "unreachable" }
            : null;
      const written = await record({
        retry: base.retry,
        failures,
        stop:
          stop === null
            ? null
            : {
                reason: stop.reason,
                ...(stop.requestId ? { request_id: stop.requestId } : {}),
              },
      });
      if (written === "paused") return { kind: "end", outcome: PAUSED };
      if (written === "stale") return { kind: "end", outcome: DONE };
      if (written === "unrecorded")
        return {
          kind: "end",
          outcome: stopInMemory(item.taskId, stop ?? { reason: "unreachable" }),
        };
      if (stop !== null) {
        set({ stops: state.stops + 1 });
        return { kind: "end", outcome: DONE };
      }
      await sleep(RETRY_DELAYS_MS[failures - 1] as number);
      if (!mayRun()) return { kind: "end", outcome: PAUSED };
    }
  };

  /** Finds or begins the sequence of one task through its day, then drives it. */
  const work = async (item: Item): Promise<Outcome> => {
    let service = alive();
    if (service === null) return PAUSED;
    if (
      item.retry !== undefined &&
      !(await lift(service, { ...item, retry: item.retry }))
    )
      return DONE;
    const found = await discover(service, item);
    if (found.kind === "end") return found.outcome;
    const { read, captured } = found;
    service = alive();
    if (service === null || read.answer.kind !== "ok" || read.zone === null)
      return PAUSED;
    const zone = read.zone;
    const today = () => todayIn(zone, deps.now());
    const throughDate = item.throughDate ?? today();
    const key: SequenceKey = {
      task_id: item.taskId,
      through_date: throughDate,
    };
    const mark = `${item.taskId}|${throughDate}`;
    if (!item.manual && !item.resume && attempted.has(mark)) return DONE;
    attempted.add(mark);
    settledThrough.set(item.taskId, { zone, day: throughDate });
    // From here the work is this sequence's: a pause resumes THIS key (`park`), never a new day's or a fresh attempt's. A thrown read
    // or store is such a pause too (its record says where it stands).
    const paused: Outcome = { kind: "paused", throughDate };
    try {
      return await sequence(service, item, read.answer, {
        key,
        throughDate,
        today,
        captured,
        paused,
      });
    } catch {
      return paused;
    }
  };

  /** The sequence of one task through its day: adopted as stored, or begun; then driven. */
  const sequence = async (
    service: AccountService,
    item: Item,
    answer: Extract<ReadAnswer, { kind: "ok" }>,
    at: {
      key: SequenceKey;
      throughDate: string;
      today: () => string;
      captured: ReturnType<AccountService["capture"]>;
      paused: Outcome;
    },
  ): Promise<Outcome> => {
    const { key, throughDate, today, captured, paused } = at;
    const stored = await readMaterialiseSequenceNow(service, key);
    if (stored === undefined) return paused;
    if (stored !== null) {
      // Adopted: a sequence another page began, or one this page left on a reload. A stop is shown, never resumed automatically.
      if (stored.phase === "stopped") return DONE;
      if (stored.phase === "awaiting_position_read") {
        // Its call was answered before this page held the lock, so the read just made was asked after it: it is the sequence's position
        // read (one read, never another `materialise`; CM-440), admitted only over the row as found.
        const next = onRead(stored, answer, today());
        const out = await commit(service, captured, key, stored, next);
        if (out === null) return paused;
        if (out.stored === null) {
          set({ finished: state.finished + 1 });
          return DONE;
        }
        return keyed(await drive(out.stored, today), throughDate);
      }
      return keyed(await drive(stored, today), throughDate);
    }
    const fresh = begin({
      taskId: item.taskId,
      throughDate,
      trigger: item.trigger,
      generation: deps.newId(),
      nowMs: deps.now(),
      position: answer.position,
      today: today(),
    });
    if (fresh === null) {
      set({ finished: state.finished + 1 });
      return DONE;
    }
    const created = await commit(
      service,
      service.capture(deps.epoch),
      key,
      null,
      fresh,
    );
    if (created === null) return paused;
    if (created.stored === null) return DONE;
    // Housekeeping: the task's earlier days that are not running.
    void pruneOlderSequences(service, service.capture(deps.epoch), {
      task_id: item.taskId,
      before: throughDate,
    });
    if (created.stored.phase === "stopped") {
      set({ stops: state.stops + 1 });
      return DONE;
    }
    return keyed(await drive(created.stored, today), throughDate);
  };

  const loop = async (): Promise<void> => {
    while (queue.length > 0 && mayRun()) {
      const item = queue.shift() as Item;
      publishQueue(item.taskId);
      let outcome: Outcome;
      try {
        outcome = await work(item);
      } catch {
        // A thrown read or store: the work did not end, so it is kept as a pause (its record says where it stands).
        outcome = PAUSED;
      }
      if (outcome.kind === "paused") park(item, outcome.throughDate);
      publishQueue(null);
    }
  };

  const pump = (): void => {
    if (running || disposed || queue.length === 0 || !mayRun()) return;
    running = true;
    const finish = () => {
      running = false;
      set({ waiting: false });
      // Work that arrived while the lock was held (or waited for) runs next.
      if (queue.length > 0 && mayRun()) pump();
    };
    if (locks === null) {
      void loop().finally(finish);
      return;
    }
    set({ waiting: true });
    locks
      .request(
        `atlas-materialise:${deps.accountId}`,
        { signal: abort.signal },
        async () => {
          set({ waiting: false });
          await loop();
        },
      )
      .then(finish, finish);
  };

  return {
    identity: deps.identity,
    ensure(taskId, trigger, options = {}) {
      if (disposed) return;
      // Work on this task that paused part-way is taken up again (review R1), whichever trigger asks.
      if (unpark(taskId)) {
        publishQueue();
        pump();
        return;
      }
      if (queue.some((q) => q.taskId === taskId) || state.current === taskId)
        return;
      // A discovery stop this page could not record admits nothing automatic either (a recorded one is refused where the work begins).
      if (state.unrecorded.has(taskId)) return;
      // Brought up to date (or found stopped) through this task's today already on this page: nothing to ask again.
      const known = settledThrough.get(taskId);
      if (
        options.throughDate === undefined &&
        known !== undefined &&
        todayIn(known.zone, deps.now()) === known.day
      )
        return;
      if (
        options.throughDate !== undefined &&
        attempted.has(`${taskId}|${options.throughDate}`)
      )
        return;
      queue.push({
        taskId,
        trigger,
        ...(options.throughDate ? { throughDate: options.throughDate } : {}),
        manual: false,
      });
      publishQueue();
      pump();
    },
    tryAgain(taskId, throughDate) {
      if (disposed) return;
      void (async () => {
        // What the person pressed it on, as stored now: lifted under the lock only if it still stands so (review R13).
        const service = alive();
        const day = throughDate ?? settledThrough.get(taskId)?.day;
        let discovery: MaterialiseDiscovery | null = null;
        let sequence: Sequence | null = null;
        if (service !== null) {
          const entries = await readMaterialiseDiscoveryNow(service);
          if (entries === undefined) return;
          discovery = entries[taskId] ?? null;
          if (day !== undefined) {
            const stored = await readMaterialiseSequenceNow(service, {
              task_id: taskId,
              through_date: day,
            });
            if (stored === undefined) return;
            if (stored?.phase === "stopped") sequence = stored;
          }
        }
        if (disposed) return;
        // The person's act supersedes paused work on the task: it is asked for again, once.
        parked.delete(taskId);
        const retry = { discovery, sequence };
        const queued = queue.find((q) => q.taskId === taskId);
        if (queued !== undefined) {
          queued.manual = true;
          queued.retry = retry;
          if (day !== undefined) queued.throughDate = day;
        } else
          queue.push({
            taskId,
            trigger: "daily",
            ...(day === undefined ? {} : { throughDate: day }),
            manual: true,
            retry,
          });
        publishQueue();
        pump();
      })();
    },
    kick() {
      if (disposed) return;
      if (unpark()) publishQueue();
      pump();
    },
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      queue.length = 0;
      parked.clear();
      abort.abort();
      set({ active: [], current: null, waiting: false });
    },
  };
}
