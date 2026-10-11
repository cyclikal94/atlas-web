import type { CalendarApi, Live } from "./api";
import type { IdentityMemory } from "./memory";
import {
  createSourceObserver,
  type SourceObserver,
} from "./observation-controller";

/**
 * A VISIT of the Calendars screen (WEB-13a revision 5, R11; design assessment C1-C3): what the screen reads by itself, without being
 * asked, is admitted once per visit, not once per mount.
 *
 * An Atlas `403` (an ordinary refusal included) unmounts the protected tree, and the session mounts it again under the same identity
 * (session matrix 3.6.2; the required protective closure, which also closes every open form). A screen that read again whenever it was
 * mounted would be refused again, remounted again and read again, for as long as the server refuses: its time limits restarted with
 * it. So the two automatic reads, the live list (`observation-controller.ts`) and the capability (`GET /notification-capabilities`),
 * belong to the visit, which outlives the mount:
 *
 *  - A visit is per displayed identity (it lives in `identityMemory(account, epoch)`, memory only, never persisted): another account or
 *    a new epoch disposes it, and a read still out for it then changes nothing.
 *  - It starts when the screen is mounted with no visit current, and ENDS when the screen unmounts because the person LEFT it (the
 *    address is no longer the one it was opened at). A remount at the same address (the session's re-check, a router made again, Strict
 *    Mode) continues the visit: it attaches again and reads nothing already read. A new document (a reload, another tab) has no visit:
 *    it reads afresh, as does opening the screen again after leaving it. Coming back online, a compatibility change, focus or a
 *    re-render starts nothing.
 *  - It holds no form, no secret, no key and no row: only the observations (with their time limits) and the capability's answer.
 */
export interface CalendarVisit {
  readonly observer: SourceObserver;
  readonly capability: CapabilityRead;
  /** Ends it: the observer and the capability read are disposed (a read still out changes nothing). Idempotent. */
  dispose(): void;
}

/**
 * The visit's read of `GET /notification-capabilities` (D-13a-10): made at most once per visit while online. A read that was never
 * SENT (offline, the screen gone before it was admitted, the session's `not_sent` hold) leaves it unread, so a later mount may make it;
 * once sent, its answer is the visit's, whatever it was: a refused or failed read is unknown (which pre-disables nothing) and is not
 * made again within the visit.
 */
export interface CapabilityRead {
  /** Whether this server can hold calendar connections: null while unknown (not read, being read, or a failed read). */
  get(): boolean | null;
  /**
   * Reads it if it has not been. `live` is the caller's (its screen mounted, the page online), asked before each admission; a later
   * caller's replaces it, so a read out across a remount is admitted for the screen mounted now.
   */
  read(live: Live): void;
  subscribe(listener: () => void): () => void;
}

function createCapabilityRead(api: Pick<CalendarApi, "capabilities">): {
  read: CapabilityRead;
  dispose(): void;
} {
  let state: "unread" | "reading" | "read" = "unread";
  let value: boolean | null = null;
  let disposed = false;
  let caller: Live = () => false;
  const listeners = new Set<() => void>();
  return {
    read: {
      get: () => value,
      read(live) {
        caller = live;
        if (disposed || state !== "unread") return;
        // Taken BEFORE the request is made: a mount that comes while it is out (the remount its own refusal causes) finds it taken.
        state = "reading";
        let declined = false;
        const admitted = (): boolean => {
          const ok = !disposed && caller();
          if (!ok) declined = true;
          return ok;
        };
        const settle = (sent: boolean, links: boolean | null): void => {
          if (disposed) return;
          state = sent ? "read" : "unread";
          value = links;
          for (const listener of [...listeners]) listener();
        };
        void api.capabilities(admitted).then(
          (result) => {
            if (result.ok) settle(true, result.value.calendarLinks);
            // `not_sent`, or `closed` because the caller declined before a request was made: nothing reached the server.
            else
              settle(
                !(
                  result.kind === "not_sent" ||
                  (result.kind === "closed" && declined)
                ),
                null,
              );
          },
          () => settle(true, null),
        );
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

/** The current visit of `memory`'s identity, begun now if there is none. */
export function enterVisit(
  memory: IdentityMemory,
  api: Pick<CalendarApi, "liveSources" | "capabilities">,
): CalendarVisit {
  const current = memory.visit;
  if (current !== null) return current;
  const observer = createSourceObserver({ api });
  const capability = createCapabilityRead(api);
  const visit: CalendarVisit = {
    observer,
    capability: capability.read,
    dispose() {
      observer.dispose();
      capability.dispose();
      if (memory.visit === visit) memory.visit = null;
    },
  };
  memory.visit = visit;
  return visit;
}
