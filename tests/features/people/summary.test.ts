import { describe, expect, test } from "vitest";
import {
  type AudienceSummary,
  attributionOf,
  audienceText,
  effectiveText,
  type PersonSummary,
  parseAudience,
  parseFieldAudience,
  parsePersonSummary,
  parsePersonSummaryDetail,
  parseSharedWith,
  parseSummaryPage,
  summaryCurrentFor,
} from "../../../src/features/people/model/summary";

/**
 * The viewer-safe summaries' strict parsing and wording (finding 8; API 0.29). The documented examples are the backend's own, copied
 * VERBATIM from `docs/people.md` at the accepted commit 4396c99 ("Viewer-safe summaries"): the parser must take every one of them.
 */
const DOC_PERSON = JSON.parse(
  `{"id": "6f1c2a4e-8b2d-4c55-9a77-3f0e1d2c4b5a", "label": "Mo", "version": 1, "policy_version": 1, "archived": false, "linkage": "none", "linked_account_id": null, "owner": {"account_id": "0d6c1b9e-2f3a-4e5d-8c7b-1a2b3c4d5e6f", "username": "alice", "you": false, "person": null}, "added_by_you": "no", "your_access": "view", "field_count": 1, "audience": {"disclosure": "partial", "in_home": true, "households": [{"id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "can_edit": false, "you_are_member": true, "name": "Atlas Home", "version": 3, "member_count": 2}], "your_direct_grant": null, "direct_grant_count": null, "excluded_count": null}}`,
);
const DOC_RAIL = JSON.parse(
  `{"disclosure": "partial", "owner": {"account_id": "0d6c1b9e-2f3a-4e5d-8c7b-1a2b3c4d5e6f", "username": "alice", "you": false, "person": null}, "accounts": [], "households": [{"id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "can_edit": false, "you_are_member": true, "name": "Atlas Home", "version": 3, "member_count": 2, "members": null}], "excluded_accounts": null}`,
);
const DOC_EMPTY_PAGE = JSON.parse(
  `{"items": [], "next_after": null, "home": null, "preferences_version": 2}`,
);
const DOC_FIELD_OWNER = JSON.parse(
  `{"id": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a", "version": 1, "policy_version": 1, "archived": false, "owner_is_you": true, "your_access": "owner", "audience": {"disclosure": "complete", "in_home": true, "households": [{"id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "can_edit": false, "you_are_member": true, "name": "Atlas Home", "version": 3, "member_count": 3}], "your_direct_grant": null, "direct_grant_count": 0, "excluded_count": 0}, "effective": {"disclosure": "complete", "account_count": 1, "limited_count": 1}}`,
);
const DOC_FIELD_LEFT = JSON.parse(
  `{"id": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a", "version": 1, "policy_version": 1, "archived": false, "owner_is_you": true, "your_access": "owner", "audience": {"disclosure": "complete", "in_home": false, "households": [{"id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "can_edit": false, "you_are_member": false, "name": null, "version": null, "member_count": null}], "your_direct_grant": null, "direct_grant_count": 0, "excluded_count": 0}, "effective": {"disclosure": "partial", "account_count": null, "limited_count": null}}`,
);
const DOC_FIELD_DIRECT = JSON.parse(
  `{"id": "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c", "version": 1, "policy_version": 1, "archived": false, "owner_is_you": true, "your_access": "owner", "audience": {"disclosure": "complete", "in_home": false, "households": [], "your_direct_grant": null, "direct_grant_count": 1, "excluded_count": 0}, "effective": {"disclosure": "partial", "account_count": null, "limited_count": null}}`,
);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const query = { after: null, limit: 100, archived: false };

describe("strict parsing", () => {
  test("every documented example is accepted exactly", () => {
    expect(parsePersonSummary(DOC_PERSON)).toEqual(DOC_PERSON);
    expect(parseSharedWith(DOC_RAIL)).toEqual(DOC_RAIL);
    expect(parseSummaryPage(DOC_EMPTY_PAGE, query, parsePersonSummary)).toEqual(
      DOC_EMPTY_PAGE,
    );
    for (const field of [DOC_FIELD_OWNER, DOC_FIELD_LEFT, DOC_FIELD_DIRECT])
      expect(parseFieldAudience(field)).toEqual(field);
    expect(
      parsePersonSummaryDetail({
        summary: DOC_PERSON,
        shared_with: DOC_RAIL,
        home: null,
        preferences_version: 2,
      }),
    ).not.toBeNull();
  });

  test("an added or missing key is refused (additionalProperties: false)", () => {
    expect(parsePersonSummary({ ...DOC_PERSON, extra: 1 })).toBeNull();
    const { field_count: _f, ...missing } = DOC_PERSON;
    expect(parsePersonSummary(missing)).toBeNull();
    expect(parseSharedWith({ ...DOC_RAIL, members: [] })).toBeNull();
  });

  test("a partial audience never carries counts or a hidden exclusion; a complete one is the owner's", () => {
    const counted = clone(DOC_PERSON);
    counted.audience.direct_grant_count = 0;
    expect(parsePersonSummary(counted)).toBeNull();
    // Complete for a reader who is not the owner: refused.
    const widened = clone(DOC_PERSON);
    widened.audience = {
      disclosure: "complete",
      in_home: true,
      households: [],
      your_direct_grant: null,
      direct_grant_count: 0,
      excluded_count: 0,
    };
    expect(parsePersonSummary(widened)).toBeNull();
    // A partial rail that expands a household or names an exclusion: refused.
    const expanded = clone(DOC_RAIL);
    expanded.households[0].members = [];
    expect(parseSharedWith(expanded)).toBeNull();
    const excluded = clone(DOC_RAIL);
    excluded.excluded_accounts = [];
    expect(parseSharedWith(excluded)).toBeNull();
    // `effective` counts only when complete, and complete only for the field's owner.
    const counts = clone(DOC_FIELD_LEFT);
    counts.effective.account_count = 0;
    expect(parseFieldAudience(counts)).toBeNull();
    const notOwner = clone(DOC_FIELD_OWNER);
    notOwner.owner_is_you = false;
    notOwner.your_access = "view";
    notOwner.audience = clone(DOC_PERSON.audience);
    expect(parseFieldAudience(notOwner)).toBeNull();
    notOwner.effective = {
      disclosure: "partial",
      account_count: null,
      limited_count: null,
    };
    expect(parseFieldAudience(notOwner)).not.toBeNull();
  });

  test("access and ownership agree; linkage and its account agree; redaction is whole", () => {
    const access = clone(DOC_PERSON);
    access.your_access = "owner";
    expect(parsePersonSummary(access)).toBeNull();
    const linked = clone(DOC_PERSON);
    linked.linkage = "other";
    expect(parsePersonSummary(linked)).toBeNull();
    linked.linked_account_id = "0d6c1b9e-2f3a-4e5d-8c7b-1a2b3c4d5e6f";
    expect(parsePersonSummary(linked)).not.toBeNull();
    const half = clone(DOC_FIELD_LEFT);
    half.audience.households[0].name = "Atlas Home";
    expect(parseFieldAudience(half)).toBeNull();
  });

  test("a page is in ascending id order after its cursor, of the asked archived state, with its next cursor the last id", () => {
    const a = {
      ...clone(DOC_PERSON),
      id: "00000000-0000-4000-8000-000000000001",
    };
    const b = {
      ...clone(DOC_PERSON),
      id: "00000000-0000-4000-8000-000000000002",
    };
    const page = (items: unknown[], next: string | null) => ({
      items,
      next_after: next,
      home: null,
      preferences_version: 1,
    });
    expect(
      parseSummaryPage(page([a, b], null), query, parsePersonSummary),
    ).not.toBeNull();
    expect(
      parseSummaryPage(page([b, a], null), query, parsePersonSummary),
    ).toBeNull();
    expect(
      parseSummaryPage(
        page([a], null),
        { ...query, after: a.id },
        parsePersonSummary,
      ),
    ).toBeNull();
    expect(
      parseSummaryPage(page([a, b], b.id), query, parsePersonSummary),
    ).not.toBeNull();
    expect(
      parseSummaryPage(page([a, b], a.id), query, parsePersonSummary),
    ).toBeNull();
    expect(
      parseSummaryPage(
        page([a], null),
        { ...query, archived: true },
        parsePersonSummary,
      ),
    ).toBeNull();
    expect(
      parseSummaryPage(
        page([a, b], null),
        { ...query, limit: 1 },
        parsePersonSummary,
      ),
    ).toBeNull();
  });

  test("labels are limited in characters as the server counts them, not UTF-16 units (review 2, finding 5)", () => {
    // Every label position: the person's own, the owner's visible person, a household's name, the primary household's.
    const withLabel = (text: string) => {
      const summary = clone(DOC_PERSON);
      summary.label = text;
      return summary;
    };
    const withOwnerPerson = (text: string) => {
      const summary = clone(DOC_PERSON);
      summary.owner.person = {
        id: "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d",
        label: text,
      };
      return summary;
    };
    const withHousehold = (text: string) => {
      const summary = clone(DOC_PERSON);
      summary.audience.households[0].name = text;
      return summary;
    };
    const detailWithHome = (text: string) =>
      parsePersonSummaryDetail({
        summary: DOC_PERSON,
        shared_with: DOC_RAIL,
        home: {
          id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
          name: text,
          version: 3,
          member_count: 2,
        },
        preferences_version: 2,
      });
    const emoji = (count: number) => "😀".repeat(count);
    const mixed = `${"é".repeat(150)}${emoji(150)}`; // 300 characters, 450 UTF-16 units
    for (const build of [withLabel, withOwnerPerson, withHousehold]) {
      expect(parsePersonSummary(build("A".repeat(300)))).not.toBeNull();
      expect(parsePersonSummary(build(emoji(200)))).not.toBeNull();
      expect(parsePersonSummary(build(emoji(300)))).not.toBeNull();
      expect(parsePersonSummary(build(mixed))).not.toBeNull();
      expect(parsePersonSummary(build(emoji(1)))).not.toBeNull();
      expect(parsePersonSummary(build("A".repeat(301)))).toBeNull();
      expect(parsePersonSummary(build(emoji(301)))).toBeNull();
      expect(parsePersonSummary(build(""))).toBeNull();
    }
    expect(detailWithHome(emoji(300))).not.toBeNull();
    expect(detailWithHome(emoji(301))).toBeNull();
    expect(detailWithHome("")).toBeNull();
    // The field-audience and rail envelopes share the household parser.
    const field = clone(DOC_FIELD_OWNER);
    field.audience.households[0].name = emoji(300);
    expect(parseFieldAudience(field)).not.toBeNull();
    field.audience.households[0].name = emoji(301);
    expect(parseFieldAudience(field)).toBeNull();
    const rail = clone(DOC_RAIL);
    rail.households[0].name = emoji(300);
    expect(parseSharedWith(rail)).not.toBeNull();
    rail.households[0].name = emoji(301);
    expect(parseSharedWith(rail)).toBeNull();
  });

  test("the detail's rail and summary come from one snapshot (same owner, same disclosure)", () => {
    const other = clone(DOC_RAIL);
    other.owner.account_id = "11111111-1111-4111-8111-111111111111";
    expect(
      parsePersonSummaryDetail({
        summary: DOC_PERSON,
        shared_with: other,
        home: null,
        preferences_version: 2,
      }),
    ).toBeNull();
  });
});

describe("what the screens say", () => {
  const owner = (over: Partial<AudienceSummary> = {}): AudienceSummary => ({
    disclosure: "complete",
    in_home: false,
    households: [],
    your_direct_grant: null,
    direct_grant_count: 0,
    excluded_count: 0,
    ...over,
  });
  const home = {
    id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    can_edit: false,
    you_are_member: true,
    name: "Atlas Home",
    version: 3,
    member_count: 4,
  };

  test("the owner's audience: Only you, one household with its role and exclusions, or counts; never household size", () => {
    expect(audienceText(owner())).toBe("Only you");
    expect(audienceText(owner({ in_home: true, households: [home] }))).toBe(
      "Atlas Home · can view",
    );
    expect(
      audienceText(
        owner({ households: [{ ...home, can_edit: true }], excluded_count: 1 }),
      ),
    ).toBe("Atlas Home · can edit · 1 excluded");
    expect(
      audienceText(
        owner({
          households: [
            home,
            {
              ...home,
              id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6e",
              can_edit: true,
            },
          ],
          direct_grant_count: 2,
        }),
      ),
    ).toBe("2 households, 2 people · mixed");
    expect(
      audienceText(
        owner({
          households: [
            {
              ...home,
              name: null,
              version: null,
              member_count: null,
              you_are_member: false,
            },
          ],
        }),
      ),
    ).toBe("A household you've left · can view");
    // The size (4) is never said as an audience.
    expect(audienceText(owner({ households: [home] }))).not.toContain("4");
  });

  test("a reader's partial audience names only what reaches them, and is never 'Only you'", () => {
    const partial = parseAudience(DOC_PERSON.audience) as AudienceSummary;
    expect(audienceText(partial)).toBe("Shared from Atlas Home");
    expect(
      audienceText({
        ...partial,
        households: [],
        your_direct_grant: { can_edit: true },
      }),
    ).toBe("Shared with you");
    expect(
      audienceText({ ...partial, your_direct_grant: { can_edit: false } }),
    ).toBe("Shared from Atlas Home and with you");
    expect(audienceText({ ...partial, households: [] })).not.toBe("Only you");
  });

  test("who can actually see a field is counted only when complete", () => {
    expect(effectiveText(DOC_FIELD_OWNER.effective, "Mo")).toBe(
      "1 other person can see it. 1 person it's shared with can't see Mo.",
    );
    expect(
      effectiveText(
        { disclosure: "complete", account_count: 0, limited_count: 0 },
        "Mo",
      ),
    ).toBe("Nobody else can see it.");
    expect(effectiveText(DOC_FIELD_LEFT.effective, "Mo")).toBeNull();
  });

  test("attribution is separate from ownership; unknown claims nothing", () => {
    const base = parsePersonSummary(DOC_PERSON) as PersonSummary;
    expect(attributionOf(base)).toEqual({ kind: "shared_by", owner: "alice" });
    expect(
      attributionOf({
        ...base,
        owner: { ...base.owner, person: { id: base.id, label: "Alice B" } },
      }),
    ).toEqual({ kind: "shared_by", owner: "Alice B" });
    expect(attributionOf({ ...base, added_by_you: "yes" })).toEqual({
      kind: "added_by_you",
    });
    expect(attributionOf({ ...base, linkage: "you" })).toEqual({ kind: "you" });
    const mine = {
      ...base,
      owner: { ...base.owner, you: true },
      your_access: "owner" as const,
    };
    expect(attributionOf({ ...mine, added_by_you: "unknown" })).toEqual({
      kind: "none",
    });
    expect(attributionOf({ ...mine, added_by_you: "no" })).toEqual({
      kind: "none",
    });
  });

  test("a summary older than the cached projection is not shown beside it", () => {
    expect(
      summaryCurrentFor(
        { version: 3, policy_version: 2 },
        { version: 3, policy_version: 2 },
      ),
    ).toBe(true);
    expect(
      summaryCurrentFor(
        { version: 4, policy_version: 2 },
        { version: 3, policy_version: 2 },
      ),
    ).toBe(true);
    expect(
      summaryCurrentFor(
        { version: 2, policy_version: 2 },
        { version: 3, policy_version: 2 },
      ),
    ).toBe(false);
    expect(
      summaryCurrentFor(
        { version: 3, policy_version: 1 },
        { version: 3, policy_version: 2 },
      ),
    ).toBe(false);
    expect(summaryCurrentFor({ version: 1, policy_version: 1 }, null)).toBe(
      true,
    );
  });
});
