import type { BrowserContext, Page } from "@playwright/test";
import { pressTab } from "./helpers";
import { managedHousehold, sharingReads } from "./pwa-reads";
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
    await page.getByRole("button", { name: "New list" }).click();
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
 * WEB-14a revision 52 (Review52 F-R52-1; design assessment Q13, bounded): every form of a page saves under the page's ONE recovery
 * identifier, so a tab whose household screen had two forms typed into leaves two copies with one id when another tab's update asks it to
 * save (the peer flush) and it then closes. A later page of the household screen observes that one closed owner from both forms at once:
 * both are restored (an exclusive probe hid the second). Control: while the tab is still open, a third tab restores and offers neither.
 * Native composition over the generation server's canned reads (GET only); never released-backend acceptance.
 */
test.describe("revision 52 (F-R52-1): one closed tab's copies of two household-screen forms", () => {
  const HOUSE = managedHousehold(
    "66666666-6666-4666-8666-666666666660",
    "R52 House",
  );
  const createName = (page: Page) =>
    page.getByRole("textbox", { name: "Household name", exact: true });
  const invitee = (page: Page) =>
    page.getByRole("textbox", {
      name: `Invite to “${HOUSE.name}” by exact username`,
      exact: true,
    });

  test("peer-flushed by another tab's update, then closed: a new household screen restores BOTH forms, focuses the first, sends nothing; while it was open a third tab restored neither", async ({
    context,
    generations,
  }) => {
    // TEST INJECTION (revision 52, design assessment Q1/Q13): in every page, a passive ownership probe (an `ifAvailable` request for a
    // recovery identifier's lock) keeps its lock until the page's SECOND probe of that same identifier has been answered (bounded at 2 s,
    // counted), so the two forms' looks really overlap at the lock manager, as they can by timing alone. It changes no answer the browser
    // gives: a probe the lock manager refuses is still refused. `__r52Probes` records each probe's mode and whether it was granted.
    await context.addInitScript(() => {
      // about:blank (before a navigation) is no secure context: it has no lock manager to wrap.
      if (typeof LockManager === "undefined") return;
      const scope = window as unknown as {
        __r52Probes: Array<{ name: string; mode: string; granted: boolean }>;
        __r52ProbeTimeouts: number;
      };
      scope.__r52Probes = [];
      scope.__r52ProbeTimeouts = 0;
      const request = LockManager.prototype.request as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const open = new Map<string, Array<() => void>>();
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
          const answer = callback(lock);
          const waiting = open.get(name);
          if (waiting) {
            open.delete(name);
            for (const release of waiting) release();
            return answer;
          }
          return new Promise((resolve) => {
            let done = false;
            const release = () => {
              if (done) return;
              done = true;
              resolve(answer);
            };
            open.set(name, [release]);
            setTimeout(() => {
              if (done) return;
              scope.__r52ProbeTimeouts += 1;
              if (open.get(name)?.includes(release)) open.delete(name);
              release();
            }, 2_000);
          });
        });
      } as LockManager["request"];
    });
    // The sharing screens' reads (`pwa-reads.ts`, revision 57 C-H3: built once; byte for byte the set this spec held inline).
    await generations.reads(sharingReads([HOUSE]));
    await seedAccount(context, generations, "acct-a", "s1", {
      validCache: "pwa-r52-households",
    });
    const writer = await openApp(context, generations, {
      route: "/sharing",
      form: false,
    });
    await workerActive(writer);
    await reloadQuietly(writer);
    const acting = await openApp(context, generations, {
      route: "/tasks",
      form: false,
    });
    await expect(invitee(writer)).toBeVisible();
    await createName(writer).fill("R52 created household");
    await invitee(writer).fill("r52-invitee");
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
    // The writer saved both forms under its own identifier (the peer flush), did not reload and still shows them.
    await expect(
      updateRegion(writer).getByText("Atlas updated in another tab."),
    ).toBeVisible();
    expect(await marked(writer)).toBe(true);
    await expect(createName(writer)).toHaveValue("R52 created household");
    await expect(invitee(writer)).toHaveValue("r52-invitee");

    // CONTROL (live owner): a third tab's household screen restores and offers neither while the writer is open.
    const third = await openApp(context, generations, {
      route: "/sharing",
      form: false,
    });
    await expect(invitee(third)).toBeVisible();
    await quiet(third);
    await expect(createName(third)).toHaveValue("");
    await expect(invitee(third)).toHaveValue("");
    await expect(third.locator("[data-recovery-state]")).toHaveCount(0);
    await third.close();

    await writer.close();
    await navigate(acting, `${generations.url}/sharing`);
    await displayed(acting);
    await expect(
      createName(acting),
      "the first of the closed tab's two copies is restored",
    ).toHaveValue("R52 created household");
    await expect(
      invitee(acting),
      "the second copy, saved under the same closed tab's id, is restored too",
    ).toHaveValue("r52-invitee");
    await expect(
      acting.locator('[data-recovery-state="restored"]'),
    ).toHaveCount(2);
    const createFirst = await createName(acting).evaluate(
      (create, invite) =>
        (create.compareDocumentPosition(invite as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
      await invitee(acting).elementHandle(),
    );
    await expect(
      createFirst ? createName(acting) : invitee(acting),
      "D2: the restored form first in the page has focus",
    ).toBeFocused();
    // The two forms' probes of the closed writer really overlapped, as passive (shared) observations both granted.
    const probes = (await acting.evaluate(
      () => (window as unknown as { __r52Probes: unknown[] }).__r52Probes,
    )) as Array<{ name: string; mode: string; granted: boolean }>;
    expect(
      probes.length,
      "both forms observed the closed writer",
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
 * hand-off delivery/handoffs/web14a-r53-decisions-20261103.md; decisions D-R53-1 and D-R53-2). The production household screen, two
 * closed tabs' copies, and a stand-in for an OLDER BUILD's exclusive ownership probe: a same-origin page holding one closed tab's
 * recovery-identifier lock exclusively (as that build's `ifAvailable` probe held it) while a current page looks. The overlap is ordered
 * deliberately (held across the look, then released): characterisation of the omission and its explicit recovery, not a natural frequency
 * or a frozen/bfcache result.
 */
test.describe("revision 53 (D-R53-1/D-R53-2): withheld copies, Check saved copies again, and focus after an explicit choice", () => {
  const HOUSE = managedHousehold(
    "66666666-6666-4666-8666-666666666653",
    "R53 House",
  );
  const CHECK = "Check saved copies again";
  const WITHHELD =
    "A saved copy of this form may still be open in another tab.";
  const createName = (page: Page) =>
    page.getByRole("textbox", { name: "Household name", exact: true });
  const invitee = (page: Page) =>
    page.getByRole("textbox", {
      name: `Invite to “${HOUSE.name}” by exact username`,
      exact: true,
    });
  const formOf = (page: Page, field: ReturnType<typeof createName>) =>
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

  test("a copy withheld under an older build's probe is said; while held a check withholds it still; after release each form's explicit check OFFERS its copy (never restores it); choosing another copy while the banner stays focuses the form's first field; nothing sent", async ({
    context,
    generations,
  }) => {
    // The sharing screens' reads (`pwa-reads.ts`, revision 57 C-H3: built once; byte for byte the set this spec held inline).
    await generations.reads(sharingReads([HOUSE]));
    await seedAccount(context, generations, "acct-a", "s1", {
      validCache: "pwa-r53-households",
    });
    // Two writer tabs: W1 types a household name; W2 a different name AND an invitation.
    const w1 = await openApp(context, generations, {
      route: "/sharing",
      form: false,
    });
    await workerActive(w1);
    await reloadQuietly(w1);
    const w2 = await openApp(context, generations, {
      route: "/sharing",
      form: false,
    });
    const acting = await openApp(context, generations, {
      route: "/tasks",
      form: false,
    });
    await expect(invitee(w1)).toBeVisible();
    await expect(invitee(w2)).toBeVisible();
    await createName(w1).fill("R53 first writer");
    await createName(w2).fill("R53 second writer");
    await invitee(w2).fill("r53-invitee");
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
    // Both writers were peer-flushed: each saved its forms under its own identifier and still shows them.
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

    // W2 closes; an older build's exclusive probe of W2's identifier is held across the next look (granted once W2's lock is released).
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
    await navigate(acting, `${generations.url}/sharing`);
    await displayed(acting);
    const create = formOf(acting, createName(acting));
    const invite = formOf(acting, invitee(acting));
    // OMITTED-ONE (create): W1's copy (no probe holds it) is restored; W2's is withheld. OMITTED-ALL (invite): W2's only copy is withheld.
    await expect(createName(acting)).toHaveValue("R53 first writer");
    await expect(
      create.locator('[data-recovery-state="restored"]'),
    ).toHaveCount(1);
    await expect(
      createName(acting),
      "D2: the restored form has focus",
    ).toBeFocused();
    await expect(create.getByText(WITHHELD)).toBeVisible();
    await expect(
      create.getByRole("button", { name: /^Restore the copy saved/ }),
    ).toHaveCount(0);
    await expect(invite.getByText(WITHHELD)).toBeVisible();
    await expect(invitee(acting)).toHaveValue("");
    await expect(invite.locator("[data-recovery-state]")).toHaveCount(0);
    // While the probe still holds the lock, an explicit check stays conservative.
    await invite.getByRole("button", { name: CHECK }).click();
    await expect(invite.getByText(WITHHELD)).toBeVisible();
    await expect(
      invite.getByRole("button", { name: /^Restore the copy saved/ }),
    ).toHaveCount(0);
    await expect(invitee(acting)).toHaveValue("");

    // The old probe ends. The person checks again, form by form: offered, never restored.
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
    await create.getByRole("button", { name: CHECK }).click();
    const offered = create.getByRole("button", {
      name: /^Restore the copy saved/,
    });
    await expect(offered, "W2's household name is offered").toHaveCount(1);
    await expect(createName(acting), "the check restored nothing").toHaveValue(
      "R53 first writer",
    );
    await invite.getByRole("button", { name: CHECK }).click();
    await expect(
      invite.getByRole("button", { name: /^Restore the copy saved/ }),
      "W2's invitation is offered",
    ).toHaveCount(1);
    await expect(invitee(acting)).toHaveValue("");
    await expect(
      invite.locator('[data-recovery-state="restored"]'),
    ).toHaveCount(0);

    // D-R53-2: focus is elsewhere (the invitation field); choosing W2's household name while the create banner stays shown focuses the
    // create form's first field once it is applied, never the removed button.
    await invitee(acting).focus();
    await offered.click();
    await expect(createName(acting)).toHaveValue("R53 second writer");
    await expect(
      create.locator('[data-recovery-state="restored"]'),
    ).toHaveCount(1);
    await expect(
      createName(acting),
      "the chosen copy's form takes focus at its first field",
    ).toBeFocused();
    await expect(
      create.getByRole("button", { name: /^Restore the copy saved/ }),
      "W1's copy is now the one offered",
    ).toHaveCount(1);
    expect(await writes(generations), "nothing is submitted").toEqual([]);
  });
});

/**
 * WEB-14a revision 55 (Review 54, F-R54-1 and F-R54-2; design assessment of 5 November 2026, native counterparts N-1 and N-3). The
 * production household screen in the real protected tree, data layer, recovery identity and worker; fixture backend reads only (FIXTURE
 * evidence of frontend composition, never released-backend acceptance).
 *
 *  - F-R54-1: the create form restores automatically (the arrival's grant) while the households read is HELD at the generation server, so
 *    the invitation form, EARLIER in the page, mounts and restores later. An applied choice of the other household-name copy keeps focus
 *    against that late restore; the control without a choice shows D2 (the earlier form takes the automatic grant). The hold is the
 *    server's, so every engine (WebKit's controlled pages included) sees it.
 *  - F-R54-2: the writer tab's next page restores its claimed update hand-off; the person chooses another tab's copy, so the hand-off goes
 *    back to the offered copies; "Check saved copies again" then keeps the hand-off offered, and restoring it brings the pre-update input.
 * Deliberately ordered (a held read, tabs closed in order): characterisation of the corrected rules, not a natural frequency result.
 */
test.describe("revision 55 (F-R54-1/F-R54-2): a choice keeps focus against a late earlier restore; a check keeps this page's claimed hand-off", () => {
  const HOUSE = managedHousehold(
    "66666666-6666-4666-8666-666666666655",
    "R55 House",
  );
  const HOUSEHOLDS = "/api/experimental/v1/households";
  const CHECK = "Check saved copies again";
  const WITHHELD =
    "A saved copy of this form may still be open in another tab.";
  const OFFERED = /^Restore the copy saved/;
  const createName = (page: Page) =>
    page.getByRole("textbox", { name: "Household name", exact: true });
  const invitee = (page: Page) =>
    page.getByRole("textbox", {
      name: `Invite to “${HOUSE.name}” by exact username`,
      exact: true,
    });
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
  /** Two rendering turns of the page: what a restore's commit and its focus effect do has been done. */
  const settledFrames = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
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
  /** Peers of `acting` are flushed by its accepted update (each saves its forms under its own identifier); `acting` then shows build b. */
  async function updateFrom(acting: Page, generations: Generations) {
    await generations.serve("fixture-b");
    await checkForUpdate(acting);
    await expect(
      updateRegion(acting).getByRole("button", { name: "Reload", exact: true }),
    ).toBeVisible();
    await quiet(acting);
    const reload = await armReload(acting);
    await updateRegion(acting)
      .getByRole("button", { name: "Reload", exact: true })
      .click();
    await reload.loaded();
    await displayed(acting);
    expect(await build(acting)).toBe("b");
  }

  for (const choice of [true, false])
    test(`F-R54-1 ${choice ? "an applied choice in the form that holds the automatic grant keeps focus when the invitation form (earlier in the page) restores late" : "CONTROL (D2): with no choice the invitation form's late restore takes the automatic grant"}; nothing sent`, async ({
      context,
      generations,
    }) => {
      await world(context, generations, `pwa-r55-focus-${choice}`);
      const w1 = await openApp(context, generations, {
        route: "/sharing",
        form: false,
      });
      await workerActive(w1);
      await reloadQuietly(w1);
      const w2 = await openApp(context, generations, {
        route: "/sharing",
        form: false,
      });
      const acting = await openApp(context, generations, {
        route: "/tasks",
        form: false,
      });
      await expect(invitee(w1)).toBeVisible();
      await expect(invitee(w2)).toBeVisible();
      await createName(w1).fill("R55 first name");
      await createName(w2).fill("R55 second name");
      await invitee(w2).fill("r55-invitee");
      await quiet(w1);
      await quiet(w2);
      await updateFrom(acting, generations);
      for (const writer of [w1, w2])
        await expect(
          updateRegion(writer).getByText("Atlas updated in another tab."),
        ).toBeVisible();
      await w1.close();
      await w2.close();
      // The households read is held: the create form restores now, the invitation form (earlier in the page) only once it is answered.
      expect(await generations.holdRead(HOUSEHOLDS, true)).toBe(0);
      await navigate(acting, `${generations.url}/sharing`);
      await displayed(acting);
      const create = formOf(acting, createName(acting));
      await expect(
        create.locator('[data-recovery-state="restored"]'),
      ).toHaveCount(1);
      await expect(createName(acting), "D2: the only restore").toBeFocused();
      await expect(
        invitee(acting),
        "the invitation form is not there yet",
      ).toHaveCount(0);
      const shown = await createName(acting).inputValue();
      const other =
        shown === "R55 first name" ? "R55 second name" : "R55 first name";
      expect(["R55 first name", "R55 second name"]).toContain(shown);
      if (choice) {
        const offered = create.getByRole("button", { name: OFFERED });
        await expect(offered).toHaveCount(1);
        await offered.focus();
        await acting.keyboard.press("Enter");
        await expect(createName(acting)).toHaveValue(other);
        await expect(
          create.locator('[data-recovery-state="restored"]'),
          "the banner stays shown",
        ).toHaveCount(1);
        await expect(
          createName(acting),
          "the applied choice focuses the create form's first field",
        ).toBeFocused();
      }
      expect(
        await generations.holdRead(HOUSEHOLDS, false),
        "the held households read is answered",
      ).toBeGreaterThan(0);
      await expect(
        invitee(acting),
        "the invitation form restores late",
      ).toHaveValue("r55-invitee");
      await expect(
        formOf(acting, invitee(acting)).locator(
          '[data-recovery-state="restored"]',
        ),
      ).toHaveCount(1);
      if (choice) {
        await settledFrames(acting);
        await expect(
          createName(acting),
          "F-R54-1: the late automatic restore does not take the person's applied choice",
        ).toBeFocused();
        await expect(createName(acting)).toHaveValue(other);
      } else
        await expect(
          invitee(acting),
          "D2: the earlier form's late restore takes the automatic grant",
        ).toBeFocused();
      expect(await writes(generations), "nothing is submitted").toEqual([]);
    });

  test("F-R54-2: the next page restores its claimed hand-off; another tab's copy chosen puts the hand-off back on offer; 'Check saved copies again' keeps it offered and restorable; nothing sent", async ({
    context,
    generations,
  }) => {
    await world(context, generations, "pwa-r55-handoff");
    // L (live, stays open), G (closes later) and W (the writer) all type a household name.
    const live = await openApp(context, generations, {
      route: "/sharing",
      form: false,
    });
    await workerActive(live);
    await reloadQuietly(live);
    const gone = await openApp(context, generations, {
      route: "/sharing",
      form: false,
    });
    const writer = await openApp(context, generations, {
      route: "/sharing",
      form: false,
    });
    for (const [page, text] of [
      [live, "R55 live tab"],
      [gone, "R55 other tab"],
      [writer, "R55 before the update"],
    ] as const) {
      await expect(createName(page)).toBeVisible();
      await createName(page).fill(text);
      await quiet(page);
    }
    // The writer accepts the update with its form dirty: "Save and reload" saves it and leaves the update hand-off to its next page.
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
