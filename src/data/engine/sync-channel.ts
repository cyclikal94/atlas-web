import type { AccountId } from "../model/types";

/**
 * The data layer's own cross-tab channel, `atlas-sync` (plan 5.3.3, 5.4.2). It carries a CLOSED union of messages, none of
 * which holds any content: an account id, an operation id, a tab id, a nonce, and the names of stores that changed. A message
 * is a HINT, never evidence: a receiver re-reads its own database and acts on that. A missing channel makes the layer a no-op,
 * and the digest recheck at wipe time is the safety net (docs/data-layer.md).
 *
 * It is separate from the session's `atlas-auth-hints` channel: the session's hints are about `auth_state`; these are about the
 * account databases.
 */
export const SYNC_CHANNEL = "atlas-sync";

export type SyncMessage =
  /** A wipe of the account is about to delete its database: close every connection, refuse recovery writes, acknowledge. */
  | { type: "wipe_imminent"; account: AccountId; operation_id: string }
  | { type: "closed_ack"; account: AccountId; tab_id: string }
  | { type: "presence_query"; account: AccountId; nonce: string }
  | { type: "presence"; account: AccountId; tab_id: string; nonce: string }
  /** A page committed to these stores of the account; followers refresh their live views (never the authority). */
  | { type: "data_changed"; account: AccountId; stores: readonly string[] }
  /**
   * WEB-09b (R2 of the review of 10 October 2026): a person pressed "Try again" / "Retry now" / "Retry applying changes" for UPDATES on a
   * page that does not lead (a follower's notice, or any page's neutral state 3). The leading page applies its own retry when the account
   * and the epoch are the ones it is bound to; the acts it makes are versioned on the failure that stands, as its own page's are.
   */
  | { type: "retry_requested"; account: AccountId; epoch: number }
  /**
   * WEB-08c revision 3 (R5, T24 D, design assessment S9): the leading page's recovery job reported "Catching up" (state 2), "Couldn't
   * finish catching up" (state 3) or nothing for the account at that epoch. Another page shows the same neutral card from it; it never
   * changes what may be displayed (the record and the exposure protocol decide that).
   */
  | {
      type: "recovery_state";
      account: AccountId;
      epoch: number;
      phase: RecoveryPhase;
    }
  /** A page that does not lead asks the leading page for its standing recovery report (it started, or its identity changed). */
  | { type: "recovery_state_query"; account: AccountId; epoch: number };

/** The recovery job's report as the channel carries it: `none` is no report (the card is not the recovery's). */
export type RecoveryPhase = "catching_up" | "failed" | "none";

/**
 * The store a `data_changed` hint names when a page RECORDS a stop of a local write (a durable failure streak reaching its bound) or ENDS
 * a durable failure it saw (R60, revision 37): the streaks live in `sync_state`. Another page's outbox reads its records on it whatever it
 * shows, because a page that was healthy when it last read cannot know otherwise that a stop has been recorded since. It is a hint like
 * any other: the receiver re-reads its own database, and a hint that is lost leaves only what the receiver's next read finds.
 */
export const LOCAL_WRITE_STOPS_STORE = "sync_state";

export interface SyncChannel {
  post(message: SyncMessage): void;
  subscribe(listener: (message: SyncMessage) => void): () => void;
}

const str = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length < 200;

const epochOk = (v: unknown): boolean =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Validates an incoming message against the closed union; anything else is ignored. */
export function parseSyncMessage(value: unknown): SyncMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case "wipe_imminent":
      return str(m.account) && str(m.operation_id)
        ? {
            type: "wipe_imminent",
            account: m.account,
            operation_id: m.operation_id,
          }
        : null;
    case "closed_ack":
      return str(m.account) && str(m.tab_id)
        ? { type: "closed_ack", account: m.account, tab_id: m.tab_id }
        : null;
    case "presence_query":
      return str(m.account) && str(m.nonce)
        ? { type: "presence_query", account: m.account, nonce: m.nonce }
        : null;
    case "presence":
      return str(m.account) && str(m.tab_id) && str(m.nonce)
        ? {
            type: "presence",
            account: m.account,
            tab_id: m.tab_id,
            nonce: m.nonce,
          }
        : null;
    case "recovery_state":
      return str(m.account) &&
        epochOk(m.epoch) &&
        (m.phase === "catching_up" ||
          m.phase === "failed" ||
          m.phase === "none")
        ? {
            type: "recovery_state",
            account: m.account,
            epoch: m.epoch as number,
            phase: m.phase,
          }
        : null;
    case "recovery_state_query":
      return str(m.account) && epochOk(m.epoch)
        ? {
            type: "recovery_state_query",
            account: m.account,
            epoch: m.epoch as number,
          }
        : null;
    case "retry_requested":
      return str(m.account) &&
        typeof m.epoch === "number" &&
        Number.isSafeInteger(m.epoch) &&
        m.epoch >= 0
        ? { type: "retry_requested", account: m.account, epoch: m.epoch }
        : null;
    case "data_changed":
      return str(m.account) &&
        Array.isArray(m.stores) &&
        m.stores.length <= 16 &&
        m.stores.every(str)
        ? {
            type: "data_changed",
            account: m.account,
            stores: m.stores as string[],
          }
        : null;
    default:
      return null;
  }
}

/** A channel the page opened and may close again (R29): the browser composition and a provider that stops release it. */
export interface ClosableSyncChannel extends SyncChannel {
  /** Closes the browser channel (idempotent). The next `post` or `subscribe` opens a new one. */
  close(): void;
}

/**
 * The browser channel. A page does not receive its own message (BroadcastChannel semantics).
 *
 * It is OPENED LAZILY, by the first `post` or `subscribe`, and `close()` closes it (R29). Constructing one therefore holds nothing: a
 * construction React discards, or one whose owner never starts, leaves no open channel behind, and an owner that stops can let it go.
 */
export function createBroadcastSyncChannel(
  factory: typeof BroadcastChannel | undefined = typeof BroadcastChannel ===
  "undefined"
    ? undefined
    : BroadcastChannel,
): ClosableSyncChannel {
  let channel: BroadcastChannel | null = null;
  const listeners = new Set<(message: SyncMessage) => void>();
  const open = (): BroadcastChannel | null => {
    if (channel !== null || !factory) return channel;
    try {
      const opened = new factory(SYNC_CHANNEL);
      opened.onmessage = (event: MessageEvent) => {
        const message = parseSyncMessage(event.data);
        if (!message) return;
        for (const listener of [...listeners]) listener(message);
      };
      channel = opened;
    } catch {
      channel = null;
    }
    return channel;
  };
  return {
    post(message) {
      try {
        open()?.postMessage(message);
      } catch {
        // A hint that cannot be posted is a hint that is not sent.
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      open();
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      const closing = channel;
      channel = null;
      if (closing === null) return;
      closing.onmessage = null;
      try {
        closing.close();
      } catch {
        // Already closed.
      }
    },
  };
}
