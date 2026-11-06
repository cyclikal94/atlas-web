import { expect, type Locator, type Page, test } from "@playwright/test";
import { contrastRatio } from "../../src/design/contrast";
import * as base from "../../src/features/sharing/copy";
import * as copy from "../../src/features/sharing/households/copy";
import { recordEvidence } from "./data-evidence";
import { settleElsewhere } from "./data-leader-helpers";
import { settled } from "./data-sync-helpers";
import { pressTab, runAxe } from "./helpers";
import {
  API,
  atlas,
  connectivity,
  FLAT,
  HOME,
  homeHousehold,
  json,
  ME,
  navigateInApp,
  PRIYA,
  reopen,
  SAM,
  sentId,
  setupHouseholds,
  signupId,
} from "./households-helpers";
import { recordPaintedContrast, surfaceScreenshot } from "./surface-checks";

/**
 * WEB-12b in Chromium, Firefox and WebKit (plan §8.3): the PRODUCTION session and protected tree (`/__session`), real IndexedDB, and the
 * household endpoints stubbed by `page.route` (`households-helpers.ts`, an emulation of the released rules). FIXTURE evidence: there is
 * no backend; the I-SH cases run against the released one.
 *
 * E-HH1 layout at five viewports; E-HH2 empty, offline-never-synced and offline-last-read; E-HH3 roles, the member view, the last manager,
 * capacity, removed elsewhere; E-HH4 a lost role: the 403 remount reopens the dialog with its problem, one command, no read loop; E-HH5 an
 * uncertain rename retried with the same key and body, never sent offline; E-HH6 For you, a stale row, Sent by you, revoke; E-HH7 signup
 * links (fragment, clipboard, nothing in the URL or storage, a remount keeps the link until Done, the cap, a lost issuance, 390 px);
 * E-HH8 a keyboard-only journey; E-HH9 the directory's browse mode enabled and disabled; E-HH10 an account switch; E-HH12 (revision 1) a
 * failed list read and a failed sent walk at 390 px drawn as failures with Try again; E-HH11 painted
 * contrast and screenshots in both themes.
 */
const detail = (page: Page) => page.locator("[data-household-detail]");
const memberRow = (page: Page, id: string) =>
  page.locator(`[data-member="${id}"]`);
const dialogNamed = (page: Page, name: string) =>
  page.getByRole("dialog", { name });

test.describe("E-HH1: layout at 390, 834, 1112, 1280 and 1440 (A1, A11)", () => {
  for (const [width, height] of [
    [390, 844],
    [834, 1112],
    [1112, 834],
    [1280, 800],
    [1440, 900],
  ] as const)
    test(`${width}×${height}: two panes from 1280 px, push navigation below; the invitations dialog full-bleed below 1280 px and centred 440 px from it; no overflow, 44 px targets (browser emulation, not a device)`, async ({
      context,
    }, info) => {
      const { page } = await setupHouseholds(context, "/sharing");
      await page.setViewportSize({ width, height });
      await expect(page.locator("[data-households-pane]")).toBeVisible();
      if (width >= 1280)
        await expect(detail(page)).toHaveAttribute(
          "data-household-detail",
          HOME,
        );
      else await expect(detail(page)).toHaveCount(0);
      await navigateInApp(page, `/sharing/households/${HOME}`);
      await expect(detail(page)).toBeVisible();
      if (width < 1280) {
        await expect(
          page.getByRole("link", { name: copy.BACK_TO_HOUSEHOLDS }),
        ).toBeVisible();
        await expect(page.locator("[data-households-pane]")).toHaveCount(0);
      }
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const small = await detail(page)
        .locator("a, button")
        .evaluateAll((els) =>
          els
            .map((e) => ({
              text: e.textContent,
              h: e.getBoundingClientRect().height,
            }))
            .filter((e) => e.h > 0 && e.h < 44),
        );
      expect(small).toEqual([]);
      await navigateInApp(page, `/sharing/households/${HOME}/invitations`);
      const dialog = dialogNamed(page, copy.INVITATIONS_TITLE_FOR("Home"));
      await expect(dialog.locator("[data-invitations-dialog]")).toBeVisible();
      const box = await dialog.boundingBox();
      if (width < 1280) {
        expect(Math.round(box?.x ?? -1)).toBe(0);
        expect(Math.round(box?.width ?? 0)).toBe(width);
        expect(Math.round(box?.height ?? 0)).toBe(height);
      } else {
        expect(Math.round(box?.width ?? 0)).toBe(440);
        expect(Math.round((box?.x ?? 0) + (box?.width ?? 0) / 2)).toBe(
          Math.round(width / 2),
        );
      }
      const dialogSmall = await dialog
        .locator("button, a, input")
        .evaluateAll((els) =>
          els
            .filter((e) => (e as HTMLElement).offsetParent !== null)
            .map((e) => ({
              text: e.textContent,
              h: e.getBoundingClientRect().height,
            }))
            .filter((e) => e.h < 44),
        );
      expect(dialogSmall).toEqual([]);
      const violations = await runAxe(page);
      expect(violations, JSON.stringify(violations, null, 1)).toEqual([]);
      recordEvidence(info, `e-hh1-${width}`, {
        viewport: { width, height },
        box,
        overflow,
      });
    });
});

test.describe("E-HH2: empty, offline never synced, offline last read (A1; DA-M2)", () => {
  test("a checked empty list says 'not in a household' and Invitations is reachable; offline before any read says 'hasn't synced' with Invitations disabled; offline after a read shows that read's time", async ({
    context,
  }) => {
    const { page, served } = await setupHouseholds(context, "/sharing", (s) => {
      s.households = [];
      s.primary = null;
      s.forMe = [
        {
          id: sentId(1),
          household_id: FLAT,
          household_name: "Flat",
          sender_id: SAM,
          status: "pending",
          expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          version: 1,
        },
      ];
    });
    await expect(page.getByText(copy.EMPTY, { exact: true })).toBeVisible();
    await page.getByRole("link", { name: copy.INVITATIONS_ACTION(1) }).click();
    const dialog = dialogNamed(page, copy.INVITATIONS_TITLE);
    await dialog.getByRole("button", { name: `${copy.ACCEPT}: Flat` }).click();
    await expect.poll(() => served.management.length).toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-household]")).toHaveCount(1);
    await connectivity(context, page, false);
    await expect(
      page.locator('[data-households-from="complete"]'),
    ).toContainText("You're offline. Your households as last read");
    await expect(
      page.getByRole("button", { name: /Invitations/ }),
    ).toBeDisabled();
    await connectivity(context, page, true);
  });

  test("offline at first load with no snapshot: 'this device hasn't synced yet', never 'not in a household'", async ({
    context,
  }) => {
    // The household chunk is loaded online (the fixture preview has no service worker to serve it offline), and neither the complete
    // list nor the B5 snapshot answers before the connection is lost: nothing about the households is known on this device.
    const { page, served } = await setupHouseholds(context, "/sharing", (s) => {
      s.held.add("households");
      s.held.add("snapshot");
    });
    await expect(page.locator("[data-households-pane]")).toBeVisible();
    await connectivity(context, page, false);
    await expect(page.getByText(copy.OFFLINE_NEVER)).toBeVisible();
    await expect(page.getByText(copy.EMPTY, { exact: true })).toHaveCount(0);
    expect(served.reads.households ?? 0).toBeGreaterThanOrEqual(1);
    await connectivity(context, page, true);
  });
});

test.describe("E-HH3: roles, the member view, the last manager, capacity, removed elsewhere (A1, A2)", () => {
  test("the last manager's Leave and own demotion are unavailable with the reason; promoting sam makes them available; a member sees no manager action; 32 households disable New household; a household removed elsewhere says so", async ({
    context,
  }) => {
    const { page, served } = await setupHouseholds(
      context,
      `/sharing/households/${HOME}`,
    );
    const leave = memberRow(page, ME).getByRole("button", {
      name: `${copy.LEAVE}: Home`,
    });
    await expect(leave).toBeDisabled();
    await expect(
      page.getByText(copy.LAST_MANAGER("Home")).first(),
    ).toBeVisible();
    await memberRow(page, SAM)
      .getByRole("button", { name: `${copy.PROMOTE}: sam` })
      .click();
    await expect(memberRow(page, SAM)).toContainText(copy.ROLE.manager);
    await expect(
      memberRow(page, ME).getByRole("button", { name: `${copy.LEAVE}: Home` }),
    ).toBeEnabled();
    expect(served.management.at(-1)?.body).toEqual({
      commands: [
        {
          kind: "set_household_role",
          household_id: HOME,
          account_id: SAM,
          expected_version: 2,
          manager: true,
        },
      ],
    });
    // Elsewhere, sam makes me a member: the next read shows the member view.
    const home = served.households[0];
    if (home)
      home.members = home.members.map((m) =>
        m.account_id === ME ? { ...m, role: "member" } : m,
      );
    await reopen(page, `/sharing/households/${HOME}`);
    await expect(memberRow(page, ME)).toContainText(copy.ROLE.member);
    await expect(
      detail(page).getByText(copy.MEMBERS_CANT_MANAGE),
    ).toBeVisible();
    await expect(
      detail(page).getByRole("link", { name: copy.RENAME }),
    ).toHaveCount(0);
    // Removed elsewhere.
    served.households = [];
    await reopen(page, `/sharing/households/${HOME}`);
    await expect(page.getByText(copy.NOT_IN_IT)).toBeVisible();
    // 32 households.
    served.households = Array.from({ length: 32 }, (_, n) =>
      homeHousehold({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`,
        name: `H${n}`,
      }),
    );
    await navigateInApp(page, "/sharing/new");
    await expect(page.getByText(copy.CAPACITY(32))).toBeVisible();
    await page.getByLabel(copy.NAME_LABEL).fill("Another");
    await expect(
      page.getByRole("button", { name: copy.CREATE }),
    ).toBeDisabled();
    await expect(page.getByText(copy.AT_CAPACITY)).toBeVisible();
  });
});

test.describe("E-HH4: a lost role, a 403 and the remount (A6)", () => {
  test("a rename refused 403 (role lost elsewhere): the session's remount reopens the dialog with its typed name and the problem; exactly one command; the list is read again and nothing is read in a loop", async ({
    context,
  }, info) => {
    const { page, served } = await setupHouseholds(
      context,
      `/sharing/households/${HOME}/rename`,
    );
    const dialog = dialogNamed(page, copy.RENAME_TITLE("Home"));
    await dialog.getByLabel(copy.NAME_LABEL).fill("Our place");
    // Elsewhere sam took over: the server now refuses this account's manager commands.
    const home = served.households[0];
    if (home)
      home.members = [
        { account_id: SAM, username: "sam", role: "manager" },
        { account_id: ME, username: "me", role: "member" },
      ];
    await dialog.getByRole("button", { name: copy.SAVE_NAME }).click();
    const reopened = dialogNamed(page, copy.RENAME_TITLE("Home"));
    await expect(reopened.getByText(copy.FORBIDDEN)).toBeVisible();
    expect(served.management).toHaveLength(1);
    // After the remount the list says member: the rename is read-only now, its typed name kept in page memory.
    await expect(reopened.getByText(copy.LOST_MANAGER)).toBeVisible();
    const settledReads = { ...served.reads };
    // An observation window: a remount loop would keep reading (the requirement is that nothing is read by itself).
    await page.waitForTimeout(2_000);
    expect(served.reads.households ?? 0).toBeLessThanOrEqual(
      (settledReads.households ?? 0) + 1,
    );
    expect(served.management).toHaveLength(1);
    recordEvidence(info, "e-hh4", {
      reads: served.reads,
      management: served.management.length,
    });
  });
});

test.describe("E-HH5: an uncertain rename (R8, one attempt per body)", () => {
  test("the rename's response is lost: offline Try again is disabled and nothing is sent; back online Try again sends the SAME key and body; its receipt closes the attempt and completes the rename (the dialog closes on the household)", async ({
    context,
  }) => {
    const { page, served } = await setupHouseholds(
      context,
      `/sharing/households/${HOME}/rename`,
    );
    await expect(dialogNamed(page, copy.RENAME_TITLE("Home"))).toBeVisible();
    // The only dialog, not found by its title: the lost rename DID commit, so a list read after it (the reconnection's) retitles the
    // dialog "Rename Our place" (pool run 2026-11-06T06-23-31.063Z-4cfdf022, m4-air Chromium, lost the locator that way).
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(copy.NAME_LABEL).fill("Our place");
    served.managementScript.push("abort");
    await dialog.getByRole("button", { name: copy.SAVE_NAME }).click();
    const retry = dialog
      .locator("[data-households-unresolved]")
      .getByRole("button", { name: base.TRY_AGAIN, exact: true });
    await expect(retry).toBeVisible();
    expect(served.management).toHaveLength(1);
    const original = structuredClone(served.management[0]);
    await connectivity(context, page, false);
    await expect(retry).toBeDisabled();
    await retry.click({ force: true });
    await connectivity(context, page, true);
    expect(served.management).toHaveLength(1);
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect.poll(() => served.management.length).toBe(2);
    expect(served.management[1]).toEqual(original);
    await expect(page.locator("[data-households-unresolved]")).toHaveCount(0);
    expect(served.households[0]?.name).toBe("Our place");
    // ADAPTATION (review 1 F-R1-2; the old assertion's intent kept): until revision 1 this case asserted that the retried rename left
    // its dialog OPEN, retitled from the list read after it ("Rename Our place"), which pinned a Try again that did not complete the
    // form. The intent, that the committed rename is what the page shows, is now asserted on the household's own route: a Try again
    // that is answered closes the dialog as a first-try success does, and the detail is titled with the new name.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/sharing/households/${HOME}`);
    await expect(
      detail(page).getByRole("heading", { level: 2, name: "Our place" }),
    ).toBeVisible();
  });
});

test.describe("E-HH12: a failed read at 390 px is a failure with its request id and Try again (A1 Er; review 1 F-R1-1)", () => {
  test("the detail alone: a failed GET /households says so with its request id and Try again (never 'Loading'), and Try again reads it and shows the household; a failed sent walk says so in 'Invited by you, waiting' with its own Try again", async ({
    context,
  }, info) => {
    const { page, served } = await setupHouseholds(
      context,
      `/sharing/households/${HOME}`,
      (s) => {
        s.failing.set("households", {
          status: 503,
          requestId: "abcd1234-0000-4000-8000-000000000000",
        });
        s.failing.set("sent", {
          status: 503,
          requestId: "feedface-0000-4000-8000-000000000000",
        });
      },
    );
    await page.setViewportSize({ width: 390, height: 844 });
    // The narrow layout applied: no pane, the push navigation's back link.
    await expect(
      page.getByRole("link", { name: copy.BACK_TO_HOUSEHOLDS }),
    ).toBeVisible();
    await expect(page.locator("[data-households-pane]")).toHaveCount(0);
    const list = detail(page).locator(
      '[data-households-read-failed="households"]',
    );
    await expect(list).toContainText(copy.FAILED);
    await expect(list).toContainText("abcd1234");
    await expect(page.getByText(copy.LOADING)).toHaveCount(0);
    const before = served.reads.households ?? 0;
    served.failing.delete("households");
    await list.getByRole("button", { name: base.TRY_AGAIN }).click();
    // The complete list landed: the manager's actions, which B5's read-only view of this household (shown meanwhile) never draws.
    await expect(
      detail(page).getByRole("link", { name: copy.RENAME }),
    ).toBeVisible();
    expect(served.reads.households ?? 0).toBeGreaterThan(before);
    await expect(list).toHaveCount(0);
    const sent = detail(page).locator(
      '[data-household-waiting] [data-households-read-failed="sent"]',
    );
    await expect(sent).toContainText(copy.SENT_FAILED);
    await expect(sent).toContainText("feedface");
    served.failing.delete("sent");
    await sent.getByRole("button", { name: base.TRY_AGAIN }).click();
    await expect(
      detail(page)
        .locator("[data-household-waiting]")
        .getByText(copy.WAITING_NONE),
    ).toBeVisible();
    recordEvidence(info, "e-hh12", { reads: served.reads });
  });
});

test.describe("E-HH6: For you, a stale row, Sent by you (A3; Q16)", () => {
  test("accept and decline; a row answered elsewhere is a row-time error with its request id; Sent by you lists every status verbatim and revokes a waiting one", async ({
    context,
  }) => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const { page, served } = await setupHouseholds(
      context,
      `/sharing/households/${HOME}/invitations`,
      (s) => {
        s.forMe = [
          {
            id: sentId(90),
            household_id: FLAT,
            household_name: "Flat",
            sender_id: SAM,
            status: "pending",
            expires_at: soon,
            version: 1,
          },
        ];
        s.sent = (
          ["pending", "accepted", "declined", "revoked", "expired"] as const
        ).map((status, n) => ({
          id: sentId(n + 1),
          household_id: HOME,
          household_name: "Home",
          sender_id: ME,
          recipient_id: PRIYA,
          recipient_username: `person${n}`,
          status,
          expires_at: soon,
          version: 1,
        }));
      },
    );
    const dialog = dialogNamed(page, copy.INVITATIONS_TITLE_FOR("Home"));
    await expect(dialog.locator("[data-sent]")).toHaveCount(5);
    const statuses = await dialog
      .locator("[data-sent]")
      .evaluateAll((rows) =>
        rows.map((r) => r.getAttribute("data-sent-status")),
      );
    expect(statuses).toEqual([
      "pending",
      "accepted",
      "declined",
      "revoked",
      "expired",
    ]);
    await expect(dialog.locator(`[data-sent="${sentId(2)}"]`)).toContainText(
      copy.STATUS.accepted,
    );
    await expect(dialog.locator(`[data-sent="${sentId(5)}"]`)).toContainText(
      copy.STATUS.expired,
    );
    await dialog
      .getByRole("button", { name: `${copy.REVOKE}: person0` })
      .click();
    await expect(dialog.locator(`[data-sent="${sentId(1)}"]`)).toContainText(
      copy.STATUS.revoked,
    );
    // The invitation for me was answered elsewhere meanwhile.
    served.forMe = [];
    await dialog.getByRole("button", { name: `${copy.ACCEPT}: Flat` }).click();
    await expect(dialog.getByText(copy.NOT_FOUND)).toBeVisible();
    await expect(dialog.getByText(/Request ID: 61af3d02/)).toBeVisible();
    await expect(dialog.getByText(copy.FOR_YOU_NONE)).toBeVisible();
  });
});

test.describe("E-HH7: signup links (A5; Q21 group 2, R7, SHARE-7)", () => {
  test("New invitation shows /join#t=<token>; Copy writes it; the token is never in the URL, history, storage or a request; a remount keeps it until Done; at the cap New invitation waits; a lost issuance is flagged after ONE POST; 390 px rows are stacked", async ({
    context,
  }, info) => {
    await context.addInitScript(() => {
      const copied: string[] = [];
      (window as unknown as { __copied: string[] }).__copied = copied;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => void copied.push(text) },
      });
    });
    const { page, served } = await setupHouseholds(
      context,
      `/sharing/households/${HOME}/signup`,
      (s) => {
        s.signup = [
          {
            id: signupId(100),
            household_id: HOME,
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
        ];
      },
    );
    const dialog = dialogNamed(page, copy.SIGNUP_TITLE("Home"));
    await dialog.getByRole("button", { name: copy.SIGNUP_NEW }).click();
    const field = dialog.getByLabel(copy.SIGNUP_LINK_LABEL);
    const token = (1).toString(16).padStart(64, "9");
    await expect(field).toHaveValue(new RegExp(`/join#t=${token}$`));
    await dialog.getByRole("button", { name: copy.SIGNUP_COPY }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __copied: string[] }).__copied,
        ),
      )
      .toEqual([await field.inputValue()]);
    expect(page.url()).not.toContain(token);
    expect(await page.evaluate(() => history.length)).toBeGreaterThan(0);
    const stored = await page.evaluate(
      () =>
        JSON.stringify({ ...localStorage }) +
        JSON.stringify({ ...sessionStorage }),
    );
    expect(stored).not.toContain(token);
    expect(served.urls.some((u) => u.includes(token))).toBe(false);
    // A remount (a 403 elsewhere on the page: revoking another manager's invitation refused) keeps the link until Done.
    served.revokeScript.push({ status: 403, body: atlas("forbidden") });
    await dialog
      .getByRole("button", {
        name: copy.SIGNUP_REVOKE(copy.SIGNUP_ID(signupId(100))),
      })
      .click();
    const again = dialogNamed(page, copy.SIGNUP_TITLE("Home"));
    await expect(again.getByLabel(copy.SIGNUP_LINK_LABEL)).toHaveValue(
      new RegExp(token),
    );
    await again.getByRole("button", { name: copy.SIGNUP_DONE }).click();
    await expect(again.getByLabel(copy.SIGNUP_LINK_LABEL)).toHaveCount(0);
    // At the cap.
    served.issueScript.push({ status: 429, body: atlas("rate_limited") });
    await again.getByRole("button", { name: copy.SIGNUP_NEW }).click();
    await expect(again.getByText(copy.SIGNUP_LIMIT).first()).toBeVisible();
    await expect(
      again.getByRole("button", { name: copy.SIGNUP_NEW }),
    ).toBeDisabled();
    // A revoke changes the list and frees it; then an issuance whose answer is lost.
    await again
      .getByRole("button", {
        name: copy.SIGNUP_REVOKE(copy.SIGNUP_ID(signupId(1))),
      })
      .click();
    await expect(
      again.getByRole("button", { name: copy.SIGNUP_NEW }),
    ).toBeEnabled();
    const posts = served.reads.signupIssue ?? 0;
    served.issueScript.push("abort");
    await again.getByRole("button", { name: copy.SIGNUP_NEW }).click();
    await expect(again.getByText(copy.SIGNUP_UNCERTAIN)).toBeVisible();
    await expect(again.locator("[data-signup-flagged]")).toHaveCount(1);
    expect(served.reads.signupIssue).toBe(posts + 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(again.locator("[data-signup-stacked]").first()).toBeVisible();
    await expect(again.locator("[data-signup-grid]")).toHaveCount(0);
    recordEvidence(info, "e-hh7", {
      urls: served.urls.filter((u) => u.includes("account-invitations")),
    });
  });
});

test.describe("E-HH8: keyboard only (A11)", () => {
  test("invite by username with Enter, and focus returns to the opener when the dialog closes; promote by keyboard", async ({
    context,
  }) => {
    const { page, served } = await setupHouseholds(
      context,
      `/sharing/households/${HOME}`,
    );
    await expect(detail(page)).toBeVisible();
    const opener = detail(page).getByRole("link", { name: copy.INVITE_PEOPLE });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = dialogNamed(page, copy.INVITATIONS_TITLE_FOR("Home"));
    await expect(dialog).toBeVisible();
    const field = dialog.getByLabel(copy.USERNAME_LABEL);
    for (
      let n = 0;
      n < 12 && !(await field.evaluate((e) => e === document.activeElement));
      n += 1
    )
      await pressTab(page);
    await expect(field).toBeFocused();
    await page.keyboard.type("jamie");
    await page.keyboard.press("Enter");
    await expect.poll(() => served.management.length).toBe(1);
    await expect(dialog.locator("[data-sent]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    const promote = memberRow(page, SAM).getByRole("button", {
      name: `${copy.PROMOTE}: sam`,
    });
    await promote.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => served.management.length).toBe(2);
    await expect(memberRow(page, SAM)).toContainText(copy.ROLE.manager);
  });
});

test.describe("E-HH9: the directory's two modes (A4; PPL-4)", () => {
  test("enabled: Find an account browses (no query), excludes you, and the choice is invited", async ({
    context,
  }) => {
    const { page, served } = await setupHouseholds(
      context,
      `/sharing/households/${HOME}/invitations`,
    );
    const dialog = dialogNamed(page, copy.INVITATIONS_TITLE_FOR("Home"));
    await dialog.getByRole("button", { name: copy.FIND_ACCOUNT }).click();
    await dialog
      .getByLabel(base.LOOKUP_SEARCH_LABEL, { exact: true })
      .fill("JA");
    await dialog
      .getByRole("button", { name: base.LOOKUP_SEARCH_BUTTON })
      .click();
    await expect(
      dialog.getByRole("button", { name: `${base.LOOKUP_CHOOSE}: jamie` }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: `${base.LOOKUP_CHOOSE}: me` }),
    ).toHaveCount(0);
    await dialog
      .getByRole("button", { name: `${base.LOOKUP_CHOOSE}: jamie` })
      .click();
    await expect(dialog.getByLabel(copy.USERNAME_LABEL)).toHaveValue("jamie");
    await dialog.getByRole("button", { name: copy.INVITE }).click();
    await expect.poll(() => served.management.length).toBe(1);
    expect(served.reads.browse).toBe(1);
  });

  test("disabled: one GET /directory answers 403 for the page lifetime; the remount reopens the lookup with the typed username; the exact lookup still finds them", async ({
    context,
  }, info) => {
    const { page, served } = await setupHouseholds(
      context,
      `/sharing/households/${HOME}/invitations`,
      (s) => {
        s.directoryEnabled = false;
      },
    );
    const dialog = dialogNamed(page, copy.INVITATIONS_TITLE_FOR("Home"));
    await dialog.getByRole("button", { name: copy.FIND_ACCOUNT }).click();
    await dialog
      .getByLabel(base.LOOKUP_EXACT_LABEL, { exact: true })
      .fill("jamie");
    await dialog
      .getByLabel(base.LOOKUP_SEARCH_LABEL, { exact: true })
      .fill("jam");
    await dialog
      .getByRole("button", { name: base.LOOKUP_SEARCH_BUTTON })
      .click();
    const again = dialogNamed(page, copy.INVITATIONS_TITLE_FOR("Home"));
    await expect(again.getByText(base.LOOKUP_EXACT_ONLY)).toBeVisible();
    await expect(
      again.getByLabel(base.LOOKUP_EXACT_LABEL, { exact: true }),
    ).toHaveValue("jamie");
    await page.waitForTimeout(1_500);
    expect(served.reads.browse).toBe(1);
    await again.getByRole("button", { name: base.LOOKUP_EXACT_BUTTON }).click();
    await again
      .getByRole("button", { name: `${base.LOOKUP_CHOOSE}: jamie` })
      .click();
    await again.getByRole("button", { name: copy.INVITE }).click();
    await expect.poll(() => served.management.length).toBe(1);
    expect(served.reads.browse).toBe(1);
    recordEvidence(info, "e-hh9", { reads: served.reads });
  });
});

test.describe("E-HH10: an account switch drops the household page memory (A9)", () => {
  test("a typed New household name and the households read for the first account are never shown for the next", async ({
    context,
  }) => {
    const OTHER = "99999999-9999-4999-8999-999999999999";
    const { page, served } = await setupHouseholds(context, "/sharing/new");
    await page.getByLabel(copy.NAME_LABEL).fill("First account's draft");
    await expect(page.getByRole("button", { name: copy.CREATE })).toBeEnabled();
    let identity = { account: ME, username: "me", session: "s1" };
    await context.route(`**${API}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.replace(API, "");
      if (path === "/browser-sessions/current")
        return route.fulfill(
          json(200, {
            account_id: identity.account,
            session_id: identity.session,
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            csrf_token: `csrf.${identity.session}`,
          }),
        );
      if (path === "/me" && identity.account !== ME)
        return route.fulfill(
          json(200, {
            id: identity.account,
            username: identity.username,
            has_password: true,
            oidc_issuers: [],
          }),
        );
      if (path === "/households" && identity.account !== ME)
        return route.fulfill(json(200, []));
      return route.fallback();
    });
    identity = { account: OTHER, username: "zed", session: "s2" };
    await settleElsewhere(context, settled(OTHER, "s2"));
    // The switch takes the window to the new account's start; that account's own New household starts empty.
    await expect(
      page.getByRole("button", { name: "zed, switch account" }),
    ).toBeVisible({ timeout: 20_000 });
    await navigateInApp(page, "/sharing/new");
    await expect(page.getByLabel(copy.NAME_LABEL)).toHaveValue("", {
      timeout: 20_000,
    });
    await navigateInApp(page, "/sharing");
    await expect(page.getByText(copy.EMPTY, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator(`[data-household="${HOME}"]`)).toHaveCount(0);
    expect(served.management).toHaveLength(0);
  });
});

test.describe("E-HH11: painted contrast and screenshots, light and dark (A11)", () => {
  for (const [width, scheme] of [
    [390, "dark"],
    [834, "light"],
    [1440, "dark"],
  ] as const)
    test(`${width} ${scheme}: text and the Main badge reach 4.5:1 against what they are painted on; axe clean (browser emulation, not a device)`, async ({
      context,
    }, info) => {
      const { page } = await setupHouseholds(
        context,
        `/sharing/households/${HOME}`,
      );
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await expect(detail(page)).toBeVisible();
      const painted = async (locator: Locator) =>
        locator.evaluate((element) => {
          let node: Element | null = element;
          let fill = "rgba(0, 0, 0, 0)";
          while (node) {
            const background = getComputedStyle(node).backgroundColor;
            if (
              background !== "rgba(0, 0, 0, 0)" &&
              background !== "transparent"
            ) {
              fill = background;
              break;
            }
            node = node.parentElement;
          }
          return { color: getComputedStyle(element).color, fill };
        });
      const hex = (rgb: string) =>
        `#${(rgb.match(/\d+/g) ?? [])
          .slice(0, 3)
          .map((n) => Number(n).toString(16).padStart(2, "0"))
          .join("")}`;
      const observations: Record<
        string,
        { color: string; fill: string; ratio: number }
      > = {};
      for (const [name, locator] of [
        ["role", memberRow(page, SAM).locator("[data-member-role]")],
        ["main-note", detail(page).locator("[data-household-main]")],
        ["badge", detail(page).getByText(copy.MAIN_BADGE, { exact: true })],
      ] as const) {
        const seen = await painted(locator);
        observations[name] = {
          ...seen,
          ratio: contrastRatio(hex(seen.color), hex(seen.fill)),
        };
        expect(observations[name]?.ratio, name).toBeGreaterThanOrEqual(4.5);
      }
      const violations = await runAxe(page);
      expect(violations, JSON.stringify(violations, null, 1)).toEqual([]);
      recordPaintedContrast(info, scheme, {
        engine: info.project.name,
        width,
        ...observations,
      });
      if (info.project.name === "fixture-chromium")
        await surfaceScreenshot(page, info, {
          name: "households-detail",
          width,
          scheme,
        });
    });
});
