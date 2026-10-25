import type { CalendarBinding, TasksApi } from "../api";
import { forgetRefusal, noteIfRefused, refusalOf } from "../memory";

/**
 * The task's calendar binding as THIS VISIT read it (WEB-13b §4.4, D-13b-9; the WEB-13a R11 lesson): page memory, per displayed identity,
 * per visit of the task's screen (`visit.ts`) and task. A remount under the same identity and visit (the session's re-check of a `403`, a
 * router made again, Strict Mode) finds the read already made, answered or under way, and asks nothing more. A refusal is recorded when
 * the ANSWER ARRIVES (`noteIfRefused`), whatever became of the screen that asked. A read that was never sent (offline, `not_sent`, closed
 * at its cover) leaves nothing, so a later mount may read. Only the displayed identity's reads, and only its newest visit's, are kept.
 *
 * A read is the visit's (R6): `live` (the visit going on) is asked before EVERY admission of the request, the first included and each
 * one after a `not_sent` wait, so a read never sent while the person was on the task is never sent once they have left it. What was
 * already sent is still answered and recorded (a refusal is the identity's, whatever became of the visit).
 */
export type BindingRead =
  | { kind: "reading" }
  | { kind: "read"; binding: CalendarBinding | null }
  /** Uncertain, refused, or not the contract's answer: "Couldn't load the anchor", with Try again. */
  | { kind: "failed" };

interface Memory {
  identity: string;
  /** By `<visit>:<task>`. */
  reads: Map<string, { read: BindingRead; token: number }>;
  /** The `set_anchor` drafts whose receipt has already caused a read again (once each). */
  reread: Set<string>;
}

let memory: Memory | null = null;
let tokens = 0;
const listeners = new Set<() => void>();
const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

function memoryOf(identity: string): Memory {
  if (memory === null || memory.identity !== identity)
    memory = { identity, reads: new Map(), reread: new Set() };
  return memory;
}

/** The read key of the anchor in the task slice's refusal memory. */
export const anchorReadKey = (taskId: string): string => `anchor:${taskId}`;

export function subscribeBinding(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bindingOf(
  identity: string,
  key: string,
): BindingRead | undefined {
  return memoryOf(identity).reads.get(key)?.read;
}

/**
 * Reads the binding for `key` unless this visit already has (answered, failed or under way) or the identity's read of it was refused. Only
 * the newest visit's reads are kept: a key of another visit drops the older ones (`visit` is the key's prefix).
 */
export function readBinding(
  identity: string,
  visit: string,
  taskId: string,
  api: Pick<TasksApi, "readAnchor">,
  live: () => boolean,
): void {
  const own = memoryOf(identity);
  const key = `${visit}:${taskId}`;
  if (own.reads.has(key) || !live()) return;
  for (const held of [...own.reads.keys()])
    if (!held.startsWith(`${visit}:`)) own.reads.delete(held);
  if (refusalOf(identity, anchorReadKey(taskId)) !== null) {
    own.reads.set(key, { read: { kind: "failed" }, token: 0 });
    notify();
    return;
  }
  tokens += 1;
  const token = tokens;
  own.reads.set(key, { read: { kind: "reading" }, token });
  notify();
  void api.readAnchor(taskId, live).then((result) => {
    noteIfRefused(identity, anchorReadKey(taskId), result);
    const now = memory;
    if (now === null || now.identity !== identity) return;
    if (now.reads.get(key)?.token !== token) return;
    if (result.ok)
      now.reads.set(key, {
        read: { kind: "read", binding: result.value.binding },
        token,
      });
    else if (
      result.kind === "not_sent" ||
      result.kind === "offline" ||
      result.kind === "closed"
    )
      // Never sent (or closed with the display): nothing was learned, so a later mount of this visit may read.
      now.reads.delete(key);
    else now.reads.set(key, { read: { kind: "failed" }, token });
    notify();
  });
}

/** "Try again", or the receipt of an anchor change: the person (or their own change) asks for the read again, once. */
export function readBindingAgain(
  identity: string,
  visit: string,
  taskId: string,
  api: Pick<TasksApi, "readAnchor">,
  live: () => boolean,
): void {
  if (!live()) return;
  forgetRefusal(identity, anchorReadKey(taskId));
  memoryOf(identity).reads.delete(`${visit}:${taskId}`);
  readBinding(identity, visit, taskId, api, live);
}

/** Whether a receipted `set_anchor` draft has caused its read again already; marks it when not. */
export function firstReceipt(identity: string, localId: string): boolean {
  const own = memoryOf(identity);
  if (own.reread.has(localId)) return false;
  own.reread.add(localId);
  if (own.reread.size > 64) {
    const oldest = own.reread.values().next().value;
    if (oldest !== undefined) own.reread.delete(oldest);
  }
  return true;
}

/** Tests only. */
export function forgetBindings(): void {
  memory = null;
}
