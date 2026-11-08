import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import { API, json, ME, personP, setup } from "./people-helpers";

/**
 * WEB-11a revision 27 (review 28, R28.1; design assessment M06/M07): the People recovery journey across a page that is LEFT and RETURNED
 * to, in a real engine, over the fixture build. Fixture evidence only: there is no backend.
 *
 * E-P50 is the actual persisted restore. Playwright's default Chromium (the headless shell) passes `--disable-back-forward-cache`, and
 * Review 28 recorded `pageshow.persisted=false` for the default Firefox and WebKit runtimes too. Only the installed FULL Chromium build
 * with that flag removed restores the same heap, so this file runs only in the `fixture-bfcache-chromium` project (playwright.config.ts),
 * which no other file matches and which runs nothing else. Its first case is the capability control: if a plain page is not restored
 * from the back/forward cache, the run fails rather than passing on a reload.
 *
 * Review 28 found that after a real restore the session lifted the gate (open=false, root not inert, account displayed) but its closed
 * `<dialog>` still covered the page and took the click on Save (R28.1). E-P50 checks the engine's rendering and hit testing at Save,
 * then makes the ordinary click (actionability checks included, never `force`).
 *
 * Its nonpersisted companion, E-P51 (a reload, in all three engines), is in fixture.people.spec.ts.
 */
/** The person's other acts sit behind "More" in the identity header (the Final design, 8 November 2026): opened once per screen. */
async function openMore(scope: Locator) {
  const more = scope.getByRole("button", { name: "More", exact: true });
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
}
const P = "55555555-5555-4555-8555-555555555555";
const UNCERTAIN = "We couldn't confirm this was saved";
type Sent = { key: string | null; body: string | null };

/** The first command's connection is reset (outcome unknown to the page); later ones are answered. */
async function lossyCommands(context: BrowserContext, sent: Sent[]) {
  await context.route(`**${API}/people-commands`, async (route) => {
    sent.push({
      key: route.request().headers()["idempotency-key"] ?? null,
      body: route.request().postData(),
    });
    if (sent.length === 1) await route.abort("connectionreset");
    else await route.fulfill(json(200, { revision: 2, person_id: P }));
  });
}

/** Every document records its own heap identity and its `pageshow` events, from before the application boots. */
async function lifecycleWitness(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __heap?: string;
      __pageshows?: boolean[];
    };
    w.__heap = crypto.randomUUID();
    w.__pageshows = [];
    window.addEventListener("pageshow", (event) =>
      w.__pageshows?.push(event.persisted),
    );
  });
  for (const path of ["__restore-away", "__restore-control"])
    await context.route(`**/${path}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><title>${path}</title><p>${path}</p>`,
      }),
    );
}
const witness = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __heap?: string; __pageshows?: boolean[] };
    return { heap: w.__heap ?? null, pageshows: w.__pageshows ?? [] };
  });

/** Leave for a plain page, run `whileAway`, then go Back and wait for the returned document's `pageshow` (not a load event). */
async function awayAndBack(page: Page, whileAway: () => void = () => {}) {
  await page.goto("/__restore-away");
  whileAway();
  await page.goBack({ waitUntil: "commit" });
  await expect
    .poll(async () => (await witness(page)).pageshows.length)
    .toBeGreaterThan(0);
}

test.describe("E-P50: an uncertain Rename across a real persisted Back (A17, A20, A21, DA26-18; review 28, R28.1)", () => {
  test("E-P50 control: this browser restores a plain page from the back/forward cache (persisted pageshow, the same heap)", async ({
    context,
  }) => {
    await lifecycleWitness(context);
    const page = await context.newPage();
    await page.goto("/__restore-control");
    const before = await witness(page);
    await awayAndBack(page);
    const after = await witness(page);
    expect(after.heap, "the same heap").toBe(before.heap);
    expect(after.pageshows.at(-1), "a persisted pageshow").toBe(true);
    await expect(page.locator("p")).toHaveText("__restore-control");
  });

  test("E-P50: the gate lifts and is gone, the linkage is read again, the typed name is kept, and a real click on Save sends the original key and body", async ({
    context,
  }, info) => {
    await lifecycleWitness(context);
    const { page, served } = await setup(
      context,
      `/people/${P}`,
      [personP(P, "Initial")],
      { linked: { [P]: ME } },
    );
    const sent: Sent[] = [];
    await lossyCommands(context, sent);
    const header = page.locator("[data-identity-header]");
    await expect(header.locator("[data-linkage]")).toHaveAttribute(
      "data-linkage",
      "self",
    );
    await openMore(header);
    await header.getByRole("button", { name: "Rename", exact: true }).click();
    await header
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Retained");
    await header.getByRole("button", { name: "Save", exact: true }).click();
    await expect(header).toContainText(UNCERTAIN);
    expect(sent).toHaveLength(1);
    const before = await witness(page);
    const reads = served.log.filter(
      (line) => line === `GET /people/${P}/summary`,
    ).length;

    // Away, the person is unlinked elsewhere (version 2); then the real Back.
    await awayAndBack(page, () =>
      served.people.set(P, {
        person: personP(P, "Initial", { version: 2 }),
        linked: null,
      }),
    );
    const after = await witness(page);
    expect(after.heap, "the same heap: a real restore, not a reload").toBe(
      before.heap,
    );
    expect(after.pageshows.at(-1), "a persisted pageshow").toBe(true);

    // The session gate opened on pagehide; the restore's check lifts it, and the page reads the linkage again.
    await page.waitForFunction(
      () =>
        !document.getElementById("protected-root")?.hasAttribute("inert") &&
        (document.getElementById("resume-gate") as HTMLDialogElement | null)
          ?.open === false,
    );
    await expect(header.locator("[data-linkage]")).toHaveAttribute(
      "data-linkage",
      "unlinked",
    );
    await expect
      .poll(
        () =>
          served.log.filter((line) => line === `GET /people/${P}/summary`)
            .length,
      )
      .toBeGreaterThan(reads);
    const name = header.getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toHaveValue("Retained");
    const save = header.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeEnabled();
    expect(sent, "nothing was sent again by itself").toHaveLength(1);

    // What the engine renders and hit-tests where the click on Save will go.
    const atSave = await save.evaluate((button) => {
      const gate = document.getElementById("resume-gate");
      const box = button.getBoundingClientRect();
      const top = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return {
        gateExists: gate !== null,
        gateDisplay: gate ? getComputedStyle(gate).display : null,
        gateLaidOut: (gate?.getClientRects().length ?? 0) > 0,
        reachesSave: top !== null && button.contains(top),
      };
    });
    expect(atSave, "the closed gate is absent; Save takes the click").toEqual({
      gateExists: true,
      gateDisplay: "none",
      gateLaidOut: false,
      reachesSave: true,
    });

    await save.click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1], "the original key and body").toEqual(sent[0]);
    expect(JSON.parse(sent[0]?.body ?? "{}").command).toMatchObject({
      kind: "rename_profile",
      person_id: P,
      expected_version: 1,
    });
    await expect(header.locator("[data-rename-form]")).toHaveCount(0);
    recordEvidence(info, "e-p50-persisted-back", {
      before,
      after,
      sent,
      atSave,
    });
  });
});
