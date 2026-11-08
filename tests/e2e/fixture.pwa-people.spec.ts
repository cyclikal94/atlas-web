import type { BrowserContext, Locator, Page } from "@playwright/test";
import { pressTab } from "./helpers";
import { seededPerson } from "./pwa-reads";
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
 * WEB-14a integration revision (review of 2 November 2026, F-INT-PEOPLE-Q4; family `people-update-recovery-participant`; Q4: an accepted
 * update saves unfinished input first, restores it without submitting it, and keeps it with retry or explicit discard when saving fails).
 * The PRODUCTION People forms in the real protected tree, with the real data layer, `form_recovery` store, recovery identity, update
 * coordinator and the app's own worker, generation A updated to B.
 *
 * Each form is a modal dialog, which keeps the page's update region out of reach (revision 38 observation): the person leaves it through
 * its own sync control, which keeps the input in People page memory for the visit with NO form mounted (the reviewer's unmounted case),
 * and accepts the update from the queue. Back opens the form again on the copy B restored.
 *
 * Backend: the generation server's stub answers the empty account's shapes only (identity, Today, defaults); the account's cache is seeded
 * valid and empty. FIXTURE evidence of frontend composition, never released-backend acceptance.
 *
 * NATIVE SELECTION (finite, reconciled in .agtx/execute.md): each People form, saved by the update and restored without being submitted, and
 * its failed save refused then retried, in Chromium, Firefox and WebKit: New person (a dialog, left by its sync control), Rename (inline in
 * the person's header: shown while the update saves it) and the field editor on a TYPED field (a dialog, left by its sync control; its
 * hidden typed slot comes back too).
 *
 * WEB-14a revision 50 (review of revision 49): the rename form and the field editor live on a person's page, whose online People reads
 * (`GET /people/{id}`, its summary and duplicates) the stub answered 404, which the shared console guard rightly fails (revision-49
 * native-diag-1). Their native journeys are made possible by a SEEDED PERSON instead: the person is put into the account's cache as a synced
 * resource (`seedAccount` `rows`), and the generation server answers exactly its People reads (the list's summaries, the person, its summary and duplicates) with healthy, schema-valid bodies
 * (`Generations.reads`, the server's canned reads; GET only, never a write). The console guard, the stub's other 404s, the receipt and the
 * no-retry policy are unchanged. The earlier offline attempt stays failed (pool request request-6c4c77941bde469dadfb): offline person pages
 * are still not a capability of this world. Fixture evidence: these reads are the client's view of a backend, not a released one.
 */
/** The person's other acts sit behind "More" in the identity header (the Final design, 8 November 2026): opened once per screen. */
async function openMore(scope: Locator) {
  const more = scope.getByRole("button", { name: "More", exact: true });
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
}
const NAME = "Q4 unfinished person";
const SAVE_FAILED =
  "Couldn't save your unfinished form before reloading. Nothing was lost — your form is still here.";

const PERSON = "71717171-7171-4171-8171-717171717171";
const OWNER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
/**
 * The seeded person and every People read of the list and of its page, as a healthy backend answers them to its owner (`pwa-reads.ts`,
 * revision 57 C-H3: built once, each body checked against the product's own parser by `tests/pwa/pwa-reads.test.ts`). Byte for byte the
 * revision 50 set this spec held inline, plus the person's activity read accepted WEB-19 added (Review 57, F-R57-2).
 */
const SEEDED = seededPerson({
  id: PERSON,
  label: "Ada Lovelace",
  owner: { account_id: OWNER, username: "alice" },
});
const PERSON_ROW = SEEDED.row;
const PERSON_READS = SEEDED.reads;
const RENAMED = "Ada King, Countess of Lovelace";

const dialog = (page: Page) => page.getByRole("dialog");
const header = (page: Page) => page.locator("[data-identity-header]");
const nameIn = (page: Page) =>
  dialog(page).getByRole("textbox", { name: "Name", exact: true });
const restoredBanner = (page: Page) =>
  dialog(page).locator('[data-recovery-state="restored"]');

/** Every request that reached the server that is not a read: a person saved or a command sent would be one. */
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

/** The account's rows of `store`, read on a page of their own. */
async function rowsOf<T>(
  context: BrowserContext,
  world: Generations,
  store: "drafts" | "form_recovery",
): Promise<T[]> {
  const page = await context.newPage();
  try {
    await navigate(page, `${world.url}/__data`);
    await page.waitForFunction(() => window.__atlasData !== undefined);
    return (await page.evaluate(async (name) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity("acct-a");
      await data.open("acct-a");
      const all = await data.rows("acct-a", name);
      data.close("acct-a");
      return all;
    }, store)) as T[];
  } finally {
    await page.close();
  }
}

/** The People list on generation A, controlled by its worker. */
async function peopleOnA(
  context: BrowserContext,
  world: Generations,
): Promise<Page> {
  // Base merge of 5 November 2026: accepted WEB-11b's People list reads the reader's pending requests; none here. Revision 56: the
  // generation server answers that empty read for every PWA spec (C-H1), so this setup no longer cans it.
  await seedAccount(context, world, "acct-a", "s1", {
    validCache: "pwa-people-q4",
  });
  const page = await openApp(context, world, {
    route: "/people",
    form: false,
  });
  await workerActive(page);
  await reloadQuietly(page);
  return page;
}

/** The seeded person's page on generation A, controlled by its worker, its linkage read ("Not linked to an account"). */
async function personOnA(
  context: BrowserContext,
  world: Generations,
): Promise<Page> {
  await world.reads(PERSON_READS);
  await seedAccount(context, world, "acct-a", "s1", {
    validCache: "pwa-people-q4",
    rows: [PERSON_ROW],
  });
  const page = await openApp(context, world, {
    route: `/people/${PERSON}`,
    form: false,
  });
  await workerActive(page);
  await reloadQuietly(page);
  await expect(
    header(page).getByText("Not linked to an account"),
  ).toBeVisible();
  return page;
}

/** The open dialog left through its own sync control: its input is kept for the visit, with no form mounted. */
async function keep(page: Page): Promise<void> {
  await dialog(page).locator("[data-sync-tone]").click();
  await expect(dialog(page)).toHaveCount(0);
}

/** B installed and waiting; the prompt is the save-first one. */
async function updateWaiting(page: Page, world: Generations): Promise<void> {
  await quiet(page);
  await world.serve("fixture-b");
  await checkForUpdate(page);
  // F-INT-PEOPLE-Q4: the kept People form is in the page's registry, so the prompt is the save-first one.
  await expect(
    updateRegion(page).getByRole("button", { name: "Save and reload" }),
  ).toBeVisible();
  await world.clearLog();
}

/** The open dialog kept by its sync control, and B installed and waiting. */
async function keptWithUpdate(page: Page, world: Generations): Promise<void> {
  await keep(page);
  await updateWaiting(page, world);
}

async function typedNewPerson(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New person" }).first().click();
  await nameIn(page).fill(NAME);
  await expect(nameIn(page)).toHaveValue(NAME);
}

/**
 * WEB-14a revision 50: a form on the seeded person's page. `type` opens the form and types into it; `leave` makes the update region
 * reachable (the dialog's sync control; the inline rename needs nothing) and puts B in place; `restored` is the form shown again on B (after
 * Back for a dialog), checked to show exactly what was typed, with its restored banner.
 */
interface PersonForm {
  name: string;
  /** WEB-14a revision 51: the form's first field (restored focus goes there, and "Discard instead" leaves it there). */
  field(page: Page): Locator;
  /** What the first field shows once "Discard instead" put the form back where it starts from. */
  discarded: string;
  type(page: Page): Promise<void>;
  leave(page: Page, world: Generations): Promise<void>;
  back(page: Page): Promise<void>;
  restored(page: Page): Promise<void>;
}
const FORMS: PersonForm[] = [
  {
    name: "Rename (inline in the person's header, shown while the update saves it)",
    field: (page) => header(page).getByRole("textbox", { name: "Name" }),
    discarded: PERSON_ROW.label,
    async type(page) {
      await openMore(header(page));
      await header(page).getByRole("button", { name: "Rename" }).click();
      const box = header(page).getByRole("textbox", { name: "Name" });
      await box.fill(RENAMED);
      await expect(box).toHaveValue(RENAMED);
    },
    leave: (page, world) => updateWaiting(page, world),
    back: async () => undefined,
    async restored(page) {
      await expect(
        header(page).getByRole("textbox", { name: "Name" }),
      ).toHaveValue(RENAMED);
      await expect(
        header(page).locator('[data-recovery-state="restored"]'),
      ).toBeVisible();
    },
  },
  {
    name: "the field editor on a typed field (a dialog kept by its sync control; its hidden typed slot too)",
    field: (page) =>
      dialog(page).getByRole("textbox", { name: "Name", exact: true }),
    discarded: "",
    async type(page) {
      await page.getByRole("link", { name: "Add a field" }).click();
      await dialog(page)
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("Weight");
      await dialog(page)
        .getByRole("textbox", { name: "Value", exact: true })
        .fill("about 70");
      await dialog(page)
        .getByRole("combobox", { name: "Type" })
        .selectOption("quantity");
      await dialog(page).getByRole("textbox", { name: "Amount" }).fill("70");
      await dialog(page).getByRole("textbox", { name: "Unit" }).fill("kg");
      await expect(
        dialog(page).getByRole("textbox", { name: "Amount" }),
      ).toHaveValue("70");
    },
    leave: (page, world) => keptWithUpdate(page, world),
    back: (page) => page.goBack().then(() => undefined),
    async restored(page) {
      const editor = dialog(page);
      await expect(
        editor.getByRole("textbox", { name: "Name", exact: true }),
      ).toHaveValue("Weight");
      await expect(editor.getByRole("combobox", { name: "Type" })).toHaveValue(
        "quantity",
      );
      await expect(editor.getByRole("textbox", { name: "Amount" })).toHaveValue(
        "70",
      );
      await expect(editor.getByRole("textbox", { name: "Unit" })).toHaveValue(
        "kg",
      );
      await expect(restoredBanner(page)).toBeVisible();
      // The hidden slot typed before the type changed came back with it (never submitted: a type change is not a save).
      await editor.getByRole("combobox", { name: "Type" }).selectOption("text");
      await expect(
        editor.getByRole("textbox", { name: "Value", exact: true }),
      ).toHaveValue("about 70");
    },
  },
];

/**
 * WEB-14a revision 51 (review of 3 November 2026, F-R51-1; family `restored-form-focus-exposure-order`; form-recovery-reload.html "Focus
 * order"): the restored form takes focus on its first field when B shows it, observed BEFORE any gesture of the test; then "Discard
 * instead" is reached by NATIVE keyboard traversal from that field (Shift+Tab; macOS WebKit with Option, `pressTab`), never by a
 * programmatic focus, and pressed with Enter: the restored banner goes, the form stays with what it starts from, and focus is still on its
 * first field. Nothing is sent or queued by either.
 */
async function restoredFocusThenKeyboardDiscard(
  page: Page,
  context: BrowserContext,
  world: Generations,
  field: Locator,
  discarded: string,
): Promise<void> {
  await expect(
    field,
    "Q4 state 3: the restored form's first field",
  ).toBeFocused();
  const discard = page.getByRole("button", {
    name: "Discard instead",
    exact: true,
  });
  for (let step = 0; step < 20; step += 1) {
    if (await discard.evaluate((button) => button === document.activeElement))
      break;
    await pressTab(page, { shift: true });
  }
  await expect(
    discard,
    "the control: native keyboard traversal reaches Discard instead",
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-recovery-state="restored"]')).toHaveCount(0);
  await expect(field).toHaveValue(discarded);
  await expect(
    field,
    "Discard instead leaves focus on the first field",
  ).toBeFocused();
  expect(await writes(world), "nothing is submitted by the discard").toEqual(
    [],
  );
  expect(
    await rowsOf(context, world, "drafts"),
    "nothing is queued by the discard",
  ).toEqual([]);
}

test.describe("F-INT-PEOPLE-Q4: the People forms across an accepted update", () => {
  test("New person kept by its sync control: 'Save and reload' saves it, B restores it on Back, nothing is sent or queued", async ({
    context,
    generations,
  }) => {
    const page = await peopleOnA(context, generations);
    await typedNewPerson(page);
    await keptWithUpdate(page, generations);
    await quiet(page);
    const pageReload = await armReload(page);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await pageReload.loaded();
    await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
    await displayed(page);
    await page.goBack();
    await expect(nameIn(page)).toHaveValue(NAME);
    await expect(restoredBanner(page)).toBeVisible();
    // Revision 51: focus first, before any other observation that could involve a gesture.
    await expect(
      nameIn(page),
      "Q4 state 3: the restored form's first field",
    ).toBeFocused();
    expect(await build(page)).toBe("b");
    expect(await writes(generations), "nothing is submitted").toEqual([]);
    expect(
      await rowsOf(context, generations, "drafts"),
      "nothing is queued",
    ).toEqual([]);
    await restoredFocusThenKeyboardDiscard(
      page,
      context,
      generations,
      nameIn(page),
      "",
    );
  });

  test("a save that fails keeps the page (no reload) with the input; 'Retry save' saves and B restores it", async ({
    context,
    generations,
  }) => {
    const page = await peopleOnA(context, generations);
    await typedNewPerson(page);
    await keptWithUpdate(page, generations);
    await mark(page);
    await failRecoveryWrites(page, 1_000);
    await updateRegion(page)
      .getByRole("button", { name: "Save and reload" })
      .click();
    await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(await marked(page), "the page was not reloaded").toBe(true);
    expect(await build(page)).toBe("a");
    await failRecoveryWrites(page, 0);
    await quiet(page);
    const pageReload = await armReload(page);
    await updateRegion(page)
      .getByRole("button", { name: "Retry save" })
      .click();
    await pageReload.loaded();
    await displayed(page);
    await page.goBack();
    await expect(nameIn(page)).toHaveValue(NAME);
    await expect(restoredBanner(page)).toBeVisible();
    expect(await writes(generations)).toEqual([]);
    expect(await rowsOf(context, generations, "drafts")).toEqual([]);
    await restoredFocusThenKeyboardDiscard(
      page,
      context,
      generations,
      nameIn(page),
      "",
    );
  });
  for (const form of FORMS) {
    test(`${form.name}: 'Save and reload' saves it, B restores it, nothing is sent or queued`, async ({
      context,
      generations,
    }) => {
      const page = await personOnA(context, generations);
      await form.type(page);
      await form.leave(page, generations);
      await quiet(page);
      const pageReload = await armReload(page);
      await updateRegion(page)
        .getByRole("button", { name: "Save and reload" })
        .click();
      await pageReload.loaded();
      await expect(page.locator("html")).toHaveAttribute(
        "data-atlas-build",
        "b",
      );
      await displayed(page);
      await form.back(page);
      // Revision 51: focus first, before `restored` (whose type change is a gesture in the editor).
      await expect(form.field(page)).toBeVisible();
      await expect(
        form.field(page),
        "Q4 state 3: the restored form's first field",
      ).toBeFocused();
      await form.restored(page);
      expect(await build(page)).toBe("b");
      expect(await writes(generations), "nothing is submitted").toEqual([]);
      expect(
        await rowsOf(context, generations, "drafts"),
        "nothing is queued",
      ).toEqual([]);
      await form.field(page).focus();
      await restoredFocusThenKeyboardDiscard(
        page,
        context,
        generations,
        form.field(page),
        form.discarded,
      );
    });

    test(`${form.name}: a save that fails keeps the page (no reload) with the input; 'Retry save' saves and B restores it`, async ({
      context,
      generations,
    }) => {
      const page = await personOnA(context, generations);
      await form.type(page);
      await form.leave(page, generations);
      await mark(page);
      await failRecoveryWrites(page, 1_000);
      await updateRegion(page)
        .getByRole("button", { name: "Save and reload" })
        .click();
      await expect(updateRegion(page).getByText(SAVE_FAILED)).toBeVisible();
      await page.waitForTimeout(1_000);
      expect(await marked(page), "the page was not reloaded").toBe(true);
      expect(await build(page)).toBe("a");
      await failRecoveryWrites(page, 0);
      await quiet(page);
      const pageReload = await armReload(page);
      await updateRegion(page)
        .getByRole("button", { name: "Retry save" })
        .click();
      await pageReload.loaded();
      await displayed(page);
      await form.back(page);
      await expect(form.field(page)).toBeVisible();
      await expect(
        form.field(page),
        "Q4 state 3: the restored form's first field",
      ).toBeFocused();
      await form.restored(page);
      expect(await writes(generations)).toEqual([]);
      expect(await rowsOf(context, generations, "drafts")).toEqual([]);
      await form.field(page).focus();
      await restoredFocusThenKeyboardDiscard(
        page,
        context,
        generations,
        form.field(page),
        form.discarded,
      );
    });
  }
});
