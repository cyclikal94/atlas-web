import {
  type AccountService,
  clearSatisfiedSequences,
  commitMaterialiseDiscovery,
  commitMaterialiseLift,
  commitMaterialiseSequence,
  type DataEnv,
  DISCOVERY_REQUEST_ID,
  type MaterialiseDiscovery,
  type MaterialiseSequenceRow,
  readMaterialiseDiscoveryNow,
  readMaterialiseSequenceNow,
  readTaskSequencesNow,
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
  satisfied,
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
 *
 * ADMISSION (revision 3, review R16): no first read is sent before it is ADMITTED in the task's entry (a fresh `attempt`, written first),
 * so every read's answer can be recorded: a new task's entry is admitted through the quota ledger, and one the ledger refuses sends
 * nothing (a `storage` stop of this page, with "Try again"; a reload asks again, sending nothing until it is admitted). Each answer is
 * recorded only over its own attempt, so a read another page admitted since (a page without Web Locks), or one of an entry deleted and
 * made again, changes nothing, and a lost claim never consumes another budget.
 *
 * BINDING (revision 3, review R17): each piece of work belongs to the service it began with (`Binding`: the exact service object, the
 * database incarnation it writes). It reads, writes and stamps through that service only, and checks after every wait that it is still
 * the displayed one: an answer that arrives once another service has replaced it (the same account and epoch, another database or a
 * reopened one) is dropped unrecorded, and the work is asked again under the new binding. A new binding retires what this page
 * remembered of the old one (`attempted`, `settledThrough`, `unrecorded`, paused work), and a "Try again" pressed on the old one lifts
 * nothing in the new one. A moment with no service bound is a pause.
 *
 * RETENTION AND TARGETS (revision 5, reviews R24 and R25; WEB-04 §5.8): work is per task AND day (`[task, through_date]`): a second day of
 * a task asked for while another is queued, worked on or paused is kept as its own work, never absorbed. A stopped row is never deleted
 * because a later day begins: a row goes only when a position read shows its own day covered (its sequence's, or any read of the task:
 * `clearSatisfied`, each row compared as read). A new row grows the store and is admitted through the quota ledger first; one not
 * admitted sends nothing (a `storage` stop of this page). The zone each task's read found (`zones`) lets a screen name the exact day it
 * works for.
 *
 * CONSENT (revision 5, review R26): a "Try again" names the stop the screen SHOWED by identities that never recur: a discovery stop by its
 * retry AND the claim it stopped on (a fresh claim per read, so a discovery that succeeded and stopped again is another stop), a day's
 * sequence by its generation and revision together with the discovery stop shown in front of it (or none), a page's memory stop by its
 * own id, and "no stop shown" explicitly. A press whose stop no longer stands exactly so lifts nothing and sends nothing.
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
  /**
   * `navigator.locks`, or null where there is none. Without it, pages are not excluded from each other: each first read is still admitted
   * (claimed) in the task's entry before it is sent and recorded only over its own claim, so a page that lost the claim records nothing.
   */
  locks?: LockManager | null;
  /** The origin's quota ledger (a new task's discovery entry is admitted through it); absent: not admitted (a test of the runner alone). */
  quota?(): DataEnv["quota"] | null;
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
  /**
   * The zone each task's read found on this page, under the binding displayed (revision 5, R24): a screen working for the task's today
   * names that exact day (`todayIn(zone, now)`); a task not read yet has none (its day is not known: never the device's own date).
   */
  zones: ReadonlyMap<string, string>;
  /**
   * The days each task was asked for EXPLICITLY on this page under the binding displayed (revision 6, review R28: a command's day), the
   * most recent `ASKED_DAYS`: a screen looks each up by its own key, so its stop is found however many later days the task holds.
   */
  asked: ReadonlyMap<string, readonly string[]>;
}

/** The most explicitly asked days of one task a runner remembers for the screens (revision 6, R28). */
export const ASKED_DAYS = 6;

export interface UnrecordedStop {
  /**
   * `storage`: the task's entry, or a new day's row, could not be admitted (the quota ledger refused its growth), so nothing was sent
   * (revision 3, R16; revision 5).
   */
  reason: "unreachable" | "rejected" | "storage";
  requestId?: string;
  /** This stop's own identity (revision 5, R26): a fresh one for every stop held, so a press on an earlier one never lifts a later one. */
  id: string;
  /** The day of the new row that could not be admitted (revision 6, R29): a press asks for THAT day again, not whichever was worked last. */
  throughDate?: string;
}

/** A discovery stop as shown (revision 5, R26): its retry and the claim it stopped on, which is never reused. */
export interface DiscoveryToken {
  retry: number;
  attempt: string | null;
}

/**
 * The stop a "Try again" was pressed on, as the screen showed it (revision 4, review R20; revision 5, R26): a day's sequence by its
 * generation and revision (every write moves the revision, so a later stop is never this one) and the discovery stop shown in front of it
 * (`null`: none was); a discovery by its retry and claim; a stop held in a page's memory by its id; or none at all (the screen showed no
 * stop of the task: a stop that appeared since is not lifted).
 */
export type SeenStop =
  | {
      kind: "sequence";
      generation: string;
      revision: number;
      discovery: DiscoveryToken | null;
    }
  | ({ kind: "discovery" } & DiscoveryToken)
  | { kind: "memory"; id: string }
  | { kind: "none" };

/** What a discovery stop shown names (revision 5, R26). One builder for every screen. */
export const discoveryToken = (
  entry: MaterialiseDiscovery,
): DiscoveryToken => ({ retry: entry.retry, attempt: entry.attempt ?? null });

/** What a press on a day's stopped sequence names, with the discovery stop shown beside it, if any (revision 5, R26). */
export const seenSequence = (
  row: MaterialiseSequenceRow,
  discovery: MaterialiseDiscovery | null | undefined,
): SeenStop => ({
  kind: "sequence",
  generation: row.sequence_generation,
  revision: row.revision ?? 0,
  discovery: discovery?.stop ? discoveryToken(discovery) : null,
});

/** What a press on a discovery stop names (revision 5, R26). */
export const seenDiscovery = (entry: MaterialiseDiscovery): SeenStop => ({
  kind: "discovery",
  ...discoveryToken(entry),
});

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
   * for its memory-only stop (no day): a fresh budget, then the work resumes. `seen`: the stop the person pressed it on, as shown (review
   * R20); when it no longer stands as shown, nothing is lifted or asked (the screen shows what stands now).
   */
  tryAgain(taskId: string, throughDate?: string, seen?: SeenStop): void;
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
  /** Asked again once already because its binding ended (R17): another end parks it for the next kick instead of looping. */
  rebound?: boolean;
  retry?: {
    /** The discovery entry as read at the press: its stop is lifted only while it stands so; none (or one with no stop): none may stand. */
    discovery: MaterialiseDiscovery | null;
    sequence: Sequence | null;
    /** The service it was pressed under: a press of an ended binding lifts nothing in another (review R17). */
    service: AccountService | null;
  };
}

/** The binding one piece of work began with (review R17): it reads, writes and stamps through this service only. */
interface Binding {
  service: AccountService;
}

/**
 * What a press made on `seen` lifts of what is stored now (review R20; revision 5, R26), or `null` when the stop the screen showed no
 * longer stands EXACTLY so: a day's stop only while it is that very row (generation and revision) and the discovery stop in front of it
 * is the one shown with it (or there is still none, as shown); a discovery stop only while it is that entry's stop on that very claim; a
 * memory stop only while it is the one held; "none" only while no stop of the task stands. The discovery is compared by its claim, which
 * is never reused, so a discovery that succeeded (its entry gone) and stopped again is never the stop an earlier screen showed.
 */
function pressedOn(
  seen: SeenStop,
  discovery: MaterialiseDiscovery | null,
  sequence: Sequence | null,
  memory: UnrecordedStop | undefined,
): {
  discovery: MaterialiseDiscovery | null;
  sequence: Sequence | null;
} | null {
  const stands = (token: DiscoveryToken | null) =>
    token === null
      ? !discovery?.stop
      : !!discovery?.stop &&
        discovery.retry === token.retry &&
        (discovery.attempt ?? null) === (token.attempt ?? null);
  switch (seen.kind) {
    case "sequence":
      return sequence !== null &&
        sequence.sequence_generation === seen.generation &&
        (sequence.revision ?? 0) === seen.revision &&
        stands(seen.discovery ?? null)
        ? { discovery: discovery?.stop ? discovery : null, sequence }
        : null;
    case "discovery":
      return stands(seen) ? { discovery, sequence: null } : null;
    case "memory":
      return memory?.id === seen.id
        ? { discovery: null, sequence: null }
        : null;
    case "none":
      return !discovery?.stop && sequence === null && memory === undefined
        ? { discovery: null, sequence: null }
        : null;
  }
}

/** The key of one piece of work (revision 5, R24/R25): its task and the day asked for (`""`: its today, once its zone is known). */
const workKey = (item: { taskId: string; throughDate?: string | undefined }) =>
  `${item.taskId}|${item.throughDate ?? ""}`;

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
type Outcome =
  | { kind: "done" }
  | { kind: "paused"; throughDate?: string }
  /** The binding it began with ended (another service is displayed now): nothing more of it is written; the task is asked again. */
  | { kind: "ended" };
const DONE: Outcome = { kind: "done" };
const PAUSED: Outcome = { kind: "paused" };
const ENDED: Outcome = { kind: "ended" };
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
    zones: new Map(),
    asked: new Map(),
  };
  /** The key of the work being done now (revision 5): another day of the same task is other work. */
  let currentKey: string | null = null;
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
    // Kept under the day it was found to be (revision 6, R29): an implicit today that resolved is that day's work from now on.
    parked.set(workKey({ taskId: item.taskId, throughDate: day }), {
      ...item,
      ...(day === undefined ? {} : { throughDate: day }),
      resume: day !== undefined,
    });
  };
  /** The work is queued or being done already (the same task and day). */
  const pending = (key: string) =>
    currentKey === key || queue.some((q) => workKey(q) === key);
  /** Paused work back in the queue, first (it was asked first), unless the same task and day is queued or worked on already. */
  const unpark = (taskId?: string) => {
    const entries = [...parked].filter(
      ([, p]) => taskId === undefined || p.taskId === taskId,
    );
    for (const [key] of entries) parked.delete(key);
    const fresh = entries
      .filter(([, item]) => !pending(workKey(item)))
      .map(([, item]) => item);
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
  const unrecord = (taskId: string, value?: Omit<UnrecordedStop, "id">) => {
    const next = new Map(state.unrecorded);
    if (value === undefined) next.delete(taskId);
    // A fresh identity for every stop held (revision 5, R26): a press on an earlier one names another.
    else next.set(taskId, { ...value, id: deps.newId() });
    set({ unrecorded: next });
  };
  /** A day asked for explicitly, for the screens (revision 6, R28): kept once, the most recent `ASKED_DAYS`. */
  const noteAsked = (taskId: string, day: string) => {
    const held = state.asked.get(taskId) ?? [];
    if (held.includes(day)) return;
    const next = [...held, day].slice(-ASKED_DAYS);
    set({ asked: new Map(state.asked).set(taskId, next) });
  };
  /** The zone a task's read found, for the screens (revision 5, R24). */
  const zoneFound = (taskId: string, zone: string) => {
    if (state.zones.get(taskId) === zone) return;
    set({ zones: new Map(state.zones).set(taskId, zone) });
  };

  /** This runner may still act: not disposed, the service it writes through still the displayed one. */
  const alive = (): AccountService | null => {
    if (disposed) return null;
    const service = deps.service();
    return service?.live && service.account === deps.accountId ? service : null;
  };
  const mayRun = () => alive() !== null && deps.online() && deps.writable();

  /** This work's binding is still the displayed one (review R17). */
  const owns = (at: Binding) =>
    !disposed && at.service.live && deps.service() === at.service;
  /** How work whose binding is no longer the displayed one ends: another service displayed, ended; none at the moment, a pause. */
  const lost = (at: Binding): Outcome => {
    if (disposed) return DONE;
    const now = deps.service();
    return now !== null && now !== at.service ? ENDED : PAUSED;
  };
  /** A commit that did not apply: its binding ended, or a pause (a store failure, the guards of the same binding). */
  const unapplied = (at: Binding): Outcome => (owns(at) ? PAUSED : lost(at));

  /**
   * The service this page's work last began under. Another one (review R17) retires what this page remembered of the old one: the days
   * it began or settled, its memory-only stops and its paused work, which is asked again as plain work (never resumed as the old one's).
   */
  let bound: AccountService | null = null;
  const rebind = (service: AccountService | null) => {
    if (service === null || service === bound) return;
    if (bound !== null) {
      attempted.clear();
      settledThrough.clear();
      for (const [key, item] of parked)
        parked.set(key, {
          taskId: item.taskId,
          trigger: item.trigger,
          manual: false,
          ...(item.throughDate === undefined
            ? {}
            : { throughDate: item.throughDate }),
        });
      if (
        state.unrecorded.size > 0 ||
        state.zones.size > 0 ||
        state.asked.size > 0
      )
        set({ unrecorded: new Map(), zones: new Map(), asked: new Map() });
    }
    bound = service;
  };

  /** Commits `next` (or deletes) over `row` as stored; on `stale`, what is stored now (adopted). `null`: not applied. */
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
  /**
   * A NEW row (revision 5): its growth admitted through the quota ledger first. `refused`: not admitted, nothing written; `null`: not
   * applied; on `stale`, what is stored now (adopted).
   */
  const create = async (
    service: AccountService,
    captured: ReturnType<AccountService["capture"]>,
    key: SequenceKey,
    next: Sequence,
  ): Promise<{ stored: Sequence | null } | "refused" | null> => {
    const quota = deps.quota?.() ?? null;
    const out = await commitMaterialiseSequence(
      service,
      captured,
      { key, expected: null, next },
      quota === null ? null : { quota },
    );
    if (out.kind !== "applied") return null;
    if (out.value.kind === "refused") return "refused";
    return { stored: out.value.stored };
  };
  /**
   * Revision 5 (reviews R24 and R25, WEB-04 §5.8): `position`, as a read of the task answered it (`captured`: its stamp), covers these
   * rows' days too: each is removed, only while it is still the row read (another page's lift, advance or new row of it stays). Rows not
   * covered stay, whatever their phase; a store failure removes nothing (the rows stay until a later read).
   */
  const clearSatisfied = async (
    at: Binding,
    captured: ReturnType<AccountService["capture"]>,
    taskId: string,
    position: Position,
    today: string,
    except?: string,
  ) => {
    const rows = await readTaskSequencesNow(at.service, taskId);
    if (rows === undefined || !owns(at)) return;
    const done = rows.filter(
      (row) =>
        row.through_date !== except &&
        satisfied(position, row.through_date, today),
    );
    if (done.length === 0) return;
    await clearSatisfiedSequences(at.service, captured, {
      task_id: taskId,
      rows: done.map((row) => ({
        through_date: row.through_date,
        expected: expectationOf(row) as NonNullable<
          ReturnType<typeof expectationOf>
        >,
      })),
    });
  };

  const readPosition = async (taskId: string): Promise<PositionRead> => {
    const result = await deps.api.readTask(taskId);
    // A refusal is noted when it arrives (WEB-10a's consumer obligation), whatever this runner does next.
    noteIfRefused(deps.identity, POSITION_READ(taskId), result);
    return classifyRead(result);
  };

  /**
   * One sequence to its end, a stop, a pause or the end of its binding. `row` is the stored sequence this runner works from; every
   * transition is committed over it through the binding's service, and a lost compare-and-set adopts what is stored instead.
   */
  const drive = async (
    at: Binding,
    start: Sequence,
    todayOf: () => string,
  ): Promise<Outcome> => {
    let row: Sequence | null = start;
    const key: SequenceKey = {
      task_id: start.task_id,
      through_date: start.through_date,
    };
    const service = at.service;
    while (row !== null && row.phase !== "stopped") {
      if (!owns(at)) return lost(at);
      if (!mayRun()) return PAUSED;
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
        if (out === null) return unapplied(at);
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
        if (!owns(at)) return lost(at);
        if (answer.kind === "pause") return PAUSED;
        const next = onSent(row, answer);
        const out = await commit(service, captured, key, row, next);
        if (out === null) return unapplied(at);
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
        if (!owns(at)) return lost(at);
        if (read.answer.kind === "pause") return PAUSED;
        const next = onRead(row, read.answer, todayOf());
        const out = await commit(service, captured, key, row, next);
        if (out === null) return unapplied(at);
        row = out.stored;
        if (row === null) {
          // The position covers this day; the task's other days it covers are satisfied too (revision 5).
          if (next === null && read.answer.kind === "ok")
            await clearSatisfied(
              at,
              captured,
              key.task_id,
              read.answer.position,
              todayOf(),
              key.through_date,
            );
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
  const stopInMemory = (taskId: string, stop: Omit<UnrecordedStop, "id">) => {
    unrecord(taskId, stop);
    set({ stops: state.stops + 1 });
    return DONE;
  };

  /**
   * The person's "Try again", under the lock (review R13), through the binding it was pressed under (R17): lifts the discovery stop and
   * the day's stopped sequence it was pressed on, if they still stand as seen, in ONE compare-and-set (revision 4, review R20: both or
   * neither; the sequence compared by its revision, so a stop that came back the same way after another press's budget is not the one
   * pressed on). Only a lift WRITTEN here admits a fresh budget: another press, here or in another tab, that lifted them first leaves this
   * one with nothing to add. `false`: nothing more is done (the stop stays shown, or the other press's work carries on).
   */
  const lift = async (
    at: Binding,
    item: Item & { retry: NonNullable<Item["retry"]> },
  ): Promise<boolean> => {
    const seen = item.retry.discovery;
    const stopped = item.retry.sequence;
    if (seen?.stop || stopped !== null) {
      const out = await commitMaterialiseLift(
        at.service,
        at.service.capture(deps.epoch),
        {
          task_id: item.taskId,
          // Revision 6 (review R30): the discovery as the press saw it is compared inside the same transaction, a stop or NONE; a stop
          // recorded while this press waited makes the whole lift stale (nothing lifted, the sequence's stop and its attempt kept).
          discovery: seen?.stop
            ? {
                kind: "stopped",
                expected: seen,
                next: {
                  retry: seen.retry + 1,
                  failures: 0,
                  stop: null,
                  attempt: null,
                },
              }
            : { kind: "no_stop" },
          // A fresh budget from the position reached, the held attempt (if any) kept: same key, same body (CM-440).
          sequence:
            stopped === null
              ? null
              : {
                  key: {
                    task_id: stopped.task_id,
                    through_date: stopped.through_date,
                  },
                  expected: expectationOf(stopped) as NonNullable<
                    ReturnType<typeof expectationOf>
                  >,
                  next: freshBudget(stopped),
                },
        },
      );
      if (out.kind !== "applied" || out.value.kind !== "written") return false;
    }
    if (!owns(at)) return false;
    unrecord(item.taskId);
    return true;
  };

  /**
   * The first read of a task, ADMITTED and counted by its discovery entry (W27): its zone (its day) and position. Before each read the
   * entry claims it (a fresh `attempt`; revision 3, R16), so its answer can always be recorded; an answer is recorded only over its own
   * attempt, through the binding's service with its read's stamp (R17). Uncertain answers are retried with the same pacing, each recorded
   * (claiming the next read) before the next is made; the bound's or a definite refusal is a recorded stop. A stop already standing
   * admits no read; an entry the quota ledger would not admit sends nothing.
   */
  const discover = async (
    at: Binding,
    item: Item,
  ): Promise<
    | {
        kind: "ok";
        read: PositionRead;
        captured: ReturnType<AccountService["capture"]>;
      }
    | { kind: "end"; outcome: Outcome }
  > => {
    const end = (outcome: Outcome) => ({ kind: "end" as const, outcome });
    if (state.unrecorded.has(item.taskId)) return end(DONE);
    const entries = await readMaterialiseDiscoveryNow(at.service);
    if (!owns(at)) return end(lost(at));
    if (entries === undefined) return end(PAUSED);
    let entry: MaterialiseDiscovery | null = entries[item.taskId] ?? null;
    if (entry?.stop) {
      // A stop written before claims existed names no claim: it is given one, sending nothing and changing no count, so a press can
      // name it by an identity that never recurs (revision 5, R26). Until that is written, only a press naming no claim lifts it.
      if ((entry.attempt ?? null) === null)
        await commitMaterialiseDiscovery(
          at.service,
          at.service.capture(deps.epoch),
          {
            task_id: item.taskId,
            expected: entry,
            next: { ...entry, attempt: deps.newId() },
          },
        );
      return end(DONE);
    }
    const quota = deps.quota?.() ?? null;
    /** `next` over the entry this work admitted, through its own service, stamped as given (an answer: its read's issue). */
    const record = async (
      captured: ReturnType<AccountService["capture"]>,
      next: MaterialiseDiscovery | null,
    ) => {
      const out = await commitMaterialiseDiscovery(
        at.service,
        captured,
        { task_id: item.taskId, expected: entry, next },
        quota === null ? null : { quota },
      );
      if (!owns(at) || out.kind === "dropped") return "lost" as const;
      if (out.kind === "failed") return "failed" as const;
      if (out.value.kind !== "written") return out.value.kind;
      entry = out.value.stored;
      return "written" as const;
    };
    // Admission: the read is claimed in the entry before it is sent (a new task's entry admitted through the quota ledger).
    const admitted = await record(at.service.capture(deps.epoch), {
      ...(entry ?? NO_DISCOVERY),
      attempt: deps.newId(),
    });
    if (admitted === "lost") return end(lost(at));
    // Another page decided meanwhile (its record is what is shown); nothing was sent.
    if (admitted === "stale") return end(DONE);
    if (admitted === "failed") return end(PAUSED);
    if (admitted === "refused")
      return end(stopInMemory(item.taskId, { reason: "storage" }));
    for (;;) {
      const captured = at.service.capture(deps.epoch);
      const read = await readPosition(item.taskId);
      if (read.answer.kind === "pause") return end(PAUSED);
      // An answer for an ended binding is dropped: it is never recorded in another database (R17).
      if (!owns(at)) return end(lost(at));
      if (read.answer.kind === "ok" && read.zone !== null) {
        // Found: the discovery's failures are over (its entry goes, only its own); a page's memory stop of it is lifted by its success.
        const done = await record(captured, null);
        if (done === "lost") return end(lost(at));
        if (done === "stale") return end(DONE);
        if (done !== "written") return end(PAUSED);
        if (state.unrecorded.has(item.taskId)) unrecord(item.taskId);
        return { kind: "ok", read, captured };
      }
      const base = entry ?? NO_DISCOVERY;
      const failures =
        read.answer.kind === "uncertain" ? base.failures + 1 : base.failures;
      const stop: Omit<UnrecordedStop, "id"> | null =
        read.answer.kind !== "uncertain"
          ? {
              reason: "rejected",
              ...(read.answer.kind === "rejected" && read.answer.requestId
                ? {
                    requestId: read.answer.requestId.slice(
                      0,
                      DISCOVERY_REQUEST_ID,
                    ),
                  }
                : {}),
            }
          : failures >= MAX_READ_FAILURES
            ? { reason: "unreachable" }
            : null;
      const written = await record(captured, {
        retry: base.retry,
        failures,
        stop:
          stop === null
            ? null
            : {
                reason: stop.reason as "unreachable" | "rejected",
                ...(stop.requestId ? { request_id: stop.requestId } : {}),
              },
        // Recorded with its answer: the next read's claim (none after a stop).
        attempt: stop === null ? deps.newId() : (base.attempt ?? null),
      });
      if (written === "lost") return end(lost(at));
      if (written === "stale") return end(DONE);
      if (written !== "written")
        return end(
          stopInMemory(item.taskId, stop ?? { reason: "unreachable" }),
        );
      if (stop !== null) {
        set({ stops: state.stops + 1 });
        return end(DONE);
      }
      await sleep(RETRY_DELAYS_MS[failures - 1] as number);
      if (!owns(at)) return end(lost(at));
      if (!mayRun()) return end(PAUSED);
    }
  };

  /** Finds or begins the sequence of one task through its day, then drives it, under the binding it began with. */
  const work = async (item: Item): Promise<Outcome> => {
    const service = alive();
    if (service === null) return PAUSED;
    rebind(service);
    const at: Binding = { service };
    // A press made under another binding lifts nothing here: the work is asked as the person asked it, and a stop still standing shows.
    if (
      item.retry !== undefined &&
      item.retry.service === service &&
      !(await lift(at, { ...item, retry: item.retry }))
    )
      return owns(at) ? DONE : lost(at);
    if (!owns(at)) return lost(at);
    const found = await discover(at, item);
    if (found.kind === "end") return found.outcome;
    const { read, captured } = found;
    if (!owns(at)) return lost(at);
    if (read.answer.kind !== "ok" || read.zone === null) return PAUSED;
    const zone = read.zone;
    zoneFound(item.taskId, zone);
    const today = () => todayIn(zone, deps.now());
    const throughDate = item.throughDate ?? today();
    // Its today found (revision 6, R29): the work is that day's from here, so the same day asked meanwhile is not asked twice.
    currentKey = workKey({ taskId: item.taskId, throughDate });
    // What the position read covers of the task's OTHER days is satisfied (revision 5): those rows go, a stopped one included. This day's
    // own row is decided by its sequence below, as before (adopted, resent with its own key, or read).
    await clearSatisfied(
      at,
      captured,
      item.taskId,
      read.answer.position,
      today(),
      throughDate,
    );
    if (!owns(at)) return lost(at);
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
      return await sequence(at, item, read.answer, {
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

  /** The sequence of one task through its day: adopted as stored, or begun (stamped with the read that found its day); then driven. */
  const sequence = async (
    at: Binding,
    item: Item,
    answer: Extract<ReadAnswer, { kind: "ok" }>,
    day: {
      key: SequenceKey;
      throughDate: string;
      today: () => string;
      captured: ReturnType<AccountService["capture"]>;
      paused: Outcome;
    },
  ): Promise<Outcome> => {
    const { key, throughDate, today, captured, paused } = day;
    const service = at.service;
    const stored = await readMaterialiseSequenceNow(service, key);
    if (!owns(at)) return lost(at);
    if (stored === undefined) return paused;
    if (stored !== null) {
      // Adopted: a sequence another page began, or one this page left on a reload. A stop is shown, never resumed automatically.
      if (stored.phase === "stopped") return DONE;
      if (stored.phase === "awaiting_position_read") {
        // Its call was answered before this page held the lock, so the read just made was asked after it: it is the sequence's position
        // read (one read, never another `materialise`; CM-440), admitted only over the row as found.
        const next = onRead(stored, answer, today());
        const out = await commit(service, captured, key, stored, next);
        if (out === null) return owns(at) ? paused : lost(at);
        if (out.stored === null) {
          if (next === null)
            await clearSatisfied(
              at,
              captured,
              key.task_id,
              answer.position,
              today(),
              key.through_date,
            );
          set({ finished: state.finished + 1 });
          return DONE;
        }
        return keyed(await drive(at, out.stored, today), throughDate);
      }
      return keyed(await drive(at, stored, today), throughDate);
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
    // A new row grows the store: admitted first (revision 5). Earlier days are NOT removed because this one begins (review R25): each
    // stays, with its attempt, until a read shows its own day covered.
    const created = await create(service, captured, key, fresh);
    if (created === "refused")
      return owns(at)
        ? stopInMemory(item.taskId, {
            reason: "storage",
            throughDate: key.through_date,
          })
        : lost(at);
    if (created === null) return owns(at) ? paused : lost(at);
    if (created.stored === null) return DONE;
    if (created.stored.phase === "stopped") {
      set({ stops: state.stops + 1 });
      return DONE;
    }
    return keyed(await drive(at, created.stored, today), throughDate);
  };

  const loop = async (): Promise<void> => {
    while (queue.length > 0 && mayRun()) {
      const item = queue.shift() as Item;
      currentKey = workKey(item);
      publishQueue(item.taskId);
      let outcome: Outcome;
      try {
        outcome = await work(item);
      } catch {
        // A thrown read or store: the work did not end, so it is kept as a pause (its record says where it stands).
        outcome = PAUSED;
      }
      if (outcome.kind === "paused") park(item, outcome.throughDate);
      // Its binding ended: the task is asked again under the one displayed now, as plain work (R17); once in a row, then it waits
      // for the next kick (a binding that keeps changing must not spin this loop).
      else if (outcome.kind === "ended" && !disposed) {
        const again: Item = {
          taskId: item.taskId,
          trigger: item.trigger,
          manual: false,
          rebound: true,
          ...(item.throughDate === undefined
            ? {}
            : { throughDate: item.throughDate }),
        };
        if (item.rebound) parked.set(workKey(item), again);
        else queue.unshift(again);
      }
      currentKey = null;
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

  /** Queues the task's day as asked (its today when `throughDate` is absent), unless it is already asked, handled or refused here. */
  const admit = (
    taskId: string,
    trigger: Trigger,
    throughDate: string | undefined,
  ): boolean => {
    // The same task and day is queued or worked on already (another day of the task is other work: revision 5, R24/R25).
    if (pending(workKey({ taskId, throughDate }))) return false;
    // A discovery stop this page could not record admits nothing automatic either (a recorded one is refused where the work begins).
    if (state.unrecorded.has(taskId)) return false;
    // Brought up to date (or found stopped) through this task's today already on this page: nothing to ask again.
    const known = settledThrough.get(taskId);
    if (
      throughDate === undefined &&
      known !== undefined &&
      todayIn(known.zone, deps.now()) === known.day
    )
      return false;
    if (throughDate !== undefined && attempted.has(`${taskId}|${throughDate}`))
      return false;
    queue.push({
      taskId,
      trigger,
      ...(throughDate ? { throughDate } : {}),
      manual: false,
    });
    return true;
  };

  return {
    identity: deps.identity,
    ensure(taskId, trigger, options = {}) {
      if (disposed) return;
      rebind(alive());
      if (options.throughDate !== undefined)
        noteAsked(taskId, options.throughDate);
      // Work on this task that paused part-way is taken up again (review R1), whichever trigger asks; then the day asked for is admitted
      // ON ITS OWN (revision 6, review R29): resuming another day's work never stands in for it, and the same day is not asked twice.
      const resumed = unpark(taskId);
      const admitted = admit(taskId, trigger, options.throughDate);
      if (!resumed && !admitted) return;
      publishQueue();
      pump();
    },
    tryAgain(taskId, throughDate, seen) {
      if (disposed) return;
      void (async () => {
        // What the person pressed it on, as stored now: lifted under the lock only if it still stands so (review R13), and only if it
        // is the stop the screen showed (review R20).
        const service = alive();
        rebind(service);
        // The day pressed on: the record's own, else the day of a row this page could not admit (revision 6, R29), else the day last
        // worked here.
        const day =
          throughDate ??
          state.unrecorded.get(taskId)?.throughDate ??
          settledThrough.get(taskId)?.day;
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
          if (seen !== undefined) {
            const shown = pressedOn(
              seen,
              discovery,
              sequence,
              state.unrecorded.get(taskId),
            );
            if (shown === null) return;
            ({ discovery, sequence } = shown);
          }
        } else if (
          seen !== undefined &&
          seen.kind === "memory" &&
          state.unrecorded.get(taskId)?.id !== seen.id
        )
          return;
        if (disposed) return;
        // The person's act supersedes paused work on the task and THAT day (revision 6, R29: exactly that day; another day's paused
        // work, or an implicit today not resolved yet, is other work and stays): it is asked for again, once.
        const pressed = workKey({ taskId, throughDate: day });
        for (const [key, p] of parked)
          if (workKey(p) === pressed) parked.delete(key);
        const retry = { discovery, sequence, service };
        const queued = queue.find((q) => workKey(q) === pressed);
        if (queued !== undefined) {
          queued.manual = true;
          queued.retry = retry;
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
      rebind(alive());
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
