import { readFileSync, writeFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import {
  ACCOUNTS,
  bootHarness,
  expect,
  exposeSession,
  paceSignIn,
  proxy,
  signIn as signInUnpaced,
  stackFile,
  test,
  untilView,
  type Who,
} from "./helpers";
import { previewStatus } from "./web08b-support";

/**
 * WEB-12a against the RELEASED backend (v0.27.0-rc.1, whose contract already has B5, Q1 and CH1) on a disposable SQLite database, behind the
 * delaying proxy: the production session, the production data controller (its defaults source and W14) and the sharing screens, with the
 * FIXTURE test leader standing in for WEB-09b's production leadership. FOCUSED REAL-BACKEND EVIDENCE for a fixture-stage task: the
 * integration gates BE-Q1, BE-B5 and BE-CH1 have no formal completion record, so this is NOT integration acceptance (`integration_passed`
 * stays false). No PostgreSQL, HTTPS or device is exercised.
 *
 * I-SH1 a generic cached resource opens in the editor and a policy change commits (A1); I-SH2 SHARE-9 (a) (A2); I-SH3 SHARE-9 (b) and the
 * editor's conflict (A3); I-SH4 the B5 record and the defaults editor (A4); I-SH5 a real `defaults_changed`, reviewed and confirmed (A5);
 * I-SH6 a lost response retried with the same key and no duplicate (A6); I-SH7 the household demonstration (A8); I-SH8 owner-only (A7).
 * Review 5: I-SH9 a household you are in that B5 does not name (the real `GET /households` and B5 differ) is offered by the defaults
 * editor and saved at the layer's version (A4; R11).
 */
const API = "/api/experimental/v1";

// Sign-in pacing shared with integration.data.spec.ts (the same ledger file per stack): at most 8 attempts per account a minute.
const budget = (who: Who) => paceSignIn(who);
const ROTATION: Who[] = ["alice", "carol", "dave", "erin"];
const ROTATION_FILE = stackFile("atlas-account-rotation.txt");
let main: Who = "alice";
test.beforeEach(async ({ context }, info) => {
  void context;
  let n = 0;
  try {
    n = Number(readFileSync(ROTATION_FILE, "utf8")) || 0;
  } catch {
    n = 0;
  }
  writeFileSync(ROTATION_FILE, String(n + 1));
  main = ROTATION[n % ROTATION.length] as Who;
  info.setTimeout(120_000);
});

interface Id {
  account_id: string;
  epoch: number;
}
async function signedIn(page: Page, who: Who): Promise<Id> {
  await budget(who);
  expect((await signInUnpaced(page, who)).kind).toBe("settled");
  await untilView(page, "displaying");
  const id = (await page.evaluate(() =>
    window.__s.identity.get(),
  )) as Id | null;
  if (!id) throw new Error("no identity after sign-in");
  return id;
}

/** The fixture leader: the account's database arranged by the seeder, the outbox dispatcher and the sync engine started. */
async function leader(page: Page, account: string): Promise<void> {
  await page.evaluate((a) => window.__atlasData?.prepareAccount(a), account);
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(a, {});
    await data.startSync(a);
  }, account);
}

/** In-app navigation of the protected tree (the router follows the browser history). */
const go = (page: Page, path: string) =>
  page.evaluate((p) => {
    history.pushState(null, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);

interface Raw {
  status: number;
  body: unknown;
}
/** One stamped request made in the page (the session's own client), asked again while the session answers `not_sent`. */
const raw = (
  page: Page,
  id: Id,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  key?: string,
) =>
  page.evaluate(
    async ({ id, method, path, body, key }) => {
      const fetchFor = window.__s.api.fetchFor(
        "ordinary",
        id.account_id,
        id.epoch,
      );
      for (let attempt = 0; ; attempt += 1) {
        try {
          const response = await fetchFor(
            new Request(`${location.origin}/api/experimental/v1${path}`, {
              method,
              headers: {
                ...(body === undefined
                  ? {}
                  : { "content-type": "application/json" }),
                ...(key ? { "Idempotency-Key": key } : {}),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
          const text = await response.text();
          return {
            status: response.status,
            body: text ? JSON.parse(text) : null,
          };
        } catch (error) {
          if (
            !String((error as { kind?: string }).kind ?? error).includes(
              "not_sent",
            ) ||
            attempt >= 60
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
    { id, method, path, body, key },
  ) as Promise<Raw>;

interface Projection {
  id: string;
  version: number;
  policy_version?: number;
  label: string;
}
const person = async (
  page: Page,
  id: Id,
  rid: string,
): Promise<Projection | undefined> => {
  const listed = await raw(page, id, "GET", "/people");
  return ((listed.body as { items?: Projection[] }).items ?? []).find(
    (p) => p.id === rid,
  );
};
const policyOf = async (page: Page, id: Id, rid: string) =>
  (await raw(page, id, "GET", `/policies/${rid}`)) as {
    status: number;
    body: {
      version: number;
      policy: {
        grants: Array<{ kind: string; id: string; edit: boolean }>;
        exclude_accounts: string[];
      };
    };
  };
const accountIdOf = async (
  page: Page,
  id: Id,
  username: string,
): Promise<string> => {
  const found = await raw(
    page,
    id,
    "GET",
    `/directory?username=${encodeURIComponent(username)}`,
  );
  const entry = (
    (found.body as Array<{ id: string; username: string }>) ?? []
  ).find((e) => e.username === username);
  if (!entry) throw new Error(`no directory entry for ${username}`);
  return entry.id;
};

/** A person created through the OUTBOX (a generic resource through the data layer), acknowledged and in the cache. */
async function createPerson(page: Page, id: Id, name: string): Promise<string> {
  const rid = crypto.randomUUID();
  const out = await page.evaluate(
    ({ rid, name }) =>
      window.__atlasData?.enqueue({
        endpoint: "/commands",
        targets: [
          {
            resourceId: rid,
            role: "primary",
            basis: "resource",
            versionChecked: false,
            seedIfUntracked: 1,
          },
        ],
        command: { commands: [{ kind: "create_person", id: rid, name }] },
        displayPatch: { [rid]: { label: name } },
      }),
    { rid, name },
  );
  expect(out?.kind).toBe("queued");
  await expect
    .poll(
      async () => {
        const rows = (await page.evaluate(
          (a) => window.__atlasData?.rows(a, "cache"),
          id.account_id,
        )) as Array<{ id: string }>;
        return rows.some((row) => row.id === rid);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return rid;
}

/** A content edit through the OUTBOX, guarded by the policy version read now (Q1), acknowledged. */
async function editContent(
  page: Page,
  id: Id,
  rid: string,
  label: string,
  policyVersion: number,
): Promise<void> {
  const out = await page.evaluate(
    ({ rid, label, pv }) =>
      window.__atlasData?.enqueue({
        endpoint: "/commands",
        targets: [
          {
            resourceId: rid,
            role: "primary",
            basis: "resource",
            versionChecked: true,
          },
        ],
        command: {
          commands: [
            {
              kind: "edit",
              id: rid,
              expected_version: { $base: rid },
              expected_policy_version: pv,
              label,
              value: "",
            },
          ],
        },
        displayPatch: { [rid]: { label } },
      }),
    { rid, label, pv: policyVersion },
  );
  expect(out?.kind).toBe("queued");
  await expect
    .poll(async () => (await person(page, id, rid))?.label, { timeout: 60_000 })
    .toBe(label);
}

/**
 * The page's own data controller looks for the account's database when the identity is displayed, which is BEFORE the fixture leader
 * creates it in this page: it would then hold no service (nothing tells it of a database made by the harness in the same page; production
 * has no leader at all until WEB-09b). So the page is loaded again once the database exists, and the controller binds it from the start;
 * the leader is restarted on the existing database (never re-seeded).
 */
async function reopenBound(
  page: Page,
  account: string,
  route: string,
): Promise<void> {
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await exposeSession(page);
  await untilView(page, "displaying");
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(a, {});
    await data.startSync(a);
  }, account);
}

/** The household the page's route names (`/sharing/households/<id>`), once the app has navigated there. */
async function householdIdFromUrl(page: Page): Promise<string> {
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
    .toMatch(/^\/sharing\/households\/[0-9a-f-]{36}/);
  return new URL(page.url()).pathname.split("/")[3] as string;
}

async function bootMain(context: BrowserContext, route = "/today") {
  const page = await bootHarness(context, "/today");
  const id = await signedIn(page, main);
  await leader(page, id.account_id);
  await reopenBound(page, id.account_id, route);
  return { page, id };
}

/** Every management-command request the PAGE sends, with its Idempotency-Key and body as the browser sent them. */
function recordManagement(
  page: Page,
): Array<{ key: string | null; body: string }> {
  const seen: Array<{ key: string | null; body: string }> = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `${API}/management-commands`
    )
      seen.push({
        key: request.headers()["idempotency-key"] ?? null,
        body: request.postData() ?? "",
      });
  });
  return seen;
}

const managementRequests = async () =>
  (await proxy.log()).filter(
    (e) => e.method === "POST" && e.path === `${API}/management-commands`,
  );

test.describe("I-SH1 and I-SH2: a generic resource in the editor, and SHARE-9 (a)", () => {
  test("a content edit leaves policy_version unchanged; the editor then commits replace_policy with that pre-edit version; a grant with a pre-edit version also succeeds", async ({
    context,
  }, info) => {
    const { page, id } = await bootMain(context);
    const bob = await accountIdOf(page, id, ACCOUNTS.bob.username);
    const rid = await createPerson(page, id, "I-SH Person");
    const before = await person(page, id, rid);
    const pv0 = before?.policy_version as number;
    expect(typeof pv0).toBe("number");
    expect((await policyOf(page, id, rid)).body.version).toBe(pv0);
    // SHARE-9 (a), first half: a content edit (Q1-guarded) leaves policy_version unchanged.
    await editContent(page, id, rid, "I-SH Renamed", pv0);
    const edited = await person(page, id, rid);
    expect(edited?.version).toBe((before?.version as number) + 1);
    expect(edited?.policy_version).toBe(pv0);
    expect((await policyOf(page, id, rid)).body.version).toBe(pv0);
    // I-SH1 / A1: the editor opens on the CACHED generic resource and commits through the online-only client.
    await go(page, `/sharing/items/${rid}`);
    const dialog = page.getByRole("dialog", { name: "Sharing — I-SH Renamed" });
    await expect(dialog.locator("[data-audience]")).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByRole("button", { name: "+ Add account grant" }).click();
    await dialog
      .getByRole("textbox", { name: "Exact username" })
      .fill(ACCOUNTS.bob.username);
    await dialog.getByRole("button", { name: "Look up" }).click();
    await dialog
      .getByRole("button", { name: `Choose: ${ACCOUNTS.bob.username}` })
      .click();
    await dialog.locator("[data-save]").click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // SHARE-9 (a), second half: the editor's replace_policy, sent with the PRE-EDIT policy version, succeeded.
    const after = await policyOf(page, id, rid);
    expect(after.body.version).toBe(pv0 + 1);
    expect(after.body.policy.grants).toContainEqual({
      kind: "account",
      id: bob,
      edit: false,
    });
    const sent = await managementRequests();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.status).toBe(200);
    // A grant with the pre-edit policy version, on a second generic resource, succeeds too.
    const other = await createPerson(page, id, "I-SH Other");
    const qv0 = (await person(page, id, other))?.policy_version as number;
    await editContent(page, id, other, "I-SH Other Renamed", qv0);
    const granted = await raw(
      page,
      id,
      "POST",
      "/access-commands",
      {
        commands: [
          {
            kind: "grant",
            id: other,
            expected_version: qv0,
            account_id: bob,
            edit: false,
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(granted.status).toBe(200);
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({
        pv0,
        after: after.body.version,
        qv0,
        grant: granted.status,
      }),
    });
  });
});

test.describe("I-SH3: SHARE-9 (b) and the editor's conflict", () => {
  test("a stale policy version on replace_policy and on grant is a conflict that leaves the content version unchanged; the editor shows the conflict and Reload", async ({
    context,
    provokes,
  }, info) => {
    provokes(409);
    const { page, id } = await bootMain(context);
    const bob = await accountIdOf(page, id, ACCOUNTS.bob.username);
    const rid = await createPerson(page, id, "I-SH Stale");
    const pv0 = (await person(page, id, rid))?.policy_version as number;
    const content = (await person(page, id, rid))?.version as number;
    const fresh = await raw(
      page,
      id,
      "POST",
      "/management-commands",
      {
        commands: [
          {
            kind: "replace_policy",
            id: rid,
            expected_version: pv0,
            policy: {
              grants: [{ kind: "account", id: bob, edit: false }],
              exclude_accounts: [],
            },
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(fresh.status).toBe(200);
    const staleReplace = await raw(
      page,
      id,
      "POST",
      "/management-commands",
      {
        commands: [
          {
            kind: "replace_policy",
            id: rid,
            expected_version: pv0,
            policy: { grants: [], exclude_accounts: [] },
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(staleReplace.status).toBe(409);
    expect((staleReplace.body as { code: string }).code).toBe("conflict");
    const staleGrant = await raw(
      page,
      id,
      "POST",
      "/access-commands",
      {
        commands: [
          {
            kind: "grant",
            id: rid,
            expected_version: pv0,
            account_id: bob,
            edit: true,
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(staleGrant.status).toBe(409);
    expect((staleGrant.body as { code: string }).code).toBe("conflict");
    // Neither changed the resource's CONTENT version, and the policy is the fresh one's.
    expect((await person(page, id, rid))?.version).toBe(content);
    expect((await policyOf(page, id, rid)).body.version).toBe(pv0 + 1);
    // The editor: opened at pv0 + 1, then the policy moves under it (another tab), so its save is refused, never overwriting.
    await go(page, `/sharing/items/${rid}`);
    const dialog = page.getByRole("dialog", { name: "Sharing — I-SH Stale" });
    await expect(dialog.locator("[data-audience]")).toBeVisible({
      timeout: 30_000,
    });
    const moved = await raw(
      page,
      id,
      "POST",
      "/management-commands",
      {
        commands: [
          {
            kind: "replace_policy",
            id: rid,
            expected_version: pv0 + 1,
            policy: { grants: [], exclude_accounts: [] },
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(moved.status).toBe(200);
    await dialog
      .getByRole("radiogroup", { name: /Read or Edit$/ })
      .first()
      .getByRole("radio", { name: "Edit" })
      .click();
    await dialog.locator("[data-save]").click();
    await expect(dialog).toContainText(
      "This policy changed since you opened it",
      { timeout: 30_000 },
    );
    await expect(dialog).toContainText(/Request ID: [0-9a-f-]{36}/);
    await dialog.getByRole("button", { name: "Reload" }).click();
    await expect(dialog).toContainText("Nobody else can see this.", {
      timeout: 30_000,
    });
    expect((await policyOf(page, id, rid)).body.version).toBe(pv0 + 2);
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({
        pv0,
        content,
        replace: staleReplace.status,
        grant: staleGrant.status,
      }),
    });
  });
});

test.describe("I-SH4: the B5 record and the defaults editor", () => {
  test("GET /defaults/snapshot is persisted as ONE record equal to the server's answer; a personal default saves with its own version; a stale one conflicts", async ({
    context,
    provokes,
  }, info) => {
    provokes(409);
    const { page, id } = await bootMain(context);
    await go(page, "/sharing");
    await expect(page.locator('[data-defaults-kind="field"]')).toBeVisible({
      timeout: 30_000,
    });
    const served = await raw(page, id, "GET", "/defaults/snapshot");
    await expect
      .poll(
        () =>
          page.evaluate(
            (a) =>
              window.__atlasData
                ?.defaultsRecord(a)
                .then((r) => r?.snapshot ?? null),
            id.account_id,
          ),
        { timeout: 30_000 },
      )
      .toEqual(served.body);
    const defaults = await raw(page, id, "GET", "/defaults");
    expect((defaults.body as { revision: string }).revision).toBe(
      (served.body as { defaults: { revision: string } }).defaults.revision,
    );
    await go(page, "/sharing/defaults?kind=field");
    const dialog = page.getByRole("dialog", {
      name: "Sharing defaults — Fields",
    });
    const personal = dialog.locator('[data-layer-form="personal"]');
    await personal
      .getByRole("radio", { name: "Primary household — read" })
      .click({ timeout: 30_000 });
    await personal.locator('[data-save="personal"]').click();
    await expect(dialog).toContainText(/your own override, version [1-9]/, {
      timeout: 30_000,
    });
    const templates = await raw(page, id, "GET", "/defaults/templates");
    const field = (
      templates.body as { field: { template: unknown; version: number } }
    ).field;
    expect(field.template).toEqual({ kind: "primary_household", edit: false });
    // The record follows the change (the editor asks for a fresh snapshot after a save).
    await expect
      .poll(
        () =>
          page.evaluate(
            (a) =>
              window.__atlasData
                ?.defaultsRecord(a)
                .then((r) => r?.snapshot.defaults.field ?? null),
            id.account_id,
          ),
        { timeout: 30_000 },
      )
      .toEqual({ kind: "primary_household", edit: false });
    const stale = await raw(
      page,
      id,
      "POST",
      "/management-commands",
      {
        commands: [
          {
            kind: "set_defaults",
            household_id: null,
            resource_kind: "field",
            expected_version: 0,
            template: { kind: "private" },
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(stale.status).toBe(409);
    expect((stale.body as { code: string }).code).toBe("conflict");
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({
        revision: (served.body as { defaults: { revision: string } }).defaults
          .revision,
        field,
      }),
    });
  });
});

test.describe("I-SH5: a real defaults_changed, reviewed and confirmed", () => {
  test("a queued create captured under revision R1 is refused when the defaults move to R2; the review shows Was/Now; Confirm supersedes it and it is created once", async ({
    context,
    provokes,
  }, info) => {
    provokes(409);
    const { page, id } = await bootMain(context);
    await go(page, "/sharing");
    await expect
      .poll(
        () =>
          page.evaluate(
            (a) =>
              window.__atlasData
                ?.defaultsRecord(a)
                .then((r) => r?.snapshot.defaults.revision ?? null),
            id.account_id,
          ),
        { timeout: 30_000 },
      )
      .not.toBeNull();
    const capture = await page.evaluate(
      (a) => window.__atlasData?.captureDefaults(a, ["person"]),
      id.account_id,
    );
    expect(capture?.kind).toBe("captured");
    expect(capture?.defaultsReview).toEqual([]);
    // The defaults move on the server (a personal override for people).
    const templates = await raw(page, id, "GET", "/defaults/templates");
    const moved = await raw(
      page,
      id,
      "POST",
      "/management-commands",
      {
        commands: [
          {
            kind: "set_defaults",
            household_id: null,
            resource_kind: "person",
            expected_version: (
              templates.body as { person: { version: number } }
            ).person.version,
            template: { kind: "private" },
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(moved.status).toBe(200);
    const rid = crypto.randomUUID();
    const queued = await page.evaluate(
      ({ rid, capture }) =>
        window.__atlasData?.enqueue({
          endpoint: "/commands",
          targets: [
            {
              resourceId: rid,
              role: "primary",
              basis: "resource",
              versionChecked: false,
              seedIfUntracked: 1,
            },
          ],
          command: {
            commands: [
              { kind: "create_person", id: rid, name: "I-SH Reviewed" },
            ],
            defaults_revision: capture?.defaultsRevision,
          },
          displayPatch: { [rid]: { label: "I-SH Reviewed" } },
          defaultsRevision: capture?.defaultsRevision ?? null,
          defaultsContext: capture?.defaultsContext as never,
          defaultsReview: capture?.defaultsReview,
        }),
      { rid, capture },
    );
    expect(queued?.kind).toBe("queued");
    // Sent, and refused: it is held for review, frozen.
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (a) => window.__atlasData?.queue(a),
              id.account_id,
            )) as Array<{
              local_id: string;
              status: string;
              review_block: boolean;
            }>
          ).find((r) => r.local_id === queued?.localId),
        { timeout: 30_000 },
      )
      .toMatchObject({ status: "in_flight", review_block: true });
    await go(page, "/sync?tab=conflicts");
    await page
      .getByRole("button", { name: /^Review sharing/ })
      .click({ timeout: 30_000 });
    const review = page.getByRole("dialog", { name: "Review sharing" });
    await expect(review).toContainText("Sharing defaults have changed", {
      timeout: 30_000,
    });
    await expect(
      review.locator('[data-review-kind="person"] [data-review-now]'),
    ).toContainText("Private");
    await review.locator("[data-confirm]").click();
    await expect(review).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(async () => (await person(page, id, rid))?.label, {
        timeout: 60_000,
      })
      .toBe("I-SH Reviewed");
    const listed = await raw(page, id, "GET", "/people");
    expect(
      ((listed.body as { items: Projection[] }).items ?? []).filter(
        (p) => p.id === rid,
      ),
    ).toHaveLength(1);
    const commands = (await proxy.log()).filter(
      (e) => e.method === "POST" && e.path === `${API}/commands`,
    );
    expect(commands.map((c) => c.status)).toEqual(
      expect.arrayContaining([409, 200]),
    );
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({ commands: commands.map((c) => c.status) }),
    });
  });
});

test.describe("I-SH6: a lost response is retried with the same key, and nothing is applied twice", () => {
  test("the proxy drops the first answer after the backend committed; Try again resends the same key and body; the policy advanced once", async ({
    context,
  }, info) => {
    const { page, id } = await bootMain(context);
    const rid = await createPerson(page, id, "I-SH Lost");
    const pv0 = (await person(page, id, rid))?.policy_version as number;
    const requests = recordManagement(page);
    await proxy.addRule({
      id: "drop-first",
      method: "POST",
      path: `${API}/management-commands`,
      ordinal: 1,
      action: "drop_after_forward",
    });
    await go(page, `/sharing/items/${rid}`);
    const dialog = page.getByRole("dialog", { name: "Sharing — I-SH Lost" });
    await expect(dialog.locator("[data-audience]")).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByRole("button", { name: "+ Add exclusion" }).click();
    await dialog
      .getByRole("textbox", { name: "Exact username" })
      .fill(ACCOUNTS.bob.username);
    await dialog.getByRole("button", { name: "Look up" }).click();
    await dialog
      .getByRole("button", { name: `Choose: ${ACCOUNTS.bob.username}` })
      .click();
    await dialog.locator("[data-save]").click();
    await expect(dialog).toContainText(
      "We couldn't confirm the change was saved",
      { timeout: 30_000 },
    );
    // The backend did commit the first attempt.
    expect((await policyOf(page, id, rid)).body.version).toBe(pv0 + 1);
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    expect((await policyOf(page, id, rid)).body.version).toBe(pv0 + 1);
    const sent = await managementRequests();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.status).toBe(200);
    // The retry was the SAME attempt: the same Idempotency-Key and the byte-identical body (the backend answered its original receipt).
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({
        pv0,
        statuses: sent.map((s) => s.status),
        rules: sent.map((s) => s.rule ?? null),
      }),
    });
  });
});

test.describe("I-SH7 and I-SH8: the household demonstration, and owner-only", () => {
  test("a real household made, an account invited and accepting, the editor shows its members; the member gets owner-only for the owner's resource", async ({
    browser,
  }, info) => {
    const owner = await browser.newContext();
    const member = await browser.newContext();
    try {
      const { page, id } = await bootMain(owner, "/sharing");
      await expect(
        page.getByRole("heading", { name: "Your households" }),
      ).toBeVisible({ timeout: 30_000 });
      const name = `I-SH Flat ${Date.now() % 100_000}`;
      // WEB-12b adaptation (D-12b-1): the create is the New household dialog, the invite the household's Invitations dialog, and the
      // member's "Invitations for you" the header-level Invitations dialog. Every assertion is kept.
      await go(page, "/sharing/new");
      await page.getByLabel("Household name").fill(name);
      await page.getByRole("button", { name: "Create household" }).click();
      const row = page.locator("[data-household]").filter({ hasText: name });
      await expect(row).toBeVisible({ timeout: 30_000 });
      const householdId = await householdIdFromUrl(page);
      await go(page, `/sharing/households/${householdId}/invitations`);
      await page
        .getByRole("dialog")
        .getByLabel("Their username")
        .fill(ACCOUNTS.bob.username);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Invite", exact: true })
        .click();
      await expect(
        page.getByRole("dialog").locator("[data-sent-status=pending]"),
      ).toHaveCount(1, { timeout: 30_000 });
      // The member accepts in their own browser.
      const theirs = await bootHarness(member, "/sharing");
      const bobId = await signedIn(theirs, "bob");
      await go(theirs, "/sharing/invitations");
      await theirs
        .getByRole("button", { name: new RegExp(`^Accept: ${name}`) })
        .click({ timeout: 30_000 });
      await expect(
        theirs.locator("[data-household]").filter({ hasText: name }),
      ).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(
          async () =>
            (
              (await raw(page, id, "GET", "/households")).body as Array<{
                name: string;
                members: unknown[];
              }>
            ).find((h) => h.name === name)?.members.length,
          { timeout: 30_000 },
        )
        .toBe(2);
      // A person created now is shared with the primary household by default (the first household is primary); the editor lists the member.
      const rid = await createPerson(page, id, "I-SH Shared");
      await go(page, `/sharing/items/${rid}`);
      const dialog = page.getByRole("dialog", {
        name: "Sharing — I-SH Shared",
      });
      await expect(dialog.locator("[data-audience]")).toContainText(
        ACCOUNTS.bob.username,
        { timeout: 30_000 },
      );
      // I-SH8: the member cannot read the owner's policy (the server says 403) and the editor says only the owner can change it.
      const forbidden = await raw(theirs, bobId, "GET", `/policies/${rid}`);
      expect(forbidden.status).toBe(403);
      await leader(theirs, bobId.account_id);
      await reopenBound(theirs, bobId.account_id, "/today");
      await expect
        .poll(
          async () =>
            (
              (await theirs.evaluate(
                (a) => window.__atlasData?.rows(a, "cache"),
                bobId.account_id,
              )) as Array<{ id: string }>
            ).some((r) => r.id === rid),
          { timeout: 60_000 },
        )
        .toBe(true);
      await go(theirs, `/sharing/items/${rid}`);
      await expect(theirs.getByRole("dialog")).toContainText(
        "Only the owner can change who can see this.",
        { timeout: 30_000 },
      );
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({
          household: name,
          forbidden: forbidden.status,
        }),
      });
    } finally {
      await owner.close();
      await member.close();
    }
  });
});

test.describe("I-SH9: a membership B5 does not name is offered by the defaults editor (A4; R11, review 5)", () => {
  test("the real /households lists a household the real B5 answer omits; the personal layer grants it at its own version; afterwards B5 names it", async ({
    context,
  }, info) => {
    const { page, id } = await bootMain(context);
    // Two real households of this account; whichever one is primary, the newest is not, and no resolved default names it yet.
    const suffix = Date.now() % 100_000;
    const names = [`I-SH9 Home ${suffix}`, `I-SH9 Second ${suffix}`];
    for (const name of names) {
      const made = await raw(
        page,
        id,
        "POST",
        "/management-commands",
        {
          commands: [
            { kind: "create_household", id: crypto.randomUUID(), name },
          ],
        },
        crypto.randomUUID(),
      );
      expect(made.status).toBe(200);
    }
    const households = (await raw(page, id, "GET", "/households"))
      .body as Array<{ id: string; name: string }>;
    const second = households.find((h) => h.name === names[1]);
    if (!second) throw new Error("the second household is not listed");
    const before = (await raw(page, id, "GET", "/defaults/snapshot")).body as {
      defaults: { primary_household_id: string | null };
      households: Array<{ id: string }>;
    };
    // Precondition (the contract's two endpoints really differ): B5 omits the second household.
    expect(before.defaults.primary_household_id).not.toBe(second.id);
    expect(before.households.map((h) => h.id)).not.toContain(second.id);
    const scope = (await raw(page, id, "GET", "/defaults/templates")).body as {
      list: { version: number };
    };
    await go(page, "/sharing/defaults?kind=list");
    const dialog = page.getByRole("dialog", {
      name: "Sharing defaults — Lists",
    });
    const personal = dialog.locator('[data-layer-form="personal"]');
    await personal
      .getByRole("radio", { name: "Explicit policy…" })
      .click({ timeout: 30_000 });
    await personal
      .getByRole("button", { name: "+ Add household grant" })
      .click({ timeout: 30_000 });
    await personal
      .locator("[data-household-picker]")
      .getByRole("button", { name: names[1], exact: true })
      .click({ timeout: 30_000 });
    const sent = recordManagement(page);
    await personal.locator('[data-save="personal"]').click();
    await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(1);
    expect(JSON.parse(sent[0]?.body ?? "null")).toEqual({
      commands: [
        {
          kind: "set_defaults",
          household_id: null,
          resource_kind: "list",
          expected_version: scope.list.version,
          template: {
            kind: "explicit",
            policy: {
              grants: [{ kind: "household", id: second.id, edit: false }],
              exclude_accounts: [],
            },
          },
        },
      ],
    });
    const granted = {
      kind: "explicit",
      policy: {
        grants: [{ kind: "household", id: second.id, edit: false }],
        exclude_accounts: [],
      },
    };
    await expect
      .poll(
        async () =>
          (
            (await raw(page, id, "GET", "/defaults/templates")).body as {
              list: { template: unknown };
            }
          ).list.template,
        { timeout: 30_000 },
      )
      .toEqual(granted);
    const saved = (await raw(page, id, "GET", "/defaults/templates")).body as {
      list: { version: number };
    };
    expect(saved.list.version).toBeGreaterThan(scope.list.version);
    // Now a resolved default names it, so B5 lists it.
    const after = (await raw(page, id, "GET", "/defaults/snapshot")).body as {
      households: Array<{ id: string }>;
    };
    expect(after.households.map((h) => h.id)).toContain(second.id);
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({
        second: second.id,
        b5Before: before.households.map((h) => h.id),
        b5After: after.households.map((h) => h.id),
        version: scope.list.version,
      }),
    });
  });
});

// ---- WEB-12b: household membership and the full sharing surface (plan §8.4) -------------------------------------------------------
/**
 * WEB-12b against the same released backend (v0.31.0-rc.1, whose contract has Q1, Q16 and CH1), on dedicated accounts (frank..quinn), so
 * WEB-12a's rotation (alice, carol, dave, erin) and its households are untouched. FOCUSED REAL-BACKEND EVIDENCE for a fixture-stage card:
 * BE-Q1, BE-Q16 and BE-CH1 have no formal completion record, so this is NOT integration acceptance. `expired` cannot be produced on a
 * seven-day server and is covered at fixture level only. I-SH17b runs in a stack of its own whose backend has its directory disabled.
 */
async function bootAs(context: BrowserContext, who: Who, route = "/sharing") {
  const page = await bootHarness(context, "/today");
  const id = await signedIn(page, who);
  await leader(page, id.account_id);
  await reopenBound(page, id.account_id, route);
  return { page, id };
}
/** One management command, stamped by the page's own session (a fresh key). */
const manage = (page: Page, id: Id, command: Record<string, unknown>) =>
  raw(
    page,
    id,
    "POST",
    "/management-commands",
    { commands: [command] },
    crypto.randomUUID(),
  );
interface Hh {
  id: string;
  name: string;
  version: number;
  role: string;
  members: Array<{ account_id: string; username: string; role: string }>;
}
const householdsOf = async (page: Page, id: Id) =>
  (await raw(page, id, "GET", "/households")).body as Hh[];
const householdNamed = async (page: Page, id: Id, name: string) =>
  (await householdsOf(page, id)).find((h) => h.name === name);
/** A household made by `id` with a raw command (the UI's own create is I-SH10's). */
async function rawHousehold(page: Page, id: Id, name: string): Promise<Hh> {
  const made = await manage(page, id, {
    kind: "create_household",
    id: crypto.randomUUID(),
    name,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const h = await householdNamed(page, id, name);
  if (!h) throw new Error(`no household ${name}`);
  return h;
}
const unique = (label: string) => `${label} ${Date.now() % 100_000}`;
const dialog = (page: Page) => page.getByRole("dialog");
const sentRows = (page: Page) => dialog(page).locator("[data-sent]");

test.describe("I-SH10: a household created, renamed, joined, managed and left, in the UI (A1, A2, A3, A9)", () => {
  test("frank creates and renames; grace (no household) accepts from the header-level Invitations and it becomes her main household; frank promotes, demotes and removes her; a fresh context of frank shows the invitation accepted; grace's deep link says she is no longer in it", async ({
    browser,
  }, info) => {
    const owner = await browser.newContext();
    const guest = await browser.newContext();
    try {
      const { page, id } = await bootAs(owner, "frank", "/sharing/new");
      const name = unique("I-SH10 Home");
      await page.getByLabel("Household name").fill(name);
      await page.getByRole("button", { name: "Create household" }).click();
      const hid = await householdIdFromUrl(page);
      await expect(
        page.locator(`[data-household-detail="${hid}"]`),
      ).toBeVisible({
        timeout: 30_000,
      });
      await page.getByRole("link", { name: "Rename" }).click();
      const renamed = `${name} renamed`;
      await dialog(page).getByLabel("Household name").fill(renamed);
      await dialog(page).getByRole("button", { name: "Save name" }).click();
      await expect(
        page.getByRole("heading", { level: 2, name: renamed }),
      ).toBeVisible({
        timeout: 30_000,
      });
      await go(page, `/sharing/households/${hid}/invitations`);
      await dialog(page)
        .getByLabel("Their username")
        .fill(ACCOUNTS.grace.username);
      await dialog(page)
        .getByRole("button", { name: "Invite", exact: true })
        .click();
      await expect(
        sentRows(page).filter({ hasText: ACCOUNTS.grace.username }),
      ).toHaveAttribute("data-sent-status", "pending", { timeout: 30_000 });
      // grace, in a browser of her own, with no household yet.
      const theirs = await bootAs(guest, "grace", "/sharing");
      await expect(
        theirs.page.getByText("You're not in a household", { exact: true }),
      ).toBeVisible({
        timeout: 30_000,
      });
      await go(theirs.page, "/sharing/invitations");
      await theirs.page
        .getByRole("button", { name: `Accept: ${renamed}` })
        .click({ timeout: 30_000 });
      await expect
        .poll(
          async () =>
            (
              (await raw(theirs.page, theirs.id, "GET", "/defaults/snapshot"))
                .body as {
                defaults: { primary_household_id: string | null };
              }
            ).defaults.primary_household_id,
          { timeout: 30_000 },
        )
        .toBe(hid);
      // frank promotes, demotes and removes her, each with the household's version. His page is opened again, as a person would
      // see a membership change made elsewhere (each read is separately timed: D-12b-3).
      await reopenBound(page, id.account_id, `/sharing/households/${hid}`);
      const member = page
        .locator("[data-member]")
        .filter({ hasText: ACCOUNTS.grace.username });
      await expect(member).toBeVisible({ timeout: 30_000 });
      await member
        .getByRole("button", {
          name: `Make manager: ${ACCOUNTS.grace.username}`,
        })
        .click();
      await expect
        .poll(
          async () =>
            (await householdNamed(page, id, renamed))?.members.find(
              (m) => m.account_id === theirs.id.account_id,
            )?.role,
          {
            timeout: 30_000,
          },
        )
        .toBe("manager");
      await member
        .getByRole("button", {
          name: `Make member: ${ACCOUNTS.grace.username}`,
        })
        .click();
      await dialog(page).getByRole("button", { name: "Confirm" }).click();
      await expect
        .poll(
          async () =>
            (await householdNamed(page, id, renamed))?.members.find(
              (m) => m.account_id === theirs.id.account_id,
            )?.role,
          {
            timeout: 30_000,
          },
        )
        .toBe("member");
      await member
        .getByRole("button", { name: `Remove: ${ACCOUNTS.grace.username}` })
        .click();
      await dialog(page).getByRole("button", { name: "Confirm" }).click();
      await expect
        .poll(
          async () => (await householdNamed(page, id, renamed))?.members.length,
          { timeout: 30_000 },
        )
        .toBe(1);
      // Q16, cross-device: a fresh context of frank reads the durable history.
      const fresh = await browser.newContext();
      try {
        const again = await bootAs(
          fresh,
          "frank",
          `/sharing/households/${hid}/invitations`,
        );
        await expect(
          again.page
            .getByRole("dialog")
            .locator("[data-sent]")
            .filter({ hasText: ACCOUNTS.grace.username }),
        ).toHaveAttribute("data-sent-status", "accepted", { timeout: 30_000 });
      } finally {
        await fresh.close();
      }
      // grace's own deep link, read again: she is no longer in it.
      await reopenBound(
        theirs.page,
        theirs.id.account_id,
        `/sharing/households/${hid}`,
      );
      await expect(
        theirs.page.getByText(
          "You're no longer in this household, or it doesn't exist.",
        ),
      ).toBeVisible({
        timeout: 30_000,
      });
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ household: hid }),
      });
    } finally {
      await owner.close();
      await guest.close();
    }
  });
});

test.describe("I-SH11: SHARE-6 and SHARE-9 against the server, and the UI's stale path (A2)", () => {
  test("a sole manager's leave is 409 last_manager; an invite with a stale household version and a response with the household's (not the invitation's) version are conflicts; the UI's stale rename is explained and read again", async ({
    browser,
  }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      const { page, id } = await bootAs(a, "olga", "/sharing");
      const pete = await bootAs(b, "pete", "/sharing");
      const name = unique("I-SH11 Home");
      const h = await rawHousehold(page, id, name);
      const leave = await manage(page, id, {
        kind: "remove_household_member",
        household_id: h.id,
        account_id: id.account_id,
        expected_version: h.version,
      });
      expect(leave.status).toBe(409);
      expect((leave.body as { code: string }).code).toBe("last_manager");
      const renamed = await manage(page, id, {
        kind: "rename_household",
        id: h.id,
        name: `${name} 2`,
        expected_version: h.version,
      });
      expect(renamed.status).toBe(200);
      const peteId = await accountIdOf(page, id, ACCOUNTS.pete.username);
      const stale = await manage(page, id, {
        kind: "invite_to_household",
        id: crypto.randomUUID(),
        household_id: h.id,
        recipient_id: peteId,
        expected_version: h.version,
      });
      expect(stale.status).toBe(409);
      expect((stale.body as { code: string }).code).toBe("conflict");
      const now = (await householdNamed(page, id, `${name} 2`)) as Hh;
      const invited = await manage(page, id, {
        kind: "invite_to_household",
        id: crypto.randomUUID(),
        household_id: h.id,
        recipient_id: peteId,
        expected_version: now.version,
      });
      expect(invited.status).toBe(200);
      const pending = (await raw(pete.page, pete.id, "GET", "/invitations"))
        .body as Array<{
        id: string;
        household_id: string;
        version: number;
      }>;
      const mine = pending.find((i) => i.household_id === h.id);
      expect(mine).toBeDefined();
      const household = (await householdNamed(page, id, `${name} 2`)) as Hh;
      expect(household.version).not.toBe(mine?.version);
      const wrongCounter = await manage(pete.page, pete.id, {
        kind: "respond_to_household_invitation",
        id: mine?.id,
        expected_version: household.version,
        accept: true,
      });
      expect(wrongCounter.status).toBe(409);
      // The UI's stale path: the rename dialog was read at one version; the household moves on; Save is refused and explained.
      await go(page, `/sharing/households/${h.id}/rename`);
      await expect(dialog(page).getByLabel("Household name")).toHaveValue(
        `${name} 2`,
        { timeout: 30_000 },
      );
      const moved = await manage(page, id, {
        kind: "rename_household",
        id: h.id,
        name: `${name} 3`,
        expected_version: household.version,
      });
      expect(moved.status).toBe(200);
      await dialog(page).getByLabel("Household name").fill(`${name} UI`);
      await dialog(page).getByRole("button", { name: "Save name" }).click();
      await expect(
        dialog(page).getByText(
          "This household changed since it was shown. It has been read again; try again.",
        ),
      ).toBeVisible({ timeout: 30_000 });
      expect((await householdNamed(page, id, `${name} 3`))?.id).toBe(h.id);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test.describe("I-SH12: invitations revoked and declined, in the UI (A3; Q16)", () => {
  test("heidi invites ivan and revokes it: ivan's For you no longer lists it and Sent by you says revoked; judy declines hers: Sent by you says declined", async ({
    browser,
  }) => {
    const [a, b, c] = [
      await browser.newContext(),
      await browser.newContext(),
      await browser.newContext(),
    ];
    try {
      const { page, id } = await bootAs(a, "heidi", "/sharing");
      const h = await rawHousehold(page, id, unique("I-SH12 Home"));
      await go(page, `/sharing/households/${h.id}/invitations`);
      for (const who of ["ivan", "judy"] as const) {
        await dialog(page)
          .getByLabel("Their username")
          .fill(ACCOUNTS[who].username);
        await dialog(page)
          .getByRole("button", { name: "Invite", exact: true })
          .click();
        await expect(
          sentRows(page).filter({ hasText: ACCOUNTS[who].username }),
        ).toHaveAttribute("data-sent-status", "pending", { timeout: 30_000 });
      }
      await dialog(page)
        .getByRole("button", { name: `Revoke: ${ACCOUNTS.ivan.username}` })
        .click();
      await expect(
        sentRows(page).filter({ hasText: ACCOUNTS.ivan.username }),
      ).toHaveAttribute("data-sent-status", "revoked", { timeout: 30_000 });
      const ivan = await bootAs(b, "ivan", "/sharing/invitations");
      await expect(
        ivan.page.getByRole("dialog").getByText("No pending invitations"),
      ).toBeVisible({ timeout: 30_000 });
      const judy = await bootAs(c, "judy", "/sharing/invitations");
      await judy.page
        .getByRole("button", { name: `Decline: ${h.name}` })
        .click({ timeout: 30_000 });
      await expect(
        judy.page.getByRole("dialog").getByText("No pending invitations"),
      ).toBeVisible({ timeout: 30_000 });
      await reopenBound(
        page,
        id.account_id,
        `/sharing/households/${h.id}/invitations`,
      );
      await expect(
        sentRows(page).filter({ hasText: ACCOUNTS.judy.username }),
      ).toHaveAttribute("data-sent-status", "declined", { timeout: 30_000 });
    } finally {
      await a.close();
      await b.close();
      await c.close();
    }
  });
});

/** The signup link the dialog shows (`<origin>/join#t=<64 hex>`). */
async function issuedLink(page: Page): Promise<string> {
  const field = dialog(page).getByLabel("Invitation link");
  await expect(field).toHaveValue(/\/join#t=[0-9a-f]{64}$/, {
    timeout: 30_000,
  });
  return field.inputValue();
}

test.describe("I-SH13: a signup link issued in the UI, redeemed, revoked, and read-only after role loss (A5, A6; Q21 group 2)", () => {
  test("kate's link is <origin>/join#t=<token>; a new person redeems it through the join surface and is a member with it as their main household; a second link revoked in the UI is refused; liam demotes kate: her signup links are gone and her screen is read-only", async ({
    browser,
  }, info) => {
    const [a, b, c] = [
      await browser.newContext(),
      await browser.newContext(),
      await browser.newContext(),
    ];
    try {
      const { page, id } = await bootAs(a, "kate", "/sharing");
      const h = await rawHousehold(page, id, unique("I-SH13 Home"));
      const liam = await bootAs(b, "liam", "/sharing");
      const liamId = liam.id.account_id;
      expect(
        (
          await manage(page, id, {
            kind: "invite_to_household",
            id: crypto.randomUUID(),
            household_id: h.id,
            recipient_id: liamId,
            expected_version: h.version,
          })
        ).status,
      ).toBe(200);
      const invitation = (
        (await raw(liam.page, liam.id, "GET", "/invitations")).body as Array<{
          id: string;
          household_id: string;
          version: number;
        }>
      ).find((i) => i.household_id === h.id);
      expect(
        (
          await manage(liam.page, liam.id, {
            kind: "respond_to_household_invitation",
            id: invitation?.id,
            expected_version: invitation?.version,
            accept: true,
          })
        ).status,
      ).toBe(200);
      const joined = (await householdNamed(page, id, h.name)) as Hh;
      expect(
        (
          await manage(page, id, {
            kind: "set_household_role",
            household_id: h.id,
            account_id: liamId,
            expected_version: joined.version,
            manager: true,
          })
        ).status,
      ).toBe(200);
      await go(page, `/sharing/households/${h.id}/signup`);
      await dialog(page)
        .getByRole("button", { name: "New invitation" })
        .click();
      const link = await issuedLink(page);
      expect(link.startsWith(`${new URL(page.url()).origin}/join#t=`)).toBe(
        true,
      );
      expect(page.url()).not.toContain(link.split("#t=")[1]);
      await dialog(page)
        .getByRole("button", { name: "Done", exact: true })
        .click();
      const token = link.split("#t=")[1] as string;
      // A new person redeems it through WEB-08b's join surface.
      const joiner = await c.newPage();
      await joiner.goto(`/__session?route=%2Fjoin#t=${token}`);
      await exposeSession(joiner);
      const username = `ish13${Date.now() % 100_000}`;
      await joiner.getByLabel("Username").fill(username);
      await joiner.getByLabel("Password").fill(`I-SH13-${crypto.randomUUID()}`);
      await joiner.getByRole("button", { name: "Create account" }).click();
      await untilView(joiner, "displaying");
      const joinerId = (await joiner.evaluate(() =>
        window.__s.identity.get(),
      )) as Id;
      const theirHouseholds = (
        await raw(joiner, joinerId, "GET", "/households")
      ).body as Hh[];
      expect(theirHouseholds.map((x) => x.id)).toEqual([h.id]);
      expect(
        (
          (await raw(joiner, joinerId, "GET", "/defaults/snapshot")).body as {
            defaults: { primary_household_id: string };
          }
        ).defaults.primary_household_id,
      ).toBe(h.id);
      await reopenBound(page, id.account_id, `/sharing/households/${h.id}`);
      await expect(
        page.locator("[data-member]").filter({ hasText: username }),
      ).toBeVisible({ timeout: 30_000 });
      // A second link, revoked in the UI, is refused at redemption.
      await go(page, `/sharing/households/${h.id}/signup`);
      await dialog(page)
        .getByRole("button", { name: "New invitation" })
        .click();
      const second = (await issuedLink(page)).split("#t=")[1] as string;
      await dialog(page)
        .getByRole("button", { name: "Done", exact: true })
        .click();
      const listed = (
        (await raw(page, id, "GET", "/account-invitations")).body as {
          invitations: Array<{ id: string }>;
        }
      ).invitations;
      expect(listed).toHaveLength(1);
      await dialog(page)
        .getByRole("button", { name: /^Revoke invitation / })
        .click();
      await expect(
        dialog(page).getByText("No active signup invitations."),
      ).toBeVisible({ timeout: 30_000 });
      // Asked as WEB-08b's own check does, outside the session (the public preview of a link): a revoked link is refused.
      expect(await previewStatus(second)).toBe(401);
      // liam (co-manager) demotes kate: her pending signup links are revoked, and her screen says so, read-only.
      await go(page, `/sharing/households/${h.id}/signup`);
      await dialog(page)
        .getByRole("button", { name: "New invitation" })
        .click();
      await issuedLink(page);
      await dialog(page)
        .getByRole("button", { name: "Done", exact: true })
        .click();
      const before = (await householdNamed(liam.page, liam.id, h.name)) as Hh;
      expect(
        (
          await manage(liam.page, liam.id, {
            kind: "set_household_role",
            household_id: h.id,
            account_id: id.account_id,
            expected_version: before.version,
            manager: false,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          (await raw(liam.page, liam.id, "GET", "/account-invitations"))
            .body as { invitations: unknown[] }
        ).invitations,
      ).toEqual([]);
      await dialog(page)
        .getByRole("button", { name: "New invitation" })
        .click();
      await expect(
        page
          .getByRole("dialog")
          .getByText(
            "You no longer manage this household — its pending signup invitations were revoked automatically.",
          ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "New invitation" }),
      ).toHaveCount(0);
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ household: h.id, joined: username }),
      });
    } finally {
      await a.close();
      await b.close();
      await c.close();
    }
  });
});

test.describe("I-SH14: the 20-per-issuer cap (A5)", () => {
  test("19 issued through the page's own client and one in the UI make 20; the 21st in the UI is refused (limit) and New invitation waits with the reason; a revoke frees it; every link revoked afterwards", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, "mia", "/sharing");
    const h = await rawHousehold(page, id, unique("I-SH14 Home"));
    try {
      for (let n = 0; n < 19; n += 1) {
        const issued = await raw(page, id, "POST", "/account-invitations", {
          household_id: h.id,
        });
        expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      }
      await go(page, `/sharing/households/${h.id}/signup`);
      await expect(dialog(page).locator("[data-signup]")).toHaveCount(19, {
        timeout: 30_000,
      });
      await dialog(page)
        .getByRole("button", { name: "New invitation" })
        .click();
      await issuedLink(page);
      await dialog(page)
        .getByRole("button", { name: "Done", exact: true })
        .click();
      await expect(dialog(page).locator("[data-signup]")).toHaveCount(20, {
        timeout: 30_000,
      });
      await dialog(page)
        .getByRole("button", { name: "New invitation" })
        .click();
      const reason =
        "Atlas didn't create an invitation: you may already have 20 waiting, or too many requests were made. Revoke one or try again shortly.";
      await expect(dialog(page).getByText(reason).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        dialog(page).getByRole("button", { name: "New invitation" }),
      ).toBeDisabled();
      await dialog(page)
        .getByRole("button", { name: /^Revoke invitation / })
        .first()
        .click();
      await expect(dialog(page).locator("[data-signup]")).toHaveCount(19, {
        timeout: 30_000,
      });
      await expect(
        dialog(page).getByRole("button", { name: "New invitation" }),
      ).toBeEnabled();
    } finally {
      const left = (
        (await raw(page, id, "GET", "/account-invitations")).body as {
          invitations: Array<{ id: string }>;
        }
      ).invitations;
      for (const i of left)
        await page.evaluate(
          async ({ id, path }) => {
            await window.__s.api.fetchFor(
              "ordinary",
              id.account_id,
              id.epoch,
            )(
              new Request(`${location.origin}/api/experimental/v1${path}`, {
                method: "DELETE",
              }),
            );
          },
          { id, path: `/account-invitations/${i.id}` },
        );
      expect(
        (
          (await raw(page, id, "GET", "/account-invitations")).body as {
            invitations: unknown[];
          }
        ).invitations,
      ).toEqual([]);
    }
  });
});

test.describe("I-SH15: a lost issuance is recovered by listing, never by retrying (A5; SHARE-7)", () => {
  test("the proxy drops a committed POST /account-invitations answer: the UI says it is not confirmed, the list read again flags the new id, and exactly one POST was made", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, "quinn", "/sharing");
    const h = await rawHousehold(page, id, unique("I-SH15 Home"));
    await go(page, `/sharing/households/${h.id}/signup`);
    await expect(
      dialog(page).getByText("No active signup invitations."),
    ).toBeVisible({ timeout: 30_000 });
    const rule = await proxy.addRule({
      method: "POST",
      path: `${API}/account-invitations`,
      ordinal: 1,
      action: "drop_after_forward",
    });
    try {
      await dialog(page)
        .getByRole("button", { name: "New invitation" })
        .click();
      await expect(
        dialog(page).getByText(
          "We couldn't confirm whether an invitation was created. It is not sent again: the list has been read again instead.",
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(dialog(page).locator("[data-signup-flagged]")).toHaveCount(
        1,
        { timeout: 30_000 },
      );
      const posts = (await proxy.log()).filter(
        (e) => e.method === "POST" && e.path === `${API}/account-invitations`,
      );
      expect(posts).toHaveLength(1);
      await expect(dialog(page).getByLabel("Invitation link")).toHaveCount(0);
    } finally {
      await proxy.removeRule(rule.id);
    }
  });
});

test.describe("I-SH16: an item's own sharing section with full household management, and the dual-ownership review (A10)", () => {
  test("nora's Home (pete joined): the policy editor grants Home and pete reads it; a create captured with Home's members is refused after pete LEAVES in WEB-12b's UI; the review shows Was/Now; Confirm sends it with the new revision", async ({
    browser,
  }, info) => {
    test.slow();
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      const { page, id } = await bootAs(a, "nora", "/sharing");
      const home = await rawHousehold(page, id, unique("I-SH16 Home"));
      const pete = await bootAs(b, "pete", "/sharing");
      expect(
        (
          await manage(page, id, {
            kind: "invite_to_household",
            id: crypto.randomUUID(),
            household_id: home.id,
            recipient_id: pete.id.account_id,
            expected_version: home.version,
          })
        ).status,
      ).toBe(200);
      const inv = (
        (await raw(pete.page, pete.id, "GET", "/invitations")).body as Array<{
          id: string;
          household_id: string;
          version: number;
        }>
      ).find((i) => i.household_id === home.id);
      expect(
        (
          await manage(pete.page, pete.id, {
            kind: "respond_to_household_invitation",
            id: inv?.id,
            expected_version: inv?.version,
            accept: true,
          })
        ).status,
      ).toBe(200);
      // nora's main household is Home (her first), so a person she creates now is shared with Home by default.
      const snapshotOf = async () =>
        (await raw(page, id, "GET", "/defaults/snapshot")).body as {
          defaults: { primary_household_id: string | null; revision: string };
        };
      expect((await snapshotOf()).defaults.primary_household_id).toBe(home.id);
      // An item's own sharing section (the shared editor WEB-10/11 embed) grants Home explicitly, and pete can read it.
      const rid = await createPerson(page, id, "I-SH16 Shared");
      await go(page, `/sharing/items/${rid}`);
      const editor = page.getByRole("dialog", {
        name: "Sharing — I-SH16 Shared",
      });
      await expect(editor.locator("[data-audience]")).toContainText(
        ACCOUNTS.pete.username,
        { timeout: 30_000 },
      );
      await expect
        .poll(
          async () =>
            (
              (
                (await raw(pete.page, pete.id, "GET", "/people")).body as {
                  items?: Projection[];
                }
              ).items ?? []
            ).some((p) => p.id === rid),
          { timeout: 60_000 },
        )
        .toBe(true);
      // The dual-ownership review: captured with Home's members, then pete leaves in WEB-12b's UI. The page's B5 record is read again
      // only when a screen asks (D-12a-10); the defaults editor acquires a fresh snapshot when it opens, so it is opened, and the
      // capture waits for a persisted record that names Home, with pete, as the main household (the raw commands above moved it).
      await go(page, "/sharing/defaults?kind=person");
      await expect
        .poll(
          () =>
            page.evaluate(
              ({ acc, home }) =>
                window.__atlasData?.defaultsRecord(acc).then((r) => {
                  const named = r?.snapshot.households.find(
                    (h) => h.id === home,
                  );
                  return r?.snapshot.defaults.primary_household_id === home
                    ? (named?.members.length ?? 0)
                    : 0;
                }),
              { acc: id.account_id, home: home.id },
            ),
          { timeout: 30_000 },
        )
        .toBe(2);
      await go(page, "/sharing");
      const capture = await page.evaluate(
        (acc) => window.__atlasData?.captureDefaults(acc, ["person"]),
        id.account_id,
      );
      expect(capture?.kind).toBe("captured");
      await go(pete.page, `/sharing/households/${home.id}`);
      await pete.page
        .getByRole("button", { name: `Leave: ${home.name}` })
        .click({ timeout: 30_000 });
      await pete.page
        .getByRole("dialog")
        .getByRole("button", { name: "Confirm" })
        .click();
      await expect
        .poll(
          async () =>
            (await householdNamed(page, id, home.name))?.members.length,
          { timeout: 30_000 },
        )
        .toBe(1);
      expect((await snapshotOf()).defaults.revision).not.toBe(
        capture?.defaultsRevision,
      );
      const queuedId = crypto.randomUUID();
      const queued = await page.evaluate(
        ({ rid, capture }) =>
          window.__atlasData?.enqueue({
            endpoint: "/commands",
            targets: [
              {
                resourceId: rid,
                role: "primary",
                basis: "resource",
                versionChecked: false,
                seedIfUntracked: 1,
              },
            ],
            command: {
              commands: [
                { kind: "create_person", id: rid, name: "I-SH16 Reviewed" },
              ],
              defaults_revision: capture?.defaultsRevision,
            },
            displayPatch: { [rid]: { label: "I-SH16 Reviewed" } },
            defaultsRevision: capture?.defaultsRevision ?? null,
            defaultsContext: capture?.defaultsContext as never,
            defaultsReview: capture?.defaultsReview,
          }),
        { rid: queuedId, capture },
      );
      expect(queued?.kind).toBe("queued");
      await go(page, "/sync?tab=conflicts");
      await page
        .getByRole("button", { name: /^Review sharing/ })
        .click({ timeout: 30_000 });
      const review = page.getByRole("dialog", { name: "Review sharing" });
      await expect(review).toContainText("Sharing defaults have changed", {
        timeout: 30_000,
      });
      // Was: Home with pete (as captured); Now: Home without him.
      await expect(
        review.locator('[data-review-kind="person"] [data-review-was]'),
      ).toContainText(ACCOUNTS.pete.username);
      await expect(
        review.locator('[data-review-kind="person"] [data-review-now]'),
      ).not.toContainText(ACCOUNTS.pete.username);
      await review.locator("[data-confirm]").click();
      await expect(review).toBeHidden({ timeout: 30_000 });
      await expect
        .poll(async () => (await person(page, id, queuedId))?.label, {
          timeout: 60_000,
        })
        .toBe("I-SH16 Reviewed");
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ home: home.id, rid, queuedId }),
      });
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test.describe("I-SH17: the directory's browse mode, enabled (A4; PPL-4)", () => {
  test("Find an account lists accounts (yourself excluded); the choice is invited", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, "judy", "/sharing");
    const h = await rawHousehold(page, id, unique("I-SH17 Home"));
    await go(page, `/sharing/households/${h.id}/invitations`);
    await dialog(page).getByRole("button", { name: "Find an account" }).click();
    await dialog(page)
      .getByLabel("Name", { exact: true })
      .fill(ACCOUNTS.quinn.username.slice(0, 3));
    await dialog(page)
      .getByRole("button", { name: "Search", exact: true })
      .click();
    await dialog(page)
      .getByRole("button", { name: `Choose: ${ACCOUNTS.quinn.username}` })
      .click({ timeout: 30_000 });
    await expect(
      dialog(page).getByRole("button", {
        name: `Choose: ${ACCOUNTS.judy.username}`,
      }),
    ).toHaveCount(0);
    await expect(dialog(page).getByLabel("Their username")).toHaveValue(
      ACCOUNTS.quinn.username,
    );
    await dialog(page)
      .getByRole("button", { name: "Invite", exact: true })
      .click();
    await expect(
      sentRows(page).filter({ hasText: ACCOUNTS.quinn.username }),
    ).toHaveAttribute("data-sent-status", "pending", {
      timeout: 30_000,
    });
  });
});

test.describe("I-SH17b: the directory disabled (A4; PPL-4; stack sharing-directory-off)", () => {
  test("one GET /directory answers 403 for the page lifetime; the dialog reopens after the remount with the typed username kept; the exact lookup invites", async ({
    context,
  }) => {
    test.skip(
      process.env.ATLAS_INTEGRATION_DIRECTORY !== "off",
      "this stack's directory is enabled (I-SH17b runs in sharing-directory-off)",
    );
    const { page, id } = await bootAs(context, "frank", "/sharing");
    const h = await rawHousehold(page, id, unique("I-SH17b Home"));
    await go(page, `/sharing/households/${h.id}/invitations`);
    await dialog(page).getByRole("button", { name: "Find an account" }).click();
    await dialog(page)
      .getByLabel("Exact username", { exact: true })
      .fill(ACCOUNTS.grace.username);
    await dialog(page).getByLabel("Name", { exact: true }).fill("gr");
    await dialog(page)
      .getByRole("button", { name: "Search", exact: true })
      .click();
    await expect(
      dialog(page).getByText(
        "This server finds accounts only by exact username.",
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      dialog(page).getByLabel("Exact username", { exact: true }),
    ).toHaveValue(ACCOUNTS.grace.username);
    // The observation window: a refused browse read is never asked again by itself.
    await page.waitForTimeout(3_000);
    const browses = (await proxy.log()).filter(
      // The proxy logs the whole request URL: the browse read is exactly `/directory`, with no query.
      (e) => e.method === "GET" && e.path === `${API}/directory`,
    );
    expect(browses.map((e) => e.status)).toEqual([403]);
    await dialog(page).getByRole("button", { name: "Look up" }).click();
    await dialog(page)
      .getByRole("button", { name: `Choose: ${ACCOUNTS.grace.username}` })
      .click({ timeout: 30_000 });
    await dialog(page)
      .getByRole("button", { name: "Invite", exact: true })
      .click();
    await expect(
      sentRows(page).filter({ hasText: ACCOUNTS.grace.username }),
    ).toHaveAttribute("data-sent-status", "pending", {
      timeout: 30_000,
    });
  });
});
