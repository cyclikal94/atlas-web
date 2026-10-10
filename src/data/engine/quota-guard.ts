import { DATA_CONFIG, type DataConfig } from "../model/config";
import {
  decideQuota,
  freeBytes,
  type QuotaKind,
  type QuotaVerdict,
} from "../model/quota";
import {
  EMPTY_LEDGER,
  type LedgerChange,
  type LedgerLanded,
  type LedgerState,
  landHold,
  ledgerFor,
  type OriginLedger,
} from "../store/quota-ledger";
import { createQuotaClock } from "./quota-clock";

/**
 * `QuotaGuard` (plan 5.4.6): caches `navigator.storage.estimate()` for a few seconds, refreshes after commits, and answers
 * whether a data write may proceed so that `atlas-auth` keeps room for its lease and observation writes. When `estimate()` is
 * missing or throws the guard reports `unknown` and the engine relies on actual failures (a `StoreFailure("quota")`).
 *
 * A real engine cannot be made to raise `QuotaExceededError` on request, so the fixture and real-engine layers use an explicit,
 * named injection (a stubbed `estimate`, a wrapped object-store method), and every report says that the engine's own quota
 * behaviour was not exercised.
 *
 * WHAT IS PROMISED AND WHAT HAS JUST LANDED IS THE ORIGIN'S, NOT THE PAGE'S (R28, revision 13). The estimate is the origin's, so the
 * reserve it protects is shared by every page, and so is the ledger (`store/quota-ledger.ts`): the bytes admitted and not yet settled
 * (the HOLDS) and the bytes of writes that have landed and that a lagging estimate may not show (the LANDED ledger). Every judgement
 * and every settlement is one atomic change of that ledger, so two pages cannot each be admitted by the same free figure. A guard with
 * no ledger of its own shares the in-realm one of its estimate source; the production composition passes the origin's.
 *
 * A WRITE IS ADMITTED ONLY ON ACCOUNTING THAT COUNTED EVERY OTHER PAGE (R28, revision 15). Nothing else can say what the other pages
 * have promised: a judgement made without the origin's ledger would be a guess, and a guess cannot bound another page's outstanding
 * write, the number of pages, or a promise this page makes that no other page can see. So when the ledger does not answer, the
 * reservation is REFUSED, never admitted on this page's own accounting. A call the ledger REJECTS is asked again a bounded number of
 * times with a short, doubling wait (a transient failure of one tiny IndexedDB record costs a few tens of milliseconds and nothing of
 * the guarantee); one it does not ANSWER within the wait is abandoned (a late application of it applies nothing). The refusal says
 * `unestablished`, so a consumer can tell "the space is short" from "the accounting could not be established" (the sync engine does not
 * stop with a storage-full notice for the second: it asks again, paced). This is distinct from the missing or throwing ESTIMATE, which
 * the plan approves as `unknown` (nothing to protect, the write relies on its own failure), and the `check` of the engine, which is
 * advisory and counts what the origin last showed without refusing on a guess.
 *
 * A HOLD LASTS AS LONG AS THE WRITE IT ADMITTED, AND THE WRITE MAY BEGIN ONLY WHILE IT DOES (R28, revisions 14 and 15). A hold in the
 * origin's ledger is leased, so that a page that dies with a save outstanding stops holding its bytes, but a lease that simply ran out
 * under a LIVE writer let every other page count the space as free while the writer was still going to write into it. Three things keep
 * the two lifetimes together. The guard RENEWS the lease of every reservation it still holds, for as long as it is unsettled. The
 * reservation says, synchronously, whether it is still one the other pages count: `live()`, asked by a writer in the same step as it
 * begins its transaction (it ends a third of a lease BEFORE the hold can lapse). And, where the ledger has OWNERS (`HoldOwners`: in
 * production a Web Lock per hold, kept by the writer's page), a hold is never reclaimed for the want of a renewal at all: a page that is
 * merely suspended (its timers do not run, its transaction may be committing) keeps its hold however long the clock has moved, and a hold
 * is reclaimed only when its owner is PROVEN to have let go (released, or its page destroyed). A `false` proof proves nothing and keeps
 * the hold. The ownership is claimed BEFORE the hold exists and released only AFTER the settlement has reached the ledger, so a hold that
 * is in the ledger has an owner for as long as the writer can still write.
 *
 * A HOLD IS NEVER DELETED FOR LACK OF THE WRITER'S WORD (R28, revision 16). Releasing a lock, letting a lease lapse or losing a page
 * establishes that the writer stopped answering; it does not establish that nothing was written, and the bytes of a write that landed
 * are the origin's whether or not anyone was told. Two invariants follow. (1) THE ONLY END OF A HOLD THAT TAKES ITS BYTES OUT OF THE
 * ACCOUNT IS THE WRITER'S OWN `not_written` (or a reservation revoked before its writer could begin, below). Every other end, namely a
 * reclaim on proof, a lapsed lease, a settlement that never got through, moves the bytes into the landed ledger (`liveAt`, `landHold`),
 * against the figure the hold was judged on, where they count for one estimate lifetime, long enough for the estimate to show them;
 * a write that did not happen costs the space for that long, one that did is never forgotten. A `written` settlement is published
 * (`conclude`) until the ledger takes it, holding the ownership meanwhile, so the hold stands whole until it is replaced by its landing
 * in one atomic change, and a change repeated because its answer was lost counts nothing twice (the landing is once per hold). (2) AN
 * AGE CAN ONLY REVOKE THE PERMISSION TO BEGIN. `live()` returning `true` is the writer beginning its transaction (`Held.started`): from
 * then on no time says that the write is not running, so a started reservation is never revoked by `quotaHoldMaxAgeMs` and keeps its
 * hold, its owner and its renewals until the writer settles or its page is gone. A reservation older than the age whose writer has not
 * begun is a leak: its permission is revoked (`live()` is `false` for good) and its hold is taken out as the write that did not happen,
 * which is exact. What this cannot do is know the size of what a transaction that was running when its page was destroyed wrote: those
 * bytes are counted by the landed ledger from the moment another page reclaims the hold, for one estimate lifetime, and by the estimate
 * after that.
 *
 * A READING OF THE ESTIMATE IS AS OLD AS ITS REQUEST, AND A LANDING IS RETIRED ONLY WHEN NO READING THAT COULD LACK IT IS STILL IN USE
 * (R28, revision 17). The landed ledger protects a re-read estimate from the writes it may not show yet, for one estimate lifetime, but
 * that protection is owed to the READING and not to the clock: a reading requested before the lifetime of a landing ended may lack its
 * bytes for as long as it is used, whether it sits in this page's cache for another few seconds, is still on its way back from the
 * browser (an answer is no fresher for arriving late), or was taken by another page. Retiring the debit at its own `until` let such a
 * reading spend bytes whose protection had just gone. So (1) every reading carries the instant its REQUEST began (`Sample.start`),
 * never the instant it was delivered; (2) the cap applies to a judgement whenever its reading began before the entry's `until`
 * (`mayLack`), whatever the clock says at the judgement; (3) the entry is kept one further estimate lifetime after `until` (`liveAt`),
 * the longest a reading that began before it can still be used; (4) a reading that has been used for longer than a lifetime when the
 * judgement is made (the ledger was slow, the clock moved) is not judged at all but asked for again (`usable`, checked INSIDE the atomic
 * change, where the entries are retired, so that a reading is never judged against entries that have gone while it could still need
 * them), and a reservation that cannot be judged on a fresh reading within its tries is refused as `unestablished`, like one the ledger
 * would not answer; (5) a reading that began before the entry's `until` and is judged AFTER it (the debit has run out meanwhile) is not
 * capped but replaced: the guard asks for a new reading at that boundary (`needsNewer`), which, being requested after `until`, shows the
 * write (the lag the estimate is assumed to have is one lifetime), where inside the lifetime nothing newer can show it yet and the
 * reading is capped; (6) after a write it knows of, the guard asks for a new reading too (`invalidate` drops the request on its way as
 * well as the cache). A request that began before a landing is never mistaken for one that began after it, so the debit lasts exactly as
 * long as a reading that could need it, and no longer: nothing is waited for its own sake, and an estimate is not asked for more than
 * once at a boundary.
 *
 * A STEP OF THE WALL CLOCK IS NO PROOF OF ANYTHING (R28, revision 17). The stamps in the ledger are read from the wall clock, the only one
 * the pages of an origin share, and it stays the one scale: no page reads a corrected clock, so no page reads another's stamps shifted
 * and no repair made in one scale is an error in another (`quota-clock.ts`). What a step changes is what the guard CONCLUDES from a stamp,
 * and that is repaired in the ledger itself, where every page sees it: a stamp that ends further ahead than its lifetime allows (the clock
 * moved BACK) is clamped to one lifetime from now, never dropped and never believed, and written back, so the next look does not extend it
 * afresh; a page that finds a step FORWARDS (by the page's monotonic clock, where one is supplied: production passes `performance.now()`)
 * takes every landed entry to have just landed for one lifetime of real time and writes that back (`liveAt`, `distrust`); a reading
 * stamped after the clock went back has no age and is asked for again, and a step found drops every reading (their stamps are in the scale
 * before it).
 *
 * A PAGE IS NOT TRUSTED WITH THE AGE OF A STAMP IT DID NOT LIVE THROUGH (R28, revision 18). A page constructed AFTER a forward step has no
 * earlier reading of its clocks to compare, and the stamps another page wrote before the step look as old as the step is long: reading
 * that age as time that passed deleted a debit the estimate had not yet caught up with (an hour's step, a second save admitted about 54 ms
 * after the first, whether the writing page was alive or not and whichever page reached the ledger first). What a page can say is the
 * reading its own clocks have been checked from (`QuotaClock.anchor()`: its construction, and again at any step it finds, in either
 * direction; a wall clock that reads less than the anchor has been set back and re-anchors it, with or without a second clock). An entry
 * stamped as landing AFTER the anchor was written within a stretch this page has verified, and its stamp is believed as it always was. An
 * entry stamped as landing BEFORE it may have been written on the far side of a step this page cannot see, and the page takes it to have
 * landed no earlier than its anchor (`liveAt`, `reaches`): it caps the readings that began before one lifetime after the anchor, and it is
 * retired one lifetime after that. An abandoned debit (its page gone) is therefore still recovered, within a bound of two lifetimes from the
 * start of whichever page looks, and a debit is never forgotten by a page that cannot know how old it is. That view is the PAGE'S: it is
 * never written back (a page's look at the ledger must not extend an entry for the others, or two pages looking at each other's would
 * extend it for ever), only a retirement it is entitled to, a clamp and a distrusted extension are. A REFUSAL that only this view makes
 * (believing the entry's own stamp, the write would fit) is a refusal for want of knowledge, not of space, and says `unestablished`: the
 * sync engine asks again, paced, instead of stopping with a storage notice, and the advisory `check` stops nothing on it; every writer is
 * refused all the same, which is what the reserve is. What a clock still cannot tell is not
 * claimed: a step LIVED THROUGH by a page that has no monotonic clock cannot be found (production always supplies `performance.now()`),
 * and a difference below `quotaClockSlackMs` is jitter.
 */
export interface StorageLike {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

/**
 * The bytes of one write held against the estimate while it is in flight. `settle` is idempotent: `written` drops the cached
 * estimate (the next check reads the origin's free space again, which includes this write and every other tab's) and records the
 * write in the ledger of writes the estimate may not show yet (below), `not_written` only releases the hold. A settlement is PUBLISHED to
 * the origin's ledger until it is taken, and the writer's ownership of the hold is kept until it is (R28, revision 16): the bytes stay
 * counted whatever the ledger does meanwhile. Only `not_written`, the writer's word that nothing was written, takes bytes out of the
 * account for good; say `written` for a transaction that may have committed.
 */
export interface QuotaReservation {
  readonly verdict: QuotaVerdict;
  /**
   * `true` on a REFUSAL made because the origin's accounting could not be established (the ledger would not answer, or the ownership of
   * the hold could not be taken), never because the space is short (R28, revision 15). A consumer that treats a refusal as exhaustion
   * (a storage-full stop) must not treat this one so: nothing is known to be full.
   */
  readonly unestablished?: boolean;
  /**
   * Whether the write may still BEGIN: the hold is unsettled and every other page still counts it, with a third of its lease to spare
   * (R28). Synchronous and cheap, for the step that creates the write's transaction; a write that finds it `false` writes nothing and
   * asks for admission again. A refused reservation is never live. A `true` answer IS the writer beginning (R28, revision 16): from then
   * on the guard treats the write as possibly running, and no age revokes the reservation; ask it only in the step that begins the
   * transaction. A `false` answer begins nothing.
   */
  live(): boolean;
  settle(outcome: "written" | "not_written"): void;
}

export interface QuotaGuard {
  /** Refreshes the cached estimate if it is stale; never rejects. Counts the writes already held in flight, in every page. */
  check(kind: QuotaKind, estimatedBytes?: number): Promise<QuotaVerdict>;
  /**
   * Checks, and unless the verdict is a refusal holds `estimatedBytes` against the estimate until `settle` is called, so two
   * saves in flight at once near exhaustion are each judged with the other's bytes counted, whichever page made the other. A refused
   * reservation holds nothing.
   */
  reserve(kind: QuotaKind, estimatedBytes: number): Promise<QuotaReservation>;
  /** The last known free bytes, or null; for reports. */
  lastFree(): number | null;
  /**
   * Drops the cached estimate AND the request for one that is on its way (after a commit, or another tab's): the next judgement asks
   * for a reading that begins after this call (R28, revision 17). A caller already waiting for the old request still gets its answer,
   * which is as old as its request and is judged as such.
   */
  invalidate(): void;
  /** Lets go of what the guard holds open (the origin ledger's connection). Optional: a double has nothing to release. */
  close?(): void;
}

type GuardConfig = Pick<
  DataConfig,
  "quotaReserveBytes" | "quotaEstimateTtlMs"
> &
  Partial<
    Pick<
      DataConfig,
      | "quotaHoldLeaseMs"
      | "quotaLedgerWaitMs"
      | "quotaHoldMaxAgeMs"
      | "quotaLedgerAttempts"
      | "quotaLedgerRetryMs"
      | "quotaClockSlackMs"
    >
  >;

/**
 * What one judgement says: the free space it was made against (after the cap of the landed ledger) and the verdict. `unestablished` is a
 * REFUSAL that only this page's view of an entry it did not live through makes (R28, revision 18): believing the entry's own stamp the
 * write would fit. It is a refusal for want of knowledge, not of space, and says so, like one the ledger would not answer.
 */
interface Judgement {
  effective: number | null;
  verdict: QuotaVerdict;
  unestablished?: boolean;
}

/**
 * One reading of the origin's free space, stamped with the instant its REQUEST began (R28, revision 17), never the instant it was
 * delivered: the browser computed it at some point after the request, so the request is the latest moment it is known to have been taken
 * at, and a reading is no fresher for arriving late. `free` is `null` when the estimate is missing or throws (the approved `unknown`).
 */
interface Sample {
  readonly start: number;
  readonly free: number | null;
}

/** A request for a reading that is on its way: the instant it began, and what it will answer. */
interface PendingSample {
  readonly start: number;
  readonly taken: Promise<Sample>;
}

/**
 * The ledger as it is at `now`: what has lapsed is gone. The landed entry is RETIRED one estimate lifetime after its `until` (R28,
 * revision 17), not at it: after `until` it no longer caps a reading requested after `until` (`mayLack`), but a reading requested before
 * it may still be in use for up to a lifetime (a cache entry, an answer that arrived late, another page's), and retiring the entry at
 * `until` would let that reading spend bytes whose protection had just been taken away. A reading is never judged once it is older than a
 * lifetime (`usable`), so by the time the entry is gone no reading that could need it is left. An entry that ends further ahead than its
 * own lifetime allows (the clock moved back since it was made, or its writer's clock was ahead) is NOT dropped, which would read a step
 * of the clock as proof that the write is reflected in the estimate: it is CLAMPED to one lifetime from `now` (`adjusted`: the change that
 * a look must write back, or the next look would extend it afresh), which keeps it at least as long as the write needs and no longer than
 * one lifetime past this look. A page that has just found a step of the wall clock FORWARDS (`distrust`, from `quota-clock.ts`) cannot
 * tell how old any stamp really is, and says so in the only way that cannot lose a byte: for one lifetime of real time, every landed entry
 * it looks at is taken to have just landed (its end is `now` plus one lifetime), and that is written back too (`adjusted`), so that every
 * page finds the debit where the write put it, in the one scale all of them read (the wall clock). An entry that is stamped as landing
 * before this guard's own `anchor` (R28, revision 18: its clocks began to be checked after that) is not judged by the age its stamp gives
 * it: it is taken to have landed no earlier than the anchor (`reaches`), for the cap, the boundary and the retirement alike, and what a
 * judgement reads of it (`view`) is not what a change writes back (`state`). (A hold of a ledger that cannot outlive its page has no end,
 * and no limit applies to it.)
 *
 * A HOLD THAT ENDS BY ANYTHING BUT ITS WRITER'S SETTLEMENT IS NOT DELETED (R28, revision 16). A lapsed lease and a released owner say that
 * the page stopped answering or let go; they do not say that nothing was written, and a writer whose settlement could not be published,
 * whose page was destroyed with a transaction committing, or whose lease ran out while it was suspended may have put its bytes into the
 * store. So the bytes move into the landed ledger (`landHold`, against the figure the hold was judged on, or `figure` for a hold that
 * recorded none) and lapse with it, one estimate lifetime from now: a write that never happened costs the space for that long, and one
 * that did is counted until the estimate can show it. An OWNED hold is never judged by the clock (R28, revision 15): it ends here only
 * when `proven` names its token, that is, when its owner has been shown to have let go.
 */
function liveAt(
  state: LedgerState,
  now: number,
  limits: { leaseMs: number; ttlMs: number },
  proven?: ReadonlySet<string>,
  figure: number | null = null,
  distrust = false,
  anchor: number = Number.NEGATIVE_INFINITY,
): {
  state: LedgerState;
  view: LedgerState;
  changed: boolean;
  adjusted: boolean;
} {
  let changed = false;
  let adjusted = false;
  let landed = state.landed;
  /**
   * An entry whose stamp says it landed before this guard's clocks began to be checked (`anchor`, `quota-clock.ts`) was written on a stretch
   * of time this page cannot vouch for: a step of the wall clock may lie between that stamp and now, and nothing a page that opened after
   * it can read shows how long ago the write really landed (R28, revision 18). It is taken to have landed no earlier than the anchor, so
   * that it caps the readings that began before one lifetime after it and is retired one lifetime after that, as the entry of a write this
   * page saw land is. (Never later than now: a clock set back below its own anchor.) A stamp made after the anchor is believed.
   */
  const unwitnessed = (entry: LedgerLanded): boolean =>
    entry.until - limits.ttlMs < anchor;
  const reaches = (entry: LedgerLanded): number =>
    unwitnessed(entry)
      ? Math.max(entry.until, Math.min(anchor, now) + limits.ttlMs)
      : entry.until;
  if (landed !== null) {
    if (distrust && landed.until < now + limits.ttlMs) {
      landed = { ...landed, until: now + limits.ttlMs };
      changed = true;
      adjusted = true;
    } else if (now >= reaches(landed) + limits.ttlMs) {
      landed = null;
      changed = true;
    } else if (landed.until - now > limits.ttlMs) {
      landed = { ...landed, until: now + limits.ttlMs };
      changed = true;
      adjusted = true;
    }
  }
  const holds: LedgerState["holds"] = {};
  for (const [token, hold] of Object.entries(state.holds)) {
    const ended =
      hold.owned === true
        ? proven?.has(token) === true
        : !(
            now < hold.until &&
            (hold.until === Number.POSITIVE_INFINITY ||
              hold.until - now <= limits.leaseMs)
          );
    if (ended) {
      landed = landHold(landed, token, hold, now, limits.ttlMs, figure);
      changed = true;
    } else holds[token] = hold;
  }
  const next = changed ? { holds, landed } : state;
  // What a judgement reads is this guard's view of the entry (`reaches`); what is written back is only what a stamp itself says.
  return {
    state: next,
    view:
      landed === null || !unwitnessed(landed)
        ? next
        : { holds: next.holds, landed: { ...landed, until: reaches(landed) } },
    changed,
    adjusted,
  };
}

/** The most owned holds of other pages that one judgement asks the owners about (the work is bounded; the rest stay counted). */
const PROOF_LIMIT = 32;

/** The ledger could not answer a call within the tries and the wait it is given: the accounting is not established. */
class LedgerUnavailable extends Error {}

/** One reservation this guard still holds in the origin's ledger, for as long as it is unsettled. */
interface Held {
  readonly token: string;
  readonly born: number;
  /** What the hold promised, and the free space it was judged against (what its landing caps the estimate with); `null`: no figure. */
  readonly bytes: number;
  readonly base: number | null;
  /** The end of the lease as the ledger last confirmed it; `Infinity` for a hold that cannot outlive its page. */
  until: number;
  /** Another page (or time) removed the hold: the writer's permission is over for good, never revived. */
  lost: boolean;
  /**
   * The writer read `live()` as `true`, in the step that begins its transaction (R28, revision 16): from then on the write may be running
   * and no time can say that it is not, so the reservation is never revoked by age; only the writer's settlement (or the death of its
   * page) ends the accounting for it. A reservation whose writer has not begun is another matter: its permission to begin can be revoked.
   */
  started: boolean;
  /** The reservation was revoked at `quotaHoldMaxAgeMs` before its writer began: its permission to begin is over, its hold is being taken out. */
  revoked: boolean;
  settled: boolean;
  /** The ownership of the hold, kept until the settlement has been asked of the ledger (or the hold is let go as a leak). */
  claim: { release(): void } | null;
}

export function createQuotaGuard(options: {
  storage: StorageLike | undefined;
  /** The wall clock (`Date.now()`): the one clock the pages of an origin share, and what every stamp in the origin's ledger is read from. */
  now(): number;
  /**
   * The page's monotonic clock (`performance.now()`), with which the guard finds a STEP of the wall clock FORWARDS and, for one lifetime
   * of real time, takes every landed entry to have just landed (R28, revision 17; `quota-clock.ts`). Omitted: a step forwards cannot be
   * told from time passing.
   */
  monotonic?: () => number;
  config?: GuardConfig;
  /**
   * The ledger of what every page of the origin has promised and written. Omitted: the in-realm ledger of the estimate source, shared
   * by every guard over it (one page's guards agree with each other). The production composition passes the origin's (IndexedDB).
   */
  ledger?: OriginLedger;
}): QuotaGuard {
  const config = options.config ?? DATA_CONFIG;
  const leaseMs = config.quotaHoldLeaseMs ?? DATA_CONFIG.quotaHoldLeaseMs;
  const waitMs = config.quotaLedgerWaitMs ?? DATA_CONFIG.quotaLedgerWaitMs;
  const maxAgeMs = config.quotaHoldMaxAgeMs ?? DATA_CONFIG.quotaHoldMaxAgeMs;
  const attempts = Math.max(
    1,
    config.quotaLedgerAttempts ?? DATA_CONFIG.quotaLedgerAttempts,
  );
  const retryMs = config.quotaLedgerRetryMs ?? DATA_CONFIG.quotaLedgerRetryMs;
  const clockSlackMs =
    config.quotaClockSlackMs ?? DATA_CONFIG.quotaClockSlackMs;
  /** The lease is renewed this often, and `live()` ends this long before the lease can: a write that begins has this long to land. */
  const thirdMs = Math.max(1, Math.floor(leaseMs / 3));
  const limits = { leaseMs, ttlMs: config.quotaEstimateTtlMs };
  const shared = options.ledger ?? ledgerFor(options.storage);
  const owners = shared.shared ? shared.owners : undefined;
  /** The reading in use, the request on its way, and which generation of readings a request belongs to (see `invalidate`). */
  let cached: Sample | null = null;
  let pending: PendingSample | null = null;
  let epoch = 0;
  /** Forgets every reading: the cache, and the request on its way (whose answer is still given to those already waiting, but never kept). */
  const dropReadings = (): void => {
    cached = null;
    pending = null;
    epoch += 1;
  };
  /**
   * The guard's time (R28, revision 17): the wall clock, read as it is, which a step may move; the page's monotonic clock, where there is
   * one, finds a step FORWARDS (`quota-clock.ts`), and the readings made before any step are dropped: they were stamped in the scale
   * before it.
   */
  const clock = createQuotaClock({
    wall: () => options.now(),
    monotonic: options.monotonic,
    slackMs: clockSlackMs,
    windowMs: config.quotaEstimateTtlMs,
    onStep: dropReadings,
  });
  const time = (): number => clock.now();
  /**
   * The ledger as it is at `now` (see `liveAt`), with what the clock says of whether a stamp can be believed: `state` is what a change
   * writes back, `view` what a judgement reads (R28, revision 18). Ask it after `time()`.
   */
  const aged = (
    state: LedgerState,
    now: number,
    proven?: ReadonlySet<string>,
    figure: number | null = null,
  ) =>
    liveAt(
      state,
      now,
      limits,
      proven,
      figure,
      clock.distrusted(),
      clock.anchor(),
    );
  let lastEffective: number | null = null;
  const guardId = Math.random().toString(36).slice(2, 10);
  let serial = 0;

  /**
   * What the origin's ledger last showed this guard: every hold (its own that are still outstanding, and the other pages') and the writes
   * that have landed. It is what the ADVISORY `check` judges on when the ledger cannot be read; a reservation never is: it is admitted
   * only by an answer of the ledger. Every change this guard makes to the ledger updates it too, so a promise it has settled is not
   * counted again.
   */
  let lastSeen: LedgerState = EMPTY_LEDGER;
  const remember = (state: LedgerState): void => {
    lastSeen = {
      holds: { ...state.holds },
      landed: state.landed === null ? null : { ...state.landed },
    };
  };

  const refresh = async (): Promise<number | null> => {
    const estimate = options.storage?.estimate;
    if (typeof estimate !== "function") return null;
    try {
      return freeBytes(await estimate.call(options.storage));
    } catch {
      return null;
    }
  };
  /**
   * A reading is used for one estimate lifetime from the instant its REQUEST began, and never when that age is negative (the clock moved
   * back: a stamp from the future says nothing about how old it is).
   */
  const fresh = (reading: Sample, now: number): boolean => {
    const age = now - reading.start;
    return age >= 0 && age < config.quotaEstimateTtlMs;
  };
  /** Whether a reading may be judged at `now`: one that is no older than a lifetime, or one that says nothing (`unknown`: nothing to protect). */
  const usable = (reading: Sample, now: number): boolean =>
    reading.free === null || fresh(reading, now);
  /**
   * Whether a judgement at `now` needs a NEWER reading than this one (R28, revision 17): it is too old to be judged (`usable`), or it
   * began before the landed entry's `until` and the entry's lifetime is over, so the debit that protected it has run out and a request
   * made now would show the write. Inside the lifetime nothing newer can show the write yet, and the reading is capped instead
   * (`mayLack`). Asking again at that boundary is what lets the guard stop counting the debit without trusting a reading that predates it.
   */
  const needsNewer = (
    state: LedgerState,
    reading: Sample,
    now: number,
  ): boolean =>
    !usable(reading, now) ||
    (reading.free !== null &&
      state.landed !== null &&
      reading.start < state.landed.until &&
      now >= state.landed.until);
  /**
   * Whether a reading may lack the writes of the landed entry (R28, revision 17): it began before the entry's `until` (the estimate has
   * shown a write once a lifetime has passed since it landed, so a request that began after `until` shows it), or it is too old to be
   * judged against what has been retired. Neither is a question for the clock now: a reading is as old as its request.
   */
  const mayLack = (
    landed: LedgerLanded,
    reading: Sample,
    now: number,
  ): boolean => !fresh(reading, now) || reading.start < landed.until;

  /**
   * The origin's free space as the browser reports it, as a reading stamped with the instant its request began, used for one estimate
   * lifetime (the ledger's cap is applied at judgement). A request on its way is JOINED, unless the caller needs a reading whose
   * request began no earlier than `since` (a judgement that found its reading too old asks for a new one: `reserve`). The answer of a
   * request is kept only if it is the newest and nothing has dropped the readings since it began (`invalidate`, a step of the clock).
   */
  const readSample = async (
    since = Number.NEGATIVE_INFINITY,
  ): Promise<Sample> => {
    const now = time();
    if (cached !== null && cached.start >= since && fresh(cached, now))
      return cached;
    if (pending !== null && pending.start >= since) return pending.taken;
    const start = now;
    const asked = epoch;
    const taken = refresh().then((free): Sample => {
      const reading: Sample = { start, free };
      if (epoch === asked && (cached === null || cached.start <= start))
        cached = reading;
      return reading;
    });
    const request: PendingSample = { start, taken };
    pending = request;
    void taken.finally(() => {
      if (pending === request) pending = null;
    });
    return taken;
  };

  /**
   * The free space the reading and the ledger leave for a write, and the verdict: `min(reading, base - landed)` while the reading may lack
   * the landed writes (`mayLack`), less every hold that has not lapsed (the write's own, `mine`, excluded: a call that is asked again
   * must not count the hold an earlier try already made).
   */
  const judge = (
    state: LedgerState,
    reading: Sample,
    now: number,
    kind: QuotaKind,
    estimatedBytes: number,
    mine?: string,
    /** The landed entry as its stamps say it is, where `state` carries this page's view of it (`liveAt`). */
    stamped: LedgerLanded | null = state.landed,
  ): Judgement => {
    const capped = (
      landed: LedgerLanded | null,
      figure: number | null,
    ): number | null =>
      figure !== null && landed !== null && mayLack(landed, reading, now)
        ? Math.min(figure, Math.max(0, landed.base - landed.landed))
        : figure;
    const effective = capped(state.landed, reading.free);
    let held = 0;
    for (const [token, hold] of Object.entries(state.holds))
      if (token !== mine) held += hold.bytes;
    const room = (figure: number | null): number | null =>
      figure === null ? null : Math.max(0, figure - held);
    const verdict = decideQuota(room(effective), kind, estimatedBytes, config);
    // A refusal that the entry's own stamp would not have made is the page's lack of knowledge, not the space's.
    const believed =
      verdict === "refuse" && stamped !== state.landed
        ? decideQuota(
            room(capped(stamped, reading.free)),
            kind,
            estimatedBytes,
            config,
          )
        : verdict;
    return {
      effective,
      verdict,
      ...(verdict === "refuse" && believed !== "refuse"
        ? { unestablished: true }
        : {}),
    };
  };
  /**
   * What the ledger last showed, as it stands at `now` (for the advisory `check` when the ledger cannot be read). The memory is AGED, not
   * merely read: a hold that has lapsed since lands once (`liveAt`), and that landing lapses in its turn, instead of being landed again
   * from every later call.
   */
  const lastKnown = (now: number) => {
    const live = aged(lastSeen, now);
    remember(live.state);
    return live;
  };

  const silent = new Error("the quota ledger did not answer");
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
  /**
   * Runs one call on the origin's ledger, within `quotaLedgerWaitMs`. A call the ledger REJECTS is asked again (up to `tries`, with a short
   * doubling wait): the rejection is immediate and the failure of a tiny record is usually transient. A call it does not ANSWER within
   * the wait is ABANDONED: the ticket it was given says so, and a change that reaches the ledger after that applies nothing. Either way,
   * when the tries are used up the accounting is NOT established and the caller must not go on as though it were: `LedgerUnavailable`.
   * A ledger that lives and dies with one realm is just called.
   */
  const through = async <T>(
    run: (ticket: { abandoned: boolean }) => Promise<T>,
    tries: number,
  ): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ticket = { abandoned: false };
      try {
        const pending = run(ticket);
        return shared.shared
          ? await Promise.race([
              pending,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(silent), waitMs);
              }),
            ])
          : await pending;
      } catch (error) {
        ticket.abandoned = true;
        if (error === silent || attempt >= tries) throw new LedgerUnavailable();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      await sleep(retryMs * 2 ** (attempt - 1));
    }
  };
  /** Takes a hold out of the ledger, once, within the wait, ignoring every failure (it lapses or is reclaimed otherwise). */
  const forget = (token: string): void => {
    if (!shared.shared) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      shared.update((state) => {
        if (!(token in state.holds)) return { state: null, result: undefined };
        const holds = { ...state.holds };
        delete holds[token];
        return { state: { holds, landed: state.landed }, result: undefined };
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(silent), waitMs);
      }),
    ])
      .catch(() => undefined)
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
  };

  /**
   * Writes back what a read-only look found out of line with the clock (`adjusted`, R28, revision 17): one change of the ledger, once,
   * within the wait, ignoring every failure (the next change anyone makes finds it again and writes it). A ledger of one realm is just
   * called.
   */
  const repair = (figure: number | null): void => {
    const change = (): Promise<void> =>
      shared.update((state) => {
        const live = aged(state, time(), undefined, figure);
        return { state: live.changed ? live.state : null, result: undefined };
      });
    if (!shared.shared) {
      void change().catch(() => undefined);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      change(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(silent), waitMs);
      }),
    ])
      .catch(() => undefined)
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
  };

  // ---- the end of a reservation is PUBLISHED, and its bytes stay counted until it is ---------------------------------------------------
  /** How many times `close()` has been called: a publication started before it gives up (and lets go of its ownership) when it sees a new one. */
  let closes = 0;
  const pauses = new Set<() => void>();
  /** A wait of the paced publication, ended early by `close()`. */
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        pauses.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      // A settlement still being offered must never be what keeps a process alive.
      (timer as { unref?: () => void }).unref?.();
      pauses.add(wake);
    });
  /**
   * Publishes the END of a reservation to the origin's ledger: ONE atomic change that takes its hold out and, for a write that landed
   * (`written`), puts its bytes into the landed ledger (`landHold`: once per hold, so a change repeated because its answer was lost
   * counts nothing twice). Another page never sees the bytes in neither. Into the ledger whatever the cache looks like now: against the
   * figure this write was judged on, or added to the writes already in it (which were judged on the same or an older figure, and are all
   * still unreflected for as long as the ledger stands). A write judged on no figure (the estimate was unavailable) has nothing to cap.
   *
   * THE BYTES STAY COUNTED UNTIL THE LEDGER HAS TAKEN THE CHANGE (R28, revision 16). A change the ledger rejects is asked again at once,
   * then offered again, paced (a doubling wait up to `quotaLedgerWaitMs`, for as long as one lease), and for all that time the writer
   * KEEPS its ownership: its hold stands in the ledger, counted whole, and no other page can prove it over. A call that never answers
   * is simply waited for (the ledger's own bound ends it), and one that is applied but whose answer is lost is asked again harmlessly.
   * Only when the ledger has taken the change, or this guard is closed, or the offer has been made for a lease without success, is the
   * ownership given up; a hold still in the ledger then is reclaimed by whichever page next needs the room, and its bytes land
   * (`liveAt`), so a settlement that never got through costs the space for one estimate lifetime and never frees it as though nothing
   * had been written. The writer's own `not_written` is the only word that removes a hold without landing it.
   */
  const conclude = (held: Held, outcome: "written" | "not_written"): void => {
    const generation = closes;
    const ended = (state: LedgerState): LedgerChange<void> => {
      const now = time();
      // The reservation's own hold is not judged by its lease: the writer's word decides it.
      const { [held.token]: _own, ...others } = state.holds;
      // (A hold of another page that recorded no figure, written by an older build, is landed against this reservation's own.)
      const live = aged(
        { holds: others, landed: state.landed },
        now,
        undefined,
        held.base,
      );
      const left: LedgerState = {
        holds: live.state.holds,
        landed:
          outcome === "written"
            ? landHold(
                live.state.landed,
                held.token,
                held,
                now,
                limits.ttlMs,
                null,
              )
            : live.state.landed,
      };
      if (shared.shared) remember(left);
      return { state: left, result: undefined };
    };
    void (async () => {
      let pace = retryMs;
      let waited = 0;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await shared.update(ended);
          break;
        } catch {
          // A ledger of one realm does not fail; a closed guard offers no more.
          if (!shared.shared || generation !== closes) break;
          // Two quick tries, then paced for as long as a lease lasts.
          if (attempt >= 2) {
            if (waited >= leaseMs) break;
            await pause(pace);
            waited += pace;
            pace = Math.min(2 * pace, waitMs);
            if (generation !== closes) break;
          }
        }
      }
      held.claim?.release();
    })();
  };

  // ---- the lease of a reservation is kept for as long as the write may still begin ---------------------------------------------------
  const tracked = new Set<Held>();
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (renewTimer !== undefined || tracked.size === 0) return;
    renewTimer = setTimeout(() => {
      renewTimer = undefined;
      void renewAll();
    }, thirdMs);
    // A reservation must never be what keeps a process alive.
    (renewTimer as { unref?: () => void }).unref?.();
  };
  const untrack = (held: Held): void => {
    tracked.delete(held);
    if (tracked.size === 0 && renewTimer !== undefined) {
      clearTimeout(renewTimer);
      renewTimer = undefined;
    }
  };
  /**
   * Extends the lease of one reservation, in the ledger that holds it. A ledger that does not answer leaves the lease where it was (the
   * next tick tries again, and `live()` ends by itself a third of a lease before the lease does); a hold that is no longer in the ledger
   * ended: another page may already have counted the space as free, and this writer must be admitted afresh, never revived.
   *
   * A reservation older than `quotaHoldMaxAgeMs` whose writer has NOT BEGUN (it never read `live()` as `true`) is a leak, not a save: its
   * permission to begin is revoked for good (`live()` is `false` from now on) and its end is published as a write that did not happen,
   * which is exact, because a writer that cannot begin writes nothing. One whose writer HAS begun is not touched by its age (R28, revision
   * 16): its transaction may be committing at this very moment, no time says it is not, and so its hold keeps its owner and its renewals
   * until the writer's own settlement (or the death of its page) ends the accounting. Revoking the permission to BEGIN is all an age can do.
   */
  const renewOne = async (held: Held): Promise<void> => {
    if (held.settled) return;
    if (!held.started && time() - held.born >= maxAgeMs) {
      held.lost = true;
      held.revoked = true;
      untrack(held);
      conclude(held, "not_written");
      return;
    }
    const ticket = { abandoned: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        shared.update<number | "gone" | "skipped">((state) => {
          if (ticket.abandoned || held.settled)
            return { state: null, result: "skipped" };
          const now = time();
          const live = aged(state, now, undefined, held.base);
          const hold = live.state.holds[held.token];
          if (hold === undefined) {
            remember(live.state);
            return { state: live.changed ? live.state : null, result: "gone" };
          }
          const until = now + leaseMs;
          const next: LedgerState = {
            holds: { ...live.state.holds, [held.token]: { ...hold, until } },
            landed: live.state.landed,
          };
          remember(next);
          return { state: next, result: until };
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(silent), waitMs);
        }),
      ]);
      if (held.settled) return;
      if (answer === "gone") {
        held.lost = true;
        untrack(held);
        held.claim?.release();
      } else if (typeof answer === "number") held.until = answer;
    } catch {
      // The next tick asks again; a change that arrives after this gives up applies nothing.
      ticket.abandoned = true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const renewAll = async (): Promise<void> => {
    await Promise.all([...tracked].map(renewOne));
    arm();
  };
  /** Whether the write this reservation admitted may still begin: unsettled, and every other page still counts the hold, with a third of a lease to spare. */
  const liveNow = (held: Held): boolean =>
    !held.settled &&
    !held.lost &&
    (held.until === Number.POSITIVE_INFINITY || time() < held.until - thirdMs);

  /** What a refusal made without the origin's accounting looks like to the caller (nothing is held, nothing is live). */
  const unestablishedFor = (free: number | null): QuotaReservation =>
    free === null
      ? // No estimate: nothing to protect and the approved behaviour is `unknown`: the write relies on its own failure.
        { verdict: "unknown", live: () => true, settle: () => undefined }
      : {
          verdict: "refuse",
          unestablished: true,
          live: () => false,
          settle: () => undefined,
        };

  /** The result of one judgement-and-hold of the ledger. */
  interface Admission extends Judgement {
    until: number;
    /** The owned holds of other pages that the judgement counted: the ones whose owners may be asked. */
    candidates: string[];
    /**
     * The reading was older than a lifetime when the change was applied, or began before a debit that has run out by now (R28, revision
     * 17): nothing was judged and nothing held, and the reservation asks again on a new reading. Judging the first would have been judging
     * against entries that had been retired while it could still have needed them, the second counting a write the new reading shows.
     */
    stale: boolean;
  }

  return {
    async check(kind, estimatedBytes = 0) {
      let taken = await readSample();
      let judged: Judgement | null = null;
      try {
        for (let round = 1; judged === null; round += 1) {
          const reading = taken;
          const looked = await through(
            () =>
              shared.peek((state) => {
                const now = time();
                const live = aged(state, now, undefined, reading.free);
                if (shared.shared) remember(live.state);
                return {
                  judged: judge(
                    live.view,
                    reading,
                    now,
                    kind,
                    estimatedBytes,
                    undefined,
                    live.state.landed,
                  ),
                  adjusted: live.adjusted,
                  newer: needsNewer(live.view, reading, now),
                };
              }),
            // Advisory: a rejection is asked once more (it costs no wait to speak of), and no more.
            Math.min(2, attempts),
          );
          // A look is read-only, and an entry it clamped (or took to have just landed) would be adjusted again, to a later end, by every look
          // that follows: write it back.
          if (looked.adjusted) repair(reading.free);
          // A reading that predates a debit that has run out is not the one to judge on (an advisory refusal stops the engine): ask again,
          // a bounded number of times, and judge on the last one with the cap on if the answer is still not a fresh one.
          if (looked.newer && round < attempts)
            taken = await readSample(time());
          else judged = looked.judged;
        }
      } catch {
        // ADVISORY: the engine's early refusal, before a request. It counts every promise it knows of (its own, and what the origin last
        // showed) but assumes none it does not, and refuses nothing on a guess: the reservation that admits the page at its commit is the
        // authority, and that one is refused when the origin cannot answer.
        const now = time();
        const known = lastKnown(now);
        judged = judge(
          known.view,
          taken,
          now,
          kind,
          estimatedBytes,
          undefined,
          known.state.landed,
        );
      }
      lastEffective = judged.effective;
      // ADVISORY: a refusal that rests only on this page's lack of knowledge of an entry (R28, revision 18) stops nothing; the reservation
      // that admits the write is the authority, and it refuses, as `unestablished`, for as long as the lack lasts.
      return judged.unestablished === true ? "unknown" : judged.verdict;
    },
    async reserve(kind, estimatedBytes) {
      let taken = await readSample();
      serial += 1;
      const token = `${guardId}:${serial}`;
      // The OWNERSHIP of the hold is taken before the hold exists: a hold that is in the ledger has an owner for as long as its writer can
      // still write. Without one (the lock manager failed) the hold could be reclaimed under a suspended writer, so nothing is admitted.
      let claim: { release(): void } | null = null;
      if (owners !== undefined) {
        try {
          claim = await owners.claim(token);
        } catch {
          claim = null;
        }
        if (claim === null) return unestablishedFor(taken.free);
      }
      const ask = (
        proven: ReadonlySet<string>,
        reading: Sample,
      ): Promise<Admission> =>
        through(
          (ticket) =>
            // The judgement and the hold are ONE atomic change of the ledger: two reservations, in this page or another, cannot both be
            // judged without the other's bytes.
            shared.update<Admission>((state) => {
              const now = time();
              const live = aged(state, now, proven, reading.free);
              // A change the guard gave up waiting for is not applied late.
              if (ticket.abandoned)
                return {
                  state: null,
                  result: {
                    effective: reading.free,
                    verdict: "unknown",
                    until: Number.POSITIVE_INFINITY,
                    candidates: [],
                    stale: false,
                  },
                };
              // The reading is judged only while it is no older than the entries that have been retired (the retirement above is this
              // very change), and not after the debit that protected it has run out: such a reading is asked for again, and nothing is
              // held for it.
              if (needsNewer(live.view, reading, now)) {
                if (shared.shared) remember(live.state);
                return {
                  state: live.changed ? live.state : null,
                  result: {
                    effective: reading.free,
                    verdict: "unknown",
                    until: Number.POSITIVE_INFINITY,
                    candidates: [],
                    stale: true,
                  },
                };
              }
              // A call that is asked again (the earlier answer was lost) must not count the hold its own earlier try made.
              const { [token]: _earlier, ...others } = live.state.holds;
              const judged = judge(
                { holds: others, landed: live.view.landed },
                reading,
                now,
                kind,
                estimatedBytes,
                undefined,
                live.state.landed,
              );
              if (judged.verdict === "refuse") {
                if (shared.shared) remember(live.state);
                return {
                  state: live.changed ? live.state : null,
                  result: {
                    ...judged,
                    until: Number.POSITIVE_INFINITY,
                    candidates: Object.entries(others)
                      .filter(([, hold]) => hold.owned === true)
                      .map(([other]) => other)
                      .slice(0, PROOF_LIMIT),
                    stale: false,
                  },
                };
              }
              const until = shared.shared
                ? now + leaseMs
                : Number.POSITIVE_INFINITY;
              const next: LedgerState = {
                holds: {
                  ...live.state.holds,
                  [token]: {
                    bytes: estimatedBytes,
                    until,
                    ...(claim === null ? {} : { owned: true }),
                    // What a landing of this write caps the estimate with, for whoever has to land it (see `liveAt`).
                    base: judged.effective,
                  },
                },
                landed: live.state.landed,
              };
              if (shared.shared) remember(next);
              return {
                state: next,
                result: { ...judged, until, candidates: [], stale: false },
              };
            }),
          attempts,
        );
      /**
       * One judgement-and-hold, asked again on a NEW reading while the one it was made on proves too old to be judged, or to predate a
       * debit that has run out meanwhile (R28, revision 17), as often as the ledger would be asked after a rejection. A reservation that
       * cannot be judged on a fresh reading is not established.
       */
      const admit = async (proven: ReadonlySet<string>): Promise<Admission> => {
        for (let round = 1; ; round += 1) {
          const admitted = await ask(proven, taken);
          if (!admitted.stale) return admitted;
          if (round >= attempts) throw new LedgerUnavailable();
          taken = await readSample(time());
        }
      };
      let admission: Admission;
      try {
        admission = await admit(new Set());
        // Refused with owned holds of other pages counted: ask their owners whether they are over. A `true` PROVES the owner let go (so
        // its hold counts for nothing and the write is judged again); anything else keeps the hold counted. Done only on a refusal, so the
        // ordinary save asks nobody.
        if (
          admission.verdict === "refuse" &&
          admission.candidates.length > 0 &&
          owners !== undefined
        ) {
          const answers = await Promise.all(
            admission.candidates.map(
              async (other) => [other, await owners.released(other)] as const,
            ),
          );
          const over = answers
            .filter(([, released]) => released)
            .map(([other]) => other);
          if (over.length > 0) admission = await admit(new Set(over));
        }
      } catch {
        claim?.release();
        // The change may have been applied just before the wait ended: take it out again, if the ledger can be asked.
        forget(token);
        return unestablishedFor(taken.free);
      }
      lastEffective = admission.effective;
      if (admission.verdict === "refuse") {
        claim?.release();
        return {
          verdict: "refuse",
          // For want of knowledge, not of space (R28, revision 18): the engine asks again, paced, and does not stop with a storage notice.
          ...(admission.unestablished === true ? { unestablished: true } : {}),
          live: () => false,
          settle: () => undefined,
        };
      }
      const held: Held = {
        token,
        born: time(),
        bytes: estimatedBytes,
        base: admission.effective,
        until: admission.until,
        lost: false,
        started: false,
        revoked: false,
        settled: false,
        claim,
      };
      if (held.until !== Number.POSITIVE_INFINITY) {
        tracked.add(held);
        arm();
      }
      return {
        verdict: admission.verdict,
        live() {
          if (!liveNow(held)) return false;
          // The writer reads this in the step that begins its transaction: from here on the write may be running.
          held.started = true;
          return true;
        },
        settle(outcome) {
          if (held.settled) return;
          held.settled = true;
          untrack(held);
          if (outcome === "written") dropReadings();
          // A reservation revoked at its age before its writer began has had its end published already, as the write that did not happen.
          if (held.revoked && outcome === "not_written") return;
          conclude(held, outcome);
        },
      };
    },
    lastFree: () => lastEffective,
    invalidate() {
      // Another tab wrote, or a page committed: read the origin's free space again, with a request that begins now (the one on its way
      // began before whatever this is about). The ledger of recent writes stands (the estimate may not show them yet), and so does every
      // reservation still in flight, in this page and in every other.
      dropReadings();
    },
    close() {
      // A settlement still being offered gives up (and lets go of its ownership: whoever needs the room next lands its hold).
      closes += 1;
      for (const wake of [...pauses]) wake();
      shared.close();
    },
  };
}
