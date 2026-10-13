import { expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  deltaPage,
  fresh,
  leaderPage,
  snapshotPage,
} from "./data-leader-helpers";
import { atlasError, startOutbox } from "./data-sync-helpers";
import { pressTab } from "./helpers";
import {
  atlas,
  bootAt,
  connectivity,
  draftsOf,
  fieldP,
  HOME,
  ME,
  MO,
  navigateInApp,
  personP,
  publish,
  servePeople,
  setup,
} from "./people-helpers";

/**
 * WEB-11a in Chromium, Firefox and WebKit: the PRODUCTION session and protected tree (`/__session`), the production data controller and
 * REAL IndexedDB, with the people and sharing endpoints stubbed by `page.route` and the cache seeded through the fixture leader's `/sync`.
 * FIXTURE evidence: an answer the stub gives is the stub's (the I-P integration cases run against the released backend). The fixture
 * leader (`startOutbox`) sends what the tree saved; it is woken by `retryOutbox()` (the fixture leader is not woken by the tree's facade).
 *
 * E-P1 the list; E-P2 a field saved offline, sent with its own key; E-P3 every value kind through the editor; E-P4 conditional values;
 * E-P5 Q1's policy version and a version conflict; E-P6 a held audience change, policy before content; E-P7 linkage, rename and unlink;
 * E-P8 archive and restore; E-P9 duplicates (PPL-3); E-P10 a new person with a note, held for the defaults review; E-P11 a 403 on the
 * field's policy across the remount; E-P12 viewports and themes; E-P13 keyboard only. Revision 1 (the review of 13 October 2026):
 * E-P14 an edit bound to what it began on; E-P15 a held change durable across a reload; E-P16 Discard stops a running held change;
 * E-P17 state stays with its person; E-P18 every person reachable in bounded steps. E-P5 also asserts the conflicted save's content.
 */
const P = "55555555-5555-4555-8555-555555555555";
const Q = "77777777-7777-4777-8777-777777777777";
const F = "66666666-6666-4666-8666-666666666666";
const PRIVATE = { grants: [], exclude_accounts: [] };
const HOME_VIEW = {
  grants: [{ kind: "household", id: HOME, edit: false }],
  exclude_accounts: [],
};

const send = (page: Page) =>
  page.evaluate(() => window.__atlasData?.retryOutbox());
const detail = (page: Page) => page.locator(`[data-person-detail="${P}"]`);

test.describe("E-P1: the people list (A1)", () => {
  test("sorted by name, searchable, archived people only under Archived; the linkage of at most 25 people is read, once", async ({
    context,
  }, info) => {
    const people = Array.from({ length: 30 }, (_, i) =>
      personP(
        `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        `Person ${String(i).padStart(2, "0")}`,
      ),
    );
    const { served, page } = await setup(
      context,
      "/people",
      [...people, personP(P, "Ada", { archived: true })],
      { linked: { [people[0]?.id as string]: ME } },
    );
    const rows = page.locator("[data-person-row]");
    await expect(rows).toHaveCount(30);
    await expect(rows.first()).toContainText("Person 00");
    await expect(rows.first()).toContainText("Linked to your account");
    const personReads = () =>
      served.log.filter((l) => /^GET \/people\/[0-9a-f-]{36}$/.test(l));
    await expect.poll(() => personReads().length).toBe(25);
    await page
      .getByRole("searchbox", { name: "Search people" })
      .fill("person 07");
    await expect(rows).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Search people" }).fill("");
    await page.getByRole("button", { name: "Archived" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Ada");
    // The Archived filter shows one person nobody has asked about: that one is read; nobody is ever read twice.
    await expect.poll(() => personReads().length).toBe(26);
    await page.getByRole("button", { name: "All" }).click();
    await expect(rows).toHaveCount(30);
    await page.waitForTimeout(500);
    recordEvidence(info, "e-p1", { personReads: personReads() });
    expect(personReads()).toHaveLength(26);
    expect(new Set(personReads()).size).toBe(26);
  });
});

test.describe("E-P2: a field saved offline (A3, A6, A19)", () => {
  test("queued in real IndexedDB with the header kind put_field, shown 'Not sent yet', then sent with its local id as the key and no expected_version", async ({
    context,
  }, info) => {
    const { net, page } = await setup(context, `/people/${P}`, [
      personP(P, "Ada"),
    ]);
    await startOutbox(page);
    await expect(detail(page)).toBeVisible();
    await connectivity(context, page, false);
    await detail(page).getByRole("link", { name: "Add a field" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a field" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Medical note");
    await dialog
      .getByRole("textbox", { name: "Value" })
      .fill("Penicillin allergy");
    await dialog.getByRole("radio", { name: "Only you", exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    const row = detail(page)
      .locator("[data-field-row]")
      .filter({ hasText: "Medical note" });
    await expect(row).toContainText("Not sent yet");
    const [draft] = await draftsOf(page);
    expect(draft?.kind).toBe("put_field");
    expect(net.commands).toEqual([]);
    await connectivity(context, page, true);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(1);
    const sent = net.commands[0];
    expect(sent?.path).toBe("/task-commands");
    expect(sent?.key).toBe(draft?.local_id);
    const body = JSON.parse(sent?.body ?? "{}");
    expect(body.command).toMatchObject({
      kind: "put_field",
      parent_id: P,
      label: "Medical note",
      value: { kind: "text", text: "Penicillin allergy" },
      initial_policy: PRIVATE,
    });
    expect(body.command).not.toHaveProperty("expected_version");
    expect(body.command).not.toHaveProperty("expected_policy_version");
    await publish(
      page,
      net,
      [
        fieldP(body.command.id, P, "Medical note", {
          kind: "text",
          text: "Penicillin allergy",
        }),
      ],
      { start: false },
    );
    await expect(row).not.toContainText("Not sent yet");
    recordEvidence(info, "e-p2", { commands: net.commands });
  });
});

test.describe("E-P2b: the PRODUCTION leader sends what the tree saved (A19)", () => {
  test("?leader=production: a field saved from the editor reaches /task-commands with its local id as the key, with no harness call", async ({
    context,
  }, info) => {
    const net = await fresh(context);
    const served = await servePeople(context);
    served.people.set(P, { person: personP(P, "Ada"), linked: null });
    net.answer = (call) =>
      call.cursor === null
        ? snapshotPage(
            [{ kind: "upsert", resource: personP(P, "Ada") }],
            "delta-1",
            false,
          )
        : deltaPage([], call.cursor ?? "delta-1");
    const page = await leaderPage(context, net, "one", undefined, {
      route: `/people/${P}`,
    });
    await expect(detail(page)).toBeVisible({ timeout: 20_000 });
    await detail(page).getByRole("link", { name: "Add a field" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a field" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Phone");
    await dialog.getByRole("textbox", { name: "Value" }).fill("0770");
    await dialog.getByRole("radio", { name: "Only you", exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => net.commands.length, { timeout: 15_000 }).toBe(1);
    const [draft] = (await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) return [];
      if (!data.stores.has(a)) {
        data.setIdentity(a);
        await data.open(a);
      }
      return data.rows(a, "drafts");
    }, ME)) as Array<{ local_id: string; kind: string }>;
    expect(net.commands[0]?.path).toBe("/task-commands");
    expect(net.commands[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    // Once receipted the draft may already have been released; while it stands, it is the draft that was sent.
    if (draft) expect(net.commands[0]?.key).toBe(draft.local_id);
    recordEvidence(info, "e-p2b", { commands: net.commands });
  });
});

test.describe("E-P3: every value kind through the editor (A3)", () => {
  test("each of the seven kinds is saved with exactly the contract's FieldValue and shown as drawn", async ({
    context,
  }, info) => {
    const { page } = await setup(context, `/people/${P}`, [personP(P, "Ada")]);
    const add = async (
      name: string,
      kind: string,
      fill: (d: ReturnType<Page["getByRole"]>) => Promise<void>,
    ) => {
      await detail(page).getByRole("link", { name: "Add a field" }).click();
      const dialog = page.getByRole("dialog", { name: "Add a field" });
      await dialog.getByRole("textbox", { name: "Name" }).fill(name);
      await dialog.getByRole("combobox", { name: "Type" }).selectOption(kind);
      await fill(dialog);
      await dialog
        .getByRole("radio", { name: "Only you", exact: true })
        .click();
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toBeHidden();
    };
    await add("Note", "text", (d) =>
      d.getByRole("textbox", { name: "Value" }).fill("Nuts"),
    );
    await add("Weight", "quantity", async (d) => {
      await d.getByRole("textbox", { name: "Amount" }).fill("21.5");
      await d.getByRole("textbox", { name: "Unit" }).fill("kg");
    });
    await add("Birthday", "date", async (d) => {
      await d.getByRole("textbox", { name: "Day" }).fill("29");
      await d.getByRole("textbox", { name: "Month" }).fill("2");
    });
    await add("School", "url", (d) =>
      d.getByRole("textbox", { name: "Link" }).fill("https://school.example"),
    );
    await add("Swims", "boolean", (d) =>
      d.getByRole("radio", { name: "Yes" }).click(),
    );
    await add("Size", "choices", async (d) => {
      await d.getByRole("button", { name: "Add an option" }).click();
      await d.getByRole("textbox", { name: "Option 1" }).fill("S");
      await d.getByRole("button", { name: "Add an option" }).click();
      await d.getByRole("textbox", { name: "Option 2" }).fill("M");
      await d.getByRole("checkbox", { name: "Selected" }).nth(1).check();
    });
    await add("Kit", "checklist", async (d) => {
      await d.getByRole("button", { name: "Add an item" }).click();
      await d.getByRole("textbox", { name: "Item 1" }).fill("Boots");
      await d.getByRole("checkbox", { name: "Done" }).check();
    });
    const drafts = await draftsOf(page);
    expect(drafts.map((d) => d.kind)).toEqual(Array(7).fill("put_field"));
    const rows = detail(page).locator("[data-field-row]");
    await expect(rows).toHaveCount(7);
    for (const text of [
      "Nuts",
      "21.5 kg",
      "29 February",
      "https://school.example",
      "Yes",
      "M of 2",
      "1 of 1 done",
    ])
      await expect(detail(page)).toContainText(text);
    const bodies = await page.evaluate(
      async (a) =>
        (await window.__atlasData?.rows(a, "draft_commands")) as Array<{
          command: { command: { value: unknown } };
        }>,
      ME,
    );
    const values = bodies.map((b) => b.command.command.value);
    expect(values).toEqual(
      expect.arrayContaining([
        { kind: "text", text: "Nuts" },
        { kind: "quantity", amount: "21.5", unit: "kg" },
        { kind: "date", month: 2, day: 29 },
        { kind: "url", url: "https://school.example" },
        { kind: "boolean", value: true },
        { kind: "choices", options: ["S", "M"], selected: ["M"] },
        {
          kind: "checklist",
          items: [
            { id: expect.stringMatching(/^[0-9a-f-]{36}$/), label: "Boots" },
          ],
          checked: [expect.any(String)],
        },
      ]),
    );
    recordEvidence(info, "e-p3", { values });
  });
});

test.describe("E-P4: conditional values (A7)", () => {
  test("a type switch keeps each slot; only the active one is saved; a refused save (quota) keeps everything", async ({
    context,
  }) => {
    const { page } = await setup(context, `/people/${P}/fields/new`, [
      personP(P, "Ada"),
    ]);
    const dialog = page.getByRole("dialog", { name: "Add a field" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Weight");
    await dialog.getByRole("textbox", { name: "Value" }).fill("about 70");
    await dialog
      .getByRole("combobox", { name: "Type" })
      .selectOption("quantity");
    await dialog.getByRole("textbox", { name: "Amount" }).fill("70");
    await dialog.getByRole("textbox", { name: "Unit" }).fill("kg");
    await dialog.getByRole("combobox", { name: "Type" }).selectOption("text");
    await expect(dialog.getByRole("textbox", { name: "Value" })).toHaveValue(
      "about 70",
    );
    await dialog
      .getByRole("combobox", { name: "Type" })
      .selectOption("quantity");
    await dialog.getByRole("radio", { name: "Only you", exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    const bodies = (await page.evaluate(
      (a) => window.__atlasData?.rows(a, "draft_commands"),
      ME,
    )) as Array<{
      command: { command: { value: unknown } };
    }>;
    expect(bodies.map((b) => b.command.command.value)).toEqual([
      { kind: "quantity", amount: "70", unit: "kg" },
    ]);
  });
});

test.describe("E-P5: Q1's policy version and a conflict (A5)", () => {
  test("an update carries expected_policy_version; a 409 becomes a version conflict; 'Save mine' supersedes THAT save's content on the current bases, after the audience now is shown", async ({
    context,
  }, info) => {
    const { net, page, served } = await setup(
      context,
      `/people/${P}/fields/${F}`,
      [
        personP(P, "Ada"),
        fieldP(
          F,
          P,
          "Phone",
          { kind: "text", text: "0770" },
          { version: 4, policy_version: 6 },
        ),
      ],
    );
    served.policies.set(F, { version: 6, policy: HOME_VIEW });
    await startOutbox(page);
    net.commandScript.push(() => ({
      status: 409,
      body: atlasError("conflict"),
    }));
    const dialog = page.getByRole("dialog", { name: "Edit Phone" });
    await expect(
      dialog.getByRole("radio", { name: "Home · can view" }),
    ).toBeChecked();
    await dialog.getByRole("textbox", { name: "Value" }).fill("0771");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await send(page);
    await expect.poll(() => net.commands.length).toBe(1);
    expect(JSON.parse(net.commands[0]?.body ?? "{}").command).toMatchObject({
      expected_version: 4,
      expected_policy_version: 6,
    });
    await expect
      .poll(async () => (await draftsOf(page)).map((d) => d.status))
      .toEqual(["version_conflict"]);
    await publish(
      page,
      net,
      [
        fieldP(
          F,
          P,
          "Phone",
          { kind: "text", text: "0779" },
          { version: 5, policy_version: 7 },
        ),
      ],
      { start: false },
    );
    // The policy moved to 7 on the server too: the conflicted save was made under 6, so the audience NOW is read and shown first.
    served.policies.set(F, { version: 7, policy: PRIVATE });
    await navigateInApp(page, `/people/${P}/fields/${F}`);
    const again = page.getByRole("dialog", { name: "Edit Phone" });
    const panel = again.locator("[data-field-conflict]");
    await expect(panel).toContainText("Current: Phone — 0779");
    await expect(panel).toContainText("Yours: Phone — 0771");
    await expect(panel).toContainText("Who can see it now: Only you");
    await panel
      .getByRole("button", { name: "Save mine on the current version" })
      .click();
    await send(page);
    await expect.poll(() => net.commands.length).toBe(2);
    expect(JSON.parse(net.commands[1]?.body ?? "{}").command).toMatchObject({
      expected_version: 5,
      expected_policy_version: 7,
      value: { kind: "text", text: "0771" },
    });
    recordEvidence(info, "e-p5", { commands: net.commands });
  });
});

test.describe("E-P6: a held audience change (A6)", () => {
  test("offline 'Hold as draft'; on reconnect: policy read, replace_policy, confirming read, THEN the content with the confirmed version", async ({
    context,
  }, info) => {
    const { net, page, served } = await setup(
      context,
      `/people/${P}/fields/${F}`,
      [
        personP(P, "Ada"),
        fieldP(
          F,
          P,
          "Note",
          { kind: "text", text: "Inhaler" },
          { version: 4, policy_version: 6 },
        ),
      ],
    );
    served.policies.set(F, { version: 6, policy: HOME_VIEW });
    await startOutbox(page);
    const dialog = page.getByRole("dialog", { name: "Edit Note" });
    await expect(
      dialog.getByRole("radio", { name: "Home · can view" }),
    ).toBeChecked();
    await connectivity(context, page, false);
    await dialog
      .getByRole("textbox", { name: "Value" })
      .fill("Inhaler in the blue bag");
    await dialog.getByRole("radio", { name: "Only you", exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toContainText(
      "You're offline, so the audience can't change yet",
    );
    await dialog.getByRole("button", { name: "Hold as draft" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`[data-held-field="${F}"]`)).toBeVisible();
    served.policyScript.push(
      () => ({ status: 200, body: { version: 6, policy: HOME_VIEW } }),
      () => ({ status: 200, body: { version: 7, policy: PRIVATE } }),
    );
    const before = served.log.length;
    await connectivity(context, page, true);
    await expect.poll(async () => (await draftsOf(page)).length).toBe(1);
    expect(served.log.slice(before)).toEqual([
      `GET /policies/${F}`,
      "POST /management-commands",
      `GET /policies/${F}`,
    ]);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(1);
    expect(JSON.parse(net.commands[0]?.body ?? "{}").command).toMatchObject({
      expected_version: 4,
      expected_policy_version: 7,
      value: { kind: "text", text: "Inhaler in the blue bag" },
    });
    recordEvidence(info, "e-p6", { log: served.log, commands: net.commands });
  });

  test("variant: the confirming read shows another policy, so no content is queued and the held draft stays with the review copy", async ({
    context,
  }) => {
    const { page, served } = await setup(context, `/people/${P}/fields/${F}`, [
      personP(P, "Ada"),
      fieldP(
        F,
        P,
        "Note",
        { kind: "text", text: "Inhaler" },
        { version: 4, policy_version: 6 },
      ),
    ]);
    served.policies.set(F, { version: 6, policy: HOME_VIEW });
    const dialog = page.getByRole("dialog", { name: "Edit Note" });
    await expect(
      dialog.getByRole("radio", { name: "Home · can view" }),
    ).toBeChecked();
    await connectivity(context, page, false);
    await dialog.getByRole("radio", { name: "Only you", exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.getByRole("button", { name: "Hold as draft" }).click();
    served.policyScript.push(
      () => ({ status: 200, body: { version: 6, policy: HOME_VIEW } }),
      () => ({ status: 200, body: { version: 8, policy: HOME_VIEW } }),
    );
    await connectivity(context, page, true);
    await expect(
      page.getByText(/The sharing changed since you opened this/),
    ).toBeVisible();
    expect(await draftsOf(page)).toEqual([]);
  });
});

test.describe("E-P7: linkage, rename and unlink (A9, A10, A17)", () => {
  test("self: rename_profile online; another account: disabled with the drawn reasons; an uncertain unlink is retried with the SAME key and body", async ({
    context,
  }, info) => {
    const { page, served } = await setup(
      context,
      `/people/${P}`,
      [personP(P, "Kieran", { version: 3 }), personP(Q, "Mo")],
      {
        linked: { [P]: ME, [Q]: MO },
      },
    );
    const header = page.locator("[data-identity-header]");
    await expect(header).toContainText(
      "This is you — you control this profile",
    );
    await header.getByRole("button", { name: "Rename" }).click();
    await header.getByRole("textbox", { name: "Name" }).fill("Kieran L.");
    await header.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => served.peopleCommands.length).toBe(1);
    expect(served.peopleCommands[0]?.body).toEqual({
      command: {
        kind: "rename_profile",
        person_id: P,
        expected_version: 3,
        name: "Kieran L.",
      },
    });
    served.peopleScript.push("abort");
    await header.getByRole("button", { name: "Unlink account" }).click();
    const confirm = page.getByRole("dialog", {
      name: "Unlink your account from this profile?",
    });
    await confirm.getByRole("button", { name: "Unlink account" }).click();
    await expect(confirm).toContainText("We couldn't confirm this was saved");
    await confirm.getByRole("button", { name: "Unlink account" }).click();
    await expect(confirm).toBeHidden();
    const unlinks = served.peopleCommands.filter(
      (c) =>
        (c.body as { command: { kind: string } }).command.kind === "unlink",
    );
    expect(unlinks).toHaveLength(2);
    expect(unlinks[0]?.key).toBe(unlinks[1]?.key);
    expect(unlinks[0]?.body).toEqual(unlinks[1]?.body);
    await navigateInApp(page, `/people/${Q}`);
    const other = page.locator("[data-identity-header]");
    await expect(other).toContainText(
      "Linked to their own account — Mo controls this name, not you",
    );
    await expect(other.getByRole("button", { name: "Rename" })).toBeDisabled();
    await expect(other).toContainText(
      "Only Mo (the linked account) can unlink this profile",
    );
    recordEvidence(info, "e-p7", { peopleCommands: served.peopleCommands });
  });
});

test.describe("E-P7: one column (tablet), where no list beside the detail reads anyone else's linkage", () => {
  test.use({ viewport: { width: 834, height: 1112 } });
  test("an unlinked person renamed offline through the queued content edit; unknown linkage offline disables Rename", async ({
    context,
  }) => {
    const { net, page } = await setup(context, `/people/${P}`, [
      personP(P, "Ada", { version: 5, policy_version: 2 }),
      personP(Q, "Bo"),
    ]);
    await startOutbox(page);
    const header = page.locator("[data-identity-header]");
    await expect(header).toContainText("Not linked to an account");
    await connectivity(context, page, false);
    await header.getByRole("button", { name: "Rename" }).click();
    await header.getByRole("textbox", { name: "Name" }).fill("Ada L.");
    await header.getByRole("button", { name: "Save" }).click();
    await expect(header).toContainText("Ada L.");
    await expect(header).toContainText("Not sent yet");
    await navigateInApp(page, `/people/${Q}`);
    await expect(page.locator("[data-identity-header]")).toContainText(
      "isn't known on this device",
    );
    await expect(
      page
        .locator("[data-identity-header]")
        .getByRole("button", { name: "Rename" }),
    ).toBeDisabled();
    await connectivity(context, page, true);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(1);
    expect(JSON.parse(net.commands[0]?.body ?? "{}")).toEqual({
      commands: [
        {
          kind: "edit",
          id: P,
          expected_version: 5,
          expected_policy_version: 2,
          label: "Ada L.",
          value: "",
        },
      ],
    });
  });
});

test.describe("E-P8: archive and restore (A12)", () => {
  test("a field and a person archived offline; the disclosure and the Settings ledger list them; restore queues the reverse", async ({
    context,
  }, info) => {
    const { net, page } = await setup(context, `/people/${P}`, [
      personP(P, "Mo", { version: 2 }),
      fieldP(
        F,
        P,
        "Old emergency contact",
        { kind: "text", text: "x" },
        { version: 3 },
      ),
    ]);
    await startOutbox(page);
    await connectivity(context, page, false);
    const row = detail(page).locator(`[data-field-row="${F}"]`);
    await row.getByRole("button", { name: "Archive" }).click();
    await expect(row).toBeHidden();
    await expect(
      detail(page).getByRole("button", { name: "Archived fields (1)" }),
    ).toBeVisible();
    await page
      .locator("[data-identity-header]")
      .getByRole("button", { name: "Archive" })
      .click();
    await expect(
      page.getByText(/Archived. Its history and fields stay./),
    ).toBeVisible();
    await connectivity(context, page, true);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(2);
    expect(net.commands.map((c) => JSON.parse(c.body).command)).toEqual([
      { kind: "archive", id: F, expected_version: 3, archived: true },
      { kind: "archive", id: P, expected_version: 2, archived: true },
    ]);
    await publish(
      page,
      net,
      [
        personP(P, "Mo", { version: 3, archived: true }),
        fieldP(
          F,
          P,
          "Old emergency contact",
          { kind: "text", text: "x" },
          { version: 4, archived: true },
        ),
      ],
      { start: false },
    );
    await navigateInApp(page, "/settings/archived");
    await expect(page.locator(`[data-archived-row="${P}"]`)).toContainText(
      "Mo",
    );
    await expect(page.getByText("Old emergency contact · Mo")).toBeVisible();
    await page
      .locator(`[data-archived-row="${P}"]`)
      .getByRole("button", { name: "Restore" })
      .click();
    await send(page);
    await expect.poll(() => net.commands.length).toBe(3);
    expect(JSON.parse(net.commands[2]?.body ?? "{}").command).toEqual({
      kind: "archive",
      id: P,
      expected_version: 3,
      archived: false,
    });
    recordEvidence(info, "e-p8", { commands: net.commands });
  });
});

test.describe("E-P9: duplicates (A13, PPL-3)", () => {
  test("an empty page with next_after is never 'none'; Check more; Not the same hides the pair; next_after null says there are none", async ({
    context,
  }, info) => {
    const { page, served } = await setup(
      context,
      `/people/${P}/duplicates`,
      [personP(P, "Mo")],
      {
        arrange: (s) => {
          s.duplicates.push(
            { items: [], next_after: Q },
            { items: [personP(Q, "Mohammed A.")], next_after: Q },
            { items: [], next_after: null },
          );
        },
      },
    );
    await expect(
      page.getByText(
        "No similar names found so far. There are more people to check.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Nothing looks like a duplicate right now."),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Check more" }).click();
    await expect(page.locator(`[data-duplicate-hint="${Q}"]`)).toContainText(
      "Mohammed A.",
    );
    await page.getByRole("button", { name: "Not the same" }).click();
    await expect(page.locator(`[data-duplicate-hint="${Q}"]`)).toHaveCount(0);
    await page.getByRole("button", { name: "Check more" }).click();
    await expect(
      page.getByText("Nothing looks like a duplicate right now."),
    ).toBeVisible();
    recordEvidence(info, "e-p9", { log: served.log });
    expect(served.log.filter((l) => l.includes("/duplicates"))).toHaveLength(3);
  });
});

test.describe("E-P10: a new person with a note, never-fetched defaults (A8 at the client, A16)", () => {
  test("one /commands batch [create_person, create_field], held for the defaults review: nothing is sent", async ({
    context,
  }, info) => {
    const { net, page } = await setup(context, "/people", [personP(Q, "Bo")]);
    // The defaults cannot be read (registered after the stubs, so it wins): the save captures 'never fetched' and is held for review.
    await context.route("**/api/experimental/v1/defaults/snapshot", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify(atlas("unavailable")),
      }),
    );
    await startOutbox(page);
    await page.locator('[data-people-action="new-person"]').click();
    const dialog = page.getByRole("dialog", { name: "New person" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Ada");
    await dialog.getByRole("button", { name: "Add a first note" }).click();
    await dialog
      .getByRole("textbox", { name: "First note" })
      .fill("Allergic to nuts");
    await expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    const [draft] = await draftsOf(page);
    expect(draft?.kind).toBe("create_person");
    expect(draft?.review_block).toEqual({
      kind: "defaults",
      kinds: ["person", "field"],
    });
    const [body] = (await page.evaluate(
      (a) => window.__atlasData?.rows(a, "draft_commands"),
      ME,
    )) as Array<{
      command: { commands: Array<{ kind: string }> };
    }>;
    expect(body?.command.commands.map((c) => c.kind)).toEqual([
      "create_person",
      "create_field",
    ]);
    await send(page);
    await page.waitForTimeout(1_000);
    expect(net.commands).toEqual([]);
    await expect(page.locator("[data-identity-header]")).toContainText(
      "Waiting for your review",
    );
    recordEvidence(info, "e-p10", { draft });
  });
});

test.describe("E-P11: a 403 on the field's policy (A20)", () => {
  test("the dialog survives the remount with its draft; the policy is asked ONCE; the owner-only copy is shown", async ({
    context,
  }, info) => {
    // The 403 is held until the value is typed: the remount it causes must come AFTER the draft exists, or there is nothing to lose.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { page, served } = await setup(
      context,
      `/people/${P}`,
      [
        personP(P, "Ada"),
        fieldP(F, P, "Phone", { kind: "text", text: "0770" }),
      ],
      {
        arrange: (s) =>
          s.policyScript.push(() => ({
            status: 403,
            body: atlas("forbidden"),
            after: held,
          })),
      },
    );
    await navigateInApp(page, `/people/${P}/fields/${F}`);
    const dialog = page.getByRole("dialog", { name: "Edit Phone" });
    await dialog
      .getByRole("textbox", { name: "Value" })
      .fill("typed before the remount");
    await expect
      .poll(() => served.log.includes(`GET /policies/${F}`))
      .toBe(true);
    await dialog.evaluate((el) => el.setAttribute("data-e-p11-before", ""));
    release();
    await expect(dialog).toContainText(
      "Only the owner can change who can see this field",
    );
    // The remount replaced the dialog element (the marked one is gone) and the new one reopened with the draft.
    await expect(page.locator("[data-e-p11-before]")).toHaveCount(0);
    await page.waitForTimeout(3_000);
    await expect(
      page
        .getByRole("dialog", { name: "Edit Phone" })
        .getByRole("textbox", { name: "Value" }),
    ).toHaveValue("typed before the remount");
    const reads = served.log.filter((l) => l === `GET /policies/${F}`).length;
    recordEvidence(info, "e-p11", { reads });
    expect(reads).toBe(1);
  });
});

test.describe("E-P12: viewports and themes (A21; browser emulation, not devices)", () => {
  for (const [name, width, height] of [
    ["phone", 390, 844],
    ["tablet portrait", 834, 1112],
    ["tablet landscape", 1180, 820],
    ["desktop", 1440, 900],
  ] as const)
    test(`${name} ${width}×${height}: list, detail and editor fit without horizontal overflow; the editor is a sheet below 768 px; targets ≥ 44 px`, async ({
      context,
    }) => {
      const { page } = await setup(context, `/people/${P}`, [
        personP(P, "Ada"),
        fieldP(F, P, "Phone", { kind: "text", text: "0770" }),
      ]);
      for (const scheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await expect(detail(page)).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
        ).toBe(true);
        await navigateInApp(page, `/people/${P}/fields/${F}`);
        const dialog = page.getByRole("dialog", { name: "Edit Phone" });
        await expect(dialog).toBeVisible();
        // The layout changes with the viewport (one column below 1280 px), which remounts the editor: measure the settled dialog.
        const widthOf = async () =>
          Math.round((await dialog.boundingBox())?.width ?? 0);
        if (width < 768) await expect.poll(widthOf).toBe(width);
        else {
          await expect.poll(widthOf).toBeGreaterThan(0);
          expect(await widthOf()).toBeLessThan(width);
        }
        const small = await dialog
          .locator("button, a, input, select")
          .evaluateAll((els) =>
            els
              .filter((el) => (el as HTMLElement).offsetParent !== null)
              .map((el) => ({
                control: `${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? ""}`,
                height: Math.round(el.getBoundingClientRect().height),
              }))
              .filter((c) => c.height > 0 && c.height < 44),
          );
        if (width < 768) expect(small).toEqual([]);
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(dialog).toBeHidden();
      }
    });
});

test.describe("E-P13: keyboard only (A21)", () => {
  test("from the list to a person, the editor opened, typed, the audience chosen with arrows, saved, focus back", async ({
    context,
  }) => {
    const { page } = await setup(context, "/people", [personP(P, "Ada")]);
    await page.locator(`[data-person-row="${P}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(detail(page)).toBeVisible();
    await detail(page).getByRole("link", { name: "Add a field" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Add a field" });
    await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
    await page.keyboard.type("Note");
    await pressTab(page);
    await pressTab(page);
    await page.keyboard.type("Nuts");
    await dialog.getByRole("radio", { name: /Use my defaults/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      dialog.getByRole("radio", { name: "Only you", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Space");
    await expect(
      dialog.getByRole("radio", { name: "Only you", exact: true }),
    ).toBeChecked();
    await dialog.getByRole("button", { name: "Save" }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(detail(page)).toContainText("Nuts");
  });
});

/** A gate a stubbed answer waits on (the request is logged and held until `open()`). */
function gate() {
  let open!: () => void;
  const after = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { after, open };
}

test.describe("E-P14: an edit keeps the versions and audience it began on (A4, A5, Q1; finding 1 of the review of 13 October)", () => {
  test("a policy published while the editor is open: Save writes no draft; the audience now is shown and 'Save mine' re-binds to it", async ({
    context,
  }, info) => {
    const { net, page, served } = await setup(
      context,
      `/people/${P}/fields/${F}`,
      [
        personP(P, "Ada"),
        fieldP(
          F,
          P,
          "Phone",
          { kind: "text", text: "0770" },
          { version: 4, policy_version: 6 },
        ),
      ],
      { arrange: (s) => s.policies.set(F, { version: 6, policy: PRIVATE }) },
    );
    const dialog = page.getByRole("dialog", { name: "Edit Phone" });
    await expect(dialog.getByRole("radio", { name: "Only you" })).toBeChecked();
    await dialog.getByRole("textbox", { name: "Value" }).fill("Confidential");
    // Version 7 widened the audience to the household.
    served.policies.set(F, { version: 7, policy: HOME_VIEW });
    await publish(
      page,
      net,
      [
        fieldP(
          F,
          P,
          "Phone",
          { kind: "text", text: "0770" },
          { version: 4, policy_version: 7 },
        ),
      ],
      { start: false },
    );
    const panel = dialog.locator("[data-field-conflict]");
    await expect(panel).toContainText("This field changed since you opened it");
    await expect(panel).toContainText("Who can see it now: Home · can view");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    // A definite answer: the refused save says so (the dialog stays open and nothing is written).
    await expect(panel).toContainText(
      "Nothing was saved. Check the current value, then save yours on it or discard it.",
    );
    expect(await draftsOf(page)).toEqual([]);
    await panel
      .getByRole("button", { name: "Save mine on the current version" })
      .click();
    await expect(dialog).toBeHidden();
    const bodies = (await page.evaluate(
      (a) => window.__atlasData?.rows(a, "draft_commands"),
      ME,
    )) as Array<{ command: { command: Record<string, unknown> } }>;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.command.command).toMatchObject({
      expected_version: 4,
      expected_policy_version: 7,
      value: { kind: "text", text: "Confidential" },
    });
    recordEvidence(info, "e-p14", { bodies });
  });
});

test.describe("E-P15: a held change is durable for its account (Q3, Q20; finding 6)", () => {
  test("held offline, it survives the page closing (a new page reads it from real IndexedDB) and runs there: the audience first, then the content", async ({
    context,
  }, info) => {
    const { net, page, served } = await setup(
      context,
      `/people/${P}/fields/${F}`,
      [
        personP(P, "Ada"),
        fieldP(
          F,
          P,
          "Note",
          { kind: "text", text: "Inhaler" },
          { version: 4, policy_version: 6 },
        ),
      ],
      { arrange: (s) => s.policies.set(F, { version: 6, policy: HOME_VIEW }) },
    );
    await startOutbox(page);
    const dialog = page.getByRole("dialog", { name: "Edit Note" });
    await expect(
      dialog.getByRole("radio", { name: "Home · can view" }),
    ).toBeChecked();
    await connectivity(context, page, false);
    await dialog.getByRole("textbox", { name: "Value" }).fill("Kept");
    await dialog.getByRole("radio", { name: "Only you", exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.getByRole("button", { name: "Hold as draft" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`[data-held-field="${F}"]`)).toBeVisible();
    // The page goes away while the device is offline (nothing has run); a NEW page of the same browser profile opens the account later.
    await page.close();
    await connectivity(context, await context.newPage(), true);
    served.policyScript.push(
      () => ({ status: 200, body: { version: 6, policy: HOME_VIEW } }),
      () => ({ status: 200, body: { version: 7, policy: PRIVATE } }),
    );
    const reopened = await bootAt(context, `/people/${P}`);
    await startOutbox(reopened);
    await expect
      .poll(() => served.management.length, { timeout: 15_000 })
      .toBe(1);
    await expect.poll(async () => (await draftsOf(reopened)).length).toBe(1);
    await send(reopened);
    await expect.poll(() => net.commands.length).toBe(1);
    expect(JSON.parse(net.commands[0]?.body ?? "{}").command).toMatchObject({
      expected_version: 4,
      expected_policy_version: 7,
      value: { kind: "text", text: "Kept" },
    });
    await expect(reopened.locator(`[data-held-field="${F}"]`)).toHaveCount(0);
    recordEvidence(info, "e-p15", { log: served.log, commands: net.commands });
  });
});

test.describe("E-P16: Discard stops a held change that is running (A6; finding 2)", () => {
  test("discarded while its policy read is on its way: no replace_policy is sent and no content is queued", async ({
    context,
  }, info) => {
    const { page, served } = await setup(
      context,
      `/people/${P}/fields/${F}`,
      [
        personP(P, "Ada"),
        fieldP(
          F,
          P,
          "Note",
          { kind: "text", text: "Inhaler" },
          { version: 4, policy_version: 6 },
        ),
      ],
      { arrange: (s) => s.policies.set(F, { version: 6, policy: HOME_VIEW }) },
    );
    const dialog = page.getByRole("dialog", { name: "Edit Note" });
    await expect(
      dialog.getByRole("radio", { name: "Home · can view" }),
    ).toBeChecked();
    await connectivity(context, page, false);
    await dialog.getByRole("radio", { name: "Only you", exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.getByRole("button", { name: "Hold as draft" }).click();
    const row = page.locator(`[data-held-field="${F}"]`);
    await expect(row).toBeVisible();
    const held = gate();
    served.policyScript.push(() => ({
      status: 200,
      body: { version: 6, policy: HOME_VIEW },
      after: held.after,
    }));
    const before = served.log.length;
    await connectivity(context, page, true);
    await expect
      .poll(() => served.log.slice(before))
      .toEqual([`GET /policies/${F}`]);
    await row.getByRole("button", { name: "Discard" }).click();
    held.open();
    await expect(row).toHaveCount(0);
    await expect(page.locator("body")).toContainText(
      "The held change to Note was discarded. Nothing was sent.",
    );
    expect(served.management).toEqual([]);
    expect(await draftsOf(page)).toEqual([]);
    recordEvidence(info, "e-p16", { log: served.log });
  });
});

test.describe("E-P17: state stays with its person (A9, A13; finding 4)", () => {
  test("a rename typed on one person is not carried to another by in-app navigation, and nothing is sent", async ({
    context,
  }) => {
    const { page, served } = await setup(
      context,
      `/people/${P}`,
      [personP(P, "Ada", { version: 3 }), personP(Q, "Bob")],
      { linked: { [P]: ME, [Q]: null } },
    );
    const header = page.locator("[data-identity-header]");
    await header.getByRole("button", { name: "Rename" }).click();
    await header.getByRole("textbox", { name: "Name" }).fill("Ada corrected");
    await navigateInApp(page, `/people/${Q}`);
    await expect(page.locator(`[data-person-detail="${Q}"]`)).toBeVisible();
    await expect(page.locator("[data-rename-form]")).toHaveCount(0);
    expect(served.peopleCommands).toEqual([]);
    expect(await draftsOf(page)).toEqual([]);
  });
});

test.describe("E-P18: every person stays reachable in bounded steps (Q9; finding 7)", () => {
  test("250 people in real IndexedDB: 'Next people' continues from the cursor, 'Previous people' goes back, nobody is skipped", async ({
    context,
  }) => {
    const people = Array.from({ length: 250 }, (_, i) =>
      personP(
        `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        `Person ${String(i).padStart(3, "0")}`,
      ),
    );
    const { page } = await setup(context, "/people", people);
    const rows = page.locator("[data-person-row]");
    await expect(rows).toHaveCount(100);
    await expect(rows.first()).toContainText("Person 000");
    await expect(rows.last()).toContainText("Person 099");
    await expect(
      page.getByRole("button", { name: "Next people" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next people" }).click();
    await expect(rows.first()).toContainText("Person 100");
    await expect(rows.last()).toContainText("Person 199");
    await expect(
      page.getByRole("button", { name: "Next people" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next people" }).click();
    await expect(rows).toHaveCount(50);
    await expect(rows.last()).toContainText("Person 249");
    await expect(page.getByRole("button", { name: "Next people" })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Previous people" }).click();
    await expect(rows.first()).toContainText("Person 100");
  });
});
