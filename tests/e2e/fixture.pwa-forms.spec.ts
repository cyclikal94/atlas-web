import type { BrowserContext, Page } from "@playwright/test";
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

/** The rows of the account's `form_recovery` store, read through the data harness on a page of its own. */
async function recoveryRows(
  context: BrowserContext,
  world: Generations,
): Promise<
  Array<{
    tab_instance_id: string;
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
    expect(saved.filter((row) => !row.terminal)).toHaveLength(1);
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
    const rows = (await recoveryRows(context, generations)).filter(
      (row) => !row.terminal,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.tab_instance_id)).size).toBe(2);
    expect(rows.map((row) => row.fields.title).sort()).toEqual([
      "From the first tab",
      "From the second tab",
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
    await expect(second.locator("[data-alternatives]")).toHaveAttribute(
      "data-alternatives",
      "1",
    );
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
    // schedules are the unit cases (`use-recoverable-form.test.tsx`, MU-1188..MU-1193). The first driver attempt of revision 1 required a
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
async function remountForm(page: Page): Promise<void> {
  const before = await page.evaluate(
    () => (window as unknown as FixtureWindow).__atlasFormMounts ?? 0,
  );
  await fixtureForm(page).evaluate((form) => {
    (form as unknown as { __old?: boolean }).__old = true;
  });
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).__atlasRemountForm?.(),
  );
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
const liveTitles = async (context: BrowserContext, world: Generations) =>
  (await recoveryRows(context, world))
    .filter((row) => !row.terminal)
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
