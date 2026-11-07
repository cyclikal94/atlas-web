import type { World } from "../session/world";

/**
 * A bound on the committed transactions of one plan, observed as they commit (R29, revision 24): the first commit past `limit` is
 * latched and `onViolation` is called once, so a test can end the work that is past its bound at once instead of waiting for a hot loop
 * to go idle before asking how often it ran.
 *
 * - What is counted is what `reads()` in the tests counts: every `idb.commit` entry the world logs for `label`, whichever pump delivered
 *   it (the FakeIdb automatic pump or a test's settle/advance). `seed` is the number already committed when the observation began, so
 *   the count stays the absolute one the assertion is about, not a delta.
 * - The bound is monotonic: the (limit + 1)th commit already disproves "at most `limit`", whenever it lands. A latched violation is a
 *   failing PREFIX of the observation, never evidence about the rest of the window, and a run without one says nothing until its
 *   caller has completed the whole window.
 * - Nothing is thrown from the world's log: an error of `onViolation` is kept and rethrown by `check()` as a plain `Error` (a harness
 *   failure, not an assertion), as is a world that halted (`livelocked`), whose quiet is not idle.
 * - `dispose()` ends the observation: nothing is counted or called afterwards.
 */
export interface ReadTripwire {
  /** The committed transactions of `label` seen so far, `seed` included. */
  readonly count: number;
  /** The first commit past the bound, when there was one. */
  readonly violation: Readonly<{
    count: number;
    time: number;
    seq: number;
  }> | null;
  /** Throws a plain `Error` when the world halted or `onViolation` failed; otherwise returns. */
  check(): void;
  dispose(): void;
}

export function readTripwire(
  world: World,
  options: {
    label: string;
    limit: number;
    seed: number;
    onViolation: () => void;
  },
): ReadTripwire {
  let active = true;
  let count = options.seed;
  let violation: ReadTripwire["violation"] = null;
  let failure: { error: unknown } | null = null;
  world.onLog((entry) => {
    if (!active || entry.type !== "idb.commit" || entry.label !== options.label)
      return;
    count += 1;
    if (violation !== null || count <= options.limit) return;
    violation = { count, time: world.time, seq: entry.seq };
    try {
      options.onViolation();
    } catch (error) {
      failure = { error };
    }
  });
  return {
    get count() {
      return count;
    },
    get violation() {
      return violation;
    },
    check() {
      if (failure !== null)
        throw new Error(
          `the read tripwire's onViolation failed: ${String((failure as { error: unknown }).error)}`,
        );
      if (world.livelocked)
        throw new Error(
          `the world halted (livelocked) with ${count} commits of ${options.label}: its quiet is not idle`,
        );
    },
    dispose() {
      active = false;
    },
  };
}
