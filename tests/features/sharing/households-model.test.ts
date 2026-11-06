import { describe, expect, test } from "vitest";
import type { SnapshotHousehold } from "../../../src/data";
import { classifyHousehold } from "../../../src/features/sharing/households/api";
import {
  cmd,
  conflictCause,
  daysLeft,
  formContext,
  groupByHousehold,
  lastManager,
  nameLength,
  parseAccountInvitations,
  parseIssued,
  parseSentPage,
  restoreName,
  restoreUsername,
  sameName,
  signupLink,
  soleMember,
  validName,
} from "../../../src/features/sharing/households/model";
import { sentRow } from "../../support/sharing/fake-households";

/**
 * WEB-12b's pure household model (plan §4.1) and its answer classification (D-12b-10). Unit evidence of the client's own rules; nothing
 * here says what the server answers (the I-SH integration cases do).
 */
const ME = "11111111-1111-4111-8111-111111111111";
const SAM = "22222222-2222-4222-8222-222222222222";
const HOME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID = "eeeeeeee-0000-4000-8000-000000000001";
const home = (over: Partial<SnapshotHousehold> = {}): SnapshotHousehold => ({
  id: HOME,
  name: "Home",
  version: 7,
  role: "manager",
  members: [
    { account_id: ME, username: "me", role: "manager" },
    { account_id: SAM, username: "sam", role: "member" },
  ],
  ...over,
});
const atlas = (code: string) => ({
  code,
  message: `refused: ${code}`,
  request_id: "61af3d02-0000-4000-8000-000000000000",
  details: [],
});
const JSON_TYPE = "application/json";

describe("S-HH4: each command names its own counter (SHARE-9)", () => {
  const invitation = {
    id: ID,
    household_id: HOME,
    household_name: "Home",
    sender_id: SAM,
    status: "pending" as const,
    expires_at: "2026-11-13T10:00:00Z",
    version: 3,
  };
  test("respond carries the INVITATION's version, never the household's (MU-6201, MU-6222)", () => {
    expect(cmd.respond(invitation, true)).toEqual({
      kind: "respond_to_household_invitation",
      id: ID,
      expected_version: 3,
      accept: true,
    });
    expect(cmd.respond(invitation, false)).toMatchObject({
      expected_version: 3,
      accept: false,
    });
  });
  test("revoke carries the SENT invitation's version (MU-6202)", () => {
    expect(cmd.revoke(sentRow({ id: ID, version: 5 }))).toEqual({
      kind: "revoke_household_invitation",
      id: ID,
      expected_version: 5,
    });
  });
  test("set_primary carries the B5 preferences_version, never a household's (MU-6203)", () => {
    expect(cmd.setPrimary(HOME, 12)).toEqual({
      kind: "set_primary_household",
      household_id: HOME,
      expected_version: 12,
    });
    expect(cmd.setPrimary(null, 12)).toEqual({
      kind: "set_primary_household",
      household_id: null,
      expected_version: 12,
    });
  });
  test("rename, invite, remove and set_household_role carry the HOUSEHOLD's version (MU-6223)", () => {
    const h = home();
    expect(cmd.rename(h, "  Flat  ")).toEqual({
      kind: "rename_household",
      id: HOME,
      name: "Flat",
      expected_version: 7,
    });
    expect(cmd.invite(ID, h, SAM)).toEqual({
      kind: "invite_to_household",
      id: ID,
      household_id: HOME,
      recipient_id: SAM,
      expected_version: 7,
    });
    expect(cmd.remove(h, SAM)).toEqual({
      kind: "remove_household_member",
      household_id: HOME,
      account_id: SAM,
      expected_version: 7,
    });
    expect(cmd.setRole(h, SAM, true)).toEqual({
      kind: "set_household_role",
      household_id: HOME,
      account_id: SAM,
      expected_version: 7,
      manager: true,
    });
    expect(cmd.create(ID, " Home ")).toEqual({
      kind: "create_household",
      id: ID,
      name: "Home",
    });
  });
});

describe("S-HH4: SHARE-6 last manager and sole member", () => {
  test("the only manager is the last manager; with a second manager nobody is", () => {
    expect(lastManager(home(), ME)).toBe(true);
    expect(lastManager(home(), SAM)).toBe(false);
    const two = home({
      members: [
        { account_id: ME, username: "me", role: "manager" },
        { account_id: SAM, username: "sam", role: "manager" },
      ],
    });
    expect(lastManager(two, ME)).toBe(false);
  });
  test("a household of one is a sole member's", () => {
    expect(soleMember(home())).toBe(false);
    expect(
      soleMember(
        home({
          members: [{ account_id: ME, username: "me", role: "manager" }],
        }),
      ),
    ).toBe(true);
  });
});

describe("S-HH11: the sent page parser (Q16)", () => {
  const page = (items: unknown[], next_after: string | null = null) => ({
    items,
    next_after,
  });
  test("every status verbatim, the cursor kept (MU-6209)", () => {
    const rows = ["pending", "accepted", "declined", "revoked", "expired"].map(
      (status, n) =>
        sentRow({
          id: `eeeeeeee-0000-4000-8000-00000000000${n}`,
          status: status as never,
        }),
    );
    const parsed = parseSentPage(page(rows, ID));
    expect(parsed?.items.map((r) => r.status)).toEqual([
      "pending",
      "accepted",
      "declined",
      "revoked",
      "expired",
    ]);
    expect(parsed?.next_after).toBe(ID);
  });
  test("refuses an extra key, an unknown status, a bad id, a version below 1, more than 200 rows, a bad cursor", () => {
    const good = sentRow({ id: ID });
    expect(parseSentPage(page([{ ...good, extra: 1 }]))).toBeNull();
    expect(parseSentPage(page([{ ...good, status: "lost" }]))).toBeNull();
    expect(parseSentPage(page([{ ...good, recipient_id: "x" }]))).toBeNull();
    expect(parseSentPage(page([{ ...good, version: 0 }]))).toBeNull();
    expect(parseSentPage(page(Array(201).fill(good)))).toBeNull();
    expect(parseSentPage(page([good], "not-a-uuid"))).toBeNull();
    expect(parseSentPage({ items: [] })).toBeNull();
  });
});

describe("S-HH13: signup invitations (Q21 group 2)", () => {
  const token = "0123456789abcdef".repeat(4);
  test("the link carries the token in the FRAGMENT at /join, never a query string (R7, MU-6207)", () => {
    const link = signupLink("https://atlas.example", token);
    expect(link).toBe(`https://atlas.example/join#t=${token}`);
    expect(new URL(link).search).toBe("");
    expect(new URL(link).hash).toBe(`#t=${token}`);
    expect(() => signupLink("https://atlas.example", "short")).toThrow();
  });
  test("the issued answer and the active list are validated strictly", () => {
    expect(
      parseIssued({ id: ID, token, expires_at: "2026-11-13T10:00:00Z" }),
    ).toEqual({ id: ID, token, expires_at: "2026-11-13T10:00:00Z" });
    expect(
      parseIssued({ id: ID, token: "ABC", expires_at: "2026-11-13T10:00:00Z" }),
    ).toBeNull();
    expect(parseIssued({ id: ID, token, expires_at: "x" })).toBeNull();
    expect(
      parseAccountInvitations({
        invitations: [
          { id: ID, household_id: HOME, expires_at: "2026-11-13T10:00:00Z" },
          { id: ME, household_id: null, expires_at: "2026-11-13T10:00:00Z" },
        ],
      }),
    ).toHaveLength(2);
    expect(parseAccountInvitations([])).toBeNull();
    expect(
      parseAccountInvitations({
        invitations: [{ id: ID, household_id: HOME }],
      }),
    ).toBeNull();
  });
});

describe("D-12b-10: household-only classification", () => {
  test("503 slice_capacity on a command is the refusal `capacity` (MU-6204); without the code or the body it is not", () => {
    expect(
      classifyHousehold("command", 503, JSON_TYPE, atlas("slice_capacity")),
    ).toMatchObject({ ok: false, kind: "capacity" });
    expect(
      classifyHousehold("command", 503, JSON_TYPE, atlas("internal_error")),
    ).toBeNull();
    expect(classifyHousehold("command", 503, "text/html", "<p>")).toBeNull();
    expect(
      classifyHousehold("issue", 503, JSON_TYPE, atlas("slice_capacity")),
    ).toBeNull();
  });
  test("429 rate_limited on an issuance is the refusal `limit` (MU-6205); without an Atlas body it stays uncertain", () => {
    expect(
      classifyHousehold("issue", 429, JSON_TYPE, atlas("rate_limited")),
    ).toMatchObject({ ok: false, kind: "limit" });
    expect(
      classifyHousehold("issue", 429, "text/plain", "slow down"),
    ).toBeNull();
    expect(
      classifyHousehold("command", 429, JSON_TYPE, atlas("rate_limited")),
    ).toBeNull();
  });
});

describe("helpers", () => {
  test("S-HH12 sameName: trimmed, NFC, case-folded", () => {
    expect(sameName(" Home ", "home")).toBe(true);
    expect(sameName("Café", "Café")).toBe(true);
    expect(sameName("Home", "Home 2")).toBe(false);
  });
  test("name length in code points of the trimmed name", () => {
    expect(nameLength("  😀a ")).toBe(2);
    expect(validName("   ")).toBe(false);
    expect(validName("x".repeat(300))).toBe(true);
    expect(validName("x".repeat(301))).toBe(false);
  });
  test("conflictCause from a read made after the refusal (MU-6224)", () => {
    const sent = [sentRow({ id: ID, recipient_id: SAM, household_id: HOME })];
    expect(conflictCause({ household: home(), sent: [] }, SAM, HOME)).toBe(
      "member",
    );
    const without = home({
      members: [{ account_id: ME, username: "me", role: "manager" }],
    });
    expect(conflictCause({ household: without, sent }, SAM, HOME)).toBe(
      "invited",
    );
    expect(
      conflictCause(
        {
          household: without,
          sent: sent.map((s) => ({ ...s, status: "declined" as const })),
        },
        SAM,
        HOME,
      ),
    ).toBe("changed");
  });
  test("days left rounds up and stops at 0", () => {
    const now = Date.UTC(2026, 10, 6, 10);
    expect(daysLeft("2026-11-13T10:00:00Z", now)).toBe(7);
    expect(daysLeft("2026-11-06T11:00:00Z", now)).toBe(1);
    expect(daysLeft("2026-11-01T10:00:00Z", now)).toBe(0);
    expect(daysLeft("soon", now)).toBeNull();
  });
  test("grouping keeps households you have left, in first-seen order", () => {
    const groups = groupByHousehold([
      sentRow({ id: ID, household_id: HOME, household_name: "Home" }),
      sentRow({ id: ME, household_id: SAM, household_name: "Old flat" }),
      sentRow({ id: SAM, household_id: HOME, household_name: "Home" }),
    ]);
    expect(groups.map((g) => [g.name, g.items.length])).toEqual([
      ["Home", 2],
      ["Old flat", 1],
    ]);
  });
  test("D-12b-15: form recovery contexts hold values only; restoring validates", () => {
    expect(formContext.create()).toBe("households:new");
    expect(formContext.rename(HOME)).toBe(`households:rename:${HOME}`);
    expect(formContext.invite(HOME)).toBe(`households:invite:${HOME}`);
    expect(restoreName({ name: "Flat" })).toBe("Flat");
    expect(restoreName({ name: "x".repeat(301) })).toBeNull();
    expect(restoreName({})).toBeNull();
    expect(restoreUsername({ username: "jamie" })).toBe("jamie");
    expect(restoreUsername({ username: "x".repeat(101) })).toBeNull();
  });
});
