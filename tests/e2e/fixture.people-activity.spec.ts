import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import { pressTab } from "./helpers";
import {
  atlas,
  connectivity,
  fieldP,
  MO,
  personP,
  publishChanges,
  type Served,
  setup,
} from "./people-helpers";

/**
 * WEB-19 in Chromium, Firefox and WebKit: "Recent changes" on the person detail in the PRODUCTION session and protected tree
 * (`/__session`), the production data controller and REAL IndexedDB, with `GET /people/{id}/activity` stubbed by the people route double
 * (`servePeople`: `activity`, `activityScript`, `activityLog`) and the cache seeded through the fixture leader's `/sync`. FIXTURE
 * evidence: an answer here is the stub's, never the backend's (I-PPL24..I-PPL29 run against the released backend).
 *
 * E-AC1 the owner's timeline as sentences, times and coverage; no sharing row, and a body that is not the contract's is not shown in
 * part. E-AC2 Show all, then Show older: the cursors asked, each id once. E-AC3 a dropped page retried and a synced change re-read: each
 * id once. E-AC4 a refused cursor restarts; a 404 clears the section; a field removed by /sync is withheld before the re-read answers.
 * E-AC5 offline shows nothing earlier; online reads again. E-AC6 a merged alias's route; targets this device does not hold are plain.
 * E-AC7 a second device of the same account reads the same ids in the same order. E-AC8 keyboard only, names, and 360 px wide.
 * E-AC9 keyboard focus, the items and the controls survive a refresh whose re-read is held (review 1, R-1).
 */
const P = "55555555-5555-4555-8555-555555555555";
const ALIAS = "57575757-5757-4757-8757-575757575757";
const F1 = "66666666-6666-4666-8666-000000000001";
const F2 = "66666666-6666-4666-8666-000000000002";
const F9 = "66666666-6666-4666-8666-000000000009";
const COVERAGE = 1793750400;
const eid = (n: number) =>
  `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, "0")}`;

const SUMMARY: Record<string, string> = {
  person_created: "Added this person",
  person_renamed: "Renamed this person",
  person_archived: "Archived this person",
  person_restored: "Restored this person",
  person_linked: "Linked this person to an account",
  person_unlinked: "Unlinked this person from an account",
  person_merged: "Merged another profile into this person",
  field_created: "Added a field",
  field_edited: "Edited a field",
  field_archived: "Archived a field",
  field_restored: "Restored a field",
};
const field = (id: string, label: string, archived = false) => ({
  kind: "field",
  id,
  label,
  archived,
  state: "current",
  field_kind: "text",
});
const ada = {
  kind: "person",
  id: P,
  label: "Ada",
  archived: false,
  state: "current",
};
function event(
  n: number,
  type: string,
  target: Record<string, unknown>,
  over: Record<string, unknown> = {},
) {
  return {
    id: eid(n),
    occurred_at: COVERAGE + 86_400 - n * 60,
    type,
    summary: SUMMARY[type],
    actor: { kind: "you" },
    target,
    ...(type === "field_edited" ? { changed: ["value"] } : {}),
    ...(type === "person_linked" || type === "person_unlinked"
      ? { account: { kind: "you" } }
      : {}),
    ...over,
  };
}
const edits = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) =>
    event(from + i, "field_edited", field(F1, "Phone")),
  );

const resources = () => [
  personP(P, "Ada"),
  fieldP(F1, P, "Phone", { kind: "text", text: "0770" }),
  fieldP(F2, P, "Medical note", { kind: "text", text: "x" }),
];

async function open(
  context: BrowserContext,
  events: unknown[],
  arrange: (served: Served) => void = () => undefined,
  route = `/people/${P}`,
) {
  const opened = await setup(context, route, resources(), {
    arrange: (served) => {
      served.activity.set(P, events);
      arrange(served);
    },
  });
  return opened;
}
const section = (page: Page) => page.locator("[data-activity]");
const ids = (page: Page) =>
  page
    .locator("[data-activity-event]")
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-activity-event")),
    );
const ready = (page: Page) =>
  expect(section(page)).toHaveAttribute("data-activity", "ready");

test.describe("E-AC1: the owner's timeline (A19-1, A19-12)", () => {
  test("sentences with current labels, a time each and the coverage; a sharing row is never shown, and its page is not shown in part", async ({
    context,
  }, info) => {
    const { page, served } = await open(context, [
      event(1, "field_edited", field(F1, "Phone"), { changed: ["label"] }),
      event(2, "field_archived", field(F9, "Old note", true), {
        actor: { kind: "someone_else" },
      }),
      event(3, "person_renamed", ada),
      event(4, "person_created", ada),
    ]);
    await ready(page);
    await expect(page.locator("[data-activity-event] p")).toHaveText([
      "You changed the name of Phone.",
      "Someone else archived Old note.",
      "You renamed this person.",
      "You added this person.",
    ]);
    await expect(section(page).locator("time")).toHaveCount(4);
    await expect(section(page)).toContainText("Recorded since 4 Nov 2026.");
    await expect(section(page)).toContainText(
      "Earlier changes weren't recorded.",
    );
    await expect(
      section(page).locator(`[data-activity-event="${eid(2)}"]`),
    ).toContainText("Archived");
    // The mock's sharing row: a type outside the contract's eleven. The page is refused whole (Try again), never shown in part.
    served.activityScript.push({
      status: 200,
      body: {
        person_id: P,
        items: [
          {
            ...event(5, "field_edited", field(F1, "Phone")),
            type: "field_policy_changed",
            summary: "Narrowed Medical note to only you",
          },
          event(1, "field_edited", field(F1, "Phone"), { changed: ["label"] }),
        ],
        next_after: null,
        coverage_started_at: COVERAGE,
      },
    });
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(section(page)).toHaveAttribute("data-activity", "failed");
    await expect(section(page)).not.toContainText("Narrowed");
    expect(await ids(page)).toEqual([]);
    await section(page).getByRole("button", { name: "Try again" }).click();
    await ready(page);
    expect(await ids(page)).toEqual([eid(1), eid(2), eid(3), eid(4)]);
    recordEvidence(info, "e-ac1", { activityLog: served.activityLog });
  });
});

test.describe("E-AC2: pagination (A19-3)", () => {
  test("preview 5, Show all 50, Show older 50 more: the cursors asked, each id once, in the server's order", async ({
    context,
  }, info) => {
    const events = edits(80);
    const { page, served } = await open(context, events);
    await ready(page);
    expect(await ids(page)).toEqual(events.slice(0, 5).map((e) => e.id));
    await section(page)
      .getByRole("button", { name: "Show all changes" })
      .click();
    await expect(page.locator("[data-activity-event]")).toHaveCount(50);
    await section(page)
      .getByRole("button", { name: "Show older changes" })
      .click();
    await expect(page.locator("[data-activity-event]")).toHaveCount(80);
    const shown = await ids(page);
    expect(shown).toEqual(events.map((e) => e.id));
    expect(new Set(shown).size).toBe(80);
    const extends_ = served.activityLog.filter((l) => l.includes("after="));
    expect(extends_).toEqual([
      `GET /people/${P}/activity?limit=45&after=${eid(5)}`,
      `GET /people/${P}/activity?limit=50&after=${eid(50)}`,
    ]);
    await expect(section(page)).toContainText(
      "Earlier changes weren't recorded.",
    );
    recordEvidence(info, "e-ac2", { activityLog: served.activityLog });
  });
});

test.describe("E-AC3: duplicate delivery (A19-4)", () => {
  test("a dropped page is retried and a synced change re-reads from the first page: each id is shown exactly once", async ({
    context,
  }, info) => {
    const events = edits(12);
    const { page, net, served } = await open(context, events);
    await ready(page);
    served.activityScript.push("abort");
    await section(page)
      .getByRole("button", { name: "Show all changes" })
      .click();
    await expect(section(page)).toContainText("Couldn't load older changes.");
    expect(await ids(page)).toHaveLength(5);
    await section(page).getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("[data-activity-event]")).toHaveCount(12);
    // Another device adds an event; this device's sync delivers the change: the timeline is read again whole.
    served.activity.set(P, [
      event(100, "field_created", field(F2, "Medical note")),
      ...events,
    ]);
    const before = served.activityLog.length;
    await publishChanges(
      page,
      net,
      [
        {
          kind: "upsert",
          resource: fieldP(
            F1,
            P,
            "Phone",
            { kind: "text", text: "0771" },
            {
              version: 2,
            },
          ),
        },
      ],
      { start: false },
    );
    await expect
      .poll(() =>
        served.activityLog.slice(before).some((l) => !l.includes("after=")),
      )
      .toBe(true);
    await expect(page.locator("[data-activity-event]").first()).toHaveAttribute(
      "data-activity-event",
      eid(100),
    );
    const shown = await ids(page);
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown).toEqual([eid(100), ...events.map((e) => e.id)].slice(0, 50));
    recordEvidence(info, "e-ac3", { activityLog: served.activityLog });
  });
});

test.describe("E-AC4: revoked cursors, lost access, hidden fields (A19-7)", () => {
  test("a refused cursor (422) on Show older restarts from the first page", async ({
    context,
  }, info) => {
    const { page, served } = await open(context, edits(60));
    await ready(page);
    served.activityScript.push({
      status: 422,
      body: atlas("invalid_value"),
    });
    await section(page)
      .getByRole("button", { name: "Show all changes" })
      .click();
    await expect(page.locator("[data-activity-event]")).toHaveCount(50);
    const tail = served.activityLog.slice(-2);
    expect(tail).toEqual([
      `GET /people/${P}/activity?limit=45&after=${eid(5)}`,
      `GET /people/${P}/activity?limit=50`,
    ]);
    recordEvidence(info, "e-ac4-422", { activityLog: served.activityLog });
  });

  test("a 404 clears the section: no label of the timeline is left on the page", async ({
    context,
  }) => {
    const { page, served } = await open(context, [
      event(1, "field_edited", field(F2, "Medical note")),
    ]);
    await ready(page);
    await expect(section(page)).toContainText("Medical note");
    served.activityScript.push({ status: 404, body: atlas("not_found") });
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(section(page)).toHaveAttribute("data-activity", "gone");
    await expect(section(page)).toHaveText(
      /You can no longer see this person's changes\./,
    );
    await expect(section(page)).not.toContainText("Medical note");
  });

  test("a field removed by /sync is withheld at once, before the re-read (held) answers", async ({
    context,
  }, info) => {
    const { page, net, served } = await open(context, [
      event(1, "field_edited", field(F2, "Medical note")),
      event(2, "field_edited", field(F1, "Phone")),
    ]);
    await ready(page);
    expect(await ids(page)).toEqual([eid(1), eid(2)]);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    served.activity.set(P, [event(2, "field_edited", field(F1, "Phone"))]);
    served.activityScript.push(() => held);
    const before = served.activityLog.length;
    await publishChanges(page, net, [{ kind: "remove", id: F2 }], {
      start: false,
    });
    await expect.poll(() => served.activityLog.length).toBeGreaterThan(before);
    await expect(section(page)).toHaveAttribute("data-activity", "loading");
    await expect(page.locator(`[data-activity-event="${eid(1)}"]`)).toHaveCount(
      0,
    );
    await expect(page.locator(`[data-activity-event="${eid(2)}"]`)).toHaveCount(
      1,
    );
    await expect(section(page)).not.toContainText("Medical note");
    release();
    await ready(page);
    expect(await ids(page)).toEqual([eid(2)]);
    recordEvidence(info, "e-ac4-withheld", { activityLog: served.activityLog });
  });
});

test.describe("E-AC5: offline (A19-10)", () => {
  test("offline shows the unavailable state and no earlier rows; online reads again", async ({
    context,
  }) => {
    const { page, served } = await open(context, [
      event(1, "field_edited", field(F1, "Phone")),
    ]);
    await ready(page);
    await connectivity(context, page, false);
    await expect(section(page)).toHaveAttribute("data-activity", "offline");
    await expect(page.locator("[data-activity-event]")).toHaveCount(0);
    await expect(section(page)).toContainText(
      "Recent changes are shown when you're online.",
    );
    const before = served.activityLog.length;
    await connectivity(context, page, true);
    await ready(page);
    expect(served.activityLog.length).toBeGreaterThan(before);
    expect(await ids(page)).toEqual([eid(1)]);
  });
});

test.describe("E-AC6: merged identities and missing targets (A19-9)", () => {
  test("a merged alias's route lists nothing and points to the person it was merged into", async ({
    context,
  }) => {
    const { page } = await setup(
      context,
      `/people/${ALIAS}`,
      [
        ...resources(),
        personP(ALIAS, "Ada L", {
          archived: true,
          value: { canonical_person_id: P },
        }),
      ],
      {
        arrange: (served) => {
          served.activity.set(P, [
            event(1, "field_edited", field(F1, "Phone")),
          ]);
          served.activityCanonical.set(ALIAS, P);
        },
      },
    );
    await expect(section(page)).toHaveAttribute("data-activity", "merged");
    await expect(page.locator("[data-activity-event]")).toHaveCount(0);
    await expect(
      section(page).getByRole("link", { name: "Open that person" }),
    ).toHaveAttribute("href", `/people/${P}`);
  });

  test("a target this device does not hold, or that is archived, is plain text; the current field links to its editor", async ({
    context,
  }) => {
    const { page } = await open(context, [
      event(1, "field_edited", field(F1, "Phone")),
      event(2, "field_created", field(F9, "Not here")),
      event(3, "person_merged", ada),
    ]);
    await ready(page);
    await expect(section(page).locator("[data-activity-link]")).toHaveCount(1);
    await expect(
      section(page).getByRole("link", { name: "Phone" }),
    ).toHaveAttribute("href", `/people/${P}/fields/${F1}`);
    await expect(
      page.locator(`[data-activity-event="${eid(3)}"] p`),
    ).toHaveText("You merged another profile into this person.");
  });
});

test.describe("E-AC7: two devices of one account (A19-6)", () => {
  test("a second device reads the same events, in the same order, each once", async ({
    browser,
    context,
  }) => {
    const events = [
      event(1, "field_edited", field(F1, "Phone"), {
        actor: { kind: "account", account_id: MO, username: "mo" },
      }),
      ...edits(4, 2),
    ];
    const first = await open(context, events);
    await ready(first.page);
    const other = await browser.newContext();
    try {
      const second = await open(other, events);
      await ready(second.page);
      expect(await ids(second.page)).toEqual(await ids(first.page));
      await expect(
        second.page.locator(`[data-activity-event="${eid(1)}"] p`),
      ).toHaveText("mo changed the value of Phone.");
    } finally {
      await other.close();
    }
  });
});

test.describe("E-AC8: keyboard, names and a narrow screen (A19-11)", () => {
  test("Tab to Show all changes, Enter: focus moves to the first new item; named region and list; no horizontal scroll at 360 px", async ({
    context,
  }, info) => {
    const { page } = await open(context, edits(60), (served) => {
      served.activity.set(P, [
        event(0, "field_created", field(F1, "A".repeat(280))),
        ...edits(59),
      ]);
    });
    await page.setViewportSize({ width: 360, height: 740 });
    await ready(page);
    const region = page.getByRole("region", { name: "Recent changes" });
    await expect(region.getByRole("list")).toBeVisible();
    await expect(region.getByRole("listitem")).toHaveCount(5);
    await page.locator("[data-activity] h3").click();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await pressTab(page);
      reached = await page.evaluate(
        () =>
          document.activeElement?.hasAttribute("data-activity-extend") ?? false,
      );
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-activity-event]")).toHaveCount(50);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.getAttribute("data-activity-event"),
        ),
      )
      .toBe(eid(5));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    const box = await region
      .getByRole("button", { name: "Show older changes" })
      .boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    recordEvidence(info, "e-ac8", { focused: eid(5) });
  });
});

test.describe("E-AC9: keyboard across a refresh (A19-11; review 1, R-1)", () => {
  test("focus on Show older changes stays through a synced change and its held re-read, on the same items; Enter then shows older and moves focus", async ({
    context,
  }, info) => {
    const events = edits(120);
    const { page, net, served } = await open(context, events);
    await ready(page);
    const tabTo = async (selector: string) => {
      for (let i = 0; i < 80; i += 1) {
        if (
          await page.evaluate(
            (wanted) => document.activeElement?.matches(wanted) ?? false,
            selector,
          )
        )
          return true;
        await pressTab(page);
      }
      return false;
    };
    await page.locator("[data-activity] h3").click();
    expect(await tabTo("[data-activity-extend]")).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-activity-event]")).toHaveCount(50);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.getAttribute("data-activity-event"),
        ),
      )
      .toBe(eid(6));
    expect(await tabTo("[data-activity-extend]")).toBe(true);
    // Mark the first item's node: a remount would replace it.
    await page
      .locator(`[data-activity-event="${eid(1)}"]`)
      .evaluate((item) => item.setAttribute("data-e-ac9", "kept"));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    served.activityScript.push(() => held);
    const before = served.activityLog.length;
    await publishChanges(
      page,
      net,
      [
        {
          kind: "upsert",
          resource: fieldP(
            F1,
            P,
            "Phone",
            { kind: "text", text: "0771" },
            { version: 2 },
          ),
        },
      ],
      { start: false },
    );
    await expect.poll(() => served.activityLog.length).toBeGreaterThan(before);
    await expect(section(page)).toHaveAttribute("data-activity", "loading");
    const focusedNow = () =>
      page.evaluate(() => ({
        extend: document.activeElement?.hasAttribute("data-activity-extend"),
        label: document.activeElement?.textContent,
      }));
    expect(await focusedNow()).toEqual({
      extend: true,
      label: "Show older changes",
    });
    await expect(
      section(page).getByRole("button", { name: "Show fewer" }),
    ).toBeVisible();
    await expect(page.locator("[data-activity-event]")).toHaveCount(50);
    release();
    await ready(page);
    expect(await focusedNow()).toEqual({
      extend: true,
      label: "Show older changes",
    });
    await expect(
      page.locator(`[data-activity-event="${eid(1)}"]`),
    ).toHaveAttribute("data-e-ac9", "kept");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-activity-event]")).toHaveCount(100);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.getAttribute("data-activity-event"),
        ),
      )
      .toBe(eid(51));
    await expect(page.locator("body")).toContainText("50 older changes shown.");
    recordEvidence(info, "e-ac9", { activityLog: served.activityLog });
  });
});
