import type { BrowserContext, Page } from "@playwright/test";
import { untilTreeSettled } from "./data-sync-helpers";
import {
  BANNER,
  build,
  checkForUpdate,
  displayed,
  expect,
  type Generations,
  mark,
  marked,
  navigate,
  openApp,
  quiet,
  reloadQuietly,
  seedAccount,
  test,
  updateRegion,
  workerActive,
} from "./pwa-world";

/**
 * WEB-14a P-U3, P-U4, P-U5: Q4 (save and restore unfinished form content around an update reload; the person chooses when; a failed save
 * keeps the form open with retry or explicit discard) and the fresh-identifier flush of capability row 400, over the REAL `form_recovery`
 * store of the displayed account, through the fixture form that uses the contract feature slices will use. FIXTURE evidence.
 */
const RESTORED =
  "Restored your unfinished form from before the update. Nothing was submitted automatically — review and submit when ready.";
const SAVE_FAILED =
  "Couldn't save your unfinished form before reloading. Nothing was lost — your form is still here.";
const DISCARD_FAILED =
  "Couldn't clear the saved copy of your unfinished form. If you reload now, that copy may be restored afterwards. Your form is still here.";
const SAVE_REFUSED =
  "Can't save your unfinished form while you're signing out. Nothing was lost — your form is still here.";

const title = (page: Page) => page.getByRole("textbox", { name: "Title" });
const notes = (page: Page) => page.getByRole("textbox", { name: "Notes" });
const password = (page: Page) => page.getByLabel("Password");
/** The restored banner itself (the announcer's live region repeats its text). */
const restoredBanner = (page: Page) =>
  page.locator('[data-recovery-state="restored"]');
const formReady = (page: Page) =>
  expect(page.locator("[data-fixture-form]")).toHaveAttribute(
    "data-ready",
    "true",
  );
/**
 * Revision 13 (F-8; review of 15 October 2026, R20). A page that has just booted is not settled when its form first shows what it restored:
 * the identity reads its boot starts in the OTHER pages of the account can close its own protected tree for a session check a few
 * milliseconds later (WEB-08c HF-1, WEB-09a R43). In the original failure (Firefox) C's form was ready and showed ORIGINAL, then C showed
 * `1e.checking` and `1e.interrupted_online` with its tree torn down before the flush began. A form whose tree is torn down has no database
 * to save to, so that save fails, as it must (covered on purpose in the revision-13 case below). A case that needs a newly booted peer's
 * save to SUCCEED first waits until the pages already open, and then the peer, have settled by what each page shows (`untilTreeSettled`:
 * booted, bound, no request lease of any page left in the record, nothing changing; the order of WEB-09a's `withSettledOutboxPeers`, so
 * the other pages' reactions to the boot are over), then for the peer's form.
 */
async function settledPeer(page: Page, others: Page[]): Promise<void> {
  for (const settling of [...others, page])
    await untilTreeSettled(settling, { account: "acct-a" });
  await displayed(page);
  await formReady(page);
}

/** The rows of the account's `form_recovery` store, read through the data harness on a page of its own. */
async function recoveryRows(
  context: BrowserContext,
  world: Generations,
): Promise<
  Array<{
    tab_instance_id: string;
    form_context: string;
    terminal: boolean;
    fields: Record<string, string>;
  }>
> {
  const page = await context.newPage();
  try {
    await navigate(page, `${world.url}/__data`);
    await page.waitForFunction(() => window.__atlasData !== undefined);
    return await page.evaluate(async () => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity("acct-a");
      await data.open("acct-a");
      const rows = await data.rows("acct-a", "form_recovery");
      data.close("acct-a");
      return rows as never;
    });
  } finally {
    await page.close();
  }
}

/** Revision 6 (R13): a row of an update hand-off (stored under the form's hand-off context, never listed as the form's own). */
const isHandoffRow = (row: { form_context: string }) =>
  row.form_context.startsWith("atlas-update-handoff:");

/** Two tabs on generation A, controlled, with B installed and waiting. */
async function twoTabsWithUpdate(
  context: BrowserContext,
  world: Generations,
): Promise<[Page, Page]> {
  await seedAccount(context, world);
  const first = await openApp(context, world);
  await workerActive(first);
  await reloadQuietly(first);
  const second = await openApp(context, world);
  await world.serve("fixture-b");
  await checkForUpdate(first);
  for (const tab of [first, second]) {
    await formReady(tab);
    await expect(
      updateRegion(tab).getByRole("button", { name: "Save and reload" }),
    ).toBeVisible();
  }
  return [first, second];
}

/** TEST INJECTION: the next `count` writes of the `form_recovery` store throw (the transaction aborts), as a failing disk would. */
const failRecoveryWrites = (page: Page, count: number) =>
  page.evaluate((n) => {
    const scope = window as unknown as { __failRecovery?: number };
    if (scope.__failRecovery === undefined) {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        if (this.name === "form_recovery" && (scope.__failRecovery ?? 0) > 0) {
          scope.__failRecovery = (scope.__failRecovery ?? 0) - 1;
          throw new DOMException("injected write failure", "UnknownError");
        }
        return put.apply(this, args);
      };
    }
    scope.__failRecovery = n;
  }, count);

test.describe("P-U3: save before the reload, restore after it, never submit", () => {
  test("a dirty form is saved, the tab reloads onto B, the form is restored unsubmitted with nothing sent, and 'Discard instead' clears it", async ({
    context,
    generations,
  }) => {
    const [first] = await twoTabsWithUpdate(context, generations);
    await title(first).fill("Half-written title");
    await notes(first).fill("Some notes");
    await password(first).fill("hunter2");
    await mark(first);
    await generations.clearLog();
    await quiet(first);
    await updateRegion(first)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect.poll(() => marked(first).catch(() => false)).toBe(false);
    await displayed(first);
    await expect.poll(() => build(first)).toBe("b");
    await formReady(first);
    await expect(restoredBanner(first)).toContainText(RESTORED);
    await expect(title(first)).toHaveValue("Half-written title");
    await expect(notes(first)).toHaveValue("Some notes");
    // Never a password.
    await expect(password(first)).toHaveValue("");
    // Nothing was submitted: the form says so, and the server received no write of any kind.
    await expect(first.locator("[data-fixture-form]")).toHaveAttribute(
      "data-submitted",
      "0",
    );
    expect(
      (await generations.log()).filter((entry) => entry.method !== "GET"),
    ).toEqual([]);
    const saved = await recoveryRows(context, generations);
    // ADAPTED (revision 6, R13; owner decision of 12 October 2026). Was: `expect(saved.filter((row) => !row.terminal)).toHaveLength(1)`.
    // The update now also writes its hand-off: ONE ordinary copy (the old page's), and ONE hand-off holding exactly the same input, which
    // this page restored (its source).
    const live = saved.filter((row) => !row.terminal);
    expect(live.filter((row) => !isHandoffRow(row))).toHaveLength(1);
    expect(live.filter(isHandoffRow).map((row) => row.fields)).toEqual([
      { title: "Half-written title", notes: "Some notes" },
    ]);
    expect(JSON.stringify(saved)).not.toContain("hunter2");

    await first.getByRole("button", { name: "Discard instead" }).click();
    await expect(title(first)).toHaveValue("");
    await expect(restoredBanner(first)).toHaveCount(0);
    await reloadQuietly(first);
    await formReady(first);
    await expect(title(first)).toHaveValue("");
    await expect(restoredBanner(first)).toHaveCount(0);
  });
});

test.describe("P-U4: a save that fails keeps the form and the update", () => {
  test("failed: 'Retry save' succeeds and the update proceeds; nothing reloads before", async ({
    context,
    generations,
  }) => {
    const [first] = await twoTabsWithUpdate(context, generations);
    await title(first).fill("Keep me");
    await mark(first);
    await failRecoveryWrites(first, 1_000);
    await updateRegion(first)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(updateRegion(first).getByText(SAVE_FAILED)).toBeVisible();
    // The form is open, editable and unchanged; the tab has not reloaded.
    await expect(title(first)).toHaveValue("Keep me");
    await title(first).fill("Keep me, edited");
    await first.waitForTimeout(1_000);
    expect(await marked(first)).toBe(true);
    await failRecoveryWrites(first, 0);
    await quiet(first);
    await updateRegion(first)
      .getByRole("button", { name: "Retry save" })
      .click();
    await expect.poll(() => marked(first).catch(() => false)).toBe(false);
    await displayed(first);
    await formReady(first);
    await expect(title(first)).toHaveValue("Keep me, edited");
  });

  test("failed: 'Discard and reload anyway' reloads without a copy", async ({
    context,
    generations,
  }) => {
    const [first] = await twoTabsWithUpdate(context, generations);
    await title(first).fill("Let it go");
    await mark(first);
    await failRecoveryWrites(first, 1_000);
    await updateRegion(first)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(updateRegion(first).getByText(SAVE_FAILED)).toBeVisible();
    await quiet(first);
    await updateRegion(first)
      .getByRole("button", { name: "Discard and reload anyway" })
      .click();
    await expect.poll(() => marked(first).catch(() => false)).toBe(false);
    await displayed(first);
    await formReady(first);
    await expect(title(first)).toHaveValue("");
    await expect(restoredBanner(first)).toHaveCount(0);
  });

  test("refused (the account is being signed out): only 'Discard and reload anyway'", async ({
    context,
    generations,
  }) => {
    const [first] = await twoTabsWithUpdate(context, generations);
    await title(first).fill("Signing out");
    // Another page of the origin marks the account `closing`, as a sign-out does before its wipe.
    const other = await context.newPage();
    await navigate(other, `${generations.url}/__data`);
    await other.waitForFunction(() => window.__atlasData !== undefined);
    await other.evaluate(async () => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity("acct-a");
      await data.open("acct-a");
      await data.markClosing("acct-a");
      data.close("acct-a");
    });
    await other.close();
    await updateRegion(first)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(updateRegion(first).getByText(SAVE_REFUSED)).toBeVisible();
    await expect(
      updateRegion(first).getByRole("button", { name: "Retry save" }),
    ).toHaveCount(0);
    await expect(title(first)).toHaveValue("Signing out");
  });
});

test.describe("P-U5: the fresh-identifier flush", () => {
  test("the other tab saves its own copy, keeps its form open and never reloads; after both reload, both copies are offered", async ({
    context,
    generations,
  }) => {
    const [first, second] = await twoTabsWithUpdate(context, generations);
    await title(first).fill("From the first tab");
    await title(second).fill("From the second tab");
    await mark(first);
    await mark(second);
    await quiet(first);
    await updateRegion(first)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect.poll(() => marked(first).catch(() => false)).toBe(false);
    await displayed(first);
    await expect.poll(() => build(first)).toBe("b");
    // The second tab saved its input under its OWN identifier, did not reload, and its form is still open and editable.
    await expect(
      updateRegion(second).getByText(BANNER.elsewhere),
    ).toBeVisible();
    expect(await marked(second)).toBe(true);
    await expect(title(second)).toHaveValue("From the second tab");
    // ADAPTED (revision 6, R13; owner decision of 12 October 2026). Was: every non-terminal row (2, distinct identifiers, both titles).
    // The first tab's update also wrote its hand-off (the same input under a hand-off identifier): the ordinary copies are asserted as
    // before, and the hand-off separately.
    const all = (await recoveryRows(context, generations)).filter(
      (row) => !row.terminal,
    );
    const rows = all.filter((row) => !isHandoffRow(row));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.tab_instance_id)).size).toBe(2);
    expect(rows.map((row) => row.fields.title).sort()).toEqual([
      "From the first tab",
      "From the second tab",
    ]);
    expect(all.filter(isHandoffRow).map((row) => row.fields.title)).toEqual([
      "From the first tab",
    ]);
    // The reloaded first tab restored its own copy and left the open second tab's alone.
    await formReady(first);
    await expect(title(first)).toHaveValue("From the first tab");
    await expect(first.locator("[data-alternatives]")).toHaveCount(0);

    // The second tab edits further, then reloads here: its newest copy is restored, and the other copy is offered.
    await title(second).fill("From the second tab, later");
    await quiet(second);
    await updateRegion(second)
      .getByRole("button", { name: "Reload here" })
      .click();
    await expect.poll(() => marked(second).catch(() => false)).toBe(false);
    await displayed(second);
    await formReady(second);
    await expect(title(second)).toHaveValue("From the second tab, later");
    // ADAPTED (revision 5, R13). Was: `expect(second.locator("[data-alternatives]")).toHaveAttribute("data-alternatives", "1")`, the first
    // tab's OLD copy (its previous page's, owner gone) offered here while the first tab, still open, showed that very input. Since revision
    // 5 a restored form owes a copy of its own: asked to save by this tab's update, the first tab saved its input under its LIVE identifier
    // and cleaned up the old row, so this tab offers nothing (another open tab's copy is never taken over). The intent, "both copies stay
    // available", is asserted instead: both inputs are durable, and the first tab's is restored once that tab has gone.
    await expect(second.locator("[data-alternatives]")).toHaveCount(0);
    await expect(title(first)).toHaveValue("From the first tab");
    // ADAPTED (revision 6, R13): the ordinary copies, as before (the second tab's own update left its hand-off too, restored here).
    expect(
      (await recoveryRows(context, generations))
        .filter((row) => !row.terminal && !isHandoffRow(row))
        .map((row) => row.fields.title)
        .sort(),
    ).toEqual(["From the first tab", "From the second tab, later"]);
    expect(await handoffTitles(context, generations)).toEqual([
      "From the second tab, later",
    ]);
    // The second tab saves its own copy (so the next page's choice is not a race between two gone copies), then the first tab goes.
    expect(await flushNow(second)).toBe("saved");
    await first.close();
    const third = await openApp(context, generations);
    await formReady(third);
    await expect(title(third)).toHaveValue("From the first tab");
    await expect(restoredBanner(third)).toBeVisible();
  });

  test("an opener-copied tab saves under an identifier of its own", async ({
    context,
    generations,
  }) => {
    const [first] = await twoTabsWithUpdate(context, generations);
    const [copy] = await Promise.all([
      context.waitForEvent("page"),
      first.evaluate(() => {
        window.open(location.href);
      }),
    ]);
    await displayed(copy);
    await formReady(copy);
    // Every tab is opened BEFORE anything is typed: a page that boots makes every other tab check its session, which remounts its
    // protected tree and loses input not saved yet (a WEB-08a/09a behaviour recorded in .agtx/execute.md, finding F-1).
    const acting = await openApp(context, generations, { form: false });
    await formReady(first);
    await formReady(copy);
    await title(first).fill("Original");
    await title(copy).fill("Copy");
    // A third tab accepts: both tabs are asked to save.
    await mark(acting);
    await quiet(acting);
    await updateRegion(acting).getByRole("button", { name: "Reload" }).click();
    await expect.poll(() => marked(acting).catch(() => false)).toBe(false);
    await displayed(acting);
    await expect(updateRegion(copy).getByText(BANNER.elsewhere)).toBeVisible();
    const all = await recoveryRows(context, generations);
    const rows = all.filter((row) => !row.terminal);
    expect(
      rows.map((row) => row.fields.title).sort(),
      JSON.stringify(all),
    ).toEqual(["Copy", "Original"]);
    expect(new Set(rows.map((row) => row.tab_instance_id)).size).toBe(2);
  });
});

// ---- revision 1 -------------------------------------------------------------------------------------------------------------------------

/** One tab on A, controlled, its form ready, with B installed and waiting ("Save and reload" offered). */
async function oneTabWithUpdate(
  context: BrowserContext,
  world: Generations,
): Promise<Page> {
  await seedAccount(context, world);
  const page = await openApp(context, world);
  await workerActive(page);
  await reloadQuietly(page);
  await formReady(page);
  await world.serve("fixture-b");
  await checkForUpdate(page);
  await expect(
    updateRegion(page).getByRole("button", { name: "Save and reload" }),
  ).toBeVisible();
  return page;
}

/** The registered form's own flush (what a peer's flush request or a proactive save runs), and the registry's dirty count. */
const flushNow = (page: Page) =>
  page.evaluate(() => {
    const forms = (
      window as unknown as {
        __atlasForms: { dirty(): Array<{ flush(): Promise<string> }> };
      }
    ).__atlasForms;
    return forms.dirty()[0]?.flush() ?? Promise.resolve("clean");
  });
const dirtyCount = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __atlasForms: { dirty(): unknown[] } }
      ).__atlasForms.dirty().length,
  );

/** "Save and reload" (after quiet), then B is displayed with the form ready. */
async function saveAndReload(page: Page): Promise<void> {
  await mark(page);
  await quiet(page);
  await updateRegion(page)
    .getByRole("button", { name: "Save and reload" })
    .click();
  await reloadedOntoB(page);
}
async function reloadedOntoB(page: Page): Promise<void> {
  await expect.poll(() => marked(page).catch(() => false)).toBe(false);
  await displayed(page);
  await expect.poll(() => build(page)).toBe("b");
  await formReady(page);
}

test.describe("revision 1, R2: a form back at its clean values after a save is dirty, and its obsolete copy is not restored", () => {
  test("saved, then cleared back to the mount value: the registry says dirty, and B shows the empty form with nothing restored", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("stale proactive copy");
    expect(await flushNow(page)).toBe("saved");
    expect(await dirtyCount(page)).toBe(0);
    await title(page).fill("");
    expect(await dirtyCount(page)).toBe(1);
    await saveAndReload(page);
    await expect(title(page)).toHaveValue("");
    await expect(restoredBanner(page)).toHaveCount(0);
    expect(
      (await recoveryRows(context, generations)).filter((row) => !row.terminal),
    ).toEqual([]);
  });
});

test.describe("revision 1, R3: nothing can be typed between the last save and the reload", () => {
  test("while another tab is still saving, the acting tab's form takes no input; B restores what it showed at 'Save and reload'", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("before accept");
    // TEST INJECTION: another tab (a channel peer) that says it is saving at once and finishes 2 s later, inside the production bound.
    await page.evaluate(() => {
      const peer = new BroadcastChannel("atlas-app-update");
      (window as unknown as { __peer: BroadcastChannel }).__peer = peer;
      peer.onmessage = ({ data }) => {
        if (data?.type !== "flush-request") return;
        peer.postMessage({
          type: "flush-started",
          id: `${data.id}:peer`,
          dirty: 1,
        });
        setTimeout(
          () =>
            peer.postMessage({
              type: "flush-done",
              id: `${data.id}:peer`,
              failed: 0,
            }),
          2_000,
        );
      };
    });
    await mark(page);
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(
      updateRegion(page).getByText("Reloading Atlas…", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("form[aria-label='Fixture note']"),
    ).toHaveAttribute("inert", "");
    // The same input the review's probe used: it must not reach the field while the reload waits.
    // Revision 2 (strengthened, not weakened): the attempts are bounded well inside the 2 s wait, and the value is read without retrying
    // and then shown to have been read on THIS page (generation A): a retrying assertion could otherwise be met by the page B the reload
    // brings, which restores the same value (revision 1 read it with `toHaveValue` after a 1 s attempt).
    await title(page)
      .fill("typed while reload waits", { timeout: 300 })
      .catch(() => undefined);
    await page.keyboard.type(" and keys");
    expect(await title(page).inputValue()).toBe("before accept");
    expect(await marked(page)).toBe(true);
    await reloadedOntoB(page);
    await expect(title(page)).toHaveValue("before accept");
  });

  test("a failed save gives the form back: it takes input again", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("keep typing");
    await failRecoveryWrites(page, 1_000);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
    await expect(
      page.locator("form[aria-label='Fixture note']"),
    ).not.toHaveAttribute("inert");
    await title(page).fill("keep typing, more");
    await expect(title(page)).toHaveValue("keep typing, more");
  });
});

test.describe("revision 1, R4: a save asked for before a submission never brings the submitted input back", () => {
  test("the first save waits for the page's recovery lock while the form is submitted: it writes nothing, and nothing is restored", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("already submitted input");
    // TEST INJECTION: the grant of this page's recovery-identifier lock (`atlas-recovery-tab-<id>`) is held until the test releases it.
    await page.evaluate(() => {
      const scope = window as unknown as {
        __held?: boolean;
        __grant?: () => void;
        __pending?: Promise<string>;
        __atlasForms: { dirty(): Array<{ flush(): Promise<string> }> };
      };
      const request = navigator.locks.request.bind(navigator.locks);
      (navigator.locks as unknown as { request: typeof request }).request = ((
        name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) => {
        if (name.startsWith("atlas-recovery-tab-") && !options.ifAvailable)
          return request(name, options, async (lock) => {
            scope.__held = true;
            await new Promise<void>((resolve) => {
              scope.__grant = resolve;
            });
            return callback(lock);
          });
        return request(name, options, callback);
      }) as typeof request;
      scope.__pending = scope.__atlasForms.dirty()[0]?.flush();
    });
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __held?: boolean }).__held),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Save note", exact: true }).click();
    await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
      "data-submitted",
      "1",
    );
    expect(
      await page.evaluate(() => {
        const scope = window as unknown as {
          __grant: () => void;
          __pending: Promise<string>;
        };
        scope.__grant();
        return scope.__pending;
      }),
    ).toBe("failed");
    await saveAndReload(page);
    await expect(title(page)).toHaveValue("");
    await expect(restoredBanner(page)).toHaveCount(0);
  });
});

test.describe("revision 1, R5: no number of discarded rows hides a durable copy", () => {
  test("120 terminal rows of other tabs whose ids sort first: the current copy is still restored after the reload", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("latest durable copy");
    expect(await flushNow(page)).toBe("saved");
    // TEST INJECTION: 120 discarded copies of the same form under tab ids that sort before every UUID (raw IndexedDB, at the database's own
    // version: the rows have the store's shape, as other tabs' discards would leave them).
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("atlas-acct-a");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction("form_recovery", "readwrite");
      const store = tx.objectStore("form_recovery");
      const rows: Array<Record<string, unknown>> = await new Promise(
        (resolve, reject) => {
          const all = store.getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        },
      );
      const live = rows.find((row) => !row.terminal);
      if (!live) throw new Error("no live copy");
      for (let i = 0; i < 120; i += 1)
        store.put({
          ...live,
          tab_instance_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          terminal: true,
          fields: {},
          saved_at: "2020-01-01T00:00:00.000Z",
        });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    });
    await saveAndReload(page);
    await expect(title(page)).toHaveValue("latest durable copy");
    await expect(restoredBanner(page)).toContainText(RESTORED);
  });
});

test.describe("revision 1, R6: 'Discard and reload anyway' discards the copies, and says so when it cannot", () => {
  test("a copy saved earlier is discarded: B shows the form empty and restores nothing", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("previously saved input");
    expect(await flushNow(page)).toBe("saved");
    await title(page).fill("discard this form");
    // TEST INJECTION: a save (a non-terminal write) of `form_recovery` throws; a discard (a terminal write) does not.
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        if (
          this.name === "form_recovery" &&
          (args[0] as { terminal?: boolean }).terminal !== true
        )
          throw new DOMException("injected write failure", "UnknownError");
        return put.apply(this, args);
      };
    });
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
    await mark(page);
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Discard and reload anyway" })
      .click();
    await reloadedOntoB(page);
    await expect(title(page)).toHaveValue("");
    await expect(restoredBanner(page)).toHaveCount(0);
  });

  test("a discard that cannot be written: the tab says so and does not reload; 'Reload anyway' reloads knowing the copy may come back", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("previously saved input");
    expect(await flushNow(page)).toBe("saved");
    await title(page).fill("discard this form");
    await failRecoveryWrites(page, 1_000);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
    await mark(page);
    await updateRegion(page)
      .getByRole("button", { name: "Discard and reload anyway" })
      .click();
    await expect(updateRegion(page).getByText(DISCARD_FAILED)).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(await marked(page)).toBe(true);
    await expect(title(page)).toHaveValue("discard this form");
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Reload anyway" })
      .click();
    await reloadedOntoB(page);
    // As the person was told: the earlier copy comes back (nothing was claimed discarded).
    await expect(title(page)).toHaveValue("previously saved input");
  });
});

test.describe("revision 1, F-1 (reassessed): a page that boots does not cost another tab its unsaved input", () => {
  /** Marks the form element, so the test can tell that the protected tree was mounted again (the mark is gone with the old element). */
  const markForm = (page: Page) =>
    page.evaluate(() => {
      const form = document.querySelector("[data-fixture-form]") as
        | (Element & { __pwaFormMark?: number })
        | null;
      if (form) form.__pwaFormMark = 1;
    });
  const formMarked = (page: Page) =>
    page.evaluate(
      () =>
        (
          document.querySelector("[data-fixture-form]") as
            | (Element & { __pwaFormMark?: number })
            | null
        )?.__pwaFormMark === 1,
    );

  test("input typed, never saved; another tab boots and remounts this one's tree: the input is still there", async ({
    context,
    generations,
    browserName,
  }, info) => {
    await seedAccount(context, generations);
    const first = await openApp(context, generations);
    await formReady(first);
    await title(first).fill("typed, never saved");
    await markForm(first);
    // Another page boots: every open tab checks its session, which MAY mount its protected tree again (WEB-08a/09a behaviour; not on every
    // boot, and Playwright's WebKit shows no such check: WEB-09a revision 23). Up to three real boots, each followed by up to 5 s for the
    // remount; the input must be there whether or not one came, and the report says whether the carry was exercised. The deterministic
    // schedules are the unit cases (`use-recoverable-form.test.tsx`, MU-1796..MU-1801). The first driver attempt of revision 1 required a
    // remount in Chromium and Firefox and failed there when none came (run 2026-10-10T17-48-39.299Z-27de41e8, preserved).
    // Revision 2 (harness budget, labelled): Playwright's WebKit never shows the remount, so this case always runs its whole designed loop
    // (three real boots, each followed by 50 polls of 100 ms plus the poll itself). Under load one poll took 0.13-0.2 s and the third
    // boot's window ran into the default 30 s test timeout (revision-2 driver attempt 3, run 2026-10-10T22-15-01.193Z-0ec50521: the input
    // was there after boots one and two). The loop, its windows and its assertions are unchanged; the case is given a budget its own worst
    // case fits.
    test.setTimeout(60_000);
    let remounts = 0;
    for (let boot = 0; boot < 3 && remounts === 0; boot += 1) {
      const other = await openApp(context, generations);
      await formReady(other);
      for (let i = 0; i < 50 && remounts === 0; i += 1) {
        if (!(await formMarked(first))) remounts += 1;
        else await first.waitForTimeout(100);
      }
      await formReady(first);
      await expect(title(first)).toHaveValue("typed, never saved");
      if (remounts === 0) await markForm(first);
    }
    info.annotations.push({
      type: "remount",
      description:
        remounts > 0
          ? `${browserName}: the first tab's protected tree was mounted again; the carried input was there`
          : `${browserName}: no remount after three peer boots: the case did not exercise the carry in this run`,
    });
    await formReady(first);
    await expect(title(first)).toHaveValue("typed, never saved");
  });

  test("P-U5 in the original order: typed in two tabs BEFORE a third tab opens and accepts; both copies are saved", async ({
    context,
    generations,
  }) => {
    const [first, second] = await twoTabsWithUpdate(context, generations);
    await title(first).fill("Original");
    await title(second).fill("Second");
    const acting = await openApp(context, generations, { form: false });
    await formReady(first);
    await formReady(second);
    await expect(title(first)).toHaveValue("Original");
    await expect(title(second)).toHaveValue("Second");
    await mark(acting);
    await quiet(acting);
    await updateRegion(acting).getByRole("button", { name: "Reload" }).click();
    await expect.poll(() => marked(acting).catch(() => false)).toBe(false);
    await displayed(acting);
    await expect(
      updateRegion(second).getByText(BANNER.elsewhere),
    ).toBeVisible();
    const rows = (await recoveryRows(context, generations)).filter(
      (row) => !row.terminal,
    );
    expect(rows.map((row) => row.fields.title).sort()).toEqual([
      "Original",
      "Second",
    ]);
  });
});

// ---- revision 2 -------------------------------------------------------------------------------------------------------------------------

type FixtureWindow = {
  __atlasRemountForm?: () => void;
  __atlasFormProps?: (props: {
    formContext?: string;
    allow?: string[];
    shown?: string[];
    unbound?: boolean;
    without?: string[];
  }) => void;
  __atlasFormMounts?: number;
  __atlasSubmitGate?: Promise<unknown>;
  __releaseSubmit?: (ok: boolean) => void;
};
const fixtureForm = (page: Page) =>
  page.locator("form[aria-label='Fixture note']");

/**
 * TEST INJECTION: the form mounted again in its place (`__atlasRemountForm`, the remount another page's boot causes, F-1), forced so the
 * schedule happens in every engine. The check that it happened: the mount counter moved on and the old form element is gone.
 */
async function remountForm(
  page: Page,
  /** Revision 3 (R11): the new mount's allow-list, given in the same render as the remount (no transition in the old mount). */
  allow?: string[],
): Promise<void> {
  const before = await page.evaluate(
    () => (window as unknown as FixtureWindow).__atlasFormMounts ?? 0,
  );
  await fixtureForm(page).evaluate((form) => {
    (form as unknown as { __old?: boolean }).__old = true;
  });
  await page.evaluate((next) => {
    const scope = window as unknown as FixtureWindow;
    if (next) scope.__atlasFormProps?.({ allow: next });
    scope.__atlasRemountForm?.();
  }, allow);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).__atlasFormMounts ?? 0,
      ),
    )
    .toBe(before + 1);
  expect(
    await fixtureForm(page).evaluate(
      (form) => (form as unknown as { __old?: boolean }).__old === true,
    ),
  ).toBe(false);
  await formReady(page);
}

/** TEST INJECTION: another tab (a channel peer) that says it is saving at once and finishes 2 s later, inside the production bound. */
const slowPeer = (page: Page) =>
  page.evaluate(() => {
    const peer = new BroadcastChannel("atlas-app-update");
    (window as unknown as { __peer: BroadcastChannel }).__peer = peer;
    peer.onmessage = ({ data }) => {
      if (data?.type !== "flush-request") return;
      peer.postMessage({
        type: "flush-started",
        id: `${data.id}:peer`,
        dirty: 1,
      });
      setTimeout(
        () =>
          peer.postMessage({
            type: "flush-done",
            id: `${data.id}:peer`,
            failed: 0,
          }),
        2_000,
      );
    };
  });

/** The live (restorable) rows' titles. */
/**
 * ADAPTED (revision 6, R13; owner decision of 12 October 2026): the titles of the ORDINARY non-terminal copies. Was: every non-terminal
 * row. An update now also writes a hand-off copy (`handoffTitles`), which no ordinary page lists; the cases that run an update assert it
 * separately.
 */
const liveTitles = async (context: BrowserContext, world: Generations) =>
  (await recoveryRows(context, world))
    .filter((row) => !row.terminal && !isHandoffRow(row))
    .map((row) => row.fields.title);
/** Revision 6 (R13): the titles of the non-terminal update hand-offs. */
const handoffTitles = async (context: BrowserContext, world: Generations) =>
  (await recoveryRows(context, world))
    .filter((row) => !row.terminal && isHandoffRow(row))
    .map((row) => row.fields.title);

test.describe("revision 2, R2: one baseline across a remount (the form's session)", () => {
  test("'one' and 'two' saved, 'three' carried by a forced remount; its first save moves the baseline, 'two' again is dirty, and B restores 'two'", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("one");
    expect(await flushNow(page)).toBe("saved");
    await title(page).fill("two");
    expect(await flushNow(page)).toBe("saved");
    expect(await dirtyCount(page)).toBe(0);
    await title(page).fill("three");
    await remountForm(page);
    await expect(title(page)).toHaveValue("three");
    expect(await flushNow(page)).toBe("saved");
    expect(await liveTitles(context, generations)).toEqual(["three"]);
    expect(await dirtyCount(page)).toBe(0);
    await title(page).fill("two");
    expect(await dirtyCount(page)).toBe(1);
    await saveAndReload(page);
    await expect(title(page)).toHaveValue("two");
  });
});

test.describe("revision 2, R4: a submission in the form mounted again overtakes the save its previous mount asked for", () => {
  test("the first save waits for the page's recovery lock; the form is mounted again and submitted there: the save writes nothing, nothing is restored", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("submitted after remount");
    // TEST INJECTION: the grant of this page's recovery-identifier lock (`atlas-recovery-tab-<id>`) is held until the test releases it.
    await page.evaluate(() => {
      const scope = window as unknown as {
        __held?: boolean;
        __grant?: () => void;
        __pending?: Promise<string>;
        __atlasForms: { dirty(): Array<{ flush(): Promise<string> }> };
      };
      const request = navigator.locks.request.bind(navigator.locks);
      (navigator.locks as unknown as { request: typeof request }).request = ((
        name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) => {
        if (name.startsWith("atlas-recovery-tab-") && !options.ifAvailable)
          return request(name, options, async (lock) => {
            scope.__held = true;
            await new Promise<void>((resolve) => {
              scope.__grant = resolve;
            });
            return callback(lock);
          });
        return request(name, options, callback);
      }) as typeof request;
      scope.__pending = scope.__atlasForms.dirty()[0]?.flush();
    });
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __held?: boolean }).__held),
      )
      .toBe(true);
    await remountForm(page);
    await expect(title(page)).toHaveValue("submitted after remount");
    await page.getByRole("button", { name: "Save note", exact: true }).click();
    await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
      "data-submitted",
      "1",
    );
    expect(
      await page.evaluate(() => {
        const scope = window as unknown as {
          __grant: () => void;
          __pending: Promise<string>;
        };
        scope.__grant();
        return scope.__pending;
      }),
    ).toBe("failed");
    expect(await liveTitles(context, generations)).toEqual([]);
    await saveAndReload(page);
    await expect(title(page)).toHaveValue("");
    await expect(restoredBanner(page)).toHaveCount(0);
  });
});

test.describe("revision 2, R3: while the tab prepares the reload, the recovery controls are unavailable and the forms stay as saved", () => {
  /** Two closed-owner copies in the account's store; the newest is restored, the older offered; B is waiting. */
  async function twoCopies(
    context: BrowserContext,
    world: Generations,
  ): Promise<Page> {
    await seedAccount(context, world);
    const seed = await context.newPage();
    await navigate(seed, `${world.url}/__data`);
    await seed.waitForFunction(() => window.__atlasData !== undefined);
    expect(
      await seed.evaluate(async () => {
        const data = window.__atlasData;
        if (!data) throw new Error("no data harness");
        data.setRuntimeIdentity({ account: "acct-a", epoch: 1 });
        const opened = await data.openService("acct-a");
        if (opened !== "opened") throw new Error(`service ${opened}`);
        const port = data.formRecovery("acct-a");
        const results: string[] = [];
        for (const [id, value, at] of [
          ["closed-older", "older selected copy", "2026-01-01T00:00:00.000Z"],
          ["closed-newer", "newest initial copy", "2026-01-02T00:00:00.000Z"],
        ] as const)
          results.push(
            await port.save({
              formContext: "fixture-note:/today",
              tabInstanceId: id,
              values: { title: value, notes: "" },
              savedAt: at,
            }),
          );
        data.close("acct-a");
        return results;
      }),
    ).toEqual(["saved", "saved"]);
    await seed.close();
    const page = await openApp(context, world);
    await workerActive(page);
    await reloadQuietly(page);
    await formReady(page);
    await expect(title(page)).toHaveValue("newest initial copy");
    await expect(page.locator("[data-alternatives]")).toHaveAttribute(
      "data-alternatives",
      "1",
    );
    await world.serve("fixture-b");
    await checkForUpdate(page);
    await expect(
      updateRegion(page).getByRole("button", { name: "Save and reload" }),
    ).toBeVisible();
    return page;
  }
  const olderCopy = (page: Page) =>
    page.getByRole("button", {
      name: "Restore the copy saved 2026-01-01T00:00:00.000Z",
      exact: true,
    });

  test("control: the older copy chosen BEFORE 'Save and reload' is what B restores", async ({
    context,
    generations,
  }) => {
    const page = await twoCopies(context, generations);
    await olderCopy(page).click();
    await expect(title(page)).toHaveValue("older selected copy");
    await saveAndReload(page);
    await expect(title(page)).toHaveValue("older selected copy");
  });

  test("during the 2 s wait for another tab: 'Restore the copy…' and 'Discard instead' are disabled and change nothing; B restores what the form showed", async ({
    context,
    generations,
  }) => {
    const page = await twoCopies(context, generations);
    await slowPeer(page);
    await mark(page);
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(
      updateRegion(page).getByText("Reloading Atlas…", { exact: true }),
    ).toBeVisible();
    await expect(fixtureForm(page)).toHaveAttribute("inert", "");
    await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
      "data-locked",
      "true",
    );
    await expect(olderCopy(page)).toBeDisabled();
    await expect(olderCopy(page)).toHaveAccessibleDescription(
      "Unavailable while Atlas saves your form and reloads.",
    );
    const discardInstead = page
      .locator('[data-recovery-state="restored"]')
      .getByRole("button", { name: "Discard instead" });
    await expect(discardInstead).toBeDisabled();
    // The same click the review made, bounded well inside the 2 s wait: it must change nothing. The value is read without retrying, and
    // the mark shows every check above was made on THIS page (generation A, still waiting), not on the page the reload brings (a retrying
    // assertion could be met there: generation B restores the newest copy too).
    await olderCopy(page)
      .click({ timeout: 300 })
      .catch(() => undefined);
    await discardInstead.click({ timeout: 300 }).catch(() => undefined);
    expect(await title(page).inputValue()).toBe("newest initial copy");
    expect(await marked(page)).toBe(true);
    await reloadedOntoB(page);
    await expect(title(page)).toHaveValue("newest initial copy");
  });

  test("the form mounted again during the 2 s wait (a forced remount) is held still with what was saved, and B restores it", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("before accept");
    await slowPeer(page);
    await mark(page);
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(
      updateRegion(page).getByText("Reloading Atlas…", { exact: true }),
    ).toBeVisible();
    await remountForm(page);
    await expect(fixtureForm(page)).toHaveAttribute("inert", "");
    await expect(title(page)).toHaveValue("before accept");
    await title(page)
      .fill("typed into the new mount", { timeout: 300 })
      .catch(() => undefined);
    expect(await title(page).inputValue()).toBe("before accept");
    expect(await marked(page)).toBe(true);
    await reloadedOntoB(page);
    await expect(title(page)).toHaveValue("before accept");
  });

  for (const outcome of ["succeeds", "fails"] as const)
    test(`a submission sent before 'Save and reload' is waited for; it ${outcome}: ${outcome === "succeeds" ? "nothing is restored" : "B restores the input"}`, async ({
      context,
      generations,
    }) => {
      const page = await oneTabWithUpdate(context, generations);
      await title(page).fill("submitted while updating");
      expect(await flushNow(page)).toBe("saved");
      // TEST INJECTION: the fixture form's "send" waits for the test (`__atlasSubmitGate`).
      await page.evaluate(() => {
        const scope = window as unknown as FixtureWindow;
        scope.__atlasSubmitGate = new Promise((resolve, reject) => {
          scope.__releaseSubmit = (ok) =>
            ok ? resolve(undefined) : reject(new Error("not sent"));
        });
      });
      await page
        .getByRole("button", { name: "Save note", exact: true })
        .click();
      await mark(page);
      await quiet(page);
      await updateRegion(page)
        .getByRole("button", { name: "Save and reload" })
        .click();
      await expect(
        updateRegion(page).getByText(
          "Saving your unfinished form before reloading…",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(fixtureForm(page)).toHaveAttribute("inert", "");
      await page.waitForTimeout(1_000);
      expect(await marked(page)).toBe(true);
      await page.evaluate(
        (ok) => (window as unknown as FixtureWindow).__releaseSubmit?.(ok),
        outcome === "succeeds",
      );
      await reloadedOntoB(page);
      if (outcome === "succeeds") {
        await expect(title(page)).toHaveValue("");
        await expect(restoredBanner(page)).toHaveCount(0);
        expect(await liveTitles(context, generations)).toEqual([]);
      } else {
        await expect(title(page)).toHaveValue("submitted while updating");
        await expect(restoredBanner(page)).toBeVisible();
      }
    });
});

// ---- revision 3 -------------------------------------------------------------------------------------------------------------------------

/** TEST INJECTION (revision 3, R10/R11): the same mount renders with another form context or allow-list (`__atlasFormProps`, fixture only). */
const formProps = async (
  page: Page,
  props: { formContext?: string; allow?: string[]; shown?: string[] },
): Promise<void> => {
  await page.evaluate(
    (next) => (window as unknown as FixtureWindow).__atlasFormProps?.(next),
    props,
  );
  if (props.formContext)
    await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
      "data-form-context",
      props.formContext,
    );
  await formReady(page);
};

/** The live (restorable) rows of the account's store: their form context and fields. */
const liveRows = async (context: BrowserContext, world: Generations) =>
  (await recoveryRows(context, world))
    .filter((row) => !row.terminal)
    .map((row) => ({ context: row.form_context, fields: row.fields }));

/** TEST INJECTION: the fixture form's "send" waits for the test (`__atlasSubmitGate`); `release(ok)` answers it. */
const holdSubmission = (page: Page) =>
  page.evaluate(() => {
    const scope = window as unknown as FixtureWindow;
    scope.__atlasSubmitGate = new Promise((resolve, reject) => {
      scope.__releaseSubmit = (ok) =>
        ok ? resolve(undefined) : reject(new Error("not sent"));
    });
  });
const releaseSubmission = (page: Page, ok: boolean) =>
  page.evaluate(
    (answer) => (window as unknown as FixtureWindow).__releaseSubmit?.(answer),
    ok,
  );
const pendingCount = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __atlasForms: { pending(): number } }
    ).__atlasForms.pending(),
  );

test.describe("revision 3, R3: a submission's success acknowledges what it SENT; input changed after the send survives the update reload", () => {
  test("sent, then changed, then 'Save and reload': the coordinator waits for the send, its success keeps the change, and B restores it", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("submitted text");
    expect(await flushNow(page)).toBe("saved");
    await holdSubmission(page);
    await page.getByRole("button", { name: "Save note", exact: true }).click();
    expect(await pendingCount(page)).toBe(1);
    await title(page).fill("LATER UNSENT EDIT");
    await mark(page);
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(
      updateRegion(page).getByText(
        "Saving your unfinished form before reloading…",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(fixtureForm(page)).toHaveAttribute("inert", "");
    expect(await title(page).inputValue()).toBe("LATER UNSENT EDIT");
    expect(await marked(page)).toBe(true);
    await releaseSubmission(page, true);
    await reloadedOntoB(page);
    await expect(title(page)).toHaveValue("LATER UNSENT EDIT");
    await expect(restoredBanner(page)).toBeVisible();
    expect(await liveTitles(context, generations)).toEqual([
      "LATER UNSENT EDIT",
    ]);
    // Revision 6 (R13): the update's hand-off holds the same later input (this page's source until it saves its own copy).
    expect(await handoffTitles(context, generations)).toEqual([
      "LATER UNSENT EDIT",
    ]);
  });
});

test.describe("revision 3, R10: a ticket completes in the form context it was sent from", () => {
  for (const late of [true, false])
    test(`${late ? "context A's success arrives after the form shows context B" : "control: no late answer from A"}: B's unsent copy and input stay${late ? ", A's sent copy is discarded" : ""}`, async ({
      context,
      generations,
    }) => {
      await seedAccount(context, generations);
      const page = await openApp(context, generations);
      await formReady(page);
      await title(page).fill("A submitted");
      expect(await flushNow(page)).toBe("saved");
      if (late) {
        await holdSubmission(page);
        await page
          .getByRole("button", { name: "Save note", exact: true })
          .click();
        expect(await pendingCount(page)).toBe(1);
      }
      await formProps(page, { formContext: "fixture-note:/other" });
      await title(page).fill("B unsent");
      expect(await flushNow(page)).toBe("saved");
      if (late) {
        await releaseSubmission(page, true);
        await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
          "data-submitted",
          "1",
        );
        await expect.poll(() => pendingCount(page)).toBe(0);
      }
      await expect(title(page)).toHaveValue("B unsent");
      expect(await dirtyCount(page)).toBe(0);
      const rows = await liveRows(context, generations);
      expect(
        rows
          .filter((row) => row.context === "fixture-note:/other")
          .map((row) => row.fields.title),
      ).toEqual(["B unsent"]);
      expect(
        rows
          .filter((row) => row.context === "fixture-note:/today")
          .map((row) => row.fields.title),
      ).toEqual(late ? [] : ["A submitted"]);
    });
});

test.describe("revision 3, R11: the mounted allow-list is what the form's session admits", () => {
  test("expanded on a remount: the carried title is restored and the newly admitted notes are captured with it", async ({
    context,
    generations,
  }) => {
    await seedAccount(context, generations);
    const page = await openApp(context, generations);
    await formReady(page);
    // A form context whose session is opened by a title-only mount (the default context's session admits both fields from the start).
    await formProps(page, {
      formContext: "fixture-note:/expand",
      allow: ["title"],
    });
    await title(page).fill("saved title");
    expect(await flushNow(page)).toBe("saved");
    await remountForm(page, ["title", "notes"]);
    await expect(title(page)).toHaveValue("saved title");
    expect(await dirtyCount(page)).toBe(0);
    await notes(page).fill("new notes");
    expect(await flushNow(page)).toBe("saved");
    expect(await liveRows(context, generations)).toEqual([
      {
        context: "fixture-note:/expand",
        fields: { notes: "new notes", title: "saved title" },
      },
    ]);
  });

  test("reduced on a remount: input in the removed field is never captured", async ({
    context,
    generations,
  }) => {
    await seedAccount(context, generations);
    const page = await openApp(context, generations);
    await formReady(page);
    await title(page).fill("old title");
    expect(await flushNow(page)).toBe("saved");
    await remountForm(page, ["title"]);
    await expect(title(page)).toHaveValue("old title");
    await title(page).fill("new title");
    await notes(page).fill("NOW EXCLUDED INPUT");
    expect(await flushNow(page)).toBe("saved");
    expect(await liveRows(context, generations)).toEqual([
      { context: "fixture-note:/today", fields: { title: "new title" } },
    ]);
  });

  test("reduced on a remount while the removed field holds input: the update cannot save it, says so, and nothing reloads", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("title");
    await notes(page).fill("unfinished notes");
    expect(await flushNow(page)).toBe("saved");
    await remountForm(page, ["title"]);
    expect(await dirtyCount(page)).toBe(1);
    expect(await flushNow(page)).toBe("failed");
    await mark(page);
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(
      updateRegion(page).getByText(SAVE_FAILED, { exact: true }),
    ).toBeVisible();
    expect(await marked(page)).toBe(true);
    expect(await liveRows(context, generations)).toEqual([
      {
        context: "fixture-note:/today",
        fields: { notes: "unfinished notes", title: "title" },
      },
    ]);
  });
});

test.describe("revision 3, R12: a page saves a copy only under an identifier whose lock it holds", () => {
  test("the owning lock is refused once: the save fails and writes nothing, another page takes nothing over; the retry holds a lock, and the copy is restorable only after the page goes", async ({
    context,
    generations,
  }) => {
    await seedAccount(context, generations);
    const first = await openApp(context, generations);
    await formReady(first);
    // TEST INJECTION: only this page's FIRST owning request for its recovery-identifier lock (`atlas-recovery-tab-<id>`) is rejected, as a
    // failing lock manager would; the store, the probes and every other page's locks are untouched.
    await first.evaluate(() => {
      const scope = window as unknown as { __refused?: number };
      const request = navigator.locks.request.bind(navigator.locks);
      (navigator.locks as unknown as { request: typeof request }).request = ((
        name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) => {
        if (
          name.startsWith("atlas-recovery-tab-") &&
          !options.ifAvailable &&
          (scope.__refused ?? 0) === 0
        ) {
          scope.__refused = 1;
          return Promise.reject(
            new DOMException("injected lock failure", "UnknownError"),
          );
        }
        return request(name, options, callback);
      }) as typeof request;
    });
    await title(first).fill("still editing in the first tab");
    expect(await flushNow(first)).toBe("failed");
    expect(
      await first.evaluate(
        () => (window as unknown as { __refused?: number }).__refused,
      ),
    ).toBe(1);
    expect(await liveTitles(context, generations)).toEqual([]);
    expect(await dirtyCount(first)).toBe(1);
    await expect(title(first)).toHaveValue("still editing in the first tab");

    const second = await openApp(context, generations);
    await formReady(second);
    await expect(title(second)).toHaveValue("");
    await expect(restoredBanner(second)).toHaveCount(0);

    // The retry is a new acquisition: it holds its lock, so the copy stays the open first tab's.
    expect(await flushNow(first)).toBe("saved");
    expect(await liveTitles(context, generations)).toEqual([
      "still editing in the first tab",
    ]);
    await second.reload();
    await displayed(second);
    await formReady(second);
    await expect(title(second)).toHaveValue("");
    await expect(restoredBanner(second)).toHaveCount(0);

    await first.close();
    await second.reload();
    await displayed(second);
    await formReady(second);
    await expect(title(second)).toHaveValue("still editing in the first tab");
    await expect(restoredBanner(second)).toBeVisible();
  });
});

// ---- revision 4 -------------------------------------------------------------------------------------------------------------------------

/**
 * Revision 4 (review of 11 October 2026, R3 and R11; design assessment Q1, Q4, Q5, Q11): the reviewer's three reproductions and their
 * controls, maintained, over the real `form_recovery` store, Web Locks, the A/B worker generations, production timers and headers.
 */
test.describe("revision 4, R3: a later edit back to an EARLIER successful submission survives the update reload", () => {
  for (const later of ["FIRST SUBMITTED", "LATER NEW INPUT"])
    test(`A succeeded; B saved and sent; the person types ${later === "FIRST SUBMITTED" ? "A again" : "a distinct later text (control)"}; 'Save and reload' waits for B; B succeeds; B restores the later input`, async ({
      context,
      generations,
    }) => {
      const page = await oneTabWithUpdate(context, generations);
      await title(page).fill("FIRST SUBMITTED");
      await page
        .getByRole("button", { name: "Save note", exact: true })
        .click();
      await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
        "data-submitted",
        "1",
      );
      expect(await dirtyCount(page)).toBe(0);
      await title(page).fill("SECOND SEND");
      expect(await flushNow(page)).toBe("saved");
      await holdSubmission(page);
      await page
        .getByRole("button", { name: "Save note", exact: true })
        .click();
      expect(await pendingCount(page)).toBe(1);
      await title(page).fill(later);
      expect(await dirtyCount(page)).toBe(1);
      await mark(page);
      await quiet(page);
      await updateRegion(page)
        .getByRole("button", { name: "Save and reload" })
        .click();
      await expect(fixtureForm(page)).toHaveAttribute("inert", "");
      expect(await title(page).inputValue()).toBe(later);
      expect(await marked(page)).toBe(true);
      await releaseSubmission(page, true);
      await reloadedOntoB(page);
      await expect(title(page)).toHaveValue(later);
      await expect(restoredBanner(page)).toBeVisible();
      await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
        "data-submitted",
        "0",
      );
      expect(await liveTitles(context, generations)).toEqual([later]);
      // Revision 6 (R13): the update's hand-off holds the same later input.
      expect(await handoffTitles(context, generations)).toEqual([later]);
    });
});

test.describe("revision 4, R11: the committed allow-list admits, the empty list included", () => {
  test("the list narrowed to none while the form is blank: the title typed afterwards is never captured", async ({
    context,
    generations,
  }) => {
    await seedAccount(context, generations);
    const page = await openApp(context, generations);
    await formReady(page);
    await formProps(page, { allow: [] });
    await title(page).fill("EXCLUDED AFTER EMPTY LIST");
    expect(await dirtyCount(page)).toBe(0);
    expect(await flushNow(page)).toBe("clean");
    expect(await liveRows(context, generations)).toEqual([]);
  });
});

test.describe("revision 4, R11: a field that leaves the page keeps its unfinished input", () => {
  for (const narrowed of [true, false])
    test(`notes typed, then the field removed${narrowed ? " with its admission in one render" : " from the page only (a conditional field hidden)"}: 'Save and reload' cannot save and says so; shown again, 'Retry save' saves it and B restores it`, async ({
      context,
      generations,
    }) => {
      const page = await oneTabWithUpdate(context, generations);
      await notes(page).fill("UNFINISHED NOTES");
      await formProps(
        page,
        narrowed
          ? { allow: ["title"], shown: ["title"] }
          : { shown: ["title"] },
      );
      await expect(notes(page)).toHaveCount(0);
      expect(await dirtyCount(page)).toBe(1);
      await mark(page);
      await quiet(page);
      await updateRegion(page)
        .getByRole("button", { name: "Save and reload" })
        .click();
      await expect(
        updateRegion(page).getByText(SAVE_FAILED, { exact: true }),
      ).toBeVisible();
      expect(await marked(page)).toBe(true);
      expect(await liveRows(context, generations)).toEqual([]);
      await formProps(page, {
        allow: ["title", "notes"],
        shown: ["title", "notes"],
      });
      await expect(notes(page)).toHaveValue("UNFINISHED NOTES");
      await updateRegion(page)
        .getByRole("button", { name: "Retry save" })
        .click();
      await reloadedOntoB(page);
      await expect(notes(page)).toHaveValue("UNFINISHED NOTES");
      await expect(restoredBanner(page)).toBeVisible();
    });

  test("control: a removed field that was never edited is no obligation; the update saves the title and reloads", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await title(page).fill("title only");
    await formProps(page, { allow: ["title"], shown: ["title"] });
    await saveAndReload(page);
    await expect(title(page)).toHaveValue("title only");
  });
});

// ---- revision 5 -------------------------------------------------------------------------------------------------------------------------

/**
 * Revision 5 (review of 11 October 2026: R3 at late binding, incomplete fix; R13, a restored copy taken for protection; design assessment
 * of 11 October 2026, Q1, Q5-Q8, Q11): over the real `form_recovery` store, Web Locks and, in the update cases, the A/B worker generations
 * with production timers and headers. FIXTURE evidence (no released backend).
 */
const ORIGINAL = "ORIGINAL UNSENT";
const PEER = "PEER NEW INPUT";

/** How many forms the page's registry lists (sessions with work outstanding, and mounts that have no session yet). */
const formsCount = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __atlasForms: { all(): unknown[] } }
      ).__atlasForms.all().length,
  );
/** Every dirty form's flush, as the update coordinator runs them; the results in registry order. */
const flushAll = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      (
        window as unknown as {
          __atlasForms: { dirty(): Array<{ flush(): Promise<string> }> };
        }
      ).__atlasForms
        .dirty()
        .map((form) => form.flush()),
    ),
  );

/**
 * TEST INJECTION (revision 5, R3): the form mounted again in its place WITHOUT its port (`unbound`, fixture only), as when the account's
 * database is not open yet: the new mount has no session until `bindForm`. Checked: the mount counter moved, the old element is gone.
 */
async function remountUnbound(page: Page): Promise<void> {
  const before = await page.evaluate(
    () => (window as unknown as FixtureWindow).__atlasFormMounts ?? 0,
  );
  await fixtureForm(page).evaluate((form) => {
    (form as unknown as { __old?: boolean }).__old = true;
  });
  await page.evaluate(() => {
    const scope = window as unknown as FixtureWindow;
    scope.__atlasFormProps?.({ unbound: true });
    scope.__atlasRemountForm?.();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).__atlasFormMounts ?? 0,
      ),
    )
    .toBe(before + 1);
  expect(
    await fixtureForm(page).evaluate(
      (form) => (form as unknown as { __old?: boolean }).__old === true,
    ),
  ).toBe(false);
  await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
    "data-port",
    "none",
  );
}
/** The unbound mount gets its port: it binds the page's session for the form and looks for copies. */
async function bindForm(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).__atlasFormProps?.({ unbound: false }),
  );
  await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
    "data-port",
    "open",
  );
  await formReady(page);
}

/**
 * TEST INJECTION (revision 5, R13): this page's request for its recovery-identifier lock (`atlas-recovery-tab-<id>`, never an `ifAvailable`
 * probe) waits until `releaseRecoveryLock`, so its first save is held between its capture and its write. Every other lock is untouched.
 */
const holdRecoveryLock = (page: Page) =>
  page.evaluate(() => {
    const scope = window as unknown as {
      __recoveryLockAsked?: number;
      __releaseRecoveryLock?: () => void;
    };
    const request = navigator.locks.request.bind(navigator.locks);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scope.__releaseRecoveryLock = release;
    (navigator.locks as unknown as { request: typeof request }).request = ((
      name: string,
      options: LockOptions,
      callback: LockGrantedCallback<unknown>,
    ) => {
      if (name.startsWith("atlas-recovery-tab-") && !options.ifAvailable) {
        scope.__recoveryLockAsked = (scope.__recoveryLockAsked ?? 0) + 1;
        return gate.then(() => request(name, options, callback));
      }
      return request(name, options, callback);
    }) as typeof request;
  });
const recoveryLockAsked = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __recoveryLockAsked?: number })
        .__recoveryLockAsked ?? 0,
  );
const releaseRecoveryLock = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __releaseRecoveryLock?: () => void }
    ).__releaseRecoveryLock?.(),
  );

/**
 * A submission that succeeds at once while the title field KEEPS FOCUS with its typed value not yet committed (as a keyboard shortcut or a
 * control outside the form submits it: `requestSubmit()`, no Enter key and no click, which would both commit the field with a change event
 * first), and the form says it happened. The removal of that focused field is where Chromium fires its change event (revision 5).
 */
async function submitKeepingFocus(page: Page, sent: number): Promise<void> {
  await title(page).focus();
  await fixtureForm(page).evaluate((form) =>
    (form as HTMLFormElement).requestSubmit(),
  );
  await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
    "data-submitted",
    String(sent),
  );
  expect(
    await page.evaluate(
      () => (document.activeElement as HTMLInputElement | null)?.name ?? null,
    ),
  ).toBe("title");
}

/**
 * The first page typed ORIGINAL and saved it, then reloaded (a new page, the old one gone): it restores that copy, S. With `peer`, a
 * second page opened afterwards restores the same S. With `update`, both are on generation A, controlled, and B is waiting.
 */
async function restorers(
  context: BrowserContext,
  world: Generations,
  options: { peer: boolean; update: boolean },
): Promise<{ first: Page; peer: Page | null }> {
  await seedAccount(context, world);
  const first = await openApp(context, world);
  if (options.update) {
    await workerActive(first);
    await reloadQuietly(first);
  }
  await formReady(first);
  await title(first).fill(ORIGINAL);
  expect(await flushNow(first)).toBe("saved");
  await reloadQuietly(first);
  await formReady(first);
  await expect(title(first)).toHaveValue(ORIGINAL);
  let peer: Page | null = null;
  if (options.peer) {
    peer = await openApp(context, world);
    await settledPeer(peer, [first]);
    await expect(title(peer)).toHaveValue(ORIGINAL);
    await quiet(peer);
  }
  if (options.update) {
    await world.serve("fixture-b");
    await checkForUpdate(first);
  }
  await quiet(first);
  return { first, peer };
}
/** A plain reload of the page (no update): the next page, with its form ready. */
async function nextPage(page: Page): Promise<void> {
  await reloadQuietly(page);
  await formReady(page);
}

test.describe("revision 5, R3: an edit typed before the form had its database keeps its provenance (store and locks, no update)", () => {
  for (const unbound of [true, false])
    test(`${unbound ? "" : "control: "}SENT A submitted with the field still focused; ${unbound ? "an UNBOUND" : "a bound"} remount typed SENT A again${unbound ? ", then bound" : ""}: dirty, saved, and the next page restores it`, async ({
      context,
      generations,
    }) => {
      await seedAccount(context, generations);
      const page = await openApp(context, generations);
      await formReady(page);
      await title(page).fill("SENT A");
      await submitKeepingFocus(page, 1);
      expect(await dirtyCount(page)).toBe(0);
      if (unbound) {
        // Removes the FOCUSED field (Chromium fires a change event at its removal): the old session stays clean and unlisted, and only
        // the new mount's provisional handle is listed.
        await remountUnbound(page);
        await expect.poll(() => formsCount(page)).toBe(1);
        expect(await dirtyCount(page)).toBe(0);
      } else await remountForm(page);
      await title(page).fill("INTERMEDIATE");
      await title(page).fill("SENT A");
      expect(await dirtyCount(page)).toBe(1);
      if (unbound) {
        await bindForm(page);
        await expect(title(page)).toHaveValue("SENT A");
        expect(await dirtyCount(page)).toBe(1);
      }
      expect(await flushAll(page)).toEqual(["saved"]);
      await nextPage(page);
      await expect(title(page)).toHaveValue("SENT A");
      await expect(restoredBanner(page)).toBeVisible();
    });
});

test.describe("revision 5, R13: a restored copy is shared; each page that restored it saves its own (store and locks, no update)", () => {
  type PeerAct = {
    name: string;
    deletes: boolean;
    run: (peer: Page) => Promise<void>;
  };
  const acts: PeerAct[] = [
    {
      name: "the other page saves different input",
      deletes: true,
      run: async (peer) => {
        await title(peer).fill(PEER);
        expect(await flushNow(peer)).toBe("saved");
      },
    },
    {
      name: "control: the other page changes nothing",
      deletes: false,
      run: async () => undefined,
    },
    {
      name: "the other page's submission succeeds",
      deletes: true,
      run: async (peer) => {
        await peer
          .getByRole("button", { name: "Save note", exact: true })
          .click();
        await expect(peer.locator("[data-fixture-form]")).toHaveAttribute(
          "data-submitted",
          "1",
        );
      },
    },
    {
      name: "control: the other page's submission fails",
      deletes: false,
      run: async (peer) => {
        await holdSubmission(peer);
        await peer
          .getByRole("button", { name: "Save note", exact: true })
          .click();
        await releaseSubmission(peer, false);
        expect(await pendingCount(peer)).toBe(0);
      },
    },
    {
      name: "the other page's 'Discard instead'",
      deletes: true,
      run: async (peer) => {
        await peer.getByRole("button", { name: "Discard instead" }).click();
        await expect(restoredBanner(peer)).toHaveCount(0);
        await expect(title(peer)).toHaveValue("");
      },
    },
    {
      name: "control: the other page's 'Discard instead' cannot be written",
      deletes: false,
      run: async (peer) => {
        await failRecoveryWrites(peer, 2);
        await peer.getByRole("button", { name: "Discard instead" }).click();
        await expect(title(peer)).toHaveValue("");
      },
    },
  ];
  for (const act of acts)
    test(`two pages restored S; ${act.name}; the first page's flush and reload keep ORIGINAL`, async ({
      context,
      generations,
    }) => {
      const { first, peer } = await restorers(context, generations, {
        peer: true,
        update: false,
      });
      if (!peer) throw new Error("no peer");
      await act.run(peer);
      await expect
        .poll(async () =>
          (await liveTitles(context, generations)).includes(ORIGINAL),
        )
        .toBe(!act.deletes);
      await expect(title(first)).toHaveValue(ORIGINAL);
      const results = await flushAll(first);
      await nextPage(first);
      await expect(title(first)).toHaveValue(ORIGINAL);
      await expect(restoredBanner(first)).toBeVisible();
      // The first page owned its protection: its flush saved a copy of its own.
      expect(results).toEqual(["saved"]);
    });

  for (const peerDeletes of [true, false])
    test(`${peerDeletes ? "" : "control: "}the first page's save held between capture and write (its identity lock)${peerDeletes ? "; meanwhile the other page saves different input, deleting S" : ""}; the save lands ORIGINAL`, async ({
      context,
      generations,
    }) => {
      const { first, peer } = await restorers(context, generations, {
        peer: true,
        update: false,
      });
      if (!peer) throw new Error("no peer");
      await holdRecoveryLock(first);
      await first.evaluate(() => {
        const forms = (
          window as unknown as {
            __atlasForms: { dirty(): Array<{ flush(): Promise<string> }> };
            __flushing?: Promise<string[]>;
          }
        ).__atlasForms;
        (window as unknown as { __flushing?: Promise<string[]> }).__flushing =
          Promise.all(forms.dirty().map((form) => form.flush()));
      });
      await expect.poll(() => recoveryLockAsked(first)).toBeGreaterThan(0);
      if (peerDeletes) {
        await title(peer).fill(PEER);
        expect(await flushNow(peer)).toBe("saved");
        expect(await liveTitles(context, generations)).toEqual([PEER]);
      }
      await releaseRecoveryLock(first);
      const results = await first.evaluate(
        () =>
          (window as unknown as { __flushing?: Promise<string[]> }).__flushing,
      );
      await nextPage(first);
      await expect(title(first)).toHaveValue(ORIGINAL);
      expect(results).toEqual(["saved"]);
    });

  for (const fails of [true, false])
    test(`${fails ? "" : "control: "}the first page's own save ${fails ? "fails once: it stays dirty, S stays; the retry saves" : "succeeds"}; the next page restores ORIGINAL`, async ({
      context,
      generations,
    }) => {
      const { first } = await restorers(context, generations, {
        peer: false,
        update: false,
      });
      if (fails) {
        await failRecoveryWrites(first, 1);
        expect(await flushAll(first)).toEqual(["failed"]);
        expect(await dirtyCount(first)).toBe(1);
        expect(await liveTitles(context, generations)).toEqual([ORIGINAL]);
      }
      expect(await flushAll(first)).toEqual(["saved"]);
      expect(await dirtyCount(first)).toBe(0);
      await nextPage(first);
      await expect(title(first)).toHaveValue(ORIGINAL);
    });

  for (const third of [true, false])
    test(`hand-off: the first page closes${third ? "; a third page restores its copy before the next page lists" : " (control: no third page)"}; the next page restores ORIGINAL`, async ({
      context,
      generations,
    }) => {
      const { first } = await restorers(context, generations, {
        peer: false,
        update: false,
      });
      expect(await flushAll(first)).toEqual(["saved"]);
      await first.close();
      if (third) {
        const reader = await openApp(context, generations);
        await formReady(reader);
        await expect(title(reader)).toHaveValue(ORIGINAL);
      }
      const next = await openApp(context, generations);
      await formReady(next);
      await expect(title(next)).toHaveValue(ORIGINAL);
    });
});

test.describe("revision 5: the real worker update (generations A to B) keeps late-bound and shared-source input", () => {
  for (const unbound of [true, false])
    test(`R3: ${unbound ? "" : "control: "}SENT A submitted with the field still focused; ${unbound ? "an unbound" : "a bound"} remount typed SENT A again; 'Save and reload'; B restores it`, async ({
      context,
      generations,
    }) => {
      const page = await oneTabWithUpdate(context, generations);
      await title(page).fill("SENT A");
      await submitKeepingFocus(page, 1);
      if (unbound) {
        await remountUnbound(page);
        await expect.poll(() => formsCount(page)).toBe(1);
        expect(await dirtyCount(page)).toBe(0);
      } else await remountForm(page);
      await title(page).fill("INTERMEDIATE");
      await title(page).fill("SENT A");
      if (unbound) await bindForm(page);
      await expect(title(page)).toHaveValue("SENT A");
      expect(await dirtyCount(page)).toBe(1);
      await saveAndReload(page);
      await expect(title(page)).toHaveValue("SENT A");
      await expect(restoredBanner(page)).toBeVisible();
      await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
        "data-submitted",
        "0",
      );
    });

  for (const peerEdits of [true, false])
    test(`R13: two pages restored S; ${peerEdits ? "the other page saves different input" : "control: the other page changes nothing"}; the first page's update keeps ORIGINAL with the other page still open`, async ({
      context,
      generations,
    }) => {
      const { first, peer } = await restorers(context, generations, {
        peer: true,
        update: true,
      });
      if (!peer) throw new Error("no peer");
      if (peerEdits) {
        await title(peer).fill(PEER);
        expect(await flushNow(peer)).toBe("saved");
      }
      await expect(title(first)).toHaveValue(ORIGINAL);
      await saveAndReload(first);
      await expect(title(first)).toHaveValue(ORIGINAL);
      await expect(first.locator("[data-fixture-form]")).toHaveAttribute(
        "data-submitted",
        "0",
      );
      if (peerEdits) await expect(title(peer)).toHaveValue(PEER);
    });

  for (const peerDeletes of [true, false])
    test(`R13: ${peerDeletes ? "" : "control: "}the first page's save held at its identity lock after 'Save and reload'${peerDeletes ? " while the other page saves different input" : " (the other page makes no edit; its peer flush still cleans S up)"}; nothing reloads until it lands; B restores ORIGINAL`, async ({
      context,
      generations,
    }) => {
      const { first, peer } = await restorers(context, generations, {
        peer: true,
        update: true,
      });
      if (!peer) throw new Error("no peer");
      await holdRecoveryLock(first);
      await mark(first);
      await quiet(first);
      await updateRegion(first)
        .getByRole("button", { name: "Save and reload" })
        .click();
      await expect.poll(() => recoveryLockAsked(first)).toBeGreaterThan(0);
      if (peerDeletes) {
        await title(peer).fill(PEER);
        expect(await flushNow(peer)).toBe("saved");
      }
      // One live row (with the edit: the other page's own copy, S gone; without: S or that page's copy of it): nothing of the first page's.
      await expect
        .poll(() => liveTitles(context, generations))
        .toEqual([peerDeletes ? PEER : ORIGINAL]);
      expect(
        (await recoveryRows(context, generations)).filter(
          (row) => !row.terminal,
        ),
      ).toHaveLength(1);
      expect(await marked(first)).toBe(true);
      expect(await title(first).inputValue()).toBe(ORIGINAL);
      await releaseRecoveryLock(first);
      await reloadedOntoB(first);
      await expect(title(first)).toHaveValue(ORIGINAL);
      await expect(restoredBanner(first)).toBeVisible();
    });

  for (const fails of [true, false])
    test(`R13: ${fails ? "" : "control: "}a restored form's own save ${fails ? "fails: 'Save and reload' stops with 'could not save', S stays; 'Retry save' saves" : "succeeds"}; B restores ORIGINAL`, async ({
      context,
      generations,
    }) => {
      const { first } = await restorers(context, generations, {
        peer: false,
        update: true,
      });
      await mark(first);
      if (fails) {
        await failRecoveryWrites(first, 1);
        await quiet(first);
        await updateRegion(first)
          .getByRole("button", { name: "Save and reload" })
          .click();
        await expect(
          updateRegion(first).getByText(SAVE_FAILED, { exact: true }),
        ).toBeVisible();
        expect(await marked(first)).toBe(true);
        expect(await liveTitles(context, generations)).toEqual([ORIGINAL]);
        await updateRegion(first)
          .getByRole("button", { name: "Retry save" })
          .click();
        await reloadedOntoB(first);
      } else await saveAndReload(first);
      await expect(title(first)).toHaveValue(ORIGINAL);
      await expect(restoredBanner(first)).toBeVisible();
    });
});

// ---- revision 6 -------------------------------------------------------------------------------------------------------------------------

/**
 * Revision 6 (review of 11 October 2026, R13 `recovery-shared-source-reload-coverage`, incomplete fix; design assessment of 11 October 2026,
 * Q3/Q4; owner decision of 12 October 2026: "protected hand-off", an abandoned hand-off "revealed, can't be removed"). Through the REAL
 * update (generations A to B, production timers and headers): A types ORIGINAL and accepts "Save and reload"; the NEXT document of A's tab
 * (A2) is held before its first Web Lock request (an init script on that tab only: nothing of A, the worker, the other tab or any lock
 * already held changes); another tab C restores A's ordinary copy and acts on it; then A2 is released. The review's matrix (no C, restore
 * only, unchanged save, divergent save) plus the legs it did not run through the worker (discard, a successful submission). FIXTURE evidence.
 */
/**
 * The NEXT page of this tab starts its form unbound (fixture `atlas-fixture-hold-form`): it makes no recovery read until `releaseNext`.
 * Revision 6 harness note: an init script wrapping `navigator.locks.request` (the review's gate) was installed in WebKit only after the
 * reloaded document's first lock requests in 3 of 8 runs (`.agtx/evidence/WEB-14a/revision-6/q-pwa-r6-1`), so it is not used here.
 */
const holdNextDocument = (page: Page) =>
  page.evaluate(() => sessionStorage.setItem("atlas-fixture-hold-form", "1"));
const releaseNext = (page: Page) =>
  page.evaluate(() => {
    sessionStorage.removeItem("atlas-fixture-hold-form");
    (window as unknown as FixtureWindow).__atlasFormProps?.({ unbound: false });
  });

/** A typed ORIGINAL on generation A and accepted "Save and reload"; A2 (on B) is held before its first lock request. */
async function updatedAndHeld(
  context: BrowserContext,
  world: Generations,
): Promise<Page> {
  await seedAccount(context, world);
  const first = await openApp(context, world);
  await workerActive(first);
  await reloadQuietly(first);
  await formReady(first);
  await title(first).fill(ORIGINAL);
  await world.serve("fixture-b");
  await checkForUpdate(first);
  await quiet(first);
  await mark(first);
  await holdNextDocument(first);
  await updateRegion(first)
    .getByRole("button", { name: "Save and reload", exact: true })
    .click();
  await expect.poll(() => build(first).catch(() => null)).toBe("b");
  // A2 is the page B brought (A's mark is gone), its form held unbound: it has read nothing.
  await expect.poll(() => marked(first).catch(() => true)).toBe(false);
  await expect(first.locator("[data-fixture-form]")).toHaveAttribute(
    "data-port",
    "none",
  );
  return first;
}

/** The non-terminal rows, as [hand-off or ordinary, title]. */
const liveCopies = async (context: BrowserContext, world: Generations) =>
  (await recoveryRows(context, world))
    .filter((row) => !row.terminal)
    .map((row) => [
      isHandoffRow(row) ? "handoff" : "ordinary",
      row.fields.title,
    ]);

test.describe("revision 6, R13: the update hands the form to the next page of the tab, whatever another tab does with the copies", () => {
  type Act = {
    name: string;
    control?: boolean;
    run(peer: Page): Promise<void>;
  };
  const acts: Act[] = [
    { name: "no other tab", control: true, run: async () => undefined },
    { name: "C restores only", control: true, run: async () => undefined },
    {
      name: "C saves it unchanged",
      run: async (peer) => {
        expect(await flushAll(peer)).toEqual(["saved"]);
      },
    },
    {
      name: "C saves different input",
      run: async (peer) => {
        await title(peer).fill(PEER);
        expect(await flushAll(peer)).toEqual(["saved"]);
      },
    },
    {
      name: "C's 'Discard instead'",
      run: async (peer) => {
        await peer.getByRole("button", { name: "Discard instead" }).click();
        await expect(title(peer)).toHaveValue("");
        await expect.poll(() => pendingCount(peer)).toBe(0);
      },
    },
    {
      name: "C's submission succeeds",
      run: async (peer) => {
        await peer
          .getByRole("button", { name: "Save note", exact: true })
          .click();
        await expect(peer.locator("[data-fixture-form]")).toHaveAttribute(
          "data-submitted",
          "1",
        );
        await expect.poll(() => pendingCount(peer)).toBe(0);
      },
    },
  ];
  for (const act of acts)
    test(`${act.control ? "control: " : ""}${act.name} while A2 is held; A2 restores ORIGINAL on B, nothing submitted`, async ({
      context,
      generations,
    }) => {
      const first = await updatedAndHeld(context, generations);
      // The hand-off was written before the reload.
      expect(await liveCopies(context, generations)).toContainEqual([
        "handoff",
        ORIGINAL,
      ]);
      let peer: Page | null = null;
      if (act.name !== "no other tab") {
        peer = await openApp(context, generations);
        await settledPeer(peer, [first]);
        await expect(title(peer)).toHaveValue(ORIGINAL);
        await act.run(peer);
      }
      // Whatever C did, the hand-off is still there.
      expect(await liveCopies(context, generations)).toContainEqual([
        "handoff",
        ORIGINAL,
      ]);
      await releaseNext(first);
      await bindForm(first);
      await expect(title(first)).toHaveValue(ORIGINAL);
      await expect(restoredBanner(first)).toBeVisible();
      await expect(first.locator("[data-fixture-form]")).toHaveAttribute(
        "data-submitted",
        "0",
      );
      // A2's own save removes the hand-off (only the page holding it may).
      expect(await flushAll(first)).toEqual(["saved"]);
      expect(
        (await liveCopies(context, generations)).filter(
          ([where]) => where === "handoff",
        ),
      ).toEqual([]);
    });

  /** As above, but A2 never comes back (its tab is closed while held), and C removes A's ordinary copy: only the hand-off is left. */
  async function abandoned(
    context: BrowserContext,
    world: Generations,
  ): Promise<Page> {
    const first = await updatedAndHeld(context, world);
    await first.close();
    const peer = await openApp(context, world);
    await formReady(peer);
    await expect(title(peer)).toHaveValue(ORIGINAL);
    await peer.getByRole("button", { name: "Discard instead" }).click();
    await expect(title(peer)).toHaveValue("");
    await expect.poll(() => pendingCount(peer)).toBe(0);
    await peer.close();
    expect(await liveCopies(context, world)).toEqual([["handoff", ORIGINAL]]);
    const later = await openApp(context, world);
    await formReady(later);
    // Offered, never restored at once.
    await expect(title(later)).toHaveValue("");
    await expect(restoredBanner(later)).toHaveCount(0);
    await expect(later.locator('[data-handoff="true"]')).toHaveCount(1);
    return later;
  }

  test("abandoned: a later page may restore the hand-off; its own save leaves the hand-off where it is", async ({
    context,
    generations,
  }) => {
    const later = await abandoned(context, generations);
    await later
      .getByRole("button", { name: /^Restore the copy saved / })
      .click();
    await expect(title(later)).toHaveValue(ORIGINAL);
    expect(await flushAll(later)).toEqual(["saved"]);
    expect(await liveCopies(context, generations)).toContainEqual([
      "handoff",
      ORIGINAL,
    ]);
  });

  test("abandoned: only the explicit 'Discard the copy' removes the hand-off", async ({
    context,
    generations,
  }) => {
    const later = await abandoned(context, generations);
    await later
      .getByRole("button", { name: /^Discard the copy saved / })
      .click();
    await expect(later.locator('[data-handoff="true"]')).toHaveCount(0);
    expect(await liveCopies(context, generations)).toEqual([]);
  });
});

// ---- revision 7 -------------------------------------------------------------------------------------------------------------------------

/**
 * Revision 7 (review of 13 October 2026, R6 `update-discard-recovery-invalidation`, regression; R13 `recovery-shared-source-reload-coverage`,
 * incomplete fix; design assessment of 13 October 2026, Q1 and Q4). Through the REAL update (generations A to B, production timers, COOP):
 *  - R6: the form's own copy is saved (the form is clean), then its hand-off or its reference cannot be written. "Discard and reload
 *    anyway" must discard what that save wrote: B shows the form empty, nothing submitted, no copy left. Controls: no failure; the storage
 *    repaired and "Retry save".
 *  - R13: the page the update brings cannot read the hand-off once (fixture TEST INJECTION `atlas-fixture-fail-handoff-read`, the real
 *    port's first hand-off read refused) after another tab took A's ordinary copy and saved different input: it is NOT ready, shows nothing
 *    restored and says so; the hand-off is still there; "Try again" restores ORIGINAL, unsubmitted. FIXTURE evidence.
 */
/** TEST INJECTION (revision 7, R6): every write of the tab's hand-off reference fails (sessionStorage refuses it) until `repairReference`. */
const failReference = (page: Page) =>
  page.evaluate(() => {
    const original = Storage.prototype.setItem;
    const scope = window as unknown as {
      __refFailures?: number;
      __repairReference?: () => void;
    };
    scope.__refFailures = 0;
    scope.__repairReference = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === sessionStorage && key === "atlas-update-handoff") {
        scope.__refFailures = (scope.__refFailures ?? 0) + 1;
        throw new DOMException(
          "injected reference failure",
          "QuotaExceededError",
        );
      }
      return original.call(this, key, value);
    };
  });
const repairReference = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __repairReference?: () => void }
    ).__repairReference?.(),
  );
/** TEST INJECTION (revision 7, R6): every write of a hand-off ROW of `form_recovery` throws (the transaction aborts); ordinary rows are written. */
const failHandoffRows = (page: Page) =>
  page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const row = args[0] as { form_context?: unknown } | undefined;
      if (
        this.name === "form_recovery" &&
        typeof row?.form_context === "string" &&
        row.form_context.startsWith("atlas-update-handoff:")
      )
        throw new DOMException(
          "injected hand-off write failure",
          "UnknownError",
        );
      return put.apply(this, args);
    };
  });

// ---- revision 13 ------------------------------------------------------------------------------------------------------------------------

/**
 * Revision 13 (F-8; review of 15 October 2026, R20 `recovery-peer-save-unexplained-failure`). C's flush in the revision-6 case "C saves it
 * unchanged" once answered `["failed"]` in Firefox: the original trace shows C's tree torn down for a session check (`1e.checking`, then
 * `1e.interrupted_online`) before the flush began, and the diagnosis (`.agtx/evidence/WEB-14a/revision-13/f8`) reproduced exactly that
 * answer with C's tree held closed: the save never reaches the store, because a form no mount shows has no database while the account is
 * not displayed (`flushSession`: no pinned target). Here that closure is FORCED after C has settled, in every engine: every identity read
 * waits (`holdIdentity`), D boots and goes away while its read waits, so its request lease is left unresolved and every displayed page of
 * the account closes its tree and checks the session with a read that waits too. The save fails closed: nothing written or removed, the
 * tab is not reloaded, the input is kept; once the session check finishes and C is shown again, its save lands and A2 still restores
 * ORIGINAL with nothing submitted. FIXTURE evidence.
 */
test.describe("revision 13, F-8: a peer whose tree is closed for a session check when it saves", () => {
  // `typed`: C first types input of its own that is in no copy (PEER), so what C shows again can only be its own kept input, never a
  // copy read back from the store (which holds ORIGINAL); unchanged: exactly F-8's case.
  for (const typed of [false, true])
    test(`C's save ${typed ? "of input it typed " : ""}fails while its tree is closed: nothing written or removed, input kept, no reload; once shown again it saves; A2 restores ORIGINAL`, async ({
      context,
      generations,
    }) => {
      const first = await updatedAndHeld(context, generations);
      const peer = await openApp(context, generations);
      await settledPeer(peer, [first]);
      await expect(title(peer)).toHaveValue(ORIGINAL);
      const mine = typed ? PEER : ORIGINAL;
      if (typed) await title(peer).fill(PEER);
      await mark(peer);
      await generations.holdIdentity(true);
      const away = await context.newPage();
      await navigate(
        away,
        `${generations.url}/__session?${new URLSearchParams({ sticky: "1", route: "/today" })}`,
      );
      // D's identity read is waiting: D's kernel has issued a request whose lease stands in the record, and the server holds a read. (A
      // fetch count is not enough: D's first fetch is `/health`, before any lease; revision-13 attempt 1, WebKit, closed D that early.)
      await expect
        .poll(
          async () =>
            (await generations.holdIdentity(true)) > 0 &&
            (await away.evaluate(async () => {
              const session = (
                window as unknown as {
                  __atlasFixture?: {
                    session?: {
                      trace: Array<{
                        event: string;
                        data?: { lease?: string };
                      }>;
                      readRecords(): Promise<unknown>;
                    };
                  };
                }
              ).__atlasFixture?.session;
              if (!session) return false;
              const issued = session.trace
                .filter((entry) => entry.event === "request.issued")
                .map((entry) => entry.data?.lease)
                .filter((lease): lease is string => typeof lease === "string");
              const records = (await session.readRecords()) as {
                auth_state?: { leases?: Record<string, unknown> };
              };
              const standing = records.auth_state?.leases ?? {};
              return issued.some((lease) => lease in standing);
            })),
        )
        .toBe(true);
      // C is the page in front (visible), so it watches D's lease whatever an engine does with a background page.
      await peer.bringToFront();
      expect(await peer.evaluate(() => document.visibilityState)).toBe(
        "visible",
      );
      await away.close();
      const shown = (page: Page) =>
        page.evaluate(() => ({
          tree:
            document.getElementById("protected-root")?.childElementCount ?? 0,
          neutral:
            document
              .querySelector("[data-neutral-state]")
              ?.getAttribute("data-neutral-state") ?? null,
        }));
      // C's tree is torn down for the session check, as in the original trace.
      await expect
        .poll(() => shown(peer))
        .toEqual({ tree: 0, neutral: "1e.interrupted_online" });
      expect(await flushAll(peer)).toEqual(["failed"]);
      // Nothing of C's was written and nothing removed: A's ordinary copy and the hand-off stand as they were. C was not reloaded.
      expect((await liveCopies(context, generations)).sort()).toEqual([
        ["handoff", ORIGINAL],
        ["ordinary", ORIGINAL],
      ]);
      expect(await marked(peer)).toBe(true);
      // The session check finishes: C is shown again with its input, and its save lands.
      expect(await generations.holdIdentity(false)).toBeGreaterThan(0);
      await displayed(peer);
      await formReady(peer);
      await expect(title(peer)).toHaveValue(mine);
      expect(await marked(peer)).toBe(true);
      expect(await flushAll(peer)).toEqual(["saved"]);
      // C's own copy holds what it showed (A's ordinary copy, the source it restored, is replaced by it); the hand-off is untouched.
      expect((await liveCopies(context, generations)).sort()).toEqual([
        ["handoff", ORIGINAL],
        ["ordinary", mine],
      ]);
      await releaseNext(first);
      await bindForm(first);
      await expect(title(first)).toHaveValue(ORIGINAL);
      await expect(restoredBanner(first)).toBeVisible();
      await expect(first.locator("[data-fixture-form]")).toHaveAttribute(
        "data-submitted",
        "0",
      );
      expect(await flushAll(first)).toEqual(["saved"]);
      expect(
        (await liveCopies(context, generations)).filter(
          ([where]) => where === "handoff",
        ),
      ).toEqual([]);
    });
});

test.describe("revision 7, R6: 'Discard and reload anyway' after a save that failed part of the way discards what it wrote", () => {
  type Leg = {
    name: string;
    fail?: "reference" | "row";
    choice: "none" | "retry" | "discard";
  };
  const legs: Leg[] = [
    { name: "control: nothing fails", choice: "none" },
    {
      name: "control: the reference fails, repaired, 'Retry save'",
      fail: "reference",
      choice: "retry",
    },
    {
      name: "the reference fails, 'Discard and reload anyway'",
      fail: "reference",
      choice: "discard",
    },
    {
      name: "the hand-off row fails, 'Discard and reload anyway'",
      fail: "row",
      choice: "discard",
    },
  ];
  for (const leg of legs)
    test(`${leg.name}: B shows ${leg.choice === "discard" ? "the form empty, no copy left" : "ORIGINAL"}, nothing submitted`, async ({
      context,
      generations,
    }) => {
      await seedAccount(context, generations);
      const page = await openApp(context, generations);
      await workerActive(page);
      await reloadQuietly(page);
      await formReady(page);
      await title(page).fill(ORIGINAL);
      await generations.serve("fixture-b");
      await checkForUpdate(page);
      await quiet(page);
      if (leg.fail === "reference") await failReference(page);
      if (leg.fail === "row") await failHandoffRows(page);
      await updateRegion(page)
        .getByRole("button", { name: "Save and reload", exact: true })
        .click();
      if (leg.fail) {
        await expect(
          updateRegion(page).getByRole("button", {
            name: "Retry save",
            exact: true,
          }),
        ).toBeVisible();
        // The decisive precondition: the form's own copy WAS saved (it is clean) and A did not reload.
        expect(
          await page.evaluate(
            () =>
              (
                window as unknown as { __atlasForms: { dirty(): unknown[] } }
              ).__atlasForms.dirty().length,
          ),
        ).toBe(0);
        expect(await build(page)).toBe("a");
        expect(
          (await liveCopies(context, generations)).filter(
            ([where]) => where === "ordinary",
          ),
        ).toEqual([["ordinary", ORIGINAL]]);
        if (leg.fail === "reference")
          expect(
            await page.evaluate(
              () =>
                (window as unknown as { __refFailures?: number }).__refFailures,
            ),
          ).toBeGreaterThan(0);
        if (leg.choice === "retry") await repairReference(page);
        await updateRegion(page)
          .getByRole("button", {
            name:
              leg.choice === "retry"
                ? "Retry save"
                : "Discard and reload anyway",
            exact: true,
          })
          .click();
      }
      await expect.poll(() => build(page).catch(() => null)).toBe("b");
      await displayed(page);
      await formReady(page);
      await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
        "data-submitted",
        "0",
      );
      if (leg.choice === "discard") {
        await expect(title(page)).toHaveValue("");
        await expect(restoredBanner(page)).toHaveCount(0);
        // Nothing of A's left that a later page could restore: no ordinary copy, no hand-off.
        expect(await liveCopies(context, generations)).toEqual([]);
      } else {
        await expect(title(page)).toHaveValue(ORIGINAL);
        await expect(restoredBanner(page)).toBeVisible();
      }
    });
});

test.describe("revision 7, R13: a successor that cannot read the hand-off says so, and 'Try again' restores it", () => {
  for (const failing of [false, true])
    test(`${failing ? "" : "control: "}C takes A's ordinary copy and saves different input; A2's first hand-off read ${failing ? "fails: not ready, nothing restored, then 'Try again' restores ORIGINAL" : "succeeds: ORIGINAL"}`, async ({
      context,
      generations,
    }) => {
      const first = await updatedAndHeld(context, generations);
      if (failing)
        await first.evaluate(() =>
          sessionStorage.setItem("atlas-fixture-fail-handoff-read", "1"),
        );
      const peer = await openApp(context, generations);
      await settledPeer(peer, [first]);
      await expect(title(peer)).toHaveValue(ORIGINAL);
      await title(peer).fill(PEER);
      expect(await flushAll(peer)).toEqual(["saved"]);
      // C consumed A's ordinary copy and stays alive; the hand-off is untouched.
      expect(await liveCopies(context, generations)).toEqual(
        expect.arrayContaining([
          ["handoff", ORIGINAL],
          ["ordinary", PEER],
        ]),
      );
      // A2's form is mounted again, still unbound, so it reads the injection from its session storage (set after A2 booted); the control
      // makes the same remount without it.
      await first.evaluate(() =>
        (window as unknown as FixtureWindow).__atlasRemountForm?.(),
      );
      await releaseNext(first);
      const form = first.locator("[data-fixture-form]");
      await expect(form).toHaveAttribute("data-port", "open");
      if (failing) {
        await expect(form).toHaveAttribute("data-unavailable", "true");
        await expect(form).toHaveAttribute("data-ready", "false");
        await expect(
          first.locator('[data-recovery-state="unavailable"]'),
        ).toBeVisible();
        await expect(title(first)).toHaveValue("");
        await expect(restoredBanner(first)).toHaveCount(0);
        await expect(first.locator("[data-alternatives]")).toHaveCount(0);
        // Nothing removed or forgotten: the hand-off and its reference are still there.
        expect(await liveCopies(context, generations)).toContainEqual([
          "handoff",
          ORIGINAL,
        ]);
        expect(
          await first.evaluate(() =>
            sessionStorage.getItem("atlas-update-handoff"),
          ),
        ).not.toBeNull();
        await first
          .getByRole("button", { name: "Try again", exact: true })
          .click();
      }
      await formReady(first);
      await expect(form).toHaveAttribute("data-unavailable", "false");
      await expect(title(first)).toHaveValue(ORIGINAL);
      await expect(restoredBanner(first)).toBeVisible();
      await expect(form).toHaveAttribute("data-submitted", "0");
      // C keeps its own input.
      await expect(title(peer)).toHaveValue(PEER);
    });
});

// ---- revision 8 -------------------------------------------------------------------------------------------------------------------------

/**
 * Revision 8 (review of 13 October 2026: R16 `recovery-equal-value-twin-authority`, R17 `recovery-control-state-value-projection`; design
 * assessment of 13 October 2026, C1-C4, step 6) through the REAL update (generations A to B, production timers and headers, the real store,
 * locks and session storage). R16: B opens first and saves, and stays open, so A starts independently; A types ORIGINAL and accepts "Save and
 * reload"; while A2 is held, B saves `bText` (A's text, or other text: the control) LATER than A and closes; A2 restores the hand-off and
 * its "Discard instead" must remove A's copy and the hand-off, never B's, asserted by row identity. R17: a checkbox and a multiple select
 * (fixture `atlas-fixture-choices`) carried by the update, with a text-only control. FIXTURE evidence.
 */
test.describe("revision 8, R16: an update hand-off removes exactly its own predecessor (actual worker A to B)", () => {
  for (const same of [false, true])
    test(`${same ? "" : "control: "}B's later copy holds ${same ? "A's very text" : "other text"}: A2's 'Discard instead' removes A's copy and the hand-off, B's copy stays`, async ({
      context,
      generations,
    }) => {
      await seedAccount(context, generations);
      const peer = await openApp(context, generations);
      await formReady(peer);
      await title(peer).fill("B FIRST");
      expect(await flushAll(peer)).toEqual(["saved"]);
      const ordinaryIds = async () =>
        (await recoveryRows(context, generations))
          .filter((row) => !row.terminal && !isHandoffRow(row))
          .map((row) => row.tab_instance_id)
          .sort();
      const [bId] = await ordinaryIds();
      const first = await openApp(context, generations);
      await workerActive(first);
      await reloadQuietly(first);
      await formReady(first);
      // B is open: A starts independently.
      await expect(title(first)).toHaveValue("");
      await title(first).fill(ORIGINAL);
      await generations.serve("fixture-b");
      await checkForUpdate(first);
      await quiet(first);
      await mark(first);
      await holdNextDocument(first);
      await updateRegion(first)
        .getByRole("button", { name: "Save and reload", exact: true })
        .click();
      await expect.poll(() => build(first).catch(() => null)).toBe("b");
      await expect.poll(() => marked(first).catch(() => true)).toBe(false);
      await expect(first.locator("[data-fixture-form]")).toHaveAttribute(
        "data-port",
        "none",
      );
      const aId = (await ordinaryIds()).find((id) => id !== bId);
      expect(aId).toBeDefined();
      await title(peer).fill(same ? ORIGINAL : "B INDEPENDENT");
      expect(await flushAll(peer)).toEqual(["saved"]);
      await peer.close();
      await releaseNext(first);
      await bindForm(first);
      await expect(title(first)).toHaveValue(ORIGINAL);
      await expect(restoredBanner(first)).toBeVisible();
      await first.getByRole("button", { name: "Discard instead" }).click();
      await expect(title(first)).toHaveValue("");
      await expect.poll(() => pendingCount(first)).toBe(0);
      const live = (await recoveryRows(context, generations)).filter(
        (row) => !row.terminal,
      );
      expect(live.filter(isHandoffRow)).toEqual([]);
      expect(live.map((row) => row.tab_instance_id)).toEqual([bId]);
      await expect(first.locator("[data-fixture-form]")).toHaveAttribute(
        "data-submitted",
        "0",
      );
    });
});

test.describe("revision 8, R17: a checkbox and a multiple select survive the actual worker update (A to B)", () => {
  const pinned = (page: Page) => page.getByRole("checkbox", { name: "Pinned" });
  const tags = (page: Page) => page.getByRole("listbox", { name: "Tags" });
  const chosen = (page: Page) =>
    tags(page).evaluate((element) =>
      [...(element as HTMLSelectElement).selectedOptions].map(
        (option) => option.value,
      ),
    );
  for (const choices of [false, true])
    test(`${choices ? "" : "control: "}${choices ? "Pinned checked and a second tag selected" : "only the title typed"}: the form is dirty, 'Save and reload' saves it, and B shows the same state (nothing submitted)`, async ({
      context,
      generations,
    }) => {
      await seedAccount(context, generations);
      const page = await openApp(context, generations);
      await workerActive(page);
      await page.evaluate(() =>
        sessionStorage.setItem("atlas-fixture-choices", "1"),
      );
      await reloadQuietly(page);
      await formReady(page);
      await expect(pinned(page)).not.toBeChecked();
      expect(await chosen(page)).toEqual(["home"]);
      expect(await dirtyCount(page)).toBe(0);
      if (choices) {
        await pinned(page).check();
        await tags(page).selectOption(["home", "work"]);
      } else await title(page).fill(ORIGINAL);
      expect(await dirtyCount(page)).toBe(1);
      await generations.serve("fixture-b");
      await checkForUpdate(page);
      await saveAndReload(page);
      if (choices) {
        await expect(pinned(page)).toBeChecked();
        expect(await chosen(page)).toEqual(["home", "work"]);
        await expect(title(page)).toHaveValue("");
      } else {
        await expect(title(page)).toHaveValue(ORIGINAL);
        await expect(pinned(page)).not.toBeChecked();
        expect(await chosen(page)).toEqual(["home"]);
      }
      await expect(restoredBanner(page)).toBeVisible();
      await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
        "data-submitted",
        "0",
      );
    });
});

// ---- revision 9 -------------------------------------------------------------------------------------------------------------------------

/**
 * Revision 9 (review of 14 October 2026, R17 `recovery-control-state-value-projection`, incomplete_fix; design assessment of 14 October 2026,
 * Q14): the actual worker update (A to B) with a choice the form cannot show. R17-A: only the selected option is removed (the select
 * stays): the normal update must not reload without it, and once the option is back it is chosen again and carried. R17-B: the page the
 * update brings cannot show the saved single choice: the restore is reported incomplete, nothing is certified, A's copy and its hand-off
 * stay until the choice can be shown and is saved. Fixture `atlas-fixture-choices` + `without` (TEST INJECTION, `recovery-form.tsx`).
 * FIXTURE evidence (generation servers, production timers and headers), not installed-PWA or device evidence.
 */
test.describe("revision 9, R17: a choice the form cannot show is never lost across the actual worker update (A to B)", () => {
  const tags = (page: Page) => page.getByRole("listbox", { name: "Tags" });
  const priority = (page: Page) =>
    page.getByRole("combobox", { name: "Priority" });
  const chosen = (page: Page) =>
    tags(page).evaluate((element) =>
      [...(element as HTMLSelectElement).selectedOptions].map(
        (option) => option.value,
      ),
    );
  const without = (page: Page, values: string[]) =>
    page.evaluate(
      (next) =>
        (window as unknown as FixtureWindow).__atlasFormProps?.({
          without: next,
        }),
      values,
    );
  const section = (page: Page) => page.locator("[data-fixture-form]");
  /** One tab on A with the choices shown, B installed and waiting. */
  async function choicesWithUpdate(
    context: BrowserContext,
    generations: Generations,
  ): Promise<Page> {
    await seedAccount(context, generations);
    const page = await openApp(context, generations);
    await workerActive(page);
    await page.evaluate(() =>
      sessionStorage.setItem("atlas-fixture-choices", "1"),
    );
    await reloadQuietly(page);
    await formReady(page);
    await generations.serve("fixture-b");
    await checkForUpdate(page);
    await expect(
      updateRegion(page).getByRole("button", { name: "Save and reload" }),
    ).toBeVisible();
    return page;
  }

  for (const removed of ["work", "later"])
    test(`${removed === "work" ? "" : "control: "}a second tag selected, then the ${removed === "work" ? "SELECTED" : "unselected"} option '${removed}' removed (the select stays): ${removed === "work" ? "'Save and reload' fails and nothing reloads; shown again, it is chosen again and 'Retry save' carries it to B" : "'Save and reload' carries both tags to B"}`, async ({
      context,
      generations,
    }) => {
      const page = await choicesWithUpdate(context, generations);
      await tags(page).selectOption(["home", "work"]);
      await without(page, [removed]);
      expect(await chosen(page)).toEqual(
        removed === "work" ? ["home"] : ["home", "work"],
      );
      expect(await dirtyCount(page)).toBe(1);
      if (removed === "work") {
        await mark(page);
        await updateRegion(page)
          .getByRole("button", { name: "Save and reload" })
          .click();
        await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
        expect(await marked(page)).toBe(true);
        expect(await build(page)).toBe("a");
        await without(page, []);
        await expect.poll(() => chosen(page)).toEqual(["home", "work"]);
        expect(await marked(page)).toBe(true);
        await quiet(page);
        await updateRegion(page)
          .getByRole("button", { name: "Retry save" })
          .click();
        await reloadedOntoB(page);
      } else await saveAndReload(page);
      expect(await chosen(page)).toEqual(["home", "work"]);
      await expect(restoredBanner(page)).toBeVisible();
      await expect(section(page)).toHaveAttribute("data-incomplete", "");
      await expect(section(page)).toHaveAttribute("data-submitted", "0");
    });

  for (const missing of [true, false])
    test(`${missing ? "" : "control: "}priority 'high' saved by A; B ${missing ? "WITHOUT the option: the restore is incomplete, B's save fails and A's copy and hand-off stay; the option back: 'high' is chosen, saved, and A's copies are removed" : "with it: restored completely, and B's save removes A's copies"}`, async ({
      context,
      generations,
    }) => {
      const page = await choicesWithUpdate(context, generations);
      await priority(page).selectOption("high");
      expect(await dirtyCount(page)).toBe(1);
      if (missing)
        await page.evaluate(() =>
          sessionStorage.setItem("atlas-fixture-without", '["high"]'),
        );
      await saveAndReload(page);
      await page.evaluate(() =>
        sessionStorage.removeItem("atlas-fixture-without"),
      );
      const fromA = (await recoveryRows(context, generations)).filter(
        (row) => !row.terminal,
      );
      expect(fromA.filter(isHandoffRow)).toHaveLength(1);
      expect(fromA.filter((row) => !isHandoffRow(row))).toHaveLength(1);
      if (missing) {
        await expect(section(page)).toHaveAttribute(
          "data-incomplete",
          "priority",
        );
        expect(await priority(page).inputValue()).toBe("normal");
        expect(await dirtyCount(page)).toBe(1);
        expect(await flushNow(page)).toBe("failed");
        expect(
          (await recoveryRows(context, generations))
            .filter((row) => !row.terminal)
            .map((row) => row.tab_instance_id)
            .sort(),
        ).toEqual(fromA.map((row) => row.tab_instance_id).sort());
        await without(page, []);
        await expect.poll(() => priority(page).inputValue()).toBe("high");
      } else {
        await expect(section(page)).toHaveAttribute("data-incomplete", "");
        expect(await priority(page).inputValue()).toBe("high");
      }
      expect(await flushNow(page)).toBe("saved");
      const after = (await recoveryRows(context, generations)).filter(
        (row) => !row.terminal,
      );
      expect(after).toHaveLength(1);
      expect(isHandoffRow(after[0] as { form_context: string })).toBe(false);
      for (const row of fromA)
        expect(after.map((one) => one.tab_instance_id)).not.toContain(
          row.tab_instance_id,
        );
      await expect(section(page)).toHaveAttribute("data-submitted", "0");
    });
});

// ---- revision 10 ------------------------------------------------------------------------------------------------------------------------

/**
 * Revision 10 (review of 14 October 2026, R17 `recovery-control-state-value-projection` and R11 `recovery-remount-field-schema-stale-session`,
 * both incomplete_fix; design assessment of 14 October 2026, Q13): the actual worker update (A to B) with input the form could not account
 * for. R17: an unfinished number entry (`1e`: the engine's own `validity.badInput`, asserted, never simulated) is not an empty field: "Save
 * and reload" fails, nothing reloads, the entry is never written over, and once the person completes it the update carries it; a second
 * tab holding one is never reloaded by the other tab's update and keeps it. R11: the page the update brings admits fewer fields than A's
 * copy holds: the restore is incomplete, B's save fails and A's copy and hand-off stay until the field is shown again. Fixture
 * `atlas-fixture-number` and `atlas-fixture-admit` (TEST INJECTION, `recovery-form.tsx`). FIXTURE evidence (generation servers, production
 * timers and headers), not installed-PWA or device evidence.
 */
test.describe("revision 10, R17 and R11: what the form cannot account for is never lost across the actual worker update (A to B)", () => {
  const count = (page: Page) => page.getByRole("spinbutton", { name: "Count" });
  const native = (page: Page) =>
    count(page).evaluate((element) => ({
      value: (element as HTMLInputElement).value,
      badInput: (element as HTMLInputElement).validity.badInput,
    }));
  const section = (page: Page) => page.locator("[data-fixture-form]");
  const withNumber = async (page: Page) => {
    await page.evaluate(() =>
      sessionStorage.setItem("atlas-fixture-number", "1"),
    );
    await reloadQuietly(page);
    await formReady(page);
  };

  for (const typed of ["1e", "12"])
    test(`${typed === "1e" ? "" : "control: "}Count typed ${typed}: ${typed === "1e" ? "'Save and reload' fails and nothing reloads; the entry is untouched; completed (1e5), 'Retry save' carries it to B" : "'Save and reload' carries it to B"}`, async ({
      context,
      generations,
    }) => {
      await seedAccount(context, generations);
      const page = await openApp(context, generations);
      await workerActive(page);
      await withNumber(page);
      await generations.serve("fixture-b");
      await checkForUpdate(page);
      await expect(
        updateRegion(page).getByRole("button", { name: "Save and reload" }),
      ).toBeVisible();
      await count(page).pressSequentially(typed);
      expect(await native(page)).toEqual(
        typed === "1e"
          ? { value: "", badInput: true }
          : { value: "12", badInput: false },
      );
      expect(await dirtyCount(page)).toBe(1);
      if (typed === "1e") {
        await mark(page);
        await updateRegion(page)
          .getByRole("button", { name: "Save and reload" })
          .click();
        await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
        expect(await marked(page)).toBe(true);
        expect(await build(page)).toBe("a");
        expect(await native(page)).toEqual({ value: "", badInput: true });
        await count(page).press("End");
        await count(page).pressSequentially("5");
        expect(await native(page)).toEqual({ value: "1e5", badInput: false });
        await quiet(page);
        await updateRegion(page)
          .getByRole("button", { name: "Retry save" })
          .click();
        await reloadedOntoB(page);
        await expect(count(page)).toHaveValue("1e5");
      } else {
        await saveAndReload(page);
        await expect(count(page)).toHaveValue("12");
      }
      await expect(restoredBanner(page)).toBeVisible();
      await expect(section(page)).toHaveAttribute("data-submitted", "0");
    });

  for (const typed of ["1e", "12"])
    test(`${typed === "1e" ? "" : "control: "}a second tab holds Count ${typed}; the first tab's update reloads only the first; the second ${typed === "1e" ? "keeps its unfinished entry as an obligation (dirty, never captured; untouched unless the first tab's boot remounted its form), with no copy of it" : "saves its copy (the peer flush) and stays"}`, async ({
      context,
      generations,
    }) => {
      await seedAccount(context, generations);
      const first = await openApp(context, generations);
      await workerActive(first);
      await reloadQuietly(first);
      const second = await openApp(context, generations);
      await withNumber(second);
      await generations.serve("fixture-b");
      await checkForUpdate(first);
      for (const tab of [first, second]) {
        await formReady(tab);
        await expect(
          updateRegion(tab).getByRole("button", { name: "Save and reload" }),
        ).toBeVisible();
      }
      await count(second).pressSequentially(typed);
      expect((await native(second)).badInput).toBe(typed === "1e");
      const mounts = () =>
        second.evaluate(
          () =>
            (window as unknown as { __atlasFormMounts?: number })
              .__atlasFormMounts ?? 0,
        );
      const mountedBefore = await mounts();
      await title(first).fill(ORIGINAL);
      await mark(second);
      await saveAndReload(first);
      await expect(title(first)).toHaveValue(ORIGINAL);
      expect(await marked(second)).toBe(true);
      expect(await build(second)).toBe("a");
      const rows = (await recoveryRows(context, generations)).filter(
        (row) => !row.terminal,
      );
      if (typed === "1e") {
        // The first tab's boot may remount this tab's protected tree (F-1, WEB-08c lifecycle): a new element cannot hold the old native
        // entry, so it is visible only where no remount happened; either way the obligation stays (dirty, never captured, no reload).
        const remounted = (await mounts()) > mountedBefore;
        test.info().annotations.push({
          type: "second-tab-remounted",
          description: String(remounted),
        });
        expect(await native(second)).toEqual({
          value: "",
          badInput: !remounted,
        });
        expect(await dirtyCount(second)).toBe(1);
        expect(rows.some((row) => "count" in row.fields)).toBe(false);
      } else
        expect(
          rows.filter((row) => row.fields.count === "12").map(isHandoffRow),
        ).toEqual([false]);
    });

  for (const narrowed of [true, false])
    test(`${narrowed ? "" : "control: "}A saves title and notes; B ${narrowed ? "admits only the title: incomplete, B's save fails and A's copy and hand-off stay; notes shown again: back, saved, A's copies removed" : "admits both: restored completely, and B's save removes A's copies"}`, async ({
      context,
      generations,
    }) => {
      const page = await oneTabWithUpdate(context, generations);
      await title(page).fill(ORIGINAL);
      await notes(page).fill("UNFINISHED NOTES");
      if (narrowed)
        await page.evaluate(() =>
          sessionStorage.setItem("atlas-fixture-admit", '["title"]'),
        );
      await saveAndReload(page);
      await page.evaluate(() =>
        sessionStorage.removeItem("atlas-fixture-admit"),
      );
      const fromA = (await recoveryRows(context, generations)).filter(
        (row) => !row.terminal,
      );
      expect(fromA.filter(isHandoffRow)).toHaveLength(1);
      expect(fromA.filter((row) => !isHandoffRow(row))).toHaveLength(1);
      await expect(title(page)).toHaveValue(ORIGINAL);
      if (narrowed) {
        await expect(notes(page)).toHaveCount(0);
        await expect(section(page)).toHaveAttribute("data-incomplete", "notes");
        expect(await dirtyCount(page)).toBe(1);
        expect(await flushNow(page)).toBe("failed");
        expect(
          (await recoveryRows(context, generations))
            .filter((row) => !row.terminal)
            .map((row) => row.tab_instance_id)
            .sort(),
        ).toEqual(fromA.map((row) => row.tab_instance_id).sort());
        await page.evaluate(() =>
          (window as unknown as FixtureWindow).__atlasFormProps?.({
            allow: ["title", "notes"],
            shown: ["title", "notes"],
          }),
        );
        await expect(notes(page)).toHaveValue("UNFINISHED NOTES");
        await expect(section(page)).toHaveAttribute("data-incomplete", "");
      } else {
        await expect(section(page)).toHaveAttribute("data-incomplete", "");
        await expect(notes(page)).toHaveValue("UNFINISHED NOTES");
      }
      expect(await flushNow(page)).toBe("saved");
      const after = (await recoveryRows(context, generations)).filter(
        (row) => !row.terminal,
      );
      expect(after).toHaveLength(1);
      expect(after[0]?.fields).toEqual({
        title: ORIGINAL,
        notes: "UNFINISHED NOTES",
      });
      for (const row of fromA)
        expect(after.map((one) => one.tab_instance_id)).not.toContain(
          row.tab_instance_id,
        );
      await expect(section(page)).toHaveAttribute("data-submitted", "0");
    });
});

// ---- revision 11 ------------------------------------------------------------------------------------------------------------------------

/**
 * Revision 11 (review of 14 October 2026, R18 `recovery-form-associated-control-boundary`; design assessment of 14 October 2026, C5 step 5,
 * Q1/Q10/Q11): the actual worker update (A to B) with an admitted field shown OUTSIDE the form element and associated with it by its `form`
 * attribute ("Place", fixture `atlas-fixture-external`, TEST INJECTION in `recovery-form.tsx`; native preconditions asserted: its form owner
 * and `namedItem` membership, outside the form). Typed and left, it is carried to B (control). Typed and then removed from the page directly
 * (the review's conditional removal: no render of the form, no read of it in between), "Save and reload" fails and nothing reloads; the
 * form mounted again shows it untouched, and "Retry save" carries it to B, or "Discard and reload anyway" drops it. A second tab holding it
 * is never reloaded by the first tab's update and keeps it as an obligation. FIXTURE evidence (generation servers, production timers and
 * headers), not installed-PWA or device evidence.
 */
test.describe("revision 11, R18: a field associated from outside the form is the form's across the actual worker update (A to B)", () => {
  const place = (page: Page) => page.getByRole("textbox", { name: "Place" });
  const section = (page: Page) => page.locator("[data-fixture-form]");
  const withPlace = async (page: Page) => {
    await page.evaluate(() =>
      sessionStorage.setItem("atlas-fixture-external", "1"),
    );
    await reloadQuietly(page);
    await formReady(page);
  };
  const association = (page: Page) =>
    place(page).evaluate((element) => {
      const input = element as HTMLInputElement;
      const form = input.form;
      return {
        owner: form?.getAttribute("aria-label") ?? null,
        member: form?.elements.namedItem("place") === input,
        descendant: form?.contains(input) ?? null,
        value: input.value,
      };
    });
  const removePlace = (page: Page) =>
    place(page).evaluate((element) => element.remove());
  const remount = (page: Page) =>
    page.evaluate(() =>
      (window as unknown as FixtureWindow).__atlasRemountForm?.(),
    );

  test("control: Place typed and left: 'Save and reload' carries it to B, restored", async ({
    context,
    generations,
  }) => {
    const page = await oneTabWithUpdate(context, generations);
    await withPlace(page);
    await place(page).fill("BESIDE THE FORM");
    expect(await association(page)).toEqual({
      owner: "Fixture note",
      member: true,
      descendant: false,
      value: "BESIDE THE FORM",
    });
    expect(await dirtyCount(page)).toBe(1);
    await saveAndReload(page);
    await expect(place(page)).toHaveValue("BESIDE THE FORM");
    await expect(restoredBanner(page)).toBeVisible();
    await expect(section(page)).toHaveAttribute("data-submitted", "0");
  });

  for (const then of ["Retry save", "Discard and reload anyway"] as const)
    test(`Place typed, then removed from the page directly: 'Save and reload' fails and nothing reloads; the form mounted again shows it untouched; '${then}' ${then === "Retry save" ? "carries it to B" : "reloads without it"}`, async ({
      context,
      generations,
    }) => {
      const page = await oneTabWithUpdate(context, generations);
      await withPlace(page);
      await place(page).fill("UNFINISHED PLACE");
      expect(await association(page)).toMatchObject({
        member: true,
        descendant: false,
      });
      await removePlace(page);
      await expect(place(page)).toHaveCount(0);
      expect(await dirtyCount(page)).toBe(1);
      await mark(page);
      await quiet(page);
      await updateRegion(page)
        .getByRole("button", { name: "Save and reload" })
        .click();
      await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
      expect(await marked(page)).toBe(true);
      expect(await build(page)).toBe("a");
      expect(
        (await recoveryRows(context, generations)).filter(
          (row) => !row.terminal && "place" in row.fields,
        ),
      ).toEqual([]);
      await remount(page);
      await expect(place(page)).toHaveValue("UNFINISHED PLACE");
      await quiet(page);
      await updateRegion(page).getByRole("button", { name: then }).click();
      await reloadedOntoB(page);
      await expect(place(page)).toHaveValue(
        then === "Retry save" ? "UNFINISHED PLACE" : "",
      );
      await expect(section(page)).toHaveAttribute("data-submitted", "0");
    });

  test("a second tab holds Place typed then removed; the first tab's update reloads only the first; the second keeps it as an obligation (dirty, no copy of it, no reload)", async ({
    context,
    generations,
  }) => {
    const [first, second] = await twoTabsWithUpdate(context, generations);
    await withPlace(second);
    await expect(
      updateRegion(second).getByRole("button", { name: "Save and reload" }),
    ).toBeVisible();
    await place(second).fill("SECOND TAB PLACE");
    await removePlace(second);
    expect(await dirtyCount(second)).toBe(1);
    await title(first).fill(ORIGINAL);
    await mark(second);
    await saveAndReload(first);
    await expect(title(first)).toHaveValue(ORIGINAL);
    expect(await marked(second)).toBe(true);
    expect(await build(second)).toBe("a");
    expect(await dirtyCount(second)).toBe(1);
    expect(
      (await recoveryRows(context, generations)).filter(
        (row) => !row.terminal && "place" in row.fields,
      ),
    ).toEqual([]);
  });
});
