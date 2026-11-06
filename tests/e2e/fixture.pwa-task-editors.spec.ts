import type { BrowserContext, Page } from "@playwright/test";
import {
  OTHER_ACCOUNT,
  type SeededTaskDay,
  STUB_ACCOUNT,
  seededTaskDay,
  taskDayReads,
} from "./pwa-reads";
import {
  armReload,
  checkForUpdate,
  displayed,
  expect,
  type Generations,
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
 * WEB-14a revision 57 (Review 57, F-R57-4; design assessment of 6 November 2026, RC-C1, I-N1, Q-N1): the maintained real-engine case of
 * WEB-10c's two kept-input editors that correction D-1 adopted into app-update recovery (Q4), as every other product editor has one
 * (`fixture.pwa-editors.spec.ts`, `fixture.pwa-people.spec.ts`). The PRODUCTION task detail in the real protected tree, with the real data
 * layer, `form_recovery` store, recovery identity, update coordinator and the app's own worker, generation A updated to B:
 *
 *  - the dependency editor ("Set what this waits for") and the turn order dialog, each left by its own sync control or by Cancel with its
 *    input kept for the visit (a modal hides the update banner, so the person leaves it first: the real path), then A to B;
 *  - after the reload the screen reopens the editor on the copy, with the restored notice, and sends nothing;
 *  - focus is the editor's own first field, never the restored banner's action (Review 57, F-R57-1: the turn order's first usable order
 *    control; the dependency editor's Task select);
 *  - Save stays the person's act and sends the restored input: the list and its strict rule (`set_dependencies`, queued in the outbox), or
 *    `set_rota` at the roster version the order was edited on, even after the roster moved (the server's conflict, never an overwrite).
 *
 * Adopted from Review 57's reviewer probe (`.agtx/evidence/review-r57-20261106/native/fixture.zz-r57-editors.spec.ts`, the reviewer's
 * five cases and three focus cases per engine), with the seeded world built by `pwa-reads.ts` (today's rows, the product's own ids) and
 * one change of method: the probe exempted the app page from the console guard because the stub answers every write 405; here the page's
 * own `fetch` HOLDS a write once the person presses Save (after every restore assertion), recording its body, so nothing reaches the
 * stub and the console guard and the read oracle stay in force for the whole case.
 *
 * Backend: the generation server's canned reads for the seeded days (GET only). FIXTURE evidence of frontend composition, never
 * released-backend acceptance.
 */
const ROOT = {
  taskId: "aaaaaaaa-0000-4000-8000-000000000001",
  executionId: "aaaaaaaa-0000-4000-8000-000000000002",
};
const PREREQUISITE = {
  taskId: "aaaaaaaa-0000-4000-8000-000000000003",
  executionId: "aaaaaaaa-0000-4000-8000-000000000004",
};
const BINS = {
  taskId: "aaaaaaaa-0000-4000-8000-000000000005",
  executionId: "aaaaaaaa-0000-4000-8000-000000000006",
};
const SURFACE =
  "[data-recovery-state],[data-recovery-alternatives],[data-recovery-check]";

const dialog = (page: Page) => page.getByRole("dialog");
const restoredBanner = (page: Page) =>
  page.locator('[data-recovery-state="restored"]');
const dayPath = (day: SeededTaskDay) =>
  `/tasks/${day.taskId}?occurrence=${day.occurrenceId}`;

/**
 * Every write the page's own `fetch` makes is recorded with its body; once `holdWrites` is called, a write is recorded and HELD (never sent,
 * its promise never settles), so the case can read what Save would send without a write reaching the generation server (which refuses
 * every write). Reads are untouched.
 */
async function recordWrites(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const scope = window as unknown as {
      __r57writes: Array<{ url: string; method: string; body: string | null }>;
      __r57hold: boolean;
    };
    scope.__r57writes = [];
    scope.__r57hold = false;
    const original = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (method === "GET" || method === "HEAD") return original(...args);
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const body =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request
            ? await input.clone().text()
            : null;
      scope.__r57writes.push({ url, method, body });
      if (scope.__r57hold) return new Promise<Response>(() => {});
      return original(...args);
    };
  });
}
const holdWrites = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __r57hold: boolean }).__r57hold = true;
  });
const pageWrites = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __r57writes?: unknown[] }).__r57writes ?? [],
  ) as Promise<Array<{ url: string; method: string; body: string | null }>>;
/** Every request that reached the generation server that is not a read (its own log, across reloads). */
const serverWrites = async (world: Generations) =>
  (await world.log()).filter(
    (entry) => entry.method !== "GET" && entry.method !== "HEAD",
  );

/** The account's rows of a store, read on a page of its own. */
async function rowsOf(
  context: BrowserContext,
  world: Generations,
  store: string,
): Promise<unknown[]> {
  const page = await context.newPage();
  try {
    await navigate(page, `${world.url}/__data`);
    await page.waitForFunction(
      () =>
        (window as unknown as { __atlasData?: unknown }).__atlasData !==
        undefined,
    );
    return (await page.evaluate(
      async ({ account, name }) => {
        const data = (
          window as unknown as {
            __atlasData: {
              setIdentity(a: string): void;
              open(a: string): Promise<unknown>;
              rows(a: string, s: string): Promise<unknown[]>;
              close(a: string): void;
            };
          }
        ).__atlasData;
        data.setIdentity(account);
        await data.open(account);
        const all = await data.rows(account, name);
        data.close(account);
        return all;
      },
      { account: STUB_ACCOUNT, name: store },
    )) as unknown[];
  } finally {
    await page.close();
  }
}

/** What holds focus: where it is relative to the editor and the recovery surfaces. */
const focusOf = (page: Page) =>
  page.evaluate((surface) => {
    const active = document.activeElement as HTMLElement | null;
    return {
      inDialog: active?.closest('[role="dialog"]') != null,
      inSurface: active?.closest(surface) != null,
      inOrder: active?.closest("[data-rota-editor]") != null,
      label: active?.getAttribute("aria-label") ?? null,
      text: (active?.textContent ?? "").trim().slice(0, 40),
      id: active?.id ?? null,
    };
  }, SURFACE);

// ---- shared steps ------------------------------------------------------------------------------------------------------------------------
type Leave = "sync" | "cancel";
/** The dialog is modal: while it is open the update region is aria-hidden and inert, so the person leaves it first. */
async function leaveDialog(page: Page, how: Leave): Promise<void> {
  if (how === "cancel")
    await dialog(page)
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
  else await dialog(page).locator("[data-sync-tone]").click();
  await expect(dialog(page)).toHaveCount(0);
}

/** B installed and waiting; the prompt is the save-first one (the kept session with input is still in the page's registry). */
async function updateWaiting(page: Page, world: Generations): Promise<void> {
  await quiet(page);
  await world.serve("fixture-b");
  await checkForUpdate(page);
  await expect(
    updateRegion(page).getByRole("button", { name: "Save and reload" }),
  ).toBeVisible();
  await world.clearLog();
}

/** "Save and reload"; B is running with the account displayed (and the person back on the task if they had left it for Sync). */
async function acceptAndReload(page: Page, left: Leave): Promise<void> {
  await quiet(page);
  const pageReload = await armReload(page);
  await updateRegion(page)
    .getByRole("button", { name: "Save and reload" })
    .click();
  await pageReload.loaded();
  await expect(page.locator("html")).toHaveAttribute("data-atlas-build", "b");
  await displayed(page);
  if (left === "sync") {
    await expect(page).toHaveURL(/\/sync/);
    await page.goBack();
    await displayed(page);
  }
}

// ---- the dependency editor ---------------------------------------------------------------------------------------------------------------
async function dependencyListOnA(
  context: BrowserContext,
  world: Generations,
): Promise<{ page: Page; prerequisite: SeededTaskDay }> {
  const root = await seededTaskDay({ ...ROOT, title: "Hang the washing" });
  const prerequisite = await seededTaskDay({
    ...PREREQUISITE,
    title: "Run the washing machine",
  });
  await recordWrites(context);
  await world.reads(taskDayReads(root));
  await seedAccount(context, world, STUB_ACCOUNT, "s1", {
    validCache: "pwa-r57-dependencies",
    rows: [...root.rows, ...prerequisite.rows],
  });
  const page = await openApp(context, world, {
    route: dayPath(root),
    form: false,
  });
  await workerActive(page);
  await reloadQuietly(page);
  await expect(page.locator('[data-dependencies="ready"]')).toBeVisible();
  await page.getByRole("button", { name: "Set what this waits for" }).click();
  await expect(page.locator('[data-dependency-editor="open"]')).toBeVisible();
  const editor = dialog(page);
  await editor
    .getByLabel("Task", { exact: true })
    .selectOption(prerequisite.taskId);
  await expect(
    editor
      .getByLabel("Day", { exact: true })
      .locator(`option[value="${prerequisite.occurrenceId}"]`),
  ).toHaveCount(1);
  await editor
    .getByLabel("Day", { exact: true })
    .selectOption(prerequisite.occurrenceId);
  await editor.getByRole("button", { name: "Add", exact: true }).click();
  await expect(editor.locator("[data-editor-item]")).toHaveCount(1);
  await editor.getByLabel("Don't allow starting early").check();
  return { page, prerequisite };
}

for (const leave of ["sync", "cancel"] as const) {
  test(`dependency editor left by ${leave === "sync" ? "its sync control" : "Cancel"}, then A to B: reopened on the copy with the restored notice, focus on its Task select, nothing sent; Save queues set_dependencies with the restored list and strict rule`, async ({
    context,
    generations,
  }) => {
    const { page, prerequisite } = await dependencyListOnA(
      context,
      generations,
    );
    await leaveDialog(page, leave);
    await updateWaiting(page, generations);
    await acceptAndReload(page, leave);
    await expect(dialog(page), "the editor reopens on the copy").toBeVisible({
      timeout: 15_000,
    });
    await expect(restoredBanner(page)).toBeVisible();
    await expect(
      dialog(page).locator(`[data-editor-item="${prerequisite.occurrenceId}"]`),
    ).toHaveCount(1);
    await expect(
      dialog(page).getByLabel("Don't allow starting early"),
    ).toBeChecked();
    // F-R57-1/I-F1: the restored editor's first field, never a recovery action.
    await expect(
      dialog(page).getByLabel("Task", { exact: true }),
    ).toBeFocused();
    expect(
      (await focusOf(page)).inSurface,
      "focus is not on a recovery surface",
    ).toBe(false);
    expect(
      await serverWrites(generations),
      "nothing is sent by the restore",
    ).toEqual([]);
    expect(await pageWrites(page), "the page sent nothing").toEqual([]);
    // Save is the person's act, admitted on the preview read now; the queued command carries the restored list and rule.
    await expect(page.locator('[data-dependency-editor="open"]')).toBeVisible();
    await holdWrites(page);
    await dialog(page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await rowsOf(context, generations, "draft_commands")).length,
        { timeout: 15_000 },
      )
      .toBe(1);
    const [draft] = (await rowsOf(
      context,
      generations,
      "draft_commands",
    )) as Array<{
      command: { command: Record<string, unknown> };
    }>;
    expect(draft?.command.command).toMatchObject({
      kind: "set_dependencies",
      occurrence_id: expect.any(String),
      prerequisites: [prerequisite.occurrenceId],
      strict: true,
    });
    expect(
      await serverWrites(generations),
      "a held write never reached the server",
    ).toEqual([]);
  });
}

// ---- the turn order dialog -------------------------------------------------------------------------------------------------------------
async function turnOrderOnA(
  context: BrowserContext,
  world: Generations,
): Promise<{ page: Page; bins: SeededTaskDay }> {
  const bins = await seededTaskDay({
    ...BINS,
    title: "Take the bins out",
    participation: "anyone",
    daily: true,
    rota: { revision: 2, ordinal: 0, account_id: OTHER_ACCOUNT },
  });
  await recordWrites(context);
  await world.reads(
    taskDayReads(bins, { version: 2, participants: [STUB_ACCOUNT] }),
  );
  await seedAccount(context, world, STUB_ACCOUNT, "s1", {
    validCache: "pwa-r57-rota",
    rows: bins.rows,
  });
  const page = await openApp(context, world, {
    route: dayPath(bins),
    form: false,
  });
  await workerActive(page);
  await reloadQuietly(page);
  const order = page.getByRole("button", { name: "Turn order…" });
  await expect(order).toBeEnabled();
  await order.click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page)
    .getByRole("button", { name: "Add: Someone (2222…)" })
    .click();
  await expect(dialog(page).locator("[data-rota-count]")).toContainText(
    "2 of 8",
  );
  return { page, bins };
}

/** After the reload: reopened on the copy, restored, focus on the order's first usable control (Move down for the first person). */
async function turnOrderRestored(
  page: Page,
  world: Generations,
): Promise<void> {
  await expect(dialog(page), "the dialog reopens on the copy").toBeVisible({
    timeout: 15_000,
  });
  await expect(restoredBanner(page)).toBeVisible();
  await expect(dialog(page).locator("[data-rota-count]")).toContainText(
    "2 of 8",
  );
  await expect
    .poll(async () => (await focusOf(page)).inOrder, {
      message: "focus is on the order's own control",
    })
    .toBe(true);
  const focused = await focusOf(page);
  expect(
    focused.inSurface,
    `focus is not on a recovery surface (it is on "${focused.text}")`,
  ).toBe(false);
  expect(focused.label ?? "").toMatch(/^Move down: /);
  expect(await serverWrites(world), "nothing is sent by the restore").toEqual(
    [],
  );
  expect(await pageWrites(page), "the page sent nothing").toEqual([]);
}

/** Save order: the set_rota the page sends (held at its own fetch, never reaching the server). */
async function saveOrder(page: Page): Promise<Record<string, unknown>> {
  await holdWrites(page);
  await dialog(page)
    .getByRole("button", { name: "Save order", exact: true })
    .click();
  await expect
    .poll(async () => (await pageWrites(page)).length, { timeout: 15_000 })
    .toBe(1);
  const [sent] = await pageWrites(page);
  const body = JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
  return (body.command as Record<string, unknown> | undefined) ?? body;
}

for (const leave of ["sync", "cancel"] as const) {
  test(`turn order left by ${leave === "sync" ? "its sync control" : "Cancel"}, then A to B: reopened on the copy with the restored notice, focus on the order (never the banner), nothing sent; Save sends set_rota at the version it was edited on`, async ({
    context,
    generations,
  }) => {
    const { page, bins } = await turnOrderOnA(context, generations);
    await leaveDialog(page, leave);
    await updateWaiting(page, generations);
    await acceptAndReload(page, leave);
    await turnOrderRestored(page, generations);
    expect(await saveOrder(page)).toMatchObject({
      kind: "set_rota",
      task_id: bins.taskId,
      expected_version: 2,
      participants: [STUB_ACCOUNT, OTHER_ACCOUNT],
    });
    expect(await serverWrites(generations)).toEqual([]);
  });
}

test("turn order: the roster moved on while the page reloaded; the restored order keeps the version it was edited on (2), never the roster's 3", async ({
  context,
  generations,
}) => {
  const { page, bins } = await turnOrderOnA(context, generations);
  await leaveDialog(page, "sync");
  await updateWaiting(page, generations);
  // Another editor changes the roster to version 3 before the reload.
  await generations.reads(
    taskDayReads(bins, { version: 3, participants: [OTHER_ACCOUNT] }),
  );
  await acceptAndReload(page, "sync");
  await turnOrderRestored(page, generations);
  const command = await saveOrder(page);
  expect(command.expected_version, "the version it was edited on").toBe(2);
  expect(command.participants).toEqual([STUB_ACCOUNT, OTHER_ACCOUNT]);
});

test("turn order (Review 57's consequence case): one Enter on the restored dialog's focus acts on the order, never discards it", async ({
  context,
  generations,
}) => {
  const { page } = await turnOrderOnA(context, generations);
  await leaveDialog(page, "cancel");
  await updateWaiting(page, generations);
  await acceptAndReload(page, "cancel");
  await turnOrderRestored(page, generations);
  await page.keyboard.press("Enter");
  // Move down: the reader's turn now comes after Someone's (before the correction: the discard's reset, "1 of 8", banner gone).
  await expect(
    dialog(page).locator("[data-rota-person]").first(),
  ).toHaveAttribute("data-rota-person", OTHER_ACCOUNT);
  await expect(dialog(page).locator("[data-rota-count]")).toContainText(
    "2 of 8",
  );
  expect(await serverWrites(generations)).toEqual([]);
  expect(await pageWrites(page)).toEqual([]);
});
