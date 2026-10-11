// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  occurrenceId,
  progressId,
  slotKey,
  uuidV5,
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
