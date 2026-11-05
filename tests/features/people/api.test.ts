// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  classifyPeopleAnswer,
  parsePersonDetail,
  parsePersonReceipt,
  parseProjection,
  parseProjectionPage,
  parseTaskReceipt,
} from "../../../src/features/people/api";

/** The people API's strict validation and answer classification (D-11a-14). A 200 that is not the contract's answer is `uncertain`. */
const P = "55555555-5555-4555-8555-555555555555";
const A = "11111111-1111-4111-8111-111111111111";
const person = {
  id: P,
  kind: "person",
  parent_id: null,
  label: "Mo",
  value: null,
  version: 3,
  can_edit: false,
  policy_version: 2,
  archived: false,
};
const JSON_TYPE = "application/json";
const error = (code: string) => ({
  code,
  message: "m",
  request_id: "99999999-9999-4999-8999-999999999999",
  details: [],
});

describe("parsing", () => {
  test("a projection, with or without policy_version", () => {
    expect(parseProjection(person)).toEqual(person);
    const { policy_version: _p, ...old } = person;
    expect(parseProjection(old)).toEqual(old);
  });

  test.each([
    ["an extra key", { ...person, owner: A }],
    ["a missing key", { ...person, archived: undefined }],
    [
      "an uppercase id",
      { ...person, id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    ],
    ["an empty label", { ...person, label: "" }],
    ["version 0", { ...person, version: 0 }],
    ["an unknown kind", { ...person, kind: "pet" }],
    ["a string value", { ...person, value: "{}" }],
  ])("refuses %s", (_name, body) => {
    expect(parseProjection(body)).toBeNull();
  });

  test("PersonDetail: the person and who it is linked to (null or a UUID), nothing else", () => {
    expect(parsePersonDetail({ person, linked_account_id: A })).toEqual({
      person,
      linked_account_id: A,
    });
    expect(
      parsePersonDetail({ person, linked_account_id: null })?.linked_account_id,
    ).toBeNull();
    expect(parsePersonDetail({ person })).toBeNull();
    expect(parsePersonDetail({ person, linked_account_id: "me" })).toBeNull();
    expect(
      parsePersonDetail({
        person: { ...person, kind: "field", parent_id: P },
        linked_account_id: null,
      }),
    ).toBeNull();
  });

  test("a page: at most the limit asked for, and a UUID cursor or null", () => {
    expect(
      parseProjectionPage({ items: [person], next_after: null }, 1),
    ).toEqual({
      items: [person],
      next_after: null,
    });
    expect(
      parseProjectionPage({ items: [], next_after: P }, 1)?.next_after,
    ).toBe(P);
    expect(
      parseProjectionPage({ items: [person, person], next_after: null }, 1),
    ).toBeNull();
    expect(parseProjectionPage({ items: [], next_after: "x" }, 1)).toBeNull();
    expect(parseProjectionPage({ items: [] }, 1)).toBeNull();
  });

  test("receipts", () => {
    expect(parsePersonReceipt({ revision: 4, person_id: P })).toEqual({
      revision: 4,
      person_id: P,
    });
    expect(parsePersonReceipt({ revision: 4 })).toBeNull();
    expect(parseTaskReceipt({ revision: 0 })).toEqual({ revision: 0 });
    expect(parseTaskReceipt({ revision: "4" })).toBeNull();
  });
});

describe("classification", () => {
  test("Atlas refusals by code and status; identity_grant_required is told apart", () => {
    expect(
      classifyPeopleAnswer(409, JSON_TYPE, error("conflict")),
    ).toMatchObject({ kind: "conflict" });
    expect(
      classifyPeopleAnswer(403, JSON_TYPE, error("forbidden")),
    ).toMatchObject({ kind: "forbidden" });
    expect(
      classifyPeopleAnswer(404, JSON_TYPE, error("not_found")),
    ).toMatchObject({ kind: "not_found" });
    expect(
      classifyPeopleAnswer(422, JSON_TYPE, error("invalid_value")),
    ).toMatchObject({ kind: "invalid" });
    expect(
      classifyPeopleAnswer(403, JSON_TYPE, error("identity_grant_required")),
    ).toMatchObject({ kind: "identity_grant_required" });
  });

  test("a 4xx without an Atlas body, a 5xx and a 429 are uncertain; a 401 is closed", () => {
    expect(classifyPeopleAnswer(403, "text/html", "<html>")).toEqual({
      ok: false,
      kind: "uncertain",
    });
    expect(
      classifyPeopleAnswer(503, JSON_TYPE, error("unavailable")).kind,
    ).toBe("uncertain");
    expect(
      classifyPeopleAnswer(429, JSON_TYPE, error("rate_limited")).kind,
    ).toBe("uncertain");
    expect(
      classifyPeopleAnswer(401, JSON_TYPE, error("unauthenticated")),
    ).toEqual({ ok: false, kind: "closed" });
  });
});
