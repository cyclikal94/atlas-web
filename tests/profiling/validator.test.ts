import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import hashes from "../../scripts/lib/profile-workload-hashes.json";

/**
 * scripts/validate-profile-handoff.mjs: what it accepts and what it refuses (each rule fails on its own). Schema 2 (WEB-09c revision 2,
 * design assessment DA-1): one protocol identity, every (workload, run) once, distinct runs counted, expectations from the workload
 * contract, and a W7 control fulfilled only when refused.
 */
const dir = mkdtempSync(join(tmpdir(), "atlas-validate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// W2 is the released backend's captured batch: its hash comes from the hand-over's W2-hashes.json, given with --w2-hashes (review R3).
const W2_SHA = "a".repeat(64);
const w2Hashes = join(dir, "W2-hashes.json");
writeFileSync(
  w2Hashes,
  JSON.stringify({ "W2-captured.chromium.limit-1.json": W2_SHA }),
);
const hash = (name: string) =>
  name === "W2"
    ? W2_SHA
    : (hashes.workloads.find((w) => w.name === name)?.sha256 as string);
const run = (
  workload: string,
  n: number,
  extra: Record<string, unknown> = {},
) => ({
  protocol_id: "protocol-1",
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
  schema: 2,
  protocol_id: "protocol-1",
  w2sha256: W2_SHA,
  workload_version: hashes.version,
  machine: {
    user_agent: "test",
    device_memory_gib: 8,
    hardware_concurrency: 8,
    platform: "test",
    secure_context: true,
  },
  runs: [...hashes.workloads, { name: "W2" }].flatMap((w) =>
    ["W1", "W2", "W3", "W4", "W6"].includes(w.name)
      ? [1, 2, 3, 4, 5].map((n) => run(w.name, n))
      : [run(w.name, 1)],
  ),
});

function validate(
  data: unknown,
  flags: string[] = [],
  hashesFlag = ["--w2-hashes", w2Hashes],
) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(data));
  const out = spawnSync(
    process.execPath,
    ["scripts/validate-profile-handoff.mjs", file, ...hashesFlag, ...flags],
    { encoding: "utf8" },
  );
  return { status: out.status, text: `${out.stdout}${out.stderr}` };
}

describe("validate-profile-handoff", () => {
  it("accepts a complete, consistent file (W2 included, verified against the hand-over's W2 hashes)", () => {
    const out = validate(complete());
    expect(out.status, out.text).toBe(0);
  });
  it("refuses a W2 run that is not one of the hand-over's captures, and one that cannot be checked without --w2-hashes", () => {
    const data = complete();
    const w2 = data.runs.find((r) => r.workload === "W2");
    (w2 as { sha256: string }).sha256 = "b".repeat(64);
    const unknown = validate(data);
    expect(unknown.status).toBe(1);
    expect(unknown.text).toContain("is not a captured W2 of the hand-over");
    const unchecked = validate(complete(), [], []);
    expect(unchecked.status).toBe(1);
    expect(unchecked.text).toContain("cannot be verified without --w2-hashes");
  });
  it("refuses results without W2 as incomplete, and reports 2 when partial results are allowed", () => {
    const data = complete();
    data.runs = data.runs.filter((r) => r.workload !== "W2");
    const refused = validate(data);
    expect(refused.status).toBe(1);
    expect(refused.text).toContain("W2: no run recorded");
    expect(validate(data, ["--allow-partial"]).status).toBe(2);
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
  it("a W7 control that timed out, failed or was killed is kept but does not fulfil its control, even with --allow-partial", () => {
    for (const outcome of ["timeout", "error", "killed"]) {
      const data = complete();
      const control = data.runs.find((r) => r.workload === "W7-truncated");
      (control as { outcome: string }).outcome = outcome;
      const out = validate(data, ["--allow-partial"]);
      expect(out.status, outcome).toBe(1);
      expect(out.text).toContain(`FAILED CONTROL runs[`);
      expect(out.text).toContain(`was not refused (outcome ${outcome})`);
    }
  });
  it("an expectation is the workload contract's: a W7 run declared 'admitted' is refused", () => {
    const data = complete();
    const control = data.runs.find((r) => r.workload.startsWith("W7-"));
    Object.assign(control as object, {
      expected: "admitted",
      outcome: "admitted",
    });
    const out = validate(data);
    expect(out.status).toBe(1);
    expect(out.text).toContain("the workload contract expects refused");
  });
  it("five copies of one run are one run: duplicates are refused and distinct runs are counted", () => {
    const data = complete();
    data.runs = data.runs.map((r) =>
      r.workload === "W3" ? { ...r, run: 1 } : r,
    );
    const out = validate(data, ["--allow-partial"]);
    expect(out.status).toBe(1);
    expect(out.text).toContain("a duplicate of runs[");
  });
  it("runs of another protocol, a missing protocol identity and a historical schema-1 file are refused", () => {
    const mixed = complete();
    (mixed.runs[3] as { protocol_id: string }).protocol_id = "protocol-2";
    expect(validate(mixed).text).toContain(
      "runs of different protocols cannot be counted together",
    );
    const anonymous = complete() as Record<string, unknown>;
    delete anonymous.protocol_id;
    expect(validate(anonymous).text).toContain("protocol_id is missing");
    const historical = { ...complete(), schema: 1 };
    const out = validate(historical);
    expect(out.status).toBe(1);
    expect(out.text).toContain("schema must be 2");
  });
  it("a W2 run, killed ones included, is of the protocol's capture", () => {
    const data = complete();
    const w2 = data.runs.find((r) => r.workload === "W2") as Record<
      string,
      unknown
    >;
    Object.assign(w2, {
      outcome: "killed",
      sha256: "",
      sha256_verified: false,
    });
    const out = validate(data);
    expect(out.status).toBe(1);
    expect(out.text).toContain("is not the protocol's capture");
  });
  it("refuses fewer than five cold runs of W1, and reports 2 when partial results are allowed", () => {
    const data = complete();
    data.runs = data.runs.filter((r) => !(r.workload === "W1" && r.run > 2));
    expect(validate(data).status).toBe(1);
    const allowed = validate(data, ["--allow-partial"]);
    expect(allowed.status).toBe(2);
    expect(allowed.text).toContain("W1: 2 distinct cold run(s)");
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
