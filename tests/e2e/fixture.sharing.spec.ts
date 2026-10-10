import {
  type BrowserContext,
  expect,
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
 * keyboard-only journey; E-SH8 the viewports.
 */
const API = "/api/experimental/v1";
const RID = "55555555-5555-4555-8555-555555555555";
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
    if (path === "/defaults/templates")
      return route.fulfill(
        json(
          200,
          url.searchParams.get("household_id")
            ? served.householdTemplates
            : served.templates,
        ),
      );
    if (path === `/policies/${RID}`)
      return route.fulfill(json(200, served.policy));
    if (path === "/households")
      return route.fulfill(
        json(200, (served.snapshot as { households: unknown }).households),
      );
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
  options: { resource?: boolean; arrange?: (served: Served) => void } = {},
) {
  const net = await stubNetwork(context);
  const served = await serveSharing(context);
  options.arrange?.(served);
  await seedSettled(context);
  const page = await bootAt(context, route);
  if (options.resource !== false) await cacheResource(page, net);
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
    expect(dialog.locator("[data-audience]")).toHaveCount(0);
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
    await expect(was).toContainText("Home: me, sam");
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
  for (const [width, height, name] of [
    [390, 844, "mobile"],
    [834, 1112, "tablet portrait"],
    [1112, 834, "tablet landscape"],
  ] as const)
    test(`${name} ${width}×${height}: the editor fits, has no horizontal overflow and keeps 44 px targets; below the tablet breakpoint it is full-bleed`, async ({
      context,
    }, info) => {
      const { page } = await setup(context, `/sharing/items/${RID}`);
      await page.setViewportSize({ width, height });
      const dialog = page.getByRole("dialog", { name: editorTitle });
      await expect(dialog.locator("[data-audience]")).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      if (width < 768) {
        expect(Math.round(box?.width ?? 0)).toBe(width);
        expect(Math.round(box?.x ?? -1)).toBe(0);
      } else {
        expect(
          (box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width,
        ).toBe(true);
      }
      const overflow = await dialog.evaluate(
        (el) => el.scrollWidth - el.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const small = await dialog.evaluate((el) =>
        [...el.querySelectorAll<HTMLElement>("button, [role=radio], a, input")]
          .filter((c) => c.offsetParent !== null)
          .map((c) => ({
            name: c.getAttribute("aria-label") ?? c.textContent?.trim() ?? "",
            h: c.getBoundingClientRect().height,
          }))
          .filter((c) => c.h < 44),
      );
      recordEvidence(info, `e-sh8-${width}`, { box, overflow, small });
      expect(small).toEqual([]);
    });
});
