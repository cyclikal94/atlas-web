import { describe, expect, test } from "vitest";
import {
  mergeNameContext,
  mergeNameFields,
  requestLinkContext,
  requestLinkFields,
  requestMergeContext,
  requestMergeFields,
  restoreMergeName,
  restoreRequestLink,
  restoreRequestMerge,
} from "../../../src/features/people/model/recovery";

/** WEB-11b's Q4 recovery contexts (D-11b-13, A11): pure, round-trip, nothing restored from a capture that is not one of these forms. */
const ADA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MO = "22222222-2222-4222-8222-222222222222";

describe("WEB-11b recovery contexts", () => {
  test("context keys", () => {
    expect(requestLinkContext("f1")).toBe("people-request-link:f1");
    expect(requestMergeContext("f1")).toBe("people-request-merge:f1");
    expect(mergeNameContext(ADA, MO)).toBe(`people-merge-name:${ADA}:${MO}`);
  });
  test("each form round-trips, unset choices included", () => {
    const link = {
      person: { id: ADA, label: "Ada" },
      recipient: { id: MO, username: "mo" },
    };
    expect(restoreRequestLink(requestLinkFields(link))).toEqual(link);
    expect(
      restoreRequestLink(requestLinkFields({ person: null, recipient: null })),
    ).toEqual({ person: null, recipient: null });
    const merge = { first: { id: ADA, label: "Ada" }, second: null };
    expect(restoreRequestMerge(requestMergeFields(merge))).toEqual(merge);
    expect(restoreMergeName(mergeNameFields("source"))).toBe("source");
  });
  test.each([
    ["not JSON", { form: "{" }],
    ["a missing choice", { form: JSON.stringify({ person: null }) }],
    [
      "an id that is not a UUID",
      {
        form: JSON.stringify({
          person: { id: "x", label: "Ada" },
          recipient: null,
        }),
      },
    ],
    [
      "an extra key",
      {
        form: JSON.stringify({
          person: { id: ADA, label: "Ada", note: "" },
          recipient: null,
        }),
      },
    ],
    [
      "a merge capture",
      { form: JSON.stringify({ first: null, second: null }) },
    ],
  ])("%s restores nothing", (_, fields) => {
    expect(restoreRequestLink(fields)).toBeNull();
  });
  test("a name that is not one of the two restores nothing", () => {
    expect(restoreMergeName({ name: "Mo" })).toBeNull();
    expect(restoreMergeName({})).toBeNull();
  });
});
