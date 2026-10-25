import type { Page } from "@playwright/test";
import { DEFAULT_CONFIG } from "../../src/session/constants";

/**
 * WEB-14a revision 35 (review R38, family `r43-premise-shared-confirmation`; design assessment C1): the one checked way a browser test
 * makes a background identity read (`GET /browser-sessions/current`, the resume verification a displaying page makes) ELIGIBLE again.
 *
 * Since HF1-SHARED-CONFIRMATION-20261013 the settlement, and every page's clean identity read, writes `auth_state.confirmation` for the
 * exact settled (account, epoch, session). A page adopts its token for exactly that session (no age requirement), and while it is less
 * than `resumeVerificationMinIntervalMs` (30 s) old the resume verification is NOT made (src/session/session.ts `confirmedRecently`).
 * That is the accepted product behaviour; a test that needs the read must establish its eligibility, never assume it.
 *
 * `ageSharedConfirmation` rewrites ONLY `confirmation.confirmed_at`, in one read-write transaction, after checking that the record
 * still settles exactly `expected` and holds a confirmation of exactly that session. Every other field, the token included, is read
 * back unchanged in the same transaction. Anything else fails the SETUP, with nothing changed: no such database (its creation is
 * aborted), no `records` store, a different or absent settlement, no confirmation of that session, an age that would not make the read
 * eligible, a failed open or transaction, or no commit within the bound. It resolves only after the commit.
 *
 * What it does NOT do, which each caller has to account for:
 *  - It does not reach a live page's memory. A document that already made (or attempted) a verification within the interval stays
 *    ineligible (`lastVerifiedAt`), and a live document compares with the record it last READ (`k.lastRecord`, refreshed by its next
 *    evaluation). Eligibility therefore needs a NEW document, or, in a document that has never verified, a display transition whose
 *    evaluation reads the record again (hide, then lift).
 *  - It does not stop a later writer. Another page's clean identity read, or a new settlement, writes a fresh confirmation; check
 *    with `sharedConfirmationAge` just before the trigger, and never age again in a loop until a request appears.
 *  - It opens its own connection. The R28 observer (tests/e2e/auth-settlement.ts `observeAuthWork`) of the document it runs in counts
 *    any `atlas-auth` connection that makes a transaction as the application's, and reads through the LAST one; after this helper
 *    closes its connection, that document's next durable look would be unreadable. Run it (and `settledIdentityOf`) only in a document
 *    that is then replaced before it is observed again, or in a document with no observer (the integration harness).
 *  - It never applies to the verifications whose cause is not freshness: a credential fence, an unresolved lease, an operation's
 *    replay, a missing token. Those happen with a fresh confirmation too.
 */

export interface SettledIdentity {
  account_id: string;
  epoch: number;
  session_id: string;
}

/** The interval the product compares the confirmation's age with (the unchanged production value). */
export const RESUME_VERIFICATION_INTERVAL_MS =
  DEFAULT_CONFIG.resumeVerificationMinIntervalMs;
/** The default written age: four intervals, far enough that no clock jitter between the test and the page matters. */
export const STALE_CONFIRMATION_AGE_MS = 4 * RESUME_VERIFICATION_INTERVAL_MS;
/** How long one setup transaction may take before the setup fails (it never waits for an assertion's time-out to say so). */
const SETUP_BOUND_MS = 5_000;

/** A redacted receipt: booleans and ages only, never the token, the cookie or a verifier. */
export interface ConfirmationAgeing {
  aged: true;
  settlement_matched: true;
  confirmation_matched: true;
  /** Every field of the record but `confirmation.confirmed_at` (the token included) read back unchanged in the same transaction. */
  other_fields_unchanged: true;
  /** The confirmation's age when it was found, by the page's clock. */
  found_age_ms: number;
  /** Its age as written, by the page's clock (the clock the session compares it with). */
  written_age_ms: number;
}

type InPage =
  | { ok: true; foundAgeMs: number; writtenAgeMs: number }
  | { ok: false; why: string };

/**
 * Runs IN THE PAGE (serialised by `page.evaluate`: it may use nothing from this module's scope). Read, check, write and read back in one
 * transaction of `atlas-auth`/`records`, resolved on `complete`; every other ending is a failure that leaves the record unchanged.
 */
function ageInPage(args: {
  want: SettledIdentity;
  ageMs: number;
  boundMs: number;
}): Promise<InPage> {
  const { want, ageMs, boundMs } = args;
  return new Promise<InPage>((resolve) => {
    let done = false;
    let db: IDBDatabase | null = null;
    let tx: IDBTransaction | null = null;
    let refusal: string | null = null;
    let verdict: InPage | null = null;
    const finish = (outcome: InPage) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      db?.close();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      let aborted = false;
      try {
        tx?.abort();
        aborted = tx !== null;
      } catch {
        // Already finished: its outcome was not reported in time, so the record may have changed.
      }
      finish({
        ok: false,
        why: `no commit within ${boundMs} ms (${tx === null ? "the database never opened" : aborted ? "the transaction was aborted" : "the transaction had already ended: the record may have changed"})`,
      });
    }, boundMs);
    const same = (
      a: { account_id?: unknown; epoch?: unknown; session_id?: unknown },
      b: typeof want,
    ) =>
      a.account_id === b.account_id &&
      a.epoch === b.epoch &&
      a.session_id === b.session_id;
    const refuse = (why: string) => {
      refusal = why;
      try {
        tx?.abort();
      } catch {
        // Already aborting or finished: its own `abort` event still reports the refusal.
      }
    };
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open("atlas-auth");
    } catch (error) {
      finish({ ok: false, why: `the open threw (${(error as Error).name})` });
      return;
    }
    open.onupgradeneeded = () => {
      // No such database: this open would create it. The version change is aborted, so nothing is created.
      open.transaction?.abort();
      finish({
        ok: false,
        why: "the origin has no atlas-auth database (its creation was aborted)",
      });
    };
    open.onerror = (event) => {
      // Handled here (also the aborted creation's error), never reported to the page as uncaught.
      event.preventDefault();
      finish({
        ok: false,
        why: `the open failed (${open.error?.name ?? "unknown"})`,
      });
    };
    open.onsuccess = () => {
      const opened = open.result;
      if (done) {
        opened.close();
        return;
      }
      db = opened;
      // Never hold up the application's own version change.
      opened.onversionchange = () => opened.close();
      if (!opened.objectStoreNames.contains("records")) {
        finish({ ok: false, why: "the database has no records store" });
        return;
      }
      try {
        tx = opened.transaction("records", "readwrite");
      } catch (error) {
        finish({
          ok: false,
          why: `no transaction (${(error as Error).name})`,
        });
        return;
      }
      const write = tx;
      const store = write.objectStore("records");
      const read = store.get("auth_state");
      read.onsuccess = () => {
        const record = read.result as
          | (Record<string, unknown> & {
              settled?: Record<string, unknown> | null;
              confirmation?: Record<string, unknown> | null;
            })
          | undefined;
        if (!record?.settled || !same(record.settled, want)) {
          refuse("the record does not settle the expected session");
          return;
        }
        if (!record.confirmation || !same(record.confirmation, want)) {
          refuse("the record has no confirmation of the expected session");
          return;
        }
        const now = Date.now();
        const foundAgeMs =
          now - Date.parse(String(record.confirmation.confirmed_at));
        const confirmedAt = new Date(now - ageMs).toISOString();
        const without = (value: typeof record) =>
          JSON.stringify({
            ...value,
            confirmation: { ...value.confirmation, confirmed_at: null },
          });
        let back: IDBRequest;
        try {
          store.put(
            {
              ...record,
              confirmation: {
                ...record.confirmation,
                confirmed_at: confirmedAt,
              },
            },
            "auth_state",
          );
          back = store.get("auth_state");
        } catch (error) {
          refuse(`the write failed (${(error as Error).name})`);
          return;
        }
        back.onsuccess = () => {
          const written = back.result as typeof record | undefined;
          if (
            !written?.confirmation ||
            written.confirmation.confirmed_at !== confirmedAt ||
            without(written) !== without(record)
          ) {
            refuse("the record read back differs in more than confirmed_at");
            return;
          }
          verdict = {
            ok: true,
            foundAgeMs,
            writtenAgeMs: now - Date.parse(confirmedAt),
          };
        };
      };
      write.oncomplete = () =>
        finish(
          verdict ?? { ok: false, why: "the transaction completed unchecked" },
        );
      write.onabort = () =>
        finish({
          ok: false,
          why:
            refusal ??
            `the transaction aborted (${write.error?.name ?? "no error"})`,
        });
    };
  });
}

export async function ageSharedConfirmation(
  page: Page,
  expected: SettledIdentity,
  ageMs = STALE_CONFIRMATION_AGE_MS,
): Promise<ConfirmationAgeing> {
  // Refused before the page is touched: an age that would leave the confirmation fresh, or that is not a number of milliseconds.
  if (!Number.isFinite(ageMs) || ageMs <= RESUME_VERIFICATION_INTERVAL_MS)
    throw new Error(
      `setup: an age of ${ageMs} ms would not make the verification eligible (the interval is ${RESUME_VERIFICATION_INTERVAL_MS} ms); nothing was changed`,
    );
  const outcome = await page.evaluate(ageInPage, {
    want: expected,
    ageMs,
    boundMs: SETUP_BOUND_MS,
  });
  if (!outcome.ok)
    throw new Error(
      `setup: the shared confirmation was not aged (${outcome.why}); nothing was changed`,
    );
  return {
    aged: true,
    settlement_matched: true,
    confirmation_matched: true,
    other_fields_unchanged: true,
    found_age_ms: outcome.foundAgeMs,
    written_age_ms: outcome.writtenAgeMs,
  };
}

/** Runs IN THE PAGE: one read-only look at `auth_state` (never creating the database), as the settled triple and the confirmation's age. */
function lookInPage(boundMs: number): Promise<
  | {
      ok: true;
      settled: SettledIdentity | null;
      confirmation: (SettledIdentity & { ageMs: number }) | null;
    }
  | { ok: false; why: string }
> {
  return new Promise((resolve) => {
    let done = false;
    let db: IDBDatabase | null = null;
    type Look = Parameters<typeof resolve>[0];
    const finish = (outcome: Look) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      db?.close();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ ok: false, why: `no answer within ${boundMs} ms` }),
      boundMs,
    );
    const open = indexedDB.open("atlas-auth");
    open.onupgradeneeded = () => {
      open.transaction?.abort();
      finish({
        ok: false,
        why: "the origin has no atlas-auth database (its creation was aborted)",
      });
    };
    open.onerror = (event) => {
      // Handled here (also the aborted creation's error), never reported to the page as uncaught.
      event.preventDefault();
      finish({
        ok: false,
        why: `the open failed (${open.error?.name ?? "unknown"})`,
      });
    };
    open.onsuccess = () => {
      const opened = open.result;
      if (done) {
        opened.close();
        return;
      }
      db = opened;
      opened.onversionchange = () => opened.close();
      let tx: IDBTransaction;
      try {
        tx = opened.transaction("records", "readonly");
      } catch (error) {
        finish({
          ok: false,
          why: `no transaction (${(error as Error).name})`,
        });
        return;
      }
      const read = tx.objectStore("records").get("auth_state");
      tx.oncomplete = () => {
        const record = read.result as
          | {
              settled?: Record<string, unknown> | null;
              confirmation?: Record<string, unknown> | null;
            }
          | undefined;
        const triple = (value: Record<string, unknown>) => ({
          account_id: String(value.account_id),
          epoch: Number(value.epoch),
          session_id: String(value.session_id),
        });
        finish({
          ok: true,
          settled: record?.settled ? triple(record.settled) : null,
          confirmation: record?.confirmation
            ? {
                ...triple(record.confirmation),
                ageMs:
                  Date.now() -
                  Date.parse(String(record.confirmation.confirmed_at)),
              }
            : null,
        });
      };
      tx.onabort = () =>
        finish({
          ok: false,
          why: `the read aborted (${tx.error?.name ?? "no error"})`,
        });
    };
  });
}

async function look(page: Page) {
  const outcome = await page.evaluate(lookInPage, SETUP_BOUND_MS);
  if (!outcome.ok)
    throw new Error(`setup: the auth record was not read (${outcome.why})`);
  return outcome;
}

/** The record's settled (account, epoch, session), read once (see the observer constraint above); a setup failure when nothing is settled. */
export async function settledIdentityOf(page: Page): Promise<SettledIdentity> {
  const { settled } = await look(page);
  if (!settled) throw new Error("setup: the auth record settles no session");
  return settled;
}

/**
 * The shared confirmation's state for `expected`: whether the record still settles it, whether the confirmation names it, and its age.
 * `eligible` is true only when both match and the age is at least the interval: what a document that never verified needs.
 */
export async function sharedConfirmationAge(
  page: Page,
  expected: SettledIdentity,
): Promise<{
  settlement_matched: boolean;
  confirmation_matched: boolean;
  age_ms: number | null;
  eligible: boolean;
}> {
  const { settled, confirmation } = await look(page);
  const same = (value: SettledIdentity | null) =>
    value !== null &&
    value.account_id === expected.account_id &&
    value.epoch === expected.epoch &&
    value.session_id === expected.session_id;
  const settlementMatched = same(settled);
  const confirmationMatched = same(confirmation);
  const age = confirmation?.ageMs ?? null;
  return {
    settlement_matched: settlementMatched,
    confirmation_matched: confirmationMatched,
    age_ms: age,
    eligible:
      settlementMatched &&
      confirmationMatched &&
      age !== null &&
      age >= RESUME_VERIFICATION_INTERVAL_MS,
  };
}
