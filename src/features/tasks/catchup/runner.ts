import {
  type AccountService,
  commitMaterialiseSequence,
  type MaterialiseSequenceRow,
  pruneOlderSequences,
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
  /** Stops that have no record (the first read never answered): memory only, with "Try again". */
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

export function createCatchUpRunner(deps: CatchUpDeps): CatchUpRunner {
  const sleep = deps.sleep ?? sleepFor;
  const locks =
    deps.locks === undefined
      ? (globalThis.navigator?.locks ?? null)
      : deps.locks;
  const listeners = new Set<() => void>();
  const queue: Array<{
    taskId: string;
    trigger: Trigger;
    throughDate?: string;
    manual: boolean;
  }> = [];
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
  ): Promise<void> => {
    let row: Sequence | null = start;
    const key: SequenceKey = {
      task_id: start.task_id,
      through_date: start.through_date,
    };
    while (row !== null && row.phase !== "stopped") {
      const service = alive();
      if (service === null || !mayRun()) return;
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
        if (out === null) return;
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
        if (answer.kind === "pause" || alive() === null) return;
        const next = onSent(row, answer);
        const out = await commit(service, captured, key, row, next);
        if (out === null) return;
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
        if (read.answer.kind === "pause" || alive() === null) return;
        const next = onRead(row, read.answer, todayOf());
        const out = await commit(service, captured, key, row, next);
        if (out === null) return;
        row = out.stored;
        if (row === null) {
          set({ finished: state.finished + 1 });
          return;
        }
        if (read.answer.kind === "uncertain" && row.phase !== "stopped")
          await sleep(RETRY_DELAYS_MS[row.read_failures - 1] ?? 4_000);
        continue;
      }
      return;
    }
    if (row?.phase === "stopped") set({ stops: state.stops + 1 });
  };

  /** Finds or begins the sequence of one task through its day, then drives it. */
  const work = async (item: (typeof queue)[number]): Promise<void> => {
    let service = alive();
    if (service === null) return;
    // The first read: the task's zone (its day) and position. Uncertain answers are retried with the same pacing; a definite refusal or
    // no answer at all is a stop this page shows (nothing is recorded: there was nothing to send).
    let read: PositionRead | null = null;
    // The stamp of the read that is answered last: a sequence adopted while awaiting its position takes that read as its own.
    let captured = service.capture(deps.epoch);
    for (let failures = 0; ; ) {
      captured = service.capture(deps.epoch);
      read = await readPosition(item.taskId);
      if (read.answer.kind !== "uncertain") break;
      failures += 1;
      if (failures >= MAX_READ_FAILURES) break;
      await sleep(RETRY_DELAYS_MS[failures - 1] as number);
      if (!mayRun()) return;
    }
    service = alive();
    if (service === null || read === null || read.answer.kind === "pause")
      return;
    if (read.answer.kind !== "ok" || read.zone === null) {
      const reason =
        read.answer.kind === "uncertain" ? "unreachable" : "rejected";
      unrecord(item.taskId, {
        reason,
        ...(read.answer.kind === "rejected" && read.answer.requestId
          ? { requestId: read.answer.requestId }
          : {}),
      });
      set({ stops: state.stops + 1 });
      return;
    }
    const zone = read.zone;
    const today = () => todayIn(zone, deps.now());
    const throughDate = item.throughDate ?? today();
    const key: SequenceKey = {
      task_id: item.taskId,
      through_date: throughDate,
    };
    const mark = `${item.taskId}|${throughDate}`;
    if (!item.manual && attempted.has(mark)) return;
    attempted.add(mark);
    settledThrough.set(item.taskId, { zone, day: throughDate });
    const stored = await readMaterialiseSequenceNow(service, key);
    if (stored === undefined) return;
    if (stored !== null) {
      // Adopted: a sequence another page began, or one this page left on a reload. A stop is shown, never resumed automatically.
      if (stored.phase === "stopped") return;
      if (stored.phase === "awaiting_position_read") {
        // Its call was answered before this page held the lock, so the read just made was asked after it: it is the sequence's position
        // read (one read, never another `materialise`; CM-440), admitted only over the row as found.
        const next = onRead(stored, read.answer, today());
        const out = await commit(service, captured, key, stored, next);
        if (out === null) return;
        if (out.stored === null) {
          set({ finished: state.finished + 1 });
          return;
        }
        await drive(out.stored, today);
        return;
      }
      await drive(stored, today);
      return;
    }
    const fresh = begin({
      taskId: item.taskId,
      throughDate,
      trigger: item.trigger,
      generation: deps.newId(),
      nowMs: deps.now(),
      position: read.answer.position,
      today: today(),
    });
    if (fresh === null) {
      set({ finished: state.finished + 1 });
      return;
    }
    const created = await commit(
      service,
      service.capture(deps.epoch),
      key,
      null,
      fresh,
    );
    if (created === null || created.stored === null) return;
    // Housekeeping: the task's earlier days that are not running.
    void pruneOlderSequences(service, service.capture(deps.epoch), {
      task_id: item.taskId,
      before: throughDate,
    });
    if (created.stored.phase === "stopped") {
      set({ stops: state.stops + 1 });
      return;
    }
    await drive(created.stored, today);
  };

  const loop = async (): Promise<void> => {
    while (queue.length > 0 && mayRun()) {
      const item = queue.shift() as (typeof queue)[number];
      publishQueue(item.taskId);
      try {
        await work(item);
      } catch {
        // A thrown read or store: this task is left as its record says; the next ensure or "Try again" starts again.
      }
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
      if (queue.some((q) => q.taskId === taskId) || state.current === taskId)
        return;
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
        unrecord(taskId);
        const service = alive();
        const day = throughDate ?? settledThrough.get(taskId)?.day;
        if (service !== null && day !== undefined) {
          const key = { task_id: taskId, through_date: day };
          const stored = await readMaterialiseSequenceNow(service, key);
          if (stored?.phase === "stopped") {
            // The person's act: a fresh budget from the position reached, the held attempt (if any) kept.
            const out = await commit(
              service,
              service.capture(deps.epoch),
              key,
              stored,
              freshBudget(stored),
            );
            if (out === null) return;
          }
        }
        if (queue.some((q) => q.taskId === taskId) || state.current === taskId)
          return;
        queue.push({
          taskId,
          trigger: "daily",
          ...(day === undefined ? {} : { throughDate: day }),
          manual: true,
        });
        publishQueue();
        pump();
      })();
    },
    kick: pump,
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
      abort.abort();
      set({ active: [], current: null, waiting: false });
    },
  };
}
