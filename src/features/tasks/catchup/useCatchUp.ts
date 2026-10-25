import { useEffect, useSyncExternalStore } from "react";
import {
  type ConflictHandlerRegistry,
  type DataEnv,
  getPageDataHost,
  type Loadable,
  type MaterialiseSequenceRow,
  useDataEnv,
  useMaterialiseSequences,
} from "../../../data";
import type { TasksApi } from "../api";
import { type TasksEnv, useTasksEnv } from "../env";
import { commandOf, QUEUED_KINDS } from "../model/commands";
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

export interface CatchUp {
  runner: CatchUpRunner;
  state: RunnerState;
  /** The durable sequences of the account (every page's), live. */
  records: Loadable<MaterialiseSequenceRow[]>;
}

export function useCatchUp(): CatchUp {
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
  const state = useSyncExternalStore(runner.subscribe, runner.get, runner.get);
  const records = useMaterialiseSequences(null);
  return { runner, state, records };
}

/** The task a draft's command names directly, or null (an occurrence-level command names no task). */
function taskOfDraft(
  draft: Parameters<
    Parameters<ConflictHandlerRegistry["register"]>[1]
  >[0]["draft"],
): string | null {
  const command = commandOf(draft);
  if (command === null) return null;
  if (typeof command.task_id === "string") return command.task_id;
  if (
    (command.kind === "revise_task" || command.kind === "archive") &&
    typeof command.id === "string"
  )
    return command.id;
  return null;
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
 * task command refused because its task must be caught up first is RETRIED with its own key under the dispatcher's back-off, and the
 * page's runner is asked to catch the task up (through the day the command names, when it names one). Any other draft, or one whose task
 * cannot be read from its command, keeps the generic rule. Registered once per registry.
 */
export function registerCatchUpConflicts(
  registry: ConflictHandlerRegistry,
): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register("materialisation_required", ({ draft }) => {
    if (!TASK_KINDS.has(draft.kind)) return { kind: "default" };
    const taskId = taskOfDraft(draft);
    if (taskId === null) return { kind: "default" };
    const command = commandOf(draft);
    const day = command?.through_date;
    runnerForAccount(draft.account_id)?.ensure(
      taskId,
      "draft",
      isContractDate(day) ? { throughDate: day } : {},
    );
    return { kind: "reclassify", as: "retry" };
  });
}
