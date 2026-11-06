// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  completionEntryId,
  occurrenceId,
  progressId,
  slotKey,
  uuidV5,
  uuidV5Sync,
} from "../../../src/features/tasks/model/ids";

const TASK = "70000000-0000-4000-8000-000000000011";
const daily = {
  start_date: "2026-09-08",
  time: null,
  timezone: "Europe/Vienna",
  repeat: { frequency: "daily" as const, interval: 1 },
};

describe("deterministic ids (A5; backend docs/tasks.md golden vector)", () => {
  test("the documented first occurrence of the daily date-only task", async () => {
    expect(slotKey(daily, "2026-09-08")).toBe("2026-09-08Tdate");
    expect(await occurrenceId(TASK, slotKey(daily, "2026-09-08"))).toBe(
      "4cc26047-d75e-5cb3-ad46-fe81937bde57",
    );
  });

  test("UUIDv5 uses the task's own UUID as namespace, never NAMESPACE_URL (RFC 9562 vector for DNS namespace)", async () => {
    // RFC 9562 appendix A.4: NAMESPACE_DNS + "www.example.com".
    expect(
      await uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"),
    ).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    const viaUrl = await uuidV5(
      "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
      `atlas-occurrence-v1:2026-09-08Tdate`,
    );
    expect(viaUrl).not.toBe("4cc26047-d75e-5cb3-ad46-fe81937bde57");
  });

  test("a progress id is namespaced by the occurrence and names the account", async () => {
    const occ = "4cc26047-d75e-5cb3-ad46-fe81937bde57";
    const a = await progressId(occ, "70000000-0000-4000-8000-000000000001");
    const b = await progressId(occ, "70000000-0000-4000-8000-000000000002");
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(a).not.toBe(b);
    expect(await progressId(occ, "70000000-0000-4000-8000-000000000001")).toBe(
      a,
    );
  });

  test("slot keys: `once` for every schedule without repeat and for the first after-completion slot", () => {
    expect(slotKey({ ...daily, repeat: null }, "2026-09-08")).toBe("once");
    expect(slotKey({ ...daily, start_date: null, repeat: null }, null)).toBe(
      "once",
    );
    expect(
      slotKey(
        { ...daily, repeat: { frequency: "after_completion", interval: 7 } },
        "2026-09-08",
      ),
    ).toBe("once");
    expect(slotKey({ ...daily, time: "07:30:00" }, "2026-09-08")).toBe(
      "2026-09-08T07:30:00",
    );
  });
});

/**
 * Revision 1 (review R6): a dependency completion's entries carry the SERVER's ids, so a synced stream that lists one shows it landed.
 * `completionEntryId` is UUIDv5(operation key, "dependency-completion:<occurrence>:<actor>") (`crates/core/src/tasks/service/
 * dependencies.rs` at the pinned 4396c99), computed synchronously for the pure row composition. The vectors are an INDEPENDENT oracle:
 * Python's standard `uuid.uuid5` (recorded in the revision's execution report), not this code.
 */
describe("dependency completion entry ids (review R6)", () => {
  test("the server's derivation, against Python's uuid.uuid5", () => {
    expect(
      completionEntryId(
        "cccccccc-0000-4000-8000-000000000001",
        "aaaaaaaa-0000-4000-8000-0000000000b1",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toBe("b4c8baa6-348d-568f-8def-49cdc618337a");
    expect(
      completionEntryId(
        "70000000-0000-4000-8000-000000000998",
        "aaaaaaaa-0000-4000-8000-0000000000b2",
        "22222222-2222-4222-8222-222222222222",
      ),
    ).toBe("9e2ee21f-01d0-5f8f-85bf-deb44ec3e180");
    expect(
      completionEntryId(
        "0f8fad5b-d9cb-469f-a165-70867728950e",
        "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toBe("d7b9c403-446a-5b1d-acd8-9b9fbc2c11c5");
    // A name longer than one SHA-1 block, and the occurrence form.
    expect(
      uuidV5Sync("0f8fad5b-d9cb-469f-a165-70867728950e", "x".repeat(130)),
    ).toBe("8716c0a4-66fb-5dd1-a317-7b3d806dd449");
    expect(
      uuidV5Sync(
        "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        "atlas-occurrence-v1:2026-10-25Tdate",
      ),
    ).toBe("4ecb123a-cade-57ff-a0f8-4e728e2121ac");
  });

  test("the synchronous digest equals WebCrypto's for names of every padding length; a key that is not a UUID gives none", async () => {
    const ns = "0f8fad5b-d9cb-469f-a165-70867728950e";
    for (let n = 0; n <= 200; n += 1) {
      const name = `${"é".repeat(n % 3)}${"a".repeat(n)}`;
      expect(uuidV5Sync(ns, name), `length ${n}`).toBe(await uuidV5(ns, name));
    }
    expect(uuidV5Sync("not-a-uuid", "x")).toBeNull();
    expect(
      completionEntryId("A0000000-0000-4000-8000-000000000001", "o", "a"),
    ).toBeNull();
  });
});
