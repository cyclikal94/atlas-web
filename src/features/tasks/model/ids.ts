import type { Schedule } from "./contract";

/**
 * The deterministic identities of the pinned contract (`crates/core/src/tasks/service.rs`, `docs/tasks.md`), so offline work can name an
 * occurrence and a progress stream before the server has made them:
 *
 *  - occurrence = UUIDv5(namespace = the TASK's UUID, "atlas-occurrence-v1:" + slot key);
 *  - progress   = UUIDv5(namespace = the OCCURRENCE's UUID, "atlas-progress-v1:" + account id).
 *
 * UUIDv5 is SHA-1 (RFC 9562 §5.5) through `crypto.subtle`, so it is asynchronous: the ids are computed BEFORE a command is enqueued, and a
 * command's `build` stays pure. Never used for anything secret.
 */
const HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function bytesOf(uuid: string): Uint8Array {
  if (!HEX.test(uuid)) throw new TypeError("not a lower-case UUID");
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1)
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function format(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function uuidV5(namespace: string, name: string): Promise<string> {
  const ns = bytesOf(namespace);
  const text = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + text.length);
  input.set(ns, 0);
  input.set(text, ns.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const out = digest.slice(0, 16);
  out[6] = ((out[6] as number) & 0x0f) | 0x50;
  out[8] = ((out[8] as number) & 0x3f) | 0x80;
  return format(out);
}

export const occurrenceId = (
  taskId: string,
  slotKey: string,
): Promise<string> => uuidV5(taskId, `atlas-occurrence-v1:${slotKey}`);

export const progressId = (
  occurrence: string,
  accountId: string,
): Promise<string> => uuidV5(occurrence, `atlas-progress-v1:${accountId}`);

/**
 * The slot key of a schedule's slot on `date` (`schedule.rs`): `once` for any schedule without `repeat` (a dated one-off, an undated inbox
 * item, and the FIRST slot of an after-completion task, which the server expands as a one-off); otherwise `YYYY-MM-DDTHH:MM:SS`, or
 * `YYYY-MM-DDTdate` for a date-only schedule.
 */
export function slotKey(schedule: Schedule, date: string | null): string {
  if (
    schedule.repeat === null ||
    schedule.repeat.frequency === "after_completion" ||
    date === null
  )
    return "once";
  return `${date}T${schedule.time ?? "date"}`;
}
