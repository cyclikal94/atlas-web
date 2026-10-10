/**
 * The provisional constants of the data layer, in one module (plan 7.4). NONE is presented as measured: each names the
 * evidence that would settle it (the `settledBy` column of `docs/data-layer.md`). A figure here is a starting point,
 * never a threshold the profiling decided.
 */
const KIB = 1024;
const MIB = 1024 * KIB;

export const DATA_CONFIG = Object.freeze({
  /** The server accepts 1 to 200, but `SyncPage.batches` has `maxItems: 80` (BE-B1 unshipped): never ask for more (D-10). */
  syncLimitMax: 80,
  /** Initial `limit` rung by device class (WEB-03 3.3d). Step-down only; step-up is disabled until measured. */
  initialLimitUnconstrained: 4,
  initialLimitOther: 1,
  /** `null`: step-up is disabled (nothing specifies it). */
  stepUpAfterSuccesses: null as number | null,
  /** Failures at `limit = 1`, counted across attempts and reloads, before the floor state is shown. */
  floorAfter: 3,
  /** A page of at least this many bytes writes the crash-loop marker before it is processed. */
  markerMinBytes: 256 * KIB,
  /**
   * A chunk-boundary check during the apply. It measures the apply alone, so it is kept well inside the persistence hold's bound
   * (the session's `persistenceHoldMs`, 30 s: the whole commit, queue wait and verdict included): an apply that overruns must meet
   * THIS check, which steps the page size down, before the hold is revoked, which only retries (R2, revision 6).
   */
  syncApplyWatchdogMs: 20_000,
  /** Contract maxima: 800 changes per batch, 9 KiB per change including its envelope, plus a margin (WEB-03). */
  maxChangesPerBatch: 800,
  bytesPerChange: 9 * KIB,
  responseMargin: 1.5,
  responseOverhead: 64 * KIB,
  /** The shape gate. */
  maxChangeBytes: 64 * KIB,
  maxValueNodes: 8_192,
  maxDepth: 24,
  /** A scan records at most this many element offsets (512 KiB of `Uint32Array`). */
  maxScanElements: 64_000,
  /** The delta page is written in groups of this many puts. */
  applyChunk: 100,
  /** `/sync` cursor length (`SyncPage.next_cursor` maxLength). */
  maxCursorLength: 512,
  /** The live-edge poll, the post-receipt poll and the back-off. All provisional. */
  syncIdleMs: 60_000,
  syncReceiptMs: 2_000,
  backoffInitialMs: 2_000,
  backoffMaxMs: 60_000,
  backoffJitter: 0.2,
  /** The sustained-failure threshold after which a passive back-off becomes an actionable "Retry now" ("a few minutes"). */
  retrySustainedMs: 180_000,
  /** Three consecutive unrecognised responses, or local write failures, pause the caller (D). */
  unrecognisedPauseAfter: 3,
  localWritePauseAfter: 3,
  /** Q9: the warning above this many queued changes, and the dispatcher's working set. */
  queueWarnAt: 200,
  queueWorkingSet: 100,
  /**
   * How soon the dispatcher looks again when drafts wait behind another draft (a shared target, an unfinished dependency, a hold)
   * and nothing else wakes it. Doubles after each pass that finds nothing, to 60 s, and starts over on any event. Each pass reads at
   * most `queueWorkingSet` candidates per turn through the `[status+created_seq]` index, whatever the length of the queue.
   */
  queueRescanMs: 5_000,
  /**
   * Q9: a page of a list read from the cache (`readResourceList`): never more rows than this, whatever the caller asks. The overlay
   * of the page's resources is read in windows of `queueWorkingSet` effects. Provisional, like every figure here.
   */
  listPage: 100,
  /**
   * The paced re-read of the sync facts after one failed (R13): the first wait, doubling to the largest. A failed read ends the
   * live query that made it, so without a re-read the controller would never learn the display state of that database again.
   */
  factsReadRetryMs: 250,
  factsReadRetryMaxMs: 10_000,
  /** A fence older than this with no pending operation is stale (longer than the 20 s lock wait). */
  fenceStaleMs: 120_000,
  /** Free quota kept for `atlas-auth`; user input is refused only below half of it (unmeasured). */
  quotaReserveBytes: 8 * MIB,
  /**
   * How long one reading of the free space is used, and how long the estimate is ASSUMED to take to show a write that has landed (R28):
   * the landed ledger caps a reading requested before the lifetime of a landing ended, and keeps the entry one further lifetime, the longest
   * such a reading can still be in use (R28, revision 17). Provisional, unmeasured.
   */
  quotaEstimateTtlMs: 5_000,
  /**
   * How far the wall clock may part from the page's monotonic clock between two readings before the guard calls it a STEP of the wall
   * clock and follows the monotonic one (R28, revision 17); a smaller difference is jitter or drift, which nothing is made of. Above the
   * 100 ms to which a browser may round either clock, far below the estimate lifetime. Provisional, unmeasured.
   */
  quotaClockSlackMs: 250,
  /**
   * How long a reservation held in the ORIGIN's ledger stands when the page that made it does not settle it (R28): a page that dies
   * with a write outstanding stops holding its bytes when the lease ends, and those bytes then count as LANDED writes for one estimate
   * lifetime (`quotaEstimateTtlMs`, R28 revision 16), because a lapsed lease does not say that nothing was written. Far longer than a local
   * write takes. Also how long a settlement the ledger will not take is offered again by the writer. Provisional, unmeasured.
   */
  quotaHoldLeaseMs: 30_000,
  /**
   * How old a reservation may be before its permission to BEGIN is revoked (R28, revisions 14 and 16). A guard renews the lease of every
   * reservation it still holds, a third of a lease apart, so a save that is still going on is never counted as free by the other pages. A
   * reservation this old whose writer has not begun (it never read `live()` as `true`) is a leak, not a save: its permission is revoked for
   * good and its hold is taken out as a write that did not happen. A reservation whose writer HAS begun is never revoked by its age: its
   * transaction may be committing at this very moment, and only its own settlement (or the death of its page) ends the accounting for it.
   * Far longer than any save or page commit takes.
   */
  quotaHoldMaxAgeMs: 10 * 60_000,
  /**
   * How long a save waits for the origin's ledger to answer one call (R28): the ledger is a tiny IndexedDB record, so a wait this long
   * means it is not answering. A save the ledger has not answered is REFUSED (R28, revision 15), never admitted on a judgement that did
   * not count the other pages' promises. Provisional, unmeasured.
   */
  quotaLedgerWaitMs: 2_000,
  /**
   * How many times one reservation asks the origin's ledger when it REJECTS the call (R28, revision 15), and the first wait between
   * two tries (doubling): a transient failure of a tiny IndexedDB record is absorbed, while a ledger that stays down leaves the write
   * refused, because nothing else can say what the other pages have promised. Provisional, unmeasured.
   */
  quotaLedgerAttempts: 4,
  quotaLedgerRetryMs: 20,
  /** The probe of an existing database and the cache of its incarnation. */
  probeTimeoutMs: 3_000,
  incarnationCacheMs: 10_000,
  /** Queued writes in flight at once (D-18). */
  maxInFlight: 1,
  /** The stamped request time-out is WEB-08a's (30 s); recorded here only to be reported. */
  stampedRequestTimeoutMs: 30_000,
  /** The bounded wait for `not_sent`, in the schedule WEB-08a used for the Settings lists (about six seconds). */
  notSentBackoffMs: [50, 100, 200, 400, 800, 1000, 1000, 1000, 1000] as const,
  /**
   * The wait for coordinated closure at wipe time (plan 5.3.3): a tab that answered the presence query is waited for until it
   * acknowledges, up to the bound the kernel passes; a tab that did not answer within this grace is not waited for (a frozen
   * tab is protected by `closing` and the digest recheck, and the delete completes the moment it wakes and closes).
   */
  presenceGraceMs: 150,
});

/** The shape of the constants with plain `number`s, so a test or a caller can supply other values than the provisional ones. */
type Widen<T> = {
  -readonly [K in keyof T]: T[K] extends number
    ? number
    : T[K] extends readonly number[]
      ? readonly number[]
      : T[K];
};
export type DataConfig = Widen<typeof DATA_CONFIG>;

/** `maxResponseBytesFor(limit)` (plan 5.4.4): a larger body is a contract violation, not a device limit. */
export function maxResponseBytesFor(
  limit: number,
  config: DataConfig = DATA_CONFIG,
): number {
  return Math.ceil(
    limit *
      config.maxChangesPerBatch *
      config.bytesPerChange *
      config.responseMargin +
      config.responseOverhead,
  );
}
