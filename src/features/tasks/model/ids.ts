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

/** SHA-1 (FIPS 180-4) of `input`, computed synchronously: the same digest `crypto.subtle` gives, for a name a pure function must derive. */
function sha1(input: Uint8Array): Uint8Array {
  const length = input.length;
  const blocks = Math.ceil((length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(input);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let block = 0; block < blocks; block += 1) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block * 64 + i * 4);
    for (let i = 16; i < 80; i += 1)
      w[i] = rotl(
        (w[i - 3] as number) ^
          (w[i - 8] as number) ^
          (w[i - 14] as number) ^
          (w[i - 16] as number),
        1,
      );
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      const [f, k] =
        i < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : i < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : i < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + (w[i] as number)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const result = new DataView(out.buffer);
  for (const [i, h] of [h0, h1, h2, h3, h4].entries())
    result.setUint32(i * 4, h);
  return out;
}

/** UUIDv5 computed synchronously (the same id as `uuidV5`), or null when `namespace` is not a lower-case UUID. */
export function uuidV5Sync(namespace: string, name: string): string | null {
  if (!HEX.test(namespace)) return null;
  const ns = bytesOf(namespace);
  const text = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + text.length);
  input.set(ns, 0);
  input.set(text, ns.length);
  const out = sha1(input).slice(0, 16);
  out[6] = ((out[6] as number) & 0x0f) | 0x50;
  out[8] = ((out[8] as number) & 0x3f) | 0x80;
  return format(out);
}

/**
 * The entry a `complete_dependencies` records on `actor`'s stream of `occurrence` (`crates/core/src/tasks/service/dependencies.rs`):
 * UUIDv5(namespace = the OPERATION's key, which is the draft's `local_id`, "dependency-completion:" + occurrence + ":" + actor). Null for
 * a key that is not a UUID (the server would refuse it).
 */
export const completionEntryId = (
  operation: string,
  occurrence: string,
  actor: string,
): string | null =>
  uuidV5Sync(operation, `dependency-completion:${occurrence}:${actor}`);

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
