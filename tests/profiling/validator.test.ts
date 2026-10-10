import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import hashes from "../../scripts/lib/profile-workload-hashes.json";

/** scripts/validate-profile-handoff.mjs: what it accepts and what it refuses (each rule fails on its own). */
const dir = mkdtempSync(join(tmpdir(), "atlas-validate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hash = (name: string) =>
  hashes.workloads.find((w) => w.name === name)?.sha256 as string;
const run = (
  workload: string,
  n: number,
  extra: Record<string, unknown> = {},
) => ({
  workload,
  run: n,
  cold: true,
  expected: workload.startsWith("W7-") ? "refused" : "admitted",
  outcome: workload.startsWith("W7-") ? "refused" : "admitted",
  detail: "",
  sha256: hash(workload),
  sha256_verified: true,
  bytes: 1,
  elapsed_ms: 10,
  user_agent: "test",
  ...extra,
});
const complete = () => ({
  schema: 1,
  workload_version: hashes.version,
  machine: {
    user_agent: "test",
    device_memory_gib: 8,
    hardware_concurrency: 8,
    platform: "test",
    secure_context: true,
  },
  runs: hashes.workloads.flatMap((w) =>
    ["W1", "W3", "W4", "W6"].includes(w.name)
      ? [1, 2, 3, 4, 5].map((n) => run(w.name, n))
      : [run(w.name, 1)],
  ),
});

function validate(data: unknown, flags: string[] = []) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(data));
  const out = spawnSync(
    process.execPath,
    ["scripts/validate-profile-handoff.mjs", file, ...flags],
    { encoding: "utf8" },
  );
  return { status: out.status, text: `${out.stdout}${out.stderr}` };
}

describe("validate-profile-handoff", () => {
  it("accepts a complete, consistent file", () => {
    const out = validate(complete());
    expect(out.status, out.text).toBe(0);
  });
  it("refuses a hash that is not the recorded one", () => {
    const data = complete();
    (data.runs[0] as { sha256: string }).sha256 = "0".repeat(64);
    const out = validate(data);
    expect(out.status).toBe(1);
    expect(out.text).toContain("is not the recorded");
  });
  it("refuses a negative control that was admitted", () => {
    const data = complete();
    const control = data.runs.find((r) => r.workload.startsWith("W7-"));
    (control as { outcome: string }).outcome = "admitted";
    const out = validate(data);
    expect(out.status).toBe(1);
    expect(out.text).toContain("NEGATIVE control was admitted");
  });
  it("refuses fewer than five cold runs of W1, and reports 2 when partial results are allowed", () => {
    const data = complete();
    data.runs = data.runs.filter((r) => !(r.workload === "W1" && r.run > 2));
    expect(validate(data).status).toBe(1);
    const allowed = validate(data, ["--allow-partial"]);
    expect(allowed.status).toBe(2);
    expect(allowed.text).toContain("W1: 2 cold run(s)");
  });
  it("refuses a run the page did not verify, a non-secure context and a stale workload version", () => {
    const unverified = complete();
    (unverified.runs[1] as { sha256_verified: boolean }).sha256_verified =
      false;
    expect(validate(unverified).text).toContain("did not verify");
    const insecure = complete();
    insecure.machine.secure_context = false;
    expect(validate(insecure).text).toContain("secure_context is false");
    const stale = complete();
    stale.workload_version = hashes.version + 1;
    expect(validate(stale).text).toContain("workload_version");
  });
});
