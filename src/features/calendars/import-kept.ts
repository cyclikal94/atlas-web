import {
  type CacheLifetimes,
  type CacheObserver,
  type CacheService,
  type Continuity,
  observeCache,
  readCache,
} from "../../data";
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
 *  - Revision 7 (review 7 R7): the cache is observed through the PAGE's cache lifetime (`pageCacheLifetime`), which every mounted
 *    controller publishes in turn, never through the controller that was mounted when the session opened: a remount of the protected tree
 *    disposes that one and builds another while the page's leader goes on syncing.
 *  - Revision 8 (review 8 R7a/R7b; design assessment C1-C3, invariants 2, 3, 6): what was missed while nothing observed is told by the
 *    cache's durable INVALIDATION WITNESS (`sync_state.cache_invalidation_seq`), which every committed invalidation moves and nothing else
 *    does (revision 7 compared `recovery_generation`, which a first fill moves too, so a session opened before the first fill could not
 *    tell a fill from a fill, an invalidation and a refill). The session keeps the witness of its database it was opened or last shown
 *    against (its BASIS: a shown dialog applies E9 itself, and a pending source's dialog stays open while the cache is brought up to
 *    date); once hidden, a cache known to be invalid, or a witness past its basis, ends it. It is also observed through the page runtime's
 *    service in hand when it opened (`observeCache`), which outlives the protected tree, and whose read made at the opening is a basis
 *    whenever it lands. Shown again, it WAITS (`importStatus` "pending") until a read made then (`readCache`) says its basis still
 *    stands: unknown facts (a replacement controller's first read, a failed read) neither discard it nor let it be saved; its input
 *    stays shown meanwhile. A witness past its basis then ends it (the dialog closes and says why).
 *  - Revision 9 (review 9 R7c; design assessment C1, invariants 2, 4, 5): ONLY that read verifies it. A publication or a live reading that
 *    agrees with its basis carries no evidence of when it was read (an old controller's, the observer's last one), so it can end a session
 *    (a cache known invalid, a witness past its basis) but never make one ready. The read belongs to its showing (a ticket): hidden again,
 *    discarded or ended, it no longer verifies anything, though what it read still ends the session when it tells an invalidation. A read
 *    that fails, or a showing with no live service of its database, leaves it waiting (input kept, nothing saved); a later publication asks
 *    again, one read at a time. With no basis, only the witness's first value (0: nothing was ever invalidated in that database) verifies.
 *    The dialog shown again by a remount of itself (not by Import events) after it was really hidden is verified the same way; the
 *    hide-and-show that Strict Mode replays within one turn is no hiding. A service of its database that ended is replaced, when the page
 *    has another, by an observation of that one (its opening read, made after the hiding, is never a basis).
 *  - Revision 10 (review 10 R7d/R7e; design assessment C1-C2, invariants 2, 5-7): a read is judged against the basis it was ASKED for
 *    (fixed when it is made), never against the basis as it is when the read lands: a session verified at a later showing follows an
 *    ordinary refresh while it is shown (its basis advances), and an older showing's read of the old witness is no invalidation. What an
 *    older read says against its own basis still ends the session (IndexedDB runs it before every read made after it, so a later
 *    verification never contradicts it). A NEW session is `acquiring` until it knows its database and witness (an opening read, or a
 *    reading published while it is shown): nothing is saved before, whatever submits the form, and the press captures that pair
 *    (`importAuthority`), never an absent one.
 *  - Revision 11 (review 11 R7f; design assessment C1, invariant 1): every change of `importStatus` is told (`subscribeImports`) once
 *    the state it follows from is complete, a reading's as much as a showing's or an ending's: the opening read, or a publication, that
 *    makes a new session ready enables the dialog showing it, with no other render needed.
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
  /**
   * The displayed database's open service (the page runtime's, revision 8): observed from the opening for as long as the session is
   * kept, and read afresh when it is shown again. Absent or null: none (a test's dialog; the page's cache lifetime alone then).
   */
  readonly service?: CacheService | null;
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
  /** The context it was last shown in: its service is the one a showing's read is made through. */
  context: ImportOwnerContext;
  /** Whether a dialog shows it now. */
  shown: boolean;
  /** Hidden past the turn that hid it (not a replay of its dialog's mount): shown again, it is verified afresh. */
  parked: boolean;
  /** Shown again and not yet verified against its basis: its input is shown, nothing is saved. */
  pending: boolean;
  /** The invalidation witness of its database it was opened or last shown against (null: none known yet). Frozen while hidden. */
  basis: number | null;
  /** The service observed (null: none in hand). */
  observer: CacheObserver | null;
  observed: CacheService | null;
  /** Whether the observation is the one begun when it opened (its opening read may be the basis), not a later rebinding. */
  opening: boolean;
  /** The showing whose read may still verify it. */
  ticket: number;
  /** A read for that showing is under way. */
  verifying: boolean;
  /** Judges it by the page's cache as it is now (ends it if that says so). */
  judge: () => void;
  readonly offs: Array<() => void>;
}

let held: Held | null = null;
let routes: RouteChanges | null = null;
let tickets = 0;
const watchers = new Set<() => void>();
const changed = (): void => {
  for (const watcher of [...watchers]) watcher();
};

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

/** Sessions the cache ended (invalidated while they were hidden or waiting): a dialog showing one closes and says why. */
const expiredEditors = new WeakSet<ImportEditor>();

function release(
  which: Held,
  reason: "discarded" | "revoked" | "expired" = "discarded",
): void {
  if (reason === "expired") expiredEditors.add(which.editor);
  for (const off of which.offs.splice(0)) off();
  which.observer?.dispose();
  which.editor.end(reason === "revoked" ? "revoked" : "discarded");
  if (held === which) held = null;
  changed();
}

type Reading = {
  readonly invalidations: number | null;
  readonly invalidated: boolean;
};

/**
 * What is read now of `which`'s database: the page's cache lifetime (whichever controller publishes it; another database's says nothing),
 * and the page runtime's service it observes.
 */
function readings(which: Held, context: ImportOwnerContext): Reading[] {
  const out: Reading[] = [];
  const life = context.cache?.get() ?? null;
  if (life !== null) {
    // Composed before there was a database: the displayed account's first one is its own (as `revokedIn` adopts it).
    if (
      which.incarnation === null &&
      which.identity.startsWith(`${life.account}:`) &&
      identityOf(context.identities.get()) === which.identity
    )
      which.incarnation = life.incarnationId;
    if (life.incarnationId === which.incarnation) out.push(life);
  }
  if (which.observer !== null) out.push(which.observer.get());
  return out;
}

/** The highest witness the readings name (null: none does); one database's witness only grows. */
const newest = (all: readonly Reading[]): number | null =>
  all.reduce<number | null>(
    (max, { invalidations }) =>
      invalidations === null
        ? max
        : max === null
          ? invalidations
          : Math.max(max, invalidations),
    null,
  );

/**
 * Judges `which` by the page's cache as it is read now (`judged`), then tells every dialog when that changed its `importStatus` (revision
 * 11, review 11 R7f): what a reading establishes (its database adopted, its first basis) makes a new session ready, and nothing else
 * would tell the dialog still showing it `acquiring`. Ended meanwhile, `release` has told them.
 */
function judgeNow(which: Held, context: ImportOwnerContext): void {
  if (which.editor.ended()) return;
  const before = importStatus(which.editor);
  judged(which, context);
  if (held === which && importStatus(which.editor) !== before) changed();
}

/**
 * Judges `which` by the page's cache as it is read now (revision 8, R7a/R7b). Shown and verified: it follows (the dialog applies E9
 * itself). Hidden or waiting: a cache known to be invalid ends it, and so does a witness past its basis (invalidated, and perhaps brought
 * up to date, while nothing observed it); facts not established prove nothing, and a reading that agrees proves nothing either (revision
 * 9, R7c): a waiting one shown asks for its showing's read instead.
 */
function judged(which: Held, context: ImportOwnerContext): void {
  const all = readings(which, context);
  // The read made when it opened is what the database said then, whenever it lands.
  if (which.opening) which.basis ??= which.observer?.get().opening ?? null;
  if (which.shown && !which.pending) {
    const known = newest(all);
    if (known !== null && (which.basis === null || known > which.basis))
      which.basis = known;
    return;
  }
  const basis = which.basis;
  if (
    all.some(
      (reading) =>
        reading.invalidated ||
        (basis !== null &&
          reading.invalidations !== null &&
          reading.invalidations > basis),
    )
  ) {
    release(which, "expired");
    return;
  }
  if (which.pending && which.shown) verify(which);
}

/** Whether `service` is a live service of `which`'s database. */
const serves = (which: Held, service: CacheService | null): boolean =>
  service !== null &&
  !service.ended &&
  service.incarnationId === which.incarnation;

/**
 * Asks for the read that may verify `which`'s showing (R7c): one at a time, through the live service of its database it was last shown
 * with (none: it waits). Whenever it lands, a cache known invalid or another witness than the basis it was asked for ends it (the read was
 * made after it was hidden: an invalidation since); only the same witness, read for the showing still waiting, by a service still live,
 * makes it ready. That basis is fixed when it is asked (R7d): a later showing verified meanwhile may have followed a refresh since.
 */
function verify(which: Held): void {
  const service = which.context.service ?? null;
  if (which.verifying || !serves(which, service)) return;
  const ticket = which.ticket;
  const basis = which.basis;
  which.verifying = true;
  void readCache(service as CacheService).then((now) => {
    if (which.ticket === ticket) which.verifying = false;
    if (held !== which || which.editor.ended() || now === null) return;
    if (
      now.invalidated ||
      (basis !== null &&
        now.invalidations !== null &&
        now.invalidations !== basis)
    ) {
      release(which, "expired");
      return;
    }
    if (
      which.ticket !== ticket ||
      !which.pending ||
      !which.shown ||
      !serves(which, service) ||
      now.invalidations === null
    )
      return;
    // Its basis became known while the read was made (its opening read landed): asked without it, the read says nothing; ask again.
    if (which.basis !== basis) {
      verify(which);
      return;
    }
    if (basis === null && now.invalidations !== 0) return;
    // No basis: the witness's first value says that nothing was ever invalidated in this database, so nothing was missed either.
    which.basis = now.invalidations;
    which.pending = false;
    changed();
  });
}

/** Observes `service` instead of the service `which` observed, once that one has ended (another service of the same database). */
function rebind(which: Held, service: CacheService | null): void {
  if (
    !serves(which, service) ||
    service === which.observed ||
    (which.observed !== null && !which.observed.ended)
  )
    return;
  if (which.opening) which.basis ??= which.observer?.get().opening ?? null;
  // Its opening read is made after the hiding: never a basis.
  which.opening = false;
  which.observer?.dispose();
  const observer = observeCache(service as CacheService);
  which.observer = observer;
  which.observed = service;
  observer.subscribe(which.judge);
}

/**
 * Shows `which` again: it WAITS until a read made for this showing through the displayed database's service verifies its basis (R7a,
 * R7c). Publications may end it meanwhile, never verify it.
 */
function resume(which: Held, context: ImportOwnerContext): void {
  which.context = context;
  which.shown = true;
  which.parked = false;
  which.pending = true;
  tickets += 1;
  which.ticket = tickets;
  which.verifying = false;
  rebind(which, context.service ?? null);
  which.judge();
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

/**
 * The kept session for `entry`, if it may be shown again in `context` (waiting, R7a, while its basis is not verified yet); any other kept
 * session ends, and so does this one when the cache says it was invalidated meanwhile.
 */
function current(
  entry: ImportEntry,
  context: ImportOwnerContext,
): ImportEditor | null {
  const which = held;
  if (which === null) return null;
  if (
    sameEntry(which.entry, entry) &&
    isCalendarsPath(observed().pathname()) &&
    owns(which, context)
  ) {
    // Judged as it is now by `resume` (a cache known invalid, or a witness past its basis, ends it), then it waits for its read.
    resume(which, context);
    if (held !== which) return null;
    changed();
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
  const service = context.service ?? null;
  // The page runtime's service of the displayed database, observed from now on (it outlives the protected tree).
  const observing =
    service !== null &&
    !service.ended &&
    service.incarnationId === context.incarnation;
  const which: Held = {
    editor,
    entry,
    identity: context.identity,
    incarnation: context.incarnation,
    inside: isCalendarsPath(changes.pathname()),
    context,
    shown: true,
    parked: false,
    pending: false,
    basis: null,
    observer: observing ? observeCache(service) : null,
    observed: observing ? service : null,
    opening: true,
    ticket: 0,
    verifying: false,
    judge: () => judgeNow(which, context),
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
  // Every reading is judged, shown or not: shown, the session follows the cache it is shown against; hidden or waiting, it ends on an
  // invalidation, seen as it happens or told by the witness afterwards (another controller, or none, may have been mounted meanwhile).
  if (context.cache !== null)
    which.offs.push(context.cache.subscribe(which.judge));
  // Heard until the observation is disposed (a rebinding, the session's end).
  which.observer?.subscribe(which.judge);
  which.judge();
  changed();
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

/**
 * A dialog shows `editor` (again: a remount of the same dialog). Hidden past its turn, it is shown again only as Import events would show
 * it: waiting for its showing's read (R7c).
 */
export function showImport(editor: ImportEditor): void {
  const which = held;
  if (which === null || which.editor !== editor || which.shown) return;
  which.shown = true;
  if (!which.parked) return;
  resume(which, which.context);
  if (held === which) changed();
}

/** The dialog showing `editor` leaves the screen without discarding it: it stays kept (if it has a visit). */
export function hideImport(editor: ImportEditor): void {
  const which = held;
  if (which === null || which.editor !== editor) return;
  which.shown = false;
  if (!which.inside) {
    release(which);
    return;
  }
  // What the cache says at the moment it is hidden counts too (an invalidation the shown dialog stayed open through, R7).
  which.judge();
  // Still hidden once this turn is over: parked, so a remount of its dialog verifies it afresh (R7c; meanwhile its showing's read verifies
  // nothing, since it is not shown). A hide and a show in the same turn (Strict Mode's replay of the dialog's mount) is no hiding.
  queueMicrotask(() => {
    if (held === which && !which.shown) which.parked = true;
  });
}

/**
 * What the dialog showing `editor` may do with it (R7a): `ready` (with the cache's history it is saved against), `acquiring` (revision
 * 10, R7e: a new session that does not know its database and witness yet: its source and input are shown, nothing is saved), `pending`
 * (shown again, its basis not verified yet: its input is shown, but neither unverified cached content nor a save), `expired` (the cache
 * was invalidated while it was hidden or waiting) or `ended`.
 */
export type ImportAuthority =
  | { readonly status: "ready"; readonly continuity: Continuity }
  | { readonly status: "acquiring" | "pending" | "expired" | "ended" };

/**
 * `editor`'s authority as it is now, asked once at the press and saved with (design assessment C2, invariant 7): the history it states to
 * the enqueue (`EnqueueRequest.continuity`, its database and the witness of its basis), which writes nothing unless its own transaction
 * reads the same. Never a save without one.
 */
export function importAuthority(editor: ImportEditor): ImportAuthority {
  if (expiredEditors.has(editor)) return { status: "expired" };
  const which = held;
  if (editor.ended() || which === null || which.editor !== editor)
    return { status: "ended" };
  if (which.pending) return { status: "pending" };
  if (which.incarnation === null || which.basis === null)
    return { status: "acquiring" };
  return {
    status: "ready",
    continuity: {
      incarnationId: which.incarnation,
      invalidations: which.basis,
    },
  };
}

export const importStatus = (editor: ImportEditor): ImportAuthority["status"] =>
  importAuthority(editor).status;

/** Hears every change of `importStatus`. */
export function subscribeImports(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
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

/** The enqueue said the cache was invalidated since `editor`'s basis (`expired`): its session ends, and the dialog closes and says why. */
export function expireImport(editor: ImportEditor): void {
  if (held?.editor === editor) release(held, "expired");
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
