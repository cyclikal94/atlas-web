import {
  documentRouteChanges,
  type RouteChanges,
} from "../../lib/route-changes";
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
 *  - It starts when the screen is mounted with no visit current, and ENDS when the person LEAVES the screen: when the document's
 *    address stops being the screen's (`VisitBoundary`, revision 6, R13). That is observed by the document itself (`route-changes.ts`),
 *    not by the screen or its router, because the person can leave while no screen is mounted at all: Back pressed while the session's
 *    protective closure has the tree unmounted ends the visit just as Back pressed on the screen does, and opening the screen again
 *    then reads afresh, once. A remount at the same address (the session's re-check, a router made again, Strict Mode) continues the
 *    visit: it attaches again and reads nothing already read; so does a change of only the query or the fragment. A new document (a
 *    reload, another tab) has no visit: it reads afresh. Coming back online, a compatibility change, focus, visibility or a re-render
 *    starts nothing.
 *  - Ending a visit ends only what the screen reads by itself. It does not touch the manual refreshes (`refresh-ownership.ts`): which
 *    press of a source may still record its outcome is decided by admission across visits too.
 *  - It holds no form, no secret, no key and no row: only the observations (with their time limits) and the capability's answer.
 */
export interface CalendarVisit {
  /** The number of departures from the screen the document had seen when the visit began (`VisitBoundary.departures`). */
  readonly departures: number;
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
            // `not_sent`, or `closed` before the send boundary (the caller declined, or the session's cover was closed): nothing
            // reached the server.
            else
              settle(
                !(
                  result.kind === "not_sent" ||
                  (result.kind === "closed" &&
                    (declined || result.unsent === true))
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

/** The Calendars screen's address (`section.tsx`): with or without a trailing slash, it is the same screen. */
export const CALENDARS_PATH = "/settings/calendars";
export const isCalendarsPath = (pathname: string): boolean =>
  pathname.replace(/\/+$/, "") === CALENDARS_PATH;

/**
 * Where a visit ends (revision 6, R13; design assessment C2): the document LEAVING the Calendars screen. It counts the times the
 * document's path went from the screen's to another (`route-changes.ts`: Back, Forward, `go`, a push or a replace, by a router or not,
 * mounted or not), so leaving and coming back while no screen is mounted is still a departure. A change that stays on the screen (the
 * same path, only a query or a fragment, a remount) is not.
 */
export interface VisitBoundary {
  departures(): number;
  /** Whether the document is at the screen now (its own address, not a router's: a router can learn of a change after this does). */
  inside(): boolean;
  /** The number of times the document entered or left the screen (a snapshot for a mounted screen to follow). */
  changes(): number;
  /** Told after each entry and each departure. */
  subscribe(listener: () => void): () => void;
}

export function createVisitBoundary(changes: RouteChanges): VisitBoundary {
  const listeners = new Set<() => void>();
  let inside = isCalendarsPath(changes.pathname());
  let departures = 0;
  let count = 0;
  changes.subscribe((pathname) => {
    const now = isCalendarsPath(pathname);
    if (now === inside) return;
    if (inside) departures += 1;
    inside = now;
    count += 1;
    for (const listener of [...listeners]) listener();
  });
  return {
    departures: () => departures,
    inside: () => inside,
    changes: () => count,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let boundary: VisitBoundary | null = null;

/** The document's boundary (one per document, made by the first call: the first visit's). */
export function documentVisitBoundary(): VisitBoundary {
  boundary ??= createVisitBoundary(documentRouteChanges());
  return boundary;
}

/**
 * The current visit of `memory`'s identity, begun now if there is none, or if the one there began before the document's latest
 * departure from the screen (it is disposed then). A visit is disposed by the next departure as it happens, mounted or not.
 */
export function enterVisit(
  memory: IdentityMemory,
  api: Pick<CalendarApi, "liveSources" | "capabilities">,
  at: VisitBoundary = documentVisitBoundary(),
): CalendarVisit {
  const departures = at.departures();
  const current = memory.visit;
  if (current !== null && current.departures === departures) return current;
  current?.dispose();
  const observer = createSourceObserver({ api });
  const capability = createCapabilityRead(api);
  let off = (): void => undefined;
  const visit: CalendarVisit = {
    departures,
    observer,
    capability: capability.read,
    dispose() {
      off();
      observer.dispose();
      capability.dispose();
      if (memory.visit === visit) memory.visit = null;
    },
  };
  off = at.subscribe(() => {
    if (at.departures() !== departures) visit.dispose();
  });
  memory.visit = visit;
  return visit;
}
