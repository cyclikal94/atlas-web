import { describe, expect, it } from "vitest";
import {
  allWorkloads,
  countNodes,
  sha256Hex,
  w1,
  w7,
} from "../../scripts/lib/profile-workloads.mjs";
import { DATA_CONFIG } from "../../src/data/model/config";
import { scanSyncPage } from "../../src/data/scan/scan";

/**
 * The profiling workloads (plan 7.3, H3). W1 must reproduce the design's own figures (WEB-03 A:3445-3473): a checklist value of
 * 100 items with 40 checked entries and one-character labels is 7,402 bytes and 547 nodes, and an 800-change batch of them is
 * 455,214 nodes at 5.83 MiB. The workloads are deterministic (the recorded hashes are the same on every machine and engine) and
 * the valid ones are accepted by the production scanner, the negative controls are not.
 */
describe("W1 reproduces the approved dense-checklist batch", () => {
  const body = w1();
  const bytes = new TextEncoder().encode(body);
  const page = JSON.parse(body) as {
    batches: Array<{ changes: Array<{ resource: { value: unknown } }> }>;
  };

  it("one batch of 800 changes; each value is 7,402 bytes and 547 nodes", () => {
    expect(page.batches).toHaveLength(1);
    expect(page.batches[0]?.changes).toHaveLength(800);
    const value = page.batches[0]?.changes[0]?.resource.value;
    expect(JSON.stringify(value)).toHaveLength(7_402);
    expect(countNodes(value)).toBe(547);
  });

  it("the page is 455,214 nodes and 5.83 MiB (as the design states them)", () => {
    expect(countNodes(page)).toBe(455_214);
    expect((bytes.length / 1_048_576).toFixed(2)).toBe("5.83");
  });

  it("is accepted by the production scanner (a delta page, one batch of 800 changes)", () => {
    const scan = scanSyncPage(bytes, DATA_CONFIG);
    expect(scan.ok).toBe(true);
    if (scan.ok) {
      expect(scan.phase).toBe("delta");
      expect(scan.totalChanges).toBe(800);
    }
  });
});

describe("the workload set", () => {
  it("is deterministic: generating twice gives byte-identical bodies", async () => {
    const first = allWorkloads();
    const second = allWorkloads();
    expect(first.map((w) => w.name)).toEqual(second.map((w) => w.name));
    for (let i = 0; i < first.length; i += 1)
      expect(await sha256Hex(first[i]?.body ?? "")).toBe(
        await sha256Hex(second[i]?.body ?? ""),
      );
  });

  it("every valid workload is accepted by the scanner, and no negative control passes the whole path", () => {
    for (const workload of allWorkloads()) {
      const scan = scanSyncPage(new TextEncoder().encode(workload.body));
      if (workload.name.startsWith("W7-")) continue;
      expect(scan.ok, workload.name).toBe(true);
    }
    // W7 controls: some fail the scan itself, the rest fail the element validator (their own tests are in the sync-engine specs).
    const truncated = scanSyncPage(new TextEncoder().encode(w7().truncated));
    expect(truncated.ok).toBe(false);
  });
});

describe("the recorded hashes", () => {
  it("match what the generators produce (a change to a workload must be re-recorded on purpose)", async () => {
    const recorded = (await import(
      "../../scripts/lib/profile-workload-hashes.json"
    )) as { default: { workloads: Array<{ name: string; sha256: string }> } };
    const now = new Map<string, string>();
    for (const w of allWorkloads()) now.set(w.name, await sha256Hex(w.body));
    expect(recorded.default.workloads.map((w) => w.name)).toEqual([
      ...now.keys(),
    ]);
    for (const w of recorded.default.workloads)
      expect(now.get(w.name), w.name).toBe(w.sha256);
  });
});
