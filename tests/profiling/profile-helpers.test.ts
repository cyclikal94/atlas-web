import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * The profiling specs' writers (tests/e2e/profile-helpers.ts; WEB-09c revision 2, design assessment Q15): a row is written only inside a
 * collection window, carries its stage and invocation, links its raw samples by path and SHA-256, cannot have its identity replaced by a
 * caller's extra fields, and is written once; a direct evidence file is stamped and written once; a failed sampler read is counted.
 */
const dir = mkdtempSync(join(tmpdir(), "atlas-profile-helpers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
vi.stubEnv("ATLAS_PROFILE", "1");
vi.stubEnv("ATLAS_PROFILE_OUT", dir);
vi.stubEnv("ATLAS_PROFILE_STAGE", "fixture");
vi.stubEnv("ATLAS_PROFILE_INVOCATION", "inv-1");
const helpers = await import("../e2e/profile-helpers");
const info = (title: string) =>
  ({
    title,
    project: { name: "fixture-chromium" },
    status: "passed",
    expectedStatus: "passed",
    retry: 0,
  }) as unknown as TestInfo;
const lines = (name: string) =>
  readFileSync(join(dir, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe("the profiling writers", () => {
  it("case: a row outside a collection window is an error, never a row", () => {
    expect(() => helpers.record("P-2 x wall_ms", "chromium", [1])).toThrow(
      /outside a collection window/,
    );
  });

  it("control: a row carries its identity, its window and its raw samples' path and hash; extra fields cannot replace them", () => {
    helpers.beginCollection(info("P-2: synthetic"));
    helpers.record("P-2 x wall_ms", "chromium", [3, 1, 2], {
      name: "forged",
      engine: "webkit",
      n: 99,
      p50: -1,
      raw: "raw/forged.json",
      raw_sha256: "0",
      stage: "integration",
      invocation: "someone",
      collection: { test: "forged" },
      shape: "x",
    });
    const [row] = lines("measurements.jsonl");
    expect(row).toMatchObject({
      id: "P-2 x wall_ms[chromium]",
      name: "P-2 x wall_ms",
      engine: "chromium",
      n: 3,
      p50: 2,
      stage: "fixture",
      invocation: "inv-1",
      raw: "raw/P-2_x_wall_ms.chromium.json",
      shape: "x",
    });
    expect(row.collection.test).toBe("P-2: synthetic");
    const raw = readFileSync(join(dir, row.raw), "utf8");
    expect(row.raw_sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(JSON.parse(raw)).toMatchObject({
      name: "P-2 x wall_ms",
      engine: "chromium",
      samples: [3, 1, 2],
    });
    helpers.recordValue("P-Q footprints", "chromium", {
      name: "forged",
      stage: "forged",
      usage: 1,
    });
    const [value] = lines("values.jsonl");
    expect(value).toMatchObject({
      name: "P-Q footprints",
      stage: "fixture",
      invocation: "inv-1",
      usage: 1,
    });
  });

  it("case: a series is written once; a second row of the same name and engine is refused", () => {
    expect(() => helpers.record("P-2 x wall_ms", "chromium", [5])).toThrow(
      /EEXIST/,
    );
    expect(lines("measurements.jsonl")).toHaveLength(1);
  });

  it("control: a direct evidence file is stamped with its stage, invocation and window, and written once", () => {
    helpers.writeEvidence("memory/P-11.chromium.json", {
      engine: "chromium",
      rows: [],
    });
    const file = JSON.parse(
      readFileSync(join(dir, "memory/P-11.chromium.json"), "utf8"),
    );
    expect(file.evidence).toMatchObject({
      stage: "fixture",
      invocation: "inv-1",
      collection: { test: "P-2: synthetic" },
    });
    expect(() =>
      helpers.writeEvidence("memory/P-11.chromium.json", {}),
    ).toThrow(/EEXIST/);
  });

  it("control: the collection log records the test with its window, stage and invocation", () => {
    helpers.endCollection(info("P-2: synthetic"));
    const [entry] = lines("collection.jsonl");
    expect(entry).toMatchObject({
      test: "P-2: synthetic",
      engine: "chromium",
      status: "passed",
      stage: "fixture",
      invocation: "inv-1",
    });
    expect(Date.parse(entry.to)).toBeGreaterThanOrEqual(Date.parse(entry.from));
    expect(() => helpers.recordValue("late", "chromium", {})).toThrow(
      /outside a collection window/,
    );
  });

  it("case: a sampler read that throws is counted, never dropped silently", async () => {
    let n = 0;
    const s = helpers.sampler(() => {
      n += 1;
      if (n % 2 === 0) throw new Error("busy");
      return n;
    }, 1);
    await new Promise((r) => setTimeout(r, 30));
    const samples = await s.stop();
    expect(samples.length).toBeGreaterThan(0);
    expect(s.failed()).toBeGreaterThan(0);
  });
});
