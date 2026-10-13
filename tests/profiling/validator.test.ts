import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Revision 4 (review 4 R2, design assessment A5): a listed hash is accepted only for a capture the hand-over CERTIFIES, so the hashes
// file is a hand-over's (fixtures/W2-hashes.json beside the carried evidence): the capture's bytes in fixtures/ and evidence/w2/, its
// P-W2 capture row with the seeded person, and contents that are the seed (a person and 199 dense checklists, built here on their own).
const PERSON = randomUUID();
const projection = (
  id: string,
  kind: string,
  parent: string | null,
  label: string,
  value: unknown,
) => ({
  id,
  kind,
  parent_id: parent,
  label,
  value,
  version: 1,
  policy_version: 1,
  can_edit: false,
  archived: false,
});
const checklist = () => {
  const items = Array.from({ length: 100 }, () => ({
    id: randomUUID(),
    label: "x",
  }));
  return {
    checked: items.slice(0, 40).map((i) => i.id),
    items,
    kind: "checklist",
  };
};
const captureText = (fill: () => unknown = checklist) =>
  JSON.stringify({
    phase: "delta",
    batches: [
      {
        revision: 7,
        changes: [
          {
            kind: "upsert",
            resource: projection(PERSON, "person", null, "W2 person", null),
          },
          ...Array.from({ length: 199 }, () => ({
            kind: "upsert",
            resource: projection(
              randomUUID(),
              "field",
              PERSON,
              "Checklist",
              fill(),
            ),
          })),
        ],
      },
    ],
    next_cursor: "d1.after",
    has_more: false,
  });
const shaOf = (text: string) => createHash("sha256").update(text).digest("hex");
const CAPTURE = "W2-captured.chromium.limit-1.json";
/** A hand-over's fixtures and carried evidence holding `text` as the chromium limit-1 capture; returns its W2-hashes.json. */
function handover(name: string, text: string): string {
  const at = join(dir, name);
  mkdirSync(join(at, "fixtures"), { recursive: true });
  mkdirSync(join(at, "evidence/w2"), { recursive: true });
  writeFileSync(join(at, "fixtures", CAPTURE), text);
  writeFileSync(join(at, "evidence/w2", CAPTURE), text);
  writeFileSync(
    join(at, "evidence/values.jsonl"),
    `${JSON.stringify({
      name: "P-W2 capture",
      engine: "chromium",
      seeding: { person: PERSON },
      captures: { limit_1: { sha256: shaOf(text) } },
    })}\n`,
  );
  const list = join(at, "fixtures/W2-hashes.json");
  writeFileSync(list, JSON.stringify({ [CAPTURE]: shaOf(text) }));
  return list;
}
const CAPTURED = captureText();
const W2_SHA = shaOf(CAPTURED);
const w2Hashes = handover("handoff", CAPTURED);
const hash = (name: string) =>
  name === "W2"
    ? W2_SHA
    : (hashes.workloads.find((w) => w.name === name)?.sha256 as string);
// Revision 3 (review 3 R2, design assessment E12): a run carries the payload its path and outcome produce, and the file holds the
// protocol's attempts in plan order (W2 after W1) with a planned count and a terminal state that agree with them.
const bytesOf = (name: string) =>
  name === "W2"
    ? 1_234
    : (hashes.workloads.find((w) => w.name === name)?.bytes as number);
const run = (
  workload: string,
  n: number,
  extra: Record<string, unknown> = {},
) => {
  const control = workload.startsWith("W7-");
  const processing = workload.startsWith("W5-");
  return {
    protocol_id: "protocol-1",
    workload,
    run: n,
    cold: true,
    expected: control ? "refused" : "admitted",
    outcome: control ? "refused" : "admitted",
    // Schema 3 (revision 10, DA-3): an engine run's detail is the state it ended in; W5's is its own description.
    detail: processing
      ? "phase snapshot"
      : JSON.stringify(
          control ? { kind: "backing_off", since: 1 } : { kind: "idle" },
        ),
    sha256: hash(workload),
    sha256_verified: true,
    ...(workload === "W2"
      ? { source: "W2-captured.chromium.limit-1.json" }
      : {}),
    bytes: bytesOf(workload),
    elapsed_ms: 10,
    scan_ms: control ? null : 3,
    commit_ms: control || processing ? null : 20,
    request_count: processing ? 0 : 1,
    limit: processing ? null : 1,
    changes_written: control ? null : 100,
    cursor_after: processing ? null : "after",
    heap_baseline_bytes: null,
    heap_peak_bytes: null,
    heap_after_bytes: null,
    // The first commit after the request: the served body's, with the run's own figures (null for W5 and a refused control here).
    first_commit:
      control || processing
        ? null
        : {
            kind: "applied",
            bytes: bytesOf(workload),
            scan_ms: 3,
            commit_ms: 20,
          },
    user_agent: "test",
    at: "2026-10-10T00:00:00.000Z",
    ...extra,
  };
};
/** The page's protocol order, written out again: every workload, W2 after W1 when a capture is named, five cold runs of the valid ones. */
const planOf = (withW2: boolean) =>
  hashes.workloads
    .flatMap((w) => (w.name === "W1" && withW2 ? ["W1", "W2"] : [w.name]))
    .flatMap((name) =>
      ["W1", "W2", "W3", "W4", "W6"].includes(name)
        ? [1, 2, 3, 4, 5].map((n) => run(name, n))
        : [run(name, 1)],
    );
const complete = () => {
  const runs = planOf(true);
  return {
    schema: 3,
    kind: "protocol",
    protocol_id: "protocol-1",
    w2sha256: W2_SHA as string | null,
    workload_version: hashes.version,
    machine: {
      user_agent: "test",
      device_memory_gib: 8,
      hardware_concurrency: 8,
      platform: "test",
      secure_context: true,
    },
    planned_runs: runs.length,
    terminal: "complete" as string | null,
    error: null,
    takeovers: [] as unknown[],
    runs,
  };
};

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
  it("accepts a W2 hash only from a hand-over that certifies its capture: a copy of the list elsewhere, or an invalid capture rehashed into every list, is refused (revision 4)", () => {
    const loose = join(dir, "W2-hashes.json");
    writeFileSync(loose, JSON.stringify({ [CAPTURE]: W2_SHA }));
    const outside = validate(complete(), [], ["--w2-hashes", loose]);
    expect(outside.status).toBe(1);
    expect(outside.text).toContain("no capture is certified");
    expect(outside.text).toMatch(/W2 run 1\): sha256 \w+ is listed, but/);
    // Empty checklists under the seed's tags and counts: a valid page, not the dense batch.
    const empty = captureText(() => ({
      checked: [],
      items: [],
      kind: "checklist",
    }));
    const forged = handover("forged", empty);
    const data = complete();
    data.w2sha256 = shaOf(empty);
    for (const r of data.runs)
      if (r.workload === "W2") (r as { sha256: string }).sha256 = shaOf(empty);
    const invalid = validate(data, [], ["--w2-hashes", forged]);
    expect(invalid.status).toBe(1);
    expect(invalid.text).toMatch(
      /is listed, but W2-captured\.chromium\.limit-1\.json is NOT a certified W2 capture: .*holds 0 items, not 100/,
    );
  });
  it("refuses results without W2 as incomplete, and reports 2 when partial results are allowed", () => {
    // A protocol started without a named capture: no W2 in its plan, so its results are incomplete (revision 3: the realistic file).
    const data = complete();
    data.runs = planOf(false);
    Object.assign(data, { w2sha256: null, planned_runs: data.runs.length });
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
  it("runs of another protocol, a missing protocol identity and historical schema-1 and schema-2 files are refused", () => {
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
    expect(out.text).toContain("schema must be 3");
    // Revision 10: schema 2 (before corroborated engine outcomes) is history too.
    const schema2 = validate({ ...complete(), schema: 2 });
    expect(schema2.status).toBe(1);
    expect(schema2.text).toContain(
      "schema must be 3 (schema 2 is a historical record",
    );
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
    // A protocol stopped after W1 run 2 (revision 3: attempts are recorded in plan order, so that is where it is still running).
    const data = complete();
    data.runs = data.runs.slice(0, 2);
    data.terminal = null;
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
