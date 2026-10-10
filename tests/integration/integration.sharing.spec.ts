import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import {
  ACCOUNTS,
  bootHarness,
  expect,
  exposeSession,
  ORIGIN,
  proxy,
  signIn as signInUnpaced,
  test,
  untilView,
  type Who,
} from "./helpers";

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
 */
const API = "/api/experimental/v1";

// Sign-in pacing shared with integration.data.spec.ts (the same ledger file per stack): at most 8 attempts per account a minute.
const LEDGER = join(
  tmpdir(),
  `atlas-signin-ledger-${new URL(ORIGIN || "http://x").port}.json`,
);
async function budget(who: Who): Promise<void> {
  for (;;) {
    let all: Record<string, number[]> = {};
    try {
      all = JSON.parse(readFileSync(LEDGER, "utf8")) as Record<
        string,
        number[]
      >;
    } catch {
      all = {};
    }
    const now = Date.now();
    const recent = (all[who] ?? []).filter((t) => now - t < 60_000);
    if (recent.length < 8) {
      all[who] = [...recent, now];
      writeFileSync(LEDGER, JSON.stringify(all));
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 60_000 - (now - (recent[0] ?? now)) + 250),
    );
  }
}
const ROTATION: Who[] = ["alice", "carol", "dave", "erin"];
const ROTATION_FILE = join(
  tmpdir(),
  `atlas-account-rotation-${new URL(ORIGIN || "http://x").port}.txt`,
);
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
      await page.getByLabel("Household name").fill(name);
      await page.getByRole("button", { name: "Create household" }).click();
      const row = page.locator("[data-household]").filter({ hasText: name });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row
        .getByLabel(`Invite to “${name}” by exact username`)
        .fill(ACCOUNTS.bob.username);
      await row.getByRole("button", { name: "Invite" }).click();
      // The member accepts in their own browser.
      const theirs = await bootHarness(member, "/sharing");
      const bobId = await signedIn(theirs, "bob");
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
