import { describe, expect, test } from "vitest";
import {
  accountPhrase,
  actorName,
  describeActivity,
  sentenceOf,
} from "../../../src/features/people/activity/describe";
import {
  formatSince,
  formatWhen,
  isoOf,
} from "../../../src/features/people/activity/format";
import {
  ACTIVITY_SUMMARIES,
  ACTIVITY_TYPES,
  type ActivityTarget,
  type ActivityType,
  parsePersonActivityPage,
} from "../../../src/features/people/model/activity";

/**
 * WEB-19 (A19-13): the strict parser of `GET /people/{id}/activity` against the pinned contract (`v0.31.0-rc.1`), and the client's
 * sentences (D-19-5). Every rejection rule of `model/activity.ts` has its own case; the backend docs' own example page is accepted.
 */
const P = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const F = "2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f";
const A = "7e6d5c4b-3a29-4f18-8e07-d6c5b4a39281";
const S = "3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a";
const E1 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const E2 = "1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";

/** The backend docs' example ("A reader's page after a field edit by a grantee and a merge of a person the reader never saw"). */
const DOC_EXAMPLE = {
  person_id: P,
  items: [
    {
      id: E1,
      occurred_at: 1793577600,
      type: "person_merged",
      summary: "Merged another profile into this person",
      actor: { kind: "account", account_id: A, username: "alice" },
      target: {
        kind: "person",
        id: P,
        label: "Morgan Lee",
        archived: false,
        state: "current",
      },
    },
    {
      id: E2,
      occurred_at: 1793574000,
      type: "field_edited",
      summary: "Edited a field",
      actor: { kind: "someone_else" },
      target: {
        kind: "field",
        id: F,
        label: "Hobby",
        archived: false,
        state: "current",
        field_kind: "text",
      },
      changed: ["value"],
    },
  ],
  next_after: E2,
  coverage_started_at: 1793491200,
};

type Json = Record<string, unknown>;
const clone = (): Json => JSON.parse(JSON.stringify(DOC_EXAMPLE));
const item = (page: Json, n: number): Json => (page.items as Json[])[n] as Json;

describe("parsePersonActivityPage: the contract's answer", () => {
  test("accepts the backend docs' example, in its order, as given", () => {
    const page = parsePersonActivityPage(clone(), 50);
    expect(page).toEqual(DOC_EXAMPLE);
  });

  test("accepts an empty first page (confirmed empty) with null next_after", () => {
    expect(
      parsePersonActivityPage(
        { person_id: P, items: [], next_after: null, coverage_started_at: 1 },
        5,
      ),
    ).toEqual({
      person_id: P,
      items: [],
      next_after: null,
      coverage_started_at: 1,
    });
  });

  test.each(ACTIVITY_TYPES.map((type) => [type] as const))(
    "accepts %s with its own phrase and members",
    (type: ActivityType) => {
      const page = clone();
      const event = item(page, 1);
      event.type = type;
      event.summary = ACTIVITY_SUMMARIES[type];
      if (type.startsWith("field_")) {
        if (type !== "field_edited") delete event.changed;
      } else {
        delete event.changed;
        event.target = {
          kind: "person",
          id: P,
          label: "Morgan Lee",
          archived: false,
          state: "current",
        };
      }
      if (type === "person_linked" || type === "person_unlinked")
        event.account = { kind: "you" };
      if (type === "person_merged") event.merged_from = { id: S, label: "M." };
      expect(parsePersonActivityPage(page, 50)?.items[1]?.type).toBe(type);
    },
  );

  test("the eleven types are the contract's enum, each with its fixed phrase", () => {
    expect(ACTIVITY_TYPES).toHaveLength(11);
    expect(new Set(Object.values(ACTIVITY_SUMMARIES)).size).toBe(11);
  });
});

describe("parsePersonActivityPage: refuses what is not the contract's answer", () => {
  const refuses = (change: (page: Json) => void, limit = 50) => {
    const page = clone();
    change(page);
    expect(parsePersonActivityPage(page, limit)).toBeNull();
  };

  test("a type outside the eleven (a sharing row, as the mock drew it)", () =>
    refuses((page) => {
      // Otherwise valid: only its type is not the contract's (no `changed`, which a field edit alone carries).
      item(page, 1).type = "field_policy_changed";
      item(page, 1).summary = "Narrowed a field";
      delete item(page, 1).changed;
    }));
  test("a summary that is not its type's phrase", () =>
    refuses((page) => {
      item(page, 1).summary = "Renamed this person";
    }));
  test("next_after that is not the last item's id", () =>
    refuses((page) => {
      page.next_after = E1;
    }));
  test("next_after on an empty page", () =>
    refuses((page) => {
      page.items = [];
    }));
  test("more items than the limit asked", () => refuses(() => undefined, 1));
  test("the same event id twice", () =>
    refuses((page) => {
      item(page, 1).id = E1;
      page.next_after = E1;
    }));
  test("an unknown top-level member", () =>
    refuses((page) => {
      page.total = 2;
    }));
  test("a missing top-level member", () =>
    refuses((page) => {
      delete page.coverage_started_at;
    }));
  test("a person_id that is not a UUID", () =>
    refuses((page) => {
      page.person_id = "me";
    }));
  test("an unknown event member (an old value)", () =>
    refuses((page) => {
      item(page, 1).previous_label = "Diagnosis";
    }));
  test("occurred_at that is not an integer", () =>
    refuses((page) => {
      item(page, 0).occurred_at = 1.5;
    }));
  test("changed on another type than field_edited", () =>
    refuses((page) => {
      item(page, 0).changed = ["label"];
    }));
  test("field_edited without changed", () =>
    refuses((page) => {
      delete item(page, 1).changed;
    }));
  test.each([
    [[]],
    [["value", "value"]],
    [["label", "value", "value"]],
    [["colour"]],
  ])("changed %j", (changed) =>
    refuses((page) => {
      item(page, 1).changed = changed;
    }),
  );
  test("account on another type than link/unlink", () =>
    refuses((page) => {
      item(page, 0).account = { kind: "you" };
    }));
  test("person_linked without account", () =>
    refuses((page) => {
      const event = item(page, 0);
      event.type = "person_linked";
      event.summary = ACTIVITY_SUMMARIES.person_linked;
    }));
  test("merged_from on another type than person_merged", () =>
    refuses((page) => {
      item(page, 1).merged_from = { id: S, label: "M." };
    }));
  test("merged_from with an extra member", () =>
    refuses((page) => {
      item(page, 0).merged_from = { id: S, label: "M.", archived: true };
    }));
  test("a field event about a person", () =>
    refuses((page) => {
      item(page, 1).target = {
        kind: "person",
        id: P,
        label: "Morgan",
        archived: false,
        state: "current",
      };
    }));
  test("a person event about a field", () =>
    refuses((page) => {
      item(page, 0).target = item(page, 1).target;
    }));
  test("canonical_person_id without state merged", () =>
    refuses((page) => {
      (item(page, 0).target as Json).canonical_person_id = S;
    }));
  test("state merged without canonical_person_id", () =>
    refuses((page) => {
      (item(page, 0).target as Json).state = "merged";
    }));
  test("a merged field", () =>
    refuses((page) => {
      Object.assign(item(page, 1).target as Json, {
        state: "merged",
        canonical_person_id: P,
      });
    }));
  test("field_kind on a person", () =>
    refuses((page) => {
      (item(page, 0).target as Json).field_kind = "text";
    }));
  test("an unknown field_kind", () =>
    refuses((page) => {
      (item(page, 1).target as Json).field_kind = "colour";
    }));
  test("an empty label, and one of 301 characters", () => {
    refuses((page) => {
      (item(page, 1).target as Json).label = "";
    });
    refuses((page) => {
      (item(page, 1).target as Json).label = "x".repeat(301);
    });
  });
  test("an actor naming an account without its id or with an extra member", () => {
    refuses((page) => {
      item(page, 0).actor = { kind: "account", username: "alice" };
    });
    refuses((page) => {
      item(page, 1).actor = { kind: "someone_else", account_id: A };
    });
    refuses((page) => {
      item(page, 1).actor = { kind: "owner" };
    });
  });
  test("a body that is not an object", () => {
    expect(parsePersonActivityPage(null, 5)).toBeNull();
    expect(parsePersonActivityPage([], 5)).toBeNull();
  });
});

describe("describeActivity (D-19-5): the client's sentence, current labels only", () => {
  const ctx = { personId: P };
  const page = parsePersonActivityPage(clone(), 50);
  const base = page?.items[1];
  if (base === undefined) throw new Error("example did not parse");
  const say = (over: Partial<typeof base>) =>
    sentenceOf(describeActivity({ ...base, ...over }, ctx));
  const person = {
    kind: "person" as const,
    id: P,
    label: "Morgan Lee",
    archived: false,
    state: "current" as const,
  };
  const alias = {
    kind: "person" as const,
    id: S,
    label: "Morgan Lewis",
    archived: true,
    state: "merged" as const,
    canonical_person_id: P,
  };

  test("person events say 'this person' on the reader's person, and name a merged profile", () => {
    const of = (type: ActivityType, target: ActivityTarget = person) =>
      say({ type, target, actor: { kind: "you" } });
    expect(of("person_created")).toBe("You added this person.");
    expect(of("person_renamed")).toBe("You renamed this person.");
    expect(of("person_archived")).toBe("You archived this person.");
    expect(of("person_restored")).toBe("You restored this person.");
    expect(of("person_created", alias)).toBe("You added Morgan Lewis.");
    // A rename never presents the label shown as the earlier one.
    expect(of("person_renamed", alias)).toBe(
      "You changed the name of Morgan Lewis.",
    );
  });

  test("field events name the field by its current label; an edit says which parts changed, never their content", () => {
    expect(say({ type: "field_created" })).toBe("Someone else added Hobby.");
    expect(say({ type: "field_archived" })).toBe(
      "Someone else archived Hobby.",
    );
    expect(say({ type: "field_restored" })).toBe(
      "Someone else restored Hobby.",
    );
    expect(say({ type: "field_edited", changed: ["value"] })).toBe(
      "Someone else changed the value of Hobby.",
    );
    expect(say({ type: "field_edited", changed: ["label"] })).toBe(
      "Someone else changed the name of Hobby.",
    );
    expect(say({ type: "field_edited", changed: ["label", "value"] })).toBe(
      "Someone else changed the name and value of Hobby.",
    );
  });

  test("link and unlink name the account as the reader may know it", () => {
    const alice = {
      kind: "account" as const,
      account_id: A,
      username: "alice",
    };
    const link = (
      actor: typeof alice | { kind: "you" } | { kind: "someone_else" },
      account: typeof alice | { kind: "you" } | { kind: "someone_else" },
      type: ActivityType = "person_linked",
    ) => say({ type, target: person, actor, account });
    expect(link({ kind: "you" }, { kind: "you" })).toBe(
      "You linked this person to your account.",
    );
    expect(link(alice, alice)).toBe(
      "alice linked this person to their account.",
    );
    expect(link({ kind: "you" }, alice)).toBe(
      "You linked this person to alice's account.",
    );
    expect(link({ kind: "someone_else" }, { kind: "someone_else" })).toBe(
      "Someone else linked this person to another account.",
    );
    expect(link(alice, { kind: "you" }, "person_unlinked")).toBe(
      "alice unlinked this person from your account.",
    );
    expect(
      accountPhrase({ kind: "someone_else" }, { kind: "someone_else" }),
    ).toBe("another account");
  });

  test("a merge names the source only when the server does", () => {
    expect(say({ type: "person_merged", target: person })).toBe(
      "Someone else merged another profile into this person.",
    );
    expect(
      say({
        type: "person_merged",
        target: person,
        merged_from: { id: S, label: "Mo" },
      }),
    ).toBe("Someone else merged Mo into this person.");
  });

  test("actors: You, the username, Someone else", () => {
    expect(actorName({ kind: "you" })).toBe("You");
    expect(
      actorName({ kind: "account", account_id: A, username: "alice" }),
    ).toBe("alice");
    expect(actorName({ kind: "someone_else" })).toBe("Someone else");
  });
});

describe("format (en-GB)", () => {
  // Midday UTC, so the date is the same in every time zone from UTC−11 to UTC+11.
  const noon = 1793750400 + 12 * 3600;
  test("since: day, short month, year", () => {
    expect(formatSince(noon)).toBe("4 Nov 2026");
  });
  test("when: the date and a 24-hour time; the machine-readable instant", () => {
    expect(formatWhen(noon)).toMatch(/^4 Nov 2026, \d{2}:\d{2}$/);
    expect(isoOf(noon)).toBe("2026-11-04T12:00:00.000Z");
  });
});
