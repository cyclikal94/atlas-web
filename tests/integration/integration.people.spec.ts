import type { BrowserContext, Page } from "@playwright/test";
import {
  BOTH_LINKED,
  PREVIEW_FORBIDDEN,
} from "../../src/features/people/requests/copy";
import { untilTreeSettled } from "../e2e/data-sync-helpers";
import {
  ACCOUNTS,
  bootHarness,
  expect,
  exposeSession,
  paceSignIn,
  proxy,
  signIn as signInUnpaced,
  test,
  untilView,
  type Who,
} from "./helpers";

/**
 * WEB-11a against the RELEASED backend (the pinned `v0.29.0-rc.1`, API 0.29.0; earlier runs against `v0.28.0-rc.1` stay historical evidence) on a
 * disposable SQLite database, behind the delaying proxy: the production session,
 * the production data controller and the People screens, with the FIXTURE test leader standing in for production leadership (it is woken
 * with `retryOutbox()` after a save made by the tree). Commands marked HARNESS are sent by the test through the session's stamped client,
 * not by the UI (the N5 fixtures' `reference_account`/`request_link`/`respond_request` are WEB-11b's UI). FOCUSED REAL-BACKEND EVIDENCE for
 * a fixture-stage task: BE-Q1 and BE-CH1 have no formal completion record, so this is NOT integration acceptance (`integration_passed` stays
 * false). No PostgreSQL, HTTPS or device is exercised.
 *
 * I-PPL1 SHARE-10 through the UI; I-PPL2 SHARE-10's atomic refusal; I-PPL3 TASK-10's seven kinds and refusals; I-PPL4 TASK-10a and Q1; I-PPL5 a held
 * audience change; I-PPL6 rename; I-PPL7 unlink; I-PPL8 N5 (a)(b)(c); I-PPL9 archive and restore; I-PPL10 PPL-3; I-PPL11 PPL-5; I-PPL12 PPL-6; I-PPL13 lost
 * responses; I-PPL14 a real defaults_changed. Finding 8 (API 0.29's viewer-safe summaries): I-PPL15 the owner's complete view and a Home member's
 * partial one (list lines, scopes, rails, field tags, revocation); I-PPL16 attribution across a link, and In Home without a primary household.
 */
const API = "/api/experimental/v1";

// The merged runner owns a fresh ledger per stack; keep its pacing across worker restarts.
const budget = (who: Who) => paceSignIn(who);
test.beforeEach(async ({ context }, info) => {
  void context;
  info.setTimeout(180_000);
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

const go = (page: Page, path: string) =>
  page.evaluate((p) => {
    history.pushState(null, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);

interface Raw {
  status: number;
  body: unknown;
}
/** HARNESS: one stamped request made in the page (the session's own client), asked again while the session answers `not_sent`. */
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
  kind: string;
  parent_id: string | null;
  label: string;
  value: Record<string, unknown> | null;
  version: number;
  policy_version?: number;
  can_edit: boolean;
  archived: boolean;
}
const pageItems = (r: Raw) =>
  ((r.body as { items?: Projection[] })?.items ?? []) as Projection[];
const fieldsOf = async (page: Page, id: Id, person: string, archived = false) =>
  pageItems(
    await raw(
      page,
      id,
      "GET",
      `/fields?parent_id=${person}&limit=200${archived ? "&archived=true" : ""}`,
    ),
  );
const personOf = async (page: Page, id: Id, person: string) =>
  (await raw(page, id, "GET", `/people/${person}`)) as {
    status: number;
    body: { person: Projection; linked_account_id: string | null };
  };
const policyOf = async (page: Page, id: Id, resource: string) =>
  (await raw(page, id, "GET", `/policies/${resource}`)) as {
    status: number;
    body: {
      version: number;
      policy: { grants: unknown[]; exclude_accounts: string[] };
    };
  };
const content = (page: Page, id: Id, commands: unknown[]) =>
  raw(page, id, "POST", "/commands", { commands }, crypto.randomUUID());
const taskCommand = (page: Page, id: Id, command: unknown) =>
  raw(page, id, "POST", "/task-commands", { command }, crypto.randomUUID());
const peopleCommand = (
  page: Page,
  id: Id,
  command: unknown,
  key = crypto.randomUUID(),
) => raw(page, id, "POST", "/people-commands", { command }, key);
const management = (page: Page, id: Id, commands: unknown[]) =>
  raw(
    page,
    id,
    "POST",
    "/management-commands",
    { commands },
    crypto.randomUUID(),
  );
const PRIVATE = { grants: [], exclude_accounts: [] };

/** The fixture leader: the database arranged by the seeder, the outbox dispatcher and the sync engine started. */
async function leader(page: Page, account: string): Promise<void> {
  await page.evaluate((a) => window.__atlasData?.prepareAccount(a), account);
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(a, {});
    await data.startSync(a);
  }, account);
}
/** The page loaded again once the database exists, so the tree's controller binds it from the start; the leader restarted on it. */
async function reopenBound(
  page: Page,
  account: string,
  route: string,
  /**
   * What must be shown BEFORE the leader starts, after which the page's session and tree are settled first (revision 4). For a route
   * whose first read is refused 403: that refusal re-evaluates the session and remounts the protected tree, whose disposal closes the
   * page's connection registry, so a harness open made meanwhile is refused `closed`.
   */
  shownFirst?: () => Promise<void>,
): Promise<void> {
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await exposeSession(page);
  await untilView(page, "displaying");
  if (shownFirst) {
    await shownFirst();
    await untilTreeSettled(page, { account, connections: 0 });
  }
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(a, {});
    await data.startSync(a);
  }, account);
}
async function boot(context: BrowserContext, who: Who, route = "/people") {
  const page = await bootHarness(context, "/today");
  const id = await signedIn(page, who);
  await leader(page, id.account_id);
  await reopenBound(page, id.account_id, route);
  return { page, id };
}
/** Wakes the fixture leader's dispatcher (it is not woken by the tree's own facade). */
const send = (page: Page) =>
  page.evaluate(() => window.__atlasData?.retryOutbox());
const nudge = (page: Page) =>
  page.evaluate(() => window.__atlasData?.nudgeSync());
/** A resource is in the page's cache (after a sync). */
async function cached(
  page: Page,
  id: Id,
  resource: string,
  present = true,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await nudge(page);
        const rows = (await page.evaluate(
          (a) => window.__atlasData?.rows(a, "cache"),
          id.account_id,
        )) as Array<{ id: string }>;
        return rows.some((row) => row.id === resource);
      },
      { timeout: 60_000 },
    )
    .toBe(present);
}
const cacheRow = async (page: Page, id: Id, resource: string) =>
  (
    (await page.evaluate(
      (a) => window.__atlasData?.rows(a, "cache"),
      id.account_id,
    )) as Projection[]
  ).find((row) => row.id === resource);

/** HARNESS: a person (private) and optionally text fields, created in one batch and in the cache. */
async function seedPerson(
  page: Page,
  id: Id,
  name: string,
  fields: Array<{ label: string; text: string }> = [],
  options: { policy?: unknown } = {},
): Promise<{ person: string; fields: string[] }> {
  const person = crypto.randomUUID();
  const fieldIds = fields.map(() => crypto.randomUUID());
  const policy = options.policy ?? PRIVATE;
  const made = await content(page, id, [
    { kind: "create_person", id: person, name, initial_policy: policy },
    ...fields.map((field, i) => ({
      kind: "create_field",
      id: fieldIds[i],
      person_id: person,
      label: field.label,
      value: field.text,
      initial_policy: PRIVATE,
    })),
  ]);
  expect(made.status).toBe(200);
  await cached(page, id, person);
  return { person, fields: fieldIds };
}

/** HARNESS: A links `person` to B's account (`request_link` by A, accepted by B). */
async function link(
  a: Page,
  aId: Id,
  b: Page,
  bId: Id,
  person: string,
): Promise<void> {
  const current = await personOf(a, aId, person);
  const request = crypto.randomUUID();
  const asked = await peopleCommand(a, aId, {
    kind: "request_link",
    id: request,
    person_id: person,
    account_id: bId.account_id,
    expected_version: current.body.person.version,
  });
  expect(asked.status).toBe(200);
  const accepted = await peopleCommand(b, bId, {
    kind: "respond_request",
    id: request,
    accept: true,
  });
  expect(accepted.status).toBe(200);
}

/** HARNESS: a household made by `owner` with `member` accepting (the owner's first household is their primary one). */
async function household(
  owner: Page,
  ownerId: Id,
  member: Page,
  memberId: Id,
): Promise<string> {
  const household = crypto.randomUUID();
  expect(
    (
      await management(owner, ownerId, [
        {
          kind: "create_household",
          id: household,
          // Named as the design names it: the people screens say "{household} · can view".
          name: "Home",
        },
      ])
    ).status,
  ).toBe(200);
  const listed = (await raw(owner, ownerId, "GET", "/households"))
    .body as Array<{ id: string; version: number }>;
  const version = listed.find((h) => h.id === household)?.version as number;
  const invitation = crypto.randomUUID();
  expect(
    (
      await management(owner, ownerId, [
        {
          kind: "invite_to_household",
          id: invitation,
          household_id: household,
          recipient_id: memberId.account_id,
          expected_version: version,
        },
      ])
    ).status,
  ).toBe(200);
  const invitations = (await raw(member, memberId, "GET", "/invitations"))
    .body as Array<{ id: string; version: number }>;
  const invited = invitations.find((i) => i.id === invitation);
  expect(
    (
      await management(member, memberId, [
        {
          kind: "respond_to_household_invitation",
          id: invitation,
          expected_version: invited?.version,
          accept: true,
        },
      ])
    ).status,
  ).toBe(200);
  return household;
}

/** Waits for the page's B5 record (the people screens use the defaults). */
async function defaultsLoaded(page: Page, id: Id): Promise<void> {
  // The Sharing page reads the defaults (a list of people does not); the page then goes back where it was.
  const back =
    new URL(page.url()).searchParams.get("route") ??
    new URL(page.url()).pathname;
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
  await go(page, back);
}
const detail = (page: Page, person: string) =>
  page.locator(`[data-person-detail="${person}"]`);
const header = (page: Page) => page.locator("[data-identity-header]");

/** Adds a field through the editor on the open person detail. */
async function addField(
  page: Page,
  person: string,
  name: string,
  kind: string,
  fill: (dialog: ReturnType<Page["getByRole"]>) => Promise<void>,
  audience: string | RegExp = "Only you",
): Promise<void> {
  await detail(page, person).getByRole("link", { name: "Add a field" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a field" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("combobox", { name: "Type" }).selectOption(kind);
  await fill(dialog);
  await dialog
    .getByRole("radio", { name: audience, exact: typeof audience === "string" })
    .click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

test.describe("I-PPL1 and I-PPL2: SHARE-10, the new person batch (A8)", () => {
  test("I-PPL1 the UI's new person with a note (defaults) is ONE /commands batch: both exist afterwards, the note under the person", async ({
    context,
  }, info) => {
    const { page, id } = await boot(context, "alice");
    await defaultsLoaded(page, id);
    await page.locator('[data-people-action="new-person"]').click();
    const dialog = page.getByRole("dialog", { name: "New person" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("I-P Ada");
    await dialog.getByRole("button", { name: "Add a first note" }).click();
    await dialog
      .getByRole("textbox", { name: "First note" })
      .fill("Allergic to nuts");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/people\/[0-9a-f-]{36}$/);
    const person = new URL(page.url()).pathname.split("/").at(-1) as string;
    await send(page);
    await expect
      .poll(async () => (await personOf(page, id, person)).status, {
        timeout: 60_000,
      })
      .toBe(200);
    const notes = await fieldsOf(page, id, person);
    expect(notes.map((f) => [f.label, f.value])).toEqual([
      ["Note", { kind: "text", text: "Allergic to nuts" }],
    ]);
    const batches = (await proxy.log()).filter(
      (e) =>
        e.method === "POST" && e.path === `${API}/commands` && e.status === 200,
    );
    expect(batches.length).toBeGreaterThanOrEqual(1);
    await cached(page, id, notes[0]?.id as string);
    await expect(
      detail(page, person).locator(`[data-field-row="${notes[0]?.id}"]`),
    ).not.toContainText("Not sent yet", { timeout: 30_000 });
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({ person, notes }),
    });
  });

  test("I-PPL2 HARNESS [create_person, create_field with an invalid value] is refused 422 and commits NEITHER", async ({
    context,
    provokes,
  }, info) => {
    provokes(422, 404);
    const { page, id } = await boot(context, "carol", "/today");
    const person = crypto.randomUUID();
    const field = crypto.randomUUID();
    const refused = await content(page, id, [
      {
        kind: "create_person",
        id: person,
        name: "I-P Nobody",
        initial_policy: PRIVATE,
      },
      {
        kind: "create_field",
        id: field,
        person_id: person,
        label: "Note",
        value: "x".repeat(4097),
        initial_policy: PRIVATE,
      },
    ]);
    expect(refused.status).toBe(422);
    expect((await personOf(page, id, person)).status).toBe(404);
    const all = pageItems(await raw(page, id, "GET", "/fields?limit=200"));
    expect(all.some((f) => f.id === field)).toBe(false);
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({ status: refused.status }),
    });
  });
});

test.describe("I-PPL3: TASK-10, the seven kinds and the refusals (A3)", () => {
  test("the UI creates every kind; GET /fields equals the client's values; a put_field under a list is invalid_value; a generic edit of a typed field is 422", async ({
    context,
    provokes,
  }, info) => {
    provokes(422);
    const { page, id } = await boot(context, "dave");
    const { person } = await seedPerson(page, id, "I-P Kinds");
    await go(page, `/people/${person}`);
    await expect(detail(page, person)).toBeVisible({ timeout: 30_000 });
    await addField(page, person, "Note", "text", (d) =>
      d.getByRole("textbox", { name: "Value" }).fill("Nuts"),
    );
    await addField(page, person, "Weight", "quantity", async (d) => {
      await d.getByRole("textbox", { name: "Amount" }).fill("21.5");
      await d.getByRole("textbox", { name: "Unit" }).fill("kg");
    });
    await addField(page, person, "Birthday", "date", async (d) => {
      await d.getByRole("textbox", { name: "Day" }).fill("29");
      await d.getByRole("textbox", { name: "Month" }).fill("2");
    });
    await addField(page, person, "School", "url", (d) =>
      d.getByRole("textbox", { name: "Link" }).fill("https://school.example/a"),
    );
    await addField(page, person, "Swims", "boolean", (d) =>
      d.getByRole("radio", { name: "Yes" }).click(),
    );
    await addField(page, person, "Size", "choices", async (d) => {
      await d.getByRole("button", { name: "Add an option" }).click();
      await d.getByRole("textbox", { name: "Option 1" }).fill("S");
      await d.getByRole("button", { name: "Add an option" }).click();
      await d.getByRole("textbox", { name: "Option 2" }).fill("M");
      await d.getByRole("checkbox", { name: "Selected" }).nth(1).check();
    });
    await addField(page, person, "Kit", "checklist", async (d) => {
      await d.getByRole("button", { name: "Add an item" }).click();
      await d.getByRole("textbox", { name: "Item 1" }).fill("Boots");
      await d.getByRole("checkbox", { name: "Done" }).check();
    });
    await send(page);
    await expect
      .poll(async () => (await fieldsOf(page, id, person)).length, {
        timeout: 60_000,
      })
      .toBe(7);
    const bodies = (await page.evaluate(
      (a) => window.__atlasData?.rows(a, "draft_commands"),
      id.account_id,
    )) as unknown[];
    void bodies;
    const server = Object.fromEntries(
      (await fieldsOf(page, id, person)).map((f) => [f.label, f.value]),
    );
    expect(server.Note).toEqual({ kind: "text", text: "Nuts" });
    expect(server.Weight).toEqual({
      kind: "quantity",
      amount: "21.5",
      unit: "kg",
    });
    expect(server.Birthday).toMatchObject({ kind: "date", month: 2, day: 29 });
    expect(server.School).toEqual({
      kind: "url",
      url: "https://school.example/a",
    });
    expect(server.Swims).toEqual({ kind: "boolean", value: true });
    expect(server.Size).toEqual({
      kind: "choices",
      options: ["S", "M"],
      selected: ["M"],
    });
    expect(server.Kit).toMatchObject({
      kind: "checklist",
      items: [{ label: "Boots" }],
    });
    // A parent that is neither a person nor a task is refused (the server's own parent rule; a list stands in for an occurrence).
    const list = crypto.randomUUID();
    expect(
      (
        await taskCommand(page, id, {
          kind: "create_list",
          id: list,
          name: "I-P List",
          initial_policy: PRIVATE,
        })
      ).status,
    ).toBe(200);
    const underList = await taskCommand(page, id, {
      kind: "put_field",
      id: crypto.randomUUID(),
      parent_id: list,
      label: "x",
      value: { kind: "text", text: "x" },
      initial_policy: PRIVATE,
    });
    expect(underList.status).toBe(422);
    expect((underList.body as { code: string }).code).toBe("invalid_value");
    // A generic content edit of a typed (non-text) field is refused.
    const weight = (await fieldsOf(page, id, person)).find(
      (f) => f.label === "Weight",
    ) as Projection;
    const generic = await content(page, id, [
      {
        kind: "edit",
        id: weight.id,
        expected_version: weight.version,
        expected_policy_version: weight.policy_version,
        label: "Weight",
        value: "70",
      },
    ]);
    expect(generic.status).toBe(422);
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({
        server,
        underList: underList.status,
        generic: generic.status,
      }),
    });
  });
});

test.describe("I-PPL4: TASK-10a's preconditions and Q1 (A4, A5)", () => {
  test("an update with the current versions succeeds; initial_policy on update and a changed parent are invalid_value; a policy changed after the edit began is a 409 the UI shows as a conflict", async ({
    context,
    provokes,
  }, info) => {
    provokes(409, 422);
    const { page, id } = await boot(context, "erin");
    const { person, fields } = await seedPerson(page, id, "I-P Q1", [
      { label: "Phone", text: "0770" },
    ]);
    const other = (await seedPerson(page, id, "I-P Other")).person;
    const field = fields[0] as string;
    await cached(page, id, field);
    // The UI's update succeeds.
    await go(page, `/people/${person}/fields/${field}`);
    let dialog = page.getByRole("dialog", { name: "Edit Phone" });
    await dialog.getByRole("textbox", { name: "Value" }).fill("0771");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await send(page);
    await expect
      .poll(async () => (await fieldsOf(page, id, person))[0]?.value, {
        timeout: 60_000,
      })
      .toEqual({ kind: "text", text: "0771" });
    const now = (await fieldsOf(page, id, person))[0] as Projection;
    // HARNESS: initial_policy on an update, and a changed parent, are refused.
    const withPolicy = await taskCommand(page, id, {
      kind: "put_field",
      id: field,
      parent_id: person,
      expected_version: now.version,
      expected_policy_version: now.policy_version,
      label: "Phone",
      value: { kind: "text", text: "x" },
      initial_policy: PRIVATE,
    });
    expect([
      withPolicy.status,
      (withPolicy.body as { code: string }).code,
    ]).toEqual([422, "invalid_value"]);
    const moved = await taskCommand(page, id, {
      kind: "put_field",
      id: field,
      parent_id: other,
      expected_version: now.version,
      expected_policy_version: now.policy_version,
      label: "Phone",
      value: { kind: "text", text: "x" },
    });
    expect([moved.status, (moved.body as { code: string }).code]).toEqual([
      422,
      "invalid_value",
    ]);
    // Q1: the cache keeps the pre-change policy version (sync paused), the policy changes on the server, and the UI's save is refused.
    await cached(page, id, field);
    await page.evaluate(() => window.__atlasData?.stopSync());
    const policy = await policyOf(page, id, field);
    expect(
      (
        await management(page, id, [
          {
            kind: "replace_policy",
            id: field,
            expected_version: policy.body.version,
            policy: { grants: [], exclude_accounts: [] },
          },
        ])
      ).status,
    ).toBe(200);
    await go(page, `/people/${person}/fields/${field}`);
    dialog = page.getByRole("dialog", { name: "Edit Phone" });
    await dialog.getByRole("textbox", { name: "Value" }).fill("0772");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await send(page);
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (a) => window.__atlasData?.queue(a),
              id.account_id,
            )) as Array<{ status: string }>
          ).map((r) => r.status),
        { timeout: 60_000 },
      )
      .toContain("version_conflict");
    expect((await fieldsOf(page, id, person))[0]?.value).toEqual({
      kind: "text",
      text: "0771",
    });
    const statuses = (await proxy.log())
      .filter((e) => e.method === "POST" && e.path === `${API}/task-commands`)
      .map((e) => e.status);
    expect(statuses).toContain(409);
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({ statuses }),
    });
  });
});

test.describe("I-PPL5: a held audience change (A6)", () => {
  test("offline edit + narrow to Only you, held; on reconnect the policy is replaced first, the member loses the field, then the new value lands", async ({
    browser,
  }, info) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    try {
      const { page, id } = await boot(ownerContext, "frank");
      const member = await bootHarness(memberContext, "/today");
      const memberId = await signedIn(member, "grace");
      await household(page, id, member, memberId);
      await reopenBound(page, id.account_id, "/people");
      await defaultsLoaded(page, id);
      // A queued create may not grant anyone: the person is created private, then shared with the member (a field needs its person
      // visible to be visible itself, PPL-5).
      const { person } = await seedPerson(page, id, "I-P Held");
      const personPolicy = await policyOf(page, id, person);
      expect(
        (
          await management(page, id, [
            {
              kind: "replace_policy",
              id: person,
              expected_version: personPolicy.body.version,
              policy: {
                grants: [
                  { kind: "account", id: memberId.account_id, edit: false },
                ],
                exclude_accounts: [],
              },
            },
          ])
        ).status,
      ).toBe(200);
      await go(page, `/people/${person}`);
      await expect(detail(page, person)).toBeVisible({ timeout: 30_000 });
      // Created shared with Home, online (task-access-commands).
      await addField(
        page,
        person,
        "Note",
        "text",
        (d) => d.getByRole("textbox", { name: "Value" }).fill("Inhaler"),
        "Home · can view",
      );
      await expect
        .poll(async () => (await fieldsOf(member, memberId, person)).length, {
          timeout: 60_000,
        })
        .toBe(1);
      const field = (await fieldsOf(page, id, person))[0] as Projection;
      await cached(page, id, field.id);
      await go(page, `/people/${person}/fields/${field.id}`);
      const dialog = page.getByRole("dialog", { name: "Edit Note" });
      await expect(
        dialog.getByRole("radio", { name: "Home · can view", exact: true }),
      ).toBeChecked({ timeout: 30_000 });
      await ownerContext.setOffline(true);
      await expect
        .poll(() => page.evaluate(() => navigator.onLine))
        .toBe(false);
      await dialog
        .getByRole("textbox", { name: "Value" })
        .fill("Inhaler in the blue bag");
      await dialog
        .getByRole("radio", { name: "Only you", exact: true })
        .click();
      await dialog.getByRole("button", { name: "Save" }).click();
      await dialog.getByRole("button", { name: "Hold as draft" }).click();
      await expect(dialog).toBeHidden();
      await ownerContext.setOffline(false);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
      await expect
        .poll(
          async () => (await policyOf(page, id, field.id)).body.policy.grants,
          { timeout: 60_000 },
        )
        .toEqual([]);
      await send(page);
      await expect
        .poll(async () => (await fieldsOf(page, id, person))[0]?.value, {
          timeout: 60_000,
        })
        .toEqual({ kind: "text", text: "Inhaler in the blue bag" });
      expect(await fieldsOf(member, memberId, person)).toEqual([]);
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ field: field.id }),
      });
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });
});

test.describe("I-PPL6 to I-PPL8: rename, unlink and N5 (A9, A10, A11)", () => {
  test("I-PPL6 the linked account renames in the UI (rename_profile); another caller is forbidden; an unlinked person renamed offline through the edit syncs", async ({
    browser,
    provokes,
  }, info) => {
    provokes(403);
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "heidi", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "ivan");
      const { person } = await seedPerson(a, aId, "I-P Ivan");
      await link(a, aId, b, bId, person);
      await leader(b, bId.account_id);
      await reopenBound(b, bId.account_id, `/people/${person}`);
      await cached(b, bId, person);
      await go(b, `/people/${person}`);
      await expect(header(b)).toContainText(
        "This is you — you control this profile",
        { timeout: 30_000 },
      );
      await header(b).getByRole("button", { name: "Rename" }).click();
      await header(b)
        .getByRole("textbox", { name: "Name" })
        .fill("Ivan Renamed");
      await header(b).getByRole("button", { name: "Save" }).click();
      await expect
        .poll(async () => (await personOf(b, bId, person)).body.person.label, {
          timeout: 30_000,
        })
        .toBe("Ivan Renamed");
      // An unlinked person of A, renamed offline through the content edit.
      const { person: plain } = await seedPerson(a, aId, "I-P Plain");
      await reopenBound(a, aId.account_id, `/people/${plain}`);
      await expect(header(a)).toContainText("Not linked to an account", {
        timeout: 30_000,
      });
      await aContext.setOffline(true);
      await expect.poll(() => a.evaluate(() => navigator.onLine)).toBe(false);
      await header(a).getByRole("button", { name: "Rename" }).click();
      await header(a)
        .getByRole("textbox", { name: "Name" })
        .fill("I-P Plain Renamed");
      await header(a).getByRole("button", { name: "Save" }).click();
      await expect(header(a)).toContainText("Not sent yet");
      await aContext.setOffline(false);
      await send(a);
      await expect
        .poll(async () => (await personOf(a, aId, plain)).body.person.label, {
          timeout: 60_000,
        })
        .toBe("I-P Plain Renamed");
      // Last: a 403 makes the page close and reopen its protected display (the session classifies it), which ends the harness's store.
      // HARNESS: the creator is not the linked account.
      const current = await personOf(a, aId, person);
      const forbidden = await peopleCommand(a, aId, {
        kind: "rename_profile",
        person_id: person,
        expected_version: current.body.person.version,
        name: "Not yours",
      });
      expect(forbidden.status).toBe(403);
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ forbidden: forbidden.status }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });

  test("I-PPL7 the linked account unlinks in the UI; every field and its policy are unchanged; the creator's view is unchanged", async ({
    browser,
  }, info) => {
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "judy", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "kate");
      const { person, fields } = await seedPerson(a, aId, "I-P Kate", [
        { label: "Phone", text: "0770" },
      ]);
      await link(a, aId, b, bId, person);
      const beforeFields = await fieldsOf(a, aId, person);
      const beforePolicies = await Promise.all(
        fields.map((f) => policyOf(a, aId, f)),
      );
      await leader(b, bId.account_id);
      await reopenBound(b, bId.account_id, `/people/${person}`);
      await cached(b, bId, person);
      await go(b, `/people/${person}`);
      await header(b)
        .getByRole("button", { name: "Unlink account" })
        .click({ timeout: 30_000 });
      await b
        .getByRole("dialog", { name: "Unlink your account from this profile?" })
        .getByRole("button", { name: "Unlink account" })
        .click();
      await expect
        .poll(
          async () => (await personOf(a, aId, person)).body.linked_account_id,
          { timeout: 30_000 },
        )
        .toBeNull();
      expect(
        (await fieldsOf(a, aId, person)).map((f) => [
          f.id,
          f.value,
          f.policy_version,
        ]),
      ).toEqual(beforeFields.map((f) => [f.id, f.value, f.policy_version]));
      const afterPolicies = await Promise.all(
        fields.map((f) => policyOf(a, aId, f)),
      );
      expect(afterPolicies.map((p) => p.body)).toEqual(
        beforePolicies.map((p) => p.body),
      );
      await expect(header(b)).toContainText(
        /Not linked to an account|isn't known/,
      );
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ person }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });

  test("I-PPL8 N5: after unlink, (a) reference_account with a fresh id makes a NEW person, (b) naming the unlinked id does not reattach it, (c) only an accepted request_link restores the link", async ({
    browser,
  }, info) => {
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    const cContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "liam", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "mia");
      const { person, fields } = await seedPerson(a, aId, "I-P Mia", [
        { label: "Phone", text: "0770" },
      ]);
      await link(a, aId, b, bId, person);
      const linkedVersion = (await personOf(b, bId, person)).body.person
        .version;
      expect(
        (
          await peopleCommand(b, bId, {
            kind: "unlink",
            person_id: person,
            expected_version: linkedVersion,
          })
        ).status,
      ).toBe(200);
      // (a) a fresh proposed id: a new person for B, never the unlinked one.
      const fresh = crypto.randomUUID();
      const referenced = await peopleCommand(a, aId, {
        kind: "reference_account",
        account_id: bId.account_id,
        person_id: fresh,
      });
      expect(referenced.status).toBe(200);
      const made = (referenced.body as { person_id: string }).person_id;
      expect(made).not.toBe(person);
      expect(
        (await personOf(a, aId, person)).body.linked_account_id,
      ).toBeNull();
      // (b) the same call naming the unlinked id does not reattach it.
      const again = await peopleCommand(a, aId, {
        kind: "reference_account",
        account_id: bId.account_id,
        person_id: person,
      });
      expect((again.body as { person_id?: string }).person_id ?? null).not.toBe(
        person,
      );
      expect(
        (await personOf(a, aId, person)).body.linked_account_id,
      ).toBeNull();
      // The UI reads it as not linked.
      await go(a, `/people/${person}`);
      await expect(header(a)).toContainText("Not linked to an account", {
        timeout: 30_000,
      });
      // (c) in a clean pair (the recipient has no self-person, so the request links rather than merges): only the accepted request links.
      const c = await bootHarness(cContext, "/today");
      const cId = await signedIn(c, "nora");
      const second = await seedPerson(a, aId, "I-P Nora", [
        { label: "Phone", text: "0771" },
      ]);
      await link(a, aId, c, cId, second.person);
      const linked = (await personOf(c, cId, second.person)).body;
      expect(
        (
          await peopleCommand(c, cId, {
            kind: "unlink",
            person_id: second.person,
            expected_version: linked.person.version,
          })
        ).status,
      ).toBe(200);
      const fieldsBefore = await fieldsOf(a, aId, second.person);
      const policiesBefore = await Promise.all(
        second.fields.map((f) => policyOf(a, aId, f)),
      );
      expect(
        (await personOf(a, aId, second.person)).body.linked_account_id,
      ).toBeNull();
      // A link transferred ownership to C, and an unlink keeps it there: the owner of the unlinked person is the one who may ask
      // (docs/people.md: "The owner of an unlinked person asks an account holder to accept linking"). Only the accepted request links.
      const owner = (await personOf(c, cId, second.person)).body.person;
      const request = crypto.randomUUID();
      const asked = await peopleCommand(c, cId, {
        kind: "request_link",
        id: request,
        person_id: second.person,
        account_id: cId.account_id,
        expected_version: owner.version,
      });
      expect(asked.status).toBe(200);
      // Asked but not yet accepted: still unlinked.
      expect(
        (await personOf(a, aId, second.person)).body.linked_account_id,
      ).toBeNull();
      expect(
        (
          await peopleCommand(c, cId, {
            kind: "respond_request",
            id: request,
            accept: true,
          })
        ).status,
      ).toBe(200);
      expect(
        (await personOf(a, aId, second.person)).body.linked_account_id,
      ).toBe(cId.account_id);
      expect(
        (await fieldsOf(a, aId, second.person)).map((f) => [f.id, f.value]),
      ).toEqual(fieldsBefore.map((f) => [f.id, f.value]));
      const policiesAfter = await Promise.all(
        second.fields.map((f) => policyOf(a, aId, f)),
      );
      expect(policiesAfter.map((p) => p.body.policy)).toEqual(
        policiesBefore.map((p) => p.body.policy),
      );
      void fields;
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({
          made,
          again: again.status,
          asked: asked.status,
        }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
      await cContext.close();
    }
  });
});

test.describe("I-PPL9: archive and restore (A12)", () => {
  test("a field and a person archived offline then sent; archived rows still sync; GET /fields?archived=true lists the field; restore returns both", async ({
    context,
  }, info) => {
    const { page, id } = await boot(context, "olga");
    const { person, fields } = await seedPerson(page, id, "I-P Archive", [
      { label: "Old contact", text: "x" },
    ]);
    const field = fields[0] as string;
    await cached(page, id, field);
    await go(page, `/people/${person}`);
    await expect(detail(page, person)).toBeVisible({ timeout: 30_000 });
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await detail(page, person)
      .locator(`[data-field-row="${field}"]`)
      .getByRole("button", { name: "Archive" })
      .click();
    await header(page).getByRole("button", { name: "Archive" }).click();
    await context.setOffline(false);
    await send(page);
    await expect
      .poll(
        async () => (await personOf(page, id, person)).body.person.archived,
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () => (await fieldsOf(page, id, person, true)).map((f) => f.id),
        { timeout: 60_000 },
      )
      .toEqual([field]);
    expect(await fieldsOf(page, id, person)).toEqual([]);
    // Archived rows still sync, with archived: true.
    await expect
      .poll(
        async () => {
          await nudge(page);
          return (await cacheRow(page, id, field))?.archived;
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await cacheRow(page, id, person))?.archived, {
        timeout: 60_000,
      })
      .toBe(true);
    await go(page, "/settings/archived");
    await page
      .locator(`[data-archived-row="${person}"]`)
      .getByRole("button", { name: "Restore" })
      .click({ timeout: 30_000 });
    await page
      .locator(`[data-archived-row="${field}"]`)
      .getByRole("button", { name: "Restore" })
      .click({ timeout: 30_000 });
    await send(page);
    await expect
      .poll(
        async () => (await personOf(page, id, person)).body.person.archived,
        { timeout: 60_000 },
      )
      .toBe(false);
    await expect
      .poll(async () => (await fieldsOf(page, id, person)).map((f) => f.id), {
        timeout: 60_000,
      })
      .toEqual([field]);
    const receipts = (await proxy.log())
      .filter((e) => e.method === "POST" && e.path === `${API}/task-commands`)
      .map((e) => e.status);
    expect(receipts.filter((s) => s === 200).length).toBeGreaterThanOrEqual(4);
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({ receipts }),
    });
  });
});

test.describe("I-PPL10: PPL-3 (A13)", () => {
  test("a first page that scanned 50 dissimilar people is empty with next_after: the UI never claims completeness; Check more finds the similar name; null says none remain", async ({
    context,
  }, info) => {
    const { page, id } = await boot(context, "pete", "/today");
    // UUID order decides the scan: 52 dissimilar people sort first, then the target and its look-alike.
    const people = Array.from({ length: 52 }, (_, i) => ({
      id: `00000000-${String(i).padStart(4, "0")}-4000-8000-${crypto.randomUUID().slice(-12)}`,
      name: `Unrelated ${i} ${crypto.randomUUID().slice(0, 6)}`,
    }));
    for (let at = 0; at < people.length; at += 20)
      expect(
        (
          await content(
            page,
            id,
            people.slice(at, at + 20).map((p) => ({
              kind: "create_person",
              id: p.id,
              name: p.name,
              initial_policy: PRIVATE,
            })),
          )
        ).status,
      ).toBe(200);
    const target = `ffffffff-0000-4000-8000-${crypto.randomUUID().slice(-12)}`;
    const twin = `ffffffff-0001-4000-8000-${crypto.randomUUID().slice(-12)}`;
    expect(
      (
        await content(page, id, [
          {
            kind: "create_person",
            id: target,
            name: "Mohammed Pettigrew",
            initial_policy: PRIVATE,
          },
          {
            kind: "create_person",
            id: twin,
            name: "Mohammed Pettigrew",
            initial_policy: PRIVATE,
          },
        ])
      ).status,
    ).toBe(200);
    await cached(page, id, target);
    await go(page, `/people/${target}/duplicates`);
    await expect(
      page.getByText(
        "No similar names found so far. There are more people to check.",
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText("Nothing looks like a duplicate right now."),
    ).toHaveCount(0);
    // One page at a time: each "Check more" is pressed only once the previous read has answered (the button is enabled again or gone).
    const checkMore = page.getByRole("button", { name: "Check more" });
    const hint = page.locator(`[data-duplicate-hint="${twin}"]`);
    const settled = async () => {
      await expect
        .poll(
          // One read in the page: the button is gone, or there and enabled (a count then a separate isEnabled() can race its removal,
          // and isEnabled() then waits for an element that will never come back).
          () =>
            page.evaluate(() => {
              const button = [...document.querySelectorAll("button")].find(
                (b) => b.textContent?.trim() === "Check more",
              );
              return button === undefined || !button.disabled;
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
    };
    for (let i = 0; i < 3 && (await hint.count()) === 0; i += 1) {
      await checkMore.click();
      await settled();
    }
    await expect(hint).toBeVisible({ timeout: 30_000 });
    for (let i = 0; i < 3 && (await checkMore.count()) > 0; i += 1) {
      await checkMore.click();
      await settled();
    }
    await expect(checkMore).toHaveCount(0, { timeout: 30_000 });
    const reads = (await proxy.log()).filter((e) =>
      e.path.includes("/duplicates"),
    ).length;
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({ reads }),
    });
  });
});

test.describe("I-PPL11 and I-PPL12: PPL-5 and PPL-6 (A14, A15)", () => {
  test("I-PPL11 the owner removes B's access to the person while B keeps a field grant: B's cache drops the person and B's UI shows none of its fields", async ({
    browser,
  }, info) => {
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "quinn", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "bob");
      const grant = {
        grants: [{ kind: "account", id: bId.account_id, edit: false }],
        exclude_accounts: [],
      };
      const person = crypto.randomUUID();
      const field = crypto.randomUUID();
      expect(
        (
          await content(a, aId, [
            {
              kind: "create_person",
              id: person,
              name: "I-P Shared",
              initial_policy: PRIVATE,
            },
          ])
        ).status,
      ).toBe(200);
      const pp = await policyOf(a, aId, person);
      expect(
        (
          await management(a, aId, [
            {
              kind: "replace_policy",
              id: person,
              expected_version: pp.body.version,
              policy: grant,
            },
          ])
        ).status,
      ).toBe(200);
      const created = await raw(
        a,
        aId,
        "POST",
        "/task-access-commands",
        {
          command: {
            kind: "put_field",
            id: field,
            parent_id: person,
            label: "Secret",
            value: { kind: "text", text: "x" },
            initial_policy: grant,
          },
        },
        crypto.randomUUID(),
      );
      expect(created.status).toBe(200);
      await leader(b, bId.account_id);
      await reopenBound(b, bId.account_id, "/today");
      await cached(b, bId, field);
      const now = await policyOf(a, aId, person);
      expect(
        (
          await management(a, aId, [
            {
              kind: "replace_policy",
              id: person,
              expected_version: now.body.version,
              policy: PRIVATE,
            },
          ])
        ).status,
      ).toBe(200);
      // B still holds the field-level grant, but a field needs its person visible.
      expect((await policyOf(a, aId, field)).body.policy).toEqual(grant);
      await cached(b, bId, person, false);
      await cached(b, bId, field, false);
      await go(b, `/people/${person}`);
      await expect(b.getByText(/This person isn't on this device/)).toBeVisible(
        { timeout: 30_000 },
      );
      await expect(b.getByText("Secret")).toHaveCount(0);
      await go(b, "/settings/archived");
      await expect(b.getByText("Secret")).toHaveCount(0);
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ person, field }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });

  test("I-PPL12 a field with defaults under a person linked to B excludes B; an explicit Home policy reaches B", async ({
    browser,
  }, info) => {
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "nora", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "olga");
      await household(a, aId, b, bId);
      const templates = await raw(a, aId, "GET", "/defaults/templates");
      expect(
        (
          await management(a, aId, [
            {
              kind: "set_defaults",
              household_id: null,
              resource_kind: "field",
              expected_version: (
                templates.body as { field: { version: number } }
              ).field.version,
              template: { kind: "primary_household", edit: false },
            },
          ])
        ).status,
      ).toBe(200);
      const { person } = await seedPerson(a, aId, "I-P Olga");
      await link(a, aId, b, bId, person);
      await reopenBound(a, aId.account_id, `/people/${person}`);
      await defaultsLoaded(a, aId);
      await cached(a, aId, person);
      await go(a, `/people/${person}`);
      await expect(header(a)).toContainText("controls this name, not you", {
        timeout: 30_000,
      });
      await addField(
        a,
        person,
        "By defaults",
        "text",
        async (d) => {
          await d.getByRole("textbox", { name: "Value" }).fill("x");
          await expect(
            d.getByText(/won't see this field unless you share it with them/),
          ).toBeVisible();
        },
        /Use my defaults/,
      );
      await addField(
        a,
        person,
        "Shared",
        "text",
        (d) => d.getByRole("textbox", { name: "Value" }).fill("y"),
        "Home · can view",
      );
      await send(a);
      await expect
        .poll(async () => (await fieldsOf(a, aId, person)).length, {
          timeout: 60_000,
        })
        .toBe(2);
      await expect
        .poll(
          async () => (await fieldsOf(b, bId, person)).map((f) => f.label),
          { timeout: 60_000 },
        )
        .toEqual(["Shared"]);
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ person }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });
});

test.describe("I-PPL13: lost responses (A17)", () => {
  test("the proxy drops rename_profile's answer after commit: Try again resends the same key and body and the name changes once; the same for a shared create", async ({
    browser,
  }, info) => {
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "kate", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "liam");
      await household(b, bId, a, aId);
      const { person } = await seedPerson(a, aId, "I-P Lost");
      await link(a, aId, b, bId, person);
      await leader(b, bId.account_id);
      await reopenBound(b, bId.account_id, `/people/${person}`);
      await cached(b, bId, person);
      await go(b, `/people/${person}`);
      const before = (await personOf(b, bId, person)).body.person.version;
      const seen: Array<{ key: string | null; body: string }> = [];
      b.on("request", (r) => {
        if (
          r.method() === "POST" &&
          new URL(r.url()).pathname.endsWith("/people-commands")
        )
          seen.push({
            key: r.headers()["idempotency-key"] ?? null,
            body: r.postData() ?? "",
          });
      });
      await proxy.addRule({
        id: "drop-rename",
        method: "POST",
        path: `${API}/people-commands`,
        ordinal: 1,
        action: "drop_after_forward",
      });
      await header(b)
        .getByRole("button", { name: "Rename" })
        .click({ timeout: 30_000 });
      await header(b).getByRole("textbox", { name: "Name" }).fill("Liam Once");
      await header(b).getByRole("button", { name: "Save" }).click();
      await expect(header(b)).toContainText(
        "We couldn't confirm this was saved",
        { timeout: 30_000 },
      );
      await header(b).getByRole("button", { name: "Save" }).click();
      await expect.poll(() => seen.length, { timeout: 30_000 }).toBe(2);
      expect(seen[1]).toEqual(seen[0]);
      const after = (await personOf(b, bId, person)).body.person;
      expect(after.label).toBe("Liam Once");
      expect(after.version).toBe(before + 1);
      await proxy.removeRule("drop-rename");
      // A shared create (task-access-commands), its answer dropped once.
      const shared: Array<{ key: string | null; body: string }> = [];
      b.on("request", (r) => {
        if (
          r.method() === "POST" &&
          new URL(r.url()).pathname.endsWith("/task-access-commands")
        )
          shared.push({
            key: r.headers()["idempotency-key"] ?? null,
            body: r.postData() ?? "",
          });
      });
      await reopenBound(b, bId.account_id, `/people/${person}`);
      await defaultsLoaded(b, bId);
      await proxy.addRule({
        id: "drop-create",
        method: "POST",
        path: `${API}/task-access-commands`,
        ordinal: 1,
        action: "drop_after_forward",
      });
      await detail(b, person)
        .getByRole("link", { name: "Add a field" })
        .click({ timeout: 30_000 });
      const dialog = b.getByRole("dialog", { name: "Add a field" });
      await dialog.getByRole("textbox", { name: "Name" }).fill("Once");
      await dialog.getByRole("textbox", { name: "Value" }).fill("only once");
      await dialog
        .getByRole("radio", { name: "Home · can view", exact: true })
        .click();
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toContainText("We couldn't confirm this was saved", {
        timeout: 30_000,
      });
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      expect(shared).toHaveLength(2);
      expect(shared[1]).toEqual(shared[0]);
      expect(
        (await fieldsOf(b, bId, person)).filter((f) => f.label === "Once"),
      ).toHaveLength(1);
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({
          rename: seen.length,
          create: shared.length,
        }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });
});

test.describe("I-PPL14: a real defaults_changed (A16)", () => {
  test("a field queued under revision R1 is refused when the defaults move to R2; reviewed and confirmed, it is created once", async ({
    context,
    provokes,
  }, info) => {
    provokes(409);
    const { page, id } = await boot(context, "mia");
    await defaultsLoaded(page, id);
    const { person } = await seedPerson(page, id, "I-P Review");
    await go(page, `/people/${person}`);
    await expect(detail(page, person)).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.__atlasData?.stopOutbox());
    await addField(
      page,
      person,
      "Reviewed",
      "text",
      (d) => d.getByRole("textbox", { name: "Value" }).fill("x"),
      /Use my defaults/,
    );
    const templates = await raw(page, id, "GET", "/defaults/templates");
    expect(
      (
        await management(page, id, [
          {
            kind: "set_defaults",
            household_id: null,
            resource_kind: "field",
            expected_version: (templates.body as { field: { version: number } })
              .field.version,
            template: { kind: "private" },
          },
        ])
      ).status,
    ).toBe(200);
    await page.evaluate(
      (a) => window.__atlasData?.startOutbox(a, {}),
      id.account_id,
    );
    await send(page);
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (a) => window.__atlasData?.queue(a),
              id.account_id,
            )) as Array<{ review_block: boolean }>
          ).some((r) => r.review_block),
        { timeout: 60_000 },
      )
      .toBe(true);
    await go(page, "/sync?tab=conflicts");
    await page
      .getByRole("button", { name: /^Review sharing/ })
      .click({ timeout: 30_000 });
    const review = page.getByRole("dialog", { name: "Review sharing" });
    await expect(review).toContainText("Sharing defaults have changed", {
      timeout: 30_000,
    });
    await review.locator("[data-confirm]").click();
    await expect(review).toBeHidden({ timeout: 30_000 });
    await send(page);
    await expect
      .poll(
        async () =>
          (await fieldsOf(page, id, person)).filter(
            (f) => f.label === "Reviewed",
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1);
    const statuses = (await proxy.log())
      .filter((e) => e.method === "POST" && e.path === `${API}/task-commands`)
      .map((e) => e.status);
    expect(statuses).toEqual(expect.arrayContaining([409, 200]));
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({ statuses }),
    });
  });
});

// ---- finding 8: the viewer-safe summaries against the released backend (API 0.29) -------------------------------------------------------
/** HARNESS: makes `household` the account's primary household (`set_primary_household`, guarded by its `preferences_version`). */
async function primary(page: Page, id: Id, household: string): Promise<void> {
  const defaults = (await raw(page, id, "GET", "/defaults")).body as {
    preferences_version: number;
    primary_household_id: string | null;
  };
  if (defaults.primary_household_id === household) return;
  expect(
    (
      await management(page, id, [
        {
          kind: "set_primary_household",
          household_id: household,
          expected_version: defaults.preferences_version,
        },
      ])
    ).status,
  ).toBe(200);
}
const personRow = (page: Page, person: string) =>
  page.locator(`[data-person-row="${person}"]`);
const fieldRowOf = (page: Page, field: string) =>
  page.locator(`[data-field-row="${field}"]`);
const view = (page: Page, name: string) =>
  page
    .locator("[data-people-list]")
    .getByRole("button", { name, exact: true })
    .click();

test.describe("I-PPL15 and I-PPL16: the viewer-safe summaries (finding 8, API 0.29)", () => {
  test("I-PPL15 the owner's complete view and a Home member's partial one: list lines, scopes, rails, field tags; a revocation leaves the member's scope", async ({
    browser,
  }, info) => {
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "carol", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "dave");
      const home = await household(a, aId, b, bId);
      await primary(a, aId, home);
      await primary(b, bId, home);
      const homeView = {
        grants: [{ kind: "household", id: home, edit: false }],
        exclude_accounts: [],
      };
      // HARNESS: made private, then shared with Home (a content create carries no household grant).
      const shared = await seedPerson(a, aId, "I-S Shared");
      const created = await policyOf(a, aId, shared.person);
      expect(
        (
          await management(a, aId, [
            {
              kind: "replace_policy",
              id: shared.person,
              expected_version: created.body.version,
              policy: homeView,
            },
          ])
        ).status,
      ).toBe(200);
      const own = await seedPerson(a, aId, "I-S Private");
      const visible = crypto.randomUUID();
      const hidden = crypto.randomUUID();
      const fieldCommand = (field: string, label: string, policy: unknown) => ({
        kind: "put_field",
        id: field,
        parent_id: shared.person,
        label,
        value: { kind: "text", text: label },
        initial_policy: policy,
      });
      // HARNESS: a shared create is online (/task-access-commands); a private one is an ordinary task command.
      const madeVisible = await raw(
        a,
        aId,
        "POST",
        "/task-access-commands",
        { command: fieldCommand(visible, "Phone", homeView) },
        crypto.randomUUID(),
      );
      expect(madeVisible.status, JSON.stringify(madeVisible.body)).toBe(200);
      const madeHidden = await taskCommand(
        a,
        aId,
        fieldCommand(hidden, "Note", PRIVATE),
      );
      expect(madeHidden.status, JSON.stringify(madeHidden.body)).toBe(200);
      await cached(a, aId, hidden);
      // The owner: complete.
      await go(a, "/people");
      await expect(personRow(a, shared.person)).toContainText(
        "Visible to: Home · can view",
        { timeout: 30_000 },
      );
      await expect(personRow(a, shared.person)).toContainText("Added by you");
      await expect(personRow(a, shared.person)).toContainText(
        "Not linked to an account",
      );
      await expect(personRow(a, own.person)).toContainText(
        "Visible to: Only you",
      );
      await go(a, `/people/${shared.person}`);
      const ownerRail = a.getByRole("region", { name: "Shared with" });
      await expect(ownerRail).toHaveAttribute("data-shared-with", "complete", {
        timeout: 30_000,
      });
      await expect(ownerRail).toContainText(ACCOUNTS.dave.username);
      await expect(ownerRail).toContainText("2 members in the household");
      await expect(fieldRowOf(a, visible)).toContainText("Home · can view", {
        timeout: 30_000,
      });
      await expect(fieldRowOf(a, visible)).toContainText(
        "1 other person can see it.",
      );
      await expect(fieldRowOf(a, hidden)).toContainText("Only you");
      await expect(fieldRowOf(a, hidden)).toContainText(
        "Nobody else can see it.",
      );
      // The member: partial, always, and the scopes are the server's.
      await leader(b, bId.account_id);
      await reopenBound(b, bId.account_id, "/people");
      await cached(b, bId, shared.person);
      await expect(personRow(b, shared.person)).toContainText(
        "Shared with you by",
        { timeout: 30_000 },
      );
      await expect(personRow(b, shared.person)).toContainText(
        "Visible to: Shared from Home",
      );
      await expect(personRow(b, own.person)).toHaveCount(0);
      await expect(
        b.getByText(/The owner may have shared them more widely/),
      ).toBeVisible();
      for (const name of ["In Home", "Shared with me", "Not linked"]) {
        await view(b, name);
        await expect(personRow(b, shared.person)).toBeVisible({
          timeout: 30_000,
        });
      }
      await go(b, `/people/${shared.person}`);
      const memberRail = b.getByRole("region", { name: "Shared with" });
      await expect(memberRail).toHaveAttribute("data-shared-with", "partial", {
        timeout: 30_000,
      });
      await expect(memberRail).toContainText("may have shared it more widely");
      await expect(memberRail).not.toContainText("can't see it");
      await expect(memberRail).not.toContainText("Excluded");
      await expect(fieldRowOf(b, visible)).toContainText("Shared from Home", {
        timeout: 30_000,
      });
      await expect(fieldRowOf(b, visible)).toContainText(
        "The owner may have shared it more widely.",
      );
      await expect(fieldRowOf(b, hidden)).toHaveCount(0);
      // HARNESS cross-check: the backend's own answers say what the screens said.
      const memberDetail = (
        await raw(b, bId, "GET", `/people/${shared.person}/summary`)
      ).body as {
        summary: { audience: { disclosure: string }; added_by_you: string };
        shared_with: { households: Array<{ members: unknown }> };
      };
      expect(memberDetail.summary.audience.disclosure).toBe("partial");
      expect(memberDetail.summary.added_by_you).toBe("no");
      expect(memberDetail.shared_with.households.map((h) => h.members)).toEqual(
        [null],
      );
      // Revocation: the owner narrows the person to private; the member's scope loses it at the next read after its sync.
      await go(b, "/people");
      await view(b, "Shared with me");
      await expect(personRow(b, shared.person)).toBeVisible({
        timeout: 30_000,
      });
      const pp = await policyOf(a, aId, shared.person);
      expect(
        (
          await management(a, aId, [
            {
              kind: "replace_policy",
              id: shared.person,
              expected_version: pp.body.version,
              policy: PRIVATE,
            },
          ])
        ).status,
      ).toBe(200);
      await cached(b, bId, shared.person, false);
      await expect(personRow(b, shared.person)).toHaveCount(0, {
        timeout: 30_000,
      });
      const after = (
        await raw(b, bId, "GET", "/people/summaries?scope=shared_with_me")
      ).body as { items: Array<{ id: string }> };
      expect(after.items.map((item) => item.id)).not.toContain(shared.person);
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ home, shared, own, visible, hidden }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });

  test("I-PPL16 a person added by A and linked to B: A still sees 'Added by you' and B's control, B sees 'You'; In Home with no primary household is explained", async ({
    browser,
  }, info) => {
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "erin", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "alice");
      const { person } = await seedPerson(a, aId, "I-S Linked");
      await link(a, aId, b, bId, person);
      await reopenBound(a, aId.account_id, "/people");
      await expect(personRow(a, person)).toContainText("Added by you", {
        timeout: 30_000,
      });
      await expect(personRow(a, person)).toContainText(
        "Linked · they control their name",
      );
      // Added by A, so never "Shared with me" for A, whoever owns it now (product decision 1).
      await view(a, "Shared with me");
      await expect(a.locator("[data-people-scope]")).toBeVisible({
        timeout: 30_000,
      });
      await expect(personRow(a, person)).toHaveCount(0);
      await leader(b, bId.account_id);
      await reopenBound(b, bId.account_id, "/people");
      await cached(b, bId, person);
      await expect(personRow(b, person)).toContainText("You", {
        timeout: 30_000,
      });
      await expect(personRow(b, person)).toContainText(
        "Linked to your account",
      );
      // HARNESS: no primary household for B (cleared if one is set), so In Home is the explained empty state.
      const defaults = (await raw(b, bId, "GET", "/defaults")).body as {
        preferences_version: number;
        primary_household_id: string | null;
      };
      if (defaults.primary_household_id !== null)
        expect(
          (
            await management(b, bId, [
              {
                kind: "set_primary_household",
                household_id: null,
                expected_version: defaults.preferences_version,
              },
            ])
          ).status,
        ).toBe(200);
      await view(b, "In Home");
      await expect(
        b.getByText(
          "You haven't chosen a primary household, so nobody is In Home. Everyone you can see is still under All.",
        ),
      ).toBeVisible({ timeout: 30_000 });
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({
          person,
          bPrimary: defaults.primary_household_id,
        }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });
});

// ---- WEB-11b: merges, links and requests (I-PPL17 to I-PPL23) -----------------------------------------------------------------------
// The UI's commands against the released `v0.29.0-rc.1` (Q16's reads included). FOCUSED CONSUMER EVIDENCE for a fixture-stage task, not
// BE-Q16's acceptance and not integration acceptance. Every name is unique per run (the accounts are shared with the earlier cases).
// Not run here: a 7-day expiry (the released backend has no clock control; fixture E-R5/E-R6 and the backend's own tests cover it).
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const HOME_VIEW_OF = (household: string) => ({
  grants: [{ kind: "household", id: household, edit: false }],
  exclude_accounts: [],
});
/** WEB-11b's request rows and lists. */
const incoming = (page: Page, text: string) =>
  page.locator("[data-incoming-request]").filter({ hasText: text });
const sentRow = (page: Page, text: string) =>
  page.locator("[data-sent-request]").filter({ hasText: text });
/** Picks `person` in the open picker: filtered by its name, with "Show more" while it is not among the people read (Q9: 100 a page). */
async function pick(page: Page, person: string, label: string) {
  await page.getByRole("textbox", { name: "Filter by name" }).fill(label);
  const row = page.locator(`[data-pick-person="${person}"]`);
  for (let i = 0; i < 3; i += 1) {
    if (await row.isVisible()) break;
    const more = page.getByRole("button", { name: "Show more" });
    await expect(row.or(more)).toBeVisible({ timeout: 30_000 });
    if (await row.isVisible()) break;
    await more.click();
  }
  await row.click({ timeout: 30_000 });
}
/** Choose a person in the open picker of "New request" (Ask to link). */
async function askToLink(
  page: Page,
  person: string,
  username: string,
  label: string,
) {
  await page.getByRole("button", { name: "Ask to link", exact: true }).click();
  await page.getByRole("button", { name: "Choose", exact: true }).click();
  await pick(page, person, label);
  await page.getByRole("button", { name: "Search the directory" }).click();
  const exact = page.locator('[data-lookup="exact"]');
  await exact.getByRole("textbox", { name: "Exact username" }).fill(username);
  await exact.getByRole("textbox", { name: "Exact username" }).press("Enter");
  await exact
    .getByRole("button", { name: /choose/i })
    .click({ timeout: 30_000 });
  await expect(
    page.locator(`[data-link-recipient="${username}"]`),
  ).toBeVisible();
}
/** The `/people-commands` and `/directory` requests a page makes, in order. */
function requestsOf(
  page: Page,
): Array<{ path: string; key: string | null; body: string }> {
  const seen: Array<{ path: string; key: string | null; body: string }> = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (
      url.pathname.endsWith("/people-commands") ||
      url.pathname.endsWith("/directory")
    )
      seen.push({
        path: `${r.method()} ${url.pathname.replace(API, "")}${url.search}`,
        key: r.headers()["idempotency-key"] ?? null,
        body: r.postData() ?? "",
      });
  });
  return seen;
}
const kindOf = (body: string) =>
  (JSON.parse(body || "{}") as { command?: { kind?: string } }).command?.kind;

test.describe("I-PPL17 to I-PPL23: merges, links and requests (WEB-11b A2-A9, A16)", () => {
  test("I-PPL17 A asks B to link a person in the UI (lookup re-checked first); B, named from their household, confirms; the person is B's; a fresh A context shows Accepted", async ({
    browser,
  }, info) => {
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "pete", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "quinn");
      await household(a, aId, b, bId);
      const name = unique("I-R Link");
      const { person } = await seedPerson(a, aId, name);
      await reopenBound(a, aId.account_id, "/people/requests");
      const seen = requestsOf(a);
      await askToLink(a, person, ACCOUNTS.quinn.username, name);
      const mark = seen.length;
      await a.getByRole("button", { name: "Send request" }).click();
      await expect(sentRow(a, name)).toBeVisible({ timeout: 30_000 });
      const after = seen
        .slice(mark)
        .map((r) =>
          r.path.startsWith("POST") ? `POST ${kindOf(r.body)}` : r.path,
        );
      expect(
        after.indexOf(`GET /directory?username=${ACCOUNTS.quinn.username}`),
      ).toBeGreaterThanOrEqual(0);
      expect(after.indexOf("POST request_link")).toBeGreaterThan(
        after.indexOf(`GET /directory?username=${ACCOUNTS.quinn.username}`),
      );
      await leader(b, bId.account_id);
      await reopenBound(b, bId.account_id, "/people/requests");
      await defaultsLoaded(b, bId);
      const row = incoming(b, name);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.locator('[data-request-sender="known"]')).toHaveText(
        ACCOUNTS.pete.username,
      );
      await row.getByRole("button", { name: "Accept", exact: true }).click();
      await row.getByRole("button", { name: "Confirm accept" }).click();
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(
          async () => (await personOf(b, bId, person)).body.linked_account_id,
          { timeout: 30_000 },
        )
        .toBe(bId.account_id);
      // Q16: the history is the server's, so a fresh browser context of A shows the authoritative state.
      const fresh = await browser.newContext();
      try {
        const { page: again } = await boot(fresh, "pete", "/people/requests");
        await expect(
          sentRow(again, name).locator("[data-sent-label]"),
        ).toHaveText("Accepted", { timeout: 30_000 });
      } finally {
        await fresh.close();
      }
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ person, requests: after }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });

  test("I-PPL18 B declines in the UI and A's Sent says Declined; A cancels another and it says Cancelled; B's answer to it is a 404 with its reference", async ({
    browser,
    provokes,
  }) => {
    provokes(404);
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "olga", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "nora");
      const first = unique("I-R Decline");
      const second = unique("I-R Cancel");
      const ask = async (label: string) => {
        const { person } = await seedPerson(a, aId, label);
        const version = (await personOf(a, aId, person)).body.person.version;
        const asked = await peopleCommand(a, aId, {
          kind: "request_link",
          id: crypto.randomUUID(),
          person_id: person,
          account_id: bId.account_id,
          expected_version: version,
        });
        expect(asked.status).toBe(200);
      };
      await ask(first);
      await ask(second);
      await leader(b, bId.account_id);
      await reopenBound(b, bId.account_id, "/people/requests");
      await expect(incoming(b, second)).toBeVisible({ timeout: 30_000 });
      await incoming(b, first).getByRole("button", { name: "Decline" }).click();
      await expect(incoming(b, first)).toHaveCount(0, { timeout: 30_000 });
      await reopenBound(a, aId.account_id, "/people/requests");
      await expect(sentRow(a, first).locator("[data-sent-label]")).toHaveText(
        "Declined",
        { timeout: 30_000 },
      );
      await sentRow(a, second)
        .getByRole("button", { name: /Cancel request/ })
        .click();
      await expect(sentRow(a, second).locator("[data-sent-label]")).toHaveText(
        "Cancelled",
        { timeout: 30_000 },
      );
      // B's list still shows the cancelled request (nothing has asked again since): answering it is refused 404.
      await incoming(b, second)
        .getByRole("button", { name: "Decline" })
        .click();
      await expect(
        b
          .locator("main")
          .getByText(
            "This request was already answered, cancelled or has expired.",
          ),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(b.locator("main").getByText(/^Reference: /)).toBeVisible();
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });

  test("I-PPL19 and I-PPL20 cross-owner: A asks B in the UI; B's review hides A's person; B's first Accept on a stale token is a 409 and is read again; the second merges", async ({
    browser,
    provokes,
  }, info) => {
    provokes(409);
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "mia", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "liam");
      const home = await household(b, bId, a, aId);
      // B's cache is open before B's person is made (seedPerson waits for it to sync).
      await leader(b, bId.account_id);
      const mine = unique("I-R Mine");
      const theirs = unique("I-R Theirs");
      const { person: x } = await seedPerson(a, aId, mine);
      const {
        person: y,
        fields: [secret],
      } = await seedPerson(b, bId, theirs, [
        { label: "Secret", text: "only B" },
      ]);
      // HARNESS: made private, then shared with B's household (a content create carries no household grant).
      const created = await policyOf(b, bId, y);
      expect(
        (
          await management(b, bId, [
            {
              kind: "replace_policy",
              id: y,
              expected_version: created.body.version,
              policy: HOME_VIEW_OF(home),
            },
          ])
        ).status,
      ).toBe(200);
      await reopenBound(a, aId.account_id, "/people/requests");
      await a.getByRole("button", { name: "Ask to merge" }).click();
      await a
        .getByRole("button", { name: "Choose", exact: true })
        .first()
        .click();
      await pick(a, x, mine);
      await a.getByRole("button", { name: "Choose", exact: true }).click();
      await pick(a, y, theirs);
      await a.getByRole("button", { name: "Compare" }).click();
      const dialog = a.getByRole("dialog");
      const ask = dialog.getByRole("button", {
        name: `Ask ${ACCOUNTS.liam.username} to merge`,
      });
      await expect(ask).toBeEnabled({ timeout: 30_000 });
      await ask.click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await leader(b, bId.account_id);
      await reopenBound(b, bId.account_id, "/people/requests");
      const row = b
        .locator('[data-incoming-request][data-request-kind="merge"]')
        .filter({ hasText: "wants to merge" });
      await expect(row.first()).toBeVisible({ timeout: 30_000 });
      const ids = await b
        .locator('[data-incoming-request][data-request-kind="merge"]')
        .evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-incoming-request")),
        );
      // The request of this run is the one whose recipient preview names Y.
      let request: string | null = null;
      for (const id of ids)
        if (
          id &&
          JSON.stringify(
            (await raw(b, bId, "GET", `/people/requests/${id}/merge-preview`))
              .body,
          ).includes(y)
        )
          request = id;
      expect(request).not.toBeNull();
      await go(b, `/people/requests/${request}`);
      const review = b.getByRole("dialog");
      await expect(review.locator("[data-merge-partial]")).toContainText(
        "Comparison unavailable",
        { timeout: 30_000 },
      );
      await expect(review.locator("[data-merge-comparison]")).toContainText(
        "Not visible to you",
      );
      // I-PPL20: B changes what only B can see (A's view, and so the sender's token, is unchanged).
      const field = (await fieldsOf(b, bId, y)).find(
        (f) => f.id === secret,
      ) as Projection;
      expect(
        (
          await taskCommand(b, bId, {
            kind: "put_field",
            id: secret,
            parent_id: y,
            expected_version: field.version,
            expected_policy_version: field.policy_version,
            label: "Secret",
            value: { kind: "text", text: "only B, changed" },
          })
        ).status,
      ).toBe(200);
      const commands = requestsOf(b);
      await review.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(review).toContainText(
        "This merge changed since you opened it.",
        { timeout: 30_000 },
      );
      await expect(
        review.getByRole("button", { name: "Accept", exact: true }),
      ).toBeEnabled({ timeout: 30_000 });
      await review.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(b).toHaveURL(/\/people\/[0-9a-f-]{36}$/, {
        timeout: 30_000,
      });
      const tokens = commands
        .filter((c) => kindOf(c.body) === "respond_request")
        .map(
          (c) =>
            (
              JSON.parse(c.body) as {
                command: { recipient_preview_token: string };
              }
            ).command.recipient_preview_token,
        );
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).not.toBe(tokens[1]);
      // Y merged into X: Y's field is now under X.
      await expect
        .poll(
          async () =>
            (await fieldsOf(a, aId, x)).some((f) => f.id === secret) ||
            (await fieldsOf(b, bId, x)).some((f) => f.id === secret),
          {
            timeout: 30_000,
          },
        )
        .toBe(true);
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ x, y, request, tokens }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });

  test("I-PPL21 a direct merge in the UI from the duplicates: ONE merge; the source becomes an alias resolving to the target, and its detail says so", async ({
    browser,
  }, info) => {
    const aContext = await browser.newContext();
    try {
      const stem = unique("I-R Dup");
      const { page: a, id: aId } = await boot(aContext, "judy", "/today");
      const { person: target } = await seedPerson(a, aId, stem);
      const { person: source } = await seedPerson(a, aId, stem);
      await reopenBound(a, aId.account_id, `/people/${target}/duplicates`);
      const seen = requestsOf(a);
      const hint = a.locator(`[data-duplicate-hint="${source}"]`);
      // Pages of 50 in the server's order (I-PPL10): each "Check more" only once the previous read answered.
      const checkMore = a.getByRole("button", { name: "Check more" });
      const settled = () =>
        expect
          .poll(
            () =>
              a.evaluate(() => {
                const button = [...document.querySelectorAll("button")].find(
                  (b) => b.textContent?.trim() === "Check more",
                );
                return (
                  document.querySelector("[data-duplicates-state]") !== null ||
                  button === undefined ||
                  !button.disabled
                );
              }),
            { timeout: 30_000 },
          )
          .toBe(true);
      await expect(
        hint.or(checkMore).or(a.locator("[data-duplicates-state]")).first(),
      ).toBeVisible({ timeout: 30_000 });
      for (let i = 0; i < 25 && (await hint.count()) === 0; i += 1) {
        await settled();
        if ((await hint.count()) > 0 || (await checkMore.count()) === 0) break;
        await checkMore.click();
      }
      await hint
        .getByRole("link", { name: "Compare & merge" })
        .click({ timeout: 30_000 });
      const dialog = a.getByRole("dialog");
      await dialog
        .getByRole("button", { name: "Merge them" })
        .click({ timeout: 30_000 });
      await expect(a).toHaveURL(new RegExp(`/people/${target}$`), {
        timeout: 30_000,
      });
      expect(seen.filter((c) => kindOf(c.body) === "merge")).toHaveLength(1);
      await expect
        .poll(async () => (await personOf(a, aId, source)).body.person.id, {
          timeout: 30_000,
        })
        .toBe(target);
      await expect
        .poll(async () => (await cacheRow(a, aId, source))?.archived, {
          timeout: 60_000,
        })
        .toBe(true);
      await go(a, `/people/${source}`);
      await expect(a.locator(`[data-merged-alias="${target}"]`)).toBeVisible({
        timeout: 30_000,
      });
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ source, target }),
      });
    } finally {
      await aContext.close();
    }
  });

  test("I-PPL21 both linked: the UI refuses before any command (the cause, no action); its control, one linked, offers the merge with the linked name fixed; a pair the reader owns neither of is refused 403 and not asked again by itself", async ({
    browser,
    provokes,
  }, info) => {
    // The third pair is refused by the backend itself (an ordinary 403 for a pair the reader owns neither of).
    provokes(403);
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    const cContext = await browser.newContext();
    // Accounts that receive no other link in the People stack; every link is undone at the end, so no later case finds a self-person.
    const undo: Array<() => Promise<void>> = [];
    try {
      const { page: a, id: aId } = await boot(aContext, "pete", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "bob");
      const c = await bootHarness(cContext, "/today");
      const cId = await signedIn(c, "carol");
      // C's cache is open before C's person is made (seedPerson waits for it to sync), as in I-PPL19.
      await leader(c, cId.account_id);
      const unlinkBy = (page: Page, id: Id, person: string) => async () => {
        const now = (await personOf(page, id, person)).body;
        if (now.linked_account_id !== id.account_id) return;
        expect(
          (
            await peopleCommand(page, id, {
              kind: "unlink",
              person_id: person,
              expected_version: now.person.version,
            })
          ).status,
        ).toBe(200);
      };
      /** The person as the reader reads it on the server: itself (not merged into an earlier profile) and linked to `account`. */
      const linkedAs = async (person: string, account: string | null) => {
        const now = (await personOf(a, aId, person)).body;
        expect(now.person.id).toBe(person);
        expect(now.linked_account_id).toBe(account);
      };
      const stem = unique("I-R Both");
      const { person: x } = await seedPerson(a, aId, stem);
      const { person: y } = await seedPerson(a, aId, stem);
      // X: the reader's person, linked to B (B owns it now; the reader still reads it, I-PPL16).
      await link(a, aId, b, bId, x);
      undo.push(unlinkBy(b, bId, x));
      await linkedAs(x, bId.account_id);
      await linkedAs(y, null);
      const seen = requestsOf(a);
      const previews: number[] = [];
      a.on("request", (r) => {
        if (new URL(r.url()).pathname.endsWith("/people/merge-preview"))
          previews.push(Date.now());
      });
      const dialog = a.getByRole("dialog");
      const confirm = dialog.locator('[data-people-action="confirm-merge"]');
      // Commands the UI sent while a dialog was shown (the harness's own link() calls through this page are outside these spans).
      const uiCommands: string[] = [];
      const during = async (phase: () => Promise<void>) => {
        const mark = seen.length;
        await phase();
        for (const r of seen.slice(mark))
          if (r.path.startsWith("POST"))
            uiCommands.push(String(kindOf(r.body)));
      };

      // (1) CONTROL, one linked: the linked person's name is fixed and the action is offered (nothing is pressed).
      await during(async () => {
        await reopenBound(
          a,
          aId.account_id,
          `/people/requests/merge/${y}/${x}`,
        );
        await expect(dialog.locator("[data-merge-name-fixed]")).toBeVisible({
          timeout: 30_000,
        });
        await expect(confirm).toBeEnabled({ timeout: 30_000 });
        await expect(dialog.getByText(BOTH_LINKED)).toHaveCount(0);
      });

      // (2) BOTH LINKED, and the reader may compare them: the reader's OWN profile (C's person, linked to the reader, so the reader owns
      // it) and X. The cause is shown, there is no action, and nothing is sent.
      const self = await seedPerson(c, cId, unique("I-R Self"));
      await link(c, cId, a, aId, self.person);
      undo.push(unlinkBy(a, aId, self.person));
      await linkedAs(self.person, aId.account_id);
      await during(async () => {
        await reopenBound(
          a,
          aId.account_id,
          `/people/requests/merge/${x}/${self.person}`,
        );
        await expect(dialog.getByText(BOTH_LINKED).first()).toBeVisible({
          timeout: 30_000,
        });
        await expect(confirm).toHaveCount(0);
        const disabled = dialog.locator("button[disabled]").last();
        await expect(disabled).toBeDisabled();
        await disabled.click({ force: true });
        await a.waitForTimeout(1_000);
      });

      // (3) A pair the reader owns NEITHER of (X linked to B, Y linked to C): the backend refuses the comparison 403 and the dialog says
      // so; once shown, the refusal is not asked again by itself through the session's re-evaluation and remount (N1 of revision 1),
      // and nothing is sent.
      await link(a, aId, c, cId, y);
      undo.push(unlinkBy(c, cId, y));
      await linkedAs(y, cId.account_id);
      const before = previews.length;
      let settled = 0;
      await during(async () => {
        // HARNESS ORDERING (revision 4): the leader starts once the refusal is shown and its remount has settled. The revision-4 pool runs
        // (Chromium, twice) had the 403 answered before the harness's outbox open, which the remount's registry close refused (`closed`);
        // the trace records the order. The assertions and the observation window below are unchanged, and run with the leader syncing.
        await reopenBound(
          a,
          aId.account_id,
          `/people/requests/merge/${y}/${x}`,
          () =>
            expect(dialog.getByText(PREVIEW_FORBIDDEN)).toBeVisible({
              timeout: 30_000,
            }),
        );
        await expect(dialog.getByText(PREVIEW_FORBIDDEN)).toBeVisible({
          timeout: 30_000,
        });
        // A fresh page load reads every summary again on each freshness signal while its first read is in flight (a cold-start burst, as
        // for any summary). Once the refusal is shown and those reads have settled, it is NOT asked again by itself (N1: before the fix, the
        // session's re-evaluation and remount asked about 150 times a second). The observation window is the requirement; nothing is shortened.
        await expect
          .poll(
            async () => {
              const at = previews.length;
              await a.waitForTimeout(1_000);
              return previews.length - at;
            },
            { timeout: 30_000, message: "the reads in flight settle" },
          )
          .toBe(0);
        settled = previews.length;
        await a.waitForTimeout(3_000);
        expect(previews.length, "comparisons asked after the refusal").toBe(
          settled,
        );
        expect(settled - before, "comparisons asked in all").toBeGreaterThan(0);
      });

      expect(uiCommands, "commands the dialogs sent").toEqual([]);
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({
          x,
          y,
          self: self.person,
          previews: previews.length,
          phase3: previews.length - before,
          commands: uiCommands.length,
        }),
      });
    } finally {
      for (const step of undo.reverse()) await step();
      await aContext.close();
      await bContext.close();
      await cContext.close();
    }
  });

  test("I-PPL22 request_link refusals from the UI: a person changed since it was read is a 409; a recipient with 100 waiting is a 503 and nothing is made", async ({
    browser,
    provokes,
  }) => {
    provokes(409, 503);
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "grace", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "frank");
      const name = unique("I-R Stale");
      const { person } = await seedPerson(a, aId, name);
      await reopenBound(a, aId.account_id, "/people/requests");
      await askToLink(a, person, ACCOUNTS.frank.username, name);
      // HARNESS: renamed on the server after the page read it (not synced yet): the UI's request carries the old version.
      const now = (await personOf(a, aId, person)).body.person;
      expect(
        (
          await content(a, aId, [
            {
              kind: "edit",
              id: person,
              expected_version: now.version,
              expected_policy_version: now.policy_version,
              label: `${name} 2`,
              value: "",
            },
          ])
        ).status,
      ).toBe(200);
      await a.getByRole("button", { name: "Send request" }).click();
      await expect(
        a
          .locator("main")
          .getByText(
            "This person changed since you chose them. Check and send again.",
          ),
      ).toBeVisible({
        timeout: 30_000,
      });
      // HARNESS: 100 pending requests for B (duplicates of one pair are accepted).
      const { person: filler } = await seedPerson(a, aId, unique("I-R Filler"));
      const version = (await personOf(a, aId, filler)).body.person.version;
      for (let i = 0; i < 100; i += 1) {
        const asked = await peopleCommand(a, aId, {
          kind: "request_link",
          id: crypto.randomUUID(),
          person_id: filler,
          account_id: bId.account_id,
          expected_version: version,
        });
        if (asked.status === 503) break;
        expect(asked.status).toBe(200);
      }
      const full = unique("I-R Full");
      const { person: refused } = await seedPerson(a, aId, full);
      await reopenBound(a, aId.account_id, "/people/requests");
      await askToLink(a, refused, ACCOUNTS.frank.username, full);
      await a.getByRole("button", { name: "Send request" }).click();
      await expect(
        a
          .locator("main")
          .getByText(
            `${ACCOUNTS.frank.username} has too many requests waiting. Try again later.`,
          ),
      ).toBeVisible({
        timeout: 30_000,
      });
      const sent = (await raw(a, aId, "GET", "/people/requests/sent?limit=200"))
        .body as {
        items: Array<{ proposal: { person_id?: string } }>;
      };
      expect(
        sent.items.filter((item) => item.proposal.person_id === refused),
      ).toHaveLength(0);
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });

  test("I-PPL23 lost responses: request_link, merge and respond_request dropped after commit; Try again resends the same key and body; each happened once", async ({
    browser,
  }, info) => {
    const aContext = await browser.newContext();
    const bContext = await browser.newContext();
    try {
      const { page: a, id: aId } = await boot(aContext, "erin", "/today");
      const b = await bootHarness(bContext, "/today");
      const bId = await signedIn(b, "dave");
      const seenA = requestsOf(a);
      const drop = (id: string) =>
        proxy.addRule({
          id,
          method: "POST",
          path: `${API}/people-commands`,
          ordinal: 1,
          action: "drop_after_forward",
        });
      const same = async (list: typeof seenA, kind: string) => {
        // The resend is asynchronous to the press: wait for it before comparing.
        await expect
          .poll(() => list.filter((c) => kindOf(c.body) === kind).length, {
            timeout: 30_000,
          })
          .toBe(2);
        const sent = list.filter((c) => kindOf(c.body) === kind);
        expect(sent).toHaveLength(2);
        expect(sent[1]?.key).toBe(sent[0]?.key);
        expect(sent[1]?.body).toBe(sent[0]?.body);
      };
      // request_link
      const name = unique("I-R Lost link");
      const { person } = await seedPerson(a, aId, name);
      await reopenBound(a, aId.account_id, "/people/requests");
      await askToLink(a, person, ACCOUNTS.dave.username, name);
      await drop("drop-request-link");
      await a.getByRole("button", { name: "Send request" }).click();
      await expect(
        a
          .locator("main")
          .getByText(
            "Atlas couldn't confirm this. It may already have happened.",
          ),
      ).toBeVisible({ timeout: 30_000 });
      await a.getByRole("button", { name: "Try again" }).click();
      await expect(sentRow(a, name)).toHaveCount(1, { timeout: 30_000 });
      await same(seenA, "request_link");
      // respond_request
      await leader(b, bId.account_id);
      await reopenBound(b, bId.account_id, "/people/requests");
      const seenB = requestsOf(b);
      const row = incoming(b, name);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await drop("drop-respond");
      await row.getByRole("button", { name: "Accept", exact: true }).click();
      await row.getByRole("button", { name: "Confirm accept" }).click();
      // It committed: the list read again no longer holds it, and its uncertain answer is kept above the list with Try again.
      await expect(
        b
          .locator("main")
          .getByText(
            "Atlas couldn't confirm this. It may already have happened.",
          )
          .first(),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        b.locator('[data-people-action="retry-answer"]'),
      ).toBeVisible({ timeout: 30_000 });
      await b.locator('[data-people-action="retry-answer"]').click();
      await expect
        .poll(
          async () => (await personOf(b, bId, person)).body.linked_account_id,
          { timeout: 30_000 },
        )
        .toBe(bId.account_id);
      await same(seenB, "respond_request");
      // merge
      const stem = unique("I-R Lost merge");
      const { person: target } = await seedPerson(a, aId, stem);
      const { person: source } = await seedPerson(a, aId, `${stem}a`);
      await reopenBound(
        a,
        aId.account_id,
        `/people/${target}/duplicates/${source}`,
      );
      const merge = a
        .getByRole("dialog")
        .getByRole("button", { name: "Merge them" });
      await expect(merge).toBeEnabled({ timeout: 30_000 });
      await drop("drop-merge");
      await merge.click();
      await expect(a.getByRole("dialog")).toContainText(
        "Atlas couldn't confirm this. It may already have happened.",
        {
          timeout: 30_000,
        },
      );
      await a
        .getByRole("dialog")
        .getByRole("button", { name: "Try again" })
        .click();
      await expect(a).toHaveURL(new RegExp(`/people/${target}$`), {
        timeout: 30_000,
      });
      await same(seenA, "merge");
      expect((await personOf(a, aId, source)).body.person.id).toBe(target);
      info.annotations.push({
        type: "evidence",
        description: JSON.stringify({ person, source, target }),
      });
    } finally {
      await aContext.close();
      await bContext.close();
    }
  });
});
