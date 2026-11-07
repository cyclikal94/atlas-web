/**
 * The messages between pages and the service worker, and between the pages of one origin (WEB-14a). Closed unions, checked on receipt:
 * anything else is ignored. Shared by the page (`coordinator.ts`) and the worker (`src/sw.ts`), so it imports nothing.
 *
 * Page to worker (posted to the worker, with a MessagePort for the answer):
 *  - `atlas:report`: "this page runs the build whose entry script is `entry`". The worker records it (one record per client) and only then
 *    answers `atlas:report-ack` on the port, with the page's generation (null: the worker does not know that entry), the generation it
 *    serves now, and whether that one was installed after the page's. Generations a page still runs are kept (live-generation retention).
 *  - `atlas:skip-waiting`: posted to the WAITING worker only, by the tab whose person accepted the update.
 *
 * Page to page (`BroadcastChannel` "atlas-app-update"):
 *  - `flush-request`: a tab is about to apply an update; every other tab saves its unfinished forms (a copy, never a submission or a
 *    reload) and answers `flush-started` at once and `flush-done` when its saves have finished.
 *  - `update-available`: a tab saw a newer version installed; the others look at their registration.
 */
export const UPDATE_CHANNEL = "atlas-app-update";

export type ToWorker =
  | { type: "atlas:report"; entry: string; nonce: string }
  | { type: "atlas:skip-waiting" };

export interface ReportAck {
  type: "atlas:report-ack";
  nonce: string;
  /** The generation whose files include the page's entry, or null. */
  generation: string | null;
  /** The generation of the worker that answered (the active one). */
  active: string;
  /** The active generation was installed after the page's. False when the page's is unknown or is the active one. */
  newer: boolean;
}

export type UpdateChannelMessage =
  | { type: "flush-request"; id: string }
  | { type: "flush-started"; id: string; dirty: number }
  | { type: "flush-done"; id: string; failed: number }
  | { type: "update-available" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2048;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parseToWorker(value: unknown): ToWorker | null {
  if (!isRecord(value)) return null;
  if (value.type === "atlas:skip-waiting")
    return { type: "atlas:skip-waiting" };
  if (
    value.type === "atlas:report" &&
    isString(value.entry) &&
    isString(value.nonce)
  )
    return { type: "atlas:report", entry: value.entry, nonce: value.nonce };
  return null;
}

export function parseReportAck(value: unknown): ReportAck | null {
  if (!isRecord(value) || value.type !== "atlas:report-ack") return null;
  if (!isString(value.nonce) || !isString(value.active)) return null;
  if (value.generation !== null && !isString(value.generation)) return null;
  if (typeof value.newer !== "boolean") return null;
  return {
    type: "atlas:report-ack",
    nonce: value.nonce,
    generation: value.generation,
    active: value.active,
    newer: value.newer,
  };
}

export function parseChannelMessage(
  value: unknown,
): UpdateChannelMessage | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "update-available":
      return { type: "update-available" };
    case "flush-request":
      return isString(value.id)
        ? { type: "flush-request", id: value.id }
        : null;
    case "flush-started":
      return isString(value.id) && isCount(value.dirty)
        ? { type: "flush-started", id: value.id, dirty: value.dirty }
        : null;
    case "flush-done":
      return isString(value.id) && isCount(value.failed)
        ? { type: "flush-done", id: value.id, failed: value.failed }
        : null;
    default:
      return null;
  }
}
