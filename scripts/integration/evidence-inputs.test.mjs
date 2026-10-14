// Review r10 H4f (revision 11): a run file is absent, present or unreadable; only "not found" is absence.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readEvidence, SHAPES } from "./evidence-inputs.mjs";
import {
  publishExclusively,
  readStackRecord,
  readStackRecords,
  stackFile,
  stacksDir,
} from "./stack-records.mjs";

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-evidence-inputs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a file that does not exist is absent; one that is read and of its shape is present", (t) => {
  const dir = scratch(t);
  assert.deepEqual(
    readEvidence(join(dir, "summary-error.json"), {
      what: "the marker",
      shape: SHAPES.summaryError,
    }),
    { state: "absent", path: join(dir, "summary-error.json") },
  );
  writeFileSync(
    join(dir, "summary-error.json"),
    JSON.stringify({ error: "EIO", stacks: [{ browser: "chromium" }] }),
  );
  const present = readEvidence(join(dir, "summary-error.json"), {
    what: "the marker",
    shape: SHAPES.summaryError,
  });
  assert.equal(present.state, "present");
  assert.equal(present.value.error, "EIO");
});

test("a torn file, a file that cannot be read (not ENOENT) and a value of another shape are unreadable, never absent", (t) => {
  const dir = scratch(t);
  const read = (name, shape) =>
    readEvidence(join(dir, name), { what: `the ${name}`, shape });
  writeFileSync(join(dir, "torn.json"), '{"error":');
  const torn = read("torn.json", SHAPES.summaryError);
  assert.equal(torn.state, "unreadable");
  assert.match(torn.error, /^the torn\.json could not be read: /);
  // A directory where the file should be: EISDIR, a read failure that is not "not found".
  mkdirSync(join(dir, "directory.json"));
  const directory = read("directory.json", SHAPES.summaryError);
  assert.equal(directory.state, "unreadable");
  assert.match(directory.error, /could not be read: .*EISDIR/);
  const cases = [
    ["null", SHAPES.summaryError, /not a JSON object/],
    ["[]", SHAPES.summary, /not a JSON object/],
    ['{"stacks":{}}', SHAPES.summary, /`stacks` is not a list/],
    ['{"stacks":[null]}', SHAPES.summaryError, /`stacks` is not a list/],
    ['{"evidence_errors":[1]}', SHAPES.summary, /`evidence_errors`/],
    ['{"invocation":"x"}', SHAPES.summary, /`invocation`/],
    ['{"terminal":true}', SHAPES.summary, /`terminal`/],
    ['{"browsers":"chromium","stacks":[]}', SHAPES.plan, /`browsers`/],
    ['{"browsers":["chromium"]}', SHAPES.plan, /`stacks`/],
    [
      '{"browsers":["chromium"],"stacks":[{"cases":{}}]}',
      SHAPES.plan,
      /`stacks`/,
    ],
    ['"run"', SHAPES.invocation, /not a JSON object/],
  ];
  for (const [text, shape, problem] of cases) {
    writeFileSync(join(dir, "value.json"), text);
    const r = read("value.json", shape);
    assert.equal(r.state, "unreadable", text);
    assert.match(r.error, /is not valid evidence: /, text);
    assert.match(r.error, problem, text);
  }
  // Controls: the shapes the runner writes.
  writeFileSync(
    join(dir, "plan.json"),
    JSON.stringify({
      browsers: ["chromium"],
      stacks: [{ stack: "base", cases: [] }, { stack: "-later" }],
    }),
  );
  assert.equal(read("plan.json", SHAPES.plan).state, "present");
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify({
      schema: 3,
      invocation: { finished: false },
      outcome: "running",
      stacks: [],
      evidence_errors: [],
      selection: null,
    }),
  );
  assert.equal(read("summary.json", SHAPES.summary).state, "present");
});

test("a stack record file that holds no record (null, a list, no key) is unreadable, not 'no record'", (t) => {
  const run = scratch(t);
  mkdirSync(stacksDir(run));
  for (const [i, text] of ["null", "[]", '{"browser":"chromium"}'].entries()) {
    writeFileSync(stackFile(run, "chromium", i), text);
    assert.deepEqual(readStackRecord(stackFile(run, "chromium", i)), {
      unreadable: "it is not a stack record",
    });
  }
  const { records, errors } = readStackRecords(run);
  assert.equal(records.size, 0);
  assert.equal(errors.length, 3);
  for (const e of errors) assert.match(e, /not a stack record/);
  assert.equal(readStackRecord(stackFile(run, "firefox", 0)), null);
});

test("an exclusive publication writes the whole file once; a second one fails with EEXIST and leaves the first and no sibling", (t) => {
  const dir = scratch(t);
  const path = join(dir, "plan.json");
  publishExclusively(path, '{"first":true}\n');
  assert.equal(readFileSync(path, "utf8"), '{"first":true}\n');
  assert.throws(
    () => publishExclusively(path, '{"second":true}\n'),
    (error) => error.code === "EEXIST",
  );
  assert.equal(readFileSync(path, "utf8"), '{"first":true}\n');
  assert.deepEqual(readdirSync(dir), ["plan.json"]);
});
