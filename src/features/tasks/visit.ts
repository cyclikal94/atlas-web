import { useRouter } from "@tanstack/react-router";
import {
  documentRouteChanges,
  type RouteChanges,
} from "../../lib/route-changes";

/**
 * The LOGICAL VISIT of a task screen (revision 22, R34 / design assessment DA22-I1..I3; WEB-02 ia.md §1.3.3, task states I1): what owns
 * the input typed on it, whichever of its editors can be shown.
 *
 * Revisions 18-21 kept input through a visit to the sync screens by asking, as each editor unmounted, where the router had gone, and held
 * the detail's days from inside the screen. Both still depended on which component could render: an editor the data hid at its own address
 * (R34: the task's details removed while its edit form was open), a screen the cache gate hid whole (DA22-I2), and a departure from the sync
 * screens to anywhere but the editor (DA22-I3) each lost, or failed to end, the person's input. So the visit is no longer a component's:
 *
 *  - A visit is ONE screen address (`location.pathname`, a change of only the query or the fragment is not a change) for ONE displayed
 *    identity (`account:epoch`). It begins when a task screen first asks for it there (`visitHere`), and every editor opened on it is an
 *    attachment to it: mounting, unmounting, the data hiding an editor, the cache gate hiding the whole screen, a remount of the protected
 *    tree or a router made again neither begin nor end it.
 *  - It goes on at the sync screens (`/sync`, queue or conflicts): checking sync state is part of the visit, and Back or the queue's close
 *    control to the same address continues it, even if none of its editors can be shown there.
 *  - It ENDS when the address becomes anything else (an ordinary departure: a link, Cancel, a save that closes onto its task, Back, from the
 *    screen or from the sync screens), when another identity asks for one, or when the tests forget it. Its end is observed by the document
 *    itself (`route-changes.ts`), not by a screen or its router, so a departure while no screen is mounted (the cache gate shown, the
 *    protected tree closed, the person still at the sync screens) ends it too. After its end the address starts a new visit: fresh input.
 *  - Ending a visit lets go of every input it owns (`onTaskVisitEnded`; each owner drops what is its): kept-input sessions, entry fixes and
 *    occurrence corrections, shown, parked or never mounted again. It never writes, sends, discards a queued operation or navigates.
 *
 * Page memory only: a reload or another tab has no visit. One visit at a time (the document has one address); visit numbers are never
 * reused. The component tests' routers use a memory history, which is not the document's: their harness gives the visits that history's
 * changes instead (`observeTaskRoutes`), with the same semantics (`createHistoryRouteChanges`).
 */
export interface TaskVisit {
  readonly identity: string;
  /** The screen's address (`location.pathname`, without a trailing slash). */
  readonly address: string;
  /** Never reused. */
  readonly generation: number;
  /** Whether it has ended (a departure, another identity, the tests forgetting it). */
  ended(): boolean;
}

interface Visit extends TaskVisit {
  over: boolean;
}

let source: RouteChanges | null = null;
let unsubscribe: (() => void) | null = null;
let current: Visit | null = null;
let generations = 0;
const ends = new Set<(visit: TaskVisit) => void>();

/** A path as compared here: without a trailing slash, and decoded (a router's path and the document's may differ in escaping only). */
function trimmed(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURI(pathname);
  } catch {
    // A malformed escape is compared as it is.
  }
  return decoded.replace(/\/+$/, "") || "/";
}

/** The sync screens' address (the shell's sync control navigates there, queue or conflicts alike). */
export const atSync = (pathname: string): boolean =>
  trimmed(pathname) === "/sync";

function observe(next: RouteChanges): RouteChanges {
  unsubscribe?.();
  source = next;
  unsubscribe = next.subscribe(heard);
  return next;
}

const routes = (): RouteChanges => source ?? observe(documentRouteChanges());

/** The address changed: the visit goes on at its own address and at the sync screens, and ends anywhere else. */
function heard(pathname: string): void {
  const visit = current;
  if (visit === null) return;
  const at = trimmed(pathname);
  if (at !== visit.address && !atSync(at)) end(visit);
}

function end(visit: Visit): void {
  if (visit.over) return;
  visit.over = true;
  if (current === visit) current = null;
  for (const listener of [...ends]) listener(visit);
}

/**
 * The visit of the screen at the current address for `identity`: the one going on (here, or at the sync screens it went to), else a new
 * one. Another identity's visit ends first (its input is never this identity's). `pathname` is where the asking screen's router is (it
 * moves with the navigation, while a browser history writes the document's address a microtask later); by default the observed address.
 */
export function visitHere(
  identity: string,
  pathname: string = routes().pathname(),
): TaskVisit {
  routes();
  const at = trimmed(pathname);
  const going = current;
  if (
    going !== null &&
    going.identity === identity &&
    (going.address === at || atSync(at))
  )
    return going;
  if (going !== null) end(going);
  generations += 1;
  const visit: Visit = {
    identity,
    address: at,
    generation: generations,
    over: false,
    ended: () => visit.over,
  };
  current = visit;
  return visit;
}

/** Told once for every visit that ends, after it has (an owner drops the input that visit owned). */
export function onTaskVisitEnded(
  listener: (visit: TaskVisit) => void,
): () => void {
  ends.add(listener);
  return () => {
    ends.delete(listener);
  };
}

/**
 * The visit an editor opening now belongs to, for `identity` (asked when it opens, not when it renders). An editor shown outside any router
 * (a component test) belongs to none: it keeps its input only while it is mounted.
 */
export function useTaskVisit(): (identity: string) => TaskVisit | null {
  const router = useRouter({ warn: false }) as {
    latestLocation: { pathname: string };
  } | null;
  return (identity) =>
    router === null || router === undefined
      ? null
      : visitHere(identity, router.latestLocation.pathname);
}

/**
 * For tests whose router has a memory history: observe its changes instead of the document's. The visit going on (if any) ends: a new
 * router is a new world.
 */
export function observeTaskRoutes(next: RouteChanges): void {
  if (current !== null) end(current);
  observe(next);
}

/** For tests: the visit going on ends (its owners drop its input); visit numbers are still never reused. */
export function forgetTaskVisits(): void {
  if (current !== null) end(current);
}
