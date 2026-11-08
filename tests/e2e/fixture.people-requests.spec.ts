import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import * as copy from "../../src/features/people/requests/copy";
import { recordEvidence } from "./data-evidence";
import { settleElsewhere } from "./data-leader-helpers";
import { settled } from "./data-sync-helpers";
import { pressTab, runAxe } from "./helpers";
import {
  API,
  atlas,
  bootAt,
  connectivity,
  fieldP,
  json,
  ME,
  MO,
  navigateInApp,
  personP,
  type Served,
  setup,
} from "./people-helpers";

/**
 * WEB-11b in Chromium, Firefox and WebKit: WF-PEOPLE-05/06 on the PRODUCTION session and protected tree (`/__session`), the production
 * data controller and REAL IndexedDB, with the people, request and directory endpoints stubbed by `context.route` (`people-helpers.ts`,
 * every WEB-11b request logged in order in `served.requestLog`). FIXTURE evidence: an answer here is the stub's (I-PPL17 to I-PPL23 run
 * against the released backend).
 *
 * E-R1 incoming list, count and offline; E-R2 sender naming; E-R3 a link answered in two steps, 404 and 409; E-R4 the recipient's partial
 * review and its token; E-R5 410 and a 409 that re-reads; E-R6 sent states and paging; E-R7 Cancel and 404; E-R8 Ask to link with the
 * re-verification before the command; E-R9 Compare & merge from the duplicates (values, conflicts, focus order, exact body); E-R10 a
 * request_merge and a merged alias; E-R11 linkage pre-checks; E-R12 the detail's "Ask to link…"; E-R13 an uncertain merge across a 403
 * remount, and Decline after an uncertain Accept; E-R15 viewports, themes and axe (browser emulation, not devices); E-R15b the comparison's
 * internal geometry with long supported values (R5 of review 1); E-R16 keyboard only; E-R17 a refused (403) comparison not asked again by itself through
 * the production session's re-evaluation and remount (N1 of revision 1); E-R18 a superseded (late) 403 never refuses a newer comparison
 * (R7 of review 2); E-R19 two tabs of one account, the 403 remembered in its own tab only (S10 of review 2's design assessment).
 * E-R20 a failed comparison's Try again retires every earlier answer, for the sender and the recipient (R7 of review 3).
 * E-R21 a sender's success consumes only the name choice its own attempt captured (R1 of review 4): a choice made in a comparison
 * reopened through either entry while the request is held survives the earlier success (and, as the control, its 409); an uncertain
 * merge tried again exactly keeps the newer choice; two tabs of one account keep their own choices.
 * E-R14 (review 1, R6): the incoming read held for the displayed account across an ACTUAL account switch (another tab settles another
 * account through the production store and posts the auth hint, as `settleElsewhere` does for E-T10), with the new account's own read
 * shown and the old answer, delivered late, never shown; its control releases the held read with no switch. E-R1b (R3): People 01's
 * Requests entry with nothing waiting, below 1280 px.
 */
const ADA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BEA = "abababab-abab-4bab-8bab-abababababab";
const MOHAMMED = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const MOPERSON = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const PHONE_S = "c0000000-0000-4000-8000-000000000001";
const PHONE_T = "c0000000-0000-4000-8000-000000000002";
const STRANGER = "99999999-9999-4999-8999-999999999999";
const R1 = "10000000-0000-4000-8000-000000000001";
const R2 = "10000000-0000-4000-8000-000000000002";
const R3 = "10000000-0000-4000-8000-000000000003";
const T1 = "1".repeat(64);
const T2 = "2".repeat(64);
const inDays = (days: number) =>
  Math.floor(Date.now() / 1000) + days * 86_400 + 120;

const linkRequest = (over: Record<string, unknown> = {}) => ({
  id: R1,
  sender_id: MO,
  expires_at: inDays(5),
  proposal: { kind: "link", person_id: ADA, account_id: ME, name: "Ada" },
  ...over,
});
const mergeRequest = (over: Record<string, unknown> = {}) => ({
  id: R2,
  sender_id: STRANGER,
  expires_at: inDays(1),
  proposal: {
    kind: "merge",
    source_id: MOHAMMED,
    target_id: MOPERSON,
    name: "Mo",
  },
  ...over,
});
const sentRequest = (
  id: string,
  state: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  recipient_id: MO,
  recipient_username: "mo",
  expires_at: inDays(4),
  state,
  proposal: { kind: "link", person_id: ADA, account_id: MO, name: "Ada" },
  ...over,
});
const projection = (id: string, label: string) =>
  personP(id, label, { version: 3, policy_version: 2 });
/** axe violations with their targets, for a readable failure. */
const axeOf = async (page: Page) =>
  (await runAxe(page)).map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
/** The command a recorded `/people-commands` call carried (an empty one when there is no such call). */
const commandAt = (served: Served, index: number) =>
  ((
    served.peopleCommands[index]?.body as
      | { command?: Record<string, unknown> }
      | undefined
  )?.command ?? {}) as Record<string, unknown>;
const kinds = (served: Served) =>
  served.peopleCommands.map(
    (c) => (c.body as { command: { kind: string } }).command,
  );
const incomingRow = (page: Page, id: string) =>
  page.locator(`[data-incoming-request="${id}"]`);
const sentRow = (page: Page, id: string) =>
  page.locator(`[data-sent-request="${id}"]`);

test.describe("E-R1: Waiting for you (A1)", () => {
  test("ordered by expiry with exact time left; the header count and the mobile banner; offline unavailable with nothing kept; reconnect reads again", async ({
    context,
  }, info) => {
    const { page, served } = await setup(
      context,
      "/people/requests",
      [projection(ADA, "Ada")],
      {
        arrange: (s) => {
          s.incoming = [
            linkRequest({ expires_at: inDays(5) }),
            mergeRequest({ expires_at: inDays(1) }),
          ];
        },
      },
    );
    await expect(incomingRow(page, R1)).toBeVisible();
    const order = await page
      .locator("[data-incoming-request]")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-incoming-request")),
      );
    expect(order).toEqual([R2, R1]);
    await expect(incomingRow(page, R1)).toContainText(copy.TIME_LEFT.days(5));
    await expect(incomingRow(page, R2)).toContainText(copy.TIME_LEFT.days(1));
    await navigateInApp(page, "/people");
    await expect(page.locator("[data-requests-count]")).toHaveText("2");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("[data-requests-banner]")).toContainText(
      copy.REQUESTS_WAITING(2),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await navigateInApp(page, "/people/requests");
    await connectivity(context, page, false);
    await expect(
      page.locator('[data-requests-state="offline"]').first(),
    ).toHaveText(copy.REQUESTS_OFFLINE);
    await expect(page.locator("[data-incoming-request]")).toHaveCount(0);
    const before = served.requestLog.filter(
      (l) => l === "GET /people/requests",
    ).length;
    await connectivity(context, page, true);
    await expect(incomingRow(page, R1)).toBeVisible();
    // The reconnection's invalidation reads again asynchronously (the earlier answer may be drawn first): wait for the new read.
    await expect
      .poll(
        () =>
          served.requestLog.filter((l) => l === "GET /people/requests").length,
      )
      .toBeGreaterThan(before);
    recordEvidence(info, "e-r1", { requestLog: served.requestLog });
  });
});

test.describe("E-R1b: People 01's Requests entry with nothing waiting (A7; R3 of review 1)", () => {
  test("390 px, none waiting: the entry stays (no banner, no count claimed) and opens Requests with Sent and New request; offline it stays", async ({
    context,
  }) => {
    const { page } = await setup(context, "/people", [projection(ADA, "Ada")], {
      arrange: (s) => {
        s.incoming = [];
        s.sent = [sentRequest(R3, "accepted")];
      },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const entry = page.locator(
      'a[href="/people/requests"][data-people-action="requests"]',
    );
    await expect(entry).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.body.innerText))
      .not.toContain(copy.REQUESTS_WAITING(0));
    await expect(page.locator("[data-requests-banner]")).toHaveCount(0);
    await connectivity(context, page, false);
    await expect(entry).toBeVisible();
    await connectivity(context, page, true);
    await entry.click();
    await expect(page).toHaveURL(/\/people\/requests$/);
    await page.getByRole("tab", { name: copy.SENT }).click();
    await expect(sentRow(page, R3)).toBeVisible();
    await expect(
      page.getByRole("button", { name: copy.NEW_REQUEST }),
    ).toBeVisible();
  });
});

test.describe("E-R2: who sent it (A1, A13)", () => {
  test("a shared household names the sender; another is 'Someone outside your households' with the caution; no account id is shown", async ({
    context,
  }) => {
    const { page } = await setup(
      context,
      "/people/requests",
      [projection(ADA, "Ada")],
      {
        arrange: (s) => {
          s.incoming = [linkRequest(), mergeRequest()];
        },
      },
    );
    await expect(
      incomingRow(page, R1).locator('[data-request-sender="known"]'),
    ).toHaveText("mo");
    await expect(incomingRow(page, R2)).toContainText(copy.SOMEONE);
    await expect(
      incomingRow(page, R2).locator("[data-request-caution]"),
    ).toHaveText(copy.UNNAMED_CAUTION);
    expect(await page.locator("main").textContent()).not.toContain(STRANGER);
  });
});

test.describe("E-R3: answering a link request (A2)", () => {
  test("Accept sends nothing; Confirm accept sends respond_request without a token, once; Decline; 404 banner with its reference; 409 copy", async ({
    context,
  }, info) => {
    const { page, served } = await setup(
      context,
      "/people/requests",
      [projection(ADA, "Ada")],
      {
        arrange: (s) => {
          s.incoming = [linkRequest(), linkRequest({ id: R3 })];
        },
      },
    );
    const row = incomingRow(page, R1);
    await row.getByRole("button", { name: copy.ACCEPT, exact: true }).click();
    await expect(row.locator("[data-link-consequence]")).toContainText(
      copy.LINK_CONSEQUENCE("Ada"),
    );
    expect(served.peopleCommands).toHaveLength(0);
    served.incoming = [linkRequest({ id: R3 })];
    await row.getByRole("button", { name: copy.CONFIRM_ACCEPT }).dblclick();
    await expect.poll(() => served.peopleCommands.length).toBe(1);
    expect(served.peopleCommands[0]?.body).toEqual({
      command: { kind: "respond_request", id: R1, accept: true },
    });
    expect(served.peopleCommands[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    await expect(row).toHaveCount(0);
    served.peopleScript.push({
      status: 404,
      body: atlas("not_found", "61af3d02-0000-4000-8000-000000000404"),
    });
    served.incoming = [];
    await incomingRow(page, R3)
      .getByRole("button", { name: copy.DECLINE })
      .click();
    await expect.poll(() => served.peopleCommands.length).toBe(2);
    expect(served.peopleCommands[1]?.body).toEqual({
      command: { kind: "respond_request", id: R3, accept: false },
    });
    await expect(
      page.locator('[data-people-banner="error"]').first(),
    ).toContainText(copy.ANSWERED_ELSEWHERE);
    await expect(
      page
        .locator("main")
        .getByText("Reference: 61af3d02-0000-4000-8000-000000000404"),
    ).toBeVisible();
    served.incoming = [linkRequest({ id: R1 })];
    await page.getByRole("button", { name: copy.CLOSE }).click();
    await page.getByRole("button", { name: copy.REFRESH }).click();
    served.peopleScript.push({ status: 409, body: atlas("conflict") });
    await incomingRow(page, R1)
      .getByRole("button", { name: copy.ACCEPT, exact: true })
      .click();
    await incomingRow(page, R1)
      .getByRole("button", { name: copy.CONFIRM_ACCEPT })
      .click();
    await expect(incomingRow(page, R1)).toContainText(
      copy.LINK_OUT_OF_DATE("mo"),
    );
    recordEvidence(info, "e-r3", { peopleCommands: served.peopleCommands });
  });
});

const recipientPreview = (over: Record<string, unknown> = {}) => ({
  token: T1,
  source: null,
  target: projection(MOPERSON, "Mo"),
  fields: [{ id: PHONE_T, parent_id: MOPERSON, label: "Phone", version: 1 }],
  requires_approval: true,
  combines_identity_audiences: true,
  freezes_field_policies: true,
  stale: false,
  ...over,
});

test.describe("E-R4: the recipient's partial review (A3, A13)", () => {
  test("the hidden side is 'Not visible to you' with the unavailable note; Accept echoes this preview's token; stale shows its banner", async ({
    context,
  }, info) => {
    const { page, served } = await setup(
      context,
      `/people/requests/${R2}`,
      [
        projection(MOPERSON, "Mo"),
        fieldP(PHONE_T, MOPERSON, "Phone", {
          kind: "text",
          text: "07700 900461",
        }),
      ],
      {
        arrange: (s) => {
          s.incoming = [mergeRequest()];
          s.recipientPreviews.set(R2, recipientPreview({ stale: true }));
        },
      },
    );
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-merge-partial]")).toContainText(
      copy.COMPARISON_UNAVAILABLE,
    );
    await expect(dialog.locator("[data-merge-comparison]")).toContainText(
      copy.NOT_VISIBLE,
    );
    await expect(dialog.locator("[data-merge-comparison]")).toContainText(
      "07700 900461",
    );
    await expect(dialog).toContainText(copy.STALE(copy.SOMEONE));
    await dialog
      .getByRole("button", { name: copy.ACCEPT, exact: true })
      .click();
    await expect.poll(() => served.peopleCommands.length).toBe(1);
    expect(served.peopleCommands[0]?.body).toEqual({
      command: {
        kind: "respond_request",
        id: R2,
        accept: true,
        recipient_preview_token: T1,
      },
    });
    await expect(page).toHaveURL(new RegExp(`/people/${MOPERSON}$`));
    recordEvidence(info, "e-r4", { requestLog: served.requestLog });
  });
});

test.describe("E-R5: expired, and a 409 that reads the review again (A3)", () => {
  test("410: expired and Accept withdrawn", async ({ context }) => {
    const { page } = await setup(
      context,
      `/people/requests/${R2}`,
      [projection(MOPERSON, "Mo")],
      {
        arrange: (s) => {
          s.incoming = [mergeRequest()];
          s.requestScript.set(
            "review",
            Array.from({ length: 6 }, () => ({
              status: 410,
              body: atlas("invitation_expired"),
            })),
          );
        },
      },
    );
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(copy.REQUEST_EXPIRED);
    await expect(
      dialog.getByRole("button", { name: copy.ACCEPT, exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: copy.DECLINE }),
    ).toBeVisible();
  });

  test("409 on accept: the preview is read again; the second Accept carries the NEW token, only after a new press", async ({
    context,
  }, info) => {
    const { page, served } = await setup(
      context,
      `/people/requests/${R2}`,
      [projection(MOPERSON, "Mo")],
      {
        arrange: (s) => {
          s.incoming = [mergeRequest()];
          s.recipientPreviews.set(R2, recipientPreview());
        },
      },
    );
    const dialog = page.getByRole("dialog");
    const accept = dialog.getByRole("button", {
      name: copy.ACCEPT,
      exact: true,
    });
    await expect(accept).toBeEnabled();
    served.peopleScript.push({ status: 409, body: atlas("conflict") });
    served.recipientPreviews.set(R2, recipientPreview({ token: T2 }));
    await accept.click();
    await expect(dialog).toContainText(copy.MERGE_CHANGED);
    await expect
      .poll(
        () =>
          served.requestLog.filter((l) =>
            l.startsWith(`GET /people/requests/${R2}`),
          ).length,
      )
      .toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(500);
    expect(served.peopleCommands).toHaveLength(1);
    await expect(accept).toBeEnabled();
    await accept.click();
    await expect.poll(() => served.peopleCommands.length).toBe(2);
    expect(commandAt(served, 1).recipient_preview_token).toBe(T2);
    // The second command follows a review read made after the first answer (request log order).
    const log = served.requestLog;
    const firstCommand = log.indexOf("POST /people-commands respond_request");
    const reread = log.findIndex(
      (l, i) => i > firstCommand && l.startsWith(`GET /people/requests/${R2}`),
    );
    const secondCommand = log.lastIndexOf(
      "POST /people-commands respond_request",
    );
    expect(reread).toBeGreaterThan(firstCommand);
    expect(secondCommand).toBeGreaterThan(reread);
    recordEvidence(info, "e-r5", { requestLog: log });
  });
});

test.describe("E-R6: Sent, every state and its pages (A4)", () => {
  test("all five states verbatim; a full page, then an empty page with a cursor, then the end; Previous restores; no device caveat", async ({
    context,
  }) => {
    const states = ["pending", "accepted", "declined", "cancelled", "expired"];
    const firstPage = Array.from({ length: 50 }, (_, i) =>
      sentRequest(
        `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        states[i % 5] as string,
      ),
    );
    const { page } = await setup(
      context,
      "/people/requests",
      [projection(ADA, "Ada")],
      {
        arrange: (s) => {
          // By cursor, whenever each page is read (the page reads again on every invalidation).
          s.sentPages.set("", {
            items: firstPage,
            next_after: firstPage[49]?.id,
          });
          s.sentPages.set(firstPage[49]?.id as string, {
            items: [],
            next_after: R3,
          });
          s.sentPages.set(R3, { items: [], next_after: null });
        },
      },
    );
    await expect(page.locator("[data-sent-request]")).toHaveCount(50);
    for (const [i, state] of states.entries()) {
      const row = sentRow(page, firstPage[i]?.id as string);
      if (state === "pending")
        await expect(
          row.getByRole("button", { name: copy.CANCEL_REQUEST_TO("mo") }),
        ).toBeVisible();
      else
        await expect(row.locator("[data-sent-label]")).toHaveText(
          copy.STATE[state as keyof typeof copy.STATE],
        );
    }
    await page.getByRole("button", { name: copy.NEXT }).click();
    await expect(page.locator('[data-sent-state="more"]')).toHaveText(
      copy.PAGE_MORE,
    );
    await page.getByRole("button", { name: copy.NEXT }).click();
    await expect(page.getByRole("button", { name: copy.NEXT })).toHaveCount(0);
    await expect(page.locator("main").getByText(copy.NO_SENT)).toHaveCount(0);
    await page.getByRole("button", { name: copy.PREVIOUS }).click();
    await page.getByRole("button", { name: copy.PREVIOUS }).click();
    await expect(page.locator("[data-sent-request]")).toHaveCount(50);
    expect(
      (await page.locator("main").textContent())?.toLowerCase(),
    ).not.toContain("this device");
  });
});

test.describe("E-R7: Cancel (A4)", () => {
  test("Cancel request sends cancel_request; a 404 is said on the row with its reference", async ({
    context,
  }) => {
    const { page, served } = await setup(
      context,
      "/people/requests",
      [projection(ADA, "Ada")],
      {
        arrange: (s) => {
          s.sent = [sentRequest(R1, "pending")];
          s.peopleScript.push({
            status: 404,
            body: atlas("not_found", "61af3d02-0000-4000-8000-0000000000c4"),
          });
        },
      },
    );
    await sentRow(page, R1)
      .getByRole("button", { name: copy.CANCEL_REQUEST_TO("mo") })
      .click();
    await expect.poll(() => served.peopleCommands.length).toBe(1);
    expect(served.peopleCommands[0]?.body).toEqual({
      command: { kind: "cancel_request", id: R1 },
    });
    await expect(sentRow(page, R1)).toContainText(copy.ANSWERED_ELSEWHERE);
    await expect(sentRow(page, R1)).toContainText(
      "Reference: 61af3d02-0000-4000-8000-0000000000c4",
    );
  });
});

async function chooseLink(page: Page) {
  await page.getByRole("button", { name: copy.CHOOSE }).click();
  await page.locator(`[data-pick-person="${ADA}"]`).click();
  await page.getByRole("button", { name: copy.SEARCH_DIRECTORY }).click();
  const exact = page.locator('[data-lookup="exact"]');
  await exact.getByRole("textbox", { name: "Exact username" }).fill("mo");
  await exact.getByRole("textbox", { name: "Exact username" }).press("Enter");
  await exact.getByRole("button", { name: /choose/i }).click();
  await expect(page.locator('[data-link-recipient="mo"]')).toBeVisible();
}

test.describe("E-R8: Ask to link (A5)", () => {
  test("only owned, unlinked people offered; the exact lookup is asked again BEFORE request_link; the linkage version is sent; an account gone sends nothing; 503", async ({
    context,
  }, info) => {
    const { page, served } = await setup(
      context,
      "/people/requests",
      [
        personP(ADA, "Ada", { version: 7 }),
        projection(BEA, "Bea"),
        projection(MOPERSON, "Mo"),
      ],
      {
        linked: { [MOPERSON]: MO },
        arrange: (s) => {
          s.directory = [{ id: MO, username: "mo" }];
          s.summaries.set(BEA, {
            your_access: "view",
            added_by_you: "no",
            owner: { account_id: MO, username: "mo", you: false, person: null },
            audience: {
              disclosure: "partial",
              in_home: false,
              households: [],
              your_direct_grant: { can_edit: false },
              direct_grant_count: null,
              excluded_count: null,
            },
          });
        },
      },
    );
    await page.getByRole("button", { name: copy.CHOOSE }).click();
    await expect(page.locator(`[data-pick-person="${ADA}"]`)).toBeVisible();
    await expect(page.locator(`[data-pick-person="${BEA}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-pick-person="${MOPERSON}"]`)).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: `‹ ${copy.CANCEL}` }).click();
    await chooseLink(page);
    const mark = served.requestLog.length;
    await page.getByRole("button", { name: copy.SEND_REQUEST }).click();
    await expect.poll(() => served.peopleCommands.length).toBe(1);
    const after = served.requestLog.slice(mark);
    const lookup = after.indexOf("GET /directory?username=mo");
    const command = after.indexOf("POST /people-commands request_link");
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(command).toBeGreaterThan(lookup);
    expect(commandAt(served, 0)).toMatchObject({
      kind: "request_link",
      person_id: ADA,
      account_id: MO,
      expected_version: 7,
    });
    // The account is gone by the next send: the re-check finds nobody, nothing is sent.
    await chooseLink(page);
    served.requestScript.set("directory", [{ status: 200, body: [] }]);
    await page.getByRole("button", { name: copy.SEND_REQUEST }).click();
    await expect(
      page.locator("main").getByText(copy.ACCOUNT_GONE),
    ).toBeVisible();
    expect(served.peopleCommands).toHaveLength(1);
    served.peopleScript.push({ status: 503, body: atlas("slice_capacity") });
    await page.getByRole("button", { name: copy.SEND_REQUEST }).click();
    await expect(
      page.locator("main").getByText(copy.CAPACITY("mo")),
    ).toBeVisible();
    await expect(page.locator('[data-link-recipient="mo"]')).toBeVisible();
    recordEvidence(info, "e-r8", { requestLog: served.requestLog });
  });
});

const mergeWorld = (
  extra: {
    linked?: Record<string, string | null>;
    arrange?: (s: Served) => void;
  } = {},
) => ({
  resources: [
    projection(MOHAMMED, "Mohammed A."),
    projection(MOPERSON, "Mo"),
    fieldP(
      PHONE_S,
      MOHAMMED,
      "Phone",
      { kind: "text", text: "07700 900802" },
      { version: 2 },
    ),
    fieldP(
      PHONE_T,
      MOPERSON,
      "phone",
      { kind: "text", text: "07700 900461" },
      { version: 1 },
    ),
  ],
  options: {
    linked: extra.linked ?? {},
    arrange: (s: Served) => {
      s.mergePreviews.set(`${MOHAMMED}:${MOPERSON}`, {
        token: T1,
        fields: [
          { id: PHONE_S, parent_id: MOHAMMED, label: "Phone", version: 2 },
          // A later version than this device holds: its value is not shown.
          { id: PHONE_T, parent_id: MOPERSON, label: "phone", version: 2 },
        ],
      });
      extra.arrange?.(s);
    },
  },
});
const COMPARE = `/people/${MOPERSON}/duplicates/${MOHAMMED}`;

test.describe("E-R9: Compare & merge from the duplicates (A6)", () => {
  test("values only from same-id rows at the preview's version; the conflict note; the consequence before the action in focus order; one exact merge; the kept person", async ({
    context,
  }, info) => {
    const world = mergeWorld({
      arrange: (s) =>
        s.duplicates.push({
          items: [projection(MOHAMMED, "Mohammed A.")],
          next_after: null,
        }),
    });
    const { page, served } = await setup(
      context,
      `/people/${MOPERSON}/duplicates`,
      world.resources,
      world.options,
    );
    await page.getByRole("link", { name: copy.COMPARE_AND_MERGE }).click();
    await expect(page).toHaveURL(new RegExp(`${COMPARE}$`));
    const dialog = page.getByRole("dialog", {
      name: copy.MERGE_TITLE("Mohammed A.", "Mo"),
    });
    const table = dialog.locator("[data-merge-comparison]");
    await expect(table).toContainText("07700 900802");
    await expect(table).not.toContainText("07700 900461");
    await expect(table.locator("[data-comparison-unsynced]")).toHaveText(
      copy.NOT_ON_DEVICE,
    );
    await expect(dialog.locator("[data-merge-conflicts]")).toContainText(
      copy.BOTH_HAVE("phone", "Mohammed A."),
    );
    const merge = dialog.getByRole("button", { name: copy.MERGE_THEM });
    await expect(merge).toBeEnabled();
    // Focus order: from the conflict note onwards, the consequence section is passed before the action is reached.
    const consequenceFirst = await dialog.evaluate((root) => {
      const note = root.querySelector("[data-merge-consequence]");
      const action = root.querySelector('[data-people-action="confirm-merge"]');
      return (
        note !== null &&
        action !== null &&
        Boolean(
          note.compareDocumentPosition(action) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        )
      );
    });
    expect(consequenceFirst).toBe(true);
    expect(await merge.getAttribute("aria-describedby")).toBe(
      await dialog.locator("[data-merge-consequence]").getAttribute("id"),
    );
    await merge.dblclick();
    await expect.poll(() => served.peopleCommands.length).toBe(1);
    expect(served.peopleCommands[0]?.body).toEqual({
      command: {
        kind: "merge",
        source_id: MOHAMMED,
        target_id: MOPERSON,
        preview_token: T1,
        name: "Mo",
      },
    });
    await expect(page).toHaveURL(new RegExp(`/people/${MOPERSON}$`));
    recordEvidence(info, "e-r9", {
      peopleCommands: served.peopleCommands,
      requestLog: served.requestLog,
    });
  });
});

test.describe("E-R10: a request to merge, and a merged alias (A6, A9)", () => {
  test("approval needed: 'Ask mo to merge', request_merge with a fresh id; a published alias says 'Merged into Mo' and Restore is disabled", async ({
    context,
  }, info) => {
    const world = mergeWorld({
      arrange: (s) => {
        s.mergePreviews.set(`${MOHAMMED}:${MOPERSON}`, {
          token: T1,
          requires_approval: true,
        });
        s.summaries.set(MOHAMMED, {
          your_access: "view",
          added_by_you: "no",
          owner: { account_id: MO, username: "mo", you: false, person: null },
          audience: {
            disclosure: "partial",
            in_home: false,
            households: [],
            your_direct_grant: { can_edit: false },
            direct_grant_count: null,
            excluded_count: null,
          },
        });
      },
    });
    const { page, served } = await setup(
      context,
      COMPARE,
      world.resources,
      world.options,
    );
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(copy.HAS_TO_ACCEPT("mo"));
    await dialog
      .getByRole("button", { name: copy.ASK_TO_MERGE_WITH("mo") })
      .click();
    await expect.poll(() => served.peopleCommands.length).toBe(1);
    const command = commandAt(served, 0);
    expect(command).toMatchObject({
      kind: "request_merge",
      source_id: MOHAMMED,
      target_id: MOPERSON,
      preview_token: T1,
      name: "Mo",
    });
    expect(command.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page).toHaveURL(new RegExp(`/people/${MOPERSON}/duplicates$`));
    recordEvidence(info, "e-r10", { command });
  });

  test("a merged alias published by sync: the note links to the kept person; Archive/Restore is disabled with its reason", async ({
    context,
  }) => {
    const { page } = await setup(context, `/people/${MOHAMMED}`, [
      personP(MOHAMMED, "Mohammed A.", {
        archived: true,
        value: { canonical_person_id: MOPERSON },
        version: 4,
      }),
      projection(MOPERSON, "Mo"),
    ]);
    await expect(
      page.getByRole("link", { name: copy.MERGED_ALIAS("Mo") }),
    ).toBeVisible();
    // Restore is behind the header's "More" (the Final design): disabled there, with its reason beside it.
    const more = page
      .locator("[data-identity-header]")
      .getByRole("button", { name: "More", exact: true });
    if ((await more.getAttribute("aria-expanded")) !== "true")
      await more.click();
    await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled();
    await expect(
      page.locator("main").getByText(copy.ALIAS_NO_RESTORE),
    ).toBeVisible();
  });
});

test.describe("E-R11: who controls the two profiles (A6)", () => {
  test("both linked: the cause, no action, nothing sent; one linked: its name fixed and sent exactly; unknown offline: disabled with the reason", async ({
    context,
  }) => {
    const both = mergeWorld({ linked: { [MOHAMMED]: MO, [MOPERSON]: ME } });
    const { page, served } = await setup(
      context,
      COMPARE,
      both.resources,
      both.options,
    );
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.locator('[data-people-banner="error"]').first(),
    ).toContainText(copy.BOTH_LINKED);
    await expect(
      dialog.getByRole("button", { name: copy.MERGE_THEM }),
    ).toBeDisabled();
    served.people.set(MOPERSON, {
      person: projection(MOPERSON, "Mo"),
      linked: null,
    });
    await dialog.getByRole("button", { name: copy.RELOAD }).click();
    await expect(dialog.locator("[data-merge-name-fixed]")).toHaveText(
      "Mohammed A.",
    );
    await expect(dialog).toContainText(copy.LINKED_NAME);
    await dialog.getByRole("button", { name: copy.MERGE_THEM }).click();
    await expect.poll(() => served.peopleCommands.length).toBe(1);
    expect(commandAt(served, 0).name).toBe("Mohammed A.");
    expect(kinds(served).map((c) => c.kind)).toEqual(["merge"]);
  });

  test("a linkage not known (offline before it was read): the action is disabled with its reason", async ({
    context,
  }) => {
    const world = mergeWorld();
    const { page } = await setup(
      context,
      `/people/${MOPERSON}/duplicates`,
      world.resources,
      world.options,
    );
    await connectivity(context, page, false);
    await navigateInApp(page, COMPARE);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(copy.PREVIEW_OFFLINE);
    await expect(
      dialog.getByRole("button", { name: copy.MERGE_THEM }),
    ).toHaveCount(0);
  });
});

test.describe("E-R12: 'Ask to link…' on the detail (A7)", () => {
  test("only for a known unlinked person the reader owns; absent when linked; opens the form with the person chosen", async ({
    context,
  }) => {
    const { page } = await setup(
      context,
      `/people/${ADA}`,
      [projection(ADA, "Ada"), projection(MOPERSON, "Mo")],
      {
        linked: { [MOPERSON]: MO },
      },
    );
    await page.getByRole("button", { name: copy.ASK_TO_LINK_ENTRY }).click();
    await expect(page).toHaveURL(/\/people\/requests$/);
    await expect(page.locator(`[data-link-person="${ADA}"]`)).toBeVisible();
    await navigateInApp(page, `/people/${MOPERSON}`);
    await expect(page.locator('[data-linkage="other"]')).toBeVisible();
    await expect(
      page.getByRole("button", { name: copy.ASK_TO_LINK_ENTRY }),
    ).toHaveCount(0);
  });
});

test.describe("E-R13: uncertain outcomes across a 403 remount (A8, A11)", () => {
  test("an uncertain merge: the remounted dialog says it may have happened; Try again resends the same key and byte-identical body", async ({
    context,
  }, info) => {
    const world = mergeWorld({ arrange: (s) => s.peopleScript.push("abort") });
    const { page, served } = await setup(
      context,
      COMPARE,
      world.resources,
      world.options,
    );
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: copy.MERGE_THEM }),
    ).toBeEnabled();
    await dialog.evaluate((el) => el.setAttribute("data-e-r13-before", ""));
    // The comparison read that follows the uncertain send is refused 403: the protected tree remounts (D-12a-13).
    served.requestScript.set("merge", [
      { status: 403, body: atlas("forbidden") },
    ]);
    await dialog.getByRole("button", { name: copy.MERGE_THEM }).click();
    await expect(page.getByRole("dialog")).toContainText(copy.UNCERTAIN);
    await expect(page.locator("[data-e-r13-before]")).toHaveCount(0);
    // Pressed once the remounted dialog has settled: a press while the remount replaces the dialog lands outside the new one, which the
    // shared non-modal Dialog treats as a dismissal (harness timing, recorded in the hand-off). ADAPTATION (revision 1, N1): the settled
    // dialog used to be recognised by its comparison read AGAIN; the 403 is now remembered for the page (D-12a-13) and not asked again by
    // itself, so the remounted dialog shows the refusal, and the retained merge stays reachable beside it.
    const remounted = page.getByRole("dialog");
    await expect(remounted).toContainText(copy.PREVIEW_FORBIDDEN);
    await expect(remounted).toContainText(copy.UNCERTAIN);
    const previews = () =>
      served.requestLog.filter((line) => line === "POST /people/merge-preview")
        .length;
    const asked = previews();
    // The retained merge is offered again (an assertion, so a missing Try again is caught as such, never as a click timeout).
    const again = remounted.getByRole("button", { name: copy.TRY_AGAIN });
    await expect(again).toBeVisible();
    await again.click();
    await expect.poll(() => served.peopleCommands.length).toBe(2);
    // The refused comparison was not asked again by itself through the remount.
    expect(previews()).toBe(asked);
    expect(served.peopleCommands[1]?.key).toBe(served.peopleCommands[0]?.key);
    expect(JSON.stringify(served.peopleCommands[1]?.body)).toBe(
      JSON.stringify(served.peopleCommands[0]?.body),
    );
    recordEvidence(info, "e-r13", {
      peopleCommands: served.peopleCommands,
      requestLog: served.requestLog,
    });
  });

  test("Decline after an uncertain Accept is refused with its copy and sends nothing", async ({
    context,
  }) => {
    const { page, served } = await setup(
      context,
      `/people/requests/${R2}`,
      [projection(MOPERSON, "Mo")],
      {
        arrange: (s) => {
          s.incoming = [mergeRequest()];
          s.recipientPreviews.set(R2, recipientPreview());
          s.peopleScript.push("abort");
        },
      },
    );
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: copy.ACCEPT, exact: true })
      .click();
    await expect(dialog).toContainText(copy.UNCERTAIN);
    await dialog.getByRole("button", { name: copy.DECLINE }).click();
    await expect(dialog).toContainText(copy.ANSWER_UNCERTAIN_FIRST);
    expect(served.peopleCommands).toHaveLength(1);
  });
});

test.describe("E-R14: an incoming read held across an actual account switch (A10; R6 of review 1)", () => {
  const OTHER = "33333333-3333-4333-8333-333333333333";
  const THEIRS = "10000000-0000-4000-8000-000000000014";
  const theirRequest = linkRequest({
    id: THEIRS,
    sender_id: STRANGER,
    proposal: { kind: "link", person_id: BEA, account_id: OTHER, name: "Zed" },
  });
  /**
   * The identity the stub answers for (`/browser-sessions/current`, `/me`, `/sessions`), and `GET /people/requests`: while `mode` is
   * "hold" every read is HELD and later answered with the first account's request; `release()` answers the held reads and from then on
   * answers the first account's reads at once ("mine": an invalidation after the release reads again, and a server answers that read
   * too); once the page has issued a request for the other account (the session trace's `request.issued`), reads are answered at once
   * with that account's own request ("theirs").
   */
  async function serveIdentity(context: BrowserContext) {
    const state = {
      identity: { account: ME, session: "s1", username: "me" },
      mode: "hold" as "hold" | "mine" | "theirs",
      held: [] as Array<() => void>,
      asked: [] as string[],
    };
    await context.route(`**${API}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.replace(API, "");
      const { account, session, username } = state.identity;
      if (path === "/browser-sessions/current")
        return route.fulfill(
          json(200, {
            account_id: account,
            session_id: session,
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            csrf_token: `csrf.${session}`,
          }),
        );
      if (path === "/me")
        return route.fulfill(
          json(200, {
            id: account,
            username,
            has_password: true,
            oidc_issuers: [],
          }),
        );
      if (path === "/sessions")
        return route.fulfill(
          json(200, {
            sessions: [
              {
                id: session,
                device_id: "dev-1",
                current: true,
                authentication: "local",
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              },
            ],
          }),
        );
      if (path === "/people/requests" && route.request().method() === "GET") {
        state.asked.push(state.mode);
        if (state.mode === "theirs")
          return route.fulfill(json(200, { items: [theirRequest] }));
        if (state.mode === "hold")
          await new Promise<void>((resolve) => state.held.push(resolve));
        return route.fulfill(json(200, { items: [linkRequest()] }));
      }
      return route.fallback();
    });
    return {
      state,
      release: () => {
        if (state.mode === "hold") state.mode = "mine";
        for (const resolve of state.held.splice(0)) resolve();
      },
    };
  }
  /** The accounts the page's session issued requests for (the production kernel's own trace). */
  const issuedFor = (page: Page) =>
    page.evaluate(() =>
      (window.__atlasFixture?.session?.trace ?? [])
        .filter((entry) => entry.event === "request.issued")
        .map((entry) => (entry.data as { account?: string }).account ?? null),
    );

  test("control: the held read, released with no switch, is shown for its own account", async ({
    context,
  }) => {
    const { page } = await setup(context, "/people", [projection(ADA, "Ada")]);
    const net = await serveIdentity(context);
    await navigateInApp(page, "/people/requests");
    await expect.poll(() => net.state.held.length).toBeGreaterThanOrEqual(1);
    await expect(incomingRow(page, R1)).toHaveCount(0);
    net.release();
    await expect(incomingRow(page, R1)).toBeVisible();
  });

  test("another tab signs in as someone else while the read is held: the new account's own read is shown; the old answer, delivered late, never is", async ({
    context,
  }) => {
    const { page } = await setup(context, "/people", [projection(ADA, "Ada")]);
    const net = await serveIdentity(context);
    await navigateInApp(page, "/people/requests");
    await expect.poll(() => net.state.held.length).toBeGreaterThanOrEqual(1);
    await expect(incomingRow(page, R1)).toHaveCount(0);
    // The first account's own input in this page's memory: Ada chosen in Ask to link (never shown or sent under another account).
    await page.locator('[data-people-action="choose-person"]').click();
    await page.locator(`[data-pick-person="${ADA}"]`).click();
    await expect(page.locator(`[data-link-person="${ADA}"]`)).toBeVisible();
    // Another tab signs in as OTHER: the production store is written and the hint posted; this page follows it.
    net.state.identity = { account: OTHER, session: "s2", username: "zed" };
    await settleElsewhere(context, settled(OTHER, "s2"));
    await expect
      .poll(async () => (await issuedFor(page)).includes(OTHER), {
        timeout: 20_000,
        message: "the page should issue requests for the new account",
      })
      .toBe(true);
    net.state.mode = "theirs";
    // The new account's own read, made for it, is shown (its page memory is its own).
    await navigateInApp(page, "/people");
    await navigateInApp(page, "/people/requests");
    await expect(incomingRow(page, THEIRS)).toBeVisible({ timeout: 20_000 });
    await expect(incomingRow(page, R1)).toHaveCount(0);
    // Nothing of the first account's page memory is shown under the next: its form starts empty.
    await expect(
      page.locator('[data-people-action="choose-person"]'),
    ).toBeVisible();
    await expect(page.locator("[data-link-person]")).toHaveCount(0);
    const heldBefore = net.state.held.length;
    expect(heldBefore).toBeGreaterThanOrEqual(1);
    net.release();
    // Long enough for a late answer to be composed and shown, were it applied (as E-T10).
    await page.waitForTimeout(1_500);
    await expect(incomingRow(page, R1)).toHaveCount(0);
    await expect(incomingRow(page, THEIRS)).toBeVisible();
    expect(net.state.held).toHaveLength(0);
    // Both accounts' reads were really issued by this page's session, the first account's before the switch.
    const issued = await issuedFor(page);
    expect(issued).toContain(ME);
    expect(issued.lastIndexOf(OTHER)).toBeGreaterThan(issued.indexOf(ME));
  });
});

test.describe("E-R17: a refused (403) comparison is not asked again by itself (N1 of revision 1)", () => {
  test("the production session's re-evaluation and remount do not ask again: once shown and settled, no POST /people/merge-preview over the window; Reload asks again, then settles", async ({
    context,
  }) => {
    const world = mergeWorld();
    const { page } = await setup(
      context,
      "/people",
      world.resources,
      world.options,
    );
    // Every comparison is refused as the released backend refuses a pair the reader owns neither of: an ordinary Atlas 403.
    const asked: number[] = [];
    await context.route(`**${API}/people/merge-preview`, (route) => {
      asked.push(Date.now());
      return route.fulfill(json(403, atlas("forbidden")));
    });
    await navigateInApp(page, COMPARE);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(copy.PREVIEW_FORBIDDEN)).toBeVisible();
    /**
     * Once the refusal is shown, reads in flight settle (an invalidation that arrives while the first read is in flight supersedes it
     * and asks once more: ordinary summaries behaviour, seen on a pool runner's Firefox), and then NOTHING is asked by itself over the
     * window. A storm never settles (before the fix: about 150 requests a second). The observation window is the requirement; nothing is
     * shortened.
     */
    const settledThenQuiet = async (what: string) => {
      await expect
        .poll(
          async () => {
            const at = asked.length;
            await page.waitForTimeout(1_000);
            return asked.length - at;
          },
          { timeout: 15_000, message: `${what}: the reads in flight settle` },
        )
        .toBe(0);
      const settled = asked.length;
      await page.waitForTimeout(3_000);
      expect(asked.length, `${what}: asked again by itself`).toBe(settled);
      return settled;
    };
    const first = await settledThenQuiet("refused");
    expect(first, "the refusal was asked").toBeGreaterThan(0);
    await expect(dialog.getByText(copy.PREVIEW_FORBIDDEN)).toBeVisible();
    await dialog.locator('[data-people-action="preview-again"]').click();
    await expect.poll(() => asked.length).toBeGreaterThan(first);
    await settledThenQuiet("after one Reload");
    // Nothing was sent.
    expect(
      (await page.evaluate(() => performance.getEntriesByType("resource")))
        .map((e) => (e as PerformanceEntry).name)
        .filter((name) => name.endsWith("/people-commands")),
    ).toEqual([]);
  });
});

/**
 * Settled, then quiet: the requests in flight settle (none for a second, within 15 s), and then NOTHING is asked over the following three
 * seconds (the observation window is the requirement; nothing is shortened). Returns how many were asked.
 */
async function settledThenQuiet(page: Page, asked: unknown[], what: string) {
  await expect
    .poll(
      async () => {
        const at = asked.length;
        await page.waitForTimeout(1_000);
        return asked.length - at;
      },
      { timeout: 15_000, message: `${what}: the reads in flight settle` },
    )
    .toBe(0);
  const settledAt = asked.length;
  await page.waitForTimeout(3_000);
  expect(asked.length, `${what}: asked again by itself`).toBe(settledAt);
  return settledAt;
}
/** A production freshness signal: the page becoming visible again invalidates every summary (`useSummaryFreshness`). */
const becomesVisible = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

test.describe("E-R18: a superseded 403 never refuses a newer comparison (R7 of review 2)", () => {
  test("the first comparison held; the page becomes visible (a newer read succeeds); the first answers 403 late: its session re-evaluation and remount do not bring the refusal back, and the next read is asked and shown", async ({
    context,
  }) => {
    const world = mergeWorld();
    const { page } = await setup(
      context,
      "/people",
      world.resources,
      world.options,
    );
    const asked: number[] = [];
    let releaseFirst: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    await context.route(`**${API}/people/merge-preview`, async (route) => {
      asked.push(Date.now());
      if (asked.length === 1) {
        await first;
        // An ordinary Atlas 403, as the released backend answers a pair the reader owns neither of.
        return route.fulfill(json(403, atlas("forbidden")));
      }
      return route.fallback();
    });
    await navigateInApp(page, COMPARE);
    const dialog = page.getByRole("dialog");
    // ADAPTATION (revision 4, as E-R20's in revision 3): a cold page's own invalidations may already have read again while the first
    // read is held (Firefox control, 4 reads before the signal); the freshness signal is sent only while the held read is the only one.
    // Either way a NEWER read (asked >= 2) answers and is shown before the first answers 403; the asserted property is unchanged.
    await expect.poll(() => asked.length).toBeGreaterThanOrEqual(1);
    if (asked.length === 1) await becomesVisible(page);
    await expect.poll(() => asked.length).toBeGreaterThanOrEqual(2);
    await expect(dialog.locator("[data-merge-comparison]")).toBeVisible();
    releaseFirst();
    const after = await settledThenQuiet(page, asked, "the late 403");
    await expect(dialog.locator("[data-merge-comparison]")).toBeVisible();
    await expect(dialog.getByText(copy.PREVIEW_FORBIDDEN)).toHaveCount(0);
    // Another freshness signal reads again (nothing remembered refuses it), and the comparison stays.
    await becomesVisible(page);
    await expect.poll(() => asked.length).toBeGreaterThan(after);
    await settledThenQuiet(page, asked, "the next read");
    await expect(dialog.locator("[data-merge-comparison]")).toBeVisible();
    await expect(dialog.getByText(copy.PREVIEW_FORBIDDEN)).toHaveCount(0);
  });
});

test.describe("E-R19: two tabs of one account (S10 of review 2's design assessment)", () => {
  test("one tab's 403 is remembered in that tab only: the other tab's comparison is read and shown; both settle; Reload asks again in its own tab", async ({
    context,
  }) => {
    const world = mergeWorld();
    const { page: refused } = await setup(
      context,
      "/people",
      world.resources,
      world.options,
    );
    const other = await bootAt(context, "/people");
    const askedRefused: number[] = [];
    const askedOther: number[] = [];
    await refused.route(`**${API}/people/merge-preview`, (route) => {
      askedRefused.push(Date.now());
      return route.fulfill(json(403, atlas("forbidden")));
    });
    await other.route(`**${API}/people/merge-preview`, (route) => {
      askedOther.push(Date.now());
      return route.fallback();
    });
    await navigateInApp(other, COMPARE);
    await expect(
      other.getByRole("dialog").locator("[data-merge-comparison]"),
    ).toBeVisible();
    await navigateInApp(refused, COMPARE);
    await expect(
      refused.getByRole("dialog").getByText(copy.PREVIEW_FORBIDDEN),
    ).toBeVisible();
    // The 403 makes the refused tab's session evaluate again, and the other tab follows the session's hint: both settle, then are quiet.
    const firstRefused = await settledThenQuiet(
      refused,
      askedRefused,
      "the refused tab",
    );
    await settledThenQuiet(other, askedOther, "the other tab");
    await expect(
      other.getByRole("dialog").locator("[data-merge-comparison]"),
    ).toBeVisible();
    await expect(
      other.getByRole("dialog").getByText(copy.PREVIEW_FORBIDDEN),
    ).toHaveCount(0);
    await expect(
      refused.getByRole("dialog").getByText(copy.PREVIEW_FORBIDDEN),
    ).toBeVisible();
    // The refused tab's Reload asks in that tab, which is refused again and settles.
    await refused
      .getByRole("dialog")
      .locator('[data-people-action="preview-again"]')
      .click();
    await expect.poll(() => askedRefused.length).toBeGreaterThan(firstRefused);
    await settledThenQuiet(refused, askedRefused, "after Reload");
    await expect(
      other.getByRole("dialog").locator("[data-merge-comparison]"),
    ).toBeVisible();
  });
});

test.describe("E-R20: a failed comparison's Try again retires every earlier answer (R7 of review 3)", () => {
  /**
   * The production form of review 3's after-retry schedule, for the sender's comparison and the recipient's review: the first read is held;
   * a freshness signal reads again and fails (an uncertain `503`), so the view offers Try again; Try again reads (uncertain again); only then
   * does the first read answer `403`. Its session re-evaluation and remount read again (uncertain), and the reads settle. The `403` was
   * dispatched BEFORE the person's explicit Try again: it is obsolete and refuses nothing. Once the server answers again, the next freshness
   * signal reads and shows the comparison. Without the retry's boundary the late `403` is the newest definite answer (every later one was
   * uncertain): it is remembered, and the next signal is refused without a request.
   */
  const variants = [
    {
      name: "the sender's comparison",
      at: "/people",
      open: COMPARE,
      pattern: `**${API}/people/merge-preview`,
      arrange: undefined as ((s: Served) => void) | undefined,
    },
    {
      name: "the recipient's review",
      at: "/people/requests",
      open: `/people/requests/${R2}`,
      pattern: `**${API}/people/requests/${R2}/merge-preview`,
      arrange: (s: Served) => {
        s.incoming = [mergeRequest()];
        s.recipientPreviews.set(R2, recipientPreview());
      },
    },
  ];
  for (const variant of variants)
    test(`${variant.name}: a 403 dispatched before Try again, answered after it, is never remembered; the next read is asked and shown`, async ({
      context,
    }) => {
      const world = mergeWorld({ arrange: variant.arrange });
      const { page } = await setup(
        context,
        variant.at,
        world.resources,
        world.options,
      );
      const asked: number[] = [];
      let releaseFirst: () => void = () => {};
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let answering = false;
      await context.route(variant.pattern, async (route) => {
        asked.push(Date.now());
        if (asked.length === 1) {
          await first;
          // An ordinary Atlas 403, as the released backend answers a comparison the reader may not have.
          return route.fulfill(json(403, atlas("forbidden")));
        }
        // Any other 5xx is uncertain: it says nothing about the refusal.
        if (!answering) return route.fulfill(json(503, atlas("unavailable")));
        return route.fallback();
      });
      await navigateInApp(page, variant.open);
      const dialog = page.getByRole("dialog");
      await expect.poll(() => asked.length).toBeGreaterThanOrEqual(1);
      // A freshness signal reads again while the first read is held (a cold page's own first invalidations may have done so already).
      if (asked.length === 1) await becomesVisible(page);
      await expect(dialog.getByText(copy.PREVIEW_FAILED)).toBeVisible();
      const failed = await settledThenQuiet(page, asked, "the failed read");
      expect(
        failed,
        "the held read and at least one failed one",
      ).toBeGreaterThanOrEqual(2);
      await dialog.getByRole("button", { name: copy.TRY_AGAIN }).click();
      await expect.poll(() => asked.length).toBeGreaterThan(failed);
      const retried = await settledThenQuiet(page, asked, "Try again");
      expect(retried, "Try again asked once").toBe(failed + 1);
      await expect(dialog.getByText(copy.PREVIEW_FAILED)).toBeVisible();
      releaseFirst();
      const late = await settledThenQuiet(page, asked, "the late 403");
      await expect(dialog.getByText(copy.PREVIEW_FORBIDDEN)).toHaveCount(0);
      answering = true;
      await becomesVisible(page);
      await expect
        .poll(() => asked.length, {
          message:
            "the next freshness signal is asked (nothing remembered refuses it)",
        })
        .toBeGreaterThan(late);
      await settledThenQuiet(page, asked, "the next read");
      await expect(dialog.locator("[data-merge-comparison]")).toBeVisible();
      await expect(dialog.getByText(copy.PREVIEW_FORBIDDEN)).toHaveCount(0);
      // Nothing was sent.
      expect(
        (await page.evaluate(() => performance.getEntriesByType("resource")))
          .map((e) => (e as PerformanceEntry).name)
          .filter((name) => name.endsWith("/people-commands")),
      ).toEqual([]);
    });
});

test.describe("E-R21: a sender's success consumes only the name choice its attempt captured (R1 of review 4)", () => {
  /** A cross-owner pair: the sender asks mo to merge (request_merge), so a success closes only the dialog that is still shown. */
  const asking = (s: Served) => {
    s.mergePreviews.set(`${MOHAMMED}:${MOPERSON}`, {
      token: T1,
      requires_approval: true,
    });
    s.summaries.set(MOHAMMED, {
      your_access: "view",
      added_by_you: "no",
      owner: { account_id: MO, username: "mo", you: false, person: null },
      audience: {
        disclosure: "partial",
        in_home: false,
        households: [],
        your_direct_grant: { can_edit: false },
        direct_grant_count: null,
        excluded_count: null,
      },
    });
  };
  const RECEIPT = { revision: 50, person_id: MOPERSON };
  const ENTRIES = [
    { name: "the duplicates' Compare & merge", path: COMPARE },
    {
      name: "Requests' Compare",
      path: `/people/requests/merge/${MOHAMMED}/${MOPERSON}`,
    },
  ];
  const OUTCOMES = [
    {
      name: "success",
      answer: (after: Promise<void>) => ({ status: 200, body: RECEIPT, after }),
      said: null as string | null,
    },
    {
      name: "refused (409)",
      answer: (after: Promise<void>) => ({
        status: 409,
        body: atlas("conflict"),
        after,
      }),
      said: copy.COMPARISON_CHANGED as string | null,
    },
  ];
  const polite = (page: Page) =>
    page.locator('[role="status"][aria-live="polite"]');
  const newerChoice = (page: Page) =>
    page.getByRole("dialog").getByRole("radio", { name: "Mohammed A." });
  const previews = (served: Served) =>
    served.requestLog.filter((line) => line === "POST /people/merge-preview")
      .length;
  /** Leaves the comparison for Requests (no dialog) and opens it again: a new mount over the same page memory. */
  async function reopen(page: Page, path: string) {
    await navigateInApp(page, "/people/requests");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await navigateInApp(page, path);
    await expect(
      page.getByRole("dialog").locator("[data-merge-comparison]"),
    ).toBeVisible();
  }

  for (const entry of ENTRIES)
    for (const outcome of OUTCOMES)
      test(`reopened through ${entry.name} and changed while the request is held: the earlier ${outcome.name} keeps the newer visible choice`, async ({
        context,
      }, info) => {
        const world = mergeWorld({ arrange: asking });
        const { page, served } = await setup(
          context,
          "/people",
          world.resources,
          world.options,
        );
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        served.peopleScript.push(outcome.answer(gate));
        await navigateInApp(page, entry.path);
        const ask = page
          .getByRole("dialog")
          .getByRole("button", { name: copy.ASK_TO_MERGE_WITH("mo") });
        await expect(ask).toBeEnabled();
        await ask.click();
        await expect.poll(() => served.peopleCommands.length).toBe(1);
        expect(commandAt(served, 0)).toMatchObject({
          kind: "request_merge",
          name: "Mo",
        });
        await reopen(page, entry.path);
        await expect(newerChoice(page)).not.toBeChecked();
        await newerChoice(page).click();
        await expect(newerChoice(page)).toBeChecked();
        const before = previews(served);
        release();
        // The earlier attempt's completion was observed: its announcement, or what the dialog now says.
        if (outcome.said === null)
          await expect(polite(page)).toContainText(copy.MERGE_REQUESTED("mo"));
        else await expect(page.getByRole("dialog")).toContainText(outcome.said);
        await expect(page).toHaveURL(new RegExp(`${entry.path}$`));
        await expect(
          newerChoice(page),
          `the earlier ${outcome.name} must not change the reopened dialog's newer choice`,
        ).toBeChecked();
        // ... nor does the comparison read again after it.
        await expect.poll(() => previews(served)).toBeGreaterThan(before);
        await expect(
          page.getByRole("dialog").locator("[data-merge-comparison]"),
        ).toBeVisible();
        await expect(newerChoice(page)).toBeChecked();
        expect(served.peopleCommands).toHaveLength(1);
        recordEvidence(info, "e-r21-reopened", {
          entry: entry.path,
          outcome: outcome.name,
          peopleCommands: served.peopleCommands,
          requestLog: served.requestLog,
        });
      });

  test("an uncertain merge, a newer choice, then Try again: the same key and byte-identical body, the original name said, the newer choice kept", async ({
    context,
  }, info) => {
    const world = mergeWorld({ arrange: (s) => s.peopleScript.push("abort") });
    const { page, served } = await setup(
      context,
      COMPARE,
      world.resources,
      world.options,
    );
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: copy.MERGE_THEM }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: copy.MERGE_THEM }).click();
    await expect(dialog).toContainText(copy.UNCERTAIN);
    await newerChoice(page).click();
    await expect(newerChoice(page)).toBeChecked();
    const again = dialog.getByRole("button", { name: copy.TRY_AGAIN });
    await expect(again).toBeEnabled();
    await again.click();
    await expect.poll(() => served.peopleCommands.length).toBe(2);
    expect(served.peopleCommands[1]?.key).toBe(served.peopleCommands[0]?.key);
    expect(JSON.stringify(served.peopleCommands[1]?.body)).toBe(
      JSON.stringify(served.peopleCommands[0]?.body),
    );
    expect(commandAt(served, 0)).toMatchObject({ kind: "merge", name: "Mo" });
    await expect(page).toHaveURL(new RegExp(`/people/${MOPERSON}$`));
    await expect(polite(page)).toContainText(copy.MERGED_INTO("Mo"));
    await expect(polite(page)).not.toContainText(
      copy.MERGED_INTO("Mohammed A."),
    );
    await navigateInApp(page, COMPARE);
    await expect(
      page.getByRole("dialog").locator("[data-merge-comparison]"),
    ).toBeVisible();
    await expect(
      newerChoice(page),
      "the replayed success must not consume the choice made after the original capture",
    ).toBeChecked();
    recordEvidence(info, "e-r21-replay", {
      peopleCommands: served.peopleCommands,
      requestLog: served.requestLog,
    });
  });

  test("two tabs of one account: the first tab's held success keeps the second tab's own choice, and the first tab's newer one", async ({
    context,
  }) => {
    const world = mergeWorld({ arrange: asking });
    const { page: first, served } = await setup(
      context,
      "/people",
      world.resources,
      world.options,
    );
    const second = await bootAt(context, "/people");
    // The other tab has its own page memory: its comparison of the same pair is shown first (as E-R19 opens its tabs).
    await navigateInApp(second, COMPARE);
    await expect(
      second.getByRole("dialog").locator("[data-merge-comparison]"),
    ).toBeVisible();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    served.peopleScript.push({ status: 200, body: RECEIPT, after: gate });
    await navigateInApp(first, COMPARE);
    const ask = first
      .getByRole("dialog")
      .getByRole("button", { name: copy.ASK_TO_MERGE_WITH("mo") });
    await expect(ask).toBeEnabled();
    await ask.click();
    await expect.poll(() => served.peopleCommands.length).toBe(1);
    // While the first tab's request is held, the other tab makes its own choice for the same pair.
    await newerChoice(second).click();
    await expect(newerChoice(second)).toBeChecked();
    // ... and a newer choice in the first tab, after its capture.
    await reopen(first, COMPARE);
    await newerChoice(first).click();
    await expect(newerChoice(first)).toBeChecked();
    release();
    await expect(polite(first)).toContainText(copy.MERGE_REQUESTED("mo"));
    await expect(first).toHaveURL(new RegExp(`${COMPARE}$`));
    await expect(newerChoice(first)).toBeChecked();
    await expect(newerChoice(second)).toBeChecked();
    // Only the first tab sent; the second tab's choice was never sent or consumed.
    expect(served.peopleCommands).toHaveLength(1);
  });
});

test.describe("E-R15: viewports, themes and axe (A12; browser emulation, not devices)", () => {
  for (const [name, width, height] of [
    ["phone", 390, 844],
    ["tablet portrait", 834, 1112],
    ["tablet landscape", 1180, 820],
    ["desktop", 1440, 900],
  ] as const)
    test(`${name} ${width}×${height}: Requests, both forms and both dialogs fit, axe clean, the dialog a sheet with its footer visible below 768 px`, async ({
      context,
    }) => {
      const world = mergeWorld({
        arrange: (s) => {
          s.incoming = [linkRequest(), mergeRequest()];
          s.sent = [sentRequest(R3, "pending")];
          s.recipientPreviews.set(R2, recipientPreview());
        },
      });
      const { page } = await setup(
        context,
        "/people/requests",
        world.resources,
        world.options,
      );
      await page.setViewportSize({ width, height });
      for (const scheme of ["dark", "light"] as const) {
        // Reduced motion: axe samples colours with no transition running after the scheme changes (as fixture.appearance does).
        await page.emulateMedia({
          colorScheme: scheme,
          reducedMotion: "reduce",
        });
        await navigateInApp(page, "/people/requests");
        await expect(page.locator("[data-requests-page]")).toBeVisible();
        await expect(
          page.locator("[data-incoming-request]").first(),
        ).toBeVisible();
        const fits = () =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          );
        expect(await fits(), `${name} ${scheme}: Requests`).toBe(true);
        expect(await axeOf(page), `${name} ${scheme}: Requests axe`).toEqual(
          [],
        );
        if (width < 1280) {
          await page.getByRole("tab", { name: copy.SENT }).click();
          await expect(page.locator("[data-sent-request]")).toBeVisible();
          await page.getByRole("tab", { name: /For you/ }).click();
          await page.getByRole("button", { name: copy.NEW_REQUEST }).click();
          const sheet = page.getByRole("dialog", { name: copy.NEW_REQUEST });
          await expect(sheet.locator("[data-new-request]")).toBeVisible();
          expect(
            await axeOf(page),
            `${name} ${scheme}: New request axe`,
          ).toEqual([]);
          await page.keyboard.press("Escape");
          await expect(sheet).toBeHidden();
        }
        for (const [path, label] of [
          [COMPARE, "sender"],
          [`/people/requests/${R2}`, "recipient"],
        ] as const) {
          await navigateInApp(page, path);
          const dialog = page.locator(`[data-merge-dialog="${label}"]`);
          await expect(dialog.locator("[data-merge-comparison]")).toBeVisible();
          expect(await fits(), `${name} ${scheme}: ${label}`).toBe(true);
          expect(await axeOf(page), `${name} ${scheme}: ${label} axe`).toEqual(
            [],
          );
          const panel = page.getByRole("dialog");
          if (width < 768) {
            await expect
              .poll(async () =>
                Math.round((await panel.boundingBox())?.width ?? 0),
              )
              .toBe(width);
            const footer = await panel.locator("button").last().boundingBox();
            expect(
              footer !== null && footer.y + footer.height <= height + 1,
              `${name}: footer visible`,
            ).toBe(true);
          }
          await page.keyboard.press("Escape");
          await expect(panel).toBeHidden();
        }
      }
    });
});

test.describe("E-R15b: the comparison with long supported values (A12; R5 of review 1)", () => {
  // A valid text value of 500 characters with no break opportunity, and a long unbroken field label: both must wrap INSIDE their
  // columns, so the comparison stays side by side within the dialog body (the document-width check of E-R15 cannot see this).
  const LONG = "x".repeat(500);
  const LABEL = `Label${"y".repeat(95)}`;
  for (const [name, width, height] of [
    ["phone", 390, 844],
    ["tablet portrait", 834, 1112],
    ["tablet landscape", 1180, 820],
    ["desktop", 1440, 900],
  ] as const)
    test(`${name} ${width}×${height}: the comparison stays within the dialog body, each cell holds its content, the whole value is reachable`, async ({
      context,
    }) => {
      const { page } = await setup(
        context,
        COMPARE,
        [
          projection(MOHAMMED, "Mohammed A."),
          projection(MOPERSON, "Mo"),
          fieldP(
            PHONE_S,
            MOHAMMED,
            LABEL,
            { kind: "text", text: LONG },
            { version: 2 },
          ),
        ],
        {
          arrange: (s) => {
            s.mergePreviews.set(`${MOHAMMED}:${MOPERSON}`, {
              token: T1,
              fields: [
                { id: PHONE_S, parent_id: MOHAMMED, label: LABEL, version: 2 },
              ],
            });
          },
        },
      );
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const dialog = page.locator('[data-merge-dialog="sender"]');
      const table = dialog.locator("[data-merge-comparison]");
      await expect(table).toContainText(LONG);
      const geometry = () =>
        table.evaluate((element) => {
          const body = element.closest(".overflow-y-auto") as HTMLElement;
          const box = element.getBoundingClientRect();
          const columns = [...element.querySelectorAll("thead th")].map(
            (th) => th.getBoundingClientRect().width,
          );
          const spilling = [...element.querySelectorAll("th, td")]
            .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
            .map((cell) => (cell.textContent ?? "").slice(0, 30));
          return {
            table: box.width,
            body: body.clientWidth,
            bodyScroll: body.scrollWidth,
            columns,
            spilling,
          };
        });
      for (const stage of ["clamped", "expanded"] as const) {
        if (stage === "expanded")
          await table.getByRole("button", { name: /show more/i }).click();
        const g = await geometry();
        const said = `${name} ${stage}: ${JSON.stringify(g)}`;
        expect(g.table, said).toBeLessThanOrEqual(g.body + 0.5);
        expect(g.bodyScroll, said).toBeLessThanOrEqual(g.body);
        expect(g.spilling, said).toEqual([]);
        // Side by side: the field and both people keep a readable column.
        expect(g.columns.length, said).toBe(3);
        for (const column of g.columns)
          expect(column, said).toBeGreaterThan(g.body * 0.2);
      }
      expect(await axeOf(page), `${name}: axe`).toEqual([]);
    });
});

test.describe("E-R16: keyboard only (A12)", () => {
  test("tabs by arrow keys; the merge dialog's focus reaches the consequence before the action and returns to its link on Escape", async ({
    context,
  }) => {
    const world = mergeWorld({
      arrange: (s) => {
        s.incoming = [linkRequest()];
        s.sent = [sentRequest(R3, "declined")];
        s.duplicates.push({
          items: [projection(MOHAMMED, "Mohammed A.")],
          next_after: null,
        });
      },
    });
    const { page } = await setup(
      context,
      "/people/requests",
      world.resources,
      world.options,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const forYou = page.getByRole("tab", { name: /For you/ });
    await forYou.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: copy.SENT })).toBeFocused();
    await expect(page.getByRole("tab", { name: copy.SENT })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("[data-sent-request]")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(forYou).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 900 });
    await navigateInApp(page, `/people/${MOPERSON}/duplicates`);
    const link = page.getByRole("link", { name: copy.COMPARE_AND_MERGE });
    await link.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: copy.MERGE_THEM }),
    ).toBeEnabled();
    // Tab through the dialog: the merge action is reached, and the consequence section (with the conflict note) precedes it.
    let reached = false;
    for (let i = 0; i < 20 && !reached; i += 1) {
      await pressTab(page);
      reached = await page.evaluate(
        () =>
          document.activeElement?.getAttribute("data-people-action") ===
          "confirm-merge",
      );
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/people/${MOPERSON}/duplicates$`));
  });
});
