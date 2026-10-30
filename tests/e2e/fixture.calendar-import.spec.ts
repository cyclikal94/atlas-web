import type { Page } from "@playwright/test";
import { corpusText, parserEvents } from "../support/ics-corpus";
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
  leaderOf,
  leaderPage,
  snapshotPage,
  untilLeader,
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

  test("review 15 R12: components are counted as the server's parser reads them: 257 folded refused, a folded header a calendar, 256 rewritten shown and sent byte-identically", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    await page
      .getByRole("button", { name: "Import events into Work rota" })
      .click();
    const dialog = await chooseFile(
      page,
      corpusText("events-folded-257"),
      "over.ics",
    );
    await expect(dialog).toContainText("This file has more than 256 events.");
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).toContainText("This file has more than 256 events.");
    expect(await rows(page, "drafts")).toEqual([]);
    await chooseFile(page, corpusText("header-folded-many"), "header.ics");
    await expect(dialog.locator("[data-import-file]")).toContainText("1 event");
    await expect(dialog).not.toContainText("isn't a calendar");
    const text = corpusText("variants-256");
    expect(parserEvents("variants-256")).toBe(256);
    await chooseFile(page, text, "mixed.ics");
    await expect(dialog.locator("[data-import-file]")).toContainText(
      "256 events",
    );
    await dialog.getByLabel("From").fill("2026-01-01");
    await dialog.getByLabel("Through").fill("2026-12-31");
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).toBeHidden();
    await send(page);
    await expect
      .poll(() => posts(cal, IMPORT_PATH).length, { timeout: 60_000 })
      .toBe(1);
    expect(JSON.parse(posts(cal, IMPORT_PATH)[0]?.body ?? "").ics).toBe(text);
  });

  test("review 16 R13: parameter-heavy files are counted as the parser reads them: 257 parameter variants refused, Review 16's 1 MiB file shown as 1 event and sent byte-identically", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    await page
      .getByRole("button", { name: "Import events into Work rota" })
      .click();
    expect(parserEvents("parameters-257")).toBe(257);
    const dialog = await chooseFile(
      page,
      corpusText("parameters-257"),
      "over.ics",
    );
    await expect(dialog).toContainText("This file has more than 256 events.");
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).toContainText("This file has more than 256 events.");
    expect(await rows(page, "drafts")).toEqual([]);
    // Review 16's largest accepted file: one event whose SUMMARY has 262,000 parameters (1,048,123 bytes).
    const text = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY${";X=A".repeat(262_000)}:Review\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    expect(Buffer.byteLength(text, "utf8")).toBe(1_048_123);
    await chooseFile(page, text, "parameters.ics");
    await expect(dialog.locator("[data-import-file]")).toContainText("1 event");
    await dialog.getByLabel("From").fill("2026-01-01");
    await dialog.getByLabel("Through").fill("2026-12-31");
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).toBeHidden();
    await send(page);
    await expect
      .poll(() => posts(cal, IMPORT_PATH).length, { timeout: 60_000 })
      .toBe(1);
    expect(JSON.parse(posts(cal, IMPORT_PATH)[0]?.body ?? "").ics).toBe(text);
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

test.describe("E-IMP7: the in-dialog sync control keeps the import (revision 6, R7; ia.md §1.3.3, the J2 dialog rule)", () => {
  /**
   * Review 6 R7 in a real engine, real File reads and the PRODUCTION router: the import dialog's sync control keeps what the person chose
   * (file, source, window, a read under way), closes and navigates to `/sync`; Back and opening Import events again show it. Nothing is
   * stored or sent until Import is pressed, nothing of the file reaches storage or history, and another page or a reload has none of it.
   */
  const MARK = "R7-RETAINED-MARK";
  const text = () => calendarText(1).replace("Bin day 0", MARK);
  const syncScreen = async (page: Page) => {
    await expect(page).toHaveURL(/\/sync(?:\?|$)/);
    await expect(
      page.getByRole("heading", { name: "Sync", exact: true }),
    ).toBeVisible();
  };
  const viaSync = async (page: Page) => {
    const dialog = page.getByRole("dialog", { name: "Import events" });
    await dialog.locator("button[data-sync-tone]").click();
    await syncScreen(page);
    await expect(dialog).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(/settings\/calendars/);
  };
  const shown = async (page: Page) => {
    const dialog = page.getByRole("dialog", { name: "Import events" });
    await expect(dialog).toBeVisible();
    const file = dialog.locator("[data-import-file]");
    return {
      file: (await file.count()) > 0 ? await file.textContent() : null,
      from: await dialog.getByLabel("From", { exact: true }).inputValue(),
      through: await dialog.getByLabel("Through", { exact: true }).inputValue(),
    };
  };
  /** Nothing of the file in storage, history or the address (the drafts store is checked separately). */
  const leaks = (page: Page) =>
    page.evaluate((mark) => {
      const found: string[] = [];
      for (const store of [localStorage, sessionStorage])
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i) ?? "";
          if (`${key}${store.getItem(key)}`.includes(mark)) found.push(key);
        }
      if (JSON.stringify(history.state ?? null).includes(mark))
        found.push("history.state");
      if (location.href.includes(mark)) found.push("location");
      return found;
    }, MARK);
  const openRow = (page: Page) =>
    page.getByRole("button", { name: "Import events into Work rota" }).click();

  test("a row's import: file and edited window kept through /sync and Back; nothing stored, sent or written to storage/history", async ({
    context,
  }) => {
    const { page, cal } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    await openRow(page);
    const dialog = await chooseFile(page, text(), "retained.ics");
    await dialog.getByLabel("From", { exact: true }).fill("2026-01-01");
    await dialog.getByLabel("Through", { exact: true }).fill("2026-12-31");
    await viaSync(page);
    await openRow(page);
    expect(await shown(page)).toEqual({
      file: expect.stringContaining("retained.ics"),
      from: "2026-01-01",
      through: "2026-12-31",
    });
    expect(await rows(page, "drafts")).toHaveLength(0);
    expect(cal.wire.filter((w) => w.method === "POST")).toHaveLength(0);
    expect(await leaks(page)).toEqual([]);
    // Then Import stores exactly what was kept.
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).toBeHidden();
    const stored = await draftOf(page, IMPORT_ENDPOINT);
    expect(stored?.target_id).toBe(SOURCE);
  });

  test("control: Cancel discards (the next dialog has no file and the default window)", async ({
    context,
  }) => {
    const { page } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    await openRow(page);
    const dialog = await chooseFile(page, text(), "retained.ics");
    await dialog.getByLabel("From", { exact: true }).fill("2026-01-01");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await openRow(page);
    const now = await shown(page);
    expect(now.file).toBeNull();
    expect(now.from).not.toBe("2026-01-01");
  });

  test("the drop zone's import (Browse): kept through /sync and Back; Browse shows it again without the file picker", async ({
    context,
  }) => {
    const { page } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    const zone = page.locator("[data-import-drop]");
    await zone.locator('input[type="file"]').setInputFiles({
      name: "dropped.ics",
      mimeType: "text/calendar",
      buffer: Buffer.from(text(), "utf8"),
    });
    const dialog = page.getByRole("dialog", { name: "Import events" });
    await expect(dialog.locator("[data-import-file]")).toContainText(
      "dropped.ics",
    );
    await dialog.getByLabel("Through", { exact: true }).fill("2026-12-31");
    await viaSync(page);
    let pickers = 0;
    page.on("filechooser", () => {
      pickers += 1;
    });
    await zone.getByRole("button", { name: "browse" }).click();
    expect(await shown(page)).toMatchObject({
      file: expect.stringContaining("dropped.ics"),
      through: "2026-12-31",
    });
    expect(pickers).toBe(0);
    expect(await rows(page, "drafts")).toHaveLength(0);
  });

  test("a file read still under way at the sync control settles while away (a held read, released at /sync): shown on return, nothing stored", async ({
    context,
  }) => {
    const { page } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    // A test barrier, not a File change: the page's next Blob read waits for `release` (its bytes are the real file's).
    await page.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      (window as unknown as { __r7Release: () => void }).__r7Release = release;
      Blob.prototype.arrayBuffer = async function (this: Blob) {
        Blob.prototype.arrayBuffer = original;
        await gate;
        return original.call(this);
      };
    });
    await openRow(page);
    const dialog = page.getByRole("dialog", { name: "Import events" });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "slow.ics",
      mimeType: "text/calendar",
      buffer: Buffer.from(text(), "utf8"),
    });
    await expect(dialog.getByText("Checking the file…")).toBeVisible();
    await dialog.locator("button[data-sync-tone]").click();
    await syncScreen(page);
    await page.evaluate(() =>
      (window as unknown as { __r7Release: () => void }).__r7Release(),
    );
    await page.goBack();
    await expect(page).toHaveURL(/settings\/calendars/);
    await openRow(page);
    await expect(dialog.locator("[data-import-file]")).toContainText(
      "slow.ics",
    );
    await expect(dialog.getByText("Checking the file…")).toBeHidden();
    expect(await rows(page, "drafts")).toHaveLength(0);
  });

  test("two pages and a new document: another page never shows this page's kept import; a reloaded page has none; a consented import persists", async ({
    context,
  }) => {
    const { page } = await calendarsPage(context, {
      cache: [sourceProjection(SOURCE)],
    });
    await openRow(page);
    const dialog = await chooseFile(page, text(), "page-a.ics");
    await dialog.getByLabel("From", { exact: true }).fill("2026-01-01");
    await dialog.locator("button[data-sync-tone]").click();
    await syncScreen(page);
    // A second page of the same browser, at the Calendars screen.
    const other = await context.newPage();
    await other.goto(ROUTE);
    await other.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await other.evaluate(() => window.__atlasFixture?.session?.ready);
    await expect(
      other.getByRole("heading", { level: 1, name: "Calendar sources" }),
    ).toBeVisible();
    await openRow(other);
    expect((await shown(other)).file).toBeNull();
    const b = await chooseFile(other, calendarText(1), "page-b.ics");
    await b.getByRole("button", { name: "Import", exact: true }).click();
    await expect(b).toBeHidden();
    expect(await rows(other, "drafts")).toHaveLength(1);
    // Page A still has its own kept import.
    await page.goBack();
    await openRow(page);
    expect(await shown(page)).toMatchObject({
      file: expect.stringContaining("page-a.ics"),
      from: "2026-01-01",
    });
    await page
      .getByRole("dialog", { name: "Import events" })
      .locator("button[data-sync-tone]")
      .click();
    await syncScreen(page);
    await page.goBack();
    // A new document for page A (the fixture boots only through its session entry, so the reload loads that address): no session survives
    // it; the stored import does, and holds page B's file only.
    await page.goto(ROUTE);
    await page.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await page.evaluate(() => window.__atlasFixture?.session?.ready);
    await expect(
      page.getByRole("heading", { level: 1, name: "Calendar sources" }),
    ).toBeVisible();
    await openRow(page);
    expect((await shown(page)).file).toBeNull();
    const commands = (await rows(page, "draft_commands")) as Array<{
      command: { ics?: string };
    }>;
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command.ics?.includes(MARK)).toBe(false);
    expect(await leaks(page)).toEqual([]);
    expect(await leaks(other)).toEqual([]);
  });
});

test.describe("E-IMP8: the kept import across a protected-tree remount and a cache invalidation (revision 7, review 7 R7)", () => {
  /**
   * Review 7 R7 (family `task-sync-navigation-draft-loss`, incomplete_fix) in a real engine, real File reads and the PRODUCTION session,
   * leader, protected tree and `DataProvider`; only network answers are scripted (the reviewer's probe, maintained). An ordinary Atlas `403`
   * to a queued settings change makes the session re-check the display: the protected tree unmounts and mounts again under the same
   * identity, so its controller is disposed and a new one built, while the page's leader goes on syncing. Then the engine meets
   * `410 resync_required` (W18: the cache `invalid`) and recovery replaces the cache (W23: `valid` again, the same database). The kept
   * import must have ended: back on Calendars, Import events is a new session. Controls: `422` (no remount) with the same invalidation, and
   * the `403` remount with no invalidation (the import kept). The remount is witnessed by the Sync heading's DOM node being replaced.
   */
  const { kind_date: _kindDate, ...wireSource } = sourceProjection(SOURCE);
  const DROP = "[data-import-drop]";
  type Entry = "row" | "chooser";
  async function scenario(
    context: Parameters<typeof calendarsPage>[0],
    entry: Entry,
    status: 403 | 422,
    invalidate: boolean,
  ) {
    test.setTimeout(90_000);
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
    let release!: (answer: { status: number; body: unknown }) => void;
    cal.answers.set("/calendar-commands", [
      {
        wait: new Promise((resolve) => {
          release = resolve;
        }),
      },
    ]);
    const page = await leaderPage(context, net, "one", undefined, {
      route: "/settings/calendars",
    });
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible({
      timeout: 30_000,
    });
    const identity = () =>
      page.evaluate(() =>
        window.__atlasFixture?.session?.booted?.session.identity.get(),
      );
    const before = {
      identity: await identity(),
      sync: await rows(page, "sync_state"),
    };
    // A settings change queued and held (its answer decides the remount).
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    const manage = page.getByRole("dialog", { name: "Manage — Work rota" });
    await manage.getByLabel("Timezone").fill("Europe/Vienna");
    await manage.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => posts(cal, "/calendar-commands").length).toBe(1);
    // The import, composed and kept by the sync control.
    const dialog = page.getByRole("dialog", {
      name: "Import events",
      exact: true,
    });
    if (entry === "row") {
      await page
        .getByRole("button", { name: "Import events into Work rota" })
        .click();
      await dialog.locator('input[type="file"]').setInputFiles({
        name: "retained.ics",
        mimeType: "text/calendar",
        buffer: Buffer.from(calendarText(1)),
      });
      await expect(dialog.locator("[data-import-file]")).toContainText(
        "retained.ics",
      );
      await dialog.getByLabel("From", { exact: true }).fill("2026-01-01");
    } else {
      await page
        .locator(DROP)
        .locator('input[type="file"]')
        .setInputFiles({
          name: "retained.ics",
          mimeType: "text/calendar",
          buffer: Buffer.from(calendarText(1)),
        });
      await expect(dialog.locator("[data-import-file]")).toContainText(
        "retained.ics",
      );
    }
    await dialog.getByLabel("Through", { exact: true }).fill("2026-12-31");
    await dialog.locator("button[data-sync-tone]").click();
    await expect(page).toHaveURL(/\/sync(?:\?|$)/);
    const heading = page.getByRole("heading", { name: "Sync", exact: true });
    await expect(heading).toBeVisible();
    await heading.evaluate((node) => {
      (node as unknown as { __r7: boolean }).__r7 = true;
    });
    release({
      status,
      body: atlasBody(status === 403 ? "forbidden" : "invalid_value"),
    });
    await expect
      .poll(
        async () =>
          ((await rows(page, "drafts")) as Array<Record<string, unknown>>).find(
            (d) => d.kind === "configure_source",
          )?.status,
        { timeout: 20_000 },
      )
      .toBe("rejected");
    await expect(heading).toBeVisible();
    const remounted = await heading.evaluate(
      (node) => (node as unknown as { __r7?: boolean }).__r7 !== true,
    );
    const after = {
      identity: await identity(),
      sync: await rows(page, "sync_state"),
    };
    const history: unknown[] = [];
    if (invalidate) {
      let resync = false;
      let snapshot!: (page: ReturnType<typeof snapshotPage>) => void;
      const held = new Promise<ReturnType<typeof snapshotPage>>((resolve) => {
        snapshot = resolve;
      });
      net.answer = (call) => {
        if (!resync) {
          resync = true;
          return {
            status: 410,
            body: JSON.stringify(atlasBody("resync_required")),
          };
        }
        return call.cursor === null ? held : deltaPage([], call.cursor);
      };
      await page.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
      await expect
        .poll(async () => (await rows(page, "sync_state"))[0]?.cache_status, {
          timeout: 15_000,
        })
        .toBe("invalid");
      history.push(await rows(page, "sync_state"));
      await expect
        .poll(() => net.calls.filter((c) => c.cursor === null).length, {
          timeout: 15_000,
        })
        .toBe(2);
      snapshot(
        snapshotPage(
          [{ kind: "upsert", resource: wireSource }],
          "delta-refreshed",
          false,
          21,
        ),
      );
      await expect
        .poll(async () => (await rows(page, "sync_state"))[0]?.cache_status, {
          timeout: 15_000,
        })
        .toBe("valid");
      history.push(await rows(page, "sync_state"));
    }
    await page.goBack();
    await expect(page).toHaveURL(/settings\/calendars/);
    let pickers = 0;
    page.on("filechooser", () => {
      pickers += 1;
    });
    if (entry === "row")
      await page
        .getByRole("button", { name: "Import events into Work rota" })
        .click();
    else
      await page.locator(DROP).getByRole("button", { name: "browse" }).click();
    const shownDialog = pickers === 0 && (await dialog.isVisible());
    const file = dialog.locator("[data-import-file]");
    const seen = {
      remounted,
      dialog: shownDialog,
      pickers,
      file:
        shownDialog && (await file.count()) > 0
          ? await file.textContent()
          : null,
      through: shownDialog
        ? await dialog.getByLabel("Through", { exact: true }).inputValue()
        : null,
      drafts: (await rows(page, "drafts")) as Array<Record<string, unknown>>,
      sent: posts(cal, "/calendar-commands").length,
      imports: posts(cal, IMPORT_PATH).length,
    };
    await test.info().attach("observations", {
      body: JSON.stringify(
        { entry, status, invalidate, before, after, history, seen },
        null,
        2,
      ),
      contentType: "application/json",
    });
    // The same identity and database throughout; exactly one rejected settings change, and nothing else stored or sent.
    expect(after.identity).toEqual(before.identity);
    expect(
      (after.sync[0] as { incarnation_id?: string } | undefined)
        ?.incarnation_id,
    ).toBe(
      (before.sync[0] as { incarnation_id?: string } | undefined)
        ?.incarnation_id,
    );
    expect(seen.drafts.map((d) => [d.kind, d.status])).toEqual([
      ["configure_source", "rejected"],
    ]);
    expect(seen.sent).toBe(1);
    expect(seen.imports).toBe(0);
    expect(seen.remounted).toBe(status === 403);
    return { page, dialog, seen };
  }

  for (const entry of ["row", "chooser"] as const) {
    test(`${entry}: 403 (the tree remounted), then the cache invalidated and replaced while kept at /sync: back, a new session`, async ({
      context,
    }) => {
      const { seen } = await scenario(context, entry, 403, true);
      if (entry === "row") {
        expect(seen.dialog).toBe(true);
        expect(seen.file).toBeNull();
        expect(seen.through).not.toBe("2026-12-31");
      } else {
        // Nothing kept: Browse asks for a file, and no dialog is shown.
        expect(seen.pickers).toBe(1);
        expect(seen.dialog).toBe(false);
      }
    });

    test(`${entry} control: 403 (the tree remounted) and no invalidation: back, the SAME session`, async ({
      context,
    }) => {
      const { seen } = await scenario(context, entry, 403, false);
      expect(seen.pickers).toBe(0);
      expect(seen.dialog).toBe(true);
      expect(seen.file).toContain("retained.ics");
      expect(seen.through).toBe("2026-12-31");
    });
  }

  test("row control: 422 (no remount), then the same invalidation and replacement: back, a new session", async ({
    context,
  }) => {
    const { seen } = await scenario(context, "row", 422, true);
    expect(seen.dialog).toBe(true);
    expect(seen.file).toBeNull();
    expect(seen.through).not.toBe("2026-12-31");
  });

  /**
   * L6 (design assessment): TWO pages. Page `two` is a follower and holds the kept import; page `one` leads, meets `410 resync_required` and
   * recovers (W18 then W23), so `two` learns of it only through its own controller's reads of the shared database. In the HELD variant every
   * BroadcastChannel message to `two` (Dexie's cross-tab `storagemutated` wake among them) is held until the cycle is over, so `two` reads
   * only the final, valid state: the generation it carries is what tells. `one` never receives `two`'s unsaved file.
   */
  const HOLD_CHANNELS = () => {
    const Native = BroadcastChannel;
    const queue: Array<() => void> = [];
    const state = window as unknown as {
      __holdChannels: boolean;
      __heldMessages: number;
      __releaseChannels: () => void;
    };
    state.__holdChannels = false;
    state.__heldMessages = 0;
    state.__releaseChannels = () => {
      state.__holdChannels = false;
      for (const deliver of queue.splice(0)) deliver();
    };
    const replayed = new WeakSet<Event>();
    window.BroadcastChannel = class extends Native {
      constructor(name: string) {
        super(name);
        // Registered before any listener of the channel's owner, so it runs first and can hold the message from all of them.
        this.addEventListener("message", (event) => {
          if (!state.__holdChannels || replayed.has(event)) return;
          event.stopImmediatePropagation();
          state.__heldMessages += 1;
          queue.push(() => {
            const copy = new MessageEvent("message", { data: event.data });
            replayed.add(copy);
            this.dispatchEvent(copy);
          });
        });
      }
    } as typeof BroadcastChannel;
  };
  for (const variant of ["delivered", "held", "control"] as const)
    test(`L6 two pages (${variant}): the follower's kept import ${variant === "control" ? "is kept when the leader page only syncs (no invalidation)" : `ends when the leader page invalidates and recovers the cache${variant === "held" ? ", its cross-tab wakes held until after" : ""}`}`, async ({
      context,
    }) => {
      test.setTimeout(90_000);
      const net = await fresh(context);
      net.answer = (call) =>
        call.cursor === null
          ? snapshotPage(
              [{ kind: "upsert", resource: wireSource }],
              "delta-0",
              false,
            )
          : deltaPage([], call.cursor);
      await stubCalendars(context);
      const one = await leaderPage(context, net, "one", undefined, {
        route: "/settings/calendars",
      });
      await expect(one.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible({
        timeout: 30_000,
      });
      const twoPage = await context.newPage();
      await twoPage.addInitScript(HOLD_CHANNELS);
      const two = await leaderPage(context, net, "two", twoPage, {
        route: "/settings/calendars",
      });
      await expect(two.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible({
        timeout: 30_000,
      });
      expect(
        (await untilLeader(two, (v) => v.attachment === "follower")).role,
      ).toBe("follower");
      expect((await leaderOf(one)).role).toBe("leader");
      const before = await rows(two, "sync_state");
      // The follower's import, kept by the sync control.
      const dialog = two.getByRole("dialog", {
        name: "Import events",
        exact: true,
      });
      await two
        .getByRole("button", { name: "Import events into Work rota" })
        .click();
      await dialog.locator('input[type="file"]').setInputFiles({
        name: "retained.ics",
        mimeType: "text/calendar",
        buffer: Buffer.from(calendarText(1).replace("Bin day 0", "L6-MARK")),
      });
      await expect(dialog.locator("[data-import-file]")).toContainText(
        "retained.ics",
      );
      await dialog.getByLabel("From", { exact: true }).fill("2026-01-01");
      await dialog.getByLabel("Through", { exact: true }).fill("2026-12-31");
      await dialog.locator("button[data-sync-tone]").click();
      await expect(two).toHaveURL(/\/sync(?:\?|$)/);
      await expect(
        two.getByRole("heading", { name: "Sync", exact: true }),
      ).toBeVisible();
      if (variant === "held")
        await two.evaluate(() => {
          (window as unknown as { __holdChannels: boolean }).__holdChannels =
            true;
        });
      const history: unknown[] = [];
      let resync = false;
      let snapshot!: (page: ReturnType<typeof snapshotPage>) => void;
      const heldSnapshot = new Promise<ReturnType<typeof snapshotPage>>(
        (resolve) => {
          snapshot = resolve;
        },
      );
      net.answer = (call) => {
        if (variant !== "control" && !resync) {
          resync = true;
          return {
            status: 410,
            body: JSON.stringify(atlasBody("resync_required")),
          };
        }
        return call.cursor === null ? heldSnapshot : deltaPage([], call.cursor);
      };
      await one.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
      if (variant === "control") {
        await expect
          .poll(() => net.calls.filter((c) => c.page === "one").length, {
            timeout: 15_000,
          })
          .toBeGreaterThan(1);
      } else {
        await expect
          .poll(async () => (await rows(one, "sync_state"))[0]?.cache_status, {
            timeout: 15_000,
          })
          .toBe("invalid");
        history.push(await rows(one, "sync_state"));
        await expect
          .poll(() => net.calls.filter((c) => c.cursor === null).length, {
            timeout: 15_000,
          })
          .toBe(2);
        snapshot(
          snapshotPage(
            [{ kind: "upsert", resource: wireSource }],
            "delta-refreshed",
            false,
            21,
          ),
        );
        await expect
          .poll(async () => (await rows(one, "sync_state"))[0]?.cache_status, {
            timeout: 15_000,
          })
          .toBe("valid");
        history.push(await rows(one, "sync_state"));
      }
      const held =
        variant === "held"
          ? await two.evaluate(() => {
              const state = window as unknown as {
                __heldMessages: number;
                __releaseChannels: () => void;
              };
              const count = state.__heldMessages;
              state.__releaseChannels();
              return count;
            })
          : null;
      await two.goBack();
      await expect(two).toHaveURL(/settings\/calendars/);
      await two
        .getByRole("button", { name: "Import events into Work rota" })
        .click();
      await expect(dialog).toBeVisible();
      const file = dialog.locator("[data-import-file]");
      const seen = {
        held,
        file: (await file.count()) > 0 ? await file.textContent() : null,
        from: await dialog.getByLabel("From", { exact: true }).inputValue(),
        through: await dialog
          .getByLabel("Through", { exact: true })
          .inputValue(),
        after: await rows(two, "sync_state"),
        // Nothing of the follower's file in the leader page's storage, nor in the shared drafts.
        leaked: await one.evaluate(() => {
          const found: string[] = [];
          for (const store of [localStorage, sessionStorage])
            for (let i = 0; i < store.length; i += 1) {
              const key = store.key(i) ?? "";
              if (`${key}${store.getItem(key)}`.includes("L6-MARK"))
                found.push(key);
            }
          return found;
        }),
        drafts: await rows(one, "drafts"),
      };
      await test.info().attach("observations", {
        body: JSON.stringify({ variant, before, history, seen }, null, 2),
        contentType: "application/json",
      });
      // The same database throughout (one incarnation), nothing stored or leaked.
      const incarnation = (r: unknown[]) =>
        (r[0] as { incarnation_id?: string } | undefined)?.incarnation_id;
      expect(incarnation(seen.after)).toBe(incarnation(before));
      expect(seen.drafts).toEqual([]);
      expect(seen.leaked).toEqual([]);
      if (variant === "held") expect(seen.held).toBeGreaterThan(0);
      if (variant === "control")
        expect(seen).toMatchObject({
          file: expect.stringContaining("retained.ics"),
          from: "2026-01-01",
          through: "2026-12-31",
        });
      else {
        expect(seen.file).toBeNull();
        expect(seen.from).not.toBe("2026-01-01");
        expect(seen.through).not.toBe("2026-12-31");
      }
    });

  /**
   * E-IMP10 (WEB-13b revision 9, design assessment C2/T5; MORNING-TASK-APPROVALS-20261028): the verification and the enqueue are separate
   * transactions, in a real engine's IndexedDB. The FOLLOWER page `two` has its import dialog OPEN and ready (a cached source, a file and a
   * window), and every cross-tab wake to it is HELD, so it hears nothing more. The leader page `one` meets `410 resync_required` (W18) and
   * fills the cache again (W23). Then `two` presses Import: the enqueue's own transaction, in `two`, reads the singleton the leader wrote, and
   * the history the import states (`EnqueueRequest.continuity`, witness 0) is no longer it (witness 1), so nothing is stored, the dialog
   * closes and says why. Control: the leader only syncs (no invalidation): one import is stored (its sending held in flight).
   */
  for (const invalidate of [true, false])
    test(`E-IMP10 two pages: the follower's OPEN import, its wakes held, ${invalidate ? "pressed after the leader page invalidates (410) and refills: refused in its own transaction (expired), nothing stored, the dialog closes and says why" : "pressed while the leader page only syncs (control): one import stored"}`, async ({
      context,
    }) => {
      test.setTimeout(120_000);
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
      cal.answers.set(IMPORT_PATH, [
        { wait: new Promise<never>(() => undefined) },
      ]);
      const one = await leaderPage(context, net, "one", undefined, {
        route: "/settings/calendars",
      });
      await expect(one.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible({
        timeout: 30_000,
      });
      const twoPage = await context.newPage();
      await twoPage.addInitScript(HOLD_CHANNELS);
      const two = await leaderPage(context, net, "two", twoPage, {
        route: "/settings/calendars",
      });
      await expect(two.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible({
        timeout: 30_000,
      });
      expect(
        (await untilLeader(two, (v) => v.attachment === "follower")).role,
      ).toBe("follower");
      expect((await leaderOf(one)).role).toBe("leader");
      const before = await rows(two, "sync_state");
      const dialog = two.getByRole("dialog", {
        name: "Import events",
        exact: true,
      });
      await two
        .getByRole("button", { name: "Import events into Work rota" })
        .click();
      await dialog.locator('input[type="file"]').setInputFiles({
        name: "verified.ics",
        mimeType: "text/calendar",
        buffer: Buffer.from(calendarText(1).replace("Bin day 0", "IMP10-MARK")),
      });
      await expect(dialog.locator("[data-import-file]")).toContainText(
        "verified.ics",
      );
      await dialog.getByLabel("From", { exact: true }).fill("2026-01-01");
      await dialog.getByLabel("Through", { exact: true }).fill("2026-12-31");
      const press = dialog.getByRole("button", { name: "Import", exact: true });
      await expect(press).toBeEnabled();
      await two.evaluate(() => {
        (window as unknown as { __holdChannels: boolean }).__holdChannels =
          true;
      });
      const history: unknown[] = [];
      let resync = false;
      let snapshot!: (page: ReturnType<typeof snapshotPage>) => void;
      const heldSnapshot = new Promise<ReturnType<typeof snapshotPage>>(
        (resolve) => {
          snapshot = resolve;
        },
      );
      net.answer = (call) => {
        if (invalidate && !resync) {
          resync = true;
          return {
            status: 410,
            body: JSON.stringify(atlasBody("resync_required")),
          };
        }
        return call.cursor === null ? heldSnapshot : deltaPage([], call.cursor);
      };
      await one.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
      if (!invalidate)
        await expect
          .poll(() => net.calls.filter((c) => c.page === "one").length, {
            timeout: 15_000,
          })
          .toBeGreaterThan(1);
      else {
        await expect
          .poll(async () => (await rows(one, "sync_state"))[0]?.cache_status, {
            timeout: 15_000,
          })
          .toBe("invalid");
        history.push(await rows(one, "sync_state"));
        await expect
          .poll(() => net.calls.filter((c) => c.cursor === null).length, {
            timeout: 15_000,
          })
          .toBe(2);
        snapshot(
          snapshotPage(
            [{ kind: "upsert", resource: wireSource }],
            "delta-refreshed",
            false,
            21,
          ),
        );
        await expect
          .poll(async () => (await rows(one, "sync_state"))[0]?.cache_status, {
            timeout: 15_000,
          })
          .toBe("valid");
        history.push(await rows(one, "sync_state"));
      }
      // Heard nothing: the dialog is open and ready as it was (the cached source's E9 close never ran).
      await expect(dialog).toBeVisible();
      await expect(press).toBeEnabled();
      const heldBefore = await two.evaluate(
        () => (window as unknown as { __heldMessages: number }).__heldMessages,
      );
      await press.click();
      if (invalidate) {
        await expect(dialog).toBeHidden();
        await expect(two.locator('[aria-live="polite"]')).toContainText(
          "Import closed while your calendar sources are brought up to date.",
        );
      } else await expect(dialog).toBeHidden();
      const importDrafts = async () =>
        ((await rows(one, "drafts")) as Array<Record<string, unknown>>).filter(
          (d) => d.endpoint === IMPORT_ENDPOINT,
        );
      if (!invalidate)
        await expect.poll(async () => (await importDrafts()).length).toBe(1);
      const seen = {
        heldBefore,
        after: await rows(two, "sync_state"),
        imports: (await importDrafts()).length,
        bodies: (await rows(one, "draft_commands")).length,
        posts: posts(cal, IMPORT_PATH).length,
        leaked: await one.evaluate(() => {
          const found: string[] = [];
          for (const store of [localStorage, sessionStorage])
            for (let i = 0; i < store.length; i += 1) {
              const key = store.key(i) ?? "";
              if (`${key}${store.getItem(key)}`.includes("IMP10-MARK"))
                found.push(key);
            }
          return found;
        }),
      };
      await two.evaluate(() =>
        (
          window as unknown as { __releaseChannels: () => void }
        ).__releaseChannels(),
      );
      await test.info().attach("observations", {
        body: JSON.stringify({ invalidate, before, history, seen }, null, 2),
        contentType: "application/json",
      });
      type Sync = { incarnation_id?: string; cache_invalidation_seq?: number };
      expect((seen.after[0] as Sync).incarnation_id).toBe(
        (before[0] as Sync).incarnation_id,
      );
      expect((seen.after[0] as Sync).cache_invalidation_seq ?? 0).toBe(
        invalidate ? 1 : 0,
      );
      expect(seen.leaked).toEqual([]);
      if (invalidate) {
        expect(seen.heldBefore).toBeGreaterThan(0);
        expect(seen.imports).toBe(0);
        expect(seen.bodies).toBe(0);
        expect(seen.posts).toBe(0);
      } else expect(seen.imports).toBe(1);
    });

  /**
   * E-IMP9 (WEB-13b revision 8, review 8 R7b; design assessment T2/T6): review 8's pending-source schedule in a real engine. The import is
   * composed by the FOLLOWER page `two` against a PENDING source while the cache is still EMPTY (the first snapshot is held; the source's
   * create is held in flight), and kept by the sync control. The leader page `one` then completes the first fill and, in the invalidation
   * variant, meets `410 resync_required` (W18) and fills again (W23), while every cross-tab wake to `two` is HELD, so `two` reads only the
   * final, valid state: a first fill moves the recovery generation exactly as fill, invalidation and refill do, and only the invalidation
   * witness tells them apart. Control: the first fill only, held the same way, keeps the import. Row entry only: the drop zone (the
   * chooser) is shown only over an open cache, so an empty cache offers no chooser to keep.
   */
  for (const invalidate of [true, false])
    test(`E-IMP9 two pages, a pending source on an EMPTY cache: the follower's kept import ${invalidate ? "ends when the leader page fills, invalidates (410) and fills again, its wakes held" : "is kept through the first fill alone (control), its wakes held"}`, async ({
      context,
    }) => {
      test.setTimeout(120_000);
      const net = await fresh(context);
      let fill!: (page: ReturnType<typeof snapshotPage>) => void;
      const firstFill = new Promise<ReturnType<typeof snapshotPage>>(
        (resolve) => {
          fill = resolve;
        },
      );
      let refill!: (page: ReturnType<typeof snapshotPage>) => void;
      const heldRefill = new Promise<ReturnType<typeof snapshotPage>>(
        (resolve) => {
          refill = resolve;
        },
      );
      // One answer throughout (a request retried meanwhile gets the same held page): the first snapshot is held until released; once the
      // first fill is seen (`filled`), the invalidation variant answers its next delta `410` and every later snapshot is the held refill.
      // ADAPTED (WEB-13b revision 12, harness race; same server sequence and assertions): the first delta after the first fill (its
      // cursor, `delta-0`) is answered `410` once the test has seen the fill (`fillSeen`), whenever it was asked. The leader asks for it
      // straight after the fill; asked before `filled` was set it used to be answered `200`, and the nudge, met inside that step, was
      // absorbed, so no `410` came within the poll (one Firefox run, revision 12's driver; trace in its evidence).
      let filled = false;
      let resync = false;
      let fillSeen!: () => void;
      const fillWasSeen = new Promise<void>((resolve) => {
        fillSeen = resolve;
      });
      net.answer = (call) => {
        if (call.cursor === null) return filled ? heldRefill : firstFill;
        if (invalidate && call.cursor === "delta-0" && !resync) {
          resync = true;
          return fillWasSeen.then(() => ({
            status: 410,
            body: JSON.stringify(atlasBody("resync_required")),
          }));
        }
        return deltaPage([], call.cursor);
      };
      const cal = await stubCalendars(context);
      cal.answers.set("/calendar-commands", [
        { wait: new Promise<never>(() => undefined) },
      ]);
      const one = await leaderPage(context, net, "one", undefined, {
        route: "/settings/calendars",
      });
      const twoPage = await context.newPage();
      await twoPage.addInitScript(HOLD_CHANNELS);
      const two = await leaderPage(context, net, "two", twoPage, {
        route: "/settings/calendars",
      });
      expect(
        (await untilLeader(two, (v) => v.attachment === "follower")).role,
      ).toBe("follower");
      expect((await leaderOf(one)).role).toBe("leader");
      // The pending source, created on the follower; its create is sent by the leader and held in flight.
      await two.getByRole("button", { name: "Add source" }).click();
      const add = two.getByRole("dialog", { name: "Add source" });
      await add.getByLabel("Label").fill("Pending calendar");
      await add.getByLabel("Timezone").fill("Europe/London");
      await add.getByRole("button", { name: "Create source" }).click();
      await expect(add).toBeHidden();
      const before = await rows(two, "sync_state");
      expect(
        (before[0] as { cache_status?: string } | undefined)?.cache_status,
      ).toBe("empty");
      const dialog = two.getByRole("dialog", {
        name: "Import events",
        exact: true,
      });
      const row = two.getByRole("button", {
        name: "Import events into Pending calendar",
      });
      await row.click();
      await dialog.locator('input[type="file"]').setInputFiles({
        name: "retained.ics",
        mimeType: "text/calendar",
        buffer: Buffer.from(calendarText(1).replace("Bin day 0", "IMP9-MARK")),
      });
      await expect(dialog.locator("[data-import-file]")).toContainText(
        "retained.ics",
      );
      await dialog.getByLabel("From", { exact: true }).fill("2026-01-01");
      await dialog.getByLabel("Through", { exact: true }).fill("2026-12-31");
      await dialog.locator("button[data-sync-tone]").click();
      await expect(two).toHaveURL(/\/sync(?:\?|$)/);
      await two.evaluate(() => {
        (window as unknown as { __holdChannels: boolean }).__holdChannels =
          true;
      });
      const history: unknown[] = [];
      // The first fill (a snapshot with one source: an EMPTY initial snapshot restarts rather than making the cache valid).
      fill(
        snapshotPage(
          [{ kind: "upsert", resource: wireSource }],
          "delta-0",
          false,
        ),
      );
      await expect
        .poll(async () => (await rows(one, "sync_state"))[0]?.cache_status, {
          timeout: 20_000,
        })
        .toBe("valid");
      history.push(await rows(one, "sync_state"));
      filled = true;
      fillSeen();
      if (invalidate) {
        await one.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
        await expect
          .poll(async () => (await rows(one, "sync_state"))[0]?.cache_status, {
            timeout: 15_000,
          })
          .toBe("invalid");
        history.push(await rows(one, "sync_state"));
        refill(
          snapshotPage(
            [{ kind: "upsert", resource: wireSource }],
            "delta-refilled",
            false,
            21,
          ),
        );
        await expect
          .poll(async () => (await rows(one, "sync_state"))[0]?.cache_status, {
            timeout: 15_000,
          })
          .toBe("valid");
        history.push(await rows(one, "sync_state"));
      }
      const held = await two.evaluate(() => {
        const state = window as unknown as {
          __heldMessages: number;
          __releaseChannels: () => void;
        };
        const count = state.__heldMessages;
        state.__releaseChannels();
        return count;
      });
      await two.goBack();
      await expect(two).toHaveURL(/settings\/calendars/);
      await row.click();
      await expect(dialog).toBeVisible();
      const file = dialog.locator("[data-import-file]");
      const seen = {
        held,
        file: (await file.count()) > 0 ? await file.textContent() : null,
        from: await dialog.getByLabel("From", { exact: true }).inputValue(),
        through: await dialog
          .getByLabel("Through", { exact: true })
          .inputValue(),
        after: await rows(two, "sync_state"),
        drafts: (await rows(one, "drafts")) as Array<Record<string, unknown>>,
        imports: posts(cal, IMPORT_PATH).length,
        leaked: await one.evaluate(() => {
          const found: string[] = [];
          for (const store of [localStorage, sessionStorage])
            for (let i = 0; i < store.length; i += 1) {
              const key = store.key(i) ?? "";
              if (`${key}${store.getItem(key)}`.includes("IMP9-MARK"))
                found.push(key);
            }
          return found;
        }),
      };
      await test.info().attach("observations", {
        body: JSON.stringify({ invalidate, before, history, seen }, null, 2),
        contentType: "application/json",
      });
      type Sync = {
        incarnation_id?: string;
        cache_status?: string;
        recovery_generation?: number;
        cache_invalidation_seq?: number;
      };
      const first = before[0] as Sync;
      const last = seen.after[0] as Sync;
      // One database; the first fill's restarts moved the generation in both variants (while the first snapshot was held, before or
      // after the import opened), the invalidation moved it again; only the invalidation moved the witness.
      expect(last.incarnation_id).toBe(first.incarnation_id);
      expect(last.cache_status).toBe("valid");
      expect(last.recovery_generation ?? 0).toBeGreaterThan(0);
      if (invalidate)
        expect(last.recovery_generation ?? 0).toBeGreaterThan(
          first.recovery_generation ?? 0,
        );
      expect(last.cache_invalidation_seq ?? 0).toBe(invalidate ? 1 : 0);
      expect(seen.held).toBeGreaterThan(0);
      expect(seen.drafts.map((d) => d.kind)).toEqual(["create_source"]);
      expect(seen.imports).toBe(0);
      expect(seen.leaked).toEqual([]);
      if (invalidate) {
        expect(seen.file).toBeNull();
        expect(seen.from).not.toBe("2026-01-01");
        expect(seen.through).not.toBe("2026-12-31");
      } else
        expect(seen).toMatchObject({
          file: expect.stringContaining("retained.ics"),
          from: "2026-01-01",
          through: "2026-12-31",
        });
    });
});
