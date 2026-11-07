import type { Page } from "@playwright/test";
import { expect, test } from "./helpers";
import {
  ageSharedConfirmation,
  RESUME_VERIFICATION_INTERVAL_MS,
  STALE_CONFIRMATION_AGE_MS,
  settledIdentityOf,
  sharedConfirmationAge,
} from "./shared-confirmation";

/**
 * WEB-14a revision 35 (review R38, design assessment Q1): the setup helper of tests/e2e/shared-confirmation.ts in each real engine,
 * against a SYNTHETIC `atlas-auth` record on a same-origin document with no application (routed below), so every outcome is the
 * helper's own: it rewrites only `confirmation.confirmed_at` of a matching record and reads the rest back unchanged; every other case
 * fails the setup with the record exactly as it was. The application's use of it (the reload controls, I-04, B1/B4/B5, S08) is in
 * production.auth-flows.spec.ts and tests/integration/integration.faults.spec.ts.
 */

const BLANK = "/__r38-blank";
const SETTLED = { account_id: "acct-r38", epoch: 4, session_id: "sess-r38" };
const record = (confirmation: Record<string, unknown> | null) => ({
  latest_epoch: 4,
  fence_seq: 2,
  attempt: null,
  settled: { ...SETTLED, settled_at: "2026-10-24T00:00:00.000Z" },
  fences: {},
  leases: {},
  confirmation,
});
const CONFIRMED = {
  ...SETTLED,
  csrf_token: "csrf.sess-r38",
  confirmed_at: "2026-10-24T00:00:00.000Z",
};

async function blankDocument(page: Page) {
  await page.route(`**${BLANK}`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>R38 blank</title>",
    }),
  );
  await page.goto(BLANK);
}

/** Creates `atlas-auth` (version 1, store `records`) holding `auth_state`, or the database alone when `value` is undefined. */
const seed = (page: Page, value?: unknown, withStore = true) =>
  page.evaluate(
    ({ value, withStore }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("atlas-auth", 1);
        open.onupgradeneeded = () => {
          if (withStore) open.result.createObjectStore("records");
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (value === undefined) {
            db.close();
            resolve();
            return;
          }
          const tx = db.transaction("records", "readwrite");
          tx.objectStore("records").put(value, "auth_state");
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
        };
      }),
    { value, withStore },
  );

/** The stored `auth_state`, as it is (structured clone), read through a connection of the test's own. */
const stored = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open("atlas-auth");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("records", "readonly");
          const read = tx.objectStore("records").get("auth_state");
          tx.oncomplete = () => {
            db.close();
            resolve(read.result);
          };
          tx.onabort = () => reject(tx.error);
        };
      }),
  );

const databases = (page: Page) =>
  page.evaluate(async () =>
    (await indexedDB.databases()).map((d) => d.name ?? ""),
  );

test.describe("revision 35, R38 Q1: the shared confirmation's ageing helper in a real engine", () => {
  test("a matching record: only confirmed_at is rewritten, the token and every other field read back unchanged, and the receipt is redacted", async ({
    page,
  }) => {
    await blankDocument(page);
    const before = record(CONFIRMED);
    await seed(page, before);
    expect(await settledIdentityOf(page)).toEqual(SETTLED);
    const receipt = await ageSharedConfirmation(page, SETTLED);
    expect(Object.keys(receipt).sort()).toEqual([
      "aged",
      "confirmation_matched",
      "found_age_ms",
      "other_fields_unchanged",
      "settlement_matched",
      "written_age_ms",
    ]);
    expect(receipt.written_age_ms).toBe(STALE_CONFIRMATION_AGE_MS);
    expect(JSON.stringify(receipt)).not.toContain("csrf");
    const after = (await stored(page)) as typeof before & {
      confirmation: typeof CONFIRMED;
    };
    expect({
      ...after,
      confirmation: { ...after.confirmation, confirmed_at: null },
    }).toEqual({
      ...before,
      confirmation: { ...CONFIRMED, confirmed_at: null },
    });
    expect(after.confirmation.csrf_token).toBe(CONFIRMED.csrf_token);
    const age = await sharedConfirmationAge(page, SETTLED);
    expect(age).toMatchObject({
      settlement_matched: true,
      confirmation_matched: true,
      eligible: true,
    });
    expect(age.age_ms).toBeGreaterThanOrEqual(STALE_CONFIRMATION_AGE_MS);
    expect(age.age_ms).toBeLessThan(STALE_CONFIRMATION_AGE_MS + 10_000);
  });

  test("control: a fresh matching confirmation is reported fresh (not eligible)", async ({
    page,
  }) => {
    await blankDocument(page);
    const now = await page.evaluate(() => new Date().toISOString());
    await seed(page, record({ ...CONFIRMED, confirmed_at: now }));
    expect(await sharedConfirmationAge(page, SETTLED)).toMatchObject({
      settlement_matched: true,
      confirmation_matched: true,
      eligible: false,
    });
  });

  for (const [name, expected, why] of [
    [
      "another account",
      { ...SETTLED, account_id: "acct-other" },
      /does not settle the expected session/,
    ],
    [
      "another epoch",
      { ...SETTLED, epoch: 3 },
      /does not settle the expected session/,
    ],
    [
      "another session",
      { ...SETTLED, session_id: "sess-other" },
      /does not settle the expected session/,
    ],
  ] as const)
    test(`refused, nothing changed: the record settles ${name} than expected`, async ({
      page,
    }) => {
      await blankDocument(page);
      const before = record(CONFIRMED);
      await seed(page, before);
      await expect(ageSharedConfirmation(page, expected)).rejects.toThrow(why);
      expect(await stored(page)).toEqual(before);
    });

  for (const [name, confirmation] of [
    ["no confirmation (a record of the previous version)", null],
    [
      "a confirmation of another session",
      { ...CONFIRMED, session_id: "sess-other" },
    ],
    ["a confirmation of another epoch", { ...CONFIRMED, epoch: 3 }],
  ] as const)
    test(`refused, nothing changed: ${name}`, async ({ page }) => {
      await blankDocument(page);
      const before = record(confirmation);
      await seed(page, before);
      await expect(ageSharedConfirmation(page, SETTLED)).rejects.toThrow(
        /no confirmation of the expected session/,
      );
      expect(await stored(page)).toEqual(before);
    });

  test("refused, nothing changed: no settlement", async ({ page }) => {
    await blankDocument(page);
    const before = { ...record(CONFIRMED), settled: null };
    await seed(page, before);
    await expect(ageSharedConfirmation(page, SETTLED)).rejects.toThrow(
      /does not settle the expected session/,
    );
    await expect(settledIdentityOf(page)).rejects.toThrow(/settles no session/);
    expect(await stored(page)).toEqual(before);
  });

  test("refused before the page is touched: an age that would leave the confirmation fresh, or no finite age", async ({
    page,
  }) => {
    await blankDocument(page);
    const before = record(CONFIRMED);
    await seed(page, before);
    for (const age of [
      RESUME_VERIFICATION_INTERVAL_MS,
      RESUME_VERIFICATION_INTERVAL_MS - 1,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      await expect(
        ageSharedConfirmation(page, SETTLED, age),
        `age ${age}`,
      ).rejects.toThrow(/would not make the verification eligible/);
    expect(await stored(page)).toEqual(before);
  });

  test("refused, and nothing is created: the origin has no atlas-auth database", async ({
    page,
  }) => {
    await blankDocument(page);
    await expect(ageSharedConfirmation(page, SETTLED)).rejects.toThrow(
      /no atlas-auth database \(its creation was aborted\)/,
    );
    expect(
      await databases(page),
      "the ageing created no database",
    ).not.toContain("atlas-auth");
    await expect(settledIdentityOf(page)).rejects.toThrow(
      /no atlas-auth database/,
    );
    expect(await databases(page), "the look created no database").not.toContain(
      "atlas-auth",
    );
  });

  test("refused: the database has no records store", async ({ page }) => {
    await blankDocument(page);
    await seed(page, undefined, false);
    await expect(ageSharedConfirmation(page, SETTLED)).rejects.toThrow(
      /no records store/,
    );
  });

  test("refused, nothing changed: the write throws, and the transaction is aborted", async ({
    page,
  }) => {
    await blankDocument(page);
    const before = record(CONFIRMED);
    await seed(page, before);
    await page.evaluate(() => {
      const real = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        IDBObjectStore.prototype.put = real;
        void args;
        throw new DOMException("injected", "DataError");
      };
    });
    await expect(ageSharedConfirmation(page, SETTLED)).rejects.toThrow(
      /the write failed \(DataError\)/,
    );
    expect(await stored(page)).toEqual(before);
  });

  test("a competing writer ordered first replaces the settlement: the check runs in the helper's own transaction, which refuses and leaves the competitor's write", async ({
    page,
  }) => {
    await blankDocument(page);
    await seed(page, record(CONFIRMED));
    // The competitor's read-write transaction is created first and kept open for 500 ms; the helper's queues behind it.
    await page.evaluate(
      () =>
        new Promise<void>((created, reject) => {
          const open = indexedDB.open("atlas-auth");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("records", "readwrite");
            const store = tx.objectStore("records");
            const read = store.get("auth_state");
            read.onsuccess = () => {
              const value = read.result as {
                settled: Record<string, unknown>;
              };
              store.put(
                {
                  ...value,
                  settled: { ...value.settled, session_id: "sess-newer" },
                },
                "auth_state",
              );
              const until = Date.now() + 500;
              const spin = () => {
                if (Date.now() < until)
                  store.get("auth_state").onsuccess = spin;
              };
              spin();
            };
            (
              window as unknown as { __competitor: Promise<void> }
            ).__competitor = new Promise<void>((done) => {
              tx.oncomplete = () => {
                db.close();
                done();
              };
            });
            created();
          };
        }),
    );
    await expect(ageSharedConfirmation(page, SETTLED)).rejects.toThrow(
      /does not settle the expected session/,
    );
    await page.evaluate(
      () => (window as unknown as { __competitor: Promise<void> }).__competitor,
    );
    const after = (await stored(page)) as {
      settled: { session_id: string };
      confirmation: { confirmed_at: string };
    };
    expect(after.settled.session_id).toBe("sess-newer");
    expect(after.confirmation.confirmed_at).toBe(CONFIRMED.confirmed_at);
  });
});
