import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PeopleResult } from "../../../src/features/people/api";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import type {
  AudienceSummary,
  FieldAudience,
  PersonSummary,
  SharedWith,
  SummaryPage,
} from "../../../src/features/people/model/summary";
import { SUMMARY_REFRESH_MS } from "../../../src/features/people/summaries";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { HOME, ME, MO, record } from "../../support/people/records";
import { fieldRow, peopleWorld, person } from "../../support/people/world";

/**
 * Finding 8 of the review of 13 October 2026 with API 0.29's viewer-safe summaries: the drawn In Home / Shared with me / Not linked views,
 * the Account and Visible to lines with who added each person, the field audience tags and the detail's "Shared with", and the summaries'
 * privacy, freshness, invalidation, pagination and identity rules as the screens apply them. jsdom with axe; FIXTURE evidence (the fake
 * server's answers pass the real strict parser; the I-PPL cases are the backend's).
 */
installMatchMedia({ width: 1440 });
beforeEach(() => {
  forgetAllPeopleMemory();
  forgetRefusedPolicies();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const id = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const SAM_OWNER = "55555555-5555-4555-8555-000000000005";
const home = {
  id: HOME,
  can_edit: false,
  you_are_member: true,
  name: "Home",
  version: 1,
  member_count: 4,
};
const ownerHome: AudienceSummary = {
  disclosure: "complete",
  in_home: true,
  households: [home],
  your_direct_grant: null,
  direct_grant_count: 0,
  excluded_count: 0,
};
const partialHome: AudienceSummary = {
  disclosure: "partial",
  in_home: true,
  households: [home],
  your_direct_grant: null,
  direct_grant_count: null,
  excluded_count: null,
};
/** Owned by Mo (who is a visible person, "Mo"), seen by me through Home. */
const sharedByMo = (
  over: Partial<PersonSummary> = {},
): Partial<PersonSummary> => ({
  owner: {
    account_id: MO,
    username: "mo",
    you: false,
    person: { id: id(90), label: "Mo" },
  },
  your_access: "view",
  added_by_you: "no",
  audience: partialHome,
  ...over,
});
const rowOf = (personId: string) =>
  document.querySelector(`[data-person-row="${personId}"]`) as HTMLElement;
const rowNames = () =>
  [...document.querySelectorAll("[data-person-row]")].map(
    (row) => row.querySelector("span span")?.textContent,
  );
const reads = (w: ReturnType<typeof peopleWorld>, op = "readSummaries") =>
  w.api.calls.filter((c) => c.op === op);
const chip = (name: string) => screen.getByRole("button", { name });
/** The text is shown (an assertion, so a mutant that removes it is caught by an assertion, not a lookup error). */
const shows = (text: string | RegExp) =>
  waitFor(() => expect(screen.queryByText(text)).not.toBeNull());

/** The drawn people of the export, with their summaries. */
function drawn() {
  const w = peopleWorld();
  const [kieran, mo, ada, sam, old] = [id(1), id(2), id(3), id(4), id(5)];
  w.setCache([
    person({ id: kieran, label: "Kieran" }),
    person({ id: mo, label: "Mo", can_edit: false }),
    person({ id: ada, label: "Ada" }),
    person({ id: sam, label: "Sam", can_edit: false }),
    person({ id: old, label: "Old friend" }),
  ]);
  w.api.linked.set(kieran, ME);
  w.api.linked.set(mo, MO);
  w.api.summary.home = { id: HOME, name: "Home", version: 1, member_count: 4 };
  w.api.summary.persons.set(kieran, {
    added_by_you: "yes",
    audience: ownerHome,
  });
  // Mo: added by me, then linked to Mo's account (Mo owns it now; the link did not erase who added it).
  w.api.summary.persons.set(
    mo,
    sharedByMo({
      added_by_you: "yes",
      owner: { account_id: MO, username: "mo", you: false, person: null },
    }),
  );
  w.api.summary.persons.set(ada, { added_by_you: "yes", audience: ownerHome });
  w.api.summary.persons.set(sam, sharedByMo());
  // Old friend: created before attribution existed (unknown), private.
  return { w, kieran, mo, ada, sam, old };
}

describe("the list's lines (finding 8)", () => {
  test("each row says who added them, their account and who can see them; partial audiences say more may exist; never live; axe clean", async () => {
    const { w, kieran, mo, ada, sam, old } = drawn();
    await w.mount("/people");
    await waitFor(() =>
      expect(document.querySelectorAll("[data-person-audience]")).toHaveLength(
        5,
      ),
    );
    expect(rowOf(kieran)).toHaveTextContent("You");
    expect(rowOf(kieran)).toHaveTextContent("Linked to your account");
    expect(rowOf(kieran)).toHaveTextContent("Visible to: Home · can view");
    expect(rowOf(mo)).toHaveTextContent("Added by you");
    expect(rowOf(mo)).toHaveTextContent("Linked · they control their name");
    expect(rowOf(mo)).toHaveTextContent("Visible to: Shared from Home");
    expect(rowOf(ada)).toHaveTextContent("Added by you");
    expect(rowOf(ada)).toHaveTextContent("Not linked to an account");
    expect(rowOf(sam)).toHaveTextContent("Shared with you by Mo");
    expect(rowOf(sam)).toHaveTextContent("Visible to: Shared from Home");
    // Unknown attribution makes no claim; a private person is "Only you".
    expect(rowOf(old).querySelector("[data-person-attribution]")).toBeNull();
    expect(rowOf(old)).toHaveTextContent("Visible to: Only you");
    // Household size (4) is never said as an audience.
    expect(document.querySelector("[data-people-list]")).not.toHaveTextContent(
      "4 people",
    );
    expect(
      screen.queryByText(/The owner may have shared them more widely/),
    ).not.toBeNull();
    expect(
      screen.queryByText(
        /^Sharing checked at .+ Atlas checks again every minute/,
      ),
    ).not.toBeNull();
    expect(reads(w, "readPerson")).toEqual([]);
    expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toEqual([]);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("a summary older than what this device shows is not shown beside the person", async () => {
    const { w, ada, sam } = drawn();
    w.api.summary.persons.set(ada, {
      added_by_you: "yes",
      audience: ownerHome,
      version: 2,
    });
    await w.mount("/people");
    await waitFor(() =>
      expect(rowOf(sam)).toHaveTextContent("Shared with you by Mo"),
    );
    expect(rowOf(ada).querySelector("[data-person-audience]")).toBeNull();
    expect(rowOf(ada).querySelector("[data-person-linkage]")).toBeNull();
  });

  test("offline: no account, audience or attribution is shown, never an old one; online again reads them again", async () => {
    const { w, sam } = drawn();
    await w.mount("/people");
    await waitFor(() =>
      expect(rowOf(sam)).toHaveTextContent("Shared with you by Mo"),
    );
    const before = reads(w).length;
    w.setOnline(false);
    await waitFor(() =>
      expect(document.querySelector("[data-person-audience]")).toBeNull(),
    );
    expect(document.querySelector("[data-person-linkage]")).toBeNull();
    expect(document.querySelector("[data-person-attribution]")).toBeNull();
    expect(
      screen.queryByText(
        "Who can see each person and their account links are checked when you're online.",
      ),
    ).not.toBeNull();
    expect(rowNames()).toHaveLength(5);
    fireEvent.click(chip("Not linked"));
    await shows("This view needs a connection. All and Archived work offline.");
    expect(reads(w)).toHaveLength(before);
    w.setOnline(true);
    await waitFor(() =>
      expect(rowNames()).toEqual(["Ada", "Old friend", "Sam"]),
    );
    // Back to All, which was read before going offline: reconnecting reads it again (never the answer from before).
    const joins = () => reads(w).filter((c) => c.args[0] === "all").length;
    const allBefore = joins();
    fireEvent.click(chip("All"));
    await waitFor(() => expect(joins()).toBeGreaterThan(allBefore));
    await waitFor(() =>
      expect(rowOf(sam)).toHaveTextContent("Shared with you by Mo"),
    );
  });
});

describe("In Home, Shared with me and Not linked are the server's (finding 8)", () => {
  test("each is a scope the server applies before paging: its rows are the server's, never a filtered cache page", async () => {
    const { w, ada } = drawn();
    await w.mount("/people");
    await waitFor(() => expect(rowNames()).toHaveLength(5));
    // The server is the source: a person it lists that this device has not synced is shown, from the summary; cached ones it does not
    // list are not.
    const zara: PersonSummary = {
      ...(w.api.summaryOf(ada) as PersonSummary),
      id: id(80),
      label: "Zara",
      field_count: 2,
    };
    w.api.next.summaries.push({
      ok: true,
      value: {
        items: [zara],
        next_after: null,
        home: w.api.summary.home,
        preferences_version: 1,
      },
    });
    fireEvent.click(chip("In Home"));
    await waitFor(() => expect(rowNames()).toEqual(["Zara"]));
    expect(rowOf(id(80))).toHaveTextContent("2 fields");
    expect(chip("In Home")).toHaveAttribute("aria-pressed", "true");
    expect(reads(w).at(-1)?.args).toEqual([
      "in_home",
      { after: null, limit: 100, archived: false },
    ]);
    // Read again (an invalidation): shared with my primary household, whoever owns them (Mo and Sam are Mo's).
    w.advanceRevision();
    await waitFor(() =>
      expect(rowNames()).toEqual(["Ada", "Kieran", "Mo", "Sam"]),
    );
    fireEvent.click(chip("Shared with me"));
    // Mo is owned by Mo but was added by me: not "Shared with me" (product decision 1).
    await waitFor(() => expect(rowNames()).toEqual(["Sam"]));
    fireEvent.click(chip("Not linked"));
    await waitFor(() =>
      expect(rowNames()).toEqual(["Ada", "Old friend", "Sam"]),
    );
  });

  test("a scope is read in bounded steps: Next and Previous people move through every page", async () => {
    const w = peopleWorld();
    const people = Array.from({ length: 250 }, (_, i) =>
      person({
        id: id(i),
        label: `P${String(i).padStart(3, "0")}`,
        can_edit: false,
      }),
    );
    w.setCache(people);
    for (const p of people) w.api.summary.persons.set(p.id, sharedByMo());
    await w.mount("/people");
    await waitFor(() => expect(rowNames()).toHaveLength(100));
    fireEvent.click(chip("Shared with me"));
    await waitFor(() =>
      expect(document.querySelector("[data-people-scope]")).not.toBeNull(),
    );
    await waitFor(() => expect(rowNames()).toHaveLength(100));
    expect(rowNames()[0]).toBe("P000");
    fireEvent.click(screen.getByRole("button", { name: "Next people" }));
    await waitFor(() => expect(rowNames()[0]).toBe("P100"));
    fireEvent.click(screen.getByRole("button", { name: "Next people" }));
    await waitFor(() => expect(rowNames()).toHaveLength(50));
    expect(screen.queryByRole("button", { name: "Next people" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous people" }));
    await waitFor(() => expect(rowNames()[0]).toBe("P100"));
    expect(
      reads(w)
        .filter((c) => c.args[0] === "shared_with_me")
        .map((c) => (c.args[1] as { after: string | null }).after),
    ).toEqual([null, id(99), id(199)]);
  });

  test("searching a scope walks the server's pages and keeps searching past a step's bound", async () => {
    const w = peopleWorld();
    const people = Array.from({ length: 2101 }, (_, i) =>
      person({ id: id(i), label: i === 2100 ? "Tail person" : `Person ${i}` }),
    );
    w.setCache(people);
    await w.mount("/people");
    fireEvent.click(chip("Not linked"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search people" }), {
      target: { value: "tail person" },
    });
    await shows(
      "No one matches “tail person” so far. There are more people to check.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep searching" }));
    await waitFor(() => expect(rowNames()).toEqual(["Tail person"]));
  });

  test("In Home without a primary household is an explained empty state; everyone stays under All", async () => {
    const { w } = drawn();
    w.api.summary.home = null;
    await w.mount("/people");
    fireEvent.click(chip("In Home"));
    await shows(
      "You haven't chosen a primary household, so nobody is In Home. Everyone you can see is still under All.",
    );
    fireEvent.click(chip("All"));
    await waitFor(() => expect(rowNames()).toHaveLength(5));
  });

  test("a scope row folds this device's unsent rename over the server's name, marked 'Not sent yet'", async () => {
    const { w, sam } = drawn();
    w.setDrafts([
      draftRow({
        local_id: "e1",
        created_seq: 1,
        kind: "edit",
        command: { commands: [{ kind: "edit", id: sam, label: "Samuel" }] },
      }),
    ]);
    await w.mount("/people");
    fireEvent.click(chip("Shared with me"));
    await waitFor(() => expect(rowNames()).toEqual(["Samuel"]));
    expect(rowOf(sam)).toHaveTextContent("Not sent yet");
  });
});

describe("freshness and invalidation (finding 8)", () => {
  const settled = async (w: ReturnType<typeof peopleWorld>, sam: string) => {
    await w.mount("/people");
    await waitFor(() =>
      expect(rowOf(sam)).toHaveTextContent("Shared with you by Mo"),
    );
    return reads(w).length;
  };

  test("a synced change, a queue change and a households or primary household change each read the summaries again", async () => {
    const { w, sam } = drawn();
    let count = await settled(w, sam);
    w.advanceRevision();
    await waitFor(() => expect(reads(w).length).toBe(count + 1));
    count += 1;
    w.env.set({
      summary: { waiting: 1, needsDecision: 0, held: 0, total: 1, warn: false },
    });
    await waitFor(() => expect(reads(w).length).toBe(count + 1));
    count += 1;
    w.env.setDefaults(record());
    await waitFor(() => expect(reads(w).length).toBe(count + 1));
    count += 1;
    w.env.setDefaults(record({ primary: null }));
    await waitFor(() => expect(reads(w).length).toBe(count + 1));
  });

  test("while shown online: every 60 seconds and whenever the page is visible again; nothing while hidden", async () => {
    const intervals: Array<{ run: () => void; ms: number }> = [];
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      run: () => void,
      ms: number,
    ) => {
      intervals.push({ run, ms });
      return real(() => {}, 1_000_000);
    }) as typeof setInterval);
    const { w, sam } = drawn();
    const count = await settled(w, sam);
    const refresh = intervals.filter((i) => i.ms === SUMMARY_REFRESH_MS).at(-1);
    expect(refresh).toBeDefined();
    expect(SUMMARY_REFRESH_MS).toBe(60_000);
    refresh?.run();
    await waitFor(() => expect(reads(w).length).toBe(count + 1));
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    refresh?.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads(w).length).toBe(count + 1);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(reads(w).length).toBe(count + 2));
  });

  test("an answer that arrives after an invalidation is never shown; the newer read is", async () => {
    const { w, sam } = drawn();
    let release: (value: PeopleResult<SummaryPage<PersonSummary>>) => void =
      () => {};
    w.api.next.summaries.push(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await w.mount("/people");
    await waitFor(() => expect(reads(w)).toHaveLength(1));
    w.advanceRevision();
    await waitFor(() =>
      expect(rowOf(sam)).toHaveTextContent("Shared with you by Mo"),
    );
    // The superseded answer says Sam is mine: it is dropped.
    release({
      ok: true,
      value: {
        items: [
          { ...(w.api.summaryOf(sam) as PersonSummary), added_by_you: "yes" },
        ],
        next_after: null,
        home: null,
        preferences_version: 1,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rowOf(sam)).toHaveTextContent("Shared with you by Mo");
    expect(rowOf(sam)).not.toHaveTextContent("Added by you");
  });

  test("an answer from an older primary-household snapshot is not applied over a newer one", async () => {
    const { w, sam } = drawn();
    w.api.summary.preferencesVersion = 3;
    const count = await settled(w, sam);
    w.api.summary.preferencesVersion = 2;
    w.api.summary.persons.set(sam, sharedByMo({ added_by_you: "yes" }));
    w.advanceRevision();
    await waitFor(() => expect(reads(w).length).toBe(count + 3));
    expect(rowOf(sam)).not.toHaveTextContent("Added by you");
    await shows("Couldn't check who can see these people.");
    expect(rowOf(sam).querySelector("[data-person-audience]")).toBeNull();
  });
});

describe("Shared with (finding 8)", () => {
  test("the owner's rail is complete: grants, households with members and exclusions, excluded accounts; sizes are sizes; axe clean", async () => {
    const { w, ada } = drawn();
    const rail: SharedWith = {
      disclosure: "complete",
      owner: { account_id: ME, username: "me", you: true, person: null },
      accounts: [{ account_id: SAM_OWNER, username: "sam", can_edit: true }],
      households: [
        {
          ...home,
          members: [
            { account_id: ME, username: "me", excluded: false },
            { account_id: MO, username: "mo", excluded: true },
          ],
        },
      ],
      excluded_accounts: [{ account_id: MO, username: "mo" }],
    };
    w.api.summary.rails.set(ada, rail);
    await w.mount(`/people/${ada}`);
    const section = await screen.findByRole("region", { name: "Shared with" });
    await waitFor(() =>
      expect(section).toHaveAttribute("data-shared-with", "complete"),
    );
    const entries = [
      ...section.querySelectorAll("[data-rail-entry]"),
    ] as HTMLElement[];
    expect(entries.map((e) => e.getAttribute("data-rail-entry"))).toEqual([
      "owner",
      "account",
      "household",
    ]);
    expect(entries[0]).toHaveTextContent(/You\s*owner$/);
    expect(entries[1]).toHaveTextContent(/sam\s*can edit$/);
    expect(entries[2]).toHaveTextContent(
      /Home\s*4 members in the household · me, mo \(can't see it\)\s*can view$/,
    );
    expect(section).toHaveTextContent("Excluded: mo");
    expect(section).not.toHaveTextContent("may have shared it more widely");
    expect(section).toHaveTextContent(/Sharing checked at/);
    expect(reads(w, "readPersonSummary")).toEqual([
      { op: "readPersonSummary", args: [ada] },
    ]);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("anyone else's rail is partial: the owner, their own access, their households; no members, no exclusions, the owner may share more", async () => {
    const { w, sam } = drawn();
    w.api.summary.rails.set(sam, {
      disclosure: "partial",
      owner: {
        account_id: MO,
        username: "mo",
        you: false,
        person: { id: id(90), label: "Mo" },
      },
      accounts: [{ account_id: ME, username: "me", can_edit: false }],
      households: [{ ...home, members: null }],
      excluded_accounts: null,
    });
    await w.mount(`/people/${sam}`);
    const section = await screen.findByRole("region", { name: "Shared with" });
    await waitFor(() =>
      expect(section).toHaveAttribute("data-shared-with", "partial"),
    );
    const entries = [
      ...section.querySelectorAll("[data-rail-entry]"),
    ] as HTMLElement[];
    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent(/Mo\s*owner$/);
    expect(entries[1]).toHaveTextContent(/You\s*can view$/);
    expect(entries[2]).toHaveTextContent(
      /Home\s*4 members in the household\s*can view$/,
    );
    expect(section).toHaveTextContent(
      "Mo owns this person. You see only how it's shared with you; Mo may have shared it more widely.",
    );
    expect(section).not.toHaveTextContent("Excluded");
    expect(section).not.toHaveTextContent("can't see it");
  });

  test("nothing shared is 'Only you'; offline is unavailable (never an old rail); a person the server can't show says so", async () => {
    const { w, old, sam } = drawn();
    await w.mount(`/people/${old}`);
    const section = await screen.findByRole("region", { name: "Shared with" });
    await waitFor(() =>
      expect(section).toHaveTextContent("Only you can see this person."),
    );
    w.setOnline(false);
    await waitFor(() =>
      expect(section).toHaveTextContent(
        "Who it's shared with is checked when you're online.",
      ),
    );
    expect(section.querySelector("[data-rail-entry]")).toBeNull();
    cleanup();
    forgetAllPeopleMemory();
    const again = drawn();
    again.w.api.next.personSummary.push({ ok: false, kind: "not_found" });
    await again.w.mount(`/people/${sam}`);
    await shows("Atlas can't show who this person is shared with.");
  });
});

describe("field audience tags (finding 8)", () => {
  test("the field's own sharing, who can actually see it when it may be counted, and partial tags for another owner's field", async () => {
    const { w, mo } = drawn();
    const f = (n: number) =>
      `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
    w.putCache(fieldRow({ id: f(1), parent_id: mo, label: "Birthday" }));
    w.putCache(fieldRow({ id: f(2), parent_id: mo, label: "Phone" }));
    w.putCache(
      fieldRow({ id: f(3), parent_id: mo, label: "School", can_edit: false }),
    );
    const owned = (over: Partial<FieldAudience>): Partial<FieldAudience> => ({
      owner_is_you: true,
      your_access: "owner",
      ...over,
    });
    w.api.summary.fields.set(
      f(1),
      owned({
        audience: ownerHome,
        effective: {
          disclosure: "complete",
          account_count: 2,
          limited_count: 1,
        },
      }),
    );
    w.api.summary.fields.set(
      f(2),
      owned({
        audience: ownerHome,
        effective: {
          disclosure: "partial",
          account_count: null,
          limited_count: null,
        },
      }),
    );
    w.api.summary.fields.set(f(3), {
      owner_is_you: false,
      your_access: "view",
      audience: partialHome,
      effective: {
        disclosure: "partial",
        account_count: null,
        limited_count: null,
      },
    });
    await w.mount(`/people/${mo}`);
    const row = (n: number) =>
      document.querySelector(`[data-field-row="${f(n)}"]`) as HTMLElement;
    await waitFor(() =>
      expect(row(1)).toHaveTextContent("2 other people can see it."),
    );
    expect(
      within(row(1)).queryByRole("button", { name: "Home · can view" }),
    ).not.toBeNull();
    expect(row(1)).toHaveTextContent("1 person it's shared with can't see Mo.");
    expect(row(2)).toHaveTextContent(
      "Only people who can also see Mo can see it.",
    );
    expect(
      within(row(3)).queryByRole("button", { name: "Shared from Home" }),
    ).not.toBeNull();
    expect(row(3)).toHaveTextContent(
      "The owner may have shared it more widely.",
    );
    expect(screen.queryByText(/For fields someone else owns/)).not.toBeNull();
    expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toEqual([]);
    expect(reads(w, "readFieldAudiences")).toHaveLength(1);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("an older field summary than the cache, or offline, is never shown: the tag asks instead", async () => {
    const { w, ada } = drawn();
    const fid = "bbbbbbbb-bbbb-4bbb-8bbb-000000000009";
    w.putCache(
      fieldRow({ id: fid, parent_id: ada, label: "Phone", version: 4 }),
    );
    w.api.summary.fields.set(fid, { version: 3 });
    await w.mount(`/people/${ada}`);
    await waitFor(() => expect(reads(w, "readFieldAudiences")).toHaveLength(1));
    const row = document.querySelector(
      `[data-field-row="${fid}"]`,
    ) as HTMLElement;
    await waitFor(() =>
      expect(
        row.closest("section")?.querySelector("[data-summary-checked]"),
      ).not.toBeNull(),
    );
    expect(
      within(row).queryByRole("button", { name: "Who can see it?" }),
    ).not.toBeNull();
    w.api.summary.fields.delete(fid);
    w.setOnline(false);
    await shows("Who can see each field is checked when you're online.");
    expect(
      within(row).queryByRole("button", { name: "Who can see it?" }),
    ).not.toBeNull();
  });
});
