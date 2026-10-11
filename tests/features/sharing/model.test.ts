// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  anonymousLabel,
  effectiveAudience,
  labelsFrom,
} from "../../../src/features/sharing/model/audience";
import {
  emptyPolicy,
  type PolicyDraftState,
  reducePolicy,
  samePolicy,
  toWirePolicy,
} from "../../../src/features/sharing/model/policy-draft";
import {
  policyRecoveryValues,
  restorePolicyDraft,
  restoreTemplateDraft,
  templateRecoveryValues,
} from "../../../src/features/sharing/model/recovery-fields";
import { freshForReview } from "../../../src/features/sharing/model/review";
import {
  canonicalBody,
  nextAttempt,
} from "../../../src/features/sharing/model/submission";
import {
  APPLICATION_DEFAULTS,
  describeTemplate,
  effectiveTemplate,
  resolvingLayer,
} from "../../../src/features/sharing/model/templates";
import {
  FLAT,
  HOME,
  household,
  JAMIE,
  ME,
  PRIYA,
  record,
  SAM,
} from "../../support/data/sharing";

/**
 * WEB-12a's pure editing models: FIXTURE data, no browser, no backend.
 */
const start = (): PolicyDraftState => ({
  policy: emptyPolicy(),
  refused: null,
});
const apply = (
  ...actions: Parameters<typeof reducePolicy>[1][]
): PolicyDraftState =>
  actions.reduce((state, action) => reducePolicy(state, action, ME), start());

describe("the policy draft reducer (WF-SHARING-04)", () => {
  test("adds account and household grants once each, read by default; Read/Edit and Remove change only their own row", () => {
    const state = apply(
      { type: "add_account", id: SAM },
      { type: "add_account", id: SAM, edit: true },
      { type: "add_household", id: HOME },
      { type: "set_edit", kind: "household", id: HOME, edit: true },
      { type: "add_account", id: JAMIE },
      { type: "remove", kind: "account", id: JAMIE },
    );
    expect(state.policy.grants).toEqual([
      { kind: "account", id: SAM, edit: false },
      { kind: "household", id: HOME, edit: true },
    ]);
    expect(state.refused).toBeNull();
  });

  test("MU-S14: the owner's own account is refused as a grantee and as an exclusion, and nothing changes", () => {
    const granted = apply({ type: "add_account", id: ME });
    expect(granted).toEqual({ policy: emptyPolicy(), refused: "owner" });
    const excluded = apply({ type: "exclude", id: ME });
    expect(excluded).toEqual({ policy: emptyPolicy(), refused: "owner" });
  });

  test("exclusions are unique and can be removed; a household grant is never refused as the owner", () => {
    const state = apply(
      { type: "exclude", id: PRIYA },
      { type: "exclude", id: PRIYA },
      { type: "add_household", id: FLAT },
    );
    expect(state.policy.exclude_accounts).toEqual([PRIYA]);
    expect(
      reducePolicy(state, { type: "include", id: PRIYA }, ME).policy
        .exclude_accounts,
    ).toEqual([]);
  });

  test("at most 100 grants and 100 exclusions", () => {
    const id = (n: number) =>
      `dddddddd-dddd-4ddd-8ddd-${n.toString(16).padStart(12, "0")}`;
    let state = start();
    for (let n = 1; n <= 100; n += 1)
      state = reducePolicy(state, { type: "add_account", id: id(n) }, ME);
    expect(state.policy.grants).toHaveLength(100);
    expect(
      reducePolicy(state, { type: "add_account", id: id(101) }, ME).refused,
    ).toBe("grant_limit");
    let ex = start();
    for (let n = 1; n <= 100; n += 1)
      ex = reducePolicy(ex, { type: "exclude", id: id(n) }, ME);
    expect(reducePolicy(ex, { type: "exclude", id: id(101) }, ME).refused).toBe(
      "exclusion_limit",
    );
  });

  test("the wire policy is canonical: households then accounts by id, exclusions sorted; samePolicy ignores order", () => {
    const a = {
      grants: [
        { kind: "account" as const, id: SAM, edit: false },
        { kind: "household" as const, id: HOME, edit: true },
      ],
      exclude_accounts: [PRIYA, JAMIE],
    };
    expect(toWirePolicy(a)).toEqual({
      grants: [
        { kind: "household", id: HOME, edit: true },
        { kind: "account", id: SAM, edit: false },
      ],
      exclude_accounts: [PRIYA, JAMIE].sort(),
    });
    expect(
      samePolicy(a, {
        grants: [...a.grants].reverse(),
        exclude_accounts: [JAMIE, PRIYA],
      }),
    ).toBe(true);
  });
});

describe("the effective audience", () => {
  const home = household({
    id: HOME,
    members: [
      { account_id: ME, username: "me", role: "manager" },
      { account_id: SAM, username: "sam", role: "member" },
      { account_id: PRIYA, username: "priya", role: "member" },
    ],
  });
  const labels = labelsFrom([home], [[JAMIE, "jamie"]]);

  test("MU-S13: an exclusion beats every grant, a direct grant included; the owner is never in the audience", () => {
    const audience = effectiveAudience({
      ownerId: ME,
      policy: {
        grants: [
          { kind: "household", id: HOME, edit: false },
          { kind: "account", id: PRIYA, edit: true },
        ],
        exclude_accounts: [PRIYA],
      },
      households: [home],
      complete: true,
      labels,
      parentLimited: false,
    });
    expect(audience.readers.map((p) => p.label)).toEqual(["sam"]);
    expect(audience.editors).toEqual([]);
    expect(audience.excluded.map((p) => p.label)).toEqual(["priya"]);
    expect(audience.owner).toEqual({ id: ME, label: "me" });
  });

  test("edit beats read for one person reached twice; a direct grant adds to a household grant", () => {
    const audience = effectiveAudience({
      ownerId: ME,
      policy: {
        grants: [
          { kind: "household", id: HOME, edit: false },
          { kind: "account", id: SAM, edit: true },
          { kind: "account", id: JAMIE, edit: false },
        ],
        exclude_accounts: [],
      },
      households: [home],
      complete: true,
      labels,
      parentLimited: true,
    });
    expect(audience.editors.map((p) => p.label)).toEqual(["sam"]);
    expect(audience.readers.map((p) => p.label)).toEqual(["jamie", "priya"]);
    expect(audience.parentLimited).toBe(true);
  });

  test("a household you are not in is shown as such; an unnamed account gets an abbreviated id, never a guessed name", () => {
    const audience = effectiveAudience({
      ownerId: ME,
      policy: {
        grants: [
          { kind: "household", id: FLAT, edit: true },
          {
            kind: "account",
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            edit: false,
          },
        ],
        exclude_accounts: [],
      },
      households: [home],
      complete: true,
      labels,
      parentLimited: false,
    });
    expect(audience.unknownHouseholds).toEqual([{ id: FLAT, edit: true }]);
    expect(audience.uncheckedHouseholds).toEqual([]);
    expect(audience.readers.map((p) => p.label)).toEqual([
      anonymousLabel("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    ]);
  });

  test("MU-S67: without a complete membership list, a granted household it does not name is unchecked, never one you are not in (R11, DA-M1)", () => {
    const audience = effectiveAudience({
      ownerId: ME,
      policy: {
        grants: [
          { kind: "household", id: HOME, edit: false },
          { kind: "household", id: FLAT, edit: true },
        ],
        exclude_accounts: [],
      },
      // The last list this editor read (a re-read is under way or failed): it still names Home's members.
      households: [home],
      complete: false,
      labels,
      parentLimited: false,
    });
    expect(audience.unknownHouseholds).toEqual([]);
    expect(audience.uncheckedHouseholds).toEqual([{ id: FLAT, edit: true }]);
    expect(audience.readers.map((p) => p.label)).toEqual(["priya", "sam"]);
  });
});

describe("the resolution chain (WF-SHARING-03, R4 fix)", () => {
  const set = (template: object | null, version: number) => ({
    template: template as never,
    version,
  });
  test("personal resolves only when its template exists; a version-0 or null template inherits", () => {
    expect(
      resolvingLayer({
        personal: set({ kind: "private" }, 2),
        household: set({ kind: "private" }, 1),
        primaryHouseholdId: HOME,
      }),
    ).toBe("personal");
    expect(
      resolvingLayer({
        personal: set(null, 0),
        household: set({ kind: "primary_household", edit: false }, 3),
        primaryHouseholdId: HOME,
      }),
    ).toBe("household");
    expect(
      resolvingLayer({
        personal: set(null, 4),
        household: set(null, 0),
        primaryHouseholdId: HOME,
      }),
    ).toBe("application");
    // Without a primary household the household layer cannot resolve.
    expect(
      resolvingLayer({
        personal: set(null, 0),
        household: set({ kind: "private" }, 1),
        primaryHouseholdId: null,
      }),
    ).toBe("application");
  });

  test("the effective template is the resolving layer's own value, else the application default", () => {
    expect(
      effectiveTemplate({
        kind: "person",
        personal: set(null, 0),
        household: set(null, 0),
        primaryHouseholdId: HOME,
      }),
    ).toEqual({ layer: "application", template: APPLICATION_DEFAULTS.person });
  });

  test("describeTemplate names the households and their members from the snapshot", () => {
    const snap = record().snapshot;
    const described = describeTemplate(
      { kind: "primary_household", edit: false },
      HOME,
      snap.households,
    );
    expect(described.summary).toBe("Primary household “Home” · read");
    expect(described.households).toEqual([
      {
        id: HOME,
        edit: false,
        name: "Home",
        members: [
          { id: ME, username: "me" },
          { id: SAM, username: "sam" },
        ],
      },
    ]);
    expect(
      describeTemplate({ kind: "primary_household", edit: true }, null, [])
        .summary,
    ).toBe("Private (no primary household)");
  });
});

describe("one idempotent attempt per body (D-12a-2)", () => {
  const keys = () => {
    let n = 0;
    return () => `k${++n}`;
  };
  test("MU-S11: the uncertain attempt is resent with the SAME key for the byte-identical body", () => {
    const newKey = keys();
    const first = nextAttempt(null, [{ kind: "x", n: 1 }], newKey);
    const retry = nextAttempt(first, [{ n: 1, kind: "x" }], newKey);
    expect(retry).toBe(first);
    expect(retry.key).toBe("k1");
  });
  test("MU-S12: a different body is a new attempt with a new key", () => {
    const newKey = keys();
    const first = nextAttempt(null, [{ kind: "x", n: 1 }], newKey);
    const changed = nextAttempt(first, [{ kind: "x", n: 2 }], newKey);
    expect(changed.key).toBe("k2");
    expect(changed.body).toBe(canonicalBody([{ kind: "x", n: 2 }]));
  });
  test("the canonical body sorts object keys at every depth and keeps array order", () => {
    expect(canonicalBody({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"b":1}',
    );
  });
});

describe("form recovery readiness (Q4)", () => {
  test("a policy and a template round-trip; a damaged value restores nothing", () => {
    const policy = {
      grants: [{ kind: "account" as const, id: SAM, edit: true }],
      exclude_accounts: [PRIYA],
    };
    expect(restorePolicyDraft(policyRecoveryValues(policy))).toEqual(policy);
    expect(restorePolicyDraft({ policy: "{" })).toBeNull();
    expect(restoreTemplateDraft(templateRecoveryValues(null))).toEqual({
      template: null,
    });
    expect(
      restoreTemplateDraft(templateRecoveryValues({ kind: "private" })),
    ).toEqual({ template: { kind: "private" } });
    expect(restoreTemplateDraft({ template: '{"kind":"public"}' })).toBeNull();
  });
});

describe("the review's Now (D-12a-6)", () => {
  test("MU-S9: only a record ASKED FOR after the review opened is Now; a persisted or earlier one is not", () => {
    expect(
      freshForReview(record(undefined, { issued_at: 999 }), 1_000),
    ).toBeNull();
    expect(
      freshForReview(record(undefined, { issued_at: 1_000 }), 1_000),
    ).not.toBeNull();
    expect(freshForReview(null, 0)).toBeNull();
  });
});
