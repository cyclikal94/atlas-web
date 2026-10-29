// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  audienceLabel,
  classify,
  fieldDefaultsLabel,
  personDefaultsLabel,
  quickPolicy,
  selectedPolicy,
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
  // The policy each choice leaves by default: Home · can view and a custom one, neither excluding anyone.
  const policyFor = {
    defaults: null,
    only_you: { grants: [], exclude_accounts: [] },
    home: {
      grants: [{ kind: "household" as const, id: HOME, edit: false }],
      exclude_accounts: [],
    },
    custom: {
      grants: [{ kind: "account" as const, id: MO, edit: false }],
      exclude_accounts: [],
    },
  };
  const note = (
    choice: "defaults" | "only_you" | "home" | "custom",
    over: Partial<Parameters<typeof subjectNote>[0]> = {},
  ) =>
    subjectNote({
      linkage: other,
      choice,
      policy: policyFor[choice],
      personName: "Mo",
      homeMembers: [ME, MO],
      homeName: "Home",
      ...over,
    });
  const INCLUDED =
    "Mo is in Home, so this sharing includes them. They'll see it if they can also see this profile.";
  const EXCLUDED =
    "Mo is excluded from this field's sharing, so they won't see it.";

  test("defaults exclude the linked subject", () => {
    expect(note("defaults")).toBe(
      "Mo won't see this field unless you share it with them.",
    );
  });

  // Copy adaptation (review 22, R22.1): this case expected "Mo is in Home and will be able to see it." (D-11a-7's wording). That
  // promise is not known to be true even without an exclusion (the subject must also see the person the field is on), so the same
  // fixture now asserts the qualified sentence; the old sentence is asserted absent.
  test("Home: the subject in Home is included by its sharing, as far as this page can know; unknown membership may", () => {
    expect(note("home")).toBe(INCLUDED);
    expect(note("home")).not.toBe("Mo is in Home and will be able to see it.");
    expect(note("home", { homeMembers: [ME] })).toBeNull();
    expect(note("home", { homeMembers: null })).toBe(
      "Mo may be able to see it.",
    );
  });

  test("custom may; only you says nothing", () => {
    expect(note("custom")).toBe("Mo may be able to see it.");
    expect(note("only_you")).toBeNull();
  });

  test("R22.1: a Home policy that excludes the subject says they won't see it, never that they will", () => {
    const excluding = { ...policyFor.home, exclude_accounts: [MO] };
    expect(note("home", { policy: excluding })).toBe(EXCLUDED);
    // ... whatever is known of Home's membership: the exclusion alone decides.
    expect(note("home", { policy: excluding, homeMembers: null })).toBe(
      EXCLUDED,
    );
    expect(note("home", { policy: excluding, homeMembers: [ME] })).toBe(
      EXCLUDED,
    );
  });

  test("R22.1: an exclusion of ANOTHER account says nothing of the subject (the identity decides, not the count)", () => {
    const other_ = { ...policyFor.home, exclude_accounts: [ME] };
    expect(note("home", { policy: other_ })).toBe(INCLUDED);
    expect(
      note("custom", {
        policy: { ...policyFor.custom, exclude_accounts: [ME] },
      }),
    ).toBe("Mo may be able to see it.");
  });

  test("R22.1: a custom policy that excludes the subject says so; one that doesn't still only may", () => {
    expect(
      note("custom", {
        policy: {
          grants: [{ kind: "household", id: HOME, edit: true }],
          exclude_accounts: [MO],
        },
      }),
    ).toBe(EXCLUDED);
    expect(note("custom")).toBe("Mo may be able to see it.");
  });

  test("R22.1: Home with its policy not known may (its exclusions are not known), even with membership known", () => {
    expect(note("home", { policy: null })).toBe("Mo may be able to see it.");
    expect(note("home", { policy: null, homeMembers: [ME, MO] })).not.toBe(
      INCLUDED,
    );
  });

  test("R22.1: defaults keep the creation rule, and Only you says nothing, whatever the policy excludes", () => {
    expect(note("defaults", { policy: null })).toBe(
      "Mo won't see this field unless you share it with them.",
    );
    expect(
      note("only_you", { policy: { grants: [], exclude_accounts: [MO] } }),
    ).toBeNull();
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

describe("selectedPolicy (R22.1): the policy a save leaves, the one the subject note describes", () => {
  const HOME_VIEW = {
    grants: [{ kind: "household" as const, id: HOME, edit: false }],
    exclude_accounts: [MO],
  };
  const PRIVATE_EXCLUDING = { grants: [], exclude_accounts: [MO] };
  const CUSTOM = {
    grants: [{ kind: "account" as const, id: ME, edit: true }],
    exclude_accounts: [MO],
  };
  const pick = (over: Partial<Parameters<typeof selectedPolicy>[0]>) =>
    selectedPolicy({
      choice: "home",
      isNew: false,
      current: HOME_VIEW,
      changed: false,
      primaryHouseholdId: HOME,
      ...over,
    });

  test("R22.1: an unchanged choice keeps the current policy exactly, exclusions and all", () => {
    expect(pick({})).toEqual(HOME_VIEW);
    expect(pick({ choice: "custom", current: CUSTOM })).toEqual(CUSTOM);
    expect(pick({ choice: "only_you", current: PRIVATE_EXCLUDING })).toEqual(
      PRIVATE_EXCLUDING,
    );
  });

  test("R22.1: a change to Home keeps the current exclusions (D-11a-7), as the save sends them", () => {
    expect(
      pick({ choice: "home", current: PRIVATE_EXCLUDING, changed: true }),
    ).toEqual({
      grants: [{ kind: "household", id: HOME, edit: false }],
      exclude_accounts: [MO],
    });
    expect(pick({ choice: "home", current: CUSTOM, changed: true })).toEqual({
      grants: [{ kind: "household", id: HOME, edit: false }],
      exclude_accounts: [MO],
    });
    // ... and the same as `quickPolicy` (one derivation for the save and the note).
    expect(
      pick({ choice: "home", current: PRIVATE_EXCLUDING, changed: true }),
    ).toEqual(quickPolicy("home", PRIVATE_EXCLUDING, HOME));
  });

  test("R22.1: a change to Only you grants nobody", () => {
    expect(pick({ choice: "only_you", changed: true })).toEqual({
      grants: [],
      exclude_accounts: [],
    });
  });

  test("R22.1: a policy not read is not known, never an empty one in its place", () => {
    expect(pick({ current: null })).toBeNull();
    expect(pick({ current: null, changed: true })).toBeNull();
    expect(pick({ choice: "custom", changed: true })).toBeNull();
    expect(pick({ changed: true, primaryHouseholdId: null })).toBeNull();
  });

  test("R22.1: a new field: defaults are the server's, Home grants it with no exclusion, Only you nobody", () => {
    const fresh = (choice: "defaults" | "only_you" | "home") =>
      pick({ choice, isNew: true, current: null });
    expect(fresh("defaults")).toBeNull();
    expect(fresh("home")).toEqual({
      grants: [{ kind: "household", id: HOME, edit: false }],
      exclude_accounts: [],
    });
    expect(fresh("only_you")).toEqual({ grants: [], exclude_accounts: [] });
    expect(
      pick({
        choice: "home",
        isNew: true,
        current: null,
        primaryHouseholdId: null,
      }),
    ).toBeNull();
  });
});
