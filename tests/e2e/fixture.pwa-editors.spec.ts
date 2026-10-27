import type { BrowserContext, Page } from "@playwright/test";
import {
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
 * WEB-14a revision 37 (review of 25 October 2026, R40 `production-form-update-recovery-registration`; design assessment Q4/Q5; Q4 and
 * capability rows 400/473: an accepted update saves unfinished input, restores it without submitting it, and keeps the form open with retry
 * or explicit discard when saving fails). The PRODUCTION new-task editor (`/tasks/new`: its preset picker, the shared task form, the task
 * feature's kept-input owner and its recoverable model) in the real protected tree, with the real data layer, `form_recovery` store,
 * recovery identity, update coordinator and the app's own worker, generation A updated to B. Nothing here is a fixture form: the
 * registered fixture form is only the paired positive control (the review's), run in the same world.
 *
 * Backend: the generation server's stub (`scripts/serve-generations.mjs`) answers the empty account's shapes only (identity, Today,
 * defaults, presets); the account's cache is seeded valid and empty (`seedAccount` `validCache`). FIXTURE evidence of frontend
 * composition, never released-backend acceptance. The failure cases refuse the `form_recovery` store's writes in the page (the browser's
 * IndexedDB `put`, as `fixture.pwa-forms.spec.ts` P-U4 does), not the application's code.
 */
const TEXT = "R40 unfinished task";
const SAVE_FAILED =
  "Couldn't save your unfinished form before reloading. Nothing was lost — your form is still here.";

const nameField = (page: Page) =>
  page.getByRole("textbox", { name: "Name", exact: true });
const scratch = (page: Page) =>
  page.getByRole("button", { name: "Start from scratch instead" });
const restoredBanner = (page: Page) =>
  page.locator('[data-recovery-state="restored"]');

/** Every request that reached the server that is not a read: a task saved or a command sent would be one. */
const writes = async (world: Generations) =>
  (await world.log()).filter(
    (entry) => entry.method !== "GET" && entry.method !== "HEAD",
  );

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

/** The account's `form_recovery` rows for the new task's form (ordinary copies and hand-offs), read on a page of their own. */
async function newTaskRows(
  context: BrowserContext,
  world: Generations,
): Promise<Array<{ form_context: string; terminal: boolean }>> {
  const page = await context.newPage();
  try {
    await navigate(page, `${world.url}/__data`);
    await page.waitForFunction(() => window.__atlasData !== undefined);
    const rows = (await page.evaluate(async () => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity("acct-a");
      await data.open("acct-a");
      const all = await data.rows("acct-a", "form_recovery");
      data.close("acct-a");
      return all;
    })) as Array<{ form_context: string; terminal: boolean }>;
    return rows.filter((row) => row.form_context.endsWith("task-form:new"));
  } finally {
    await page.close();
  }
}

/** The new-task editor on generation A, controlled by its worker, a name typed from scratch, and B installed and waiting. */
async function typedWithUpdate(
  context: BrowserContext,
  world: Generations,
): Promise<Page> {
  await seedAccount(context, world, "acct-a", "s1", {
    validCache: "pwa-r40-empty",
  });
  const page = await openApp(context, world, {
    route: "/tasks/new",
    form: false,
  });
  await workerActive(page);
  await reloadQuietly(page);
  await scratch(page).click();
  await nameField(page).fill(TEXT);
  await expect(nameField(page)).toHaveValue(TEXT);
  await quiet(page);
  await world.serve("fixture-b");
  await checkForUpdate(page);
  // R40: the editor is in the page's registry, so the prompt is the save-first one (a plain Reload would lose the input).
  await expect(
    updateRegion(page).getByRole("button", { name: "Save and reload" }),
  ).toBeVisible();
  await world.clearLog();
  return page;
}

test.describe("R40: the production new-task editor across an accepted update", () => {
  test("'Save and reload': B restores the form's stage and name with the restored banner, focuses the name, and sends nothing", async ({
    context,
    generations,
  }) => {
    const page = await typedWithUpdate(context, generations);
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
    await displayed(page);
    // The stage the person had reached (the form), never the picker again; the name as typed; nothing submitted.
    await expect(nameField(page)).toHaveValue(TEXT);
    await expect(scratch(page)).toHaveCount(0);
    await expect(restoredBanner(page)).toBeVisible();
    await expect(nameField(page)).toBeFocused();
    expect(await build(page)).toBe("b");
    expect(await writes(generations), "nothing is submitted").toEqual([]);
  });

  test("restored, then 'Discard instead': the copies go, and an ordinary reload brings back nothing", async ({
    context,
    generations,
  }) => {
    const page = await typedWithUpdate(context, generations);
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
    await displayed(page);
    await expect(restoredBanner(page)).toBeVisible();
    await restoredBanner(page)
      .getByRole("button", { name: "Discard instead" })
      .click();
    await expect(restoredBanner(page)).toHaveCount(0);
    await expect(nameField(page)).toHaveValue("");
    await expect
      .poll(async () =>
        (await newTaskRows(context, generations)).every((row) => row.terminal),
      )
      .toBe(true);
    await reloadQuietly(page);
    await expect(scratch(page)).toBeVisible();
    await expect(restoredBanner(page)).toHaveCount(0);
    expect(await writes(generations)).toEqual([]);
  });

  test("a save that fails keeps the editor open and editable, nothing reloads; 'Retry save' saves and B restores the newer input", async ({
    context,
    generations,
  }) => {
    const page = await typedWithUpdate(context, generations);
    await mark(page);
    await failRecoveryWrites(page, 1_000);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
    await expect(nameField(page)).toHaveValue(TEXT);
    await nameField(page).fill(`${TEXT}, edited`);
    await expect(nameField(page)).toHaveValue(`${TEXT}, edited`);
    await page.waitForTimeout(1_000);
    expect(await marked(page)).toBe(true);
    await failRecoveryWrites(page, 0);
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Retry save" })
      .click();
    await expect.poll(() => marked(page).catch(() => false)).toBe(false);
    await displayed(page);
    await expect(nameField(page)).toHaveValue(`${TEXT}, edited`);
    await expect(restoredBanner(page)).toBeVisible();
    expect(await writes(generations)).toEqual([]);
  });

  test("a save that fails, then 'Discard and reload anyway': B shows the picker with nothing restored", async ({
    context,
    generations,
  }) => {
    const page = await typedWithUpdate(context, generations);
    await mark(page);
    await failRecoveryWrites(page, 1_000);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Discard and reload anyway" })
      .click();
    await expect.poll(() => marked(page).catch(() => false)).toBe(false);
    await displayed(page);
    await expect(scratch(page)).toBeVisible();
    await expect(restoredBanner(page)).toHaveCount(0);
    expect(await writes(generations)).toEqual([]);
  });

  test("revision 38 (DA-R40-D): a Lists create dialog kept by its sync control is saved by the update; Back to Lists opens it again on the name typed; nothing is saved", async ({
    context,
    generations,
  }) => {
    // A modal dialog keeps the page's update region out of reach (revision 38 observation): the person leaves the dialog without
    // discarding it through its own sync control, which keeps the input for the visit, and accepts the update from the queue.
    await seedAccount(context, generations, "acct-a", "s1", {
      validCache: "pwa-r38-lists",
    });
    const page = await openApp(context, generations, {
      route: "/tasks/lists",
      form: false,
    });
    await workerActive(page);
    await reloadQuietly(page);
    await page.getByRole("button", { name: "+ New list" }).click();
    const listName = page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true });
    await listName.fill("R38 unfinished list");
    await expect(listName).toHaveValue("R38 unfinished list");
    await page.getByRole("dialog").locator("[data-sync-tone]").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await quiet(page);
    await generations.serve("fixture-b");
    await checkForUpdate(page);
    await expect(
      updateRegion(page).getByRole("button", { name: "Save and reload" }),
    ).toBeVisible();
    await generations.clearLog();
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
    await displayed(page);
    await page.goBack();
    await expect(listName).toHaveValue("R38 unfinished list");
    await expect(
      page.getByRole("dialog").locator('[data-recovery-state="restored"]'),
    ).toBeVisible();
    expect(await build(page)).toBe("b");
    expect(await writes(generations), "nothing is submitted").toEqual([]);
  });

  test("CONTROL (the review's): the registered fixture form survives the same worker update", async ({
    context,
    generations,
  }) => {
    await seedAccount(context, generations);
    const page = await openApp(context, generations);
    await workerActive(page);
    await reloadQuietly(page);
    await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
      "data-ready",
      "true",
    );
    const title = page.getByRole("textbox", { name: "Title", exact: true });
    await title.fill("R40 registered form");
    await quiet(page);
    await generations.serve("fixture-b");
    await checkForUpdate(page);
    await quiet(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
    await displayed(page);
    await expect(page.locator("[data-fixture-form]")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await expect(title).toHaveValue("R40 registered form");
    await expect(restoredBanner(page)).toBeVisible();
  });
});
