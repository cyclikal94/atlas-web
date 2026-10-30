// WEB-09c R23-PAIR (I7): a paired interval record is evidence only when it binds one interval's exchanges, bodies, barriers, terminal state,
// oracle and memory. Each corruption below must be refused; the valid record must be accepted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { SCHEMA, validateInterval } from "./pair-evidence.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const bodies = {
  "1.json": Buffer.from('{"piece":0}'),
  "2.json": Buffer.from('{"piece":1}'),
  "3.json": Buffer.from('{"piece":2}'),
};
const readBody = (f) => {
  if (!(f in bodies)) throw new Error(`ENOENT ${f}`);
  return bodies[f];
};
const req = (seq, cursor, next, file, extra = {}) => ({
  seq,
  label: "iv",
  status: 200,
  query: { cursor, limit: null, max_changes: "4" },
  next_cursor: next,
  sha256: sha(bodies[file]),
  bytes: bodies[file].length,
  body_file: file,
  ...extra,
});
const valid = () => ({
  schema: SCHEMA,
  interval: "iv",
  case: "PAIR-W2",
  engine: "chromium",
  backend: "development",
  selection_manifest_sha256: "f434df4a",
  workload: "W-real",
  synthetic: false,
  pre_grant_cursor: "c0",
  requests: [
    req(1, "c0", "c1", "1.json"),
    req(2, "c1", "c2", "2.json"),
    req(3, "c2", "c3", "3.json"),
  ],
  unaltered: true,
  barriers: [
    { name: "pre_grant_complete", at: 1 },
    { name: "grant_complete", at: 2 },
    { name: "piece_persisted", at: 3 },
    { name: "piece_persisted", at: 4 },
    { name: "final_released", at: 5 },
    { name: "activation_complete", at: 6 },
  ],
  barriered: true,
  pieces_persisted: 2,
  terminal: { kind: "activated" },
  oracle: { verdict: "match", problems: [] },
  memory: {
    kind: "chromium_cdp_js_heap_used",
    scope: "whole page",
    samples: [10, 12],
  },
});
const problems = (mutate) => {
  const record = valid();
  mutate(record);
  return validateInterval(record, { readBody });
};

test("the valid record is accepted, with its bodies re-hashed", () => {
  assert.deepEqual(validateInterval(valid(), { readBody }), []);
});

for (const [name, mutate, expected] of [
  [
    "an exchange deleted from the chain",
    (r) => r.requests.splice(1, 1),
    /cursor not delivered earlier/,
  ],
  [
    "exchanges reordered",
    (r) => r.requests.reverse(),
    /sequence|cursor not delivered/,
  ],
  [
    "a corrupted body hash",
    (r) => (r.requests[0].sha256 = "0".repeat(64)),
    /body hash differs/,
  ],
  [
    "a body of another length",
    (r) => (r.requests[0].bytes += 1),
    /bytes, recorded/,
  ],
  [
    "a missing body file",
    (r) => (r.requests[0].body_file = "missing.json"),
    /body file unreadable/,
  ],
  [
    "another interval's exchange",
    (r) => (r.requests[1].label = "other"),
    /not this interval/,
  ],
  [
    "an exchange that never completed",
    (r) => (r.requests[2].status = null),
    /did not complete/,
  ],
  ["no exchange at all", (r) => (r.requests = []), /no exchange/],
  [
    "the activation before the final release",
    (r) => r.barriers.splice(4, 2, r.barriers[5], r.barriers[4]),
    /final_released after activation_complete/,
  ],
  [
    "time going backwards",
    (r) => (r.barriers[3].at = 0),
    /time goes backwards/,
  ],
  [
    "a missing activation barrier",
    (r) => r.barriers.pop(),
    /missing barrier activation_complete/,
  ],
  [
    "a piece count that differs from the barriers",
    (r) => (r.pieces_persisted = 3),
    /piece_persisted barriers/,
  ],
  [
    "a barriered interval without its final release",
    (r) => r.barriers.splice(4, 1),
    /no final_released/,
  ],
  [
    "an unknown barrier",
    (r) => r.barriers.splice(2, 0, { name: "idle", at: 2 }),
    /unknown barrier/,
  ],
  [
    "an oracle mismatch",
    (r) => (r.oracle = { verdict: "mismatch", problems: ["x"] }),
    /oracle says/,
  ],
  ["no terminal state", (r) => (r.terminal = { kind: "timeout" }), /terminal/],
  ["memory as a zero", (r) => (r.memory.samples = [0]), /zero/],
  [
    "memory with a kind but no samples",
    (r) => (r.memory.samples = []),
    /no samples/,
  ],
  [
    "memory unavailable without a reason",
    (r) => (r.memory = { kind: null }),
    /without a reason/,
  ],
  ["memory not recorded", (r) => delete r.memory, /memory is not recorded/],
  [
    "memory that does not say what it covers",
    (r) => delete r.memory.scope,
    /what it covers/,
  ],
  [
    "an injected answer while claiming unaltered",
    (r) =>
      (r.requests[0].delivered = {
        injected: "TAP-INJECTED x",
        status: 200,
        next_cursor: "c1",
      }),
    /claims to be unaltered/,
  ],
  [
    "an altered answer that is not labelled",
    (r) => {
      r.unaltered = false;
      r.requests[0].delivered = { status: 200, next_cursor: "c1" };
    },
    /not labelled as injected/,
  ],
  [
    "a dropped answer that is also delivered",
    (r) => {
      r.unaltered = false;
      r.requests[0].dropped = "TAP-INJECTED drop_connection";
      r.requests[0].delivered = {
        injected: "TAP-INJECTED x",
        status: 200,
        next_cursor: "c1",
      };
    },
    /dropped answer/,
  ],
  [
    "a synthetic workload not labelled synthetic",
    (r) => (r.workload = "W-synthetic"),
    /not labelled synthetic/,
  ],
  [
    "a development interval naming no selection",
    (r) => delete r.selection_manifest_sha256,
    /selection manifest/,
  ],
  ["another schema", (r) => (r.schema = "v0"), /schema/],
])
  test(`refused: ${name}`, () => {
    const found = problems(mutate);
    assert.ok(
      found.some((p) => expected.test(p)),
      `${name}: ${JSON.stringify(found)}`,
    );
  });

test("a real 410 lets the recovery's snapshot start without a cursor; an injected 410 counts as injected", () => {
  const ok = valid();
  ok.requests = [
    req(1, "c0", "c1", "1.json"),
    { ...req(2, "c1", null, "2.json"), status: 410 },
    req(3, null, "s1", "3.json"),
  ];
  ok.barriered = false;
  ok.terminal = { kind: "recovered" };
  ok.barriers = ok.barriers.filter(
    (b) => !["piece_persisted", "final_released"].includes(b.name),
  );
  assert.deepEqual(validateInterval(ok, { readBody }), []);
  const injected = valid();
  injected.requests = [
    req(1, "c0", "c1", "1.json"),
    {
      ...req(2, "c1", "c2", "2.json"),
      delivered: {
        injected: "TAP-INJECTED answer_410",
        status: 410,
        next_cursor: null,
      },
    },
    req(3, null, "s1", "3.json"),
  ];
  injected.unaltered = false;
  injected.barriered = false;
  injected.terminal = { kind: "recovered" };
  injected.barriers = injected.barriers.filter(
    (b) => !["piece_persisted", "final_released"].includes(b.name),
  );
  assert.deepEqual(validateInterval(injected, { readBody }), []);
  // Without a 410 the cursor-less request is not part of the chain.
  const broken = valid();
  broken.requests[2] = req(3, null, "s1", "3.json");
  assert.ok(
    validateInterval(broken, { readBody }).some((p) =>
      /cursor not delivered/.test(p),
    ),
  );
});

test("memory unavailable WITH a reason is accepted (never a bound)", () => {
  const r = valid();
  r.memory = {
    kind: null,
    reason: "webkit: no supported per-page heap counter",
  };
  assert.deepEqual(validateInterval(r, { readBody }), []);
});
