// @vitest-environment node
import { describe, expect, test } from "vitest";
import { digestOf } from "../../src/data/model/canonical";
import {
  digestOfMembers,
  EMPTY_DIGEST,
  isMemberDraft,
  population,
  summarise,
} from "../../src/data/model/local-work";
import { draftRow, recoveryRow } from "../support/data/rows";

describe("the normative population (WEB-04 design 733-775)", () => {
  test("members: queued, in flight, rejected, blocked and both conflicts; ordinary acknowledged and superseded drafts are not", () => {
    const members = [
      "queued",
      "in_flight",
      "rejected",
      "blocked",
      "version_conflict",
      "operation_conflict",
    ] as const;
    for (const status of members)
      expect(isMemberDraft(draftRow({ status })), status).toBe(true);
    expect(isMemberDraft(draftRow({ status: "acknowledged" }))).toBe(false);
    expect(isMemberDraft(draftRow({ status: "superseded" }))).toBe(false);
  });
  test("an acknowledged draft is a member while its outcome is still held or unavailable", () => {
    expect(
      isMemberDraft(
        draftRow({ status: "acknowledged", held_pending_cache: true }),
      ),
    ).toBe(true);
    expect(
      isMemberDraft(
        draftRow({ status: "acknowledged", unavailable_outcome: true }),
      ),
    ).toBe(true);
  });
  test("every unfinished form copy is a member; a terminal recovery row (its fields cleared) is not", () => {
    const live = recoveryRow({ form_context: "a" });
    const done = recoveryRow({ form_context: "b", terminal: true, fields: {} });
    expect(population([], [live, done])).toHaveLength(1);
  });
});

describe("the summary: counts and generic lines, never content", () => {
  test("an empty population has a well-known digest and no lines", () => {
    expect(summarise([])).toEqual({
      count: 0,
      items: [],
      digest: EMPTY_DIGEST,
    });
  });
  test("lines are generic category text with counts, unique per category, in a fixed order", () => {
    const drafts = [
      draftRow({ status: "queued", command: { secret: "buy milk" } }),
      draftRow({ status: "in_flight" }),
      draftRow({ status: "version_conflict" }),
      draftRow({ status: "rejected" }),
      draftRow({ status: "acknowledged", held_pending_cache: true }),
    ];
    const out = summarise(
      population(drafts, [recoveryRow({ fields: { note: "private words" } })]),
    );
    expect(out.count).toBe(6);
    expect(out.items).toEqual([
      "2 changes waiting to send",
      "1 change that needs your decision",
      "1 change that could not be saved",
      "1 change still being confirmed",
      "1 unfinished form copy",
    ]);
    expect(new Set(out.items).size).toBe(out.items.length);
    const text = JSON.stringify(out);
    expect(text).not.toContain("buy milk");
    expect(text).not.toContain("private words");
  });
  test("a queued change under defaults review is a decision, not a wait", () => {
    const out = summarise(
      population(
        [
          draftRow({
            status: "queued",
            review_block: { kind: "defaults", kinds: ["x"] },
          }),
        ],
        [],
      ),
    );
    expect(out.items).toEqual(["1 change that needs your decision"]);
  });
});

describe("F-O15: the digest changes exactly when the work genuinely changes", () => {
  const base = () => [
    draftRow({ local_id: "a", status: "queued", command: { v: 1 } }),
    draftRow({ local_id: "b", status: "queued", command: { v: 2 } }),
  ];
  const digest = (drafts = base(), recovery = [recoveryRow()]) =>
    digestOfMembers(population(drafts, recovery));

  test("stable for the same work, in any order", () => {
    expect(digest()).toBe(digest());
    expect(digest(base().reverse())).toBe(digest(base()));
  });
  test("changes when a queued command is edited in place", () => {
    const edited = base();
    edited[0] = draftRow({
      local_id: "a",
      status: "queued",
      command: { v: 99 },
    });
    expect(digest(edited)).not.toBe(digest());
  });
  test("changes when one draft is replaced by another with the same count", () => {
    const replaced = [
      base()[0] as ReturnType<typeof draftRow>,
      draftRow({ local_id: "c", status: "queued", command: { v: 2 } }),
    ];
    expect(replaced).toHaveLength(base().length);
    expect(digest(replaced)).not.toBe(digest());
  });
  test("changes when a recovery copy's content changes, and not when only the same content is re-saved", () => {
    expect(
      digest(base(), [
        recoveryRow({
          fields: { name: "y" },
          content_digest: digestOf({ name: "y" }),
        }),
      ]),
    ).not.toBe(digest());
    expect(digest(base(), [recoveryRow()])).toBe(digest());
  });
  test("changes when an acknowledged draft's flag is set or cleared", () => {
    const flagged = [
      ...base(),
      draftRow({
        local_id: "z",
        status: "acknowledged",
        held_pending_cache: true,
      }),
    ];
    const cleared = [
      ...base(),
      draftRow({
        local_id: "z",
        status: "acknowledged",
        held_pending_cache: false,
      }),
    ];
    expect(digest(flagged)).not.toBe(digest());
    expect(digest(cleared)).toBe(digest());
  });
  test("changes when a status changes", () => {
    const moved = base();
    moved[0] = draftRow({
      local_id: "a",
      status: "in_flight",
      command: { v: 1 },
    });
    expect(digest(moved)).not.toBe(digest());
  });
});
