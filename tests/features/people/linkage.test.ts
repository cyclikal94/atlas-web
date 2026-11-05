// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  linkageOf,
  renameRoute,
  unknownLinkage,
  unlinkOffer,
} from "../../../src/features/people/model/linkage";

/**
 * Who controls a profile (D-11a-2), how "Rename" works (D-11a-5) and when "Unlink account" is offered (D-11a-6). Linkage comes ONLY from
 * an answer of `GET /people/{id}`; `can_edit` never says anything about it (a person linked to someone else syncs read-only, exactly like
 * an ordinary read-only share).
 */
const ME = "11111111-1111-4111-8111-111111111111";
const MO = "22222222-2222-4222-8222-222222222222";
const answer = (linked: string | null) => ({
  linked_account_id: linked,
  person: { version: 4 },
});

describe("linkageOf", () => {
  test("self, other and unlinked, with the answer's version", () => {
    expect(linkageOf(answer(ME), ME, 10)).toEqual({
      known: true,
      kind: "self",
      accountId: ME,
      version: 4,
      readAt: 10,
    });
    expect(linkageOf(answer(MO), ME, 10)).toMatchObject({
      kind: "other",
      accountId: MO,
    });
    expect(linkageOf(answer(null), ME, 10)).toMatchObject({
      kind: "unlinked",
      accountId: null,
    });
  });
});

describe("renameRoute", () => {
  test("known self: rename_profile (1 to 200), whether or not the person is editable", () => {
    expect(renameRoute(linkageOf(answer(ME), ME, 0), false)).toEqual({
      kind: "rename_profile",
      maxLength: 200,
    });
  });

  test("known unlinked: the content edit (1 to 300), only with can_edit", () => {
    const unlinked = linkageOf(answer(null), ME, 0);
    expect(renameRoute(unlinked, true)).toEqual({
      kind: "edit",
      maxLength: 300,
    });
    expect(renameRoute(unlinked, false)).toEqual({
      kind: "disabled",
      reason: "cannot_edit",
    });
  });

  test("known other: disabled, the linked account owns the name (even with can_edit)", () => {
    expect(renameRoute(linkageOf(answer(MO), ME, 0), true)).toEqual({
      kind: "disabled",
      reason: "other_owns",
    });
  });

  test("UNKNOWN is never treated as unlinked, and can_edit infers nothing", () => {
    for (const reason of ["offline", "loading", "failed", "refused"] as const) {
      expect(renameRoute(unknownLinkage(reason), true)).toEqual({
        kind: "disabled",
        reason: "unknown",
      });
    }
  });
});

describe("unlinkOffer", () => {
  test("enabled for the linked self; disabled for another account; absent when unlinked or unknown", () => {
    expect(unlinkOffer(linkageOf(answer(ME), ME, 0))).toEqual({
      kind: "enabled",
    });
    expect(unlinkOffer(linkageOf(answer(MO), ME, 0))).toEqual({
      kind: "disabled",
      reason: "other_owns",
    });
    expect(unlinkOffer(linkageOf(answer(null), ME, 0))).toEqual({
      kind: "absent",
    });
    expect(unlinkOffer(unknownLinkage("offline"))).toEqual({ kind: "absent" });
  });
});
