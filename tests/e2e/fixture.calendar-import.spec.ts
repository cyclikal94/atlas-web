import type { Page } from "@playwright/test";
import {
  ACCOUNT,
  atlasBody,
  calendarsPage,
  calendarText,
  IMPORT_PATH,
  pathKey,
  posts,
  rows,
  send,
  smallTargets,
  sourceProjection,
  stubCalendars,
} from "./calendar-13b-helpers";
import {
  deltaPage,
  fresh,
  leaderPage,
  snapshotPage,
} from "./data-leader-helpers";
import { startOutbox, untilTreeSettled } from "./data-sync-helpers";
import { expect, runAxe, test } from "./helpers";
import { goOfflineAtBoundary, goOnlineAtBoundary } from "./tasks-helpers";

/**
 * E-IMP1 to E-IMP5 (WEB-13b; Q22 "file imports"; delivery-slices "Acceptance cases for calendar command queuing" 1, 2, 4, 6(b) and 7): the
 * local ICS import in a real engine through the PRODUCTION composition, with the network stubbed and the data harness's fixture leader
 * sending what the screen queued (its conflict registry has the import's terminal answers, as the page host's has). FIXTURE evidence:
 * no backend behind any of it (I-IMP1..4 run the same journeys against the released one).
 */
const SOURCE = "00000000-0000-4000-8000-00000000ca13";
const ROUTE = "/__session?route=%2Fsettings%2Fcalendars";

/** Chooses `text` as the dialog's file (a real file control) and waits for the device's check of it. */
async function chooseFile(page: Page, text: string, name = "family.ics") {
  const dialog = page.getByRole("dialog", { name: "Import events" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "text/calendar",
    buffer: Buffer.from(text, "utf8"),
  });
  await expect(dialog.locator("[data-import-file]")).toContainText(name);
  return dialog;
}

async function importInto(
  page: Page,
  label: string,
  text: string,
  window_ = { from: "2026-01-01", through: "2026-12-31" },
) {
  await page
    .getByRole("button", { name: `Import events into ${label}` })
    .click();
  const dialog = await chooseFile(page, text);
  await dialog.getByLabel("From").fill(window_.from);
  await dialog.getByLabel("Through").fill(window_.through);
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toBeHidden();
}

const draftOf = async (page: Page, endpoint: string) =>
  ((await rows(page, "drafts")) as Array<Record<string, unknown>>).find(
    (d) => d.endpoint === endpoint,
  ) as
    | {
        local_id: string;
        status: string;
        depends_on: string[];
        attempts: number;
        target_id: string;
        last_error: { status?: number; code?: string; stage: string } | null;
      }
    | undefined;
const IMPORT_ENDPOINT = "/calendar-sources/{id}/import";

test.describe("E-IMP1: an import into a pending source (case 2)", () => {
  test("composed offline against this device's pending create; sent only after the create's receipt, to the source's address, byte-identical", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, cal } = await calendarsPage(context);
    // Offline at the app's boundary (WebKit's emulated offline fails every File read, even of a File made in the page: evidence in
    // .agtx/evidence/WEB-13b/findings/webkit-offline-file).
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "Add source" }).click();
    const add = page.getByRole("dialog", { name: "Add source" });
    await add.getByLabel("Label").fill("Weekend chores");
    await add.getByLabel("Timezone").fill("Europe/London");
    await add.getByRole("button", { name: "Create source" }).click();
    await expect(add).toBeHidden();
    const text = calendarText(2);
    await importInto(page, "Weekend chores", text);
    const create = await draftOf(page, "/calendar-commands");
    const imported = await draftOf(page, IMPORT_ENDPOINT);
    expect(imported?.depends_on).toEqual([create?.local_id]);
    await expect(page.locator("[data-import-status]")).toHaveAttribute(
      "data-import-status",
      "queued",
    );
    expect(cal.wire.filter((w) => w.method === "POST")).toEqual([]);

    // Online, the create's answer is held: nothing else is sent until it is receipted.
    let release: (v: { status: number; body: unknown }) => void = () =>
      undefined;
    cal.answers.set("/calendar-commands", [
      {
        wait: new Promise((resolve) => {
          release = resolve;
        }),
      },
    ]);
    await goOnlineAtBoundary(page);
    await send(page);
    await expect.poll(() => posts(cal, "/calendar-commands").length).toBe(1);
    await page.waitForTimeout(1_500);
    expect(posts(cal, IMPORT_PATH)).toEqual([]);
    release({ status: 200, body: { revision: 301 } });
    await expect
      .poll(() => posts(cal, IMPORT_PATH).length, { timeout: 30_000 })
      .toBe(1);
    const [sent] = posts(cal, IMPORT_PATH);
    expect(sent?.path).toBe(`/calendar-sources/${imported?.target_id}/import`);
    expect(sent?.key).toBe(imported?.local_id);
    expect(JSON.parse(sent?.body ?? "")).toEqual({
      ics: text,
      from: "2026-01-01",
      through: "2026-12-31",
    });
    await expect(page.locator("[data-import-status]")).toHaveAttribute(
      "data-import-status",
      "accepted",
    );
    await expect(page.locator("[data-import-draft]")).toContainText(
      "Import accepted.",
    );
  });

  test("control: an import into a cached, editable, enabled source is sent at once", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    await importInto(page, "Work rota", calendarText(1));
    await send(page);
    await expect
      .poll(() => posts(cal, IMPORT_PATH).length, { timeout: 30_000 })
      .toBe(1);
    expect(posts(cal, IMPORT_PATH)[0]?.path).toBe(
      `/calendar-sources/${SOURCE}/import`,
    );
  });
});

test.describe("E-IMP2: uncertainty (cases 1 and 6)", () => {
  test("a lost answer is resent with the SAME key and body; 409 refresh_in_progress keeps it uncertain across a reload, then the receipt", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    await importInto(page, "Work rota", calendarText(3));
    cal.answers.set(IMPORT_PATH, [
      { abort: true },
      { status: 409, body: atlasBody("refresh_in_progress") },
    ]);
    await send(page);
    await expect
      .poll(() => posts(cal, IMPORT_PATH).length, { timeout: 30_000 })
      .toBe(2);
    const draft = await draftOf(page, IMPORT_ENDPOINT);
    expect(draft?.status).toBe("in_flight");
    await expect(page.locator("[data-import-status]")).toHaveAttribute(
      "data-import-status",
      "sent",
    );
    // A reload while it waits: the new page's leader resends it under the same key, and the receipt settles it.
    await page.goto(ROUTE);
    await page.waitForFunction(() => window.__atlasData !== undefined);
    await untilTreeSettled(page, { connections: 2 });
    await startOutbox(page, ACCOUNT, { start: false });
    await send(page);
    await expect
      .poll(() => posts(cal, IMPORT_PATH).length, { timeout: 60_000 })
      .toBe(3);
    const sent = posts(cal, IMPORT_PATH);
    expect(new Set(sent.map((s) => s.key))).toEqual(new Set([draft?.local_id]));
    expect(new Set(sent.map((s) => s.body)).size).toBe(1);
    await expect
      .poll(async () => (await draftOf(page, IMPORT_ENDPOINT))?.status, {
        timeout: 30_000,
      })
      .toBe("acknowledged");
  });

  test("503 temporarily_unavailable (7(f), the busy calendar permits) is the generic retry: resent, then receipted", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    await importInto(page, "Work rota", calendarText(1));
    cal.answers.set(IMPORT_PATH, [
      { status: 503, body: atlasBody("temporarily_unavailable") },
    ]);
    await send(page);
    await expect
      .poll(() => posts(cal, IMPORT_PATH).length, { timeout: 60_000 })
      .toBe(2);
    await expect
      .poll(async () => (await draftOf(page, IMPORT_ENDPOINT))?.status, {
        timeout: 30_000,
      })
      .toBe("acknowledged");
  });
});

const TERMINAL: Array<
  [string, number, string, Record<string, unknown>, string]
> = [
  [
    "422 invalid_ics",
    422,
    "invalid_ics",
    {},
    "the file isn't a valid calendar",
  ],
  [
    "422 unsupported_calendar_rule",
    422,
    "unsupported_calendar_rule",
    {},
    "it uses a repeat rule Atlas doesn't support",
  ],
  ["422 calendar_limit", 422, "calendar_limit", {}, "it's over Atlas's limits"],
  [
    "422 invalid_value (turned off)",
    422,
    "invalid_value",
    {},
    "this calendar is turned off",
  ],
  [
    "502 fetch_failed (Atlas)",
    502,
    "fetch_failed",
    {},
    "it contains something Atlas can't read",
  ],
  [
    "409 stale_refresh (generation_changed)",
    409,
    "stale_refresh",
    { reason: "generation_changed" },
    "another update to this calendar finished first",
  ],
  [
    "409 stale_refresh (lease_expired)",
    409,
    "stale_refresh",
    { reason: "lease_expired" },
    "another update to this calendar finished first",
  ],
  ["404 not_found", 404, "not_found", {}, "this calendar no longer exists"],
];

test.describe("E-IMP3: terminal answers (cases 4 and 7)", () => {
  for (const [name, status, code, extra, words] of TERMINAL)
    test(`${name}: sent once, refused with its words; nothing changed`, async ({
      context,
    }) => {
      test.setTimeout(60_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [sourceProjection(SOURCE)],
      });
      await importInto(page, "Work rota", calendarText(1));
      cal.answers.set(IMPORT_PATH, [{ status, body: atlasBody(code, extra) }]);
      await send(page);
      const entry = page.locator("[data-import-draft]");
      await expect(entry).toHaveAttribute("data-import-status", "rejected", {
        timeout: 30_000,
      });
      await expect(entry).toContainText(`Couldn't import this file — ${words}`);
      await expect(entry).toContainText(
        "Nothing changed: your existing events for this source are exactly as before.",
      );
      await page.waitForTimeout(4_000);
      expect(posts(cal, IMPORT_PATH)).toHaveLength(1);
      await entry.getByRole("button", { name: "Dismiss" }).click();
      await expect(page.locator("[data-import-draft]")).toHaveCount(0);
    });

  test("a gateway's 502 (no Atlas body) is retried; 503 slice_capacity is held for the person and never resent by itself", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    await importInto(page, "Work rota", calendarText(1));
    cal.answers.set(IMPORT_PATH, [
      {
        status: 502,
        body: "<html>Bad gateway</html>",
        contentType: "text/html",
      },
      { status: 503, body: atlasBody("slice_capacity") },
    ]);
    await send(page);
    await expect
      .poll(() => posts(cal, IMPORT_PATH).length, { timeout: 60_000 })
      .toBe(2);
    const entry = page.locator("[data-import-draft]");
    await expect(entry).toHaveAttribute("data-import-status", "blocked", {
      timeout: 30_000,
    });
    await expect(entry).toContainText(
      "Atlas has run out of room for new items on this server",
    );
    await expect(entry).not.toContainText("your account is full");
    await page.waitForTimeout(6_000);
    expect(posts(cal, IMPORT_PATH)).toHaveLength(2);
  });

  test("a settings change queued after an import that is refused is refused with it (dependency), and says so", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    // Offline at the app's boundary (WebKit's emulated offline fails every File read, even of a File made in the page: evidence in
    // .agtx/evidence/WEB-13b/findings/webkit-offline-file).
    await goOfflineAtBoundary(page);
    await importInto(page, "Work rota", calendarText(1));
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    const manage = page.getByRole("dialog", { name: "Manage — Work rota" });
    await manage.getByLabel("Timezone").fill("Europe/Vienna");
    await manage.getByRole("button", { name: "Save" }).click();
    await expect(manage).toBeHidden();
    cal.answers.set(IMPORT_PATH, [
      { status: 422, body: atlasBody("invalid_ics") },
    ]);
    await goOnlineAtBoundary(page);
    await send(page);
    await expect
      .poll(
        async () =>
          (
            (await rows(page, "drafts")) as Array<{
              endpoint: string;
              status: string;
            }>
          )
            .map((d) => d.status)
            .sort(),
        { timeout: 30_000 },
      )
      .toEqual(["rejected", "rejected"]);
    expect(posts(cal, "/calendar-commands")).toEqual([]);
  });
});

test.describe("E-IMP4: the client bounds (case 4)", () => {
  test("over the limits, not UTF-8, or a bad window: refused on this device, nothing stored or sent", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    await page
      .getByRole("button", { name: "Import events into Work rota" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Import events" });
    await chooseFile(page, calendarText(257));
    await expect(dialog).toContainText("This file has more than 256 events.");
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "latin1.ics",
      mimeType: "text/calendar",
      buffer: Buffer.concat([
        Buffer.from("BEGIN:VCALENDAR\r\nSUMMARY:"),
        Buffer.from([0xe9, 0xff]),
        Buffer.from("\r\nEND:VCALENDAR\r\n"),
      ]),
    });
    await expect(dialog).toContainText("it isn't UTF-8");
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "lines.ics",
      mimeType: "text/calendar",
      buffer: Buffer.from(
        `BEGIN:VCALENDAR\r\n${"X-A:b\r\n".repeat(20_000)}END:VCALENDAR\r\n`,
      ),
    });
    await expect(dialog).toContainText("This file has more than 20,000 lines.");
    await chooseFile(
      page,
      `${calendarText(1)}${"é".repeat(524_288)}`,
      "big.ics",
    );
    await expect(dialog).toContainText("This file is larger than 1 MiB.");
    await chooseFile(page, calendarText(1), "ok.ics");
    await dialog.getByLabel("From").fill("2026-01-01");
    await dialog.getByLabel("Through").fill("2028-01-02");
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).toContainText("no more than 730 days later");
    await dialog.getByLabel("From").fill("1899-12-31");
    await dialog.getByLabel("Through").fill("1900-01-02");
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).toContainText("Enter a date between 1900 and 9999");
    expect(await rows(page, "drafts")).toEqual([]);
    expect(cal.wire.filter((w) => w.method === "POST")).toEqual([]);
  });

  test("a valid file of exactly 1 MiB is stored and sent byte-identically (the large-draft path of a real engine)", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    const text = calendarText(3, 1_048_576);
    expect(Buffer.byteLength(text, "utf8")).toBe(1_048_576);
    await importInto(page, "Work rota", text);
    await send(page);
    await expect
      .poll(() => posts(cal, IMPORT_PATH).length, { timeout: 60_000 })
      .toBe(1);
    expect(JSON.parse(posts(cal, IMPORT_PATH)[0]?.body ?? "").ics).toBe(text);
  });
});

const WIDTHS = [
  { width: 320, height: 1200 },
  { width: 390, height: 1200 },
  { width: 768, height: 1024 },
  { width: 834, height: 1112 },
  { width: 1112, height: 834 },
  { width: 1280, height: 900 },
];
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
for (const scheme of ["dark", "light"] as const)
  test.describe(`E-IMP5: layout, axe and keyboard (${scheme})`, () => {
    test.use({ colorScheme: scheme });
    test("every width: the drop zone, the Imports panel and the dialog pass axe with contrast, 44 px targets, no horizontal scroll; the dialog is a sheet below 768 px", async ({
      context,
    }) => {
      test.setTimeout(180_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [sourceProjection(SOURCE)],
      });
      await importInto(page, "Work rota", calendarText(1));
      cal.answers.set(IMPORT_PATH, [
        { status: 422, body: atlasBody("unsupported_calendar_rule") },
      ]);
      await send(page);
      await expect(page.locator("[data-import-draft]")).toHaveAttribute(
        "data-import-status",
        "rejected",
        { timeout: 30_000 },
      );
      for (const size of WIDTHS) {
        await page.setViewportSize(size);
        await expect(page.locator("[data-import-drop]")).toBeVisible();
        const violations = await runAxe(page);
        expect(
          violations.map((v) => [v.id, v.nodes.map((n) => n.target)]),
          `${size.width}`,
        ).toEqual([]);
        expect(await smallTargets(page), `${size.width}`).toEqual([]);
        expect(await overflow(page), `${size.width}`).toBeLessThanOrEqual(0);
        const opener = page.getByRole("button", {
          name: "Import events into Work rota",
        });
        await opener.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Import events" });
        await expect(dialog).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(
              () => document.activeElement?.closest('[role="dialog"]') !== null,
            ),
          )
          .toBe(true);
        const box = await dialog.boundingBox();
        if (size.width < 768)
          expect(box?.width, `${size.width} sheet`).toBeGreaterThanOrEqual(
            size.width - 1,
          );
        else
          expect(box?.width ?? 0, `${size.width} dialog`).toBeLessThan(
            size.width,
          );
        const inDialog = await runAxe(page);
        expect(
          inDialog.map((v) => [v.id, v.nodes.map((n) => n.target)]),
          `${size.width} dialog`,
        ).toEqual([]);
        expect(await smallTargets(page), `${size.width} dialog`).toEqual([]);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(opener).toBeFocused();
      }
    });
  });

test.describe("E-IMP6: the PRODUCTION leader and the page host's registrations", () => {
  /**
   * The production leader (`?leader=production`, WEB-09b) sends what the tree queued, with the PAGE HOST's conflict registry: the import's
   * terminal answers are registered there by the protected tree before the leader starts (`app/commands.ts`). A `403` is NOT exercised
   * here: an ordinary 403 to any queued command makes the session re-check the display, the leader stops and restarts its dispatcher, the
   * answer is dropped and the draft is resent at once, in a loop (finding F-13b-1, pre-existing at b9fd602, `.agtx/execute.md`). The 403's
   * classification is covered by `tests/data/outbox-calendar-extension.test.ts`.
   */
  // The wire's projection (no `kind_date`: that is the cache's derived key).
  const { kind_date: _kindDate, ...wireSource } = sourceProjection(SOURCE);
  async function productionPage(context: Parameters<typeof calendarsPage>[0]) {
    const net = await fresh(context);
    net.answer = (call) =>
      call.cursor === null
        ? snapshotPage(
            [{ kind: "upsert", resource: wireSource }],
            "delta-0",
            false,
          )
        : deltaPage([], call.cursor);
    const cal = await stubCalendars(context);
    const page = await leaderPage(context, net, "one", undefined, {
      route: "/settings/calendars",
    });
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible({
      timeout: 30_000,
    });
    cal.phase = "test";
    return { page, net, cal };
  }
  const importDraft = async (page: Page) =>
    ((await rows(page, "drafts")) as Array<Record<string, unknown>>).find(
      (d) => d.endpoint === IMPORT_ENDPOINT,
    ) as { status: string; local_id: string } | undefined;

  for (const [name, status, code, extra] of [
    [
      "409 stale_refresh",
      409,
      "stale_refresh",
      { reason: "generation_changed" },
    ],
    ["502 fetch_failed", 502, "fetch_failed", {}],
  ] as const)
    test(`${name} through the production leader: sent once, terminal, with no harness call`, async ({
      context,
    }) => {
      test.setTimeout(90_000);
      const { page, cal } = await productionPage(context);
      cal.answers.set(IMPORT_PATH, [{ status, body: atlasBody(code, extra) }]);
      await importInto(page, "Work rota", calendarText(1));
      await expect
        .poll(async () => (await importDraft(page))?.status, {
          timeout: 30_000,
        })
        .toBe("rejected");
      await page.waitForTimeout(4_000);
      expect(posts(cal, IMPORT_PATH)).toHaveLength(1);
      expect(pathKey(posts(cal, IMPORT_PATH)[0]?.path ?? "")).toBe(IMPORT_PATH);
      await expect(page.locator("[data-import-draft]")).toHaveAttribute(
        "data-import-status",
        "rejected",
      );
    });

  test("control: a 409 refresh_in_progress through the production leader is retried under the same key, then receipted", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, cal } = await productionPage(context);
    cal.answers.set(IMPORT_PATH, [
      { status: 409, body: atlasBody("refresh_in_progress") },
    ]);
    await importInto(page, "Work rota", calendarText(1));
    await expect
      .poll(() => posts(cal, IMPORT_PATH).length, { timeout: 60_000 })
      .toBe(2);
    expect(posts(cal, IMPORT_PATH)[1]?.key).toBe(
      posts(cal, IMPORT_PATH)[0]?.key,
    );
    await expect
      .poll(async () => (await importDraft(page))?.status, { timeout: 30_000 })
      .toBe("acknowledged");
  });
});
