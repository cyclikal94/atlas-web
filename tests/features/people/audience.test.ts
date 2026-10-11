// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  audienceLabel,
  classify,
  fieldDefaultsLabel,
  personDefaultsLabel,
  quickPolicy,
  subjectNote,
} from "../../../src/features/people/model/audience";
import {
  linkageOf,
  unknownLinkage,
} from "../../../src/features/people/model/linkage";

/** Who can see a field, as the people screens say it (D-11a-7, D-11a-13), and the PPL-6 subject note. */
import { HOME, ME, MO, OTHER_HH, record } from "../../support/people/records";

describe("classify", () => {
  test("nobody granted is Only you", () => {
    expect(classify({ grants: [], exclude_accounts: [] }, HOME)).toEqual({
      kind: "only_you",
    });
  });

  test("one read grant to the primary household is Home · can view, counting exclusions", () => {
    const policy = {
      grants: [{ kind: "household" as const, id: HOME, edit: false }],
      exclude_accounts: [MO],
    };
    const audience = classify(policy, HOME);
    expect(audience).toEqual({
      kind: "home_view",
      householdId: HOME,
      excluded: 1,
    });
    expect(audienceLabel(audience, "Home")).toBe(
      "Home · can view · 1 excluded",
    );
  });

  test("anything else is Custom with a summary", () => {
    expect(
      classify(
        {
          grants: [{ kind: "household", id: HOME, edit: true }],
          exclude_accounts: [],
        },
        HOME,
      ),
    ).toEqual({ kind: "custom", summary: "Home · can edit" });
    expect(
      classify(
        {
          grants: [
            { kind: "household", id: OTHER_HH, edit: false },
            { kind: "account", id: MO, edit: true },
            { kind: "account", id: ME, edit: false },
          ],
          exclude_accounts: [],
        },
        HOME,
      ),
    ).toEqual({ kind: "custom", summary: "1 household, 2 people · mixed" });
  });
});

describe("quickPolicy", () => {
  test("Only you grants nobody, and drops exclusions", () => {
    expect(
      quickPolicy("only_you", { grants: [], exclude_accounts: [MO] }, HOME),
    ).toEqual({ grants: [], exclude_accounts: [] });
  });

  test("Home · can view grants the primary household read access and KEEPS exclusions", () => {
    expect(
      quickPolicy(
        "home",
        {
          grants: [{ kind: "account", id: MO, edit: true }],
          exclude_accounts: [MO],
        },
        HOME,
      ),
    ).toEqual({
      grants: [{ kind: "household", id: HOME, edit: false }],
      exclude_accounts: [MO],
    });
  });

  test("no primary household: Home cannot be chosen", () => {
    expect(quickPolicy("home", null, null)).toBeNull();
  });
});

describe("defaults labels (B5)", () => {
  test("the field template as the screens say it", () => {
    expect(fieldDefaultsLabel(record())).toBe("Only you");
    expect(
      fieldDefaultsLabel(
        record({ field: { kind: "primary_household", edit: false } }),
      ),
    ).toBe("Home · can view");
    expect(
      fieldDefaultsLabel(
        record({
          field: { kind: "primary_household", edit: false },
          primary: null,
        }),
      ),
    ).toBe("Only you");
    expect(personDefaultsLabel(record())).toBe("Home · can edit");
  });

  test("an unknown record is null, never 'Only you' by assumption (D-12a-16)", () => {
    expect(fieldDefaultsLabel(null)).toBeNull();
    expect(personDefaultsLabel(null)).toBeNull();
  });
});

describe("subjectNote (PPL-6)", () => {
  const other = linkageOf(
    { linked_account_id: MO, person: { version: 1 } },
    ME,
    0,
  );
  const note = (
    choice: "defaults" | "only_you" | "home" | "custom",
    over: Partial<Parameters<typeof subjectNote>[0]> = {},
  ) =>
    subjectNote({
      linkage: other,
      choice,
      personName: "Mo",
      homeMembers: [ME, MO],
      homeName: "Home",
      ...over,
    });

  test("defaults exclude the linked subject", () => {
    expect(note("defaults")).toBe(
      "Mo won't see this field unless you share it with them.",
    );
  });

  test("Home: the subject in Home will see it; unknown membership may", () => {
    expect(note("home")).toBe("Mo is in Home and will be able to see it.");
    expect(note("home", { homeMembers: [ME] })).toBeNull();
    expect(note("home", { homeMembers: null })).toBe(
      "Mo may be able to see it.",
    );
  });

  test("custom may; only you says nothing", () => {
    expect(note("custom")).toBe("Mo may be able to see it.");
    expect(note("only_you")).toBeNull();
  });

  test("nothing is said unless the person is KNOWN to be linked to another account", () => {
    expect(note("defaults", { linkage: unknownLinkage("offline") })).toBeNull();
    expect(
      note("defaults", {
        linkage: linkageOf(
          { linked_account_id: null, person: { version: 1 } },
          ME,
          0,
        ),
      }),
    ).toBeNull();
    expect(
      note("defaults", {
        linkage: linkageOf(
          { linked_account_id: ME, person: { version: 1 } },
          ME,
          0,
        ),
      }),
    ).toBeNull();
  });
});
