import { createWebLocksPort } from "../../session";
import {
  createQuotaGuard,
  type QuotaGuard,
  type StorageLike,
} from "../engine/quota-guard";
import { createIdbLedger, type OwnerLocks } from "../store/quota-ledger";

/**
 * The quota guard of a page of PRODUCTION (R28, revision 13), in one place so that the application, the tests and the real-engine
 * harness all build the same one.
 *
 * What is promised to writes in flight and what has just landed is the ORIGIN's, so every page's guard judges against one ledger, an
 * IndexedDB record that all of them read and change atomically (`store/quota-ledger.ts`). It is opened on first use, so building the
 * guard holds nothing (a construction React discards leaks nothing), and `close()` lets go of it. Without IndexedDB the guard keeps the
 * in-realm ledger of its estimate source, which is the page-local accounting it always had.
 *
 * The holds of the ledger have OWNERS (R28, revision 15): a Web Lock per hold, kept by the writer's page, so that a hold is reclaimed only
 * when its owner is proven to have let go, never because a suspended page missed a renewal. `locks` is the page's lock port (`navigator.locks`
 * unless a test names one, or `null` for none, which leaves the holds to their leases alone). Web Locks are a required capability of the
 * application (answer Q12), so in production the ledger always has owners.
 *
 * `storage` is the estimate source (`navigator.storage`; the fixture names its injection); `factory` the IndexedDB the ledger lives in
 * (the page's own unless a test names one, or `null` for none).
 *
 * The guard's time is the wall clock FOLLOWED by the page's monotonic clock (R28, revision 17; `engine/quota-clock.ts`): a step of the
 * wall clock is taken out of every stamp and age, so that it is read neither as proof that a landing's lifetime has passed nor as a
 * reason to hold a lease for as long as the clock was moved back. With the page's own clocks (neither `now` nor `monotonic` named) that
 * is `Date.now()` followed by `performance.now()`. A test or the fixture that names `now` names the whole clock: with no `monotonic`
 * beside it the guard reads that one clock as it is (naming `now` alone is how a test moves time). `monotonic: null` says there is none.
 */
export function createProductionQuota(options?: {
  storage?: StorageLike | undefined;
  now?: () => number;
  /** The monotonic clock the wall clock is followed by: omitted, the page's `performance.now()` when `now` is not named either; `null`, none. */
  monotonic?: (() => number) | null;
  /** The IndexedDB the ledger lives in: omitted, the page's own; `null`, none (the guard keeps its in-realm ledger). */
  factory?: Parameters<typeof createIdbLedger>[0];
  /** The lock port that gives the holds their owners: omitted, the page's own `navigator.locks`; `null`, none. */
  locks?: OwnerLocks | null;
}): QuotaGuard {
  const storage =
    options && "storage" in options
      ? options.storage
      : typeof navigator === "undefined"
        ? undefined
        : navigator.storage;
  const locks =
    options?.locks !== undefined
      ? (options.locks ?? undefined)
      : typeof navigator !== "undefined" &&
          typeof navigator.locks?.request === "function"
        ? createWebLocksPort(navigator.locks)
        : undefined;
  const monotonic =
    options?.monotonic !== undefined
      ? (options.monotonic ?? undefined)
      : options?.now === undefined &&
          typeof performance !== "undefined" &&
          typeof performance.now === "function"
        ? () => performance.now()
        : undefined;
  // With no estimate there is nothing to protect and every verdict is `unknown`: the ledger is not opened for it.
  const ledger =
    typeof storage?.estimate === "function"
      ? createIdbLedger(options?.factory, locks)
      : undefined;
  return createQuotaGuard({
    storage,
    now: options?.now ?? (() => Date.now()),
    ...(monotonic ? { monotonic } : {}),
    ...(ledger ? { ledger } : {}),
  });
}
