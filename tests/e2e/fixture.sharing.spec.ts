import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  ACCOUNT,
  pageText,
  type SyncStub,
  seedSettled,
  startLeader,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
  waitForState,
} from "./data-sync-helpers";
import { pressTab } from "./helpers";

/**
 * WEB-12a in Chromium, Firefox and WebKit: the PRODUCTION session and protected tree (`/__session`), the production data controller and
 * REAL IndexedDB, with the sharing endpoints stubbed by `page.route`. FIXTURE evidence: there is no backend, and an answer the stub gives is
 * the stub's (the I-SH integration cases run against the released backend). The fixture leader (`startLeader`/`startOutbox`) stands in for
 * WEB-09b's production leadership.
 *
 * E-SH1 open, effective visibility and save; E-SH2 offline and an uncertain save retried; E-SH3 the directory lookup; E-SH4 the defaults
 * editor's layers and conflict; E-SH5 a locally blocked draft, reviewed and confirmed, then sent; E-SH6 W14 in real IndexedDB; E-SH7 a
 * keyboard-only journey; E-SH8 the viewports. Review cycle 1: E-SH9 a non-owner's editor, E-SH10/E-SH11 kept drafts. Review 2: E-SH12/E-SH13
 * a dismissal discards what the editor's session kept, also before its read lands, offline, and for another kind. Review 3: E-SH14 an
 * unresolved household create survives the browser going offline and back, and is the only command sent until it is resolved. Review 4:
 * E-SH15 a defaults answer asked before the database was deleted and created again (by this page or another) is never written into the
 * replacement, through the harness's production controller and defaults source. Review 6: E-SH17 a household template that could not be
 * read is unknown, never Private, and a save waits for it. Review 5: E-SH16 the editors' household choices and names
 * come from the complete membership list (`GET /households`), which the stub serves on its own (`memberships`), never from B5's subset.
 */
const API = "/api/experimental/v1";
const RID = "55555555-5555-4555-8555-555555555555";
/** A second cached resource (E-SH10's target isolation). */
const OTHER_RID = "66666666-6666-4666-8666-666666666666";
const SAM = "22222222-2222-4222-8222-222222222222";
const PRIYA = "33333333-3333-4333-8333-333333333333";
const JAMIE = "44444444-4444-4444-8444-444444444444";
const HOME = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ELSEWHERE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const rev = (n: number) => n.toString(16).padStart(64, "0");
const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const atlas = (code: string, id = "61af3d02-0000-4000-8000-000000000000") => ({
  code,
  message: `refused: ${code}`,
  request_id: id,
  details: [],
});

const homeHousehold = (...more: Array<[string, string]>) => ({
  id: HOME,
  name: "Home",
  version: 2,
  role: "manager",
  members: [
    { account_id: ACCOUNT, username: "me", role: "manager" },
    { account_id: SAM, username: "sam", role: "member" },
    ...more.map(([id, username]) => ({
      account_id: id,
      username,
      role: "member",
    })),
  ],
});

interface Served {
  snapshot: Record<string, unknown>;
  policy: { version: number; policy: unknown };
  templates: Record<string, { template: unknown; version: number }>;
  householdTemplates: Record<string, { template: unknown; version: number }>;
  directory: Array<{ id: string; username: string }>;
  /** Each management request, in order. */
  management: Array<{ key: string | null; body: unknown }>;
  /** What the next management requests answer (`abort`: the connection drops after the request), else `200 { revision }`. */
  managementScript: Array<"abort" | { status: number; body: unknown }>;
  snapshotReads: number;
  /** Holds every snapshot answer until released (E-SH6). */
  holdSnapshot: Promise<void> | null;
  /**
   * `GET /households`: the caller's COMPLETE membership list, served on its own (WEB-12a R11, design assessment DA-T1). B5's
   * `snapshot.households` names only the primary household and the households the resolved defaults name, so the two differ whenever
   * you are in a household no resolved default names; by default they coincide (Home only).
   */
  memberships: unknown[];
  /**
   * While set, EVERY `GET /households` answers this refusal, else `200 memberships`. Every reader is refused alike: the Sharing page's
   * household demonstration under an editor reads the list too, so a refusal of only the next read would go to whichever read came first.
   */
  refuseMemberships: { status: number; body: unknown } | null;
  membershipReads: number;
  /** `GET /policies/{RID}` requests (E-SH16: a membership Try again reads only the list). */
  policyReads: number;
  /**
   * While set, EVERY `GET /defaults/templates?household_id=…` answers this refusal (E-SH17); the personal read is never refused. Only the
   * defaults editor reads templates, so the count is that editor's household reads.
   */
  refuseHouseholdTemplates: { status: number; body: unknown } | null;
  householdTemplateReads: number;
}

function scope(
  over: Record<string, { template: unknown; version: number }> = {},
) {
  const empty = { template: null, version: 0 };
  return {
    person: empty,
    field: empty,
    task: empty,
    list: empty,
    progress: empty,
    ...over,
  };
}

function snapshotOf(
  revision: string,
  over: Record<string, unknown> = {},
  households = [homeHousehold()],
) {
  return {
    defaults: {
      revision,
      preferences_version: 1,
      primary_household_id: HOME,
      person: { kind: "primary_household", edit: true },
      field: { kind: "private" },
      task: { kind: "private" },
      list: { kind: "private" },
      progress: { kind: "primary_household", edit: false },
      ...over,
    },
    households,
  };
}

/** The sharing endpoints. Registered AFTER `stubNetwork`, so it answers first; everything else falls through to the shared stub. */
async function serveSharing(context: BrowserContext): Promise<Served> {
  const served: Served = {
    snapshot: snapshotOf(rev(1)),
    policy: {
      version: 3,
      policy: {
        grants: [{ kind: "household", id: HOME, edit: false }],
        exclude_accounts: [PRIYA],
      },
    },
    templates: scope(),
    householdTemplates: scope({
      field: {
        template: { kind: "primary_household", edit: false },
        version: 4,
      },
    }),
    directory: [{ id: JAMIE, username: "jamie" }],
    management: [],
    managementScript: [],
    snapshotReads: 0,
    holdSnapshot: null,
    memberships: [homeHousehold()],
    refuseMemberships: null,
    membershipReads: 0,
    policyReads: 0,
    refuseHouseholdTemplates: null,
    householdTemplateReads: 0,
  };
  let revision = 500;
  await context.route(`**${API}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(API, "");
    const method = route.request().method();
    if (path === "/me")
      return route.fulfill(
        json(200, {
          id: ACCOUNT,
          username: "me",
          has_password: true,
          oidc_issuers: [],
        }),
      );
    if (path === "/sessions")
      return route.fulfill(
        json(200, {
          sessions: [
            {
              id: "s1",
              device_id: "dev-1",
              current: true,
              authentication: "local",
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        }),
      );
    if (path === "/defaults/snapshot") {
      served.snapshotReads += 1;
      if (served.holdSnapshot) await served.holdSnapshot;
      return route.fulfill(json(200, served.snapshot));
    }
    if (path === "/defaults/templates") {
      if (!url.searchParams.get("household_id"))
        return route.fulfill(json(200, served.templates));
      served.householdTemplateReads += 1;
      const refusal = served.refuseHouseholdTemplates;
      if (refusal) return route.fulfill(json(refusal.status, refusal.body));
      return route.fulfill(json(200, served.householdTemplates));
    }
    if (path === `/policies/${RID}`) {
      served.policyReads += 1;
      return route.fulfill(json(200, served.policy));
    }
    if (path === `/policies/${OTHER_RID}`)
      return route.fulfill(
        json(200, { version: 1, policy: { grants: [], exclude_accounts: [] } }),
      );
    if (path === "/households") {
      served.membershipReads += 1;
      const refusal = served.refuseMemberships;
      if (refusal) return route.fulfill(json(refusal.status, refusal.body));
      return route.fulfill(json(200, served.memberships));
    }
    if (path === "/invitations") return route.fulfill(json(200, []));
    if (path === "/directory") {
      const username = url.searchParams.get("username") ?? "";
      return route.fulfill(
        json(
          200,
          served.directory.filter((entry) =>
            entry.username.startsWith(username),
          ),
        ),
      );
    }
    if (path === "/management-commands" && method === "POST") {
      served.management.push({
        key: route.request().headers()["idempotency-key"] ?? null,
        body: JSON.parse(route.request().postData() ?? "null"),
      });
      const next = served.managementScript.shift();
      if (next === "abort") return route.abort("connectionreset");
      if (next) return route.fulfill(json(next.status, next.body));
      revision += 1;
      return route.fulfill(json(200, { revision }));
    }
    return route.fallback();
  });
  return served;
}

/** A booted session page (the production composition) on `route`, with the data harness attached. */
async function bootAt(context: BrowserContext, route: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

/** In-app navigation to `path` (history and popstate): the page and its memory stay, unlike `reopen`, which loads the page again. */
async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** The same page loaded again on `route` (the harness page: a plain reload would load the application's own route). */
async function reopen(page: Page, route: string): Promise<void> {
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
}

/** The resource the editor opens, in the account's cache: one delta page through the fixture leader. */
async function cacheResource(
  page: Page,
  net: SyncStub,
  policyVersion = 2,
  other = false,
): Promise<void> {
  net.script.push(() => ({
    status: 200,
    body: pageText(
      [
        [
          {
            kind: "upsert",
            resource: {
              id: RID,
              kind: "person",
              parent_id: null,
              label: "Water plants",
              value: null,
              version: 3,
              policy_version: policyVersion,
              can_edit: true,
              archived: false,
            },
          },
          ...(other
            ? [
                {
                  kind: "upsert",
                  resource: {
                    id: OTHER_RID,
                    kind: "person",
                    parent_id: null,
                    label: "Feed the cat",
                    value: null,
                    version: 1,
                    policy_version: 1,
                    can_edit: true,
                    archived: false,
                  },
                },
              ]
            : []),
        ],
      ],
      "cursor-1",
    ),
  }));
  await startLeader(page);
  await waitForState(page, "idle");
}

async function setup(
  context: BrowserContext,
  route: string,
  options: {
    resource?: boolean;
    other?: boolean;
    arrange?: (served: Served) => void;
  } = {},
) {
  const net = await stubNetwork(context);
  const served = await serveSharing(context);
  options.arrange?.(served);
  await seedSettled(context);
  const page = await bootAt(context, route);
  if (options.resource !== false)
    await cacheResource(page, net, 2, options.other === true);
  return { net, served, page };
}

const editorTitle = "Sharing — Water plants";

test.describe("E-SH1: open, effective visibility and save (A1)", () => {
  test("a cached generic resource opens; the summary follows the edits; replace_policy is guarded by GET /policies' version", async ({
    context,
  }, info) => {
    const { served, page } = await setup(context, `/sharing/items/${RID}`);
    const dialog = page.getByRole("dialog", { name: editorTitle });
    await expect(dialog).toBeVisible();
    const audience = dialog.locator("[data-audience]");
    await expect(audience).toContainText("Can read: sam");
    // priya is in no household this page has read and was never looked up: an abbreviated id, never a guessed name.
    await expect(audience).toContainText("Excluded: Account 3333…");
    // The cache's policy_version (2) lags the server's (3): the editor says so and saves against 3.
    await expect(dialog).toContainText("hasn't caught up");
    await dialog.getByRole("button", { name: "+ Add account grant" }).click();
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("jam");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await dialog.getByRole("button", { name: "Choose: jamie" }).click();
    await expect(audience).toContainText("jamie");
    await dialog.locator("[data-save]").click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/sharing$/);
    expect(served.management).toHaveLength(1);
    expect(served.management[0]?.body).toEqual({
      commands: [
        {
          kind: "replace_policy",
          id: RID,
          expected_version: 3,
          policy: {
            grants: [
              { kind: "household", id: HOME, edit: false },
              { kind: "account", id: JAMIE, edit: false },
            ],
            exclude_accounts: [PRIYA],
          },
        },
      ],
    });
    expect(served.management[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    recordEvidence(info, "e-sh1", { management: served.management });
  });

  test("Er: a stale policy version shows the conflict with its request id; nothing is resent; Reload re-reads", async ({
    context,
  }) => {
    const { served, page } = await setup(context, `/sharing/items/${RID}`);
    served.managementScript.push({ status: 409, body: atlas("conflict") });
    const dialog = page.getByRole("dialog", { name: editorTitle });
    await dialog
      .getByRole("radiogroup", { name: "Home: Read or Edit" })
      .getByRole("radio", { name: "Edit" })
      .click();
    await dialog.locator("[data-save]").click();
    await expect(dialog).toContainText(
      "This policy changed since you opened it",
    );
    await expect(dialog).toContainText(
      "Request ID: 61af3d02-0000-4000-8000-000000000000",
    );
    await page.waitForTimeout(300);
    expect(served.management).toHaveLength(1);
    await dialog.getByRole("button", { name: "Reload" }).click();
    await expect(
      dialog
        .getByRole("radiogroup", { name: "Home: Read or Edit" })
        .getByRole("radio", { name: "Read" }),
    ).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("E-SH9: a non-owner (A7)", () => {
  test("GET /policies answers 403 forbidden: the editor says only the owner can change it, discloses nothing, and asks once", async ({
    context,
  }, info) => {
    const { served, page } = await setup(context, "/today");
    let asked = 0;
    await context.route(`**${API}/policies/${RID}`, (route) => {
      asked += 1;
      return route.fulfill(json(403, atlas("forbidden")));
    });
    await page.evaluate((p) => {
      history.pushState(null, "", p);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/sharing/items/${RID}`);
    const dialog = page.getByRole("dialog", { name: editorTitle });
    await expect(dialog).toContainText(
      "Only the owner can change who can see this.",
    );
    // A 403 closes and reopens the protected display (the session classifies it), which remounts the editor: it must not ask again.
    await page.waitForTimeout(3_000);
    recordEvidence(info, "e-sh9", {
      asked,
      management: served.management.length,
    });
    await expect(dialog).toContainText(
      "Only the owner can change who can see this.",
    );
    // Awaited (revision 1): an unawaited locator assertion is cancelled when the test returns first, which failed this case in two
    // engines of the follow-up campaign without ever checking the count.
    await expect(dialog.locator("[data-audience]")).toHaveCount(0);
    expect(asked).toBe(1);
  });
});

test.describe("E-SH2: online-only (A6)", () => {
  test("a dropped connection after the request is uncertain; Try again resends the SAME key and body; offline disables Save and keeps the draft", async ({
    context,
  }, info) => {
    const { served, page } = await setup(context, `/sharing/items/${RID}`);
    served.managementScript.push("abort");
    const dialog = page.getByRole("dialog", { name: editorTitle });
    await dialog
      .getByRole("radiogroup", { name: "Home: Read or Edit" })
      .getByRole("radio", { name: "Edit" })
      .click();
    await dialog.locator("[data-save]").click();
    await expect(dialog).toContainText(
      "We couldn't confirm the change was saved",
    );
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog).toBeHidden();
    expect(served.management).toHaveLength(2);
    expect(served.management[1]).toEqual(served.management[0]);
    recordEvidence(info, "e-sh2-retry", { management: served.management });
    // Offline: the editor keeps its draft, and Save says why it is disabled.
    await reopen(page, `/sharing/items/${RID}`);
    const again = page.getByRole("dialog", { name: editorTitle });
    await again
      .getByRole("radiogroup", { name: "Home: Read or Edit" })
      .getByRole("radio", { name: "Edit" })
      .click();
    await context.setOffline(true);
    await expect(again.locator("[data-save]")).toBeDisabled();
    await expect(again).toContainText(
      "You're offline. Sharing changes need a connection.",
    );
    await expect(
      again
        .getByRole("radiogroup", { name: "Home: Read or Edit" })
        .getByRole("radio", { name: "Edit" }),
    ).toHaveAttribute("aria-checked", "true");
    await context.setOffline(false);
    await expect(again.locator("[data-save]")).toBeEnabled();
  });
});

test.describe("E-SH3: the directory lookup (A9)", () => {
  test("two sections in one reading order; an empty answer is the empty state; the exact lookup finds one", async ({
    context,
  }) => {
    const { page } = await setup(context, `/sharing/items/${RID}`);
    const dialog = page.getByRole("dialog", { name: editorTitle });
    await dialog.getByRole("button", { name: "+ Add exclusion" }).click();
    const sections = dialog.locator("[data-lookup]");
    await expect(sections).toHaveCount(2);
    expect(
      await sections.evaluateAll((all) =>
        all.map((s) => s.getAttribute("data-lookup")),
      ),
    ).toEqual(["search", "exact"]);
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("zz");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(dialog.locator("[data-lookup-empty]").first()).toContainText(
      "No account found",
    );
    await dialog.getByRole("textbox", { name: "Exact username" }).fill("jamie");
    await dialog.getByRole("button", { name: "Look up" }).click();
    await dialog.getByRole("button", { name: "Choose: jamie" }).click();
    await expect(dialog.locator(`[data-exclusion="${JAMIE}"]`)).toBeVisible();
  });
});

test.describe("E-SH4: the defaults editor (A4)", () => {
  test("the household layer resolves; a personal save is guarded by the PERSONAL version; a stale one is the conflict", async ({
    context,
  }, info) => {
    const { served, page } = await setup(
      context,
      "/sharing/defaults?kind=field",
      {
        resource: false,
        arrange: (served) => {
          // The personal template is missing (null) at version 6: it inherits, and its OWN version guards a save.
          served.templates = scope({ field: { template: null, version: 6 } });
        },
      },
    );
    const dialog = page.getByRole("dialog", {
      name: "Sharing defaults — Fields",
    });
    await expect(dialog.locator('[data-chain="household"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    const personal = dialog.locator('[data-layer-form="personal"]');
    await personal.getByRole("radio", { name: "Private" }).click();
    await personal.locator('[data-save="personal"]').click();
    await expect.poll(() => served.management.length).toBe(1);
    // The PERSONAL template's own version (6), never the household layer's (4), although the household layer resolves.
    expect(served.management[0]?.body).toEqual({
      commands: [
        {
          kind: "set_defaults",
          household_id: null,
          resource_kind: "field",
          expected_version: 6,
          template: { kind: "private" },
        },
      ],
    });
    served.managementScript.push({
      status: 409,
      body: atlas("conflict", "c2049e11-0000-4000-8000-000000000000"),
    });
    const household = dialog.locator('[data-layer-form="household"]');
    await household.getByRole("radio", { name: "Household · edit" }).click();
    await household.locator('[data-save="household"]').click();
    await expect(dialog).toContainText(
      "This template changed since you opened it",
    );
    await expect(dialog).toContainText(
      "Request ID: c2049e11-0000-4000-8000-000000000000",
    );
    expect(served.management[1]?.body).toEqual({
      commands: [
        {
          kind: "set_defaults",
          household_id: HOME,
          resource_kind: "field",
          expected_version: 4,
          template: { kind: "primary_household", edit: true },
        },
      ],
    });
    recordEvidence(info, "e-sh4", { management: served.management });
  });
});

test.describe("E-SH5: a locally blocked draft is never sent until the person confirms the audience (A5, A11)", () => {
  test("captured with a household nobody here has seen: blocked, held, reviewed (Was shows the captured members), confirmed, then sent with the reviewed revision", async ({
    context,
  }, info) => {
    const { net, served, page } = await setup(context, "/sharing", {
      resource: false,
    });
    served.snapshot = snapshotOf(rev(1), {
      person: {
        kind: "explicit",
        policy: {
          grants: [
            { kind: "household", id: HOME, edit: false },
            { kind: "household", id: ELSEWHERE, edit: false },
          ],
          exclude_accounts: [],
        },
      },
    });
    await startOutbox(page);
    // The page reads the defaults (the Sharing page uses them) and W14 persists them in the account's database.
    await reopen(page, "/sharing");
    await startOutbox(page);
    await expect
      .poll(() =>
        page
          .evaluate((a) => window.__atlasData?.defaultsRecord(a), ACCOUNT)
          .then((r) => r?.snapshot.defaults.revision ?? null),
      )
      .toBe(rev(1));
    const capture = await page.evaluate(
      (a) => window.__atlasData?.captureDefaults(a, ["person"]),
      ACCOUNT,
    );
    expect(capture?.defaultsReview).toEqual(["person"]);
    const id = "77777777-7777-4777-8777-777777777777";
    const queued = await page.evaluate(
      ({ id, capture }) =>
        window.__atlasData?.enqueue({
          endpoint: "/commands",
          targets: [
            {
              resourceId: id,
              role: "primary",
              basis: "resource",
              versionChecked: false,
              seedIfUntracked: 1,
            },
          ],
          command: {
            commands: [{ kind: "create_person", id, name: "Morgan" }],
            defaults_revision: capture?.defaultsRevision,
          },
          defaultsRevision: capture?.defaultsRevision ?? null,
          defaultsContext: capture?.defaultsContext as never,
          defaultsReview: capture?.defaultsReview,
        }),
      { id, capture },
    );
    expect(queued?.kind).toBe("queued");
    const later = await page.evaluate(() =>
      window.__atlasData?.enqueue({
        endpoint: "/commands",
        targets: [
          {
            resourceId: "88888888-8888-4888-8888-888888888888",
            role: "primary",
            basis: "resource",
            versionChecked: false,
            seedIfUntracked: 1,
          },
        ],
        command: {
          commands: [
            {
              kind: "create_person",
              id: "88888888-8888-4888-8888-888888888888",
              name: "Later",
            },
          ],
        },
      }),
    );
    expect(later?.kind).toBe("queued");
    await page.waitForTimeout(1_500);
    // Blocked and holding the queue: nothing was sent.
    expect(net.commands).toEqual([]);
    // The person reviews it from the queue.
    await page.evaluate(() => {
      history.pushState(null, "", "/sync?tab=conflicts");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByRole("button", { name: /^Review sharing/ }).click();
    const review = page.getByRole("dialog", { name: "Review sharing" });
    await expect(review).toContainText("Your sharing defaults haven't changed");
    const was = review.locator('[data-review-kind="person"] [data-review-was]');
    await expect(was).toContainText("Home · Read: me, sam");
    await expect(was).toContainText("Members not known on this device");
    await review.locator("[data-confirm]").click();
    await expect(review).toBeHidden();
    await expect.poll(() => net.commands.length).toBeGreaterThanOrEqual(1);
    expect(net.commands[0]?.key).toBe((queued as { localId: string }).localId);
    expect(JSON.parse(net.commands[0]?.body ?? "{}").defaults_revision).toBe(
      rev(1),
    );
    // The hold is gone with the block: the later draft follows.
    await expect.poll(() => net.commands.length).toBe(2);
    recordEvidence(info, "e-sh5", {
      commands: net.commands.map((c) => ({ key: c.key, body: c.body })),
    });
  });
});

test.describe("E-SH6: W14 in real IndexedDB (A10)", () => {
  test("no database: read into memory, nothing created; with one: persisted whole through the production commit; W14's own guards and the later-issued rule hold in this engine", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    const served = await serveSharing(context);
    await seedSettled(context);
    // No database yet: the Sharing page reads the defaults (memory only) and creates nothing.
    const page = await bootAt(context, "/sharing");
    await expect(page.locator('[data-defaults-kind="person"]')).toContainText(
      "Primary household",
    );
    expect(served.snapshotReads).toBeGreaterThanOrEqual(1);
    const names = (await page.evaluate(() => window.__atlasData?.list())) ?? [];
    expect(names.some((name) => name.includes(ACCOUNT))).toBe(false);
    // With a database (the fixture leader made it), the next read is persisted, whole.
    await startLeader(page);
    await waitForState(page, "idle");
    const reopenedAt = Date.now();
    await reopen(page, "/sharing");
    // The harness reads through a connection of its own (the product controller's belongs to its runtime); it never creates one.
    expect(
      await page.evaluate((a) => {
        window.__atlasData?.setIdentity(a);
        return window.__atlasData?.open(a);
      }, ACCOUNT),
    ).toBe("opened");
    await expect
      .poll(() =>
        page.evaluate(
          (a) =>
            window.__atlasData
              ?.defaultsRecord(a)
              .then((r) => r?.format ?? null),
          ACCOUNT,
        ),
      )
      .toBe(1);
    // ADAPTED PRECONDITION, WEB-08c revision 10 (labelled for the review; every assertion below is unchanged). The probes compare with the
    // stored record, so it must be the reopened page's OWN read: the page that ran the leader persisted an earlier one (after its first
    // sync), which already satisfies the format poll above, and the reopened page's read is persisted moments later. Before
    // HF1-SHARED-CONFIRMATION-20261013 the reopened page made two identity reads first, which delayed its read past the test's; now it
    // adopts the shared confirmation and reads at once, so in WebKit the record could change between the test's read of it and the probe
    // (2 of 10 runs "kept" for the later probe, revision-10 evidence `sharing/`; accepted main 10 of 10): the later-issued rule was right,
    // the test's precondition was not established. Asked after `reopenedAt`, that read's `issued_at` is at least it.
    await expect
      .poll(() =>
        page.evaluate(
          (a) =>
            window.__atlasData
              ?.defaultsRecord(a)
              .then((r) => r?.issued_at ?? null),
          ACCOUNT,
        ),
      )
      .toBeGreaterThanOrEqual(reopenedAt);
    const stored = (await page.evaluate(
      (a) => window.__atlasData?.syncState(a),
      ACCOUNT,
    )) as {
      defaults: { snapshot: unknown; issued_at: number; epoch: number };
      stamp: { epoch: number } | null;
    };
    expect(stored.defaults.snapshot).toEqual(served.snapshot);
    const issued = stored.defaults.issued_at;
    // The later-issued rule: an answer asked for BEFORE the stored one is kept out; one asked for later replaces it.
    const probe = (epoch: number, issuedAt: number, revision: string) =>
      page.evaluate(
        ({ a, input }) => window.__atlasData?.writeDefaultsProbe(a, input),
        {
          a: ACCOUNT,
          input: { epoch, issuedAt, snapshot: snapshotOf(revision) },
        },
      );
    const epoch = stored.defaults.epoch;
    expect(await probe(epoch, issued - 1, rev(7))).toBe("kept");
    expect(await probe(epoch, issued + 1, rev(8))).toBe("written");
    // EPO: once a later epoch is published to the database, an answer of an earlier one writes nothing.
    const sync = (await page.evaluate(
      (a) => window.__atlasData?.syncState(a),
      ACCOUNT,
    )) as Record<string, unknown>;
    await page.evaluate(
      ({ a, row }) => window.__atlasData?.put(a, "sync_state", [row]),
      {
        a: ACCOUNT,
        row: { ...sync, stamp: { epoch: epoch + 5 } },
      },
    );
    expect(await probe(epoch, issued + 10, rev(9))).toBe(
      "dropped:epoch_superseded",
    );
    // CLS: while a wipe is closing, nothing is written.
    const fenced = (await page.evaluate(
      (a) => window.__atlasData?.syncState(a),
      ACCOUNT,
    )) as Record<string, unknown>;
    await page.evaluate(
      ({ a, row }) => window.__atlasData?.put(a, "sync_state", [row]),
      {
        a: ACCOUNT,
        row: {
          ...fenced,
          draft_fence: {
            token: "t",
            started_at: Date.now(),
            operation_ids: [],
            consent_digest: "d",
            closing: true,
          },
        },
      },
    );
    expect(await probe(epoch + 5, issued + 20, rev(10))).toBe(
      "dropped:closing",
    );
    const after = await page.evaluate(
      (a) => window.__atlasData?.defaultsRecord(a),
      ACCOUNT,
    );
    expect(after?.snapshot.defaults.revision).toBe(rev(8));
    recordEvidence(info, "e-sh6", { issued, other: net.other });
  });
});

test.describe("E-SH7: keyboard only (A12)", () => {
  test("the policy editor is operable by keyboard alone: add a grant through the lookup and save", async ({
    context,
  }) => {
    const { served, page } = await setup(context, `/sharing/items/${RID}`);
    const dialog = page.getByRole("dialog", { name: editorTitle });
    await expect(dialog.locator("[data-audience]")).toBeVisible();
    const focusOn = async (name: RegExp, limit = 60) => {
      for (let i = 0; i < limit; i += 1) {
        const label = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el
            ? (el.getAttribute("aria-label") ?? el.textContent ?? "")
            : "";
        });
        if (name.test(label.trim())) return;
        // macOS WebKit Tabs to buttons only with Option held, as Safari does (helpers.ts `pressTab`).
        await pressTab(page);
      }
      throw new Error(`never reached ${name} by Tab`);
    };
    await focusOn(/^\+ Add account grant$/);
    await page.keyboard.press("Enter");
    await dialog.getByRole("textbox", { name: "Exact username" }).focus();
    await page.keyboard.type("jamie");
    await page.keyboard.press("Enter");
    await focusOn(/^Choose: jamie$/);
    await page.keyboard.press("Enter");
    await focusOn(/^Replace policy$/);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    expect(served.management).toHaveLength(1);
  });
});

test.describe("E-SH8: viewports (A13)", () => {
  /** The panel's geometry, its horizontal overflow and its visible targets under 44 px. */
  const measure = async (dialog: Locator) => {
    const box = await dialog.boundingBox();
    const overflow = await dialog.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    const small = await dialog.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>("button, [role=radio], a, input")]
        .filter((c) => c.offsetParent !== null)
        .map((c) => ({
          name: c.getAttribute("aria-label") ?? c.textContent?.trim() ?? "",
          h: c.getBoundingClientRect().height,
        }))
        .filter((c) => c.h < 44),
    );
    return { box, overflow, small };
  };
  /**
   * Below the desktop breakpoint (1280 px) the sharing editors are FULL-BLEED sheets, as the accepted tablet frames draw them at 834×1112
   * and 1112×834 (WEB-05.5 `tablet/sharing-portrait.html`, `sharing-landscape.html`, Q14) and the mobile sheet at 390 (WEB-12a R6); from
   * it, the centred 440 px dialog.
   */
  const expectPlacement = (
    box: { x: number; y: number; width: number; height: number } | null,
    width: number,
    height: number,
  ) => {
    expect(box).not.toBeNull();
    if (width < 1280) {
      expect(Math.round(box?.x ?? -1)).toBe(0);
      expect(Math.round(box?.y ?? -1)).toBe(0);
      expect(Math.round(box?.width ?? 0)).toBe(width);
      expect(Math.round(box?.height ?? 0)).toBe(height);
    } else {
      expect(Math.round(box?.width ?? 0)).toBe(440);
      expect(Math.round((box?.x ?? 0) + (box?.width ?? 0) / 2)).toBe(
        Math.round(width / 2),
      );
    }
  };
  for (const [width, height, name] of [
    [390, 844, "mobile"],
    [834, 1112, "tablet portrait"],
    [1112, 834, "tablet landscape"],
    [1440, 900, "desktop"],
  ] as const)
    test(`${name} ${width}×${height}: both editors are full-bleed sheets below 1280 px and the centred dialog from it, with no horizontal overflow and 44 px targets`, async ({
      context,
    }, info) => {
      const { page } = await setup(context, `/sharing/items/${RID}`);
      await page.setViewportSize({ width, height });
      const policy = page.getByRole("dialog", { name: editorTitle });
      await expect(policy.locator("[data-audience]")).toBeVisible();
      const policyMeasured = await measure(policy);
      await reopen(page, "/sharing/defaults?kind=field");
      const defaults = page.getByRole("dialog", {
        name: "Sharing defaults — Fields",
      });
      await expect(
        defaults.locator('[data-layer-form="personal"]'),
      ).toBeVisible();
      const defaultsMeasured = await measure(defaults);
      recordEvidence(info, `e-sh8-${width}`, {
        viewport: { width, height },
        policy: policyMeasured,
        defaults: defaultsMeasured,
      });
      for (const measured of [policyMeasured, defaultsMeasured]) {
        expectPlacement(measured.box, width, height);
        expect(measured.overflow).toBeLessThanOrEqual(0);
        expect(measured.small).toEqual([]);
      }
    });
});

test.describe("E-SH10: the policy editor keeps an unsaved draft through the in-dialog sync control (ia.md §1.3.3; R5)", () => {
  test("Read → Edit, an account grant added and an exclusion removed; the sync control opens the queue, back: all of it is shown again and nothing was saved; another resource never shows it; Save sends it; Cancel discards a draft", async ({
    context,
  }, info) => {
    const { served, page } = await setup(context, `/sharing/items/${RID}`, {
      other: true,
    });
    let dialog = page.getByRole("dialog", { name: editorTitle });
    const home = () =>
      dialog.getByRole("radiogroup", { name: "Home: Read or Edit" });
    await home().getByRole("radio", { name: "Edit" }).click();
    // An account grant added through the lookup, and the exclusion removed: explicit principals are kept too.
    await dialog.getByRole("button", { name: "+ Add account grant" }).click();
    await dialog.getByRole("textbox", { name: "Exact username" }).fill("jamie");
    await dialog.getByRole("button", { name: "Look up" }).click();
    await dialog.getByRole("button", { name: "Choose: jamie" }).click();
    await expect(
      dialog.locator(`[data-grant="account"][data-principal="${JAMIE}"]`),
    ).toBeVisible();
    await dialog
      .locator(`[data-exclusion="${PRIYA}"]`)
      .getByRole("button", { name: /^Remove exclusion/ })
      .click();
    await expect(dialog.locator(`[data-exclusion="${PRIYA}"]`)).toHaveCount(0);
    await dialog.locator("[data-sync-tone]").click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/sync/);
    await page.goBack();
    dialog = page.getByRole("dialog", { name: editorTitle });
    await expect(dialog.locator("[data-audience]")).toBeVisible();
    await expect(home().getByRole("radio", { name: "Edit" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(dialog.locator("[data-policy-restored]")).toBeVisible();
    await expect(
      dialog.locator(`[data-grant="account"][data-principal="${JAMIE}"]`),
    ).toBeVisible();
    await expect(dialog.locator(`[data-exclusion="${PRIYA}"]`)).toHaveCount(0);
    expect(served.management).toEqual([]);
    // Target isolation: another resource's editor never shows the draft kept for this one. In-app navigation (the kept draft lives in
    // this page's memory; a reload forgets it by design).
    const navigate = (to: string) => navigateInApp(page, to);
    await navigate(`/sharing/items/${OTHER_RID}`);
    const other = page.getByRole("dialog", { name: "Sharing — Feed the cat" });
    await expect(other.locator("[data-audience]")).toBeVisible();
    await expect(other.locator("[data-policy-restored]")).toHaveCount(0);
    await expect(
      other.locator(`[data-grant="account"][data-principal="${JAMIE}"]`),
    ).toHaveCount(0);
    await navigate(`/sharing/items/${RID}`);
    dialog = page.getByRole("dialog", { name: editorTitle });
    await expect(dialog.locator("[data-policy-restored]")).toBeVisible();
    await dialog.locator("[data-save]").click();
    await expect.poll(() => served.management.length).toBe(1);
    expect(served.management[0]?.body).toEqual({
      commands: [
        {
          kind: "replace_policy",
          id: RID,
          expected_version: 3,
          policy: {
            grants: [
              { kind: "household", id: HOME, edit: true },
              { kind: "account", id: JAMIE, edit: false },
            ],
            exclude_accounts: [],
          },
        },
      ],
    });
    // The save closed the editor, which navigates to /sharing: wait for that navigation before navigating again (else the router's
    // pending one can land after ours, as WebKit showed).
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/sharing$/);
    // Control: Cancel discards a KEPT draft. Kept again through the sync control and shown again, then cancelled: reopened IN THE SAME
    // PAGE (a reload would forget anything kept anyway), the editor starts from the policy read.
    await navigateInApp(page, `/sharing/items/${RID}`);
    dialog = page.getByRole("dialog", { name: editorTitle });
    await home().getByRole("radio", { name: "Edit" }).click();
    await dialog.locator("[data-sync-tone]").click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/sync/);
    await page.goBack();
    dialog = page.getByRole("dialog", { name: editorTitle });
    await expect(dialog.locator("[data-policy-restored]")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/sharing$/);
    await navigateInApp(page, `/sharing/items/${RID}`);
    dialog = page.getByRole("dialog", { name: editorTitle });
    await expect(dialog.locator("[data-audience]")).toBeVisible();
    await expect(home().getByRole("radio", { name: "Read" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(dialog.locator("[data-policy-restored]")).toHaveCount(0);
    recordEvidence(info, "e-sh10", { management: served.management });
  });
});

test.describe("E-SH11: the defaults editor keeps unsaved choices offline and through the sync control (R5)", () => {
  test("Inherit → Private survives offline then online; an explicit template with a household grant is kept through the sync control and back shows it (another kind never does); Save sends it; Done discards", async ({
    context,
  }, info) => {
    const { served, page } = await setup(
      context,
      "/sharing/defaults?kind=field",
      {
        resource: false,
      },
    );
    let dialog = page.getByRole("dialog", {
      name: "Sharing defaults — Fields",
    });
    const personal = () => dialog.locator('[data-layer-form="personal"]');
    const privateChoice = () =>
      personal().getByRole("radio", { name: "Private", exact: true });
    await privateChoice().click();
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(
      dialog.locator("[data-defaults-offline-editing]"),
    ).toBeVisible();
    await expect(privateChoice()).toHaveAttribute("aria-checked", "true");
    await expect(personal().locator('[data-save="personal"]')).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(dialog.locator("[data-defaults-offline-editing]")).toHaveCount(
      0,
    );
    await expect(privateChoice()).toHaveAttribute("aria-checked", "true");
    expect(served.management).toEqual([]);
    // An explicit template with a household grant is kept as well.
    await personal()
      .getByRole("radio", { name: "Explicit policy…", exact: true })
      .click();
    await personal()
      .getByRole("button", { name: "+ Add household grant" })
      .click();
    await personal().getByRole("button", { name: "Home", exact: true }).click();
    await expect(
      personal().locator(`[data-grant="household"][data-principal="${HOME}"]`),
    ).toBeVisible();
    // The sync control keeps it; back, the editor shows it again.
    await dialog.locator("[data-sync-tone]").click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/sync/);
    await page.goBack();
    dialog = page.getByRole("dialog", { name: "Sharing defaults — Fields" });
    await expect(personal()).toBeVisible();
    await expect(
      personal().getByRole("radio", { name: "Explicit policy…", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      personal().locator(`[data-grant="household"][data-principal="${HOME}"]`),
    ).toBeVisible();
    await expect(personal().locator("[data-layer-restored]")).toBeVisible();
    expect(served.management).toEqual([]);
    // Target isolation: another kind's form is another target and shows nothing kept; this kind's still has it.
    dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "People" }).click();
    await expect(dialog).toHaveAccessibleName("Sharing defaults — People");
    await expect(personal()).toBeVisible();
    await expect(personal().locator("[data-layer-restored]")).toHaveCount(0);
    await dialog.getByRole("tab", { name: "Fields" }).click();
    await expect(dialog).toHaveAccessibleName("Sharing defaults — Fields");
    dialog = page.getByRole("dialog", { name: "Sharing defaults — Fields" });
    await expect(personal().locator("[data-layer-restored]")).toBeVisible();
    await personal().locator('[data-save="personal"]').click();
    await expect.poll(() => served.management.length).toBe(1);
    expect(served.management[0]?.body).toEqual({
      commands: [
        {
          kind: "set_defaults",
          household_id: null,
          resource_kind: "field",
          expected_version: 0,
          template: {
            kind: "explicit",
            policy: {
              grants: [{ kind: "household", id: HOME, edit: false }],
              exclude_accounts: [],
            },
          },
        },
      ],
    });
    // Control: Done discards KEPT choices. Kept again through the sync control and shown again, then Done: reopened in the same page
    // (a reload would forget anything kept anyway), nothing kept is shown.
    await navigateInApp(page, "/sharing/defaults?kind=field");
    dialog = page.getByRole("dialog", { name: "Sharing defaults — Fields" });
    await privateChoice().click();
    await dialog.locator("[data-sync-tone]").click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/sync/);
    await page.goBack();
    dialog = page.getByRole("dialog", { name: "Sharing defaults — Fields" });
    await expect(personal().locator("[data-layer-restored]")).toBeVisible();
    await expect(privateChoice()).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/sharing$/);
    await navigateInApp(page, "/sharing/defaults?kind=field");
    dialog = page.getByRole("dialog", { name: "Sharing defaults — Fields" });
    await expect(personal()).toBeVisible();
    await expect(privateChoice()).toHaveAttribute("aria-checked", "false");
    await expect(personal().locator("[data-layer-restored]")).toHaveCount(0);
    recordEvidence(info, "e-sh11", { management: served.management });
  });
});

// ---- WEB-12a review 2 (R5): a dismissal discards what the session kept, whatever is on screen -----------------------------------------
/** The in-dialog sync control: keeps what the editor shows and opens the queue. */
async function keepThroughSync(page: Page): Promise<void> {
  await page.getByRole("dialog").locator("[data-sync-tone]").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page).toHaveURL(/\/sync/);
}
/** The editor closed itself (its close navigates to /sharing): wait for that navigation before navigating again (WebKit, cycle 1). */
async function closedToSharing(page: Page): Promise<void> {
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page).toHaveURL(/\/sharing$/);
}
/** The browser's own connectivity (navigator.onLine follows it), so a remounted boundary sees it (review 2's corrected precondition). */
async function connectivity(
  context: BrowserContext,
  page: Page,
  online: boolean,
): Promise<void> {
  await context.setOffline(!online);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(online);
}

test.describe("E-SH12: the policy editor's dismissal discards a kept draft even before its read lands (R5, review 2)", () => {
  test("kept Read → Edit; reopened with GET /policies held: released, the kept draft is restored (control); kept again, reopened held and Escape: released and reopened, the read policy is shown; a page reload keeps nothing; nothing was saved", async ({
    context,
  }, info) => {
    const { served, page } = await setup(context, `/sharing/items/${RID}`);
    const dialog = () => page.getByRole("dialog", { name: editorTitle });
    const choice = (name: "Read" | "Edit") =>
      dialog()
        .getByRole("radiogroup", { name: "Home: Read or Edit" })
        .getByRole("radio", { name, exact: true });
    let release: () => void = () => undefined;
    let requested = 0;
    /** Holds the next GET /policies/{id} until `release`. */
    const holdNextRead = async () => {
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      requested = 0;
      await context.route(
        `**${API}/policies/${RID}`,
        async (route) => {
          requested += 1;
          await gate;
          await route.fulfill(json(200, served.policy));
        },
        { times: 1 },
      );
    };
    await expect(dialog().locator("[data-audience]")).toBeVisible();
    await choice("Edit").click();
    await keepThroughSync(page);
    // Control: the held reopening restores the kept draft once its read lands.
    await holdNextRead();
    await navigateInApp(page, `/sharing/items/${RID}`);
    await expect(dialog()).toBeVisible();
    await expect.poll(() => requested).toBe(1);
    await expect(dialog().locator("[data-audience]")).toHaveCount(0);
    release();
    await expect(dialog().locator("[data-policy-restored]")).toBeVisible();
    await expect(choice("Edit")).toHaveAttribute("aria-checked", "true");
    // Kept again; reopened with the read held, then dismissed by Escape before it lands.
    await keepThroughSync(page);
    await holdNextRead();
    await navigateInApp(page, `/sharing/items/${RID}`);
    await expect(dialog()).toBeVisible();
    await expect.poll(() => requested).toBe(1);
    await expect(dialog().locator("[data-audience]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await closedToSharing(page);
    release();
    await navigateInApp(page, `/sharing/items/${RID}`);
    await expect(dialog().locator("[data-audience]")).toBeVisible();
    await expect(choice("Read")).toHaveAttribute("aria-checked", "true");
    await expect(dialog().locator("[data-policy-restored]")).toHaveCount(0);
    // Lifetime boundary: kept again, then the page is loaded again. Kept input lives in the page's memory only (no storage), so the
    // reloaded editor starts from the read policy; nothing was sent.
    await choice("Edit").click();
    await keepThroughSync(page);
    await reopen(page, `/sharing/items/${RID}`);
    await expect(dialog().locator("[data-audience]")).toBeVisible();
    await expect(choice("Read")).toHaveAttribute("aria-checked", "true");
    await expect(dialog().locator("[data-policy-restored]")).toHaveCount(0);
    expect(served.management).toEqual([]);
    recordEvidence(info, "e-sh12", { management: served.management });
  });
});

test.describe("E-SH13: the defaults editor's Done discards every kept choice, offline or on another kind (R5, review 2)", () => {
  test("kept Private; reopened offline (no forms) and back online without Done, it is restored (control); kept again, reopened offline and Done: back online it is gone. Kept again; Fields → Tasks → Fields restores it (control); Tasks then Done: Fields shows the stored template", async ({
    context,
  }, info) => {
    const path = "/sharing/defaults?kind=field";
    const { served, page } = await setup(context, path, { resource: false });
    const dialog = () => page.getByRole("dialog");
    const personal = () => dialog().locator('[data-layer-form="personal"]');
    const privateChoice = () =>
      personal().getByRole("radio", { name: "Private", exact: true });
    const done = () => dialog().getByRole("button", { name: "Done" }).click();
    const keepPrivate = async () => {
      await privateChoice().click();
      await keepThroughSync(page);
    };
    await keepPrivate();
    // Control: reopened offline (the read-only snapshot, no form), then back online in the open editor: the kept choice returns.
    await connectivity(context, page, false);
    await navigateInApp(page, path);
    await expect(dialog().locator("[data-defaults-offline]")).toBeVisible();
    await expect(personal()).toHaveCount(0);
    await connectivity(context, page, true);
    await expect(personal().locator("[data-layer-restored]")).toBeVisible();
    await expect(privateChoice()).toHaveAttribute("aria-checked", "true");
    // Kept again; reopened offline and Done with no form on screen.
    await keepThroughSync(page);
    await connectivity(context, page, false);
    await navigateInApp(page, path);
    await expect(dialog().locator("[data-defaults-offline]")).toBeVisible();
    await expect(personal()).toHaveCount(0);
    await done();
    await closedToSharing(page);
    await connectivity(context, page, true);
    await navigateInApp(page, path);
    await expect(personal()).toBeVisible();
    await expect(privateChoice()).toHaveAttribute("aria-checked", "false");
    await expect(personal().locator("[data-layer-restored]")).toHaveCount(0);
    // Control: kept, then Fields → Tasks → Fields without a dismissal gives it back.
    await keepPrivate();
    await navigateInApp(page, path);
    await expect(personal().locator("[data-layer-restored]")).toBeVisible();
    await dialog().getByRole("tab", { name: "Tasks", exact: true }).click();
    await expect(dialog()).toHaveAccessibleName("Sharing defaults — Tasks");
    await expect(personal().locator("[data-layer-restored]")).toHaveCount(0);
    await dialog().getByRole("tab", { name: "Fields", exact: true }).click();
    await expect(dialog()).toHaveAccessibleName("Sharing defaults — Fields");
    await expect(personal().locator("[data-layer-restored]")).toBeVisible();
    await expect(privateChoice()).toHaveAttribute("aria-checked", "true");
    // Then Tasks and Done: the Fields choice kept earlier is discarded too.
    await dialog().getByRole("tab", { name: "Tasks", exact: true }).click();
    await expect(dialog()).toHaveAccessibleName("Sharing defaults — Tasks");
    await done();
    await closedToSharing(page);
    await navigateInApp(page, path);
    await expect(dialog()).toHaveAccessibleName("Sharing defaults — Fields");
    await expect(personal()).toBeVisible();
    await expect(privateChoice()).toHaveAttribute("aria-checked", "false");
    await expect(personal().locator("[data-layer-restored]")).toHaveCount(0);
    expect(served.management).toEqual([]);
    recordEvidence(info, "e-sh13", { management: served.management });
  });
});

// ---- WEB-12a review 3 (R8): a Try again that is not sent proves nothing about the earlier request -----------------------------------
test.describe("E-SH14: an unresolved household create is kept across the browser going offline (R8, review 3)", () => {
  test("the create's response is lost (uncertain); offline, Try again and Create are disabled and nothing is sent; back online Create stays blocked and Try again sends the SAME key and body; its receipt frees Create, whose next create is a new command", async ({
    context,
  }, info) => {
    const { served, page } = await setup(context, "/sharing", {
      resource: false,
    });
    const create = page.getByRole("button", {
      name: "Create household",
      exact: true,
    });
    // The unresolved attempt's own Try again (a failed list read has its own "Try again" in another banner).
    const retry = page
      .locator("[data-sharing-banner]")
      .filter({ hasText: "We couldn't confirm the change was saved" })
      .getByRole("button", { name: "Try again", exact: true });
    // Precondition: the households and invitations have been read, so going offline cannot interrupt a read still under way
    // (WebKit fails such a read, campaign 1 of revision 3; nothing here is about reads).
    await expect(page.locator("[data-household]")).toHaveCount(1);
    await expect(page.getByText("No pending invitations")).toBeVisible();
    await page
      .getByLabel("Household name", { exact: true })
      .fill("Review household");
    served.managementScript.push("abort");
    await create.click();
    await expect(retry).toBeVisible();
    expect(served.management).toHaveLength(1);
    const original = structuredClone(served.management[0]);
    // The browser's own connectivity, as the person would lose it.
    await connectivity(context, page, false);
    await expect(retry).toBeDisabled();
    await expect(create).toBeDisabled();
    await retry.click({ force: true });
    await connectivity(context, page, true);
    // Asserted before anything else is clicked: no request was made offline, and the earlier one is still the one to resolve.
    expect(served.management).toHaveLength(1);
    await expect(create).toBeDisabled();
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect.poll(() => served.management.length).toBe(2);
    expect(served.management[1]).toEqual(original);
    await expect(retry).toHaveCount(0);
    await expect(create).toBeEnabled();
    await page.getByLabel("Household name", { exact: true }).fill("Another");
    await create.click();
    await expect.poll(() => served.management.length).toBe(3);
    expect(served.management[2]?.key).not.toBe(original?.key);
    recordEvidence(info, "e-sh14", { management: served.management });
  });
});

test.describe("E-SH15: a defaults answer belongs to the database it was asked under (A10; R10, review 4)", () => {
  type Acquired = { outcome: string; record: unknown };
  /**
   * The page's PRODUCTION controller (the harness's gate) with its PRODUCTION defaults source over the account's real database, and every
   * `GET /defaults/snapshot` held until the spec releases it with a revision. The page shows the task list, which reads no defaults of its
   * own. (Labelled adaptation, WEB-10a revision 2: this was Today, a placeholder when the case was written; WEB-10a's Today reads the
   * defaults for its quick actions, so its own `GET /defaults/snapshot` was held here and released in place of the gate's. The intent, a page
   * that asks for no defaults itself, is unchanged; the assertions are unchanged.)
   */
  async function heldDefaults(context: BrowserContext) {
    const { page } = await setup(context, "/tasks");
    const held: Array<(revision: number) => void> = [];
    await context.route(`**${API}/defaults/snapshot`, async (route) => {
      const revision = await new Promise<number>((resolve) =>
        held.push(resolve),
      );
      await route.fulfill(json(200, snapshotOf(rev(revision))));
    });
    await page.evaluate(
      (a) => window.__atlasData?.startGate(a, { defaults: true }),
      ACCOUNT,
    );
    const incarnation = await page.evaluate(() =>
      window.__atlasData?.gateIncarnation(),
    );
    expect(incarnation).toBeTruthy();
    return { page, held, incarnation: incarnation as string };
  }
  /** Asks the gate's source for a snapshot issued now; the acquisition is kept on the page until `acquired` collects it. */
  const acquire = (page: Page) =>
    page.evaluate(() => {
      const defaults = window.__atlasData?.gateDefaults();
      if (!defaults) throw new Error("no gate defaults");
      (window as unknown as { eSh15?: Promise<unknown> }).eSh15 =
        defaults.acquire(defaults.boundary());
    });
  const acquired = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { eSh15?: Promise<unknown> }).eSh15,
    ) as Promise<Acquired>;
  /** The record persisted in the account's database now, read through the harness's own connection (it never creates one). */
  const storedRevision = async (page: Page) => {
    const found = await page.evaluate(async (a) => {
      const h = window.__atlasData;
      if (!h) throw new Error("no harness");
      h.setIdentity(a);
      const opened = await h.open(a);
      return {
        opened,
        revision:
          (await h.defaultsRecord(a))?.snapshot.defaults.revision ?? null,
      };
    }, ACCOUNT);
    // A refused open (the page's registry closed under the harness) is not a database to read: say so, not "no open store" later.
    expect(found.opened).not.toMatch(/^absent$|^refused/);
    return found.revision;
  };
  /** The account's database deleted and created again (a new incarnation) by `by`, then the controller of `page` looks again. */
  async function replaceDatabase(page: Page, by: Page, before: string) {
    const replaced = await by.evaluate(async (a) => {
      const h = window.__atlasData;
      if (!h) throw new Error("no harness");
      h.stopSync();
      await h.ports.database.closeOwnConnections(a);
      const deleted = await h.ports.database.delete(a);
      h.close(a);
      h.setIdentity(a);
      const opened = await h.open(a, { create: true });
      return {
        deleted,
        opened,
        incarnation: h.incarnation(a),
        stored: await h.defaultsRecord(a),
      };
    }, ACCOUNT);
    expect(replaced.deleted).toMatch(/deleted/);
    // An explicit creation answers `created` (review 4's corrected harness expectation), never `opened`.
    expect(replaced.opened).toBe("created");
    expect(replaced.incarnation).not.toBe(before);
    expect(replaced.stored).toBeNull();
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.gateIncarnation()))
      .toBe(replaced.incarnation);
    return replaced.incarnation as string;
  }

  test("control: an answer whose database stands is persisted into the incarnation it was asked under, and returned", async ({
    context,
  }, info) => {
    const { page, held, incarnation } = await heldDefaults(context);
    await acquire(page);
    await expect.poll(() => held.length).toBe(1);
    held.shift()?.(44);
    const got = await acquired(page);
    expect(got.outcome).toBe("fetched");
    expect(await storedRevision(page)).toBe(rev(44));
    expect(
      await page.evaluate(() => window.__atlasData?.gateIncarnation()),
    ).toBe(incarnation);
    recordEvidence(info, "e-sh15-control", { incarnation, got: got.outcome });
  });

  test("an answer asked before this page's database was deleted and created again is never written into the replacement; a fresh one is", async ({
    context,
  }, info) => {
    const { page, held, incarnation } = await heldDefaults(context);
    await acquire(page);
    await expect.poll(() => held.length).toBe(1);
    const release = held.shift();
    const replacement = await replaceDatabase(page, page, incarnation);
    release?.(44);
    const got = await acquired(page);
    // Asserted on the database first: the forbidden write is what review 4 observed in every engine.
    expect(await storedRevision(page)).toBeNull();
    expect(got).toEqual({ outcome: "closed", record: null });
    expect(
      await page.evaluate(() => window.__atlasData?.gateDefaults()?.revision()),
    ).toBeNull();
    // A fresh request, asked under the replacement, is persisted into it.
    await acquire(page);
    await expect.poll(() => held.length).toBe(1);
    held.shift()?.(45);
    expect((await acquired(page)).outcome).toBe("fetched");
    expect(await storedRevision(page)).toBe(rev(45));
    recordEvidence(info, "e-sh15-replaced", {
      before: incarnation,
      after: replacement,
      late: got,
    });
  });

  test("another page deletes and recreates the database while this page's answer is held: the answer is never written into the replacement", async ({
    context,
  }, info) => {
    const { page, held, incarnation } = await heldDefaults(context);
    await acquire(page);
    await expect.poll(() => held.length).toBe(1);
    const release = held.shift();
    // A page that reads no defaults of its own (labelled adaptation, revision 2 of WEB-10a: was Today, see `heldDefaults`).
    const other = await bootAt(context, "/tasks");
    const replacement = await replaceDatabase(page, other, incarnation);
    release?.(44);
    const got = await acquired(page);
    expect(await storedRevision(other)).toBeNull();
    expect(got).toEqual({ outcome: "closed", record: null });
    // Durable state, read by a page that loads afresh.
    const fresh = await bootAt(context, "/tasks");
    // A page that has just booted remounts its tree once (WEB-09a r19/r23), and that disposal closes the page's registry, the harness's
    // store included (revision 5: reproduced in Firefox, a `closed_for_deletion` from the tree's dispose 131 ms after boot, then "no open
    // store"). The harness reads only once the page has settled (no binding required). `other` above keeps its original schedule: there
    // the replacement itself makes its tree remount, so waiting first only moves that disposal onto the read (diagnosed, not adopted).
    await untilTreeSettled(fresh, { account: ACCOUNT, connections: 0 });
    expect(await storedRevision(fresh)).toBeNull();
    recordEvidence(info, "e-sh15-other-page", {
      before: incarnation,
      after: replacement,
      late: got,
    });
  });
});

test.describe("E-SH16: household choices and names come from the complete membership list, not B5's subset (A4; R11, review 5)", () => {
  /** A household you are in that no resolved default names: the complete list has it, B5 does not. */
  const second = {
    id: ELSEWHERE,
    name: "Second household",
    version: 1,
    role: "member",
    members: [
      { account_id: ACCOUNT, username: "me", role: "member" },
      { account_id: PRIYA, username: "priya", role: "manager" },
    ],
  };
  const grantingSecond = {
    kind: "explicit",
    policy: {
      grants: [{ kind: "household", id: ELSEWHERE, edit: false }],
      exclude_accounts: [],
    },
  };
  /** The B5 answer names only Home (fixture contract: the stub's two endpoints really differ here). */
  const b5Households = (served: Served) =>
    (served.snapshot as { households: Array<{ id: string }> }).households.map(
      (household) => household.id,
    );

  for (const layer of ["personal", "household"] as const)
    test(`${layer} layer: a membership B5 does not name is offered beside Home, and the save sends it at that layer's version`, async ({
      context,
    }, info) => {
      const { served, page } = await setup(
        context,
        "/sharing/defaults?kind=field",
        {
          resource: false,
          arrange: (served) => {
            served.memberships = [homeHousehold(), second];
            served.templates = scope({ field: { template: null, version: 6 } });
          },
        },
      );
      expect(b5Households(served)).toEqual([HOME]);
      const dialog = page.getByRole("dialog", {
        name: "Sharing defaults — Fields",
      });
      const form = dialog.locator(`[data-layer-form="${layer}"]`);
      await form.getByRole("radio", { name: "Explicit policy…" }).click();
      await form.getByRole("button", { name: "+ Add household grant" }).click();
      const picker = form.locator("[data-household-picker]");
      // Control and requirement together: Home (which B5 names) and Second household (which it does not) are both offered.
      await expect(picker.getByRole("button")).toHaveText([
        "Home",
        "Second household",
        "Cancel",
      ]);
      await picker.getByRole("button", { name: "Second household" }).click();
      await form.locator(`[data-save="${layer}"]`).click();
      await expect.poll(() => served.management.length).toBe(1);
      expect(served.management[0]?.body).toEqual({
        commands: [
          {
            kind: "set_defaults",
            household_id: layer === "personal" ? null : HOME,
            resource_kind: "field",
            expected_version: layer === "personal" ? 6 : 4,
            template: grantingSecond,
          },
        ],
      });
      expect(served.membershipReads).toBeGreaterThanOrEqual(1);
      recordEvidence(info, `e-sh16-${layer}`, {
        management: served.management,
        membershipReads: served.membershipReads,
      });
    });

  test("an overridden household template's grant of a household you are in is named (B5 omits it); with no primary household it is still offered", async ({
    context,
  }, info) => {
    const { served, page } = await setup(
      context,
      "/sharing/defaults?kind=field",
      {
        resource: false,
        arrange: (served) => {
          served.memberships = [homeHousehold(), second];
          // The personal layer overrides the household template, so the resolved field default is Private and B5 names only Home.
          served.templates = scope({
            field: { template: { kind: "private" }, version: 2 },
          });
          served.householdTemplates = scope({
            field: { template: grantingSecond, version: 5 },
          });
        },
      },
    );
    expect(b5Households(served)).toEqual([HOME]);
    const dialog = page.getByRole("dialog", {
      name: "Sharing defaults — Fields",
    });
    const household = dialog.locator('[data-layer-form="household"]');
    await expect(
      household.locator(
        `[data-grant="household"][data-principal="${ELSEWHERE}"]`,
      ),
    ).toContainText("Second household");
    await expect(household).not.toContainText("A household you're not in");
    // No primary household and private defaults: B5 names no household, and your memberships are still offered.
    served.snapshot = snapshotOf(
      rev(2),
      {
        primary_household_id: null,
        person: { kind: "private" },
        progress: { kind: "private" },
      },
      [],
    );
    served.memberships = [second];
    await reopen(page, "/sharing/defaults?kind=field");
    const reopened = page.getByRole("dialog", {
      name: "Sharing defaults — Fields",
    });
    await expect(reopened.locator('[data-layer="household"]')).toContainText(
      "You don't have a primary household",
    );
    const personal = reopened.locator('[data-layer-form="personal"]');
    await personal.getByRole("radio", { name: "Explicit policy…" }).click();
    await personal
      .getByRole("button", { name: "+ Add household grant" })
      .click();
    await expect(
      personal.locator("[data-household-picker]").getByRole("button"),
    ).toHaveText(["Second household", "Cancel"]);
    recordEvidence(info, "e-sh16-labels", {
      membershipReads: served.membershipReads,
    });
  });

  test("the policy editor: a refused membership read is unchecked (never 'not in'); its own Try again reads only the list and names the household", async ({
    context,
  }, info) => {
    const { served, page } = await setup(context, `/sharing/items/${RID}`, {
      arrange: (served) => {
        served.refuseMemberships = {
          status: 503,
          body: atlas("unavailable", "d3a10000-0000-4000-8000-000000000000"),
        };
      },
    });
    const dialog = page.getByRole("dialog", { name: editorTitle });
    const failed = dialog.locator('[data-membership="failed"]');
    await expect(failed).toContainText("Couldn't load your households.");
    const grant = dialog.locator(
      `[data-grant="household"][data-principal="${HOME}"]`,
    );
    await expect(grant).toContainText("A household (name not loaded)");
    const audience = dialog.locator("[data-audience]");
    await expect(audience).toContainText(
      "Members of 1 household that couldn't be loaded",
    );
    await expect(audience).not.toContainText("you're not in");
    await expect(
      dialog.getByRole("button", { name: "+ Add household grant" }),
    ).toBeDisabled();
    // Two readers asked once each and were refused: the editor and the Sharing page's household demonstration beneath it.
    await expect.poll(() => served.membershipReads).toBe(2);
    expect(served.policyReads).toBe(1);
    served.refuseMemberships = null;
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(grant).toContainText("Home");
    await expect(failed).toHaveCount(0);
    await expect(audience).toContainText("Can read: sam");
    // The editor's Try again read the list once more, and nothing else: not the policy.
    expect(served.membershipReads).toBe(3);
    expect(served.policyReads).toBe(1);
    expect(served.management).toEqual([]);
    recordEvidence(info, "e-sh16-policy", {
      membershipReads: served.membershipReads,
      policyReads: served.policyReads,
    });
  });
});

test.describe("E-SH17: a household template that could not be read is unknown, never Private (A4; R12, review 6)", () => {
  const HOME_READ = "Primary household “Home” · read";
  const unknownPreview =
    "What new records of this kind would start as isn't known yet: the household default hasn't loaded. Existing records are never changed by this edit.";
  /** Fields: Home's template is shared (read) at version 7 and every household-template read is refused with a 503 until cleared. */
  async function refused(context: BrowserContext, personalOverride: boolean) {
    const { served, page } = await setup(
      context,
      "/sharing/defaults?kind=field",
      {
        resource: false,
        arrange: (served) => {
          served.snapshot = snapshotOf(rev(31), {
            field: personalOverride
              ? { kind: "private" }
              : { kind: "primary_household", edit: false },
          });
          served.templates = scope({
            field: personalOverride
              ? { template: { kind: "private" }, version: 5 }
              : { template: null, version: 0 },
          });
          served.householdTemplates = scope({
            field: {
              template: { kind: "primary_household", edit: false },
              version: 7,
            },
          });
          served.refuseHouseholdTemplates = {
            status: 503,
            body: atlas("temporarily_unavailable"),
          };
        },
      },
    );
    const dialog = page.getByRole("dialog", {
      name: "Sharing defaults — Fields",
    });
    const household = dialog.locator('[data-layer="household"]');
    // The state the assertions are about: the refused read is on screen as a failure, and the personal layer has been read.
    await expect(
      household.locator('[data-sharing-banner="error"]'),
    ).toContainText("Couldn't load the current templates.");
    await expect(dialog.locator("[data-personal-state]")).toBeVisible();
    expect(served.householdTemplateReads).toBeGreaterThanOrEqual(1);
    return { served, page, dialog, household };
  }

  test("E-SH17: no personal override: the personal row, the chain and Inherit say what is unknown; once read, they name Home", async ({
    context,
  }, info) => {
    const { served, dialog, household } = await refused(context, false);
    const personalState = await dialog
      .locator("[data-personal-state]")
      .textContent();
    const current = await dialog
      .locator('[data-chain][aria-current="true"]')
      .count();
    const inheritLabel = await dialog
      .locator('[data-layer-form="personal"]')
      .getByRole("radio", { name: /^Inherit household default/ })
      .textContent();
    recordEvidence(info, "e-sh17-unknown", {
      personalState,
      current,
      inheritLabel,
      householdTemplateReads: served.householdTemplateReads,
    });
    expect(personalState).toBe(
      "No personal override set — what it inherits isn't known yet: the household default hasn't loaded (version 0)",
    );
    expect(current).toBe(0);
    expect(inheritLabel).toBe(
      "Inherit household default (currently: not loaded)",
    );
    // Control: read, the same editor resolves the household layer and names Home; the Try again is the one further read.
    const before = served.householdTemplateReads;
    served.refuseHouseholdTemplates = null;
    await household.getByRole("button", { name: "Try again" }).click();
    await expect(dialog.locator('[data-chain="household"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(dialog.locator("[data-personal-state]")).toHaveText(
      `No personal override set — inherits ${HOME_READ} (version 0)`,
    );
    expect(served.householdTemplateReads).toBe(before + 1);
    expect(served.management).toEqual([]);
  });

  test("E-SH17: removing a personal override while it is unknown previews nothing false and sends nothing; once read, the same choice saves template:null at the PERSONAL version", async ({
    context,
  }, info) => {
    const { served, dialog, household } = await refused(context, true);
    const personal = dialog.locator('[data-layer-form="personal"]');
    // Control: the personal layer's own template is known, so the layer that resolves is known.
    await expect(dialog.locator("[data-personal-state]")).toHaveText(
      "Private (your own override, version 5)",
    );
    await expect(dialog.locator('[data-chain="personal"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    const inherit = personal.getByRole("radio", {
      name: /^Inherit household default/,
    });
    expect(await inherit.textContent()).toBe(
      "Inherit household default (currently: not loaded)",
    );
    await inherit.click();
    const preview = await personal.locator("[data-preview]").textContent();
    const save = personal.locator('[data-save="personal"]');
    const disabled = await save.isDisabled();
    recordEvidence(info, "e-sh17-waits", { preview, disabled });
    expect(preview).toBe(unknownPreview);
    expect(disabled).toBe(true);
    expect(served.management).toEqual([]);
    served.refuseHouseholdTemplates = null;
    await household.getByRole("button", { name: "Try again" }).click();
    await expect(personal.locator("[data-preview]")).toHaveText(
      `New records of this kind would start as: Inherit household default (currently: ${HOME_READ}). Existing records are never changed by this edit.`,
    );
    // The read did not reset the choice.
    await expect(
      personal.getByRole("radio", {
        name: `Inherit household default (currently: ${HOME_READ})`,
      }),
    ).toBeChecked();
    await save.click();
    await expect.poll(() => served.management.length).toBe(1);
    expect(served.management[0]?.body).toEqual({
      commands: [
        {
          kind: "set_defaults",
          household_id: null,
          resource_kind: "field",
          expected_version: 5,
          template: null,
        },
      ],
    });
    recordEvidence(info, "e-sh17-saved", {
      management: served.management,
      householdTemplateReads: served.householdTemplateReads,
    });
  });
});
