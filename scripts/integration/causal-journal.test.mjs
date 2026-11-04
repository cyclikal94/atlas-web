// WEB-09c revision 27 (R27-DIAG.a): the causal journal itself — gap-free positions in the order events are recorded, incremental
// persistence, the bound, a failed write, and the independent reader's refusals.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  before,
  bindingProblem,
  CLOCK,
  createJournal,
  JOURNAL_SCHEMA,
  journalProblems,
} from "./causal-journal.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const make = (o = {}) => {
  const lines = [];
  const j = createJournal({
    attempt: "a1",
    append: (l) => lines.push(l),
    ...o,
  });
  return { j, lines, bytes: () => Buffer.from(lines.join("")) };
};

test("positions are 1, 2, 3 … in recording order, each persisted at once as one line with its raw clock", () => {
  const { j, lines } = make({ now: () => 5 });
  assert.equal(j.record("tap", "request", { seq: 1 }), 1);
  assert.equal(lines.length, 1, "persisted before the next event");
  assert.equal(j.record("control", "stdin", { n: 1 }), 2);
  assert.equal(j.record("bridge", "mark", { name: "x0:a" }), 3);
  const events = lines.map((l) => JSON.parse(l));
  assert.deepEqual(
    events.map((e) => [
      e.j,
      e.producer,
      e.kind,
      e.at,
      e.clock,
      e.schema,
      e.attempt,
    ]),
    [
      [1, "tap", "request", 5, CLOCK, JOURNAL_SCHEMA, "a1"],
      [2, "control", "stdin", 5, CLOCK, JOURNAL_SCHEMA, "a1"],
      [3, "bridge", "mark", 5, CLOCK, JOURNAL_SCHEMA, "a1"],
    ],
  );
  assert.deepEqual(j.state(), {
    events: 3,
    complete: true,
    overflowed: false,
    write_errors: [],
  });
});
test("an unknown producer or kind is refused at once (never recorded)", () => {
  const { j, lines } = make();
  assert.throws(() => j.record("tap", "guess"), /unknown journal event/);
  assert.throws(() => j.record("spec", "mark"), /unknown journal event/);
  assert.equal(lines.length, 0);
  assert.throws(() => createJournal({ attempt: "" }), /one named attempt/);
});
test("beyond the bound the journal is INCOMPLETE (never evidence), and a failed write is kept", () => {
  const { j } = make({ maxEvents: 2 });
  j.record("tap", "request");
  j.record("tap", "request");
  j.record("tap", "request");
  assert.equal(j.state().complete, false);
  assert.equal(j.state().overflowed, true);
  const failing = createJournal({
    attempt: "a1",
    append: () => {
      throw new Error("ENOSPC");
    },
  });
  failing.record("tap", "request");
  assert.deepEqual(failing.state().write_errors, [{ j: 1, error: "ENOSPC" }]);
  assert.equal(failing.state().complete, false);
});
test("the reader: a complete journal is accepted and answered by position; each corruption is refused", () => {
  const { j, bytes } = make();
  j.record("tap", "request", { seq: 1 });
  j.record("control", "stdin", { n: 2, seq: 1, op: "inspect" });
  j.record("tap", "gate_open", { seq: 1 });
  const ok = journalProblems(bytes(), {
    attempt: "a1",
    sha256: sha(bytes()),
    events: 3,
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.events.get(2).kind, "stdin");
  const lines = String(bytes()).split("\n").filter(Boolean);
  const as = (ls) => Buffer.from(ls.map((l) => `${l}\n`).join(""));
  const cases = [
    [as([lines[0], lines[2]]), /a gap, a replay or a reorder/],
    [
      as([lines[0], lines[1], lines[1], lines[2]]),
      /a gap, a replay or a reorder/,
    ],
    [as([lines[1], lines[0], lines[2]]), /a gap, a replay or a reorder/],
    [as([lines[0], "not json", lines[2]]), /not JSON/],
    [
      as([lines[0], lines[1].replace('"a1"', '"a2"'), lines[2]]),
      /belongs to attempt a2/,
    ],
  ];
  for (const [b, re] of cases) {
    const r = journalProblems(b, { attempt: "a1" });
    assert.ok(
      r.problems.some((p) => re.test(p)),
      JSON.stringify(r.problems),
    );
  }
  assert.ok(
    journalProblems(bytes(), {
      attempt: "a1",
      sha256: "0".repeat(64),
    }).problems.some((p) => /bytes are not the ones/.test(p)),
  );
  assert.ok(
    journalProblems(bytes(), { attempt: "a1", events: 4 }).problems.some((p) =>
      /holds 3 events/.test(p),
    ),
  );
  assert.deepEqual(journalProblems(null, { attempt: "a1" }).problems, [
    "the causal journal cannot be read",
  ]);
});
test("binding: a position must name the event it claims (producer, kind and reference)", () => {
  const { j, bytes } = make();
  j.record("tap", "request", { seq: 7 });
  j.record("bridge", "mark", { name: "x0:a" });
  const { events } = journalProblems(bytes(), { attempt: "a1" });
  assert.equal(
    bindingProblem(events, 1, "tap", "request", { seq: 7 }, "r"),
    null,
  );
  assert.match(
    bindingProblem(events, 1, "tap", "request", { seq: 8 }, "r"),
    /whose seq is 7, not 8/,
  );
  assert.match(
    bindingProblem(events, 2, "tap", "request", {}, "r"),
    /a bridge\.mark, not a tap\.request/,
  );
  assert.match(
    bindingProblem(events, 9, "tap", "request", {}, "r"),
    /does not hold/,
  );
  assert.match(
    bindingProblem(events, undefined, "tap", "request", {}, "r"),
    /names no journal position/,
  );
  assert.equal(before(1, 2), true);
  assert.equal(before(2, 2), false);
  assert.equal(before(undefined, 2), false);
});
