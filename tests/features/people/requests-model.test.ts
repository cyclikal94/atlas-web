import { describe, expect, test } from "vitest";
import { classifyPeopleAnswer } from "../../../src/features/people/api";
import type { LinkageState } from "../../../src/features/people/model/linkage";
import {
  cancelBody,
  comparisonRows,
  conflictLabels,
  isMergedAlias,
  mergeBody,
  mergeNaming,
  mergeRecipient,
  parseIncomingRequests,
  parseMergePreview,
  parseRecipientPreview,
  parseSentPage,
  requestLinkBody,
  requestMergeBody,
  respondBody,
  senderName,
  timeLeft,
} from "../../../src/features/people/model/requests";
import type { PersonSummary } from "../../../src/features/people/model/summary";

/**
 * WEB-11b's pure model (§3.2, A1–A6, A9): the strict parsers of the four reads, the five command bodies, and what the screens decide
 * (time left, the sender's name, the merge's name rule, the comparison's values, the conflict note, who accepts, merged aliases), plus
 * the people classifier's two new refusals (`expired`, `capacity`).
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const R1 = "10000000-0000-4000-8000-000000000001";
const R2 = "10000000-0000-4000-8000-000000000002";
const TOKEN = "f".repeat(64);
const person = (id: string, label: string, extra: object = {}) => ({
  id,
  kind: "person",
  parent_id: null,
  label,
  value: null,
  version: 3,
  can_edit: true,
  archived: false,
  policy_version: 1,
  ...extra,
});
const known = (kind: "self" | "other" | "unlinked"): LinkageState => ({
  known: true,
  kind,
  accountId: kind === "unlinked" ? null : A,
  version: 1,
  readAt: 0,
});

describe("incoming requests (GET /people/requests)", () => {
  const link = {
    id: R1,
    sender_id: A,
    expires_at: 1_800_000_000,
    proposal: { kind: "link", person_id: B, account_id: C, name: "Ada" },
  };
  test("a contract answer parses; link and merge proposals", () => {
    const merge = {
      id: R2,
      sender_id: A,
      expires_at: 1_800_000_000,
      proposal: { kind: "merge", source_id: B, target_id: C, name: "Mo" },
    };
    expect(parseIncomingRequests({ items: [link, merge] })).toEqual([
      link,
      merge,
    ]);
  });
  test.each([
    ["an extra key", { items: [{ ...link, sender_username: "mo" }] }],
    ["a bad UUID", { items: [{ ...link, id: "x" }] }],
    ["milliseconds as a float", { items: [{ ...link, expires_at: 1.5 }] }],
    [
      "an unknown proposal",
      { items: [{ ...link, proposal: { ...link.proposal, kind: "own" } }] },
    ],
    [
      "a name over 200",
      {
        items: [
          { ...link, proposal: { ...link.proposal, name: "x".repeat(201) } },
        ],
      },
    ],
    ["more than 100", { items: Array.from({ length: 101 }, () => link) }],
    ["no items", {}],
  ])("%s is not the contract's answer", (_, body) => {
    expect(parseIncomingRequests(body)).toBeNull();
  });
});

describe("sent history (GET /people/requests/sent)", () => {
  const sent = (id: string, state: string) => ({
    id,
    recipient_id: C,
    recipient_username: "mo",
    expires_at: 1_800_000_000,
    state,
    proposal: { kind: "link", person_id: B, account_id: C, name: "Ada" },
  });
  test("every state parses; an empty page with a cursor is kept as such", () => {
    for (const state of [
      "pending",
      "accepted",
      "declined",
      "cancelled",
      "expired",
    ])
      expect(
        parseSentPage(
          { items: [sent(R1, state)], next_after: null },
          { after: null, limit: 50 },
        )?.items[0]?.state,
      ).toBe(state);
    expect(
      parseSentPage({ items: [], next_after: R2 }, { after: R1, limit: 50 }),
    ).toEqual({
      items: [],
      next_after: R2,
    });
  });
  test.each([
    ["an unknown state", { items: [sent(R1, "revoked")], next_after: null }],
    [
      "more than the limit",
      { items: [sent(R1, "pending"), sent(R2, "pending")], next_after: null },
      1,
    ],
    [
      "out of id order",
      { items: [sent(R2, "pending"), sent(R1, "pending")], next_after: null },
    ],
    [
      "at or before the cursor",
      { items: [sent(R1, "pending")], next_after: null },
      50,
      R1,
    ],
    ["a bad cursor", { items: [], next_after: "x" }],
  ])(
    "%s is not the contract's answer",
    (_, body, limit: unknown = 50, after: unknown = null) => {
      expect(
        parseSentPage(body, {
          after: after as string | null,
          limit: limit as number,
        }),
      ).toBeNull();
    },
  );
});

describe("previews", () => {
  const preview = {
    token: TOKEN,
    source: person(B, "Mohammed A."),
    target: person(C, "Mo"),
    fields: [{ id: D, parent_id: B, label: "Phone", version: 2 }],
    requires_approval: true,
    combines_identity_audiences: true,
    freezes_field_policies: true,
  };
  test("the sender's preview needs both people; the recipient's may hide one and says whether it is stale", () => {
    expect(parseMergePreview(preview)?.token).toBe(TOKEN);
    expect(parseMergePreview({ ...preview, source: null })).toBeNull();
    expect(parseMergePreview({ ...preview, stale: false })).toBeNull();
    const recipient = parseRecipientPreview({
      ...preview,
      source: null,
      stale: true,
    });
    expect(recipient?.source).toBeNull();
    expect(recipient?.stale).toBe(true);
    expect(parseRecipientPreview(preview)).toBeNull();
  });
  test.each([
    ["a short token", { ...preview, token: "f".repeat(63) }],
    ["an upper-case token", { ...preview, token: "F".repeat(64) }],
    [
      "a field with a value",
      {
        ...preview,
        fields: [{ ...preview.fields[0], value: { kind: "text", text: "x" } }],
      },
    ],
    [
      "a field projection as a person",
      { ...preview, source: { ...preview.source, kind: "field" } },
    ],
    [
      "more than 200 fields",
      {
        ...preview,
        fields: Array.from({ length: 201 }, () => preview.fields[0]),
      },
    ],
  ])("%s is not the contract's answer", (_, body) => {
    expect(parseMergePreview(body)).toBeNull();
  });
});

describe("command bodies", () => {
  test("request_link carries a fresh request id and the linkage version, no note", () => {
    expect(
      requestLinkBody({ requestId: R1, personId: B, accountId: C, version: 4 }),
    ).toEqual({
      command: {
        kind: "request_link",
        id: R1,
        person_id: B,
        account_id: C,
        expected_version: 4,
      },
    });
  });
  test("request_merge carries an id; merge carries none", () => {
    expect(
      requestMergeBody({
        requestId: R1,
        sourceId: B,
        targetId: C,
        token: TOKEN,
        name: "Mo",
      }),
    ).toEqual({
      command: {
        kind: "request_merge",
        id: R1,
        source_id: B,
        target_id: C,
        preview_token: TOKEN,
        name: "Mo",
      },
    });
    expect(
      mergeBody({ sourceId: B, targetId: C, token: TOKEN, name: "Mo" }),
    ).toEqual({
      command: {
        kind: "merge",
        source_id: B,
        target_id: C,
        preview_token: TOKEN,
        name: "Mo",
      },
    });
  });
  test("only accepting a merge carries the recipient's token", () => {
    expect(
      respondBody({ requestId: R1, accept: true, recipientToken: TOKEN })
        .command,
    ).toEqual({
      kind: "respond_request",
      id: R1,
      accept: true,
      recipient_preview_token: TOKEN,
    });
    expect(
      respondBody({ requestId: R1, accept: true }).command,
    ).not.toHaveProperty("recipient_preview_token");
    expect(
      respondBody({ requestId: R1, accept: false, recipientToken: TOKEN })
        .command,
    ).not.toHaveProperty("recipient_preview_token");
    expect(cancelBody({ requestId: R1 })).toEqual({
      command: { kind: "cancel_request", id: R1 },
    });
  });
});

describe("time left (expires_at in SECONDS)", () => {
  const now = 1_800_000_000_000;
  test.each([
    [now / 1000 + 5 * 86_400 + 60, { kind: "days", n: 5 }],
    [now / 1000 + 86_400, { kind: "days", n: 1 }],
    [now / 1000 + 3 * 3_600 + 1, { kind: "hours", n: 3 }],
    [now / 1000 + 59 * 60, { kind: "under_hour" }],
    [now / 1000, { kind: "due" }],
    [now / 1000 - 1, { kind: "due" }],
  ])("%d", (expires, expected) => {
    expect(timeLeft(expires, now)).toEqual(expected);
  });
});

describe("the sender's name (D-11b-5)", () => {
  const households = [
    {
      id: D,
      name: "Home",
      version: 1,
      role: "member" as const,
      members: [{ account_id: A, username: "mo", role: "member" as const }],
    },
  ];
  const summary = {
    owner: { account_id: B, username: "sam", you: false, person: null },
  } as unknown as PersonSummary;
  test("from a shared household, then a summary's owner, else null (never the id)", () => {
    expect(senderName(A, households, [])).toBe("mo");
    expect(senderName(B, households, [summary])).toBe("sam");
    expect(senderName(C, households, [summary])).toBeNull();
  });
});

describe("the merge's name (D-11b-7)", () => {
  const labels = { source: "Mohammed A.", target: "Mo" };
  test("both linked: nothing; unknown: nothing offered; one linked: its name, exactly; neither: a choice, the kept person's by default", () => {
    expect(mergeNaming(known("other"), known("self"), labels)).toEqual({
      kind: "both_linked",
    });
    expect(
      mergeNaming(
        { known: false, reason: "offline" },
        known("unlinked"),
        labels,
      ),
    ).toEqual({ kind: "unknown" });
    expect(
      mergeNaming(
        known("unlinked"),
        { known: false, reason: "failed" },
        labels,
      ),
    ).toEqual({ kind: "unknown" });
    expect(mergeNaming(known("other"), known("unlinked"), labels)).toEqual({
      kind: "fixed",
      name: "Mohammed A.",
    });
    expect(mergeNaming(known("unlinked"), known("self"), labels)).toEqual({
      kind: "fixed",
      name: "Mo",
    });
    expect(mergeNaming(known("unlinked"), known("unlinked"), labels)).toEqual({
      kind: "choose",
      options: ["Mo", "Mohammed A."],
      default: "Mo",
    });
  });
});

describe("the comparison (D-11b-6)", () => {
  const fields = [
    { id: D, parent_id: B, label: "Phone", version: 2 },
    { id: R1, parent_id: C, label: " phone ", version: 5 },
    { id: R2, parent_id: C, label: "Birthday", version: 1 },
  ];
  const preview = {
    source: person(B, "Mohammed A."),
    target: person(C, "Mo"),
    fields,
  } as never;
  test("values only from a synced row with the same id at the preview's version or later", () => {
    const cached = (id: string) =>
      id === D
        ? ({
            ...person(D, "Phone", {
              kind: "field",
              parent_id: B,
              version: 2,
              value: { kind: "text", text: "1" },
            }),
          } as never)
        : id === R1
          ? ({
              ...person(R1, "phone", {
                kind: "field",
                parent_id: C,
                version: 4,
              }),
            } as never)
          : null;
    const rows = comparisonRows(preview, cached);
    expect(rows[0]).toMatchObject({
      key: "name",
      source: { kind: "name", text: "Mohammed A." },
      target: { kind: "name", text: "Mo" },
    });
    expect(rows[1]).toMatchObject({
      key: D,
      source: { kind: "value" },
      target: null,
    });
    expect(rows[2]).toMatchObject({
      key: R1,
      source: null,
      target: { kind: "unsynced" },
    });
    expect(rows[3]).toMatchObject({ key: R2, target: { kind: "unsynced" } });
  });
  test("a hidden side has no rows", () => {
    const rows = comparisonRows(
      { source: null, target: person(C, "Mo"), fields } as never,
      () => null,
    );
    expect(rows.map((row) => row.key)).toEqual(["name", R1, R2]);
    expect(rows[0]?.source).toBeNull();
  });
  test("a conflict is a label both sides have, trimmed and case-insensitive", () => {
    expect(conflictLabels(fields, { sourceId: B, targetId: C })).toEqual([
      "phone",
    ]);
    expect(
      conflictLabels(fields.slice(0, 1), { sourceId: B, targetId: C }),
    ).toEqual([]);
  });
});

describe("who accepts (D-11b-8) and merged aliases (D-11b-12)", () => {
  const summary = (you: boolean, username: string) =>
    ({
      owner: { account_id: A, username, you, person: null },
    }) as unknown as PersonSummary;
  test("the owner of the side the reader does not own; unknown without a summary", () => {
    expect(mergeRecipient(summary(true, "me"), summary(false, "mo"))).toEqual({
      username: "mo",
    });
    expect(mergeRecipient(summary(false, "sam"), null)).toEqual({
      username: "sam",
    });
    expect(mergeRecipient(summary(true, "me"), null)).toBeNull();
  });
  test("an archived person naming its canonical person is an alias", () => {
    expect(
      isMergedAlias({
        kind: "person",
        archived: true,
        value: { canonical_person_id: C },
      }),
    ).toBe(C);
    expect(
      isMergedAlias({
        kind: "person",
        archived: false,
        value: { canonical_person_id: C },
      }),
    ).toBeNull();
    expect(
      isMergedAlias({ kind: "person", archived: true, value: null }),
    ).toBeNull();
    expect(
      isMergedAlias({
        kind: "field",
        archived: true,
        value: { canonical_person_id: C },
      }),
    ).toBeNull();
  });
});

describe("the people classifier (D-11b-9)", () => {
  const body = (code: string) => ({
    code,
    message: "m",
    request_id: R1,
    details: [],
  });
  const json = "application/json";
  test("410 is expired, not not_found", () => {
    expect(
      classifyPeopleAnswer(410, json, body("invitation_expired")).kind,
    ).toBe("expired");
    expect(classifyPeopleAnswer(404, json, body("not_found")).kind).toBe(
      "not_found",
    );
  });
  test("a people command's 503 slice_capacity is a definite refusal; any other 503 is uncertain", () => {
    expect(
      classifyPeopleAnswer(503, json, body("slice_capacity"), {
        capacity: true,
      }),
    ).toMatchObject({
      kind: "capacity",
      requestId: R1,
    });
    expect(classifyPeopleAnswer(503, json, body("slice_capacity")).kind).toBe(
      "uncertain",
    );
    expect(
      classifyPeopleAnswer(503, json, body("unavailable"), { capacity: true })
        .kind,
    ).toBe("uncertain");
    expect(
      classifyPeopleAnswer(500, json, body("internal_error"), {
        capacity: true,
      }).kind,
    ).toBe("uncertain");
  });
});
