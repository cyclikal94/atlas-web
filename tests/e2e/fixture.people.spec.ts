import { expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  deltaPage,
  fresh,
  leaderPage,
  snapshotPage,
} from "./data-leader-helpers";
import {
  atlasError,
  seedSettled,
  startOutbox,
  stubNetwork,
} from "./data-sync-helpers";
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
  notSummary,
  OWNER_ONLY,
  personP,
  publish,
  publishChanges,
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
 * Finding 8 with API 0.29's viewer-safe summaries: E-P19 the drawn lines and the server's In Home / Shared with me / Not linked views,
 * offline included; E-P20 the "Shared with" rails and the field audience tags; E-P21 a synced change reads them again, and an answer it
 * superseded is never shown. Review 2 (22 October 2026): E-P22 an old editor never overwrites a newer edit of the same queued draft
 * (finding 3); E-P23 the generic Sync dialog never resends a People change under an audience the person did not review (finding 1);
 * E-P24 held changes past a thousand ended copies stay reachable in real IndexedDB (finding 4). E-P15 asserts D1's "Send now".
 * Review 7 (23 October 2026): E-P34 a field's actions and E-P35 a header action and a list row keep their place through an answer during
 * a press (finding 3). Review 9 (24 October 2026): E-P36 the field editor whose real IndexedDB read of its field fails says so, and the
 * overlay, the close icon and Escape end only the session of the field shown, reached through the same route (in-app or Back).
 * Review 15 (25 October 2026): E-P39 a duplicate's field count follows its person across two real pages (R15.1, A14).
 * Review 16 (26 October 2026): E-P40 the detail, the archived ledger, the field editor and the sharing deep link show a field only with its
 * person from the same read, across two real pages (R16.1, DA16-S1, A14).
 */
const P = "55555555-5555-4555-8555-555555555555";
const Q = "77777777-7777-4777-8777-777777777777";
const F = "66666666-6666-4666-8666-666666666666";
const PRIVATE = { grants: [], exclude_accounts: [] };
const HOME_VIEW = {
  grants: [{ kind: "household", id: HOME, edit: false }],
  exclude_accounts: [],
};

type Box = { x: number; y: number; width: number; height: number };
/** A field audience of the owner alone (the summaries' `OWNER_ONLY`). */
const OWNER_ONLY_AUDIENCE = OWNER_ONLY;

const send = (page: Page) =>
  page.evaluate(() => window.__atlasData?.retryOutbox());
const detail = (page: Page) => page.locator(`[data-person-detail="${P}"]`);
/**
 * Harness precondition (revision 5, campaign 19): the person's linkage line has answered. Until then the header shows the longer
 * "isn't known" line, and its answer moves every control below it up; a click whose press and release straddle that move reaches
 * no link (Firefox E-P3). A case that clicks in the detail straight after boot waits for it first; what it asserts is unchanged.
 */
const linkageAnswered = (page: Page) =>
  expect(
    detail(page).locator('[data-linkage]:not([data-linkage="unknown"])'),
  ).toBeVisible();

test.describe("E-P1: the people list (A1)", () => {
  test("sorted by name, searchable, archived people only under Archived; the Account line comes from the summaries, never a person read", async ({
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
    await expect(page.locator("[data-person-linkage]")).toHaveCount(30);
    await page
      .getByRole("searchbox", { name: "Search people" })
      .fill("person 07");
    await expect(rows).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Search people" }).fill("");
    await page.getByRole("button", { name: "Archived" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Ada");
    await expect(rows.first()).toContainText("Not linked to an account");
    await page.getByRole("button", { name: "All" }).click();
    await expect(rows).toHaveCount(30);
    const personReads = served.log.filter((l) =>
      /^GET \/people\/[0-9a-f-]{36}$/.test(l),
    );
    const summaryReads = served.log
      .filter((l) => l.startsWith("GET /people/summaries"))
      .map((l) => new URL(l.slice(4), "http://x").searchParams);
    recordEvidence(info, "e-p1", { personReads, log: served.log });
    // Finding 8: the list reads no person (the 0.28 prefetch of 25 is gone); every summary read is bounded and of the step's view.
    expect(personReads).toEqual([]);
    expect(summaryReads.length).toBeGreaterThan(0);
    for (const query of summaryReads) {
      expect(query.get("scope")).toBe("all");
      expect(query.get("limit")).toBe("100");
    }
    expect(summaryReads.some((q) => q.get("archived") === "true")).toBe(true);
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
    await linkageAnswered(page);
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
    await linkageAnswered(page);
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
    expect(served.log.slice(before).filter(notSummary)).toEqual([
      `GET /policies/${F}`,
      "POST /management-commands",
      `GET /policies/${F}`,
    ]);
    // The audience change was sent: the summaries shown are read again after it (finding 8).
    const sent = served.log.lastIndexOf("POST /management-commands");
    await expect
      .poll(() => served.log.slice(sent).some((l) => !notSummary(l)))
      .toBe(true);
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
    await linkageAnswered(page);
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

test.describe("E-P39: a duplicate's field count follows its person across two real pages (A14, PPL-5; review 15, R15.1)", () => {
  const G = "67676767-6767-4676-8676-676767676767";
  const phone = { kind: "text", text: "07700 900461" };
  for (const schedule of ["removed", "removed-and-added", "control"] as const)
    test(`${schedule === "removed" ? "the person is removed by a sync page in the leader page, their field kept: the other page's hint stays listed with no count" : schedule === "removed-and-added" ? "ONE sync page removes the person and adds a field of theirs: the other page never shows '2 fields', and no count" : "control: a field added under the visible person reaches the other page as '2 fields'"}`, async ({
      context,
    }, info) => {
      // The leader page commits the sync pages (the production page commit over real IndexedDB); the observer is another page with its
      // own memory and its own live reads, which learns of the commit only through the database.
      const net = await stubNetwork(context);
      const served = await servePeople(context);
      const resources = [
        personP(P, "Mo"),
        personP(Q, "Mohammed A."),
        fieldP(F, Q, "Phone", phone),
      ];
      for (const resource of resources)
        if (resource.kind === "person")
          served.people.set(resource.id, { person: resource, linked: null });
      // The observer's first page (the leader shows the list, which reads no duplicates).
      served.duplicates.push({
        items: [personP(Q, "Mohammed A.")],
        next_after: null,
      });
      await seedSettled(context);
      const leader = await bootAt(context, "/people");
      const observer = await bootAt(context, `/people/${P}/duplicates`);
      const asked = () =>
        served.log.filter((l) => l.includes("/duplicates")).length;
      await publish(leader, net, resources);
      const hint = observer.locator(`[data-duplicate-hint="${Q}"]`);
      await expect(hint).toContainText("1 field");
      const before = asked();
      // Every DOM state of the hint from here on (MutationObserver: no paint or timer is involved).
      await observer.evaluate((q) => {
        const seen: string[] = [];
        (window as unknown as { __ep39: string[] }).__ep39 = seen;
        new MutationObserver(() => {
          seen.push(
            document.querySelector(`[data-duplicate-hint="${q}"]`)
              ?.textContent ?? "(no hint)",
          );
        }).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      }, Q);
      const added = fieldP(G, Q, "Mobile", phone);
      await publishChanges(
        leader,
        net,
        schedule === "removed"
          ? [{ kind: "remove", id: Q }]
          : schedule === "removed-and-added"
            ? [
                { kind: "remove", id: Q },
                { kind: "upsert", resource: added },
              ]
            : [{ kind: "upsert", resource: added }],
        // Harness precondition (author diagnostics in all three engines): the running leader takes the page, nudged until it does. A
        // single nudge during the leader's own follow-up /sync started nothing, and a restarted leader lost the page to the old engine's
        // follow-up. What the case asserts is unchanged.
        { start: false, retake: true },
      );
      // The commit is in the ONE database both pages read (seen through the leader's handle): the field (or fields) of Q stay cached.
      await expect
        .poll(async () =>
          (
            (await leader.evaluate(
              (a) => window.__atlasData?.rows(a, "cache"),
              ME,
            )) as Array<{ id: string }>
          )
            .map((row) => row.id)
            .filter((id) => [Q, F, G].includes(id))
            .sort(),
        )
        .toEqual(
          (schedule === "removed"
            ? [F]
            : schedule === "removed-and-added"
              ? [F, G]
              : [F, G, Q]
          ).sort(),
        );
      if (schedule === "control") await expect(hint).toContainText("2 fields");
      else {
        await expect(hint).toContainText("Mohammed A.");
        await expect(hint).not.toContainText(/\d+ fields?/);
      }
      const seen = (await observer.evaluate(
        () => (window as unknown as { __ep39: string[] }).__ep39,
      )) as string[];
      recordEvidence(info, "e-p39", { schedule, seen, log: served.log });
      if (schedule === "removed-and-added")
        expect(seen.filter((text) => text.includes("2 fields"))).toEqual([]);
      // Nothing was asked of the server again: the count followed the database alone (one read, the observer's first page, at its boot).
      expect(before).toBe(1);
      expect(asked()).toBe(before);
    });
});

test.describe("E-P40: a field shown only with its person from the same read, across two real pages (A14, PPL-5; review 16, R16.1, DA16-S1)", () => {
  const G = "68686868-6868-4686-8686-686868686868";
  const SECRET = "Newly delivered secret";
  const RENAMED = "Renamed secret label";
  type Surface = "detail" | "ledger" | "editor" | "sharing";
  const routes: Record<Surface, string> = {
    detail: `/people/${P}`,
    ledger: "/settings/archived",
    editor: `/people/${P}/fields/${F}`,
    sharing: `/sharing/items/${F}`,
  };
  const cases: Array<{
    surface: Surface;
    schedule: "removed-and-changed" | "removed" | "control";
  }> = [
    ...(["detail", "ledger", "editor", "sharing"] as const).flatMap(
      (surface) => [
        { surface, schedule: "removed-and-changed" as const },
        { surface, schedule: "control" as const },
      ],
    ),
    { surface: "detail", schedule: "removed" },
    { surface: "ledger", schedule: "removed" },
  ];
  for (const { surface, schedule } of cases)
    test(`${surface}: ${schedule === "removed-and-changed" ? "ONE sync page in the leader page removes the person, changes their field and adds another: the other page never shows the new label or value" : schedule === "removed" ? "the person alone is removed by a sync page, their field kept: the other page withdraws the field (its read follows the person)" : "control: the field changed and another added under the visible person reach the other page"}`, async ({
      context,
    }, info) => {
      // The leader page commits the sync pages (the production page commit over real IndexedDB); the observer is another page with its
      // own memory and its own live reads, which learns of the commit only through the database.
      const net = await stubNetwork(context);
      const served = await servePeople(context);
      const archived = surface === "ledger";
      const old = fieldP(
        F,
        P,
        "Phone",
        { kind: "text", text: "Old value" },
        { archived },
      );
      served.people.set(P, { person: personP(P, "Mo"), linked: null });
      served.policies.set(F, { version: 1, policy: PRIVATE });
      await seedSettled(context);
      const leader = await bootAt(context, "/people");
      const observer = await bootAt(context, routes[surface]);
      await publish(leader, net, [personP(P, "Mo"), old]);
      const shown = {
        detail: () =>
          expect(observer.locator(`[data-field-row="${F}"]`)).toContainText(
            "Old value",
          ),
        ledger: () => expect(observer.getByText("Phone · Mo")).toBeVisible(),
        editor: () =>
          expect(
            observer.getByRole("dialog", { name: "Edit Phone" }),
          ).toBeVisible(),
        sharing: () =>
          expect(
            observer.getByRole("dialog", { name: "Sharing — Phone" }),
          ).toBeVisible(),
      }[surface];
      await shown();
      // Every rendered state of the observer from here on (MutationObserver: no paint or timer is involved).
      await observer.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { __ep40: string[] }).__ep40 = seen;
        new MutationObserver(() => {
          seen.push(document.body.textContent ?? "");
        }).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      });
      const changed = fieldP(
        F,
        P,
        RENAMED,
        { kind: "text", text: SECRET },
        { archived, version: 2 },
      );
      const added = fieldP(
        G,
        P,
        "Mobile",
        { kind: "text", text: SECRET },
        { archived },
      );
      await publishChanges(
        leader,
        net,
        schedule === "removed"
          ? [{ kind: "remove", id: P }]
          : schedule === "removed-and-changed"
            ? [
                { kind: "remove", id: P },
                { kind: "upsert", resource: changed },
                { kind: "upsert", resource: added },
              ]
            : [
                { kind: "upsert", resource: changed },
                { kind: "upsert", resource: added },
              ],
        // Harness precondition (E-P39): the running leader takes the page, nudged until it does.
        { start: false, retake: true },
      );
      // The commit is in the ONE database both pages read (seen through the leader's handle): the fields stay cached after the person.
      await expect
        .poll(async () =>
          (
            (await leader.evaluate(
              (a) => window.__atlasData?.rows(a, "cache"),
              ME,
            )) as Array<{ id: string }>
          )
            .map((row) => row.id)
            .filter((id) => [P, F, G].includes(id))
            .sort(),
        )
        .toEqual(
          (schedule === "removed"
            ? [F]
            : schedule === "removed-and-changed"
              ? [F, G]
              : [F, G, P]
          ).sort(),
        );
      if (schedule === "control") {
        const after = {
          detail: () =>
            expect(observer.locator(`[data-field-row="${G}"]`)).toContainText(
              SECRET,
            ),
          ledger: () =>
            expect(observer.getByText(`${RENAMED} · Mo`)).toBeVisible(),
          editor: () =>
            expect(observer.getByRole("dialog")).toContainText(SECRET),
          sharing: () =>
            expect(
              observer.getByRole("dialog", { name: `Sharing — ${RENAMED}` }),
            ).toBeVisible(),
        }[surface];
        await after();
      } else {
        const gone = {
          detail: () =>
            expect(
              observer.locator('[data-people-state="not-on-device"]'),
            ).toBeVisible(),
          ledger: () =>
            expect(observer.getByText(/Nothing archived/)).toBeVisible(),
          editor: () =>
            expect(
              observer.locator('[data-people-state="not-on-device"]'),
            ).toBeVisible(),
          sharing: () =>
            expect(
              observer.locator('[data-policy-state="absent"]'),
            ).toBeVisible(),
        }[surface];
        await gone();
        await expect(observer.locator("body")).not.toContainText("Old value");
      }
      const seen = (await observer.evaluate(
        () => (window as unknown as { __ep40: string[] }).__ep40,
      )) as string[];
      recordEvidence(info, "e-p40", {
        surface,
        schedule,
        states: seen.length,
        log: served.log,
      });
      if (schedule === "removed-and-changed") {
        expect(seen.filter((text) => text.includes(SECRET))).toEqual([]);
        expect(seen.filter((text) => text.includes(RENAMED))).toEqual([]);
      }
    });
});

test.describe("E-P10: a new person with a note, never-fetched defaults (A8 at the client, A16)", () => {
  test("one /commands batch [create_person, create_field], held for the defaults review: nothing is sent", async ({
    context,
  }, info) => {
    // The defaults cannot be read from the page's first request on: the save captures 'never fetched' and is held for review.
    // HARNESS CORRECTION (22 October 2026): the 503 used to be routed AFTER `setup` had booted the page, so the boot's own defaults read
    // could already have been answered 200 (Chromium, run pw-people-4: review_block null). Same intent, arranged before the boot.
    const { net, page } = await setup(context, "/people", [personP(Q, "Bo")], {
      arrange: (s) => {
        s.snapshotUnavailable = true;
      },
    });
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
    // Harness precondition (revision 5, campaign 18): the app puts focus on the page heading itself, at boot (the session hand-off
    // focuses the protected tree's first heading once it appears, possibly after `setup` returns) and after each in-app navigation
    // (RouteFocus, a frame later). Keyboard input starts only once that has happened, or the late focus takes the row's and Enter
    // opens nothing. The journey and its assertions are unchanged.
    const heading = page.getByRole("heading", { level: 1, name: "People" });
    await expect(heading).toBeFocused();
    await page.locator(`[data-person-row="${P}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(detail(page)).toBeVisible();
    await expect(heading).toBeFocused();
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
  // ADAPTATION (D1, 22 October 2026: "explicit Send now"): the reopened page used to run the recovered hold by itself. Its intent (durable
  // across the page closing, read from real IndexedDB, the audience first and then the content on the confirmed version) is kept; the run
  // now starts only from "Send now", and nothing is asked before it.
  test("held offline, it survives the page closing (a new page reads it from real IndexedDB), waits for 'Send now' there, then runs: the audience first, then the content", async ({
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
    const sinceReopen = served.log.length;
    const reopened = await bootAt(context, `/people/${P}`);
    await startOutbox(reopened);
    const recovered = reopened.locator(`[data-held-field="${F}"]`);
    await expect(recovered).toContainText(
      "Waiting to change who can see Note. Send it when you're ready.",
    );
    const sendNow = recovered.getByRole("button", { name: "Send now" });
    await expect(sendNow).toBeEnabled();
    // Online and writable, and nothing was asked for it before the person chose to send it.
    const atChoice = served.log.length;
    expect(
      served.log
        .slice(sinceReopen)
        .filter((line) => line === `GET /policies/${F}`),
    ).toEqual([]);
    expect(served.management).toEqual([]);
    await sendNow.click();
    await expect
      .poll(() => served.management.length, { timeout: 15_000 })
      .toBe(1);
    expect(
      served.log.slice(sinceReopen).indexOf(`GET /policies/${F}`) + sinceReopen,
    ).toBeGreaterThanOrEqual(atChoice);
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
      .poll(() => served.log.slice(before).filter(notSummary))
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

// ---- finding 8: the viewer-safe summaries (API 0.29) ----------------------------------------------------------------------------------
const K8 = "88888888-8888-4888-8888-000000000001";
const M8 = "88888888-8888-4888-8888-000000000002";
const S8 = "88888888-8888-4888-8888-000000000003";
const A8 = "88888888-8888-4888-8888-000000000004";
const HOUSEHOLD = {
  id: HOME,
  can_edit: false,
  you_are_member: true,
  name: "Home",
  version: 1,
  member_count: 2,
};
const OWNER_HOME = {
  disclosure: "complete",
  in_home: true,
  households: [HOUSEHOLD],
  your_direct_grant: null,
  direct_grant_count: 0,
  excluded_count: 0,
};
const PARTIAL_HOME = {
  disclosure: "partial",
  in_home: true,
  households: [HOUSEHOLD],
  your_direct_grant: null,
  direct_grant_count: null,
  excluded_count: null,
};
const MO_OWNER = {
  account_id: MO,
  username: "mo",
  you: false,
  person: { id: M8, label: "Mo" },
};
const SAM_SHARED = {
  owner: MO_OWNER,
  your_access: "view",
  added_by_you: "no",
  audience: PARTIAL_HOME,
};

test.describe("E-P19: the drawn lines and views from the viewer-safe summaries (finding 8)", () => {
  test("Account, Visible to and who added each person; In Home, Shared with me and Not linked are the server's; offline they need a connection and nothing old is shown", async ({
    context,
  }, info) => {
    const { served, page } = await setup(
      context,
      "/people",
      [
        personP(K8, "Kieran"),
        personP(M8, "Mo", { can_edit: false }),
        personP(S8, "Sam", { can_edit: false }),
        personP(A8, "Ada"),
      ],
      {
        linked: { [K8]: ME, [M8]: MO },
        arrange: (s) => {
          s.summaries.set(K8, { added_by_you: "yes", audience: OWNER_HOME });
          s.summaries.set(M8, {
            owner: { ...MO_OWNER, person: null },
            your_access: "view",
            added_by_you: "yes",
            audience: PARTIAL_HOME,
          });
          s.summaries.set(S8, SAM_SHARED);
          s.summaries.set(A8, { added_by_you: "yes", audience: OWNER_HOME });
        },
      },
    );
    const rows = page.locator("[data-person-row]");
    const row = (id: string) => page.locator(`[data-person-row="${id}"]`);
    await expect(row(S8)).toContainText("Shared with you by Mo");
    await expect(row(S8)).toContainText("Visible to: Shared from Home");
    await expect(row(K8)).toContainText("Linked to your account");
    await expect(row(M8)).toContainText("Added by you");
    await expect(row(M8)).toContainText("Linked · they control their name");
    await expect(row(A8)).toContainText("Visible to: Home · can view");
    await expect(
      page.getByText(/The owner may have shared them more widely/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Shared with me" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Sam");
    await page.getByRole("button", { name: "Not linked" }).click();
    await expect(rows).toHaveCount(2);
    await page.getByRole("button", { name: "In Home" }).click();
    await expect(rows).toHaveCount(4);
    const scopes = new Set(
      served.log
        .filter((l) => l.startsWith("GET /people/summaries"))
        .map((l) => new URL(l.slice(4), "http://x").searchParams.get("scope")),
    );
    expect([...scopes].sort()).toEqual([
      "all",
      "in_home",
      "not_linked",
      "shared_with_me",
    ]);
    await connectivity(context, page, false);
    await expect(
      page.getByText(
        "This view needs a connection. All and Archived work offline.",
      ),
    ).toBeVisible();
    await expect(rows).toHaveCount(0);
    await page.getByRole("button", { name: "All" }).click();
    await expect(rows).toHaveCount(4);
    await expect(page.locator("[data-person-audience]")).toHaveCount(0);
    await expect(page.locator("[data-person-linkage]")).toHaveCount(0);
    await expect(page.locator("[data-person-attribution]")).toHaveCount(0);
    await connectivity(context, page, true);
    await expect(page.locator("[data-person-audience]")).toHaveCount(4);
    recordEvidence(info, "e-p19", { log: served.log });
  });
});

test.describe("E-P20: Shared with and the field tags (finding 8)", () => {
  test("the owner's complete rail and another owner's partial one; a field's own sharing and who can see it; no owner-only policy read", async ({
    context,
  }) => {
    const { served, page } = await setup(
      context,
      `/people/${A8}`,
      [
        personP(A8, "Ada"),
        personP(S8, "Sam", { can_edit: false }),
        personP(M8, "Mo", { can_edit: false }),
        fieldP(F, A8, "Phone", { kind: "text", text: "07700 900461" }),
      ],
      {
        arrange: (s) => {
          s.summaries.set(S8, SAM_SHARED);
          s.rails.set(A8, {
            disclosure: "complete",
            owner: { account_id: ME, username: "me", you: true, person: null },
            accounts: [{ account_id: MO, username: "mo", can_edit: true }],
            households: [
              {
                ...HOUSEHOLD,
                members: [
                  { account_id: ME, username: "me", excluded: false },
                  { account_id: MO, username: "mo", excluded: true },
                ],
              },
            ],
            excluded_accounts: [{ account_id: MO, username: "mo" }],
          });
          s.rails.set(S8, {
            disclosure: "partial",
            owner: MO_OWNER,
            accounts: [{ account_id: ME, username: "me", can_edit: false }],
            households: [{ ...HOUSEHOLD, members: null }],
            excluded_accounts: null,
          });
          s.fieldAudiences.set(A8, [
            {
              id: F,
              version: 1,
              policy_version: 1,
              archived: false,
              owner_is_you: true,
              your_access: "owner",
              audience: OWNER_HOME,
              effective: {
                disclosure: "complete",
                account_count: 1,
                limited_count: 0,
              },
            },
          ]);
        },
      },
    );
    const rail = page.getByRole("region", { name: "Shared with" });
    await expect(rail).toHaveAttribute("data-shared-with", "complete");
    await expect(rail).toContainText("mo (can't see it)");
    await expect(rail).toContainText("Excluded: mo");
    await expect(rail).toContainText("2 members in the household");
    const field = page.locator(`[data-field-row="${F}"]`);
    await expect(
      field.getByRole("button", { name: "Home · can view" }),
    ).toBeVisible();
    await expect(field).toContainText("1 other person can see it.");
    await navigateInApp(page, `/people/${S8}`);
    const other = page.getByRole("region", { name: "Shared with" });
    await expect(other).toHaveAttribute("data-shared-with", "partial");
    await expect(other).toContainText(
      "Mo owns this person. You see only how it's shared with you; Mo may have shared it more widely.",
    );
    await expect(other).not.toContainText("Excluded");
    expect(served.log.filter((l) => l.startsWith("GET /policies/"))).toEqual(
      [],
    );
  });
});

test.describe("E-P21: freshness and supersession in real IndexedDB (finding 8)", () => {
  test("a synced change (here a field of a listed person: the list's people are the same) reads the summaries again; an answer it superseded is never shown", async ({
    context,
  }, info) => {
    const { net, served, page } = await setup(
      context,
      "/people",
      [personP(S8, "Sam", { can_edit: false })],
      { arrange: (s) => s.summaries.set(S8, SAM_SHARED) },
    );
    const row = page.locator(`[data-person-row="${S8}"]`);
    const reads = () =>
      served.log.filter((l) => l.startsWith("GET /people/summaries")).length;
    await expect(row).toContainText("Shared with you by Mo");
    // The B5 record is loaded (its arrival is a signal of its own), so only the synced changes below can ask again.
    await expect
      .poll(() =>
        page.evaluate(
          (a) =>
            window.__atlasData
              ?.defaultsRecord(a)
              .then((r) => r?.snapshot.defaults.revision ?? null),
          ME,
        ),
      )
      .not.toBeNull();
    await page.waitForTimeout(300);
    const before = reads();
    // The next summary read is held, and claims Sam was added by me: once superseded it must never be shown.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    served.summaryScript.push({
      status: 200,
      after: held,
      body: {
        items: [
          {
            id: S8,
            label: "Sam",
            version: 1,
            policy_version: 1,
            archived: false,
            linkage: "none",
            linked_account_id: null,
            ...SAM_SHARED,
            added_by_you: "yes",
            field_count: 0,
          },
        ],
        next_after: null,
        home: served.home,
        preferences_version: 1,
      },
    });
    const field = fieldP(F, S8, "Phone", { kind: "text", text: "0770" });
    await publish(page, net, [field], { start: false });
    await expect.poll(reads).toBe(before + 1);
    // A second synced change supersedes the held read: the newer answer is shown.
    await publish(page, net, [{ ...field, version: 2 }], { start: false });
    await expect.poll(reads).toBe(before + 2);
    await expect(row).toContainText("Shared with you by Mo");
    release();
    await page.waitForTimeout(500);
    await expect(row).toContainText("Shared with you by Mo");
    await expect(row).not.toContainText("Added by you");
    recordEvidence(info, "e-p21", { log: served.log });
  });
});

test.describe("E-P22: an old editor never overwrites a newer edit of the same queued draft (review 2, finding 3)", () => {
  for (const concurrent of [false, true])
    test(`${concurrent ? "the queued body was edited through the public outbox while the editor was open: nothing is written, the field is reviewed, the newer body survives" : "control: the queued draft the editor opened on is edited in place"}`, async ({
      context,
    }, info) => {
      const { page } = await setup(
        context,
        `/people/${P}/fields/${F}`,
        [
          personP(P, "Ada"),
          fieldP(
            F,
            P,
            "Note",
            { kind: "text", text: "Original" },
            { version: 4, policy_version: 6 },
          ),
        ],
        { arrange: (s) => s.policies.set(F, { version: 6, policy: PRIVATE }) },
      );
      const bodies = () =>
        page.evaluate(
          (account) => window.__atlasData?.rows(account, "draft_commands"),
          ME,
        ) as Promise<
          Array<{ command: { command: { value: { text: string } } } }>
        >;
      let dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("radio", { name: "Only you", exact: true }),
      ).toBeChecked();
      await dialog
        .getByRole("textbox", { name: "Value" })
        .fill("Original queued");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden();
      const [original] = await draftsOf(page);
      expect(original?.status).toBe("queued");
      await navigateInApp(page, `/people/${P}/fields/${F}`);
      dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("textbox", { name: "Value" })).toHaveValue(
        "Original queued",
      );
      await dialog
        .getByRole("textbox", { name: "Value" })
        .fill("Older open editor");
      if (concurrent) {
        await startOutbox(page, ME, { start: false });
        const edited = await page.evaluate(
          ({ id, field, person }) =>
            window.__atlasData?.editQueued(id, {
              endpoint: "/task-commands",
              targets: [
                {
                  resourceId: field,
                  role: "primary",
                  basis: "resource",
                  versionChecked: true,
                },
              ],
              command: {
                command: {
                  kind: "put_field",
                  id: field,
                  parent_id: person,
                  expected_version: 4,
                  expected_policy_version: 6,
                  label: "Note",
                  value: { kind: "text", text: "Newer save from another tab" },
                },
              },
            }),
          { id: original?.local_id as string, field: F, person: P },
        );
        expect(edited?.kind).toBe("edited");
      }
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      if (concurrent) {
        await expect(dialog).toContainText(
          "This field changed since you opened it",
        );
        await expect(
          dialog.getByRole("textbox", { name: "Value" }),
        ).toHaveValue("Older open editor");
      } else await expect(dialog).toBeHidden();
      const stored = await bodies();
      expect(await draftsOf(page)).toHaveLength(1);
      expect(stored[0]?.command.command.value.text).toBe(
        concurrent ? "Newer save from another tab" : "Older open editor",
      );
      recordEvidence(info, "e-p22", { concurrent, stored });
    });
});

test.describe("E-P23: the generic Sync dialog never resends a People change under an audience the person did not review (review 2, finding 1)", () => {
  for (const widened of [false, true])
    test(`${widened ? "the field's audience was widened to Home after the conflict: the retained content is shown, Resend is withheld with its reason, nothing is sent" : "control, the same audience: the retained content beside the current, and Resend sends it under the policy version it was saved with"}`, async ({
      context,
    }, info) => {
      const field = (version: number, policy: number) =>
        fieldP(
          F,
          P,
          "Note",
          { kind: "text", text: "Original" },
          { version, policy_version: policy },
        );
      const { page, net, served } = await setup(
        context,
        `/people/${P}/fields/${F}`,
        [personP(P, "Ada"), field(4, 6)],
        { arrange: (s) => s.policies.set(F, { version: 6, policy: PRIVATE }) },
      );
      await startOutbox(page);
      net.commandScript.push(() => ({
        status: 409,
        body: atlasError("conflict"),
      }));
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("radio", { name: "Only you", exact: true }),
      ).toBeChecked();
      await dialog.getByRole("textbox", { name: "Value" }).fill("Confidential");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden();
      await send(page);
      await expect
        .poll(async () => (await draftsOf(page)).map((d) => d.status))
        .toEqual(["version_conflict"]);
      const now = widened ? field(4, 7) : field(5, 6);
      if (widened) served.policies.set(F, { version: 7, policy: HOME_VIEW });
      await publish(page, net, [now], { start: false });
      await context.route("**/fields?**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [now], next_after: null }),
        }),
      );
      await navigateInApp(page, "/sync?tab=conflicts");
      await page.getByRole("button", { name: "Details: Field change" }).click();
      const detailDialog = page.getByRole("dialog");
      await expect(
        detailDialog.locator('[data-compare="retained"]'),
      ).toContainText("Note: Confidential");
      await expect(
        detailDialog.locator('[data-compare="current"]'),
      ).toContainText("Note: Original");
      const resend = detailDialog.getByRole("button", {
        name: "Resend as a new operation",
      });
      if (widened) {
        await expect(detailDialog).toContainText(
          "Who can see this field changed since you saved it. Review it on the person's page in People.",
        );
        await expect(resend).toBeDisabled();
        await send(page);
        expect(net.commands).toHaveLength(1);
        expect((await draftsOf(page)).map((d) => d.status)).toEqual([
          "version_conflict",
        ]);
        recordEvidence(info, "e-p23", { widened, commands: net.commands });
        return;
      }
      await expect(resend).toBeEnabled();
      await resend.click();
      await expect(detailDialog).toBeHidden();
      await send(page);
      await expect.poll(() => net.commands.length).toBe(2);
      expect(JSON.parse(net.commands[1]?.body ?? "{}").command).toMatchObject({
        expected_version: 5,
        expected_policy_version: 6,
        value: { kind: "text", text: "Confidential" },
      });
      recordEvidence(info, "e-p23", { widened, commands: net.commands });
    });
});

test.describe("E-P24: held changes past a thousand ended copies stay reachable in real IndexedDB (review 2, finding 4)", () => {
  for (const ended of [999, 1000])
    test(`${ended} ended copies of the field before one held change: ${ended < 1000 ? "it is on the first page (control)" : "the first page says more may be kept, and 'Show more held changes' reaches it"}`, async ({
      context,
    }, info) => {
      const { page } = await setup(context, `/people/${P}`, [
        personP(P, "Ada"),
        fieldP(
          F,
          P,
          "Note",
          { kind: "text", text: "Original" },
          { version: 4, policy_version: 6 },
        ),
      ]);
      const context_ = `people-held:${P}:${F}`;
      const live = {
        form_context: context_,
        tab_instance_id: "zzzzzzzz-0000-4000-8000-000000000001",
        fields: {
          held: JSON.stringify({
            v: 2,
            rev: 0,
            queued: false,
            fieldId: F,
            personId: P,
            label: "Note",
            value: { kind: "text", text: "Kept" },
            sameKind: true,
            version: 4,
            expectedBase: 4,
            from: { version: 6, policy: HOME_VIEW },
            to: PRIVATE,
            attempt: null,
            failed: null,
            heldAt: "2026-10-22T09:00:00.000Z",
          }),
        },
        redacted: [],
        saved_at: "2026-10-22T09:00:00.000Z",
        capture_seq: 0,
        writer_gen: Number.MAX_SAFE_INTEGER,
        terminal: false,
        content_digest: "live-digest",
      };
      const rows = [
        ...Array.from({ length: ended }, (_, i) => ({
          ...live,
          tab_instance_id: `t${String(i).padStart(5, "0")}`,
          fields: {},
          terminal: true,
          content_digest: "ended",
        })),
        live,
      ];
      await page.evaluate(
        ({ account, rows }) =>
          window.__atlasData?.put(account, "form_recovery", rows),
        { account: ME, rows },
      );
      await navigateInApp(page, "/people");
      await navigateInApp(page, `/people/${P}`);
      const held = page.locator(`[data-held-field="${F}"]`);
      // Adapted (review 4): the seeded copy is of the v 2 shape, which is now LEGACY (shown and discardable, never sent): its row says so
      // instead of "Waiting to change who can see Note". What this case proves (it is reachable past the ended copies) is unchanged.
      const LEGACY =
        "A held change to who can see Note from an earlier version of Atlas is kept on this device.";
      if (ended < 1000) {
        await expect(held).toContainText(LEGACY);
      } else {
        await expect(page.locator("[data-held-page]")).toContainText(
          "More held changes may be kept on this device.",
        );
        await expect(held).toHaveCount(0);
        await page
          .getByRole("button", { name: "Show more held changes" })
          .click();
        await expect(held).toContainText(LEGACY);
      }
      // The ended copies are kept (they order late writes).
      const stored = (await page.evaluate(
        (account) => window.__atlasData?.rows(account, "form_recovery"),
        ME,
      )) as Array<{ terminal: boolean }>;
      expect(stored.filter((row) => row.terminal)).toHaveLength(ended);
      recordEvidence(info, "e-p24", { ended });
    });
});

/** The live (non-terminal) held copies of the account in real IndexedDB, decoded. */
const liveHolds = async (page: Page) =>
  (
    (await page.evaluate(
      (account) => window.__atlasData?.rows(account, "form_recovery"),
      ME,
    )) as Array<{ terminal: boolean; fields: { held?: string } }>
  )
    .filter((row) => !row.terminal)
    .map(
      (row) => JSON.parse(row.fields.held ?? "{}") as Record<string, unknown>,
    );

/** Waits until no page holds the field's lock (Web Locks): every run and save of the field's holds has finished its last write. */
const fieldSettled = (page: Page) =>
  page.evaluate(
    ({ account, field }) =>
      navigator.locks.request(
        `atlas-people-held:${account}:${field}`,
        async () => undefined,
      ),
    { account: ME, field: F },
  );

/** Holds "Only you" for the field offline from its open editor, with `text` typed. */
async function holdOffline(page: Page, text: string) {
  const dialog = page.getByRole("dialog", { name: "Edit Note" });
  await dialog.getByRole("textbox", { name: "Value" }).fill(text);
  await dialog.getByRole("radio", { name: "Only you", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("button", { name: "Hold as draft" }).click();
  return dialog;
}

const heldSetup = (context: Parameters<typeof setup>[0]) =>
  setup(
    context,
    `/people/${P}/fields/${F}`,
    [
      personP(P, "Ada"),
      fieldP(
        F,
        P,
        "Note",
        { kind: "text", text: "Original" },
        { version: 4, policy_version: 6 },
      ),
    ],
    { arrange: (s) => s.policies.set(F, { version: 6, policy: HOME_VIEW }) },
  );

test.describe("E-P25: leaving the page never discards a held change (review 3, finding 1)", () => {
  for (const leave of [true, false])
    test(`${leave ? "navigating to the list while its first policy read is held keeps the input in real IndexedDB; it is listed again" : "control: an explicit Discard at the same moment ends it"}`, async ({
      context,
    }, info) => {
      const { page, served } = await heldSetup(context);
      const dialog = page.getByRole("dialog", { name: "Edit Note" });
      await expect(
        dialog.getByRole("radio", { name: "Home · can view" }),
      ).toBeChecked();
      await connectivity(context, page, false);
      await holdOffline(page, "Retain this unsent input");
      await expect(dialog).toBeHidden();
      const row = page.locator(`[data-held-field="${F}"]`);
      await expect(row).toBeVisible();
      expect(await liveHolds(page)).toHaveLength(1);
      const held = gate();
      served.policyScript.push(() => ({
        status: 200,
        body: { version: 6, policy: HOME_VIEW },
        after: held.after,
      }));
      const before = served.log.length;
      await connectivity(context, page, true);
      await expect
        .poll(() => served.log.slice(before).filter(notSummary))
        .toEqual([`GET /policies/${F}`]);
      if (leave) {
        await navigateInApp(page, "/people");
        await expect(row).toHaveCount(0);
      } else await row.getByRole("button", { name: "Discard" }).click();
      held.open();
      // The run's last write is done once the field's lock is free (the run holds it until then).
      await fieldSettled(page);
      const after = await liveHolds(page);
      recordEvidence(info, "e-p25", { leave, after, log: served.log });
      expect(served.management).toEqual([]);
      expect(await draftsOf(page)).toEqual([]);
      if (!leave) {
        expect(after).toEqual([]);
        return;
      }
      expect(after).toHaveLength(1);
      // Adapted (review 4, finding 1): `queued: false` (no content admission) is not part of the v 4 copy any more; its content is handed
      // off in one commit with its draft, so a copy that is still live was not handed off (and no draft exists, asserted above).
      // Adapted again (review 12, R12.1): the copy is now v 5 and records the save its value was typed over; nothing was outstanding
      // here, so that binding is null (never omitted, never "unknown").
      expect(after[0]).toMatchObject({
        v: 5,
        predecessor: null,
        value: { kind: "text", text: "Retain this unsent input" },
        to: PRIVATE,
        retired: false,
      });
      // Offline again, back on the person: it is listed as it was held (with this page's authority it would run once online).
      await connectivity(context, page, false);
      await navigateInApp(page, `/people/${P}`);
      await expect(row).toContainText("Waiting to change who can see Note");
    });
});

test.describe("E-P26: one current hold per field, under the field's lock (review 3, finding 2)", () => {
  test("while another holder has the field's lock 'Hold as draft' writes nothing and keeps the edit; once it is free the new hold replaces the earlier one", async ({
    context,
  }, info) => {
    const { page } = await heldSetup(context);
    const dialog = page.getByRole("dialog", { name: "Edit Note" });
    await expect(
      dialog.getByRole("radio", { name: "Home · can view" }),
    ).toBeChecked();
    await connectivity(context, page, false);
    await holdOffline(page, "First");
    await expect(dialog).toBeHidden();
    expect((await liveHolds(page)).map((h) => [h.value, h.seq])).toEqual([
      [{ kind: "text", text: "First" }, 1],
    ]);
    // Another holder of the field's lock (as another page's run or save would be).
    await page.evaluate(
      ({ account, field }) => {
        const w = window as unknown as { __releaseField?: () => void };
        void navigator.locks.request(
          `atlas-people-held:${account}:${field}`,
          () =>
            new Promise<void>((resolve) => {
              w.__releaseField = resolve;
            }),
        );
      },
      { account: ME, field: F },
    );
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __releaseField?: () => void })
          .__releaseField === "function",
    );
    await navigateInApp(page, `/people/${P}/fields/${F}`);
    await expect(dialog).toBeVisible();
    await holdOffline(page, "Second");
    await expect(dialog).toContainText(
      "Another change to this field is being saved or sent. Try again in a moment.",
    );
    await expect(dialog.getByRole("textbox", { name: "Value" })).toHaveValue(
      "Second",
    );
    expect((await liveHolds(page)).map((h) => h.value)).toEqual([
      { kind: "text", text: "First" },
    ]);
    await page.evaluate(() =>
      (window as unknown as { __releaseField: () => void }).__releaseField(),
    );
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.getByRole("button", { name: "Hold as draft" }).click();
    await expect(dialog).toBeHidden();
    await fieldSettled(page);
    const after = await liveHolds(page);
    recordEvidence(info, "e-p26", { after });
    expect(after.map((h) => [h.value, h.seq])).toEqual([
      [{ kind: "text", text: "Second" }, 2],
    ]);
  });
});

test.describe("E-P27: an unresolved policy attempt outlives its discarded content (review 3, C3c)", () => {
  // Adapted (review 4, finding 4): "Check now" no longer ends the record or says the attempt was made; it says what the audience IS now and
  // keeps the record, and only "Discard" forgets it. Its intent (one owner-only read, nothing sent, the record survives the page) is kept.
  test("discarded after an uncertain replace_policy, the attempt is kept as a record that survives the page closing; 'Check now' reads once and keeps it (adapted, review 4)", async ({
    context,
  }, info) => {
    const { page, served } = await heldSetup(context);
    const dialog = page.getByRole("dialog", { name: "Edit Note" });
    await expect(
      dialog.getByRole("radio", { name: "Home · can view" }),
    ).toBeChecked();
    await connectivity(context, page, false);
    await holdOffline(page, "Confidential");
    await expect(dialog).toBeHidden();
    const row = page.locator(`[data-held-field="${F}"]`);
    served.policyScript.push(() => ({
      status: 200,
      body: { version: 6, policy: HOME_VIEW },
    }));
    served.managementScript.push("abort");
    await connectivity(context, page, true);
    await expect.poll(() => served.management.length).toBe(1);
    await expect(row.getByRole("button", { name: "Try again" })).toBeVisible();
    await row.getByRole("button", { name: "Discard" }).click();
    await expect(row).toContainText(
      "An earlier change to who can see Note may already have been made.",
    );
    await fieldSettled(page);
    const kept = await liveHolds(page);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      retired: true,
      value: { kind: "text", text: "" },
      attempt: { key: served.management[0]?.key },
    });
    // The page goes; a new page of the same profile finds the record in real IndexedDB, and asks nothing by itself.
    await page.close();
    served.policyScript.push(() => ({
      status: 200,
      body: { version: 7, policy: PRIVATE },
    }));
    const since = served.log.length;
    const reopened = await bootAt(context, `/people/${P}`);
    // The harness's handle on the reopened page's account database (as E-P15 opens it); nothing is queued here.
    await startOutbox(reopened);
    const record = reopened.locator(`[data-held-field="${F}"]`);
    await expect(record).toContainText(
      "An earlier change to who can see Note may already have been made.",
    );
    expect(
      served.log.slice(since).filter((line) => line === `GET /policies/${F}`),
    ).toEqual([]);
    await record.getByRole("button", { name: "Check now" }).click();
    await expect(record).toContainText(
      "Checked: who can see Note is now what this asked for. Whether this change made it can't be told from here.",
    );
    await expect(record).toHaveCount(1);
    expect(
      served.log.slice(since).filter((line) => line === `GET /policies/${F}`),
    ).toHaveLength(1);
    expect(served.management).toHaveLength(1);
    expect(await liveHolds(reopened)).toMatchObject([
      { retired: true, attempt: { key: served.management[0]?.key } },
    ]);
    // Only the person's Discard forgets it.
    await record.getByRole("button", { name: "Discard" }).click();
    await expect(record).toHaveCount(0);
    expect(await liveHolds(reopened)).toEqual([]);
    expect(served.management).toHaveLength(1);
    recordEvidence(info, "e-p27", { log: served.log });
  });
});

/** The tombstone an ended hold keeps in real IndexedDB (its `held_end`), by hold id. */
const endedHolds = async (page: Page) =>
  (
    (await page.evaluate(
      (account) => window.__atlasData?.rows(account, "form_recovery"),
      ME,
    )) as Array<{
      terminal: boolean;
      tab_instance_id: string;
      fields: { held_end?: string };
    }>
  )
    .filter((row) => row.terminal && row.fields.held_end !== undefined)
    .map((row) => ({
      holdId: row.tab_instance_id,
      ...(JSON.parse(row.fields.held_end ?? "{}") as {
        seq?: number | null;
        cause?: string | null;
        localId?: string | null;
      }),
    }));

/** The next real IndexedDB transaction that writes `match`'s row into `form_recovery` is ABORTED (once): nothing it wrote is kept. */
const abortNextFormWrite = (page: Page, match: "transferred" | "replaced") =>
  page.evaluate((cause) => {
    const put = IDBObjectStore.prototype.put;
    const w = window as unknown as { __aborted?: number };
    w.__aborted = 0;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: { terminal?: boolean; fields?: { held_end?: string } },
      ...rest: unknown[]
    ) {
      if (
        this.name === "form_recovery" &&
        value?.terminal === true &&
        String(value.fields?.held_end ?? "").includes(`"cause":"${cause}"`)
      ) {
        IDBObjectStore.prototype.put = put;
        w.__aborted = 1;
        this.transaction.abort();
        throw new DOMException("injected: aborted", "AbortError");
      }
      return (put as (...a: unknown[]) => IDBRequest).call(
        this,
        value,
        ...rest,
      );
    } as typeof put;
  }, match);

test.describe("E-P28: a held change's content is handed off in ONE transaction, never again after Sync's decision (review 4, finding 1)", () => {
  for (const discard of [true, false])
    test(`${discard ? "the draft discarded in Sync is never recreated: the person's page shows no hold to send again" : "control: the draft kept stays single"}`, async ({
      context,
    }, info) => {
      const { page, served } = await heldSetup(context);
      const dialog = page.getByRole("dialog", { name: "Edit Note" });
      await expect(
        dialog.getByRole("radio", { name: "Home · can view" }),
      ).toBeChecked();
      await connectivity(context, page, false);
      await holdOffline(page, "Handed off once");
      await expect(dialog).toBeHidden();
      const row = page.locator(`[data-held-field="${F}"]`);
      served.policyScript.push(
        () => ({ status: 200, body: { version: 6, policy: HOME_VIEW } }),
        () => ({ status: 200, body: { version: 7, policy: PRIVATE } }),
      );
      await connectivity(context, page, true);
      await expect(row).toHaveCount(0);
      await fieldSettled(page);
      const drafts = await draftsOf(page);
      expect(drafts.map((d) => d.local_id)).toHaveLength(1);
      const localId = drafts[0]?.local_id as string;
      // The copy ended in the same commit, and keeps for ever that it was handed off under that local id.
      expect(await endedHolds(page)).toMatchObject([
        { holdId: localId, cause: "transferred", localId },
      ]);
      expect(await liveHolds(page)).toEqual([]);
      if (discard) {
        await startOutbox(page, ME, { start: false });
        expect(
          await page.evaluate(
            (id) => window.__atlasData?.discardDraft(id),
            localId,
          ),
        ).toMatchObject({ kind: "discarded" });
        expect(await draftsOf(page)).toEqual([]);
      }
      // The person's page again (the same identity): nothing is offered to send again, and nothing is queued again.
      await navigateInApp(page, "/people");
      await navigateInApp(page, `/people/${P}`);
      await expect(page.getByRole("heading", { name: "Ada" })).toBeVisible();
      await fieldSettled(page);
      await expect(row).toHaveCount(0);
      const after = await draftsOf(page);
      recordEvidence(info, "e-p28", { discard, drafts, after });
      expect(after).toHaveLength(discard ? 0 : 1);
      expect(served.management).toHaveLength(1);
      expect(await endedHolds(page)).toHaveLength(1);
    });

  test("a hand-off whose transaction is aborted keeps the hold and queues nothing; Try again then hands it off once", async ({
    context,
  }, info) => {
    const { page, served } = await heldSetup(context);
    const dialog = page.getByRole("dialog", { name: "Edit Note" });
    await expect(
      dialog.getByRole("radio", { name: "Home · can view" }),
    ).toBeChecked();
    await connectivity(context, page, false);
    await holdOffline(page, "Kept through an abort");
    await expect(dialog).toBeHidden();
    const row = page.locator(`[data-held-field="${F}"]`);
    await abortNextFormWrite(page, "transferred");
    served.policyScript.push(
      () => ({ status: 200, body: { version: 6, policy: HOME_VIEW } }),
      () => ({ status: 200, body: { version: 7, policy: PRIVATE } }),
    );
    await connectivity(context, page, true);
    await expect(row).toContainText("Couldn't save on this device. Try again.");
    await fieldSettled(page);
    expect(
      await page.evaluate(
        () => (window as unknown as { __aborted?: number }).__aborted,
      ),
    ).toBe(1);
    expect(await draftsOf(page)).toEqual([]);
    expect(await liveHolds(page)).toMatchObject([
      { value: { kind: "text", text: "Kept through an abort" } },
    ]);
    await row.getByRole("button", { name: "Try again" }).click();
    await expect(row).toHaveCount(0);
    await fieldSettled(page);
    const drafts = await draftsOf(page);
    recordEvidence(info, "e-p28-abort", { drafts, log: served.log });
    expect(drafts).toHaveLength(1);
    expect(await endedHolds(page)).toMatchObject([{ cause: "transferred" }]);
    expect(served.management).toHaveLength(1);
  });
});

test.describe("E-P29: the field's head never goes back (review 4, finding 2)", () => {
  for (const discardWinner of [true, false])
    test(`an earlier hold whose retirement was aborted ${discardWinner ? "never runs after the newer hold is discarded" : "never runs while the newer hold is kept (control)"}`, async ({
      context,
    }, info) => {
      const { page, served } = await heldSetup(context);
      const dialog = page.getByRole("dialog", { name: "Edit Note" });
      await expect(
        dialog.getByRole("radio", { name: "Home · can view" }),
      ).toBeChecked();
      await connectivity(context, page, false);
      await holdOffline(page, "First");
      await expect(dialog).toBeHidden();
      // The replacement's cleanup of the first hold is aborted: the first stays live (generation 1), the second is current (2).
      await abortNextFormWrite(page, "replaced");
      await navigateInApp(page, `/people/${P}/fields/${F}`);
      await expect(dialog).toBeVisible();
      await holdOffline(page, "Second");
      await expect(dialog).toBeHidden();
      await fieldSettled(page);
      expect(
        (await liveHolds(page)).map((h) => [h.value, h.seq]).sort(),
      ).toEqual(
        [
          [{ kind: "text", text: "First" }, 1],
          [{ kind: "text", text: "Second" }, 2],
        ].sort(),
      );
      const second = page.locator(`[data-held-field="${F}"]`, {
        hasText: "Second",
      });
      if (discardWinner) {
        const rows = page.locator(`[data-held-field="${F}"]`);
        await expect(rows).toHaveCount(2);
        // The newer hold is discarded (the person's choice, before going online).
        const ids = await liveHolds(page);
        expect(ids).toHaveLength(2);
        await rows.nth(1).getByRole("button", { name: "Discard" }).click();
        await expect(rows).toHaveCount(1);
      }
      served.policyScript.push(
        () => ({ status: 200, body: { version: 6, policy: HOME_VIEW } }),
        () => ({ status: 200, body: { version: 7, policy: PRIVATE } }),
      );
      await connectivity(context, page, true);
      await expect
        .poll(async () => (await liveHolds(page)).length, { timeout: 10_000 })
        .toBe(0);
      await fieldSettled(page);
      const drafts = await draftsOf(page);
      recordEvidence(info, "e-p29", {
        discardWinner,
        drafts,
        management: served.management,
        ended: await endedHolds(page),
      });
      // The first hold never ran: if anything was sent, it was the second's (only while it was kept), and no draft is the first's.
      const ended = await endedHolds(page);
      const first = ended.find((h) => h.seq === 1);
      expect(first?.cause).toBe("replaced");
      if (discardWinner) {
        expect(served.management).toEqual([]);
        expect(drafts).toEqual([]);
      } else {
        expect(served.management).toHaveLength(1);
        expect(drafts).toHaveLength(1);
        expect(drafts[0]?.local_id).toBe(
          ended.find((h) => h.seq === 2)?.holdId,
        );
        await expect(second).toHaveCount(0);
      }
    });
});

test.describe("E-P30: a run that stops lets the next authorised hold run (review 5, finding 1)", () => {
  const Q2 = "55555555-5555-4555-8555-555555555556";
  const G = "66666666-6666-4666-8666-666666666667";
  for (const leaveEarly of [true, false])
    test(`${leaveEarly ? "leaving the person while A's run waits for its policy answer suspends A, and B on the next person then runs" : "control: A completes before leaving, then B runs"}`, async ({
      context,
    }, info) => {
      const { page, served } = await setup(
        context,
        `/people/${Q2}/fields/${G}`,
        [
          personP(P, "Ada"),
          personP(Q2, "Bea"),
          fieldP(
            F,
            P,
            "Note A",
            { kind: "text", text: "Original A" },
            { version: 4, policy_version: 6 },
          ),
          fieldP(
            G,
            Q2,
            "Note B",
            { kind: "text", text: "Original B" },
            { version: 4, policy_version: 6 },
          ),
        ],
        {
          arrange: (s) => {
            s.policies.set(F, { version: 6, policy: HOME_VIEW });
            s.policies.set(G, { version: 6, policy: HOME_VIEW });
          },
        },
      );
      const hold = async (label: string, text: string) => {
        const d = page.getByRole("dialog", { name: `Edit ${label}` });
        await expect(
          d.getByRole("radio", { name: "Home · can view" }),
        ).toBeChecked();
        await connectivity(context, page, false);
        await d.getByRole("textbox", { name: "Value" }).fill(text);
        await d.getByRole("radio", { name: "Only you", exact: true }).click();
        await d.getByRole("button", { name: "Save", exact: true }).click();
        await d.getByRole("button", { name: "Hold as draft" }).click();
        await expect(d).toBeHidden();
      };
      await hold("Note B", "B text");
      // A's audience is read online before its offline hold is made (B's row is not shown on A's person: it cannot run there).
      await navigateInApp(page, `/people/${P}/fields/${F}`);
      await connectivity(context, page, true);
      await hold("Note A", "A text");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      served.policyScript.push((id) => {
        expect(id).toBe(F);
        return {
          status: 200,
          body: { version: 6, policy: HOME_VIEW },
          after: gate,
        };
      });
      for (let n = 0; n < 6; n += 1)
        served.policyScript.push((id) => ({
          status: 200,
          body: served.management.some((m) =>
            JSON.stringify(m.body).includes(id),
          )
            ? { version: 7, policy: PRIVATE }
            : { version: 6, policy: HOME_VIEW },
        }));
      const start = served.log.length;
      await connectivity(context, page, true);
      // A's run is positively under way: its policy read was asked.
      await expect
        .poll(() => served.log.slice(start).includes(`GET /policies/${F}`))
        .toBe(true);
      if (!leaveEarly) {
        release();
        await expect.poll(() => draftsOf(page)).toHaveLength(1);
      }
      await navigateInApp(page, `/people/${Q2}`);
      const row = page.locator(`[data-held-field="${G}"]`);
      if (leaveEarly) {
        await expect(row).toBeVisible();
        expect(await draftsOf(page)).toEqual([]);
        release();
        // A's run has let go of A's field lock: it has ended (suspended) and nothing else will make the page render.
        await page.evaluate(
          async ({ me, f }) =>
            navigator.locks.request(
              `atlas-people-held:${me}:${f}`,
              async () => {},
            ),
          { me: ME, f: F },
        );
      }
      // The reviewer's five-second observation, unchanged.
      await expect
        .poll(async () => JSON.stringify(await draftsOf(page)), {
          timeout: 5000,
        })
        .toContain(G);
      const drafts = await draftsOf(page);
      recordEvidence(info, "e-p30", {
        leaveEarly,
        drafts,
        management: served.management,
        log: served.log,
      });
      const bodies = JSON.stringify(drafts);
      expect(bodies).toContain("B text");
      if (leaveEarly) {
        // A was only stopped: nothing of it queued, its input kept as held.
        expect(bodies).not.toContain("A text");
        expect(drafts).toHaveLength(1);
      }
    });
});

test.describe("E-P31: an archived field's new parent is not complete until it is read (review 5, finding 2)", () => {
  const X = "12121212-1212-4121-8121-121212121212";
  for (const reparent of [true, false])
    test(`${reparent ? "a synced projection moves the field to a visible person: 'Nothing archived' is withdrawn before the field is listed, and never shown with it" : "control: a synced change of the field under the same absent person keeps 'Nothing archived'"}`, async ({
      context,
    }, info) => {
      const { page, net } = await setup(context, "/settings/archived", [
        fieldP(
          F,
          X,
          "Old phone",
          { kind: "text", text: "07700 900461" },
          { archived: true },
        ),
      ]);
      const empty = page.locator('[data-archived-state="empty"]');
      await expect(empty).toBeVisible();
      // Every DOM change from here on, as the ledger showed it at that moment (MutationObserver: no paint or timer is involved).
      await page.evaluate(() => {
        const seen: Array<{ empty: boolean; row: boolean }> = [];
        (window as unknown as { __ep31: typeof seen }).__ep31 = seen;
        new MutationObserver(() => {
          seen.push({
            empty:
              document.querySelector('[data-archived-state="empty"]') !== null,
            row: (
              document.querySelector("[data-archived-items]")?.textContent ?? ""
            ).includes("Old phone · Bea"),
          });
        }).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      });
      await publish(
        page,
        net,
        reparent
          ? [
              personP(Q, "Bea"),
              fieldP(
                F,
                Q,
                "Old phone",
                { kind: "text", text: "07700 900461" },
                { archived: true, version: 2 },
              ),
            ]
          : [
              fieldP(
                F,
                X,
                "Old phone",
                { kind: "text", text: "07700 900462" },
                { archived: true, version: 2 },
              ),
            ],
      );
      if (reparent)
        await expect(page.locator(`[data-archived-row="${F}"]`)).toContainText(
          "Old phone · Bea",
        );
      else
        await expect
          .poll(async () => {
            const rows = (await page.evaluate(
              (a) => window.__atlasData?.rows(a, "cache"),
              ME,
            )) as Array<{ id: string; version: number }>;
            return rows.find((row) => row.id === F)?.version;
          })
          .toBe(2);
      const seen = (await page.evaluate(
        () => (window as unknown as { __ep31: unknown }).__ep31,
      )) as Array<{ empty: boolean; row: boolean }>;
      recordEvidence(info, "e-p31", { reparent, seen });
      if (reparent) {
        expect(seen.filter((s) => s.empty && s.row)).toEqual([]);
        const withdrawn = seen.findIndex((s) => !s.empty);
        const listed = seen.findIndex((s) => s.row);
        expect(withdrawn).toBeGreaterThanOrEqual(0);
        // Adapted in revision 17 (review 16, R16.1): the field and its new person are now ONE answer of the ledger's page read, so
        // "Nothing archived" is withdrawn in the same state that lists the field (campaign 36: [empty] -> [row] in all three engines), not
        // in an earlier one while a separate person read loads (the original asserted `listed > withdrawn` and an intermediate state).
        // Kept: never shown together (above), and never listed before it is withdrawn.
        expect(listed).toBeGreaterThanOrEqual(withdrawn);
        await expect(empty).toHaveCount(0);
      } else {
        expect(seen.every((s) => s.empty && !s.row)).toBe(true);
        await expect(empty).toBeVisible();
      }
    });
});

test.describe("E-P32: a save's completion ends only the editor session it was made in (review 6, finding 1)", () => {
  // Adapted from the reviewer's qualified Chromium pair (`review-6/editor-lifetime-qualified.probe.spec.ts`): the same schedule, all engines.
  for (const completedFirst of [false, true])
    test(`a shared create held at /task-access-commands, ${completedFirst ? "control: answered before 'Add a field' is opened again" : "Cancel and a new 'Add a field' typed in before it answers: the new editor and its input stay"}`, async ({
      context,
    }, info) => {
      const { page } = await setup(context, `/people/${P}/fields/new`, [
        personP(P, "Ada"),
      ]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let sent = 0;
      await page.route("**/task-access-commands", async (route) => {
        sent += 1;
        await gate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ revision: 10 }),
        });
      });
      const d = page.getByRole("dialog", { name: "Add a field" });
      const name = d.getByRole("textbox", { name: "Name", exact: true });
      const value = d.getByRole("textbox", { name: "Value", exact: true });
      await name.fill("First");
      await value.fill("First saved text");
      await d.getByRole("radio", { name: "Home · can view" }).click();
      await d.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => sent).toBe(1);
      if (completedFirst) {
        release();
        await expect(d).toBeHidden();
      } else {
        await d.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(d).toBeHidden();
      }
      await navigateInApp(page, `/people/${P}/fields/new`);
      await name.fill("Second");
      await value.fill("Second unsaved text");
      if (!completedFirst) {
        release();
        // The first save's answer arrived and was told.
        await expect(page.locator('[aria-live="polite"]')).toContainText(
          "Saved. It'll appear here once it has synced.",
        );
      }
      recordEvidence(info, "e-p32", {
        completedFirst,
        sent,
        url: page.url(),
        dialogs: await d.count(),
      });
      expect(sent).toBe(1);
      await expect(d).toBeVisible();
      await expect(value).toHaveValue("Second unsaved text");
      expect(new URL(page.url()).pathname).toBe(`/people/${P}/fields/new`);
    });
});

test.describe("E-P33: a press is not lost when the linkage answers during it (review 6, finding 3)", () => {
  // The reviewer's straddle schedule (`review-6/linkage-pointer.probe.spec.ts`, revision 5's E-P3 diagnostic): the person read is held,
  // the pointer goes down on "Add a field", the answer is released and SHOWN, then the pointer comes up. "unlinked" makes the header shorter,
  // "other" (two disabled actions with their reasons) changes it the other way; the control clicks after the answer.
  for (const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ])
    test.describe(`${viewport.name} (${viewport.width} px)`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
      });
      for (const answer of ["unlinked", "other", "control"] as const)
        test(`${answer === "control" ? "control: the answer shown before the click" : `pressed before and released after the answer (${answer}) is shown`}: the editor opens`, async ({
          context,
        }, info) => {
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let held = 0;
          context.on("page", (page) => {
            void page.route(
              `**/api/experimental/v1/people/${P}`,
              async (route) => {
                if (route.request().method() === "GET") {
                  held += 1;
                  await gate;
                }
                await route.fallback();
              },
            );
          });
          const { page } = await setup(
            context,
            `/people/${P}`,
            [personP(P, "Ada")],
            {
              linked: { [P]: answer === "other" ? MO : null },
            },
          );
          await expect.poll(() => held).toBeGreaterThan(0);
          await expect(
            detail(page).locator('[data-linkage="unknown"]'),
          ).toBeVisible();
          const link = detail(page).getByRole("link", { name: "Add a field" });
          await link.scrollIntoViewIfNeeded();
          const before = await link.boundingBox();
          if (before === null) throw new Error("no link");
          let pressed: { y: number } | null = null;
          if (answer === "control") {
            release();
            await linkageAnswered(page);
            await link.click();
          } else {
            await page.mouse.move(
              before.x + before.width / 2,
              before.y + before.height / 2,
            );
            await page.mouse.down();
            release();
            await expect(
              detail(page).locator(`[data-linkage="${answer}"]`),
            ).toBeVisible();
            pressed = await link.boundingBox();
            await page.mouse.up();
          }
          recordEvidence(info, "e-p33", {
            viewport,
            answer,
            held,
            before,
            pressed,
          });
          await expect(
            page
              .getByRole("dialog", { name: "Add a field" })
              .getByRole("textbox", { name: "Name", exact: true }),
          ).toBeVisible();
          // While pressed, with the answer shown, the action stayed where the press began.
          if (answer !== "control") expect(pressed?.y).toBe(before.y);
        });
    });
});

/**
 * E-P34 (review 7, finding 3): a press on a FIELD's action is not lost when the field's audience and reach answer during it. In the
 * narrow layout the audience and reach are stacked ABOVE Edit and Archive inside the same row, so a fixed row height alone does not keep
 * them under the pointer (the reviewer's 22 px move, `review-7/field-pointer-upper.probe.spec.ts`). Each case holds the field-audiences
 * read, observes it and the unknown audience, presses a point INSIDE the action (centre, upper and lower quarter, just inside the top,
 * bottom and right edges), releases the answer, observes the audience and reach SHOWN, then releases the pointer where it went down. The
 * action must stay where it was (x, y, width, height), be the element under the pointer, and act exactly once. Each point's control
 * presses the same point after the answer is shown. Phone, tablet and desktop.
 */
test.describe("E-P34: a field action keeps its place while the field's audience answers during a press (review 7, finding 3)", () => {
  // Points INSIDE the action's hit area. Edge points are taken at the middle of an edge, 2 px in: a point 2 px from a corner is outside
  // the control's 8 px rounded corner and is not on the action at all (revision 7's first campaign: its point-matched control missed too).
  const points = {
    centre: (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }),
    "upper quarter": (b: Box) => ({
      x: b.x + b.width / 2,
      y: b.y + b.height / 4,
    }),
    "lower quarter": (b: Box) => ({
      x: b.x + b.width / 2,
      y: b.y + (3 * b.height) / 4,
    }),
    "top edge": (b: Box) => ({ x: b.x + b.width / 2, y: b.y + 2 }),
    "bottom edge": (b: Box) => ({
      x: b.x + b.width / 2,
      y: b.y + b.height - 2,
    }),
    "right edge": (b: Box) => ({ x: b.x + b.width - 2, y: b.y + b.height / 2 }),
  } as const;
  for (const viewport of [
    { name: "phone", width: 390, height: 844 },
    { name: "tablet", width: 820, height: 1180 },
    { name: "desktop", width: 1280, height: 900 },
  ])
    test.describe(`${viewport.name} (${viewport.width} px)`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
      });
      for (const action of ["edit", "archive", "audience"] as const)
        for (const point of Object.keys(points) as (keyof typeof points)[])
          for (const control of [false, true])
            test(`${action} at the ${point}: ${control ? "control, the answer shown before the press" : "pressed before and released after the answer is shown"}`, async ({
              context,
            }, info) => {
              let release!: () => void;
              const gate = new Promise<void>((resolve) => {
                release = resolve;
              });
              let held = 0;
              context.on("page", (page) => {
                void page.route(
                  `**/api/experimental/v1/people/${P}/field-audiences*`,
                  async (route) => {
                    held += 1;
                    await gate;
                    await route.fallback();
                  },
                );
              });
              const { page } = await setup(
                context,
                `/people/${P}`,
                [
                  personP(P, "Ada"),
                  fieldP(F, P, "Note", { kind: "text", text: "Kept value" }),
                ],
                {
                  arrange: (served) => {
                    served.policies.set(F, { version: 1, policy: PRIVATE });
                    served.fieldAudiences.set(P, [
                      {
                        id: F,
                        version: 1,
                        policy_version: 1,
                        archived: false,
                        owner_is_you: true,
                        your_access: "owner",
                        audience: OWNER_ONLY_AUDIENCE,
                        effective: {
                          disclosure: "complete",
                          account_count: 0,
                          limited_count: 0,
                        },
                      },
                    ]);
                  },
                },
              );
              const row = page.locator(`[data-field-row="${F}"]`);
              await expect.poll(() => held).toBeGreaterThan(0);
              // Harness precondition: the header's own read has answered (E-P33 is that schedule; this one is the field's).
              await linkageAnswered(page);
              await expect(
                row.locator('[data-field-audience="unknown"]'),
              ).toBeVisible();
              const target =
                action === "edit"
                  ? row.getByRole("link", { name: "Edit", exact: true })
                  : action === "archive"
                    ? row.locator('[data-people-action="archive-field"]')
                    : row.locator('[data-people-action="field-audience"]');
              await target.scrollIntoViewIfNeeded();
              const before = await target.boundingBox();
              if (before === null) throw new Error("no target");
              let pressed: Box | null = null;
              let hit: boolean | null = null;
              // The control presses the same point of the action as laid out AFTER the answer.
              if (control) {
                release();
                await expect(row.locator("[data-field-reach]")).toBeVisible();
              }
              const from = control ? await target.boundingBox() : before;
              if (from === null) throw new Error("no target");
              const at = points[point](from);
              await page.mouse.move(at.x, at.y);
              await page.mouse.down();
              if (!control) release();
              await expect(
                row.locator('[data-field-audience="complete"]'),
              ).toBeVisible();
              await expect(row.locator("[data-field-reach]")).toBeVisible();
              pressed = await target.boundingBox();
              hit = await target.evaluate((element, { x, y }) => {
                const under = document.elementFromPoint(x, y);
                return under !== null && element.contains(under);
              }, at);
              await page.mouse.up();
              recordEvidence(info, "e-p34", {
                viewport,
                action,
                point,
                control,
                held,
                before,
                from,
                pressed,
                hit,
              });
              if (action === "edit")
                await expect(
                  page.getByRole("dialog", { name: "Edit Note" }),
                ).toBeVisible();
              else if (action === "audience")
                await expect(
                  page.getByRole("dialog", { name: "Sharing — Note" }),
                ).toBeVisible();
              else
                await expect
                  .poll(
                    async () =>
                      (await draftsOf(page)).filter(
                        (draft) =>
                          draft.kind === "archive" &&
                          (draft.target_resource_ids as string[]).includes(F),
                      ).length,
                  )
                  .toBe(1);
              // While pressed, with the answer shown, the action stayed where the press began and was what the pointer was over.
              expect(pressed).toEqual(from);
              expect(hit).toBe(true);
            });
    });
});

/**
 * E-P35 (review 7, finding 3; the assessment's representative controls): the same for an action INSIDE the fixed header (the person's
 * Archive, while the linkage answers) and for a People list row below rows that grow when the list's summaries answer.
 */
test.describe("E-P35: a header action and a list row keep their place through an answer during a press (review 7, finding 3)", () => {
  for (const viewport of [
    { name: "phone", width: 390, height: 844 },
    { name: "desktop", width: 1280, height: 900 },
  ])
    test.describe(`${viewport.name} (${viewport.width} px)`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
      });
      for (const answer of ["other", "control"] as const)
        test(`the person's Archive: ${answer === "control" ? "control, the linkage shown before the click" : "pressed before and released after the linkage (other) is shown"}`, async ({
          context,
        }, info) => {
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let held = 0;
          context.on("page", (page) => {
            void page.route(
              `**/api/experimental/v1/people/${P}`,
              async (route) => {
                if (route.request().method() === "GET") {
                  held += 1;
                  await gate;
                }
                await route.fallback();
              },
            );
          });
          const { page } = await setup(
            context,
            `/people/${P}`,
            [personP(P, "Ada")],
            { linked: { [P]: MO } },
          );
          await expect.poll(() => held).toBeGreaterThan(0);
          await expect(
            detail(page).locator('[data-linkage="unknown"]'),
          ).toBeVisible();
          const target = detail(page).locator(
            '[data-people-action="archive-person"]',
          );
          await target.scrollIntoViewIfNeeded();
          const before = await target.boundingBox();
          if (before === null) throw new Error("no target");
          let pressed: Box | null = null;
          if (answer === "control") {
            release();
            await linkageAnswered(page);
            await target.click();
          } else {
            await page.mouse.move(
              before.x + before.width / 2,
              before.y + before.height / 4,
            );
            await page.mouse.down();
            release();
            await expect(
              detail(page).locator('[data-linkage="other"]'),
            ).toBeVisible();
            pressed = await target.boundingBox();
            await page.mouse.up();
          }
          recordEvidence(info, "e-p35-header", {
            viewport,
            answer,
            held,
            before,
            pressed,
          });
          await expect
            .poll(
              async () =>
                (await draftsOf(page)).filter(
                  (draft) =>
                    draft.kind === "archive" &&
                    (draft.target_resource_ids as string[]).includes(P),
                ).length,
            )
            .toBe(1);
          if (answer !== "control") expect(pressed).toEqual(before);
        });

      for (const answer of ["summaries", "control"] as const)
        test(`a People row: ${answer === "control" ? "control, the summaries shown before the click" : "pressed before and released after the summaries are shown"}`, async ({
          context,
        }, info) => {
          const people = ["Ada", "Ben", "Cleo", "Dan"].map((name, i) =>
            personP(`55555555-5555-4555-8555-00000000000${i + 1}`, name),
          );
          const pressedOn = people[2] as (typeof people)[number];
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const { page, served } = await setup(context, "/people", people, {
            arrange: (s) => {
              // Every summary read waits for the gate (a read made twice, or again on an invalidation, never answers early).
              for (let n = 0; n < 20; n += 1)
                s.summaryScript.push(async () => {
                  await gate;
                });
            },
          });
          const row = page.locator(`[data-person-row="${pressedOn.id}"]`);
          await expect(row).toBeVisible();
          await expect
            .poll(() =>
              served.log.some((line) =>
                line.startsWith("GET /people/summaries"),
              ),
            )
            .toBe(true);
          await expect(page.locator("[data-person-linkage]")).toHaveCount(0);
          const before = await row.boundingBox();
          if (before === null) throw new Error("no row");
          let pressed: Box | null = null;
          if (answer === "control") {
            release();
            await expect(row.locator("[data-person-linkage]")).toBeVisible();
            await row.click();
          } else {
            await page.mouse.move(
              before.x + before.width / 2,
              before.y + before.height / 4,
            );
            await page.mouse.down();
            release();
            await expect(
              page
                .locator(`[data-person-row="${people[0]?.id}"]`)
                .locator("[data-person-linkage]"),
            ).toBeVisible();
            pressed = await row.boundingBox();
            await page.mouse.up();
          }
          recordEvidence(info, "e-p35-row", {
            viewport,
            answer,
            before,
            pressed,
          });
          await expect(
            page.locator(`[data-person-detail="${pressedOn.id}"]`),
          ).toBeVisible();
          if (answer !== "control") expect(pressed).toEqual(before);
        });
    });
});

/**
 * The next real IndexedDB reads of the cache row `ids` FAIL (an `IDBObjectStore.get` that throws, as a read the engine refuses), until
 * `readsOfCacheRows(page, [])`; `window.__ep36Faults` counts the reads it refused, so a case knows the fault was reached.
 */
const readsOfCacheRows = (page: Page, ids: string[]) =>
  page.evaluate((failing) => {
    const w = window as unknown as {
      __ep36Get?: typeof IDBObjectStore.prototype.get;
      __ep36Faults?: number;
    };
    if (w.__ep36Get === undefined) w.__ep36Get = IDBObjectStore.prototype.get;
    const get = w.__ep36Get;
    w.__ep36Faults = 0;
    IDBObjectStore.prototype.get =
      failing.length === 0
        ? get
        : (function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
            if (this.name === "cache" && failing.includes(String(key))) {
              w.__ep36Faults = (w.__ep36Faults ?? 0) + 1;
              throw new DOMException("injected: read refused", "UnknownError");
            }
            return get.call(this, key);
          } as typeof get);
  }, ids);
/**
 * The next real IndexedDB reads of this device's unsent changes by status (the `drafts` index `[status+created_seq]`, as the editor's chain
 * reads them) FAIL until called again with `false`; `window.__ep36ChainFaults` counts them.
 */
const readsOfUnsentChanges = (page: Page, failing: boolean) =>
  page.evaluate((on) => {
    const w = window as unknown as {
      __ep36Index?: {
        getAll: typeof IDBIndex.prototype.getAll;
        openCursor: typeof IDBIndex.prototype.openCursor;
      };
      __ep36ChainFaults?: number;
    };
    if (w.__ep36Index === undefined)
      w.__ep36Index = {
        getAll: IDBIndex.prototype.getAll,
        openCursor: IDBIndex.prototype.openCursor,
      };
    const original = w.__ep36Index;
    w.__ep36ChainFaults = 0;
    const refuses = (index: IDBIndex) =>
      on &&
      index.objectStore.name === "drafts" &&
      index.name === "[status+created_seq]";
    IDBIndex.prototype.getAll = function (this: IDBIndex, ...args: never[]) {
      if (refuses(this)) {
        w.__ep36ChainFaults = (w.__ep36ChainFaults ?? 0) + 1;
        throw new DOMException("injected: read refused", "UnknownError");
      }
      return (original.getAll as (...a: never[]) => IDBRequest).apply(
        this,
        args,
      );
    } as typeof original.getAll;
    IDBIndex.prototype.openCursor = function (
      this: IDBIndex,
      ...args: never[]
    ) {
      if (refuses(this)) {
        w.__ep36ChainFaults = (w.__ep36ChainFaults ?? 0) + 1;
        throw new DOMException("injected: read refused", "UnknownError");
      }
      return (
        original.openCursor as (
          ...a: never[]
        ) => IDBRequest<IDBCursorWithValue | null>
      ).apply(this, args);
    } as typeof original.openCursor;
  }, failing);

const faultsReached = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __ep36Faults?: number }).__ep36Faults ?? 0,
  );

test.describe("E-P36: the field editor's target and its failed reads (review 9, findings 1 and 2)", () => {
  const G = "68686868-6868-4686-8686-686868686868";
  const resources = () => [
    personP(P, "Ada"),
    fieldP(F, P, "First", { kind: "text", text: "First saved" }),
    fieldP(G, P, "Second", { kind: "text", text: "Second saved" }),
  ];
  const field = (id: string) => `/people/${P}/fields/${id}`;
  // Both fields' audiences are served (an unserved policy read is a 403, and that 403 remounts the protected tree while the value is
  // typed: campaign 26 lost a fill to it in Firefox, revision-9/ep36-diag-firefox-2.log).
  const policies = {
    arrange: (s: { policies: Map<string, unknown> }) => {
      s.policies.set(F, { version: 1, policy: PRIVATE });
      s.policies.set(G, { version: 1, policy: PRIVATE });
    },
  };
  /** Types `text` into the field's editor, then leaves it by navigation (its input is kept, not discarded). */
  async function keep(page: Page, id: string, name: string, text: string) {
    await navigateInApp(page, field(id));
    const d = page.getByRole("dialog", { name: `Edit ${name}` });
    // The audience has answered (nothing more re-renders the editor while it is typed in).
    await expect(d.getByRole("radio", { name: "Only you" })).toBeChecked();
    const box = d.getByRole("textbox", { name: "Value", exact: true });
    await box.fill(text);
    await expect(box).toHaveValue(text);
    await navigateInApp(page, `/people/${P}`);
    await expect(d).toBeHidden();
  }
  async function reopened(page: Page, id: string, name: string) {
    await navigateInApp(page, field(id));
    const d = page.getByRole("dialog", { name: `Edit ${name}` });
    await expect(d).toBeVisible();
    return d.getByRole("textbox", { name: "Value", exact: true });
  }
  const failed = (page: Page) =>
    page.locator('[data-people-state="editor-read-failed"]');

  for (const ending of ["overlay", "Close", "Escape"] as const)
    for (const reached of ["route reuse", "Back", "control"] as const)
      test(`${ending}, ${reached}: the failed read is said, and ${reached === "control" ? "the field shown" : "only the field shown"} ends its session`, async ({
        context,
      }, info) => {
        const { page } = await setup(
          context,
          `/people/${P}`,
          resources(),
          policies,
        );
        await expect(page.locator(`[data-field-row="${G}"]`)).toBeVisible();
        await keep(page, F, "First", "First kept");
        await keep(page, G, "Second", "Second kept");
        await readsOfCacheRows(page, [F, G]);
        // The shown target is Second, reached through the same route component (in-app navigation, or Back from a later entry).
        if (reached === "route reuse") {
          await navigateInApp(page, field(F));
          await expect(failed(page)).toBeVisible();
          await navigateInApp(page, field(G));
        } else if (reached === "Back") {
          await navigateInApp(page, field(G));
          await expect(failed(page)).toBeVisible();
          await navigateInApp(page, field(F));
          await expect.poll(() => new URL(page.url()).pathname).toBe(field(F));
          await page.goBack();
        } else await navigateInApp(page, field(G));
        await expect.poll(() => new URL(page.url()).pathname).toBe(field(G));
        const d = page.getByRole("dialog", { name: "Edit field" });
        await expect(
          d.locator('[data-people-state="editor-read-failed"]'),
        ).toBeVisible();
        await expect(
          d.getByRole("button", { name: "Try again" }),
        ).toBeVisible();
        expect(await faultsReached(page)).toBeGreaterThan(0);
        if (ending === "overlay") await page.mouse.click(8, 8);
        else if (ending === "Close")
          await d.getByRole("button", { name: "Close", exact: true }).click();
        else await page.keyboard.press("Escape");
        await expect(d).toBeHidden();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(`/people/${P}`);
        await readsOfCacheRows(page, []);
        const second = await (await reopened(page, G, "Second")).inputValue();
        await navigateInApp(page, `/people/${P}`);
        const first = await (await reopened(page, F, "First")).inputValue();
        recordEvidence(info, "e-p36", { ending, reached, second, first });
        expect(second, "the session shown was ended").toBe("Second saved");
        expect(first, "another field's session is not touched").toBe(
          "First kept",
        );
      });

  // Review 9's own reproduction of finding 1: the unsent changes cannot be read (shared by both fields, so the unread view is not
  // withdrawn while the next field's own read loads), and the router shows Second's route through the same component.
  for (const ending of ["overlay", "Close", "Escape"] as const)
    for (const reached of ["route reuse", "control"] as const)
      test(`unsent changes unread, ${ending}, ${reached}: ${reached === "control" ? "the field shown" : "only the field shown"} ends its session`, async ({
        context,
      }, info) => {
        const { page } = await setup(
          context,
          `/people/${P}`,
          resources(),
          policies,
        );
        await expect(page.locator(`[data-field-row="${G}"]`)).toBeVisible();
        await keep(page, F, "First", "First kept");
        await keep(page, G, "Second", "Second kept");
        await readsOfUnsentChanges(page, true);
        if (reached === "route reuse") {
          await navigateInApp(page, field(F));
          await expect(
            page
              .getByRole("dialog", { name: "Edit First" })
              .locator('[data-people-state="editor-unread"]'),
          ).toBeVisible();
        }
        await navigateInApp(page, field(G));
        const d = page.getByRole("dialog", { name: "Edit Second" });
        await expect(
          d.locator('[data-people-state="editor-unread"]'),
        ).toBeVisible();
        const faults = await page.evaluate(
          () =>
            (window as unknown as { __ep36ChainFaults?: number })
              .__ep36ChainFaults ?? 0,
        );
        expect(faults).toBeGreaterThan(0);
        if (ending === "overlay") await page.mouse.click(8, 8);
        else if (ending === "Close")
          await d.getByRole("button", { name: "Close", exact: true }).click();
        else await page.keyboard.press("Escape");
        await expect(d).toBeHidden();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(`/people/${P}`);
        await readsOfUnsentChanges(page, false);
        const second = await (await reopened(page, G, "Second")).inputValue();
        await navigateInApp(page, `/people/${P}`);
        const first = await (await reopened(page, F, "First")).inputValue();
        recordEvidence(info, "e-p36-chain", { ending, reached, second, first });
        expect(second, "the session shown was ended").toBe("Second saved");
        expect(first, "another field's session is not touched").toBe(
          "First kept",
        );
      });

  test("Try again after the read is repaired: the editor, with the input kept (nothing is sent)", async ({
    context,
  }, info) => {
    const { page, net } = await setup(
      context,
      `/people/${P}`,
      resources(),
      policies,
    );
    await expect(page.locator(`[data-field-row="${G}"]`)).toBeVisible();
    await keep(page, G, "Second", "Second kept");
    await readsOfCacheRows(page, [G]);
    await navigateInApp(page, field(G));
    const d = page.getByRole("dialog", { name: "Edit field" });
    await expect(
      d.locator('[data-people-state="editor-read-failed"]'),
    ).toBeVisible();
    await readsOfCacheRows(page, []);
    await d.getByRole("button", { name: "Try again" }).click();
    const editor = page.getByRole("dialog", { name: "Edit Second" });
    await expect(
      editor.getByRole("textbox", { name: "Value", exact: true }),
    ).toHaveValue("Second kept");
    recordEvidence(info, "e-p36-retry", { commands: net.commands.length });
    expect(net.commands).toHaveLength(0);
  });
});

test.describe("E-P37: an edit of an unsent create after the create is published (review 10, finding 1)", () => {
  /** The account's draft bodies in real IndexedDB, by local id. */
  const bodiesOf = async (page: Page) =>
    (await page.evaluate(
      (a) => window.__atlasData?.rows(a, "draft_commands"),
      ME,
    )) as Array<{
      local_id: string;
      command: { command?: Record<string, unknown> };
    }>;
  /** Creates a private field offline (an unsent create), and serves its audience. */
  async function queued(context: Parameters<typeof setup>[0]): Promise<{
    page: Page;
    net: Awaited<ReturnType<typeof setup>>["net"];
    id: string;
  }> {
    const { page, net, served } = await setup(
      context,
      `/people/${P}/fields/new`,
      [personP(P, "Ada")],
    );
    await startOutbox(page, ME);
    await connectivity(context, page, false);
    const d = page.getByRole("dialog", { name: "Add a field" });
    await d.getByRole("textbox", { name: "Name", exact: true }).fill("Queued");
    await d
      .getByRole("textbox", { name: "Value", exact: true })
      .fill("First value");
    await d.getByRole("radio", { name: "Only you", exact: true }).click();
    await d.getByRole("button", { name: "Save", exact: true }).click();
    await expect(d).toBeHidden();
    const [draft] = await draftsOf(page);
    expect(draft?.status).toBe("queued");
    const id = (
      draft?.target_resource_ids as string[] | undefined
    )?.[0] as string;
    served.policies.set(id, { version: 1, policy: PRIVATE });
    return { page, net, id };
  }
  /** Opens the queued field's editor and types the second value (the editor of an unsent create: no Archive). */
  async function typed(page: Page, id: string) {
    await navigateInApp(page, `/people/${P}/fields/${id}`);
    const d = page.getByRole("dialog", { name: "Edit Queued" });
    await expect(d).toBeVisible();
    await expect(
      d.getByRole("button", { name: "Archive", exact: true }),
    ).toHaveCount(0);
    const box = d.getByRole("textbox", { name: "Value", exact: true });
    await box.fill("Second value");
    await expect(box).toHaveValue("Second value");
    return d;
  }
  /** Sends the create, observes its acknowledgement, and publishes the field through the fixture leader (one real page application). */
  async function sendAndPublish(
    context: Parameters<typeof setup>[0],
    page: Page,
    net: Awaited<ReturnType<typeof setup>>["net"],
    id: string,
  ) {
    await connectivity(context, page, true);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect.poll(() => net.commands.length).toBe(1);
    await expect
      .poll(async () => (await draftsOf(page)).map((d) => d.status))
      .toEqual(["acknowledged"]);
    await publish(
      page,
      net,
      [fieldP(id, P, "Queued", { kind: "text", text: "First value" })],
      {
        start: false,
      },
    );
  }
  /** The one queued draft after the save: exactly the update of the same field on the reviewed versions. */
  async function expectUpdate(page: Page, id: string) {
    await expect
      .poll(
        async () =>
          (await draftsOf(page)).filter((d) => d.status === "queued").length,
      )
      .toBe(1);
    const [draft] = (await draftsOf(page)).filter((d) => d.status === "queued");
    const body = (await bodiesOf(page)).find(
      (b) => b.local_id === draft?.local_id,
    );
    expect(body?.command.command).toEqual({
      kind: "put_field",
      id,
      parent_id: P,
      expected_version: 1,
      expected_policy_version: 1,
      label: "Queued",
      value: { kind: "text", text: "Second value" },
    });
    return draft;
  }

  for (const timing of ["while open", "while away"] as const)
    test(`${timing}: the kept input is reviewed on the published field and stored as its update, after the person's choice only`, async ({
      context,
    }, info) => {
      const { page, net, id } = await queued(context);
      await typed(page, id);
      if (timing === "while away") {
        await navigateInApp(page, `/people/${P}`);
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
      await sendAndPublish(context, page, net, id);
      if (timing === "while away")
        await navigateInApp(page, `/people/${P}/fields/${id}`);
      const d = page.getByRole("dialog", { name: "Edit Queued" });
      // Published (the positive witness): Archive is offered; the input is kept; the review is shown and Save waits for it.
      await expect(
        d.getByRole("button", { name: "Archive", exact: true }),
      ).toBeVisible();
      await expect(
        d.getByRole("textbox", { name: "Value", exact: true }),
      ).toHaveValue("Second value");
      await expect(d.locator("[data-review-published]")).toHaveText(
        "Your change isn't saved yet. Check the field as it is now, then save yours on it or discard it.",
      );
      await expect(
        d.getByRole("button", { name: "Save", exact: true }),
      ).toBeDisabled();
      await expect(d.locator("[data-review-audience]")).toContainText(
        "Only you",
      );
      // Nothing was bound or stored because the create was published.
      expect(
        (await draftsOf(page)).filter((x) => x.status === "queued"),
      ).toHaveLength(0);
      await d
        .getByRole("button", {
          name: "Save mine on the current version",
          exact: true,
        })
        .click();
      await expect(d).toBeHidden();
      const draft = await expectUpdate(page, id);
      recordEvidence(info, "e-p37", {
        timing,
        id,
        draft,
        commands: net.commands.length,
      });
      expect(net.commands).toHaveLength(1);
    });

  test("control: published before the editor opened: an ordinary bound edit, stored as the same update", async ({
    context,
  }, info) => {
    const { page, net, id } = await queued(context);
    await sendAndPublish(context, page, net, id);
    await navigateInApp(page, `/people/${P}/fields/${id}`);
    const d = page.getByRole("dialog", { name: "Edit Queued" });
    await expect(
      d.getByRole("button", { name: "Archive", exact: true }),
    ).toBeVisible();
    await expect(d.locator("[data-review-published]")).toHaveCount(0);
    await expect(d.getByRole("radio", { name: "Only you" })).toBeChecked();
    const box = d.getByRole("textbox", { name: "Value", exact: true });
    await box.fill("Second value");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    await expect(d).toBeHidden();
    const draft = await expectUpdate(page, id);
    recordEvidence(info, "e-p37-control", { id, draft });
  });
});
