import type { Hint, HintChannel } from "../ports/hints";

export const HINT_CHANNEL = "atlas-auth-hints";

const HINT_TYPES = new Set(["auth_state_changed", "observation", "lease"]);
const isHint = (value: unknown): value is Hint =>
  typeof value === "object" &&
  value !== null &&
  HINT_TYPES.has((value as { type?: unknown }).type as string);

/**
 * `BroadcastChannel` hints (matrix 3.3): a hint is never evidence. A receiver re-reads `auth_state` and acts on that; the
 * payload only says where to look and lets a displaying page hold a moment sooner. A page does not receive its own
 * message (BroadcastChannel semantics), and a missing channel makes the layer a no-op: the 30 s scan and the
 * visibility events are the fallback the protocol already relies on.
 */
export function createBroadcastHints(
  factory: typeof BroadcastChannel | undefined = typeof BroadcastChannel ===
  "undefined"
    ? undefined
    : BroadcastChannel,
): HintChannel {
  let channel: BroadcastChannel | null = null;
  try {
    channel = factory ? new factory(HINT_CHANNEL) : null;
  } catch {
    channel = null;
  }
  const listeners = new Set<(hint: Hint) => void>();
  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      if (!isHint(event.data)) return;
      for (const listener of [...listeners]) listener(event.data);
    };
  }
  return {
    post(hint) {
      try {
        channel?.postMessage(hint);
      } catch {
        // A hint that cannot be posted is a hint that is not sent; the receivers' scan finds the record.
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
