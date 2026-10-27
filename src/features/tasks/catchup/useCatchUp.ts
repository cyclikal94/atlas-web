import { useEffect, useSyncExternalStore } from "react";
import {
  type ConflictHandlerRegistry,
  type DataEnv,
  getPageDataHost,
  type Loadable,
  type MaterialiseDiscovery,
  type MaterialiseSequenceRow,
  readResourcesNow,
  useDataEnv,
  useMaterialiseDiscovery,
  useMaterialiseSequences,
} from "../../../data";
import type { TasksApi } from "../api";
import { type TasksEnv, useTasksEnv } from "../env";
import { commandOf, QUEUED_KINDS } from "../model/commands";
import { parseOccurrenceData } from "../model/contract";
import { isContractDate } from "../model/primitives";
import {
  type CatchUpRunner,
  createCatchUpRunner,
  type RunnerState,
} from "./runner";

/**
 * The page's catch-up runner for the DISPLAYED identity (page memory: one at a time; another identity disposes the old one, so nothing it
 * does afterwards reaches the new one). It is keyed by the identity alone: the data controller, connectivity and compatibility it reads
 * are the latest any task screen rendered (`held`), so two trees of one identity share one runner instead of replacing each other. Its
 * disposal and kicks run after the render that asked for them, never inside it.
 */
interface Held {
  runner: CatchUpRunner;
  data: DataEnv;
  online: boolean;
  writable: boolean;
  env: TasksEnv;
}
let held: Held | null = null;

export function runnerOf(env: TasksEnv, data: DataEnv): CatchUpRunner {
  if (held !== null && held.runner.identity === env.identity) {
    const changed =
      held.online !== env.online ||
      held.writable !== env.writable ||
      held.data !== data;
    held.data = data;
    held.online = env.online;
    held.writable = env.writable;
    held.env = env;
    if (changed) {
      const runner = held.runner;
      queueMicrotask(() => runner.kick());
    }
    return held.runner;
  }
  const previous = held?.runner;
  if (previous) queueMicrotask(() => previous.dispose());
  const epoch = Number(env.identity.slice(env.identity.lastIndexOf(":") + 1));
  const mine = (): Held | null => (held?.runner === runner ? held : null);
  // The client of the latest render of this identity (a remounted tree builds another one for the same account and epoch).
  const api = () => mine()?.env.api ?? env.api;
  const runner: CatchUpRunner = createCatchUpRunner({
    api: {
      readTask: (id) => api().readTask(id),
      materialise: (command, key) => api().materialise(command, key),
    } as Pick<TasksApi, "readTask" | "materialise"> as TasksApi,
    identity: env.identity,
    accountId: env.accountId,
    epoch: Number.isSafeInteger(epoch) ? epoch : 0,
    service: () => mine()?.data.service() ?? null,
    // A new task's discovery record is admitted through the origin's quota ledger before its first read (revision 3, R16).
    quota: () => mine()?.data.quota ?? null,
    online: () => mine()?.online ?? false,
    writable: () => mine()?.writable ?? false,
    now: () => mine()?.env.now() ?? Date.now(),
    newId: () => env.newId(),
  });
  held = { runner, data, online: env.online, writable: env.writable, env };
  return runner;
}

/** Forgets the page's runner and what it did (tests: a fresh page). */
export function forgetCatchUp(): void {
  const previous = held?.runner;
  held = null;
  previous?.dispose();
}

/** The page's runner, if one is held for `account` (the conflict handler's lookup). */
export const runnerForAccount = (account: string): CatchUpRunner | null =>
  held?.runner.identity.startsWith(`${account}:`) ? held.runner : null;

const NONE: Readonly<Record<string, MaterialiseDiscovery>> = {};

export interface CatchUp {
  runner: CatchUpRunner;
  state: RunnerState;
  /** The durable sequences of the account (every page's), live. */
  records: Loadable<MaterialiseSequenceRow[]>;
  /** The account's failed discoveries by task (every page's; review R13), live; empty until read (`discoveryRead` false). */
  discovery: Readonly<Record<string, MaterialiseDiscovery>>;
  discoveryRead: boolean;
}

/**
 * The page's catch-up SERVICE for the displayed identity, held by every task screen (review R8): Today and the streak, and also the
 * list, a task's detail, the editors and the account's timers, so a task command refused with `materialisation_required` finds a live
 * runner bound to the current connectivity, compatibility and database whichever task screen the person opened. It registers the command
 * path's handler with the page's registry and lets work wait for the database's binding.
 */
export function useCatchUpService(): CatchUpRunner {
  const env = useTasksEnv();
  const data = useDataEnv();
  const runner = runnerOf(env, data);
  useEffect(() => {
    registerCatchUpConflicts(getPageDataHost().conflicts);
  }, []);
  // Work asked for before the account's database was bound waits in the queue; the binding lets it run.
  useEffect(
    () => data.serviceStore.subscribe(() => runner.kick()),
    [data, runner],
  );
  return runner;
}

export function useCatchUp(): CatchUp {
  const runner = useCatchUpService();
  const state = useSyncExternalStore(runner.subscribe, runner.get, runner.get);
  const records = useMaterialiseSequences(null);
  const found = useMaterialiseDiscovery();
  const discovery = found.status === "ready" ? found.value : NONE;
  return {
    runner,
    state,
    records,
    discovery,
    discoveryRead: found.status === "ready",
  };
}

type Draft = Parameters<
  Parameters<ConflictHandlerRegistry["register"]>[1]
>[0]["draft"];

/**
 * What a blocked task command needs caught up (WEB-04 §5.8, input derivation): the task it names, through the day it names (else today in
 * the task's zone), or, for a command on one day (`occurrence_id`), that day's task through that day's own date, which this device holds
 * in its cache. Null: not a task command this handler can derive from.
 */
type Target =
  | { kind: "task"; taskId: string; throughDate?: string }
  | { kind: "occurrence"; occurrenceId: string };
function targetOfDraft(draft: Draft): Target | null {
  const command = commandOf(draft);
  if (command === null) return null;
  const day = command.through_date;
  const through = isContractDate(day) ? { throughDate: day } : {};
  if (typeof command.task_id === "string")
    return { kind: "task", taskId: command.task_id, ...through };
  if (
    (command.kind === "revise_task" || command.kind === "archive") &&
    typeof command.id === "string"
  )
    return { kind: "task", taskId: command.id, ...through };
  if (typeof command.occurrence_id === "string")
    return { kind: "occurrence", occurrenceId: command.occurrence_id };
  return null;
}

/**
 * Asks `runner` to catch up what `target` needs. A day's task and date come from this device's cache (the occurrence row): a day the
 * cache does not hold cannot be derived here, and the command is retried under the back-off as before, with nothing asked.
 */
async function catchUpFor(runner: CatchUpRunner, target: Target) {
  if (target.kind === "task") {
    runner.ensure(
      target.taskId,
      "draft",
      target.throughDate === undefined
        ? {}
        : { throughDate: target.throughDate },
    );
    return;
  }
  const data = held?.runner === runner ? held.data : null;
  if (data === null) return;
  const rows = await readResourcesNow(data, [target.occurrenceId]);
  const row = rows?.get(target.occurrenceId)?.merged ?? null;
  const day = row ? parseOccurrenceData(row.value) : null;
  if (day === null || held?.runner !== runner) return;
  runner.ensure(
    day.task_id,
    "draft",
    day.slot.date === null ? {} : { throughDate: day.slot.date },
  );
}

const TASK_KINDS = new Set<string>([
  ...QUEUED_KINDS,
  "set_dependencies",
  "complete_dependencies",
  "start_timer",
  "stop_timer",
  "cancel_timer",
]);
const registered = new WeakSet<ConflictHandlerRegistry>();

/**
 * The command path (CM-432; fixture-only: the released backend raises `materialisation_required` on no command, §0.1 item 7). A queued
 * task command refused because its task must be caught up first is RETRIED with its own key under the dispatcher's back-off (at most a
 * minute), and the page's catch-up service is asked to catch up what it needs (`targetOfDraft`: the task it names through the day it
 * names, or a day's own task through that day's date). The resend follows the sequence: before it completes the command is refused again
 * and asked again, which the runner absorbs (one sequence per task and day); after it completes the SAME key is sent and applied. A stop
 * is never restarted by a resend: it is shown with its reason and "Try again" (Today's banner, the task's detail), and the command is
 * kept, retried, until the person's "Try again" completes the catch-up or they discard it. Any other draft, or one whose need cannot be
 * derived, keeps the generic rule. Registered once per registry.
 */
export function registerCatchUpConflicts(
  registry: ConflictHandlerRegistry,
): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register("materialisation_required", ({ draft }) => {
    if (!TASK_KINDS.has(draft.kind)) return { kind: "default" };
    const target = targetOfDraft(draft);
    if (target === null) return { kind: "default" };
    const runner = runnerForAccount(draft.account_id);
    // No task screen has held a catch-up service for this account on this page: nothing can be asked (the generic rule retries it).
    if (runner === null) return { kind: "default" };
    void catchUpFor(runner, target);
    return { kind: "reclassify", as: "retry" };
  });
}
