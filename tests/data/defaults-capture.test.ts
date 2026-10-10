// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  captureDefaults,
  type DraftRow,
  defaultsReviewCase,
  parseDefaultsContext,
  parseSharingSnapshot,
  reviewKinds,
} from "../../src/data";
import { parseDefaultsRecord } from "../../src/data/model/sharing-snapshot";
import {
  ELSEWHERE,
  FLAT,
  HOME,
  household,
  PRIYA,
  record,
  revision,
  SAM,
  snapshot,
} from "../support/data/sharing";

/**
 * WEB-12a, B5 and WEB-04 §5.2/§5.7: the strict parser of `GET /defaults/snapshot`, the tolerant reader of the stored record, the capture
 * a queued create attaches and the four review cases. Pure functions: FIXTURE data, no backend.
 */
const clone = <T>(value: T): T => structuredClone(value);
/** A clone loosened so each case can break exactly one rule of the contract. */
// biome-ignore lint/suspicious/noExplicitAny: each case mutates a deliberately untyped clone of a valid body
type Loose = any;

describe("parseSharingSnapshot: the contract's SharingSnapshot, strictly", () => {
  test("a valid snapshot parses to an equal value", () => {
    const body = snapshot();
    expect(parseSharingSnapshot(clone(body))).toEqual(body);
  });

  test("an explicit template with account and household grants and exclusions parses", () => {
    const body = snapshot({
      templates: {
        field: {
          kind: "explicit",
          policy: {
            grants: [
              { kind: "account", id: SAM, edit: true },
              { kind: "household", id: FLAT, edit: false },
            ],
            exclude_accounts: [PRIYA],
          },
        },
      },
      households: [
        household({ id: HOME }),
        household({ id: FLAT, name: "Flat" }),
      ],
    });
    expect(parseSharingSnapshot(clone(body))).toEqual(body);
  });

  test.each([
    [
      "a revision that is not 64 lower-case hex",
      (b: Loose) => {
        b.defaults.revision = "A".repeat(64);
      },
    ],
    [
      "a revision of 63 characters",
      (b: Loose) => {
        b.defaults.revision = "a".repeat(63);
      },
    ],
    [
      "a missing template kind",
      (b: Loose) => {
        delete b.defaults.progress;
      },
    ],
    [
      "an unknown template kind",
      (b: Loose) => {
        b.defaults.task = { kind: "public" };
      },
    ],
    [
      "an extra key in the defaults",
      (b: Loose) => {
        b.defaults.extra = 1;
      },
    ],
    [
      "an extra key at the top",
      (b: Loose) => {
        b.extra = 1;
      },
    ],
    [
      "a primary household id that is not a uuid",
      (b: Loose) => {
        b.defaults.primary_household_id = "home";
      },
    ],
    [
      "preferences_version 0",
      (b: Loose) => {
        b.defaults.preferences_version = 0;
      },
    ],
    [
      "a member without a username",
      (b: Loose) => {
        delete b.households[0].members[0].username;
      },
    ],
    [
      "a member whose username is not text",
      (b: Loose) => {
        b.households[0].members[0].username = 7;
      },
    ],
    [
      "a member role outside the enum",
      (b: Loose) => {
        b.households[0].members[0].role = "owner";
      },
    ],
    [
      "a household with an empty name",
      (b: Loose) => {
        b.households[0].name = "";
      },
    ],
    [
      "a household name of 301 characters",
      (b: Loose) => {
        b.households[0].name = "x".repeat(301);
      },
    ],
    [
      "a household version 0",
      (b: Loose) => {
        b.households[0].version = 0;
      },
    ],
    [
      "a repeated household",
      (b: Loose) => {
        b.households.push(clone(b.households[0]));
      },
    ],
    [
      "a primary_household template without edit",
      (b: Loose) => {
        b.defaults.person = { kind: "primary_household" };
      },
    ],
    [
      "an explicit template with a repeated exclusion",
      (b: Loose) => {
        b.defaults.field = {
          kind: "explicit",
          policy: { grants: [], exclude_accounts: [PRIYA, PRIYA] },
        };
      },
    ],
    [
      "an explicit template with a grant of an unknown principal",
      (b: Loose) => {
        b.defaults.field = {
          kind: "explicit",
          policy: {
            grants: [{ kind: "group", id: SAM, edit: false }],
            exclude_accounts: [],
          },
        };
      },
    ],
  ])("refuses %s", (_name, mutate) => {
    const body = clone(snapshot()) as Loose;
    mutate(body);
    expect(parseSharingSnapshot(body)).toBeNull();
  });

  test("refuses more than 32 households and accepts exactly 32", () => {
    const id = (n: number) =>
      `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`;
    const of = (count: number) =>
      snapshot({
        households: Array.from({ length: count }, (_, n) =>
          household({ id: id(n + 1) }),
        ),
      });
    expect(parseSharingSnapshot(of(32))).not.toBeNull();
    expect(parseSharingSnapshot(of(33))).toBeNull();
  });

  test("refuses more than 100 members in a household and accepts exactly 100", () => {
    const member = (n: number) => ({
      account_id: `dddddddd-dddd-4ddd-8ddd-${n.toString(16).padStart(12, "0")}`,
      username: `u${n}`,
      role: "member" as const,
    });
    const of = (count: number) =>
      snapshot({
        households: [
          household({
            id: HOME,
            members: Array.from({ length: count }, (_, n) => member(n + 1)),
          }),
        ],
      });
    expect(parseSharingSnapshot(of(100))).not.toBeNull();
    expect(parseSharingSnapshot(of(101))).toBeNull();
  });

  test("refuses anything that is not an object", () => {
    for (const body of [null, "x", 1, [], undefined])
      expect(parseSharingSnapshot(body)).toBeNull();
  });
});

describe("parseDefaultsRecord: the stored field, tolerantly", () => {
  test("WEB-09a's seed (null), another format and damage all read as no record", () => {
    expect(parseDefaultsRecord(null)).toBeNull();
    expect(parseDefaultsRecord({ format: 2, snapshot: snapshot() })).toBeNull();
    expect(
      parseDefaultsRecord({ ...record(), snapshot: { defaults: {} } }),
    ).toBeNull();
    expect(parseDefaultsRecord({ ...record(), epoch: 0 })).toBeNull();
    expect(parseDefaultsRecord({ ...record(), issued_at: "x" })).toBeNull();
  });
  test("a record of this format reads back equal", () => {
    expect(parseDefaultsRecord(clone(record()))).toEqual(record());
  });
});

describe("captureDefaults: what a queued create carries (WEB-04 §5.2)", () => {
  test("with no record ever fetched: never_fetched, no revision, and EVERY requested kind needs review", () => {
    expect(captureDefaults(null, ["task", "progress", "task"])).toEqual({
      kind: "never_fetched",
      defaultsRevision: null,
      defaultsContext: null,
      defaultsReview: ["task", "progress"],
    });
  });

  test("a primary_household template captures the primary household's members from the SAME snapshot", () => {
    const capture = captureDefaults(record(), ["person"]);
    expect(capture.kind).toBe("captured");
    expect(capture.defaultsRevision).toBe(revision(1));
    expect(capture.defaultsReview).toEqual([]);
    expect(capture.defaultsContext).toEqual({
      format: "atlas-defaults-context-v1",
      revision: revision(1),
      fetched_at: 1_000,
      primary_household_id: HOME,
      kinds: {
        person: {
          template: { kind: "primary_household", edit: true },
          households: [snapshot().households[0]],
        },
      },
    });
  });

  test("an explicit template captures EVERY household it grants, not only the primary one (F7a)", () => {
    const flat = household({
      id: FLAT,
      name: "Flat",
      members: [{ account_id: SAM, username: "sam", role: "manager" }],
    });
    const snap = snapshot({
      templates: {
        task: {
          kind: "explicit",
          policy: {
            grants: [
              { kind: "household", id: FLAT, edit: false },
              { kind: "account", id: PRIYA, edit: false },
              { kind: "household", id: HOME, edit: true },
            ],
            exclude_accounts: [],
          },
        },
      },
      households: [household({ id: HOME }), flat],
    });
    const capture = captureDefaults(record(snap), ["task"]);
    expect(capture.defaultsContext?.kinds.task?.households).toEqual([
      flat,
      household({ id: HOME }),
    ]);
    expect(capture.defaultsReview).toEqual([]);
  });

  test("a household the template names that the snapshot does not list is captured as unavailable, and that kind needs review (F7b)", () => {
    const snap = snapshot({
      templates: {
        list: {
          kind: "explicit",
          policy: {
            grants: [{ kind: "household", id: ELSEWHERE, edit: false }],
            exclude_accounts: [],
          },
        },
      },
    });
    const capture = captureDefaults(record(snap), ["list", "progress"]);
    expect(capture.kind).toBe("captured");
    expect(capture.defaultsContext?.kinds.list?.households).toEqual([
      { id: ELSEWHERE, unavailable: true },
    ]);
    expect(capture.defaultsReview).toEqual(["list"]);
  });

  test("a private template names no household; a primary_household template without a primary household names none either", () => {
    expect(
      captureDefaults(record(), ["field"]).defaultsContext?.kinds.field,
    ).toEqual({ template: { kind: "private" }, households: [] });
    const none = captureDefaults(record(snapshot({ primary: null })), [
      "person",
    ]);
    expect(none.defaultsContext?.kinds.person?.households).toEqual([]);
    expect(none.defaultsReview).toEqual([]);
  });

  test("the captured context reads back through parseDefaultsContext", () => {
    const context = captureDefaults(record(), [
      "person",
      "progress",
    ]).defaultsContext;
    expect(parseDefaultsContext(clone(context))).toEqual(context);
  });

  test("parseDefaultsContext reads WEB-09a's seed and foreign data as not recorded", () => {
    expect(parseDefaultsContext({ kind: "defaults", kinds: [] })).toBeNull();
    expect(parseDefaultsContext(null)).toBeNull();
    expect(
      parseDefaultsContext({
        format: "atlas-defaults-context-v1",
        revision: "nope",
        fetched_at: 1,
        primary_household_id: null,
        kinds: {},
      }),
    ).toBeNull();
  });
});

describe("defaultsReviewCase: WEB-04 §5.7's four copies", () => {
  const draft = (
    over: Partial<DraftRow>,
  ): Pick<DraftRow, "status" | "defaults_revision" | "defaults_context"> => {
    const capture = captureDefaults(record(), ["person"]);
    return {
      status: "queued",
      defaults_revision: capture.defaultsRevision,
      defaults_context: capture.defaultsContext,
      ...over,
    };
  };
  test("1. nothing was captured: never_fetched", () => {
    expect(
      defaultsReviewCase(
        draft({ defaults_revision: null, defaults_context: null }),
        snapshot(),
      ),
    ).toBe("never_fetched");
    // A foreign context (WEB-09a's seed) is not a captured audience either.
    expect(
      defaultsReviewCase(
        draft({ defaults_context: { kind: "defaults", kinds: [] } }),
        snapshot(),
      ),
    ).toBe("never_fetched");
  });
  test("2. sent and refused with defaults_changed (in_flight with its block): changed_rejected", () => {
    expect(
      defaultsReviewCase(
        draft({ status: "in_flight" }),
        snapshot({ revision: revision(2) }),
      ),
    ).toBe("changed_rejected");
  });
  test("3. queued, never sent, same revision: review_unchanged", () => {
    expect(defaultsReviewCase(draft({}), snapshot())).toBe("review_unchanged");
  });
  test("4. queued, never sent, revision moved: changed_never_sent", () => {
    expect(
      defaultsReviewCase(draft({}), snapshot({ revision: revision(2) })),
    ).toBe("changed_never_sent");
  });
});

describe("reviewKinds", () => {
  test("the block's kinds first, else the captured context's", () => {
    const context = captureDefaults(record(), [
      "person",
      "progress",
    ]).defaultsContext;
    expect(
      reviewKinds({
        review_block: { kind: "defaults", kinds: ["task"] },
        defaults_context: context,
      }),
    ).toEqual(["task"]);
    expect(
      reviewKinds({
        review_block: { kind: "defaults", kinds: [] },
        defaults_context: context,
      }),
    ).toEqual(["person", "progress"]);
    expect(
      reviewKinds({
        review_block: { kind: "defaults", kinds: ["nonsense"] },
        defaults_context: null,
      }),
    ).toEqual([]);
  });
});
