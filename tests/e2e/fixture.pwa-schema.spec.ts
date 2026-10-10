import type { Page } from "@playwright/test";
import { accountDatabaseName } from "../../src/data/model/schema";
import {
  BANNER,
  displayed,
  expect,
  mark,
  marked,
  navigate,
  openApp,
  quiet,
  seedAccount,
  test,
  updateRegion,
} from "./pwa-world";

/**
 * WEB-14a P-U7: capability row 400's declared-then-probe, in the running app. Another tab's NEWER build upgrades the account's database
 * (here: a raw version change to 30, as a build with schema version 3 would make). A tab that has the database open closes it, stops
 * reading and writing it and says "Atlas was updated in another tab and needs to reload here to keep working" (PROPOSED copy); a tab that
 * opens afterwards finds the newer version at its probe and says the same. Neither reloads on its own. FIXTURE evidence. The data-level
 * assertions (latch, refusal, a single report) are `fixture.data-schema-probe.spec.ts`.
 */
const NAME = accountDatabaseName("acct-a");

const upgradeTo = (page: Page, version: number) =>
  page.evaluate(
    ({ n, v }) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(n, v);
        request.onsuccess = () => {
          const reached = request.result.version;
          request.result.close();
          resolve(reached);
        };
        request.onerror = () => reject(request.error);
      }),
    { n: NAME, v: version },
  );

test("an upgrade by a newer build: the open tab and a tab opened later both stop and ask to reload; nothing reloads unasked", async ({
  context,
  generations,
}) => {
  await seedAccount(context, generations);
  const open = await openApp(context, generations);
  await expect(open.locator("[data-fixture-form]")).toHaveAttribute(
    "data-port",
    "open",
  );
  await mark(open);
  // The newer build, in a page of its own on the same origin.
  const newer = await open.context().newPage();
  await navigate(newer, `${generations.url}/__neutral`);
  expect(await upgradeTo(newer, 30)).toBe(30);
  await newer.close();

  await expect(updateRegion(open).getByText(BANNER.superseded)).toBeVisible();
  // ADAPTED (revision 1, R7). Revision 0 asserted `data-port="none"` here: the tab let go of the database, so the form had no store to save
  // to. WEB-04 8 requires the old code to keep a recovery path for the person's form through a fresh connection; the intent kept is that the
  // tab no longer uses the database for anything else (the banner, the refusal of every open: `fixture.data-schema-probe.spec.ts`). The form
  // keeps its port, over the recovery connection.
  await expect(open.locator("[data-fixture-form]")).toHaveAttribute(
    "data-port",
    "open",
  );
  await expect(
    updateRegion(open).getByRole("button", { name: "Not now" }),
  ).toHaveCount(0);

  const later = await openApp(context, generations);
  await expect(updateRegion(later).getByText(BANNER.superseded)).toBeVisible();
  await expect(later.locator("[data-fixture-form]")).toHaveAttribute(
    "data-port",
    "none",
  );
  await open.waitForTimeout(1_000);
  expect(await marked(open)).toBe(true);

  // The database is as the newer build left it.
  const version = await later.evaluate(
    (n) =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open(n);
        request.onsuccess = () => {
          const v = request.result.version;
          request.result.close();
          resolve(v);
        };
      }),
    NAME,
  );
  expect(version).toBe(30);

  // "Reload here" reloads this tab only (it then finds the newer version again: this build cannot use it).
  await quiet(open);
  await updateRegion(open).getByRole("button", { name: "Reload here" }).click();
  await expect.poll(() => marked(open).catch(() => false)).toBe(false);
  await displayed(open);
  await expect(updateRegion(open).getByText(BANNER.superseded)).toBeVisible();
});

/** The account's `form_recovery` rows and the database's version, read with a no-version open (which never upgrades). */
const recoveryState = (page: Page) =>
  page.evaluate(
    (n) =>
      new Promise<{
        version: number;
        rows: Array<{ terminal: boolean; fields: Record<string, string> }>;
      }>((resolve, reject) => {
        const request = indexedDB.open(n);
        request.onsuccess = () => {
          const db = request.result;
          const all = db
            .transaction("form_recovery")
            .objectStore("form_recovery")
            .getAll();
          all.onsuccess = () => {
            const version = db.version;
            db.close();
            resolve({ version, rows: all.result });
          };
          all.onerror = () => reject(all.error);
        };
        request.onerror = () => reject(request.error);
      }),
    NAME,
  );

/** The newer build, in a page of its own: an upgrade to `version`; `migrate` runs in its upgrade (and may abort it). */
async function newerBuild(
  open: Page,
  url: string,
  version: number,
  migrate: "none" | "fail" | "drop-recovery",
): Promise<number> {
  const newer = await open.context().newPage();
  await navigate(newer, `${url}/__neutral`);
  const reached = await newer.evaluate(
    ({ n, v, m }) =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open(n, v);
        request.onupgradeneeded = () => {
          if (m === "fail") request.transaction?.abort();
          if (m === "drop-recovery")
            request.result.deleteObjectStore("form_recovery");
        };
        request.onsuccess = () => {
          const reachedVersion = request.result.version;
          request.result.close();
          resolve(reachedVersion);
        };
        // A migration that failed rolls the whole version change back.
        request.onerror = () => resolve(-1);
      }),
    { n: NAME, v: version, m: migrate },
  );
  await newer.close();
  return reached;
}

const flushNow = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __atlasForms: { dirty(): Array<{ flush(): Promise<string> }> };
      }
    ).__atlasForms
      .dirty()[0]
      ?.flush(),
  );

/**
 * Revision 1, R7 (WEB-04 8): the person's unfinished form outlives a newer build's upgrade of the database. The old tab never reads or
 * writes the account's data again, but its form is saved through a FRESH connection to the upgraded database (`store/recovery-store.ts`),
 * which keeps the account, incarnation, `closing`, quota and capture-order guards. A failed (rolled-back) migration leaves the old version,
 * which the fresh connection uses the same way; a newer schema that broke the `form_recovery` contract fails the save honestly, and the form
 * stays with "Retry save" and "Discard and reload anyway".
 */
test.describe("revision 1, R7: the form's recovery path through a newer build's upgrade", () => {
  const dirtyForm = async (
    context: Parameters<typeof seedAccount>[0],
    generations: Parameters<typeof seedAccount>[1],
  ) => {
    await seedAccount(context, generations);
    const open = await openApp(context, generations);
    await expect(open.locator("[data-fixture-form]")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await open
      .getByRole("textbox", { name: "Title" })
      .fill("saved before upgrade");
    expect(await flushNow(open)).toBe("saved");
    await open
      .getByRole("textbox", { name: "Title" })
      .fill("unfinished after first copy");
    return open;
  };

  test("an upgrade (20 to 30, no store changed): 'Reload here' saves the edits made after the first copy, through a fresh connection", async ({
    context,
    generations,
  }) => {
    const open = await dirtyForm(context, generations);
    expect(await newerBuild(open, generations.url, 30, "none")).toBe(30);
    await expect(updateRegion(open).getByText(BANNER.superseded)).toBeVisible();
    await expect(open.locator("[data-fixture-form]")).toHaveAttribute(
      "data-port",
      "open",
    );
    await mark(open);
    await quiet(open);
    await updateRegion(open)
      .getByRole("button", { name: "Reload here" })
      .click();
    await expect.poll(() => marked(open).catch(() => false)).toBe(false);
    await displayed(open);
    // This build still cannot use the newer database (it asks again); the copy is there, at the newer version, unchanged by this build.
    await expect(updateRegion(open).getByText(BANNER.superseded)).toBeVisible();
    const state = await recoveryState(open);
    expect(state.version).toBe(30);
    expect(
      state.rows.filter((row) => !row.terminal).map((row) => row.fields.title),
    ).toEqual(["unfinished after first copy"]);
  });

  test("a migration that failed (rolled back to 20): the old tab saves through a fresh connection, and the reloaded tab restores the form", async ({
    context,
    generations,
  }) => {
    const open = await dirtyForm(context, generations);
    expect(await newerBuild(open, generations.url, 30, "fail")).toBe(-1);
    await expect(updateRegion(open).getByText(BANNER.superseded)).toBeVisible();
    expect((await recoveryState(open)).version).toBe(20);
    await mark(open);
    await quiet(open);
    await updateRegion(open)
      .getByRole("button", { name: "Reload here" })
      .click();
    await expect.poll(() => marked(open).catch(() => false)).toBe(false);
    await displayed(open);
    await expect(open.locator("[data-fixture-form]")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await expect(open.getByRole("textbox", { name: "Title" })).toHaveValue(
      "unfinished after first copy",
    );
    await expect(updateRegion(open).getByText(BANNER.superseded)).toHaveCount(
      0,
    );
  });

  test("a newer schema that broke the recovery contract: the save fails honestly, the form stays, and only the person discards", async ({
    context,
    generations,
  }) => {
    const open = await dirtyForm(context, generations);
    expect(await newerBuild(open, generations.url, 30, "drop-recovery")).toBe(
      30,
    );
    await expect(updateRegion(open).getByText(BANNER.superseded)).toBeVisible();
    await mark(open);
    await updateRegion(open)
      .getByRole("button", { name: "Reload here" })
      .click();
    await expect(
      updateRegion(open).getByRole("button", { name: "Retry save" }),
    ).toBeVisible();
    await updateRegion(open)
      .getByRole("button", { name: "Retry save" })
      .click();
    await expect(
      updateRegion(open).getByRole("button", { name: "Retry save" }),
    ).toBeVisible();
    await expect(open.getByRole("textbox", { name: "Title" })).toHaveValue(
      "unfinished after first copy",
    );
    await open.waitForTimeout(1_000);
    expect(await marked(open)).toBe(true);
  });
});
