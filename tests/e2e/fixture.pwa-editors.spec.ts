import type { BrowserContext, Page } from "@playwright/test";
import { pressTab } from "./helpers";
import {
  API,
  managedHousehold,
  STUB_ACCOUNT,
  seededTaskDay,
  sharingReads,
  taskDayReads,
} from "./pwa-reads";
import {
  armReload,
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

/**
 * WEB-14a revision 51 (F-R51-1): "Discard instead" reached by NATIVE keyboard traversal from the focused restored control (macOS WebKit
 * with Option, `pressTab`), never a programmatic focus, and pressed with Enter; returns once the restored banner has gone. Backwards
 * first; where Shift+Tab does not move focus at all it goes forwards round the dialog's loop instead: in Firefox a keyboard user who
 * Tabbed into the sharing editors' radio group (Radix, `ChoiceGroup`) cannot Shift+Tab out of it, with or without recovery (revision 51
 * observation O-R51-2, native-diag-8: pre-existing, reported to its owner, not this task's change).
 */
async function keyboardDiscard(page: Page): Promise<void> {
  const discard = page.getByRole("button", {
    name: "Discard instead",
    exact: true,
  });
  const marked = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      const was = active?.hasAttribute("data-r51-was") ?? false;
      for (const old of document.querySelectorAll("[data-r51-was]"))
        old.removeAttribute("data-r51-was");
      active?.setAttribute("data-r51-was", "");
      return was;
    });
  let shift = true;
  for (let step = 0; step < 30; step += 1) {
    if (await discard.evaluate((button) => button === document.activeElement))
      break;
    await marked();
    await pressTab(page, { shift });
    if (shift && (await marked())) shift = false;
  }
  await expect(
    discard,
    "the control: native keyboard traversal reaches Discard instead",
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(restoredBanner(page)).toHaveCount(0);
}

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
): Promise<
  Array<{ form_context: string; tab_instance_id: string; terminal: boolean }>
> {
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
    })) as Array<{
      form_context: string;
      tab_instance_id: string;
      terminal: boolean;
    }>;
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
    const pageReload = await armReload(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await pageReload.loaded();
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

  test("restored, then 'Discard instead': its own copies go, the hand-off stays (R42); an ordinary reload restores nothing and offers the hand-off", async ({
    context,
    generations,
  }) => {
    const page = await typedWithUpdate(context, generations);
    await quiet(page);
    const pageReload = await armReload(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await pageReload.loaded();
    await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
    await displayed(page);
    await expect(restoredBanner(page)).toBeVisible();
    const isHandoff = (row: { form_context: string }) =>
      row.form_context.startsWith("atlas-update-handoff:");
    const handed = (await newTaskRows(context, generations))
      .filter((row) => isHandoff(row) && !row.terminal)
      .map((row) => row.tab_instance_id);
    expect(handed).toHaveLength(1);
    await restoredBanner(page)
      .getByRole("button", { name: "Discard instead" })
      .click();
    await expect(restoredBanner(page)).toHaveCount(0);
    await expect(nameField(page)).toHaveValue("");
    // Revision 40 adaptation (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028): was "every new-task row is terminal"; now every
    // ORDINARY row is terminal and the hand-off A wrote stays, exactly that one (B restored it; no page that took it over removes it).
    await expect
      .poll(async () =>
        (await newTaskRows(context, generations))
          .filter((row) => !isHandoff(row))
          .every((row) => row.terminal),
      )
      .toBe(true);
    expect(
      (await newTaskRows(context, generations))
        .filter((row) => isHandoff(row) && !row.terminal)
        .map((row) => row.tab_instance_id),
    ).toEqual(handed);
    await reloadQuietly(page);
    await expect(scratch(page)).toBeVisible();
    await expect(restoredBanner(page)).toHaveCount(0);
    // Revision 40 adaptation (R42): was "an ordinary reload brings back nothing"; now nothing is restored (the reference was used up by
    // B's look) and the hand-off, no longer held by any page, is offered as an earlier copy on the form's own stage, never restored.
    await scratch(page).click();
    await expect(nameField(page)).toHaveValue("");
    await expect(restoredBanner(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Restore the copy saved / }),
    ).toHaveCount(1);
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
    const pageReload = await armReload(page);
    await updateRegion(page)
      .getByRole("button", { name: "Retry save" })
      .click();
    await pageReload.loaded();
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
    const pageReload = await armReload(page);
    await updateRegion(page)
      .getByRole("button", { name: "Discard and reload anyway" })
      .click();
    await pageReload.loaded();
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
    const pageReload = await armReload(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await pageReload.loaded();
    await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
    await displayed(page);
    await page.goBack();
    await expect(listName).toHaveValue("R38 unfinished list");
    await expect(
      page.getByRole("dialog").locator('[data-recovery-state="restored"]'),
    ).toBeVisible();
    expect(await build(page)).toBe("b");
    expect(await writes(generations), "nothing is submitted").toEqual([]);
    // Revision 51 (F-R51-1): focus is on the restored Name; a keyboard discard clears it, keeps the dialog and leaves focus there.
    await expect(
      listName,
      "Q4 state 3: the restored form's first field",
    ).toBeFocused();
    await keyboardDiscard(page);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(listName).toHaveValue("");
    await expect(
      listName,
      "Discard instead leaves focus on Name",
    ).toBeFocused();
    expect(
      await writes(generations),
      "nothing is submitted by the discard",
    ).toEqual([]);
  });

  test("revision 51 (F-R51-1): a sharing-defaults choice kept by its sync control is saved by the update; on B the restored layer focuses its CHOSEN option, and a keyboard discard focuses the option its reset chose; nothing is saved", async ({
    context,
    generations,
  }) => {
    // The personal layer of the field defaults, an account with no household: the snapshot is the stub's; the layer's templates, the
    // memberships and the sharing screens' invitations are the generation server's canned reads (GET only), healthy empty answers.
    // The sharing screens' reads (`pwa-reads.ts`, revision 57 C-H3: built once; byte for byte the set this spec held inline).
    await generations.reads(sharingReads());
    await seedAccount(context, generations, "acct-a", "s1", {
      validCache: "pwa-r51-defaults",
    });
    const page = await openApp(context, generations, {
      route: "/sharing/defaults?kind=field",
      form: false,
    });
    await workerActive(page);
    await reloadQuietly(page);
    const layer = page.locator('[data-layer-form="personal"]');
    const option = (name: string) =>
      layer.getByRole("radio", { name, exact: true });
    const chosen = layer.locator('[role="radio"][aria-checked="true"]');
    await expect(chosen).toHaveCount(1);
    const recorded = (await chosen.textContent()) ?? "";
    expect(recorded, "the setup: the recorded choice is not Private").not.toBe(
      "Private",
    );
    await option("Private").click();
    await expect(option("Private")).toHaveAttribute("aria-checked", "true");
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
    const pageReload = await armReload(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await pageReload.loaded();
    await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
    await displayed(page);
    await page.goBack();
    await expect(
      layer.locator('[data-recovery-state="restored"]'),
    ).toBeVisible();
    await expect(option("Private")).toHaveAttribute("aria-checked", "true");
    await expect(
      option("Private"),
      "Q4 state 3: the restored layer's chosen option",
    ).toBeFocused();
    await keyboardDiscard(page);
    await expect(chosen).toHaveText(recorded);
    await expect(
      chosen,
      "Discard instead focuses the option its reset chose",
    ).toBeFocused();
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
    const pageReload = await armReload(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await pageReload.loaded();
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

/**
 * WEB-12b's household dialogs (maintenance merge of 2f42ac35, correction M-1). WEB-12b replaced the household screen's two inline forms
 * (`HouseholdsMinimal`) with route-addressed dialogs whose drafts live in the households page memory: New household (`/sharing/new`) and a
 * household's Invitations (`/sharing/households/<id>/invitations`), each recoverable through `households/form-recovery.ts`. In-app
 * navigation keeps the page and its memory; a page navigation is a new page.
 */
/**
 * WEB-13b maintenance merge of accepted main, correction M-13b-1 G-1 (Kieran, 7 November 2026, "Fix all three in the merge"): the
 * new task's CALENDAR ANCHOR is part of the task form's recoverable text (version 2). Before the correction an accepted update restored the
 * form without it, saying nothing, and Save then created a task with no anchor. The account's cache holds a calendar source and one of its
 * events (synced rows, as the snapshot would); the anchor is chosen with the real panel, saved into the form, and the update accepted.
 */
const ANCHOR_SOURCE = "00000000-0000-4000-8000-0000000000a1";
const anchorRows = [
  {
    id: ANCHOR_SOURCE,
    kind: "calendar_source",
    label: "Family calendar",
    parent_id: null,
    value: { timezone: "Europe/London" },
    version: 1,
    can_edit: true,
    archived: false,
  },
  {
    id: "00000000-0000-4000-8000-0000000000e1",
    kind: "event",
    label: "Bin day",
    parent_id: ANCHOR_SOURCE,
    value: {
      uid: "bin@example",
      original: "2026-11-02",
      title: "Bin day",
      start: {
        date: "2026-11-02",
        time: null,
        timezone: "Europe/London",
        instant: null,
      },
      end: null,
      status: "present",
      sequence: 0,
    },
    version: 1,
    can_edit: true,
    archived: false,
  },
];
const anchorSection = (page: Page) => page.locator("[data-task-form-anchor]");

test.describe("WEB-13b M-13b-1 G-1: the new task's calendar anchor across an accepted update", () => {
  test("'Save and reload': B restores the form WITH its anchor (the summary as saved), and sends nothing", async ({
    context,
    generations,
  }) => {
    await seedAccount(context, generations, "acct-a", "s1", {
      validCache: "pwa-r40-empty",
      rows: anchorRows,
    });
    const page = await openApp(context, generations, {
      route: "/tasks/new",
      form: false,
    });
    await workerActive(page);
    await reloadQuietly(page);
    await scratch(page).click();
    await nameField(page).fill("Put the bins out");
    await page
      .getByRole("combobox", { name: "Repeats", exact: true })
      .selectOption("none");
    await anchorSection(page)
      .getByRole("button", { name: "Anchor…", exact: true })
      .click();
    const panel = page.getByRole("dialog");
    await panel.getByRole("button", { name: "Change event…" }).click();
    await panel
      .getByRole("button", { name: /Bin day/ })
      .first()
      .click();
    await panel
      .getByRole("textbox", { name: "Days before (−) or after (+)" })
      .fill("-1");
    await panel.getByRole("textbox", { name: "Time (optional)" }).fill("18:00");
    await panel
      .getByRole("button", { name: "Save anchor", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const summary = "Family calendar · Bin day · 1 day before at 18:00";
    await expect(anchorSection(page)).toHaveAttribute(
      "data-task-form-anchor",
      "set",
    );
    await expect(anchorSection(page)).toContainText(summary);
    await quiet(page);
    await generations.serve("fixture-b");
    await checkForUpdate(page);
    // The form is in the page's registry, so the prompt is the save-first one.
    await expect(
      updateRegion(page).getByRole("button", { name: "Save and reload" }),
    ).toBeVisible();
    await generations.clearLog();
    await quiet(page);
    const pageReload = await armReload(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await pageReload.loaded();
    await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
    await displayed(page);
    // The stage and the name, as R40 restores them, and now the anchor too: the summary exactly as it was saved.
    await expect(nameField(page)).toHaveValue("Put the bins out");
    await expect(restoredBanner(page)).toBeVisible();
    await expect(anchorSection(page)).toHaveAttribute(
      "data-task-form-anchor",
      "set",
    );
    await expect(anchorSection(page)).toContainText(summary);
    expect(await build(page)).toBe("b");
    expect(await writes(generations), "nothing is submitted").toEqual([]);
  });
});

/**
 * WEB-13b revision 37 (Review 46, F-R46-1/F-R46-2): G-2 and G-3 natively, through the person's real path. A modal dialog makes the update
 * banner inert, so the person leaves the dialog by its in-dialog sync control (the session is kept for the visit) and accepts the update
 * at the sync screens; Back returns to the screen that opened the dialog. Reviewer-owned probes (Review 46) were the starting point.
 */
const editorDialog = (page: Page) => page.getByRole("dialog");
const restoredNotice = (scope: ReturnType<Page["getByRole"]>) =>
  scope.locator('[data-recovery-state="restored"]');
/** The element focused, as the restore left it: never inside a recovery surface (F-R51-1), on the dialog's first field (D2). */
const focusOf = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      inDialog: active?.closest('[role="dialog"]') != null,
      inRecovery:
        active?.closest(
          "[data-recovery-state],[data-recovery-alternatives],[data-recovery-check]",
        ) != null,
      anchorFirst: active?.hasAttribute("data-anchor-first-field") ?? false,
      importFirst: active?.hasAttribute("data-import-first-field") ?? false,
    };
  });

/** B installed and waiting, "Save and reload" offered (the page holds unfinished input); the server's log cleared. */
async function updateOffered(page: Page, world: Generations): Promise<void> {
  await quiet(page);
  await world.serve("fixture-b");
  await checkForUpdate(page);
  await expect(
    updateRegion(page).getByRole("button", { name: "Save and reload" }),
  ).toBeVisible();
  await world.clearLog();
  await quiet(page);
}

/** "Save and reload" accepted at the sync screens; B running with the account displayed; Back to the screen that opened the dialog. */
async function reloadedAndBack(page: Page, world: Generations): Promise<void> {
  await updateOffered(page, world);
  const pageReload = await armReload(page);
  await updateRegion(page)
    .getByRole("button", { name: "Save and reload" })
    .click();
  await pageReload.loaded();
  await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
  await displayed(page);
  await expect(page).toHaveURL(/\/sync/);
  await page.goBack();
  await displayed(page);
}

// ---- G-3: the import dialog --------------------------------------------------------------------------------------------------------------
const ICS_FILE = {
  name: "bins.ics",
  mimeType: "text/calendar",
  buffer: Buffer.from(
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//r37//EN\r\nBEGIN:VEVENT\r\nUID:r37@example\r\nDTSTAMP:20261101T000000Z\r\nDTSTART;VALUE=DATE:20261102\r\nSUMMARY:Bin day\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  ),
};
const importRow = (page: Page) =>
  page.getByRole("button", { name: "Import events into Family calendar" });

/** The calendar screen on A, controlled by its worker, the row's import dialog open. */
async function importOpen(
  context: BrowserContext,
  world: Generations,
): Promise<Page> {
  await world.reads({
    [`${API}/notification-capabilities`]: {
      calendar_links: true,
      ntfy: false,
      web_push: false,
      native_local: false,
      apns: false,
      fcm: false,
      vapid_public_key: null,
    },
    [`${API}/calendar-sources`]: { items: [], next_after: null },
  });
  await seedAccount(context, world, "acct-a", "s1", {
    validCache: "pwa-r40-empty",
    rows: anchorRows,
  });
  const page = await openApp(context, world, {
    route: "/settings/calendars",
    form: false,
  });
  await workerActive(page);
  await reloadQuietly(page);
  await importRow(page).click();
  await expect(editorDialog(page)).toBeVisible();
  return page;
}

test.describe("WEB-13b M-13b-1 G-3: the import dialog across an accepted update (revision 37)", () => {
  test("kept by its sync control with a window typed: the update saves it; Back: the row's dialog reopens on the copy with the restored notice, focus on From and no file; nothing is sent", async ({
    context,
    generations,
  }) => {
    const page = await importOpen(context, generations);
    const importer = editorDialog(page);
    await importer.getByLabel("From", { exact: true }).fill("2026-01-05");
    await importer.getByLabel("Through", { exact: true }).fill("2026-03-30");
    await importer.locator("[data-sync-tone]").click();
    await expect(editorDialog(page)).toHaveCount(0);
    await reloadedAndBack(page, generations);
    const reopened = editorDialog(page);
    await expect(
      reopened,
      "the row reopened the dialog on its copy",
    ).toBeVisible();
    await expect(restoredNotice(reopened)).toBeVisible();
    await expect(reopened.getByLabel("From", { exact: true })).toHaveValue(
      "2026-01-05",
    );
    await expect(reopened.getByLabel("Through", { exact: true })).toHaveValue(
      "2026-03-30",
    );
    await expect(reopened.locator("[data-import-file]")).toHaveCount(0);
    const focus = await focusOf(page);
    expect(focus.importFirst, `focus is From: ${JSON.stringify(focus)}`).toBe(
      true,
    );
    expect(focus.inRecovery).toBe(false);
    expect(await build(page)).toBe("b");
    expect(await writes(generations), "nothing is submitted").toEqual([]);
  });

  test("kept by its sync control with a FILE chosen: the accepted update STOPS (Retry save, Discard and reload anyway) and the page does not reload; Back: the row's dialog shows the kept file and window; nothing is sent", async ({
    context,
    generations,
  }) => {
    const page = await importOpen(context, generations);
    const importer = editorDialog(page);
    await importer.getByLabel("From", { exact: true }).fill("2026-01-05");
    await importer.locator('input[type="file"]').setInputFiles(ICS_FILE);
    await expect(importer.locator("[data-import-file]")).toContainText(
      "bins.ics",
    );
    await importer.locator("[data-sync-tone]").click();
    await expect(editorDialog(page)).toHaveCount(0);
    await updateOffered(page, generations);
    await mark(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    // The file is input no copy can hold (docs/pwa.md, D-P7): the update stops with retry or an explicit discard.
    await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
    await expect(
      updateRegion(page).getByRole("button", { name: "Retry save" }),
    ).toBeVisible();
    await expect(
      updateRegion(page).getByRole("button", {
        name: "Discard and reload anyway",
      }),
    ).toBeVisible();
    expect(await marked(page), "the page did not reload").toBe(true);
    expect(await build(page)).toBe("a");
    // Nothing was lost: Back at the calendar screen, the row's Import events shows the kept session, file and window.
    await page.goBack();
    await displayed(page);
    await importRow(page).click();
    const again = editorDialog(page);
    await expect(again.locator("[data-import-file]")).toContainText("bins.ics");
    await expect(again.getByLabel("From", { exact: true })).toHaveValue(
      "2026-01-05",
    );
    expect(await marked(page), "still the same page").toBe(true);
    expect(await writes(generations), "nothing is submitted").toEqual([]);
  });
});

// ---- G-2: a task's anchor panel ----------------------------------------------------------------------------------------------------------
const WASH = {
  taskId: "aaaaaaaa-0000-4000-8000-000000000001",
  executionId: "aaaaaaaa-0000-4000-8000-000000000002",
  title: "Hang the washing",
};

/** A non-repeating task's detail on A; its anchor panel edited (an event series, an offset at a time) and left by its sync control. */
async function detailPanelKept(
  context: BrowserContext,
  world: Generations,
): Promise<{ page: Page; day: Awaited<ReturnType<typeof seededTaskDay>> }> {
  const day = await seededTaskDay(WASH);
  await world.reads(taskDayReads(day));
  await seedAccount(context, world, STUB_ACCOUNT, "s1", {
    validCache: "pwa-r37-anchor-detail",
    rows: [...day.rows, ...anchorRows],
  });
  const page = await openApp(context, world, {
    route: `/tasks/${day.taskId}?occurrence=${day.occurrenceId}`,
    form: false,
  });
  await workerActive(page);
  await reloadQuietly(page);
  const section = page.locator("[data-anchor-section]");
  await expect(section).toHaveAttribute("data-anchor-section", "none");
  await section
    .getByRole("button", { name: /Anchor/ })
    .first()
    .click();
  const panel = editorDialog(page);
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Change event…" }).click();
  await panel
    .getByRole("button", { name: /Bin day/ })
    .first()
    .click();
  await panel
    .getByRole("textbox", { name: "Days before (−) or after (+)" })
    .fill("-2");
  await panel.getByRole("textbox", { name: "Time (optional)" }).fill("07:15");
  await panel.locator("[data-sync-tone]").click();
  await expect(editorDialog(page)).toHaveCount(0);
  return { page, day };
}

test.describe("WEB-13b M-13b-1 G-2: a task's anchor panel across an accepted update (revision 37)", () => {
  test("kept by its sync control: the update saves it; Back: the section reopens the panel on its copy with the restored notice and focus on its first field; nothing is sent", async ({
    context,
    generations,
  }) => {
    const { page } = await detailPanelKept(context, generations);
    await reloadedAndBack(page, generations);
    const reopened = editorDialog(page);
    await expect(
      reopened,
      "the section reopened the panel on its copy",
    ).toBeVisible();
    await expect(restoredNotice(reopened)).toBeVisible();
    await expect(
      reopened.getByRole("textbox", { name: "Days before (−) or after (+)" }),
    ).toHaveValue("-2");
    await expect(
      reopened.getByRole("textbox", { name: "Time (optional)" }),
    ).toHaveValue("07:15");
    const focus = await focusOf(page);
    expect(
      focus.anchorFirst,
      `focus is the panel's first field: ${JSON.stringify(focus)}`,
    ).toBe(true);
    expect(focus.inRecovery).toBe(false);
    expect(await build(page)).toBe("b");
    expect(await writes(generations), "nothing is submitted").toEqual([]);
  });

  test("the task changed while the page reloaded: Save on the restored panel says the task changed and sends nothing", async ({
    context,
    generations,
  }) => {
    const { page, day } = await detailPanelKept(context, generations);
    await reloadedAndBack(page, generations);
    const reopened = editorDialog(page);
    await expect(restoredNotice(reopened)).toBeVisible();
    // Another page of the account changes the cached task (a newer version), as a sync would, while the restored panel is open.
    const other = await context.newPage();
    try {
      await navigate(other, `${generations.url}/__data`);
      await other.waitForFunction(() => window.__atlasData !== undefined);
      await other.evaluate(
        async ({ account, task }) => {
          const data = window.__atlasData;
          if (!data) throw new Error("no data harness");
          data.setIdentity(account);
          await data.open(account);
          await data.put(account, "cache", [task]);
          data.close(account);
        },
        {
          account: STUB_ACCOUNT,
          task: {
            ...day.rows[0],
            label: `${WASH.title} (renamed)`,
            version: 2,
          },
        },
      );
    } finally {
      await other.close();
    }
    // The page has seen the newer task (its heading, behind the modal panel) before Save is pressed.
    await expect(
      page.getByText(`${WASH.title} (renamed)`, { exact: true }).first(),
    ).toBeAttached();
    await reopened
      .getByRole("button", { name: "Save anchor", exact: true })
      .click();
    await expect(reopened).toContainText(
      "This task changed while you were editing — check the anchor and save again.",
    );
    expect(
      await writes(generations),
      "nothing is sent over the newer task",
    ).toEqual([]);
  });
});

const NEW_HOUSEHOLD = "/sharing/new";
const invitationsOf = (house: { id: string }) =>
  `/sharing/households/${house.id}/invitations`;
const householdName = (page: Page) =>
  page.getByRole("textbox", { name: "Household name", exact: true });
const householdInvitee = (page: Page) =>
  page.getByRole("textbox", { name: "Their username", exact: true });
/** In-app navigation (history and popstate): the page and its households memory stay. */
async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}
/**
 * The household dialogs are modal: while one is open the page behind it, the update banner included, is inert. A person who wants the
 * update closes the dialog first (WEB-14a's other dialogs leave by their sync control), and WEB-12b keeps the draft in page memory when a
 * dialog closes, so the form stays the page's dirty form and the update saves it.
 */
const closeInvitations = (page: Page) =>
  page.getByRole("dialog", { name: /^Invitations/ }).press("Escape");
/** New household's Cancel: the dialog closes and its name stays in page memory (WEB-12b's rule), still the page's dirty form. */
const cancelNewHousehold = (page: Page) =>
  page
    .getByRole("dialog", { name: "New household" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

/**
 * WEB-14a revision 52 (Review52 F-R52-1; design assessment Q13, bounded), over WEB-12b's dialogs (M-1): every form of a page saves under
 * the page's ONE recovery identifier, so a tab that had both household forms typed into (a name kept after Cancel, an invitation open)
 * leaves two copies with one id when another tab's update asks it to save (the peer flush) and it then closes. A later page observes that
 * one closed owner from each dialog as it opens: each copy is restored, passively (an exclusive probe made each look a momentary owner).
 * The old screen showed both forms at once, so their looks overlapped at the lock manager; the dialogs look one after the other, so this
 * case records the probes and does not hold them (the overlap is carried by the two defaults layers, `recovery-owner-discard.test.tsx`,
 * and `tests/lib/recovery-observation.test.tsx`). Control: while the tab is still open, a third tab restores neither. Native composition
 * over the generation server's canned reads (GET only); never released-backend acceptance.
 */
test.describe("revision 52 (F-R52-1), WEB-12b's dialogs (M-1): one closed tab's copies of two household forms", () => {
  const HOUSE = managedHousehold(
    "66666666-6666-4666-8666-666666666660",
    "R52 House",
  );

  test("peer-flushed by another tab's update, then closed: New household and the household's Invitations each restore the closed tab's copy when opened, by a passive observation; nothing is sent; while it was open a third tab restored neither", async ({
    context,
    generations,
  }) => {
    // Records each passive ownership probe (an `ifAvailable` request for a recovery identifier's lock): its mode and whether it was
    // granted. It changes no answer and holds nothing.
    await context.addInitScript(() => {
      // about:blank (before a navigation) is no secure context: it has no lock manager to wrap.
      if (typeof LockManager === "undefined") return;
      const scope = window as unknown as {
        __r52Probes: Array<{ name: string; mode: string; granted: boolean }>;
      };
      scope.__r52Probes = [];
      const request = LockManager.prototype.request as (
        ...args: unknown[]
      ) => Promise<unknown>;
      LockManager.prototype.request = function (
        this: LockManager,
        ...args: unknown[]
      ) {
        const [name, options, callback] = args as [
          string,
          LockOptions,
          LockGrantedCallback<unknown>,
        ];
        if (
          typeof options !== "object" ||
          !options?.ifAvailable ||
          !String(name).startsWith("atlas-recovery-tab-")
        )
          return request.apply(this, args);
        return request.call(this, name, options, (lock: Lock | null) => {
          scope.__r52Probes.push({
            name,
            mode: options.mode ?? "exclusive",
            granted: lock !== null,
          });
          return callback(lock);
        });
      } as LockManager["request"];
    });
    // The sharing screens' reads (`pwa-reads.ts`, revision 57 C-H3: built once).
    await generations.reads(sharingReads([HOUSE]));
    await seedAccount(context, generations, "acct-a", "s1", {
      validCache: "pwa-r52-households",
    });
    const writer = await openApp(context, generations, {
      route: NEW_HOUSEHOLD,
      form: false,
    });
    await workerActive(writer);
    await reloadQuietly(writer);
    const acting = await openApp(context, generations, {
      route: "/tasks",
      form: false,
    });
    await expect(householdName(writer)).toBeVisible();
    await householdName(writer).fill("R52 created household");
    await cancelNewHousehold(writer);
    await navigateInApp(writer, invitationsOf(HOUSE));
    await expect(householdInvitee(writer)).toBeVisible();
    await householdInvitee(writer).fill("r52-invitee");
    await closeInvitations(writer);
    await expect(writer.getByRole("dialog")).toHaveCount(0);
    await quiet(writer);
    await generations.serve("fixture-b");
    await checkForUpdate(acting);
    // The acting tab has no form of its own, so its prompt is the plain Reload; the writer is still asked to save first (peer flush).
    await expect(
      updateRegion(acting).getByRole("button", { name: "Reload", exact: true }),
    ).toBeVisible();
    await generations.clearLog();
    await mark(writer);
    await quiet(acting);
    const actingReload = await armReload(acting);
    await updateRegion(acting)
      .getByRole("button", { name: "Reload", exact: true })
      .click();
    await actingReload.loaded();
    await displayed(acting);
    expect(await build(acting)).toBe("b");
    // The writer saved both forms under its own identifier (the peer flush: two drafts kept in page memory, no dialog open) and did not
    // reload.
    await expect(
      updateRegion(writer).getByText("Atlas updated in another tab."),
    ).toBeVisible();
    expect(await marked(writer)).toBe(true);

    // CONTROL (live owner): a third tab's New household restores nothing while the writer is open.
    const third = await openApp(context, generations, {
      route: NEW_HOUSEHOLD,
      form: false,
    });
    await expect(householdName(third)).toBeVisible();
    await quiet(third);
    await expect(householdName(third)).toHaveValue("");
    await expect(third.locator('[data-recovery-state="restored"]')).toHaveCount(
      0,
    );
    await third.close();

    await writer.close();
    await navigate(acting, `${generations.url}${NEW_HOUSEHOLD}`);
    await displayed(acting);
    await expect(
      householdName(acting),
      "the closed tab's household name is restored",
    ).toHaveValue("R52 created household");
    await expect(
      householdName(acting),
      "D2: the restored field has focus",
    ).toBeFocused();
    await navigateInApp(acting, invitationsOf(HOUSE));
    await expect(
      householdInvitee(acting),
      "the second copy, saved under the same closed tab's id, is restored when its dialog opens",
    ).toHaveValue("r52-invitee");
    await expect(
      householdInvitee(acting),
      "the restored invitation field has focus",
    ).toBeFocused();
    // Each dialog observed the closed writer passively (shared), and both observations were granted.
    const probes = (await acting.evaluate(
      () => (window as unknown as { __r52Probes: unknown[] }).__r52Probes,
    )) as Array<{ name: string; mode: string; granted: boolean }>;
    expect(
      probes.length,
      "both dialogs observed the closed writer",
    ).toBeGreaterThanOrEqual(2);
    expect(probes.slice(0, 2)).toEqual([
      expect.objectContaining({ mode: "shared", granted: true }),
      expect.objectContaining({ mode: "shared", granted: true }),
    ]);
    expect(probes[0]?.name).toBe(probes[1]?.name);
    expect(await writes(generations), "nothing is submitted").toEqual([]);
  });
});

/**
 * WEB-14a revision 53 (Kieran, 3 November 2026: /Users/kieran/atlas/atlas-orchestrator/approval/web14a-r53-decisions-20261103.json,
 * hand-off delivery/handoffs/web14a-r53-decisions-20261103.md; decisions D-R53-1 and D-R53-2), over WEB-12b's household dialogs (M-1):
 * two closed tabs' copies, and a stand-in for an OLDER BUILD's exclusive ownership probe, a same-origin page holding one closed tab's
 * recovery-identifier lock exclusively (as that build's `ifAvailable` probe held it) while a current page looks. Each dialog looks when it
 * opens, so the old screen's two forms are New household and then the household's Invitations, in one page (in-app navigation). The
 * overlap is ordered deliberately (held across the looks, then released): characterisation of the omission and its explicit recovery, not
 * a natural frequency or a frozen/bfcache result.
 */
test.describe("revision 53 (D-R53-1/D-R53-2), WEB-12b's dialogs (M-1): withheld copies, Check saved copies again, and focus after an explicit choice", () => {
  const HOUSE = managedHousehold(
    "66666666-6666-4666-8666-666666666653",
    "R53 House",
  );
  const CHECK = "Check saved copies again";
  const WITHHELD =
    "A saved copy of this form may still be open in another tab.";
  const formOf = (page: Page, field: ReturnType<typeof householdName>) =>
    page.locator("form").filter({ has: field });

  /** The account's household recovery rows (ordinary copies), read on a page of their own. */
  async function householdRows(
    context: BrowserContext,
    world: Generations,
  ): Promise<Array<{ form_context: string; tab_instance_id: string }>> {
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
      })) as Array<{ form_context: string; tab_instance_id: string }>;
      return rows.filter((row) => row.form_context.includes("household-"));
    } finally {
      await page.close();
    }
  }

  test("a copy withheld under an older build's probe is said; while held a check withholds it still; after release each dialog's explicit check OFFERS its copy (never restores it); choosing another copy while the banner stays focuses the field; nothing sent", async ({
    context,
    generations,
  }) => {
    await generations.reads(sharingReads([HOUSE]));
    await seedAccount(context, generations, "acct-a", "s1", {
      validCache: "pwa-r53-households",
    });
    // Two writer tabs: W1 types a household name; W2 a different name (kept after Cancel) AND an invitation.
    const w1 = await openApp(context, generations, {
      route: NEW_HOUSEHOLD,
      form: false,
    });
    await workerActive(w1);
    await reloadQuietly(w1);
    const w2 = await openApp(context, generations, {
      route: NEW_HOUSEHOLD,
      form: false,
    });
    const acting = await openApp(context, generations, {
      route: "/tasks",
      form: false,
    });
    await expect(householdName(w1)).toBeVisible();
    await expect(householdName(w2)).toBeVisible();
    await householdName(w1).fill("R53 first writer");
    await cancelNewHousehold(w1);
    await householdName(w2).fill("R53 second writer");
    await cancelNewHousehold(w2);
    await navigateInApp(w2, invitationsOf(HOUSE));
    await expect(householdInvitee(w2)).toBeVisible();
    await householdInvitee(w2).fill("r53-invitee");
    await closeInvitations(w2);
    await quiet(w1);
    await quiet(w2);
    await generations.serve("fixture-b");
    await checkForUpdate(acting);
    await expect(
      updateRegion(acting).getByRole("button", { name: "Reload", exact: true }),
    ).toBeVisible();
    await generations.clearLog();
    await quiet(acting);
    const actingReload = await armReload(acting);
    await updateRegion(acting)
      .getByRole("button", { name: "Reload", exact: true })
      .click();
    await actingReload.loaded();
    await displayed(acting);
    expect(await build(acting)).toBe("b");
    // Both writers were peer-flushed: each saved its forms under its own identifier.
    for (const writer of [w1, w2])
      await expect(
        updateRegion(writer).getByText("Atlas updated in another tab."),
      ).toBeVisible();
    const rows = await householdRows(context, generations);
    const inviteRows = rows.filter((row) =>
      row.form_context.includes("household-invite:"),
    );
    expect(inviteRows, "only W2 saved an invitation").toHaveLength(1);
    const w2Id = inviteRows[0]?.tab_instance_id as string;
    expect(
      rows.filter((row) => row.form_context.includes("household-create")),
      "both writers saved a household name",
    ).toHaveLength(2);

    // W2 closes; an older build's exclusive probe of W2's identifier is held across the next looks (granted once W2's lock is released).
    await w2.close();
    const old = await context.newPage();
    await navigate(old, `${generations.url}/__data`);
    await old.evaluate(
      (name) =>
        new Promise<void>((granted) => {
          void navigator.locks.request(name, { mode: "exclusive" }, () => {
            granted();
            return new Promise<void>((release) => {
              (window as unknown as { __r53Release: () => void }).__r53Release =
                release;
            });
          });
        }),
      `atlas-recovery-tab-${w2Id}`,
    );
    await w1.close();
    await navigate(acting, `${generations.url}${NEW_HOUSEHOLD}`);
    await displayed(acting);
    const create = formOf(acting, householdName(acting));
    // OMITTED-ONE (New household): W1's copy (no probe holds it) is restored; W2's is withheld.
    await expect(householdName(acting)).toHaveValue("R53 first writer");
    await expect(
      create.locator('[data-recovery-state="restored"]'),
    ).toHaveCount(1);
    await expect(
      householdName(acting),
      "D2: the restored field has focus",
    ).toBeFocused();
    await expect(create.getByText(WITHHELD)).toBeVisible();
    await expect(
      create.getByRole("button", { name: /^Restore the copy saved/ }),
    ).toHaveCount(0);
    // OMITTED-ALL (the invitation, its own dialog and look): W2's only copy is withheld.
    await navigateInApp(acting, invitationsOf(HOUSE));
    const invite = formOf(acting, householdInvitee(acting));
    await expect(invite.getByText(WITHHELD)).toBeVisible();
    await expect(householdInvitee(acting)).toHaveValue("");
    await expect(invite.locator("[data-recovery-state]")).toHaveCount(0);
    // While the probe still holds the lock, an explicit check stays conservative.
    await invite.getByRole("button", { name: CHECK }).click();
    await expect(invite.getByText(WITHHELD)).toBeVisible();
    await expect(
      invite.getByRole("button", { name: /^Restore the copy saved/ }),
    ).toHaveCount(0);
    await expect(householdInvitee(acting)).toHaveValue("");

    // The old probe ends. The person checks again, dialog by dialog: offered, never restored.
    await old.evaluate(() =>
      (window as unknown as { __r53Release: () => void }).__r53Release(),
    );
    await expect
      .poll(
        () =>
          old.evaluate(
            (name) =>
              navigator.locks.request(
                name,
                { mode: "shared", ifAvailable: true },
                (lock) => lock !== null,
              ),
            `atlas-recovery-tab-${w2Id}`,
          ),
        { message: "the stand-in probe released the lock" },
      )
      .toBe(true);
    await old.close();
    await invite.getByRole("button", { name: CHECK }).click();
    await expect(
      invite.getByRole("button", { name: /^Restore the copy saved/ }),
      "W2's invitation is offered",
    ).toHaveCount(1);
    await expect(householdInvitee(acting)).toHaveValue("");
    await expect(
      invite.locator('[data-recovery-state="restored"]'),
    ).toHaveCount(0);
    // Back in New household (the page's model, resumed: its look's answer stands, nothing looks again by itself).
    await navigateInApp(acting, NEW_HOUSEHOLD);
    await expect(create.getByText(WITHHELD)).toBeVisible();
    await create.getByRole("button", { name: CHECK }).click();
    const offered = create.getByRole("button", {
      name: /^Restore the copy saved/,
    });
    await expect(offered, "W2's household name is offered").toHaveCount(1);
    await expect(
      householdName(acting),
      "the check restored nothing",
    ).toHaveValue("R53 first writer");

    // D-R53-2: focus is elsewhere (the dialog's Cancel); choosing W2's household name while the restored banner stays shown focuses the
    // field once it is applied, never the removed button.
    await acting
      .getByRole("dialog", { name: "New household" })
      .getByRole("button", { name: "Cancel", exact: true })
      .focus();
    await offered.click();
    await expect(householdName(acting)).toHaveValue("R53 second writer");
    await expect(
      create.locator('[data-recovery-state="restored"]'),
    ).toHaveCount(1);
    await expect(
      householdName(acting),
      "the chosen copy's form takes focus at its field",
    ).toBeFocused();
    await expect(
      create.getByRole("button", { name: /^Restore the copy saved/ }),
      "W1's copy is now the one offered",
    ).toHaveCount(1);
    expect(await writes(generations), "nothing is submitted").toEqual([]);
  });
});

/**
 * WEB-14a revision 55 (Review 54, F-R54-2; design assessment of 5 November 2026, native counterpart N-3), over WEB-12b's New household
 * dialog (M-1): the writer tab's next page restores its claimed update hand-off; the person chooses another tab's copy, so the hand-off goes
 * back to the offered copies; "Check saved copies again" then keeps the hand-off offered, and restoring it brings the pre-update input.
 * Deliberately ordered (tabs closed in order): characterisation of the corrected rule, not a natural frequency result. FIXTURE evidence of
 * frontend composition, never released-backend acceptance.
 *
 * F-R54-1 (N-1) needed the old household screen's composition: the create form and the invitation form EARLIER in one page, the latter
 * restoring late. WEB-12b shows them in separate route-addressed dialogs, so no product page composes them; F-R54-1 stays carried by
 * `tests/lib/recovery-discard-focus.test.tsx` ("revision 55 (F-R54-1)") and `tests/pwa/update-focus.test.tsx` (T-F8).
 */
test.describe("revision 55 (F-R54-2), WEB-12b's New household (M-1): a check keeps this page's claimed hand-off", () => {
  const HOUSE = managedHousehold(
    "66666666-6666-4666-8666-666666666655",
    "R55 House",
  );
  const CHECK = "Check saved copies again";
  const WITHHELD =
    "A saved copy of this form may still be open in another tab.";
  const OFFERED = /^Restore the copy saved/;
  const createName = householdName;
  const formOf = (page: Page, field: ReturnType<typeof createName>) =>
    page.locator("form").filter({ has: field });
  /** The account's update hand-off rows, read on a page of their own (as revision 53's household rows). */
  async function handoffRows(
    context: BrowserContext,
    generations: Generations,
  ): Promise<Array<{ form_context: string; saved_at: string }>> {
    const page = await context.newPage();
    try {
      await navigate(page, `${generations.url}/__data`);
      await page.waitForFunction(() => window.__atlasData !== undefined);
      const rows = (await page.evaluate(async () => {
        const data = window.__atlasData;
        if (!data) throw new Error("no data harness");
        data.setIdentity("acct-a");
        await data.open("acct-a");
        const all = await data.rows("acct-a", "form_recovery");
        data.close("acct-a");
        return all;
      })) as Array<{ form_context: string; saved_at: string }>;
      return rows.filter((row) =>
        row.form_context.startsWith("atlas-update-handoff:"),
      );
    } finally {
      await page.close();
    }
  }
  async function world(
    context: BrowserContext,
    generations: Generations,
    cache: string,
  ) {
    // The sharing screens' reads (`pwa-reads.ts`, revision 57 C-H3: built once; byte for byte the set this spec held inline).
    await generations.reads(sharingReads([HOUSE]));
    await seedAccount(context, generations, "acct-a", "s1", {
      validCache: cache,
    });
  }
  test("F-R54-2: the next page restores its claimed hand-off; another tab's copy chosen puts the hand-off back on offer; 'Check saved copies again' keeps it offered and restorable; nothing sent", async ({
    context,
    generations,
  }) => {
    await world(context, generations, "pwa-r55-handoff");
    // L (live, stays open), G (closes later) and W (the writer) all type a household name.
    const live = await openApp(context, generations, {
      route: NEW_HOUSEHOLD,
      form: false,
    });
    await workerActive(live);
    await reloadQuietly(live);
    const gone = await openApp(context, generations, {
      route: NEW_HOUSEHOLD,
      form: false,
    });
    const writer = await openApp(context, generations, {
      route: NEW_HOUSEHOLD,
      form: false,
    });
    for (const [page, text] of [
      [live, "R55 live tab"],
      [gone, "R55 other tab"],
      [writer, "R55 before the update"],
    ] as const) {
      await expect(createName(page)).toBeVisible();
      await createName(page).fill(text);
      await cancelNewHousehold(page);
      await quiet(page);
    }
    // The writer accepts the update with its form dirty (the name kept after Cancel): "Save and reload" saves it and leaves the update
    // hand-off to its next page.
    await generations.serve("fixture-b");
    await checkForUpdate(writer);
    const save = updateRegion(writer).getByRole("button", {
      name: "Save and reload",
    });
    await expect(save).toBeVisible();
    await quiet(writer);
    const reload = await armReload(writer);
    await save.click();
    await reload.loaded();
    await displayed(writer);
    expect(await build(writer)).toBe("b");
    for (const peer of [live, gone])
      await expect(
        updateRegion(peer).getByText("Atlas updated in another tab."),
      ).toBeVisible();
    // The next page opens where the writer was (Households); New household, opened again, looks and restores the claimed hand-off.
    await navigateInApp(writer, NEW_HOUSEHOLD);
    const create = formOf(writer, createName(writer));
    await expect(
      createName(writer),
      "the claimed hand-off is restored",
    ).toHaveValue("R55 before the update");
    await expect(
      create.locator('[data-recovery-state="restored"]'),
    ).toHaveCount(1);
    // The other tab goes; the person checks again: its copy is OFFERED (the live tab's stays withheld).
    await gone.close();
    await create.getByRole("button", { name: CHECK }).click();
    const offered = create.getByRole("button", { name: OFFERED });
    await expect(offered, "the other tab's copy is offered").toHaveCount(1);
    await offered.click();
    await expect(createName(writer)).toHaveValue("R55 other tab");
    await expect(
      offered,
      "the hand-off goes back to the offered copies",
    ).toHaveCount(1);
    // F-R54-2: the live tab goes too, and the person checks again. The check's end is visible (nothing is withheld any more), and the
    // claimed, still-valid hand-off must stay offered beside the live tab's copy (before the correction the hand-off was dropped and the
    // writer's ordinary copy its lineage names was offered on its own instead: Review 54 F-R54-2 with manifestation c).
    await live.close();
    await create.getByRole("button", { name: CHECK }).click();
    await expect(
      create.getByText(WITHHELD),
      "the check finished: nothing is withheld now",
    ).toHaveCount(0);
    // The hand-off's row is the one with its own "Discard the copy saved …" (only hand-off copies carry it): the two copies may share a
    // saved-at second, so their restore labels can be equal.
    const handoffRow = create.locator("span").filter({
      has: writer.getByRole("button", { name: /^Discard the copy saved/ }),
    });
    await expect(
      handoffRow,
      "F-R54-2: this page's claimed hand-off is still offered after the check",
    ).toHaveCount(1);
    await expect(
      offered,
      "beside it only the live tab's copy (the hand-off's lineage is not offered on its own)",
    ).toHaveCount(2);
    await expect(createName(writer), "the check restored nothing").toHaveValue(
      "R55 other tab",
    );
    const [handoff] = (await handoffRows(context, generations)).filter((row) =>
      row.form_context.endsWith("household-create"),
    );
    expect(handoff, "the hand-off is still in the store").toBeDefined();
    await handoffRow.getByRole("button", { name: OFFERED }).click();
    await expect(createName(writer)).toHaveValue("R55 before the update");
    expect(await writes(generations), "nothing is submitted").toEqual([]);
  });
});
