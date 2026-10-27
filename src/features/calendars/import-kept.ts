import type { CacheLifetime, CacheLifetimes } from "../../data";
import {
  documentRouteChanges,
  type RouteChanges,
} from "../../lib/route-changes";
import { createImportEditor, type ImportEditor } from "./import-editor";
import { isCalendarsPath } from "./visit";

/**
 * The owner of the import dialog's editing session (WEB-13b revision 6, review 6 R7; design assessment C1-C2, invariants 1-3, 7-8; ia.md
 * §1.3.3, the J2 dialog rule). ONE session at a time (the page has one import dialog), held for the import's VISIT and its identity, not by
 * the dialog showing it nor by the Calendars screen that opened it:
 *
 *  - The import's visit begins at the Calendars screen when a session opens there, goes on at the sync screens (`/sync`, queue or
 *    conflicts: checking sync state is part of composing the import), and ENDS when the document's address becomes anything else (a link,
 *    Back past the screen, an account change's `/`), whether or not a screen or a tree is mounted then (`route-changes.ts`). It is not the
 *    Calendars screen's automatic-read visit (`visit.ts`), which ends at the sync screens and must keep doing so.
 *  - Opening Import events again from the SAME entry (the same source's row, or the drop zone's Browse for its chooser) on the same visit,
 *    identity and database shows the session again (`resume`); a different entry is a deliberate new edit: the old session ends. A drop
 *    onto the zone while the chooser's session is kept is a new file chosen in it (the source and the window stay).
 *  - Cancel, Escape and the close icon end the session they showed (`discard`), and only that one. A session consumed by its own save
 *    leaves. A dialog that unmounts otherwise (the sync control, a remount of the protected tree) leaves its session kept.
 *  - The session ends, shown or not, when the settled identity changes (another account, a new epoch, signed out: observed while hidden,
 *    so A→B→A never gives A's old input back), when the database it was composed against is no longer the displayed one (checked whenever
 *    it is shown again or saved), and, while kept hidden, when the cache is invalidated to be brought up to date (the open dialog's E9
 *    rule).
 *  - Revision 7 (review 7 R7; design assessment C1-C3, invariants 2, 3, 6): the cache is observed through the PAGE's cache lifetime
 *    (`pageCacheLifetime`), which every mounted controller publishes in turn, never through the controller that was mounted when the
 *    session opened: a remount of the protected tree disposes that one and builds another while the page's leader goes on syncing. What
 *    was missed while no controller (or no observer) was there is told by the cache's durable generation: the session keeps the generation
 *    of the valid cache it was last shown against (a shown dialog applies E9 itself), and once hidden, a cache known to be invalid, or valid
 *    under ANOTHER generation, ends it. A controller that has not established the facts yet (a remount's first read) proves nothing either
 *    way and ends nothing, except that a session is not shown again until its generation can be compared.
 *
 * Page memory only: never stored, sent, broadcast, put in history state or logged; a reload or another tab has none. Retained selection
 * is never retained permission: the dialog reads the source's current state whenever it shows the session.
 */
export type ImportEntry =
  | { readonly kind: "row"; readonly sourceId: string }
  | { readonly kind: "chooser" };

export interface ImportOwnerContext {
  /** The displayed identity, as `account:epoch`. */
  readonly identity: string;
  /** The page's settled identity, observed while the session is kept (it outlives every mount of the protected tree). */
  readonly identities: {
    get(): { account_id: string; epoch: number } | null;
    subscribe(listener: () => void): () => void;
  };
  /** The displayed account database's incarnation, or null when there is none. */
  readonly incarnation: string | null;
  /** The page's cache lifetime (`pageCacheLifetime`), observed for as long as the session is kept; null: none (a test's dialog). */
  readonly cache: CacheLifetimes | null;
  /** Today's date on this device (`YYYY-MM-DD`): a new session's default window. */
  readonly today: string;
}

interface Held {
  readonly editor: ImportEditor;
  readonly entry: ImportEntry;
  readonly identity: string;
  /** The database it was composed against (null until there was one: nothing could be saved before). */
  incarnation: string | null;
  /** Opened at the Calendars screen: it has a visit, and is kept while not shown. */
  readonly inside: boolean;
  /** Whether a dialog shows it now. */
  shown: boolean;
  /** The generation of the valid cache it was last shown against (null: not shown against a valid one yet). Frozen while hidden. */
  generation: number | null;
  /** Judges it by the page's cache as it is now (ends it if that says so). */
  judge: () => void;
  readonly offs: Array<() => void>;
}

let held: Held | null = null;
let routes: RouteChanges | null = null;

const atSync = (pathname: string): boolean =>
  pathname.replace(/\/+$/, "") === "/sync";
const observed = (): RouteChanges => {
  routes ??= documentRouteChanges();
  return routes;
};

const sameEntry = (a: ImportEntry, b: ImportEntry): boolean =>
  a.kind === "row"
    ? b.kind === "row" && b.sourceId === a.sourceId
    : b.kind === "chooser";

const identityOf = (
  identity: { account_id: string; epoch: number } | null,
): string | null =>
  identity === null ? null : `${identity.account_id}:${identity.epoch}`;

function release(
  which: Held,
  reason: "discarded" | "revoked" = "discarded",
): void {
  for (const off of which.offs.splice(0)) off();
  which.editor.end(reason);
  if (held === which) held = null;
}

/**
 * Whether the page's cache, as `life` says it now, lets `which` live on (revision 7, R7). Shown: the dialog applies E9 itself, and the
 * session follows the valid cache it shows (a pending source's dialog stays open while the cache is brought up to date). Hidden: a cache
 * known to be invalid ends it, and so does a valid cache of another generation (invalidated and recovered while nothing was observing it);
 * facts not established yet prove nothing. Another database is the incarnation rule's (`revokedIn`), and no controller says nothing.
 */
function survives(
  which: Held,
  life: CacheLifetime | null,
  context: ImportOwnerContext,
): boolean {
  if (life === null) return true;
  // Composed before there was a database: the displayed account's first one is its own (as `revokedIn` adopts it).
  if (
    which.incarnation === null &&
    which.identity.startsWith(`${life.account}:`) &&
    identityOf(context.identities.get()) === which.identity
  )
    which.incarnation = life.incarnationId;
  if (life.incarnationId !== which.incarnation) return true;
  if (which.shown) {
    if (life.valid && life.generation !== null)
      which.generation = life.generation;
    return true;
  }
  if (life.invalidated) return false;
  if (life.generation === null) return true;
  if (which.generation === null) {
    if (life.valid) which.generation = life.generation;
    return true;
  }
  return life.generation === which.generation;
}

/** Whether `which`'s generation can be compared with the cache's now: it has none to compare yet, or the facts of its database are established. */
function verifiable(which: Held, life: CacheLifetime | null): boolean {
  return (
    which.generation === null ||
    (life !== null &&
      life.incarnationId === which.incarnation &&
      life.generation !== null)
  );
}

/** Whether `which` may still be shown or saved in `context`: its identity is displayed and settled, and its database is the displayed one. */
function owns(which: Held, context: ImportOwnerContext): boolean {
  return !which.editor.ended() && !revokedIn(which, context);
}

/** Its identity or its database is not the displayed one. */
function revokedIn(which: Held, context: ImportOwnerContext): boolean {
  if (
    which.identity !== context.identity ||
    identityOf(context.identities.get()) !== context.identity
  )
    return true;
  if (context.incarnation === null) return false;
  which.incarnation ??= context.incarnation;
  return which.incarnation !== context.incarnation;
}

/** The kept session for `entry`, if it may be shown again in `context`; any other kept session ends. */
function current(
  entry: ImportEntry,
  context: ImportOwnerContext,
): ImportEditor | null {
  const which = held;
  if (which === null) return null;
  const life = context.cache?.get() ?? null;
  if (
    sameEntry(which.entry, entry) &&
    isCalendarsPath(observed().pathname()) &&
    owns(which, context) &&
    (context.cache === null ||
      (verifiable(which, life) && survives(which, life, context)))
  ) {
    which.shown = true;
    return which.editor;
  }
  release(which, revokedIn(which, context) ? "revoked" : "discarded");
  return null;
}

/**
 * The session the dialog opening now for `entry` shows: the kept one for that entry (on the same visit, identity and database), else a
 * new one; any other kept session ends. A new session outside the Calendars screen (a test's dialog) is kept only while shown.
 */
export function openImport(
  entry: ImportEntry,
  context: ImportOwnerContext,
): ImportEditor {
  const kept = current(entry, context);
  if (kept !== null) return kept;
  const editor = createImportEditor({
    today: context.today,
    onConsumed: () => {
      if (held?.editor === editor) release(held);
    },
  });
  const changes = observed();
  const which: Held = {
    editor,
    entry,
    identity: context.identity,
    incarnation: context.incarnation,
    inside: isCalendarsPath(changes.pathname()),
    shown: true,
    generation: null,
    judge: () => undefined,
    offs: [],
  };
  held = which;
  which.offs.push(
    changes.subscribe((pathname) => {
      // The visit goes on at the screen and at the sync screens; anywhere else it ends, mounted or not.
      if (!which.inside || (!isCalendarsPath(pathname) && !atSync(pathname)))
        release(which);
    }),
    context.identities.subscribe(() => {
      if (identityOf(context.identities.get()) !== which.identity)
        release(which, "revoked");
    }),
  );
  const cache = context.cache;
  if (cache !== null) {
    // Every publication is judged, shown or not: shown, the session follows the valid cache it is shown against; hidden, it ends on an
    // invalidation, seen as it happens or told by the generation afterwards (another controller, or none, may have been mounted meanwhile).
    const judge = (): void => {
      if (!survives(which, cache.get(), context)) release(which);
    };
    which.offs.push(cache.subscribe(judge));
    which.judge = judge;
    judge();
  }
  return editor;
}

/** The drop zone's Browse: the chooser's kept session shown again, or null (Browse then opens the picker). */
export function resumeChooser(
  context: ImportOwnerContext,
): ImportEditor | null {
  return held?.entry.kind === "chooser"
    ? current({ kind: "chooser" }, context)
    : null;
}

/** A dialog shows `editor` (again: a remount of the same dialog). */
export function showImport(editor: ImportEditor): void {
  if (held?.editor === editor) held.shown = true;
}

/** The dialog showing `editor` leaves the screen without discarding it: it stays kept (if it has a visit). */
export function hideImport(editor: ImportEditor): void {
  const which = held;
  if (which === null || which.editor !== editor) return;
  which.shown = false;
  if (!which.inside) release(which);
  // What the cache says at the moment it is hidden counts too (an invalidation the shown dialog stayed open through, R7).
  else which.judge();
}

/** Whether `editor` may be saved now (asked at the press): still the kept session of the displayed identity and database. */
export function importOwned(
  editor: ImportEditor,
  context: ImportOwnerContext,
): boolean {
  const which = held;
  if (which === null || which.editor !== editor) return false;
  if (!revokedIn(which, context)) return !editor.ended();
  release(which, "revoked");
  return false;
}

/** Cancel, Escape, the close icon or the cache being brought up to date: `editor`'s session ends (a save it made stays queued). */
export function discardImport(editor: ImportEditor): void {
  if (held?.editor === editor) release(held);
  else editor.end();
}

/** Tests only: forgets the kept session (and observes `changes` instead of the document, when given). */
export function forgetImportSessions(changes?: RouteChanges): void {
  if (held !== null) release(held);
  if (changes !== undefined) routes = changes;
}
