/**
 * What the quota guard knows of its clock (R28, revision 17).
 *
 * Every stamp the guard writes into the origin's ledger (the end of a lease, the end of a landing's lifetime) and every age it reads (of an
 * estimate, of a reservation) is a reading of ONE clock, and the only clock that every page of the origin shares is the wall clock. It can
 * STEP: the person sets the time, a time service corrects it, a machine resumes. A step is not evidence of anything about the browser's
 * free-space estimate, which has caught up with a write after a stretch of REAL time and not before: a step forwards is no proof that a
 * landing's lifetime has passed, and a step backwards is no proof that the write never happened.
 *
 * THE WALL CLOCK STAYS THE SCALE. A page that read its time from a clock corrected for the steps it has seen would disagree with a page that
 * opened after them (each page reading the stamps of the other shifted by the step), and a repair made in one scale would be an error in the
 * other. So `now()` is the wall clock, read as it is, and every page of the origin always shares one scale. What the steps change is what
 * the guard concludes from a stamp, and that is repaired in the ledger itself, where every page sees it:
 *
 *  - a step BACKWARDS needs no second clock: a stamp that ends further ahead than its lifetime allows is clamped, never dropped
 *    (`quota-guard.ts`, `liveAt`);
 *  - a step FORWARDS makes every stamp look older than it is, and nothing in the wall clock can show it. Where the page has a monotonic clock
 *    (production supplies `performance.now()`), a difference between how far the wall clock moved and how far the monotonic clock moved,
 *    between two readings, larger than `slackMs`, is a step; the guard then DISTRUSTS the wall clock's reading of age for one estimate
 *    lifetime of real time (`distrusted()`): in that time every landed entry it looks at is taken to have just landed, and the change is
 *    written back (`liveAt`), so that every page, whatever it read from its own clock, finds the debit where the write put it. `onStep` says
 *    that a step was found, in either direction (the guard drops what it read before: the readings of free space are stamped in the scale
 *    before it).
 *
 * A PAGE THAT OPENS AFTER A STEP IS NOT TRUSTED WITH A STAMP IT DID NOT LIVE THROUGH (R28, revision 18). A page that opens after a forward step
 * has no readings to compare, and the stamps another page wrote before the step look as old as the step is long: reading that age as
 * time that passed deleted a debit the estimate had not yet caught up with, whichever page had written it and whether or not that page
 * was still alive. What a page CAN say is the reading from which its own clocks have been checked against one another: `anchor()`, the
 * wall clock as it read when this clock began, and again when it last found a step. A stamp that says its entry landed after that reading
 * was made within a stretch this page has verified, and its age is believed; a stamp that says it landed before it was made may have been
 * written on the far side of a step this page cannot see, and the entry is taken to have landed no earlier than the anchor
 * (`quota-guard.ts`, `liveAt`). That costs a debit left by an earlier page at most one lifetime more of cap and one more of retention from
 * the moment this page began, and it needs no second clock: the anchor is the reading of a page that opened after a step too.
 *
 * What this cannot do, and does not claim: a step that a page lives through without a monotonic clock cannot be found (a guard with no
 * monotonic clock believes the stamps it reads after its own anchor; production always supplies one); a difference below `slackMs` is
 * indistinguishable from the jitter to which a browser rounds its clocks and from the drift of the wall clock against the monotonic one,
 * and is not acted on.
 */
export interface QuotaClock {
  /** The wall clock, in milliseconds, as it reads. A reading is also the moment a step since the last one is found. */
  now(): number;
  /** Whether a step forwards was found within the last `windowMs` of the page's monotonic time. Ask it after `now()`. */
  distrusted(): boolean;
  /**
   * The wall clock's reading from which this clock has been checked continuously (R28, revision 18): when it began, and again at the latest
   * step it found, in either direction. A stamp made after it was made within a stretch whose length this page can vouch for. Ask it after
   * `now()`, which is where a step is found.
   */
  anchor(): number;
}

export function createQuotaClock(options: {
  /** The wall clock (`Date.now()`): the only clock the pages of an origin share. */
  wall(): number;
  /** The page's monotonic clock (`performance.now()`). Omitted: no step can be found. */
  monotonic?: (() => number) | undefined;
  /** How far the two clocks may part between readings before it is called a step. */
  slackMs: number;
  /** How long, in monotonic time, the wall clock is distrusted after a step forwards. */
  windowMs: number;
  /** A step of the wall clock was found (`movedMs`: positive forwards, negative backwards). */
  onStep?: ((movedMs: number) => void) | undefined;
}): QuotaClock {
  const { wall, monotonic, slackMs, windowMs, onStep } = options;
  // A clock that answers with something else than a number has no moment to anchor at: every stamp is then believed, as it was.
  const began = wall();
  let anchored = Number.isFinite(began) ? began : Number.NEGATIVE_INFINITY;
  /**
   * A wall clock that reads LESS than the moment its stretch began has been set back, whatever else is known of it (it needs no second
   * clock to say so): the stretch starts again from this reading, so that the anchor is never ahead of the clock it anchors, and an entry
   * that is believed to have landed no earlier than the anchor is never believed to land later than now (R28, revision 18).
   */
  const settle = (reading: number): void => {
    if (Number.isFinite(reading) && reading < anchored) anchored = reading;
  };
  if (monotonic === undefined)
    return {
      now() {
        const reading = wall();
        settle(reading);
        return reading;
      },
      distrusted: () => false,
      anchor: () => anchored,
    };
  let lastWall = began;
  let lastMonotonic = monotonic();
  let distrustedUntil: number | null = null;
  return {
    now() {
      const reading = wall();
      const steady = monotonic();
      settle(reading);
      // A clock that answers with something else than a number says nothing: it is not followed, and is not read as a step.
      if (Number.isFinite(reading) && Number.isFinite(steady)) {
        const moved = reading - lastWall - (steady - lastMonotonic);
        lastWall = reading;
        lastMonotonic = steady;
        if (Math.abs(moved) > slackMs) {
          if (moved > 0) distrustedUntil = steady + windowMs;
          // The stretch this page has checked starts again from here: a stamp made before it was made on the far side of the step.
          anchored = reading;
          onStep?.(moved);
        }
      }
      return reading;
    },
    distrusted() {
      if (distrustedUntil === null) return false;
      const steady = monotonic();
      return Number.isFinite(steady) && steady < distrustedUntil;
    },
    anchor: () => anchored,
  };
}
